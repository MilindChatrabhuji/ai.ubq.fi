import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as kv from "../src/kv.ts";
import { normalizeResponseMessageItem } from "../src/input-normalization.ts";
import { normalizeResponsesInput } from "../src/responses-request.ts";
import { buildCodexRequest } from "../src/models/codex-models-fetch.ts";
import { legacyReplay } from "../tools/cloudflare/runtime-matrix/context-replay.ts";
import { object, type MatrixContext } from "../tools/cloudflare/runtime-matrix/contracts.ts";

function fixture(transform?: (input: Record<string, unknown>[]) => void) {
  const state: { original?: unknown[]; normalized?: unknown[]; forwarded?: Record<string, unknown>[]; requests: number } = { requests: 0 };
  const unused = () => {
    throw new Error("legacy helper regression must not use database, provider or unrelated capabilities");
  };
  const context: MatrixContext = {
    url: unused,
    post: (path, body) => {
      state.requests++;
      assert.equal(path, "/v1/responses");
      const request = object(body);
      assert(Array.isArray(request.input));
      const original = JSON.stringify(request.input);
      state.original = structuredClone(request.input);
      const normalized = normalizeResponsesInput(request.input);
      assert(normalized.ok, "actual original source input normalization must accept its existing legacy vector");
      state.normalized = structuredClone(normalized.value);
      const codex = buildCodexRequest(String(request.model), normalized.value);
      assert(Array.isArray(codex.input));
      const forwarded = codex.input.map(object);
      state.forwarded = structuredClone(forwarded);
      transform?.(forwarded);
      assert.equal(JSON.stringify(request.input), original, "actual original source normalization/replay must not edit client history");
      const event = { kind: "matrix_dispatch", marker: "fixture:matrix:replay:legacy", provider: "codex", context_input: forwarded };
      context.events = () => Promise.resolve([event]);
      return Promise.resolve(Response.json({ status: "completed" }, { headers: { "x-uos-request-id": "legacy-source-regression" } }));
    },
    rpc: unused,
    read: unused,
    lifecycle: (id) => {
      assert.equal(id, "legacy-source-regression");
      return Promise.resolve({ attempts: [{ provider: "chatgpt_codex", transport_started: true }], terminal_intent: { delivery: "unknown" } });
    },
    events: unused,
    cases: [],
  };
  return { context, state };
}

test("actual source message normalization precedes replay cleanup and clears both observed message IDs", async () => {
  const { context, state } = fixture();
  const opener = spyOn(kv, "getKv").mockImplementation(() => {
    throw new Error("real KV access is forbidden");
  });
  try {
    await legacyReplay(context);
    assert.equal(opener.mock.calls.length, 0);
  } finally {
    opener.mockRestore();
  }
  assert.equal(state.requests, 1);
  assert(state.original && state.normalized && state.forwarded);
  for (const index of [7, 10]) {
    const original = object(state.original[index]);
    assert.equal(typeof original.id, "string");
    const message = normalizeResponseMessageItem(original, `input[${index}]`);
    assert(message.ok);
    assert.equal("id" in message.value, false);
    assert.deepEqual(state.normalized[index], message.value);
  }
  assert.equal(object(state.original[7]).id, "msg_03375d708dca4424016abf51971e4887d1acd5ea8e0c400198");
  assert.equal(object(state.original[10]).id, "resp_custom_item_0");
  assert.equal(state.forwarded.length, 11);
  assert.deepEqual(
    state.forwarded.map((item) => item.id ?? null),
    [null, null, null, null, "rs_03375d708dca4424016abf51952afc87d1824eacab5be80344", null, null, null, null, `resp_${"a".repeat(41)}_rs_0`, null]
  );
  assert.deepEqual(context.cases, ["matrix_exact_legacy_replay_drops_only_unencrypted_synthetic_reasoning_preserves_genuine_and_nonmatching_ids"]);
});

test("echoing message IDs is rejected rather than accepted as an order or subset relaxation", async () => {
  const { context } = fixture((input) => {
    object(input[5]).id = "msg_03375d708dca4424016abf51971e4887d1acd5ea8e0c400198";
    object(input[8]).id = "resp_custom_item_0";
  });
  await assert.rejects(legacyReplay(context), assert.AssertionError);
  assert.equal(context.cases.length, 0);
});

test("genuine and nonmatching long-prefix non-message reasoning IDs must still be preserved", async () => {
  for (const index of [4, 9]) {
    const { context } = fixture((input) => {
      delete object(input[index]).id;
    });
    await assert.rejects(legacyReplay(context), assert.AssertionError);
    assert.equal(context.cases.length, 0);
  }
});

test("encrypted synthetic and genuine reasoning replay payload checks remain strict", async () => {
  for (const index of [3, 4, 7]) {
    const { context } = fixture((input) => {
      object(input[index]).encrypted_content = "changed";
    });
    await assert.rejects(legacyReplay(context), assert.AssertionError);
    assert.equal(context.cases.length, 0);
  }
});

test("original call identities and legacy message content assertions remain strict", async () => {
  for (const index of [1, 2]) {
    const { context } = fixture((input) => {
      object(input[index]).call_id = "different-call";
    });
    await assert.rejects(legacyReplay(context), assert.AssertionError);
  }
  const { context } = fixture((input) => {
    object(input[0]).content = [{ type: "output_text", text: "changed legacy answer" }];
  });
  await assert.rejects(legacyReplay(context), assert.AssertionError);
});

test("the exact eleven-item inventory is not reduced to make the legacy assertion pass", async () => {
  const { context } = fixture((input) => {
    input.pop();
  });
  await assert.rejects(legacyReplay(context), (error: unknown) => error instanceof assert.AssertionError && error.actual === 10 && error.expected === 11);
  assert.equal(context.cases.length, 0);
});
