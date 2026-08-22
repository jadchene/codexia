import assert from "node:assert/strict";
import { test } from "vitest";
import { pickGatewayAccount, quotaWindowExhausted, resetSelectionState, usageScore } from "../src/main/selection.ts";
import { createGatewayRouting, sessionIdFromHeaders, turnIdFromHeaders } from "../src/main/gateway-routing.ts";
import { buildAuthorizeUrl } from "../src/main/auth.ts";
import { gatewayProviderBlock, insertProviderBlockIntoConfig, nextGatewayConfig, replaceGatewayProviderBlock } from "../src/main/codex-cli-auth.ts";
import { buildMcpGatewayCommand, mcpGatewayPath, mcpGatewayUrl } from "../src/main/mcp-gateway-service.ts";
import { buildSubscriptionRoutingHint, setSubscriptionRoutingHint } from "../src/main/gateway/protocol.ts";
import {
  buildCodexQuotaHeaders,
  buildCodexQuotaSnapshot,
  buildAccountPoolQuotaSummary,
  buildGatewayRequest,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  callWithFailover,
  createSseUsageParser,
  dailyRebalanceDateKey,
  extractTokenUsage,
  isAuthExpiredResponse,
  isQuotaExhaustedResponse,
  matchGatewayRoute,
  selectInitialGatewayAccount,
  syncAccountUsageFromHeaders
} from "../src/main/gateway.ts";

test("pickGatewayAccount chooses the first enabled token account by priority order", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "disabled", enabled: false, access_token: "a", status: "active", quota_5h_used_percent: 0 },
    { id: "busy", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 80 },
    { id: "best", enabled: true, access_token: "c", status: "active", quota_5h_used_percent: 20, priority: 50 }
  ]);
  assert.equal(account.id, "best");
});

test("buildAuthorizeUrl uses the official Codex OAuth scope shape", () => {
  const url = new URL(buildAuthorizeUrl({
    issuer: "https://auth.openai.com",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    codeChallenge: "challenge",
    state: "state"
  }));
  assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
});

test("pickGatewayAccount can exclude failed accounts", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "first", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 1 },
    { id: "second", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 20 }
  ], "", ["first"]);
  assert.equal(account.id, "second");
});

test("usageScore uses the highest active quota window", () => {
  assert.equal(usageScore({ quota_5h_used_percent: 12, quota_7d_used_percent: 34 }), 34);
});

test("quotaWindowExhausted marks accounts with a depleted window unavailable", () => {
  resetSelectionState();
  assert.equal(quotaWindowExhausted({ quota_5h_used_percent: 100, quota_7d_used_percent: 20 }), true);
  assert.equal(pickGatewayAccount([
    { id: "empty", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 100 },
    { id: "usable", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 50 }
  ]).id, "usable");
});

test("pickGatewayAccount keeps the current database account until exhausted", () => {
  resetSelectionState();
  const accounts = [
    { id: "less-used", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 10 },
    { id: "current", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 95 }
  ];
  assert.equal(pickGatewayAccount(accounts, "current").id, "current");
});

test("pickGatewayAccount falls back to fixed order when no current account exists", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "more-used", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 40 },
    { id: "less-used", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 15 }
  ]);
  assert.equal(account.id, "more-used");
});

test("pickGatewayAccount switches current account only when exhausted", () => {
  resetSelectionState();
  const accounts = [
    { id: "current", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 100 },
    { id: "next", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 40 }
  ];
  assert.equal(pickGatewayAccount(accounts, "current").id, "next");
});

test("pickGatewayAccount keeps low remaining accounts usable until exhausted", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "almost-empty", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 97 },
    { id: "least-empty", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 96 }
  ]);
  assert.equal(account.id, "almost-empty");
});

test("pickGatewayAccount can prefer the account with more seven-day quota", () => {
  resetSelectionState();
  const account = pickGatewayAccount([
    { id: "current", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 5, quota_7d_used_percent: 70 },
    { id: "weekly-room", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 95, quota_7d_used_percent: 20 }
  ], "current", [], { preferSevenDayQuota: true });
  assert.equal(account.id, "weekly-room");
});

test("selectInitialGatewayAccount rebalances once per local day", () => {
  resetSelectionState();
  const accounts = [
    { id: "current", enabled: true, access_token: "a", status: "active", quota_5h_used_percent: 0, quota_7d_used_percent: 70 },
    { id: "weekly-room", enabled: true, access_token: "b", status: "active", quota_5h_used_percent: 10, quota_7d_used_percent: 20 }
  ];
  const savedSettings = [];
  const appLogs = [];
  const store = {
    listAccounts: () => accounts,
    saveSettings: (patch) => savedSettings.push(patch),
    addAppLog: (entry) => appLogs.push(entry)
  };

  const picked = selectInitialGatewayAccount(
    store,
    { gateway_current_account_id: "current", gateway_last_daily_rebalance_date: "2026-05-14" },
    new Date("2026-05-15T08:00:00")
  );
  assert.equal(picked.id, "weekly-room");
  assert.deepEqual(savedSettings.at(-1), {
    gateway_current_account_id: "weekly-room",
    gateway_last_daily_rebalance_date: "2026-05-15"
  });
  assert.equal(appLogs.at(-1).action, "daily-rebalance");

  const kept = selectInitialGatewayAccount(
    store,
    { gateway_current_account_id: "current", gateway_last_daily_rebalance_date: "2026-05-15" },
    new Date("2026-05-15T20:00:00")
  );
  assert.equal(kept.id, "current");
  assert.deepEqual(savedSettings.at(-1), { gateway_current_account_id: "current" });
});

