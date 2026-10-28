import type { PageResult } from "./common";

export interface RequestLogModels {
  clientModels: string[];
  upstreamModels: string[];
}

export interface LogQuery {
  page: number;
  pageSize: number;
  startAt: number;
  endAt: number;
  accountId?: string;
  upstreamId?: string;
  clientModel?: string;
  upstreamModel?: string;
  sessionId?: string;
  status?: string;
  keyword?: string;
  level?: string;
  scope?: string;
}

export interface RequestLog {
  id: number;
  account_id?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  method?: string;
  request_path?: string | null;
  upstream_path?: string | null;
  session_id?: string | null;
  version?: string | null;
  status?: number | string | null;
  duration_ms?: number | null;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  message?: string | null;
  upstream_id?: string | null;
  upstream_name?: string | null;
  upstream_kind?: string | null;
  client_model?: string | null;
  upstream_model?: string | null;
  attempt_count?: number;
  attempt_chain_json?: string | null;
  fallback_from?: string | null;
  fallback_reason?: string | null;
  credential_ref?: string | null;
  estimated_cost?: number | null;
  cost_unit?: string | null;
  /** 客户端请求的原始优先级。 */
  requested_service_tier?: string | null;
  /** 当次费用估算采用的优先级。 */
  service_tier?: string | null;
  /** 计费依据：请求声明或默认标准；response 仅兼容历史记录。 */
  service_tier_source?: "response" | "request" | "default" | null;
  /** 结算时的倍率快照，历史记录不受后续设置影响。 */
  service_tier_multiplier?: number | null;
  created_at: number;
}

export interface AppLog {
  id: number;
  level: string;
  scope?: string | null;
  action?: string | null;
  status?: string | null;
  message?: string | null;
  created_at: number;
}

export interface RequestLogPage extends PageResult<RequestLog> {
  startAt?: number;
  endAt?: number;
  query?: LogQuery;
}

export interface AppLogPage extends PageResult<AppLog> {
  startAt?: number;
  endAt?: number;
  query?: LogQuery;
}

export interface TokenTotals {
  calls?: number;
  errors?: number;
  fallback_count?: number;
  average_duration_ms?: number;
  estimated_cost?: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface TokenAccountSummary extends TokenTotals {
  account_id?: string | null;
  account_name?: string;
  upstream_id?: string | null;
  upstream_name?: string | null;
}

export interface TokenSummary {
  total: TokenTotals;
  byAccount: TokenAccountSummary[];
}
