import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "../src/main/store.ts";
import { createRequestLogWriter } from "../src/main/request-log-writer.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-log-writer-"));
  const dbPath = path.join(dir, "test.sqlite");
  const store = createStore({ dataDir: dir, dbPath, secretCodec: { encrypt: (v: string) => v, decrypt: (v: string) => v } });
  const errors = vi.fn();
  const writer = createRequestLogWriter(dbPath, errors);
  cleanups.push(async () => { await writer.close().catch(() => {}); store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, writer, errors };
}
test("worker persists batches, preserves enqueue timestamps, and flushes before clearing", async () => {
  const { store, writer } = fixture();
  for (let i = 0; i < 130; i++) expect(writer.enqueue({ method: "POST", status: 200, total_tokens: i, created_at: 12345 })).toBe(true);
  await writer.flush();
  expect(store.db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS t FROM request_logs").get()).toMatchObject({ n: 130, t: 12345 });
  expect(store.clearTokenLogs().deleted).toBe(130);
  writer.enqueue({ method: "WS", total_tokens: 7 });
  await writer.close();
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM request_logs").get()).toMatchObject({ n: 1 });
});
test("queue overload is bounded and reported without throwing into forwarding", async () => {
  const { writer, errors } = fixture();
  const accepted = Array.from({ length: 1100 }, () => writer.enqueue({ method: "POST" })).filter(Boolean).length;
  expect(accepted).toBe(1024);
  await writer.flush();
  expect(errors).toHaveBeenCalledOnce();
});
test("a locked database stalls the worker, not the main event loop", async () => {
  const { store, writer } = fixture();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    writer.enqueue({ method: "POST", total_tokens: 12 });
    const flushed = writer.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    store.db.exec("COMMIT");
    await flushed;
    expect(store.db.prepare("SELECT total_tokens AS n FROM request_logs").get()).toMatchObject({ n: 12 });
  } catch (error) { try { store.db.exec("ROLLBACK"); } catch {} throw error; }
});
test("worker write failures reject flush without failing enqueue", async () => {
  const { store, writer } = fixture();
  store.db.exec("DROP TABLE request_logs");
  expect(writer.enqueue({ method: "POST" })).toBe(true);
  await expect(writer.flush()).rejects.toThrow(/写入失败/);
  expect(writer.enqueue({ method: "POST" })).toBe(false);
});
