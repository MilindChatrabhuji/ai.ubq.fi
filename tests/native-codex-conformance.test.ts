import { test } from "bun:test";
import assert from "node:assert/strict";
import * as codex from "../src/authority/native-codex.ts";
import * as capacity from "../src/authority/native-codex-capacity.ts";
import * as mutations from "../src/authority/native-codex-mutations.ts";
import * as contracts from "../src/authority/native-codex-contracts.ts";
import type {
  CodexAccountRoutingState,
  CodexCapacityRoutingObservation,
  CodexRoutingAccount,
  CodexRoutingIdentity,
  CodexRoutingSlot,
} from "../src/authority/native-codex-contracts.ts";

// BEGIN SHARED_CODEX_VECTORS
const fixtureNow = 1_700_000_000_000;
const identities: readonly CodexRoutingIdentity[] = [
  { slot: 0, accountIdHash: "a".repeat(64), credentialVersion: "b".repeat(64) },
  { slot: 1, accountIdHash: "c".repeat(64), credentialVersion: "d".repeat(64) },
];
const same = (actual: unknown, expected: unknown, label: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Codex conformance: " + label);
};
const present = <T>(value: T | null | undefined, label: string): T => {
  if (value === null || value === undefined) throw new Error("Codex conformance missing " + label);
  return value;
};
const stateOf = (slots: readonly CodexRoutingSlot[]): CodexAccountRoutingState => ({
  v: 2,
  updated_at_ms: fixtureNow,
  banked_reset_legacy_identity_unresolved: false,
  slots,
});
const neutralState = (): CodexAccountRoutingState =>
  stateOf(identities.map((identity) => capacity.neutralSlot(identity.credentialVersion, identity.accountIdHash)));
