import assert from "node:assert/strict";
import { test } from "vitest";
import { createSubscriptionModelFetcher, orderModelAccounts, type ModelAccount } from "../src/main/subscription-models.ts";

/** 构造不包含真实凭证的目录账号。 */
function account(plan: string, extra: Partial<ModelAccount> = {}): ModelAccount {
  return { id: plan, enabled: true, subscription_plan: plan, access_token: `${plan}-token`, account_id: `${plan}-id`, ...extra };
}

test("catalog account order uses subscription tier before account priority and excludes disabled accounts", () => {
  const ordered = orderModelAccounts([
    account("free"), account("unknown"), account("go"), account("plus", { priority: 1 }),
    account("pro", { priority: 200 }), account("prolite"),
    account("pro", { id: "disabled", enabled: false }), account("pro", { id: "status-disabled", status: "disabled" }),
    account("pro", { id: "no-token", access_token: "" })
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ["pro", "prolite", "plus", "go", "free", "unknown"]);
});

test("fetches full official catalog using the highest tier pool account and the real client version", async () => {
  const metadata = { slug: "remote-new", context_window: 400000, model_messages: { instructions_template: "template" } };
  const calls: string[] = [];
  const fetchModels = createSubscriptionModelFetcher({
    listAccounts: () => [account("plus"), account("prolite")],
    refreshAccount: async () => { throw new Error("unexpected refresh"); },
    getClientVersion: async () => "0.136.0",
    fetch: async (url, init) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/models?client_version=0.136.0");
      const headers = new Headers(init?.headers);
      calls.push(headers.get("authorization")!);
      assert.equal(headers.get("chatgpt-account-id"), "prolite-id");
      assert.equal(headers.get("user-agent"), "codex_cli_rs/0.136.0");
      assert.equal(init?.redirect, "error");
      return Response.json({ models: [metadata] });
    }
  });
  assert.deepEqual(JSON.parse(await fetchModels()).models, [metadata]);
  assert.deepEqual(calls, ["Bearer prolite-token"]);
});

test("401 refreshes the same account once before trying a lower subscription tier", async () => {
  const calls: string[] = [];
  const refreshed: string[] = [];
  const fetchModels = createSubscriptionModelFetcher({
    listAccounts: () => [account("plus"), account("pro")],
    refreshAccount: async (id) => { refreshed.push(id); return account("pro", { access_token: "renewed" }); },
    getClientVersion: async () => "0.136.0",
    fetch: async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")!;
      calls.push(token);
      return token === "Bearer plus-token" ? Response.json({ models: [{ slug: "available" }] }) : new Response(null, { status: 401 });
    }
  });
  assert.equal(JSON.parse(await fetchModels()).models[0].slug, "available");
  assert.deepEqual(refreshed, ["pro"]);
  assert.deepEqual(calls, ["Bearer pro-token", "Bearer renewed", "Bearer plus-token"]);
});

test("invalid, empty and duplicate catalogs fail over without leaking response contents", async () => {
  for (const response of ["<html>secret-response</html>", '{"models":[]}', '{"models":[{"slug":"x"},{"slug":"x"}]}']) {
    let calls = 0;
    const fetchModels = createSubscriptionModelFetcher({
      listAccounts: () => [account("pro"), account("free")],
      refreshAccount: async () => { throw new Error("unexpected refresh"); },
      getClientVersion: async () => "0.136.0",
      fetch: async () => { calls += 1; return new Response(response); }
    });
    await assert.rejects(fetchModels(), /GPT 账号池远程模型获取失败/);
    assert.equal(calls, 2);
  }
});

test("an empty account pool never sends a network request", async () => {
  const fetchModels = createSubscriptionModelFetcher({
    listAccounts: () => [],
    refreshAccount: async () => { throw new Error("unexpected refresh"); },
    getClientVersion: async () => { throw new Error("unexpected CLI call"); },
    fetch: async () => { throw new Error("unexpected fetch"); }
  });
  await assert.rejects(fetchModels(), /没有可用于/);
});
