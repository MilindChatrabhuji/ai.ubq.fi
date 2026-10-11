import assert from "node:assert/strict";
import { createAnthropicReplayStore } from "../src/provider/anthropic-replay.ts";

const context = { scope: "opaque-authenticated-principal", provider: "surplus", model: "claude-opus-5.5" };
const fixture = (suffix = "turn1", summary = true) => {
  const nativeBlocks = [
    { type: "thinking", thinking: "Inspect the input.", signature: "real-provider-signature" },
    { type: "redacted_thinking", data: "real-provider-opaque-block" },
    { type: "text", text: "Reading the file." },
    { type: "tool_use", id: `call-${suffix}`, name: "read_file", input: { path: "a.txt", lines: 3 } },
  ];
  const output: Record<string, unknown>[] = [
    ...(summary
      ? [{ type: "reasoning", id: `rs_resp_${suffix}_0`, status: "completed", summary: [{ type: "summary_text", text: "Inspect the input." }] }]
      : []),
    {
      type: "message",
      id: `msg_resp_${suffix}_2`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Reading the file.", annotations: [] }],
    },
    {
      type: "function_call",
      id: `fc_resp_${suffix}_3`,
      status: "completed",
      call_id: `call-${suffix}`,
      name: "read_file",
      arguments: '{"path":"a.txt","lines":3}',
    },
  ];
  return { ...context, nativeBlocks, output };
};

Deno.test("Anthropic replay restores complete signed blocks and original order within authenticated history", () => {
  const store = createAnthropicReplayStore();
  const receipt = fixture();
  assert.equal(store.remember(receipt), true);
  const question = { type: "message", role: "user", content: "Read a.txt" };
  const result = { type: "function_call_output", call_id: "call-turn1", output: "file contents" };
  assert.deepEqual(store.restore([question, ...receipt.output, result], context), [
    { type: "original", item: question },
    { type: "native_assistant", blocks: receipt.nativeBlocks },
    { type: "original", item: result },
  ]);
});

Deno.test("Anthropic replay accepts official Codex nulls and removed status/annotations without private wire data", () => {
  const store = createAnthropicReplayStore();
  const receipt = fixture();
  assert.equal(store.remember(receipt), true);
  const replay = [
    { ...receipt.output[0], status: undefined, content: null, encrypted_content: null },
    { ...receipt.output[1], status: undefined, content: [{ type: "output_text", text: "Reading the file." }], phase: null },
    { ...receipt.output[2], status: undefined, namespace: null, encrypted_function_args: null, arguments: '{ "lines": 3, "path": "a.txt" }' },
  ];
  assert.deepEqual(store.restore(replay, context), [{ type: "native_assistant", blocks: receipt.nativeBlocks }]);
  assert.equal(JSON.stringify(receipt.output).includes("real-provider-signature"), false);
  assert.equal(JSON.stringify(receipt.output).includes("encrypted_content"), false);
});

Deno.test("Anthropic replay restores hidden thinking/redacted blocks when summaries were disabled", () => {
  const store = createAnthropicReplayStore();
  const receipt = fixture("hidden1", false);
  assert.equal(store.remember(receipt), true);
  assert.deepEqual(store.restore(receipt.output, context), [{ type: "native_assistant", blocks: receipt.nativeBlocks }]);
});

Deno.test("Anthropic replay never resolves another principal, provider, model or absent scope", () => {
  const store = createAnthropicReplayStore();
  for (const summary of [true, false]) {
    const receipt = fixture(`scope${Number(summary)}`, summary);
    assert.equal(store.remember(receipt), true);
    for (const changed of [{ scope: "another-principal" }, { provider: "metered" }, { model: "claude-other" }, { scope: "" }]) {
      assert.equal(store.restore(receipt.output, { ...context, ...changed }), null);
    }
  }
});

Deno.test("Anthropic replay rejects opaque or unknown reasoning and unknown native output IDs", () => {
  const store = createAnthropicReplayStore();
  assert.equal(store.restore([{ type: "reasoning", summary: [] }], context), null);
  assert.equal(store.restore([{ type: "reasoning", id: "rs_external", summary: [], encrypted_content: "opaque-upstream-content" }], context), null);
  assert.equal(store.restore(fixture("unknown1", false).output, context), null);
  const ordinary = { type: "function_call", id: "fc_external", call_id: "call", name: "read", arguments: "{}" };
  assert.deepEqual(store.restore([ordinary], context), [{ type: "original", item: ordinary }]);
});

