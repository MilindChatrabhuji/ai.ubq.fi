import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DEEPSEEK_WATERFALL_MODEL_ID } from "../../../src/deepseek/waterfall.ts";
import { MATRIX_MODELS } from "../fixtures/provider-matrix.mjs";
import { assertSingleAdmission, dispatches, object, post, responseObject, selectProviders, settled, type MatrixContext } from "./contracts.ts";

const policy = { version: "deepseek-forwarded-payload/v1", mode: "bytes", per_message_limit: 65_536 };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const bytes = (value: string): number => Buffer.byteLength(value);
const tools = [
  {
    type: "function",
    name: "lookup",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  { type: "custom", name: "apply_patch" },
];

function records(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value));
  return value.map(object);
}

async function oneDispatch(context: MatrixContext, marker: string, provider: string): Promise<Record<string, unknown>> {
  const calls = dispatches(await context.events(), marker).filter((call) => call.provider === provider);
  assert.equal(calls.length, 1, "The actual controlled upstream must observe exactly one dispatch");
  const call = object(calls[0]);
  assert.equal(call.provider, provider);
  return call;
}

/** A client-side SSE reader, not a provider transform or replay oracle. */
async function streamedCompletion(response: Response, expectedDelta = "replay"): Promise<Record<string, unknown>> {
  assert.equal(response.status, 200);
  assert(response.headers.get("content-type")?.startsWith("text/event-stream"));
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let pending = "";
  let progressive = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    let deltaThisRead = false;
    pending += decoder.decode(chunk.value, { stream: true });
    const blocks = pending.split(/\r?\n\r?\n/u);
    pending = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event = object(JSON.parse(data));
      if (typeof event.type === "string" && event.type.endsWith(".delta") && typeof event.delta === "string" && event.delta.includes(expectedDelta)) {
        deltaThisRead = true;
      }
      events.push(event);
    }
    progressive ||= deltaThisRead && !events.some((event) => event.type === "response.completed");
  }
  pending += decoder.decode();
  assert.equal(pending.trim(), "", "The actual response must end at a complete SSE boundary");
  assert(progressive, "Actual replay producer deltas must precede its semantic completion");
  const terminal = events.filter((event) => event.type === "response.completed");
  assert.equal(terminal.length, 1);
  return object(terminal[0]?.response);
}

function assertProduced(output: Record<string, unknown>[]): void {
  assert.deepEqual(
    output.map((item) => item.type),
    ["reasoning", "message", "function_call", "custom_tool_call"]
  );
  for (const [index, prefix] of ["rs_", "msg_", "fc_", "ctc_"].entries()) {
    const id = output[index]?.id;
    assert(typeof id === "string" && id.startsWith(`${prefix}resp_`));
  }
  assert.equal(records(output[0]?.summary)[0]?.text, "replay thought é");
  assert.equal(records(output[1]?.content)[0]?.text, "replay answer 😀");
  assert.equal(output[2]?.call_id, "call_context_lookup");
  assert.equal(output[3]?.call_id, "call_context_patch");
  assert.equal(output[3]?.input, "*** Begin Patch\nfixture😀\n*** End Patch");
}

function assertCodexRoundTrip(input: Record<string, unknown>[], marker: string): void {
  assert.deepEqual(
    input.map((item) => item.type),
    ["message", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "message"]
  );
  assert(
    input.slice(0, 3).every((item) => !("id" in item)),
    "Only synthetic item IDs are omitted on the Codex wire"
  );
  assert.equal(records(input[0]?.content)[0]?.text, "replay answer 😀");
  assert.equal(input[1]?.call_id, "call_context_lookup");
  assert.equal(input[1]?.arguments, '{"query":"kept😀"}');
  assert.equal(input[2]?.call_id, "call_context_patch");
  assert.equal(input[2]?.input, "*** Begin Patch\nfixture😀\n*** End Patch");
  assert.equal(input[3]?.call_id, "call_context_lookup");
  assert.equal(input[3]?.output, "lookup result é😀");
  assert.equal(input[4]?.call_id, "call_context_patch");
  assert.equal(records(input[5]?.content)[0]?.text, marker);
}

