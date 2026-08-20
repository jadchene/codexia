import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PublicAccount } from "../shared/contracts/accounts";
import type { Settings } from "../shared/contracts/settings";

const EDITABLE_SETTING_KEYS = new Set([
  "gateway_host", "gateway_port", "gateway_api_key", "upstream_base_url",
  "gateway_connect_timeout_ms", "gateway_stream_idle_timeout_ms", "gateway_unary_timeout_ms",
  "gateway_shutdown_grace_ms", "gateway_request_body_limit_bytes", "gateway_error_body_limit_bytes",
  "gateway_compaction_response_limit_bytes",
  "gateway_max_concurrent_requests", "gateway_websocket_max_connections", "gateway_websocket_max_payload_bytes",
  "gateway_websocket_buffer_high_water_bytes", "gateway_websocket_pending_queue_limit_bytes",
  "gateway_websocket_idle_timeout_ms", "gateway_quota_cooldown_ms", "gateway_session_affinity_ttl_hours",
  "gateway_websocket_reject_http_only_model_upgrade",
  "usage_refresh_interval_secs", "usage_refresh_timeout_ms", "auto_start_gateway", "auto_start_mcp_gateway",
  "mcp_gateway_config_path", "mcp_gateway_host", "mcp_gateway_port", "mcp_gateway_path",
  "startup_launch", "close_behavior", "codex_quota_headers_mode",
  "ignore_five_hour_limit", "codex_config_use_openai_base_url",
  "debug_api_logging",
  "auto_review_upstream_model",
  "billing_currency", "request_log_retention_days", "app_log_retention_days",
  "appearance_theme", "appearance_density", "navigation_collapsed"
]);

const INTEGER_SETTINGS: Record<string, readonly [number, number]> = {
  gateway_port: [1, 65535],
  gateway_connect_timeout_ms: [1000, 600000],
  gateway_stream_idle_timeout_ms: [1000, 3600000],
  gateway_unary_timeout_ms: [1000, 3600000],
  gateway_shutdown_grace_ms: [100, 60000],
  gateway_request_body_limit_bytes: [1024, 1073741824],
  gateway_error_body_limit_bytes: [1024, 67108864],
  gateway_compaction_response_limit_bytes: [1024, 1073741824],
  gateway_max_concurrent_requests: [1, 10000],
  gateway_websocket_max_connections: [1, 10000],
  gateway_websocket_max_payload_bytes: [1024, 1073741824],
  gateway_websocket_buffer_high_water_bytes: [1024, 1073741824],
  gateway_websocket_pending_queue_limit_bytes: [1024, 1073741824],
  gateway_websocket_idle_timeout_ms: [1000, 3600000],
  gateway_quota_cooldown_ms: [1000, 3600000],
  gateway_session_affinity_ttl_hours: [1, 8760],
  usage_refresh_interval_secs: [0, 86400],
  usage_refresh_timeout_ms: [1000, 300000],
  mcp_gateway_port: [1, 65535],
  request_log_retention_days: [1, 3650],
  app_log_retention_days: [1, 3650]
};

const ENUM_SETTINGS = {
  auto_start_gateway: ["true", "false"],
  auto_start_mcp_gateway: ["true", "false"],
  startup_launch: ["disabled", "auto", "delayed"],
  close_behavior: ["exit", "tray"],
  codex_quota_headers_mode: ["block", "rewrite"],
  ignore_five_hour_limit: ["true", "false"],
  debug_api_logging: ["true", "false"],
  codex_config_use_openai_base_url: ["true", "false"],
  gateway_websocket_reject_http_only_model_upgrade: ["true", "false"],
  appearance_theme: ["light", "dark", "system"],
  appearance_density: ["comfortable", "compact"],
  navigation_collapsed: ["true", "false"],
  billing_currency: ["USD", "CNY", "EUR", "JPY"]
};

export function publicAccount(account: Record<string, unknown> | null | undefined): PublicAccount | null | undefined {
  if (!account) return account;
  const { id_token: _idToken, access_token, refresh_token, raw_usage_json: _rawUsage, ...safe } = account;
  return {
    ...(safe as unknown as Omit<PublicAccount, "has_access_token" | "has_refresh_token">),
    has_access_token: Boolean(access_token),
    has_refresh_token: Boolean(refresh_token)
  };
}
export function publicSettings(settings: Settings): Settings {
  const gatewayApiKey = String(settings.gateway_api_key || "");
  const {
    gateway_api_key: _gatewayApiKey,
    codex_bundled_override_enabled: _bundledOverrideEnabled,
    codex_bundled_override_json: _bundledOverrideJson,
    ...safe
  } = settings;
  return {
    ...safe,
    gateway_api_key_configured: gatewayApiKey ? "true" : "false",
    gateway_api_key_fingerprint: gatewayApiKey
      ? createHash("sha256").update(gatewayApiKey).digest("hex").slice(0, 12)
      : ""
  };
}
export function editableSettingsPatch(patch: unknown): Settings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("设置内容格式错误。");
  const result: Settings = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_SETTING_KEYS.has(key)) continue;
    const text = String(value ?? "").trim();
    if (text.length > 4096) throw new Error(`设置项过长：${key}`);
    const integerRange = INTEGER_SETTINGS[key as keyof typeof INTEGER_SETTINGS];
    const enumValues = ENUM_SETTINGS[key as keyof typeof ENUM_SETTINGS];
    if (integerRange) validateIntegerSetting(key, text, integerRange);
    if (enumValues && !enumValues.includes(text)) throw new Error(`设置项取值无效：${key}`);
    if (key === "gateway_api_key" && /[\u0000-\u001f\u007f]/.test(text)) throw new Error("API Key 不能包含控制字符。");
    result[key] = text;
  }
  validateHost("gateway_host", result.gateway_host);
  validateHost("mcp_gateway_host", result.mcp_gateway_host);
  if (result.upstream_base_url) validateHttpUrl(result.upstream_base_url);
  if (result.mcp_gateway_path && (!result.mcp_gateway_path.startsWith("/") || /[?#\s]/.test(result.mcp_gateway_path))) {
    throw new Error("MCP 路径必须以 / 开头，且不能包含空格、查询参数或片段。");
  }
  return result;
}

function validateIntegerSetting(key: string, value: string, [min, max]: readonly [number, number]): void {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`设置项超出范围：${key}（${min}-${max}）`);
  }
}

function validateHost(key: string, value: string | undefined): void {
  if (!value) return;
  if (!/^[A-Za-z0-9.:[\]_-]+$/.test(value)) throw new Error(`监听主机格式无效：${key}`);
}

function validateHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("上游地址不是有效 URL。");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("上游地址只支持 HTTP 或 HTTPS。");
}

export function isTrustedRendererUrl(value: string, options: {
  packaged: boolean;
  devOrigin: string;
  indexFile: string;
}): boolean {
  try {
    const url = new URL(value);
    if (!options.packaged) return url.origin === options.devOrigin;
    return url.protocol === "file:" && path.resolve(fileURLToPath(url)) === path.resolve(options.indexFile);
  } catch {
    return false;
  }
}
