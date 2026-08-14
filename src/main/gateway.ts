type Dynamic = any;

import http from "node:http";
import { pickGatewayAccount } from "./selection.ts";
import { createGatewayRouting } from "./gateway-routing.ts";
import { createGatewayWebSocketGateway } from "./gateway-websocket.ts";
import { readCurrentCodexModel } from "./codex-cli-auth.ts";
import { estimateUpstreamCost } from "./upstreams/cost-estimator.ts";
import { extractTokenUsage, createSseUsageParser, emptyUsage } from "./gateway/usage-parser.ts";
import { adaptCompactionStream, isCompactionTriggerRequest, rewriteGatewayCompactionRequest } from "./gateway/compaction-adapter.ts";
import { AUTO_REVIEW_MODEL_ID, isAutoReviewRequest, resolveAutoReviewFallback } from "./gateway/auto-review.ts";
import {
  syncAccountUsageFromHeaders,
  buildCodexQuotaHeaders,
  buildCodexQuotaHeaderDetail,
  buildCodexQuotaSnapshot,
  buildAccountPoolQuotaSummary,
  buildExternalQuotaHeaders,
  buildExternalQuotaSnapshot,
  isQuotaExhaustedResponse,
  isAuthExpiredResponse
} from "./gateway/quota.ts";
import {
  matchGatewayRoute,
  buildGatewayRequest,
  buildUpstreamUrl,
  pathFromUrl,
  gatewayErrorMessage,
  buildUpstreamHeaders,
  setHeader,
  stripSubscriptionHeaders,
  positiveSetting,
  connectionHeaderTokens,
  parseAffinitySnapshot,
  isLoopbackHost,
  isStrongGatewayApiKey
} from "./gateway/protocol.ts";
import {
  writeResponseChunk,
  readBody,
  readResponseBody,
  createRequestLifecycle,
  createLinkedAbortController,
  scheduleAbort,
  abortController,
  cancellationKind,
  cancellationMessage
} from "./gateway-lifecycle.ts";

const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_ERROR_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_COMPACTION_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_UNARY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2 * 1000;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 1000;

function createGateway(store: Dynamic, authService: Dynamic, hooks: Dynamic = {}) {
  let server: Dynamic = null;
  let state = { running: false, url: "", error: "" };
  const activeRequests = new Set<Dynamic>();
  const activeWebSockets = new Set<Dynamic>();
  const sockets = new Set<Dynamic>();
  const routing = createGatewayRouting({
    snapshot: parseAffinitySnapshot(store.getSettings().gateway_affinity_state_json),
    getIgnoreFiveHourLimit: () => store.getSettings().ignore_five_hour_limit === "true",
    getSessionAffinityTtlMs: () => positiveSetting(store.getSettings().gateway_session_affinity_ttl_hours, 168) * 60 * 60 * 1000,
    onChanged(snapshot: Dynamic) {
      store.saveSettings({ gateway_affinity_state_json: JSON.stringify(snapshot) });
    }
  });
  let websocketGateway: Dynamic = null;

  async function start() {
    if (server) return status();
    const settings = store.getSettings();
    const host = settings.gateway_host || "127.0.0.1";
    const port = Number(settings.gateway_port || 1455);
    if (!isLoopbackHost(host) && !isStrongGatewayApiKey(settings.gateway_api_key)) {
      throw new Error("非回环监听地址必须配置至少 24 个字符的随机 API Key。");
    }
    const runtime = { activeRequests, activeWebSockets, routing };
    server = http.createServer((req: Dynamic, res: Dynamic) => handleRequest(req, res, store, authService, hooks, runtime));
    websocketGateway = createGatewayWebSocketGateway({
      store,
      hooks,
      runtime,
      helpers: {
        buildUpstreamUrl,
        buildUpstreamHeaders,
        setHeader,
        buildCodexQuotaHeaders,
        buildCodexQuotaSnapshot,
        buildExternalQuotaSnapshot,
        syncAccountUsageFromHeaders,
        readCurrentCodexModel: hooks.readCurrentCodexModel || readCurrentCodexModel,
        isQuotaExhaustedResponse,
        isAuthExpiredResponse,
        extractTokenUsage
      }
    });
    server.on("upgrade", websocketGateway.handleUpgrade);
    server.on("connection", (socket: Dynamic) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Dynamic) => {
          server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    } catch (error: Dynamic) {
      const failedServer = server;
      server = null;
      const failedWebsocketGateway = websocketGateway;
      websocketGateway = null;
      failedServer?.removeAllListeners();
      await failedWebsocketGateway?.close();
      state = { running: false, url: "", error: String(error?.message || error) };
      throw error;
    }
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    state = { running: true, url: `http://${host}:${listeningPort}`, error: "" };
    return status();
  }

  async function stop() {
    if (!server) {
      state = { running: false, url: "", error: "" };
      return status();
    }
    const closing = server;
    server = null;
    const closingWebsocketGateway = websocketGateway;
    websocketGateway = null;
    const settings = store.getSettings();
    const graceMs = positiveSetting(settings.gateway_shutdown_grace_ms, DEFAULT_SHUTDOWN_GRACE_MS);
    const closePromise = new Promise<void>((resolve) => closing.close(resolve));
    for (const controller of activeRequests) abortController(controller, "gateway_shutdown", "Gateway is shutting down.");
    for (const controller of activeWebSockets) abortController(controller, "gateway_shutdown", "Gateway is shutting down.");
    let forcedSocketCount = 0;
    let forceTimer = null;
    const forcePromise = new Promise<void>((resolve) => {
      forceTimer = setTimeout(() => {
        forcedSocketCount = sockets.size;
        if (typeof closing.closeAllConnections === "function") closing.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        resolve();
      }, graceMs);
    });
    await Promise.race([closePromise, forcePromise]);
    await closingWebsocketGateway?.close();
    if (forceTimer) clearTimeout(forceTimer);
    if (forcedSocketCount > 0 && store.addAppLog) {
      store.addAppLog({
        level: "warn",
        scope: "gateway",
        action: "stop",
        status: "forced",
        message: `API 服务停机宽限期结束，强制关闭 ${forcedSocketCount} 个残留连接。`
      });
    }
    state = { running: false, url: "", error: "" };
    return status();
  }

  function status() {
    return {
      ...state,
      activeHttpRequests: activeRequests.size,
      activeWebSockets: activeWebSockets.size
    };
  }

  return { start, stop, status };
}