async function producerRoundTrip(context: MatrixContext, stream: boolean): Promise<void> {
  const kind = stream ? "sse" : "buffered";
  const marker = `fixture:matrix:replay:producer-${kind}`;
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS.lithos, input: marker, tools, stream });
  const produced = stream ? await streamedCompletion(response) : await responseObject(response);
  assert.equal(produced.status, "completed");
  const output = records(produced.output);
  assertProduced(output);
  assertSingleAdmission(await settled(context, response), "lithos");
  const nextMarker = `fixture:matrix:replay:codex-${kind}`;
  const history = [
    ...structuredClone(output),
    { type: "function_call_output", call_id: "call_context_lookup", output: "lookup result é😀" },
    { type: "custom_tool_call_output", call_id: "call_context_patch", output: "patch applied 😀" },
    { type: "message", role: "user", content: [{ type: "input_text", text: nextMarker }] },
  ];
  const snapshot = JSON.stringify(history);
  const replay = await post(context, "/v1/responses", { model: MATRIX_MODELS.codex, input: history, tools, stream: false });
  assert.equal((await responseObject(replay)).status, "completed");
  assertSingleAdmission(await settled(context, replay), "chatgpt_codex");
  assertCodexRoundTrip(records((await oneDispatch(context, nextMarker, "codex")).context_input), nextMarker);
  assert.equal(JSON.stringify(history), snapshot, "The adopted history is not rewritten by the client");
  const original = await post(context, "/v1/responses", { model: MATRIX_MODELS.lithos, input: history, tools, stream: false });
  assert.equal((await responseObject(original)).status, "completed");
  assertSingleAdmission(await settled(context, original), "lithos");
  const messages = records((await oneDispatch(context, nextMarker, "lithos")).context_messages);
  assert(messages.some((message) => typeof message.reasoning_content === "string" && message.reasoning_content.includes("replay thought é")));
  assert(messages.some((message) => message.role === "tool" && message.tool_call_id === "call_context_lookup" && message.content === "lookup result é😀"));
  assert.deepEqual(
    dispatches(await context.events(), nextMarker).map((call) => call.provider),
    ["codex", "lithos"]
  );
  assert.equal(JSON.stringify(history), snapshot);
  context.cases.push(`matrix_actual_lithos_${kind}_output_replayed_to_codex_keeps_calls_unicode_and_original_history`);
}

export async function legacyReplay(context: MatrixContext): Promise<void> {
  const marker = "fixture:matrix:replay:legacy";
  const responseId = "resp_197c782c84e54851b12fbae3fc396d7e";
  const genuine = "rs_03375d708dca4424016abf51952afc87d1824eacab5be80344";
  const genuineMessage = "msg_03375d708dca4424016abf51971e4887d1acd5ea8e0c400198";
  const longId = `resp_${"a".repeat(41)}_rs_0`;
  const history = [
    { type: "reasoning", id: `${responseId}_rs_0`, summary: [{ type: "summary_text", text: "drop local thought" }] },
    { type: "message", id: `${responseId}_msg_0`, role: "assistant", content: [{ type: "output_text", text: "legacy answer 😀" }] },
    { type: "function_call", id: `${responseId}_fc_0`, call_id: "call_legacy", name: "lookup", arguments: '{"query":"é😀"}' },
    { type: "function_call_output", call_id: "call_legacy", output: "legacy result 😀" },
    { type: "reasoning", id: `rs_${responseId}_1`, encrypted_content: "fixture-synthetic-opaque", summary: [] },
    { type: "reasoning", id: `rs_${responseId}_2`, encrypted_content: "", summary: [] },
    { type: "reasoning", id: genuine, encrypted_content: "fixture-genuine-opaque", summary: [{ type: "summary_text", text: "keep genuine" }] },
    { type: "message", id: genuineMessage, role: "assistant", content: [{ type: "output_text", text: "genuine answer é" }] },
    { type: "message", id: "msg_resp_chatcmplABC123_0", role: "assistant", content: [{ type: "output_text", text: "nonhex synthetic answer" }] },
    { type: "reasoning", id: `rs_resp_${"a".repeat(40)}_0`, encrypted_content: "fixture-forty-opaque", summary: [] },
    { type: "message", id: "resp_custom_item_0", role: "user", content: [{ type: "input_text", text: "unrelated id" }] },
    { type: "reasoning", id: longId, summary: [] },
    { type: "message", role: "user", content: [{ type: "input_text", text: marker }] },
  ];
  const snapshot = JSON.stringify(history);
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS.codex, input: history, tools, stream: false });
  assert.equal((await responseObject(response)).status, "completed");
  assertSingleAdmission(await settled(context, response), "chatgpt_codex");
  const input = records((await oneDispatch(context, marker, "codex")).context_input);
  assert.equal(input.length, 11);
  assert.deepEqual(
    input.map((item) => item.id ?? null),
    // Source message normalization reconstructs only type/role/content before Codex replay.
    [null, null, null, null, genuine, null, null, null, null, longId, null]
  );
  assert.equal(records(input[0]?.content)[0]?.text, "legacy answer 😀");
  assert.equal(input[1]?.call_id, "call_legacy");
  assert.equal(input[2]?.call_id, "call_legacy");
  assert.equal(input[3]?.encrypted_content, "fixture-synthetic-opaque");
  assert.equal(input[4]?.encrypted_content, "fixture-genuine-opaque");
  assert.equal(input[7]?.encrypted_content, "fixture-forty-opaque");
  assert.equal(JSON.stringify(history), snapshot);
  context.cases.push("matrix_exact_legacy_replay_drops_only_unencrypted_synthetic_reasoning_preserves_genuine_and_nonmatching_ids");
}

