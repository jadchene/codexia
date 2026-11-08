import type { Settings } from "./contracts/settings";

/** 生成账号代理写入与界面预览共用的本机 API 地址。 */
export const accountModeGatewayBaseUrl = (settings: Settings): string => {
  const configuredHost = String(settings.gateway_host || "localhost").trim();
  const reachableHost = configuredHost === "0.0.0.0" || configuredHost === "::" || configuredHost === "[::]"
    ? "localhost"
    : configuredHost;
  const host = reachableHost.includes(":") && !reachableHost.startsWith("[") ? `[${reachableHost}]` : reachableHost;
  return `http://${host}:${settings.gateway_port || "8436"}/v1`;
};
