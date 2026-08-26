type Dynamic = any;

import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { bridgeWebSockets } from "./gateway-websocket-relay.ts";
import { createWebSocketObserver } from "./gateway-websocket-observer.ts";
import { rewriteGatewayCompactionRequest } from "./gateway/compaction-adapter.ts";
import { rewriteSubscriptionReasoningRequest } from "./gateway/reasoning-adapter.ts";
import { isAutoReviewRequest, resolveAutoReviewFallback } from "./gateway/auto-review.ts";
import { buildSubscriptionRoutingHint, replaceSubscriptionRoutingHint, stripSubscriptionHeaders } from "./gateway/protocol.ts";
import { DEFAULT_API_DEBUG_BODY_LIMIT_BYTES, sanitizeHeaders } from "./api-debug-log.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_ERROR_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
const DEFAULT_BUFFER_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const DEFAULT_PENDING_QUEUE_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 1000;
const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_PENDING_MAX_MESSAGES = 1024;
const CONNECTION_LIMIT_LOG_INTERVAL_MS = 10 * 1000;

const WEBSOCKET_ROUTES = new Set([
  "/v1/responses",
  "/v1/realtime"
]);

const BLOCKED_CLIENT_RESPONSE_HEADERS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "content-length",
  "transfer-encoding",
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

const SEMANTIC_CLIENT_RESPONSE_HEADERS = new Set([
  "x-codex-turn-state",
  "x-models-etag",
  "x-reasoning-included",
  "openai-model"
]);

/**
 * Creates the WebSocket half of the local gateway. Responses API routes wait
 * for the first response.create because its model is not known during the HTTP
 * handshake; Realtime routes continue to use the subscription account pool.
 */
