import { test } from "bun:test";
import { type AtomicOperation, type Kv, type KvCommitResult, type KvEntryMaybe, type KvKey } from "#kv";
import assert from "node:assert/strict";

import {
  capacityHeadroomForObservation,
  capacityObservationIsFresh,
  capacityState,
  loadCodexAccountRouting,
  loadCodexCapacityRoutingObservations,
  neutralSlot,
  parseFinitePercent,
  parseStoredCapacityObservationStore,
  probeLeaseMatchesRoutingAccount,
  quotaBlockForClass,
  quotaBlockKeyForClass,
  quotaBlocksIncludingLegacy,
  quotaClass,
  quotaHeadroomFor,
  quotaSignalObservedAtForClass,
  recheckQuotaClasses,
  reconcileCapacityRoutingState,
  recordCodexCapacityRoutingObservations,
  releaseQuotaClassProbe,
  resetCodexAccountRoutingForTest,
  routingAccountIdentity,
  routingProbeCircuit,
  slotFor,
  slotMatchesRoutingAccount,
  updateRoutingState,
  withSlot,
  withoutQuotaClass,
} from "../src/codex/capacity-routing.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_CAPACITY_ROUTING_MAX_AGE_MS,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  type CodexAccountRoutingState,
  type CodexCapacityRoutingObservation,
  type CodexCapacityRoutingObservationInput,
  type CodexQuotaClassBlock,
  type CodexRoutingSlot,
  type RoutingAccount,
} from "../src/codex/routing-state.ts";
import { setKvForTest } from "../src/kv.ts";
import { PROVIDER_CAPACITY_SNAPSHOT_KEY } from "../src/provider/capacity-contract.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";

/* ------------------------------------------------------------------ fixtures */

const account = (accountId: string, accessToken = `access-${accountId}`): CodexAuthState => ({
  access_token: accessToken,
  refresh_token: `refresh-${accountId}`,
  account_id: accountId,
  updated_at_ms: 1,
});

const poolOf = (...accounts: CodexAuthState[]): CodexAuthPoolState => ({ accounts, updated_at_ms: 1 });

const routingAccountOf = async (auth: CodexAuthState, slot: number, extra: Partial<RoutingAccount> = {}): Promise<RoutingAccount> => {
  await Promise.resolve();
  return {
    auth,
    slot,
    accountIdHash: await accountHashOf(auth),
    credentialVersion: `credential-${auth.account_id}`,
    quotaHeadroom: null,
    probeRequired: true,
    probeGeneration: null,
    probeToken: null,
    ...extra,
  };
};

const accountHashOf = async (auth: CodexAuthState): Promise<string> => (await routingAccountIdentity(auth)).accountIdHash;

const stateWith = (...slots: CodexRoutingSlot[]): CodexAccountRoutingState => ({
  v: 2,
  updated_at_ms: 1,
  banked_reset_legacy_identity_unresolved: false,
  slots,
});

const quotaBlock = (blockedUntilMs: number, extra: Partial<CodexQuotaClassBlock> = {}): CodexQuotaClassBlock => ({
  blocked_until_ms: blockedUntilMs,
  source: "header_retry_after",
  legacy_fallback: false,
  quota_signal_observed_at_ms: blockedUntilMs - 1_000,
  observed_reset_at_ms: null,
  observed_reset_at_is_stable: false,
  banked_reset_generation_ambiguous: false,
  banked_reset_recovery_probe_pending: false,
  ...extra,
});

const slotWithClassBlock = (quotaClassKey: string, block: CodexQuotaClassBlock, extra: Partial<CodexRoutingSlot> = {}): CodexRoutingSlot => ({
  ...neutralSlot("credential-one", "account-one-hash"),
  quota_blocks_by_class: { [quotaClassKey]: block },
  quota_blocked_classes: [quotaClassKey],
  quota_blocked_until_ms: block.blocked_until_ms,
  quota_block_source: block.source,
  quota_signal_observed_at_ms: block.quota_signal_observed_at_ms,
  ...extra,
});

const observationOf = (input: Partial<CodexCapacityRoutingObservation> & { slot: number; account_id_hash: string }): CodexCapacityRoutingObservation => ({
  state: "available",
  source_observed_at_ms: null,
  snapshot_at_ms: 1_790_000_000_000,
  windows: { primary: { limit_window_seconds: 300, used_percent: 10, reset_at_ms: null }, secondary: null },
  additional_rate_limits: [],
  ...input,
});

/* ------------------------------------------------------------------ fake KV */

type KvWrite = { type: "set" | "delete"; key: KvKey };

const keyOf = (key: KvKey): string => JSON.stringify(key);

