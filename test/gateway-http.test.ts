import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createGateway } from "../src/main/gateway.ts";

test("HTTP gateway streams SSE unchanged and preserves turn state", async () => {
  const harness = await startHarness((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-codex-turn-state": "state-a"
    });
    res.write('data: {"type":"response.in_progress"}\n\n');
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n');
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("session-1", "turn-1")
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-codex-turn-state"), "state-a");
    assert.equal(await response.text(), [
      'data: {"type":"response.in_progress"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n'
    ].join(""));
    assert.equal(harness.tokenLogs.at(-1).total_tokens, 5);
  } finally {
    await harness.close();
  }
});

test("HTTP subscription gateway removes non-empty external reasoning items before replaying history", async () => {
  const upstreamBodies = [];
  const harness = await startHarness(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.completed"}\n\n');
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("cross-provider-session", "gpt-return-turn"),
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
          { type: "reasoning", id: "rs_openai", summary: [], content: [], encrypted_content: "gAAAAA-openai" },
          {
            type: "reasoning",
            summary: [],
            content: [{ type: "reasoning_text", text: "provider-private reasoning" }],
            encrypted_content: "deepseek-response-id-0"
          },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] }
        ]
      })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(upstreamBodies.length, 1);
    assert.deepEqual(upstreamBodies[0].input, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
      { type: "reasoning", id: "rs_openai", summary: [], content: [], encrypted_content: "gAAAAA-openai" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] }
    ]);
  } finally {
    await harness.close();
  }
});

