import { test } from "bun:test";
import { type AtomicOperation, type Kv, type KvEntry, type KvEntryMaybe, type KvKey, type KvListIterator } from "#kv";
import assert from "node:assert/strict";

import {
  claimTransaction,
  durableReceiptId,
  loadLiveSubmissionConfig,
  makeResetContext,
  matchesContext,
  prepareSubmission,
  quotaWindowIsOpen,
  readClock,
  readCurrentFences,
  readExistingRecord,
  receiptId,
  rejectOwned,
  renewSubmittedForRedeem,
  selectInventoryCredit,
  stateWith,
  validRedeemResult,
} from "../src/codex/banked-reset-claim.ts";
import { evaluateCodexBankedResetPool, listCodexResetShadowDecisions } from "../src/codex/banked-reset-pool.ts";
import { attemptCodexBankedReset, reconcileCodexBankedReset } from "../src/codex/banked-reset-submission.ts";
import {
  candidate,
  codexResetAccountDailyKey,
  Deferred,
  fullPool,
  codexResetRedemptionKey,
  codexResetUsageKey,
  clone,
  CODEX_BANKED_RESET_LEASE_MS,
  config,
  dependencies,
  FakeCodexUsageResetProvider,
  inventory,
  MemoryKv,
  provenContract,
  routingFenceKey,
  seedFences,
  testHash,
  TestClock,
} from "./helpers/codex-banked-reset-harness.ts";
import { MAX_CAS_ATTEMPTS, type CodexBankedResetCandidate } from "../src/codex/banked-reset.ts";
import type { CodexResetRedemptionRecord } from "../src/types.ts";

/** A clock whose readings are scripted, so a mid-transaction reading can change. */
const scriptedClock = (readings: readonly (number | undefined)[]): (() => number) => {
  let index = 0;
  return () => {
    const value = readings[Math.min(index, readings.length - 1)];
    index += 1;
    return value ?? 0;
  };
};

/** MemoryKv with targeted read failures and a commit that can reject outright. */
class FailKeyKv extends MemoryKv {
  readonly failGetKeys: string[] = [];
  commitThrows = false;
  listEntries: KvEntry<unknown>[] = [];
  listThrows = false;

  override get<T>(key: KvKey, options?: unknown): Promise<KvEntryMaybe<T>> {
    if (this.failGetKeys.some((encoded) => encoded === JSON.stringify(key))) return Promise.reject(new Error("kv read unavailable"));
    return super.get<T>(key, options);
  }

  override atomic(): AtomicOperation {
    if (!this.commitThrows) return super.atomic();
    const failing = {
      check: () => failing,
      set: () => failing,
      delete: () => failing,
      commit: () => Promise.reject(new Error("kv commit unavailable")),
    };
    return failing as unknown as AtomicOperation;
  }

