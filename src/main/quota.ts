type JsonObject = Record<string, any>;

export interface NormalizedUsage {
  raw_usage_json: string;
  has_five_hour_quota?: number;
  quota_5h_used_percent?: number;
  quota_5h_reset_at?: number;
  quota_7d_used_percent?: number;
  quota_7d_reset_at?: number;
}
interface NormalizedCredit {
  id: string;
  status: string;
  title: string;
  granted_at: number | null;
  expires_at: number | null;
}
export function percentFromLimit(limit: unknown): number | null {
  if (!limit || typeof limit !== "object") return null;
  const source = limit as JsonObject;
  const used = Number(source.used ?? source.current ?? source.consumed);
  const total = Number(source.limit ?? source.total ?? source.quota);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

export function timestampFrom(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const cst = parseChinaStandardTime(value);
  if (cst !== null) return cst;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export function normalizeUsagePayload(payload: any): NormalizedUsage {
  const root = payload?.usage || payload?.snapshot || payload || {};
  const windows = collectRateLimitWindows(root);
  const fiveHour = windows.find((item) => Number(item.limit_window_seconds) === 18000)
    || root.gpt5 || root.codex || root.five_hour || root["5h"] || root.window_5h || {};
  const sevenDay = windows.find((item) => Number(item.limit_window_seconds) === 604800)
    || root.gpt5_weekly || root.weekly || root.seven_day || root["7d"] || root.window_7d || {};

  const isLimitReached = root.rate_limit?.limit_reached === true || root.rate_limit?.allowed === false;
  let fiveHourUsed = readUsedPercent(fiveHour) ?? finiteNumber(root.quota_5h_used_percent);
  let sevenDayUsed = readUsedPercent(sevenDay) ?? finiteNumber(root.quota_7d_used_percent);
  let fiveHourResetAt = timestampFrom(fiveHour.resets_at ?? fiveHour.reset_at ?? root.quota_5h_reset_at);
  const sevenDayResetAt = timestampFrom(sevenDay.resets_at ?? sevenDay.reset_at ?? root.quota_7d_reset_at);
  const hasFiveHourQuota = fiveHourUsed !== null || fiveHourResetAt !== null;

  if (isLimitReached && hasFiveHourQuota) {
    fiveHourUsed = 100;
  }
  if (fiveHourUsed !== null && fiveHourUsed >= 99) fiveHourUsed = 100;
  if (sevenDayUsed !== null && sevenDayUsed >= 99) sevenDayUsed = 100;
  if (!hasFiveHourQuota) {
    fiveHourUsed = sevenDayUsed;
    fiveHourResetAt = sevenDayResetAt;
  }

  const usage: NormalizedUsage = {
    raw_usage_json: JSON.stringify(payload ?? {}),
    ...(hasFiveHourQuota || sevenDayUsed !== null || sevenDayResetAt !== null
      ? { has_five_hour_quota: hasFiveHourQuota ? 1 : 0 }
      : {})
  };
  if (fiveHourUsed !== null && Number.isFinite(fiveHourUsed)) usage.quota_5h_used_percent = fiveHourUsed;
  if (fiveHourResetAt !== null) usage.quota_5h_reset_at = fiveHourResetAt;
  if (sevenDayUsed !== null && Number.isFinite(sevenDayUsed)) usage.quota_7d_used_percent = sevenDayUsed;
  if (sevenDayResetAt !== null) usage.quota_7d_reset_at = sevenDayResetAt;
  return usage;
}

export function normalizeResetCreditsPayload(payload: any): {
  reset_credits_available_count: number;
  reset_credits_next_expires_at: number;
  reset_credits_json: string;
} {
  const root = payload?.reset_credits || payload?.rate_limit_reset_credits || payload || {};
  const rawCredits: any[] = Array.isArray(root.credits)
    ? root.credits
    : Array.isArray(root.items)
      ? root.items
      : [];
  const credits: NormalizedCredit[] = rawCredits.map((item: any) => ({
    id: cleanText(item?.id),
    status: cleanText(item?.status),
    title: cleanText(item?.title || item?.type || item?.reset_type),
    granted_at: timestampFrom(item?.granted_at ?? item?.starts_at ?? item?.valid_from),
    expires_at: timestampFrom(item?.expires_at ?? item?.ends_at ?? item?.valid_until)
  }));
  const availableCount = finiteNumber(root.available_count ?? root.availableCount)
    ?? credits.filter((item) => item.status === "available").length;
  const nextExpiresAt = nearestFutureExpiry(credits);
  return {
    reset_credits_available_count: Math.max(0, Math.trunc(availableCount)),
    reset_credits_next_expires_at: nextExpiresAt,
    reset_credits_json: JSON.stringify({
      available_count: Math.max(0, Math.trunc(availableCount)),
      credits
    })
  };
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value: unknown): string {
  return String(value || "").trim();
}

function nearestFutureExpiry(credits: NormalizedCredit[]): number {
  const now = Math.floor(Date.now() / 1000);
  const expiries = credits
    .filter((item) => item.status === "available")
    .map((item) => Number(item.expires_at || 0))
    .filter((value) => Number.isFinite(value) && value > 0 && value >= now)
    .sort((a, b) => a - b);
  return expiries[0] || 0;
}

function parseChinaStandardTime(value: unknown): number | null {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s+CST$/i);
  if (!match) return null;
  const [, year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = match.map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, hour - 8, minute, second) / 1000);
}

function readUsedPercent(limit: any): number | null {
  const direct = Number(limit?.used_percent);
  if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));
  return percentFromLimit(limit);
}

export function collectRateLimitWindows(root: any): JsonObject[] {
  const windows: JsonObject[] = [];
  addLimitGroup(windows, root.rate_limit);
  addLimitGroup(windows, root.code_review_rate_limit);
  const additional = root.additional_rate_limits;
  if (Array.isArray(additional)) {
    additional.forEach((item) => addLimitGroup(windows, item));
  } else if (additional && typeof additional === "object") {
    Object.values(additional).forEach((item) => addLimitGroup(windows, item));
  }
  return windows;
}

function addLimitGroup(windows: JsonObject[], group: any): void {
  if (!group || typeof group !== "object") return;
  if (group.primary_window) windows.push(group.primary_window);
  if (group.secondary_window) windows.push(group.secondary_window);
}
