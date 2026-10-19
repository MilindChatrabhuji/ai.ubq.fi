import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { manualFixture, cleanupManualFixture } from "./helpers/manual-reset-harness.ts";
import { handleAdminCodexResetConsume } from "../src/admin/codex-reset.ts";
import { CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY } from "../src/codex/routing-state.ts";
import handler from "../src/handler/index.ts";
afterEach(cleanupManualFixture);
const request = (body: unknown) =>
  new Request("http://localhost/admin/providers/codex/banked-resets/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("admin consume accepts only stable account identity", async () => {
  for (const body of [
    {},
    { account_id_hash: "bad" },
    { account_id_hash: "a".repeat(64), access_token: "forbidden" },
    { account_id_hash: "a".repeat(64), slot: 1 },
  ])
    assert.equal((await handleAdminCodexResetConsume(request(body))).status, 400);
});
test("admin consume reports verified matching account only after promotion", async () => {
  const fixture = await manualFixture();
  const response = await handleAdminCodexResetConsume(request({ account_id_hash: fixture.targetHash }), fixture.dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reset_status: "verified", active_account_id_hash: fixture.targetHash });
});
test("the registered consume route retains ordinary admin authentication", async () => {
  const response = await handler(request({ account_id_hash: "a".repeat(64) }));
  assert.equal(response.status, 401);
});

test("duplicate API response cannot claim current priority after a later active transition", async () => {
  const fixture = await manualFixture();
  const first = await handleAdminCodexResetConsume(request({ account_id_hash: fixture.targetHash }), fixture.dependencies);
  assert.equal(first.status, 200);
  await fixture.kv.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, { ...fixture.active, generation: 20 });
  const duplicate = await handleAdminCodexResetConsume(request({ account_id_hash: fixture.targetHash }), fixture.dependencies);
  assert.equal(duplicate.status, 409);
  const body = (await duplicate.json()) as { error: { code: string }; active_account_id_hash?: string };
  assert.equal(body.error.code, "codex_reset_already_completed");
  assert.equal(body.active_account_id_hash, undefined);
  assert.equal(fixture.provider.redeemInputs.length, 1);
});