const blockedSlot = (index: number, deadline = fixtureNow + 60_000): CodexRoutingSlot => {
  const identity = identities[index];
  const block = {
    blocked_until_ms: deadline,
    source: "body_resets_at" as const,
    legacy_fallback: false,
    quota_signal_observed_at_ms: fixtureNow,
    observed_reset_at_ms: deadline,
    observed_reset_at_is_stable: true,
    banked_reset_generation_ambiguous: false,
    banked_reset_recovery_probe_pending: false,
  };
  return {
    ...capacity.neutralSlot(identity.credentialVersion, identity.accountIdHash),
    generation: 3,
    quota_blocked_until_ms: deadline,
    quota_block_source: block.source,
    quota_blocked_classes: ["standard"],
    quota_blocks_by_class: { standard: block },
    quota_signal_observed_at_ms: fixtureNow,
    observed_reset_at_ms: deadline,
    observed_reset_at_is_stable: true,
  };
};
const snapshotOf = (routing: unknown = null, active: unknown = null): codex.CodexSerialSnapshot => ({
  active,
  routing,
  capacity: null,
  poolIdentities: identities,
  selectedAccountHashes: identities.map((identity) => identity.accountIdHash),
  accountPolicies: new Map(identities.map((identity) => [identity.accountIdHash, { modelUnavailable: null, overageUsageAllowed: false }])),
  revisions: { active: active === null ? null : "A/opaque:7", pool: "P/opaque:11", routing: routing === null ? null : "R/opaque:13", capacity: null },
});
const eligibleAccount = (plan: contracts.CodexSerialAdmissionPlan): CodexRoutingAccount => {
  if (plan.selection.kind !== "eligible") throw new Error("Codex conformance expected eligible account");
  return present(plan.selection.accounts[0], "selected account");
};
const serialVectors = () => {
  const bootstrap = present(codex.selectCodex(snapshotOf(), fixtureNow, "gpt-test"), "bootstrap");
  const account = eligibleAccount(bootstrap);
  same([account.slot, account.activeGeneration, bootstrap.writes.active?.transition_reason], [0, 1, null], "deterministic bootstrap");
  const routing = present(bootstrap.writes.routing, "bootstrap routing");
  const active = present(bootstrap.writes.active, "bootstrap active");
  const hot = present(codex.selectCodex(snapshotOf(routing, active), fixtureNow + 10, "gpt-other"), "hot admission");
  same(hot.writes, { routing: null, active: null }, "hot admission checks without writes");
  same(hot.checks, { active: "A/opaque:7", pool: "P/opaque:11", routing: "R/opaque:13", capacity: null }, "all four opaque revisions");
  const changedCapacity = present(
    codex.selectCodex({ ...snapshotOf(routing, active), revisions: { ...hot.checks, capacity: "C/conflict:17" } }, fixtureNow + 10, "gpt-test"),
    "conflicting capacity snapshot"
  );
  same(changedCapacity.checks.capacity, "C/conflict:17", "conflict reload uses new C fence");
  same(changedCapacity.writes, hot.writes, "conflict replay stays check-only");
  const reduced = present(
    codex.selectCodex({ ...snapshotOf(), selectedAccountHashes: [identities[1].accountIdHash] }, fixtureNow, "gpt-test"),
    "reduced cohort"
  );
  same([eligibleAccount(reduced).slot, reduced.writes.routing?.slots.length], [1, 2], "selected cohort keeps full-pool slots");
  const reorderedIdentities = [
    { ...identities[1], slot: 0 },
    { ...identities[0], slot: 1 },
  ];
  const reordered = present(codex.selectCodex({ ...snapshotOf(routing, active), poolIdentities: reorderedIdentities }, fixtureNow + 10, "gpt-test"), "reorder");
  same([eligibleAccount(reordered).slot, eligibleAccount(reordered).activeGeneration], [1, 1], "reorder preserves sticky identity and generation");
  const refreshed = present(
    codex.selectCodex(
      { ...snapshotOf(routing, active), poolIdentities: [{ ...identities[0], credentialVersion: "e".repeat(64) }, identities[1]] },
      fixtureNow + 20,
      "gpt-test"
    ),
    "same-account rotation"
  );
  same([eligibleAccount(refreshed).activeGeneration, refreshed.writes.active?.routing_generation], [1, 1], "same-account refresh retains active generation");
  const quotaState = stateOf([blockedSlot(0), routing.slots[1]]);
  const advance = present(codex.selectCodex(snapshotOf(quotaState, active), fixtureNow, "gpt-test"), "quota advance");
  same(
    [eligibleAccount(advance).slot, advance.writes.active?.generation, advance.writes.active?.transition_reason],
    [1, 2, "quota_exhausted"],
    "authoritative quota advances once"
  );
  const exhausted = present(codex.selectCodex(snapshotOf(stateOf([blockedSlot(0), blockedSlot(1)]), active), fixtureNow, "gpt-test"), "full cohort");
  if (exhausted.selection.kind !== "quota_blocked") throw new Error("Codex conformance expected exhausted quota cohort");
  same([exhausted.selection.fullCohortExhausted, exhausted.selection.fullCohortUnavailable], [true, true], "quota and unavailability proofs");
  const invalid = { ...routing.slots[1], invalid_credential_version: identities[1].credentialVersion };
  const mixed = present(codex.selectCodex(snapshotOf(stateOf([blockedSlot(0), invalid]), active), fixtureNow, "gpt-test"), "mixed cohort");
  if (mixed.selection.kind !== "quota_blocked") throw new Error("Codex conformance expected mixed quota cohort");
  same([mixed.selection.fullCohortExhausted, mixed.selection.fullCohortUnavailable], [false, true], "invalid credential never authorizes quota reset");
  const held = {
    ...routing.slots[0],
    probe_lease: { token: "held", expires_at_ms: fixtureNow + 30_000, generation: 0, circuit: "quota" as const, quota_class: "standard" as const },
  };
  const leaseBlocked = present(codex.selectCodex(snapshotOf(stateOf([held, routing.slots[1]]), active), fixtureNow, "gpt-test"), "held recovery lease");
  same([leaseBlocked.selection.kind, leaseBlocked.writes.active], ["routing_unavailable", null], "lease cannot elect sibling or open paid fallback");
  const unavailableSnapshot = snapshotOf(routing, active);
  const unavailable = present(
    codex.selectCodex(
      {
        ...unavailableSnapshot,
        accountPolicies: new Map(
          identities.map((identity) => [identity.accountIdHash, { modelUnavailable: { detail: "synthetic entitlement" }, overageUsageAllowed: false }])
        ),
      },
      fixtureNow,
      "gpt-test"
    ),
    "model entitlement"
  );
  same(unavailable.selection.kind, "model_unavailable", "model refusal is separate from quota");
  same(codex.selectCodex({ ...snapshotOf(), active: { v: 1, generation: "malformed" } }, fixtureNow, "gpt-test"), null, "malformed A refuses");
  same(codex.selectCodex({ ...snapshotOf(), routing: { v: 2, slots: "malformed" } }, fixtureNow, "gpt-test"), null, "malformed R refuses");
  same(codex.selectCodex({ ...snapshotOf(), revisions: { ...hot.checks, pool: null } }, fixtureNow, "gpt-test"), null, "missing opaque pool revision refuses");
  same(
    JSON.stringify(bootstrap).includes("access_token") || JSON.stringify(bootstrap).includes("refresh_token") || JSON.stringify(bootstrap).includes('"auth"'),
    false,
    "pure DTOs carry no credentials"
  );
  return { bootstrap, hot, changedCapacity, reduced, reordered, refreshed, advance, exhausted, mixed, leaseBlocked, unavailable };
};
const probeVectors = () => {
  const bootstrap = present(codex.selectCodex(snapshotOf(), fixtureNow, "gpt-test"), "probe bootstrap");
  const account = { ...eligibleAccount(bootstrap), probeRequired: true, probeCircuit: "quota" as const };
  const expired = stateOf([blockedSlot(0, fixtureNow - 1), neutralState().slots[1]]);
  const claim = present(mutations.buildExpiredProbeClaim(expired, account, fixtureNow, "probe-one", fixtureNow + 17), "expired claim");
  same(
    [claim.lease.expires_at_ms, claim.lease.generation, claim.next.updated_at_ms],
    [fixtureNow + 30_000, 3, fixtureNow + 17],
    "lease timing and separate mutation clock"
  );
  same(mutations.buildExpiredProbeClaim(claim.next, account, fixtureNow + 29_999, "competing", fixtureNow), null, "live lease refuses competing claim");
  const reclaimed = present(
    mutations.buildExpiredProbeClaim(claim.next, account, fixtureNow + 30_000, "probe-two", fixtureNow + 30_001),
    "lease boundary reclaim"
  );
  same(reclaimed.lease.token, "probe-two", "lease expires at exact deadline");
  const claimedAccount = { ...account, probeRequired: false, probeGeneration: claim.lease.generation, probeToken: claim.lease.token };
  same(mutations.markCodexSuccess(claim.next, { ...claimedAccount, probeToken: "late-other" }, fixtureNow + 20), null, "stale probe cannot clear circuit");
  const success = present(mutations.markCodexSuccess(claim.next, claimedAccount, fixtureNow + 21), "probe success");
  same(
    [success.slots[0].quota_blocked_until_ms, success.slots[0].probe_lease, success.slots[0].banked_reset_generation_ambiguous],
    [null, null, false],
    "successful matching probe clears recovery scope"
  );
  const rotated = present(
    mutations.reconcileRoutingCredential(claim.next, claimedAccount, { ...identities[0], credentialVersion: "e".repeat(64) }, true, fixtureNow + 22),
    "credential rotation"
  );
  same(
    [rotated.slots[0].generation, rotated.slots[0].probe_lease?.generation, rotated.slots[0].probe_lease?.token],
    [4, 4, "probe-one"],
    "same-account refresh transfers exact lease"
  );
  same(mutations.markCodexCredentialInvalid(rotated, claimedAccount, fixtureNow, fixtureNow), null, "old credential completion cannot invalidate replacement");
  const fenced = stateOf([blockedSlot(0), neutralState().slots[1]]);
  const fencedAccount = { ...account, routingGeneration: 3 };
  same(mutations.isCodexQuotaBlockFenceCurrent(fenced, fencedAccount, fixtureNow + 60_000, 3), true, "stable exact reset fence");
  same(mutations.isCodexQuotaBlockFenceCurrent(fenced, fencedAccount, fixtureNow + 59_999, 3), false, "shorter later deadline cannot authorize reset");
  const recoveryLease = { token: "recovery", expires_at_ms: fixtureNow + 30_000, generation: 4, circuit: "quota" as const, quota_class: "standard" as const };
  const recovery = mutations.recoveryProbeTransition(fenced, fencedAccount, recoveryLease, fixtureNow + 23);
  same(
    [
      recovery.slots[0].quota_blocked_until_ms,
      recovery.slots[0].observed_reset_at_ms,
      recovery.slots[0].banked_reset_generation_ambiguous,
      recovery.slots[0].banked_reset_recovery_probe_pending,
    ],
    [null, fixtureNow + 60_000, true, true],
    "verified reset stays lookup-only until successful recovery"
  );
  const rechecked = mutations.recheckSlotTransition(blockedSlot(0), fixtureNow + 24);
  same(
    [rechecked.generation, rechecked.banked_reset_generation_ambiguous, rechecked.observed_reset_at_ms],
    [4, true, fixtureNow + 60_000],
    "admin recheck preserves ambiguous reset identity"
  );
  const timeout = present(mutations.markCodexUpstreamTimeout(neutralState(), account, fixtureNow, fixtureNow + 25), "legacy timeout transition");
  same(timeout.slots[0].upstream_timeout_blocked_until_ms, fixtureNow + 60_000, "legacy timeout duration");
  const normalized = capacity.normalizeRoutingState(timeout, identities, fixtureNow + 26, true);
  same([normalized.slots[0].upstream_timeout_blocked_until_ms, normalized.slots[0].generation], [null, 2], "normalization discards legacy timeout fences");
  return { claim, reclaimed, success, rotated, recovery, rechecked, timeout, normalized };
};
const capacityVectors = () => {
  const observation: CodexCapacityRoutingObservation = {
    slot: 0,
    account_id_hash: identities[0].accountIdHash,
    state: "available",
    source_observed_at_ms: fixtureNow,
    snapshot_at_ms: fixtureNow + 1,
    windows: { primary: { limit_window_seconds: 3600, used_percent: 10, reset_at_ms: fixtureNow + 60_000 }, secondary: null },
    additional_rate_limits: [
      {
        limit_name: "gpt-5.3-codex-spark",
        metered_feature: null,
        windows: { primary: { limit_window_seconds: 3600, used_percent: 100, reset_at_ms: fixtureNow + 60_000 }, secondary: null },
      },
    ],
  };
  const base = stateOf([blockedSlot(0), neutralState().slots[1]]);
  const cleared = present(capacity.applyCapacityObservation(base, observation, fixtureNow + 2, "gpt-test", fixtureNow + 31), "positive capacity");
  same([cleared.slots[0].quota_blocked_until_ms, cleared.updated_at_ms], [null, fixtureNow + 31], "fresh positive class capacity uses injected write clock");
  const older = { ...observation, snapshot_at_ms: fixtureNow - 1 };
  const retained = present(capacity.applyCapacityObservation(base, older, fixtureNow + 2, "gpt-test", fixtureNow + 32), "older positive sample");
  same(retained.slots[0].quota_blocked_until_ms, fixtureNow + 60_000, "newer inference quota remains authoritative");
  same(capacity.capacityHeadroomForObservation(observation, "gpt-5.3-codex-spark"), 0, "requested model class uses its own capacity");
  same(
    capacity.applyCapacityObservation(base, { ...observation, account_id_hash: identities[1].accountIdHash }, fixtureNow + 2, "gpt-test", fixtureNow),
    null,
    "wrong account observation refuses"
  );
  same(
    capacity.applyCapacityObservation(base, { ...observation, snapshot_at_ms: fixtureNow + 3 }, fixtureNow + 2, "gpt-test", fixtureNow),
    null,
    "future observation refuses"
  );
  const pending = { ...base.slots[0], banked_reset_generation_ambiguous: true, banked_reset_recovery_probe_pending: true };
  const pendingObserved = present(
    capacity.applyCapacityObservation(stateOf([pending, base.slots[1]]), observation, fixtureNow + 2, "gpt-test", fixtureNow + 33),
    "pending reset capacity"
  );
  same(
    [pendingObserved.slots[0].banked_reset_generation_ambiguous, pendingObserved.slots[0].observed_reset_at_ms],
    [true, fixtureNow + 60_000],
    "capacity cannot clear pending reset safety"
  );
  const old = { ...observation, account_id_hash: "f".repeat(64), snapshot_at_ms: fixtureNow - contracts.CODEX_CAPACITY_ROUTING_MAX_AGE_MS - 1 };
  const atBoundary = { ...observation, account_id_hash: identities[1].accountIdHash, snapshot_at_ms: fixtureNow - contracts.CODEX_CAPACITY_ROUTING_MAX_AGE_MS };
  const store = capacity.planCapacityObservationStore("C/opaque:19", [old, atBoundary], [{ ...observation, snapshot_at_ms: fixtureNow }], fixtureNow);
  same(
    [
      store.checks.capacity,
      store.writes.capacity.observations.length,
      store.writes.capacity.observations.some((row) => row.account_id_hash === old.account_id_hash),
    ],
    ["C/opaque:19", 2, false],
    "absolute observation retention boundary"
  );
  const parser = contracts.parseCodexAccountRoutingState(base);
  same(parser?.slots.length, 2, "routing codec preserves full pool");
  same(contracts.parseCodexActiveAccountSelection({ v: 1, account_id_hash: "not-an-opaque-hash" }), null, "active codec refuses malformed identity");
  return { cleared, retained, pendingObserved, store, parser };
};
export const runCodexConformanceVectors = () => ({ serial: serialVectors(), probes: probeVectors(), capacity: capacityVectors() });
// END SHARED_CODEX_VECTORS

test("native Codex pure boundaries preserve serial fences, probe leases, reset safety and capacity provenance", () => {
  const vectors = runCodexConformanceVectors();
  assert.equal(vectors.serial.hot.writes.active, null);
  assert.equal(vectors.serial.reduced.writes.active?.slot, 1);
  assert.equal(vectors.probes.claim.lease.expires_at_ms, fixtureNow + 30_000);
  assert.equal(vectors.capacity.store.writes.capacity.observations.length, 2);
});