/** In-memory KV with observable reads and injectable failures; `openKv` is undefined here. */
class ScriptedKv {
  readonly values = new Map<string, unknown>();
  readonly versions = new Map<string, number>();
  readonly gets: string[] = [];
  readonly writes: KvWrite[] = [];
  readonly commitAttempts: KvWrite[] = [];
  commitFailures = 0;
  rejectGets = false;

  get binding(): Kv {
    return this as unknown as Kv;
  }

  get<T>(key: KvKey, options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    assert.equal(options?.consistency, "strong", "routing reads must be strong");
    const encoded = keyOf(key);
    this.gets.push(encoded);
    if (this.rejectGets) return Promise.reject(new Error("kv unavailable"));
    const value = this.values.get(encoded) as T | undefined;
    const version = this.versions.get(encoded);
    return Promise.resolve({
      key,
      value: value ?? null,
      versionstamp: version === undefined ? null : String(version).padStart(20, "0"),
    } as KvEntryMaybe<T>);
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    this.writes.push({ type: "set", key });
    this.#apply({ type: "set", key, value });
    return Promise.resolve({ ok: true, versionstamp: String(this.versions.get(keyOf(key)) ?? 0).padStart(20, "0") });
  }

  atomic(): AtomicOperation {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const writes: { type: "set" | "delete"; key: KvKey; value?: unknown }[] = [];
    const chain = {
      check: (...entries: { key: KvKey; versionstamp: string | null }[]) => {
        checks.push(...entries);
        return chain;
      },
      set: (key: KvKey, value: unknown) => {
        writes.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        writes.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        this.commitAttempts.push(...writes);
        if (this.commitFailures > 0) {
          this.commitFailures -= 1;
          return Promise.resolve({ ok: false } as const);
        }
        for (const check of checks) {
          const current = this.versions.get(keyOf(check.key));
          const versionstamp = current === undefined ? null : String(current).padStart(20, "0");
          if (versionstamp !== check.versionstamp) return Promise.resolve({ ok: false } as const);
        }
        for (const write of writes) this.#apply(write);
        return Promise.resolve({ ok: true, versionstamp: "00000000000000000007" } as const);
      },
    };
    return chain as unknown as AtomicOperation;
  }

  /** Runs one test with this stub installed and the routing singletons reset. */
  static async run(run: (kv: ScriptedKv) => Promise<void>): Promise<void> {
    const kv = new ScriptedKv();
    setKvForTest(kv.binding);
    resetCodexAccountRoutingForTest();
    try {
      await run(kv);
    } finally {
      setKvForTest(null);
      resetCodexAccountRoutingForTest();
    }
  }

  #apply(write: { type: "set" | "delete"; key: KvKey; value?: unknown }): void {
    const encoded = keyOf(write.key);
    if (write.type === "delete") this.values.delete(encoded);
    else this.values.set(encoded, write.value);
    this.versions.set(encoded, (this.versions.get(encoded) ?? 0) + 1);
  }
}

/* ------------------------------------------------------------- pure helpers */

test("slotFor falls back to a neutral slot for an account the state does not describe", async () => {
  const auth = account("one");
  const routingAccount = await routingAccountOf(auth, 0);
  const described = stateWith({ ...neutralSlot(routingAccount.credentialVersion, routingAccount.accountIdHash), generation: 4 });
  assert.equal(slotFor(described, routingAccount).generation, 4);

  const missing = stateWith();
  const neutral = slotFor(missing, routingAccount);
  assert.equal(neutral.generation, 0);
  assert.equal(neutral.account_id_hash, routingAccount.accountIdHash);
  assert.equal(neutral.credential_version, routingAccount.credentialVersion);
  assert.deepEqual(neutral.quota_blocks_by_class, {});
});

test("slotMatchesRoutingAccount accepts an exact identity and the legacy null-hash record only", async () => {
  const routingAccount = await routingAccountOf(account("one"), 0);
  const exact = neutralSlot(routingAccount.credentialVersion, routingAccount.accountIdHash);
  assert.equal(slotMatchesRoutingAccount(exact, routingAccount), true);
  const legacy = neutralSlot(routingAccount.credentialVersion, null);
  assert.equal(slotMatchesRoutingAccount(legacy, routingAccount), true, "a legacy slot without a hash matches on its credential version");
  const rotated = neutralSlot("some-other-credential", routingAccount.accountIdHash);
  assert.equal(slotMatchesRoutingAccount(rotated, routingAccount), false, "a different credential version never matches");
  const foreign = neutralSlot(routingAccount.credentialVersion, "another-account-hash");
  assert.equal(slotMatchesRoutingAccount(foreign, routingAccount), false);
});

