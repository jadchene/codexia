import { expect, test } from "vitest";
import { createRequestMetadataParser } from "../src/main/request-metadata.ts";

test.each([1, 3, 1024])("metadata handles arbitrary chunk boundaries (%i) and ignores nested keys", (size) => {
  const data = Buffer.from(JSON.stringify({ input: [{ model: "wrong", service_tier: "wrong", text: '你好 \\"model\\": "fake"' }], model: "模型-测试", service_tier: "priority" }));
  const parser = createRequestMetadataParser();
  for (let offset = 0; offset < data.length; offset += size) parser.feed(data.subarray(offset, offset + size));
  expect(parser.finish()).toEqual({ model: "模型-测试", serviceTier: "priority" });
});
test("metadata after more than 16 MiB of input is still captured without retaining input", () => {
  const parser = createRequestMetadataParser();
  parser.feed(Buffer.from('{"input":"'));
  const chunk = Buffer.alloc(64 * 1024, 120);
  for (let i = 0; i < 300; i++) parser.feed(chunk);
  parser.feed(Buffer.from('","service_tier":"ultrafast","model":"late-model"}'));
  expect(parser.finish()).toEqual({ model: "late-model", serviceTier: "ultrafast" });
});
test.each([
  ['{"model":"old","model":"new","service_tier":null}', { model: "new", serviceTier: null }],
  ['{"model":"old","model":{ "model":"nested" },"service_tier":"fast"}', { model: "", serviceTier: "fast" }],
  ['{"model":"unterminated', { model: "", serviceTier: null }],
  [JSON.stringify({ model: "x".repeat(9000), service_tier: "fast" }), { model: "", serviceTier: "fast" }],
  ['{"mo\\u0064el":"escaped","service_tier":"priority"}', { model: "escaped", serviceTier: "priority" }]
])("metadata remains bounded with malformed, duplicate, or escaped fields", (body, result) => {
  const parser = createRequestMetadataParser(); parser.feed(Buffer.from(body as string)); expect(parser.finish()).toEqual(result);
});
