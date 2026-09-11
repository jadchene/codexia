import type { IncomingHttpHeaders } from "node:http";
import type { Settings } from "../shared/contracts/settings";
import type { TokenUsage } from "./gateway/usage-parser.ts";
import type { ModelPricing } from "../shared/contracts/upstreams";
import { estimateUpstreamCost } from "./upstreams/cost-estimator.ts";

interface LogAccount {
  id: string;
}

interface LogTarget {
  id?: string;
  name?: string;
  kind?: string;
  clientModel?: string;
  upstreamModel?: string;
  credentialRef?: string;
  attemptCount?: number;
  attemptChain?: Array<Record<string, unknown>>;
  modelPricing?: ModelPricing;
}

interface ResponsesRequestLogInput {
  account?: LogAccount | null;
  target?: LogTarget | null;
  method: string;
  requestPath: string;
  upstreamPath: string;
  headers: IncomingHttpHeaders;
  status: number;
  durationMs: number;
  usage: TokenUsage;
  settings: Settings;
  clientModel?: string;
  upstreamModel?: string;
  modelPricing?: ModelPricing | null | undefined;
  message?: string | null;
}

/**
 * 生成 HTTP 与 WebSocket 共用的 Responses 调用日志字段。
 */
export const buildResponsesRequestLog = (input: ResponsesRequestLogInput): Record<string, unknown> => {
  const estimated = estimateUpstreamCost(
    input.usage,
    input.target?.modelPricing || input.modelPricing,
    input.settings.billing_currency
  );
  return {
    account_id: input.account?.id || null,
    upstream_id: input.target?.id || (input.account ? "builtin-chatgpt-subscription-pool" : null),
    upstream_name: input.target?.name || (input.account ? "ChatGPT 订阅账号池" : null),
    upstream_kind: input.target?.kind || (input.account ? "chatgpt_subscription_pool" : null),
    client_model: input.target?.clientModel || input.clientModel || null,
    upstream_model: input.target?.upstreamModel || input.upstreamModel || input.clientModel || null,
    credential_ref: input.target?.credentialRef || input.account?.id || null,
    attempt_count: input.target?.attemptCount || 1,
    attempt_chain_json: JSON.stringify(input.target?.attemptChain || []),
    method: input.method,
    request_path: input.requestPath,
    upstream_path: input.upstreamPath,
    session_id: sessionHeaderValue(input.headers),
    version: headerValue(input.headers, "version"),
    status: input.status,
    duration_ms: input.durationMs,
    ...input.usage,
    ...(estimated ? { estimated_cost: estimated.amount, cost_unit: estimated.unit } : {}),
    message: input.message || null
  };
};

export const headerValue = (headers: IncomingHttpHeaders, name: string): string => {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) return String(Array.isArray(value) ? value[0] || "" : value || "");
  }
  return "";
};

const sessionHeaderValue = (headers: IncomingHttpHeaders): string => (
  headerValue(headers, "session_id")
  || headerValue(headers, "session-id")
  || headerValue(headers, "x-session-id")
);