function createGatewayWebSocketGateway(options: Dynamic) {
  const { store, hooks = {}, runtime, helpers } = options;
  let lastConnectionLimitLogAt = 0;
  const maxPayloadBytes = positiveSetting(store.getSettings().gateway_websocket_max_payload_bytes, DEFAULT_MAX_PAYLOAD_BYTES);
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true,
    maxPayload: maxPayloadBytes,
    handleProtocols(_protocols: Dynamic, request: Dynamic) {
      return request.gatewaySelectedProtocol || false;
    }
  });

  server.on("headers", (headers: Dynamic, request: Dynamic) => {
    for (const header of request.gatewayResponseHeaders || []) headers.push(header);
  });

  async function handleUpgrade(request: Dynamic, socket: Dynamic, head: Dynamic) {
    const started = Date.now();
    const connectionId = randomUUID();
    const settings = store.getSettings();
    const parsedUrl = new URL(request.url, "http://localhost");
    const apiDebugLogger = runtime.apiDebugLogger;
    const debugEnabled = Boolean(apiDebugLogger && settings.debug_api_logging === "true");
    const debugResponse = (status: Dynamic, message: Dynamic = "", extra: Dynamic = {}) => {
      writeApiDebugLog(apiDebugLogger, debugEnabled, connectionId, {
        kind: "response",
        transport: "websocket",
        status: Number(status || 0),
        message: String(message || ""),
        durationMs: Date.now() - started,
        ...extra
      });
    };
    if (debugEnabled && apiDebugLogger) {
      apiDebugLogger.write({
        ts: new Date().toISOString(),
        id: connectionId,
        kind: "request",
        transport: "websocket",
        method: "GET",
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: sanitizeHeaders(request.headers),
        body: "",
        bodyBytes: 0,
        truncated: false
      });
    }
    if (!WEBSOCKET_ROUTES.has(parsedUrl.pathname)) {
      debugResponse(404, "Unrecognized WebSocket request URL.");
      return rejectUpgrade(socket, 404, "Unrecognized WebSocket request URL.");
    }
    const localKey = settings.gateway_api_key || "";
    if (localKey && request.headers.authorization !== `Bearer ${localKey}`) {
      debugResponse(401, "Incorrect API key provided.");
      return rejectUpgrade(socket, 401, "Incorrect API key provided.");
    }
    const maxConnections = positiveSetting(settings.gateway_websocket_max_connections, DEFAULT_MAX_CONNECTIONS);
    if (runtime.activeWebSockets.size >= maxConnections) {
      const now = Date.now();
      if (now - lastConnectionLimitLogAt >= CONNECTION_LIMIT_LOG_INTERVAL_MS) {
        lastConnectionLimitLogAt = now;
        store.addAppLog?.({
          level: "warn",
          scope: "gateway-websocket",
          action: "reject",
          status: "connection-limit",
          message: `WebSocket 连接数已达到上限：${runtime.activeWebSockets.size}/${maxConnections}`
        });
      }
      debugResponse(503, "The gateway has reached its WebSocket connection limit.");
      return rejectUpgrade(socket, 503, "The gateway has reached its WebSocket connection limit.");
    }

    const routeContext = runtime.routing.context(request.headers);
    if (routeContext.unknownTurnState) {
      debugResponse(409, "The gateway cannot safely route this existing turn state.");
      return rejectUpgrade(socket, 409, "The gateway cannot safely route this existing turn state.");
    }
    if (parsedUrl.pathname === "/v1/responses") {
      const clientModel = settings.gateway_websocket_reject_http_only_model_upgrade === "true"
        ? String(helpers.readCurrentCodexModel?.() || "").trim()
        : "";
      if (clientModel) {
        const upstream = hooks.upstreamService?.findRuntimeByModel?.(clientModel);
        if (upstream && !upstream.supportsWebSocket) {
          store.addAppLog?.({
            level: "warn",
            scope: "gateway-websocket",
            action: "reject",
            status: "WEBSOCKET_NOT_SUPPORTED",
            message: `[${connectionId}] ${parsedUrl.pathname} 握手阶段已拒绝：Codex 当前模型 ${clientModel} 仅支持 HTTP 传输（426）。`
          });
          debugResponse(426, `The model ${clientModel} configured in Codex supports HTTP transport only.`, {
            code: "WEBSOCKET_NOT_SUPPORTED"
          });
          return rejectUpgrade(
            socket,
            426,
            `The model ${clientModel} configured in Codex supports HTTP transport only.`,
            "WEBSOCKET_NOT_SUPPORTED"
          );
        }
      }
      return handleDeferredResponsesUpgrade({
        server,
        request,
        socket,
        head,
        parsedUrl,
        routeContext,
        settings,
        store,
        hooks,
        runtime,
        helpers,
        connectionId,
        started
      });
    }
    let accounts = store.listAccounts();
    let firstAccount = selectFirstAccount(runtime.routing, routeContext, accounts);
    if (!firstAccount && hooks.ensureUsableAccounts) {
      await hooks.ensureUsableAccounts();
      accounts = store.listAccounts();
      firstAccount = selectFirstAccount(runtime.routing, routeContext, accounts);
    }
    if (!firstAccount) {
      const message = routeContext.established
        ? "The account assigned to this Codex session is unavailable. Start a new session and try again."
        : "The server is currently unavailable. Please try again later.";
      debugResponse(503, message);
      return rejectUpgrade(socket, 503, message);
    }

    const controller = new AbortController();
    runtime.activeWebSockets.add(controller);
    const onClientClosed = () => abortController(controller, "client_cancelled", "WebSocket client disconnected.");
    socket.once("close", onClientClosed);
    socket.once("error", onClientClosed);
    let releaseAccountLoad = runtime.routing.beginRequest(firstAccount.id);
    let upstream: Dynamic = null;
    let observer: Dynamic = null;
    try {
      let result: Dynamic;
      try {
        result = await connectWithFailover({
          request,
          settings,
          store,
          hooks,
          helpers,
          routing: runtime.routing,
          routeContext,
          firstAccount,
          signal: controller.signal
        });
      } catch (error: Dynamic) {
        throw error;
      }
      upstream = result.websocket;
      releaseAccountLoad();
      releaseAccountLoad = runtime.routing.beginRequest(result.account.id);
      helpers.syncAccountUsageFromHeaders(result.account, result.headers, store);
      runtime.routing.observeResponse(routeContext, result.account, result.headers);
      store.saveSettings({ gateway_current_account_id: result.account.id });

      request.gatewaySelectedProtocol = upstream.protocol || "";
      request.gatewayResponseHeaders = responseHeadersForClient(result.headers, settings, store, helpers);
      const downstream = await acceptDownstream(server, request, socket, head, controller.signal);
      debugResponse(101, "", {
        headers: sanitizeHeaders(responseHeadersToObject(request.gatewayResponseHeaders)),
        accountId: result.account?.id || null
      });
      observer = createWebSocketObserver({
        store,
        hooks,
        routing: runtime.routing,
        account: result.account,
        request,
        requestPath: `${parsedUrl.pathname}${parsedUrl.search}`,
        upstreamPath: pathFromUrl(result.upstreamUrl),
        helpers,
        settings,
        onIdleTimeout: () => abortController(controller, "websocket_idle_timeout", "Upstream WebSocket response became idle.")
      });
      downstream.once("close", observer.onClose);
      const downstreamClose = waitForWebSocketClose(downstream);
      bridgeWebSockets({
        downstream,
        upstream,
        controller,
        bufferHighWaterBytes: positiveSetting(settings.gateway_websocket_buffer_high_water_bytes, DEFAULT_BUFFER_HIGH_WATER_BYTES),
        onDownstreamMessage(data: Dynamic, isBinary: Dynamic) {
          observer.onDownstreamMessage(data, isBinary);
          debugWebSocketMessage(apiDebugLogger, debugEnabled, connectionId, "request", data, isBinary, apiDebugLogger?.bodyLimitBytes);
          return rewriteDownstreamSubscriptionRequest(data, isBinary);
        },
        onUpstreamMessage(data: Dynamic, isBinary: Dynamic) {
          observer.onUpstreamMessage(data, isBinary);
          debugWebSocketMessage(apiDebugLogger, debugEnabled, connectionId, "response", data, isBinary, apiDebugLogger?.bodyLimitBytes);
          return rewriteUpstreamMessage(data, isBinary, settings, store, helpers);
        }
      });
      controller.signal.addEventListener("abort", () => {
        const reason = controller.signal.reason;
        if (["client_cancelled", "gateway_shutdown"].includes(reason?.code)) return;
        store.addAppLog?.({
          level: "warn",
          scope: "gateway-websocket",
          action: "relay",
          status: reason?.code || "aborted",
          message: `${parsedUrl.pathname} WebSocket 已中止：${reason?.message || "unknown error"}`
        });
      }, { once: true });
      logOpen(store, parsedUrl, result.account, connectionId, started);
      upstream = null;
      const closeDetail = await downstreamClose;
      logClose(store, parsedUrl, result.account, connectionId, closeDetail, started);
    } catch (error: Dynamic) {
      upstream?.terminate();
      if (!socket.destroyed) {
        const status = Number(error.statusCode || 502);
        debugResponse(status, publicUpgradeError(error));
        rejectUpgrade(socket, status, publicUpgradeError(error));
      }
      logFailure(store, parsedUrl, firstAccount, connectionId, error, started);
    } finally {
      observer?.dispose();
      releaseAccountLoad();
      socket.off("close", onClientClosed);
      socket.off("error", onClientClosed);
      runtime.activeWebSockets.delete(controller);
    }
  }

  return {
    handleUpgrade,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function handleDeferredResponsesUpgrade(options: Dynamic) {
  const {
    server,
    request,
    socket,
    head,
    parsedUrl,
    routeContext,
    settings,
    store,
    hooks,
    runtime,
    helpers,
    connectionId,
    started
  } = options;
  const apiDebugLogger = runtime.apiDebugLogger;
  const debugEnabled = Boolean(apiDebugLogger && settings.debug_api_logging === "true");
  const debugResponse = (status: Dynamic, message: Dynamic = "", extra: Dynamic = {}) => {
    writeApiDebugLog(apiDebugLogger, debugEnabled, connectionId, {
      kind: "response",
      transport: "websocket",
      status: Number(status || 0),
      message: String(message || ""),
      durationMs: Date.now() - started,
      ...extra
    });
  };
  const controller = new AbortController();
  runtime.activeWebSockets.add(controller);
  const onClientClosed = () => abortController(controller, "client_cancelled", "WebSocket client disconnected.");
  socket.once("close", onClientClosed);
  socket.once("error", onClientClosed);
  let downstream: Dynamic = null;
  let upstream: Dynamic = null;
  let observer: Dynamic = null;
  let pending: Dynamic = null;
  let selected: Dynamic = null;
  let releaseAccountLoad = () => {};
  try {
    downstream = await acceptDownstream(server, request, socket, head, controller.signal);
    pending = createPendingDownstreamMessages(
      downstream,
      controller,
      positiveSetting(settings.gateway_websocket_idle_timeout_ms, DEFAULT_CONNECT_TIMEOUT_MS),
      positiveSetting(settings.gateway_websocket_pending_queue_limit_bytes, DEFAULT_PENDING_QUEUE_LIMIT_BYTES),
      DEFAULT_PENDING_MAX_MESSAGES
    );
    const firstMessage = await pending.firstResponseCreate;
    selected = await selectDeferredResponsesRoute({
      ...options,
      firstMessage,
      signal: controller.signal
    });
    upstream = selected.websocket;
    if (selected.account) {
      releaseAccountLoad = runtime.routing.beginRequest(selected.account.id);
      helpers.syncAccountUsageFromHeaders(selected.account, selected.headers, store);
      runtime.routing.observeResponse(routeContext, selected.account, selected.headers);
      store.saveSettings({ gateway_current_account_id: selected.account.id });
    }
    debugResponse(101, "", {
      headers: sanitizeHeaders(responseHeadersToObject(request.gatewayResponseHeaders)),
      accountId: selected.account?.id || null,
      targetId: selected.target?.id || null,
      clientModel: selected.clientModel || null,
      upstreamModel: selected.upstreamModel || null
    });
    observer = createWebSocketObserver({
      store,
      hooks,
      routing: runtime.routing,
      account: selected.account,
      target: {
        id: selected.target.id,
        name: selected.target.name,
        kind: selected.target.kind,
        credentialRef: selected.target.credentialRef,
        clientModel: selected.clientModel,
        upstreamModel: selected.upstreamModel,
        attemptCount: selected.attemptCount,
        attemptChain: selected.attemptChain,
        modelPricing: selected.target.modelPricing
      },
      request,
      requestPath: `${parsedUrl.pathname}${parsedUrl.search}`,
      upstreamPath: pathFromUrl(selected.upstreamUrl),
      helpers,
      settings,
      onIdleTimeout: () => abortController(controller, "websocket_idle_timeout", "Upstream WebSocket response became idle.")
    });
    downstream.once("close", observer.onClose);
    const downstreamClose = waitForWebSocketClose(downstream);
    let externalQuotaSent = false;
    const transformDownstream = createDeferredMessageTransformer({
      downstream,
      observer,
      hooks,
      target: selected.target,
      clientModel: selected.clientModel,
      routingHint: selected.routingHint,
      modelRewrite: selected.autoReviewFallbackModel
    });
    bridgeWebSockets({
      downstream,
      upstream,
      controller,
      bufferHighWaterBytes: positiveSetting(settings.gateway_websocket_buffer_high_water_bytes, DEFAULT_BUFFER_HIGH_WATER_BYTES),
      takeInitialDownstreamMessages: pending.take,
      onDownstreamMessage(data: Dynamic, isBinary: Dynamic) {
        debugWebSocketMessage(apiDebugLogger, debugEnabled, connectionId, "request", data, isBinary, apiDebugLogger?.bodyLimitBytes);
        return transformDownstream(data, isBinary);
      },
      onUpstreamMessage(data: Dynamic, isBinary: Dynamic) {
        const observation = observer.onUpstreamMessage(data, isBinary);
        debugWebSocketMessage(apiDebugLogger, debugEnabled, connectionId, "response", data, isBinary, apiDebugLogger?.bodyLimitBytes);
        if (observation.reconnectForQuota && selected.account) {
          const alternative = runtime.routing.selectNewAccount(store.listAccounts(), [selected.account.id]);
          if (alternative) {
            runtime.routing.releaseQuotaBinding(routeContext, selected.account.id);
            store.addAppLog?.({
              scope: "gateway-websocket",
              action: "quota-reconnect",
              status: "retry",
              message: `[${connectionId}] 当前账号额度已用尽，正在切换账号并重试本次请求。`
            });
            closeWebSocketForReconnect(downstream, "subscription account quota exhausted");
            return false;
          }
        }
        if (selected.account) return rewriteUpstreamMessage(data, isBinary, settings, store, helpers);
        if (!externalQuotaSent) {
          externalQuotaSent = true;
          queueMicrotask(() => {
            if (downstream.readyState !== WebSocket.OPEN) return;
            downstream.send(JSON.stringify({ type: "codex.rate_limits", rate_limits: helpers.buildExternalQuotaSnapshot() }));
          });
        }
        return data;
      }
    });
    controller.signal.addEventListener("abort", () => {
      const reason = controller.signal.reason;
      if (["client_cancelled", "gateway_shutdown"].includes(reason?.code)) return;
      store.addAppLog?.({
        level: "warn",
        scope: "gateway-websocket",
        action: "relay",
        status: reason?.code || "aborted",
        message: `${parsedUrl.pathname} WebSocket 已中止：${reason?.message || "unknown error"}`
      });
    }, { once: true });
    pending = null;
    upstream = null;
    logTargetOpen(store, parsedUrl, selected, connectionId, started);
    const closeDetail = await downstreamClose;
    logTargetClose(store, parsedUrl, selected, connectionId, closeDetail, started);
  } catch (error: Dynamic) {
    pending?.dispose();
    upstream?.terminate();
    if (downstream && downstream.readyState === WebSocket.OPEN) {
      if (Number(error.statusCode) === 426) {
        debugResponse(426, publicPostUpgradeError(error));
        sendWebSocketHttpFallbackAndClose(downstream, error.code, publicPostUpgradeError(error));
      } else if (error.reconnectRequired) {
        debugResponse(1012, "retry model transport");
        closeWebSocketForReconnect(downstream, "retry model transport");
      } else {
        debugResponse(Number(error.statusCode || 502), publicPostUpgradeError(error));
        sendWebSocketErrorAndClose(downstream, error.code || "WEBSOCKET_ROUTE_FAILED", publicPostUpgradeError(error));
      }
    } else if (!socket.destroyed) {
      debugResponse(Number(error.statusCode || 502), publicUpgradeError(error));
      rejectUpgrade(socket, Number(error.statusCode || 502), publicUpgradeError(error));
    }
    logTargetFailure(store, parsedUrl, selected, connectionId, error, started);
  } finally {
    observer?.dispose();
    releaseAccountLoad();
    socket.off("close", onClientClosed);
    socket.off("error", onClientClosed);
    runtime.activeWebSockets.delete(controller);
  }
}

async function selectDeferredResponsesRoute(options: Dynamic) {
  const { firstMessage, hooks, runtime, store, settings, helpers, request, signal, routeContext } = options;
  const modelId = String(firstMessage.event.model || "").trim();
  const routingHint = buildSubscriptionRoutingHint(firstMessage.event);

  const upstream = modelId ? hooks.upstreamService?.findRuntimeByModel?.(modelId) : null;
  if (upstream) {
    if (!upstream.supportsWebSocket) {
      throw routeError(426, "WEBSOCKET_NOT_SUPPORTED", "The selected model upstream supports HTTP transport only.");
    }
    const started = Date.now();
    try {
      const connected = await openApiUpstream(request, upstream, settings, helpers, signal);
      hooks.upstreamService.recordRequestOutcome?.(upstream.id, { status: 101, latencyMs: Date.now() - started });
      return {
        ...connected,
        account: null,
        target: {
          ...upstream,
          modelPricing: hooks.upstreamService.getModelPricing(upstream.id, modelId)
        },
        clientModel: modelId,
        upstreamModel: modelId,
        attemptCount: 1,
        attemptChain: []
      };
    } catch (error: Dynamic) {
      hooks.upstreamService.recordRequestOutcome?.(upstream.id, {
        status: Number(error.statusCode || 0),
        latencyMs: Date.now() - started,
        message: error.message
      });
      throw error;
    }
  }

  const isAutoReview = isAutoReviewRequest(firstMessage.event);
  let accounts = store.listAccounts();
  let firstAccount = selectFirstAccount(runtime.routing, routeContext, accounts);
  if (!firstAccount && hooks.ensureUsableAccounts) {
    await hooks.ensureUsableAccounts();
    accounts = store.listAccounts();
    firstAccount = selectFirstAccount(runtime.routing, routeContext, accounts);
  }
  if (!firstAccount) {
    if (isAutoReview) return connectAutoReviewWebSocketFallback({ ...options, clientModel: modelId });
    throw routeError(503, "SUBSCRIPTION_ACCOUNT_UNAVAILABLE", "No usable subscription account is available for this WebSocket session.");
  }
  try {
    const connected = await connectWithFailover({
      request,
      settings,
      store,
      hooks,
      helpers,
      routing: runtime.routing,
      routeContext,
      firstAccount,
      routingHint,
      signal
    });
    return {
      ...connected,
      target: {
        id: "builtin-chatgpt-subscription-pool",
        name: "ChatGPT 订阅账号池",
        kind: "chatgpt_subscription_pool",
        credentialRef: connected.account.id,
        modelPricing: hooks.upstreamService?.getModelPricing?.("builtin-chatgpt-subscription-pool", modelId)
      },
      clientModel: modelId,
      upstreamModel: modelId,
      routingHint,
      attemptCount: 1,
      attemptChain: []
    };
  } catch (error: Dynamic) {
    if (isAutoReview && isWebSocketQuotaFailure(error, helpers)) {
      return connectAutoReviewWebSocketFallback({ ...options, clientModel: modelId });
    }
    throw error;
  }
}

async function connectAutoReviewWebSocketFallback(options: Dynamic) {
  const { settings, hooks, helpers, request, signal, store, clientModel } = options;
  const fallback = resolveAutoReviewFallback(settings, hooks);
  if (!fallback) {
    throw routeError(503, "SUBSCRIPTION_ACCOUNT_UNAVAILABLE", "No usable subscription account is available for this WebSocket session.");
  }
  if (!fallback.upstream.supportsWebSocket) {
    throw routeError(426, "WEBSOCKET_NOT_SUPPORTED", `The selected auto review fallback model ${fallback.model} supports HTTP transport only.`);
  }
  store?.addAppLog?.({
    level: "info",
    scope: "gateway-websocket",
    action: "auto-review-fallback",
    status: "api-upstream",
    message: `账号池不可用，Auto Review WebSocket 请求转由第三方渠道模型 ${fallback.model} 处理。`
  });
  const started = Date.now();
  try {
    const connected = await openApiUpstream(request, fallback.upstream, settings, helpers, signal);
    hooks.upstreamService.recordRequestOutcome?.(fallback.upstream.id, { status: 101, latencyMs: Date.now() - started });
    return {
      ...connected,
      account: null,
      target: {
        ...fallback.upstream,
        modelPricing: hooks.upstreamService.getModelPricing(fallback.upstream.id, fallback.model)
      },
      clientModel: clientModel || String(options.firstMessage?.event?.model || ""),
      upstreamModel: fallback.model,
      autoReviewFallbackModel: fallback.model,
      attemptCount: 1,
      attemptChain: []
    };
  } catch (error: Dynamic) {
    hooks.upstreamService.recordRequestOutcome?.(fallback.upstream.id, {
      status: Number(error.statusCode || 0),
      latencyMs: Date.now() - started,
      message: error.message
    });
    throw error;
  }
}
function createPendingDownstreamMessages(
  downstream: Dynamic,
  controller: Dynamic,
  timeoutMs: Dynamic,
  maxBytes: Dynamic,
  maxMessages: Dynamic
) {
  const signal = controller.signal;
  const messages: Dynamic[] = [];
  let queuedBytes = 0;
  let settled = false;
  let resolveFirst: Dynamic;
  let rejectFirst: Dynamic;
  const firstResponseCreate = new Promise<Dynamic>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  const fail = (error: Dynamic) => {
    if (settled) return;
    settled = true;
    rejectFirst(error);
  };
  const onMessage = (data: Dynamic, isBinary: Dynamic) => {
    const messageBytes = rawDataByteLength(data);
    if (messages.length >= maxMessages || queuedBytes + messageBytes > maxBytes) {
      abortController(
        controller,
        "WEBSOCKET_PENDING_QUEUE_LIMIT",
        `WebSocket messages queued during the upstream handshake exceed the ${maxBytes}-byte or ${maxMessages}-message limit.`
      );
      return;
    }
    messages.push({ data, isBinary });
    queuedBytes += messageBytes;
    if (settled) return;
    if (isBinary) return fail(routeError(400, "INVALID_FIRST_WEBSOCKET_EVENT", "The first WebSocket message must be a JSON response.create event."));
    const event = parseJson(data);
    if (event?.type !== "response.create") {
      return fail(routeError(400, "INVALID_FIRST_WEBSOCKET_EVENT", "The first WebSocket message must be a response.create event."));
    }
    settled = true;
    resolveFirst({ data, isBinary, event });
  };
  const onClose = () => fail(abortError("client_cancelled", "WebSocket client disconnected before response.create."));
  const onError = (error: Dynamic) => fail(error);
  const onAbort = () => fail(signal.reason || abortError("request_aborted", "WebSocket request aborted."));
  const timeout = setTimeout(() => fail(routeError(408, "RESPONSE_CREATE_TIMEOUT", "Timed out waiting for the first response.create event.")), timeoutMs);
  timeout.unref?.();
  downstream.on("message", onMessage);
  downstream.once("close", onClose);
  downstream.once("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  const dispose = () => {
    clearTimeout(timeout);
    downstream.off("message", onMessage);
    downstream.off("close", onClose);
    downstream.off("error", onError);
    signal?.removeEventListener("abort", onAbort);
  };
  return {
    firstResponseCreate,
    take() {
      dispose();
      return messages.splice(0);
    },
    dispose
  };
}

function rawDataByteLength(data: Dynamic): number {
  if (Array.isArray(data)) return data.reduce((total, item) => total + rawDataByteLength(item), 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Buffer.isBuffer(data) || ArrayBuffer.isView(data) ? data.byteLength : Buffer.byteLength(String(data));
}

function createDeferredMessageTransformer(options: Dynamic) {
  const { downstream, observer, hooks, target, clientModel, modelRewrite } = options;
  return (data: Dynamic, isBinary: Dynamic) => {
    observer.onDownstreamMessage(data, isBinary);
    if (isBinary) return undefined;
    const event = parseJson(data);
    if (event?.type !== "response.create") return undefined;
    const modelId = String(event.model || "").trim();
    if (modelId) {
      if (modelRewrite && modelId === clientModel && target.kind === "responses_api") {
        return Buffer.from(JSON.stringify({ ...event, model: modelRewrite }), "utf8");
      }
      const owner = hooks.upstreamService?.findRuntimeByModel?.(modelId) || null;
      const expectedTargetId = owner?.id || "builtin-chatgpt-subscription-pool";
      const routingHintChanged = target.kind === "chatgpt_subscription_pool"
        && buildSubscriptionRoutingHint(event) !== options.routingHint;
      if (modelId !== clientModel || expectedTargetId !== target.id || routingHintChanged) {
        closeWebSocketForReconnect(downstream, "model, tier, or channel changed");
        return false;
      }
    }
    if (target.kind === "chatgpt_subscription_pool") return rewriteDownstreamSubscriptionRequest(data, false);
    return rewriteDownstreamCompactionRequest(data, false);
  };
}

function rewriteDownstreamSubscriptionRequest(data: Dynamic, isBinary: boolean) {
  if (isBinary) return undefined;
  const event = parseJson(data);
  if (event?.type !== "response.create") return undefined;
  const reasoning = rewriteSubscriptionReasoningRequest(event);
  const compaction = rewriteGatewayCompactionRequest(reasoning.body);
  if (compaction.adapted) return toWebSocketBuffer(compaction.body);
  if (reasoning.adapted) return toWebSocketBuffer(reasoning.body);
  return undefined;
}

function rewriteDownstreamCompactionRequest(data: Dynamic, isBinary: boolean) {
  if (isBinary) return undefined;
  const event = parseJson(data);
  if (event?.type !== "response.create") return undefined;
  const rewritten = rewriteGatewayCompactionRequest(event);
  return rewritten.adapted ? Buffer.from(JSON.stringify(rewritten.body), "utf8") : undefined;
}

function toWebSocketBuffer(value: Dynamic) {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function selectFirstAccount(routing: Dynamic, routeContext: Dynamic, accounts: Dynamic) {
  if (routeContext.established) return routing.findBoundAccount(routeContext, accounts);
  return routing.findPreferredAccount(routeContext, accounts) || routing.selectNewAccount(accounts);
}

async function connectWithFailover(options: Dynamic) {
  const { request, settings, store, hooks, helpers, routing, routeContext, signal } = options;
  const excluded = new Set<Dynamic>();
  const allowFailover = !routeContext.established;
  let account = options.firstAccount;
  let lastError: Dynamic = null;
  let quotaRefreshNeeded = false;
  while (account) {
    routing.reserveSession(routeContext, account);
    let result: Dynamic;
    try {
      result = await openUpstream(request, account, settings, hooks, helpers, signal, options.routingHint);
      if (quotaRefreshNeeded) scheduleUsageRefresh(options.firstAccount, hooks, routing, store);
      return { account, ...result };
    } catch (error: Dynamic) {
      let failure: Dynamic = error;
      if (helpers.isAuthExpiredResponse(failure.statusCode, failure.body || Buffer.alloc(0)) && hooks.refreshAccountToken) {
        let refreshedAccount: Dynamic;
        try {
          refreshedAccount = await hooks.refreshAccountToken(account.id) || account;
        } catch (refreshError: Dynamic) {
          store.addAppLog?.({
            level: "warn",
            scope: "gateway-websocket",
            action: "refresh-token",
            status: "failed",
            message: `WebSocket 刷新账号 token 失败：${account.email || account.name || account.id}: ${refreshError.message}`
          });
          if (!allowFailover) {
            routing.releaseSessionReservation(routeContext, account.id);
            throw failure;
          }
        }
        if (refreshedAccount) {
          account = refreshedAccount;
          try {
            result = await openUpstream(request, account, settings, hooks, helpers, signal, options.routingHint);
            if (quotaRefreshNeeded) scheduleUsageRefresh(options.firstAccount, hooks, routing, store);
            return { account, ...result };
          } catch (retryError: Dynamic) {
            failure = retryError;
          }
        }
      }
      lastError = failure;
      if (helpers.isAuthExpiredResponse(failure.statusCode, failure.body || Buffer.alloc(0))) {
        routing.setCooldown(
          account.id,
          positiveSetting(settings.gateway_quota_cooldown_ms, DEFAULT_QUOTA_COOLDOWN_MS)
        );
        if (!allowFailover) break;
        excluded.add(account.id);
        account = routing.selectNewAccount(store.listAccounts(), Array.from(excluded));
        continue;
      }
      const headers = failure.headers || {};
      const syncedUsage = helpers.syncAccountUsageFromHeaders(account, headers, store);
      if (!isWebSocketQuotaFailure(failure, helpers)) {
        routing.releaseSessionReservation(routeContext, account.id);
        throw failure;
      }
      if (!syncedUsage) {
        routing.setCooldown(account.id, positiveSetting(settings.gateway_quota_cooldown_ms, DEFAULT_QUOTA_COOLDOWN_MS));
        quotaRefreshNeeded = true;
      }
      if (!allowFailover) break;
      excluded.add(account.id);
      account = routing.selectNewAccount(store.listAccounts(), Array.from(excluded));
    }
  }
  if (lastError && quotaRefreshNeeded && !options.quotaRefreshAttempted && hooks.refreshAllUsage) {
    const retryAccount = await refreshQuotaAndSelectRetryAccount(options);
    if (retryAccount) {
      return connectWithFailover({
        ...options,
        firstAccount: retryAccount,
        quotaRefreshAttempted: true
      });
    }
  }
  routing.releaseSessionReservation(routeContext);
  throw lastError || statusError(503, "No enabled GPT account with an access token is available.");
}

function openUpstream(request: Dynamic, account: Dynamic, settings: Dynamic, hooks: Dynamic, helpers: Dynamic, signal: Dynamic, routingHint = "") {
  const upstreamUrl = helpers.buildUpstreamUrl(subscriptionBaseUrl(settings, hooks), request.url);
  const headers = buildUpstreamWebSocketHeaders(request.headers, account, request.url, helpers);
  replaceSubscriptionRoutingHint(headers, routingHint);
  return openUpstreamSocket(request, upstreamUrl, headers, settings, signal);
}

function subscriptionBaseUrl(settings: Dynamic, hooks: Dynamic) {
  try {
    const target = hooks.upstreamService?.getRuntime?.("builtin-chatgpt-subscription-pool");
    if (target?.kind === "chatgpt_subscription_pool" && target.baseUrl) return target.baseUrl;
  } catch {
    // Legacy/test compositions without the built-in target use the compatible settings fallback.
  }
  return settings.upstream_base_url;
}

function openApiUpstream(request: Dynamic, upstream: Dynamic, settings: Dynamic, helpers: Dynamic, signal: Dynamic) {
  const upstreamUrl = helpers.buildUpstreamUrl(upstream.baseUrl, request.url);
  const headers = buildUpstreamWebSocketHeaders(
    request.headers,
    { access_token: upstream.apiKey, account_id: "", workspace_id: "" },
    request.url,
    helpers
  );
  for (const [name, value] of Object.entries(upstream.requestHeaders || {})) helpers.setHeader(headers, name, value);
  stripSubscriptionHeaders(headers);
  if (!upstream.apiKey) deleteHeader(headers, "authorization");
  return openUpstreamSocket(request, upstreamUrl, headers, settings, signal, false);
}

function openUpstreamSocket(request: Dynamic, upstreamUrl: Dynamic, headers: Dynamic, settings: Dynamic, signal: Dynamic, forwardClientProtocols = true) {
  const protocols = forwardClientProtocols ? parseProtocols(request.headers["sec-websocket-protocol"]) : [];
  const timeoutMs = positiveSetting(settings.gateway_connect_timeout_ms, DEFAULT_CONNECT_TIMEOUT_MS);
  const errorLimit = positiveSetting(settings.gateway_error_body_limit_bytes, DEFAULT_ERROR_BODY_LIMIT_BYTES);
  return new Promise<Dynamic>((resolve, reject) => {
    let websocket: Dynamic;
    let responseHeaders: Dynamic = {};
    let settled = false;
    const finish = (callback: Dynamic) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      websocket?.terminate();
      reject(signal.reason || abortError("request_aborted", "WebSocket request aborted."));
    });
    try {
      websocket = new WebSocket(upstreamUrl, protocols, {
        headers,
        handshakeTimeout: timeoutMs,
        maxPayload: positiveSetting(settings.gateway_websocket_max_payload_bytes, DEFAULT_MAX_PAYLOAD_BYTES),
        perMessageDeflate: true
      });
    } catch (error: Dynamic) {
      return finish(() => reject(error));
    }
    websocket.once("upgrade", (response: Dynamic) => {
      responseHeaders = response.headers || {};
    });
    websocket.once("open", () => finish(() => resolve({ websocket, headers: responseHeaders, upstreamUrl })));
    websocket.once("unexpected-response", (_request: Dynamic, response: Dynamic) => {
      collectUnexpectedResponse(response, errorLimit).then(({ body, headers: failureHeaders }: Dynamic) => {
        const error: Dynamic = statusError(response.statusCode || 502, `Upstream WebSocket handshake returned HTTP ${response.statusCode || 502}.`);
        error.code = "UPSTREAM_WEBSOCKET_HANDSHAKE_FAILED";
        error.headers = failureHeaders;
        error.body = body;
        finish(() => {
          websocket.terminate();
          reject(error);
        });
      }, (error: Dynamic) => finish(() => reject(error)));
    });
    websocket.once("error", (error: Dynamic) => finish(() => reject(error)));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function deleteHeader(headers: Dynamic, name: Dynamic) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  if (key) delete headers[key];
}

function collectUnexpectedResponse(response: Dynamic, limitBytes: Dynamic) {
  return new Promise<Dynamic>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => resolve({ body: Buffer.concat(chunks, size), headers: response.headers || {} });
    response.on("data", (chunk: Dynamic) => {
      const remaining = limitBytes - size;
      if (remaining <= 0) return;
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      size += kept.length;
    });
    response.once("end", done);
    response.once("close", done);
    response.once("error", done);
    response.resume();
  });
}

function acceptDownstream(server: Dynamic, request: Dynamic, socket: Dynamic, head: Dynamic, signal: Dynamic) {
  return new Promise<Dynamic>((resolve, reject) => {
    const onAbort = () => reject(signal.reason || abortError("request_aborted", "WebSocket request aborted."));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      server.handleUpgrade(request, socket, head, (websocket: Dynamic) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(websocket);
      });
    } catch (error: Dynamic) {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

function waitForWebSocketClose(websocket: Dynamic) {
  if (websocket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: "" });
  return new Promise<Dynamic>((resolve) => websocket.once("close", (code: Dynamic, reason: Dynamic) => resolve({
    code,
    reason: sanitizeCloseReason(reason)
  })));
}

function buildUpstreamWebSocketHeaders(headers: Dynamic, account: Dynamic, path: Dynamic, helpers: Dynamic) {
  const outgoing = helpers.buildUpstreamHeaders(headers, account, false, path);
  for (const key of Object.keys(outgoing)) {
    const lower = key.toLowerCase();
    if (lower === "upgrade" || lower === "connection" || lower.startsWith("sec-websocket-")) {
      delete outgoing[key];
    }
  }
  return outgoing;
}

function responseHeadersForClient(headers: Dynamic, settings: Dynamic, store: Dynamic, helpers: Dynamic) {
  const result = [];
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (BLOCKED_CLIENT_RESPONSE_HEADERS.has(lower) || !SEMANTIC_CLIENT_RESPONSE_HEADERS.has(lower)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) result.push(`${key}: ${item}`);
    }
  }
  if (settings.codex_quota_headers_mode === "rewrite") {
    for (const [key, value] of Object.entries(helpers.buildCodexQuotaHeaders(store.listAccounts(), undefined, { ignoreFiveHourLimit: settings.ignore_five_hour_limit === "true" }))) {
      result.push(`${key}: ${value}`);
    }
  }
  return result;
}

