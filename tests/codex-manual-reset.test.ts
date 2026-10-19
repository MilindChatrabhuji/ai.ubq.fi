import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { manualFixture, cleanupManualFixture } from "./helpers/manual-reset-harness.ts";
import { consumeManualCodexReset, ManualResetError } from "../src/codex/manual-reset.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  parseCodexAccountRoutingState,
} from "../src/codex/routing-state.ts";
import { selectCodexRoutingAccountsStrong } from "../src/codex/account-routing.ts";
import { codexResetAccountDailyKey } from "../src/codex/banked-reset.ts";
import { config } from "./helpers/codex-banked-reset-harness.ts";
import { attemptCodexBankedReset } from "../src/codex/banked-reset-submission.ts";
import { codexResetUsageKey } from "../src/codex/reset-settings.ts";
import { PROVIDER_SELECTION_KV_KEY } from "../src/provider/selection.ts";
afterEach(cleanupManualFixture);

test("manual click works with automatic off and shadow, promotes target and immediately serves the next eligible model", async () => {
  const fixture = await manualFixture();
  const result = await consumeManualCodexReset(fixture.targetHash, fixture.dependencies);
  assert.equal(result.active_account_id_hash, fixture.targetHash);
  assert.equal(result.reset_status, "verified");
  assert.equal(fixture.provider.redeemInputs.length, 1);
  const selected = await selectCodexRoutingAccountsStrong(fixture.pool, fixture.pool.accounts, fixture.now, "gpt-6-astra");
  assert.equal(selected.kind, "eligible");
  assert.equal(selected.accounts[0].auth.account_id, "target");
  const routing = parseCodexAccountRoutingState((await fixture.kv.get(CODEX_ACCOUNT_ROUTING_KV_KEY)).value);
  assert.equal(routing?.slots[1].quota_blocks_by_class?.standard, undefined);
  assert.ok(routing?.slots[1].quota_blocks_by_class?.reserve);
  const observed = (await fixture.kv.get<{ observations: { windows: { primary: { used_percent: number } } }[] }>(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY))
    .value;
  assert.equal(observed?.observations[0].windows.primary.used_percent, 1);
  assert.deepEqual((await fixture.kv.get(codexResetUsageKey(fixture.targetHash))).value, { enabled: false });
  assert.deepEqual((await fixture.kv.get(PROVIDER_SELECTION_KV_KEY)).value, { provider_ids: ["codex"], updated_at_ms: fixture.now });
  assert.equal((await fixture.kv.get(["uos_ai", "codex_overage_usage", "account", "v1", fixture.targetHash])).value, null);
});

test("global disabled controls make zero usage, inventory or consume calls", async () => {
  for (const configured of [config({ enabled: false }), config({ mode: "disabled" })]) {
    const fixture = await manualFixture();
    await assert.rejects(consumeManualCodexReset(fixture.targetHash, { ...fixture.dependencies, reloadConfig: () => configured }), ManualResetError);
    assert.equal(fixture.usageCalls(), 0);
    assert.equal(fixture.provider.callCount, 0);
  }
});

test("unknown consumption never repeats or changes account priority", async () => {
  const fixture = await manualFixture();
  fixture.provider.redeemResult = { kind: "unknown", providerReceiptId: null };
  await assert.rejects(consumeManualCodexReset(fixture.targetHash, fixture.dependencies), ManualResetError);
  await assert.rejects(consumeManualCodexReset(fixture.targetHash, fixture.dependencies), ManualResetError);
  assert.equal(fixture.provider.redeemInputs.length, 1);
  assert.deepEqual((await fixture.kv.get(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)).value, fixture.active);
});

test("unpropagated reset stays pending; explicit reconciliation promotes without consuming again", async () => {
  const fixture = await manualFixture();
  fixture.restore(false);
  await assert.rejects(
    consumeManualCodexReset(fixture.targetHash, fixture.dependencies),
    (error: unknown) => error instanceof ManualResetError && error.resetStatus === "verified"
  );
  assert.deepEqual((await fixture.kv.get(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)).value, fixture.active);
  fixture.restore(true);
  await consumeManualCodexReset(fixture.targetHash, fixture.dependencies);
  assert.equal(fixture.provider.redeemInputs.length, 1);
});

