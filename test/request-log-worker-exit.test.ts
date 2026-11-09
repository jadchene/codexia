import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ worker: null as any }));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    constructor() { super(); state.worker = this; }
    postMessage = vi.fn();
    terminate = vi.fn().mockResolvedValue(0);
  }
}));
import { createRequestLogWriter } from "../src/main/request-log-writer.ts";

test("closing rejects immediately if the worker exits before acknowledging its batch", async () => {
  const writer = createRequestLogWriter("unused.sqlite", vi.fn());
  writer.enqueue({ status: 200 });
  const closed = writer.close();
  const rejected = expect(closed).rejects.toThrow(/意外退出/);
  state.worker.emit("exit", 1);
  await rejected;
  expect(writer.failed).toBe(true);
});