  list(): KvListIterator<unknown> {
    if (this.listThrows) throw new Error("kv list unavailable");
    const entries = this.listEntries;
    let index = 0;
    const iterator = {
      next: (): Promise<IteratorResult<KvEntry<unknown>>> =>
        Promise.resolve(index < entries.length ? { value: entries[index++], done: false } : { value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator as unknown as KvListIterator<unknown>;
  }
}

/** Fails the next `count` atomic commits, whatever their number. */
const failNextCommits = (kv: MemoryKv, count: number): void => {
  const base = kv.atomicCommitCount;
  for (let index = 1; index <= count; index += 1) kv.failCommitNumbers.add(base + index);
};

/** Narrows a discriminated result the test has already asserted on. */
const requireKind = <TValue extends { kind: string }, TKind extends TValue["kind"]>(
  value: TValue,
  kind: TKind,
  label: string
): Extract<TValue, { kind: TKind }> => {
  assert.equal(value.kind, kind, label);
  return value as Extract<TValue, { kind: TKind }>;
};

const contextOf = async (input: CodexBankedResetCandidate) => {
  const context = await makeResetContext(input, testHash);
  assert.ok(context, "the fixture candidate must produce a reset context");
  return context;
};

/* ---------------------------------------------------------------- claim core */

test("makeResetContext refuses an unusable candidate and an unusable hash", async () => {
  const usable = candidate();
  assert.equal(await makeResetContext({ ...usable, accountId: "" }, testHash), null);
  assert.equal(await makeResetContext({ ...usable, credentialVersion: "" }, testHash), null);
  assert.equal(await makeResetContext({ ...usable, quotaResetAtMs: -1 }, testHash), null);
  assert.equal(await makeResetContext({ ...usable, quotaResetAtMs: Number.NaN }, testHash), null);
  assert.equal(await makeResetContext({ ...usable, routingGeneration: 1.5 }, testHash), null);
  assert.equal(await makeResetContext({ ...usable, routingGeneration: -1 }, testHash), null);
  assert.equal(await makeResetContext(usable, () => Promise.resolve("")), null, "a hash that cannot produce a key is refused");
  assert.equal(await makeResetContext({ ...usable, routingGeneration: Number.NaN }, testHash), null);
  assert.equal(
    await makeResetContext(usable, () => Promise.reject(new Error("hash unavailable"))),
    null,
    "an unavailable hash is reported as an unusable context"
  );
  assert.equal(await makeResetContext(usable, () => Promise.resolve("")), null);

  const context = await contextOf(usable);
  assert.match(context.account.credentialVersion, /^v1:/);
  assert.match(context.account.quotaGeneration, /^v1:/);
  assert.match(context.idempotencyKey, /^uos_ai_codex_reset_v1_/);
  assert.equal(context.account.accountId, usable.accountId);
  const record = createRecord(context, usable);
  assert.equal(matchesContext(record, context), true);
  assert.equal(matchesContext({ ...record, idempotency_key_hash: "other" }, context), false);
  assert.equal(matchesContext({ ...record, credential_version: "v1:other" }, context), false);
});

const createRecord = (
  context: Awaited<ReturnType<typeof makeResetContext>> & object,
  input: CodexBankedResetCandidate,
  state: CodexResetRedemptionRecord["state"] = "claimed",
  nowMs = 1_700_000_000_000
): CodexResetRedemptionRecord => ({
  v: 1,
  account_id_hash: context.account.accountIdHash,
  credential_version: context.account.credentialVersion,
  quota_generation: context.account.quotaGeneration,
  routing_generation: input.routingGeneration,
  idempotency_key_hash: context.idempotencyKeyHash,
  state,
  owner_token: "owner-1",
  fence: 1,
  lease_expires_at_ms: nowMs - 1,
  provider_receipt_id: null,
  created_at_ms: nowMs - 1_000,
  updated_at_ms: nowMs,
  submitted_at_ms: state === "claimed" ? null : nowMs,
  verified_at_ms: null,
  last_error_code: null,
});

test("readClock rejects unsafe readings and a clock that throws", () => {
  assert.equal(
    readClock(() => 1_700_000_000_000),
    1_700_000_000_000
  );
  assert.equal(
    readClock(() => Number.NaN),
    null
  );
  assert.equal(
    readClock(() => -1),
    null
  );
  assert.equal(
    readClock(() => {
      throw new Error("clock unavailable");
    }),
    null,
    "an unavailable clock is reported as an unreadable reading"
  );
});

test("readCurrentFences refuses a candidate without usable fences and treats an exploding predicate as stale", async () => {
  const kv = new MemoryKv();
  const input = candidate();
  await seedFences(kv, input);

  const missing = await readCurrentFences(kv as unknown as Kv, { ...input, fences: [] });
  assert.deepEqual(missing, { kind: "failure", code: "routing_fence_missing" });
  const malformed = await readCurrentFences(kv as unknown as Kv, { ...input, fences: [{ key: routingFenceKey(input.accountId), isCurrent: 5 }] as never });
  assert.deepEqual(malformed, { kind: "failure", code: "routing_fence_missing" });

  const exploding = await readCurrentFences(kv as unknown as Kv, {
    ...input,
    fences: [
      {
        key: routingFenceKey(input.accountId),
        isCurrent: () => {
          throw new Error("fence predicate unavailable");
        },
      },
    ],
  });
  assert.deepEqual(exploding, { kind: "stale" }, "an unreadable predicate proves nothing about the fence");

  const valid = requireKind(await readCurrentFences(kv as unknown as Kv, input), "valid", "the fixture must be a valid decision");
  assert.equal(valid.entries.length, 2);

  const failing = new FailKeyKv();
  failing.failGetKeys.push(JSON.stringify(routingFenceKey(input.accountId)));
  const unreadable = await readCurrentFences(failing as unknown as Kv, input);
  assert.deepEqual(unreadable, { kind: "failure", code: "kv_unavailable" });
});

test("claimTransaction refuses a quota window that expired after the fence reads", async () => {
  const kv = new MemoryKv();
  const clock = new TestClock();
  const input = candidate();
  await seedFences(kv, input);
  const context = await contextOf(input);

  const closedClock = scriptedClock([input.quotaResetAtMs]);
  const claimed = await claimTransaction(kv as unknown as Kv, context, input, input.quotaResetAtMs - 1_000, closedClock, "owner-1", true);
  assert.deepEqual(claimed, { kind: "failure", code: "quota_window_expired" }, "the window is rechecked after the asynchronous fence reads");
  assert.equal(kv.entries.size, 2, "an expired window writes nothing but its fences");
  assert.equal(clock.nowMs, 1_700_000_000_000);
});

test("claimTransaction reports an unusable KV and an exhausted compare-and-set", async () => {
  const input = candidate();
  const context = await contextOf(input);
  const clock = new TestClock();

  const unreadable = new FailKeyKv();
  await seedFences(unreadable, input);
  unreadable.failGetKeys.push(JSON.stringify(routingFenceKey(input.accountId)));
  const unavailable = await claimTransaction(unreadable as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true);
  assert.deepEqual(unavailable, { kind: "failure", code: "kv_unavailable" }, "an unreadable fence read is reported, never retried blindly");

  const contending = new MemoryKv();
  await seedFences(contending, input);
  failNextCommits(contending, MAX_CAS_ATTEMPTS);
  const exhausted = await claimTransaction(contending as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true);
  assert.deepEqual(exhausted, { kind: "failure", code: "kv_cas_exhausted" });

  const claimThrows = new FailKeyKv();
  await seedFences(claimThrows, input);
  claimThrows.commitThrows = true;
  const claimUnavailable = await claimTransaction(claimThrows as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true);
  assert.deepEqual(claimUnavailable, { kind: "failure", code: "kv_unavailable" });
});

test("a takeover of an expired claim is fenced on the routing generation and survives a lost race", async () => {
  const kv = new MemoryKv();
  const clock = new TestClock();
  const input = candidate();
  await seedFences(kv, input);
  const context = await contextOf(input);
  const claimed = await claimTransaction(kv as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true);
  assert.equal(claimed.kind, "submit");
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);

  const staleGeneration = await claimTransaction(
    kv as unknown as Kv,
    context,
    { ...input, routingGeneration: input.routingGeneration + 1 },
    clock.nowMs,
    () => clock.nowMs,
    "owner-2",
    true
  );
  assert.deepEqual(staleGeneration, { kind: "failure", code: "routing_fence_stale" }, "a claimed record cannot be taken over across a routing generation");

  const contended = new MemoryKv();
  await seedFences(contended, input);
  const claimedThere = await claimTransaction(
    contended as unknown as Kv,
    context,
    input,
    clock.nowMs - CODEX_BANKED_RESET_LEASE_MS - 1,
    () => clock.nowMs - CODEX_BANKED_RESET_LEASE_MS - 1,
    "owner-1",
    true
  );
  assert.equal(claimedThere.kind, "submit");
  failNextCommits(contended, MAX_CAS_ATTEMPTS);
  const lostRace = await claimTransaction(contended as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-2", true);
  assert.deepEqual(lostRace, { kind: "failure", code: "kv_cas_exhausted" });

  const exhaustedPermit = await claimTransaction(kv as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-2", false);
  assert.equal(exhaustedPermit.kind, "in_progress", "an expired claim without a new-submission permit is never taken over");

  const throwing = new FailKeyKv();
  await seedFences(throwing, input);
  const firstClock = new TestClock();
  const claimedThrow = await claimTransaction(throwing as unknown as Kv, context, input, firstClock.nowMs, () => firstClock.nowMs, "owner-1", true);
  assert.equal(claimedThrow.kind, "submit");
  firstClock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  throwing.commitThrows = true;
  const takeoverUnavailable = await claimTransaction(throwing as unknown as Kv, context, input, firstClock.nowMs, () => firstClock.nowMs, "owner-2", true);
  assert.deepEqual(takeoverUnavailable, { kind: "failure", code: "kv_unavailable" });
});

test("claimTransaction reconciles an expired submitted record without a new submission permit", async () => {
  const kv = new MemoryKv();
  const clock = new TestClock();
  const input = candidate();
  await seedFences(kv, input);
  const context = await contextOf(input);
  const claimed = requireKind(
    await claimTransaction(kv as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  await kv.set(
    codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration),
    stateWith(claimed.record, "submitted", clock.nowMs, { submitted_at_ms: clock.nowMs })
  );
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);

  const reconciled = requireKind(
    await claimTransaction(kv as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-2", false),
    "reconcile",
    "an expired submitted record is taken over for reconciliation"
  );
  assert.equal(reconciled.tookOver, true);
  assert.equal(reconciled.record.owner_token, "owner-2");
  assert.equal(reconciled.record.fence, 2);
});

test("updateOwnedRecord writes only for the exact owner and fence", async () => {
  const kv = new MemoryKv();
  const clock = new TestClock();
  const input = candidate();
  await seedFences(kv, input);
  const context = await contextOf(input);
  const claimed = requireKind(
    await claimTransaction(kv as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );

  const foreign = await rejectOwned(kv as unknown as Kv, context, { ...claimed.record, owner_token: "someone-else" }, clock.nowMs, "not_ours");
  assert.equal(foreign, null, "another owner's record is never mutated");
  const replaced = await rejectOwned(kv as unknown as Kv, context, { ...claimed.record, fence: claimed.record.fence + 1 }, clock.nowMs, "fence_mismatch");
  assert.equal(replaced, null, "a newer fence means this worker no longer owns the record");
  const rejected = await rejectOwned(kv as unknown as Kv, context, claimed.record, clock.nowMs, "provider_rejected");
  assert.ok(rejected);
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.last_error_code, "provider_rejected");

  const throwing = new FailKeyKv();
  await seedFences(throwing, input);
  const claimedThere = requireKind(
    await claimTransaction(throwing as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  throwing.commitThrows = true;
  assert.equal(await rejectOwned(throwing as unknown as Kv, context, claimedThere.record, clock.nowMs, "unavailable"), null);
  const failingReads = new FailKeyKv();
  await seedFences(failingReads, input);
  failingReads.failGetKeys.push(JSON.stringify(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration)));
  assert.equal(await rejectOwned(failingReads as unknown as Kv, context, claimedThere.record, clock.nowMs, "unreadable"), null);
});

test("prepareSubmission refuses a claim that lost its lease, an unreadable budget and an exhausted compare-and-set", async () => {
  const input = candidate();
  const context = await contextOf(input);

  const clock = new TestClock();
  const kv = new MemoryKv();
  await seedFences(kv, input);
  const claimed = requireKind(
    await claimTransaction(kv as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  const stale = await prepareSubmission(kv as unknown as Kv, context, input, claimed.record, clock.nowMs, () => clock.nowMs, 5);
  assert.deepEqual(stale, { kind: "failure", code: "stale_owner" }, "an expired lease never crosses the submission boundary");

  const fresh = new TestClock();
  const budgetKv = new FailKeyKv();
  await seedFences(budgetKv, input);
  const budgetClaim = requireKind(
    await claimTransaction(budgetKv as unknown as Kv, context, input, fresh.nowMs, () => fresh.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  budgetKv.failGetKeys.push(JSON.stringify(codexResetAccountDailyKey(context.account.accountIdHash, "2023-11-14")));
  const unreadableBudget = await prepareSubmission(budgetKv as unknown as Kv, context, input, budgetClaim.record, fresh.nowMs, () => fresh.nowMs, 5);
  assert.deepEqual(unreadableBudget, { kind: "failure", code: "kv_unavailable" });

  const commitClock = new TestClock();
  const commitKv = new FailKeyKv();
  await seedFences(commitKv, input);
  const commitClaim = requireKind(
    await claimTransaction(commitKv as unknown as Kv, context, input, commitClock.nowMs, () => commitClock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  commitKv.commitThrows = true;
  const unavailableCommit = await prepareSubmission(
    commitKv as unknown as Kv,
    context,
    input,
    commitClaim.record,
    commitClock.nowMs,
    () => commitClock.nowMs,
    5
  );
  assert.deepEqual(unavailableCommit, { kind: "failure", code: "kv_unavailable" });

  const contendedClock = new TestClock();
  const contended = new MemoryKv();
  await seedFences(contended, input);
  const contendedClaim = requireKind(
    await claimTransaction(contended as unknown as Kv, context, input, contendedClock.nowMs, () => contendedClock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  failNextCommits(contended, MAX_CAS_ATTEMPTS);
  const exhausted = await prepareSubmission(
    contended as unknown as Kv,
    context,
    input,
    contendedClaim.record,
    contendedClock.nowMs,
    () => contendedClock.nowMs,
    5
  );
  assert.deepEqual(exhausted, { kind: "failure", code: "kv_cas_exhausted" });

  const happy = new MemoryKv();
  await seedFences(happy, input);
  const happyClock = new TestClock();
  const happyClaim = requireKind(
    await claimTransaction(happy as unknown as Kv, context, input, happyClock.nowMs, () => happyClock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  const prepared = requireKind(
    await prepareSubmission(happy as unknown as Kv, context, input, happyClaim.record, happyClock.nowMs, () => happyClock.nowMs, 5),
    "submitted",
    "the submission boundary must be crossed"
  );
  assert.equal(prepared.record.state, "submitted");
  const daily = happy.entries.get(JSON.stringify(codexResetAccountDailyKey(context.account.accountIdHash, "2023-11-14")))?.value as
    { submission_count: number } | undefined;
  assert.equal(daily?.submission_count, 1, "the daily budget is consumed exactly once at the boundary");
});

test("renewSubmittedForRedeem requires an owned submitted lease and reports a broken binding", async () => {
  const input = candidate();
  const context = await contextOf(input);
  const clock = new TestClock();
  const kv = new MemoryKv();
  await seedFences(kv, input);
  const claimed = requireKind(
    await claimTransaction(kv as unknown as Kv, context, input, clock.nowMs, () => clock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  const prepared = requireKind(
    await prepareSubmission(kv as unknown as Kv, context, input, claimed.record, clock.nowMs, () => clock.nowMs, 5),
    "submitted",
    "expected a submitted record"
  );

  const renewed = await renewSubmittedForRedeem(kv as unknown as Kv, context, input, prepared.record, () => clock.nowMs);
  if (renewed.kind !== "renewed") throw new Error("expected the lease to be renewed");
  assert.equal(renewed.record.fence, prepared.record.fence + 1);
  assert.equal(renewed.record.owner_token, prepared.record.owner_token);

  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  const stale = await renewSubmittedForRedeem(kv as unknown as Kv, context, input, renewed.record, () => clock.nowMs);
  assert.deepEqual(stale, { kind: "failure", code: "stale_owner" });

  const throwing = new FailKeyKv();
  const throwingClock = new TestClock();
  await seedFences(throwing, input);
  const throwingClaim = requireKind(
    await claimTransaction(throwing as unknown as Kv, context, input, throwingClock.nowMs, () => throwingClock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  const throwingPrepared = await prepareSubmission(
    throwing as unknown as Kv,
    context,
    input,
    throwingClaim.record,
    throwingClock.nowMs,
    () => throwingClock.nowMs,
    5
  );
  if (throwingPrepared.kind !== "submitted") throw new Error("expected a submitted record");
  throwing.commitThrows = true;
  assert.deepEqual(await renewSubmittedForRedeem(throwing as unknown as Kv, context, input, throwingPrepared.record, () => throwingClock.nowMs), {
    kind: "failure",
    code: "kv_unavailable",
  });

  const contended = new MemoryKv();
  const contendedClock = new TestClock();
  await seedFences(contended, input);
  const contendedClaim = requireKind(
    await claimTransaction(contended as unknown as Kv, context, input, contendedClock.nowMs, () => contendedClock.nowMs, "owner-1", true),
    "submit",
    "the fixture must be a submit decision"
  );
  const contendedPrepared = await prepareSubmission(
    contended as unknown as Kv,
    context,
    input,
    contendedClaim.record,
    contendedClock.nowMs,
    () => contendedClock.nowMs,
    5
  );
  if (contendedPrepared.kind !== "submitted") throw new Error("expected a submitted record");
  failNextCommits(contended, MAX_CAS_ATTEMPTS);
  assert.deepEqual(await renewSubmittedForRedeem(contended as unknown as Kv, context, input, contendedPrepared.record, () => contendedClock.nowMs), {
    kind: "failure",
    code: "kv_cas_exhausted",
  });
});

test("credit selection ranks finite expiry first and refuses unusable inventories", () => {
  const provider = new FakeCodexUsageResetProvider();
  const nowMs = 1_700_000_000_000;
  const expired = inventory("expired", nowMs - 1_000);
  assert.deepEqual(selectInventoryCredit({ ...expired, availableCount: 0, credits: [] }, provider, nowMs), { kind: "empty" });
  assert.deepEqual(
    selectInventoryCredit(
      { availableCount: 1, observedAtMs: nowMs, credits: [{ id: "wrong-type", status: "available", resetType: "other", expiresAtMs: null }] },
      provider,
      nowMs
    ),
    { kind: "no_eligible_credit" }
  );
  assert.deepEqual(
    selectInventoryCredit(expired, provider, nowMs),
    { kind: "no_eligible_credit" },
    "an available credit that already expired is not selectable"
  );

  const later = inventory("later", nowMs + 60_000);
  const earlier = inventory("earlier", nowMs + 30_000);
  const twoCredits = {
    availableCount: 2,
    observedAtMs: nowMs,
    credits: [...later.credits.map((credit) => ({ ...credit, status: "available" })), ...earlier.credits.map((credit) => ({ ...credit, status: "available" }))],
  };
  const finite = requireKind(selectInventoryCredit(twoCredits, provider, nowMs), "selected", "the fixture must be a selected decision");
  assert.equal(finite.credit.id, "earlier", "the soonest finite expiry wins");

  const sameExpiryA = { ...earlier.credits[0], id: "zzz" };
  const sameExpiryB = { ...earlier.credits[0], id: "aaa" };
  const tie = requireKind(
    selectInventoryCredit(
      { availableCount: 2, observedAtMs: nowMs, credits: [sameExpiryA, sameExpiryB].map((credit) => ({ ...credit, status: "available" })) },
      provider,
      nowMs
    ),
    "selected",
    "the fixture must be a selected decision"
  );
  assert.equal(tie.credit.id, "aaa", "an expiry tie is broken by the opaque credit id");

  const neverExpires = requireKind(
    selectInventoryCredit(
      {
        availableCount: 2,
        observedAtMs: nowMs,
        credits: [
          { id: "forever", status: "available", resetType: "codex_rate_limits", expiresAtMs: null },
          ...earlier.credits.map((credit) => ({ ...credit, status: "available" })),
        ],
      },
      provider,
      nowMs
    ),
    "selected",
    "the fixture must be a selected decision"
  );
  assert.equal(neverExpires.credit.id, "earlier", "a finite expiry beats a credit that never expires");
});

test("redeem-result and receipt validation reject unusable provider output", () => {
  assert.equal(validRedeemResult("completed"), false, "a non-object result is never trusted");
  assert.equal(validRedeemResult({ kind: "completed" }), false, "a terminal result without a receipt is unusable");
  assert.equal(validRedeemResult({ kind: "accepted", providerReceiptId: 7 }), false);
  assert.equal(validRedeemResult({ kind: "rejected" }), false, "a rejection without a reason is unusable");
  assert.equal(validRedeemResult({ kind: "rejected", reason: "definitive" }), true);
  assert.equal(validRedeemResult({ kind: "unknown", providerReceiptId: null }), true);
  assert.equal(validRedeemResult({ kind: "unknown", providerReceiptId: "receipt" }), true);
  assert.equal(validRedeemResult({ kind: "future_kind", providerReceiptId: "receipt" }), false, "an unknown result kind is schema drift");
  assert.equal(receiptId("receipt-1"), "receipt-1");
  assert.equal(receiptId("x".repeat(513)), null, "an over-long receipt id is refused");
  assert.equal(receiptId("   "), "   ", "any bounded opaque text is accepted verbatim");
  assert.equal(receiptId(7), null);
  const unsafeProvider = new FakeCodexUsageResetProvider({ ...provenContract(), receiptIdsSafeToPersistAndLog: false });
  assert.equal(durableReceiptId(unsafeProvider, "receipt-1"), null, "an unapproved receipt id stays out of the durable record");
  assert.equal(durableReceiptId(new FakeCodexUsageResetProvider(), "receipt-1"), "receipt-1");
});

test("loadLiveSubmissionConfig names every reason a live submission is closed", () => {
  const kv = new MemoryKv();
  const clock = new TestClock();
  const provider = new FakeCodexUsageResetProvider();
  const live = dependencies(kv, provider, clock);
  assert.deepEqual(loadLiveSubmissionConfig(live).reason, null);

  assert.equal(loadLiveSubmissionConfig({ ...live, config: config({ enabled: false }) }).reason, "feature_disabled");
  assert.equal(loadLiveSubmissionConfig({ ...live, config: config({ mode: "disabled" }) }).reason, "mode_disabled");
  assert.equal(loadLiveSubmissionConfig({ ...live, config: config({ maxPerAccountPerDay: 0 }) }).reason, "per_account_day_limit_invalid");
  assert.equal(loadLiveSubmissionConfig({ ...live, config: config({ maxPerAccountPerWindow: 2 }) }).reason, "per_account_window_limit_invalid");
  assert.equal(loadLiveSubmissionConfig({ ...live, config: config({ mode: "shadow" }) }).reason, "mode_not_live");
  const exploding = dependencies(kv, provider, clock, config(), {}, () => {
    throw new Error("configuration unavailable");
  });
  assert.equal(loadLiveSubmissionConfig(exploding).reason, "configuration_unavailable");
});

test("readExistingRecord distinguishes an absent, a corrupt and an unreadable record", async () => {
  const kv = new FailKeyKv();
  const input = candidate();
  const context = await contextOf(input);
  const key = codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration);

  assert.deepEqual(await readExistingRecord(kv as unknown as Kv, context), { record: null, code: null });
  await kv.set(key, { v: 1, state: "claimed" });
  assert.deepEqual(await readExistingRecord(kv as unknown as Kv, context), { record: null, code: "redemption_record_invalid" });
  const valid = { ...createRecord(context, input) };
  await kv.set(key, valid);
  const read = await readExistingRecord(kv as unknown as Kv, context);
  assert.ok(read.record);
  assert.equal(read.code, null);
  kv.failGetKeys.push(JSON.stringify(key));
  assert.deepEqual(await readExistingRecord(kv as unknown as Kv, context), { record: null, code: "kv_unavailable" });
  assert.equal(quotaWindowIsOpen(input, input.quotaResetAtMs - 1), true);
  assert.equal(quotaWindowIsOpen(input, input.quotaResetAtMs), false);
});

test("listCodexResetShadowDecisions reports an unavailable binding and sorts usable records", async () => {
  assert.equal(await listCodexResetShadowDecisions(null), null);
  const kv = new FailKeyKv();
  assert.deepEqual(await listCodexResetShadowDecisions(kv as unknown as Kv), []);
  kv.listThrows = true;
  assert.equal(await listCodexResetShadowDecisions(kv as unknown as Kv), null, "an unreadable store is reported instead of an empty list");

  const decisions = new FailKeyKv();
  const decisionFence = (slot: number, suffix: string) => ({
    slot,
    account_id_hash: `hash-${suffix}`,
    quota_generation: `gen-${suffix}`,
    routing_generation: 7,
    quota_reset_at_ms: 1_700_000_060_000,
  });
  decisions.listEntries = [
    {
      key: ["uos_ai", "codex_reset_shadow_decision", "b"],
      value: {
        v: 1,
        episode_hash: "b",
        created_at_ms: 200,
        expires_at_ms: 1_700_000_100_000,
        decision_reason: "selected",
        selected_account_id_hash: "hash-b",
        selected_credit_id_hash: "credit-b",
        selected_credit_expires_at_ms: null,
        fences: [decisionFence(1, "b")],
      },
      versionstamp: "1",
    },
    { key: ["uos_ai", "codex_reset_shadow_decision", "corrupt"], value: { v: 1 }, versionstamp: "1" },
    {
      key: ["uos_ai", "codex_reset_shadow_decision", "a"],
      value: {
        v: 1,
        episode_hash: "a",
        created_at_ms: 200,
        expires_at_ms: 1_700_000_100_000,
        decision_reason: "inventory_empty",
        selected_account_id_hash: null,
        selected_credit_id_hash: null,
        selected_credit_expires_at_ms: null,
        fences: [decisionFence(0, "a")],
      },
      versionstamp: "1",
    },
  ];
  const listed = await listCodexResetShadowDecisions(decisions as unknown as Kv);
  assert.deepEqual(
    listed?.map((decision) => decision.episode_hash),
    ["a", "b"],
    "usable records are sorted by creation time then episode hash, and unparsable rows are skipped"
  );
});

/* ------------------------------------------------------- submission routing */

test("attemptCodexBankedReset reports every prerequisite it cannot satisfy", async () => {
  const input = candidate();
  const clock = new TestClock();
  const provider = new FakeCodexUsageResetProvider();
  const kv = new MemoryKv();
  await seedFences(kv, input);
  const deps = dependencies(kv, provider, clock);

  assert.equal((await attemptCodexBankedReset({ ...input, credentialVersion: "" }, deps)).reason, "invalid_quota_generation");
  assert.equal((await attemptCodexBankedReset(input, { ...deps, kv: null })).reason, "kv_unavailable");
  assert.equal((await attemptCodexBankedReset(input, { ...deps, now: () => Number.NaN })).reason, "invalid_clock");
  assert.equal((await attemptCodexBankedReset(input, { ...deps, newOwnerToken: () => "" })).reason, "owner_token_unavailable");
  assert.equal(
    (
      await attemptCodexBankedReset(input, {
        ...deps,
        reloadConfig: () => {
          throw new Error("configuration unavailable");
        },
      })
    ).reason,
    "configuration_unavailable"
  );

  const throwingAccessor = { ...deps };
  Object.defineProperty(throwingAccessor, "kv", {
    get() {
      throw new Error("kv accessor unavailable");
    },
  });
  assert.equal((await attemptCodexBankedReset(input, throwingAccessor)).reason, "kv_unavailable");

  const context = await contextOf(input);
  const corrupt = new MemoryKv();
  await seedFences(corrupt, input);
  await corrupt.set(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration), { v: 1, state: "claimed" });
  assert.equal((await attemptCodexBankedReset(input, dependencies(corrupt, provider, clock))).reason, "redemption_record_invalid");

  const foreign = new MemoryKv();
  await seedFences(foreign, input);
  await foreign.set(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration), {
    ...createRecord(context, input),
    idempotency_key_hash: "another-key-hash",
  });
  const mismatch = await attemptCodexBankedReset(input, dependencies(foreign, provider, clock));
  assert.equal(mismatch.reason, "redemption_record_context_mismatch");

  const withoutProvider = new FakeCodexUsageResetProvider({
    ...provenContract(),
    lookup: { byIdempotencyKey: false, byProviderReceiptId: false },
    verification: { independentlyVerifiable: false },
  });
  const unproven = await attemptCodexBankedReset({ ...input, accountId: "unproven-account" }, { ...deps, provider: withoutProvider });
  assert.equal(unproven.reason, "provider_contract_unproven");
  assert.equal(withoutProvider.inventoryInputs.length, 0, "an unproven provider contract is refused before any provider call");
});

test("reconcileCodexBankedReset reports both client aborts and never submits", async () => {
  const input = candidate();
  const clock = new TestClock();
  const provider = new FakeCodexUsageResetProvider();
  const kv = new MemoryKv();
  await seedFences(kv, input);
  const context = await contextOf(input);
  await kv.set(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration), createRecord(context, input, "submitted", clock.nowMs));

  const controller = new AbortController();
  controller.abort();
  const aborted = await reconcileCodexBankedReset({ ...input, signal: controller.signal }, dependencies(kv, provider, clock));
  assert.equal(aborted.reason, "client_aborted_before_reconciliation", "an aborted client never starts a recovery lookup");
  assert.equal(provider.lookupInputs.length, 0);

  const noTransaction = await reconcileCodexBankedReset(candidate({ accountId: "empty-account" }), dependencies(new MemoryKv(), provider, clock));
  assert.equal(noTransaction.reason, "no_existing_transaction", "a reconcile-only attempt never creates a claim");
});

test("recovery lookups classify unavailable, malformed and receipt-less provider answers", async () => {
  const clock = new TestClock();
  const contextInput = candidate();

  const submittedKv = async (input = contextInput): Promise<MemoryKv> => {
    const kv = new MemoryKv();
    await seedFences(kv, input);
    const context = await contextOf(input);
    await kv.set(
      codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration),
      createRecord(context, input, "submitted", clock.nowMs)
    );
    return kv;
  };

  const unavailableProvider = new FakeCodexUsageResetProvider();
  unavailableProvider.lookupFailure = new Error("lookup unavailable");
  const unavailable = await reconcileCodexBankedReset(contextInput, dependencies(await submittedKv(), unavailableProvider, clock));
  assert.equal(unavailable.reason, "lookup_unavailable");

  const malformedProvider = new FakeCodexUsageResetProvider();
  malformedProvider.lookupResult = { kind: "future_completed", providerReceiptId: "receipt" } as never;
  const malformed = await reconcileCodexBankedReset(contextInput, dependencies(await submittedKv(), malformedProvider, clock));
  assert.equal(malformed.reason, "lookup_response_invalid");

  const receiptlessProvider = new FakeCodexUsageResetProvider();
  receiptlessProvider.lookupResult = { kind: "completed" } as never;
  const receiptless = await reconcileCodexBankedReset(contextInput, dependencies(await submittedKv(), receiptlessProvider, clock));
  assert.equal(receiptless.reason, "lookup_response_invalid", "a completed lookup without a receipt is unusable");

  const negativeProvider = new FakeCodexUsageResetProvider();
  negativeProvider.lookupResult = { kind: "rejected", reason: "not found" };
  negativeProvider.verifyResult = true;
  const negative = await reconcileCodexBankedReset(contextInput, dependencies(await submittedKv(), negativeProvider, clock));
  assert.equal(negative.kind, "verified", "a negative lookup alone is resolved only by independent verification");

  const driftProvider = new FakeCodexUsageResetProvider();
  driftProvider.lookupResult = { kind: "completed", providerReceiptId: "lookup-receipt" };
  driftProvider.verifyResult = "not-a-boolean" as never;
  const drift = await reconcileCodexBankedReset(contextInput, dependencies(await submittedKv(), driftProvider, clock));
  assert.equal(drift.reason, "verification_response_invalid");

  const unappliedProvider = new FakeCodexUsageResetProvider();
  unappliedProvider.lookupResult = { kind: "completed", providerReceiptId: "lookup-receipt" };
  unappliedProvider.verifyResult = false;
  const unapplied = await reconcileCodexBankedReset(contextInput, dependencies(await submittedKv(), unappliedProvider, clock));
  assert.equal(unapplied.reason, "verification_not_applied");

  const failedVerifyProvider = new FakeCodexUsageResetProvider();
  failedVerifyProvider.lookupResult = { kind: "completed", providerReceiptId: "lookup-receipt" };
  failedVerifyProvider.verifyFailure = new Error("verification unavailable");
  const failedVerify = await reconcileCodexBankedReset(contextInput, dependencies(await submittedKv(), failedVerifyProvider, clock));
  assert.equal(failedVerify.reason, "verification_unavailable");
});

test("a recovery that cannot read its clock reports invalid_clock instead of guessing a state", async () => {
  const clock = new TestClock();
  const input = candidate();
  const provider = new FakeCodexUsageResetProvider();
  provider.lookupResult = { kind: "completed", providerReceiptId: "lookup-receipt" };
  provider.verifyResult = true;
  const kv = new MemoryKv();
  await seedFences(kv, input);
  const context = await contextOf(input);
  await kv.set(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration), createRecord(context, input, "submitted", clock.nowMs));
  const base = dependencies(kv, provider, clock);

  const outcomes: { validReads: number; kind: string; reason: string }[] = [];
  const recordKey = codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration);
  for (let validReads = 0; validReads <= 6; validReads += 1) {
    resetRecordTo(context, kv, input, clock.nowMs);
    const readings = Array.from({ length: validReads }, () => clock.nowMs);
    const outcome = await reconcileCodexBankedReset(input, { ...base, now: scriptedClock([...readings, Number.NaN]) });
    if (outcome.reason === "invalid_clock") {
      assert.ok(["pending", "skipped"].includes(outcome.kind), `an unreadable clock never settles the record (saw ${outcome.kind})`);
      assert.notEqual(kv.redemptionRecord(recordKey)?.state, "verified", `readings=${validReads}: an unreadable clock never verifies the record`);
    }
    outcomes.push({ validReads, kind: outcome.kind, reason: outcome.reason });
  }
  assert.ok(
    outcomes.some((outcome) => outcome.reason === "invalid_clock"),
    `an unreadable clock must be reported, saw ${outcomes.map((outcome) => outcome.reason).join(",")}`
  );
  assert.equal(outcomes.at(-1)?.reason, "verified", "the same fixture settles when every reading is usable");
});

const resetRecordTo = (context: Awaited<ReturnType<typeof makeResetContext>> & object, kv: MemoryKv, input: CodexBankedResetCandidate, nowMs: number): void => {
  kv.entries.set(JSON.stringify(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration)), {
    key: codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration),
    value: clone(createRecord(context, input, "submitted", nowMs)),
    versionstamp: "00000000000000000099",
  });
};

test("a submission whose provider throws synchronously or rejects leaves a durable unknown record", async () => {
  const clock = new TestClock();
  const input = candidate();
  const kv = new MemoryKv();
  await seedFences(kv, input);
  const synchronousProvider = new FakeCodexUsageResetProvider();
  synchronousProvider.redeem = () => {
    throw new Error("provider threw synchronously");
  };

  const outcome = await attemptCodexBankedReset(input, dependencies(kv, synchronousProvider, clock));
  assert.equal(outcome.kind, "pending");
  assert.equal(outcome.reason, "submit_transport_unknown");
  const context = await contextOf(input);
  const record = kv.redemptionRecord(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration));
  assert.equal(record?.state, "unknown", "a synchronous transport failure is durable, never a silent success");
  assert.ok(record);
  assert.equal(record.last_error_code, "submit_transport_unknown");

  const rejectingKv = new MemoryKv();
  await seedFences(rejectingKv, input);
  const rejectingProvider = new FakeCodexUsageResetProvider();
  rejectingProvider.redeemFailure = new Error("provider rejected");
  const rejected = await attemptCodexBankedReset(input, dependencies(rejectingKv, rejectingProvider, clock));
  assert.equal(rejected.kind, "pending");
  assert.equal(rejected.reason, "submit_transport_unknown");

  const receiptlessKv = new MemoryKv();
  await seedFences(receiptlessKv, input);
  const receiptlessProvider = new FakeCodexUsageResetProvider();
  receiptlessProvider.redeemResult = { kind: "unknown", providerReceiptId: null };
  const receiptless = await attemptCodexBankedReset(input, dependencies(receiptlessKv, receiptlessProvider, clock));
  assert.equal(receiptless.kind, "pending");
  assert.equal(receiptless.reason, "provider_commit_unknown", "an unknown outcome is never treated as a verified reset");
});

test("a client aborted mid-submission is rejected before and after the final renewal", async () => {
  const input = candidate();
  const controller = new AbortController();
  const abortedInput: CodexBankedResetCandidate = { ...input, signal: controller.signal };
  const clock = new TestClock();
  const provider = new FakeCodexUsageResetProvider();
  const kv = new MemoryKv();
  await seedFences(kv, abortedInput);
  const entered = new Deferred<void>();
  provider.inventoryEntered = entered;
  provider.inventoryGate = entered.promise.then(() => {
    controller.abort();
  });

  const beforeRenewal = await attemptCodexBankedReset(abortedInput, dependencies(kv, provider, clock));
  assert.equal(beforeRenewal.reason, "client_aborted_before_submission", "an abort observed before the durable submission rejects the record");
  assert.equal(provider.redeemInputs.length, 0, "no provider redemption is attempted for an aborted client");

  const afterSubmission = new AbortController();
  const afterSubmissionKv = new MemoryKv();
  const afterSubmissionInput = candidate({ accountId: "test-account-c" });
  await seedFences(afterSubmissionKv, afterSubmissionInput);
  afterSubmissionKv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber === 2) afterSubmission.abort();
  };
  const abortedAfterSubmit = await attemptCodexBankedReset(
    { ...afterSubmissionInput, signal: afterSubmission.signal },
    dependencies(afterSubmissionKv, new FakeCodexUsageResetProvider(), clock)
  );
  assert.equal(
    abortedAfterSubmit.reason,
    "client_aborted_after_submission",
    "an abort seen after the durable submission rejects the record instead of spending"
  );
  assert.ok(afterSubmissionKv.atomicCommitCount >= 2, "the durable submission boundary was crossed before the abort was observed");

  const afterRenewal = new AbortController();
  const afterRenewalKv = new MemoryKv();
  const afterRenewalInput = candidate({ accountId: "test-account-d" });
  await seedFences(afterRenewalKv, afterRenewalInput);
  afterRenewalKv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber === 3) afterRenewal.abort();
  };
  const spendingProvider = new FakeCodexUsageResetProvider();
  const abortedAfterRenewal = await attemptCodexBankedReset(
    { ...afterRenewalInput, signal: afterRenewal.signal },
    dependencies(afterRenewalKv, spendingProvider, clock)
  );
  assert.equal(abortedAfterRenewal.reason, "client_aborted_after_submission", "an abort seen after the final renewal stops before the provider call");
  assert.equal(spendingProvider.redeemInputs.length, 0);
});

test("a settled verified or rejected record is reported without a new claim", async () => {
  const clock = new TestClock();
  const input = candidate();
  const provider = new FakeCodexUsageResetProvider();
  const context = await contextOf(input);

  const verifiedKv = new MemoryKv();
  await seedFences(verifiedKv, input);
  await verifiedKv.set(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration), {
    ...createRecord(context, input, "verified", clock.nowMs),
    verified_at_ms: clock.nowMs,
  });
  const verified = await attemptCodexBankedReset(input, dependencies(verifiedKv, provider, clock));
  assert.equal(verified.kind, "verified");
  assert.equal(verified.reason, "previously_verified");
  assert.equal(provider.callCount, 0, "a settled outcome never re-enters the provider");

  const rejectedKv = new MemoryKv();
  await seedFences(rejectedKv, input);
  await rejectedKv.set(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration), {
    ...createRecord(context, input, "rejected", clock.nowMs),
    last_error_code: "provider_rejected",
  });
  const rejected = await attemptCodexBankedReset(input, dependencies(rejectedKv, provider, clock));
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.reason, "provider_rejected");

  const staleKv = new MemoryKv();
  await seedFences(staleKv, input);
  await staleKv.set(codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration), {
    ...createRecord(context, input, "verified", clock.nowMs),
    verified_at_ms: clock.nowMs,
  });
  const stale = await attemptCodexBankedReset({ ...input, routingGeneration: input.routingGeneration + 1 }, dependencies(staleKv, provider, clock));
  assert.equal(stale.reason, "verified_routing_generation_stale", "an older verified reset is never a recovery candidate for a newer circuit");
});

/* ------------------------------------------------------------- pool routing */

test("evaluateCodexBankedResetPool reports malformed pools, an unreadable clock and an unavailable KV", async () => {
  const clock = new TestClock();
  const provider = new FakeCodexUsageResetProvider();
  const input = candidate();
  const kv = new MemoryKv();
  await seedFences(kv, input);
  const deps = dependencies(kv, provider, clock, config({ mode: "shadow" }));

  assert.equal((await evaluateCodexBankedResetPool([], deps)).reason, "full_pool_missing");
  const second = candidate({ accountId: "test-account-b" });
  await seedFences(kv, second);
  const poolWithSlots = (firstSlot: number, secondSlot: number) => [
    { slot: firstSlot, candidate: input, provider },
    { slot: secondSlot, candidate: second, provider },
  ];
  assert.equal((await evaluateCodexBankedResetPool(poolWithSlots(0, 0), deps)).reason, "full_pool_invalid", "two candidates may not share a slot");
  assert.equal((await evaluateCodexBankedResetPool(poolWithSlots(0.5, 1), deps)).reason, "full_pool_invalid", "a fractional slot is not a pool slot");
  assert.equal((await evaluateCodexBankedResetPool(poolWithSlots(0, 1), { ...deps, now: () => Number.NaN })).reason, "invalid_clock");
  assert.equal(
    (await evaluateCodexBankedResetPool([...fullPool(input, provider, candidate({ accountId: "test-account-b" }), provider)], { ...deps, kv: null })).reason,
    "kv_unavailable"
  );
  assert.equal(
    (await evaluateCodexBankedResetPool(fullPool({ ...input, credentialVersion: "" }, provider, candidate({ accountId: "test-account-b" }), provider), deps))
      .reason,
    "invalid_quota_generation"
  );
  assert.equal(
    (
      await evaluateCodexBankedResetPool(
        fullPool({ ...input, quotaResetAtMs: clock.nowMs - 1 }, provider, candidate({ accountId: "test-account-b" }), provider),
        deps
      )
    ).reason,
    "quota_window_expired"
  );
  assert.equal(
    (
      await evaluateCodexBankedResetPool(fullPool(input, provider, candidate({ accountId: "test-account-b" }), provider), {
        ...deps,
        reloadConfig: () => {
          throw new Error("config unavailable");
        },
      })
    ).reason,
    "configuration_unavailable"
  );
});

test("a live pool refuses a per-account day limit above one when an injected provider treats redeem outcomes as final", async () => {
  const clock = new TestClock();
  const input = candidate();
  const kv = new MemoryKv();
  await seedFences(kv, input);
  const terminalProvider = new FakeCodexUsageResetProvider({ ...provenContract(), redeemOutcomeIsFinal: true });
  const second = candidate({ accountId: "test-account-b" });
  await seedFences(kv, second);

  const outcome = await evaluateCodexBankedResetPool(
    [...fullPool(input, terminalProvider, second, terminalProvider)],
    dependencies(kv, terminalProvider, clock, config({ mode: "live", maxPerAccountPerDay: 2 }))
  );
  assert.equal(outcome.reason, "terminal_outcome_account_day_limit_must_be_one");

  const atMostOnce = await evaluateCodexBankedResetPool(
    [...fullPool(input, terminalProvider, second, terminalProvider)],
    dependencies(kv, terminalProvider, clock, config({ mode: "live", maxPerAccountPerDay: 1 }))
  );
  assert.notEqual(atMostOnce.reason, "terminal_outcome_account_day_limit_must_be_one");
});

test("a shadow pool refuses an unreadable usage record and reports its read-only decision", async () => {
  const clock = new TestClock();
  const input = candidate();
  const second = candidate({ accountId: "test-account-b" });
  const provider = new FakeCodexUsageResetProvider();
  const kv = new FailKeyKv();
  await seedFences(kv, input);
  await seedFences(kv, second);
  const deps = dependencies(kv, provider, clock, config({ mode: "shadow" }));

  provider.inventoryFailure = new Error("inventory unavailable");
  assert.equal(
    (await evaluateCodexBankedResetPool([...fullPool(input, provider, second, provider)], deps)).reason,
    "inventory_unavailable",
    "a failed inventory read stops the episode"
  );
  provider.inventoryFailure = null;

  const context = await contextOf(input);
  const unreadableUsage = new FailKeyKv();
  await seedFences(unreadableUsage, input);
  await seedFences(unreadableUsage, second);
  unreadableUsage.failGetKeys.push(JSON.stringify(codexResetUsageKey(context.account.accountIdHash)));
  assert.equal(
    (
      await evaluateCodexBankedResetPool(
        [...fullPool(input, provider, second, provider)],
        dependencies(unreadableUsage, provider, clock, config({ mode: "shadow" }))
      )
    ).reason,
    "configuration_unavailable",
    "an unreadable reset-settings record fails the whole episode closed"
  );

  provider.inventory = inventory("credit-1", clock.nowMs + 60_000);
  const configuredGloballyDisallowed = dependencies(kv, provider, clock, config({ mode: "shadow", enabled: false }));
  assert.equal((await evaluateCodexBankedResetPool([...fullPool(input, provider, second, provider)], configuredGloballyDisallowed)).reason, "feature_disabled");

  const shadow = await evaluateCodexBankedResetPool([...fullPool(input, provider, second, provider)], deps);
  assert.equal(shadow.kind, "shadow");
  assert.equal(shadow.reason, "shadow_selected");
  assert.ok(shadow.selected, "a selected shadow decision names the candidate it would spend");
});
