import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BalanceQueryType,
  BalanceRefreshResult,
  GatewayModelSummary,
  ModelPricing,
  SaveResponsesApiUpstreamInput,
  UpstreamHealthResult,
  UpstreamInvocationTestResult,
  UpstreamKind,
  UpstreamModel,
  UpstreamSummary
} from "../../shared/contracts/upstreams";
import { buildAccountPoolQuotaSummary } from "../gateway/quota.ts";
import { estimateUpstreamCost } from "./cost-estimator.ts";

export const BUILTIN_SUBSCRIPTION_ID = "builtin-chatgpt-subscription-pool";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
interface SecretCodec {
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
}

export interface RuntimeUpstream {
  id: string;
  name: string;
  kind: UpstreamKind;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  supportsWebSocket: boolean;
  compactAdaptEnabled: boolean;
  requestHeaders: Record<string, string>;
  credentialRef: string;
}

interface CatalogModel {
  slug: string;
  displayName: string;
  metadata: Record<string, unknown>;
}

type SqlRow = Record<string, unknown>;

export function createUpstreamService(options: {
  db: DatabaseSync;
  secretCodec: SecretCodec;
  fetch?: typeof fetch;
}) {
  const { db, secretCodec } = options;
  const fetchImpl = options.fetch || globalThis.fetch;
  backfillMissingEstimatedCosts(db);
  return {
    list: () => listUpstreams(db, secretCodec),
    listModels: (upstreamId: string) => listModels(db, upstreamId),
    listGatewayModels: () => listGatewayModels(db),
    listGatewayModelOptions: () => listGatewayModelOptions(db),
    getRuntime: (upstreamId: string) => runtimeUpstream(db, secretCodec, upstreamId),
    findRuntimeByModel: (modelId: string) => findRuntimeByModel(db, secretCodec, modelId),
    getModelPricing: (upstreamId: string, modelId: string) => getModelPricing(db, upstreamId, modelId),
    saveModelPricing: (upstreamId: string, pricing: Record<string, ModelPricing>) => saveModelPricing(db, upstreamId, pricing),
    save: (input: SaveResponsesApiUpstreamInput) => saveUpstream(db, secretCodec, input),
    delete: (upstreamId: string) => deleteUpstream(db, upstreamId),
    refreshBalance: (upstreamId: string) => refreshBalance(db, secretCodec, fetchImpl, upstreamId),
    testConnection: (upstreamId: string) => testConnection(db, secretCodec, fetchImpl, upstreamId),
    testInvocation: (upstreamId: string, modelId: string) => testInvocation(db, secretCodec, fetchImpl, upstreamId, modelId),
    recordRequestOutcome: (upstreamId: string, outcome: { status?: number; latencyMs: number; message?: string }) => recordRequestOutcome(db, upstreamId, outcome)
  };
}

function listUpstreams(db: DatabaseSync, secretCodec: SecretCodec): UpstreamSummary[] {
  return db.prepare(`
    SELECT upstreams.*, COUNT(upstream_models.model_id) AS model_count,
      MAX(upstream_models.last_synced_at) AS last_synced_at
    FROM upstreams
    LEFT JOIN upstream_models ON upstream_models.upstream_id = upstreams.id
      AND upstream_models.available = 1
    GROUP BY upstreams.id
    ORDER BY CASE upstreams.kind WHEN 'chatgpt_subscription_pool' THEN 0 ELSE 1 END,
      upstreams.created_at ASC
  `).all().map((row) => publicUpstream(db, row as SqlRow, secretCodec));
}

function listModels(db: DatabaseSync, upstreamId: string): UpstreamModel[] {
  requireUpstream(db, upstreamId);
  return db.prepare(`
    SELECT model_id, display_name, available, source, raw_metadata_json, pricing_json,
      last_seen_at, last_synced_at
    FROM upstream_models WHERE upstream_id = ?
    ORDER BY available DESC, model_id COLLATE NOCASE ASC
  `).all(upstreamId).map((value) => {
    const row = value as SqlRow;
    return {
      modelId: String(row.model_id || ""),
      displayName: String(row.display_name || row.model_id || ""),
      available: Boolean(row.available),
      source: String(row.source || ""),
      metadata: parseJsonObject(row.raw_metadata_json),
      pricing: normalizePricing(parseJsonObject(row.pricing_json)),
      lastSeenAt: numberOrNull(row.last_seen_at),
      lastSyncedAt: numberOrNull(row.last_synced_at)
    };
  });
}

