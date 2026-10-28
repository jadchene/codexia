import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { serviceTierLogFields, serviceTierMultiplier } from "../src/shared/service-tier.ts";
import { createSseUsageParser, extractTokenUsage } from "../src/main/gateway/usage-parser.ts";
import { createWebSocketObserver } from "../src/main/gateway-websocket-observer.ts";
import { createAccountModeResponsesObserver } from "../src/main/account-mode-responses-observer.ts";
import { buildResponsesRequestLog } from "../src/main/responses-request-log.ts";
import { editableSettingsPatch } from "../src/main/renderer-boundary.ts";

const usage = { input_tokens: 1_000_000, cached_input_tokens: 250_000, output_tokens: 100_000, reasoning_output_tokens: 0, total_tokens: 1_100_000 };
const modelPricing = { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 10 };

describe("优先级估算与协议兼容", () => {
  it.each([[undefined, 1], [null, 1], ["", 1], ["  ", 1], ["default", 1], ["priority", 2], ["fast", 2], ["ultrafast", 6], ["auto", 1], ["flex", 1], ["future-tier", 1]] as const)("%s 的基础倍率为 %s", (tier, multiplier) => {
    expect(serviceTierMultiplier(tier)).toBe(multiplier);
    const log = buildResponsesRequestLog({
      method: "POST", requestPath: "/v1/responses", upstreamPath: "/responses", headers: {}, status: 200,
      durationMs: 1, usage: { ...usage, service_tier: "default" }, settings: {}, requestedServiceTier: tier ?? null, modelPricing
    });
    expect(log.service_tier_multiplier).toBe(multiplier);
    expect(log.estimated_cost).toBe(2.625 * multiplier);
  });

  it("按请求保存计费档位，未指定时使用标准倍率设置", () => {
    expect(serviceTierLogFields("ultrafast", {})).toEqual({
      requested_service_tier: "ultrafast", service_tier: "ultrafast", service_tier_source: "request", service_tier_multiplier: 6
    });
    expect(serviceTierLogFields(null, { billing_service_tier_standard_multiplier: "1.5" })).toEqual({
      requested_service_tier: null, service_tier: "default", service_tier_source: "default", service_tier_multiplier: 1.5
    });
  });

  it("保存并验证可配置的小数和零倍率", () => {
    const settings = editableSettingsPatch({ billing_service_tier_fast_multiplier: "2.5", billing_service_tier_ultrafast_multiplier: "0" });
    expect(serviceTierMultiplier("priority", settings)).toBe(2.5);
    expect(serviceTierMultiplier("ultrafast", settings)).toBe(0);
    for (const value of ["", "-1", "NaN", "Infinity", "1001"]) {
      expect(() => editableSettingsPatch({ billing_service_tier_fast_multiplier: value })).toThrow(/优先级倍率/);
    }
    expect(serviceTierMultiplier("fast", { billing_service_tier_fast_multiplier: "invalid" })).toBe(2);
  });

  it("JSON 和分块 SSE 在用量分离时仍保留响应优先级", () => {
    expect(extractTokenUsage(JSON.stringify({ service_tier: "ultrafast", usage })).service_tier).toBe("ultrafast");
    const parser = createSseUsageParser();
    const body = `data: ${JSON.stringify({ type: "response.created", response: { service_tier: "fast" } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { usage } })}`;
    for (let index = 0; index < body.length; index += 7) parser.feed(Buffer.from(body.slice(index, index + 7)));
    expect(parser.latestUsage()).toEqual({ ...usage, service_tier: "fast" });
    expect(extractTokenUsage(body)).toEqual({ ...usage, service_tier: "fast" });
  });
});

describe.each(["gateway", "account"])("%s WebSocket 的逐次优先级", (mode) => {
  it("在同一连接中按请求独立结算，响应 default 不覆盖 Fast 开关", () => {
    const logs: Record<string, unknown>[] = [];
    const billingSettings: Record<string, string> = {};
    const common = {
      store: { addTokenLog: (entry: Record<string, unknown>) => { logs.push(entry); }, getSettings: () => billingSettings },
      request: { headers: {} } as IncomingMessage,
      requestPath: "/v1/responses", upstreamPath: "/responses", settings: {}, onIdleTimeout: () => {}
    };
    const observer = mode === "account"
      ? createAccountModeResponsesObserver({ ...common, accountId: "a", getModelPricing: () => modelPricing })
      : createWebSocketObserver({ ...common, account: { id: "a" }, helpers: { extractTokenUsage, isQuotaExhaustedResponse: () => false }, routing: { setCooldown: () => {}, clearCooldown: () => {} }, hooks: { upstreamService: { getModelPricing: () => modelPricing } } });
    const send = (direction: "onDownstreamMessage" | "onUpstreamMessage", event: unknown) => observer[direction](Buffer.from(JSON.stringify(event)), false);
    try {
      for (const tier of ["priority", "ultrafast", undefined]) {
        send("onDownstreamMessage", { type: "response.create", model: "gpt-test", service_tier: tier });
        send("onUpstreamMessage", { type: "response.created", response: { service_tier: tier === "priority" ? "default" : undefined } });
        send("onUpstreamMessage", { type: "response.completed", response: { service_tier: "default", usage } });
      }
      expect(logs.map((log) => log.service_tier_multiplier)).toEqual([2, 6, 1]);
      expect(logs.map((log) => log.estimated_cost)).toEqual([5.25, 15.75, 2.625]);
      expect(logs[0]).toMatchObject({ requested_service_tier: "priority", service_tier: "priority", service_tier_source: "request" });
      expect(logs[2]).toMatchObject({ requested_service_tier: null, service_tier: "default", service_tier_source: "default" });
      send("onDownstreamMessage", { type: "response.create", model: "gpt-test", service_tier: "fast" });
      send("onUpstreamMessage", { type: "response.failed", response: { service_tier: "fast" } });
      expect(logs[3]).toMatchObject({ status: 500, requested_service_tier: "fast", service_tier: "fast", service_tier_multiplier: 2 });
      expect(logs[3]?.estimated_cost).toBe(0);
      billingSettings.billing_service_tier_fast_multiplier = "3";
      send("onDownstreamMessage", { type: "response.create", model: "gpt-test", service_tier: "fast" });
      send("onUpstreamMessage", { type: "response.completed", response: { usage } });
      expect(logs[4]).toMatchObject({ service_tier_multiplier: 3, estimated_cost: 7.875 });
      expect(logs[3]?.service_tier_multiplier).toBe(2);
    } finally { observer.dispose(); }
  });
});
