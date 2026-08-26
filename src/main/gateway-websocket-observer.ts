import type { IncomingMessage } from "node:http";
import type { RawData } from "ws";
import type { Settings } from "../shared/contracts/settings";
import type { ModelPricing } from "../shared/contracts/upstreams";
import { estimateUpstreamCost } from "./upstreams/cost-estimator.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 1000;

interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}
interface ObserverAccount {
  id: string;
  email?: string;
  name?: string;
}
interface ObserverTarget {
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

interface ObserverStore {
  addTokenLog?: (entry: Record<string, unknown>) => unknown;
  updateUsage?: (id: string, usage: Record<string, unknown>) => unknown;
  addAppLog?: (entry: Record<string, unknown>) => unknown;
}

interface ObserverOptions {
  store: ObserverStore;
  account?: ObserverAccount | null;
  target?: ObserverTarget | null;
  request: IncomingMessage;
  requestPath: string;
  upstreamPath: string;
  helpers: {
    extractTokenUsage: (data: RawData) => TokenUsage;
    isQuotaExhaustedResponse: (status: number, data: RawData) => boolean;
  };
  settings: Settings;
  onIdleTimeout: () => void;
  routing: { setCooldown: (id: string, durationMs: number) => void; clearCooldown: (id: string) => void };
  hooks: { refreshAllUsage?: (reason: string) => Promise<Array<{ id: string; ok: boolean }>> };
}

interface CurrentRequest {
  startedAt: number;
  prewarm: boolean;
  clientModel: string;
  upstreamModel: string;
  usage: TokenUsage;
  outputStarted: boolean;
}
interface UpstreamObservation {
  reconnectForQuota: boolean;
}
type JsonEvent = Record<string, any>;

/**
 * Observes copies of WebSocket JSON messages without changing relay payloads.
 */
export function createWebSocketObserver(options: ObserverOptions) {
  const { store, account, target, request, requestPath, upstreamPath, helpers, settings, onIdleTimeout } = options;
  let currentRequest: CurrentRequest | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function onDownstreamMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    const event = parseJson(data);
    if (event?.type !== "response.create") return;
    currentRequest = {
      startedAt: Date.now(),
      prewarm: event.generate === false,
      clientModel: modelFromEvent(event),
      upstreamModel: modelFromEvent(event),
      usage: emptyUsage(),
      outputStarted: false
    };
    armIdleTimer();
  }

  function onUpstreamMessage(data: RawData, isBinary: boolean): UpstreamObservation {
    if (currentRequest) armIdleTimer();
    if (isBinary) return { reconnectForQuota: false };
    const event = parseJson(data);
    if (!event) return { reconnectForQuota: false };
    observeRateLimits(event);
    const quotaExhausted = observeQuotaError(event, data);
    const reconnectForQuota = Boolean(quotaExhausted && currentRequest && !currentRequest.outputStarted);
    if (!currentRequest) return { reconnectForQuota };
    if (!quotaExhausted && !retryNeutralEvent(event)) currentRequest.outputStarted = true;
    const observedModel = modelFromEvent(event);
    if (observedModel) {
      currentRequest.clientModel ||= observedModel;
      currentRequest.upstreamModel ||= observedModel;
    }
    const usage = helpers.extractTokenUsage(data);
    if (hasUsage(usage)) currentRequest.usage = usage;
    if (event.type === "response.completed") finishRequest(200, null);
    else if (isTerminalError(event)) finishRequest(errorStatus(event), errorMessage(event));
    return { reconnectForQuota };
  }

  function onClose(code: number, reason: Buffer): void {
    if (!currentRequest) return;
    const message = `WebSocket closed before response completion (${code}${reason?.length ? `: ${reason.toString()}` : ""})`;
    finishRequest(code === 1000 ? 499 : 502, message);
  }

  function finishRequest(status: number, message: string | null): void {
    if (!currentRequest) return;
    clearIdleTimer();
    const estimated = estimateUpstreamCost(currentRequest.usage, target?.modelPricing, settings.billing_currency);
    store.addTokenLog?.({
      account_id: account?.id || null,
      upstream_id: target?.id || (account ? "builtin-chatgpt-subscription-pool" : null),
      upstream_name: target?.name || (account ? "ChatGPT 订阅账号池" : null),
      upstream_kind: target?.kind || (account ? "chatgpt_subscription_pool" : null),
      client_model: target?.clientModel || currentRequest.clientModel || null,
      upstream_model: target?.upstreamModel || currentRequest.upstreamModel || null,
      credential_ref: target?.credentialRef || account?.id || null,
      attempt_count: target?.attemptCount || 1,
      attempt_chain_json: JSON.stringify(target?.attemptChain || []),
      method: "WS",
      request_path: requestPath,
      upstream_path: upstreamPath,
      session_id: headerValue(request.headers, "session_id")
        || headerValue(request.headers, "session-id")
        || headerValue(request.headers, "x-session-id"),
      version: headerValue(request.headers, "version"),
      status,
      duration_ms: Date.now() - currentRequest.startedAt,
      ...currentRequest.usage,
      ...(estimated ? { estimated_cost: estimated.amount, cost_unit: estimated.unit } : {}),
      message: currentRequest.prewarm
        ? ["WebSocket prewarm", message].filter(Boolean).join(": ")
        : message
    });
    currentRequest = null;
  }