function listGatewayModels(db: DatabaseSync) {
  return db.prepare(`
    SELECT upstream_models.model_id, upstream_models.display_name, upstreams.id AS upstream_id,
      upstreams.name AS upstream_name
    FROM upstream_models JOIN upstreams ON upstreams.id = upstream_models.upstream_id
    WHERE upstream_models.available = 1 AND upstreams.enabled = 1
    ORDER BY CASE upstreams.kind WHEN 'chatgpt_subscription_pool' THEN 0 ELSE 1 END,
      upstream_models.model_id COLLATE NOCASE
  `).all().map((row) => {
    const value = row as SqlRow;
    return {
      id: String(value.model_id || ""),
      object: "model",
      display_name: String(value.display_name || value.model_id || ""),
      owned_by: String(value.upstream_name || value.upstream_id || "")
    };
  });
}

function listGatewayModelOptions(db: DatabaseSync): GatewayModelSummary[] {
  return db.prepare(`
    SELECT upstream_models.model_id, upstream_models.display_name,
      upstreams.id AS upstream_id, upstreams.name AS upstream_name
    FROM upstream_models JOIN upstreams ON upstreams.id = upstream_models.upstream_id
    WHERE upstream_models.available = 1 AND upstreams.enabled = 1
      AND upstreams.kind = 'responses_api'
    ORDER BY upstream_models.model_id COLLATE NOCASE
  `).all().map((row) => {
    const value = row as SqlRow;
    return {
      modelId: String(value.model_id || ""),
      displayName: String(value.display_name || value.model_id || ""),
      upstreamId: String(value.upstream_id || ""),
      upstreamName: String(value.upstream_name || value.upstream_id || "")
    };
  });
}

function runtimeUpstream(db: DatabaseSync, secretCodec: SecretCodec, upstreamId: string): RuntimeUpstream {
  return runtimeFromRow(requireUpstream(db, upstreamId), secretCodec);
}

function findRuntimeByModel(db: DatabaseSync, secretCodec: SecretCodec, rawModelId: string): RuntimeUpstream | null {
  const modelId = String(rawModelId || "").trim();
  if (!modelId) return null;
  const rows = db.prepare(`
    SELECT upstreams.* FROM upstream_models
    JOIN upstreams ON upstreams.id = upstream_models.upstream_id
    WHERE upstream_models.model_id = ? AND upstream_models.available = 1
      AND upstreams.enabled = 1 AND upstreams.kind = 'responses_api'
    ORDER BY upstreams.id
  `).all(modelId) as SqlRow[];
  if (rows.length > 1) throw upstreamError("DUPLICATE_MODEL_OWNER", `模型 ${modelId} 同时属于多个 API 上游。`);
  return rows[0] ? runtimeFromRow(rows[0], secretCodec) : null;
}

function getModelPricing(db: DatabaseSync, upstreamId: string, modelId: string): ModelPricing {
  const row = db.prepare("SELECT pricing_json FROM upstream_models WHERE upstream_id = ? AND model_id = ?")
    .get(upstreamId, modelId) as SqlRow | undefined;
  return normalizePricing(parseJsonObject(row?.pricing_json));
}