test("probeLeaseMatchesRoutingAccount requires a complete claim on the exact account", async () => {
  const routingAccount = await routingAccountOf(account("one"), 0, {
    probeGeneration: 3,
    probeToken: "token-3",
    probeCircuit: "quota",
    requestedModel: "gpt-6-astra",
  });
  const lease = { generation: 3, token: "token-3", circuit: "quota" as const, quota_class: null, expires_at_ms: 1 };
  const leased: CodexRoutingSlot = {
    ...neutralSlot(routingAccount.credentialVersion, routingAccount.accountIdHash),
    generation: 3,
    probe_lease: lease,
  };
  assert.equal(probeLeaseMatchesRoutingAccount(leased, routingAccount), true, "a quota lease with no class claim covers the account");

  assert.equal(
    probeLeaseMatchesRoutingAccount(leased, await routingAccountOf(account("one"), 0)),
    false,
    "an account without a pending generation owns no lease"
  );
  assert.equal(probeLeaseMatchesRoutingAccount({ ...leased, probe_lease: null }, routingAccount), false);
  assert.equal(probeLeaseMatchesRoutingAccount({ ...leased, generation: 4 }, routingAccount), false, "a slot generation that moved on invalidates the lease");
  assert.equal(
    probeLeaseMatchesRoutingAccount({ ...leased, probe_lease: { ...lease, token: "stale" } }, routingAccount),
    false,
    "a different lease token belongs to another claim"
  );
  assert.equal(
    probeLeaseMatchesRoutingAccount({ ...leased, probe_lease: { ...lease, circuit: "upstream_timeout" } }, routingAccount),
    false,
    "a lease for another circuit is not this account's claim"
  );
  const timeoutCircuit = await routingAccountOf(account("one"), 0, { probeGeneration: 3, probeToken: "token-3", probeCircuit: "upstream_timeout" });
  assert.equal(
    probeLeaseMatchesRoutingAccount({ ...leased, probe_lease: { ...lease, circuit: "upstream_timeout" } }, timeoutCircuit),
    true,
    "an upstream-timeout circuit carries no model class"
  );
  assert.equal(routingProbeCircuit(await routingAccountOf(account("one"), 0)), "quota", "a missing circuit means the quota circuit");
  const classified = { ...leased, probe_lease: { ...lease, quota_class: quotaClass("gpt-6-astra") } };
  assert.equal(probeLeaseMatchesRoutingAccount(classified, routingAccount), true);
  assert.equal(
    probeLeaseMatchesRoutingAccount(
      classified,
      await routingAccountOf(account("one"), 0, { probeGeneration: 3, probeToken: "token-3", probeCircuit: "quota", requestedModel: "gpt-oss-120b" })
    ),
    false,
    "a lease for another model class does not cover this request"
  );
});

test("withSlot grows the slot list to the requested index and stamps the update", () => {
  const state = stateWith(neutralSlot("credential-one", "account-one-hash"));
  const grown = withSlot(state, 2, neutralSlot("credential-three", "account-three-hash"));
  assert.equal(grown.slots.length, 3);
  assert.equal(grown.slots[2].account_id_hash, "account-three-hash");
  assert.equal(grown.slots[1].account_id_hash, "account-three-hash", "a gap slot is a neutral filler until the durable state describes it");
  assert.equal(grown.slots[1].generation, 0);
  assert.equal(grown.slots[0], state.slots[0], "existing slot references are preserved");
  assert.ok(grown.updated_at_ms > 0);
  const replaced = withSlot(state, 0, neutralSlot("credential-one", "account-one-hash"));
  assert.equal(replaced.slots.length, 1);
});

test("percent parsing and headroom projection ignore unusable values", () => {
  assert.equal(parseFinitePercent(null), null);
  assert.equal(parseFinitePercent("42"), 42);
  assert.equal(parseFinitePercent("abc"), null);
  assert.equal(parseFinitePercent("-1"), null);
  assert.equal(parseFinitePercent("101"), null);
  assert.equal(capacityState("available"), "available");
  assert.equal(capacityState("stale"), "stale");
  assert.equal(capacityState("unavailable"), "unavailable");
  assert.equal(capacityState("unknown"), null);
  assert.equal(capacityState(7), null);

  const both = { ...neutralSlot("credential-one", "account-one-hash"), primary_used_percent: 70, secondary_used_percent: 90 };
  assert.equal(quotaHeadroomFor(both), 10, "the tightest window decides the headroom");
  const empty = neutralSlot("credential-one", "account-one-hash");
  assert.equal(quotaHeadroomFor(empty), null);
  const negative = { ...empty, primary_used_percent: 120 };
  assert.equal(quotaHeadroomFor(negative), 0, "an over-quota window reports no negative headroom");
});