test("dailyRebalanceDateKey uses the local calendar day", () => {
  assert.equal(dailyRebalanceDateKey(new Date("2026-05-15T08:00:00")), "2026-05-15");
});

test("buildUpstreamUrl maps local /v1 requests to codex backend prefix", () => {
  assert.equal(
    buildUpstreamUrl("https://chatgpt.com/backend-api/codex", "/v1/responses?stream=true"),
    "https://chatgpt.com/backend-api/codex/responses?stream=true"
  );
  assert.equal(
    buildUpstreamUrl("https://api.openai.com/v1", "/v1/responses"),
    "https://api.openai.com/v1/responses"
  );
  assert.equal(
    buildUpstreamUrl("https://chatgpt.com/backend-api/codex", "/v1/messages/count_tokens"),
    "https://chatgpt.com/backend-api/codex/messages/count_tokens"
  );
});

test("buildUpstreamHeaders sends Codex account auth headers", () => {
  const headers = buildUpstreamHeaders(
    {
      host: "127.0.0.1:8436",
      authorization: "Bearer local",
      "x-codex-turn-state": "state",
      "user-agent": "codex_cli_rs/1.0.0",
      originator: "codex_cli_rs",
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-random-client-header": "keep",
      cookie: "sid=client",
      "proxy-authorization": "Bearer proxy",
      "openai-organization": "org_client",
      "openai-project": "proj_client",
      origin: "http://127.0.0.1:8436",
      referer: "http://127.0.0.1:8436/",
      "accept-encoding": "gzip",
      connection: "keep-alive, x-local-hop",
      "keep-alive": "timeout=5",
      "x-local-hop": "secret",
      te: "trailers",
      trailer: "x-checksum",
      upgrade: "h2c"
    },
    { access_token: "upstream-token", account_id: "acc_123" },
    true,
    "/v1/responses"
  );
  assert.equal(headers.Authorization, "Bearer upstream-token");
  assert.equal(headers["ChatGPT-Account-ID"], "acc_123");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers["user-agent"], "codex_cli_rs/1.0.0");
  assert.equal(headers["x-codex-turn-state"], "state");
  assert.equal(headers.host, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-random-client-header"], "keep");
  assert.equal(headers.cookie, undefined);
  assert.equal(headers["proxy-authorization"], undefined);
  assert.equal(headers["openai-organization"], undefined);
  assert.equal(headers["openai-project"], undefined);
  assert.equal(headers.origin, undefined);
  assert.equal(headers.referer, undefined);
  assert.equal(headers["accept-encoding"], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers["keep-alive"], undefined);
  assert.equal(headers["x-local-hop"], undefined);
  assert.equal(headers.te, undefined);
  assert.equal(headers.trailer, undefined);
  assert.equal(headers.upgrade, undefined);
});

test("buildUpstreamHeaders only replaces local auth and account headers", () => {
  const headers = buildUpstreamHeaders(
    { "user-agent": "OpenAI/JS", accept: "application/json" },
    { access_token: "upstream-token", workspace_id: "ws_123" },
    true,
    "/v1/responses"
  );
  assert.deepEqual(headers, {
    "user-agent": "OpenAI/JS",
    accept: "application/json",
    Authorization: "Bearer upstream-token",
    "ChatGPT-Account-ID": "ws_123"
  });
});

test("buildGatewayRequest keeps compact endpoint path", () => {
  const request = buildGatewayRequest(
    "https://chatgpt.com/backend-api/codex",
    "/v1/responses/compact",
    Buffer.from(JSON.stringify({ input: "compact" }))
  );
  assert.equal(request.path, "/v1/responses/compact");
  assert.equal(request.upstreamUrl, "https://chatgpt.com/backend-api/codex/responses/compact");
});

test("buildCodexQuotaHeaders rewrites quota headers from account pool", () => {
  const headers = buildCodexQuotaHeaders([
    {
      enabled: true,
      status: "active",
      access_token: "a",
      quota_5h_used_percent: 20,
      quota_5h_reset_at: 1_000,
      quota_7d_used_percent: 30,
      quota_7d_reset_at: 5_000
    },
    {
      enabled: true,
      status: "active",
      access_token: "b",
      quota_5h_used_percent: 40,
      quota_5h_reset_at: 900,
      quota_7d_used_percent: 50,
      quota_7d_reset_at: 4_000
    },
    {
      enabled: false,
      status: "active",
      access_token: "c",
      quota_5h_used_percent: 100,
      quota_5h_reset_at: 100,
      quota_7d_used_percent: 100,
      quota_7d_reset_at: 100
    }
  ], 500);
  assert.equal(headers["x-codex-primary-used-percent"], "0");
  assert.equal(headers["x-codex-primary-window-minutes"], "300");
  assert.equal(headers["x-codex-primary-reset-after-seconds"], "400");
  assert.equal(headers["x-codex-secondary-used-percent"], "0");
  assert.equal(headers["x-codex-secondary-window-minutes"], "10080");
  assert.equal(headers["x-codex-secondary-reset-after-seconds"], "3500");
  assert.equal(headers["x-codex-plan-type"], "unknown");
  assert.equal(headers["x-codex-active-limit"], "primary");
  assert.equal(headers["x-codex-credits-balance"], "0");
  assert.equal(headers["x-codex-credits-has-credits"], "false");
  assert.equal(headers["x-codex-credits-unlimited"], "false");
});

