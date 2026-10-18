import { manualFixture, cleanupManualFixture } from "./helpers/manual-reset-harness.ts";
import { consumeManualCodexReset } from "../src/codex/manual-reset.ts";
import { auditCodexResetRedemptions, auditManualResetIntents } from "../src/cache/kv-migration-validation.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Kv } from "#kv";
import { MemoryKv } from "./helpers/codex-banked-reset-harness.ts";
import { CODEX_MANUAL_RESET_PREFIX, parseManualResetIntent } from "../src/codex/manual-reset-state.ts";
import { classifyKvMigrationKey, importKvMigrationLines, parseKvMigrationEntryLine } from "../src/cache/kv-migration-base.ts";
import { keyToJson } from "../src/kv-conversion/profile-json.ts";
const receipt = {
  v: 1,
  account_id_hash: "a".repeat(64),
  credential_version: "b".repeat(64),
  quota_reset_at_ms: 1700000060000,
  routing_generation: 2,
  created_at_ms: 1700000000000,
  promoted_at_ms: 1700000001000,
  quota_signal_at_ms: null,
};
const encode = (value: unknown): unknown =>
  value !== null && typeof value === "object"
    ? { type: "object", value: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) }
    : { type: value === null ? "null" : typeof value, value };
test("manual reset intent is durable across prod export/import and exact-value roundtrip", async () => {
  const key = [...CODEX_MANUAL_RESET_PREFIX, receipt.account_id_hash];
  const options = { profile: "prod" as const, includeCache: false, includeLegacy: false, overwrite: false, dryRun: false };
  assert.equal(classifyKvMigrationKey(key, options).action, "import");
  const line = JSON.stringify({ key: keyToJson(key), value: encode(receipt) });
  assert.deepEqual(parseKvMigrationEntryLine(line).value, receipt);
  const kv = new MemoryKv();
  const result = await importKvMigrationLines(kv as unknown as Kv, [line], options);
  assert.equal(result.imported, 1);
  assert.deepEqual(parseManualResetIntent((await kv.get(key)).value), receipt);
});
test("manual reset recovery refuses malformed stored identity or promotion evidence", () => {
  for (const value of [
    null,
    { ...receipt, account_id_hash: "other" },
    { ...receipt, credential_version: "token" },
    { ...receipt, access_token: "unapproved" },
    { ...receipt, routing_generation: -1 },
    { ...receipt, promoted_at_ms: receipt.created_at_ms - 1 },
    { ...receipt, quota_reset_at_ms: "later" },
  ])
    assert.equal(parseManualResetIntent(value), null);
});

test("migration validation audits malformed manual intent keys and values", async () => {
  const kv = new MemoryKv();
  await kv.set([...CODEX_MANUAL_RESET_PREFIX, receipt.account_id_hash], receipt);
  const listing = Object.assign(kv, {
    *list() {
      for (const entry of kv.entries.values()) yield entry;
    },
  });
  const errors: string[] = [];
  await auditManualResetIntents(listing as unknown as Kv, errors);
  assert.deepEqual(errors, []);
  await kv.set([...CODEX_MANUAL_RESET_PREFIX, "wrong"], receipt);
  await kv.set([...CODEX_MANUAL_RESET_PREFIX, "c".repeat(64)], { ...receipt, credential_version: "token" });
  await auditManualResetIntents(listing as unknown as Kv, errors);
  assert.equal(errors.length, 2);
});

test("export/import retains manual intent, consumed window and shared daily allowance together", async () => {
  const fixture = await manualFixture();
  try {
    await consumeManualCodexReset(fixture.targetHash, fixture.dependencies);
    const rows = [...fixture.kv.entries.values()].filter((entry) => entry.key[1] === "codex_manual_reset" || entry.key[1] === "codex_reset_redemption");
    assert.equal(rows.length, 3);
    const options = { profile: "prod" as const, includeCache: false, includeLegacy: false, overwrite: false, dryRun: false };
    const lines = rows.map((entry) => JSON.stringify({ key: keyToJson(entry.key), value: encode(entry.value) }));
    const kv = new MemoryKv();
    const result = await importKvMigrationLines(kv as unknown as Kv, lines, options);
    assert.equal(result.imported, 3);
    for (const row of rows) assert.deepEqual((await kv.get(row.key)).value, row.value);
    const listing = Object.assign(kv, {
      *list(options: { prefix: readonly unknown[] }) {
        for (const entry of kv.entries.values()) if (options.prefix.every((part, index) => entry.key[index] === part)) yield entry;
      },
    });
    const errors: string[] = [];
    await auditCodexResetRedemptions(listing as unknown as Kv, errors);
    await auditManualResetIntents(listing as unknown as Kv, errors);
    assert.deepEqual(errors, []);
    await kv.set(["uos_ai", "codex_reset_redemption", "account_day", "v1", fixture.targetHash, "bad"], { submission_count: 0 });
    await auditCodexResetRedemptions(listing as unknown as Kv, errors);
    assert.equal(errors.length, 1);
  } finally {
    cleanupManualFixture();
  }
});
