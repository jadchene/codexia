import { createRequestMetadataParser } from "./request-metadata.ts";
import { randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ApiDebugLogger } from "./api-debug-log.ts";
import type { ModelPricing } from "../shared/contracts/upstreams";
import { createBodyCapture, previewBody, sanitizeHeaders } from "./api-debug-log.ts";
import { createAccountModeResponsesObserver } from "./account-mode-responses-observer.ts";
import { bridgeWebSockets } from "./gateway-websocket-relay.ts";
import { emptyUsage, createSseUsageParser } from "./gateway/usage-parser.ts";
import { buildResponsesRequestLog } from "./responses-request-log.ts";
import { normalizeServiceTier } from "../shared/service-tier.ts";
import { syncAccountUsageFromEvent, syncAccountUsageFromHeaders, type GatewayAccountQuota } from "./gateway/quota.ts";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const RESPONSES_PATH = "/backend-api/codex/responses";
const PUBLIC_RESPONSES_PATH = "/v1/responses";
const DEFAULT_UPSTREAM_BASE_URL = "https://chatgpt.com";

type Dynamic = any;

interface AccountModeProxyOptions {
  upstreamBaseUrl?: string;
  /** Resolve once per connection so an in-flight request cannot change channels. */
  resolveOptions?: () => AccountModeProxyOptions;
  apiTarget?: { id: string; name: string; kind: string };
  /** 第三方模式只允许所选渠道目录中的模型。 */
  allowedModels?: string[];
  /** 第三方渠道专用请求头在本地网关添加，不写入 Codex 配置。 */
  requestHeaders?: Record<string, string>;
  /** 禁止向仅支持 HTTP 的第三方渠道发起 WebSocket。 */
  supportsWebSocket?: boolean;

  getModelPricing?: ((modelId: string) => ModelPricing | null | undefined) | undefined;
}

interface ProxyStore {
  listAccounts?: () => GatewayAccountQuota[];
  updateUsage?: (id: string, usage: Record<string, unknown>) => unknown;
  paths?: { dataDir?: string };
  getSettings: () => Record<string, string>;
  addTokenLog: (entry: Record<string, unknown>) => unknown;
  addAppLog?: (entry: Record<string, unknown>) => unknown;
}

interface WebSocketContext {
  downstream: WebSocket;
  upstream: WebSocket;
  controller: AbortController;
}

/**
 * 将账号模式透明代理挂载到现有网关服务，不创建额外监听端口。
 */
export const createAccountModeApiProxy = (
  store: ProxyStore,
  apiDebugLogger: ApiDebugLogger,
  options: AccountModeProxyOptions = {}
) => {
  const notifyStatus = (): void => {};
  const activeRequests = new Set<http.ClientRequest>();
  const activeWebSockets = new Set<WebSocketContext>();
  const websocket = createAccountProxyWebSocketServer(
    store,
    apiDebugLogger,
    activeWebSockets,
    notifyStatus,
    options
  );
  return {
    handleHttp: async (request: IncomingMessage, response: ServerResponse) => handleHttpRequest(
      request,
      response,
      store,
      apiDebugLogger,
      activeRequests,
      notifyStatus,
      options.resolveOptions?.() || options
    ),
    handleUpgrade: websocket.handleUpgrade,
    close: async () => {
      for (const request of activeRequests) request.destroy(proxyAbortError("网关服务正在停止。"));
      for (const context of activeWebSockets) context.controller.abort(proxyAbortError("网关服务正在停止。"));
      await websocket.close();
    }
  };
};

const handleHttpRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  store: ProxyStore,
  apiDebugLogger: ApiDebugLogger,
  activeRequests: Set<http.ClientRequest>,
  notifyStatus: () => void,
  options: AccountModeProxyOptions
): Promise<void> => {
  const startedAt = Date.now();
  const parsed = new URL(request.url || "/", "http://localhost");
  if (!isSupportedProxyPath(parsed.pathname, options)) {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { message: "Unrecognized request URL." } }));
    return;
  }
  const mappedPath = upstreamRequestPath(parsed, options);
  if (options.allowedModels && request.method === "GET" && parsed.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: options.allowedModels.map((id) => ({ id, object: "model", owned_by: options.apiTarget?.id })) }));
    return;
  }
  if (options.allowedModels && parsed.pathname.startsWith("/v1/models/")) {
    const model = decodeURIComponent(parsed.pathname.slice("/v1/models/".length));
    if (!options.allowedModels.includes(model)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "model_not_allowed", message: "所选渠道中没有此模型。" } }));
      return;
    }
  }
  let checkedBody: Buffer | null = null;
  if (options.allowedModels && request.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    const limit = positiveInteger(store.getSettings().gateway_request_body_limit_bytes, 32 * 1024 * 1024);
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "请求正文超过大小限制。" } }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    checkedBody = Buffer.concat(chunks);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(checkedBody.toString("utf8")); }
    catch { payload = {}; }
    if (!payload || !options.allowedModels.includes(String(payload.model || ""))) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "model_not_allowed", message: "只能使用所选第三方渠道的可用模型。" } }));
      return;
    }
  }
  const observed = request.method === "POST" && (options.apiTarget ? parsed.pathname === PUBLIC_RESPONSES_PATH : mappedPath.pathname === RESPONSES_PATH);
  const settings = store.getSettings();
  const debugEnabled = observed && settings.debug_api_logging === "true" && apiDebugLogger.isEnabled();
  const requestId = debugEnabled ? randomUUID() : "";
  const requestCapture = debugEnabled ? createBodyCapture(apiDebugLogger.bodyLimitBytes || DEFAULT_BODY_LIMIT_BYTES) : null;
  const metadata = observed ? createRequestMetadataParser() : null;
  const responseCapture = debugEnabled ? createBodyCapture(apiDebugLogger.bodyLimitBytes || DEFAULT_BODY_LIMIT_BYTES) : null;
  const quotaAccount = options.apiTarget ? null : resolveProxyAccount(request, store);
  const usageParser = observed ? createSseUsageParser((event) => syncAccountUsageFromEvent(quotaAccount, event, store)) : null;
  const upstreamUrl = new URL(`${mappedPath.pathname}${mappedPath.search}`, upstreamBaseUrl(options));
  const outgoingHeaders = { ...transparentRequestHeaders(request.headers), ...options.requestHeaders };
  const transport = upstreamUrl.protocol === "https:" ? https : http;
  let finished = false;
  let clientRequest: http.ClientRequest | null = null;

  const finishLog = (statusCode: number, message: string | null): void => {
    if (!observed || finished) return;
    finished = true;
    const requestMetadata = metadata?.finish();
    const model = requestMetadata?.model || "";
    const usage = usageParser?.latestUsage() || emptyUsage();
    // 流式业务失败也应计为失败，仅影响日志，不改写客户端收到的状态与正文。
    const failure = statusCode >= 200 && statusCode < 300 ? usageParser?.terminalFailure() : null;
    try {
      store.addTokenLog(buildResponsesRequestLog({
        account: options.apiTarget ? null : quotaAccount || selectedAccount(settings),
        target: options.apiTarget || null,
        method: request.method || "POST",
        requestPath: PUBLIC_RESPONSES_PATH,
        upstreamPath: `${mappedPath.pathname}${mappedPath.search}`,
        headers: request.headers,
        status: failure?.status ?? statusCode,
        durationMs: Date.now() - startedAt,
        usage,
        requestedServiceTier: normalizeServiceTier(request.headers["openai-service-tier"]) ?? normalizeServiceTier(requestMetadata?.serviceTier),
        settings,
        clientModel: model,
        upstreamModel: model,
        modelPricing: options.getModelPricing?.(model),
        message: message ?? failure?.message ?? null
      }));
    } catch (error) {
      logObservationFailure(store, error);
    }
  };

  await new Promise<void>((resolve, reject) => {
    clientRequest = transport.request(upstreamUrl, {
      method: request.method,
      headers: outgoingHeaders
    }, (upstreamResponse) => {
      if (observed) safelyObserve(store, () => syncAccountUsageFromHeaders(quotaAccount, upstreamResponse.headers, store));
      response.writeHead(upstreamResponse.statusCode || 502, transparentResponseHeaders(upstreamResponse.headers));
      upstreamResponse.on("data", (chunk: Buffer) => {
        safelyObserve(store, () => usageParser?.feed(chunk));
        responseCapture?.push(chunk);
      });
      upstreamResponse.once("end", () => {
        finishLog(upstreamResponse.statusCode || 502, null);
        if (debugEnabled) safelyObserve(store, () => writeDebugResponse(apiDebugLogger, requestId, upstreamResponse.statusCode || 0, upstreamResponse.headers, responseCapture, startedAt, upstreamUrl));
        resolve();
      });
      upstreamResponse.once("error", reject);
      upstreamResponse.pipe(response);
    });
    activeRequests.add(clientRequest);
    notifyStatus();
    clientRequest.once("error", reject);
    request.on("data", (chunk: Buffer) => {
      requestCapture?.push(chunk);
      metadata?.feed(chunk);
    });
    const logRequest = () => {
      if (!debugEnabled) return;
      safelyObserve(store, () => apiDebugLogger.write({
        ts: new Date().toISOString(),
        id: requestId,
        kind: "request",
        mode: "account_proxy",
        transport: "http",
        method: request.method || "POST",
        path: `${parsed.pathname}${parsed.search}`,
        headers: sanitizeHeaders(request.headers),
        ...requestCapture?.snapshot()
      }));
    };
    request.once("end", logRequest);
    response.once("close", () => {
      if (response.writableEnded) return;
      clientRequest?.destroy(proxyAbortError("客户端已取消请求。"));
      finishLog(499, "Client cancelled the request.");
    });
    if (checkedBody) {
      requestCapture?.push(checkedBody);
      metadata?.feed(checkedBody);
      logRequest();
      clientRequest.end(checkedBody);
    } else request.pipe(clientRequest);
  }).catch((error) => {
    const cancelled = response.destroyed || request.aborted;
    finishLog(cancelled ? 499 : 502, error instanceof Error ? error.message : String(error));
    if (debugEnabled) safelyObserve(store, () => writeDebugResponse(apiDebugLogger, requestId, cancelled ? 499 : 502, response.getHeaders(), responseCapture, startedAt, upstreamUrl));
    throw error;
  }).finally(() => {
    if (clientRequest) activeRequests.delete(clientRequest);
    notifyStatus();
  });
};

