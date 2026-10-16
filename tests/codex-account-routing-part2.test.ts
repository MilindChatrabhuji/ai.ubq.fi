import { test } from "bun:test";
import { type Kv } from "#kv";
// codex-account-routing suite, part 2 of 3: tests moved out of tests/codex-account-routing.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  type CodexAuthPoolState,
  RoutingKv,
  claimCodexRoutingProbe,
  codexCredentialVersion,
  deltaSecondsQuotaResponse,
  getCodexQuotaBlockFence,
  key,
  markCodexCredentialInvalid,
  markCodexQuotaBlocked,
  markCodexSuccess,
  markCodexUpstreamTimeout,
  parseCodexAccountRoutingState,
  pool,
  readCodex429,
  recheckCodexRoutingSlot,
  reconcileCodexQuotaAfterVerifiedReset,
  reconcileCodexRoutingAccount,
  recordCodexCapacityRoutingObservations,
  required,
  resetCodexAccountRoutingForTest,
  selectCodexRoutingAccounts,
  setKvForTest,
  singlePool,
} from "./helpers/codex-account-routing-harness.ts";

test("conflicting absolute body and header deadlines permanently fail closed", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const bodyResetAtSeconds = Math.floor(now / 1_000) + 60;
    const headerResetAtMs = now + 120_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const classified = await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: bodyResetAtSeconds } }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": new Date(headerResetAtMs).toUTCString(),
        },
      }),
      now
    );
    assert.equal(classified.retryAtMs, headerResetAtMs);
    assert.equal(classified.quotaBlockSource, "body_resets_at");
    assert.equal(classified.resetDeadlineIsStable, false);
    assert.equal(classified.resetDeadlineConflict, true);

    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[0]?.banked_reset_generation_ambiguous, true);
    assert.equal(await getCodexQuotaBlockFence(initial.accounts[0], headerResetAtMs), null);

    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
    assert.equal(selected.kind, "quota_blocked");
    {
      assert.deepEqual(selected.blockedAccounts, []);
    }
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("body resets_at preserves longer relative routing delays without authorizing redemption", async () => {
  const now = 1_700_000_000_000;
  const bodyResetAtSeconds = Math.floor(now / 1_000) + 60;
  for (const testCase of [
    { name: "shorter", retryAfter: "30", expectedRetryAtMs: now + 60_000, stable: true, conflict: false },
    { name: "equal", retryAfter: "60", expectedRetryAtMs: now + 60_000, stable: true, conflict: false },
    { name: "longer", retryAfter: "120", expectedRetryAtMs: now + 120_000, stable: false, conflict: true },
  ] as const) {
    const classified = await readCodex429(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: bodyResetAtSeconds } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": testCase.retryAfter },
      }),
      now
    );
    assert.equal(classified.retryAtMs, testCase.expectedRetryAtMs, testCase.name);
    assert.equal(classified.quotaBlockSource, "body_resets_at", testCase.name);
    assert.equal(classified.resetDeadlineIsStable, testCase.stable, testCase.name);
    assert.equal(classified.resetDeadlineConflict, testCase.conflict, testCase.name);
  }
});

