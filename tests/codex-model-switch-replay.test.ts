import { test } from "bun:test";
import assert from "node:assert/strict";

import { toDeepSeekChatMessages } from "../src/deepseek/chat-projection.ts";
import { type DeepSeekResponsesEcho, toDeepSeekResponsesPayload } from "../src/deepseek/responses-payload.ts";
import { createDeepSeekResponsesStreamTranslator } from "../src/deepseek/responses-stream.ts";
import { buildCodexRequest } from "../src/models/codex-models-fetch.ts";
import { buildResponsesUpstreamBodies } from "../src/responses-request.ts";
import type { ResponseInputItem } from "../src/types.ts";

/**
 * Model-switch replay: the Chat-only routes (DeepSeek, LithosAI, Cerebras)
 * synthesize Responses item ids that the Codex upstream rejects once the
 * conversation is replayed there. These tests pin both halves of the repair:
 * the emitted ids carry the official type prefixes, and the Codex request seam
 * removes gateway-local provenance from an already-stored history without
 * touching genuine OpenAI items or any other provider's replay.
 */

const echo: DeepSeekResponsesEcho = { tools: undefined, tool_choice: undefined, parallel_tool_calls: true, instructions: null };

/** The exact responseId shape the Chat-only routes mint: `resp_` + alphanumerics. */
const INCIDENT_RESPONSE_ID = "resp_197c782c84e54851b12fbae3fc396d7e";

const codexBodyInput = (items: ResponseInputItem[]): Record<string, unknown>[] => {
  const body = buildCodexRequest("gpt-6.1-sol", items, {});
  return body.input as Record<string, unknown>[];
};

