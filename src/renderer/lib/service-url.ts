const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function clientReachableHost(host: unknown): string {
  const value = String(host || "").trim();
  return WILDCARD_HOSTS.has(value.toLowerCase()) ? "127.0.0.1" : (value || "127.0.0.1");
}

export function clientReachableUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (WILDCARD_HOSTS.has(parsed.hostname.toLowerCase())) parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

export function localServiceUrl(protocol: "http" | "ws", host: unknown, port: unknown, path = ""): string {
  const reachableHost = clientReachableHost(host);
  const urlHost = reachableHost.includes(":") && !reachableHost.startsWith("[") ? `[${reachableHost}]` : reachableHost;
  const normalizedPath = path ? `/${path.replace(/^\/+/, "")}` : "";
  return `${protocol}://${urlHost}:${String(port || "")}${normalizedPath}`;
}