Deno.test("Anthropic replay falls back on tampered content, reordered/missing/duplicated output groups", () => {
  const store = createAnthropicReplayStore();
  const receipt = fixture();
  assert.equal(store.remember(receipt), true);
  for (const input of [
    receipt.output.slice(1),
    receipt.output.slice(0, 2),
    [receipt.output[0], receipt.output[2], receipt.output[1]],
    [...receipt.output, ...receipt.output],
    [{ ...receipt.output[0], summary: [{ type: "summary_text", text: "changed" }] }, ...receipt.output.slice(1)],
    [receipt.output[0], { ...receipt.output[1], content: [{ type: "output_text", text: "changed" }] }, receipt.output[2]],
    [receipt.output[0], receipt.output[1], { ...receipt.output[2], arguments: '{"path":"secret.txt"}' }],
    [{ ...receipt.output[0], encrypted_content: "opaque" }, ...receipt.output.slice(1)],
    [{ ...receipt.output[0], content: [{ type: "reasoning_text", text: "unknown" }] }, ...receipt.output.slice(1)],
  ])
    assert.equal(store.restore(input, context), null);
});

Deno.test("Anthropic replay clones retained and returned native blocks so callers cannot mutate receipts", () => {
  const store = createAnthropicReplayStore();
  const receipt = fixture();
  const original = structuredClone(receipt.nativeBlocks);
  assert.equal(store.remember(receipt), true);
  receipt.nativeBlocks[0].signature = "changed";
  const first = store.restore(receipt.output, context);
  assert.equal(first?.[0].type, "native_assistant");
  assert.deepEqual(first[0].blocks, original);
  first[0].blocks[0].signature = "changed-again";
  assert.deepEqual(store.restore(receipt.output, context), [{ type: "native_assistant", blocks: original }]);
});

Deno.test("Anthropic replay expires receipts without extending TTL on reads, including hidden-summary turns", () => {
  let at = 100;
  const store = createAnthropicReplayStore({ now: () => at, ttlMs: 10 });
  const receipt = fixture("expires1", false);
  assert.equal(store.remember(receipt), true);
  at = 109;
  assert.notEqual(store.restore(receipt.output, context), null);
  at = 110;
  assert.equal(store.restore(receipt.output, context), null);
});

Deno.test("Anthropic replay bounds receipt count and evicts oldest without refreshing lookup order", () => {
  const store = createAnthropicReplayStore({ maxEntries: 2 });
  const first = fixture("old1");
  const second = fixture("old2");
  const third = fixture("new3");
  assert.equal(store.remember(first), true);
  assert.equal(store.remember(second), true);
  assert.notEqual(store.restore(first.output, context), null);
  assert.equal(store.remember(third), true);
  assert.equal(store.restore(first.output, context), null);
  assert.notEqual(store.restore(second.output, context), null);
  assert.notEqual(store.restore(third.output, context), null);
});

Deno.test("Anthropic replay bounds retained bytes and refuses oversized individual receipts", () => {
  const small = fixture("small1");
  const store = createAnthropicReplayStore({ maxBytes: 1700 });
  assert.equal(store.remember(small), true);
  const second = fixture("small2");
  assert.equal(store.remember(second), true);
  assert.equal(store.restore(small.output, context), null);
  assert.notEqual(store.restore(second.output, context), null);
  assert.equal(createAnthropicReplayStore({ maxEntryBytes: 100 }).remember(fixture()), false);
});

