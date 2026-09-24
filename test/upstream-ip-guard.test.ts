import { afterEach, expect, test, vi } from "vitest";
import { createUpstreamIpGuard, installUpstreamIpGuard, guardedFetch, guardedSubscriptionFetch, isGptUrl, validateIpGuardSettings } from "../src/main/upstream-ip-guard.ts";

const settings = () => ({ gpt_ip_guard: "true", gpt_allowed_ip: "203.0.113.10" });
afterEach(() => { installUpstreamIpGuard(undefined); vi.restoreAllMocks(); vi.useRealTimers(); });

test("disabled by default; validation rejects missing or invalid IP", () => {
  const fetch = vi.fn();
  const guard = createUpstreamIpGuard(() => ({}), fetch);
  guard.start();
  guard.assertAllowed();
  expect(fetch).not.toHaveBeenCalled();
  expect(() => validateIpGuardSettings({ gpt_ip_guard: "true" })).toThrow();
  expect(() => validateIpGuardSettings({ ...settings(), gpt_allowed_ip: "host.example" })).toThrow();
});

test("calls only read cache; failed refresh invalidates a previous match; manual refresh recovers", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"ip":"203.0.113.10"}'));
  const guard = createUpstreamIpGuard(settings, fetch);
  expect(() => guard.assertAllowed()).toThrow(/尚未检测/);
  await guard.refresh();
  for (let i = 0; i < 10; i++) guard.assertAllowed();
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockRejectedValueOnce(new Error("offline"));
  await guard.refresh();
  expect(guard.status().currentIp).toBe("");
  expect(() => guard.assertAllowed()).toThrow(/offline/);
  fetch.mockResolvedValueOnce(new Response('{"ip":"203.0.113.11"}'));
  await guard.refresh();
  expect(() => guard.assertAllowed()).toThrow(/203.0.113.11/);
  fetch.mockResolvedValueOnce(new Response('{"ip":"203.0.113.10"}'));
  await guard.refresh();
  guard.assertAllowed();
});

test("timer refreshes once a minute; stale cache blocks; stop clears timer", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => new Response('{"ip":"203.0.113.10"}'));
  const guard = createUpstreamIpGuard(settings, fetch);
  guard.start();
  await guard.refresh();
  guard.assertAllowed();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  guard.stop();
  await vi.advanceTimersByTimeAsync(90_001);
  expect(() => guard.assertAllowed()).toThrow(/过期/);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("IPv6 normalization, current config changes and disabling take effect", async () => {
  const config = { gpt_ip_guard: "true", gpt_allowed_ip: "2001:0db8::1" };
  const guard = createUpstreamIpGuard(() => config, vi.fn().mockResolvedValue(new Response('{"ip":"2001:db8:0:0:0:0:0:1"}')));
  await guard.refresh();
  guard.assertAllowed();
  config.gpt_allowed_ip = "2001:db8::2";
  expect(() => guard.assertAllowed()).toThrow(/允许的 IP/);
  config.gpt_ip_guard = "false";
  guard.assertAllowed();
});

test("HTTP gate blocks before transport, applies to custom subscription URLs, leaves third parties usable", async () => {
  const guard = createUpstreamIpGuard(settings, vi.fn());
  installUpstreamIpGuard(guard);
  const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  await expect(guardedFetch("https://chatgpt.com/backend-api/codex/models")).rejects.toThrow(/尚未检测/);
  await expect(guardedFetch("https://auth.openai.com/oauth/token")).rejects.toThrow();
  await expect(guardedSubscriptionFetch("http://localhost:9999/custom")).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  await guardedFetch("https://third-party.example/v1/responses");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(isGptUrl("https://chatgpt.com.evil.example")).toBe(false);
});

test.each([new Response("{}"), new Response("bad"), new Response("", { status: 429 })])("invalid IPinfo response fails closed", async (response) => {
  const guard = createUpstreamIpGuard(settings, vi.fn().mockResolvedValue(response));
  await guard.refresh();
  expect(() => guard.assertAllowed()).toThrow();
});
