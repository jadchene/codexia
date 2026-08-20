import fs from "node:fs";
import path from "node:path";

type Dynamic = any;

export const DEFAULT_API_DEBUG_BODY_LIMIT_BYTES = 1024 * 1024;
export const API_DEBUG_MAX_DURATION_MS = 10 * 60 * 1000;
export const API_DEBUG_EXPIRY_SETTING = "debug_api_logging_expires_at";
const API_DEBUG_FLUSH_INTERVAL_MS = 25;
const API_DEBUG_FLUSH_BUFFER_BYTES = 256 * 1024;

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key"
]);

export interface ApiDebugLogEntry {
  ts: string;
  id: string;
  kind: "request" | "response";
  [key: string]: unknown;
}

export interface ApiDebugLogger {
  bodyLimitBytes: number;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  write: (entry: ApiDebugLogEntry) => void;
  flush: () => Promise<void>;
  clear: () => Promise<void>;
}

export interface BodyPreview {
  body: string;
  bodyBytes: number;
  truncated: boolean;
}

/**
 * Creates a best-effort buffered JSONL debug logger. Entries are appended to
 * data/logs/<yyyymmdd>.jsonl using the local date. Logging failures are swallowed
 * so debug logging never breaks API serving.
 */
export function createApiDebugLogger(options: {
  dataDir?: string;
  bodyLimitBytes?: number;
  enabled?: boolean;
}): ApiDebugLogger {
  const dataDir = String(options.dataDir || "").trim();
  const bodyLimitBytes = Number.isFinite(options.bodyLimitBytes) && Number(options.bodyLimitBytes) > 0
    ? Math.trunc(Number(options.bodyLimitBytes))
    : DEFAULT_API_DEBUG_BODY_LIMIT_BYTES;
  const logDir = dataDir ? path.join(dataDir, "logs") : "";
  let enabled = options.enabled !== false;
  let bufferedLines: string[] = [];
  let bufferedBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingWrite = Promise.resolve();

  const flush = (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!logDir || bufferedLines.length === 0) return pendingWrite;
    const content = bufferedLines.join("");
    bufferedLines = [];
    bufferedBytes = 0;
    const file = path.join(logDir, `${localDateKey(new Date())}.jsonl`);
    pendingWrite = pendingWrite.then(async () => {
      await fs.promises.mkdir(logDir, { recursive: true });
      await fs.promises.appendFile(file, content, "utf8");
    }).catch(() => {
      // Best-effort only.
    });
    return pendingWrite;
  };

  return {
    bodyLimitBytes,
    isEnabled: () => enabled,
    setEnabled(value) {
      enabled = value;
    },
    write(entry) {
      if (!enabled || !logDir) return;
      const line = `${JSON.stringify(entry)}\n`;
      bufferedLines.push(line);
      bufferedBytes += Buffer.byteLength(line);
      if (bufferedBytes >= API_DEBUG_FLUSH_BUFFER_BYTES) {
        void flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => void flush(), API_DEBUG_FLUSH_INTERVAL_MS);
        flushTimer.unref?.();
      }
    },
    flush,
    async clear() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      bufferedLines = [];
      bufferedBytes = 0;
      if (!logDir) return;
      pendingWrite = pendingWrite.then(() => fs.promises.rm(logDir, { recursive: true, force: true })).catch(() => {
        // Best-effort only.
      });
      await pendingWrite;
    }
  };
}