Deno.test("Anthropic replay rejects unsigned thinking, invalid tools, inconsistent public output and ID collisions", () => {
  const store = createAnthropicReplayStore();
  const unsigned = fixture("unsigned1");
  unsigned.nativeBlocks[0].signature = "";
  assert.equal(store.remember(unsigned), false);
  const mismatch = fixture("mismatch1");
  mismatch.nativeBlocks[2].text = "different";
  assert.equal(store.remember(mismatch), false);
  const invalid = fixture("invalid1");
  invalid.output[2].arguments = "invalid-json";
  assert.equal(store.remember(invalid), false);
  const duplicate = fixture("duplicate1");
  duplicate.output[1].id = duplicate.output[0].id;
  assert.equal(store.remember(duplicate), false);
  const receipt = fixture();
  assert.equal(store.remember(receipt), true);
  assert.equal(store.remember(receipt), false);
  assert.notEqual(store.restore(receipt.output, context), null);
});

Deno.test("Anthropic replay rejects excessive blocks, non-JSON numbers and circular native state", () => {
  const store = createAnthropicReplayStore();
  const receipt = fixture();
  assert.equal(store.remember({ ...receipt, nativeBlocks: Array.from({ length: 257 }, () => receipt.nativeBlocks[0]) }), false);
  const nonJson = fixture("nonjson1");
  nonJson.nativeBlocks[3].input = { path: "a.txt", lines: Number.NaN };
  assert.equal(store.remember(nonJson), false);
  const circular = fixture("cycle1");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(store.remember({ ...circular, nativeBlocks: [...circular.nativeBlocks, cycle] }), false);
});

const chatFixture = (suffix = "chat1", summary = true) => {
  const { output } = fixture(suffix, summary);
  return {
    ...context,
    output,
    assistant: {
      role: "assistant",
      content: "Reading the file.",
      reasoning_details: [
        { type: "reasoning.text", text: "Inspect the input.", signature: "original-chat-signature", format: "anthropic-claude-v1", index: 0 },
      ],
      tool_calls: [{ id: `call-${suffix}`, type: "function", function: { name: "read_file", arguments: '{"path":"a.txt","lines":3}' } }],
    },
  };
};

Deno.test("Anthropic Chat replay preserves exact original assistant and reasoning_details with Chat provenance", () => {
  const store = createAnthropicReplayStore();
  const receipt = chatFixture();
  assert.equal(store.rememberChat(receipt), true);
  assert.deepEqual(store.restoreChat(receipt.output, context), [{ type: "native_chat_assistant", message: receipt.assistant }]);
  assert.equal(store.restore(receipt.output, context), null);
  const native = fixture("native1");
  assert.equal(store.remember(native), true);
  assert.equal(store.restoreChat(native.output, context), null);
  assert.notEqual(store.restore(native.output, context), null);
  assert.equal(JSON.stringify(receipt.output).includes("original-chat-signature"), false);
});

Deno.test("Anthropic Chat replay keeps original details when explicit summaries were disabled", () => {
  const store = createAnthropicReplayStore();
  const receipt = chatFixture("hiddenchat1", false);
  assert.equal(store.rememberChat(receipt), true);
  assert.deepEqual(store.restoreChat(receipt.output, context), [{ type: "native_chat_assistant", message: receipt.assistant }]);
  for (const changed of [{ scope: "another-principal" }, { provider: "metered" }, { model: "claude-other" }]) {
    assert.equal(store.restoreChat(receipt.output, { ...context, ...changed }), null);
  }
});

