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
  if (gateway && mcp) return "，API 与 MCP 服务需要重启后生效";
  if (gateway) return "，API 服务需要重启后生效";
  if (mcp) return "，MCP 服务需要重启后生效";
  return "";
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}
