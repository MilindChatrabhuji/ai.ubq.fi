import { test } from "bun:test";
import assert from "node:assert/strict";
import { toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";
import { FORWARDED_PAYLOAD_POLICY } from "../src/deepseek/forwarded-payload-policy.ts";

const limit = FORWARDED_PAYLOAD_POLICY.perMessageLimit;
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const withEmoji = (prefix: string): string => prefix + "😀" + "a".repeat(limit + 1_024 - prefix.length - 2);
const byteLoopPrefix = "é".repeat(10_000) + "a".repeat(43_082);
const markerPrefix = "é".repeat(6_552) + "a".repeat(46_530);
const fixtures = [
  { name: "initial surrogate cut", output: withEmoji("a".repeat(limit - 1)), prefix: "a".repeat(58_981) },
  { name: "second UTF-8 byte-loop cut", output: withEmoji(byteLoopPrefix), prefix: byteLoopPrefix },
  { name: "marker-reservation surrogate cut", output: withEmoji(markerPrefix), prefix: markerPrefix },
  { name: "ordinary ASCII reduction", output: "a".repeat(limit + 1_024), prefix: "a".repeat(58_982) },
  { name: "ordinary BMP reduction", output: "é".repeat(limit + 1_024), prefix: "é".repeat(31_343) },
];

const request = (output: string, truncation?: string): Record<string, unknown> => ({
  input: [
    { type: "function_call", name: "read_file", arguments: "{}", call_id: "call_unicode" },
    { type: "function_call_output", call_id: "call_unicode", output },
  ],
  ...(truncation === undefined ? {} : { truncation }),
});

// These positions distinguish the later reduction seams from the already
// guarded initial slice. Both original payloads contain complete emoji pairs.
test("forwarded payload Unicode: fixtures reach the byte loop and marker reservation", () => {
  const byteLoopOutput = withEmoji(byteLoopPrefix);
  assert.equal(byteLength(byteLoopOutput.slice(0, limit)) > limit, true);
  assert.equal(byteLength(byteLoopOutput.slice(0, 58_982)) > limit, true);
  assert.equal(byteLength(byteLoopOutput.slice(0, 53_083)) <= limit, true);
  assert.equal(byteLoopOutput.charCodeAt(53_082), 0xd83d);
  assert.equal(byteLoopOutput.charCodeAt(53_083), 0xde00);

  const markerOutput = withEmoji(markerPrefix);
  assert.equal(byteLength(markerOutput.slice(0, limit)) > limit, true);
  assert.equal(byteLength(markerOutput.slice(0, 58_982)), limit);
  assert.equal(markerOutput.charCodeAt(53_082), 0xd83d);
  assert.equal(markerOutput.charCodeAt(53_083), 0xde00);
});

for (const fixture of fixtures) {
  for (const truncation of [undefined, "auto"]) {
    test(`forwarded payload Unicode: ${fixture.name} (${truncation ?? "default"})`, () => {
      assert.equal(fixture.output.isWellFormed(), true);
      const result = toDeepSeekResponsesChatBody(request(fixture.output, truncation), "deepseek-flash", false);
      if (!result.ok) throw new Error(result.message);
      const messages = result.value.body.messages as Record<string, unknown>[];
      const tool = messages.at(-1);
      assert.equal(tool?.role, "tool");
      const content = tool.content;
      assert.ok(typeof content === "string");
      const markerIndex = content.indexOf("\n[gateway:");
      assert.notEqual(markerIndex, -1);
      const prefix = content.slice(0, markerIndex);
      const marker = content.slice(markerIndex);
      const originalBytes = byteLength(fixture.output);
      const omittedBytes = originalBytes - byteLength(prefix);
      assert.equal(prefix, fixture.prefix);
      assert.equal(fixture.output.startsWith(prefix), true);
      assert.equal(content.isWellFormed(), true);
      assert.equal(new TextDecoder().decode(new TextEncoder().encode(content)), content);
      assert.equal(byteLength(content), byteLength(prefix) + byteLength(marker));
      assert.equal(byteLength(content) <= limit, true);
      assert.equal(marker.includes(`${FORWARDED_PAYLOAD_POLICY.version} elided ${omittedBytes} bytes omitted;`), true);
      assert.equal(marker.includes("the model did not receive the elided bytes"), true);
      assert.equal(marker.includes(`at most ${limit} bytes per message`), true);
      assert.deepEqual(result.value.elisions, [
        { path: "input[1].output", callId: "call_unicode", kind: "tool_output", originalBytes, forwardedBytes: byteLength(content), omittedBytes },
      ]);
    });
  }
}

test("forwarded payload Unicode: in-budget emoji and BMP content stays verbatim", () => {
  const output = "é😀".repeat(10_000);
  assert.equal(byteLength(output) <= limit, true);
  const result = toDeepSeekResponsesChatBody(request(output), "deepseek-flash", false);
  if (!result.ok) throw new Error(result.message);
  const messages = result.value.body.messages as Record<string, unknown>[];
  assert.equal(messages.at(-1)?.content, output);
  assert.deepEqual(result.value.elisions, []);
});

test("forwarded payload Unicode: disabled truncation rejects without reduction", () => {
  const output = withEmoji(markerPrefix);
  const result = toDeepSeekResponsesChatBody(request(output, "disabled"), "deepseek-flash", false);
  if (result.ok) throw new Error("expected oversized Unicode output to be rejected");
  assert.equal(result.code, "context_length_exceeded");
  assert.equal(result.param, "input[1].output");
  assert.equal(result.message.includes(`carries ${byteLength(output)} bytes`), true);
  assert.equal(result.message.includes(`at most ${limit} bytes per message`), true);
  assert.equal(result.message.includes("truncation 'disabled'"), true);
});