test("HTTP subscription gateway adds model routing hints for Responses and Compact", async () => {
  const upstreamRequests = [];
  const harness = await startHarness(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    if (req.url.endsWith("/compact")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.completed"}\n\n');
  });
  try {
    const requests = [
      ["/v1/responses", { model: "gpt-test", input: "hello" }, "model=gpt-test"],
      ["/v1/responses/compact", { model: "gpt-test", service_tier: "priority", input: [] }, "model=gpt-test;tier=priority"]
    ];
    for (const [path, body] of requests) {
      const response = await gatewayFetch(harness, path, {
        headers: { ...codexHeaders(`routing-${path}`, `turn-${path}`), "x-codex-routing-hint": "stale-client-hint" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.deepEqual(upstreamRequests.map((request) => request.headers["x-codex-routing-hint"]), requests.map((item) => item[2]));
    assert.equal(upstreamRequests[0].headers.authorization, "Bearer token-a");
    assert.equal(upstreamRequests[0].headers["chatgpt-account-id"], "account-a");
    assert.equal(upstreamRequests[0].headers.session_id, "routing-/v1/responses");
    assert.deepEqual(upstreamRequests.map((request) => request.body.model), ["gpt-test", "gpt-test"]);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway rewrites account quota headers with the aggregate pool quota", async () => {
  const harness = await startHarness((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-codex-primary-used-percent": "90",
      "x-codex-secondary-used-percent": "95"
    });
    res.end('data: {"type":"response.completed"}\n\n');
  }, { codex_quota_headers_mode: "rewrite" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("session-rewrite-quota", "turn-rewrite-quota")
    });
    assert.equal(response.headers.get("x-codex-primary-used-percent"), "10");
    assert.equal(response.headers.get("x-codex-secondary-used-percent"), "15");
    assert.equal(await response.text(), 'data: {"type":"response.completed"}\n\n');
    assert.equal(harness.accounts[0].quota_5h_used_percent, 90);
    assert.equal(harness.accounts[0].quota_7d_used_percent, 95);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway removes hop-by-hop, connection-nominated, and cookie response headers", async () => {
  const harness = await startHarness((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      connection: "keep-alive, x-upstream-hop",
      "keep-alive": "timeout=99",
      "x-upstream-hop": "secret",
      "set-cookie": "session=upstream",
      "x-codex-turn-state": "safe-state"
    });
    res.end("{}");
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses/compact", {
      headers: codexHeaders("session-headers", "turn-headers")
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-codex-turn-state"), "safe-state");
    assert.equal(response.headers.get("x-upstream-hop"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.notEqual(response.headers.get("keep-alive"), "timeout=99");
  } finally {
    await harness.close();
  }
});

test("HTTP gateway keeps a session account until quota exhaustion then replaces the session binding", async () => {
  const attempts = [];
  let accountAResponses = 0;
  const harness = await startHarness((req, res) => {
    const token = req.headers.authorization;
    attempts.push(token);
    if (token === "Bearer token-a") accountAResponses += 1;
    if (token === "Bearer token-a" && accountAResponses === 2) {
      res.writeHead(429, {
        "content-type": "application/json",
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-after-seconds": "1800"
      });
      return res.end('{"error":"quota exceeded"}');
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end('data: {"type":"response.completed"}\n\n');
  });
  try {
    assert.equal((await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") })).status, 200);
    assert.equal((await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-2") })).status, 200);
    assert.equal((await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-3") })).status, 200);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a", "Bearer token-b", "Bearer token-b"]);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway replaces a session account when token refresh fails", async () => {
  const attempts = [];
  const harness = await startHarness((req, res) => {
    attempts.push(req.headers.authorization);
    if (req.headers.authorization === "Bearer token-a") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"error":"token expired"}');
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end('data: {"type":"response.completed"}\n\n');
  }, {}, {
    async refreshAccountToken(id) {
      assert.equal(id, "a");
      throw new Error("refresh credential unavailable");
    }
  });
  try {
    const first = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("session-auth-failover", "turn-1")
    });
    assert.equal(first.status, 200);
    await first.text();

    const second = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("session-auth-failover", "turn-2")
    });
    assert.equal(second.status, 200);
    await second.text();
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-b", "Bearer token-b"]);
    assert.match(harness.store.getSettings().gateway_affinity_state_json, /session-auth-failover/);
    assert.match(harness.store.getSettings().gateway_affinity_state_json, /"accountId":"b"/);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway never moves an established turn to another account", async () => {
  const attempts = [];
  let calls = 0;
  const harness = await startHarness((req, res) => {
    attempts.push(req.headers.authorization);
    calls += 1;
    if (calls === 1) {
      res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": "sticky-a" });
      return res.end('data: {"type":"response.completed"}\n\n');
    }
    res.writeHead(429, { "content-type": "application/json" });
    return res.end('{"error":"quota exceeded"}');
  });
  try {
    const first = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    await first.text();
    const second = await gatewayFetch(harness, "/v1/responses", {
      headers: {
        ...codexHeaders("session-1", "turn-1"),
        "x-codex-turn-state": "sticky-a"
      }
    });
    assert.equal(second.status, 429);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a"]);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway rejects an unknown turn state instead of guessing an account", async () => {
  let upstreamCalls = 0;
  const harness = await startHarness((req, res) => {
    upstreamCalls += 1;
    res.end("unexpected");
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: {
        ...codexHeaders("session-1", "turn-1"),
        "x-codex-turn-state": "unknown-state"
      }
    });
    assert.equal(response.status, 409);
    assert.equal(upstreamCalls, 0);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway restores turn affinity after a gateway restart", async () => {
  const attempts = [];
  const harness = await startHarness((req, res) => {
    attempts.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": "persisted-state" });
    res.end('data: {"type":"response.completed"}\n\n');
  });
  let restarted = null;
  try {
    const first = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    await first.text();
    await harness.gateway.stop();

    restarted = createGateway(harness.store, null, {});
    await restarted.start();
    const second = await fetch(`${restarted.status().url}/v1/responses`, {
      method: "POST",
      headers: {
        ...codexHeaders("session-1", "turn-1"),
        "x-codex-turn-state": "persisted-state"
      },
      body: "{}"
    });
    assert.equal(second.status, 200);
    await second.text();
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-a"]);
  } finally {
    await restarted?.stop();
    await harness.close();
  }
});

test("HTTP gateway rejects oversized request bodies before contacting upstream", async () => {
  let upstreamCalls = 0;
  const harness = await startHarness((req, res) => {
    upstreamCalls += 1;
    res.end("unexpected");
  }, { gateway_request_body_limit_bytes: "8" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      body: "0123456789",
      headers: codexHeaders("session-1", "turn-1")
    });
    assert.equal(response.status, 413);
    assert.equal(upstreamCalls, 0);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway enforces the configured concurrent request limit", async () => {
  let upstreamCalls = 0;
  const harness = await startHarness((req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.in_progress"}\n\n');
  }, { gateway_max_concurrent_requests: "1" });
  try {
    const first = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    assert.equal(harness.gateway.status().activeHttpRequests, 1);
    assert.equal(harness.gateway.status().activeWebSockets, 0);
    const second = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-2", "turn-2") });
    assert.equal(second.status, 503);
    assert.equal(upstreamCalls, 1);
    await first.body.cancel();
    await waitFor(() => harness.gateway.status().activeHttpRequests === 0, 1_000);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway caps buffered upstream error bodies", async () => {
  const harness = await startHarness((req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("x".repeat(1024));
  }, { gateway_error_body_limit_bytes: "32" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    assert.equal(response.status, 500);
    assert.equal((await response.text()).length, 32);
  } finally {
    await harness.close();
  }
});

test("HTTP client disconnect aborts the active upstream response", async () => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  const harness = await startHarness((req, res) => {
    res.on("close", resolveUpstreamClosed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.in_progress"}\n\n');
  });
  try {
    await abortAfterFirstChunk(`${harness.gateway.status().url}/v1/responses`, codexHeaders("session-1", "turn-1"));
    await withTimeout(upstreamClosed, 1_000, "upstream response was not cancelled");
    assert.equal(harness.appLogs.some((entry) => entry.status === "client_cancelled"), true);
  } finally {
    await harness.close();
  }
});

test("HTTP client abort during request upload does not hang or contact upstream", async () => {
  let upstreamCalls = 0;
  const harness = await startHarness((req, res) => {
    upstreamCalls += 1;
    res.end("unexpected");
  });
  try {
    await abortDuringUpload(`${harness.gateway.status().url}/v1/responses`, codexHeaders("session-1", "turn-1"));
    await waitFor(() => harness.appLogs.some((entry) => entry.status === "client_cancelled"), 1_000);
    assert.equal(upstreamCalls, 0);
  } finally {
    await harness.close();
  }
});

test("HTTP streaming idle timeout ends a stalled upstream response", async () => {
  const harness = await startHarness((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.in_progress"}\n\n');
  }, { gateway_stream_idle_timeout_ms: "40" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    await withTimeout(response.text(), 1_000, "gateway did not end the idle response");
    assert.equal(harness.appLogs.some((entry) => entry.status === "stream_idle_timeout"), true);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway applies a separate upstream connection timeout", async () => {
  const harness = await startHarness(() => {}, { gateway_connect_timeout_ms: "40" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") });
    assert.equal(response.status, 502);
    assert.equal(harness.appLogs.some((entry) => entry.status === "connect_timeout"), true);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway applies a unary total timeout independently from stream idle timeout", async () => {
  const harness = await startHarness((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  }, { gateway_unary_timeout_ms: "40", gateway_stream_idle_timeout_ms: "1000" });
  try {
    const response = await gatewayFetch(harness, "/v1/responses/compact", { headers: codexHeaders("session-1", "turn-1") });
    await withTimeout(response.text(), 1_000, "unary timeout did not end the response");
    assert.equal(harness.appLogs.some((entry) => entry.status === "unary_timeout"), true);
  } finally {
    await harness.close();
  }
});

test("gateway stop aborts active requests and completes within its grace period", async () => {
  let resolveUpstreamStarted;
  const upstreamStarted = new Promise((resolve) => {
    resolveUpstreamStarted = resolve;
  });
  const harness = await startHarness(() => {
    resolveUpstreamStarted();
  }, { gateway_shutdown_grace_ms: "50" });
  try {
    const pending = gatewayFetch(harness, "/v1/responses", { headers: codexHeaders("session-1", "turn-1") }).catch(() => null);
    await withTimeout(upstreamStarted, 1_000, "upstream request did not start");
    const started = Date.now();
    await harness.gateway.stop();
    assert.ok(Date.now() - started < 500);
    await pending;
  } finally {
    await harness.close();
  }
});

test("gateway can retry startup after its configured port was temporarily occupied", async () => {
  const occupied = http.createServer();
  await listen(occupied);
  const settings = {
    gateway_host: "127.0.0.1",
    gateway_port: String(occupied.address().port),
    gateway_api_key: "local-key",
    gateway_shutdown_grace_ms: "100",
    gateway_affinity_state_json: "{}"
  };
  const store = {
    getSettings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    listAccounts: () => [],
    addAppLog: () => {}
  };
  const gateway = createGateway(store, null, {});
  try {
    await assert.rejects(gateway.start(), /EADDRINUSE/);
    assert.equal(gateway.status().running, false);
    assert.match(gateway.status().error, /EADDRINUSE/);
    await closeServer(occupied);
    await gateway.start();
    assert.equal(gateway.status().running, true);
  } finally {
    await gateway.stop();
    await closeServer(occupied);
  }
});

test("optional Codex HTTP endpoints are explicitly proxied", async () => {
  const paths = [];
  const harness = await startHarness((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { "content-type": "application/json", location: "/v1/realtime/calls/call-1" });
    res.end("{}");
  });
  try {
    for (const path of [
      "/v1/memories/trace_summarize",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/realtime/calls"
    ]) {
      const response = await gatewayFetch(harness, path, { headers: codexHeaders("session-1", "turn-1") });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.deepEqual(paths, [
      "/backend-api/codex/memories/trace_summarize",
      "/backend-api/codex/images/generations",
      "/backend-api/codex/images/edits",
      "/backend-api/codex/realtime/calls"
    ]);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway refreshes stale quotas and retries account selection without client reconnect", async () => {
  let refreshCount = 0;
  const harness = await startHarness((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }, {}, {
    async ensureUsableAccounts() {
      refreshCount += 1;
      for (const account of harness.accounts) account.quota_7d_used_percent = 10;
    }
  });
  try {
    for (const account of harness.accounts) account.quota_7d_used_percent = 100;
    const response = await gatewayFetch(harness, "/v1/responses/compact", { headers: codexHeaders("refresh-session", "refresh-turn") });
    assert.equal(response.status, 200);
    assert.equal(refreshCount, 1);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway waits for a quota refresh and retries the current upstream request", async () => {
  let upstreamCalls = 0;
  let refreshCount = 0;
  const harness = await startHarness((_req, res) => {
    upstreamCalls += 1;
    if (upstreamCalls <= 2) {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("quota exceeded");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }, {}, {
    async refreshAllUsage(reason) {
      refreshCount += 1;
      assert.equal(reason, "gateway-quota-without-headers");
      for (const account of harness.accounts) account.quota_7d_used_percent = 10;
      return harness.accounts.map((account) => ({ id: account.id, ok: true }));
    }
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses/compact", {
      headers: codexHeaders("quota-refresh-session", "quota-refresh-turn")
    });
    assert.equal(response.status, 200);
    assert.equal(refreshCount, 1);
    assert.equal(upstreamCalls, 3);
  } finally {
    await harness.close();
  }
});

test("HTTP client close after response.completed is logged as a completed request", async () => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  const harness = await startHarness((_req, res) => {
    res.on("close", resolveUpstreamClosed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.completed","response":{"usage":{"total_tokens":7}}}\n\n');
  });
  try {
    await abortAfterFirstChunk(`${harness.gateway.status().url}/v1/responses`, codexHeaders("completed-session", "completed-turn"));
    await withTimeout(upstreamClosed, 1_000, "completed upstream response was not released");
    await waitFor(() => harness.tokenLogs.some((entry) => entry.status === 200), 1_000);
    assert.equal(harness.appLogs.some((entry) => entry.status === "client_cancelled"), false);
    assert.equal(harness.tokenLogs.at(-1).total_tokens, 7);
  } finally {
    await harness.close();
  }
});

test("GET models returns the combined local model catalog", async () => {
  const harness = await startHarness((_req, res) => {
    res.writeHead(500);
    res.end();
  }, {}, {
    upstreamService: {
      listGatewayModels() {
        return [
          { id: "gpt-built-in", object: "model", display_name: "GPT Built In", owned_by: "ChatGPT 订阅账号池" },
          { id: "third-party", object: "model", display_name: "Third Party", owned_by: "Example API" }
        ];
      }
    }
  });
  try {
    const response = await fetch(`${harness.gateway.status().url}/v1/models`, {
      headers: { authorization: "Bearer local-key" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((model) => model.id), ["gpt-built-in", "third-party"]);
  } finally {
    await harness.close();
  }
});

test("unified subscription routing uses the migrated built-in upstream base URL", async () => {
  let migratedCalls = 0;
  let legacyCalls = 0;
  const migratedUpstream = http.createServer((_req, res) => {
    migratedCalls += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.completed"}\n\n');
  });
  await listen(migratedUpstream);
  const migratedPort = migratedUpstream.address().port;
  const hooks = {
    routingPolicyService: {
      httpCandidates() {
        return [{ id: "builtin-chatgpt-subscription-pool", name: "Subscription", kind: "chatgpt_subscription_pool" }];
      }
    },
    modelMappingService: { resolve: () => null },
    upstreamService: {
      getRuntime(id) {
        assert.equal(id, "builtin-chatgpt-subscription-pool");
        return {
          id,
          name: "Subscription",
          kind: "chatgpt_subscription_pool",
          baseUrl: `http://127.0.0.1:${migratedPort}/backend-api/codex`
        };
      }
    }
  };
  const harness = await startHarness((_req, res) => {
    legacyCalls += 1;
    res.writeHead(500);
    res.end();
  }, {}, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("migrated-subscription", "turn-1"),
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(migratedCalls, 1);
    assert.equal(legacyCalls, 0);
  } finally {
    await harness.close();
    await closeServer(migratedUpstream);
  }
});

test("HTTP gateway routes an external model directly to its owning API channel", async () => {
  const apiRequests = [];
  const apiUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    apiRequests.push({
      authorization: req.headers.authorization,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
    });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "openai-model": "provider-internal-model",
      "x-codex-primary-used-percent": "91",
      "x-provider-limit": "provider-value"
    });
    res.end('data: {"type":"response.completed","response":{"model":"third-party","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}\n\n');
  });
  await listen(apiUpstream);
  const apiPort = apiUpstream.address().port;
  let subscriptionCalls = 0;
  const hooks = {
    upstreamService: {
      findRuntimeByModel(model) {
        return model === "third-party" ? {
          id: "api-owner",
          name: "API Owner",
          kind: "responses_api",
          enabled: true,
          baseUrl: `http://127.0.0.1:${apiPort}/v1`,
          apiKey: "provider-key",
          supportsWebSocket: false,
          requestHeaders: {},
          credentialRef: "provider-fingerprint"
        } : null;
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0.25, outputPerMillion: 2 };
      },
      recordRequestOutcome() {}
    }
  };
  const harness = await startHarness((_req, res) => {
    subscriptionCalls += 1;
    res.writeHead(500);
    res.end();
  }, { billing_currency: "USD", codex_quota_headers_mode: "rewrite" }, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: {
        ...codexHeaders("direct-model", "turn-1"),
        "openai-beta": "responses=2026",
        "chatgpt-account-id": "must-not-leak",
        "x-codex-routing-hint": "must-not-leak"
      },
      body: JSON.stringify({ model: "third-party", input: "hello" })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(subscriptionCalls, 0);
    assert.equal(apiRequests.length, 1);
    assert.equal(apiRequests[0].authorization, "Bearer provider-key");
    assert.equal(apiRequests[0].headers["openai-beta"], undefined);
    assert.equal(apiRequests[0].headers["chatgpt-account-id"], undefined);
    assert.equal(apiRequests[0].headers["x-codex-routing-hint"], undefined);
    assert.equal(apiRequests[0].headers["x-codex-turn-metadata"], undefined);
    assert.equal(apiRequests[0].headers.session_id, undefined);
    assert.equal(apiRequests[0].body.model, "third-party");
    assert.equal(response.headers.get("openai-model"), null);
    assert.equal(response.headers.get("x-codex-primary-used-percent"), "0");
    assert.equal(response.headers.get("x-codex-secondary-used-percent"), "0");
    assert.equal(response.headers.get("x-provider-limit"), "provider-value");
    assert.equal(harness.tokenLogs.at(-1).upstream_id, "api-owner");
    assert.equal(harness.tokenLogs.at(-1).client_model, "third-party");
    assert.equal(harness.tokenLogs.at(-1).upstream_model, "third-party");
    assert.equal(harness.tokenLogs.at(-1).estimated_cost, 0.000008);
    assert.equal(harness.tokenLogs.at(-1).cost_unit, "USD");
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway routes codex-auto-review to the configured API model when the account pool is unavailable", async () => {
  const apiRequests = [];
  let subscriptionCalls = 0;
  const apiUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    apiRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.completed","response":{"model":"deepseek-model","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n');
  });
  await listen(apiUpstream);
  const apiPort = apiUpstream.address().port;
  const hooks = {
    upstreamService: {
      findRuntimeByModel(model) {
        return model === "deepseek-model" ? {
          id: "api-owner",
          name: "API Owner",
          kind: "responses_api",
          enabled: true,
          baseUrl: `http://127.0.0.1:${apiPort}/v1`,
          apiKey: "provider-key",
          supportsWebSocket: false,
          compactAdaptEnabled: false,
          requestHeaders: {},
          credentialRef: "provider-fingerprint"
        } : null;
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1 };
      },
      recordRequestOutcome() {}
    }
  };
  const harness = await startHarness((_req, res) => {
    subscriptionCalls += 1;
    res.writeHead(500);
    res.end();
  }, { auto_review_upstream_model: "deepseek-model" }, hooks);
  try {
    for (const account of harness.accounts) account.quota_7d_used_percent = 100;
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("auto-review-fallback", "turn-1"),
      body: JSON.stringify({ model: "codex-auto-review", input: "review the diff" })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(subscriptionCalls, 0);
    assert.equal(apiRequests.length, 1);
    assert.equal(apiRequests[0].model, "deepseek-model");
    assert.equal(apiRequests[0].input, "review the diff");
    assert.equal(harness.tokenLogs.at(-1).client_model, "codex-auto-review");
    assert.equal(harness.tokenLogs.at(-1).upstream_model, "deepseek-model");
    assert.equal(harness.tokenLogs.at(-1).upstream_id, "api-owner");
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway keeps codex-auto-review on the subscription pool while an account is usable", async () => {
  const apiRequests = [];
  const subscriptionBodies = [];
  const apiUpstream = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  await listen(apiUpstream);
  const apiPort = apiUpstream.address().port;
  const hooks = {
    upstreamService: {
      findRuntimeByModel(model) {
        return model === "deepseek-model" ? {
          id: "api-owner",
          name: "API Owner",
          kind: "responses_api",
          enabled: true,
          baseUrl: `http://127.0.0.1:${apiPort}/v1`,
          apiKey: "provider-key",
          supportsWebSocket: false,
          compactAdaptEnabled: false,
          requestHeaders: {},
          credentialRef: "provider-fingerprint"
        } : null;
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1 };
      },
      recordRequestOutcome() {}
    }
  };
  const harness = await startHarness(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    subscriptionBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.completed","response":{"model":"codex-auto-review","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n');
  }, { auto_review_upstream_model: "deepseek-model" }, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("auto-review-pool", "turn-1"),
      body: JSON.stringify({ model: "codex-auto-review", input: "review the diff" })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(apiRequests.length, 0);
    assert.equal(subscriptionBodies.length, 1);
    assert.equal(subscriptionBodies[0].model, "codex-auto-review");
    assert.equal(harness.tokenLogs.at(-1).upstream_kind, "chatgpt_subscription_pool");
    assert.equal(harness.tokenLogs.at(-1).client_model, "codex-auto-review");
    assert.equal(harness.tokenLogs.at(-1).upstream_model, "codex-auto-review");
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway falls back for guardian review requests when the pool upstream exhausts quota", async () => {
  const apiRequests = [];
  let subscriptionAttempts = 0;
  const apiUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    apiRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.completed","response":{"model":"deepseek-model","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n');
  });
  await listen(apiUpstream);
  const apiPort = apiUpstream.address().port;
  const hooks = {
    upstreamService: {
      findRuntimeByModel(model) {
        return model === "deepseek-model" ? {
          id: "api-owner",
          name: "API Owner",
          kind: "responses_api",
          enabled: true,
          baseUrl: `http://127.0.0.1:${apiPort}/v1`,
          apiKey: "provider-key",
          supportsWebSocket: false,
          compactAdaptEnabled: false,
          requestHeaders: {},
          credentialRef: "provider-fingerprint"
        } : null;
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1 };
      },
      recordRequestOutcome() {}
    }
  };
  const harness = await startHarness((_req, res) => {
    subscriptionAttempts += 1;
    res.writeHead(429, { "content-type": "application/json" });
    res.end('{"error":"quota exceeded"}');
  }, { auto_review_upstream_model: "deepseek-model" }, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("auto-review-exhausted", "turn-1"),
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        prompt_cache_key: "guardian:thread-1",
        input: "review the diff"
      })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(subscriptionAttempts, 2);
    assert.equal(apiRequests.length, 1);
    assert.equal(apiRequests[0].model, "deepseek-model");
    assert.equal(apiRequests[0].input, "review the diff");
    assert.equal(harness.tokenLogs.at(-1).client_model, "gpt-5.6-luna");
    assert.equal(harness.tokenLogs.at(-1).upstream_model, "deepseek-model");
    assert.equal(harness.tokenLogs.at(-1).upstream_id, "api-owner");
    assert.equal(harness.appLogs.some((entry) => entry.action === "auto-review-fallback"), true);
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway rejects codex-auto-review when the pool is unavailable and no fallback model is configured", async () => {
  let subscriptionCalls = 0;
  const hooks = {
    upstreamService: {
      findRuntimeByModel() {
        return null;
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1 };
      },
      recordRequestOutcome() {}
    }
  };
  const harness = await startHarness((_req, res) => {
    subscriptionCalls += 1;
    res.writeHead(500);
    res.end();
  }, {}, hooks);
  try {
    for (const account of harness.accounts) account.quota_7d_used_percent = 100;
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("auto-review-unconfigured", "turn-1"),
      body: JSON.stringify({ model: "codex-auto-review", input: "review the diff" })
    });
    assert.equal(response.status, 503);
    assert.equal(subscriptionCalls, 0);
    assert.match(harness.appLogs.at(-1).message, /auto review fallback model/);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway wraps compaction responses for API channels with the adaptation switch enabled", async () => {
  const apiRequests = [];
  const apiUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    apiRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      'data: {"type":"response.created","response":{"id":"resp-compact"}}',
      "",
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Summarized history."}]}}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp-compact","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}',
      ""
    ].join("\n"));
  });
  await listen(apiUpstream);
  const apiPort = apiUpstream.address().port;
  const hooks = {
    upstreamService: {
      findRuntimeByModel(model) {
        return model === "deepseek-model" ? {
          id: "api-owner",
          name: "API Owner",
          kind: "responses_api",
          enabled: true,
          baseUrl: `http://127.0.0.1:${apiPort}/v1`,
          apiKey: "provider-key",
          supportsWebSocket: false,
          compactAdaptEnabled: true,
          requestHeaders: {},
          credentialRef: "provider-fingerprint"
        } : null;
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1 };
      },
      recordRequestOutcome() {}
    }
  };
  const harness = await startHarness((_req, res) => {
    res.writeHead(500);
    res.end();
  }, {}, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("compact-adapt", "turn-1"),
      body: JSON.stringify({
        model: "deepseek-model",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "compaction_trigger" }]
      })
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(apiRequests[0].input.some((item) => item.type === "compaction_trigger"), true);
    const events = body.split(/\n{2,}/).filter(Boolean).map((block) => JSON.parse(block.replace(/^data:\s*/, "")));
    const compactionDones = events.filter((event) => event.type === "response.output_item.done" && event.item?.type === "compaction");
    assert.equal(compactionDones.length, 1);
    assert.equal(compactionDones[0].item.encrypted_content, "Summarized history.");
    assert.match(compactionDones[0].item.id, /^cmp_cgw_plain_v1_/);
    assert.ok(events.findIndex((event) => event.type === "response.output_item.done" && event.item?.type === "compaction")
      < events.findIndex((event) => event.type === "response.completed"));
    assert.equal(harness.tokenLogs.at(-1).total_tokens, 14);
    assert.equal(harness.tokenLogs.at(-1).upstream_id, "api-owner");
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway caps buffered compaction adaptation responses", async () => {
  const apiUpstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", content: [{ type: "output_text", text: "x".repeat(2048) }] }
    })}\n\n`);
  });
  await listen(apiUpstream);
  const hooks = compactAdaptHooks(`http://127.0.0.1:${apiUpstream.address().port}/v1`);
  const harness = await startHarness((_req, res) => res.end(), {
    gateway_compaction_response_limit_bytes: "1024"
  }, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("compact-limit", "turn-limit"),
      body: compactionRequestBody()
    });
    const responseBody = await response.json();
    assert.equal(response.status, 502);
    assert.equal(responseBody.error.message, "The server encountered a temporary error and could not complete your request.");
    assert.match(harness.appLogs.at(-1).message, /exceeds the 1024-byte gateway limit/);
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway applies a total timeout to a continuously active compaction adaptation response", async () => {
  const apiUpstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const interval = setInterval(() => res.write('data: {"type":"response.in_progress"}\n\n'), 15);
    res.once("close", () => clearInterval(interval));
  });
  await listen(apiUpstream);
  const hooks = compactAdaptHooks(`http://127.0.0.1:${apiUpstream.address().port}/v1`);
  const harness = await startHarness((_req, res) => res.end(), {
    gateway_stream_idle_timeout_ms: "200",
    gateway_unary_timeout_ms: "60"
  }, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("compact-total-timeout", "turn-total-timeout"),
      body: compactionRequestBody()
    });
    const responseBody = await response.json();
    assert.equal(response.status, 502);
    assert.equal(responseBody.error.message, "Request timed out.");
    assert.equal(harness.appLogs.at(-1).status, "compaction_timeout");
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway times out an idle buffered compaction adaptation response", async () => {
  const apiUpstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created"}\n\n');
  });
  await listen(apiUpstream);
  const hooks = compactAdaptHooks(`http://127.0.0.1:${apiUpstream.address().port}/v1`);
  const harness = await startHarness((_req, res) => res.end(), {
    gateway_stream_idle_timeout_ms: "40",
    gateway_unary_timeout_ms: "1000"
  }, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("compact-idle", "turn-idle"),
      body: compactionRequestBody()
    });
    const responseBody = await response.json();
    assert.equal(response.status, 502);
    assert.equal(responseBody.error.message, "Request timed out.");
    assert.equal(harness.appLogs.at(-1).status, "stream_idle_timeout");
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway rewrites its plaintext compaction before routing to an API channel", async () => {
  const apiRequests = [];
  const apiUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    apiRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n');
  });
  await listen(apiUpstream);
  const apiPort = apiUpstream.address().port;
  const hooks = {
    upstreamService: {
      findRuntimeByModel() {
        return {
          id: "third-party-owner",
          name: "Third Party",
          kind: "responses_api",
          enabled: true,
          baseUrl: `http://127.0.0.1:${apiPort}/v1`,
          apiKey: "provider-key",
          supportsWebSocket: false,
          compactAdaptEnabled: true,
          requestHeaders: {},
          credentialRef: "provider-fingerprint"
        };
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1 };
      },
      recordRequestOutcome() {}
    }
  };
  const harness = await startHarness((_req, res) => {
    res.writeHead(500);
    res.end();
  }, {}, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("portable-compaction", "turn-2"),
      body: JSON.stringify({
        model: "any-third-party-model",
        input: [
          {
            id: "cmp_cgw_plain_v1_test",
            type: "compaction",
            encrypted_content: "Summarized portable context."
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(apiRequests[0].input, [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Summarized portable context." }]
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }
    ]);
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway passes compaction responses through unchanged when the adaptation switch is disabled", async () => {
  const upstreamText = [
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Plain reply"}]}}',
    "",
    'data: {"type":"response.completed","response":{"id":"resp-plain"}}',
    ""
  ].join("\n");
  const apiUpstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(upstreamText);
  });
  await listen(apiUpstream);
  const apiPort = apiUpstream.address().port;
  const hooks = {
    upstreamService: {
      findRuntimeByModel() {
        return {
          id: "api-owner",
          name: "API Owner",
          kind: "responses_api",
          enabled: true,
          baseUrl: `http://127.0.0.1:${apiPort}/v1`,
          apiKey: "provider-key",
          supportsWebSocket: false,
          compactAdaptEnabled: false,
          requestHeaders: {},
          credentialRef: "provider-fingerprint"
        };
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1 };
      },
      recordRequestOutcome() {}
    }
  };
  const harness = await startHarness((_req, res) => {
    res.writeHead(500);
    res.end();
  }, {}, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("compact-plain", "turn-1"),
      body: JSON.stringify({
        model: "deepseek-model",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "compaction_trigger" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), upstreamText);
  } finally {
    await harness.close();
    await closeServer(apiUpstream);
  }
});

