import type { PublicAccount, ResetCredit } from "../../shared/contracts/accounts";
import type { Settings } from "../../shared/contracts/settings";

export const formatTime = (value: unknown, empty = "未填写"): string => {
  if (!value) return empty;
  if (typeof value === "string" && Number.isNaN(Number(value))) return value;
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? empty : date.toLocaleString();
};
export const formatTokenNumber = (value: unknown): string => (
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value || 0))
);

export const cacheHitRate = (input: unknown, cached: unknown): number => {
  const total = Number(input || 0);
  return total > 0 ? Math.max(0, Math.min(100, Number(cached || 0) / total * 100)) : 0;
};


export const isUsableAccount = (account: PublicAccount | undefined, settings: Settings): boolean => {
  if (!account?.enabled || account.status === "disabled" || !account.has_access_token) return false;
  const now = Math.floor(Date.now() / 1000);
  const windows: Array<[number | undefined, number | undefined]> = [
    [account.quota_7d_used_percent, account.quota_7d_reset_at]
  ];
  if (settings.ignore_five_hour_limit !== "true") {
    windows.push([account.quota_5h_used_percent, account.quota_5h_reset_at]);
  }
  return !windows.some(([used, resetAt]) => (
    Number(used) >= 99.9 && (!Number.isFinite(Number(resetAt)) || Number(resetAt) <= 0 || Number(resetAt) > now)
  ));
};

export const parseResetCredits = (account: PublicAccount | null): { availableCount: number; credits: ResetCredit[] } => {
  let parsed: { available_count?: number; credits?: ResetCredit[] } = {};
  try {
    parsed = account?.reset_credits_json ? JSON.parse(account.reset_credits_json) : {};
  } catch {
    parsed = {};
  }
  const available = Number(account?.reset_credits_available_count ?? parsed.available_count ?? 0);
  return {
    availableCount: Number.isFinite(available) ? Math.max(0, Math.trunc(available)) : 0,
    credits: Array.isArray(parsed.credits) ? parsed.credits : []
  };
};

export const resetCreditStatusLabel = (status: unknown): string => {
  const value = String(status || "").toLowerCase();
  if (value === "available") return "可用";
  if (value === "used") return "已使用";
  if (value === "expired") return "已过期";
  return String(status || "-");
};
