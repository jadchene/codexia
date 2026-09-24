import { isIP } from "node:net";
import type { IpGuardStatus, Settings } from "../shared/contracts/settings";

export class UpstreamIpGuardError extends Error {
  readonly code = "upstream_ip_guard_blocked";
  readonly status = 403;
  readonly statusCode = 403;
}

export function validateIpGuardSettings(settings: Settings): void {
  const ip = (settings.gpt_allowed_ip || "").trim();
  if ((ip && (!isIP(ip) || ip.includes("%"))) || (settings.gpt_ip_guard === "true" && !isIP(ip))) {
    throw new Error("启用 GPT 出口 IP 校验时必须填写一个有效的 IPv4 或 IPv6 地址。");
  }
}

function normalizeIp(ip: string): string {
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
}

export function isGptUrl(input: string | URL | Request): boolean {
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname.replace(/\.$/, "");
  return ["chatgpt.com", "openai.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function createUpstreamIpGuard(getSettings: () => Settings, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)) {
  let currentIp = "";
  let checkedAt: number | null = null;
  let error = "";
  let pending: Promise<void> | null = null;
  let configuration = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const status = (): IpGuardStatus => {
    const settings = getSettings();
    const allowedIp = (settings.gpt_allowed_ip || "").trim();
    return { enabled: settings.gpt_ip_guard === "true", allowedIp, currentIp, checkedAt, error,
      matched: Boolean(currentIp && checkedAt !== null && Date.now() - checkedAt <= 90_000
        && isIP(allowedIp) && !allowedIp.includes("%") && normalizeIp(currentIp) === normalizeIp(allowedIp)) };
  };
  const refresh = async (): Promise<IpGuardStatus> => {
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetchImpl("https://ipinfo.io/json", {
            signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store",
            headers: { accept: "application/json" }
          });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`IP 检测 HTTP ${response.status}`); }
          const payload = await response.json() as { ip?: unknown };
          if (typeof payload.ip !== "string" || (!isIP(payload.ip.trim()) || payload.ip.includes("%"))) throw new Error("IP 检测返回了无效地址");
          currentIp = payload.ip.trim();
          error = "";
        } catch (cause) {
          currentIp = "";
          error = cause instanceof Error ? cause.message : String(cause);
        } finally { checkedAt = Date.now(); }
      })().finally(() => { pending = null; });
    }
    await pending;
    return status();
  };
  const assertAllowed = (): void => {
    if (!status().enabled) return;
    try { validateIpGuardSettings(getSettings()); }
    catch (cause) { throw new UpstreamIpGuardError(String(cause)); }
    const result = status();
    if (result.checkedAt === null || Date.now() - result.checkedAt > 90_000) {
      throw new UpstreamIpGuardError("GPT 调用已阻止：出口 IP 尚未检测或缓存已过期，请刷新当前 IP。");
    }
    if (!result.enabled) return;
    if (result.error || !result.matched) {
      throw new UpstreamIpGuardError(result.error
        ? `GPT 调用已阻止：无法检测出口 IP（${result.error}）。`
        : `GPT 调用已阻止：当前出口 IP ${result.currentIp || "未知"}，允许的 IP ${result.allowedIp || "未配置"}。`);
    }
  };
  const stop = (): void => { if (timer) clearInterval(timer); timer = undefined; };
  const start = (): void => {
    const nextConfiguration = JSON.stringify([status().enabled, status().allowedIp]);
    if (configuration === nextConfiguration && (!status().enabled || timer)) return;
    configuration = nextConfiguration;
    stop();
    currentIp = "";
    checkedAt = null;
    error = "";
    if (!status().enabled) return;
    void refresh();
    timer = setInterval(() => { void refresh(); }, 60_000);
    timer.unref?.();
  };
  return { status, refresh, assertAllowed, start, stop };
}

let activeGuard: ReturnType<typeof createUpstreamIpGuard> | undefined;
export function installUpstreamIpGuard(guard: typeof activeGuard): void { activeGuard = guard; }
export function assertGptIpAllowed(url?: string | URL, force = false): void {
  if (force || url === undefined || isGptUrl(url)) activeGuard?.assertAllowed();
}
export const guardedFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  assertGptIpAllowed(url);
  // Do not follow unchecked redirects to another upstream.
  return globalThis.fetch(input, activeGuard?.status().enabled ? { ...init, redirect: "error" } : init);
};

export const guardedSubscriptionFetch: typeof fetch = async (input, init) => {
  assertGptIpAllowed(undefined, true);
  return globalThis.fetch(input, activeGuard?.status().enabled ? { ...init, redirect: "error" } : init);
};
