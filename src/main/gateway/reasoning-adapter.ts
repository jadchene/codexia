export function rewriteSubscriptionReasoningRequest(body: unknown): { adapted: boolean; body: unknown } {
  const payload = parseJsonObject(body);
  if (!Array.isArray(payload.input)) return { adapted: false, body };

  const input = payload.input.filter((item) => !hasNonEmptyReasoningContent(item));
  if (input.length === payload.input.length) return { adapted: false, body };

  const rewritten = { ...payload, input };
  if (Buffer.isBuffer(body)) return { adapted: true, body: Buffer.from(JSON.stringify(rewritten), "utf8") };
  if (typeof body === "string") return { adapted: true, body: JSON.stringify(rewritten) };
  return { adapted: true, body: rewritten };
}

function hasNonEmptyReasoningContent(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "reasoning") return false;
  if (Array.isArray(value.content)) return value.content.length > 0;
  return value.content !== undefined && value.content !== null && value.content !== "";
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (Buffer.isBuffer(value)) {
    try {
      const parsed = JSON.parse(value.toString("utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (isRecord(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
