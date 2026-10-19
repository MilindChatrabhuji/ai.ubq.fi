import assert from "node:assert/strict";
import { MATRIX_MODELS } from "../fixtures/provider-matrix.mjs";
import { assertSingleAdmission, dispatches, object, post, responseObject, selectProviders, settled, type MatrixContext } from "./contracts.ts";
import { progressiveBody } from "./direct.ts";

async function catalogCases(context: MatrixContext): Promise<void> {
  const headers = { authorization: `Bearer ${context.clientToken ?? "fixture-access"}` };
  const native = await responseObject(await fetch(context.url("/v1/models?client_version=0.163.0"), { headers }));
  assert(Array.isArray(native.models));
  const model = native.models.map(object).find((value) => value.slug === MATRIX_MODELS.codex);
  assert(model, "The actual account-bound upstream catalogue must supply the requested model");
  const levels = model.supported_reasoning_levels;
  assert(Array.isArray(levels));
  assert(
    levels.map(object).some((level) => level.effort === "matrix-provider-tier"),
    "Nonempty source tiers cannot be hard-coded away"
  );
  assert(levels.map(object).some((level) => level.effort === "none"));
  const ordinary = await responseObject(await fetch(context.url("/v1/models"), { headers }));
  assert.equal(ordinary.object, "list");
  assert(!("models" in ordinary));
  assert(Array.isArray(ordinary.data) && ordinary.data.some((value) => object(value).id === MATRIX_MODELS.codex));
  context.cases.push("matrix_codex_official_and_exact_version_catalogues_preserve_source_tiers");
}

async function reasoningCase(context: MatrixContext, effort: "none" | "ultra"): Promise<void> {
  const marker = `fixture:matrix:codex:${effort}`;
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS.codex, input: marker, reasoning: { effort }, stream: false });
  assert.equal((await responseObject(response)).status, "completed");
  assertSingleAdmission(await settled(context, response), "chatgpt_codex");
  const calls = dispatches(await context.events(), marker);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.provider, "codex");
  assert.equal(calls[0]?.effort, effort === "ultra" ? "max" : "none");
  assert.equal(calls[0]?.has_account, true);
  assert.equal(calls[0]?.originator, "codex_cli_rs");
  context.cases.push(`matrix_codex_${effort}_actual_upstream_translation`);
}

async function streamAndChat(context: MatrixContext): Promise<void> {
  const marker = "fixture:matrix:codex:stream";
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS.codex, input: marker, stream: true });
  await progressiveBody(response);
  assertSingleAdmission(await settled(context, response), "chatgpt_codex");
  const chat = await post(context, "/v1/chat/completions", {
    model: MATRIX_MODELS.codex,
    messages: [{ role: "user", content: "fixture:matrix:codex:chat" }],
    stream: false,
  });
  const body = await responseObject(chat);
  assert(Array.isArray(body.choices) && body.choices.length === 1);
  assert.equal(object(object(body.choices[0]).message).content, "matrix answer");
  assertSingleAdmission(await settled(context, chat), "chatgpt_codex");
  context.cases.push("matrix_codex_progressive_responses_and_chat_translation");
}

async function truncated(context: MatrixContext): Promise<void> {
  const marker = "fixture:matrix:codex:truncated";
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS.codex, input: marker, stream: true });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert(!text.includes("response.completed"));
  assert(text.includes("response.failed") || text.includes("response.incomplete"));
  const state = await settled(context, response);
  assert.equal(state.finished, true);
  // Any declared terminal seals retries; this flag does not mean successful completion.
  assert.equal(state.semantic_committed, true);
  const terminal = object(state.terminal_intent);
  assert.deepEqual(terminal, { semantic_terminal: "response.failed", reader_termination: "eof", body: "drained", delivery: "unobserved" });
  assertSingleAdmission(state, "chatgpt_codex");
  const attempts = state.attempts;
  assert(Array.isArray(attempts));
  const attempt = object(attempts[0]);
  assert.equal(attempt.phase, "Terminal");
  assert.deepEqual(attempt.observation, terminal);
  context.cases.push("matrix_codex_truncated_stream_retains_failed_terminal_without_success_or_delivery");
}

export async function codexProviderCases(context: MatrixContext): Promise<void> {
  await selectProviders(context, ["codex"]);
  await catalogCases(context);
  await reasoningCase(context, "none");
  await reasoningCase(context, "ultra");
  await streamAndChat(context);
  await truncated(context);
}
