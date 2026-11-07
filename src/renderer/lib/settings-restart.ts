import type { Settings } from "../../shared/contracts/settings";

const GATEWAY_RESTART_KEYS = new Set([
  "gateway_host",
  "gateway_port",
  "gateway_websocket_max_payload_bytes"
]);

const MCP_RESTART_KEYS = new Set([
  "mcp_gateway_config_path",
  "mcp_gateway_host",
  "mcp_gateway_port",
  "mcp_gateway_path"
]);

export function settingsRestartReminder(
  current: Settings,
  next: Settings,
  gatewayRunning: boolean,
  mcpRunning: boolean
): string {
  const changed = new Set(Object.entries(next)
    .filter(([key, value]) => value !== current[key])
    .map(([key]) => key));
  const gateway = gatewayRunning && intersects(changed, GATEWAY_RESTART_KEYS);
  const mcp = mcpRunning && intersects(changed, MCP_RESTART_KEYS);
  const services = [gateway ? "网关服务" : "", mcp ? "MCP 服务" : ""].filter(Boolean);
  const reminders = services.length ? [`${services.join("与")}需要重启后生效`] : [];
  if (["control_api_host", "control_api_port", "control_api_key"].some((key) => changed.has(key))) {
    reminders.push("外部 API 设置需要重启应用后生效");
  }
  return reminders.length ? `，${reminders.join("；")}` : "";
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}
