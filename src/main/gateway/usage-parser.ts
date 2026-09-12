export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface SseUsageParser {
  feed: (chunk: Uint8Array) => void;
  latestUsage: () => TokenUsage;
  responseCompleted: () => boolean;
  terminalError: () => string;
}

const MAX_TAIL_BYTES = 1024 * 1024;

export function extractTokenUsage(body: unknown): TokenUsage {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  if (!text.trim()) return emptyUsage();
  const direct = parseUsageJson(text);
  if (hasUsage(direct)) return direct;
  return parseUsageSse(text);
}

export function createSseUsageParser(): SseUsageParser {
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
      } catch {}
      let usage = parseUsageJson(payload);
      if (!hasUsage(usage)) usage = parseUsageFromJsonTail(payload);
      if (hasUsage(usage)) latest = usage;
    }
    if (tail.length > MAX_TAIL_BYTES) tail = tail.slice(-MAX_TAIL_BYTES);
  };

  return {
    terminalError: () => terminalError,
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
    if (hasUsage(usage)) latest = usage;
  }
  return latest;
}

function usageFromObject(value: unknown): TokenUsage {
  const usage = findUsage(value);
  if (!usage) return emptyUsage();
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