function rewriteUpstreamMessage(data: Dynamic, isBinary: Dynamic, settings: Dynamic, store: Dynamic, helpers: Dynamic) {
  if (isBinary || settings.codex_quota_headers_mode !== "rewrite") return data;
  const event = parseJson(data);
  if (event?.type !== "codex.rate_limits") return data;
  return Buffer.from(JSON.stringify({
    ...event,
    rate_limits: helpers.buildCodexQuotaSnapshot(store.listAccounts(), undefined, { ignoreFiveHourLimit: settings.ignore_five_hour_limit === "true" })
  }));
}

function parseJson(data: Dynamic) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function parseProtocols(value: Dynamic) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isWebSocketQuotaFailure(error: Dynamic, helpers: Dynamic) {
  if (Number(error.statusCode) === 429) return true;
  return helpers.isQuotaExhaustedResponse(error.statusCode, error.body);
}

async function refreshQuotaAndSelectRetryAccount(options: Dynamic) {
  const { firstAccount, store, hooks, routing, routeContext } = options;
  try {
    const results = await hooks.refreshAllUsage("gateway-websocket-quota-without-headers");
    const successfulIds = new Set(Array.isArray(results)
      ? results.filter((item: Dynamic) => item?.ok && item.id).map((item: Dynamic) => item.id)
      : []);
    for (const id of successfulIds) routing.clearCooldown(id);
    const accounts = store.listAccounts();
    if (routeContext.established) {
      if (!successfulIds.has(firstAccount.id)) return null;
      return routing.findBoundAccount(routeContext, accounts);
    }
    return routing.selectNewAccount(accounts);
  } catch (error: Dynamic) {
    store.addAppLog?.({
      level: "warn",
      scope: "gateway-websocket",
      action: "quota-refresh",
      status: "failed",
      message: `WebSocket 配额错误后刷新账号状态失败：${firstAccount.email || firstAccount.name || firstAccount.id}: ${error.message}`
    });
    return null;
  }
}