async function handleRequest(req: Dynamic, res: Dynamic, store: Dynamic, authService: Dynamic, hooks: Dynamic, runtime: Dynamic = {}) {
  const started = Date.now();
  const settings = store.getSettings();
  const parsedUrl = new URL(req.url, "http://localhost");
  const pathname = parsedUrl.pathname;
  if (req.method === "GET" && pathname === "/auth/callback") {
    return handleAuthCallback(parsedUrl, res, authService);
  }
  const route = matchGatewayRoute(req.method, pathname);
  if (!route.pathAllowed) {
    return sendJson(res, 404, { error: { message: "Unrecognized request URL." } });
  }
  if (!route.methodAllowed) {
    res.setHeader("allow", route.allowedMethods.join(", "));
    return sendJson(res, 405, { error: { message: "Method not allowed." } });
  }
  const auth = req.headers.authorization || "";
  const localKey = settings.gateway_api_key || "";
  if (localKey && auth !== `Bearer ${localKey}`) {
    return sendJson(res, 401, { error: { message: "Incorrect API key provided." } });
  }
  if (req.method === "GET" && pathname === "/v1/models" && hooks.upstreamService?.listGatewayModels) {
    return sendJson(res, 200, { object: "list", data: hooks.upstreamService.listGatewayModels() });
  }
  const maxConcurrentRequests = positiveSetting(settings.gateway_max_concurrent_requests, 16);
  if (runtime.activeRequests?.size >= maxConcurrentRequests) {
    return sendJson(res, 503, { error: { message: "The gateway has reached its concurrent request limit." } });
  }

  const lifecycle = createRequestLifecycle(req, res, runtime.activeRequests);
  const totalTimeoutMs = isStreamingResponsesPath(pathname)
    ? 0
    : positiveSetting(settings.gateway_unary_timeout_ms, legacyUnaryTimeout(settings));
  const stopTotalTimeout = scheduleAbort(lifecycle.controller, totalTimeoutMs, "unary_timeout", "Upstream request timed out.");
  let request = null;
  let accountForLog: Dynamic = null;
  let targetForLog: Dynamic = null;
  let routeResultForLog: Dynamic = null;
  let releaseAccountLoad = () => {};
  let disposeUpstream = () => {};
  try {
    const bodyLimit = positiveSetting(settings.gateway_request_body_limit_bytes, DEFAULT_REQUEST_BODY_LIMIT_BYTES);
    const rawIncomingBody = await readBody(req, bodyLimit, lifecycle.signal);
    const rewrittenCompactionRequest = pathname === "/v1/responses"
      ? rewriteGatewayCompactionRequest(rawIncomingBody)
      : { adapted: false, body: rawIncomingBody };
    const incomingBody = rewrittenCompactionRequest.body;
    request = buildGatewayRequest(settings.upstream_base_url, req.url, incomingBody);
    const routeContext = runtime.routing?.context(req.headers) || { established: false, accountId: "" };
    if (routeContext.unknownTurnState) {
      return sendJson(res, 409, {
        error: { message: "The gateway cannot safely route this existing turn state. Start a new Codex turn and try again." }
      });
    }
    const onAccountSelected = (account: Dynamic) => {
      if (!account?.id || account.id === accountForLog?.id) return;
      runtime.routing?.reserveSession(routeContext, account);
      releaseAccountLoad();
      releaseAccountLoad = runtime.routing?.beginRequest(account.id) || (() => {});
      accountForLog = account;
    };
    const payload = parseResponsesPayload(incomingBody);
    const selectedModel = String(payload?.model || "");
    const isAutoReview = isAutoReviewRequest(payload);
    const apiUpstream = selectedModel
      ? hooks.upstreamService?.findRuntimeByModel?.(selectedModel)
      : null;
    const result = isAutoReview && !apiUpstream
      ? await callAutoReviewTarget({
        req,
        request,
        incomingBody,
        settings,
        store,
        hooks,
        runtime,
        routeContext,
        signal: lifecycle.signal,
        onAccountSelected,
        clientModel: selectedModel
      })
      : apiUpstream
        ? await callDirectApiTarget({ req, request, incomingBody, settings, hooks, signal: lifecycle.signal, upstream: apiUpstream, modelId: selectedModel })
        : await callSubscriptionTarget({
          req,
          request,
          settings,
          store,
          hooks,
          runtime,
          routeContext,
          signal: lifecycle.signal,
          onAccountSelected
        });
    disposeUpstream = result.dispose || (() => {});
    routeResultForLog = result;
    const { account, target, response, body, tokenUsage: errorUsage } = result;
    accountForLog = account;
    targetForLog = target;
    const actualUpstreamUrl = result.upstreamUrl || request.upstreamUrl;
    const compactAdaptEnabled = target?.kind === "responses_api"
      && target?.compactAdaptEnabled === true
      && pathname === "/v1/responses"
      && isCompactionTriggerRequest(incomingBody);

    if (response.status >= 200 && response.status < 300) {
      if (target?.kind !== "responses_api") {
        runtime.routing?.observeResponse(routeContext, account, response.headers);
      }
      res.statusCode = response.status;
      copyHeadersToResponse(response.headers, res, settings, store, target?.kind !== "responses_api");
      const usageParser = createSseUsageParser();
      let completedResponseForwarded = false;
      if (response.body) {
        const reader = response.body.getReader();
        if (compactAdaptEnabled) {
          try {
            await forwardAdaptedCompactionStream({
              reader,
              res,
              signal: lifecycle.signal,
              controller: lifecycle.controller,
              usageParser,
              limitBytes: positiveSetting(settings.gateway_compaction_response_limit_bytes, DEFAULT_COMPACTION_RESPONSE_LIMIT_BYTES),
              idleTimeoutMs: positiveSetting(settings.gateway_stream_idle_timeout_ms, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
              totalTimeoutMs: positiveSetting(settings.gateway_unary_timeout_ms, DEFAULT_UNARY_TIMEOUT_MS)
            });
          } catch (error) {
            if (!(usageParser.responseCompleted() && cancellationKind(error, lifecycle.signal) === "client_cancelled")) throw error;
            await reader.cancel("client closed after response.completed").catch(() => {});
          }
        } else {
          const idleTimeoutMs = isStreamingResponsesPath(pathname)
            ? positiveSetting(settings.gateway_stream_idle_timeout_ms, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
            : 0;
          let stopIdleTimeout = scheduleAbort(lifecycle.controller, idleTimeoutMs, "stream_idle_timeout", "Upstream response stream became idle.");
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              stopIdleTimeout();
              stopIdleTimeout = scheduleAbort(lifecycle.controller, idleTimeoutMs, "stream_idle_timeout", "Upstream response stream became idle.");
              usageParser.feed(value);
              await writeResponseChunk(res, value, lifecycle.signal);
              if (usageParser.responseCompleted()) completedResponseForwarded = true;
            }
          } catch (error) {
            if (!(completedResponseForwarded && cancellationKind(error, lifecycle.signal) === "client_cancelled")) throw error;
            await reader.cancel("client closed after response.completed").catch(() => {});
          } finally {
            stopIdleTimeout();
            if (!res.writableEnded && !res.destroyed) res.end();
          }
        }
      } else {
        res.end();
      }
      const tokenUsage = usageParser.latestUsage();
      store.addTokenLog({
        account_id: account?.id || null,
        method: req.method,
        request_path: request.originalPath,
        upstream_path: pathFromUrl(actualUpstreamUrl),
        session_id: sessionHeaderValue(req.headers),
        version: headerValue(req.headers.version),
        status: response.status,
        duration_ms: Date.now() - started,
        ...tokenUsage,
        ...routeLogFields(result),
        ...costLogFields(result, tokenUsage, settings),
        message: null
      });
    } else {
      res.statusCode = response.status;
      copyHeadersToResponse(response.headers, res, settings, store, target?.kind !== "responses_api");
      res.end(body);
      store.addTokenLog({
        account_id: account?.id || null,
        method: req.method,
        request_path: request.originalPath,
        upstream_path: pathFromUrl(actualUpstreamUrl),
        session_id: sessionHeaderValue(req.headers),
        version: headerValue(req.headers.version),
        status: response.status,
        duration_ms: Date.now() - started,
        ...errorUsage,
        ...routeLogFields(result),
        ...costLogFields(result, errorUsage, settings),
        message: null
      });
    }
  } catch (error: Dynamic) {
    const cancellation = cancellationKind(error, lifecycle.signal);
    const status = Number(error?.statusCode || (cancellation === "client_cancelled" ? 499 : 502));
    const message = cancellationMessage(cancellation, error);
    const requestPath = request?.originalPath || `${pathname}${parsedUrl.search}`;
    const upstreamPath = request?.upstreamUrl ? pathFromUrl(request.upstreamUrl) : pathFromUrl(buildUpstreamUrl(settings.upstream_base_url, req.url));
    if (request && (accountForLog || targetForLog)) {
      store.addTokenLog({
        account_id: accountForLog?.id || null,
        method: req.method,
        request_path: request.originalPath,
        upstream_path: pathFromUrl(request.upstreamUrl),
        session_id: sessionHeaderValue(req.headers),
        version: headerValue(req.headers.version),
        status,
        duration_ms: Date.now() - started,
        ...emptyUsage(),
        ...routeLogFields(routeResultForLog || { account: accountForLog, target: targetForLog }),
        message: gatewayErrorMessage(error, message)
      });
    }
    store.addAppLog({
      level: cancellation === "client_cancelled" ? "info" : "error",
      scope: "gateway",
      action: "request",
      status: cancellation || "failed",
      message: `${req.method || "-"} ${requestPath} -> ${upstreamPath}: ${gatewayErrorMessage(error, message)}`
    });
    if (!res.headersSent && !res.destroyed) {
      const clientMessage = [400, 409, 413, 422].includes(Number(error?.statusCode))
        ? error.message
        : cancellation && cancellation !== "client_cancelled"
          ? "Request timed out."
          : "The server encountered a temporary error and could not complete your request.";
      sendJson(res, status, { error: { message: clientMessage } });
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } finally {
    stopTotalTimeout();
    disposeUpstream();
    releaseAccountLoad();
    lifecycle.dispose();
  }
}

function selectRequestAccount(runtime: Dynamic, routeContext: Dynamic, accounts: Dynamic, store: Dynamic, settings: Dynamic) {
  if (routeContext.established) return runtime.routing.findBoundAccount(routeContext, accounts);
  return runtime.routing?.findPreferredAccount(routeContext, accounts)
    || (runtime.routing ? runtime.routing.selectNewAccount(accounts) : selectInitialGatewayAccount(store, settings));
}

async function callSubscriptionTarget(options: Dynamic) {
  const { req, request, settings, store, hooks, runtime, routeContext, signal, onAccountSelected } = options;
  const routedRequest = requestForSubscriptionTarget(request, settings, hooks);
  let accounts = store.listAccounts();
  let firstAccount = selectRequestAccount(runtime, routeContext, accounts, store, settings);
  if (!firstAccount && hooks.ensureUsableAccounts) {
    await hooks.ensureUsableAccounts();
    accounts = store.listAccounts();
    firstAccount = selectRequestAccount(runtime, routeContext, accounts, store, settings);
  }
  if (!firstAccount) {
    throw gatewayRouteError(503, "SUBSCRIPTION_ACCOUNT_UNAVAILABLE", "The server is currently unavailable. Please try again later.");
  }
  let result: Dynamic;
  try {
    result = await callWithFailover(req, routedRequest, firstAccount, settings, store, hooks, {
      signal,
      allowAccountFailover: !routeContext.established,
      routing: runtime.routing,
      onAccountSelected
    });
  } catch (error) {
    runtime.routing?.releaseSessionReservation(routeContext);
    throw error;
  }
  if (!(result.response?.status >= 200 && result.response?.status < 300)) {
    runtime.routing?.releaseSessionReservation(routeContext, result.account?.id);
  }
  const modelId = String(parseResponsesPayload(request.body)?.model || "");
  return {
    ...result,
    upstreamUrl: routedRequest.upstreamUrl,
    target: {
      id: "builtin-chatgpt-subscription-pool",
      name: "ChatGPT 订阅账号池",
      kind: "chatgpt_subscription_pool",
      credentialRef: result.account?.id || "",
      modelPricing: hooks.upstreamService?.getModelPricing?.("builtin-chatgpt-subscription-pool", modelId)
    },
    attemptCount: result.retried ? 2 : 1,
    attemptChain: [],
    clientModel: modelId,
    upstreamModel: modelId
  };
}

async function callAutoReviewTarget(options: Dynamic) {
  try {
    const result = await callSubscriptionTarget(options);
    if (isQuotaExhaustedResponse(result.response?.status, result.body)) {
      return callAutoReviewFallback(options);
    }
    return result;
  } catch (error: Dynamic) {
    if (error?.code !== "SUBSCRIPTION_ACCOUNT_UNAVAILABLE") throw error;
    return callAutoReviewFallback(options);
  }
}

async function callAutoReviewFallback(options: Dynamic) {
  const fallback = resolveAutoReviewFallback(options.settings, options.hooks);
  if (!fallback) {
    throw gatewayRouteError(
      503,
      "AUTO_REVIEW_FALLBACK_UNAVAILABLE",
      "The subscription account pool is unavailable and no usable auto review fallback model is configured."
    );
  }
  options.store?.addAppLog?.({
    level: "info",
    scope: "gateway",
    action: "auto-review-fallback",
    status: "api-upstream",
    message: `账号池不可用，Auto Review 请求转由第三方渠道模型 ${fallback.model} 处理。`
  });
  return callDirectApiTarget({
    ...options,
    upstream: fallback.upstream,
    modelId: fallback.model,
    clientModel: options.clientModel || AUTO_REVIEW_MODEL_ID,
    incomingBody: rewriteResponsesModel(options.incomingBody, fallback.model)
  });
}

function requestForSubscriptionTarget(request: Dynamic, settings: Dynamic, hooks: Dynamic) {
  let baseUrl = settings.upstream_base_url;
  try {
    const target = hooks.upstreamService?.getRuntime?.("builtin-chatgpt-subscription-pool");
    if (target?.baseUrl) baseUrl = target.baseUrl;
  } catch {
    // Keep the compatible settings fallback when the built-in target is unavailable.
  }
  return { ...request, upstreamUrl: buildUpstreamUrl(baseUrl, request.originalPath) };
}

async function callDirectApiTarget(options: Dynamic) {
  const { req, request, incomingBody, settings, hooks, signal, upstream, modelId, clientModel } = options;
  if (!upstream.enabled) {
    throw gatewayRouteError(409, "MODEL_UPSTREAM_DISABLED", "The API upstream for the selected model is disabled.");
  }
  const started = Date.now();
  try {
    const result = await callApiUpstream({
      req,
      request,
      body: incomingBody,
      upstream,
      settings,
      signal
    });
    hooks.upstreamService.recordRequestOutcome?.(upstream.id, {
      status: result.response.status,
      latencyMs: Date.now() - started
    });
    return {
      ...result,
      account: null,
      target: {
        ...upstream,
        modelPricing: hooks.upstreamService.getModelPricing(upstream.id, modelId)
      },
      attemptCount: 1,
      attemptChain: [],
      clientModel: clientModel || modelId,
      upstreamModel: modelId
    };
  } catch (error: Dynamic) {
    hooks.upstreamService.recordRequestOutcome?.(upstream.id, {
      latencyMs: Date.now() - started,
      message: gatewayErrorMessage(error)
    });
    throw error;
  }
}
async function callApiUpstream(options: Dynamic) {
  const { req, request, body, upstream, settings, signal } = options;
  const timeoutMs = positiveSetting(settings.gateway_connect_timeout_ms, DEFAULT_CONNECT_TIMEOUT_MS);
  const attempt = createLinkedAbortController(signal);
  const stopTimeout = scheduleAbort(attempt.controller, timeoutMs, "connect_timeout", "Upstream connection timed out.");
  const upstreamUrl = buildUpstreamUrl(upstream.baseUrl, request.originalPath);
  let handedOff = false;
  try {
    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildApiUpstreamHeaders(req.headers, upstream, body.length > 0, request.path) as HeadersInit,
      body,
      signal: attempt.signal
    });
    stopTimeout();
    if (response.status >= 200 && response.status < 300) {
      handedOff = true;
      return { response, body: null, tokenUsage: emptyUsage(), dispose: attempt.dispose, upstreamUrl };
    }
    const errorLimit = positiveSetting(settings.gateway_error_body_limit_bytes, DEFAULT_ERROR_BODY_LIMIT_BYTES);
    const responseBody = await readResponseBody(response, errorLimit, attempt.signal);
    return { response, body: responseBody, tokenUsage: extractTokenUsage(responseBody), upstreamUrl };
  } finally {
    stopTimeout();
    if (!handedOff) attempt.dispose();
  }
}

