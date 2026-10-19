import assert from "node:assert/strict";
import { captureUnexpectedStatus } from "./failure-capture.ts";
import { MATRIX_MODELS } from "../fixtures/provider-matrix.mjs";
import { assertSingleAdmission, dispatches, object, post, responseObject, selectProviders, settled, type MatrixContext } from "./contracts.ts";

export async function progressiveBody(response: Response): Promise<string> {
  await captureUnexpectedStatus(response, 200);
  assert.equal(response.status, 200);
  assert(response.headers.get("content-type")?.startsWith("text/event-stream"));
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let contentBeforeTerminal = false;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    text += decoder.decode(part.value, { stream: true });
    if (text.includes("matrix ") && !text.includes("response.completed")) contentBeforeTerminal = true;
  }
  text += decoder.decode();
  assert(contentBeforeTerminal, "Actual output content must reach the client before the completion terminal");
  assert(text.includes("response.completed"));
  return text;
}

async function successfulSurface(context: MatrixContext, provider: "lithos" | "openrouter", stream: boolean): Promise<void> {
  const marker = `fixture:matrix:${provider}:${stream ? "stream" : "json"}`;
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS[provider], input: marker, stream });
  if (stream) await progressiveBody(response);
  else {
    const body = await responseObject(response);
    assert.equal(body.status, "completed");
    assert(JSON.stringify(body.output).includes("matrix answer"));
  }
  const state = await settled(context, response);
  assertSingleAdmission(state, provider);
  assert.equal(object(state.terminal_intent).semantic_terminal, "response.completed");
  const calls = dispatches(await context.events(), marker);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.provider, provider);
  assert.equal(calls[0]?.model, MATRIX_MODELS[provider]);
  assert.equal(calls[0]?.wire, provider === "lithos" ? "chat" : "responses");
  context.cases.push(`matrix_${provider}_responses_${stream ? "progressive_sse" : "json"}_one_original_admission`);
}

async function chatSurface(context: MatrixContext, provider: "lithos" | "openrouter"): Promise<void> {
  const marker = `fixture:matrix:${provider}:chat`;
  const response = await post(context, "/v1/chat/completions", {
    model: MATRIX_MODELS[provider],
    messages: [{ role: "user", content: marker }],
    stream: false,
  });
  const body = await responseObject(response);
  assert(Array.isArray(body.choices) && body.choices.length === 1);
  assert.equal(object(object(body.choices[0]).message).content, "matrix answer");
  assertSingleAdmission(await settled(context, response), provider);
  const calls = dispatches(await context.events(), marker);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.provider, provider);
  assert.equal(calls[0]?.wire, "chat");
  context.cases.push(`matrix_${provider}_chat_json_actual_wire`);
}

async function transientIsNotCapacity(context: MatrixContext, provider: "lithos" | "openrouter"): Promise<void> {
  const marker = `fixture:matrix:${provider}:transient`;
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS[provider], input: marker, stream: false });
  assert.equal(response.status, 503);
  await response.arrayBuffer();
  const state = await settled(context, response);
  assert.equal(state.semantic_committed, false);
  const calls = dispatches(await context.events(), marker);
  assert(calls.length >= 1);
  assert(
    calls.every((call) => call.provider === provider),
    "A transient refusal cannot manufacture another provider's exhaustion proof"
  );
  context.cases.push(`matrix_${provider}_503_no_invented_capacity_failover`);
}

export async function directProviderCases(context: MatrixContext): Promise<void> {
  for (const provider of ["lithos", "openrouter"] as const) {
    await selectProviders(context, [provider]);
    await successfulSurface(context, provider, false);
    await successfulSurface(context, provider, true);
    await chatSurface(context, provider);
    await transientIsNotCapacity(context, provider);
  }
}