function scheduleUsageRefresh(account: Dynamic, hooks: Dynamic, routing: Dynamic, store: Dynamic) {
  Promise.resolve()
    .then(() => hooks.refreshAllUsage("gateway-websocket-quota-without-headers"))
    .then((results) => {
      if (!Array.isArray(results)) return;
      for (const item of results) {
        if (item?.ok && item.id) routing.clearCooldown(item.id);
      }
    })
    .catch((error) => store.addAppLog?.({
      level: "warn",
      scope: "gateway-websocket",
      action: "quota-refresh",
      status: "failed",
      message: `WebSocket 配额错误后刷新账号状态失败：${account.email || account.name || account.id}: ${error.message}`
    }));
}

function sendWebSocketErrorAndClose(websocket: Dynamic, code: Dynamic, message: Dynamic) {
  if (websocket.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: String(code || "WEBSOCKET_ROUTE_FAILED"),
      message: String(message || "The WebSocket request could not be routed.").slice(0, 1000)
    }
  });
  websocket.send(payload, (error: Dynamic) => {
    if (websocket.readyState !== WebSocket.OPEN) return;
    if (error) websocket.terminate();
    else websocket.close(1008, "route rejected");
  });
}

function sendWebSocketHttpFallbackAndClose(websocket: Dynamic, code: Dynamic, message: Dynamic) {
  if (websocket.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify({
    type: "error",
    status: 426,
    error: {
      type: "unsupported_transport",
      code: String(code || "WEBSOCKET_NOT_SUPPORTED"),
      message: String(message || "The selected model upstream supports HTTP transport only.").slice(0, 1000)
    }
  });
  websocket.send(payload, (error: Dynamic) => {
    if (websocket.readyState !== WebSocket.OPEN) return;
    if (error) websocket.terminate();
    else websocket.close(1008, "HTTP transport required");
  });
}

function closeWebSocketForReconnect(websocket: Dynamic, reason: string) {
  if (websocket.readyState !== WebSocket.OPEN) return;
  websocket.close(1012, reason.slice(0, 123));
}

function publicPostUpgradeError(error: Dynamic) {
  if (error?.code === "client_cancelled") return "WebSocket client disconnected.";
  if (error?.statusCode || error?.code) return String(error.message || "The WebSocket request could not be routed.");
  return "The gateway could not establish the selected upstream WebSocket connection.";
}

function logTargetOpen(store: Dynamic, parsedUrl: Dynamic, result: Dynamic, connectionId: Dynamic, started: Dynamic) {
  store.addAppLog?.({
    level: "info",
    scope: "gateway-websocket",
    action: "connect",
    status: "success",
    message: `[${connectionId}] ${parsedUrl.pathname} 已连接目标 ${result.target.name || result.target.id}，模型 ${result.clientModel} -> ${result.upstreamModel}，握手耗时 ${Date.now() - started}ms。`
  });
}

function logTargetClose(store: Dynamic, parsedUrl: Dynamic, result: Dynamic, connectionId: Dynamic, detail: Dynamic, started: Dynamic) {
  const reason = detail.reason ? `，原因：${detail.reason}` : "";
  store.addAppLog?.({
    level: "info",
    scope: "gateway-websocket",
    action: "disconnect",
    status: String(detail.code),
    message: `[${connectionId}] ${parsedUrl.pathname} 已断开目标 ${result.target.name || result.target.id}，连接时长 ${Date.now() - started}ms，关闭码 ${detail.code}${reason}。`
  });
}

function logTargetFailure(store: Dynamic, parsedUrl: Dynamic, result: Dynamic, connectionId: Dynamic, error: Dynamic, started: Dynamic) {
  if (error?.code === "client_cancelled") return;
  store.addAppLog?.({
    level: "error",
    scope: "gateway-websocket",
    action: "connect",
    status: error?.code || String(error?.statusCode || "failed"),
    message: `[${connectionId}] ${parsedUrl.pathname} 连接目标 ${result?.target?.name || result?.target?.id || "pending"} 失败（${Date.now() - started}ms）：${error.message}`
  });
}

function rejectUpgrade(socket: Dynamic, status: Dynamic, message: Dynamic, code: Dynamic = "") {
  if (socket.destroyed) return;
  const error: Record<string, string> = { message: String(message) };
  if (code) error.code = String(code);
  const body = JSON.stringify({ error });
  const reason = statusReason(status);
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body
  ].join("\r\n"));
}