/** Requires a fresh codex namespace with the existing fixed Lithos binding. */
export async function replayProviderCases(context: MatrixContext): Promise<void> {
  await selectProviders(context, ["lithos", "codex"]);
  await producerRoundTrip(context, false);
  await producerRoundTrip(context, true);
  await legacyReplay(context);
}

function unicodeVectors(): { name: string; output: string; prefix: string }[] {
  const limit = policy.per_message_limit;
  const withEmoji = (prefix: string): string => prefix + "😀" + "a".repeat(limit + 1_024 - prefix.length - 2);
  const byteLoop = "é".repeat(10_000) + "a".repeat(43_082);
  const marker = "é".repeat(6_552) + "a".repeat(46_530);
  // Exact committed source fixtures, not a JavaScript implementation of reduction.
  return [
    { name: "initial", output: withEmoji("a".repeat(limit - 1)), prefix: "a".repeat(58_981) },
    { name: "byte-loop", output: withEmoji(byteLoop), prefix: byteLoop },
    { name: "marker-reservation", output: withEmoji(marker), prefix: marker },
    { name: "ascii", output: "a".repeat(limit + 1_024), prefix: "a".repeat(58_982) },
    { name: "bmp", output: "é".repeat(limit + 1_024), prefix: "é".repeat(31_343) },
  ];
}

function unicodeInput(output: string, marker: string): Record<string, unknown>[] {
  return [
    { type: "function_call", name: "read_file", arguments: "{}", call_id: "call_unicode" },
    { type: "function_call_output", call_id: "call_unicode", output },
    { type: "message", role: "user", content: [{ type: "input_text", text: marker }] },
  ];
}

function elisionMarker(omitted: number): string {
  return `\n[gateway: ${policy.version} elided ${String(omitted)} bytes omitted; the model did not receive the elided bytes; this route forwards at most ${String(policy.per_message_limit)} bytes per message because the provider counts forwarded payloads as text tokens]`;
}

async function assertUnicodeWire(context: MatrixContext, output: string, expected: string, prefix: string, marker: string, truncation?: string): Promise<void> {
  const response = await post(context, "/v1/responses", {
    model: MATRIX_MODELS.lithos,
    input: unicodeInput(output, marker),
    stream: false,
    ...(truncation ? { truncation } : {}),
  });
  assert.equal((await responseObject(response)).status, "completed");
  assertSingleAdmission(await settled(context, response), "lithos");
  const wire = object((await oneDispatch(context, marker, "lithos")).unicode);
  assert.equal(wire.sha256, hash(expected), "Actual upstream receives the complete exact source vector, not merely an under-limit prefix");
  assert.equal(wire.prefix_sha256, hash(prefix));
  assert.equal(wire.marker, expected === output ? null : elisionMarker(bytes(output) - bytes(prefix)));
  assert.equal(wire.bytes, bytes(expected));
  assert.equal(wire.tool_call_id, "call_unicode");
  assert.equal(wire.well_formed, true);
  assert.equal(wire.replacement_character, false);
  assert(bytes(expected) <= policy.per_message_limit);
}

