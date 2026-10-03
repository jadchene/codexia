import { quotaPlanMultiplier, type QuotaNormalizationOptions } from "../../shared/quota-normalization.ts";

export interface GatewayAccountQuota {
  id: string;
  name?: string;
  email?: string;
  enabled?: boolean | number;
  status?: string;
  access_token?: string;
  quota_5h_used_percent?: number | string | null;
  quota_5h_reset_at?: number | string | null;
  quota_7d_used_percent?: number | string | null;
  quota_7d_reset_at?: number | string | null;
  [key: string]: unknown;
}

interface UsageUpdate {
  quota_5h_used_percent?: number;
  quota_5h_reset_at?: number;
  quota_7d_used_percent?: number;
  quota_7d_reset_at?: number;
  raw_usage_json?: string;
  [key: string]: unknown;
}

interface UsageStore {
  getSettings?: () => Record<string, unknown>;
  updateUsage?: (accountId: string, usage: UsageUpdate) => unknown;
}

interface HeaderSource {
  get?: (name: string) => string | null;
  [Symbol.iterator]?: () => Iterator<[string, string]>;
}

type HeaderRecord = Record<string, string | string[] | number | undefined>;

export interface QuotaOptions extends QuotaNormalizationOptions {
  ignoreFiveHourLimit?: boolean;
}

interface ResetCandidate {
  id: string;
  email: string;
  reset_at: number;
  reset_after_seconds: number;
}

interface ResetDetail {
  value: number;
  selected: ResetCandidate | null;
  candidates: ResetCandidate[];
}

export interface CodexQuotaSnapshot {
  primary: {
    used_percent: number;
    window_minutes: number;
    reset_after_seconds: number;
    reset_at: number;
  };
  secondary: {
    used_percent: number;
    window_minutes: number;
    reset_after_seconds: number;
    reset_at: number;
  };
  plan_type: string;
  active_limit: string;
  credits: {
    balance: number;
    has_credits: boolean;
    unlimited: boolean;
  };
}

export interface AccountPoolQuotaSummary {
  capacity_percent: number;
  primary: {
    remaining_percent: number;
    reset_after_seconds: number;
    reset_at: number;
  };
  secondary: {
    remaining_percent: number;
    reset_after_seconds: number;
    reset_at: number;
  };
}

export function syncAccountUsageFromHeaders(
  account: GatewayAccountQuota | null | undefined,
  headers: HeaderSource | HeaderRecord | null | undefined,
  store: UsageStore | null | undefined
): boolean {
  if (!account?.id || !headers || !store?.updateUsage) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const usage: UsageUpdate = {};
  const primaryUsed = numberHeader(headers, "x-codex-primary-used-percent");
  const primaryResetAfter = numberHeader(headers, "x-codex-primary-reset-after-seconds");
  const secondaryUsed = numberHeader(headers, "x-codex-secondary-used-percent");
  const secondaryResetAfter = numberHeader(headers, "x-codex-secondary-reset-after-seconds");
  const primaryMinutes = numberHeader(headers, "x-codex-primary-window-minutes") ?? 300;
  const secondaryMinutes = numberHeader(headers, "x-codex-secondary-window-minutes") ?? 10080;

  const settings = store.getSettings?.() ?? {};
  for (const window of [
    { used: primaryUsed, resetAfter: primaryResetAfter, minutes: primaryMinutes },
    { used: secondaryUsed, resetAfter: secondaryResetAfter, minutes: secondaryMinutes }
  ]) {
    if (window.minutes !== 300 && window.minutes !== 10080) continue;
    const weekly = window.minutes === 10080;
    if (!weekly && settings.ignore_five_hour_limit === "true") continue;
    applyQuotaHeaderWindow(usage, account, {
      used: window.used,
      resetAfter: window.resetAfter,
      usedField: weekly ? "quota_7d_used_percent" : "quota_5h_used_percent",
      resetField: weekly ? "quota_7d_reset_at" : "quota_5h_reset_at",
      nowSeconds
    });
    if (!weekly && (usage.quota_5h_used_percent !== undefined || usage.quota_5h_reset_at !== undefined)) usage.has_five_hour_quota = 1;
  }
  if (Object.keys(usage).length === 0) return false;
  if (primaryMinutes === 10080 && secondaryUsed === null && secondaryResetAfter === null) {
    usage.has_five_hour_quota = 0;
    if (usage.quota_7d_used_percent !== undefined) usage.quota_5h_used_percent = usage.quota_7d_used_percent;
    if (usage.quota_7d_reset_at !== undefined) usage.quota_5h_reset_at = usage.quota_7d_reset_at;
  }

  usage.raw_usage_json = JSON.stringify({
    source: "gateway-response-headers",
    at: nowSeconds,
    headers: {
      "x-codex-primary-used-percent": headerGet(headers, "x-codex-primary-used-percent"),
      "x-codex-primary-reset-after-seconds": headerGet(headers, "x-codex-primary-reset-after-seconds"),
      "x-codex-secondary-used-percent": headerGet(headers, "x-codex-secondary-used-percent"),
      "x-codex-secondary-reset-after-seconds": headerGet(headers, "x-codex-secondary-reset-after-seconds")
    }
  });
  store.updateUsage(account.id, usage);
  return true;
}