function publicUpgradeError(error: Dynamic) {
  if (error.code === "client_cancelled") return "WebSocket client disconnected.";
  if (error.statusCode) return error.message;
  return "The gateway could not establish the upstream WebSocket connection.";
}

function logOpen(store: Dynamic, parsedUrl: Dynamic, account: Dynamic, connectionId: Dynamic, started: Dynamic) {
  store.addAppLog?.({
    level: "info",
    scope: "gateway-websocket",
    action: "connect",
    status: "success",
    message: `[${connectionId}] ${parsedUrl.pathname} 已连接账号 ${account.email || account.name || account.id}，握手耗时 ${Date.now() - started}ms。`
  });
}

function logClose(store: Dynamic, parsedUrl: Dynamic, account: Dynamic, connectionId: Dynamic, detail: Dynamic, started: Dynamic) {
  const reason = detail.reason ? `，原因：${detail.reason}` : "";
  store.addAppLog?.({
    level: "info",
    scope: "gateway-websocket",
    action: "disconnect",
    status: String(detail.code),
    message: `[${connectionId}] ${parsedUrl.pathname} 已断开账号 ${account.email || account.name || account.id}，连接时长 ${Date.now() - started}ms，关闭码 ${detail.code}${reason}。`
  });
}

function sanitizeCloseReason(reason: Dynamic) {
  return Buffer.from(reason || Buffer.alloc(0))
    .toString("utf8")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 256);
}