  function observeRateLimits(event: JsonEvent): void {
    if (!account || event.type !== "codex.rate_limits") return;
    const usage: Record<string, unknown> = {};
    if (settings.ignore_five_hour_limit !== "true") {
      applyRateLimitWindow(usage, event.rate_limits?.primary, "quota_5h_used_percent", "quota_5h_reset_at");
    }
    applyRateLimitWindow(usage, event.rate_limits?.secondary, "quota_7d_used_percent", "quota_7d_reset_at");
    if (Object.keys(usage).length === 0) return;
    usage.raw_usage_json = JSON.stringify({ source: "gateway-websocket-event", at: Math.floor(Date.now() / 1000), event });
    store.updateUsage?.(account.id, usage);
  }

  function observeQuotaError(event: JsonEvent, data: RawData): boolean {
    if (!account || !isTerminalError(event) || !helpers.isQuotaExhaustedResponse(429, data)) return false;
    options.routing.setCooldown(account.id, positiveSetting(settings.gateway_quota_cooldown_ms, DEFAULT_QUOTA_COOLDOWN_MS));
    scheduleUsageRefresh(account, options.hooks, options.routing, store);
    return true;
  }

  function armIdleTimer(): void {
    clearIdleTimer();
    const timeoutMs = positiveSetting(settings.gateway_websocket_idle_timeout_ms, DEFAULT_IDLE_TIMEOUT_MS);
    idleTimer = setTimeout(onIdleTimeout, timeoutMs);
  }

  function clearIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  return {
    onDownstreamMessage,
    onUpstreamMessage,
    onClose,
    dispose: clearIdleTimer
  };
}

function applyRateLimitWindow(target: Record<string, unknown>, window: any, usedField: string, resetField: string): void {
  if (!window || typeof window !== "object") return;
  const used = Number(window.used_percent);
  const resetAt = Number(window.reset_at);
  if (Number.isFinite(used)) target[usedField] = Math.max(0, Math.min(100, used));
  if (Number.isFinite(resetAt) && resetAt > 0) target[resetField] = Math.trunc(resetAt);
}

function isTerminalError(event: JsonEvent | null): boolean {
  return event?.type === "error" || event?.type === "response.failed";
}

function errorStatus(event: JsonEvent): number {
  const value = Number(event?.status || event?.status_code || event?.error?.status || event?.error?.status_code);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function errorMessage(event: JsonEvent): string {
  const message = event?.error?.message || event?.message || event?.error?.code || event?.code || "WebSocket response failed.";
  return String(message).slice(0, 1000);
}

function retryNeutralEvent(event: JsonEvent): boolean {
  return event.type === "codex.rate_limits"
    || event.type === "response.created"
    || event.type === "response.in_progress"
    || isTerminalError(event);
}

function parseJson(data: RawData): JsonEvent | null {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function modelFromEvent(event: JsonEvent | null): string {
  const response = event?.response && typeof event.response === "object" ? event.response : {};
  return String(event?.model || response.model || "").trim();
}

function hasUsage(usage: TokenUsage | null | undefined): boolean {
  return Boolean(usage && Object.values(usage).some((value) => Number(value) > 0));
}

function emptyUsage(): TokenUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function headerValue(headers: IncomingMessage["headers"], name: string): string {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) return String(Array.isArray(value) ? value[0] || "" : value || "");
  }
  return "";
}

function positiveSetting(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function scheduleUsageRefresh(
  account: ObserverAccount,
  hooks: ObserverOptions["hooks"],
  routing: ObserverOptions["routing"],
  store: ObserverStore
): void {
  const refreshAllUsage = hooks?.refreshAllUsage;
  if (!refreshAllUsage) return;
  Promise.resolve()
    .then(() => refreshAllUsage("gateway-websocket-event-quota"))
    .then((results) => {
      if (!Array.isArray(results) || results.some((item) => item?.id === account.id && item.ok)) routing.clearCooldown(account.id);
    })
    .catch((error) => store.addAppLog?.({
      level: "warn",
      scope: "gateway-websocket",
      action: "quota-refresh",
      status: "failed",
      message: `WebSocket 配额事件后刷新账号状态失败：${account.email || account.name || account.id}: ${error instanceof Error ? error.message : String(error)}`
    }));
}