/** Requires a fresh codex namespace for the exact versioned catalog assertion. */
export async function unicodeForwardingCases(context: MatrixContext): Promise<void> {
  await selectProviders(context, ["lithos", "codex"]);
  const catalog = await responseObject(
    await fetch(context.url("/v1/models?client_version=0.163.0"), { headers: { authorization: `Bearer ${context.clientToken ?? "fixture-access"}` } })
  );
  const model = records(catalog.models).find((row) => row.slug === MATRIX_MODELS.lithos);
  assert(model);
  assert.deepEqual(model.forwarding_policy, policy);
  context.cases.push("matrix_native_catalog_advertises_exact_versioned_utf8_forwarding_policy");
  for (const fixture of unicodeVectors()) {
    const expected = fixture.prefix + elisionMarker(bytes(fixture.output) - bytes(fixture.prefix));
    for (const truncation of [undefined, "auto"]) {
      const marker = `fixture:matrix:unicode:${fixture.name}-${truncation ?? "default"}`;
      await assertUnicodeWire(context, fixture.output, expected, fixture.prefix, marker, truncation);
      context.cases.push(`matrix_unicode_${fixture.name}_${truncation ?? "default"}_exact_source_forwarded_wire`);
    }
  }
  const inBudget = "é😀".repeat(10_000);
  await assertUnicodeWire(context, inBudget, inBudget, inBudget, "fixture:matrix:unicode:verbatim");
  context.cases.push("matrix_in_budget_unicode_tool_result_is_forwarded_verbatim");
  const fixture = unicodeVectors()[2];
  assert(fixture);
  const marker = "fixture:matrix:unicode:disabled";
  const refused = await responseObject(
    await post(context, "/v1/responses", { model: MATRIX_MODELS.lithos, input: unicodeInput(fixture.output, marker), truncation: "disabled", stream: false }),
    400
  );
  const error = object(refused.error);
  assert.equal(error.code, "context_length_exceeded");
  assert.equal(error.param, "input[1].output");
  assert.equal(
    error.message,
    `input item input[1].output (tool call call_unicode) carries ${String(bytes(fixture.output))} bytes; this route forwards at most ${String(policy.per_message_limit)} bytes per message under ${policy.version}, and the request set truncation 'disabled', so the gateway will not reduce it. Reduce the payload or send truncation 'auto' to allow the declared reduction.`
  );
  assert.equal(dispatches(await context.events(), marker).length, 0, "Disabled truncation must refuse before any actual upstream fetch");
  context.cases.push("matrix_disabled_unicode_truncation_preserves_exact_source_error_and_zero_dispatch");
}

const compactionMetadata = JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses" } });
const oldCompactionResult = "Obsolete tool result with its original evidence. ".repeat(100);
const keptCompactionText = "retain_compaction_fallback_artifact";

function compactionInput(marker: string): Record<string, unknown>[] {
  const message = (role: string, text: string): Record<string, unknown> => ({ type: "message", role, content: [{ type: "input_text", text }] });
  return [
    message("user", `Keep ${keptCompactionText} ${marker} verbatim while completing the release.`),
    message("assistant", "Inspecting old evidence."),
    { type: "function_call", call_id: "old_a", name: "shell", arguments: '{"command":"read old evidence"}' },
    { type: "function_call_output", call_id: "old_a", output: oldCompactionResult },
    { type: "function_call", call_id: "old_b", name: "shell", arguments: '{"command":"read more old evidence"}' },
    { type: "function_call_output", call_id: "old_b", output: oldCompactionResult },
    message("assistant", "The old investigation is finished."),
    message("user", "First recent follow-up: draft the release outline."),
    message("assistant", "Drafted."),
    message("user", "Second recent follow-up: check the artifact."),
    message("assistant", "Checked."),
    message("user", `Final goal: retain ${keptCompactionText} ${marker}.`),
    message("user", "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary."),
  ];
}

