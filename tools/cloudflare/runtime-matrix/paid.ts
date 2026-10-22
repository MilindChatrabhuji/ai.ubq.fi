import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { MATRIX_MODELS } from "../fixtures/provider-matrix.mjs";
import { createClient, dispatches, object, post, responseObject, selectProviders, settled, stringKey, type MatrixContext } from "./contracts.ts";

async function prepare(context: MatrixContext): Promise<MatrixContext> {
  await selectProviders(context, ["codex", "surplus", "openlux"]);
  const native = await responseObject(
    await fetch(context.url("/v1/models?client_version=0.163.0"), { headers: { authorization: `Bearer ${context.clientToken ?? "fixture-access"}` } })
  );
  assert(Array.isArray(native.models) && native.models.some((row) => object(row).slug === MATRIX_MODELS.codex));
  const catalog = await responseObject(
    await fetch(context.url("/v1/models"), { headers: { authorization: `Bearer ${context.clientToken ?? "fixture-access"}` } })
  );
  assert(Array.isArray(catalog.data) && catalog.data.some((row) => object(row).id === MATRIX_MODELS.codex));
  const key = await createClient(context, true);
  return { ...context, clientToken: key.token };
}

async function request(context: MatrixContext, marker: string): Promise<{ state: Record<string, unknown>; calls: Record<string, unknown>[] }> {
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS.codex, input: marker, stream: false });
  assert.equal((await responseObject(response)).status, "completed");
  const state = await settled(context, response);
  return { state, calls: dispatches(await context.events(), marker) };
}

async function paidRows(context: MatrixContext, state: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  assert(Array.isArray(state.attempts));
  const records = [];
  for (const attempt of state.attempts.map(object)) {
    if (attempt.paid === null) continue;
    const reservation = object(attempt.paid);
    assert(typeof reservation.key_id === "string" && typeof reservation.attempt_id === "string");
    const row = await context.read(stringKey("uos_ai", "paid_fallback", "v3", "request", reservation.key_id, reservation.attempt_id));
    assert(row, "Actual authority must retain the paid attempt");
    records.push(object(row.value));
  }
  return records;
}

export async function transientNoFailover(context: MatrixContext, expected: "codex" | "surplus"): Promise<void> {
  const marker = "fixture:matrix:paid:transient";
  const before = await context.events();
  const response = await post(context, "/v1/responses", { model: MATRIX_MODELS.codex, input: marker, stream: false });
  assert.equal(response.status, 503);
  await response.arrayBuffer();
  const state = await settled(context, response);
  assert.equal(state.semantic_committed, false);
  const after = await context.events();
  assert(
    after.length >= before.length && before.every((event, index) => isDeepStrictEqual(event, after[index])),
    "Controlled fixture event log must retain its complete append-only prefix"
  );
  const calls = dispatches(after.slice(before.length), marker);
  if (!(calls.length > 0 && calls.every((call) => call.provider === expected))) {
    const knownProviders = ["codex", "claude", "surplus", "openlux", "lithos", "openrouter", "deepseek"];
    const counts = new Map<string, number>();
    for (const call of calls) {
      const provider = typeof call.provider === "string" && knownProviders.includes(call.provider) ? call.provider : "[invalid]";
      counts.set(provider, (counts.get(provider) ?? 0) + 1);
    }
    try {
      console.error(
        "RUNTIME_MATRIX_DISPATCH_FAILURE=" +
          JSON.stringify({ case: marker, expected_provider: expected, dispatch_count: calls.length, providers: Object.fromEntries(counts) })
      );
    } catch {
      // Diagnostics cannot replace the original no-failover assertion.
    }
  }
  assert(calls.length > 0 && calls.every((call) => call.provider === expected), "Transient failure cannot mint pool or paid capacity proof");
  context.cases.push(`matrix_${expected}_transient_503_never_advances_paid_waterfall`);
}