test("buildCodexQuotaSnapshot uses the same aggregate as response headers", () => {
  const accounts = [
    { enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 90.24, quota_5h_reset_at: 1_000, quota_7d_used_percent: 95, quota_7d_reset_at: 2_000 },
    { enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 80.4, quota_5h_reset_at: 1_500, quota_7d_used_percent: 70, quota_7d_reset_at: 2_500 }
  ];
  const headers = buildCodexQuotaHeaders(accounts, 500);
  const snapshot = buildCodexQuotaSnapshot(accounts, 500);

  assert.equal(snapshot.primary.used_percent, Number(headers["x-codex-primary-used-percent"]));
  assert.equal(snapshot.primary.used_percent, 70.6);
  assert.equal(snapshot.primary.window_minutes, Number(headers["x-codex-primary-window-minutes"]));
  assert.equal(snapshot.primary.reset_after_seconds, Number(headers["x-codex-primary-reset-after-seconds"]));
  assert.equal(snapshot.primary.reset_at, 1_000);
  assert.equal(snapshot.secondary.used_percent, Number(headers["x-codex-secondary-used-percent"]));
  assert.equal(snapshot.secondary.window_minutes, Number(headers["x-codex-secondary-window-minutes"]));
  assert.equal(snapshot.secondary.reset_after_seconds, Number(headers["x-codex-secondary-reset-after-seconds"]));
  assert.equal(snapshot.secondary.reset_at, 2_000);
});

test("buildCodexQuotaHeaders caps stacked remaining quota before subtraction", () => {
  const accounts = [
    { enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 80, quota_5h_reset_at: 100 },
    { enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 50, quota_5h_reset_at: 200 }
  ];
  const headers = buildCodexQuotaHeaders(accounts, 500);
  const summary = buildAccountPoolQuotaSummary(accounts, 500);
  assert.equal(headers["x-codex-primary-used-percent"], "30");
  assert.equal(summary.capacity_percent, 200);
  assert.equal(summary.primary.remaining_percent, 70);
  assert.equal(headers["x-codex-primary-reset-after-seconds"], "0");
});

test("application quota summary keeps remaining capacity above 100 while response headers cap it", () => {
  const accounts = [
    { enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 10, quota_7d_used_percent: 20 },
    { enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 20, quota_7d_used_percent: 30 }
  ];
  const headers = buildCodexQuotaHeaders(accounts, 500);
  const summary = buildAccountPoolQuotaSummary(accounts, 500);

  assert.equal(summary.capacity_percent, 200);
  assert.equal(summary.primary.remaining_percent, 170);
  assert.equal(summary.secondary.remaining_percent, 150);
  assert.equal(headers["x-codex-primary-used-percent"], "0");
  assert.equal(headers["x-codex-secondary-used-percent"], "0");
});

test("buildCodexQuotaHeaders subtracts stacked remaining quota from 100", () => {
  const headers = buildCodexQuotaHeaders([
    { enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 90 },
    { enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 80 }
  ], 500);
  assert.equal(headers["x-codex-primary-used-percent"], "70");
});

test("syncAccountUsageFromHeaders stores quota snapshots for the active account", () => {
  let updated = null;
  syncAccountUsageFromHeaders(
    { id: "active" },
    new Headers({
      "x-codex-primary-used-percent": "67.5",
      "x-codex-primary-reset-after-seconds": "120",
      "x-codex-secondary-used-percent": "12",
      "x-codex-secondary-reset-after-seconds": "240"
    }),
    {
      updateUsage(id, usage) {
        updated = { id, usage };
      }
    }
  );
  assert.equal(updated.id, "active");
  assert.equal(updated.usage.quota_5h_used_percent, 67.5);
  assert.equal(updated.usage.quota_7d_used_percent, 12);
  assert.ok(updated.usage.quota_5h_reset_at > Math.floor(Date.now() / 1000));
  assert.ok(updated.usage.quota_7d_reset_at > updated.usage.quota_5h_reset_at);
});

test("syncAccountUsageFromHeaders ignores ambiguous zero quota headers", () => {
  let updated = null;
  syncAccountUsageFromHeaders(
    {
      id: "active",
      quota_5h_used_percent: 42,
      quota_5h_reset_at: Math.floor(Date.now() / 1000) + 1000,
      quota_7d_used_percent: 85,
      quota_7d_reset_at: Math.floor(Date.now() / 1000) + 1000
    },
    new Headers({
      "x-codex-primary-used-percent": "0",
      "x-codex-primary-reset-after-seconds": "0",
      "x-codex-secondary-used-percent": "0",
      "x-codex-secondary-reset-after-seconds": "0"
    }),
    {
      updateUsage(id, usage) {
        updated = { id, usage };
      }
    }
  );
  assert.equal(updated, null);
});

