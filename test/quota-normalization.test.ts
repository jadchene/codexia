import { describe, expect, it } from "vitest";
import { buildAccountPoolQuotaSummary, buildCodexQuotaHeaders, buildCodexQuotaSnapshot } from "../src/main/gateway/quota.ts";
import { editableSettingsPatch } from "../src/main/renderer-boundary.ts";
import { DEFAULT_QUOTA_PLAN_MULTIPLIERS, quotaNormalizationFromSettings, quotaPlanMultiplier } from "../src/shared/quota-normalization.ts";

const account = (plan: string, used: number, extra = {}) => ({
  id: plan, subscription_plan: plan, enabled: true, status: "active", access_token: "test",
  quota_5h_used_percent: used, quota_7d_used_percent: used, quota_5h_reset_at: 1000, quota_7d_reset_at: 2000, ...extra
});
const options = quotaNormalizationFromSettings({ gpt_quota_normalization_enabled: "true" });

describe("Plus 基准额度", () => {
  it.each(Object.entries(DEFAULT_QUOTA_PLAN_MULTIPLIERS))("%s 使用默认倍率 %s", (plan, multiplier) => {
    expect(quotaPlanMultiplier(plan, options)).toBe(multiplier);
    const summary = buildAccountPoolQuotaSummary([account(plan, 40)], 500, options);
    expect(summary.capacity_percent).toBe(multiplier * 100);
    expect(summary.primary.remaining_percent).toBe(multiplier * 60);
    expect(buildCodexQuotaSnapshot([account(plan, 40)], 500, options).primary.used_percent).toBe(multiplier === 0 ? 100 : 40);
  });

  it("混合套餐叠加超过 100%，响应头与圆环共用加权总容量占比", () => {
    const accounts = [account("plus", 20), account("prolite", 60), account("pro", 90), account("promax", 40), account("free", 0), account("go", 0)];
    const summary = buildAccountPoolQuotaSummary(accounts, 500, options);
    expect(summary.capacity_percent).toBe(4100);
    expect(summary.primary.remaining_percent).toBe(1880);
    const headers = buildCodexQuotaHeaders(accounts, 500, options);
    expect(headers["x-codex-primary-used-percent"]).toBe("54.1");
    expect(headers["x-codex-secondary-used-percent"]).toBe("54.1");
    expect(buildCodexQuotaSnapshot(accounts, 500, options).primary.used_percent).toBe(54.1);
  });

  it("默认关闭与显式关闭都保持等权叠加和原响应头规则", () => {
    const accounts = [account("plus", 20), account("promax", 60), account("free", 0)];
    for (const config of [{}, { gpt_quota_normalization_enabled: "false", gpt_quota_multiplier_promax: "90" }]) {
      const off = quotaNormalizationFromSettings(config);
      const summary = buildAccountPoolQuotaSummary(accounts, 500, off);
      expect(summary.capacity_percent).toBe(300);
      expect(summary.primary.remaining_percent).toBe(220);
      expect(buildCodexQuotaHeaders(accounts, 500, off)["x-codex-primary-used-percent"]).toBe("0");
    }
  });

  it("自定义倍率支持小数、零及未知套餐回退", () => {
    const custom = quotaNormalizationFromSettings({ gpt_quota_normalization_enabled: "true", gpt_quota_multiplier_plus: "1.5", gpt_quota_multiplier_pro: "0", gpt_quota_multiplier_free: "0.5", gpt_quota_multiplier_other: "2" });
    const accounts = [account(" PLUS ", 20), account("pro", 0), account("free", 60), account("enterprise", 50)];
    const summary = buildAccountPoolQuotaSummary(accounts, 500, custom);
    expect(summary.capacity_percent).toBe(400);
    expect(summary.primary.remaining_percent).toBe(240);
    expect(buildCodexQuotaSnapshot(accounts, 500, custom).primary.used_percent).toBe(40);
    expect(quotaPlanMultiplier("missing", options)).toBe(1);
    expect(quotaPlanMultiplier(undefined, options)).toBe(1);
  });

  it("无账号、全零倍率或全部耗尽时使用 100% 已用，额度充足时使用 0% 已用", () => {
    for (const accounts of [[], [account("free", 0), account("go", 0)], [account("plus", 100), account("promax", 100)]]) {
      const snapshot = buildCodexQuotaSnapshot(accounts, 500, options);
      expect(snapshot.primary.used_percent).toBe(100);
      expect(snapshot.secondary.used_percent).toBe(100);
    }
    expect(buildCodexQuotaSnapshot([account("promax", 0)], 500, options).primary.used_percent).toBe(0);
  });

  it("极小的小数倍率不会在计算占比前被舍入为零", () => {
    const fractional = quotaNormalizationFromSettings({ gpt_quota_normalization_enabled: "true", gpt_quota_multiplier_plus: "0.0001" });
    const accounts = [account("plus", 50)];
    const summary = buildAccountPoolQuotaSummary(accounts, 500, fractional);
    expect(summary.capacity_percent).toBe(0.01);
    expect(summary.primary.remaining_percent).toBe(0.005);
    expect(buildCodexQuotaSnapshot(accounts, 500, fractional).primary.used_percent).toBe(50);
  });

  it("排除禁用、无令牌和零倍率账号的额度与重置时间", () => {
    const accounts = [account("plus", 20), account("promax", 0, { enabled: false }), account("pro", 0, { status: "disabled" }), account("prolite", 0, { access_token: "" }), account("free", 0, { quota_5h_reset_at: 501 })];
    const summary = buildAccountPoolQuotaSummary(accounts, 500, options);
    expect(summary.capacity_percent).toBe(100);
    expect(summary.primary.remaining_percent).toBe(80);
    expect(summary.primary.reset_at).toBe(1000);
  });

  it("忽略五小时窗口时主窗口同步加权七天额度和重置时间", () => {
    const accounts = [account("plus", 80, { quota_7d_used_percent: 20 }), account("pro", 0, { quota_7d_used_percent: 90 })];
    const ignored = { ...options, ignoreFiveHourLimit: true };
    const summary = buildAccountPoolQuotaSummary(accounts, 500, ignored);
    expect(summary.primary.remaining_percent).toBe(180);
    expect(summary.primary).toEqual(summary.secondary);
    const snapshot = buildCodexQuotaSnapshot(accounts, 500, ignored);
    expect(snapshot.primary.window_minutes).toBe(10080);
    expect(snapshot.primary.used_percent).toBe(83.6);
    expect(snapshot.primary.reset_at).toBe(2000);
  });

  it("边界验证拒绝非法倍率，读取历史非法值时回退默认值", () => {
    expect(editableSettingsPatch({ gpt_quota_normalization_enabled: "true", gpt_quota_multiplier_pro: "12.5" })).toEqual({ gpt_quota_normalization_enabled: "true", gpt_quota_multiplier_pro: "12.5" });
    for (const value of ["", "-1", "NaN", "Infinity", "1001", "abc"]) {
      expect(() => editableSettingsPatch({ gpt_quota_multiplier_pro: value })).toThrow(/倍率/);
      expect(quotaPlanMultiplier("pro", quotaNormalizationFromSettings({ gpt_quota_normalization_enabled: "true", gpt_quota_multiplier_pro: value }))).toBe(10);
    }
    expect(() => editableSettingsPatch({ gpt_quota_normalization_enabled: "yes" })).toThrow();
  });
});
