import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createStore } from "../src/main/store.ts";
import { createUpstreamService } from "../src/main/upstreams/upstream-service.ts";

const codec = {
  encrypt: (value: string) => `enc:${Buffer.from(value).toString("base64")}`,
  decrypt: (value: string) => Buffer.from(value.replace(/^enc:/, ""), "base64").toString(),
  isEncrypted: (value: string) => value.startsWith("enc:")
};

test("each model owns independent three-rate pricing and exact channel routing", () => {
  const fixture = createFixture();
  try {
    const service = createUpstreamService({ db: fixture.store.db, secretCodec: codec });
    const saved = service.save({
      name: "Example API", baseUrl: "https://api.example.test/v1", apiKey: "secret",
      enabled: true, supportsWebSocket: false, balanceQueryType: "none",
      modelCatalogJson: JSON.stringify({ models: [
        { slug: "model-a", display_name: "Model A", supports_parallel_tool_calls: true },
        { slug: "model-b", display_name: "Model B", supports_parallel_tool_calls: false }
      ] }),
      modelPricing: {
        "model-a": { inputPerMillion: 1.11119, cachedInputPerMillion: 0.22229, outputPerMillion: 3.33339 },
        "model-b": { inputPerMillion: 4.44, cachedInputPerMillion: 0.55, outputPerMillion: 6.66 }
      }
    });
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.compactAdaptEnabled, true);
    assert.equal(service.findRuntimeByModel("model-a")?.compactAdaptEnabled, true);
    assert.equal("apiKey" in saved, false);
    assert.equal(JSON.stringify(saved).includes(Buffer.from("secret").toString("base64")), false);
    assert.equal(service.listModels(saved.id)[0]?.metadata.prefer_websockets, false);
    assert.equal(service.findRuntimeByModel("model-a")?.id, saved.id);
    assert.equal(service.findRuntimeByModel("unknown"), null);
    assert.deepEqual(service.getModelPricing(saved.id, "model-a"), {
      inputPerMillion: 1.1112, cachedInputPerMillion: 0.2223, outputPerMillion: 3.3334
    });
    assert.deepEqual(service.getModelPricing(saved.id, "model-b"), {
      inputPerMillion: 4.44, cachedInputPerMillion: 0.55, outputPerMillion: 6.66
    });
    const updated = service.save({
      ...input("Example API Updated", "model-a"),
      id: saved.id,
      compactAdaptEnabled: false,
      modelCatalogJson: JSON.stringify({ models: [
        { slug: "model-a", display_name: "Model A Updated", supports_parallel_tool_calls: true },
        { slug: "model-b", display_name: "Model B", supports_parallel_tool_calls: false }
      ] }),
      modelPricing: {
        "model-a": { inputPerMillion: 1.11, cachedInputPerMillion: 0.22, outputPerMillion: 3.33 },
        "model-b": { inputPerMillion: 4.44, cachedInputPerMillion: 0.55, outputPerMillion: 6.66 }
      }
    });
    assert.equal(updated.id, saved.id);
    assert.equal(updated.name, "Example API Updated");
    assert.equal(updated.compactAdaptEnabled, false);
    assert.equal(service.findRuntimeByModel("model-a")?.compactAdaptEnabled, false);
    assert.equal(service.list().filter((upstream) => upstream.kind === "responses_api").length, 1);
  } finally { fixture.close(); }
});

test("model IDs are globally unique across channels", () => {
  const fixture = createFixture();
  try {
    const service = createUpstreamService({ db: fixture.store.db, secretCodec: codec });
    service.save(input("API A", "shared-model"));
    assert.throws(() => service.save(input("API B", "shared-model")), /模型 shared-model 已属于上游/);
  } finally { fixture.close(); }
});

test("editing an upstream cannot retain encrypted credentials while switching to remote HTTP", () => {
  const fixture = createFixture();
  try {
    const service = createUpstreamService({ db: fixture.store.db, secretCodec: codec });
    const saved = service.save({ ...input("Secure API", "secure-model"), apiKey: "secret" });
    assert.throws(() => service.save({
      ...input("Secure API", "secure-model"), id: saved.id, baseUrl: "http://api.example.test/v1"
    }), /远程上游必须使用 HTTPS/);
    assert.equal(service.getRuntime(saved.id).baseUrl, "https://api.example.test/v1");
  } finally { fixture.close(); }
});

