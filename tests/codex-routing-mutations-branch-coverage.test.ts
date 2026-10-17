import { test } from "bun:test";
import { type AtomicOperation, type Kv, type KvCommitError, type KvEntryMaybe, type KvKey } from "#kv";
// Branch-coverage tests for src/codex/routing-mutations.ts.
//
// The routing mutations are guard-heavy: every writer re-checks the durable
// slot identity, the half-open probe lease and the credential version before it
// writes. Each test drives one guard in both directions and asserts the durable
// KV row (or the returned account) rather than the internal control flow.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_HALF_OPEN_LEASE_MS,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  httpDateQuotaResponse,
  key,
  markCodexQuotaBlocked,
  parseCodexAccountRoutingState,
  pool,
  required,
  resetCodexAccountRoutingForTest,
  RoutingKv,
  selectCodexRoutingAccounts,
  setKvForTest,
} from "./helpers/codex-account-routing-harness.ts";
import {
  claimCodexRoutingProbe,
  getCodexQuotaBlockFence,
  isCodexQuotaBlockFenceCurrent,
  markCodexCredentialInvalid,
  markCodexUpstreamTimeout,
  reconcileCodexQuotaAfterVerifiedReset,
  reconcileCodexRoutingAccount,
  releaseCodexRoutingProbe,
} from "../src/codex/routing-mutations.ts";
import { codexCredentialVersion } from "../src/codex/account-routing.ts";
import { loadCodexAccountRouting } from "../src/codex/capacity-routing.ts";
import type { CodexAccountRoutingState, CodexRoutingSlot, RoutingAccount } from "../src/codex/routing-state.ts";
import type { CodexAuthState } from "../src/types.ts";

const NOW = 1_700_000_000_000;

/** The shared in-memory routing KV with individually controllable failures. */
class FaultyRoutingKv extends RoutingKv {
  throwOnGet = false;
  throwForKey: string | null = null;
  failCommits = false;

  override get<T>(kvKey: KvKey): Promise<KvEntryMaybe<T>> {
    if (this.throwOnGet || this.throwForKey === key(kvKey)) throw new Error("routing kv get failed");
    return super.get<T>(kvKey);
  }

  override atomic(): AtomicOperation {
    const operation = super.atomic();
    const commit = operation.commit.bind(operation);
    operation.commit = async () => (this.failCommits ? ({ ok: false } as KvCommitError) : await commit());
    return operation;
  }
}

const stateOf = (kv: RoutingKv): CodexAccountRoutingState | null => parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));

const requiredState = (kv: RoutingKv): CodexAccountRoutingState => required(stateOf(kv), "a persisted routing state");

const slotOf = (kv: RoutingKv, account: RoutingAccount): CodexRoutingSlot =>
  required(requiredState(kv).slots[account.slot], "a persisted slot for the account");

const seedSlot = (kv: RoutingKv, slot: number, value: CodexRoutingSlot): void => {
  const state = requiredState(kv);
  kv.values.set(key(CODEX_ACCOUNT_ROUTING_KV_KEY), { ...state, slots: state.slots.map((current, index) => (index === slot ? value : current)) });
  // The routing cache must observe the seeded row rather than its pre-seed copy.
  resetCodexAccountRoutingForTest();
};

const selectedAccounts = async (now = NOW): Promise<readonly RoutingAccount[]> => {
  const selected = await selectCodexRoutingAccounts(pool, pool.accounts, now);
  assert.equal(selected.kind, "eligible");
  return selected.accounts;
};

/** A normalized lease: its generation always matches the slot that holds it. */
const leaseFor = (generation: number, overrides: Record<string, unknown> = {}) => ({
  token: "probe-token",
  expires_at_ms: NOW + CODEX_HALF_OPEN_LEASE_MS,
  generation,
  circuit: "quota" as const,
  quota_class: null,
  ...overrides,
});

const rotatedAuth = (accountId: string, accessToken: string): CodexAuthState => ({
  access_token: accessToken,
  refresh_token: `refresh-${accessToken}`,
  account_id: accountId,
  updated_at_ms: NOW,
});