const createAccountProxyWebSocketServer = (
  store: ProxyStore,
  apiDebugLogger: ApiDebugLogger,
  activeWebSockets: Set<WebSocketContext>,
  notifyStatus: () => void,
  baseOptions: AccountModeProxyOptions
) => {
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true,
    handleProtocols(_protocols, request: Dynamic) {
      return request.accountProxySelectedProtocol || false;
    }
  });
  server.on("headers", (headers, request: Dynamic) => {
    for (const header of request.accountProxyResponseHeaders || []) headers.push(header);
  });

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const options = baseOptions.resolveOptions?.() || baseOptions;
    if (options.supportsWebSocket === false) {
      rejectUpgrade(socket, 426, "所选第三方渠道仅支持 HTTP 请求。");
      return;
    }
    const parsed = new URL(request.url || "/", "http://localhost");
    if (!isSupportedProxyPath(parsed.pathname, options)) {
      rejectUpgrade(socket, 404, "Unrecognized request URL.");
      return;
    }
    const mappedPath = upstreamRequestPath(parsed, options);
    const observed = (options.apiTarget ? parsed.pathname === PUBLIC_RESPONSES_PATH : mappedPath.pathname === RESPONSES_PATH);
    const startedAt = Date.now();
    const settings = store.getSettings();
    const debugEnabled = observed && settings.debug_api_logging === "true" && apiDebugLogger.isEnabled();
    const connectionId = randomUUID();
    if (debugEnabled) safelyObserve(store, () => writeWebSocketDebug(apiDebugLogger, connectionId, {
      kind: "request",
      method: "GET",
      path: `${parsed.pathname}${parsed.search}`,
      headers: sanitizeHeaders(request.headers),
      body: "",
      bodyBytes: 0,
      truncated: false
    }));
    const upstreamUrl = new URL(`${mappedPath.pathname}${mappedPath.search}`, webSocketBaseUrl(options));
    const protocols = parseProtocols(request.headers["sec-websocket-protocol"]);
    const upstream = new WebSocket(upstreamUrl, protocols, {
      headers: { ...transparentWebSocketHeaders(request.headers), ...options.requestHeaders },
      perMessageDeflate: true
    });
    let responseHeaders: string[] = [];
    let accepted = false;
    let rejected = false;
    socket.once("close", () => {
      if (!accepted && upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
    });
    upstream.once("upgrade", (upstreamResponse) => {
      responseHeaders = transparentWebSocketResponseHeaders(upstreamResponse.rawHeaders);
      if (observed && !options.apiTarget) safelyObserve(store, () => syncAccountUsageFromHeaders(resolveProxyAccount(request, store), upstreamResponse.headers, store));
    });
    upstream.once("unexpected-response", (_client, upstreamResponse) => {
      rejected = true;
      // Preserve failed handshake status, business headers, and body (including non-JSON errors).
      const headers = transparentResponseHeaders(upstreamResponse.headers);
      socket.write(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || "Error"}\r\n`);
      for (const [name, values] of Object.entries(headers)) {
        for (const value of Array.isArray(values) ? values : [values]) {
          if (value !== undefined) socket.write(`${name}: ${value}\r\n`);
        }
      }
      socket.write("Connection: close\r\n\r\n");
      upstreamResponse.once("error", () => socket.destroy());
      upstreamResponse.pipe(socket);
      if (debugEnabled) safelyObserve(store, () => writeWebSocketDebug(apiDebugLogger, connectionId, {
        kind: "response",
        status: upstreamResponse.statusCode || 502,
        message: upstreamResponse.statusMessage || "",
        durationMs: Date.now() - startedAt
      }));
    });
    upstream.once("error", (error) => {
      if (!accepted && !rejected && !socket.destroyed) rejectUpgrade(socket, 502, "Unable to connect to the upstream WebSocket.");
      store.addAppLog?.({ level: "error", scope: "gateway", action: "account-proxy-websocket", status: "failed", message: error.message });
    });
    upstream.once("open", () => {
      accepted = true;
      const selectedProtocol = upstream.protocol || "";
      Object.assign(request, {
        accountProxySelectedProtocol: selectedProtocol,
        accountProxyResponseHeaders: responseHeaders
      });
      server.handleUpgrade(request, socket, head, (downstream) => {
        const controller = new AbortController();
        const context = { downstream, upstream, controller };
        activeWebSockets.add(context);
        notifyStatus();
        const observer = observed ? createAccountModeResponsesObserver({
          store,
          accountId: options.apiTarget ? "" : resolveProxyAccount(request, store)?.id || String(settings.codex_selected_account_id || ""),
          target: options.apiTarget || null,
          quotaAccount: options.apiTarget ? null : resolveProxyAccount(request, store),
          request,
          requestPath: PUBLIC_RESPONSES_PATH,
          upstreamPath: `${mappedPath.pathname}${mappedPath.search}`,
          settings,
          getModelPricing: options.getModelPricing
        }) : null;
        if (debugEnabled) safelyObserve(store, () => writeWebSocketDebug(apiDebugLogger, connectionId, {
          kind: "response",
          status: 101,
          headers: sanitizeHeaders(Object.fromEntries(responseHeaders.map((header) => splitHeader(header)))),
          durationMs: Date.now() - startedAt,
          upstreamUrl: upstreamUrl.toString()
        }));
        let connectionModel = "";
        bridgeWebSockets({
          downstream,
          upstream,
          controller,
          bufferHighWaterBytes: positiveInteger(settings.gateway_websocket_buffer_high_water_bytes, 2 * 1024 * 1024),
          onDownstreamMessage: (data, isBinary) => {
            if (options.allowedModels) {
              let payload: Record<string, unknown>;
              try { payload = JSON.parse(rawDataToBuffer(data).toString("utf8")); }
              catch { payload = {}; }
              const model = String(payload?.model || connectionModel);
              if (!payload || !options.allowedModels.includes(model)) {
                downstream.send(JSON.stringify({ type: "error", error: { code: "model_not_allowed", message: "只能使用所选第三方渠道的可用模型。" } }));
                return false;
              }
              connectionModel = model;
            }
            safelyObserve(store, () => observer?.onDownstreamMessage(data, isBinary));
            if (debugEnabled) safelyObserve(store, () => writeWebSocketMessage(apiDebugLogger, connectionId, "request", data, isBinary));
            return data;
          },
          onUpstreamMessage: (data, isBinary) => {
            safelyObserve(store, () => observer?.onUpstreamMessage(data, isBinary));
            if (debugEnabled) safelyObserve(store, () => writeWebSocketMessage(apiDebugLogger, connectionId, "response", data, isBinary));
            return data;
          }
        });
        const cleanup = (code: number, reason: Buffer): void => {
          safelyObserve(store, () => observer?.onClose(code, reason));
          observer?.dispose();
          activeWebSockets.delete(context);
          notifyStatus();
        };
        downstream.once("close", cleanup);
      });
    });
  };

  return {
    server,
    handleUpgrade,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
};

const writeDebugResponse = (
  logger: ApiDebugLogger,
  id: string,
  status: number,
  headers: Record<string, unknown>,
  capture: ReturnType<typeof createBodyCapture> | null,
  startedAt: number,
  upstreamUrl: URL
): void => logger.write({
  ts: new Date().toISOString(),
  id,
  kind: "response",
  mode: "account_proxy",
  transport: "http",
  status,
  headers: sanitizeHeaders(headers),
  ...(capture?.snapshot() || previewBody("", DEFAULT_BODY_LIMIT_BYTES)),
  durationMs: Date.now() - startedAt,
  upstreamUrl: upstreamUrl.toString()
});

const writeWebSocketDebug = (logger: ApiDebugLogger, id: string, entry: Record<string, unknown>): void => logger.write({
  ts: new Date().toISOString(),
  id,
  kind: entry.kind === "response" ? "response" : "request",
  mode: "account_proxy",
  transport: "websocket",
  ...entry
});

const writeWebSocketMessage = (logger: ApiDebugLogger, id: string, kind: "request" | "response", data: RawData, isBinary: boolean): void => {
  const buffer = rawDataToBuffer(data);
  const preview = previewBody(buffer, logger.bodyLimitBytes || DEFAULT_BODY_LIMIT_BYTES);
  writeWebSocketDebug(logger, id, {
    kind,
    message: preview.body,
    messageBytes: preview.bodyBytes,
    truncated: preview.truncated,
    binary: isBinary
  });
};

const transparentRequestHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders => filterHeaders(headers, new Set([
  "host", "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authorization"
]));

const transparentResponseHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders => filterHeaders(headers, new Set([
  "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization"
]));

const transparentWebSocketHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders => filterHeaders(headers, new Set([
  "host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"
]));

const filterHeaders = (headers: IncomingHttpHeaders, blocked: Set<string>): IncomingHttpHeaders => {
  const connectionTokens = new Set(String(headers.connection || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (blocked.has(name.toLowerCase()) || connectionTokens.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
};

const transparentWebSocketResponseHeaders = (rawHeaders: string[]): string[] => {
  const blocked = new Set(["connection", "upgrade", "sec-websocket-accept", "sec-websocket-extensions", "sec-websocket-protocol"]);
  const result: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] || "";
    const value = rawHeaders[index + 1] || "";
    if (name && !blocked.has(name.toLowerCase())) result.push(`${name}: ${value}`);
  }
  return result;
};

const rejectUpgrade = (socket: Duplex, status: number, message: string): void => {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: { message } });
  socket.end([
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Error"}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body
  ].join("\r\n"));
};

const isSupportedProxyPath = (pathname: string, _options: AccountModeProxyOptions): boolean => pathname.startsWith("/v1/");

const upstreamRequestPath = (parsed: URL, options: AccountModeProxyOptions): { pathname: string; search: string } => ({
  pathname: options.apiTarget
    ? `${new URL(upstreamBaseUrl(options)).pathname.replace(/\/+$/, "")}${parsed.pathname.slice(3)}`
    : `/backend-api/codex${parsed.pathname.slice(3)}`,
  search: parsed.search
});

const upstreamBaseUrl = (options: AccountModeProxyOptions): string => String(options.upstreamBaseUrl || DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, "");

const webSocketBaseUrl = (options: AccountModeProxyOptions): string => upstreamBaseUrl(options)
  .replace(/^https:/, "wss:")
  .replace(/^http:/, "ws:");

const selectedAccount = (settings: Record<string, string>): { id: string } | null => {
  const id = String(settings.codex_selected_account_id || "").trim();
  return id ? { id } : null;
};

/** 根据实际转发的身份匹配额度账号，避免切换选中账号后写错快照。 */
const resolveProxyAccount = (request: IncomingMessage, store: ProxyStore): GatewayAccountQuota | null => {
  const accounts = store.listAccounts?.() ?? [];
  const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const accountId = String(request.headers["chatgpt-account-id"] || "");
  const matching = accounts.filter((account) => accountId
    ? (account.account_id || account.workspace_id) === accountId
    : Boolean(token && account.access_token === token));
  return matching.find((account) => token && account.access_token === token) ?? (matching.length === 1 ? matching[0]! : null);
};

const parseProtocols = (value: string | string[] | undefined): string[] => String(Array.isArray(value) ? value.join(",") : value || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const rawDataToBuffer = (data: RawData): Buffer => {
  if (Array.isArray(data)) return Buffer.concat(data.map(rawDataToBuffer));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(String(data), "utf8");
};

const splitHeader = (header: string): [string, string] => {
  const index = header.indexOf(":");
  return index < 0 ? [header, ""] : [header.slice(0, index).trim(), header.slice(index + 1).trim()];
};

const positiveInteger = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
};

const proxyAbortError = (message: string): Error => Object.assign(new Error(message), { code: "account_proxy_stopped" });

const safelyObserve = (store: ProxyStore, observe: () => unknown): void => {
  try {
    observe();
  } catch (error) {
    logObservationFailure(store, error);
  }
};

const logObservationFailure = (store: ProxyStore, error: unknown): void => {
  try {
    store.addAppLog?.({
      level: "warn",
      scope: "gateway",
      action: "observe",
      status: "failed",
      message: `记录 Responses 调用失败：${error instanceof Error ? error.message : String(error)}`
    });
  } catch {}
};
