/** 统一套餐显示名称，保留原始标识用于鉴权和额度计算。 */
export const subscriptionPlanLabel = (plan: unknown): string => {
  const value = String(plan || "").trim().toLowerCase();
  if (!value) return "未知";
  const names: Record<string, string> = { prolite: "Pro 100", pro: "Pro 200", promax: "Pro 500" };
  return names[value] || value.charAt(0).toUpperCase() + value.slice(1);
};
