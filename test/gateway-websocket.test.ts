import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { test } from "vitest";

import gatewayModule from "../src/main/gateway.ts";
import gatewayWebSocketModule from "../src/main/gateway-websocket.ts";

const { buildCodexQuotaSnapshot, createGateway } = gatewayModule;
const { rewriteUpstreamMessage } = gatewayWebSocketModule;

test("WebSocket quota rewriting leaves incompatible payloads unchanged", () => {
  const text = Buffer.from("not-json");
  const otherEvent = Buffer.from(JSON.stringify({ type: "response.output_text.delta", delta: "ok" }));
  const rateLimitEvent = Buffer.from(JSON.stringify({ type: "codex.rate_limits", rate_limits: {} }));
  const store = { listAccounts: () => [] };
  const helpers = { buildCodexQuotaSnapshot };

  assert.strictEqual(rewriteUpstreamMessage(rateLimitEvent, false, { codex_quota_headers_mode: "block" }, store, helpers), rateLimitEvent);
  assert.strictEqual(rewriteUpstreamMessage(rateLimitEvent, true, { codex_quota_headers_mode: "rewrite" }, store, helpers), rateLimitEvent);
  assert.strictEqual(rewriteUpstreamMessage(text, false, { codex_quota_headers_mode: "rewrite" }, store, helpers), text);
  assert.strictEqual(rewriteUpstreamMessage(otherEvent, false, { codex_quota_headers_mode: "rewrite" }, store, helpers), otherEvent);
});

test("WebSocket gateway proxies compressed Responses messages and keeps upstream handshake metadata private", async () => {
  const requests = [];
  let resolveUpstreamPong;
  const upstreamPong = new Promise((resolve) => {
    resolveUpstreamPong = resolve;
  });
  const harness = await startHarness({
    onHeaders(headers) {
      headers.push("x-codex-turn-state: ws-state-a");
      headers.push("x-codex-primary-used-percent: 12");
      headers.push("x-upstream-private: should-not-cross");
    },
    onConnection(websocket, request) {
      requests.push(request);
      websocket.once("pong", resolveUpstreamPong);
      websocket.ping("upstream-health");
      websocket.once("message", (data, isBinary) => {
        assert.equal(isBinary, false);
        websocket.send(`upstream:${data.toString()}`);
        websocket.send(JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3, total_tokens: 15 } }
        }));
      });
    }
  });
  try {
    const { websocket, response } = await connectGateway(harness, "/v1/responses?stream=true", {
      "session-id": "session-1",
      "thread-id": "thread-1",
      "openai-beta": "responses_websockets=2026-02-06"
    });
    assert.match(websocket.extensions, /permessage-deflate/);
    assert.equal(response.headers["x-codex-turn-state"], undefined);
    assert.equal(response.headers["x-codex-primary-used-percent"], undefined);
    assert.equal(response.headers["x-upstream-private"], undefined);
    const pong = new Promise((resolve) => websocket.once("pong", resolve));
    websocket.ping("health");
    await pong;
    const messagesPromise = nextMessages(websocket, 2);
    const requestMessage = JSON.stringify({ type: "response.create", model: "gpt-test" });
    websocket.send(requestMessage);
    await withTimeout(upstreamPong, 1_000, "gateway did not answer the upstream ping");
    const messages = await messagesPromise;
    assert.equal(messages[0].toString(), `upstream:${requestMessage}`);
    assert.match(messages[1].toString(), /response\.completed/);
    websocket.close(1000, "done");
    await nextClose(websocket);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/backend-api/codex/responses?stream=true");
    assert.equal(requests[0].headers.authorization, "Bearer token-a");
    assert.equal(requests[0].headers["chatgpt-account-id"], "account-a");
    assert.equal(requests[0].headers["session-id"], "session-1");
    assert.equal(requests[0].headers["openai-beta"], "responses_websockets=2026-02-06");
    assert.match(harness.settings.gateway_affinity_state_json, /session-1/);
    await waitFor(() => harness.tokenLogs.length > 0, 1_000);
    assert.equal(harness.tokenLogs.at(-1).input_tokens, 12);
    assert.equal(harness.tokenLogs.at(-1).cached_input_tokens, 4);
    assert.equal(harness.tokenLogs.at(-1).total_tokens, 15);
    assert.equal(harness.tokenLogs.at(-1).client_model, "gpt-test");
    assert.equal(harness.tokenLogs.at(-1).upstream_model, "gpt-test");
    await waitFor(() => harness.appLogs.some((entry) => entry.action === "disconnect"), 1_000);
    const connectLog = harness.appLogs.find((entry) => entry.action === "connect" && entry.status === "success");
    const disconnectLog = harness.appLogs.find((entry) => entry.action === "disconnect");
    const connectionId = connectLog.message.match(/^\[([^\]]+)\]/)?.[1];
    assert.ok(connectionId);
    assert.match(disconnectLog.message, new RegExp(`^\\[${connectionId}\\]`));
    assert.equal(disconnectLog.status, "1000");
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway reuses one upstream connection for sequential and binary messages", async () => {
  let connections = 0;
  let completed = 0;
  const harness = await startHarness({
    onConnection(websocket) {
      connections += 1;
      websocket.on("message", (data, isBinary) => {
        if (isBinary) {
          websocket.send(data, { binary: true }, () => websocket.close(4001, "rotate"));
          return;
        }
        completed += 1;
        websocket.send(JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: completed, output_tokens: 1, total_tokens: completed + 1 } }
        }));
      });
    }
  }, { gateway_websocket_buffer_high_water_bytes: "16" });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-reuse" });
    for (let index = 0; index < 2; index += 1) {
      const response = nextMessage(websocket);
      websocket.send(JSON.stringify({ type: "response.create", input: [{ role: "user", content: `turn-${index}` }] }));
      assert.match((await response).toString(), /response\.completed/);
    }
    const binary = Buffer.alloc(256 * 1024, 7);
    const echoed = nextMessage(websocket);
    const closed = nextCloseDetail(websocket);
    websocket.send(binary, { binary: true });
    assert.deepEqual(await echoed, binary);
    assert.deepEqual(await closed, { code: 4001, reason: "rotate" });
    await waitFor(() => harness.tokenLogs.length === 2, 1_000);
    assert.equal(connections, 1);
    assert.equal(harness.tokenLogs[0].input_tokens, 1);
    assert.equal(harness.tokenLogs[1].input_tokens, 2);
    const logs = JSON.stringify([harness.appLogs, harness.tokenLogs]);
    assert.doesNotMatch(logs, /token-a|local-key|turn-0|turn-1/);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway enforces its independent connection and message-size limits", async () => {
  const concurrencyHarness = await startHarness({}, { gateway_websocket_max_connections: "1" });
  try {
    const first = await connectGateway(concurrencyHarness, "/v1/responses", { "session-id": "session-limit-1" });
    const second = await connectFailure(concurrencyHarness, "/v1/responses", { "session-id": "session-limit-2" });
    assert.equal(second.statusCode, 503);
    assert.equal(concurrencyHarness.appLogs.some((entry) => entry.status === "connection-limit"), true);
    first.websocket.close();
    await nextClose(first.websocket);
  } finally {
    await concurrencyHarness.close();
  }

  const payloadHarness = await startHarness({}, { gateway_websocket_max_payload_bytes: "64" });
  try {
    const { websocket } = await connectGateway(payloadHarness, "/v1/responses", { "session-id": "session-payload" });
    const closed = nextCloseDetail(websocket);
    websocket.send("x".repeat(128));
    assert.equal((await closed).code, 1009);
  } finally {
    await payloadHarness.close();
  }
});