const chatCompletion = (message: Record<string, unknown>): Record<string, unknown> => ({
  id: "chatcmpl-1",
  created: 1_780_000_000,
  choices: [{ index: 0, message, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

test("model-switch replay: buffered output item ids carry the official type prefixes", () => {
  const payload = toDeepSeekResponsesPayload(
    chatCompletion({
      role: "assistant",
      content: "pong",
      reasoning_content: "The request asked for one word.",
      tool_calls: [
        { id: "call_fn", type: "function", function: { name: "lookup", arguments: "{}" } },
        { id: "call_ctc", type: "function", function: { name: "apply_patch", arguments: '{"input":"hi"}' } },
      ],
    }),
    "deepseek-flash",
    INCIDENT_RESPONSE_ID,
    echo,
    new Map(),
    new Set(["apply_patch"])
  );
  assert.deepEqual(
    (payload.output as Record<string, unknown>[]).map((item) => item.id),
    [`rs_${INCIDENT_RESPONSE_ID}_0`, `msg_${INCIDENT_RESPONSE_ID}_0`, `fc_${INCIDENT_RESPONSE_ID}_0_0`, `ctc_${INCIDENT_RESPONSE_ID}_0_1`]
  );
});

test("model-switch replay: streamed output item ids carry the official type prefixes", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", INCIDENT_RESPONSE_ID, echo, 1_780_000_000, new Map(), new Set(["exec"]));
  const events: Record<string, unknown>[] = [];
  events.push(...translator.push({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think" } }] }));
  events.push(...translator.push({ choices: [{ index: 0, delta: { content: "pong" } }] }));
  events.push(
    ...translator.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_fn", function: { name: "lookup", arguments: "{}" } },
              { index: 1, id: "call_ctc", function: { name: "exec", arguments: '{"input":"text(hi);"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
  );
  events.push(...translator.finish());

  assert.deepEqual(
    events.filter((event) => event.type === "response.output_item.added").map((event) => (event.item as Record<string, unknown>).id),
    [`rs_${INCIDENT_RESPONSE_ID}_0`, `msg_${INCIDENT_RESPONSE_ID}_0`, `fc_${INCIDENT_RESPONSE_ID}_0`, `ctc_${INCIDENT_RESPONSE_ID}_1`]
  );

  // The custom call keeps one official id across its added, delta and terminal events.
  const customId = `ctc_${INCIDENT_RESPONSE_ID}_1`;
  const customAdded = events.find((event) => event.type === "response.output_item.added" && (event.item as Record<string, unknown>).id === customId) as
    { item: Record<string, unknown> } | undefined;
  assert.equal(customAdded?.item.type, "custom_tool_call");
  assert.deepEqual(
    events.filter((event) => event.type === "response.custom_tool_call_input.delta").map((event) => event.item_id),
    [customId]
  );
  const terminal = events.at(-1) as { response: Record<string, unknown> };
  assert.deepEqual(
    (terminal.response.output as Record<string, unknown>[]).filter((item) => item.id === customId),
    [{ id: customId, type: "custom_tool_call", status: "completed", call_id: "call_ctc", name: "exec", input: "text(hi);" }]
  );
});

test("model-switch replay: a legacy synthetic function-call id is omitted and its pair and order survive", () => {
  const items: ResponseInputItem[] = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Use the previous result to answer only pong." }] },
    {
      type: "function_call",
      id: `${INCIDENT_RESPONSE_ID}_fc_0`,
      call_id: "call_c2b91f389bde48e2add2262c",
      name: "exec_command",
      arguments: '{"cmd":"echo pong"}',
    },
    { type: "function_call_output", call_id: "call_c2b91f389bde48e2add2262c", output: "pong" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Reply only pong." }] },
  ];
  const snapshot = structuredClone(items);

  assert.deepEqual(codexBodyInput(items), [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Use the previous result to answer only pong." }] },
    { type: "function_call", call_id: "call_c2b91f389bde48e2add2262c", name: "exec_command", arguments: '{"cmd":"echo pong"}' },
    { type: "function_call_output", call_id: "call_c2b91f389bde48e2add2262c", output: "pong" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Reply only pong." }] },
  ]);
  assert.deepEqual(items, snapshot);
});

test("model-switch replay: a legacy synthetic reasoning item without encrypted replay is dropped", () => {
  const items: ResponseInputItem[] = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Reply only pong." }] },
    {
      id: "resp_e5e0060cd7e14be8ac967e1edb8509d7_rs_0",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "I will answer briefly." }],
      encrypted_content: "",
      content: [],
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue. Reply only pong." }] },
  ];

  assert.deepEqual(codexBodyInput(items), [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Reply only pong." }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue. Reply only pong." }] },
  ]);
});

test("model-switch replay: a replayed gateway completion is repaired on the Codex seam", () => {
  const payload = toDeepSeekResponsesPayload(
    chatCompletion({
      role: "assistant",
      content: "pong",
      reasoning_content: "The request asked for one word.",
      tool_calls: [{ id: "call_fn", type: "function", function: { name: "lookup", arguments: "{}" } }],
    }),
    "deepseek-flash",
    INCIDENT_RESPONSE_ID,
    echo
  );
  const replayed = payload.output as ResponseInputItem[];

  assert.deepEqual(codexBodyInput(replayed), [
    { type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
    { type: "function_call", status: "completed", call_id: "call_fn", name: "lookup", arguments: "{}" },
  ]);
});

test("model-switch replay: future gateway-prefixed item ids are recognized as gateway-local", () => {
  const items: ResponseInputItem[] = [
    { id: `rs_${INCIDENT_RESPONSE_ID}_0`, type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
    { id: `msg_${INCIDENT_RESPONSE_ID}_0`, type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
    { id: `fc_${INCIDENT_RESPONSE_ID}_0_0`, type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "pong" },
    { id: `ctc_${INCIDENT_RESPONSE_ID}_0_0`, type: "custom_tool_call", call_id: "call_2", name: "exec", input: "text(hi);" },
    { type: "custom_tool_call_output", call_id: "call_2", output: "ok" },
  ];

  assert.deepEqual(codexBodyInput(items), [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "pong" },
    { type: "custom_tool_call", call_id: "call_2", name: "exec", input: "text(hi);" },
    { type: "custom_tool_call_output", call_id: "call_2", output: "ok" },
  ]);
});

test("model-switch replay: both producer responseId shapes are recognized", () => {
  // `src/deepseek/handlers.ts` mints `resp_` plus up to 40 alphanumerics of the
  // provider request id (or a UUID), so a non-hex id and the 40-character slice
  // are both legitimate gateway provenance.
  const providerRequestId = "resp_chatcmplABC123";
  const longestSlice = `resp_${"a".repeat(40)}`;
  const items: ResponseInputItem[] = [
    { id: `${providerRequestId}_msg_0`, type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
    { id: `${providerRequestId}_rs_0`, type: "reasoning", summary: [] },
    { id: `${longestSlice}_ctc_0_0`, type: "custom_tool_call", call_id: "call_1", name: "exec", input: "hi" },
    { id: `msg_${providerRequestId}_0`, type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
    { id: `rs_${longestSlice}_0`, type: "reasoning", summary: [] },
  ];

  assert.deepEqual(codexBodyInput(items), [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
    { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "hi" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
  ]);
});

test("model-switch replay: genuine OpenAI and unrelated item ids pass through untouched", () => {
  const items: ResponseInputItem[] = [
    {
      id: "rs_03375d708dca4424016abf51952afc87d1824eacab5be80344",
      type: "reasoning",
      encrypted_content: "gAAAAAencrypted",
      summary: [{ type: "summary_text", text: "thought" }],
    },
    {
      id: "msg_03375d708dca4424016abf51971e4887d1acd5ea8e0c400198",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    },
    {
      id: "fc_03375d708dca4424016abf519532c087d1b18faf96f016e5b9",
      type: "function_call",
      call_id: "call_03375d708dca4424016abf519532c087d1b18faf96f016e5b9",
      name: "lookup",
      arguments: "{}",
    },
    { id: "resp_custom_item_0", type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    // The producer slices its responseId to 40 characters, so a longer run
    // cannot be a gateway id and must stay untouched.
    { id: `resp_${"a".repeat(41)}_rs_0`, type: "reasoning", summary: [] },
  ];

  assert.deepEqual(codexBodyInput(items), items);
});

test("model-switch replay: the seam leaves the source input intact for the DeepSeek replay", () => {
  const items: ResponseInputItem[] = [
    { type: "reasoning", id: "resp_e5e0060cd7e14be8ac967e1edb8509d7_rs_0", summary: [{ type: "summary_text", text: "keep me" }] },
    { type: "function_call", id: `${INCIDENT_RESPONSE_ID}_fc_0`, call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "pong" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
  ];
  const snapshot = structuredClone(items);

  codexBodyInput(items);

  assert.deepEqual(items, snapshot);
  const projected = toDeepSeekChatMessages(items, null);
  assert.deepEqual(projected.ok ? projected.value : null, [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      reasoning_content: "keep me",
    },
    { role: "tool", tool_call_id: "call_1", content: "pong" },
    { role: "user", content: "go" },
  ]);
});

test("model-switch replay: the Responses assembler repairs the Codex body and returns the original input to the removed provider", () => {
  const items: ResponseInputItem[] = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Use the previous result to answer only pong." }] },
    { id: `${INCIDENT_RESPONSE_ID}_rs_0`, type: "reasoning", summary: [{ type: "summary_text", text: "legacy thought" }], encrypted_content: "", content: [] },
    { id: `rs_${INCIDENT_RESPONSE_ID}_1`, type: "reasoning", summary: [{ type: "summary_text", text: "future thought" }] },
    {
      id: "rs_03375d708dca4424016abf51952afc87d1824eacab5be80344",
      type: "reasoning",
      encrypted_content: "gAAAAAencrypted",
      summary: [{ type: "summary_text", text: "genuine" }],
    },
    { id: `${INCIDENT_RESPONSE_ID}_fc_0`, type: "function_call", call_id: "call_1", name: "exec_command", arguments: '{"cmd":"echo pong"}' },
    { type: "function_call_output", call_id: "call_1", output: "pong" },
    { id: `ctc_${INCIDENT_RESPONSE_ID}_0_0`, type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "text(hi);" },
    { type: "custom_tool_call_output", call_id: "call_2", output: "Done!" },
    { id: `msg_${INCIDENT_RESPONSE_ID}_0`, type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
  ];
  const snapshot = structuredClone(items);

  const { codexBody, removedProviderBody } = buildResponsesUpstreamBodies("gpt-6.1-sol", items, "be brief", { effort: "low" }, {});

  assert.equal(codexBody.input !== items, true);
  assert.deepEqual(codexBody.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Use the previous result to answer only pong." }] },
    {
      id: "rs_03375d708dca4424016abf51952afc87d1824eacab5be80344",
      type: "reasoning",
      encrypted_content: "gAAAAAencrypted",
      summary: [{ type: "summary_text", text: "genuine" }],
    },
    { type: "function_call", call_id: "call_1", name: "exec_command", arguments: '{"cmd":"echo pong"}' },
    { type: "function_call_output", call_id: "call_1", output: "pong" },
    { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "text(hi);" },
    { type: "custom_tool_call_output", call_id: "call_2", output: "Done!" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] },
  ]);
  assert.equal(removedProviderBody.input, items);
  assert.equal(codexBody.model, "gpt-6.1-sol");
  assert.equal(codexBody.stream, true);
  assert.equal(codexBody.store, false);
  assert.equal(removedProviderBody.stream, true);
  assert.equal(removedProviderBody.store, false);
  assert.equal(codexBody.instructions, "be brief");
  assert.deepEqual(codexBody.reasoning, { effort: "low" });
  assert.deepEqual(items, snapshot);
});