function saveModelPricing(db: DatabaseSync, upstreamId: string, pricing: Record<string, ModelPricing>): UpstreamModel[] {
  requireUpstream(db, upstreamId);
  const update = db.prepare("UPDATE upstream_models SET pricing_json = ? WHERE upstream_id = ? AND model_id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [modelId, value] of Object.entries(pricing || {})) {
      const result = update.run(JSON.stringify(normalizePricing(value)), upstreamId, modelId);
      if (Number(result.changes || 0) === 0) throw upstreamError("MODEL_NOT_FOUND", `模型不存在：${modelId}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  backfillMissingEstimatedCosts(db, upstreamId);
  return listModels(db, upstreamId);
}

function backfillMissingEstimatedCosts(db: DatabaseSync, upstreamId?: string): void {
  const currency = String((db.prepare("SELECT value FROM settings WHERE key = ?").get("billing_currency") as SqlRow | undefined)?.value || "USD").toUpperCase();
  const rows = db.prepare(`
    SELECT request_logs.id, request_logs.input_tokens, request_logs.cached_input_tokens,
      request_logs.output_tokens, upstream_models.pricing_json
    FROM request_logs
    JOIN upstream_models ON upstream_models.upstream_id = request_logs.upstream_id
      AND upstream_models.model_id = COALESCE(NULLIF(request_logs.upstream_model, ''), request_logs.client_model)
    WHERE request_logs.estimated_cost IS NULL
      AND (? IS NULL OR request_logs.upstream_id = ?)
  `).all(upstreamId || null, upstreamId || null) as SqlRow[];
  if (rows.length === 0) return;
  const update = db.prepare("UPDATE request_logs SET estimated_cost = ?, cost_unit = ? WHERE id = ? AND estimated_cost IS NULL");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const pricing = normalizePricing(parseJsonObject(row.pricing_json));
      if (pricing.inputPerMillion <= 0 && pricing.cachedInputPerMillion <= 0 && pricing.outputPerMillion <= 0) continue;
      const estimated = estimateUpstreamCost({
        input_tokens: Number(row.input_tokens || 0),
        cached_input_tokens: Number(row.cached_input_tokens || 0),
        output_tokens: Number(row.output_tokens || 0)
      }, pricing, currency);
      if (estimated) update.run(estimated.amount, estimated.unit, Number(row.id));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function runtimeFromRow(row: SqlRow, secretCodec: SecretCodec): RuntimeUpstream {
  const stored = parseJsonObject(row.capabilities_json);
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    kind: row.kind === "responses_api" ? "responses_api" : "chatgpt_subscription_pool",
    enabled: Boolean(row.enabled),
    baseUrl: String(row.base_url || ""),
    apiKey: row.api_key_encrypted ? secretCodec.decrypt(String(row.api_key_encrypted)) : "",
    supportsWebSocket: Boolean(row.supports_websocket),
    compactAdaptEnabled: booleanOrDefault(row.compact_adapt_enabled, true),
    requestHeaders: {
      ...normalizeStoredHeaderMap(stored.requestHeaders),
      ...decryptSecretHeaders(secretCodec, row.custom_headers_encrypted_json)
    },
    credentialRef: row.api_key_encrypted
      ? createHash("sha256").update(String(row.api_key_encrypted)).digest("hex").slice(0, 16)
      : ""
  };
}

function saveUpstream(db: DatabaseSync, secretCodec: SecretCodec, raw: SaveResponsesApiUpstreamInput): UpstreamSummary {
  const input = normalizeInput(raw);
  const models = parseModelCatalog(input.modelCatalogJson).map((model) => ({
    ...model,
    metadata: {
      ...model.metadata,
      prefer_websockets: input.supportsWebSocket,
      supports_websockets: input.supportsWebSocket
    }
  }));
  const existing = input.id ? requireUpstream(db, input.id) : null;
  if (existing?.kind === "chatgpt_subscription_pool") {
    throw upstreamError("BUILTIN_UPSTREAM_READ_ONLY", "内置订阅账号池不能通过 API 上游表单修改。");
  }
  const id = String(existing?.id || randomUUID());
  assertUniqueModelOwners(db, id, models.map((model) => model.slug));
  const timestamp = now();
  const encryptedApiKey = input.apiKey
    ? secretCodec.encrypt(input.apiKey)
    : existing?.api_key_encrypted ? String(existing.api_key_encrypted) : null;
  const encryptedSecretHeaders = input.secretHeaders === undefined
    ? existing?.custom_headers_encrypted_json ? String(existing.custom_headers_encrypted_json) : null
    : Object.keys(input.secretHeaders).length > 0
      ? secretCodec.encrypt(JSON.stringify(input.secretHeaders))
      : null;
  const previousState = parseJsonObject(existing?.capabilities_json);
  const stateJson = JSON.stringify({ requestHeaders: input.publicHeaders, health: previousState.health || null });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
    INSERT INTO upstreams (
      id, name, kind, enabled, base_url, auth_type, api_key_encrypted,
      custom_headers_encrypted_json, model_discovery_mode, models_endpoint,
      supports_http, supports_websocket, compact_adapt_enabled, capabilities_json, cost_factors_json,
      balance_query_type, created_at, updated_at
    ) VALUES (?, ?, 'responses_api', ?, ?, 'bearer', ?, ?, 'disabled', NULL, 1, ?, ?, ?, '{}', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, enabled = excluded.enabled, base_url = excluded.base_url,
      api_key_encrypted = excluded.api_key_encrypted,
      custom_headers_encrypted_json = excluded.custom_headers_encrypted_json,
      supports_http = 1, supports_websocket = excluded.supports_websocket,
      compact_adapt_enabled = excluded.compact_adapt_enabled,
      capabilities_json = excluded.capabilities_json,
      balance_query_type = excluded.balance_query_type, updated_at = excluded.updated_at
    `).run(
      id, input.name, input.enabled ? 1 : 0, input.baseUrl, encryptedApiKey,
      encryptedSecretHeaders, input.supportsWebSocket ? 1 : 0, input.compactAdaptEnabled ? 1 : 0, stateJson,
      input.balanceQueryType, Number(existing?.created_at || timestamp), timestamp
    );
    db.prepare("DELETE FROM upstream_models WHERE upstream_id = ?").run(id);
    const insert = db.prepare(`
      INSERT INTO upstream_models (
        upstream_id, model_id, display_name, available, source, capabilities_json,
        raw_metadata_json, pricing_json, last_seen_at, last_synced_at
      ) VALUES (?, ?, ?, 1, 'catalog_json', '{}', ?, ?, ?, ?)
    `);
    for (const model of models) {
      insert.run(
        id, model.slug, model.displayName, JSON.stringify(model.metadata),
        JSON.stringify(normalizePricing(input.modelPricing[model.slug])), timestamp, timestamp
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  backfillMissingEstimatedCosts(db, id);
  const saved = listUpstreams(db, secretCodec).find((upstream) => upstream.id === id);
  if (!saved) throw upstreamError("UPSTREAM_NOT_FOUND", "API 上游保存后无法读取。");
  return saved;
}

function deleteUpstream(db: DatabaseSync, upstreamId: string): { deleted: true; id: string } {
  const upstream = requireUpstream(db, upstreamId);
  if (upstream.kind === "chatgpt_subscription_pool") {
    throw upstreamError("BUILTIN_UPSTREAM_READ_ONLY", "内置订阅账号池不能删除。");
  }
  db.prepare("DELETE FROM upstreams WHERE id = ?").run(upstreamId);
  return { deleted: true, id: upstreamId };
}

async function refreshBalance(
  db: DatabaseSync,
  secretCodec: SecretCodec,
  fetchImpl: typeof fetch,
  upstreamId: string
): Promise<BalanceRefreshResult> {
  const row = requireUpstream(db, upstreamId);
  if (row.kind !== "responses_api") throw upstreamError("BALANCE_UNSUPPORTED", "订阅账号池余额由账号状态汇总。" );
  const queryType = balanceQueryType(row.balance_query_type);
  if (queryType === "none") throw upstreamError("BALANCE_UNSUPPORTED", "该上游未配置余额查询方式。" );
  const endpoint = balanceEndpoint(queryType, String(row.base_url || ""));
  const apiKey = row.api_key_encrypted ? secretCodec.decrypt(String(row.api_key_encrypted)) : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(endpoint, {
      headers: { ...requestHeadersFromRow(row, secretCodec), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: controller.signal
    });
    const payload = parseJsonObject((await readLimitedBody(response, MAX_RESPONSE_BYTES)).toString("utf8"));
    if (!response.ok) throw upstreamError("BALANCE_HTTP_ERROR", `余额接口返回 HTTP ${response.status}。`);
    const balance = parseDeepSeekBalance(payload);
    db.prepare("UPDATE upstreams SET balance_json = ?, balance_checked_at = ?, balance_error = NULL WHERE id = ?")
      .run(JSON.stringify(balance), balance.checkedAt, upstreamId);
    return { upstreamId, ...balance };
  } catch (error) {
    const message = errorName(error) === "AbortError" ? "余额查询超时。" : errorMessage(error);
    db.prepare("UPDATE upstreams SET balance_checked_at = ?, balance_error = ? WHERE id = ?")
      .run(now(), message.slice(0, 500), upstreamId);
    throw upstreamError("BALANCE_QUERY_FAILED", message);
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection(
  db: DatabaseSync,
  secretCodec: SecretCodec,
  fetchImpl: typeof fetch,
  upstreamId: string
): Promise<UpstreamHealthResult> {
  const row = requireUpstream(db, upstreamId);
  if (row.kind !== "responses_api") throw upstreamError("CONNECTION_TEST_UNSUPPORTED", "订阅账号池使用账号额度刷新检查状态。" );
  const endpoint = `${normalizeHttpUrl(row.base_url, "上游 Base URL")}/models`;
  const apiKey = row.api_key_encrypted ? secretCodec.decrypt(String(row.api_key_encrypted)) : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref?.();
  const started = Date.now();
  let status: UpstreamHealthResult["status"] = "unhealthy";
  let message = "连接失败";
  try {
    const response = await fetchImpl(endpoint, {
      headers: { ...requestHeadersFromRow(row, secretCodec), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: controller.signal
    });
    await response.body?.cancel();
    status = response.ok ? "healthy" : "unhealthy";
    message = response.ok ? `连接成功（HTTP ${response.status}）` : `连接返回 HTTP ${response.status}`;
  } catch (error) {
    message = errorName(error) === "AbortError" ? "连接检查超时" : `连接失败：${errorMessage(error)}`;
  } finally {
    clearTimeout(timer);
  }
  const result = { upstreamId, status, checkedAt: now(), latencyMs: Date.now() - started, message };
  saveHealthResult(db, row, result);
  return result;
}

async function testInvocation(
  db: DatabaseSync,
  secretCodec: SecretCodec,
  fetchImpl: typeof fetch,
  upstreamId: string,
  rawModelId: string
): Promise<UpstreamInvocationTestResult> {
  const row = requireUpstream(db, upstreamId);
  if (row.kind !== "responses_api") throw upstreamError("INVOCATION_TEST_UNSUPPORTED", "调用测试仅支持 API 上游。" );
  const modelId = String(rawModelId || "").trim();
  const model = db.prepare("SELECT 1 FROM upstream_models WHERE upstream_id = ? AND model_id = ? AND available = 1")
    .get(upstreamId, modelId);
  if (!model) throw upstreamError("INVOCATION_MODEL_UNAVAILABLE", "调用测试模型不在该上游的模型 JSON 中。" );
  const endpoint = `${normalizeHttpUrl(row.base_url, "上游 Base URL")}/responses`;
  const apiKey = row.api_key_encrypted ? secretCodec.decrypt(String(row.api_key_encrypted)) : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  timer.unref?.();
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        ...requestHeadersFromRow(row, secretCodec), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        Accept: "application/json", "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: modelId, input: "Reply with exactly OK.", max_output_tokens: 32, stream: false, store: false }),
      signal: controller.signal
    });
  } catch (error) {
    recordRequestOutcome(db, upstreamId, { latencyMs: Date.now() - started, message: errorMessage(error) });
    throw upstreamError("INVOCATION_TEST_FAILED", errorName(error) === "AbortError" ? "上游调用测试超时。" : errorMessage(error));
  } finally {
    clearTimeout(timer);
  }
  const body = await readLimitedBody(response, MAX_RESPONSE_BYTES);
  const payload = parseJsonObject(body.toString("utf8"));
  const latencyMs = Date.now() - started;
  const usage = isObject(payload.usage) ? payload.usage : {};
  const message = response.ok ? "调用测试成功" : String(isObject(payload.error) ? payload.error.message : payload.message || `HTTP ${response.status}`).slice(0, 500);
  recordRequestOutcome(db, upstreamId, { status: response.status, latencyMs, message });
  return {
    upstreamId, endpoint, modelId, ok: response.ok, status: response.status, latencyMs,
    responseId: payload.id ? String(payload.id).slice(0, 200) : null,
    outputPreview: invocationOutputPreview(payload),
    inputTokens: Math.max(0, Number(usage.input_tokens || 0)),
    outputTokens: Math.max(0, Number(usage.output_tokens || 0)),
    totalTokens: Math.max(0, Number(usage.total_tokens || 0)),
    message
  };
}

function publicUpstream(db: DatabaseSync, row: SqlRow, secretCodec: SecretCodec): UpstreamSummary {
  const state = parseJsonObject(row.capabilities_json);
  const health = parseHealth(state.health);
  const encryptedKey = String(row.api_key_encrypted || "");
  const builtin = row.kind === "chatgpt_subscription_pool";
  const storedBalance = parseStoredBalance(row);
  return {
    id: String(row.id || ""), name: String(row.name || ""),
    kind: builtin ? "chatgpt_subscription_pool" : "responses_api",
    enabled: Boolean(row.enabled), baseUrl: String(row.base_url || ""),
    hasApiKey: Boolean(encryptedKey),
    apiKeyFingerprint: encryptedKey ? createHash("sha256").update(encryptedKey).digest("hex").slice(0, 10) : null,
    supportsWebSocket: Boolean(row.supports_websocket),
    compactAdaptEnabled: booleanOrDefault(row.compact_adapt_enabled, true),
    publicHeaders: normalizeStoredHeaderMap(state.requestHeaders),
    secretHeaders: secretHeaderSummary(decryptSecretHeaders(secretCodec, row.custom_headers_encrypted_json)),
    balanceQueryType: builtin ? "none" : balanceQueryType(row.balance_query_type),
    balance: builtin ? subscriptionPoolBalance(db) : storedBalance,
    healthStatus: health.status, healthCheckedAt: health.checkedAt,
    healthLatencyMs: health.latencyMs, healthMessage: health.message,
    modelCount: Number(row.model_count || 0), lastSyncedAt: numberOrNull(row.last_synced_at)
  };
}

function subscriptionPoolBalance(db: DatabaseSync) {
  const accounts = db.prepare(`
    SELECT id, access_token, enabled, status, quota_5h_used_percent, quota_5h_reset_at,
      quota_7d_used_percent, quota_7d_reset_at,
      reset_credits_available_count FROM accounts
  `).all() as SqlRow[];
  const enabledAccounts = accounts.filter((account) => Boolean(account.enabled) && account.status !== "disabled");
  const available = accounts.filter((account) => Boolean(account.enabled) && account.status === "active").length;
  const credits = enabledAccounts.reduce((total, account) => total + Math.max(0, Number(account.reset_credits_available_count || 0)), 0);
  const ignoreFiveHour = String((db.prepare("SELECT value FROM settings WHERE key = ?").get("ignore_five_hour_limit") as SqlRow | undefined)?.value || "false") === "true";
  const quota = buildAccountPoolQuotaSummary(accounts.map((account) => ({
    ...account,
    id: String(account.id || ""),
    access_token: String(account.access_token || "")
  })), undefined, { ignoreFiveHourLimit: ignoreFiveHour });
  const total = accounts.length;
  return {
    available: available > 0,
    infos: [],
    summary: `${available}/${total} 个可用账号 · ${credits} 次重置额度`,
    checkedAt: null,
    error: null,
    subscriptionPool: {
      totalAccounts: total,
      enabledAccounts: enabledAccounts.length,
      availableAccounts: available,
      quotaCapacityPercent: quota.capacity_percent,
      fiveHourRemainingPercent: ignoreFiveHour ? null : quota.primary.remaining_percent,
      sevenDayRemainingPercent: quota.secondary.remaining_percent,
      resetCredits: credits
    }
  };
}

function parseStoredBalance(row: SqlRow) {
  const parsed = parseJsonObject(row.balance_json);
  const infos = Array.isArray(parsed.infos) ? parsed.infos.filter(isObject).map((item) => ({
    currency: String(item.currency || ""), totalBalance: moneyText(item.totalBalance),
    grantedBalance: moneyText(item.grantedBalance), toppedUpBalance: moneyText(item.toppedUpBalance)
  })) : [];
  return {
    available: typeof parsed.available === "boolean" ? parsed.available : null,
    infos,
    summary: parsed.summary ? String(parsed.summary) : null,
    checkedAt: numberOrNull(row.balance_checked_at),
    error: row.balance_error ? String(row.balance_error) : null,
    subscriptionPool: null
  };
}

function parseDeepSeekBalance(payload: Record<string, unknown>) {
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos.filter(isObject).map((item) => ({
    currency: String(item.currency || ""), totalBalance: moneyText(item.total_balance),
    grantedBalance: moneyText(item.granted_balance), toppedUpBalance: moneyText(item.topped_up_balance)
  })) : [];
  return { available: payload.is_available === true, infos, summary: null, checkedAt: now(), error: null, subscriptionPool: null };
}

function parseModelCatalog(raw: string): CatalogModel[] {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw upstreamError("INVALID_MODEL_CATALOG", "模型 JSON 不是有效 JSON。" ); }
  if (!isObject(payload) || !Array.isArray(payload.models) || payload.models.length === 0) {
    throw upstreamError("INVALID_MODEL_CATALOG", "模型 JSON 必须包含非空 models 数组。" );
  }
  if (payload.models.length > 200) throw upstreamError("INVALID_MODEL_CATALOG", "单个上游最多配置 200 个模型。" );
  const seen = new Set<string>();
  return payload.models.map((entry) => {
    if (!isObject(entry)) throw upstreamError("INVALID_MODEL_CATALOG", "models 中每一项必须是对象。" );
    const slug = String(entry.slug || "").trim();
    if (!slug || slug.length > 200) throw upstreamError("INVALID_MODEL_CATALOG", "每个模型必须包含有效的 slug。" );
    if (seen.has(slug)) throw upstreamError("DUPLICATE_MODEL_SLUG", `模型 JSON 中存在重复 slug：${slug}`);
    seen.add(slug);
    return { slug, displayName: String(entry.display_name || slug).trim() || slug, metadata: entry };
  });
}

function assertUniqueModelOwners(db: DatabaseSync, upstreamId: string, slugs: string[]): void {
  const find = db.prepare(`
    SELECT upstreams.name FROM upstream_models
    JOIN upstreams ON upstreams.id = upstream_models.upstream_id
    WHERE upstream_models.model_id = ? AND upstream_models.available = 1
      AND upstream_models.upstream_id <> ? LIMIT 1
  `);
  for (const slug of slugs) {
    const owner = find.get(slug, upstreamId) as SqlRow | undefined;
    if (owner) throw upstreamError("MODEL_SLUG_CONFLICT", `模型 ${slug} 已属于上游“${owner.name}”，模型 ID 必须全局唯一。`);
  }
}

function normalizeInput(input: SaveResponsesApiUpstreamInput) {
  const name = String(input.name || "").trim();
  if (!name || name.length > 80) throw upstreamError("INVALID_UPSTREAM", "上游名称长度必须为 1-80 个字符。" );
  return {
    id: String(input.id || "").trim() || null, name,
    baseUrl: normalizeHttpUrl(input.baseUrl, "上游 Base URL"),
    apiKey: String(input.apiKey || "").trim(), enabled: input.enabled !== false,
    supportsWebSocket: Boolean(input.supportsWebSocket),
    compactAdaptEnabled: input.compactAdaptEnabled !== false,
    balanceQueryType: balanceQueryType(input.balanceQueryType),
    publicHeaders: normalizeHeaderMap(input.publicHeaders, "公开请求头"),
    secretHeaders: input.secretHeaders === undefined ? undefined : normalizeHeaderMap(input.secretHeaders, "机密请求头"),
    modelCatalogJson: String(input.modelCatalogJson || "").trim(),
    modelPricing: isObject(input.modelPricing) ? input.modelPricing as Record<string, ModelPricing> : {}
  };
}

function recordRequestOutcome(db: DatabaseSync, upstreamId: string, outcome: { status?: number; latencyMs: number; message?: string }): void {
  const row = requireUpstream(db, upstreamId);
  if (row.kind !== "responses_api") return;
  const code = Number(outcome.status || 0);
  const unhealthy = code === 0 || code === 401 || code === 403 || code === 429 || code >= 500;
  saveHealthResult(db, row, {
    upstreamId, status: unhealthy ? "unhealthy" : "healthy", checkedAt: now(),
    latencyMs: Math.max(0, Math.trunc(outcome.latencyMs)),
    message: String(outcome.message || (code ? `请求返回 HTTP ${code}` : "上游网络请求失败")).slice(0, 500)
  });
}

function saveHealthResult(db: DatabaseSync, row: SqlRow, result: UpstreamHealthResult): void {
  const state = parseJsonObject(row.capabilities_json);
  state.health = result;
  db.prepare("UPDATE upstreams SET capabilities_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(state), now(), result.upstreamId);
}

function parseHealth(value: unknown) {
  const source = isObject(value) ? value : {};
  return {
    status: source.status === "healthy" || source.status === "unhealthy" ? source.status : "unknown" as const,
    checkedAt: numberOrNull(source.checkedAt), latencyMs: finiteNumberOrNull(source.latencyMs),
    message: source.message ? String(source.message).slice(0, 500) : null
  };
}

function balanceEndpoint(type: BalanceQueryType, baseUrl: string): string {
  if (type === "deepseek") return new URL("/user/balance", normalizeHttpUrl(baseUrl, "上游 Base URL")).toString();
  throw upstreamError("BALANCE_UNSUPPORTED", "未配置余额查询方式。" );
}

function balanceQueryType(value: unknown): BalanceQueryType {
  return value === "deepseek" ? "deepseek" : "none";
}

function normalizePricing(value: unknown): ModelPricing {
  const source = isObject(value) ? value : {};
  return {
    inputPerMillion: price(source.inputPerMillion),
    cachedInputPerMillion: price(source.cachedInputPerMillion),
    outputPerMillion: price(source.outputPerMillion)
  };
}

function price(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) return 0;
  return Math.round(number * 10_000) / 10_000;
}

function normalizeHttpUrl(value: unknown, label: string): string {
  let url: URL;
  try { url = new URL(String(value || "").trim()); } catch { throw upstreamError("INVALID_UPSTREAM", `${label}不是有效 URL。`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw upstreamError("INVALID_UPSTREAM", `${label}只支持 HTTP 或 HTTPS。`);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

const FORBIDDEN_HEADERS = new Set(["authorization", "content-length", "cookie", "host", "connection", "upgrade", "chatgpt-account-id"]);

function normalizeHeaderMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw upstreamError("INVALID_UPSTREAM_HEADERS", `${label}必须是对象。`);
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw upstreamError("INVALID_UPSTREAM_HEADERS", `请求头 ${name || rawName} 无效或由网关管理。`);
    }
    const text = String(rawValue ?? "").trim();
    if (!text || text.length > 4096 || /[\r\n]/.test(text)) throw upstreamError("INVALID_UPSTREAM_HEADERS", `请求头 ${name} 的值无效。`);
    result[name] = text;
  }
  return result;
}

function normalizeStoredHeaderMap(value: unknown): Record<string, string> {
  try { return normalizeHeaderMap(value, "已保存请求头"); } catch { return {}; }
}

function decryptSecretHeaders(secretCodec: SecretCodec, encrypted: unknown): Record<string, string> {
  if (!encrypted) return {};
  try { return normalizeStoredHeaderMap(JSON.parse(secretCodec.decrypt(String(encrypted)))); } catch { return {}; }
}

function requestHeadersFromRow(row: SqlRow, secretCodec: SecretCodec) {
  const state = parseJsonObject(row.capabilities_json);
  return { ...normalizeStoredHeaderMap(state.requestHeaders), ...decryptSecretHeaders(secretCodec, row.custom_headers_encrypted_json) };
}

function secretHeaderSummary(headers: Record<string, string>) {
  return Object.entries(headers).map(([name, value]) => ({ name, fingerprint: createHash("sha256").update(value).digest("hex").slice(0, 10) }));
}

async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw upstreamError("RESPONSE_TOO_LARGE", "上游响应超过大小限制。" ); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function invocationOutputPreview(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text.slice(0, 500);
  const parts: string[] = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!isObject(item)) continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (isObject(content) && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").slice(0, 500);
}

function requireUpstream(db: DatabaseSync, upstreamId: string): SqlRow {
  const row = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(String(upstreamId || "").trim()) as SqlRow | undefined;
  if (!row) throw upstreamError("UPSTREAM_NOT_FOUND", "API 上游不存在。" );
  return row;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  try { const parsed = JSON.parse(String(value || "{}")); return isObject(parsed) ? parsed : {}; } catch { return {}; }
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function moneyText(value: unknown): string {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function finiteNumberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function upstreamError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const errorName = (error: unknown): string => error instanceof Error ? error.name : "";
const now = (): number => Math.floor(Date.now() / 1000);
