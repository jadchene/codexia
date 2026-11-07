import { expect, test, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { createAccountModeResponsesObserver } from "../src/main/account-mode-responses-observer.ts";
import { createSseUsageParser } from "../src/main/gateway/usage-parser.ts";

test("monitor WebSocket parses each message once and never creates idle timers", () => {
  const logs: Record<string, unknown>[] = [];
  const observer = createAccountModeResponsesObserver({
    store: { addTokenLog: (entry) => logs.push(entry) }, accountId: "a", request: { headers: {} } as IncomingMessage,
    requestPath: "/v1/responses", upstreamPath: "/responses", settings: { gateway_websocket_idle_timeout_ms: "1" }
  });
  const parse = vi.spyOn(JSON, "parse");
  const timer = vi.spyOn(globalThis, "setTimeout");
  const request = '{"type":"response.create","model":"test"}';
  const response = '{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}';
  try {
    observer.onDownstreamMessage(Buffer.from(request), false);
    observer.onUpstreamMessage(Buffer.from(response), false);
    expect(parse.mock.calls.filter(([value]) => value === response)).toHaveLength(1);
    expect(parse.mock.calls.filter(([value]) => value === request)).toHaveLength(1);
    expect(timer).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ total_tokens: 7, status: 200 });
  } finally { parse.mockRestore(); timer.mockRestore(); observer.dispose(); }
});
test("SSE shares its parsed event with observation and usage extraction, even if observer throws", () => {
  const parser = createSseUsageParser(() => { throw new Error("observer unavailable"); });
  const response = '{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}';
  const parse = vi.spyOn(JSON, "parse");
  try {
    parser.feed(Buffer.from(`data: ${response}\n\n`));
    expect(parser.latestUsage()).toMatchObject({ total_tokens: 7 });
    expect(parse.mock.calls.filter(([value]) => value === response)).toHaveLength(1);
  } finally { parse.mockRestore(); }
});
