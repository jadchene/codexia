const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-amz-security-token"
]);

export function isSensitiveHeaderName(value: unknown): boolean {
  const name = String(value || "").trim().toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(name)) return true;
  return /(?:^|[-_])(api[-_]?key|(?:access[-_]?|auth[-_]?)?token|secret|password|credential)(?:$|[-_])/.test(name);
}

export function isLoopbackHttpUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "[::1]"
      || hostname === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

export function usesInsecureRemoteTransport(value: unknown): boolean {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" && !isLoopbackHttpUrl(url.toString());
  } catch {
    return false;
  }
}
