import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  API_DEBUG_EXPIRY_SETTING,
  API_DEBUG_MAX_DURATION_MS,
  createApiDebugLogger,
  createApiDebugModeController,
  createBodyCapture,
  captureResponse,
  previewBody,
  sanitizeHeaders
} from "../src/main/api-debug-log.ts";

const tempDirs: string[] = [];

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-debug-log-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("API debug logger appends JSONL entries to data/logs/<yyyymmdd>.jsonl", async () => {
  const dataDir = tempDataDir();
  const logger = createApiDebugLogger({ dataDir });
  logger.write({
    ts: "2026-08-20T00:00:00.000Z",
    id: "req-1",
    kind: "request",
    method: "POST",
    path: "/v1/responses",
    body: "{}",
    bodyBytes: 2,
    truncated: false
  });
  await logger.flush();
  logger.write({
    ts: "2026-08-20T00:00:00.001Z",
    id: "req-1",
    kind: "response",
    status: 200,
    body: "ok",
    bodyBytes: 2,
    truncated: false,
    durationMs: 5
  });
  await logger.flush();
  const key = localDateKey(new Date());
  const file = path.join(dataDir, "logs", `${key}.jsonl`);
  assert.equal(fs.existsSync(file), true);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.kind, "request");
  assert.equal(first.id, "req-1");
  assert.equal(first.path, "/v1/responses");
  const second = JSON.parse(lines[1]);
  assert.equal(second.kind, "response");
  assert.equal(second.status, 200);
  assert.equal(second.id, first.id);
});

test("API debug mode expires after ten minutes and clears buffered and written logs", async () => {
  vi.useFakeTimers();
  const dataDir = tempDataDir();
  const logger = createApiDebugLogger({ dataDir, enabled: false });
  let settings: Record<string, string> = {
    debug_api_logging: "false",
    [API_DEBUG_EXPIRY_SETTING]: ""
  };
  const changes: string[] = [];
  const controller = createApiDebugModeController({
    logger,
    getSettings: () => settings,
    saveSettings: (patch) => (settings = { ...settings, ...patch }),
    onChanged: (reason) => changes.push(reason),
    now: () => Date.now()
  });

  await controller.initialize();
  await controller.setEnabled(true);
  assert.equal(settings.debug_api_logging, "true");
  assert.equal(Number(settings[API_DEBUG_EXPIRY_SETTING]), Date.now() + API_DEBUG_MAX_DURATION_MS);
  logger.write({ ts: new Date().toISOString(), id: "req-1", kind: "request" });
  await logger.flush();
  assert.equal(fs.existsSync(path.join(dataDir, "logs")), true);

  await vi.advanceTimersByTimeAsync(API_DEBUG_MAX_DURATION_MS);
  await controller.whenIdle();
  assert.equal(settings.debug_api_logging, "false");
  assert.equal(settings[API_DEBUG_EXPIRY_SETTING], "");
  assert.equal(fs.existsSync(path.join(dataDir, "logs")), false);
  assert.deepEqual(changes, ["enabled", "expired"]);
});

test("disabling API debug mode clears logs and does not extend an active deadline", async () => {
  const dataDir = tempDataDir();
  const logger = createApiDebugLogger({ dataDir, enabled: false });
  let currentTime = 1_000;
  let settings: Record<string, string> = {
    debug_api_logging: "false",
    [API_DEBUG_EXPIRY_SETTING]: ""
  };
  const controller = createApiDebugModeController({
    logger,
    getSettings: () => settings,
    saveSettings: (patch) => (settings = { ...settings, ...patch }),
    now: () => currentTime
  });

  await controller.setEnabled(true);
  const firstExpiry = settings[API_DEBUG_EXPIRY_SETTING];
  currentTime += 30_000;
  await controller.setEnabled(true);
  assert.equal(settings[API_DEBUG_EXPIRY_SETTING], firstExpiry);
  logger.write({ ts: new Date().toISOString(), id: "req-1", kind: "request" });
  await logger.flush();

  await controller.setEnabled(false);
  assert.equal(settings.debug_api_logging, "false");
  assert.equal(fs.existsSync(path.join(dataDir, "logs")), false);
  controller.dispose();
});

test("API debug logger writes nothing without a data directory", () => {
  const logger = createApiDebugLogger({ dataDir: "" });
  assert.doesNotThrow(() => {
    logger.write({ ts: "2026-08-20T00:00:00.000Z", id: "req-1", kind: "request", method: "GET", path: "/v1/models" });
  });
});

test("sanitizeHeaders redacts sensitive values and keeps the rest", () => {
  assert.deepEqual(sanitizeHeaders({
    authorization: "Bearer secret",
    cookie: "session=abc",
    "set-cookie": ["a=1", "b=2"],
    "content-type": "application/json",
    "x-codex-turn-state": "state-1"
  }), {
    authorization: "[REDACTED]",
    cookie: "[REDACTED]",
    "set-cookie": "[REDACTED]",
    "content-type": "application/json",
    "x-codex-turn-state": "state-1"
  });
});

test("previewBody truncates long bodies and reports the full byte count", () => {
  const preview = previewBody(Buffer.from("x".repeat(20)), 10);
  assert.equal(preview.body, "x".repeat(10));
  assert.equal(preview.bodyBytes, 20);
  assert.equal(preview.truncated, true);
  const short = previewBody("hello", 10);
  assert.equal(short.body, "hello");
  assert.equal(short.truncated, false);
});

test("createBodyCapture accumulates writes and stops at the limit", () => {
  const capture = createBodyCapture(5);
  capture.push("ab");
  capture.push("cdef");
  const snapshot = capture.snapshot();
  assert.equal(snapshot.body, "abcde");
  assert.equal(snapshot.bodyBytes, 6);
  assert.equal(snapshot.truncated, true);
});

test("captureResponse collects write and end payloads until restored", () => {
  const captured: Buffer[] = [];
  const written: string[] = [];
  let ended: string | undefined;
  const res = {
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
    end(chunk: string) {
      ended = chunk;
      return this;
    }
  };
  const restore = captureResponse(res, { push: (value) => captured.push(Buffer.from(value)) });
  res.write("hello ");
  res.end("world");
  assert.equal(Buffer.concat(captured).toString(), "hello world");
  assert.deepEqual(written, ["hello "]);
  assert.equal(ended, "world");
  restore();
  res.write("after");
  assert.equal(Buffer.concat(captured).toString(), "hello world");
});

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
