import type { Settings } from "./contracts/settings";

/** 费用估算的优先级倍率，不用于订阅额度折算。 */
export const SERVICE_TIER_DEFAULT_SETTINGS: Settings = {
  billing_service_tier_standard_multiplier: "1",
  billing_service_tier_fast_multiplier: "2",
  billing_service_tier_ultrafast_multiplier: "6"
};

/** 保留协议取值，拒绝无效或过长的日志字段。 */
export const normalizeServiceTier = (value: unknown): string | null => (
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null
);

/** 读取 Responses 请求或响应事件中的优先级。 */
export const serviceTierFromObject = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  return normalizeServiceTier(response?.service_tier) ?? normalizeServiceTier(record.service_tier);
};

/** 将协议优先级映射为界面名称，未知值保持可见。 */
export const serviceTierLabel = (value: unknown): string => {
  const tier = normalizeServiceTier(value);
  if (!tier) return "未记录";
  const labels: Record<string, string> = {
    default: "标准", standard: "标准", priority: "快速", fast: "快速", ultrafast: "超快速", auto: "自动", flex: "弹性", scale: "Scale"
  };
  return `${labels[tier] || "未知"}（${tier}）`;
};

/** 按请求优先级读取倍率，自动或未知优先级按基础价格估算。 */
export const serviceTierMultiplier = (value: unknown, settings: Settings = {}): number => {
  const tier = normalizeServiceTier(value);
  const category = tier === "priority" || tier === "fast" ? "fast"
    : tier === "ultrafast" ? "ultrafast"
      : tier === "default" || tier === "standard" || !tier ? "standard" : null;
  if (!category) return 1;
  const key = `billing_service_tier_${category}_multiplier`;
  const raw = settings[key];
  const multiplier = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(multiplier) && multiplier >= 0 && multiplier <= 1000
    ? multiplier : Number(SERVICE_TIER_DEFAULT_SETTINGS[key]);
};

/** 仅按请求优先级保存计费快照，未指定时按标准处理。 */
export const serviceTierLogFields = (requested: unknown, settings: Settings) => {
  const requestedTier = normalizeServiceTier(requested);
  const tier = requestedTier ?? "default";
  return {
    requested_service_tier: requestedTier,
    service_tier: tier,
    service_tier_source: requestedTier ? "request" : "default",
    service_tier_multiplier: serviceTierMultiplier(tier, settings)
  };
};
