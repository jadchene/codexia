import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createCodexModelCatalogService } from "../src/main/codex-model-catalog.ts";
import { createStore } from "../src/main/store.ts";
import { BUILTIN_SUBSCRIPTION_ID, createUpstreamService } from "../src/main/upstreams/upstream-service.ts";

const codec = { encrypt: (value: string) => value, decrypt: (value: string) => value, isEncrypted: () => true };
const bundled = JSON.stringify({ models: [{ slug: "gpt-built-in", display_name: "GPT Built In", support_shell_tool: true }] });

test("cached bundled and external channel catalogs merge without rerunning Codex on gateway rebuild", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-"));
  const store = createStore({ secretCodec: codec, dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  let debugCalls = 0;
  try {
    const upstreams = createUpstreamService({ db: store.db, secretCodec: codec });
    const catalogs = createCodexModelCatalogService({ db: store.db, dataDir: directory, runBundledModels: () => { debugCalls += 1; return bundled; } });
    catalogs.refreshBundled();
    assert.equal(debugCalls, 1);
    upstreams.saveModelPricing(BUILTIN_SUBSCRIPTION_ID, {
      "gpt-built-in": { inputPerMillion: 1.23, cachedInputPerMillion: 0.45, outputPerMillion: 6.78 }
    });
    upstreams.save({
      name: "Third Party", baseUrl: "https://api.example.test/v1", enabled: true,
      supportsWebSocket: false, balanceQueryType: "none",
      modelCatalogJson: JSON.stringify({ models: [{ slug: "third-party-model", display_name: "Third Party" }] }),
      modelPricing: { "third-party-model": { inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4 } }
    });
    const result = catalogs.refresh();
    assert.equal(debugCalls, 1);
    assert.equal(result.totalCount, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.path, "utf8")).models.map((model: { slug: string }) => model.slug), ["gpt-built-in", "third-party-model"]);
    catalogs.refreshBundled();
    assert.equal(debugCalls, 2);
    assert.deepEqual(upstreams.getModelPricing(BUILTIN_SUBSCRIPTION_ID, "gpt-built-in"), {
      inputPerMillion: 1.23, cachedInputPerMillion: 0.45, outputPerMillion: 6.78
    });
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("model management overrides names, priorities, and visibility without removing models", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-management-"));
  const store = createStore({ secretCodec: codec, dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  let bundledCatalog = JSON.stringify({ models: [{ slug: "built-in", display_name: "Built In", priority: 90 }] });
  const management = [
    { slug: "external", displayName: "External Custom", visible: true },
    { slug: "built-in", displayName: "Built In Hidden", visible: false }
  ];
  try {
    const upstreams = createUpstreamService({ db: store.db, secretCodec: codec });
    upstreams.save({
      name: "Third Party", baseUrl: "https://api.example.test/v1", enabled: true,
      supportsWebSocket: false, balanceQueryType: "none",
      modelCatalogJson: JSON.stringify({ models: [{ slug: "external", priority: 40 }] }),
      modelPricing: {}
    });
    const catalogs = createCodexModelCatalogService({
      db: store.db,
      dataDir: directory,
      runBundledModels: () => bundledCatalog,
      getModelManagement: () => management
    });
    let result = catalogs.refreshBundled();
    let models = JSON.parse(fs.readFileSync(result.path, "utf8")).models;
    assert.deepEqual(models.map((model: { slug: string }) => model.slug), ["external", "built-in"]);
    assert.equal(models[0].display_name, "External Custom");
    assert.equal(models[0].priority, 1);
    assert.deepEqual(models.map((model: { visibility: string }) => model.visibility), ["list", "hide"]);
    assert.deepEqual(catalogs.listModels().map((model) => [model.slug, model.visible]), [
      ["external", true], ["built-in", false]
    ]);

    bundledCatalog = JSON.stringify({ models: [{ slug: "built-in" }, { slug: "new-model", priority: 5, visibility: "hide" }] });
    result = catalogs.refreshBundled();
    models = JSON.parse(fs.readFileSync(result.path, "utf8")).models;
    assert.deepEqual(models.map((model: { slug: string }) => model.slug), ["external", "built-in", "new-model"]);
    assert.deepEqual(models.map((model: { priority: number }) => model.priority), [1, 2, 3]);
    assert.deepEqual(catalogs.listModels().map((model) => [model.slug, model.visible]), [
      ["external", true], ["built-in", false], ["new-model", false]
    ]);
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("enabled bundled override skips Codex and merges the manual catalog with external models", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-override-"));
  const store = createStore({ secretCodec: codec, dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  let debugCalls = 0;
  let override = { enabled: false, modelCatalogJson: "" };
  try {
    const upstreams = createUpstreamService({ db: store.db, secretCodec: codec });
    const catalogs = createCodexModelCatalogService({
      db: store.db,
      dataDir: directory,
      runBundledModels: () => { debugCalls += 1; return bundled; },
      getBundledOverride: () => override
    });
    catalogs.refreshBundled();
    const cachedBundled = fs.readFileSync(path.join(directory, "codex-bundled-models.json"), "utf8");
    upstreams.save({
      name: "Third Party", baseUrl: "https://api.example.test/v1", enabled: true,
      supportsWebSocket: false, balanceQueryType: "none",
      modelCatalogJson: JSON.stringify({ models: [{ slug: "third-party-model", display_name: "Third Party" }] }),
      modelPricing: {}
    });

    override = {
      enabled: true,
      modelCatalogJson: JSON.stringify({ models: [{ slug: "gpt-override", display_name: "GPT Override" }] })
    };
    const result = catalogs.refreshBundled();

    assert.equal(debugCalls, 1);
    assert.equal(result.bundledSource, "override");
    assert.equal(result.bundledCount, 1);
    assert.equal(result.externalCount, 1);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(result.path, "utf8")).models.map((model: { slug: string }) => model.slug),
      ["gpt-override", "third-party-model"]
    );
    assert.equal(fs.readFileSync(path.join(directory, "codex-bundled-models.json"), "utf8"), cachedBundled);
    assert.deepEqual(
      upstreams.listModels(BUILTIN_SUBSCRIPTION_ID).filter((model) => model.available).map((model) => model.modelId),
      ["gpt-override"]
    );

    override = { enabled: false, modelCatalogJson: override.modelCatalogJson };
    const restored = catalogs.refreshBundled();
    assert.equal(debugCalls, 2);
    assert.equal(restored.bundledSource, "cli");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(restored.path, "utf8")).models.map((model: { slug: string }) => model.slug),
      ["gpt-built-in", "third-party-model"]
    );
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bundled override rejects duplicate slugs and conflicts with external models", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-override-conflict-"));
  const store = createStore({ secretCodec: codec, dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  let override = {
    enabled: true,
    modelCatalogJson: JSON.stringify({ models: [{ slug: "duplicate" }, { slug: "duplicate" }] })
  };
  try {
    const upstreams = createUpstreamService({ db: store.db, secretCodec: codec });
    const catalogs = createCodexModelCatalogService({
      db: store.db,
      dataDir: directory,
      runBundledModels: () => bundled,
      getBundledOverride: () => override
    });
    override = { enabled: true, modelCatalogJson: JSON.stringify({ models: [] }) };
    assert.throws(() => catalogs.refreshBundled(), /必须包含非空 models 数组/);
    override = {
      enabled: true,
      modelCatalogJson: JSON.stringify({ models: [{ slug: "duplicate" }, { slug: "duplicate" }] })
    };
    assert.throws(() => catalogs.refreshBundled(), /重复的模型 slug/);

    upstreams.save({
      name: "Third Party", baseUrl: "https://api.example.test/v1", enabled: true,
      supportsWebSocket: false, balanceQueryType: "none",
      modelCatalogJson: JSON.stringify({ models: [{ slug: "shared-model" }] }),
      modelPricing: {}
    });
    override = {
      enabled: true,
      modelCatalogJson: JSON.stringify({ models: [{ slug: "shared-model" }] })
    };
    assert.throws(() => catalogs.refreshBundled(), /模型 ID 冲突：shared-model/);
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy discovered API models are normalized to Codex slugs during catalog rebuild", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-legacy-"));
  const store = createStore({ secretCodec: codec, dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  try {
    const catalogs = createCodexModelCatalogService({ db: store.db, dataDir: directory, runBundledModels: () => bundled });
    catalogs.refreshBundled();
    const upstreamId = "legacy-api";
    const timestamp = Math.floor(Date.now() / 1000);
    store.db.prepare(`
      INSERT INTO upstreams (
        id, name, kind, enabled, base_url, auth_type, supports_http,
        supports_websocket, capabilities_json, cost_factors_json, created_at, updated_at
      ) VALUES (?, 'Legacy API', 'responses_api', 1, 'https://api.example.test/v1',
        'bearer', 1, 0, '{}', '{}', ?, ?)
    `).run(upstreamId, timestamp, timestamp);
    store.db.prepare(`
      INSERT INTO upstream_models (
        upstream_id, model_id, display_name, available, source,
        capabilities_json, raw_metadata_json, pricing_json, last_seen_at, last_synced_at
      ) VALUES (?, 'legacy-model', 'Legacy Model', 1, 'discovery', '{}',
        '{"id":"legacy-model","object":"model"}', '{}', ?, ?)
    `).run(upstreamId, timestamp, timestamp);

    const result = catalogs.refresh();
    const external = JSON.parse(fs.readFileSync(result.path, "utf8")).models.find((model: { slug: string }) => model.slug === "legacy-model");
    assert.deepEqual(external, {
      id: "legacy-model",
      object: "model",
      slug: "legacy-model",
      display_name: "Legacy Model",
      prefer_websockets: false,
      supports_websockets: false
    });
    const stored = JSON.parse(String(store.db.prepare(`
      SELECT raw_metadata_json FROM upstream_models WHERE upstream_id = ? AND model_id = 'legacy-model'
    `).get(upstreamId)?.raw_metadata_json));
    assert.equal(stored.slug, "legacy-model");
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
