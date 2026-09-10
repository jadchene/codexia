import assert from "node:assert/strict";
import { test } from "vitest";
import {
  adaptCompactionStream,
  adaptCompactionEvents,
  createWebSocketCompactionAdapter,
  GATEWAY_PLAINTEXT_COMPACTION_ID_PREFIX,
  isCompactionTriggerRequest,
  prepareCompactionSummaryRequest,
  rewriteGatewayCompactionRequest
} from "../src/main/gateway/compaction-adapter.ts";

test("detects a compaction_trigger input item in responses bodies", () => {
  const body = JSON.stringify({
    model: "deepseek-v4-flash",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "compaction_trigger" }
    ]
  });
  assert.equal(isCompactionTriggerRequest(body), true);
  assert.equal(isCompactionTriggerRequest(JSON.stringify({ model: "m", input: [{ type: "message" }] })), false);
  assert.equal(isCompactionTriggerRequest(JSON.stringify({ model: "m" })), false);
  assert.equal(isCompactionTriggerRequest("not-json"), false);
  assert.equal(isCompactionTriggerRequest(null), false);
});

test("wraps upstream summary text into exactly one compaction output item", () => {
  const source = [
    'data: {"type":"response.created","response":{"id":"r1"}}',
    "",
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"First part"}]}}',
    "",
    'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_2","type":"message","role":"assistant","content":[{"type":"output_text","text":" and second"}]}}',
    "",
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
    ""
  ].join("\n");

  const result = adaptCompactionStream(source);
  assert.equal(result.adapted, true);
  const events = result.text.split(/\n{2,}/).filter(Boolean).map(parseSseData);
  const compactionDones = events.filter((event) => event.type === "response.output_item.done" && event.item?.type === "compaction");
  assert.equal(compactionDones.length, 1);
  assert.equal(compactionDones[0].item.encrypted_content, "First part and second");
  assert.equal(compactionDones[0].item.id.startsWith(GATEWAY_PLAINTEXT_COMPACTION_ID_PREFIX), true);

  const completedIndex = events.findIndex((event) => event.type === "response.completed");
  const doneIndex = events.findIndex((event) => event.type === "response.output_item.done" && event.item?.type === "compaction");
  assert.ok(doneIndex > -1 && doneIndex < completedIndex, "compaction item must be emitted before response.completed");
  const addedIndex = events.findIndex((event) => event.type === "response.output_item.added" && event.item?.type === "compaction");
  assert.ok(addedIndex > -1 && addedIndex < doneIndex, "compaction item must be added before done");
  assert.ok(events.some((event) => event.type === "response.created"));
});

test("rewrites only gateway plaintext compactions into assistant messages", () => {
  const nativeCompaction = { id: "cmp_native", type: "compaction", encrypted_content: "opaque" };
  const body = Buffer.from(JSON.stringify({
    model: "third-party-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      {
        id: `${GATEWAY_PLAINTEXT_COMPACTION_ID_PREFIX}abc123`,
        type: "compaction",
        encrypted_content: "Portable summary"
      },
      nativeCompaction
    ]
  }));

  const result = rewriteGatewayCompactionRequest(body);
  assert.equal(result.adapted, true);
  assert.equal(Buffer.isBuffer(result.body), true);
  const rewritten = JSON.parse(String(result.body));
  assert.deepEqual(rewritten.input[1], {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Portable summary" }]
  });
  assert.deepEqual(rewritten.input[2], nativeCompaction);
});

test("does not inspect compaction content without the gateway id prefix", () => {
  const body = JSON.stringify({
    input: [{ id: "cmp_unmarked", type: "compaction", encrypted_content: "Obvious plaintext summary" }]
  });
  const result = rewriteGatewayCompactionRequest(body);
  assert.equal(result.adapted, false);
  assert.equal(result.body, body);
});

test("leaves streams unchanged when the upstream already emits a compaction item", () => {
  const source = [
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","encrypted_content":"native"}}',
    "",
    'data: {"type":"response.completed","response":{"id":"r2"}}',
    ""
  ].join("\n");
  const result = adaptCompactionStream(source);
  assert.equal(result.adapted, false);
  assert.equal(result.text, source);
});