test("syncAccountUsageFromHeaders accepts zero quota headers with a reset window", () => {
  let updated = null;
  syncAccountUsageFromHeaders(
    { id: "active", quota_5h_used_percent: 42 },
    new Headers({
      "x-codex-primary-used-percent": "0",
      "x-codex-primary-reset-after-seconds": "18000"
    }),
    {
      updateUsage(id, usage) {
        updated = { id, usage };
      }
    }
  );
  assert.equal(updated.usage.quota_5h_used_percent, 0);
  assert.ok(updated.usage.quota_5h_reset_at > Math.floor(Date.now() / 1000));
});

test("callWithFailover stores quota headers and switches current account after exhaustion", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = [
    { id: "first", enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 50, quota_7d_used_percent: 20 },
    { id: "second", enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 10, quota_7d_used_percent: 20 }
  ];
  const savedSettings = [];
  const selectedAccounts = [];
  let refreshAllCalled = false;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    const call = fetchCount;
    fetchCount += 1;
    if (call === 0) {
      return new Response("quota exceeded", {
        status: 429,
        headers: {
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-after-seconds": "1800"
        }
      });
    }
    return new Response("{}", { status: 200 });
  };
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      {},
      {
        listAccounts: () => accounts,
        saveSettings: (patch) => savedSettings.push(patch),
        addAppLog: () => {},
        updateUsage(id, usage) {
          const account = accounts.find((item) => item.id === id);
          Object.assign(account, usage);
        }
      },
      {
        refreshAllUsage: async () => {
          refreshAllCalled = true;
        }
      },
      { onAccountSelected: (account) => selectedAccounts.push(account.id) }
    );
    assert.equal(result.account.id, "second");
    assert.equal(accounts[0].quota_5h_used_percent, 100);
    assert.equal(savedSettings.at(-1).gateway_current_account_id, "second");
    assert.equal(refreshAllCalled, false);
    assert.deepEqual(selectedAccounts, ["first", "second"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callWithFailover keeps authoritative quota values when quota headers are missing", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = [
    { id: "first", enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 50 },
    { id: "second", enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 10 }
  ];
  const savedSettings = [];
  globalThis.fetch = async () => new Response("quota exceeded", { status: 429 });
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      {},
      {
        listAccounts: () => accounts,
        saveSettings: (patch) => savedSettings.push(patch),
        addAppLog: () => {},
        updateUsage(id, usage) {
          const account = accounts.find((item) => item.id === id);
          Object.assign(account, usage);
        }
      },
      {}
    );
    assert.equal(result.account.id, "second");
    assert.equal(accounts[0].quota_5h_used_percent, 50);
    assert.equal(accounts[1].quota_5h_used_percent, 10);
    assert.equal(savedSettings.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callWithFailover cools a no-header quota account and schedules usage refresh", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = [
    { id: "first", enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 50 },
    { id: "second", enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 10 }
  ];
  const routing = createGatewayRouting();
  let fetchCount = 0;
  let refreshReason = "";
  globalThis.fetch = async () => {
    fetchCount += 1;
    return fetchCount === 1
      ? new Response("quota exceeded", { status: 429 })
      : new Response("{}", { status: 200 });
  };
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      { gateway_quota_cooldown_ms: 60_000 },
      {
        listAccounts: () => accounts,
        saveSettings: () => {},
        addAppLog: () => {},
        updateUsage: () => {}
      },
      {
        async refreshAllUsage(reason) {
          refreshReason = reason;
          return [{ id: "first", ok: false }];
        }
      },
      { routing }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.account.id, "second");
    assert.equal(refreshReason, "gateway-quota-without-headers");
    assert.ok(routing.cooldowns.get("first") > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quotaWindowExhausted makes a reset quota window usable again", () => {
  assert.equal(quotaWindowExhausted({ quota_5h_used_percent: 100, quota_5h_reset_at: 900 }, 1_000), false);
  assert.equal(quotaWindowExhausted({ quota_5h_used_percent: 100, quota_5h_reset_at: 1_100 }, 1_000), true);
});

test("gateway routing keeps new turns on their active session account while turn affinity remains strict", () => {
  let now = 1_000;
  const routing = createGatewayRouting({ now: () => now });
  const accounts = [
    { id: "a", enabled: true, status: "active", access_token: "token-a", quota_7d_used_percent: 80 },
    { id: "b", enabled: true, status: "active", access_token: "token-b", quota_7d_used_percent: 20 }
  ];
  const first = routing.context({ session_id: "session-1", "x-codex-turn-metadata": '{"turn_id":"turn-1"}' });
  assert.equal(first.established, false);
  routing.observeResponse(first, accounts[0], new Headers({ "x-codex-turn-state": "state-a" }));

  now += 1;
  const sameTurn = routing.context({ session_id: "session-1", "x-codex-turn-state": "state-a" });
  assert.equal(sameTurn.established, true);
  assert.equal(routing.findBoundAccount(sameTurn, accounts).id, "a");

  const nextTurn = routing.context({ session_id: "session-1", "x-codex-turn-metadata": '{"turn_id":"turn-2"}' });
  assert.equal(nextTurn.established, false);
  assert.equal(nextTurn.sessionPreferred, true);
  assert.equal(routing.findPreferredAccount(nextTurn, accounts).id, "a");
});

