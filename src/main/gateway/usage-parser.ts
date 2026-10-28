import { serviceTierFromObject } from "../../shared/service-tier.ts";

export interface TokenUsage {
  /** 响应确认的优先级，独立于是否返回 Token 用量。 */
  service_tier?: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface SseUsageParser {
  feed: (chunk: Uint8Array) => void;
  latestUsage: () => TokenUsage;
  responseCompleted: () => boolean;
  terminalError: () => string;
  /** 提取流内失败供请求日志使用，避免将握手成功误记为生成成功。 */
  terminalFailure: () => { status: number; message: string } | null;
}

const MAX_TAIL_BYTES = 1024 * 1024;

export function extractTokenUsage(body: unknown): TokenUsage {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  if (!text.trim()) return emptyUsage();
  const direct = parseUsageJson(text);
  if (hasUsage(direct) || direct.service_tier) return direct;
  return parseUsageSse(text);
}

export function createSseUsageParser(onEvent?: (event: Record<string, unknown>) => void): SseUsageParser {
  const decoder = new TextDecoder();
  let tail = "";
  let latest = emptyUsage();
  let completed = false;
  let terminalError = "";

  const consume = (text: string, flush = false): void => {
    const lines = text.split(/\r?\n/);
    tail = flush ? "" : lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload) as Record<string, unknown>;
        if (event.type === "response.completed") completed = true;
        if (event.type === "error" || event.type === "response.failed") terminalError = payload;
        onEvent?.(event);
      } catch {}
      let usage = parseUsageJson(payload);
      if (!hasUsage(usage)) usage = { ...usage, ...parseUsageFromJsonTail(payload) };
      if (hasUsage(usage)) latest = { ...latest, ...usage };
      else if (usage.service_tier) latest.service_tier = usage.service_tier;
    }
    if (tail.length > MAX_TAIL_BYTES) tail = tail.slice(-MAX_TAIL_BYTES);
  };

  return {
    terminalError: () => terminalError,
    terminalFailure: () => {
      if (!terminalError) return null;
      const event = JSON.parse(terminalError);
      const error = event.response?.error || event.error || event;
      const explicitStatus = [event.status, event.status_code, error.status, error.status_code]
        .map(Number).find((status) => Number.isInteger(status) && status >= 400 && status <= 599);
      const code = String(error.code || event.code || "");
      const status = explicitStatus ?? (["rate_limit_exceeded", "usage_limit_reached", "insufficient_quota", "model_capacity_exceeded"].includes(code) ? 429 : 500);
      return { status, message: String(error.message || event.message || code || "Upstream response failed.").slice(0, 1000) };
    },
    feed(chunk: Uint8Array): void {
      consume(tail + decoder.decode(chunk, { stream: true }));
    },
    latestUsage(): TokenUsage {
      consume(tail + decoder.decode() + "\n", true);
      return latest;
    },
    responseCompleted(): boolean {
      return completed;
    }
  };
}

function parseUsageFromJsonTail(text: string): TokenUsage {
  const marker = text.lastIndexOf('"usage"');
  if (marker < 0) return emptyUsage();
  const start = text.indexOf("{", marker + 7);
  if (start < 0) return emptyUsage();
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth !== 0) continue;
    try {
      return usageFromObject({ usage: JSON.parse(text.slice(start, index + 1)) });
    } catch {
      return emptyUsage();
    }
  }
  return emptyUsage();
}

function parseUsageJson(text: string): TokenUsage {
  try {
    return usageFromObject(JSON.parse(text));
  } catch {
    return emptyUsage();
  }
}

function parseUsageSse(text: string): TokenUsage {
  let latest = emptyUsage();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const usage = parseUsageJson(payload);
    if (hasUsage(usage)) latest = { ...latest, ...usage };
    else if (usage.service_tier) latest.service_tier = usage.service_tier;
  }
  return latest;
}

function usageFromObject(value: unknown): TokenUsage {
  const serviceTier = serviceTierFromObject(value);
  const tierFields = serviceTier ? { service_tier: serviceTier } : {};
  const usage = findUsage(value);
  if (!usage) return { ...emptyUsage(), ...tierFields };
  const input = numberFrom(usage.input_tokens, usage.prompt_tokens);
  const output = numberFrom(usage.output_tokens, usage.completion_tokens);
  const cached = numberFrom(
    usage.cached_input_tokens,
    objectValue(usage.input_tokens_details, "cached_tokens"),
    objectValue(usage.prompt_tokens_details, "cached_tokens")
  );
  const reasoning = numberFrom(
    usage.reasoning_output_tokens,
    objectValue(usage.output_tokens_details, "reasoning_tokens"),
    objectValue(usage.completion_tokens_details, "reasoning_tokens")
  );
  const total = numberFrom(usage.total_tokens, input + output);
  return {
    ...tierFields,
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total
  };
}

function findUsage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.usage && typeof record.usage === "object") return record.usage as Record<string, unknown>;
  const response = record.response;
  if (response && typeof response === "object") {
    const responseUsage = (response as Record<string, unknown>).usage;
    if (responseUsage && typeof responseUsage === "object") return responseUsage as Record<string, unknown>;
  }
  if (record.type && String(record.type).includes("usage") && ("input_tokens" in record || "output_tokens" in record)) return record;
  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = findUsage(item);
      if (usage) return usage;
    }
  }
  return null;
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function hasUsage(usage: TokenUsage): boolean {
  return usage.input_tokens > 0 || usage.cached_input_tokens > 0 || usage.output_tokens > 0 || usage.total_tokens > 0;
}

function numberFrom(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, Math.trunc(number));
  }
  return 0;
}

export function emptyUsage(): TokenUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}