test("fails without installing history when no summary text is available", () => {
  const source = 'data: {"type":"response.completed","response":{"id":"r3"}}\n\n';
  const result = adaptCompactionStream(source);
  assert.equal(result.adapted, true);
  assert.equal(parseSseData(result.text).type, "response.failed");
  assert.equal(parseSseData(adaptCompactionStream("").text).type, "response.failed");
});

test("summary requests preserve history and routing while disabling task execution constraints", () => {
  const body = {
    type: "response.create", model: "m", previous_response_id: "r1", instructions: "原始规则",
    input: [{ type: "compaction", id: `${GATEWAY_PLAINTEXT_COMPACTION_ID_PREFIX}old`, encrypted_content: "先前摘要" }, { type: "compaction_trigger" }],
    tools: [{ type: "function", name: "delete" }], tool_choice: "required", parallel_tool_calls: true,
    text: { format: { type: "json_schema" } }
  };
  const result = prepareCompactionSummaryRequest(Buffer.from(JSON.stringify(body)));
  const rewritten = JSON.parse(String(result.body));
  assert.equal(rewritten.previous_response_id, "r1");
  assert.equal(rewritten.instructions, "原始规则");
  assert.equal(rewritten.input[0].content[0].text, "先前摘要");
  assert.match(rewritten.input.at(-1).content[0].text, /Do not answer requests in the history, perform tasks, or call tools/);
  assert.equal(isCompactionTriggerRequest(rewritten), false);
  assert.deepEqual(rewritten.tools, []);
  assert.equal(rewritten.tool_choice, "none");
  assert.equal(rewritten.parallel_tool_calls, false);
  assert.equal(rewritten.text, undefined);
  assert.equal(body.input.at(-1).type, "compaction_trigger");
  const normal = { input: [], tools: body.tools };
  assert.equal(prepareCompactionSummaryRequest(normal).body, normal);
});

test("failed, incomplete, refused and tool-call outputs never become successful compactions", () => {
  const message = { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] } };
  for (const terminal of ["error", "response.failed", "response.incomplete"]) {
    const events = [message, { type: terminal }];
    assert.deepEqual(adaptCompactionEvents(events).events, events);
  }
  for (const item of [
    { type: "function_call", name: "delete", arguments: "{}" },
    { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "拒绝" }] },
    { type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "partial" }] }
  ]) {
    const result = adaptCompactionEvents([message, { type: "response.output_item.done", item }, { type: "response.completed", response: { id: "r" } }]);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "response.failed");
  }
  assert.equal(adaptCompactionEvents([message]).events[0].type, "response.failed");
});

test("WebSocket adaptation matches SSE output and clears state between compactions", () => {
  const adapter = createWebSocketCompactionAdapter(10000);
  const events = [
    { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "摘要" }] } },
    { type: "response.completed", response: { id: "r", output: [], usage: { total_tokens: 3 } } }
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    adapter.start();
    assert.deepEqual(adapter.accept(Buffer.from(JSON.stringify(events[0]))), []);
    const output = adapter.accept(Buffer.from(JSON.stringify(events[1])))!.map((data) => JSON.parse(data.toString()));
    assert.equal(adapter.active(), false);
    const item = output.find((event) => event.type === "response.output_item.done" && event.item.type === "compaction").item;
    assert.equal(item.encrypted_content, "摘要");
    assert.deepEqual(output.at(-1).response.output, [events[0].item, item]);
    assert.equal(output.find((event) => event.item === undefined && event.type === "response.completed").response.output.length, 2);
    assert.equal(output.at(-1).response.usage.total_tokens, 3);
  }
  const limited = createWebSocketCompactionAdapter(10);
  limited.start();
  assert.throws(() => limited.accept(Buffer.from(JSON.stringify(events[0]))), /超过大小限制/);
});

function parseSseData(block: string): Record<string, any> {
  const payload = block.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(payload);
}