function buildApiUpstreamHeaders(headers: Dynamic, upstream: Dynamic, hasBody: Dynamic, path: Dynamic) {
  const outgoing = buildUpstreamHeaders(headers, { access_token: upstream.apiKey }, hasBody, path);
  for (const [name, value] of Object.entries(upstream.requestHeaders || {})) setHeader(outgoing, name, String(value));
  if (!upstream.apiKey) deleteHeader(outgoing, "authorization");
  stripSubscriptionHeaders(outgoing);
  return outgoing;
}

async function forwardAdaptedCompactionStream(options: Dynamic) {
  const { reader, res, signal, controller, usageParser, limitBytes, idleTimeoutMs, totalTimeoutMs } = options;
  const chunks: Buffer[] = [];
  let size = 0;
  let stopIdleTimeout = scheduleAbort(controller, idleTimeoutMs, "stream_idle_timeout", "Upstream compaction response stream became idle.");
  const stopTotalTimeout = scheduleAbort(controller, totalTimeoutMs, "compaction_timeout", "Upstream compaction response timed out.");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stopIdleTimeout();
      stopIdleTimeout = scheduleAbort(controller, idleTimeoutMs, "stream_idle_timeout", "Upstream compaction response stream became idle.");
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > limitBytes) {
        await reader.cancel("gateway compaction response limit reached").catch(() => {});
        const error: Dynamic = new Error(`Upstream compaction response exceeds the ${limitBytes}-byte gateway limit.`);
        error.statusCode = 502;
        throw error;
      }
      usageParser.feed(value);
      chunks.push(chunk);
    }
  } finally {
    stopIdleTimeout();
    stopTotalTimeout();
  }
  const original = Buffer.concat(chunks, size).toString("utf8");
  const adapted = adaptCompactionStream(original);
  if (!res.writableEnded && !res.destroyed) {
    if (!signal.aborted) {
      res.write(adapted.adapted ? adapted.text : original);
    }
    res.end();
  }
}