test("WebSocket gateway caps queued bytes while the upstream handshake is pending", async () => {
  const harness = await startHarness({
    onUpgrade(_request, _socket, _head, accept) {
      setTimeout(accept, 250);
    }
  }, { gateway_websocket_pending_queue_limit_bytes: "128" });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-pending-bytes" });
    const errorMessage = nextMessage(websocket);
    const closed = nextCloseDetail(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "gpt-test" }));
    websocket.send("x".repeat(128));
    const payload = JSON.parse((await errorMessage).toString());
    assert.equal(payload.error.code, "WEBSOCKET_PENDING_QUEUE_LIMIT");
    assert.equal((await closed).code, 1008);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway caps queued message count while the upstream handshake is pending", async () => {
  const harness = await startHarness({
    onUpgrade(_request, _socket, _head, accept) {
      setTimeout(accept, 500);
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-pending-count" });
    const errorMessage = nextMessage(websocket);
    const closed = nextCloseDetail(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "gpt-test" }));
    for (let index = 0; index < 1024; index += 1) websocket.send("{}");
    const payload = JSON.parse((await errorMessage).toString());
    assert.equal(payload.error.code, "WEBSOCKET_PENDING_QUEUE_LIMIT");
    assert.equal((await closed).code, 1008);
  } finally {
    await harness.close();
  }
});