/** 按实际窗口时长保存流式额度事件，兼容只有周额度的账号。 */
export const syncAccountUsageFromEvent = (
  account: GatewayAccountQuota | null | undefined,
  event: Record<string, any>,
  store: UsageStore
): boolean => {
  if (event.type !== "codex.rate_limits" || !account?.id || !store.updateUsage) return false;
  const limits = event.rate_limits;
  if (!limits || typeof limits !== "object") return false;
  const headers: HeaderRecord = {};
  for (const name of ["primary", "secondary"]) {
    const window = limits[name] ?? limits[`${name}_window`];
    if (!window || typeof window !== "object") continue;
    const minutes = window.window_minutes ?? (window.limit_window_seconds != null ? Number(window.limit_window_seconds) / 60 : undefined);
    if (window.used_percent != null) headers[`x-codex-${name}-used-percent`] = window.used_percent;
    if (minutes != null) headers[`x-codex-${name}-window-minutes`] = minutes;
    const resetAfter = window.reset_after_seconds ?? (window.reset_at != null ? Number(window.reset_at) - Math.floor(Date.now() / 1000) : undefined);
    if (resetAfter != null) headers[`x-codex-${name}-reset-after-seconds`] = resetAfter;
  }
  return syncAccountUsageFromHeaders(account, headers, {
    getSettings: () => store.getSettings?.() ?? {},
    updateUsage: (id, usage) => store.updateUsage!(id, {
      ...usage,
      raw_usage_json: JSON.stringify({ source: "gateway-stream-event", at: Math.floor(Date.now() / 1000), event })
    })
  });
};

export function buildCodexQuotaHeaders(
  accounts: GatewayAccountQuota[],
  nowSeconds = Math.floor(Date.now() / 1000),
  options: QuotaOptions = {}
): Record<string, string> {
  return buildCodexQuotaHeaderDetail(accounts, nowSeconds, options).headers;
}

export function buildCodexQuotaHeaderDetail(
  accounts: GatewayAccountQuota[],
  nowSeconds = Math.floor(Date.now() / 1000),
  options: QuotaOptions = {}
) {
  const detail = buildCodexQuotaSnapshotDetail(accounts, nowSeconds, options);
  const { snapshot, primary, secondary } = detail;
  const headers = {
    "x-codex-primary-used-percent": formatHeaderNumber(snapshot.primary.used_percent),
    "x-codex-primary-window-minutes": String(snapshot.primary.window_minutes),
    "x-codex-primary-reset-after-seconds": String(snapshot.primary.reset_after_seconds),
    "x-codex-secondary-used-percent": formatHeaderNumber(snapshot.secondary.used_percent),
    "x-codex-secondary-window-minutes": String(snapshot.secondary.window_minutes),
    "x-codex-secondary-reset-after-seconds": String(snapshot.secondary.reset_after_seconds),
    "x-codex-plan-type": snapshot.plan_type,
    "x-codex-active-limit": snapshot.active_limit,
    "x-codex-credits-balance": String(snapshot.credits.balance),
    "x-codex-credits-has-credits": String(snapshot.credits.has_credits),
    "x-codex-credits-unlimited": String(snapshot.credits.unlimited)
  };
  return { headers, nowSeconds, accountCount: detail.accountCount, primary, secondary };
}

export function buildCodexQuotaSnapshot(
  accounts: GatewayAccountQuota[],
  nowSeconds = Math.floor(Date.now() / 1000),
  options: QuotaOptions = {}
): CodexQuotaSnapshot {
  return buildCodexQuotaSnapshotDetail(accounts, nowSeconds, options).snapshot;
}

export function buildAccountPoolQuotaSummary(
  accounts: GatewayAccountQuota[],
  nowSeconds = Math.floor(Date.now() / 1000),
  options: QuotaOptions = {}
): AccountPoolQuotaSummary {
  return buildAccountPoolQuotaDetail(accounts, nowSeconds, options).summary;
}