function compactionRequest(context: MatrixContext, marker: string, metadata?: string, stream = true, model = "deepseek-flash"): Promise<Response> {
  return fetch(context.url("/v1/responses"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${context.clientToken ?? "fixture-access"}`,
      "content-type": "application/json",
      connection: "close",
      ...(metadata === undefined ? {} : { "x-codex-turn-metadata": metadata }),
    },
    body: JSON.stringify({ model, input: compactionInput(marker), stream, reasoning: { effort: "low" }, max_output_tokens: 128 }),
  });
}

function jevCalls(events: unknown[], marker: string): Record<string, unknown>[] {
  return events.map(object).filter((event) => event.kind === "matrix_compaction_jev" && event.marker === marker);
}

export async function compactionHeaderControls(context: MatrixContext): Promise<void> {
  const controls = [
    undefined,
    "{not json",
    JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses_compaction_v2" } }),
    JSON.stringify({ request_kind: "turn", compaction: { implementation: "responses" } }),
  ];
  for (const [index, metadata] of controls.entries()) {
    const marker = `fixture:matrix:compaction:ordinary-${String(index)}`;
    const response = await compactionRequest(context, marker, metadata, false);
    assert.equal((await responseObject(response)).status, "completed");
    assert.equal(response.headers.get("x-jev-compaction"), null);
    assertSingleAdmission(await settled(context, response), "deepseek");
    assert.equal(jevCalls(await context.events(), marker).length, 0, "Only the exact header predicate may invoke Jev");
    await oneDispatch(context, marker, "deepseek");
  }
  context.cases.push("matrix_compaction_header_absent_malformed_wrong_implementation_and_ordinary_turn_do_not_invoke_jev");
}

async function compactionFailedFallback(context: MatrixContext, mode: "failure" | "partial"): Promise<void> {
  const created = await responseObject(
    await context.post(
      "/admin/api-keys",
      { name: "compaction one-request fixture", usage_limit_requests: 1, window_ms: 3_600_000, paid_fallback_enabled: false },
      context.adminToken ?? "fixture-admin"
    )
  );
  assert(typeof created.token === "string" && typeof created.id === "string");
  const client = { ...context, clientToken: created.token };
  const marker = `fixture:matrix:compaction:${mode}`;
  const response = await compactionRequest(client, marker, compactionMetadata, true, DEEPSEEK_WATERFALL_MODEL_ID);
  assert.equal((await streamedCompletion(response, "matrix ")).status, "completed");
  assert.equal(response.headers.get("x-jev-compaction"), null, "A failed or partial Jev result cannot become an adopted summary");
  const id = response.headers.get("x-uos-request-id");
  assert(id);
  const state = await settled(context, response);
  assert.equal(object(state.context).request_id, id);
  assert.equal(object(state.api).request_id, id);
  assert.equal(object(state.api).key_id, created.id);
  const calls = dispatches(await context.events(), marker);
  const providers = mode === "failure" ? ["lithos", "deepseek"] : ["lithos"];
  assert.deepEqual(
    calls.map((call) => call.provider),
    providers
  );
  assert.deepEqual(
    records(state.attempts).map((attempt) => attempt.provider),
    providers
  );
  assert(records(state.attempts).every((attempt) => attempt.transport_started === true));
  for (const call of calls) {
    const messages = records(call.compaction_messages);
    for (const callId of ["old_a", "old_b"]) {
      assert(messages.some((message) => message.role === "tool" && message.tool_call_id === callId && message.sha256 === hash(oldCompactionResult)));
    }
    assert(
      messages.some(
        (message) => message.role === "user" && message.sha256 === hash(`Keep ${keptCompactionText} ${marker} verbatim while completing the release.`)
      )
    );
  }
  const decisions = jevCalls(await context.events(), marker);
  assert.equal(decisions.length, 1, "The actual Worker must invoke the decision service before this fallback");
  assert.equal(decisions[0]?.model, "~typesafe/jev-latest");
  const questions = decisions[0]?.questions;
  assert(Array.isArray(questions));
  const names: string[] = [];
  for (const name of questions) {
    assert(typeof name === "string");
    names.push(name);
  }
  assert.deepEqual(names, ["call_t1", "result_t1", "call_t2", "result_t2"]);
  const blockedMarker = `fixture:matrix:compaction:quota-${mode}`;
  const blocked = await post(client, "/v1/responses", { model: "deepseek-flash", input: blockedMarker, stream: false });
  assert.equal(blocked.status, 429, "The completed fallback must consume the key's sole dispatch allowance");
  await blocked.arrayBuffer();
  assert.equal(dispatches(await context.events(), blockedMarker).length, 0);
  context.cases.push(`matrix_compaction_${mode}_fallback_preserves_original_input_admission_and_one_request_quota`);
}

/** Uses real fallback journals; local-success/cancellation accounting waits for M05's finite observation API. */
export async function compactionFallbackCases(context: MatrixContext): Promise<void> {
  await selectProviders(context, ["lithos", "deepseek", "openrouter"]);
  await compactionHeaderControls(context);
  await selectProviders(context, ["lithos", "deepseek", "openrouter", "ubiquity"]);
  await compactionFailedFallback(context, "failure");
  await compactionFailedFallback(context, "partial");
  await selectProviders(context, ["lithos", "deepseek", "openrouter"]);
}
