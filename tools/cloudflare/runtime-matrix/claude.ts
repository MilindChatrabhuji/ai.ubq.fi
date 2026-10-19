import assert from "node:assert/strict";
import { MATRIX_KEYS, MATRIX_MODELS } from "../fixtures/provider-matrix.mjs";
import { assertSingleAdmission, createClient, dispatches, object, post, responseObject, selectProviders, settled, type MatrixContext } from "./contracts.ts";
import { progressiveBody } from "./direct.ts";

async function allow(context: MatrixContext, ids: string[]): Promise<void> {
  await responseObject(await context.post("/admin/providers/claude-code/access", { allowed_key_ids: ids }, context.adminToken ?? "fixture-admin"));
}

export async function claudeProviderCases(context: MatrixContext): Promise<void> {
  await selectProviders(context, ["claude_code"]);
  const key = await createClient(context);
  const client = { ...context, clientToken: key.token };
  const configured = await responseObject(
    await context.post(
      "/admin/providers/claude-code/auth",
      { credential: MATRIX_KEYS.claude, create_new: true, activate: true, label: "controlled matrix" },
      context.adminToken ?? "fixture-admin"
    )
  );
  assert(typeof configured.account_id === "string");
  await allow(context, [key.id]);
  const marker = "fixture:matrix:claude:none";
  const response = await post(client, "/v1/responses", { model: MATRIX_MODELS.claude, input: marker, reasoning: { effort: "none" }, stream: false });
  assert.equal((await responseObject(response)).status, "completed");
  assertSingleAdmission(await settled(context, response), "claude_code");
  const calls = dispatches(await context.events(), marker);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.wire, "anthropic");
  assert.equal(calls[0]?.anthropic_version, "2023-06-01");
  assert.equal(calls[0]?.thinking, "disabled", "Only actual fresh model capabilities authorize disabled thinking");
  context.cases.push("matrix_claude_allowed_kv_principal_fresh_disabled_thinking_and_native_messages");

  const stream = await post(client, "/v1/responses", { model: MATRIX_MODELS.claude, input: "fixture:matrix:claude:stream", stream: true });
  await progressiveBody(stream);
  assertSingleAdmission(await settled(context, stream), "claude_code");
  const chat = await post(client, "/v1/chat/completions", {
    model: MATRIX_MODELS.claude,
    messages: [{ role: "user", content: "fixture:matrix:claude:chat" }],
    stream: false,
  });
  const body = await responseObject(chat);
  assert(Array.isArray(body.choices) && body.choices.length === 1);
  assert.equal(object(object(body.choices[0]).message).content, "matrix answer");
  assertSingleAdmission(await settled(context, chat), "claude_code");
  context.cases.push("matrix_claude_progressive_responses_and_chat_translation");

  const workspaceMarker = "fixture:matrix:claude:workspace";
  const workspace = await post(client, "/v1/responses", { model: MATRIX_MODELS.claude, input: workspaceMarker, stream: false });
  assert.equal((await responseObject(workspace)).status, "completed");
  const state = await settled(context, workspace);
  assertSingleAdmission(state, "claude_code");
  const attempt = object((state.attempts as unknown[])[0]);
  assert.equal(attempt.response_count, 2);
  assert.equal(attempt.workspace_continuations, 1);
  const workspaceCalls = dispatches(await context.events(), workspaceMarker);
  assert.deepEqual(
    workspaceCalls.map((call) => call.workspace),
    [null, "wrkspc_fixture_matrix"]
  );
  assert((await context.events()).some((event) => object(event).kind === "matrix_workspaces"));
  context.cases.push("matrix_claude_workspace_required_retry_retains_one_original_admission");

  await allow(context, []);
  const deniedMarker = "fixture:matrix:claude:denied";
  const denied = await post(client, "/v1/responses", { model: MATRIX_MODELS.claude, input: deniedMarker, stream: false });
  assert.notEqual(denied.status, 200);
  await denied.arrayBuffer();
  assert.equal(dispatches(await context.events(), deniedMarker).length, 0);
  context.cases.push("matrix_claude_revoked_principal_never_dispatches");
}