function writeApiDebugLog(logger: Dynamic, enabled: boolean, id: string, entry: Dynamic) {
  if (!enabled || !logger) return;
  logger.write({ ts: new Date().toISOString(), id, ...entry });
}

function debugWebSocketMessage(
  logger: Dynamic,
  enabled: boolean,
  id: string,
  kind: Dynamic,
  data: Dynamic,
  isBinary: Dynamic,
  limitBytes: Dynamic
) {
  if (!enabled || !logger) return;
  logger.write({
    ts: new Date().toISOString(),
    id,
    kind,
    transport: "websocket",
    ...previewWebSocketMessage(data, isBinary, limitBytes)
  });
}

function previewWebSocketMessage(data: Dynamic, isBinary: Dynamic, limitBytes: Dynamic) {
  const buffer = rawDataToBuffer(data);
  const limit = Number.isFinite(limitBytes) && Number(limitBytes) > 0
    ? Math.trunc(Number(limitBytes))
    : DEFAULT_API_DEBUG_BODY_LIMIT_BYTES;
  const truncated = buffer.length > limit;
  const kept = truncated ? buffer.subarray(0, limit) : buffer;
  return {
    message: kept.toString("utf8"),
    messageBytes: buffer.length,
    truncated,
    binary: Boolean(isBinary)
  };
}

