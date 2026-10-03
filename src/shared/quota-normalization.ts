/**
 * 订阅额度按 Plus 基准折算的配置。
 * @author chenjd
 * @created 2026-10-03 20:30:00
 */
export interface QuotaNormalizationOptions {
  /** 是否启用套餐额度折算，默认关闭。 */
  normalizeQuotaToPlus?: boolean;
  /** 各套餐相对 Plus 的容量倍率。 */
  quotaPlanMultipliers?: Readonly<Record<string, number>>;
}

/** 套餐标识与默认容量倍率；其他或未知套餐默认按一个 Plus 计算。 */
export const DEFAULT_QUOTA_PLAN_MULTIPLIERS = {
  plus: 1, prolite: 5, pro: 10, promax: 25, free: 0, go: 0, other: 1
} as const;

/** 新旧数据库均使用相同的额度配置默认值。 */
export const QUOTA_NORMALIZATION_DEFAULT_SETTINGS: Record<string, string> = {
  gpt_quota_normalization_enabled: "false",
  ...Object.fromEntries(Object.entries(DEFAULT_QUOTA_PLAN_MULTIPLIERS)
    .map(([plan, multiplier]) => [`gpt_quota_multiplier_${plan}`, String(multiplier)]))
};

/** 从持久化设置读取额度折算配置，非法倍率回退至套餐默认值。 */
export const quotaNormalizationFromSettings = (settings: Record<string, unknown>): QuotaNormalizationOptions => ({
  normalizeQuotaToPlus: settings.gpt_quota_normalization_enabled === "true",
  quotaPlanMultipliers: Object.fromEntries(Object.entries(DEFAULT_QUOTA_PLAN_MULTIPLIERS).map(([plan, fallback]) => {
    const raw = settings[`gpt_quota_multiplier_${plan}`];
    const value = raw === undefined || raw === null || String(raw).trim() === "" ? NaN : Number(raw);
    return [plan, Number.isFinite(value) && value >= 0 && value <= 1000 ? value : fallback];
  }))
});

/** 关闭折算时保持每个账号容量相同，启用时按套餐倍率计算。 */
export const quotaPlanMultiplier = (plan: unknown, options: QuotaNormalizationOptions): number => {
  if (!options.normalizeQuotaToPlus) return 1;
  const name = String(plan || "").trim().toLowerCase();
  const key = Object.hasOwn(DEFAULT_QUOTA_PLAN_MULTIPLIERS, name) ? name : "other";
  const value = options.quotaPlanMultipliers?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000
    ? value : DEFAULT_QUOTA_PLAN_MULTIPLIERS[key as keyof typeof DEFAULT_QUOTA_PLAN_MULTIPLIERS];
};