export function createApiDebugModeController(options: {
  logger: ApiDebugLogger;
  getSettings: () => Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Record<string, string>;
  addAppLog?: (entry: Record<string, unknown>) => void;
  onChanged?: (reason: "enabled" | "disabled" | "expired") => void;
  now?: () => number;
  maxDurationMs?: number;
}) {
  const now = options.now || Date.now;
  const maxDurationMs = options.maxDurationMs || API_DEBUG_MAX_DURATION_MS;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTransition: Promise<unknown> = Promise.resolve();

  const cancelTimer = () => {
    if (!expiryTimer) return;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  };

  const scheduleExpiry = (expiresAt: number) => {
    cancelTimer();
    expiryTimer = setTimeout(() => {
      pendingTransition = disable("expired");
    }, Math.max(0, expiresAt - now()));
    expiryTimer.unref?.();
  };

  const disable = async (reason: "disabled" | "expired") => {
    cancelTimer();
    options.logger.setEnabled(false);
    const settings = options.saveSettings({
      debug_api_logging: "false",
      [API_DEBUG_EXPIRY_SETTING]: ""
    });
    await options.logger.clear();
    options.addAppLog?.({
      scope: "api-debug",
      action: "logging",
      status: reason,
      message: reason === "expired"
        ? "API 调试日志已达到 10 分钟上限，已自动关闭并清空。"
        : "API 调试日志已关闭并清空。"
    });
    options.onChanged?.(reason);
    return settings;
  };

  const initialize = async () => {
    const settings = options.getSettings();
    const expiresAt = Number(settings[API_DEBUG_EXPIRY_SETTING] || 0);
    if (settings.debug_api_logging !== "true") {
      options.logger.setEnabled(false);
      await options.logger.clear();
      if (settings[API_DEBUG_EXPIRY_SETTING]) {
        return options.saveSettings({ [API_DEBUG_EXPIRY_SETTING]: "" });
      }
      return settings;
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      return disable("expired");
    }
    options.logger.setEnabled(true);
    scheduleExpiry(expiresAt);
    return settings;
  };

  const setEnabled = async (enabled: boolean) => {
    const settings = options.getSettings();
    const expiresAt = Number(settings[API_DEBUG_EXPIRY_SETTING] || 0);
    if (!enabled && settings.debug_api_logging !== "true") {
      options.logger.setEnabled(false);
      await options.logger.clear();
      return settings;
    }
    if (!enabled) return disable("disabled");
    if (settings.debug_api_logging === "true" && Number.isFinite(expiresAt) && expiresAt > now()) {
      options.logger.setEnabled(true);
      scheduleExpiry(expiresAt);
      return settings;
    }
    cancelTimer();
    options.logger.setEnabled(false);
    await options.logger.clear();
    const nextExpiry = now() + maxDurationMs;
    const next = options.saveSettings({
      debug_api_logging: "true",
      [API_DEBUG_EXPIRY_SETTING]: String(nextExpiry)
    });
    options.logger.setEnabled(true);
    scheduleExpiry(nextExpiry);
    options.addAppLog?.({
      level: "warn",
      scope: "api-debug",
      action: "logging",
      status: "enabled",
      message: "API 调试日志已开启，正文可能包含敏感数据；10 分钟后将自动关闭并清空。"
    });
    options.onChanged?.("enabled");
    return next;
  };

  return {
    initialize,
    setEnabled,
    disable: () => disable("disabled"),
    whenIdle: () => pendingTransition.then(() => undefined),
    dispose: cancelTimer
  };
}

export function sanitizeHeaders(headers: Record<string, unknown> | undefined | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || "");
    if (!name) continue;
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
      result[name] = "[REDACTED]";
      continue;
    }
    result[name] = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue ?? "");
  }
  return result;
}

export function previewBody(value: Buffer | Uint8Array | string | undefined | null, limitBytes: number): BodyPreview {
  const buffer = value === undefined || value === null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(value)
      ? value
      : Buffer.from(value);
  const truncated = buffer.length > limitBytes;
  const kept = truncated ? buffer.subarray(0, limitBytes) : buffer;
  return {
    body: kept.toString("utf8"),
    bodyBytes: buffer.length,
    truncated
  };
}

export function createBodyCapture(limitBytes: number): {
  push: (value: string | Uint8Array) => void;
  snapshot: () => BodyPreview;
} {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let bodyBytes = 0;
  let truncated = false;
  return {
    push(value) {
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bodyBytes += buffer.length;
      if (truncated || capturedBytes >= limitBytes) {
        truncated = true;
        return;
      }
      const remaining = limitBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const kept = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(kept);
      capturedBytes += kept.length;
      if (buffer.length > remaining) truncated = true;
    },
    snapshot() {
      return {
        body: Buffer.concat(chunks, capturedBytes).toString("utf8"),
        bodyBytes,
        truncated
      };
    }
  };
}

/**
 * Wraps res.write/res.end so every byte sent to the client is also captured
 * for the debug log. Returns a restore function to unwrap the methods.
 */
export function captureResponse(res: Dynamic, capture: { push: (value: string | Uint8Array) => void }): () => void {
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = (chunk: Dynamic, ...rest: Dynamic[]) => {
    if (chunk !== undefined && chunk !== null) capture.push(chunk);
    return originalWrite(chunk, ...rest);
  };
  res.end = (chunk: Dynamic, ...rest: Dynamic[]) => {
    if (chunk !== undefined && chunk !== null) capture.push(chunk);
    return originalEnd(chunk, ...rest);
  };
  return () => {
    res.write = originalWrite;
    res.end = originalEnd;
  };
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
