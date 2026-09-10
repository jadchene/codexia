import assert from "node:assert/strict";
import { test } from "vitest";
import { createAuthService, subscriptionFromTokens } from "../src/main/auth.ts";

const subscriptionToken = (claims: Record<string, unknown>): string => `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": claims
})).toString("base64url")}.signature`;

test("subscription refresh reads fresh claims and falls back to the fresh access token", () => {
  assert.deepEqual(subscriptionFromTokens({
    id_token: subscriptionToken({ chatgpt_plan_type: "pro" }),
    access_token: subscriptionToken({ chatgpt_plan_type: "plus", chatgpt_subscription_active_until: "2026-10-01T00:00:00Z" })
  }), { subscription_plan: "pro", subscription_expires_at: Date.parse("2026-10-01T00:00:00Z") / 1000 });
});

test("subscription refresh clears unavailable expiry including a downgrade to free", () => {
  assert.deepEqual(subscriptionFromTokens({ access_token: subscriptionToken({ chatgpt_plan_type: "free" }) }), {
    subscription_plan: "free", subscription_expires_at: null
  });
  assert.deepEqual(subscriptionFromTokens({ id_token: "invalid" }), {
    subscription_plan: "", subscription_expires_at: null
  });
});

test("cancelled browser login cannot complete its callback", async () => {
  const sessions = new Map<string, Record<string, unknown>>([
    ["login-1", {
      id: "login-1",
      redirect_uri: "http://localhost:1455/auth/callback",
      code_verifier: "verifier",
      status: "pending",
      error: null
    }]
  ]);
  const service = createAuthService({
    saveLoginSession: (session) => sessions.set(String(session.id), { ...session }),
    getLoginSession: (id) => sessions.get(id) as never,
    updateLoginSession: (id, status, error) => sessions.set(id, { ...sessions.get(id), status, error }),
    saveAccount: (account) => account as never,
    listAccounts: () => [],
    addAppLog: () => undefined
  }, async () => undefined);

  assert.deepEqual(service.cancelLogin("login-1"), { cancelled: true });
  assert.equal(service.loginStatus("login-1").status, "cancelled");
  assert.deepEqual(service.cancelLogin("login-1"), { cancelled: false });
  await assert.rejects(
    service.completeCallback(new URLSearchParams({ state: "login-1", code: "unused" })),
    /登录授权已取消/
  );
});