test("upstream timeout marker refuses a foreign slot, a lease-only slot and a stale lease", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const accounts = await selectedAccounts();
    const [first, second] = accounts;
    await markCodexUpstreamTimeout(first, NOW);
    const blockedUntil = NOW + CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS;
    assert.equal(slotOf(kv, first).upstream_timeout_blocked_until_ms, blockedUntil);
    const afterSuccess = structuredClone(requiredState(kv).slots[first.slot]);

    // A slot that belongs to another account is never overwritten.
    await markCodexUpstreamTimeout({ ...second, slot: first.slot }, NOW);
    assert.deepEqual(slotOf(kv, first), afterSuccess);

    // A slot holding a lease this account does not own is left alone.
    const heldGeneration = afterSuccess.generation;
    seedSlot(kv, first.slot, { ...afterSuccess, probe_lease: leaseFor(heldGeneration, { token: "someone-elses-lease" }) });
    const withLease = structuredClone(slotOf(kv, first));
    await markCodexUpstreamTimeout({ ...first, probeGeneration: null, probeToken: null }, NOW);
    assert.deepEqual(slotOf(kv, first), withLease);

    await markCodexUpstreamTimeout({ ...first, probeGeneration: heldGeneration, probeToken: "not-the-token", probeCircuit: "quota" }, NOW);
    assert.deepEqual(slotOf(kv, first), withLease);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("credential-invalid marker refuses a foreign slot and a foreign lease", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const accounts = await selectedAccounts();
    const [first, second] = accounts;
    await markCodexCredentialInvalid(first);
    const afterSuccess = structuredClone(slotOf(kv, first));
    assert.equal(afterSuccess.invalid_credential_version, first.credentialVersion);

    await markCodexCredentialInvalid({ ...second, slot: first.slot });
    assert.deepEqual(slotOf(kv, first), afterSuccess);

    seedSlot(kv, first.slot, { ...afterSuccess, probe_lease: leaseFor(afterSuccess.generation, { token: "not-this-account" }) });
    const withForeignLease = structuredClone(slotOf(kv, first));
    await markCodexCredentialInvalid({ ...first, probeGeneration: 99, probeToken: "other", probeCircuit: "quota" });
    assert.deepEqual(slotOf(kv, first), withForeignLease);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("credential reconciliation keeps a matching claim and drops an unrenewable one", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const accounts = await selectedAccounts();
    const account = accounts[0];
    await markCodexQuotaBlocked(account, httpDateQuotaResponse(NOW + 60_000), NOW);

    // Unchanged credentials keep the account, its identity hash and its probe fence.
    const unchanged = await reconcileCodexRoutingAccount(account, account.auth);
    assert.deepEqual(unchanged, account);

    // A rotated credential for the same account retains a lease that is still
    // durable under the new credential version (lines 137-140).
    const leaseGeneration = slotOf(kv, account).generation;
    const lease = leaseFor(leaseGeneration);
    seedSlot(kv, account.slot, {
      ...slotOf(kv, account),
      account_id_hash: account.accountIdHash,
      probe_lease: lease,
    });
    const claimedAccount: RoutingAccount = {
      ...account,
      probeGeneration: lease.generation,
      probeToken: lease.token,
      probeCircuit: "quota",
    };
    const retained = await reconcileCodexRoutingAccount(claimedAccount, rotatedAuth(account.auth.account_id, "rotated-access"));
    assert.notEqual(retained.credentialVersion, account.credentialVersion);
    const durable = slotOf(kv, account);
    const durableLease = durable.probe_lease;
    assert.ok(durableLease);
    assert.equal(durable.credential_version, retained.credentialVersion);
    assert.equal(retained.probeGeneration, durable.generation);
    assert.equal(retained.probeGeneration, durableLease.generation);
    assert.equal(retained.probeToken, durableLease.token);
    assert.equal(retained.probeCircuit, "quota");

    // The same rotation against a slot that already holds the new credential
    // version writes nothing and therefore cannot retain the fence (line 114).
    const newVersion = await codexCredentialVersion(rotatedAuth(account.auth.account_id, "rotated-again"));
    seedSlot(kv, account.slot, {
      ...slotOf(kv, account),
      credential_version: newVersion,
      account_id_hash: account.accountIdHash,
      probe_lease: lease,
    });
    const dropped = await reconcileCodexRoutingAccount(claimedAccount, rotatedAuth(account.auth.account_id, "rotated-again"));
    assert.equal(dropped.credentialVersion, newVersion);
    assert.equal(dropped.probeGeneration, null);
    assert.equal(dropped.probeToken, null);
    assert.equal(dropped.probeCircuit, null);

    // A replacement account starts from a neutral slot without the old fence.
    seedSlot(kv, account.slot, { ...slotOf(kv, account), probe_lease: null });
    const replaced = await reconcileCodexRoutingAccount(claimedAccount, rotatedAuth("different-account", "replacement"));
    assert.equal(replaced.probeGeneration, null);
    assert.equal(replaced.probeToken, null);
    assert.notEqual(replaced.accountIdHash, account.accountIdHash);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("probe release refuses a slot that is not the claim and clears the claimed circuit", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const accounts = await selectedAccounts();
    const account = accounts[0];
    await markCodexQuotaBlocked(account, httpDateQuotaResponse(NOW - 1_000), NOW - 10_000);
    resetCodexAccountRoutingForTest();
    const expired = (await selectedAccounts()).find((candidate) => candidate.probeRequired);
    assert.ok(expired);
    const claimed = await claimCodexRoutingProbe(pool, expired, NOW);
    assert.ok(claimed);
    assert.notEqual(claimed.probeToken, null);

    // A slot whose lease token differs from the claim is left untouched.
    seedSlot(kv, claimed.slot, { ...slotOf(kv, claimed), probe_lease: leaseFor(slotOf(kv, claimed).generation, { token: "foreign" }) });
    const foreign = structuredClone(slotOf(kv, claimed));
    await releaseCodexRoutingProbe({ ...claimed, probeToken: "not-the-lease" });
    assert.deepEqual(slotOf(kv, claimed), foreign);

    // Releasing the real claim clears the lease and the quota class it held.
    seedSlot(kv, claimed.slot, { ...foreign, probe_lease: leaseFor(foreign.generation, { token: claimed.probeToken ?? "probe-token" }) });
    await releaseCodexRoutingProbe(claimed);
    const released = slotOf(kv, claimed);
    assert.equal(released.probe_lease, null);
    assert.deepEqual(released.quota_blocks_by_class ?? {}, {});

    // The upstream-timeout circuit is a legacy shape: normalization discards the
    // deadline and its lease before any live mutation can observe them, which is
    // why the timeout branch of the release is unreachable from durable state.
    const timeoutTimeGeneration = released.generation;
    seedSlot(kv, claimed.slot, {
      ...released,
      upstream_timeout_blocked_until_ms: NOW + 5_000,
      probe_lease: leaseFor(timeoutTimeGeneration, { circuit: "upstream_timeout", token: "timeout-token" }),
    });
    const timeoutSeeded = structuredClone(slotOf(kv, claimed));
    await releaseCodexRoutingProbe({
      ...claimed,
      probeCircuit: "upstream_timeout",
      probeToken: "timeout-token",
      probeGeneration: timeoutTimeGeneration,
    });
    assert.deepEqual(slotOf(kv, claimed), timeoutSeeded);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});
/** Re-expires the account's quota circuit so every start of a claim is independent. */
const seedExpiredCircuit = async (account: RoutingAccount, at: number): Promise<RoutingAccount> => {
  await markCodexQuotaBlocked(account, httpDateQuotaResponse(at - 1_000), at - 10_000);
  resetCodexAccountRoutingForTest();
  const expired = (await selectedAccounts(at)).find((candidate) => candidate.probeRequired);
  if (!expired) throw new Error("expected an expired probe circuit");
  return expired;
};

/** A quota-blocked account with the fence generation a verified reset would carry. */
const blockedFenceFixture = async (kv: RoutingKv, resetAtMs: number) => {
  const accounts = await selectedAccounts();
  const account = accounts[0];
  await markCodexQuotaBlocked(account, httpDateQuotaResponse(resetAtMs), NOW);
  const generation = await getCodexQuotaBlockFence(account, resetAtMs);
  assert.equal(typeof generation, "number");
  if (generation === null) throw new Error("unreachable");
  return { account, generation, state: requiredState(kv) };
};

test("quota block fence predicate and strong read reject invalid inputs and unreadable KV", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const resetAtMs = NOW + 60_000;
    const { account, generation, state } = await blockedFenceFixture(kv, resetAtMs);
    assert.equal(isCodexQuotaBlockFenceCurrent(state, account, resetAtMs, generation), true);

    assert.equal(isCodexQuotaBlockFenceCurrent(state, account, Number.NaN, generation), false);
    assert.equal(isCodexQuotaBlockFenceCurrent(state, account, resetAtMs, 1.5), false);
    assert.equal(isCodexQuotaBlockFenceCurrent(state, account, resetAtMs, -1), false);
    assert.equal(isCodexQuotaBlockFenceCurrent(state, account, resetAtMs + 1, generation), false);
    assert.equal(isCodexQuotaBlockFenceCurrent({ ...state, banked_reset_legacy_identity_unresolved: true }, account, resetAtMs, generation), false);

    assert.equal(await getCodexQuotaBlockFence(account, Number.NaN), null);
    assert.equal(await getCodexQuotaBlockFence(account, -1), null);
    assert.equal(await getCodexQuotaBlockFence(account, resetAtMs), generation);

    // A read that fails is not a fence: the strong read fails closed.
    const faulty = new FaultyRoutingKv();
    faulty.values = kv.values;
    faulty.versions = kv.versions;
    faulty.throwOnGet = true;
    setKvForTest(faulty as unknown as Kv);
    assert.equal(await getCodexQuotaBlockFence(account, resetAtMs), null);

    // KV itself being unavailable is also a fail-closed null.
    setKvForTest(null);
    assert.equal(await getCodexQuotaBlockFence(account, resetAtMs), null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("verified-reset reconciliation rejects invalid input, stale fences and unreadable fences", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const resetAtMs = NOW + 60_000;
    const { account, generation } = await blockedFenceFixture(kv, resetAtMs);

    assert.equal(await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: Number.NaN, routingGeneration: generation }), null);
    assert.equal(await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: resetAtMs, routingGeneration: -1 }), null);

    const fenceKey: KvKey = ["test", "reset-fence"];
    const malformedFences = [{ key: "not-a-key", isCurrent: "no" }] as unknown as readonly {
      key: KvKey;
      isCurrent: (value: unknown) => boolean;
    }[];
    assert.equal(
      await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: resetAtMs, routingGeneration: generation, fences: malformedFences }),
      null
    );

    const staleFence = { key: fenceKey, isCurrent: () => false };
    assert.equal(
      await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: resetAtMs, routingGeneration: generation, fences: [staleFence] }),
      null
    );

    const faulty = new FaultyRoutingKv();
    faulty.values = kv.values;
    faulty.versions = kv.versions;
    faulty.throwForKey = key(fenceKey);
    setKvForTest(faulty as unknown as Kv);
    const currentFence = { key: fenceKey, isCurrent: () => true };
    assert.equal(
      await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: resetAtMs, routingGeneration: generation, fences: [currentFence] }),
      null
    );

    // A current fence is read and checked for every listed entry.
    faulty.throwForKey = null;
    const claimed = await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: resetAtMs, routingGeneration: generation, fences: [currentFence] });
    assert.ok(claimed);
    setKvForTest(kv as unknown as Kv);

    // Every lost compare-and-set exhausts the bounded retry loop.
    const retrying = new FaultyRoutingKv();
    retrying.values = kv.values;
    retrying.versions = kv.versions;
    retrying.failCommits = true;
    setKvForTest(retrying as unknown as Kv);
    const before = structuredClone(requiredState(kv));
    assert.equal(await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: resetAtMs, routingGeneration: generation }), null);
    assert.deepEqual(requiredState(kv), before);

    // A throwing read inside the attempt is a fail-closed null, not an escape.
    retrying.failCommits = false;
    retrying.throwOnGet = true;
    setKvForTest(kv as unknown as Kv);
    const fenceBeforeThrow = await blockedFenceFixture(kv, resetAtMs + 2_000);
    setKvForTest(retrying as unknown as Kv);
    assert.equal(
      await reconcileCodexQuotaAfterVerifiedReset(fenceBeforeThrow.account, {
        quotaResetAtMs: resetAtMs + 2_000,
        routingGeneration: fenceBeforeThrow.generation,
      }),
      null
    );

    // Without KV there is no durable fence to claim.
    retrying.throwOnGet = false;
    setKvForTest(null);
    assert.equal(await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: resetAtMs, routingGeneration: generation }), null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("verified-reset reconciliation refuses a generation it cannot advance", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const resetAtMs = NOW + 60_000;
    const { account, state } = await blockedFenceFixture(kv, resetAtMs);
    const exhausted = Number.MAX_SAFE_INTEGER;
    seedSlot(kv, account.slot, { ...state.slots[account.slot], generation: exhausted });
    const claimed = await reconcileCodexQuotaAfterVerifiedReset(account, { quotaResetAtMs: resetAtMs, routingGeneration: exhausted });
    assert.equal(claimed, null);
    assert.equal(slotOf(kv, account).generation, exhausted);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("probe claim returns early, claims locally without KV and fails closed on lost commits", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const accounts = await selectedAccounts();
    const account = accounts[0];

    // An account with no pending probe is returned untouched.
    const notRequired = { ...account, probeRequired: false };
    assert.deepEqual(await claimCodexRoutingProbe(pool, notRequired, NOW), notRequired);

    // Expired circuit -> the durable claim is attempted and written. Every later
    // scenario moves past the previous claim's lease so it starts from scratch.
    const leaseStep = CODEX_HALF_OPEN_LEASE_MS + 1;
    const firstAt = NOW;
    const expired = await seedExpiredCircuit(account, firstAt);
    const claimed = await claimCodexRoutingProbe(pool, expired, firstAt);
    assert.ok(claimed);
    const durable = slotOf(kv, claimed);
    const claimedLease = durable.probe_lease;
    assert.ok(claimedLease);
    assert.equal(claimedLease.token, claimed.probeToken);
    assert.equal(claimedLease.circuit, "quota");
    assert.equal(claimedLease.generation, durable.generation);

    // Every lost compare-and-set exhausts the retry loop.
    const secondAt = NOW + leaseStep;
    const retryExpired = await seedExpiredCircuit(account, secondAt);
    const retrying = new FaultyRoutingKv();
    retrying.values = kv.values;
    retrying.versions = kv.versions;
    retrying.failCommits = true;
    setKvForTest(retrying as unknown as Kv);
    assert.equal(await claimCodexRoutingProbe(pool, retryExpired, secondAt), null);

    // A read failure falls back to the locally cached state (availability over coordination).
    const thirdAt = NOW + 2 * leaseStep;
    const localExpired = await seedExpiredCircuit(account, thirdAt);
    await loadCodexAccountRouting(pool);
    const faulty = new FaultyRoutingKv();
    faulty.values = kv.values;
    faulty.versions = kv.versions;
    faulty.throwOnGet = true;
    setKvForTest(faulty as unknown as Kv);
    const durableBeforeLocal = structuredClone(slotOf(kv, localExpired));
    const localFromFailure = await claimCodexRoutingProbe(pool, localExpired, thirdAt);
    assert.ok(localFromFailure);
    assert.equal(localFromFailure.probeGeneration, durableBeforeLocal.generation);
    assert.equal(localFromFailure.probeCircuit, "quota");
    // The local claim is deliberately not durable: the stored row is untouched.
    assert.deepEqual(slotOf(kv, localExpired), durableBeforeLocal);
    assert.notEqual(slotOf(kv, localExpired).probe_lease?.token, localFromFailure.probeToken);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("probe claim falls back to the cached state when KV is unavailable", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const account = (await selectedAccounts())[0];
    const expired = await seedExpiredCircuit(account, NOW);
    // The expired circuit is loaded into this isolate's cache while KV still works.
    await loadCodexAccountRouting(pool);
    setKvForTest(null);
    const claimed = await claimCodexRoutingProbe(pool, expired, NOW);
    assert.ok(claimed);
    assert.notEqual(claimed.probeToken, null);
    assert.equal(claimed.probeGeneration, slotOf(kv, expired).generation);

    // The cache now holds the locally claimed lease, so a second claim has no
    // expired circuit to work with and fails closed.
    assert.equal(await claimCodexRoutingProbe(pool, expired, NOW), null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});