test("buildSubscriptionRoutingHint uses the model and optional service tier", () => {
  assert.equal(buildSubscriptionRoutingHint({ model: "gpt-5.6-sol" }), "model=gpt-5.6-sol");
  assert.equal(
    buildSubscriptionRoutingHint({ model: "gpt-5.6-sol", service_tier: "priority" }),
    "model=gpt-5.6-sol;tier=priority"
  );
  assert.equal(buildSubscriptionRoutingHint({ service_tier: "priority" }), "");
  assert.equal(buildSubscriptionRoutingHint({ model: "gpt-test\ninvalid" }), "");
  assert.equal(buildSubscriptionRoutingHint({ model: "gpt-测试" }), "");
  assert.equal(buildSubscriptionRoutingHint({ model: "gpt-test", service_tier: "bad\rvalue" }), "");

  const headers = { "X-Codex-Routing-Hint": "stale-client-hint" };
  assert.equal(setSubscriptionRoutingHint(headers, { model: "bad\nmodel" }), "");
  assert.equal(Object.keys(headers).length, 0);
});

test("gateway routing uses a sliding session affinity TTL based on successful use", () => {
  let now = 1_000;
  const routing = createGatewayRouting({ now: () => now, sessionAffinityTtlMs: 100 });
  const accounts = [
    { id: "a", enabled: true, status: "active", access_token: "token-a", quota_7d_used_percent: 80 },
    { id: "b", enabled: true, status: "active", access_token: "token-b", quota_7d_used_percent: 20 }
  ];
  const first = routing.context({ session_id: "session-1" });
  routing.observeResponse(first, accounts[0], new Headers());

  now = 1_099;
  const next = routing.context({ session_id: "session-1" });
  assert.equal(routing.findPreferredAccount(next, accounts).id, "a");
  routing.observeResponse(next, accounts[0], new Headers());

  now = 1_198;
  assert.equal(routing.findPreferredAccount(routing.context({ session_id: "session-1" }), accounts).id, "a");
  now = 1_200;
  const expired = routing.context({ session_id: "session-1" });
  assert.equal(routing.findPreferredAccount(expired, accounts), null);
  assert.equal(routing.selectNewAccount(accounts).id, "b");
});

test("gateway routing restores unexpired session affinity and expires stale snapshots", () => {
  let now = 10_000;
  const routing = createGatewayRouting({
    now: () => now,
    sessionAffinityTtlMs: 2_000,
    snapshot: {
      sessions: [{
        key: "session-1",
        targetId: "builtin-chatgpt-subscription-pool",
        accountId: "a",
        credentialRef: "",
        clientModel: "",
        upstreamModel: "",
        lastSeenAt: 9_000
      }]
    }
  });
  const accounts = [
    { id: "a", enabled: true, status: "active", access_token: "token-a", quota_7d_used_percent: 80 },
    { id: "b", enabled: true, status: "active", access_token: "token-b", quota_7d_used_percent: 20 }
  ];

  const route = routing.context({ session_id: "session-1" });
  assert.equal(route.established, false);
  assert.equal(routing.findPreferredAccount(route, accounts).id, "a");
  now = 11_001;
  const expired = routing.context({ session_id: "session-1" });
  assert.equal(routing.findPreferredAccount(expired, accounts), null);
  assert.equal(routing.selectNewAccount(accounts).id, "b");
  assert.deepEqual(routing.snapshot().sessions, []);
});

test("gateway routing switches an unavailable session account and persists the replacement", () => {
  const routing = createGatewayRouting({ now: () => 10_000 });
  const accounts = [
    { id: "a", enabled: true, status: "active", access_token: "token-a", quota_7d_used_percent: 80 },
    { id: "b", enabled: true, status: "active", access_token: "token-b", quota_7d_used_percent: 20 }
  ];
  const first = routing.context({ session_id: "session-1" });
  routing.observeResponse(first, accounts[0], new Headers());
  accounts[0].enabled = false;

  const next = routing.context({ session_id: "session-1" });
  assert.equal(routing.findPreferredAccount(next, accounts), null);
  assert.equal(routing.selectNewAccount(accounts).id, "b");
  routing.observeResponse(next, accounts[1], new Headers());
  assert.equal(routing.findPreferredAccount(routing.context({ session_id: "session-1" }), accounts).id, "b");
});