Deno.test("Anthropic Chat replay validates namespaced and freeform tool mapping without converting original wire fields", () => {
  const store = createAnthropicReplayStore();
  const namespaced = chatFixture("namespace1");
  namespaced.assistant.tool_calls[0].function.name = "functions__read_file";
  namespaced.output[2].namespace = "functions";
  const toolNames = new Map([["functions__read_file", { name: "read_file", namespace: "functions" }]]);
  assert.equal(store.rememberChat({ ...namespaced, toolNames }), true);
  assert.deepEqual(store.restoreChat(namespaced.output, context), [{ type: "native_chat_assistant", message: namespaced.assistant }]);
  const tampered = [...namespaced.output];
  tampered[2] = { ...tampered[2], namespace: "other" };
  assert.equal(store.restoreChat(tampered, context), null);

  const custom = chatFixture("custom1", false);
  custom.assistant.tool_calls[0].function = { name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' };
  custom.output[1] = {
    type: "custom_tool_call",
    id: "ctc_resp_custom1_3",
    call_id: "call-custom1",
    name: "apply_patch",
    input: "*** Begin Patch\n*** End Patch",
  };
  assert.equal(store.rememberChat({ ...custom, customToolNames: new Set(["apply_patch"]) }), true);
  assert.deepEqual(store.restoreChat(custom.output, context), [{ type: "native_chat_assistant", message: custom.assistant }]);
});

Deno.test("Anthropic Chat replay shares expiry, byte/count bounds and clone isolation with Messages receipts", () => {
  let at = 100;
  const store = createAnthropicReplayStore({ now: () => at, ttlMs: 10, maxEntries: 1 });
  const chat = chatFixture("isolatedchat1", false);
  const original = structuredClone(chat.assistant);
  assert.equal(store.rememberChat(chat), true);
  chat.assistant.reasoning_details[0].signature = "changed-after-publication";
  const first = store.restoreChat(chat.output, context);
  assert.equal(first?.[0].type, "native_chat_assistant");
  first[0].message.reasoning_details = [];
  assert.deepEqual(store.restoreChat(chat.output, context), [{ type: "native_chat_assistant", message: original }]);
  assert.equal(store.remember(fixture("nativeeviction1")), true);
  assert.equal(store.restoreChat(chat.output, context), null);
  const second = chatFixture("expireschat2", false);
  assert.equal(store.rememberChat(second), true);
  at = 110;
  assert.equal(store.restoreChat(second.output, context), null);
  assert.equal(createAnthropicReplayStore({ maxEntryBytes: 100 }).rememberChat(chatFixture()), false);
});

Deno.test("Anthropic Chat replay rejects unknown reasoning variants, malformed tools, tampering and partial groups", () => {
  const store = createAnthropicReplayStore();
  const malformed = chatFixture("malformedchat1");
  malformed.assistant.reasoning_details[0].signature = "";
  assert.equal(store.rememberChat(malformed), false);
  const opaque = chatFixture("opaquechat1");
  opaque.assistant.reasoning_details[0].type = "reasoning.encrypted";
  assert.equal(store.rememberChat(opaque), false);
  const invalid = chatFixture("invalidchat1");
  invalid.assistant.tool_calls[0].function.arguments = "invalid-json";
  assert.equal(store.rememberChat(invalid), false);
  const receipt = chatFixture();
  assert.equal(store.rememberChat(receipt), true);
  assert.equal(store.restoreChat(receipt.output.slice(1), context), null);
  assert.equal(store.restoreChat([...receipt.output, ...receipt.output], context), null);
  const altered = [{ ...receipt.output[0], encrypted_content: "opaque" }, ...receipt.output.slice(1)];
  assert.equal(store.restoreChat(altered, context), null);
});

Deno.test("Anthropic Chat replay preserves refusal and prefers canonical readable reasoning content", () => {
  const store = createAnthropicReplayStore();
  const receipt = chatFixture("prioritychat1");
  receipt.assistant.reasoning_details[0].text = "Original signed detail.";
  assert.equal(store.rememberChat({ ...receipt, assistant: { ...receipt.assistant, reasoning_content: "Inspect the input." } }), true);
  const refused = {
    ...context,
    assistant: { role: "assistant", content: null, refusal: "Cannot do that." },
    output: [{ type: "message", id: "msg_resp_refused1_0", role: "assistant", content: [{ type: "refusal", refusal: "Cannot do that." }] }],
  };
  assert.equal(store.rememberChat(refused), true);
  assert.deepEqual(store.restoreChat(refused.output, context), [{ type: "native_chat_assistant", message: refused.assistant }]);
});

Deno.test("Anthropic Chat replay preserves provider reasoning spelling and its readable precedence", () => {
  const store = createAnthropicReplayStore();
  const receipt = chatFixture("nativereasoning1");
  receipt.assistant.reasoning_details[0].text = "Original signed detail.";
  const assistant = { ...receipt.assistant, reasoning: "Inspect the input." };
  assert.equal(store.rememberChat({ ...receipt, assistant }), true);
  assert.deepEqual(store.restoreChat(receipt.output, context), [{ type: "native_chat_assistant", message: assistant }]);
  assert.equal(store.rememberChat({ ...chatFixture("badreasoning1"), assistant: { ...assistant, reasoning: 10 } }), false);
});