test("class-scoped quota blocks keep the legacy class list and its synthetic unknown fence", () => {
  const astra = quotaClass("gpt-6-astra");
  const known = slotWithClassBlock(astra, quotaBlock(1_790_000_000));
  assert.equal(quotaBlockForClass(known, astra)?.blocked_until_ms, 1_790_000_000);
  assert.equal(quotaClass("gpt-6-astra"), "standard");
  assert.equal(quotaClass("gpt-oss-120b"), "gpt_oss_120b");
  assert.equal(quotaBlockForClass(known, quotaClass("gpt-oss-120b")), null, "another known class is not covered by this class's fence");

  const syntheticFence = quotaBlock(1_790_000_100, { legacy_fallback: true });
  const migrated = slotWithClassBlock(astra, quotaBlock(1_790_000_000), {
    quota_blocks_by_class: { [astra]: quotaBlock(1_790_000_000), unknown: syntheticFence },
    quota_blocked_classes: [astra, "unknown"],
    quota_blocked_until_ms: syntheticFence.blocked_until_ms,
  });
  assert.equal(quotaBlockKeyForClass(migrated, astra), "unknown", "a known-class recovery releases the shared synthetic fence instead of the class entry");
  assert.equal(quotaBlockKeyForClass(migrated, "unknown"), "unknown");
  assert.equal(quotaBlockKeyForClass(neutralSlot("credential-one", "account-one-hash"), astra), null);

  const released = withoutQuotaClass(migrated, astra);
  assert.deepEqual(released.quota_blocks_by_class, {}, "the synthetic unknown fence is dropped with the class it mirrors");
  assert.deepEqual(released.quota_blocked_classes, []);
  assert.equal(released.quota_blocked_until_ms, null);
  assert.equal(quotaBlocksIncludingLegacy(migrated).unknown?.blocked_until_ms, syntheticFence.blocked_until_ms);
  assert.equal(quotaSignalObservedAtForClass(migrated, astra), syntheticFence.quota_signal_observed_at_ms);
  assert.equal(quotaSignalObservedAtForClass(neutralSlot("credential-one", "account-one-hash"), astra), null);
});

test("recheckQuotaClasses preserves legacy evidence and re-fences every class block", () => {
  const recheckAtMs = 1_790_000_500;
  const legacyOnly = { ...neutralSlot("credential-one", "account-one-hash"), quota_blocked_until_ms: 1_790_000_100, quota_blocked_classes: ["codex"] };
  const recheckedLegacy = recheckQuotaClasses(legacyOnly, recheckAtMs);
  assert.equal(recheckedLegacy.quota_blocked_until_ms, recheckAtMs, "a legacy fence is rechecked rather than erased");
  assert.equal(recheckedLegacy.banked_reset_generation_ambiguous, true, "rechecking marks the generation as ambiguous");
  const unblocked = recheckQuotaClasses(neutralSlot("credential-one", "account-one-hash"), recheckAtMs);
  assert.equal(unblocked.quota_blocked_until_ms, null, "an unblocked slot stays unblocked");
  assert.equal(unblocked.banked_reset_generation_ambiguous, false);

  const astra = quotaClass("gpt-6-astra");
  const blocked = slotWithClassBlock(astra, quotaBlock(1_790_000_100, { observed_reset_at_ms: 1_790_000_200, observed_reset_at_is_stable: true }));
  const rechecked = recheckQuotaClasses(blocked, recheckAtMs);
  const recheckedBlock = rechecked.quota_blocks_by_class?.[astra];
  assert.ok(recheckedBlock);
  assert.equal(recheckedBlock.blocked_until_ms, recheckAtMs);
  assert.equal(recheckedBlock.quota_signal_observed_at_ms, recheckAtMs);
  assert.equal(recheckedBlock.banked_reset_generation_ambiguous, true);
  assert.equal(rechecked.observed_reset_at_ms, 1_790_000_200, "the recorded reset evidence survives a recheck");
  assert.equal(rechecked.observed_reset_at_is_stable, true);
});

test("releaseQuotaClassProbe clears the class fence and keeps pending recovery evidence", () => {
  const astra = quotaClass("gpt-6-astra");
  const released = releaseQuotaClassProbe(slotWithClassBlock(astra, quotaBlock(1_790_000_100)), astra);
  assert.deepEqual(released.quota_blocks_by_class, {});
  assert.equal(released.banked_reset_generation_ambiguous, false);

  const pending = slotWithClassBlock(astra, quotaBlock(1_790_000_100, { observed_reset_at_ms: 1_790_000_200, observed_reset_at_is_stable: true }), {
    banked_reset_recovery_probe_pending: true,
  });
  const releasedPending = releaseQuotaClassProbe(pending, astra);
  assert.equal(releasedPending.observed_reset_at_ms, 1_790_000_200, "the pending recovery keeps the observed reset instant");
  assert.equal(releasedPending.observed_reset_at_is_stable, true);
  assert.equal(releasedPending.banked_reset_generation_ambiguous, true);
});

