import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as kv from "../src/kv.ts";
import { selectProviders, type MatrixContext } from "../tools/cloudflare/runtime-matrix/contracts.ts";

function fixture(returned: string[], options: { stored?: boolean; status?: number } = {}) {
  const calls: { path: string; body: unknown; token: string | undefined }[] = [];
  const unused = () => {
    throw new Error("provider selection must not use inference, database or provider capabilities");
  };
  const context: MatrixContext = {
    url: unused,
    post: (path, body, token) => {
      calls.push({ path, body: structuredClone(body), token });
      return Promise.resolve(Response.json({ stored: options.stored ?? true, provider_ids: returned }, { status: options.status ?? 200 }));
    },
    rpc: unused,
    read: unused,
    lifecycle: unused,
    events: unused,
    cases: [],
    adminToken: "synthetic-selection-admin",
  };
  return { context, calls };
}

test("recorded reordered known IDs require source roster order while the original request remains unchanged", async () => {
  const submitted = ["lithos", "codex"];
  const actual = ["codex", "lithos"];
  assert.throws(
    () => {
      assert.deepEqual(actual, submitted);
    },
    assert.AssertionError,
    "old caller-order expectation reproduces the recorded failure"
  );
  const { context, calls } = fixture(actual);
  await selectProviders(context, submitted);
  assert.deepEqual(calls, [{ path: "/admin/providers/selection", body: { provider_ids: ["lithos", "codex"] }, token: "synthetic-selection-admin" }]);
  assert.deepEqual(submitted, ["lithos", "codex"]);
  assert.deepEqual(actual, ["codex", "lithos"]);
});

test("all existing unordered context provider sets use the fixed source roster rather than caller or alphabetic priority", async () => {
  const vectors = [
    { submitted: ["lithos", "deepseek", "openrouter"], returned: ["deepseek", "lithos", "openrouter"] },
    { submitted: ["openlux", "surplus", "codex"], returned: ["codex", "surplus", "openlux"] },
    { submitted: ["openrouter", "cerebras", "deepseek", "claude_code"], returned: ["claude_code", "deepseek", "cerebras", "openrouter"] },
  ];
  for (const { submitted, returned } of vectors) {
    const { context, calls } = fixture(returned);
    await selectProviders(context, submitted);
    assert.deepEqual(calls[0]?.body, { provider_ids: submitted });
  }
});

test("source normalization trims and deduplicates the expected stored IDs without editing the request", async () => {
  const submitted = [" lithos ", "codex", "lithos"];
  const { context, calls } = fixture(["codex", "lithos"]);
  await selectProviders(context, submitted);
  assert.deepEqual(calls[0]?.body, { provider_ids: [" lithos ", "codex", "lithos"] });
});

test("subscription IDs retain source hash ordering and Codex umbrella absorption", async () => {
  const first = `codex:${"a".repeat(64)}`;
  const second = `codex:${"b".repeat(64)}`;
  const selected = fixture(["surplus", first, second]);
  await selectProviders(selected.context, [second, "surplus", first, second]);
  const umbrella = fixture(["codex", "surplus"]);
  await selectProviders(umbrella.context, [second, "surplus", "codex", first]);
});

test("unchanged already-canonical selections and empty selection preserve existing helper meanings", async () => {
  for (const providers of [[], ["codex"], ["claude_code"], ["codex", "surplus", "openlux"]]) {
    const { context, calls } = fixture([...providers]);
    await selectProviders(context, [...providers]);
    assert.deepEqual(calls[0]?.body, { provider_ids: providers });
  }
});

test("wrong returned order, missing and extra IDs still fail exact equality instead of being sorted or reduced to a set", async () => {
  for (const returned of [["lithos", "codex"], ["codex"], ["codex", "lithos", "openlux"], ["codex", "lithos", "lithos"]]) {
    await assert.rejects(selectProviders(fixture(returned).context, ["lithos", "codex"]), assert.AssertionError);
  }
  await assert.rejects(selectProviders(fixture(["codex", "openlux", "surplus"]).context, ["surplus", "codex", "openlux"]), assert.AssertionError);
  const first = `codex:${"a".repeat(64)}`;
  const second = `codex:${"b".repeat(64)}`;
  await assert.rejects(selectProviders(fixture([second, first]).context, [second, first]), assert.AssertionError);
  await assert.rejects(selectProviders(fixture(["codex", first]).context, ["codex", first]), assert.AssertionError);
});

test("HTTP success and actual stored=true requirements are not relaxed by expected order normalization", async () => {
  await assert.rejects(selectProviders(fixture(["codex"], { status: 503 }).context, ["codex"]), assert.AssertionError);
  await assert.rejects(selectProviders(fixture(["codex"], { stored: false }).context, ["codex"]), assert.AssertionError);
});

test("the reused original normalizer remains pure and never invokes the lazy real KV opener", async () => {
  const opener = spyOn(kv, "getKv").mockImplementation(() => {
    throw new Error("real KV access is forbidden");
  });
  try {
    await selectProviders(fixture(["codex", "lithos"]).context, ["lithos", "codex"]);
    assert.equal(opener.mock.calls.length, 0);
  } finally {
    opener.mockRestore();
  }
});
