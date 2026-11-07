import { normalizeServiceTier } from "../shared/service-tier.ts";
type Db = any;
type Row = Record<string, any>;

export function addTokenLog(db: Db, entry: Row): void {
  db.prepare(`
    INSERT INTO request_logs (
      account_id, method, request_path, upstream_path, session_id, version, status, duration_ms,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      message, upstream_id, upstream_name, upstream_kind, client_model, upstream_model,
      attempt_count, attempt_chain_json, fallback_from, fallback_reason, credential_ref, estimated_cost, cost_unit,
      requested_service_tier, service_tier, service_tier_source, service_tier_multiplier,
      created_at
    )
    VALUES (
      @account_id, @method, @request_path, @upstream_path, @session_id, @version, @status, @duration_ms,
      @input_tokens, @cached_input_tokens, @output_tokens, @reasoning_output_tokens, @total_tokens,
      @message, @upstream_id, @upstream_name, @upstream_kind, @client_model, @upstream_model,
      @attempt_count, @attempt_chain_json, @fallback_from, @fallback_reason, @credential_ref, @estimated_cost, @cost_unit,
      @requested_service_tier, @service_tier, @service_tier_source, @service_tier_multiplier,
      @created_at
    )
  `).run({
    account_id: entry.account_id || null,
    method: entry.method || "GET",
    request_path: entry.request_path || null,
    upstream_path: entry.upstream_path || null,
    session_id: entry.session_id || null,
    version: entry.version || null,
    status: entry.status || null,
    duration_ms: entry.duration_ms || null,
    input_tokens: toInt(entry.input_tokens),
    cached_input_tokens: toInt(entry.cached_input_tokens),
    output_tokens: toInt(entry.output_tokens),
    reasoning_output_tokens: toInt(entry.reasoning_output_tokens),
    total_tokens: toInt(entry.total_tokens),
    message: entry.message || null,
    upstream_id: entry.upstream_id || null,
    upstream_name: entry.upstream_name || null,
    upstream_kind: entry.upstream_kind || null,
    client_model: entry.client_model || null,
    upstream_model: entry.upstream_model || null,
    attempt_count: Math.max(1, toInt(entry.attempt_count || 1)),
    attempt_chain_json: normalizeAttemptChainJson(entry.attempt_chain_json),
    fallback_from: entry.fallback_from || null,
    fallback_reason: entry.fallback_reason || null,
    credential_ref: entry.credential_ref || null,
    estimated_cost: entry.estimated_cost != null && Number.isFinite(Number(entry.estimated_cost)) ? Number(entry.estimated_cost) : null,
    cost_unit: entry.cost_unit || null,
    requested_service_tier: normalizeServiceTier(entry.requested_service_tier),
    service_tier: normalizeServiceTier(entry.service_tier),
    service_tier_source: ["response", "request", "default"].includes(entry.service_tier_source) ? entry.service_tier_source : null,
    service_tier_multiplier: typeof entry.service_tier_multiplier === "number" && Number.isFinite(entry.service_tier_multiplier) && entry.service_tier_multiplier >= 0
      ? entry.service_tier_multiplier : null,
    created_at: entry.created_at ?? Math.floor(Date.now() / 1000)
  });
}

function cleanFilterValue(value: unknown): string {
  const text = String(value || "").trim();
  return text ? text.slice(0, 240) : "";
}

function normalizeAttemptChainJson(value: unknown): string | null {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return null;
    const chain = parsed.slice(0, 64).map((entry, index) => {
      const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Row : {};
      const status = Number(source.status);
      return {
        attempt: clampInt(source.attempt, index + 1, 1, 64),
        targetId: cleanFilterValue(source.targetId),
        targetName: cleanFilterValue(source.targetName),
        kind: cleanFilterValue(source.kind),
        outcome: cleanFilterValue(source.outcome),
        ...(Number.isFinite(status) && status > 0 ? { status: Math.trunc(status) } : {}),
        fallbackReason: cleanFilterValue(source.fallbackReason)
      };
    });
    return JSON.stringify(chain);
  } catch {
    return null;
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function toInt(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