function rawDataToBuffer(data: Dynamic): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data.map((item: Dynamic) => rawDataToBuffer(item)));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array || data instanceof DataView) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(String(data), "utf8");
}

function responseHeadersToObject(entries: Dynamic): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const text = String(entry || "");
    const index = text.indexOf(":");
    if (index <= 0) continue;
    const name = text.slice(0, index).trim();
    const value = text.slice(index + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

function pathFromUrl(value: Dynamic) {
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(value || "");
  }
}

function logFailure(store: Dynamic, parsedUrl: Dynamic, account: Dynamic, connectionId: Dynamic, error: Dynamic, started: Dynamic) {
  if (error.code === "client_cancelled") return;
  store.addAppLog?.({
    level: "error",
    scope: "gateway-websocket",
    action: "connect",
    status: error.code || String(error.statusCode || "failed"),
    message: `[${connectionId}] ${parsedUrl.pathname} 连接账号 ${account.email || account.name || account.id} 失败（${Date.now() - started}ms）：${error.message}`
  });
}

function positiveSetting(value: Dynamic, fallback: Dynamic) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function statusError(statusCode: Dynamic, message: Dynamic): Dynamic {
  const error: Dynamic = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function routeError(statusCode: Dynamic, code: Dynamic, message: Dynamic): Dynamic {
  const error = statusError(statusCode, message);
  error.code = code;
  return error;
}

function abortError(code: Dynamic, message: Dynamic): Dynamic {
  const error: Dynamic = new Error(message);
  error.name = "AbortError";
  error.code = code;
  return error;
}

function abortController(controller: Dynamic, code: Dynamic, message: Dynamic) {
  if (!controller.signal.aborted) controller.abort(abortError(code, message));
}

function statusReason(status: Dynamic) {
  const reasons: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 426: "Upgrade Required", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable" };
  return reasons[Number(status)] || "Error";
}

export {
  createGatewayWebSocketGateway,
  buildUpstreamWebSocketHeaders,
  responseHeadersForClient,
  rewriteUpstreamMessage,
  WEBSOCKET_ROUTES
};

export default {
  createGatewayWebSocketGateway,
  buildUpstreamWebSocketHeaders,
  responseHeadersForClient,
  rewriteUpstreamMessage,
  WEBSOCKET_ROUTES
};