export function buildExternalQuotaHeaders(): Record<string, string> {
  const snapshot = buildExternalQuotaSnapshot();
  return {
    "x-codex-primary-used-percent": "0",
    "x-codex-primary-window-minutes": String(snapshot.primary.window_minutes),
    "x-codex-primary-reset-after-seconds": "0",
    "x-codex-secondary-used-percent": "0",
    "x-codex-secondary-window-minutes": String(snapshot.secondary.window_minutes),
    "x-codex-secondary-reset-after-seconds": "0",
    "x-codex-plan-type": snapshot.plan_type,
    "x-codex-active-limit": snapshot.active_limit,
    "x-codex-credits-balance": "0",
    "x-codex-credits-has-credits": "false",
    "x-codex-credits-unlimited": "false"
  };
}

export function buildExternalQuotaSnapshot(): CodexQuotaSnapshot {
  return {
    primary: { used_percent: 0, window_minutes: 300, reset_after_seconds: 0, reset_at: 0 },
    secondary: { used_percent: 0, window_minutes: 10080, reset_after_seconds: 0, reset_at: 0 },
    plan_type: "api",
    active_limit: "none",
    credits: { balance: 0, has_credits: false, unlimited: false }
  };
}

function buildCodexQuotaSnapshotDetail(
  accounts: GatewayAccountQuota[],
  nowSeconds: number,
  options: QuotaOptions = {}
) {
  const detail = buildAccountPoolQuotaDetail(accounts, nowSeconds, options);
  const { pool, primary, secondary, summary } = detail;
  const ignoreFiveHour = options.ignoreFiveHourLimit === true;
  const secondaryUsed = roundHeaderPercent(protocolUsedPercent(summary.secondary.remaining_percent, summary.capacity_percent, options));
  const snapshot: CodexQuotaSnapshot = {
    primary: {
      used_percent: ignoreFiveHour
        ? secondaryUsed
        : roundHeaderPercent(protocolUsedPercent(summary.primary.remaining_percent, summary.capacity_percent, options)),
      window_minutes: ignoreFiveHour ? 10080 : 300,
      reset_after_seconds: summary.primary.reset_after_seconds,
      reset_at: summary.primary.reset_at
    },
    secondary: {
      used_percent: secondaryUsed,
      window_minutes: 10080,
      reset_after_seconds: summary.secondary.reset_after_seconds,
      reset_at: summary.secondary.reset_at
    },
    plan_type: "unknown",
    active_limit: ignoreFiveHour ? "secondary" : "primary",
    credits: { balance: 0, has_credits: false, unlimited: false }
  };
  return { snapshot, accountCount: pool.length, primary, secondary };
}

function buildAccountPoolQuotaDetail(
  accounts: GatewayAccountQuota[],
  nowSeconds: number,
  options: QuotaOptions
) {
  const pool = accounts.filter((account) => account
    && account.enabled
    && account.status !== "disabled"
    && account.access_token
    && quotaPlanMultiplier(account.subscription_plan, options) > 0);
  const primary = resetAfterSeconds(pool, "quota_5h_reset_at", nowSeconds);
  const secondary = resetAfterSeconds(pool, "quota_7d_reset_at", nowSeconds);
  const ignoreFiveHour = options.ignoreFiveHourLimit === true;
  const displayPercent = (value: number): number => options.normalizeQuotaToPlus ? value : roundDisplayPercent(value);
  const secondaryRemaining = displayPercent(totalRemainingPercent(pool, "quota_7d_used_percent", options));
  const summary: AccountPoolQuotaSummary = {
    capacity_percent: pool.reduce((sum, account) => sum + quotaPlanMultiplier(account.subscription_plan, options) * 100, 0),
    primary: {
      remaining_percent: ignoreFiveHour
        ? secondaryRemaining
        : displayPercent(totalRemainingPercent(pool, "quota_5h_used_percent", options)),
      reset_after_seconds: ignoreFiveHour ? secondary.value : primary.value,
      reset_at: ignoreFiveHour ? (secondary.selected?.reset_at ?? 0) : (primary.selected?.reset_at ?? 0)
    },
    secondary: {
      remaining_percent: secondaryRemaining,
      reset_after_seconds: secondary.value,
      reset_at: secondary.selected?.reset_at ?? 0
    }
  };
  return { pool, primary, secondary, summary };
}