function deleteHeader(headers: Dynamic, name: Dynamic) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  if (key) delete headers[key];
}

function parseResponsesPayload(body: Dynamic) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rewriteResponsesModel(body: Dynamic, model: string): Dynamic {
  const parsed = parseResponsesPayload(body);
  if (!parsed) return body;
  parsed.model = model;
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

function routeLogFields(result: Dynamic = {}) {
  const target = result.target || {};
  return {
    upstream_id: target.id || null,
    upstream_name: target.name || null,
    upstream_kind: target.kind || null,
    client_model: result.clientModel || null,
    upstream_model: result.upstreamModel || null,
    attempt_count: result.attemptCount || 1,
    attempt_chain_json: JSON.stringify(result.attemptChain || []),
    credential_ref: target.credentialRef || result.account?.id || null
  };
}

function costLogFields(result: Dynamic, usage: Dynamic, settings: Dynamic) {
  const estimated = estimateUpstreamCost(usage, result?.target?.modelPricing, settings?.billing_currency);
  return estimated ? { estimated_cost: estimated.amount, cost_unit: estimated.unit } : {};
}

function gatewayRouteError(statusCode: Dynamic, code: Dynamic, message: Dynamic): Dynamic {
  const error: Dynamic = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function selectInitialGatewayAccount(store: Dynamic, settings: Dynamic, now = new Date()) {
  const options: Dynamic = dailyRebalanceOptions(settings, now);
  if (settings.ignore_five_hour_limit === "true") options.ignoreFiveHourLimit = true;
  const account = pickGatewayAccount(store.listAccounts(), settings.gateway_current_account_id || "", [], options);
  if (!account) return null;
  const patch: Dynamic = { gateway_current_account_id: account.id };
  if (options.dailyRebalanceDate) patch.gateway_last_daily_rebalance_date = options.dailyRebalanceDate;
  store.saveSettings(patch);
  if (options.dailyRebalanceDate && store.addAppLog) {
    store.addAppLog({
      scope: "gateway",
      action: "daily-rebalance",
      status: "success",
      message: `当天首次 API 服务请求按 7 天剩余额度选择账号：${account.email || account.name || account.id}`
    });
  }
  return account;
}

function dailyRebalanceOptions(settings: Dynamic, now = new Date()): Dynamic {
  const today = dailyRebalanceDateKey(now);
  if (!today || settings.gateway_last_daily_rebalance_date === today) return {};
  return { preferSevenDayQuota: true, dailyRebalanceDate: today };
}

function dailyRebalanceDateKey(value: Dynamic = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  if (!Number.isFinite(year)) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function headerValue(value: Dynamic) {
  if (Array.isArray(value)) return value[0] || "";
  return value ? String(value) : "";
}

function sessionHeaderValue(headers: Dynamic) {
  return headerValue(headers?.session_id)
    || headerValue(headers?.["session-id"])
    || headerValue(headers?.["x-session-id"]);
}

async function callWithFailover(req: Dynamic, request: Dynamic, firstAccount: Dynamic, settings: Dynamic, store: Dynamic, hooks: Dynamic, options: Dynamic = {}) {
  const excluded = new Set<string>();
  let account = firstAccount;
  let lastResult = null;
  let lastAccount = null;
  let quotaRefreshNeeded = false;
  const allowAccountFailover = options.allowAccountFailover !== false;
  const maxAttempts = allowAccountFailover ? Math.max(1, store.listAccounts().length) : 1;
  for (let attempt = 0; attempt < maxAttempts && account; attempt += 1) {
    lastAccount = account;
    options.onAccountSelected?.(account);
    let result: Dynamic = await callUpstream(req, request, account, settings, options.signal);
    if (isAuthExpiredResponse(result.response.status, result.body) && hooks.refreshAccountToken) {
      try {
        const refreshed = await hooks.refreshAccountToken(account.id);
        account = refreshed || account;
        options.onAccountSelected?.(account);
        result = await callUpstream(req, request, account, settings, options.signal);
        result.retried = true;
      } catch (error: Dynamic) {
        store.addAppLog({
          level: "warn",
          scope: "gateway",
          action: "refresh-token",
          status: "failed",
          message: `${request.path} 刷新账号 token 失败：${account.email || account.name || account.id}: ${error.message}`
        });
      }
    }
    if (isAuthExpiredResponse(result.response.status, result.body)) {
      lastResult = result;
      options.routing?.setCooldown(
        account.id,
        positiveSetting(settings.gateway_quota_cooldown_ms, DEFAULT_QUOTA_COOLDOWN_MS)
      );
      if (!allowAccountFailover) break;
      excluded.add(account.id);
      account = options.routing
        ? options.routing.selectNewAccount(store.listAccounts(), Array.from(excluded))
        : pickGatewayAccount(store.listAccounts(), "", Array.from(excluded), { ignoreFiveHourLimit: settings.ignore_five_hour_limit === "true" });
      continue;
    }
    const syncedUsage = syncAccountUsageFromHeaders(account, result.response.headers, store);
    if (!isQuotaExhaustedResponse(result.response.status, result.body)) {
      if (quotaRefreshNeeded) scheduleUsageRefresh(firstAccount, hooks, options.routing, store);
      saveCurrentGatewayAccount(store, account);
      return { account, ...result };
    }
    lastResult = result;
    if (!syncedUsage) {
      const cooldownMs = positiveSetting(settings.gateway_quota_cooldown_ms, DEFAULT_QUOTA_COOLDOWN_MS);
      options.routing?.setCooldown(account.id, cooldownMs);
      quotaRefreshNeeded = true;
    }
    if (!allowAccountFailover) break;
    excluded.add(account.id);
    account = options.routing
      ? options.routing.selectNewAccount(store.listAccounts(), Array.from(excluded))
      : pickGatewayAccount(store.listAccounts(), "", Array.from(excluded), { ignoreFiveHourLimit: settings.ignore_five_hour_limit === "true" });
  }
  if (lastResult && quotaRefreshNeeded && !options.quotaRefreshAttempted && hooks.refreshAllUsage) {
    const retryAccount = await refreshQuotaAndSelectRetryAccount({
      reason: "gateway-quota-without-headers",
      firstAccount,
      settings,
      store,
      hooks,
      routing: options.routing,
      allowAccountFailover
    });
    if (retryAccount) {
      return callWithFailover(req, request, retryAccount, settings, store, hooks, {
        ...options,
        quotaRefreshAttempted: true
      });
    }
  }
  if (lastResult) return { account: lastAccount || firstAccount, ...lastResult };
  throw new Error("No enabled GPT account with an access token is available.");
}

function saveCurrentGatewayAccount(store: Dynamic, account: Dynamic) {
  if (account?.id) store.saveSettings({ gateway_current_account_id: account.id });
}

async function refreshQuotaAndSelectRetryAccount(options: Dynamic) {
  const { firstAccount, settings, store, hooks, routing, allowAccountFailover } = options;
  try {
    const results = await hooks.refreshAllUsage(options.reason);
    const successfulIds = new Set(Array.isArray(results)
      ? results.filter((item: Dynamic) => item?.ok && item.id).map((item: Dynamic) => item.id)
      : []);
    for (const id of successfulIds) routing?.clearCooldown(id);
    const accounts = store.listAccounts();
    if (allowAccountFailover) {
      return routing
        ? routing.selectNewAccount(accounts)
        : pickGatewayAccount(accounts, "", [], { ignoreFiveHourLimit: settings.ignore_five_hour_limit === "true" });
    }
    if (!successfulIds.has(firstAccount.id)) return null;
    return pickGatewayAccount(
      accounts.filter((item: Dynamic) => item.id === firstAccount.id),
      firstAccount.id,
      [],
      { ignoreFiveHourLimit: settings.ignore_five_hour_limit === "true" }
    );
  } catch (error: Dynamic) {
    store.addAppLog?.({
      level: "warn",
      scope: "gateway",
      action: "quota-refresh",
      status: "failed",
      message: `配额错误后刷新账号状态失败：${firstAccount.email || firstAccount.name || firstAccount.id}: ${error.message}`
    });
    return null;
  }
}

function scheduleUsageRefresh(account: Dynamic, hooks: Dynamic, routing: Dynamic, store: Dynamic) {
  Promise.resolve()
    .then(() => hooks.refreshAllUsage("gateway-quota-without-headers"))
    .then((results) => {
      if (!Array.isArray(results)) return;
      for (const item of results) {
        if (item?.ok && item.id) routing?.clearCooldown(item.id);
      }
    })
    .catch((error) => {
      store.addAppLog?.({
        level: "warn",
        scope: "gateway",
        action: "quota-refresh",
        status: "failed",
        message: `配额错误后刷新账号状态失败：${account.email || account.name || account.id}: ${error.message}`
      });
    });
}

async function callUpstream(req: Dynamic, request: Dynamic, account: Dynamic, settings: Dynamic, parentSignal: Dynamic) {
  const timeoutMs = positiveSetting(settings.gateway_connect_timeout_ms, DEFAULT_CONNECT_TIMEOUT_MS);
  const attempt = createLinkedAbortController(parentSignal);
  const stopTimeout = scheduleAbort(attempt.controller, timeoutMs, "connect_timeout", "Upstream connection timed out.");
  const hasBody = request.body.length > 0 && req.method !== "GET" && req.method !== "HEAD";
  let handedOff = false;
  try {
    const upstream = await fetch(request.upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, account, hasBody, request.path) as HeadersInit,
      body: hasBody ? request.body : undefined,
      signal: attempt.signal
    });
    stopTimeout();
    if (upstream.status >= 200 && upstream.status < 300) {
      handedOff = true;
      return { response: upstream, body: null, tokenUsage: emptyUsage(), dispose: attempt.dispose };
    }
    const errorLimit = positiveSetting(settings.gateway_error_body_limit_bytes, DEFAULT_ERROR_BODY_LIMIT_BYTES);
    const responseBody = await readResponseBody(upstream, errorLimit, attempt.signal);
    return { response: upstream, body: responseBody, tokenUsage: extractTokenUsage(responseBody) };
  } finally {
    stopTimeout();
    if (!handedOff) attempt.dispose();
  }
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "set-cookie",
  "x-codex-primary-used-percent",
  "x-codex-primary-window-minutes",
  "x-codex-primary-reset-after-seconds",
  "x-codex-secondary-used-percent",
  "x-codex-secondary-window-minutes",
  "x-codex-secondary-reset-after-seconds",
  "x-codex-plan-type",
  "x-codex-active-limit",
  "x-codex-credits-balance",
  "x-codex-credits-has-credits",
  "x-codex-credits-unlimited"
]);