test("valid delta Retry-After durably blocks a fully parsed usage limit", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const payload = JSON.stringify({ error: { type: "usage_limit_reached" } });
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const classified = await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(payload, {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
      now
    );
    assert.equal(classified.usageLimitReached, true);
    assert.equal(classified.retryAtMs, now + 60_000);
    assert.equal(await classified.response.text(), payload);

    const state = kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)) as {
      v: number;
      slots: { quota_blocked_until_ms: number | null; quota_block_source: string | null }[];
    };
    assert.equal(state.v, 2);
    assert.equal(state.slots[0]?.quota_blocked_until_ms, now + 60_000);
    assert.equal(state.slots[0]?.quota_block_source, "header_retry_after");

    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
    assert.equal(selected.kind, "quota_blocked");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("relative Retry-After blocks ordinary routing but cannot mint a banked-reset fence", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    const classified = await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
      now
    );

    assert.equal(classified.retryAtMs, now + 60_000);
    assert.equal(classified.resetDeadlineIsStable, false);
    assert.equal(await getCodexQuotaBlockFence(account, now + 60_000), null);
    const blocked = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
    assert.equal(blocked.kind, "quota_blocked");

    assert.deepEqual(blocked.blockedAccounts, []);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("valid HTTP-date Retry-After durably blocks a fully parsed usage limit", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const retryAtMs = now + 120_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const classified = await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(retryAtMs).toUTCString() },
      }),
      now
    );
    assert.equal(classified.usageLimitReached, true);
    assert.equal(classified.retryAtMs, retryAtMs);

    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
    assert.equal(selected.kind, "quota_blocked");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("eligible routing exposes only stable blocked siblings to the banked-reset cohort", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const retryAtMs = now + 120_000;
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const classified = await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": new Date(retryAtMs).toUTCString(),
        },
      }),
      now
    );
    assert.equal(classified.resetDeadlineIsStable, true);

    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(pool, pool.accounts, now + 1);
    assert.equal(selected.kind, "eligible");

    assert.deepEqual(
      selected.accounts.map((account) => account.slot),
      [1]
    );
    assert.equal(selected.accounts[0]?.probeRequired, false);
    assert.equal(selected.blockedAccounts.length, 1);
    assert.equal(selected.blockedAccounts[0]?.slot, 0);
    assert.equal(selected.blockedAccounts[0]?.quotaResetAtMs, retryAtMs);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("quota circuits skip blocked slots and synthesize direct-fallback eligibility", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const first = initial.accounts[0];
    const original = new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
    const replayable = await markCodexQuotaBlocked(first, original, now);
    assert.equal(replayable.response.status, 429);
    assert.match(await replayable.response.text(), /usage_limit_reached/);

    const afterOne = await selectCodexRoutingAccounts(pool, pool.accounts, now + 1);
    assert.equal(afterOne.kind, "eligible");

    assert.deepEqual(
      afterOne.accounts.map((account) => account.auth.account_id),
      ["two"]
    );
    assert.deepEqual(afterOne.blockedAccounts, []);

    await markCodexQuotaBlocked(
      afterOne.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
      now + 1
    );
    const allBlocked = await selectCodexRoutingAccounts(pool, pool.accounts, now + 2);
    assert.equal(allBlocked.kind, "quota_blocked");

    assert.equal(await recheckCodexRoutingSlot(1), true);
    const halfOpen = await selectCodexRoutingAccounts(pool, pool.accounts, Date.now());
    assert.equal(halfOpen.kind, "eligible");
    {
      assert.equal(halfOpen.accounts.length, 1);
      assert.equal(halfOpen.accounts[0]?.probeRequired, true);
      assert.deepEqual(halfOpen.blockedAccounts, []);
    }
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("429 classification reads fragmented JSON and preserves the response", async () => {
  const now = 1_700_000_000_000;
  const payload = JSON.stringify({ error: { type: "usage_limit_reached" } });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(payload);
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17));
      controller.close();
    },
  });
  const parsed = await readCodex429(
    new Response(source, {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "1" },
    }),
    now
  );
  assert.equal(parsed.usageLimitReached, true);
  assert.equal(parsed.retryAtMs, now + 1_000);
  assert.equal(await parsed.response.text(), payload);
});

test("429 classification rejects malformed UTF-8 before recognizing a usage-limit body", async () => {
  const now = 1_700_000_000_000;
  const encoder = new TextEncoder();
  const prefix = encoder.encode('{"error":{"type":"usage_limit_reached","message":"');
  const suffix = encoder.encode('"}}');
  const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
  bytes.set(prefix);
  bytes[prefix.length] = 0x80;
  bytes.set(suffix, prefix.length + 1);
  const parsed = await readCodex429(
    new Response(bytes, {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": new Date(now + 60_000).toUTCString() },
    }),
    now
  );

  assert.equal(parsed.usageLimitReached, false);
  assert.equal(parsed.retryAtMs, now + 60_000);
  assert.deepEqual(Array.from(new Uint8Array(await parsed.response.arrayBuffer())), Array.from(bytes));
});

test("429 classification rejects duplicate error keys before JSON last-key resolution", async () => {
  const now = 1_700_000_000_000;
  const payload = '{"error":{"type":"rate_limit_error","type":"usage_limit_reached"}}';
  const parsed = await readCodex429(
    new Response(payload, {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": new Date(now + 60_000).toUTCString() },
    }),
    now
  );

  assert.equal(parsed.usageLimitReached, false);
  assert.equal(await parsed.response.text(), payload);
});

test("429 classification returns a valid error when capture is truncated", async () => {
  const oversized = JSON.stringify({ error: { type: "usage_limit_reached", detail: "x".repeat(70 * 1_024) } });
  const parsed = await readCodex429(new Response(oversized, { status: 429, headers: { "Content-Type": "application/json" } }));
  assert.equal(parsed.usageLimitReached, false);
  assert.equal(parsed.retryAtMs, null);
  assert.deepEqual(await parsed.response.json(), {
    error: {
      message: "Codex returned an oversized or incomplete rate-limit response.",
      type: "rate_limit_error",
      code: "codex_rate_limit_response_truncated",
      param: null,
    },
  });
});

