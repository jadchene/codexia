type HeaderValue = string | string[] | number | undefined;
export type HeaderMap = Record<string, HeaderValue>;

export interface GatewayRouteMatch {
  pathAllowed: boolean;
  methodAllowed: boolean;
  allowedMethods: string[];
}

export interface GatewayUpstreamAccount {
  access_token: string;
  account_id?: string;
  workspace_id?: string;
}

const GATEWAY_ROUTES: Record<string, string[]> = {
  "/v1/models": ["GET"],
  "/v1/responses": ["POST"],
  "/v1/responses/compact": ["POST"],
  "/v1/memories/trace_summarize": ["POST"],
  "/v1/images/generations": ["POST"],
  "/v1/images/edits": ["POST"],
  "/v1/realtime/calls": ["POST"]
};

export function matchGatewayRoute(method: unknown, pathname: string): GatewayRouteMatch {
  const allowedMethods = GATEWAY_ROUTES[pathname] ?? [];
  const normalizedMethod = String(method || "").toUpperCase();
  return {
    pathAllowed: allowedMethods.length > 0,
    methodAllowed: allowedMethods.includes(normalizedMethod),
    allowedMethods
  };
}

export function buildGatewayRequest(baseUrl: unknown, requestUrl: string, body: unknown) {
  const parsed = new URL(requestUrl, "http://localhost");
  const path = parsed.pathname;
  const upstreamUrl = buildUpstreamUrl(baseUrl, `${path}${parsed.search}`);
  return { upstreamUrl, body, path, originalPath: `${parsed.pathname}${parsed.search}` };
}

export function buildUpstreamUrl(baseUrl: unknown, requestUrl: string): string {
  const base = String(baseUrl || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
  const parsed = new URL(requestUrl, "http://localhost");
  const upstreamPath = parsed.pathname.replace(/^\/v1/, "");
  return `${base}${upstreamPath}${parsed.search}`;
}

export function pathFromUrl(value: unknown): string {
  try {
    const parsed = new URL(String(value));
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(value || "");
  }
}

export function gatewayErrorMessage(error: unknown, fallback?: string): string {
  const typedError = isRecord(error) ? error : {};
  const message = fallback || String(typedError.message || error || "");
  const cause = isRecord(typedError.cause) ? typedError.cause : {};
  const causeParts = [cause.code, cause.errno, cause.syscall, cause.address, cause.port].filter(Boolean);
  return causeParts.length > 0 ? `${message} (${causeParts.join(" ")})` : message;
}

export function buildUpstreamHeaders(
  headers: HeaderMap,
  account: GatewayUpstreamAccount,
  _hasBody = false,
  _path = ""
): HeaderMap {
  const outgoing: HeaderMap = {};
  const connectionHeaders = connectionHeaderTokens(headers);
  const discardedHeaders = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
    "content-length",
    "authorization",
    "cookie",
    "proxy-authorization",
    "openai-organization",
    "openai-project",
    "origin",
    "referer",
    "accept-encoding"
  ]);
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (discardedHeaders.has(lower) || connectionHeaders.has(lower)) continue;
    outgoing[key] = value;
  }
  setHeader(outgoing, "Authorization", `Bearer ${account.access_token}`);
  const accountHeader = account.account_id || account.workspace_id || "";
  if (accountHeader) setHeader(outgoing, "ChatGPT-Account-ID", accountHeader);
  return outgoing;
}

export function positiveSetting(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

export function connectionHeaderTokens(headers: HeaderMap | Headers): Set<string> {
  const value = typeof (headers as Headers)?.get === "function"
    ? (headers as Headers).get("connection")
    : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === "connection")?.[1];
  return new Set(String(Array.isArray(value) ? value.join(",") : value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

export function parseAffinitySnapshot(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value || ""));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isLoopbackHost(host: unknown): boolean {
  const value = String(host || "").trim().toLowerCase();
  return value === "localhost"
    || value === "127.0.0.1"
    || value === "::1"
    || value === "[::1]";
}

export function isStrongGatewayApiKey(value: unknown): boolean {
  const key = String(value || "").trim();
  return key.length >= 24 && key !== "local-personal-token";
}

export function setHeader(headers: HeaderMap, name: string, value: string): void {
  const lower = name.toLowerCase();
  const existing = Object.keys(headers).find((item) => item.toLowerCase() === lower);
  headers[existing || name] = value;
}

export function buildSubscriptionRoutingHint(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const model = routingHintValue(payload.model);
  if (!model) return "";
  if (payload.service_tier === undefined || payload.service_tier === null || payload.service_tier === "") {
    return `model=${model}`;
  }
  const tier = routingHintValue(payload.service_tier);
  return tier ? `model=${model};tier=${tier}` : "";
}

export function setSubscriptionRoutingHint(headers: HeaderMap, payload: unknown): string {
  const hint = buildSubscriptionRoutingHint(payload);
  replaceSubscriptionRoutingHint(headers, hint);
  return hint;
}

export function replaceSubscriptionRoutingHint(headers: HeaderMap, hint: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-codex-routing-hint") delete headers[key];
  }
  if (hint) setHeader(headers, "x-codex-routing-hint", hint);
}

export function stripSubscriptionHeaders(headers: HeaderMap): void {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("openai-")
      || lower.startsWith("chatgpt-")
      || lower.startsWith("x-codex-")
      || lower === "session_id"
      || lower === "session-id"
      || lower === "x-session-id"
    ) delete headers[key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function routingHintValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && /^[\x20-\x7e]+$/.test(normalized) ? normalized : "";
}