export async function paidProviderCases(context: MatrixContext): Promise<void> {
  const client = await prepare(context);
  const first = await request(client, "fixture:matrix:paid:primary");
  assert.deepEqual(
    first.calls.map((call) => [call.provider, call.account_label]),
    [["codex", "a"]]
  );
  await transientNoFailover(client, "codex");
  const retained = await request(client, "fixture:matrix:paid:retained");
  assert.deepEqual(
    retained.calls.map((call) => [call.provider, call.account_label]),
    [["codex", "a"]]
  );
  const mixed = await request(client, "fixture:matrix:paid:mixed");
  assert.deepEqual(
    mixed.calls.map((call) => [call.provider, call.account_label]),
    [
      ["codex", "a"],
      ["codex", "b"],
    ]
  );
  assert(Array.isArray(mixed.state.attempts) && mixed.state.attempts.length === 2);
  context.cases.push("matrix_codex_active_retained_through_success_and_transient_then_only_authoritative_quota_rotates");
  context.cases.push("matrix_partial_pool_quota_cannot_dispatch_paid_while_sibling_remains_eligible");

  const fallback = await request(client, "fixture:matrix:paid:surplus");
  assert.deepEqual(
    fallback.calls.map((call) => [call.provider, call.account_label]),
    [
      ["codex", "b"],
      ["surplus", null],
    ]
  );
  assert.equal(fallback.calls[1]?.mask_secrets, "on");
  const rows = await paidRows(context, fallback.state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.billing_state, "settled");
  assert.equal(rows[0]?.spend_microcredits, 5, "Measured Surplus terminal cost must settle once, not become unknown or free");
  assert.equal(rows[0]?.terminal_state, "completed");
  context.cases.push("matrix_full_current_pool_proof_then_surplus_masked_wire_and_exact_terminal_cost_settlement");
  await transientNoFailover({ ...context, clientToken: (await createClient(context, true)).token }, "surplus");
}

export async function openluxProviderCases(context: MatrixContext): Promise<void> {
  const client = await prepare(context);
  const result = await request(client, "fixture:matrix:paid:openlux");
  assert.deepEqual(
    result.calls.map((call) => call.provider),
    ["codex", "codex", "surplus", "openlux"]
  );
  assert.deepEqual(
    result.calls.slice(0, 2).map((call) => call.account_label),
    ["a", "b"]
  );
  assert.equal(result.calls[2]?.mask_secrets, "on");
  assert.equal(new Set((result.state.attempts as unknown[]).map((row) => object(row).id)).size, 4);
  const rows = await paidRows(context, result.state);
  assert.equal(rows.length, 2);
  const openlux = rows.find((row) => object(row.reservation).provider === "metered");
  assert(openlux);
  assert.equal(openlux.billing_state, "settled");
  assert.equal(openlux.provider_quota, 20);
  assert.equal(openlux.spend_microcredits, 40);
  assert.equal(openlux.provider_request_id, "matrix-openlux-openlux");
  assert((await context.events()).some((event) => object(event).kind === "matrix_billing_lookup"));
  context.cases.push("matrix_codex_full_pool_surplus_capacity_openlux_last_actual_billing_lookup_and_one_original_lifetime");
}

export async function unknownPaidCases(context: MatrixContext): Promise<void> {
  const client = await prepare(context);
  const result = await request(client, "fixture:matrix:paid:unknown");
  assert.deepEqual(
    result.calls.map((call) => call.provider),
    ["codex", "codex", "surplus", "openlux"]
  );
  const rows = await paidRows(context, result.state);
  const openlux = rows.find((row) => object(row.reservation).provider === "metered");
  assert(openlux);
  assert(["pending", "unresolved"].includes(String(openlux.billing_state)));
  assert.equal(openlux.spend_microcredits, null, "Missing correlated billing is unknown, never measured zero cost or a refund");
  assert.equal(openlux.provider_quota, null);
  assert.equal(openlux.transport_started, true);
  assert.equal(openlux.terminal_state, "completed", "Semantic completion and unresolved billing remain separate");
  context.cases.push("matrix_openlux_completed_response_without_billing_evidence_remains_unknown_not_free");
}