test("HTTP gateway estimates built-in subscription model cost from its configured model rate", async () => {
  const hooks = {
    upstreamService: {
      getModelPricing(upstreamId, modelId) {
        assert.equal(upstreamId, "builtin-chatgpt-subscription-pool");
        assert.equal(modelId, "gpt-priced");
        return { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 };
      }
    }
  };
  const harness = await startHarness((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.completed","response":{"model":"gpt-priced","usage":{"input_tokens":1000,"cached_input_tokens":500,"output_tokens":100,"total_tokens":1100}}}\n\n');
  }, { billing_currency: "USD" }, hooks);
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("priced-model", "turn-priced"),
      body: JSON.stringify({ model: "gpt-priced", input: "hello" })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(harness.tokenLogs.at(-1).upstream_kind, "chatgpt_subscription_pool");
    assert.equal(harness.tokenLogs.at(-1).estimated_cost, 0.0023);
    assert.equal(harness.tokenLogs.at(-1).cost_unit, "USD");
  } finally {
    await harness.close();
  }
});

test("HTTP gateway writes JSONL API debug logs when enabled", async () => {
  const harness = await startHarness((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": "debug-state" });
    res.end('data: {"type":"response.completed"}\n\n');
  }, {
    debug_api_logging: "true",
    debug_api_logging_expires_at: String(Date.now() + 10 * 60 * 1000)
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("debug-session", "debug-turn"),
      body: JSON.stringify({ model: "gpt-debug", input: "hello" })
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: {"type":"response.completed"}\n\n');
    const logDir = path.join(harness.store.paths.dataDir, "logs");
    await waitFor(() => {
      if (!fs.existsSync(logDir)) return false;
      const files = fs.readdirSync(logDir);
      if (files.length !== 1) return false;
      return fs.readFileSync(path.join(logDir, files[0]), "utf8").trim().split("\n").length >= 2;
    }, 1000);
    const files = fs.readdirSync(logDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], `${localDateKey(new Date())}.jsonl`);
    const lines = fs.readFileSync(path.join(logDir, files[0]), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const requestEntry = JSON.parse(lines[0]);
    assert.equal(requestEntry.kind, "request");
    assert.equal(requestEntry.method, "POST");
    assert.equal(requestEntry.path, "/v1/responses");
    assert.equal(requestEntry.headers.authorization, "[REDACTED]");
    assert.match(requestEntry.body, /gpt-debug/);
    const responseEntry = JSON.parse(lines[1]);
    assert.equal(responseEntry.kind, "response");
    assert.equal(responseEntry.status, 200);
    assert.match(responseEntry.body, /response.completed/);
    assert.equal(responseEntry.id, requestEntry.id);
  } finally {
    await harness.close();
  }
});

test("HTTP gateway writes no debug logs when the setting is disabled", async () => {
  const harness = await startHarness((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  try {
    const response = await gatewayFetch(harness, "/v1/responses", {
      headers: codexHeaders("plain-session", "plain-turn")
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(fs.existsSync(path.join(harness.store.paths.dataDir, "logs")), false);
  } finally {
    await harness.close();
  }
});

function codexHeaders(sessionId, turnId) {
  return {
    authorization: "Bearer local-key",
    "content-type": "application/json",
    session_id: sessionId,
    "x-codex-turn-metadata": JSON.stringify({ turn_id: turnId })
  };
}

function compactionRequestBody() {
  return JSON.stringify({
    model: "deepseek-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "compaction_trigger" }
    ]
  });
}

function compactAdaptHooks(baseUrl) {
  return {
    upstreamService: {
      findRuntimeByModel() {
        return {
          id: "api-owner",
          name: "API Owner",
          kind: "responses_api",
          enabled: true,
          baseUrl,
          apiKey: "provider-key",
          supportsWebSocket: false,
          compactAdaptEnabled: true,
          requestHeaders: {},
          credentialRef: "provider-fingerprint"
        };
      },
      getModelPricing() {
        return { inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1 };
      },
      recordRequestOutcome() {}
    }
  };
}

function gatewayFetch(harness, path, options = {}) {
  return fetch(`${harness.gateway.status().url}${path}`, {
    method: "POST",
    headers: options.headers,
    body: options.body ?? "{}"
  });
}

async function startHarness(upstreamHandler, settingOverrides = {}, hooks = {}) {
  const upstream = http.createServer(upstreamHandler);
  await listen(upstream);
  const upstreamPort = upstream.address().port;
  const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-gateway-test-"));
  const accounts = [
    account("a", "token-a", 10),
    account("b", "token-b", 20)
  ];
  const settings = {
    gateway_host: "127.0.0.1",
    gateway_port: "0",
    gateway_api_key: "local-key",
    upstream_base_url: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    gateway_connect_timeout_ms: "1000",
    gateway_stream_idle_timeout_ms: "1000",
    gateway_unary_timeout_ms: "1000",
    gateway_shutdown_grace_ms: "100",
    gateway_request_body_limit_bytes: "1048576",
    gateway_error_body_limit_bytes: "65536",
    gateway_max_concurrent_requests: "16",
    gateway_quota_cooldown_ms: "1000",
    codex_quota_headers_mode: "block",
    ...settingOverrides
  };
  const tokenLogs = [];
  const appLogs = [];
  const store = {
    paths: {
      dataDir: testDataDir,
      dbPath: path.join(testDataDir, "codex-gateway.sqlite")
    },
    getSettings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    listAccounts: () => accounts,
    updateUsage(id, usage) {
      Object.assign(accounts.find((item) => item.id === id), usage);
    },
    addTokenLog: (entry) => tokenLogs.push(entry),
    addAppLog: (entry) => appLogs.push(entry)
  };
  const gateway = createGateway(store, null, { routingPersistenceDebounceMs: 0, ...hooks });
  await gateway.start();
  return {
    gateway,
    store,
    upstream,
    accounts,
    tokenLogs,
    appLogs,
    async close() {
      await gateway.stop();
      await closeServer(upstream);
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  };
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

function abortAfterFirstChunk(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers }, (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
    });
    request.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
    request.end("{}");
  });
}

function abortDuringUpload(url, headers) {
  return new Promise((resolve) => {
    const request = http.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": "100" }
    });
    request.on("error", () => resolve());
    request.write("partial");
    setTimeout(() => {
      request.destroy();
      resolve();
    }, 10);
  });
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