test("duplicate completed action cannot restore an old priority after a later transition", async () => {
  const fixture = await manualFixture();
  await consumeManualCodexReset(fixture.targetHash, fixture.dependencies);
  const later = { ...fixture.active, generation: 20 };
  await fixture.kv.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, later);
  await assert.rejects(
    consumeManualCodexReset(fixture.targetHash, fixture.dependencies),
    (error: unknown) => error instanceof ManualResetError && error.code === "codex_reset_already_completed"
  );
  assert.deepEqual((await fixture.kv.get(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)).value, later);
  assert.equal(fixture.provider.redeemInputs.length, 1);
});

test("concurrent clicks consume only once", async () => {
  const fixture = await manualFixture();
  const outcomes = await Promise.allSettled([
    consumeManualCodexReset(fixture.targetHash, fixture.dependencies),
    consumeManualCodexReset(fixture.targetHash, fixture.dependencies),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(fixture.provider.redeemInputs.length, 1);
});

test("daily cap and disabled selection reject before provider reads", async () => {
  const fixture = await manualFixture();
  await fixture.kv.set(codexResetAccountDailyKey(fixture.targetHash, new Date(fixture.now).toISOString().slice(0, 10)), {
    v: 1,
    day: new Date(fixture.now).toISOString().slice(0, 10),
    submission_count: 1,
    updated_at_ms: fixture.now,
  });
  await assert.rejects(
    consumeManualCodexReset(fixture.targetHash, fixture.dependencies),
    (error: unknown) => error instanceof ManualResetError && error.code === "account_day_limit_reached"
  );
  await fixture.kv.set(PROVIDER_SELECTION_KV_KEY, { provider_ids: ["openlux"], updated_at_ms: fixture.now });
  await assert.rejects(
    consumeManualCodexReset(fixture.targetHash, fixture.dependencies),
    (error: unknown) => error instanceof ManualResetError && error.code === "codex_provider_disabled"
  );
  assert.equal(fixture.usageCalls(), 0);
  assert.equal(fixture.provider.callCount, 0);
});

test("credential replacement during preflight cannot consume a reset", async () => {
  const fixture = await manualFixture();
  const fetcher = fixture.dependencies.fetcher;
  assert.ok(fetcher);
  const { createFetchMock } = await import("./helpers/fetch-mock.ts");
  await assert.rejects(
    consumeManualCodexReset(fixture.targetHash, {
      ...fixture.dependencies,
      fetcher: createFetchMock(async (input, init) => {
        await fixture.kv.set(CODEX_AUTH_POOL_KV_KEY, {
          ...fixture.pool,
          accounts: fixture.pool.accounts.map((auth) => ({ ...auth, access_token: auth.access_token + "-new" })),
        });
        return fetcher(input, init);
      }),
    }),
    ManualResetError
  );
  assert.equal(fixture.provider.redeemInputs.length, 0);
});

test("missing credits and definitive rejection leave the prior active subscription unchanged", async () => {
  for (const missing of [true, false]) {
    const fixture = await manualFixture();
    if (missing) fixture.provider.inventory = { ...fixture.provider.inventory, availableCount: 0, credits: [] };
    else fixture.provider.redeemResult = { kind: "rejected", reason: "no_credit" };
    await assert.rejects(consumeManualCodexReset(fixture.targetHash, fixture.dependencies), ManualResetError);
    assert.deepEqual((await fixture.kv.get(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)).value, fixture.active);
    assert.equal(fixture.provider.redeemInputs.length, missing ? 0 : 1);
  }
});

test("verified promotion retains named-model exhaustion from the fresh usage result", async () => {
  const fixture = await manualFixture();
  const fetcher = fixture.dependencies.fetcher;
  assert.ok(fetcher);
  const { createFetchMock } = await import("./helpers/fetch-mock.ts");
  await consumeManualCodexReset(fixture.targetHash, {
    ...fixture.dependencies,
    fetcher: createFetchMock(async (input, init) => {
      const payload = (await (await fetcher(input, init)).json()) as { additional_rate_limits: unknown[] };
      payload.additional_rate_limits.push({
        limit_name: "gpt-6-astra",
        rate_limit: { primary_window: { used_percent: 100, reset_at: (fixture.now + 3_600_000) / 1000, limit_window_seconds: 18000 } },
      });
      return new Response(JSON.stringify(payload));
    }),
  });
  const selected = await selectCodexRoutingAccountsStrong(fixture.pool, fixture.pool.accounts, fixture.now, "gpt-6-astra");
  assert.equal(selected.kind, "eligible");
  assert.equal(selected.accounts[0].auth.account_id, "first");
});

test("manual and automatic concurrent submissions share the same one-per-day allowance", async () => {
  const fixture = await manualFixture();
  await fixture.kv.set(codexResetUsageKey(fixture.targetHash), { enabled: true });
  const automatic = {
    accountId: "target",
    credentialVersion: fixture.identities[1].credentialVersion,
    quotaResetAtMs: fixture.now + 7_200_000,
    routingGeneration: 0,
    requestId: "automatic-race",
    fences: [{ key: CODEX_AUTH_POOL_KV_KEY, isCurrent: (value: unknown) => JSON.stringify(value) === JSON.stringify(fixture.pool) }],
  };
  await Promise.allSettled([
    consumeManualCodexReset(fixture.targetHash, fixture.dependencies),
    attemptCodexBankedReset(automatic, { kv: fixture.dependencies.kv, config: config(), provider: fixture.provider, now: () => fixture.now }),
  ]);
  assert.equal(fixture.provider.redeemInputs.length, 1);
  const budget = await fixture.kv.get<{ submission_count: number }>(
    codexResetAccountDailyKey(fixture.targetHash, new Date(fixture.now).toISOString().slice(0, 10))
  );
  assert.equal(budget.value?.submission_count, 1);
});

test("an old completed quota window cannot be promoted again on a later UTC day", async () => {
  const fixture = await manualFixture();
  const originalFetch = fixture.dependencies.fetcher;
  assert.ok(originalFetch);
  const { createFetchMock } = await import("./helpers/fetch-mock.ts");
  let clock = fixture.now;
  const dependencies = {
    ...fixture.dependencies,
    now: () => clock,
    fetcher: createFetchMock(async (input, init) => {
      const payload = (await (await originalFetch(input, init)).json()) as { rate_limit: { secondary_window: { reset_at: number } } };
      payload.rate_limit.secondary_window.reset_at = (fixture.now + 7 * 86_400_000) / 1000;
      return new Response(JSON.stringify(payload));
    }),
  };
  await consumeManualCodexReset(fixture.targetHash, dependencies);
  const later = { ...fixture.active, generation: 20 };
  await fixture.kv.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, later);
  clock += 2 * 3_600_000;
  await assert.rejects(
    consumeManualCodexReset(fixture.targetHash, dependencies),
    (error: unknown) => error instanceof ManualResetError && error.code === "codex_reset_already_completed"
  );
  assert.deepEqual((await fixture.kv.get(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)).value, later);
  assert.equal(fixture.provider.redeemInputs.length, 1);
});

test("account removal after consumption retains verified reset evidence without promotion", async () => {
  const fixture = await manualFixture();
  const originalFetch = fixture.dependencies.fetcher;
  assert.ok(originalFetch);
  const { createFetchMock } = await import("./helpers/fetch-mock.ts");
  await assert.rejects(
    consumeManualCodexReset(fixture.targetHash, {
      ...fixture.dependencies,
      fetcher: createFetchMock(async (input, init) => {
        const response = await originalFetch(input, init);
        if (fixture.provider.redeemInputs.length) await fixture.kv.set(CODEX_AUTH_POOL_KV_KEY, { ...fixture.pool, accounts: [fixture.pool.accounts[0]] });
        return response;
      }),
    }),
    (error: unknown) => error instanceof ManualResetError && error.resetStatus === "verified"
  );
  assert.deepEqual((await fixture.kv.get(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)).value, fixture.active);
  assert.equal(fixture.provider.redeemInputs.length, 1);
});