test("ordinary 429 clears only the current fenced probe from an expired circuit", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      }),
      now
    );

    resetCodexAccountRoutingForTest();
    const firstSelection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1_001);
    assert.equal(firstSelection.kind, "eligible");

    const staleProbe = await claimCodexRoutingProbe(singlePool, firstSelection.accounts[0], now + 1_001);
    assert.ok(staleProbe);

    resetCodexAccountRoutingForTest();
    const secondSelection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1_001 + 30_001);
    assert.equal(secondSelection.kind, "eligible");

    const currentProbe = await claimCodexRoutingProbe(singlePool, secondSelection.accounts[0], now + 1_001 + 30_001);
    assert.ok(currentProbe);
    assert.notEqual(staleProbe.probeToken, currentProbe.probeToken);

    await markCodexQuotaBlocked(
      staleProbe,
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
      now + 1_001 + 30_002
    );
    resetCodexAccountRoutingForTest();
    const afterStale = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1_001 + 30_002);
    assert.equal(afterStale.kind, "quota_blocked");

    await markCodexQuotaBlocked(
      currentProbe,
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
      now + 1_001 + 30_003
    );
    resetCodexAccountRoutingForTest();
    const released = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1_001 + 30_003);
    assert.equal(released.kind, "eligible");
    {
      assert.equal(released.accounts[0]?.probeToken, null);
    }
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a stale ordinary usage-limit 429 cannot overwrite a foreign half-open lease", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const staleSelection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(staleSelection.kind, "eligible");

    const staleAccount = staleSelection.accounts[0];
    assert.equal(staleAccount.probeGeneration, null);

    resetCodexAccountRoutingForTest();
    const blockingSelection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(blockingSelection.kind, "eligible");

    await markCodexQuotaBlocked(
      blockingSelection.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      }),
      now
    );

    const probeAt = now + 1_001;
    resetCodexAccountRoutingForTest();
    const probeSelection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, probeAt);
    assert.equal(probeSelection.kind, "eligible");

    const currentProbe = await claimCodexRoutingProbe(singlePool, probeSelection.accounts[0], probeAt);
    assert.ok(currentProbe);
    const beforeStale429 = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(beforeStale429?.slots[0]?.probe_lease?.token, currentProbe.probeToken);

    resetCodexAccountRoutingForTest();
    const stale429At = probeAt + 1;
    await markCodexQuotaBlocked(
      staleAccount,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      }),
      stale429At
    );
    const afterStale429 = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.deepEqual(afterStale429?.slots[0], beforeStale429.slots[0]);

    resetCodexAccountRoutingForTest();
    const secondSelection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, stale429At + 1_001);
    const secondProbe = secondSelection.kind === "eligible" ? await claimCodexRoutingProbe(singlePool, secondSelection.accounts[0], stale429At + 1_001) : null;
    assert.equal(secondProbe, null);
    assert.equal(secondSelection.kind, "quota_blocked");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("expired circuits grant one fenced probe and reject stale completion", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
      now
    );

    const expiry = now + 61_000;
    resetCodexAccountRoutingForTest();
    const probes = (
      await Promise.all(
        Array.from({ length: 50 }, async () => {
          const selection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, expiry);
          if (selection.kind !== "eligible") return null;
          return await claimCodexRoutingProbe(singlePool, selection.accounts[0], expiry);
        })
      )
    ).filter((probe) => probe !== null);
    assert.equal(probes.length, 1);
    const firstProbe = probes[0];

    resetCodexAccountRoutingForTest();
    const second = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, expiry + 30_001);
    assert.equal(second.kind, "eligible");

    const secondProbe = await claimCodexRoutingProbe(singlePool, second.accounts[0], expiry + 30_001);
    assert.ok(secondProbe);
    assert.notEqual(firstProbe.probeToken, secondProbe.probeToken);

    await markCodexSuccess(firstProbe);
    resetCodexAccountRoutingForTest();
    const afterStaleSuccess = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, expiry + 30_002);
    assert.equal(afterStaleSuccess.kind, "quota_blocked");

    await markCodexSuccess(secondProbe);
    resetCodexAccountRoutingForTest();
    const recovered = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, expiry + 30_003);
    assert.equal(recovered.kind, "eligible");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("an expired circuit receives one half-open probe before a healthy sibling", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const blocked = required(
      initial.accounts.find((account) => account.auth.account_id === "one"),
      "account one"
    );
    await markCodexQuotaBlocked(
      blocked,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
      now
    );

    const selection = await selectCodexRoutingAccounts(pool, pool.accounts, now + 61_000);
    assert.equal(selection.kind, "eligible");

    assert.equal(selection.accounts.length, 2);
    assert.equal(selection.accounts[0]?.auth.account_id, "one");
    assert.equal(selection.accounts[0]?.probeRequired, true);
    const probe = await claimCodexRoutingProbe(pool, selection.accounts[0], now + 61_000);
    assert.ok(probe);
    assert.notEqual(probe.probeToken, null);
    assert.equal(selection.accounts[1]?.auth.account_id, "two");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("an expired second-account circuit never jumps the healthy first account", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const blocked = required(
      initial.accounts.find((account) => account.auth.account_id === "two"),
      "account two"
    );
    await markCodexQuotaBlocked(
      blocked,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
      now
    );

    const selection = await selectCodexRoutingAccounts(pool, pool.accounts, now + 61_000);
    assert.equal(selection.kind, "eligible");

    assert.deepEqual(
      selection.accounts.map((account) => account.auth.account_id),
      ["one", "two"]
    );
    assert.equal(selection.accounts[0]?.probeToken, null);
    assert.equal(selection.accounts[0]?.probeRequired, false);
    assert.equal(selection.accounts[1]?.probeRequired, true);
    assert.equal(selection.accounts[1]?.probeToken, null);
    const stateBeforeAttempt = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(stateBeforeAttempt?.slots[1]?.probe_lease, null);

    const claimed = await claimCodexRoutingProbe(pool, selection.accounts[1], now + 61_000);
    assert.ok(claimed);
    assert.notEqual(claimed.probeToken, null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("unchanged auth reconciliation preserves a single-account half-open success fence", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
      now
    );

    const selection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 61_000);
    assert.equal(selection.kind, "eligible");

    const probe = await claimCodexRoutingProbe(singlePool, selection.accounts[0], now + 61_000);
    assert.ok(probe);
    assert.notEqual(probe.probeGeneration, null);
    assert.notEqual(probe.probeToken, null);

    const reconciled = await reconcileCodexRoutingAccount(probe, probe.auth);
    assert.equal(reconciled.probeGeneration, probe.probeGeneration);
    assert.equal(reconciled.probeToken, probe.probeToken);
    await markCodexSuccess(reconciled);

    resetCodexAccountRoutingForTest();
    const recovered = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 61_001);
    assert.equal(recovered.kind, "eligible");
    {
      assert.equal(recovered.accounts[0]?.probeGeneration, null);
      assert.equal(recovered.accounts[0]?.probeToken, null);
    }
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("credential rotation clears only the matching invalid circuit state", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts);
    assert.equal(initial.kind, "eligible");

    await markCodexCredentialInvalid(initial.accounts[0]);
    const invalid = await selectCodexRoutingAccounts(singlePool, singlePool.accounts);
    assert.equal(invalid.kind, "credentials_invalid");

    const rotated: CodexAuthPoolState = {
      accounts: [{ ...singlePool.accounts[0], access_token: "rotated-access", updated_at_ms: Date.now() }],
      updated_at_ms: Date.now(),
    };
    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(rotated, rotated.accounts);
    assert.equal(selected.kind, "eligible");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("fresh capacity cannot reopen a credential marked invalid", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const observedAtMs = Date.now();
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, observedAtMs, "gpt-5.6-luna");
    assert.equal(initial.kind, "eligible");

    await markCodexCredentialInvalid(initial.accounts[0]);

    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 0,
          account_id: "one",
          state: "available",
          source_observed_at_ms: observedAtMs,
          snapshot_at_ms: observedAtMs,
          windows: {
            primary: { limit_window_seconds: 604_800, used_percent: 50, reset_at_ms: observedAtMs + 604_800_000 },
            secondary: null,
          },
          additional_rate_limits: [],
        },
      ],
      observedAtMs
    );

    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, observedAtMs + 1, "gpt-5.6-luna")).kind, "credentials_invalid");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("same-account credential rotation discards a legacy timeout circuit", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexUpstreamTimeout(initial.accounts[0], now);

    const rotated: CodexAuthPoolState = {
      accounts: [{ ...singlePool.accounts[0], access_token: "rotated-access", updated_at_ms: now + 1 }],
      updated_at_ms: now + 1,
    };
    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(rotated, rotated.accounts, now + 1);
    assert.equal(selected.kind, "eligible");

    assert.equal(selected.accounts[0]?.probeRequired, false);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("credential refresh does not transfer a legacy timeout probe", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexUpstreamTimeout(initial.accounts[0], now - CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS - 1);
    resetCodexAccountRoutingForTest();
    const eligible = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(eligible.kind, "eligible");

    assert.equal(eligible.accounts[0]?.probeRequired, false);

    const rotated = {
      ...singlePool.accounts[0],
      access_token: "rotated-access",
      updated_at_ms: now + 1,
    };
    const reconciled = await reconcileCodexRoutingAccount(eligible.accounts[0], rotated);
    assert.equal(reconciled.probeCircuit, null);
    assert.equal(reconciled.probeToken, null);
    assert.equal(reconciled.probeGeneration, null);
    const transferred = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(transferred?.slots[0]?.upstream_timeout_blocked_until_ms, null);
    assert.equal(transferred.slots[0]?.probe_lease, null);

    await markCodexSuccess(reconciled);
    const recovered = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(recovered?.slots[0]?.upstream_timeout_blocked_until_ms, null);
    assert.equal(recovered.slots[0]?.probe_lease, null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a stale refresh reconciliation cannot overwrite a newer credential version", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts);
    assert.equal(initial.kind, "eligible");

    const accountA = initial.accounts[0];
    const authB = { ...accountA.auth, access_token: "refresh-b", updated_at_ms: 2 };
    const authC = { ...accountA.auth, access_token: "rotation-c", updated_at_ms: 3 };
    const credentialC = await codexCredentialVersion(authC);
    const stateC = {
      v: 2 as const,
      updated_at_ms: Date.now(),
      slots: [
        {
          credential_version: credentialC,
          quota_blocked_until_ms: null,
          quota_block_source: null,
          invalid_credential_version: credentialC,
          primary_used_percent: null,
          secondary_used_percent: null,
          observed_reset_at_ms: null,
          generation: 7,
          probe_lease: null,
        },
      ],
    };
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, stateC);

    const reconciled = await reconcileCodexRoutingAccount(accountA, authB);
    assert.equal(reconciled.credentialVersion, await codexCredentialVersion(authB));
    const durable = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(durable?.slots[0]?.credential_version, credentialC);
    assert.equal(durable.slots[0]?.invalid_credential_version, credentialC);
    assert.equal(durable.slots[0]?.generation, 7);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a revised active stable Retry-After fails closed rather than minting a second reset identity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    const firstResetAtMs = now + 60_000;
    await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(firstResetAtMs).toUTCString() },
      }),
      now
    );
    const firstFence = await getCodexQuotaBlockFence(account, firstResetAtMs);
    assert.equal(typeof firstFence, "number");
    if (firstFence === null) return;

    // A changed stable HTTP-date is not a provider-proven new quota
    // generation. The old record remains lookup-only, but neither deadline
    // may authorize a new claim or clear the current circuit.
    const latestResetAtMs = now + 120_000;
    await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(latestResetAtMs).toUTCString() },
      }),
      now + 1
    );
    assert.equal(await getCodexQuotaBlockFence(account, firstResetAtMs), null);
    assert.equal(await getCodexQuotaBlockFence(account, latestResetAtMs), null);
    const revised = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(revised?.slots[0]?.quota_blocked_until_ms, latestResetAtMs);
    assert.equal(revised.slots[0]?.observed_reset_at_ms, firstResetAtMs);
    assert.equal(revised.slots[0]?.banked_reset_generation_ambiguous, true);
    const blocked = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 2);
    assert.equal(blocked.kind, "quota_blocked");

    assert.deepEqual(
      blocked.blockedAccounts.map((candidate) => ({
        quotaResetAtMs: candidate.quotaResetAtMs,
        routingGeneration: candidate.routingGeneration,
      })),
      [{ quotaResetAtMs: firstResetAtMs, routingGeneration: required(revised, "persisted routing state").slots[0].generation }]
    );
    assert.equal(
      await reconcileCodexQuotaAfterVerifiedReset(account, {
        quotaResetAtMs: firstResetAtMs,
        routingGeneration: firstFence,
      }),
      null
    );
    assert.equal(
      await reconcileCodexQuotaAfterVerifiedReset(account, {
        quotaResetAtMs: firstResetAtMs,
        routingGeneration: required(revised, "persisted routing state").slots[0].generation,
      }),
      null
    );
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a post-reset recovery probe fences delayed 429s and clears ambiguity only after success", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    // This request remains in flight while the first qualifying 429 is
    // reconciled, so its response must not create a new quota identity.
    const account = initial.accounts[0];
    const firstResetAtMs = now + 60_000;
    await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(firstResetAtMs).toUTCString() },
      }),
      now
    );
    const firstFence = await getCodexQuotaBlockFence(account, firstResetAtMs);
    assert.equal(typeof firstFence, "number");
    if (firstFence === null) return;

    const recoveryProbe = await reconcileCodexQuotaAfterVerifiedReset(account, {
      quotaResetAtMs: firstResetAtMs,
      routingGeneration: firstFence,
    });
    assert.ok(recoveryProbe);

    assert.equal(recoveryProbe.probeGeneration, firstFence + 1);
    assert.ok(recoveryProbe.probeToken);
    const released = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
    assert.equal(released.kind, "quota_blocked");
    {
      assert.ok(released.retryAtMs !== null && released.retryAtMs > now + 1);
    }

    const revisedResetAtMs = now + 120_000;
    await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(revisedResetAtMs).toUTCString() },
      }),
      now + 1
    );

    assert.equal(await getCodexQuotaBlockFence(account, firstResetAtMs), null);
    assert.equal(await getCodexQuotaBlockFence(account, revisedResetAtMs), null);
    const delayed = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(delayed?.slots[0]?.quota_blocked_until_ms, null);
    assert.equal(delayed.slots[0]?.observed_reset_at_ms, firstResetAtMs);
    assert.equal(delayed.slots[0]?.observed_reset_at_is_stable, true);
    assert.equal(delayed.slots[0]?.banked_reset_generation_ambiguous, true);
    assert.equal(delayed.slots[0]?.probe_lease?.token, recoveryProbe.probeToken);

    await markCodexSuccess(recoveryProbe);
    const recovered = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(recovered?.slots[0]?.observed_reset_at_ms, null);
    assert.equal(recovered.slots[0]?.banked_reset_generation_ambiguous, false);

    const postSuccess = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 2);
    assert.equal(postSuccess.kind, "eligible");

    const nextResetAtMs = now + 180_000;
    await markCodexQuotaBlocked(
      postSuccess.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(nextResetAtMs).toUTCString() },
      }),
      now + 2
    );
    assert.equal(typeof (await getCodexQuotaBlockFence(postSuccess.accounts[0], nextResetAtMs)), "number");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a relative Retry-After after a stable deadline cannot mint a later reset identity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    const firstDeadline = now + 120_000;
    await markCodexQuotaBlocked(account, deltaSecondsQuotaResponse(new Date(firstDeadline).toUTCString()), now);
    const firstFence = await getCodexQuotaBlockFence(account, firstDeadline);
    assert.equal(typeof firstFence, "number");
    if (firstFence === null) return;

    // A delta timeout can extend ordinary routing's block, but it cannot
    // revise a stable reset identity into a second redemption key.
    const relativeDeadline = now + 180_001;
    await markCodexQuotaBlocked(account, deltaSecondsQuotaResponse("180"), now + 1);
    assert.equal(await getCodexQuotaBlockFence(account, firstDeadline), null);
    assert.equal(await getCodexQuotaBlockFence(account, relativeDeadline), null);

    // A later canonical date remains fenced too: D1 -> relative -> D2 must
    // stay lookup-only rather than restore a new key based on D2.
    const laterDeadline = now + 240_000;
    await markCodexQuotaBlocked(account, deltaSecondsQuotaResponse(new Date(laterDeadline).toUTCString()), now + 2);
    assert.equal(await getCodexQuotaBlockFence(account, laterDeadline), null);
    const durable = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(durable?.slots[0]?.quota_blocked_until_ms, laterDeadline);
    assert.equal(durable.slots[0]?.observed_reset_at_ms, firstDeadline);
    assert.equal(durable.slots[0]?.observed_reset_at_is_stable, true);
    assert.equal(durable.slots[0]?.banked_reset_generation_ambiguous, true);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("only a successful recovery probe clears reset-generation ambiguity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Math.floor(Date.now() / 1_000) * 1_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    const firstDeadline = now + 60_000;
    const revisedDeadline = now + 120_000;
    await markCodexQuotaBlocked(account, deltaSecondsQuotaResponse(new Date(firstDeadline).toUTCString()), now);
    await markCodexQuotaBlocked(account, deltaSecondsQuotaResponse(new Date(revisedDeadline).toUTCString()), now + 1);

    // An administrative recheck opens a normal probe but cannot clear the
    // ambiguous generation on its own.
    assert.equal(await recheckCodexRoutingSlot(1), true);
    const afterRecheck = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, Date.now());
    assert.equal(afterRecheck.kind, "eligible");

    assert.equal(afterRecheck.accounts[0]?.probeRequired, true);
    const firstProbe = await claimCodexRoutingProbe(singlePool, afterRecheck.accounts[0], Date.now());
    assert.ok(firstProbe);

    const thirdNow = Math.floor(Date.now() / 1_000) * 1_000;
    const laterDeadline = thirdNow + 180_000;
    await markCodexQuotaBlocked(firstProbe, deltaSecondsQuotaResponse(new Date(laterDeadline).toUTCString()), thirdNow);
    assert.equal(await getCodexQuotaBlockFence(firstProbe, laterDeadline), null);
    const stillAmbiguous = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(stillAmbiguous?.slots[0]?.observed_reset_at_ms, firstDeadline);
    assert.equal(stillAmbiguous.slots[0]?.banked_reset_generation_ambiguous, true);

    // Only an actual successful half-open probe resets the provisional
    // identity. The next stable observation can then establish a fresh fence.
    assert.equal(await recheckCodexRoutingSlot(1), true);
    const afterSecondRecheck = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, Date.now());
    assert.equal(afterSecondRecheck.kind, "eligible");

    const successfulProbe = await claimCodexRoutingProbe(singlePool, afterSecondRecheck.accounts[0], Date.now());
    assert.ok(successfulProbe);

    await markCodexSuccess(successfulProbe);
    const recovered = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(recovered?.slots[0]?.observed_reset_at_ms, null);
    assert.equal(recovered.slots[0]?.banked_reset_generation_ambiguous, false);

    const postSuccess = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, Date.now());
    assert.equal(postSuccess.kind, "eligible");

    const freshNow = Math.floor(Date.now() / 1_000) * 1_000;
    const freshDeadline = freshNow + 240_000;
    await markCodexQuotaBlocked(postSuccess.accounts[0], deltaSecondsQuotaResponse(new Date(freshDeadline).toUTCString()), freshNow);
    assert.equal(typeof (await getCodexQuotaBlockFence(postSuccess.accounts[0], freshDeadline)), "number");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("same-account credential rotation and pool reordering retain reset ambiguity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(pool, [pool.accounts[0]], now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    const firstDeadline = now + 60_000;
    const revisedDeadline = now + 120_000;
    await markCodexQuotaBlocked(account, deltaSecondsQuotaResponse(new Date(firstDeadline).toUTCString()), now);
    await markCodexQuotaBlocked(account, deltaSecondsQuotaResponse(new Date(revisedDeadline).toUTCString()), now + 1);

    const rotatedAccount = { ...pool.accounts[0], access_token: "rotated-access", updated_at_ms: now + 2 };
    const reorderedPool: CodexAuthPoolState = {
      accounts: [pool.accounts[1], rotatedAccount],
      updated_at_ms: now + 2,
    };
    // Simulate a fresh isolate that sees the durable state only after the pool
    // order and credential have both changed.
    resetCodexAccountRoutingForTest();
    const rotated = await selectCodexRoutingAccounts(reorderedPool, reorderedPool.accounts, now + 2);
    assert.equal(rotated.kind, "eligible");

    // The refreshed account becomes normally routable, and its sibling remains
    // routable after the pool order changes. The old stable identity is still
    // retained only as a banked-reset fence.
    assert.deepEqual(
      rotated.accounts.map((candidate) => candidate.auth.account_id),
      ["two", "one"]
    );
    assert.equal(
      rotated.accounts.every((candidate) => !candidate.probeRequired),
      true
    );
    const rotatedRouting = rotated.accounts.find((candidate) => candidate.auth.account_id === "one");
    assert.ok(rotatedRouting);

    const laterDeadline = revisedDeadline + 60_000;
    await markCodexQuotaBlocked(rotatedRouting, deltaSecondsQuotaResponse(new Date(laterDeadline).toUTCString()), now + 2);
    assert.equal(await getCodexQuotaBlockFence(rotatedRouting, laterDeadline), null);
    const durable = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(durable?.slots[1]?.observed_reset_at_ms, firstDeadline);
    assert.equal(durable.slots[1]?.banked_reset_generation_ambiguous, true);
    assert.equal(durable.slots[1]?.credential_version, await codexCredentialVersion(rotatedAccount));
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("an unmappable legacy stable identity cannot migrate to a replacement account", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const oldCredentialVersion = await codexCredentialVersion(singlePool.accounts[0]);
    const legacyDeadline = now + 60_000;
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      v: 2,
      updated_at_ms: now,
      slots: [
        {
          credential_version: oldCredentialVersion,
          quota_blocked_until_ms: legacyDeadline,
          quota_block_source: "header_retry_after",
          invalid_credential_version: null,
          primary_used_percent: null,
          secondary_used_percent: null,
          observed_reset_at_ms: legacyDeadline,
          observed_reset_at_is_stable: true,
          banked_reset_generation_ambiguous: true,
          generation: 1,
          probe_lease: null,
        },
      ],
    });
    const replacement = {
      access_token: "replacement-access",
      refresh_token: "replacement-refresh",
      account_id: "replacement",
      updated_at_ms: now + 1,
    };
    const replacementPool: CodexAuthPoolState = { accounts: [replacement], updated_at_ms: now + 1 };

    // An unknown legacy association must not make the replacement account
    // inherit the old circuit, but it must still stop a new reset key.
    const selected = await selectCodexRoutingAccounts(replacementPool, replacementPool.accounts, now + 1);
    assert.equal(selected.kind, "eligible");

    // Exercise the warm-cache normalization path too: the global legacy guard
    // is monotonic and may not disappear after the old slot is neutralized.
    const warmSelected = await selectCodexRoutingAccounts(replacementPool, replacementPool.accounts, now + 2);
    assert.equal(warmSelected.kind, "eligible");

    const replacementRouting = warmSelected.accounts[0];
    const replacementDeadline = now + 120_000;
    await markCodexQuotaBlocked(
      replacementRouting,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(replacementDeadline).toUTCString() },
      }),
      now + 1
    );
    assert.equal(await getCodexQuotaBlockFence(replacementRouting, replacementDeadline), null);
    const durable = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(durable?.banked_reset_legacy_identity_unresolved, true);
    assert.equal(durable.slots[0]?.observed_reset_at_ms, replacementDeadline);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("an administrative recheck fences a stable reset identity until a successful probe", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    const deadline = now + 60_000;
    await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(deadline).toUTCString() },
      }),
      now
    );
    assert.equal(typeof (await getCodexQuotaBlockFence(account, deadline)), "number");

    assert.equal(await recheckCodexRoutingSlot(1), true);
    assert.equal(await getCodexQuotaBlockFence(account, deadline), null);
    const durable = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(durable?.slots[0]?.observed_reset_at_ms, deadline);
    assert.equal(durable.slots[0]?.banked_reset_generation_ambiguous, true);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("fresh Spark capacity reconciles a blocked account without reordering configured accounts", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(initial.kind, "eligible");

    const accountTwo = initial.accounts.find((account) => account.auth.account_id === "two");
    assert.ok(accountTwo);
    const blockedUntil = now + 60_000;
    await markCodexQuotaBlocked(
      accountTwo,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(blockedUntil).toUTCString() },
      }),
      now
    );

    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 1,
          account_id: "two",
          state: "available",
          source_observed_at_ms: now + 1,
          snapshot_at_ms: now + 1,
          windows: {
            primary: { limit_window_seconds: 604_800, used_percent: 100, reset_at_ms: now + 604_800_000 },
            secondary: null,
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              metered_feature: "codex_bengalfox",
              windows: {
                primary: { limit_window_seconds: 18_000, used_percent: 50, reset_at_ms: now + 18_000_000 },
                secondary: null,
              },
            },
          ],
        },
      ],
      now + 1
    );

    const selected = await selectCodexRoutingAccounts(pool, pool.accounts, now + 2, "gpt-5.3-codex-spark");
    assert.equal(selected.kind, "eligible");

    // Configured order is the selection order; fresh capacity reopens the
    // account without promoting it ahead of the first configured account.
    assert.equal(selected.accounts[0]?.auth.account_id, "one");
    const reopened = selected.accounts.find((account) => account.auth.account_id === "two");
    assert.equal(reopened?.quotaHeadroom, 50);
    assert.equal(selected.blockedAccounts.length, 0);

    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[1]?.quota_blocked_until_ms, null);
    assert.equal(state.slots[1]?.primary_used_percent, 100);
    assert.equal(state.slots[1]?.capacity_observed_at_ms, now + 1);
    const storedObservation = JSON.stringify(kv.values.get(key(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY)));
    assert.equal(storedObservation.includes("account_id"), true);
    assert.equal(storedObservation.includes('"two"'), false);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("class capacity freshness ignores a newer independent quota signal", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const sparkDeadline = now + 60_000;
    const standardDeadline = now + 120_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(sparkDeadline).toUTCString() },
      }),
      now
    );
    const standard = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-5.6-luna");
    assert.equal(standard.kind, "eligible");

    await markCodexQuotaBlocked(
      standard.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(standardDeadline).toUTCString() },
      }),
      now + 1
    );
    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 0,
          account_id: "one",
          state: "available",
          source_observed_at_ms: now + 2,
          snapshot_at_ms: now + 2,
          windows: {
            primary: { limit_window_seconds: 604_800, used_percent: 100, reset_at_ms: sparkDeadline },
            secondary: null,
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              metered_feature: "codex_bengalfox",
              windows: {
                primary: { limit_window_seconds: 604_800, used_percent: 50, reset_at_ms: sparkDeadline },
                secondary: null,
              },
            },
          ],
        },
      ],
      now + 2
    );
    const sparkAfterCapacity = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 3, "gpt-5.3-codex-spark");
    assert.equal(sparkAfterCapacity.kind, "eligible");
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 3, "gpt-5.6-luna")).kind, "quota_blocked");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});