test("idle WebSocket connections do not consume HTTP request concurrency", async () => {
  const harness = await startHarness({
    onHttpRequest(_request, response) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }
  }, {
    gateway_max_concurrent_requests: "1",
    gateway_websocket_max_connections: "4"
  });
  const connections = [];
  try {
    connections.push(await connectGateway(harness, "/v1/responses", { "session-id": "session-idle-1" }));
    connections.push(await connectGateway(harness, "/v1/responses", { "session-id": "session-idle-2" }));

    const response = await fetch(`${harness.gateway.status().url}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer local-key",
        "content-type": "application/json"
      },
      body: "{}"
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "{}");
  } finally {
    for (const { websocket } of connections) websocket.close();
    await harness.close();
  }
});

test("WebSocket gateway refreshes an expired account before forwarding response.create", async () => {
  const attempts = [];
  const harness = await startHarness({
    hooks: {
      async refreshAccountToken(id) {
        assert.equal(id, "a");
        return account("a", "token-refreshed", 10);
      }
    },
    onUpgrade(request, socket, _head, accept) {
      attempts.push(request.headers.authorization);
      if (attempts.length === 1) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      accept();
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-refresh" });
    websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    await waitFor(() => attempts.length === 2, 1_000);
    websocket.close();
    await nextClose(websocket);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-refreshed"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway reports a structured error when token refresh fails after local upgrade", async () => {
  const harness = await startHarness({
    hooks: {
      async refreshAccountToken() {
        throw new Error("credential store unavailable");
      }
    },
    onUpgrade(_request, socket) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
  });
  try {
    const { websocket, response } = await connectGateway(harness, "/v1/responses", { "session-id": "session-refresh-failure" });
    assert.equal(response.statusCode, 101);
    const message = nextMessage(websocket);
    const closed = nextCloseDetail(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    const event = JSON.parse((await message).toString());
    assert.equal(event.type, "error");
    assert.equal((await closed).code, 1008);
    assert.equal(harness.appLogs.some((entry) => entry.action === "refresh-token" && entry.status === "failed"), true);
  } finally {
    await harness.close();
  }
});

test("Responses WebSocket selects an external channel by its exact model ID without model rewriting", async () => {
  let harness;
  const upstreamMessages = [];
  const upstreamRequests = [];
  harness = await startHarness({
    hooks: externalApiHooks(() => harness),
    onConnection(websocket, request) {
      upstreamRequests.push(request);
      websocket.on("message", (data) => {
        upstreamMessages.push(JSON.parse(data.toString()));
        websocket.send(JSON.stringify({
          type: "response.completed",
          response: { model: "deepseek-chat", id: "response-1", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }
        }));
      });
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", {
      "session-id": "native-api-session",
      "openai-beta": "responses_websockets=2026-02-06",
      "x-codex-turn-metadata": JSON.stringify({ turn_id: "external-turn" }),
      "chatgpt-account-id": "must-not-leak"
    });
    assert.equal(upstreamRequests.length, 0);

    const responseMessages = nextMessages(websocket, 2);
    websocket.send(JSON.stringify({
      type: "response.create",
      model: "deepseek-chat",
      reasoning: { effort: "high", summary: "auto" },
      input: [
        {
          id: "cmp_cgw_plain_v1_websocket",
          type: "compaction",
          encrypted_content: "Portable WebSocket summary"
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }
      ]
    }));
    const downstreamEvents = (await responseMessages).map((data) => JSON.parse(data.toString()));
    const completedPayload = downstreamEvents.find((event) => event.type === "response.completed");
    const quotaPayload = downstreamEvents.find((event) => event.type === "codex.rate_limits");
    assert.equal(completedPayload.type, "response.completed");
    assert.equal(completedPayload.response.model, "deepseek-chat");
    assert.equal(completedPayload.response.id, "response-1");
    assert.equal(quotaPayload.rate_limits.primary.used_percent, 0);
    assert.equal(quotaPayload.rate_limits.secondary.used_percent, 0);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].headers.authorization, "Bearer api-secret");
    assert.equal(upstreamRequests[0].headers["chatgpt-account-id"], undefined);
    assert.equal(upstreamRequests[0].headers["openai-beta"], undefined);
    assert.equal(upstreamRequests[0].headers["x-codex-turn-metadata"], undefined);
    assert.equal(upstreamRequests[0].headers["session-id"], undefined);
    assert.equal(upstreamRequests[0].headers["x-provider-tenant"], "tenant-ws");
    assert.equal(upstreamRequests[0].headers.host.startsWith("127.0.0.1:"), true);
    assert.deepEqual(upstreamMessages[0], {
      type: "response.create",
      model: "deepseek-chat",
      reasoning: { effort: "high", summary: "auto" },
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Portable WebSocket summary" }]
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }
      ]
    });
    websocket.close();
    await nextClose(websocket);
    await waitFor(() => harness.tokenLogs.length === 1, 1_000);
    assert.equal(harness.tokenLogs[0].upstream_id, "api-native");
    assert.equal(harness.tokenLogs[0].client_model, "deepseek-chat");
    assert.equal(harness.tokenLogs[0].upstream_model, "deepseek-chat");
    assert.equal(harness.tokenLogs[0].estimated_cost, 0.000007);
    assert.equal(harness.tokenLogs[0].cost_unit, "USD");
  } finally {
    await harness.close();
  }
});

test("Responses WebSocket uses the subscription pool when the model is not owned by an external channel", async () => {
  const upstreamMessages = [];
  const harness = await startHarness({
    hooks: {
      upstreamService: {
        findRuntimeByModel() { return null; },
        getModelPricing(upstreamId, modelId) {
          assert.equal(upstreamId, "builtin-chatgpt-subscription-pool");
          assert.equal(modelId, "gpt-5");
          return { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 };
        }
      }
    },
    onConnection(websocket) {
      websocket.once("message", (data) => {
        upstreamMessages.push(JSON.parse(data.toString()));
        websocket.send(JSON.stringify({ type: "response.completed", response: { model: "gpt-5", usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100, total_tokens: 1100 } } }));
      });
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "builtin-model" });
    const completed = nextMessage(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5", input: "hello" }));
    assert.match((await completed).toString(), /response\.completed/);
    assert.equal(upstreamMessages[0].model, "gpt-5");
    websocket.close();
    await nextClose(websocket);
    await waitFor(() => harness.tokenLogs.length === 1, 1_000);
    assert.equal(harness.tokenLogs[0].estimated_cost, 0.0023);
    assert.equal(harness.tokenLogs[0].cost_unit, "USD");
  } finally {
    await harness.close();
  }
});

test("Responses WebSocket closes for reconnect before forwarding a changed model or channel", async () => {
  let harness;
  const upstreamMessages = [];
  harness = await startHarness({
    hooks: externalApiHooks(() => harness, false),
    onConnection(websocket) {
      websocket.on("message", (data) => {
        upstreamMessages.push(JSON.parse(data.toString()));
        websocket.send(JSON.stringify({ type: "response.completed", response: { model: "gpt-5" } }));
      });
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "switch-to-http-only-model" });
    const firstCompleted = nextMessage(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5", input: "first" }));
    assert.match((await firstCompleted).toString(), /response\.completed/);

    const closed = nextCloseDetail(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "deepseek-chat", input: "second" }));
    assert.equal((await closed).code, 1012);
    assert.equal(upstreamMessages.length, 1);
    assert.equal(upstreamMessages[0].model, "gpt-5");
  } finally {
    await harness.close();
  }
});

test("Responses WebSocket closes for reconnect before changing models within one channel", async () => {
  let harness;
  const upstreamMessages = [];
  harness = await startHarness({
    hooks: externalApiHooks(() => harness),
    onConnection(websocket) {
      websocket.on("message", (data) => {
        upstreamMessages.push(JSON.parse(data.toString()));
        websocket.send(JSON.stringify({ type: "response.completed", response: { model: "deepseek-chat" } }));
      });
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "switch-model-same-channel" });
    const firstCompleted = nextMessage(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "deepseek-chat", input: "first" }));
    assert.match((await firstCompleted).toString(), /response\.completed/);

    const closed = nextCloseDetail(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "deepseek-reasoner", input: "second" }));
    assert.equal((await closed).code, 1012);
    assert.equal(upstreamMessages.length, 1);
    assert.equal(upstreamMessages[0].model, "deepseek-chat");
  } finally {
    await harness.close();
  }
});

test("Responses WebSocket immediately requests HTTP fallback when the first model only supports HTTP", async () => {
  let harness;
  let upstreamUpgrades = 0;
  harness = await startHarness({
    hooks: externalApiHooks(() => harness, false),
    onUpgrade() {
      upstreamUpgrades += 1;
    }
  });
  try {
    const { websocket, response } = await connectGateway(harness, "/v1/responses", { "session-id": "post-upgrade-426" });
    assert.equal(response.statusCode, 101);
    const message = nextMessage(websocket);
    const closed = nextCloseDetail(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "deepseek-chat" }));
    const event = JSON.parse((await message).toString());
    assert.deepEqual(event, {
      type: "error",
      status: 426,
      error: {
        type: "unsupported_transport",
        code: "WEBSOCKET_NOT_SUPPORTED",
        message: "The selected model upstream supports HTTP transport only."
      }
    });
    assert.equal((await closed).code, 1008);
    assert.equal(upstreamUpgrades, 0);
  } finally {
    await harness.close();
  }
});

test("Responses WebSocket routes guardian review requests to an HTTP-only fallback model when the pool is exhausted", async () => {
  let harness;
  let upstreamUpgrades = 0;
  harness = await startHarness({
    hooks: {
      upstreamService: {
        findRuntimeByModel(modelId) {
          if (modelId !== "deepseek-model") return null;
          return {
            id: "api-native",
            name: "Native API",
            kind: "responses_api",
            enabled: true,
            baseUrl: harness.settings.upstream_base_url,
            apiKey: "api-secret",
            supportsWebSocket: false,
            requestHeaders: {},
            credentialRef: "api-key-ref"
          };
        },
        getModelPricing() {
          return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 2 };
        },
        recordRequestOutcome() {}
      }
    },
    onUpgrade() {
      upstreamUpgrades += 1;
    }
  }, { auto_review_upstream_model: "deepseek-model" });
  try {
    for (const account of harness.accounts) account.quota_7d_used_percent = 100;
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "ws-auto-review-426" });
    const message = nextMessage(websocket);
    const closed = nextCloseDetail(websocket);
    websocket.send(JSON.stringify({
      type: "response.create",
      model: "gpt-5.6-luna",
      prompt_cache_key: "guardian:thread-1"
    }));
    const event = JSON.parse((await message).toString());
    assert.equal(event.status, 426);
    assert.equal(event.error.code, "WEBSOCKET_NOT_SUPPORTED");
    assert.match(event.error.message, /deepseek-model/);
    assert.equal((await closed).code, 1008);
    assert.equal(upstreamUpgrades, 0);
  } finally {
    await harness.close();
  }
});

test("Responses WebSocket falls back to a WebSocket-capable model with the review model rewritten when the pool is exhausted", async () => {
  let harness;
  const upstreamMessages = [];
  harness = await startHarness({
    hooks: {
      upstreamService: {
        findRuntimeByModel(modelId) {
          if (modelId !== "ws-fallback-model") return null;
          return {
            id: "api-native",
            name: "Native API",
            kind: "responses_api",
            enabled: true,
            baseUrl: harness.settings.upstream_base_url,
            apiKey: "api-secret",
            supportsWebSocket: true,
            requestHeaders: {},
            credentialRef: "api-key-ref"
          };
        },
        getModelPricing() {
          return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 2 };
        },
        recordRequestOutcome() {}
      }
    },
    onConnection(websocket) {
      websocket.on("message", (data) => {
        upstreamMessages.push(JSON.parse(data.toString()));
        websocket.send(JSON.stringify({
          type: "response.completed",
          response: { model: "ws-fallback-model", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
        }));
      });
    }
  }, { auto_review_upstream_model: "ws-fallback-model" });
  try {
    for (const account of harness.accounts) account.quota_7d_used_percent = 100;
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "ws-auto-review-fallback" });
    const message = nextMessage(websocket);
    websocket.send(JSON.stringify({
      type: "response.create",
      model: "gpt-5.6-luna",
      prompt_cache_key: "guardian:thread-1",
      input: "review"
    }));
    assert.match((await message).toString(), /response\.completed/);
    assert.equal(upstreamMessages.length, 1);
    assert.equal(upstreamMessages[0].type, "response.create");
    assert.equal(upstreamMessages[0].model, "ws-fallback-model");
    await waitFor(() => harness.tokenLogs.length > 0, 1_000);
    assert.equal(harness.tokenLogs.at(-1).client_model, "gpt-5.6-luna");
    assert.equal(harness.tokenLogs.at(-1).upstream_model, "ws-fallback-model");
    websocket.close();
    await nextClose(websocket);
  } finally {
    await harness.close();
  }
});

test("WebSocket upgrade is rejected with 426 when the configured Codex model only supports HTTP", async () => {
  let harness;
  let upstreamUpgrades = 0;
  harness = await startHarness({
    hooks: {
      ...externalApiHooks(() => harness, false),
      readCurrentCodexModel: () => "deepseek-chat"
    },
    onUpgrade() {
      upstreamUpgrades += 1;
    }
  }, { gateway_websocket_reject_http_only_model_upgrade: "true" });
  try {
    const response = await connectFailure(harness, "/v1/responses", { "session-id": "upgrade-426" });
    assert.equal(response.statusCode, 426);
    assert.equal(upstreamUpgrades, 0);
    assert.equal(harness.appLogs.some((entry) => entry.status === "WEBSOCKET_NOT_SUPPORTED"), true);
  } finally {
    await harness.close();
  }
});

test("WebSocket upgrade proceeds when the configured Codex model is unknown or supports WebSocket", async () => {
  const harness = await startHarness({
    hooks: {
      readCurrentCodexModel: () => "not-in-catalog"
    }
  }, { gateway_websocket_reject_http_only_model_upgrade: "true" });
  try {
    const { websocket, response } = await connectGateway(harness, "/v1/responses", { "session-id": "upgrade-ok" });
    assert.equal(response.statusCode, 101);
    websocket.close();
    await nextClose(websocket);
  } finally {
    await harness.close();
  }
});

test("Responses WebSocket does not replay a request after an upstream error on an established connection", async () => {
  let harness;
  const attempts = [];
  harness = await startHarness({
    hooks: externalApiHooks(() => harness),
    onUpgrade(request, _socket, _head, accept) {
      attempts.push(request.headers.authorization);
      accept();
    },
    onConnection(websocket) {
      websocket.once("message", () => {
        websocket.send(JSON.stringify({ type: "error", error: { code: "usage_limit_reached", message: "quota exceeded" } }));
        websocket.close(1011, "quota");
      });
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "no-replay" });
    const message = nextMessage(websocket);
    const closed = nextCloseDetail(websocket);
    websocket.send(JSON.stringify({ type: "response.create", model: "deepseek-chat" }));
    assert.match((await message).toString(), /usage_limit_reached/);
    assert.equal((await closed).code, 1011);
    assert.deepEqual(attempts, ["Bearer api-secret"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket rate-limit events update usage and quota errors affect only the next connection", async () => {
  const attempts = [];
  let firstConnection = true;
  const harness = await startHarness({
    onUpgrade(request, _socket, _head, accept) {
      attempts.push(request.headers.authorization);
      accept();
    },
    onConnection(websocket) {
      if (!firstConnection) return;
      firstConnection = false;
      websocket.once("message", () => {
        websocket.send(JSON.stringify({
          type: "codex.rate_limits",
          rate_limits: {
            primary: { used_percent: 50, window_minutes: 300, reset_at: 2_000_000_000 },
            secondary: { used_percent: 25, window_minutes: 10080, reset_at: 2_000_100_000 }
          }
        }));
        websocket.send(JSON.stringify({ type: "error", error: { code: "usage_limit_reached", message: "quota exceeded" } }));
      });
    }
  });
  try {
    const first = await connectGateway(harness, "/v1/responses", { "session-id": "session-quota-event" });
    const messages = nextMessages(first.websocket, 2);
    first.websocket.send(JSON.stringify({ type: "response.create" }));
    const received = await messages;
    const rateLimits = JSON.parse(received[0].toString());
    assert.equal(rateLimits.rate_limits.primary.used_percent, 50);
    assert.equal(rateLimits.rate_limits.secondary.used_percent, 25);
    assert.equal(first.websocket.readyState, WebSocket.OPEN);
    first.websocket.close();
    await nextClose(first.websocket);
    assert.equal(harness.accounts[0].quota_5h_used_percent, 50);
    assert.equal(harness.accounts[0].quota_7d_used_percent, 25);

    const second = await connectGateway(harness, "/v1/responses", { "session-id": "session-quota-event" });
    second.websocket.send(JSON.stringify({ type: "response.create" }));
    await waitFor(() => attempts.length === 2, 1_000);
    second.websocket.close();
    await nextClose(second.websocket);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-b"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket rewrite stores the account event before forwarding the aggregate quota", async () => {
  const rawEvent = {
    type: "codex.rate_limits",
    correlation_id: "rate-limit-1",
    rate_limits: {
      primary: { used_percent: 90, window_minutes: 300, reset_at: 2_000_000_000 },
      secondary: { used_percent: 95, window_minutes: 10080, reset_at: 2_000_100_000 }
    }
  };
  const harness = await startHarness({
    onConnection(websocket) {
      websocket.once("message", () => websocket.send(JSON.stringify(rawEvent)));
    }
  }, { codex_quota_headers_mode: "rewrite" });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-rewrite-quota" });
    const message = nextMessage(websocket);
    websocket.send(JSON.stringify({ type: "response.create" }));
    const rewritten = JSON.parse((await message).toString());

    assert.equal(rewritten.type, "codex.rate_limits");
    assert.equal(rewritten.correlation_id, "rate-limit-1");
    assert.equal(rewritten.rate_limits.primary.used_percent, 10);
    assert.equal(rewritten.rate_limits.primary.window_minutes, 300);
    assert.equal(rewritten.rate_limits.primary.reset_at, 2_000_000_000);
    assert.equal(rewritten.rate_limits.secondary.used_percent, 15);
    assert.equal(rewritten.rate_limits.secondary.window_minutes, 10080);
    assert.equal(rewritten.rate_limits.secondary.reset_at, 2_000_100_000);
    assert.deepEqual(rewritten.rate_limits.credits, { balance: 0, has_credits: false, unlimited: false });

    assert.equal(harness.accounts[0].quota_5h_used_percent, 90);
    assert.equal(harness.accounts[0].quota_7d_used_percent, 95);
    const stored = JSON.parse(harness.accounts[0].raw_usage_json);
    assert.equal(stored.event.rate_limits.primary.used_percent, 90);
    assert.equal(stored.event.rate_limits.secondary.used_percent, 95);

    websocket.close();
    await nextClose(websocket);
  } finally {
    await harness.close();
  }
});

test("WebSocket response idle timeout closes a stalled logical request", async () => {
  const harness = await startHarness({}, { gateway_websocket_idle_timeout_ms: "40" });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-idle" });
    const closed = nextClose(websocket);
    websocket.send(JSON.stringify({ type: "response.create" }));
    await withTimeout(closed, 1_000, "stalled WebSocket request was not closed");
    await waitFor(() => harness.appLogs.some((entry) => entry.status === "websocket_idle_timeout"), 1_000);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway validates local API key and route before upstream", async () => {
  let attempts = 0;
  const harness = await startHarness({
    onUpgrade(_request, _socket, _head, accept) {
      attempts += 1;
      accept();
    }
  });
  try {
    const unauthorized = await connectFailure(harness, "/v1/responses", { authorization: "Bearer wrong-key" });
    const unknownRoute = await connectFailure(harness, "/v1/unknown");
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unknownRoute.statusCode, 404);
    assert.equal(attempts, 0);
  } finally {
    await harness.close();
  }
});

test("WebSocket reconnect keeps its Session account until quota failover succeeds", async () => {
  const attempts = [];
  let accountAAttempts = 0;
  const harness = await startHarness({
    onUpgrade(request, socket, head, accept) {
      attempts.push(request.headers.authorization);
      if (request.headers.authorization === "Bearer token-a") accountAAttempts += 1;
      if (request.headers.authorization === "Bearer token-a" && accountAAttempts === 2) {
        socket.end([
          "HTTP/1.1 429 Too Many Requests",
          "Content-Type: application/json",
          "Content-Length: 26",
          "Connection: close",
          "",
          '{"error":"quota exceeded"}'
        ].join("\r\n"));
        return;
      }
      accept();
    }
  });
  try {
    const first = await connectGateway(harness, "/v1/responses", { "session-id": "session-1" });
    first.websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    await waitFor(() => attempts.length === 1, 1_000);
    first.websocket.close();
    await nextClose(first.websocket);

    const second = await connectGateway(harness, "/v1/responses", { "session-id": "session-1" });
    second.websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    await waitFor(() => attempts.length === 3, 1_000);
    second.websocket.close();
    await nextClose(second.websocket);

    const third = await connectGateway(harness, "/v1/responses", { "session-id": "session-1" });
    third.websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    await waitFor(() => attempts.length === 4, 1_000);
    third.websocket.close();
    await nextClose(third.websocket);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a", "Bearer token-b", "Bearer token-b"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway never moves an established Turn when its upstream handshake fails", async () => {
  const attempts = [];
  let connections = 0;
  const turnMetadata = JSON.stringify({ turn_id: "turn-1" });
  const harness = await startHarness({
    onUpgrade(request, socket, head, accept) {
      attempts.push(request.headers.authorization);
      connections += 1;
      if (connections === 2) {
        socket.end("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      accept();
    }
  });
  try {
    const first = await connectGateway(harness, "/v1/responses", {
      "session-id": "session-1",
      "x-codex-turn-metadata": turnMetadata
    });
    first.websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    await waitFor(() => attempts.length === 1, 1_000);
    first.websocket.close();
    await nextClose(first.websocket);

    const second = await connectGateway(harness, "/v1/responses", {
      "session-id": "session-1",
      "x-codex-turn-metadata": turnMetadata
    });
    const errorMessage = nextMessage(second.websocket);
    const closed = nextCloseDetail(second.websocket);
    second.websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    assert.match((await errorMessage).toString(), /error/);
    assert.equal((await closed).code, 1008);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a"]);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway rejects unknown Turn state before contacting upstream", async () => {
  let attempts = 0;
  const harness = await startHarness({
    onUpgrade(_request, _socket, _head, accept) {
      attempts += 1;
      accept();
    }
  });
  try {
    const failure = await connectFailure(harness, "/v1/responses", {
      "session-id": "session-1",
      "x-codex-turn-state": "unknown-state"
    });
    assert.equal(failure.statusCode, 409);
    assert.equal(attempts, 0);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway proxies Realtime and sideband query parameters", async () => {
  let upstreamPath = "";
  const harness = await startHarness({
    onConnection(websocket, request) {
      upstreamPath = request.url;
      websocket.once("message", (data) => websocket.send(data));
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/realtime?call_id=rtc_test", {
      "x-session-id": "realtime-session"
    });
    websocket.send(JSON.stringify({ type: "session.update" }));
    assert.equal((await nextMessage(websocket)).toString(), JSON.stringify({ type: "session.update" }));
    websocket.close();
    await nextClose(websocket);
    assert.equal(upstreamPath, "/backend-api/codex/realtime?call_id=rtc_test");
    assert.match(harness.settings.gateway_affinity_state_json, /realtime-session/);
  } finally {
    await harness.close();
  }
});

test("gateway stop terminates active WebSockets within the shutdown grace period", async () => {
  const harness = await startHarness({});
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "session-1" });
    assert.equal(harness.gateway.status().activeWebSockets, 1);
    assert.equal(harness.gateway.status().activeHttpRequests, 0);
    const closed = nextClose(websocket);
    const started = Date.now();
    await harness.gateway.stop();
    await withTimeout(closed, 1_000, "active WebSocket did not close during gateway stop");
    assert.ok(Date.now() - started < 500);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway refreshes stale quotas before rejecting the existing handshake", async () => {
  let refreshCount = 0;
  let harness;
  harness = await startHarness({
    hooks: {
      async ensureUsableAccounts() {
        refreshCount += 1;
        for (const account of harness.accounts) account.quota_7d_used_percent = 10;
      }
    },
    onConnection(websocket) {
      websocket.close(1000, "ok");
    }
  });
  try {
    for (const account of harness.accounts) account.quota_7d_used_percent = 100;
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "refresh-session" });
    websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    await nextClose(websocket);
    assert.equal(refreshCount, 1);
  } finally {
    await harness.close();
  }
});

test("WebSocket gateway waits for a quota refresh and retries the current handshake", async () => {
  let upgradeCount = 0;
  let refreshCount = 0;
  let harness;
  harness = await startHarness({
    hooks: {
      async refreshAllUsage(reason) {
        refreshCount += 1;
        assert.equal(reason, "gateway-websocket-quota-without-headers");
        for (const account of harness.accounts) account.quota_7d_used_percent = 10;
        return harness.accounts.map((account) => ({ id: account.id, ok: true }));
      }
    },
    onUpgrade(_request, socket, _head, accept) {
      upgradeCount += 1;
      if (upgradeCount <= 2) {
        socket.end([
          "HTTP/1.1 429 Too Many Requests",
          "Content-Type: text/plain",
          "Content-Length: 14",
          "Connection: close",
          "",
          "quota exceeded"
        ].join("\r\n"));
        return;
      }
      accept();
    },
    onConnection(websocket) {
      websocket.close(1000, "ok");
    }
  });
  try {
    const { websocket } = await connectGateway(harness, "/v1/responses", { "session-id": "quota-refresh-session" });
    websocket.send(JSON.stringify({ type: "response.create", model: "gpt-5" }));
    await nextClose(websocket);
    assert.equal(refreshCount, 1);
    assert.equal(upgradeCount, 3);
  } finally {
    await harness.close();
  }
});

function externalApiHooks(getHarness, supportsWebSocket = true) {
  return {
    upstreamService: {
      findRuntimeByModel(modelId) {
        if (modelId !== "deepseek-chat" && modelId !== "deepseek-reasoner") return null;
        const harness = getHarness();
        return {
          id: "api-native",
          name: "Native API",
          kind: "responses_api",
          enabled: true,
          baseUrl: harness.settings.upstream_base_url,
          apiKey: "api-secret",
          supportsWebSocket,
          requestHeaders: { "X-Provider-Tenant": "tenant-ws" },
          credentialRef: "api-key-ref"
        };
      },
      getModelPricing(upstreamId, modelId) {
        if (upstreamId === "builtin-chatgpt-subscription-pool") return null;
        assert.equal(upstreamId, "api-native");
        assert.equal(modelId === "deepseek-chat" || modelId === "deepseek-reasoner", true);
        return { inputPerMillion: 1, cachedInputPerMillion: 0.25, outputPerMillion: 2 };
      },
      recordRequestOutcome() {
        return undefined;
      }
    }
  };
}

async function startHarness(options, settingOverrides = {}) {
  const upstreamServer = http.createServer((request, response) => {
    if (options.onHttpRequest) options.onHttpRequest(request, response);
    else response.end("{}");
  });
  const upstreamWebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  upstreamWebSocketServer.on("headers", (headers, request) => options.onHeaders?.(headers, request));
  upstreamWebSocketServer.on("connection", (websocket, request) => options.onConnection?.(websocket, request));
  upstreamServer.on("upgrade", (request, socket, head) => {
    const accept = () => upstreamWebSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      upstreamWebSocketServer.emit("connection", websocket, request);
    });
    if (options.onUpgrade) options.onUpgrade(request, socket, head, accept);
    else accept();
  });
  await listen(upstreamServer);
  const accounts = [account("a", "token-a", 10), account("b", "token-b", 20)];
  const settings = {
    gateway_host: "127.0.0.1",
    gateway_port: "0",
    gateway_api_key: "local-key",
    upstream_base_url: `http://127.0.0.1:${upstreamServer.address().port}/backend-api/codex`,
    gateway_connect_timeout_ms: "1000",
    gateway_shutdown_grace_ms: "100",
    gateway_error_body_limit_bytes: "65536",
    gateway_max_concurrent_requests: "16",
    gateway_websocket_max_connections: "128",
    gateway_websocket_max_payload_bytes: "134217728",
    gateway_websocket_buffer_high_water_bytes: "4194304",
    gateway_websocket_pending_queue_limit_bytes: "4194304",
    gateway_websocket_idle_timeout_ms: "1000",
    gateway_quota_cooldown_ms: "1000",
    codex_quota_headers_mode: "block",
    ...settingOverrides
  };
  const tokenLogs = [];
  const appLogs = [];
  const store = {
    getSettings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    listAccounts: () => accounts,
    updateUsage(id, usage) {
      Object.assign(accounts.find((item) => item.id === id), usage);
    },
    addTokenLog: (entry) => tokenLogs.push(entry),
    addAppLog: (entry) => appLogs.push(entry)
  };
  const gateway = createGateway(store, null, {
    readCurrentCodexModel: () => "",
    ...(options.hooks || {})
  });
  await gateway.start();
  return {
    gateway,
    settings,
    store,
    accounts,
    tokenLogs,
    appLogs,
    upstreamServer,
    upstreamWebSocketServer,
    async close() {
      await gateway.stop();
      for (const websocket of upstreamWebSocketServer.clients) websocket.terminate();
      await closeWebSocketServer(upstreamWebSocketServer);
      await closeServer(upstreamServer);
    }
  };
}

function connectGateway(harness, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(toWebSocketUrl(harness.gateway.status().url, path), {
      perMessageDeflate: true,
      headers: { authorization: "Bearer local-key", ...extraHeaders }
    });
    let response = null;
    websocket.once("upgrade", (value) => {
      response = value;
    });
    websocket.once("open", () => resolve({ websocket, response }));
    websocket.once("error", reject);
  });
}