test("gateway routing reserves one account for concurrent first requests in a session", () => {
  const routing = createGatewayRouting({ now: () => 10_000 });
  const accounts = [
    { id: "a", enabled: true, status: "active", access_token: "token-a", quota_7d_used_percent: 20 },
    { id: "b", enabled: true, status: "active", access_token: "token-b", quota_7d_used_percent: 20 }
  ];
  const first = routing.context({ session_id: "session-1" });
  const selected = routing.selectNewAccount(accounts);
  routing.reserveSession(first, selected);

  const concurrent = routing.context({ session_id: "session-1" });
  assert.equal(routing.findPreferredAccount(concurrent, accounts).id, "a");
  routing.releaseSessionReservation(first, "a");
  assert.equal(routing.findPreferredAccount(routing.context({ session_id: "session-1" }), accounts), null);
});

test("gateway routing prioritizes seven-day quota before active request count", () => {
  const routing = createGatewayRouting({ now: () => 10_000 });
  const accounts = [
    { id: "a", enabled: true, status: "active", access_token: "token-a", quota_7d_used_percent: 80 },
    { id: "b", enabled: true, status: "active", access_token: "token-b", quota_7d_used_percent: 20 }
  ];
  const releases = Array.from({ length: 5 }, () => routing.beginRequest("b"));
  assert.equal(routing.selectNewAccount(accounts).id, "b");
  for (const release of releases) release();
});

test("routing header parsers read Codex session and turn identifiers", () => {
  assert.equal(sessionIdFromHeaders({ session_id: "session-1" }), "session-1");
  assert.equal(sessionIdFromHeaders({ "x-session-id": "realtime-session" }), "realtime-session");
  assert.equal(turnIdFromHeaders({ "x-codex-turn-metadata": '{"turn_id":"turn-1"}' }), "turn-1");
  assert.equal(turnIdFromHeaders({ "x-codex-turn-metadata": "invalid" }), "");
});

test("gateway routing snapshot preserves session and turn affinity across restart", () => {
  let savedSnapshot = null;
  const first = createGatewayRouting({
    now: () => 10_000,
    onChanged(snapshot) {
      savedSnapshot = snapshot;
    }
  });
  const route = first.context({
    session_id: "session-1",
    "x-codex-turn-metadata": '{"turn_id":"turn-1"}'
  });
  first.observeResponse(route, { id: "a" }, new Headers({ "x-codex-turn-state": "state-a" }));

  const restored = createGatewayRouting({ now: () => 10_001, snapshot: savedSnapshot });
  const restoredTurn = restored.context({ session_id: "session-1", "x-codex-turn-state": "state-a" });
  assert.equal(restoredTurn.established, true);
  assert.equal(restoredTurn.accountId, "a");
  const restoredSession = restored.context({ session_id: "session-1", "x-codex-turn-metadata": '{"turn_id":"turn-2"}' });
  assert.equal(restoredSession.sessionPreferred, true);
  assert.equal(restoredSession.accountId, "a");
  assert.equal(savedSnapshot.sessions.length, 1);

  const unknown = createGatewayRouting({ now: () => 10_001 }).context({ "x-codex-turn-state": "unknown-state" });
  assert.equal(unknown.unknownTurnState, true);
});

test("gateway routing bounds turn affinity maps while retaining recently used bindings", () => {
  let now = 10_000;
  const routing = createGatewayRouting({ now: () => now });
  for (let index = 0; index < 500; index += 1) {
    const route = routing.context({ "x-codex-turn-metadata": JSON.stringify({ turn_id: `turn-${index}` }) });
    routing.observeResponse(route, { id: "a" }, new Headers());
    now += 1;
  }
  const refreshed = routing.context({ "x-codex-turn-metadata": '{"turn_id":"turn-0"}' });
  routing.observeResponse(refreshed, { id: "a" }, new Headers());
  now += 1;
  const newest = routing.context({ "x-codex-turn-metadata": '{"turn_id":"turn-500"}' });
  routing.observeResponse(newest, { id: "b" }, new Headers());

  const turns = routing.snapshot().turns;
  assert.equal(turns.length, 500);
  assert.equal(turns.some((item) => item.key === "turn-0"), true);
  assert.equal(turns.some((item) => item.key === "turn-1"), false);
  assert.equal(turns.some((item) => item.key === "turn-500"), true);
});

