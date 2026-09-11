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

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const RESPONSES_PATH = "/backend-api/codex/responses";
const PUBLIC_RESPONSES_PATH = "/v1/responses";
const DEFAULT_UPSTREAM_BASE_URL = "https://chatgpt.com";

type Dynamic = any;

interface AccountModeProxyOptions {
  upstreamBaseUrl?: string;
  getModelPricing?: ((modelId: string) => ModelPricing | null | undefined) | undefined;
}

interface ProxyStore {
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
 * 将账号模式透明代理挂载到现有 API 服务，不创建额外监听端口。
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
    handleHttp: (request: IncomingMessage, response: ServerResponse) => handleHttpRequest(
      request,
      response,
      store,
      apiDebugLogger,
      activeRequests,
      notifyStatus,
      options
    ),
    handleUpgrade: websocket.handleUpgrade,
    close: async () => {
      for (const request of activeRequests) request.destroy(proxyAbortError("API 服务正在停止。"));
      for (const context of activeWebSockets) context.controller.abort(proxyAbortError("API 服务正在停止。"));
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
  const observed = request.method === "POST" && mappedPath.pathname === RESPONSES_PATH;
  const settings = store.getSettings();
  const debugEnabled = observed && settings.debug_api_logging === "true" && apiDebugLogger.isEnabled();
  const requestId = debugEnabled ? randomUUID() : "";
  const requestCapture = observed ? createBodyCapture(apiDebugLogger.bodyLimitBytes || DEFAULT_BODY_LIMIT_BYTES) : null;
  const responseCapture = debugEnabled ? createBodyCapture(apiDebugLogger.bodyLimitBytes || DEFAULT_BODY_LIMIT_BYTES) : null;
  const usageParser = observed ? createSseUsageParser() : null;
  const upstreamUrl = new URL(`${mappedPath.pathname}${mappedPath.search}`, upstreamBaseUrl(options));
  const outgoingHeaders = transparentRequestHeaders(request.headers);
  const transport = upstreamUrl.protocol === "https:" ? https : http;
  let finished = false;
  let clientRequest: http.ClientRequest | null = null;

  const finishLog = (statusCode: number, message: string | null): void => {
    if (!observed || finished) return;
    finished = true;
    const model = modelFromBody(requestCapture?.snapshot().body || "");
    try {
      store.addTokenLog(buildResponsesRequestLog({
        account: selectedAccount(settings),
        method: request.method || "POST",
        requestPath: PUBLIC_RESPONSES_PATH,
        upstreamPath: `${mappedPath.pathname}${mappedPath.search}`,
        headers: request.headers,
        status: statusCode,
        durationMs: Date.now() - startedAt,
        usage: usageParser?.latestUsage() || emptyUsage(),
        settings,
        clientModel: model,
        upstreamModel: model,
        modelPricing: options.getModelPricing?.(model),
        message
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
      response.writeHead(upstreamResponse.statusCode || 502, transparentResponseHeaders(upstreamResponse.headers));
      upstreamResponse.on("data", (chunk: Buffer) => {
        usageParser?.feed(chunk);
        responseCapture?.push(chunk);
      });
      upstreamResponse.once("end", () => {
        finishLog(upstreamResponse.statusCode || 502, null);
        if (debugEnabled) writeDebugResponse(apiDebugLogger, requestId, upstreamResponse.statusCode || 0, upstreamResponse.headers, responseCapture, startedAt, upstreamUrl);
        resolve();
      });
      upstreamResponse.once("error", reject);
      upstreamResponse.pipe(response);
    });
    activeRequests.add(clientRequest);
    notifyStatus();
    clientRequest.once("error", reject);
    request.on("data", (chunk: Buffer) => requestCapture?.push(chunk));
    request.once("end", () => {
      if (!debugEnabled) return;
      apiDebugLogger.write({
        ts: new Date().toISOString(),
        id: requestId,
        kind: "request",
        mode: "account_proxy",
        transport: "http",
        method: request.method || "POST",
        path: `${parsed.pathname}${parsed.search}`,
        headers: sanitizeHeaders(request.headers),
        ...requestCapture?.snapshot()
      });
    });
    response.once("close", () => {
      if (response.writableEnded) return;
      clientRequest?.destroy(proxyAbortError("客户端已取消请求。"));
      finishLog(499, "Client cancelled the request.");
    });
    request.pipe(clientRequest);
  }).catch((error) => {
    const cancelled = response.destroyed || request.destroyed;
    finishLog(cancelled ? 499 : 502, error instanceof Error ? error.message : String(error));
    if (debugEnabled) writeDebugResponse(apiDebugLogger, requestId, cancelled ? 499 : 502, response.getHeaders(), responseCapture, startedAt, upstreamUrl);
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
  options: AccountModeProxyOptions
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
    const parsed = new URL(request.url || "/", "http://localhost");
    if (!isSupportedProxyPath(parsed.pathname, options)) {
      rejectUpgrade(socket, 404, "Unrecognized request URL.");
      return;
    }
    const mappedPath = upstreamRequestPath(parsed, options);
    const observed = mappedPath.pathname === RESPONSES_PATH;
    const startedAt = Date.now();
    const settings = store.getSettings();
    const debugEnabled = observed && settings.debug_api_logging === "true" && apiDebugLogger.isEnabled();
    const connectionId = randomUUID();
    if (debugEnabled) writeWebSocketDebug(apiDebugLogger, connectionId, {
      kind: "request",
      method: "GET",
      path: `${parsed.pathname}${parsed.search}`,
      headers: sanitizeHeaders(request.headers),
      body: "",
      bodyBytes: 0,
      truncated: false
    });
    const upstreamUrl = new URL(`${mappedPath.pathname}${mappedPath.search}`, webSocketBaseUrl(options));
    const protocols = parseProtocols(request.headers["sec-websocket-protocol"]);
    const upstream = new WebSocket(upstreamUrl, protocols, {
      headers: transparentWebSocketHeaders(request.headers),
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
    });
    upstream.once("unexpected-response", (_client, upstreamResponse) => {
      rejected = true;
      upstreamResponse.resume();
      rejectUpgrade(socket, upstreamResponse.statusCode || 502, upstreamResponse.statusMessage || "Upstream rejected the WebSocket request.");
      if (debugEnabled) writeWebSocketDebug(apiDebugLogger, connectionId, {
        kind: "response",
        status: upstreamResponse.statusCode || 502,
        message: upstreamResponse.statusMessage || "",
        durationMs: Date.now() - startedAt
      });
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
          accountId: String(settings.codex_selected_account_id || ""),
          request,
          requestPath: PUBLIC_RESPONSES_PATH,
          upstreamPath: `${mappedPath.pathname}${mappedPath.search}`,
          settings,
          getModelPricing: options.getModelPricing,
          onIdleTimeout: () => controller.abort(proxyAbortError("WebSocket 响应等待超时。"))
        }) : null;
        if (debugEnabled) writeWebSocketDebug(apiDebugLogger, connectionId, {
          kind: "response",
          status: 101,
          headers: sanitizeHeaders(Object.fromEntries(responseHeaders.map((header) => splitHeader(header)))),
          durationMs: Date.now() - startedAt,
          upstreamUrl: upstreamUrl.toString()
        });
        bridgeWebSockets({
          downstream,
          upstream,
          controller,
          bufferHighWaterBytes: positiveInteger(settings.gateway_websocket_buffer_high_water_bytes, 2 * 1024 * 1024),
          onDownstreamMessage: (data, isBinary) => {
            safelyObserve(store, () => observer?.onDownstreamMessage(data, isBinary));
            if (debugEnabled) writeWebSocketMessage(apiDebugLogger, connectionId, "request", data, isBinary);
            return data;
          },
          onUpstreamMessage: (data, isBinary) => {
            safelyObserve(store, () => observer?.onUpstreamMessage(data, isBinary));
            if (debugEnabled) writeWebSocketMessage(apiDebugLogger, connectionId, "response", data, isBinary);
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

const upstreamRequestPath = (parsed: URL, _options: AccountModeProxyOptions): { pathname: string; search: string } => ({
  pathname: `/backend-api/codex${parsed.pathname.slice(3)}`,
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

const modelFromBody = (body: string): string => {
  try {
    const payload = JSON.parse(body) as { model?: unknown };
    return String(payload.model || "").trim();
  } catch {
    return "";
  }
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