export function isQuotaExhaustedResponse(status: unknown, body: unknown): boolean {
  if (![400, 403, 429].includes(Number(status))) return false;
  const normalized = bodyText(body).toLowerCase();
  return normalized.includes("rate_limit")
    || normalized.includes("limit_reached")
    || normalized.includes("usage_limit")
    || normalized.includes("quota")
    || normalized.includes("insufficient_quota")
    || normalized.includes("too many requests")
    || normalized.includes("exceeded");
}

export function isAuthExpiredResponse(status: unknown, body: unknown): boolean {
  if (![401, 403].includes(Number(status))) return false;
  const normalized = bodyText(body).toLowerCase();
  return Number(status) === 401
    || normalized.includes("invalid_token")
    || normalized.includes("expired")
    || normalized.includes("unauthorized")
    || normalized.includes("authentication");
}

function applyQuotaHeaderWindow(
  usage: UsageUpdate,
  account: GatewayAccountQuota,
  options: {
    used: number | null;
    resetAfter: number | null;
    usedField: "quota_5h_used_percent" | "quota_7d_used_percent";
    resetField: "quota_5h_reset_at" | "quota_7d_reset_at";
    nowSeconds: number;
  }
): void {
  const { used, resetAfter, usedField, resetField, nowSeconds } = options;
  const hasUsed = Number.isFinite(used);
  const hasReset = Number.isFinite(resetAfter);
  const resetSeconds = hasReset ? Math.max(0, Math.trunc(resetAfter as number)) : null;
  const existingUsed = Number(account[usedField]);
  const existingResetAt = Number(account[resetField]);
  const hasExistingPositiveUsage = Number.isFinite(existingUsed) && existingUsed > 0;
  const hasExistingFutureReset = Number.isFinite(existingResetAt) && existingResetAt > nowSeconds;
  const isAmbiguousZero = hasUsed
    && clampPercent(used as number) === 0
    && (!hasReset || resetSeconds === 0)
    && (hasExistingPositiveUsage || hasExistingFutureReset);

  if (hasUsed && !isAmbiguousZero) usage[usedField] = clampPercent(used as number);
  if (hasReset && resetSeconds !== null && resetSeconds > 0) usage[resetField] = nowSeconds + resetSeconds;
}

function numberHeader(headers: HeaderSource | HeaderRecord, name: string): number | null {
  const raw = headerGet(headers, name);
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function headerGet(headers: HeaderSource | HeaderRecord, name: string): unknown {
  if (typeof (headers as HeaderSource).get === "function") return (headers as HeaderSource).get?.(name) ?? null;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function totalRemainingPercent(accounts: GatewayAccountQuota[], field: keyof GatewayAccountQuota, options: QuotaOptions): number {
  return accounts
    .reduce((sum, account) => {
      const value = Number(account[field]);
      return Number.isFinite(value)
        ? sum + Math.max(0, 100 - clampPercent(value)) * quotaPlanMultiplier(account.subscription_plan, options)
        : sum;
    }, 0);
}

/** 启用折算时响应头使用总容量占比，关闭时保持原有叠加规则。 */
const protocolUsedPercent = (totalRemaining: number, capacity: number, options: QuotaOptions): number => {
  const remaining = options.normalizeQuotaToPlus ? (capacity > 0 ? totalRemaining / capacity * 100 : 0) : totalRemaining;
  return 100 - Math.min(100, Math.max(0, remaining));
};

function resetAfterSeconds(
  accounts: GatewayAccountQuota[],
  field: keyof GatewayAccountQuota,
  nowSeconds: number
): ResetDetail {
  let nearest: ResetCandidate | null = null;
  const candidates: ResetCandidate[] = [];
  for (const account of accounts) {
    const resetAt = Number(account[field]);
    if (!Number.isFinite(resetAt) || resetAt <= 0) continue;
    const item: ResetCandidate = {
      id: account.id,
      email: account.email || account.name || account.id,
      reset_at: resetAt,
      reset_after_seconds: Math.max(0, Math.trunc(resetAt - nowSeconds))
    };
    candidates.push(item);
    if (nearest === null || resetAt < nearest.reset_at) nearest = item;
  }
  return { value: nearest?.reset_after_seconds ?? 0, selected: nearest, candidates };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatHeaderNumber(value: number): string {
  const rounded = roundHeaderPercent(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function roundHeaderPercent(value: number): number {
  return Math.round(clampPercent(value) * 10) / 10;
}

function roundDisplayPercent(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function bodyText(body: unknown): string {
  return Buffer.isBuffer(body)
    ? body.toString("utf8", 0, Math.min(body.length, 4096))
    : String(body || "");
}