function connectFailure(harness, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(toWebSocketUrl(harness.gateway.status().url, path), {
      headers: { authorization: "Bearer local-key", ...extraHeaders }
    });
    websocket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response);
    });
    websocket.once("open", () => reject(new Error("WebSocket unexpectedly connected")));
    websocket.once("error", () => {});
  });
}

function nextMessage(websocket) {
  return new Promise((resolve, reject) => {
    websocket.once("message", resolve);
    websocket.once("error", reject);
  });
}

function nextMessages(websocket, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (data) => {
      messages.push(data);
      if (messages.length < count) return;
      cleanup();
      resolve(messages);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      websocket.off("message", onMessage);
      websocket.off("error", onError);
    };
    websocket.on("message", onMessage);
    websocket.once("error", onError);
  });
}

function nextClose(websocket) {
  if (websocket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => websocket.once("close", resolve));
}

function nextCloseDetail(websocket) {
  return new Promise((resolve) => websocket.once("close", (code, reason) => resolve({
    code,
    reason: reason.toString()
  })));
}

function account(id, token, usage) {
  return {
    id,
    enabled: true,
    status: "active",
    access_token: token,
    account_id: `account-${id}`,
    quota_5h_used_percent: usage,
    quota_7d_used_percent: usage,
    priority: 100
  };
}

function toWebSocketUrl(baseUrl, path) {
  return `${baseUrl.replace(/^http/, "ws")}${path}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function closeWebSocketServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