test("callWithFailover returns the last attempted account when all accounts fail", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = [
    { id: "first", enabled: true, status: "active", access_token: "a", quota_5h_used_percent: 50 },
    { id: "second", enabled: true, status: "active", access_token: "b", quota_5h_used_percent: 10 }
  ];
  globalThis.fetch = async () => new Response("quota exceeded", { status: 429 });
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      {},
      {
        listAccounts: () => accounts,
        saveSettings: () => {},
        addAppLog: () => {},
        updateUsage: () => {}
      },
      {}
    );
    assert.equal(result.account.id, "second");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callWithFailover can reach accounts beyond the first eight candidates", async () => {
  const originalFetch = globalThis.fetch;
  const accounts = Array.from({ length: 9 }, (_, index) => ({
    id: `account-${index + 1}`,
    enabled: true,
    status: "active",
    access_token: `token-${index + 1}`,
    quota_5h_used_percent: 10
  }));
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount < 9) return new Response("quota exceeded", { status: 429 });
    return new Response("{}", { status: 200 });
  };
  try {
    const result = await callWithFailover(
      { method: "POST", headers: {} },
      { upstreamUrl: "https://example.test/responses", path: "/v1/responses", body: Buffer.from("{}") },
      accounts[0],
      {},
      {
        listAccounts: () => accounts,
        saveSettings: () => {},
        addAppLog: () => {},
        updateUsage(id, usage) {
          const account = accounts.find((item) => item.id === id);
          Object.assign(account, usage);
        }
      },
      {}
    );
    assert.equal(result.account.id, "account-9");
    assert.equal(fetchCount, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matchGatewayRoute validates both path and method", () => {
  assert.deepEqual(matchGatewayRoute("GET", "/v1/models"), {
    pathAllowed: true,
    methodAllowed: true,
    allowedMethods: ["GET"]
  });
  assert.deepEqual(matchGatewayRoute("GET", "/v1/responses"), {
    pathAllowed: true,
    methodAllowed: false,
    allowedMethods: ["POST"]
  });
  assert.deepEqual(matchGatewayRoute("POST", "/v1/unknown"), {
    pathAllowed: false,
    methodAllowed: false,
    allowedMethods: []
  });
  for (const path of [
    "/v1/memories/trace_summarize",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/realtime/calls"
  ]) {
    assert.equal(matchGatewayRoute("POST", path).methodAllowed, true);
  }
});

test("extractTokenUsage uses latest SSE usage instead of summing cumulative events", () => {
  const usage = extractTokenUsage(Buffer.from([
    "data: {\"type\":\"response.in_progress\",\"response\":{\"usage\":{\"input_tokens\":1000,\"cached_input_tokens\":800,\"output_tokens\":10,\"total_tokens\":1010}}}\n\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1200,\"cached_input_tokens\":900,\"output_tokens\":20,\"total_tokens\":1220}}}\n\n",
    "data: [DONE]\n\n"
  ].join(""), "utf8"));
  assert.equal(usage.input_tokens, 1200);
  assert.equal(usage.cached_input_tokens, 900);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.total_tokens, 1220);
});

test("isQuotaExhaustedResponse detects quota and rate limit failures", () => {
  assert.equal(isQuotaExhaustedResponse(429, Buffer.from('{"error":"rate_limit_exceeded"}')), true);
  assert.equal(isQuotaExhaustedResponse(403, Buffer.from('{"detail":"quota exceeded"}')), true);
  assert.equal(isQuotaExhaustedResponse(500, Buffer.from("rate_limit_exceeded")), false);
});

test("isAuthExpiredResponse detects expired token failures", () => {
  assert.equal(isAuthExpiredResponse(401, Buffer.from('{"error":"invalid_token"}')), true);
  assert.equal(isAuthExpiredResponse(403, Buffer.from('{"error":"token expired"}')), true);
  assert.equal(isAuthExpiredResponse(403, Buffer.from('{"detail":"quota exceeded"}')), false);
});

test("insertProviderBlockIntoConfig keeps all root keys before the first table", () => {
  const current = [
    'model = "gpt-5.4"',
    "",
    'approval_policy = "on-request"',
    "",
    "[notice.model_migrations]",
    '"gpt-5.3-codex" = "gpt-5.4"',
    "",
    "[profiles.default]",
    'approval_policy = "on-request"',
    ""
  ].join("\n");
  const block = [
    'model_provider = "codex_gateway"',
    "",
    "[model_providers.codex_gateway]",
    'base_url = "http://localhost:8436/v1"',
    ""
  ].join("\n");
  const next = insertProviderBlockIntoConfig(current, block);
  assert.match(next, /^model = "gpt-5\.4"\n\napproval_policy = "on-request"\n\nmodel_provider = "codex_gateway"/);
  assert.match(next, /base_url = "http:\/\/localhost:8436\/v1"\n\n\[notice\.model_migrations\]/);
  assert.ok(next.indexOf('approval_policy = "on-request"') < next.indexOf('model_provider = "codex_gateway"'));
  assert.ok(next.indexOf('model_provider = "codex_gateway"') < next.indexOf("[notice.model_migrations]"));
});