function copyHeadersToResponse(headers: Dynamic, res: Dynamic, settings: Dynamic = {}, store: Dynamic = null, subscriptionPool = true) {
  const connectionHeaders = connectionHeaderTokens(headers);
  headers.forEach((value: Dynamic, key: Dynamic) => {
    const lower = key.toLowerCase();
    const subscriptionHeader = lower.startsWith("openai-") || lower.startsWith("chatgpt-") || lower.startsWith("x-codex-");
    if (!BLOCKED_RESPONSE_HEADERS.has(lower) && !connectionHeaders.has(lower) && (subscriptionPool || !subscriptionHeader)) {
      res.setHeader(key, value);
    }
  });
  if (subscriptionPool && settings.codex_quota_headers_mode === "rewrite") {
    const accounts = store?.listAccounts ? store.listAccounts() : [];
    const detail = buildCodexQuotaHeaderDetail(accounts, undefined, { ignoreFiveHourLimit: settings.ignore_five_hour_limit === "true" });
    setCodexQuotaHeaders(res, detail.headers);
  } else if (!subscriptionPool) {
    setCodexQuotaHeaders(res, buildExternalQuotaHeaders());
  }
}

function setCodexQuotaHeaders(res: Dynamic, headers: Dynamic) {
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

async function handleAuthCallback(parsedUrl: Dynamic, res: Dynamic, authService: Dynamic) {
  if (!authService) return sendHtml(res, 500, "Codexia", "登录服务未初始化。");
  try {
    await authService.completeCallback(parsedUrl.searchParams);
    return sendHtml(res, 200, "登录成功", "账号已保存，可以关闭这个浏览器页面并回到 Codexia。");
  } catch (error: Dynamic) {
    return sendHtml(res, 500, "登录失败", String(error?.message || error));
  }
}

function legacyUnaryTimeout(settings: Dynamic) {
  return positiveSetting(settings.request_timeout_ms, DEFAULT_UNARY_TIMEOUT_MS);
}

function isStreamingResponsesPath(pathname: Dynamic) {
  return pathname === "/v1/responses";
}

function sendJson(res: Dynamic, status: Dynamic, body: Dynamic) {
  if (res.writableEnded) return;
  res.statusCode = status;
  if (!res.headersSent) res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendHtml(res: Dynamic, status: Dynamic, title: Dynamic, message: Dynamic) {
  if (res.writableEnded) return;
  res.statusCode = status;
  if (!res.headersSent) res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;padding:40px"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`);
}

function escapeHtml(value: Dynamic) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char as keyof Record<string, string>] || char);
}

export {
  createGateway,
  buildUpstreamUrl,
  buildUpstreamHeaders,
  buildGatewayRequest,
  matchGatewayRoute,
  buildCodexQuotaHeaders,
  buildCodexQuotaHeaderDetail,
  buildCodexQuotaSnapshot,
  buildAccountPoolQuotaSummary,
  callWithFailover,
  selectInitialGatewayAccount,
  dailyRebalanceDateKey,
  syncAccountUsageFromHeaders,
  extractTokenUsage,
  createSseUsageParser,
  isQuotaExhaustedResponse,
  isAuthExpiredResponse,
  isStrongGatewayApiKey
};

export default {
  createGateway,
  buildUpstreamUrl,
  buildUpstreamHeaders,
  buildGatewayRequest,
  matchGatewayRoute,
  buildCodexQuotaHeaders,
  buildCodexQuotaHeaderDetail,
  buildCodexQuotaSnapshot,
  buildAccountPoolQuotaSummary,
  callWithFailover,
  selectInitialGatewayAccount,
  dailyRebalanceDateKey,
  syncAccountUsageFromHeaders,
  extractTokenUsage,
  createSseUsageParser,
  isQuotaExhaustedResponse,
  isAuthExpiredResponse,
  isStrongGatewayApiKey
};