test("legacy timeout fences are discarded before any routing decision", async () => {
  await ScriptedKv.run(async (kv) => {
    const auth = account("one");
    const identity = await routingAccountIdentity(auth);
    await kv.set(
      CODEX_ACCOUNT_ROUTING_KV_KEY,
      stateWith({ ...neutralSlot(identity.credentialVersion, identity.accountIdHash), upstream_timeout_blocked_until_ms: 1_790_000_000 })
    );
    const loaded = await loadCodexAccountRouting(poolOf(auth));
    assert.equal(loaded.slots[0].upstream_timeout_blocked_until_ms, null, "a durable legacy timeout fence never reaches a decision");

    let fenceSeenByTransform: number | null | undefined;
    await updateRoutingState((state) => {
      fenceSeenByTransform = state.slots[0].upstream_timeout_blocked_until_ms;
      return null;
    });
    assert.equal(fenceSeenByTransform, null, "a transition always starts from a cleaned base state");
  });
});

/* --------------------------------------------------- loading and transitions */

test("loadCodexAccountRouting normalizes from the auth pool without a KV binding and caches the result", async () => {
  setKvForTest(null);
  resetCodexAccountRoutingForTest();
  try {
    const pool = poolOf(account("one"), account("two"));
    const first = await loadCodexAccountRouting(pool);
    assert.equal(first.v, 2);
    assert.equal(first.slots.length, 2, "one slot per pool account");
    assert.equal(first.banked_reset_legacy_identity_unresolved, false);
    assert.deepEqual(first.slots[0].quota_blocks_by_class, {});

    const cached = await loadCodexAccountRouting(pool);
    assert.equal(cached, first, "the routing cache serves later reads without KV");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("loadCodexAccountRouting reads the durable row and falls open when the binding fails", async () => {
  await ScriptedKv.run(async (kv) => {
    const auth = account("one");
    const identity = await routingAccountIdentity(auth);
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, stateWith({ ...neutralSlot(identity.credentialVersion, identity.accountIdHash), generation: 9 }));
    const loaded = await loadCodexAccountRouting(poolOf(auth));
    assert.equal(loaded.slots[0].generation, 9, "a durable slot is reused instead of rebuilt");
    assert.ok(kv.gets.some((key) => key === keyOf(CODEX_ACCOUNT_ROUTING_KV_KEY)));
  });

  await ScriptedKv.run(async (kv) => {
    const pool = poolOf(account("one"));
    kv.rejectGets = true;
    const failedOpen = await loadCodexAccountRouting(pool);
    assert.equal(failedOpen.v, 2);
    assert.equal(failedOpen.slots.length, 1);
    assert.deepEqual(failedOpen.slots[0].quota_blocks_by_class, {}, "a KV failure still yields a usable neutral state");
  });
});

test("updateRoutingState applies a local transition when there is no KV binding", async () => {
  setKvForTest(null);
  resetCodexAccountRoutingForTest();
  try {
    const pool = poolOf(account("one"));
    const base = await loadCodexAccountRouting(pool);
    assert.equal(base.v, 2, "the transition starts from a loaded routing state");
    const next = await updateRoutingState((state) => ({ ...state, updated_at_ms: 42 }));
    assert.ok(next);
    assert.equal(next.updated_at_ms, 42);

    const unchanged = await updateRoutingState(() => null);
    assert.ok(unchanged);
    assert.equal(unchanged.updated_at_ms, 42, "a transform that declines reports the current state");

    const replacement = await updateRoutingState((state) => ({ ...state, updated_at_ms: 99 }));
    assert.ok(replacement);
    assert.equal(replacement.updated_at_ms, 99);

    resetCodexAccountRoutingForTest();
    assert.equal(await updateRoutingState((state) => state), null, "a transition without any known state is refused");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("updateRoutingState commits with the cached versionstamp, survives a lost race and reports exhaustion", async () => {
  await ScriptedKv.run(async (kv) => {
    const pool = poolOf(account("one"));
    await loadCodexAccountRouting(pool);
    const committed = await updateRoutingState((state) => ({ ...state, updated_at_ms: 7 }));
    assert.ok(committed);
    assert.equal(committed.updated_at_ms, 7);
    const durable = kv.values.get(keyOf(CODEX_ACCOUNT_ROUTING_KV_KEY)) as CodexAccountRoutingState;
    assert.equal(durable.updated_at_ms, 7, "the transition reached the durable row");

    // A concurrent writer moves the row on: the cached stamp loses and the
    // strong re-read retry commits the transition on top of the new state.
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, { ...durable, updated_at_ms: 11 });
    const retried = await updateRoutingState((state) => ({ ...state, updated_at_ms: state.updated_at_ms + 1 }));
    assert.ok(retried);
    assert.equal(retried.updated_at_ms, 12, "the retry applies the transition to the durable state");
  });

  await ScriptedKv.run(async (kv) => {
    const pool = poolOf(account("one"));
    await loadCodexAccountRouting(pool);
    kv.commitFailures = 20;
    assert.equal(await updateRoutingState((state) => ({ ...state, updated_at_ms: 5 })), null, "an exhausted compare-and-set reports the conflict");
    assert.ok(kv.commitAttempts.length >= 3, "every attempt is a checked compare-and-set");
  });
});

test("capacity observations are parsed defensively from the durable store", () => {
  const valid = observationOf({ slot: 0, account_id_hash: "account-one-hash" });
  assert.deepEqual(parseStoredCapacityObservationStore({ v: 1, observations: [valid] }), [valid]);
  assert.deepEqual(parseStoredCapacityObservationStore({ v: 2, observations: [valid] }), [], "an unknown store version is ignored");
  assert.deepEqual(parseStoredCapacityObservationStore({ v: 1, observations: "not-an-array" }), []);
  assert.deepEqual(parseStoredCapacityObservationStore(null), []);
  assert.deepEqual(
    parseStoredCapacityObservationStore({
      v: 1,
      observations: [
        { ...valid, slot: 3 },
        { ...valid, slot: 0.5 },
        { ...valid, account_id_hash: "" },
        { ...valid, state: "bogus" },
        { ...valid, snapshot_at_ms: -1 },
        { ...valid, windows: null },
        "not-an-observation",
      ],
    }),
    [],
    "an observation missing any required field is dropped rather than guessed at"
  );
  assert.deepEqual(
    parseStoredCapacityObservationStore({
      v: 1,
      observations: [
        {
          slot: 1,
          account_id_hash: "account-two-hash",
          state: "available",
          source_observed_at_ms: null,
          snapshot_at_ms: 1_790_000_000_000,
          windows: { primary: 5, secondary: { limit_window_seconds: 600, used_percent: 200, reset_at_ms: "later" } },
          additional_rate_limits: [
            { limit_name: "", windows: {} },
            { limit_name: "gpt-6", windows: null },
            { limit_name: "gpt-6", windows: {}, metered_feature: 7 },
          ],
        },
      ],
    }).map((parsed) => ({ windows: parsed.windows, limits: parsed.additional_rate_limits })),
    [
      {
        windows: { primary: null, secondary: { limit_window_seconds: 600, used_percent: null, reset_at_ms: null } },
        limits: [],
      },
    ],
    "a non-object window becomes null, an out-of-range percent is dropped and unusable extra limits are discarded"
  );
});

test("capacity headroom follows the requested model's own rate-limit windows", () => {
  const observation = observationOf({
    slot: 0,
    account_id_hash: "account-one-hash",
    windows: { primary: { limit_window_seconds: 300, used_percent: 25, reset_at_ms: null }, secondary: null },
    additional_rate_limits: [
      {
        limit_name: "gpt-6-astra",
        metered_feature: null,
        windows: { primary: { limit_window_seconds: 300, used_percent: 80, reset_at_ms: null }, secondary: null },
      },
      { limit_name: "gpt-6-luna", metered_feature: null, windows: { primary: null, secondary: null } },
    ],
  });
  assert.equal(capacityHeadroomForObservation(observation, null), 75, "without a model the account-wide windows decide");
  assert.equal(capacityHeadroomForObservation(observation, "gpt-6-astra"), 20, "a model-specific window overrides the account-wide one");
  assert.equal(capacityHeadroomForObservation(observation, "gpt-6-luna"), null, "a model limit without a usable window reports no headroom");
  assert.equal(capacityHeadroomForObservation(observation, "unlisted-model"), 75);

  const now = 1_790_000_100_000;
  assert.equal(capacityObservationIsFresh({ ...observation, snapshot_at_ms: now - 1_000 }, now), true);
  assert.equal(capacityObservationIsFresh({ ...observation, snapshot_at_ms: now + 1 }, now), false, "an observation from the future is not fresh");
  assert.equal(capacityObservationIsFresh({ ...observation, snapshot_at_ms: now - CODEX_CAPACITY_ROUTING_MAX_AGE_MS - 1 }, now), false);
  assert.equal(capacityObservationIsFresh({ ...observation, state: "unavailable", snapshot_at_ms: now }, now), false);
});
/* ------------------------------------- observation persistence and merging */

const observationInputOf = (
  input: Partial<CodexCapacityRoutingObservationInput> & { slot: number; account_id: string }
): CodexCapacityRoutingObservationInput => ({
  state: "available",
  source_observed_at_ms: null,
  snapshot_at_ms: NOW_MS - 5_000,
  windows: { primary: { limit_window_seconds: 300, used_percent: 12, reset_at_ms: null }, secondary: null },
  additional_rate_limits: [],
  ...input,
});

const storedObservationsOf = (kv: ScriptedKv): readonly CodexCapacityRoutingObservation[] => {
  const store = kv.values.get(keyOf(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY)) as
    { v: number; observations: readonly CodexCapacityRoutingObservation[] } | undefined;
  return store?.observations ?? [];
};

const NOW_MS = 1_790_000_000_000;

test("recordCodexCapacityRoutingObservations stores only account-hash-bound rows and refuses unusable input", async () => {
  await ScriptedKv.run(async (kv) => {
    const one = account("one");
    const pool = poolOf(one, account("two"));
    await recordCodexCapacityRoutingObservations([observationInputOf({ slot: 0, account_id: "one" })], NOW_MS);
    const stored = storedObservationsOf(kv);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].slot, 0);
    assert.equal(stored[0].account_id_hash, await accountHashOf(one), "the durable row is bound to the opaque account hash");
    assert.equal(
      JSON.stringify(kv.values.get(keyOf(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY))).includes("one"),
      false,
      "the raw account id never reaches the durable row"
    );

    const writesAfterFirst = kv.writes.length;
    await recordCodexCapacityRoutingObservations(
      [
        observationInputOf({ slot: 3, account_id: "one" }),
        observationInputOf({ slot: 0.5, account_id: "one" }),
        observationInputOf({ slot: 0, account_id: "   " }),
        observationInputOf({ slot: 0, account_id: "one", snapshot_at_ms: -1 }),
        observationInputOf({ slot: 0, account_id: "one", state: "bogus" as CodexCapacityRoutingObservationInput["state"] }),
      ],
      NOW_MS
    );
    assert.equal(kv.writes.length, writesAfterFirst, "an unusable observation is dropped before it can be persisted");
    assert.equal(storedObservationsOf(kv).length, 1);

    const merged = await loadCodexCapacityRoutingObservations(pool, true);
    assert.equal(merged.length, 1, "a later read sees exactly the one accepted observation");
    assert.equal(merged[0].account_id_hash, stored[0].account_id_hash);
  });
});

test("capacity observations are kept in memory without KV and are never adopted after a lost compare-and-set", async () => {
  await ScriptedKv.run(async (kv) => {
    const one = account("one");
    const pool = poolOf(one);
    kv.commitFailures = 20;
    await recordCodexCapacityRoutingObservations([observationInputOf({ slot: 0, account_id: "one" })], NOW_MS);
    assert.equal(storedObservationsOf(kv).length, 0, "a lost compare-and-set persists nothing");
    assert.deepEqual(await loadCodexCapacityRoutingObservations(pool, true), [], "and this isolate does not pretend it was durable");
  });

  setKvForTest(null);
  resetCodexAccountRoutingForTest();
  try {
    const pool = poolOf(account("one"));
    await recordCodexCapacityRoutingObservations([observationInputOf({ slot: 0, account_id: "one" })], NOW_MS);
    const cached = await loadCodexCapacityRoutingObservations(pool);
    assert.equal(cached.length, 1, "without a KV binding the sampler result is still visible in this isolate");
    const forced = await loadCodexCapacityRoutingObservations(pool, true);
    assert.equal(forced.length, 1, "a forced read without a binding keeps the in-memory observations");
    assert.equal(forced[0].slot, 0);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("the durable observation store merges with the legacy provider snapshot by newest sample", async () => {
  await ScriptedKv.run(async (kv) => {
    const one = account("one");
    const pool = poolOf(one);
    const durableSnapshot = NOW_MS - 20_000;
    await kv.set(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, {
      v: 1,
      updated_at_ms: durableSnapshot,
      observations: [
        observationOf({
          slot: 0,
          account_id_hash: await accountHashOf(one),
          snapshot_at_ms: durableSnapshot,
          windows: { primary: { limit_window_seconds: 300, used_percent: 90, reset_at_ms: null }, secondary: null },
        }),
      ],
    });
    const legacySnapshot = NOW_MS - 1_000;
    await kv.set(PROVIDER_CAPACITY_SNAPSHOT_KEY, {
      snapshot_at_ms: legacySnapshot,
      sources: [
        { source: "codex", slot: 1, state: "available", windows: { primary: { limit_window_seconds: 300, used_percent: 30, reset_at_ms: null } } },
        { source: "codex", slot: 2, state: "available", windows: { primary: { limit_window_seconds: 300, used_percent: 5, reset_at_ms: null } } },
        { source: "codex", slot: 1, state: "bogus", windows: { primary: null } },
        { source: "metered", slot: 1, state: "available", windows: { primary: null } },
      ],
    });

    const merged = await loadCodexCapacityRoutingObservations(pool, true);
    assert.equal(merged.length, 1, "both sources describe the same account, so the newest sample wins");
    assert.equal(merged[0].slot, 0);
    assert.equal(merged[0].account_id_hash, await accountHashOf(one), "a legacy slot-only snapshot is re-bound to the current account");
    assert.equal(merged[0].snapshot_at_ms, legacySnapshot, "the newer legacy sample is adopted");
    assert.equal(merged[0].windows.primary?.used_percent, 30);
  });

  await ScriptedKv.run(async (kv) => {
    const one = account("one");
    const newerPool = { accounts: [one], updated_at_ms: NOW_MS };
    await kv.set(PROVIDER_CAPACITY_SNAPSHOT_KEY, {
      snapshot_at_ms: NOW_MS - 60_000,
      sources: [{ source: "codex", slot: 1, state: "available", windows: { primary: { limit_window_seconds: 300, used_percent: 30, reset_at_ms: null } } }],
    });
    assert.deepEqual(
      await loadCodexCapacityRoutingObservations(newerPool, true),
      [],
      "a snapshot older than the auth pool can no longer be attributed to a slot"
    );
  });

  await ScriptedKv.run(async (kv) => {
    const pool = poolOf(account("one"));
    await kv.set(PROVIDER_CAPACITY_SNAPSHOT_KEY, { snapshot_at_ms: NOW_MS, sources: "not-an-array" });
    assert.deepEqual(await loadCodexCapacityRoutingObservations(pool, true), []);
    kv.rejectGets = true;
    assert.deepEqual(await loadCodexCapacityRoutingObservations(pool, true), [], "a failing binding yields no observations instead of throwing");
  });
});

test("reconcileCapacityRoutingState applies only observations that still describe the durable slot", async () => {
  await ScriptedKv.run(async () => {
    const one = account("one");
    const two = account("two");
    const pool = poolOf(one, two);
    const base = await loadCodexAccountRouting(pool);
    const now = NOW_MS;
    const matching = observationOf({
      slot: 0,
      account_id_hash: await accountHashOf(one),
      snapshot_at_ms: now - 1_000,
      windows: {
        primary: { limit_window_seconds: 300, used_percent: 40, reset_at_ms: null },
        secondary: { limit_window_seconds: 60, used_percent: 10, reset_at_ms: null },
      },
    });

    const reconciled = await reconcileCapacityRoutingState(
      base,
      [
        observationOf({ ...matching, snapshot_at_ms: now + 1 }),
        observationOf({ ...matching, slot: 5 }),
        observationOf({ ...matching, account_id_hash: await accountHashOf(two) }),
        matching,
      ],
      now,
      null
    );
    assert.equal(reconciled.slots[0].primary_used_percent, 40, "the matching observation updates its own slot");
    assert.equal(reconciled.slots[0].secondary_used_percent, 10);
    assert.equal(reconciled.slots[0].capacity_observed_at_ms, now - 1_000);
    assert.equal(reconciled.slots[0].generation, base.slots[0].generation + 1, "a positive observation advances the slot generation");
    assert.equal(reconciled.slots[1], base.slots[1], "another account's slot is untouched");

    const older = observationOf({
      ...matching,
      snapshot_at_ms: now - 2_000,
      windows: { primary: { limit_window_seconds: 300, used_percent: 5, reset_at_ms: null }, secondary: null },
    });
    const noChange = await reconcileCapacityRoutingState(reconciled, [older], now, null);
    assert.equal(noChange, reconciled, "an observation older than the slot's last sample is ignored");
    assert.equal(noChange.slots[0].primary_used_percent, 40);
  });
});

test("a recorded observation reconciles the cached routing slot before the next inference", async () => {
  await ScriptedKv.run(async (kv) => {
    const one = account("one");
    const pool = poolOf(one);
    const base = await loadCodexAccountRouting(pool);
    assert.equal(base.slots.length, 1, "the cached slot is the one the recorded observation must reconcile");
    const accountHash = await accountHashOf(one);
    await recordCodexCapacityRoutingObservations(
      [
        observationInputOf({
          slot: 0,
          account_id: "one",
          snapshot_at_ms: NOW_MS - 1_000,
          windows: { primary: { limit_window_seconds: 300, used_percent: 55, reset_at_ms: null }, secondary: null },
        }),
      ],
      NOW_MS
    );

    let cachedPercent: number | null | undefined;
    await updateRoutingState((state) => {
      cachedPercent = state.slots[0].primary_used_percent;
      return null;
    });
    assert.equal(cachedPercent, 55, "the dashboard refresh reconciles the cached slot immediately");
    assert.equal(await accountHashOf(one), accountHash);
    const stored = storedObservationsOf(kv);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].snapshot_at_ms, NOW_MS - 1_000);
  });
});