test("gateway model options exclude the subscription pool and keep only third-party channel models", () => {
  const fixture = createFixture();
  try {
    const service = createUpstreamService({ db: fixture.store.db, secretCodec: codec });
    const saved = service.save(input("API A", "model-a"));
    const builtin = service.list().find((upstream) => upstream.kind === "chatgpt_subscription_pool");
    assert.ok(builtin);
    fixture.store.db.prepare(`
      INSERT INTO upstream_models (
        upstream_id, model_id, display_name, available, source,
        capabilities_json, raw_metadata_json, last_seen_at, last_synced_at
      ) VALUES (?, ?, ?, 1, 'test', '{}', '{}', ?, ?)
    `).run(builtin.id, "gpt-pool-model", "GPT Pool Model", Date.now(), Date.now());
    const options = service.listGatewayModelOptions();
    assert.deepEqual(options.map((item) => item.modelId), ["model-a"]);
    assert.equal(options[0]?.upstreamId, saved.id);
  } finally { fixture.close(); }
});

test("subscription pool exposes total quota and respects the ignored five-hour window", () => {
  const fixture = createFixture();
  try {
    fixture.store.saveAccount({ id: "a", name: "A", access_token: "a", refresh_token: "ra", id_token: "ia", enabled: true, status: "active", quota_5h_used_percent: 20, quota_7d_used_percent: 30, reset_credits_available_count: 1 });
    fixture.store.saveAccount({ id: "b", name: "B", access_token: "b", refresh_token: "rb", id_token: "ib", enabled: true, status: "active", quota_5h_used_percent: 50, quota_7d_used_percent: 60, reset_credits_available_count: 2 });
    fixture.store.saveAccount({ id: "c", name: "C", access_token: "c", refresh_token: "rc", id_token: "ic", enabled: false, status: "disabled", quota_5h_used_percent: 0, quota_7d_used_percent: 0, reset_credits_available_count: 9 });
    const service = createUpstreamService({ db: fixture.store.db, secretCodec: codec });
    const builtin = service.list().find((upstream) => upstream.kind === "chatgpt_subscription_pool");
    assert.deepEqual(builtin?.balance.subscriptionPool, {
      totalAccounts: 3,
      enabledAccounts: 2,
      availableAccounts: 2,
      quotaCapacityPercent: 200,
      fiveHourRemainingPercent: 130,
      sevenDayRemainingPercent: 110,
      resetCredits: 3
    });

    fixture.store.saveSettings({ ignore_five_hour_limit: "true" });
    const ignored = service.list().find((upstream) => upstream.kind === "chatgpt_subscription_pool");
    assert.equal(ignored?.balance.subscriptionPool?.fiveHourRemainingPercent, null);
    assert.equal(ignored?.balance.subscriptionPool?.sevenDayRemainingPercent, 110);
  } finally { fixture.close(); }
});

test("service startup backfills missing historical estimates from per-model pricing", () => {
  const fixture = createFixture();
  try {
    const service = createUpstreamService({ db: fixture.store.db, secretCodec: codec });
    const upstream = service.save({
      ...input("Priced API", "priced-model"),
      modelPricing: {
        "priced-model": { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 }
      }
    });
    fixture.store.addTokenLog({
      method: "POST",
      request_path: "/v1/responses",
      status: 200,
      upstream_id: upstream.id,
      upstream_name: upstream.name,
      upstream_kind: "responses_api",
      client_model: "priced-model",
      upstream_model: "priced-model",
      input_tokens: 1000,
      cached_input_tokens: 500,
      output_tokens: 100,
      total_tokens: 1100
    });
    assert.equal(fixture.store.listTokenLogs().items[0]?.estimated_cost, null);

    createUpstreamService({ db: fixture.store.db, secretCodec: codec });
    const backfilled = fixture.store.listTokenLogs().items[0];
    assert.equal(backfilled?.estimated_cost, 0.0023);
    assert.equal(backfilled?.cost_unit, "USD");
  } finally { fixture.close(); }
});

test("DeepSeek balance query uses the official endpoint and normalizes two-decimal amounts", async () => {
  const fixture = createFixture();
  let requestedUrl = "";
  try {
    const service = createUpstreamService({
      db: fixture.store.db,
      secretCodec: codec,
      fetch: async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "110", granted_balance: "10", topped_up_balance: "100" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const saved = service.save({ ...input("Deep API", "deep-model"), baseUrl: "https://api.deepseek.com/v1", balanceQueryType: "deepseek", apiKey: "key" });
    const result = await service.refreshBalance(saved.id);
    assert.equal(requestedUrl, "https://api.deepseek.com/user/balance");
    assert.deepEqual(result.infos[0], {
      currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00"
    });
  } finally { fixture.close(); }
});

function input(name: string, slug: string) {
  return {
    name, baseUrl: "https://api.example.test/v1", enabled: true,
    supportsWebSocket: false, balanceQueryType: "none" as const,
    modelCatalogJson: JSON.stringify({ models: [{ slug, display_name: slug }] }),
    modelPricing: { [slug]: { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 } }
  };
}

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-upstream-"));
  const store = createStore({ secretCodec: codec, dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  return {
    store,
    close() { store.db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  };
}