test("gatewayProviderBlock uses openai_base_url override by default", () => {
  const block = gatewayProviderBlock({ gateway_host: "localhost", gateway_port: "8436" }, { modelCatalogPath: "C:/data/models.json" });
  assert.doesNotMatch(block, /^model_provider\s*=/m);
  assert.match(block, /openai_base_url = "http:\/\/localhost:8436\/v1"/);
  assert.doesNotMatch(block, /\[model_providers\./);
  assert.match(block, /model_catalog_json = "C:\/data\/models\.json"/);
});

test("gatewayProviderBlock keeps custom provider when simplified config is disabled", () => {
  const block = gatewayProviderBlock(
    { gateway_host: "localhost", gateway_port: "8436", codex_config_use_openai_base_url: "false" },
    { modelCatalogPath: "C:/data/models.json" }
  );
  assert.match(block, /^model_provider = "codexia"/m);
  assert.match(block, /name = "OpenAI"/);
  assert.match(block, /wire_api = "responses"/);
  assert.match(block, /supports_websockets = true/);
  assert.doesNotMatch(block, /openai_base_url/);
});

test("gateway config replaces any previous catalog with the generated total catalog", () => {
  const managed = nextGatewayConfig([
    'model_catalog_json = "C:/Users/test/.codex/codex-gateway-models.json"',
    ""
  ].join("\n"), { gateway_host: "localhost", gateway_port: "8436" }, { modelCatalogPath: "C:/data/models.json" });
  assert.match(managed, /model_catalog_json = "C:\/data\/models\.json"/);

  const custom = nextGatewayConfig([
    'model_catalog_json = "C:/Users/test/.codex/custom-models.json"',
    ""
  ].join("\n"), { gateway_host: "localhost", gateway_port: "8436" }, { modelCatalogPath: "C:/data/models.json" });
  assert.doesNotMatch(custom, /custom-models/);
  assert.match(custom, /model_catalog_json = "C:\/data\/models\.json"/);
});

test("incremental SSE usage parser handles split and oversized completed events", () => {
  const parser = createSseUsageParser();
  parser.feed(Buffer.from(`data: {"type":"response.completed","output":"${"x".repeat(1_100_000)}`));
  parser.feed(Buffer.from('","response":{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}\n\n'));
  assert.deepEqual(parser.latestUsage(), {
    input_tokens: 12,
    cached_input_tokens: 0,
    output_tokens: 3,
    reasoning_output_tokens: 0,
    total_tokens: 15
  });
});

test("gatewayProviderBlock writes localhost base URL for wildcard listener", () => {
  const block = gatewayProviderBlock({ gateway_host: "0.0.0.0", gateway_port: "8436" });
  assert.match(block, /openai_base_url = "http:\/\/localhost:8436\/v1"/);
  assert.doesNotMatch(block, /openai_base_url = "http:\/\/0\.0\.0\.0:8436\/v1"/);
  const custom = gatewayProviderBlock({ gateway_host: "0.0.0.0", gateway_port: "8436", codex_config_use_openai_base_url: "false" });
  assert.match(custom, /base_url = "http:\/\/localhost:8436\/v1"/);
  assert.doesNotMatch(custom, /base_url = "http:\/\/0\.0\.0\.0:8436\/v1"/);
});

test("mcp gateway command omits optional HTTP arguments by default", () => {
  assert.equal(mcpGatewayUrl({}), "");
  assert.equal(buildMcpGatewayCommand({}), "mcp-gateway-service --http");
});

test("mcp gateway path is normalized with leading slash", () => {
  assert.equal(mcpGatewayPath({ mcp_gateway_path: "mcp" }), "/mcp");
  assert.equal(
    mcpGatewayUrl({ mcp_gateway_host: "0.0.0.0", mcp_gateway_port: "3100", mcp_gateway_path: "mcp" }),
    "http://0.0.0.0:3100/mcp"
  );
});

test("mcp gateway command includes only filled optional arguments", () => {
  assert.equal(
    buildMcpGatewayCommand({
      mcp_gateway_config_path: "./config.json",
      mcp_gateway_port: "3100",
      mcp_gateway_json_response: "true"
    }),
    "mcp-gateway-service --http --config ./config.json --port 3100"
  );
});

test("replaceGatewayProviderBlock repairs existing provider name", () => {
  const current = [
    'model = "gpt-5.4"',
    "",
    'model_provider = "codex_gateway"',
    "",
    "[model_providers.codex_gateway]",
    'name = "Codex Gateway"',
    'base_url = "http://localhost:8436/v1"',
    'wire_api = "responses"',
    "",
    "[notice.model_migrations]",
    '"gpt-5.3-codex" = "gpt-5.4"',
    ""
  ].join("\n");
  const next = replaceGatewayProviderBlock(current, gatewayProviderBlock({
    gateway_host: "localhost",
    gateway_port: "8436",
    codex_config_use_openai_base_url: "false"
  }));
  assert.equal((next.match(/\[model_providers\.codexia\]/g) || []).length, 1);
  assert.doesNotMatch(next, /\[model_providers\.codex_gateway\]/);
  assert.match(next, /name = "OpenAI"/);
  assert.doesNotMatch(next, /name = "Codex Gateway"/);
  assert.ok(next.indexOf('model_provider = "codexia"') < next.indexOf("[notice.model_migrations]"));
});

test("default openai_base_url config replaces a legacy codex_gateway provider block", () => {
  const current = [
    'model = "gpt-5.4"',
    "",
    'model_provider = "codex_gateway"',
    "",
    "[model_providers.codex_gateway]",
    'name = "Codex Gateway"',
    'base_url = "http://localhost:8436/v1"',
    'wire_api = "responses"',
    "",
    "[notice.model_migrations]",
    '"gpt-5.3-codex" = "gpt-5.4"',
    ""
  ].join("\n");
  const next = replaceGatewayProviderBlock(current, gatewayProviderBlock({ gateway_host: "localhost", gateway_port: "8436" }));
  assert.doesNotMatch(next, /codex_gateway/);
  assert.match(next, /openai_base_url = "http:\/\/localhost:8436\/v1"/);
  assert.ok(next.indexOf('openai_base_url = "http://localhost:8436/v1"') < next.indexOf("[notice.model_migrations]"));
});
