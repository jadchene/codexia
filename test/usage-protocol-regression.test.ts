import assert from "node:assert/strict";
import { test } from "vitest";
import { syncAccountUsageFromHeaders, syncAccountUsageFromEvent } from "../src/main/gateway/quota.ts";
import { createSseUsageParser, extractTokenUsage } from "../src/main/gateway/usage-parser.ts";
import { estimateUpstreamCost } from "../src/main/upstreams/cost-estimator.ts";
import { createAccountModeResponsesObserver } from "../src/main/account-mode-responses-observer.ts";
import type { IncomingMessage } from "node:http";
import { createWebSocketObserver } from "../src/main/gateway-websocket-observer.ts";

test("weekly primary headers update weekly quota even when five-hour limits are ignored", () => {
  const updates: any[] = [];
  syncAccountUsageFromHeaders({ id: "a" }, {
    "x-codex-primary-used-percent": "27",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-after-seconds": "600"
  }, { getSettings: () => ({ ignore_five_hour_limit: "true" }), updateUsage: (_, usage) => updates.push(usage) });
  assert.equal(updates[0].quota_7d_used_percent, 27);
  assert.equal(updates[0].quota_5h_used_percent, 27);
  assert.equal(updates[0].has_five_hour_quota, 0);
  assert.ok(updates[0].quota_7d_reset_at > Date.now() / 1000);
});

test("stream quota windows use their duration and preserve unrelated snapshots", () => {
  const updates: any[] = [];
  const store = { updateUsage: (_: string, usage: any) => updates.push(usage) };
  syncAccountUsageFromEvent({ id: "a" }, { type: "codex.rate_limits", rate_limits: {
    primary: { used_percent: 31, window_minutes: 10080, reset_at: 2_000_000_000 },
    secondary: null
  } }, store);
  assert.equal(updates[0].quota_7d_used_percent, 31);
  assert.equal(updates[0].quota_7d_reset_at, 2_000_000_000);
  assert.equal(updates[0].has_five_hour_quota, 0);
  syncAccountUsageFromEvent({ id: "a" }, { type: "codex.rate_limits", rate_limits: {
    primary: { used_percent: 55, window_minutes: 60 }
  } }, store);
  assert.equal(updates.length, 1);
});

test("fragmented SSE quota events update the selected account immediately", () => {
  const updates: any[] = [];
  const parser = createSseUsageParser((event) => syncAccountUsageFromEvent({ id: "a" }, event, {
    updateUsage: (id, usage) => updates.push({ id, ...usage })
  }));
  const data = 'data: {"type":"codex.rate_limits","rate_limits":{"primary_window":{"used_percent":42,"limit_window_seconds":604800},"secondary_window":null}}\n\n';
  parser.feed(Buffer.from(data.slice(0, 50)));
  assert.equal(updates.length, 0);
  parser.feed(Buffer.from(data.slice(50)));
  assert.equal(updates[0].id, "a");
  assert.equal(updates[0].quota_7d_used_percent, 42);
  assert.equal(updates[0].has_five_hour_quota, 0);
});

test("nullable usage aliases do not hide cached tokens or the derived total", () => {
  const usage = extractTokenUsage(JSON.stringify({ usage: {
    input_tokens: 180627, cached_input_tokens: null, input_tokens_details: { cached_tokens: 177536 },
    output_tokens: 354, total_tokens: null
  } }));
  assert.equal(usage.cached_input_tokens, 177536);
  assert.equal(usage.total_tokens, 180981);
  assert.equal(estimateUpstreamCost(usage, { inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 50 })?.amount, 0.226146);
});

test("account-mode WebSocket observes quota events outside a response without creating token logs", () => {
  const updates: any[] = [];
  const logs: any[] = [];
  const observer = createAccountModeResponsesObserver({
    store: { addTokenLog: (log) => logs.push(log), updateUsage: (id, usage) => updates.push({ id, ...usage }) },
    accountId: "selected", quotaAccount: { id: "actual" }, request: { headers: {} } as IncomingMessage,
    requestPath: "/v1/responses", upstreamPath: "/backend-api/codex/responses",
    settings: { ignore_five_hour_limit: "true" }, onIdleTimeout: () => {}
  });
  try {
    observer.onUpstreamMessage(Buffer.from(JSON.stringify({ type: "codex.rate_limits", rate_limits: {
      primary: { used_percent: 39, window_minutes: 10080 }, secondary: null
    } })), false);
    assert.equal(updates[0].id, "actual");
    assert.equal(updates[0].quota_7d_used_percent, 39);
    assert.equal(logs.length, 0);
  } finally {
    observer.dispose();
  }
});

test("persistent WebSocket requests use saved pricing without reconnecting", () => {
  let cachedRate = 1000;
  const logs: any[] = [];
  const observer = createWebSocketObserver({
    store: { addTokenLog: (log) => logs.push(log) }, account: { id: "a" },
    target: { id: "pool", upstreamModel: "model", modelPricing: { inputPerMillion: 10, cachedInputPerMillion: 1000, outputPerMillion: 50 } },
    request: { headers: {} } as IncomingMessage, requestPath: "/v1/responses", upstreamPath: "/responses",
    helpers: { extractTokenUsage, isQuotaExhaustedResponse: () => false }, settings: {},
    onIdleTimeout: () => {}, routing: { setCooldown: () => {}, clearCooldown: () => {} },
    hooks: { upstreamService: { getModelPricing: () => ({ inputPerMillion: 10, cachedInputPerMillion: cachedRate, outputPerMillion: 50 }) } }
  });
  try {
    for (const rate of [1000, 10]) {
      cachedRate = rate;
      observer.onDownstreamMessage(Buffer.from('{"type":"response.create","model":"model"}'), false);
      observer.onUpstreamMessage(Buffer.from('{"type":"response.completed","response":{"usage":{"input_tokens":180627,"cached_input_tokens":177536,"output_tokens":354}}}'), false);
    }
    assert.equal(logs[0].estimated_cost, 177.58461);
    assert.equal(logs[1].estimated_cost, 1.82397);
  } finally {
    observer.dispose();
  }
});
