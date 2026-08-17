import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BundledModelOverride, ModelCatalogBuildResult } from "../shared/contracts/upstreams.ts";
import { writeFilesTransaction } from "./codex-cli-auth.ts";
import { BUILTIN_SUBSCRIPTION_ID } from "./upstreams/upstream-service.ts";

type ModelEntry = Record<string, unknown> & { slug: string };
type Catalog = Record<string, unknown> & { models: ModelEntry[] };

interface CatalogServiceOptions {
  db: DatabaseSync;
  dataDir: string;
  runBundledModels?: () => string;
  getBundledOverride?: () => BundledModelOverride;
}

export function createCodexModelCatalogService(options: CatalogServiceOptions) {
  const catalogPath = path.join(options.dataDir, "models.json");
  const bundledCachePath = path.join(options.dataDir, "codex-bundled-models.json");
  const rebuild = (refreshBundled: boolean, allowCachedFallback: boolean): ModelCatalogBuildResult => {
    const override = options.getBundledOverride?.() || { enabled: false, modelCatalogJson: "" };
    let bundled: Catalog;
    let bundledSource: ModelCatalogBuildResult["bundledSource"];
    if (override.enabled) {
      bundled = parseBundledOverrideCatalog(override.modelCatalogJson);
      bundledSource = "override";
    } else if (refreshBundled || !fs.existsSync(bundledCachePath)) {
      try {
        bundled = parseCatalog((options.runBundledModels || runBundledModels)(), "Codex 内置模型目录");
        writeFilesTransaction([{ file: bundledCachePath, content: `${JSON.stringify(bundled, null, 2)}\n` }]);
        bundledSource = "cli";
      } catch (error) {
        if (!allowCachedFallback || !fs.existsSync(bundledCachePath)) throw error;
        bundled = parseCatalog(fs.readFileSync(bundledCachePath, "utf8"), "Codex 内置模型缓存");
        bundledSource = "cache";
      }
    } else {
      bundled = parseCatalog(fs.readFileSync(bundledCachePath, "utf8"), "Codex 内置模型缓存");
      bundledSource = "cache";
    }
    const external = enabledExternalModels(options.db);
    const merged = mergeCatalogs(bundled, external);
    syncBundledModels(options.db, bundled.models);
    writeFilesTransaction([{ file: catalogPath, content: `${JSON.stringify(merged, null, 2)}\n` }], () => {
      parseCatalog(fs.readFileSync(catalogPath, "utf8"), "生成的模型目录");
    });
    return {
      path: catalogPath,
      bundledCachePath,
      bundledSource,
      bundledCount: bundled.models.length,
      externalCount: external.length,
      totalCount: merged.models.length
    };
  };
  return {
    path: catalogPath,
    refresh: () => rebuild(false, false),
    refreshBundled: (allowCachedFallback = false) => rebuild(true, allowCachedFallback)
  };
}

export function runBundledModels(): string {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec || "cmd.exe";
    return execFileSync(shell, ["/d", "/s", "/c", "codex debug models --bundled"], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
  }
  return execFileSync("codex", ["debug", "models", "--bundled"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
}

export function parseCatalog(raw: string, label = "模型目录"): Catalog {
  let value: unknown;
  try { value = JSON.parse(String(raw || "")); } catch { throw new Error(`${label}不是有效 JSON。`); }
  if (!isObject(value) || !Array.isArray(value.models)) throw new Error(`${label}缺少 models 数组。`);
  const models = value.models.map((entry) => {
    if (!isObject(entry)) throw new Error(`${label}包含非对象模型项。`);
    const slug = String(entry.slug || "").trim();
    if (!slug) throw new Error(`${label}包含缺少 slug 的模型项。`);
    return { ...entry, slug } as ModelEntry;
  });
  if (new Set(models.map((model) => model.slug)).size !== models.length) {
    throw new Error(`${label}包含重复的模型 slug。`);
  }
  return { ...value, models } as Catalog;
}

export function parseBundledOverrideCatalog(raw: string): Catalog {
  const catalog = parseCatalog(raw, "Codex Bundled 覆盖模型目录");
  if (catalog.models.length === 0) throw new Error("Codex Bundled 覆盖模型目录必须包含非空 models 数组。");
  return catalog;
}

export function mergeCatalogs(bundled: Catalog, external: ModelEntry[]): Catalog {
  const models = [...bundled.models];
  const owners = new Set(models.map((model) => model.slug));
  for (const model of external) {
    if (owners.has(model.slug)) throw new Error(`模型 ID 冲突：${model.slug} 已存在于 Codex 内置目录或其他 API 上游。`);
    owners.add(model.slug);
    models.push(model);
  }
  return { ...bundled, models };
}

function enabledExternalModels(db: DatabaseSync): ModelEntry[] {
  const rows = db.prepare(`
    SELECT upstream_models.upstream_id, upstream_models.raw_metadata_json,
      upstream_models.model_id, upstream_models.display_name,
      upstreams.supports_websocket
    FROM upstream_models
    JOIN upstreams ON upstreams.id = upstream_models.upstream_id
    WHERE upstreams.kind = 'responses_api' AND upstreams.enabled = 1
      AND upstream_models.available = 1
    ORDER BY upstreams.created_at, upstream_models.model_id COLLATE NOCASE
  `).all() as Array<Record<string, unknown>>;
  const update = db.prepare(`
    UPDATE upstream_models SET raw_metadata_json = ?
    WHERE upstream_id = ? AND model_id = ?
  `);
  return rows.map((row) => {
    const modelId = String(row.model_id || "").trim();
    if (!modelId) throw new Error("API 上游模型记录缺少模型 ID。");
    const stored = parseStoredMetadata(row.raw_metadata_json, modelId);
    const model = {
      ...stored,
      slug: modelId,
      display_name: String(stored.display_name || row.display_name || modelId),
      prefer_websockets: Boolean(row.supports_websocket),
      supports_websockets: Boolean(row.supports_websocket)
    } as ModelEntry;
    const normalized = JSON.stringify(model);
    if (normalized !== String(row.raw_metadata_json || "")) {
      update.run(normalized, String(row.upstream_id || ""), modelId);
    }
    return model;
  });
}

function parseStoredMetadata(value: unknown, modelId: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value || "{}")); } catch {
    throw new Error(`API 上游模型 ${modelId} 的元数据不是有效 JSON。`);
  }
  if (!isObject(parsed)) throw new Error(`API 上游模型 ${modelId} 的元数据必须是对象。`);
  return parsed;
}

function syncBundledModels(db: DatabaseSync, models: ModelEntry[]): void {
  const timestamp = Math.floor(Date.now() / 1000);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE upstream_models SET available = 0, last_synced_at = ? WHERE upstream_id = ?")
      .run(timestamp, BUILTIN_SUBSCRIPTION_ID);
    const upsert = db.prepare(`
      INSERT INTO upstream_models (
        upstream_id, model_id, display_name, available, source, capabilities_json,
        raw_metadata_json, pricing_json, last_seen_at, last_synced_at
      ) VALUES (?, ?, ?, 1, 'codex_bundled', '{}', ?, '{}', ?, ?)
      ON CONFLICT(upstream_id, model_id) DO UPDATE SET
        display_name = excluded.display_name, available = 1, source = excluded.source,
        raw_metadata_json = excluded.raw_metadata_json,
        last_seen_at = excluded.last_seen_at, last_synced_at = excluded.last_synced_at
    `);
    for (const model of models) {
      upsert.run(
        BUILTIN_SUBSCRIPTION_ID,
        model.slug,
        String(model.display_name || model.slug),
        JSON.stringify(model),
        timestamp,
        timestamp
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
