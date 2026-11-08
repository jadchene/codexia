import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

type Entry = Record<string, unknown>;

/** One bounded queue and one in-flight batch: disk stalls never block forwarding. */
export function createRequestLogWriter(dbPath: string, onError: (message: string) => void = console.warn, onCommitted: () => void = () => {}) {
  const bundled = new URL("./request-log-worker.mjs", import.meta.url);
  const worker = new Worker(existsSync(bundled) ? bundled : new URL("./request-log-worker.ts", import.meta.url), { workerData: { dbPath } });
  const queue: { entry: Entry; bytes: number; sequence: number }[] = [];
  const waiters: { sequence: number; resolve: () => void; reject: (error: Error) => void }[] = [];
  let queuedBytes = 0;
  let sequence = 0;
  let acknowledged = 0;
  let inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let failed: Error | undefined;
  let closed = false;
  let overflowReported = false;

  const report = (message: string) => setImmediate(() => { try { onError(message); } catch {} });
  const fail = (message: string) => {
    if (failed) return;
    failed = new Error(message);
    clearTimeout(timer); clearTimeout(deadline);
    queue.length = 0; queuedBytes = 0;
    for (const waiter of waiters.splice(0)) waiter.reject(failed);
    report(message);
    void worker.terminate();
  };
  const send = () => {
    clearTimeout(timer); timer = undefined;
    if (failed || inFlight || !queue.length) return;
    const batch = queue.splice(0, 64);
    for (const item of batch) queuedBytes -= item.bytes;
    inFlight = batch[batch.length - 1]!.sequence;
    deadline = setTimeout(() => fail("监控日志写入超时，待写日志未确认；请求转发不受影响。"), 5000);
    try { worker.postMessage({ entries: batch.map((item) => item.entry) }); }
    catch { fail("监控日志写入线程不可用，待写日志未确认。 "); }
  };
  worker.on("message", (message) => {
    if (failed) return;
    clearTimeout(deadline);
    if (!message.ok) { fail("监控日志批量写入失败，待写日志未确认；请求转发不受影响。"); return; }
    acknowledged = inFlight; inFlight = 0;
    try { onCommitted(); } catch {}
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.sequence <= acknowledged) waiters.splice(i, 1)[0]!.resolve();
    }
    setImmediate(send);
  });
  worker.on("error", () => fail("监控日志写入线程发生错误，待写日志未确认。"));
  worker.on("exit", () => { if (!closed) fail("监控日志写入线程意外退出，待写日志未确认。"); });

  const flush = (): Promise<void> => {
    if (failed) return Promise.reject(failed);
    if (sequence <= acknowledged) return Promise.resolve();
    const result = new Promise<void>((resolve, reject) => waiters.push({ sequence, resolve, reject }));
    send();
    return result;
  };
  return {
    get failed() { return Boolean(failed); },
    enqueue(entry: Entry): boolean {
      if (closed || failed) return false;
      const snapshot = { ...entry, created_at: entry.created_at ?? Math.floor(Date.now() / 1000) };
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      if (queue.length >= 1024 || queuedBytes + bytes > 4 * 1024 * 1024) {
        if (!overflowReported) { overflowReported = true; report("监控日志队列已满，部分新日志被丢弃；请求继续转发。"); }
        return false;
      }
      queue.push({ entry: snapshot, bytes, sequence: ++sequence }); queuedBytes += bytes;
      if (!timer && !inFlight) timer = setTimeout(send, 25);
      return true;
    },
    flush,
    async close() {
      closed = true;
      try { await flush(); }
      finally { clearTimeout(timer); clearTimeout(deadline); await worker.terminate(); }
    }
  };
}

/** Recover on subsequent requests; a failed write must not hide historical logs. */
export function createMonitorLogWriter(dbPath: string, onCommitted: () => void, onError: (message: string) => void = console.warn) {
  let writer: ReturnType<typeof createRequestLogWriter> | undefined;
  let closed = false;
  return {
    enqueue(entry: Entry): boolean {
      if (closed) return false;
      if (writer?.failed) writer = undefined;
      writer ??= createRequestLogWriter(dbPath, onError, onCommitted);
      return writer.enqueue(entry);
    },
    async flush() {
      const current = writer;
      try { await current?.flush(); }
      catch { if (writer === current) writer = undefined; }
    },
    async close() {
      closed = true;
      await writer?.close();
    }
  };
}
