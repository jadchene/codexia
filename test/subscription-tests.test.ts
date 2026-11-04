import assert from "node:assert/strict";
import { test } from "vitest";
import { createSubscriptionTests } from "../src/main/upstreams/subscription-tests.ts";

const account = { id: "pool-account", enabled: true, status: "active", access_token: "pool-token", account_id: "workspace" };

test("pool checks use subscription credentials and refresh unauthorized tokens", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const tests = createSubscriptionTests({
    listAccounts: () => [account], ignoreFiveHourLimit: () => false, getClientVersion: async () => "0.166.0",
    refreshAccount: async (id) => { assert.equal(id, account.id); return { ...account, access_token: "refreshed" }; },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response("{}", { status: calls.length === 1 ? 401 : 200 });
    }
  });
  const result = await tests.connection();
  assert.equal(result.status, "healthy");
  assert.ok(result.latencyMs >= 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/models?client_version=0.166.0");
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, "Bearer refreshed");
  assert.equal((calls[1].init.headers as Record<string, string>)["ChatGPT-Account-Id"], "workspace");
});

test("pool invocation reads chunked SSE completion and reports output and usage", async () => {
  const tests = createSubscriptionTests({
    listAccounts: () => [{ ...account, id: "disabled", enabled: false }, account], ignoreFiveHourLimit: () => false,
    getClientVersion: async () => "0.166.0", refreshAccount: async () => account,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "pool-model");
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, undefined);
      const event = `data: ${JSON.stringify({ type: "response.completed", response: { id: "test-response",
        output: [{ content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }
      } })}\n\n`;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(event.slice(0, 20)));
        controller.enqueue(new TextEncoder().encode(event.slice(20)));
        controller.close();
      } }));
    }
  });
  const result = await tests.invocation("pool-model");
  assert.equal(result.ok, true);
  assert.equal(result.outputPreview, "OK");
  assert.equal(result.responseId, "test-response");
  assert.equal(result.totalTokens, 9);
});

test("pool checks reject unavailable accounts and incomplete or failed streams", async () => {
  const options = { listAccounts: () => [account], ignoreFiveHourLimit: () => false,
    getClientVersion: async () => "0.166.0", refreshAccount: async () => account };
  const unavailable = createSubscriptionTests({ ...options, listAccounts: () => [{ ...account, enabled: false }],
    fetch: async () => { throw new Error("must not connect"); } });
  assert.equal((await unavailable.connection()).status, "unhealthy");
  await assert.rejects(unavailable.invocation("pool-model"), /没有可用账号/);
  for (const body of ['data: {"type":"response.created"}\n\n', 'data: {"type":"response.failed"}\n\n']) {
    const tests = createSubscriptionTests({ ...options, fetch: async () => new Response(body) });
    assert.equal((await tests.invocation("pool-model")).ok, false);
  }
});
