import { test } from "bun:test";
import type { AtomicOperation, Kv, KvCommitError, KvEntryMaybe, KvKey, KvListIterator, KvListSelector } from "#kv";
// Coverage tests for the kernel auth usage ledger (src/kernel/usage.ts).
//
// The ledger is pure KV projection: every case seeds raw stored values, calls
// the exported reader, and asserts the projected record (or the null that
// fail-closed paths return). The KV substitute is shared with the other kernel
// suites and keeps real compare-and-set semantics.

import assert from "node:assert/strict";
import {
  getKernelOrgUsage,
  getKernelUsage,
  KERNEL_AUTH_ORG_USAGE_DAILY_PREFIX,
  KERNEL_AUTH_ORG_USAGE_PREFIX,
  KERNEL_AUTH_USAGE_DAILY_PREFIX,
  KERNEL_AUTH_USAGE_PREFIX,
  kernelOrgUsageDailyKey,
  kernelOrgUsageKey,
  kernelUsageDailyKey,
  kernelUsageKey,
  listKernelOrgUsageRecords,
  listKernelUsageRecords,
} from "../src/kernel/usage.ts";
import {
  acquireKernelDefaultWindowCutover,
  kernelReservationContext,
  normalizeKernelQuotaReservationRowV2,
  readKernelQuotaPolicyState,
  reclaimExpiredKernelReservationUnlocked,
  reconcileKernelQuotaWindowReservations,
  releaseKernelDefaultWindowCutover,
  resolveKernelQuotaPolicyState,
} from "../src/kernel/quota-reservations.ts";
import {
  KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY,
  KERNEL_REPO_WINDOW_V2_PREFIX,
  type KernelQuotaWindowV2,
  kernelOrgPolicyKey,
  kernelRepoPolicyKey,
  kernelRepoReservationKey,
  kernelRepoWindowKey,
} from "../src/kernel/quota-v2.ts";
import { DEFAULT_KERNEL_POLICY_LIMIT_KEY, DEFAULT_KERNEL_POLICY_WINDOW_KEY } from "../src/defaults.ts";
import { setKvForTest } from "../src/kv.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

const kv = new CountingKv();
setKvForTest(kv as unknown as Kv);

/** The shared KV substitute with individual paths that can be made to fail. */
class FaultyKv extends CountingKv {
  failGet = false;
  failList = false;
  failCommits = 0;
  override get<T = unknown>(key: KvKey): Promise<KvEntryMaybe<T>> {
    if (this.failGet) throw new Error("kv get failed");
    return super.get<T>(key);
  }
  override list<T = unknown>(selector: KvListSelector): KvListIterator<T> {
    if (this.failList) throw new Error("kv list failed");
    return super.list<T>(selector);
  }
  throwOnCommit = false;
  override atomic(): AtomicOperation {
    const operation = super.atomic();
    const commit = operation.commit.bind(operation);
    operation.commit = async () => {
      if (this.throwOnCommit) throw new Error("kv commit failed");
      if (this.failCommits > 0) {
        this.failCommits -= 1;
        return { ok: false } as KvCommitError;
      }
      return await commit();
    };
    return operation;
  }
}

/** Awaits a promise that must reject and returns the failure. */
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error("expected the promise to reject");
};

const dayKeyUtc = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

const seedUsage = (owner: string, repo: string, value: unknown): void => {
  kv.seed(kernelUsageKey(owner, repo), value);
};
const seedOrgUsage = (owner: string, value: unknown): void => {
  kv.seed(kernelOrgUsageKey(owner), value);
};

/** A complete, well-formed stored usage record. */
const usageRecord = (owner: string, repo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  owner,
  repo,
  total_requests: 10,
  stream_requests: 4,
  non_stream_requests: 6,
  completed_requests: 9,
  error_requests: 1,
  input_tokens: 100,
  output_tokens: 200,
  total_tokens: 300,
  first_seen_at_ms: 1_000,
  last_seen_at_ms: 2_000,
  last_model: "gpt-5.6-sol",
  last_reasoning: "low",
  last_route: "/v1/responses",
  ...overrides,
});

/** A complete, well-formed stored org usage record. */
const orgUsageRecord = (owner: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const record = usageRecord(owner, "unused", overrides);
  delete record.repo;
  return record;
};

test("kernel usage keys address one repo and one org row", () => {
  assert.deepEqual(kernelUsageKey("acme", "demo"), ["ubq_ai", "kernel_auth", "usage", "acme", "demo"]);
  assert.deepEqual(kernelUsageDailyKey("acme", "demo"), ["ubq_ai", "kernel_auth", "usage_daily", "acme", "demo"]);
  assert.deepEqual(kernelOrgUsageKey("acme"), ["ubq_ai", "kernel_auth", "org_usage", "acme"]);
  assert.deepEqual(kernelOrgUsageDailyKey("acme"), ["ubq_ai", "kernel_auth", "org_usage_daily", "acme"]);
  assert.deepEqual(KERNEL_AUTH_USAGE_PREFIX, ["ubq_ai", "kernel_auth", "usage"]);
  assert.deepEqual(KERNEL_AUTH_USAGE_DAILY_PREFIX, ["ubq_ai", "kernel_auth", "usage_daily"]);
  assert.deepEqual(KERNEL_AUTH_ORG_USAGE_PREFIX, ["ubq_ai", "kernel_auth", "org_usage"]);
  assert.deepEqual(KERNEL_AUTH_ORG_USAGE_DAILY_PREFIX, ["ubq_ai", "kernel_auth", "org_usage_daily"]);
});

test("kernel usage reads report the stored counters and labels", async () => {
  kv.clearData();
  seedUsage("acme", "demo", usageRecord("acme", "demo"));

  const usage = await getKernelUsage("acme", "demo");
  assert.deepEqual(usage, {
    owner: "acme",
    repo: "demo",
    total_requests: 10,
    stream_requests: 4,
    non_stream_requests: 6,
    completed_requests: 9,
    error_requests: 1,
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    first_seen_at_ms: 1_000,
    last_seen_at_ms: 2_000,
    last_model: "gpt-5.6-sol",
    last_reasoning: "low",
    last_route: "/v1/responses",
  });
  assert.equal(Object.hasOwn(usage, "daily_requests"), false);

  seedOrgUsage("acme", orgUsageRecord("acme", { total_requests: 3 }));
  const orgUsage = await getKernelOrgUsage("acme");
  assert.ok(orgUsage);
  assert.equal(orgUsage.total_requests, 3);
  assert.equal(orgUsage.owner, "acme");
  assert.equal(orgUsage.last_model, "gpt-5.6-sol");
});

test("kernel usage reads coerce malformed stored values instead of trusting them", async () => {
  kv.clearData();
  // A stored scalar is not a record: the projection reports an untouched row.
  seedUsage("acme", "scalar", 7);
  const scalar = await getKernelUsage("acme", "scalar");
  assert.deepEqual(scalar, {
    owner: "acme",
    repo: "scalar",
    total_requests: 0,
    stream_requests: 0,
    non_stream_requests: 0,
    completed_requests: 0,
    error_requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    first_seen_at_ms: scalar?.first_seen_at_ms,
    last_seen_at_ms: scalar?.last_seen_at_ms,
    last_model: null,
    last_reasoning: null,
    last_route: null,
  });
  assert.equal(typeof scalar.first_seen_at_ms, "number");

  // Field-level coercion: non-numeric counters fall back, fractional counters
  // truncate, identity fields fall back to the requested key, labels trim.
  seedUsage(
    "acme",
    "coerced",
    usageRecord("", "", {
      owner: 12,
      repo: { name: "demo" },
      total_requests: "many",
      stream_requests: 3.9,
      non_stream_requests: Number.POSITIVE_INFINITY,
      completed_requests: 2,
      error_requests: null,
      input_tokens: -5,
      output_tokens: 1.2,
      total_tokens: Number.NaN,
      first_seen_at_ms: "yesterday",
      last_seen_at_ms: 5.75,
      last_model: "  gpt-5.6-sol  ",
      last_reasoning: "   ",
      last_route: 9,
    })
  );
  const coerced = await getKernelUsage("acme", "coerced");
  assert.ok(coerced);
  assert.equal(coerced.owner, "acme");
  assert.equal(coerced.repo, "coerced");
  assert.equal(coerced.total_requests, 0);
  assert.equal(coerced.stream_requests, 3);
  assert.equal(coerced.non_stream_requests, 0);
  assert.equal(coerced.error_requests, 0);
  assert.equal(coerced.input_tokens, -5);
  assert.equal(coerced.output_tokens, 1);
  assert.equal(coerced.total_tokens, 0);
  assert.equal(coerced.last_seen_at_ms, 5);
  assert.equal(coerced.last_model, "gpt-5.6-sol");
  assert.equal(coerced.last_reasoning, null);
  assert.equal(coerced.last_route, null);

  // A very long label is retained only up to the stored maximum.
  const longLabel = "m".repeat(200);
  seedUsage("acme", "labels", usageRecord("acme", "labels", { last_model: longLabel, last_route: " r ".repeat(1) }));
  const labels = await getKernelUsage("acme", "labels");
  assert.ok(labels);
  assert.equal(labels.last_model?.length, 120);
  assert.equal(labels.last_model, "m".repeat(120));
  assert.equal(labels.last_route, "r");

  seedOrgUsage("acme", 3);
  const orgScalar = await getKernelOrgUsage("acme");
  assert.ok(orgScalar);
  assert.equal(orgScalar.total_requests, 0);
  assert.equal(orgScalar.owner, "acme");
  assert.equal(orgScalar.last_model, null);

  seedOrgUsage("beta", orgUsageRecord("", { owner: "  ", total_requests: 4.9, last_model: 5 }));
  const orgCoerced = await getKernelOrgUsage("beta");
  assert.ok(orgCoerced);
  assert.equal(orgCoerced.owner, "beta");
  assert.equal(orgCoerced.total_requests, 4);
  assert.equal(orgCoerced.last_model, null);
});

test("kernel usage reads build the daily series from stored day rows", async () => {
  kv.clearData();
  const nowMs = Date.now();
  const today = dayKeyUtc(nowMs);
  const yesterday = dayKeyUtc(nowMs - DAY_MS);
  seedUsage("acme", "demo", usageRecord("acme", "demo"));
  kv.seed(kernelUsageDailyKey("acme", "demo"), {
    owner: "acme",
    repo: "demo",
    days: [
      { day: today, request_count: 5 },
      { day: yesterday, request_count: 2.9 },
      { day: "1970-01-01", request_count: -4 },
      { day: "not-a-day", request_count: 9 },
      { day: "2024-1-1", request_count: 9 },
      { day: "", request_count: 9 },
      { day: "2024-02-30", request_count: 7 },
      7,
      { request_count: 3 },
    ],
    updated_at_ms: 5,
  });

  const series = await getKernelUsage("acme", "demo", { includeDaily: true });
  assert.ok(series);
  const daily = series.daily_requests;
  assert.ok(daily);
  assert.equal(daily.length, 30);
  assert.equal(daily[29], 5);
  assert.equal(daily[28], 2);
  assert.equal(
    daily.reduce((sum, count) => sum + count, 0),
    7
  );

  const short = (await getKernelUsage("acme", "demo", { includeDaily: true, dailyDays: 2.9 }))?.daily_requests;
  assert.deepEqual(short, [2, 5]);
  const single = (await getKernelUsage("acme", "demo", { includeDaily: true, dailyDays: 0 }))?.daily_requests;
  assert.deepEqual(single, [5]);

  seedOrgUsage("acme", orgUsageRecord("acme"));
  kv.seed(kernelOrgUsageDailyKey("acme"), { days: [{ day: today, request_count: 8 }] });
  const orgSeries = (await getKernelOrgUsage("acme", { includeDaily: true, dailyDays: 3 }))?.daily_requests;
  assert.deepEqual(orgSeries, [0, 0, 8]);

  // A daily row that is not a record, and a non-array day list, both read as empty.
  seedUsage("acme", "no-days", usageRecord("acme", "no-days"));
  kv.seed(kernelUsageDailyKey("acme", "no-days"), 42);
  const noDays = (await getKernelUsage("acme", "no-days", { includeDaily: true, dailyDays: 2 }))?.daily_requests;
  assert.deepEqual(noDays, [0, 0]);

  seedOrgUsage("beta", orgUsageRecord("beta"));
  kv.seed(kernelOrgUsageDailyKey("beta"), { days: "nope" });
  const orgNoDays = (await getKernelOrgUsage("beta", { includeDaily: true, dailyDays: 2 }))?.daily_requests;
  assert.deepEqual(orgNoDays, [0, 0]);

  // A daily row whose owner/repo are unusable falls back to the requested key.
  seedUsage("acme", "identity", usageRecord("acme", "identity"));
  kv.seed(kernelUsageDailyKey("acme", "identity"), { owner: 5, repo: null, days: [{ day: today, request_count: 1 }] });
  const identity = await getKernelUsage("acme", "identity", { includeDaily: true, dailyDays: 1 });
  assert.ok(identity);
  assert.deepEqual(identity.daily_requests, [1]);
});

test("kernel usage reads fail closed without KV, without a row, and on KV errors", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    assert.equal(await getKernelUsage("acme", "demo"), null);
    assert.equal(await getKernelOrgUsage("acme"), null);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  assert.equal(await getKernelUsage("acme", "missing"), null);
  assert.equal(await getKernelUsage("acme", "missing", { includeDaily: true }), null);
  assert.equal(await getKernelOrgUsage("acme"), null);
  assert.equal(await getKernelOrgUsage("acme", { includeDaily: true }), null);

  const faulty = new FaultyKv();
  setKvForTest(faulty as unknown as Kv);
  try {
    faulty.failGet = true;
    assert.equal(await getKernelUsage("acme", "demo"), null);
    assert.equal(await getKernelOrgUsage("acme"), null);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }
});
test("kernel usage listings sort their rows, attach daily series and stay inside their scope", async () => {
  kv.clearData();
  seedUsage("beta", "alpha", usageRecord("beta", "alpha", { total_requests: 1 }));
  seedUsage("acme", "zeta", usageRecord("acme", "zeta", { total_requests: 2 }));
  seedUsage("acme", "alpha", { owner: 5, repo: 6, total_requests: 3 });
  // A row stored without owner/repo key parts keeps an empty identity instead of throwing.
  kv.seed([...KERNEL_AUTH_USAGE_PREFIX], usageRecord("", "", { owner: 7, repo: 8, total_requests: 4 }));
  // Daily rows live in their own namespace and must never be projected as usage rows.
  kv.seed([...KERNEL_AUTH_USAGE_DAILY_PREFIX, "ghost", "row"], { days: [] });
  kv.seed(kernelUsageDailyKey("acme", "alpha"), { days: [{ day: dayKeyUtc(Date.now()), request_count: 6 }] });
  kv.seed(kernelUsageDailyKey("acme", "zeta"), 5);
  kv.seed(kernelUsageDailyKey("", ""), { days: [{ day: dayKeyUtc(Date.now()), request_count: 2 }] });

  const plain = await listKernelUsageRecords();
  assert.ok(plain);
  assert.deepEqual(
    plain.map((row) => `${row.owner}/${row.repo}`),
    ["/", "acme/alpha", "acme/zeta", "beta/alpha"]
  );
  assert.equal(Object.hasOwn(plain[0], "daily_requests"), false);
  assert.equal(plain[1].total_requests, 3);

  const withDaily = await listKernelUsageRecords({ includeDaily: true, dailyDays: 2 });
  assert.ok(withDaily);
  assert.deepEqual(withDaily[0].daily_requests, [0, 2]);
  assert.deepEqual(withDaily[1].daily_requests, [0, 6]);
  assert.deepEqual(withDaily[2].daily_requests, [0, 0]);
  assert.deepEqual(withDaily[3].daily_requests, [0, 0]);
  assert.equal(withDaily[3].total_requests, 1);

  seedOrgUsage("beta", 9);
  seedOrgUsage("acme", orgUsageRecord("acme", { total_requests: 5 }));
  kv.seed(kernelOrgUsageDailyKey("acme"), { days: [{ day: dayKeyUtc(Date.now()), request_count: 3 }] });

  const orgPlain = await listKernelOrgUsageRecords();
  assert.ok(orgPlain);
  assert.deepEqual(
    orgPlain.map((row) => row.owner),
    ["acme", "beta"]
  );
  assert.equal(Object.hasOwn(orgPlain[0], "daily_requests"), false);
  assert.equal(orgPlain[0].total_requests, 5);
  assert.equal(orgPlain[1].total_requests, 0);

  const orgWithDaily = await listKernelOrgUsageRecords({ includeDaily: true, dailyDays: 1 });
  assert.ok(orgWithDaily);
  assert.deepEqual(orgWithDaily[0].daily_requests, [3]);
  assert.deepEqual(orgWithDaily[1].daily_requests, [0]);
});

test("kernel usage listings return an empty array for an empty ledger", async () => {
  kv.clearData();
  assert.deepEqual(await listKernelUsageRecords(), []);
  assert.deepEqual(await listKernelUsageRecords({ includeDaily: true }), []);
  assert.deepEqual(await listKernelOrgUsageRecords(), []);
  assert.deepEqual(await listKernelOrgUsageRecords({ includeDaily: true, dailyDays: 4 }), []);
});

test("kernel usage listings fail closed without KV and on KV errors", async () => {
  setKvForTest(null);
  try {
    assert.equal(await listKernelUsageRecords(), null);
    assert.equal(await listKernelUsageRecords({ includeDaily: true }), null);
    assert.equal(await listKernelOrgUsageRecords(), null);
    assert.equal(await listKernelOrgUsageRecords({ includeDaily: true }), null);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  const faulty = new FaultyKv();
  faulty.failList = true;
  setKvForTest(faulty as unknown as Kv);
  try {
    assert.equal(await listKernelUsageRecords(), null);
    assert.equal(await listKernelUsageRecords({ includeDaily: true }), null);
    assert.equal(await listKernelOrgUsageRecords(), null);
    assert.equal(await listKernelOrgUsageRecords({ includeDaily: true }), null);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }
});

const WINDOW_MS = 60_000;

const reservationRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 2,
  scope: "repo",
  owner: "acme",
  repo: "demo",
  request_id: "req-1",
  route: "/v1/responses",
  window_created_at_ms: 5_000,
  window_reset_at_ms: Date.now() + WINDOW_MS,
  state: "reserved",
  terminal_intent: null,
  reserved_at_ms: 4_000,
  lease_expires_at_ms: Date.now() + 300_000,
  committed_at_ms: null,
  released_at_ms: null,
  release_reason: null,
  ...overrides,
});

const windowRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 2,
  scope: "repo",
  owner: "acme",
  repo: "demo",
  usage_requests: 0,
  reserved_requests: 1,
  usage_reset_at_ms: Date.now() + WINDOW_MS,
  applied_window_ms: WINDOW_MS,
  created_at_ms: 5_000,
  updated_at_ms: 6_000,
  ...overrides,
});

/** A window stored before the reserved_requests aggregate existed. */
const legacyWindowRow = (): Record<string, unknown> => {
  const row = windowRow();
  delete row.reserved_requests;
  return row;
};

/** The same row, typed the way the reservation API declares it. */
const typedWindow = (overrides: Record<string, unknown> = {}): KernelQuotaWindowV2 => windowRow(overrides) as unknown as KernelQuotaWindowV2;

test("kernel quota policy state resolves the repo scope, the org scope and malformed policies", async () => {
  kv.clearData();
  const repoOnly = await resolveKernelQuotaPolicyState("acme", "demo", { kv: kv as unknown as Kv });
  assert.deepEqual(repoOnly, { ok: true, limit_scope: "org", has_policy: false });

  kv.seed(kernelOrgPolicyKey("acme"), {
    v: 2,
    scope: "org",
    owner: "acme",
    usage_limit_requests: 5,
    window_ms: WINDOW_MS,
    expires_at_ms: -1,
    created_at_ms: 1,
    updated_at_ms: 2,
  });
  const orgPolicy = await resolveKernelQuotaPolicyState("acme", "demo", { kv: kv as unknown as Kv });
  assert.deepEqual(orgPolicy, { ok: true, limit_scope: "org", has_policy: true });

  kv.seed(kernelRepoPolicyKey("acme", "demo"), {
    v: 2,
    scope: "repo",
    owner: "acme",
    repo: "demo",
    usage_limit_requests: 5,
    window_ms: WINDOW_MS,
    expires_at_ms: -1,
    created_at_ms: 1,
    updated_at_ms: 2,
  });
  const repoPolicy = await resolveKernelQuotaPolicyState("acme", "demo", { kv: kv as unknown as Kv });
  assert.deepEqual(repoPolicy, { ok: true, limit_scope: "repo", has_policy: true });

  const state = await readKernelQuotaPolicyState(kv as unknown as Kv, "acme", "demo");
  assert.equal(state.limit_scope, "repo");
  assert.equal(state.repo_entry.value === null, false);
  assert.equal(state.org_entry.value === null, false);

  kv.clearData();
  const noKv = await resolveKernelQuotaPolicyState("acme", "demo", { kv: null });
  assert.equal(noKv.ok, false);
  assert.equal(noKv.response.status, 503);

  kv.seed(kernelOrgPolicyKey("acme"), { v: 2, scope: "org", owner: "acme" });
  const malformedOrg = await resolveKernelQuotaPolicyState("acme", "demo", { kv: kv as unknown as Kv });
  assert.equal(malformedOrg.ok, false);
  await assert.rejects(() => readKernelQuotaPolicyState(kv as unknown as Kv, "acme", "demo"), /Kernel org quota policy is malformed/);

  kv.clearData();
  kv.seed(kernelRepoPolicyKey("acme", "demo"), { v: 2, scope: "repo", owner: "acme", repo: "other" });
  const malformedRepo = await resolveKernelQuotaPolicyState("acme", "demo", { kv: kv as unknown as Kv });
  assert.equal(malformedRepo.ok, false);
  await assert.rejects(() => readKernelQuotaPolicyState(kv as unknown as Kv, "acme", "demo"), /Kernel repo quota policy is malformed/);
});

test("kernel reservation rows normalize only complete, consistent terminal states", () => {
  const valid = normalizeKernelQuotaReservationRowV2(reservationRow(), "repo", "acme", "demo");
  assert.ok(valid);
  assert.equal(valid.request_id, "req-1");
  assert.equal(valid.terminal_intent, null);

  const committed = normalizeKernelQuotaReservationRowV2(
    reservationRow({ state: "committed", terminal_intent: "committed", committed_at_ms: 9_000 }),
    "repo",
    "acme",
    "demo"
  );
  assert.equal(committed?.state, "committed");
  const released = normalizeKernelQuotaReservationRowV2(
    reservationRow({ state: "released", terminal_intent: "released", released_at_ms: 9_000, release_reason: "done" }),
    "repo",
    "acme",
    "demo"
  );
  assert.equal(released?.release_reason, "done");
  const legacyIntent = normalizeKernelQuotaReservationRowV2(reservationRow({ terminal_intent: undefined }), "repo", "acme", "demo");
  assert.equal(legacyIntent?.terminal_intent, null);

  const rejected: unknown[] = [
    7,
    { ...reservationRow(), scope: "org" },
    { ...reservationRow(), owner: "other" },
    { ...reservationRow(), repo: "other" },
    { ...reservationRow(), v: 3 },
    reservationRow({ request_id: "" }),
    reservationRow({ request_id: 7 }),
    reservationRow({ route: "" }),
    reservationRow({ route: null }),
    reservationRow({ window_created_at_ms: -1 }),
    reservationRow({ window_reset_at_ms: 0 }),
    reservationRow({ state: "unknown" }),
    reservationRow({ terminal_intent: "unknown" }),
    reservationRow({ reserved_at_ms: -1 }),
    reservationRow({ lease_expires_at_ms: 0 }),
    reservationRow({ committed_at_ms: 5 }),
    reservationRow({ released_at_ms: "5" }),
    reservationRow({ release_reason: 5 }),
    reservationRow({ committed_at_ms: 5, release_reason: "x" }),
    reservationRow({ state: "committed", committed_at_ms: null }),
    reservationRow({ state: "committed", committed_at_ms: 5, released_at_ms: 5 }),
    reservationRow({ state: "committed", committed_at_ms: 5, release_reason: "x" }),
    reservationRow({ state: "committed", committed_at_ms: 5, terminal_intent: "released" }),
    reservationRow({ state: "released", released_at_ms: null }),
    reservationRow({ state: "released", released_at_ms: 5, committed_at_ms: 5, release_reason: "x" }),
    reservationRow({ state: "released", released_at_ms: 5, release_reason: "" }),
    reservationRow({ state: "released", released_at_ms: 5, release_reason: "x", terminal_intent: "committed" }),
  ];
  for (const value of rejected) {
    assert.equal(normalizeKernelQuotaReservationRowV2(value, "repo", "acme", "demo"), null);
  }
  assert.equal(normalizeKernelQuotaReservationRowV2(reservationRow(), "org", "acme", undefined), null);
});

test("kernel window reservation reconciliation counts legacy rows and rejects malformed ones", async () => {
  kv.clearData();
  const entry = await kv.get<KernelQuotaWindowV2>(kernelRepoWindowKey("acme", "demo"));
  assert.equal(entry.value, null);
  assert.equal(await reconcileKernelQuotaWindowReservations(kv as unknown as Kv, entry, "repo", "acme", "demo"), null);

  // A window written before the aggregate field existed is rebuilt from its rows.
  kv.seed(kernelRepoWindowKey("acme", "demo"), legacyWindowRow());
  kv.seed(kernelRepoReservationKey("acme", "demo", 5_000, "req-1"), reservationRow());
  kv.seed(
    kernelRepoReservationKey("acme", "demo", 5_000, "req-2"),
    reservationRow({ request_id: "req-2", state: "released", released_at_ms: 1, release_reason: "x" })
  );
  const legacyEntry = await kv.get<KernelQuotaWindowV2>(kernelRepoWindowKey("acme", "demo"));
  const reconciled = await reconcileKernelQuotaWindowReservations(kv as unknown as Kv, legacyEntry, "repo", "acme", "demo");
  assert.ok(reconciled);
  assert.equal(reconciled.reserved_requests, 1);
  assert.equal(reconciled.usage_requests, 0);

  // A window that already carries the aggregate is returned untouched.
  kv.seed(kernelRepoWindowKey("acme", "demo"), windowRow({ reserved_requests: 7 }));
  const storedEntry = await kv.get<KernelQuotaWindowV2>(kernelRepoWindowKey("acme", "demo"));
  const untouched = await reconcileKernelQuotaWindowReservations(kv as unknown as Kv, storedEntry, "repo", "acme", "demo");
  assert.equal(untouched?.reserved_requests, 7);

  // A reservation row that disagrees with its key is malformed, not ignored.
  kv.seed(kernelRepoWindowKey("acme", "demo"), legacyWindowRow());
  kv.seed(kernelRepoReservationKey("acme", "demo", 5_000, "req-1"), reservationRow({ request_id: "different" }));
  const brokenEntry = await kv.get<KernelQuotaWindowV2>(kernelRepoWindowKey("acme", "demo"));
  await assert.rejects(
    () => reconcileKernelQuotaWindowReservations(kv as unknown as Kv, brokenEntry, "repo", "acme", "demo"),
    /Kernel quota reservation is malformed/
  );
});

test("kernel expired reservations are reclaimed once and fail closed when every commit is lost", async () => {
  kv.clearData();
  const liveWindow = typedWindow();
  assert.equal(await reclaimExpiredKernelReservationUnlocked(kv as unknown as Kv, "repo", "acme", "demo", liveWindow, Date.now()), false);

  // An expired lease that cannot be committed keeps the aggregate reserved.
  const faulty = new FaultyKv();
  setKvForTest(faulty as unknown as Kv);
  try {
    faulty.seed(kernelRepoWindowKey("acme", "demo"), windowRow({ reserved_requests: 1 }));
    faulty.seed(kernelRepoReservationKey("acme", "demo", 5_000, "req-1"), reservationRow({ lease_expires_at_ms: Date.now() - 1 }));
    const expiredWindow = typedWindow();
    faulty.failCommits = 3;
    await assert.rejects(
      () => reclaimExpiredKernelReservationUnlocked(faulty as unknown as Kv, "repo", "acme", "demo", expiredWindow, Date.now()),
      /Kernel quota reservation changed concurrently/
    );
    faulty.failCommits = 0;
    const reclaimed = await reclaimExpiredKernelReservationUnlocked(faulty as unknown as Kv, "repo", "acme", "demo", expiredWindow, Date.now());
    assert.equal(reclaimed, true);
    const windowEntry = await faulty.get<Record<string, unknown>>(kernelRepoWindowKey("acme", "demo"));
    assert.equal(windowEntry.value?.reserved_requests, 0);
    const rowEntry = await faulty.get<Record<string, unknown>>(kernelRepoReservationKey("acme", "demo", 5_000, "req-1"));
    assert.ok(rowEntry.value);
    assert.equal(rowEntry.value.state, "released");
    assert.equal(rowEntry.value.release_reason, "lease_expired");
  } finally {
    setKvForTest(kv as unknown as Kv);
  }
});

test("kernel expired reservation reclaim rejects a row whose window lost its reservation", async () => {
  kv.clearData();
  kv.seed(kernelRepoWindowKey("acme", "demo"), windowRow({ reserved_requests: 0 }));
  kv.seed(kernelRepoReservationKey("acme", "demo", 5_000, "req-expired"), reservationRow({ request_id: "req-expired", lease_expires_at_ms: Date.now() - 1 }));
  await assert.rejects(
    () => reclaimExpiredKernelReservationUnlocked(kv as unknown as Kv, "repo", "acme", "demo", typedWindow(), Date.now()),
    /Kernel quota reservation is malformed/
  );
});

test("kernel reservation context commits and releases its own row exactly once", async () => {
  kv.clearData();
  const route = "/v1/responses";
  kv.seed(kernelRepoWindowKey("acme", "demo"), windowRow());
  kv.seed(kernelRepoReservationKey("acme", "demo", 5_000, "req-commit"), reservationRow({ request_id: "req-commit" }));

  const committed = kernelReservationContext(kv as unknown as Kv, "repo", "acme", "demo", 5_000, "req-commit", route, Date.now() + 60_000);
  assert.equal(committed.signal.aborted, false);
  await committed.commit();
  assert.equal(committed.signal.aborted, false);
  await committed.commit();

  const windowEntry = await kv.get<Record<string, unknown>>(kernelRepoWindowKey("acme", "demo"));
  assert.ok(windowEntry.value);
  assert.equal(windowEntry.value.usage_requests, 1);
  assert.equal(windowEntry.value.reserved_requests, 0);
  const rowEntry = await kv.get<Record<string, unknown>>(kernelRepoReservationKey("acme", "demo", 5_000, "req-commit"));
  assert.ok(rowEntry.value);
  assert.equal(rowEntry.value.state, "committed");
  assert.equal(rowEntry.value.terminal_intent, "committed");
  assert.equal(rowEntry.value.release_reason, null);

  const lateRelease = await rejection(committed.release("too late"));
  assert.match(lateRelease.message, /terminal state is already committed/);

  kv.seed(kernelRepoWindowKey("acme", "demo"), windowRow({ usage_requests: 1, reserved_requests: 1 }));
  kv.seed(kernelRepoReservationKey("acme", "demo", 5_000, "req-release"), reservationRow({ request_id: "req-release" }));
  const released = kernelReservationContext(kv as unknown as Kv, "repo", "acme", "demo", 5_000, "req-release", route, Date.now() + 60_000);
  await released.release("");
  assert.equal(released.signal.aborted, false);

  const releasedWindow = await kv.get<Record<string, unknown>>(kernelRepoWindowKey("acme", "demo"));
  assert.ok(releasedWindow.value);
  assert.equal(releasedWindow.value.usage_requests, 1);
  assert.equal(releasedWindow.value.reserved_requests, 0);
  const releasedRow = await kv.get<Record<string, unknown>>(kernelRepoReservationKey("acme", "demo", 5_000, "req-release"));
  assert.ok(releasedRow.value);
  assert.equal(releasedRow.value.state, "released");
  assert.equal(releasedRow.value.terminal_intent, "released");
  assert.equal(releasedRow.value.release_reason, "request_incomplete");

  const lateCommit = await rejection(released.commit());
  assert.match(lateCommit.message, /terminal state is already released/);
});

test("kernel default-window cutover acquires a guard only while no default-backed work is live", async () => {
  kv.clearData();
  const expectedLimitEntry = await kv.get<number>(DEFAULT_KERNEL_POLICY_LIMIT_KEY);
  const expectedWindowEntry = await kv.get<number>(DEFAULT_KERNEL_POLICY_WINDOW_KEY);

  const acquired = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.equal(acquired.ok, true);
  const marker = await kv.get<Record<string, unknown>>(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY);
  assert.ok(marker.value);
  assert.equal(marker.value.v, 2);
  assert.equal(typeof marker.value.id, "string");
  assert.equal(marker.value.expires_at_ms, (marker.value.created_at_ms as number) + 5 * 60_000);

  // A live reservation holds the guard back, and the marker is released again.
  kv.seed(kernelRepoWindowKey("acme", "demo"), windowRow({ reserved_requests: 1, usage_reset_at_ms: Date.now() + WINDOW_MS }));
  kv.seed(kernelRepoReservationKey("acme", "demo", 5_000, "req-live"), reservationRow({ request_id: "req-live" }));
  await kv.delete(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY);
  const blocked = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.deepEqual(blocked, { ok: false, reason: "active_reservations" });
  assert.equal((await kv.get(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY)).value, null);

  // An explicit policy on the scope supersedes the defaults, so its live
  // reservations do not block the cutover.
  kv.seed(
    kernelRepoPolicyKey("acme", "demo"),
    windowRow({
      v: 2,
      scope: "repo",
      usage_requests: 0,
      reserved_requests: 0,
      usage_limit_requests: 5,
      window_ms: WINDOW_MS,
      expires_at_ms: -1,
      created_at_ms: 1,
      updated_at_ms: 2,
    })
  );
  const withPolicy = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.equal(withPolicy.ok, true);

  // A held lease that is still valid is a concurrent change.
  const stillAsking = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.deepEqual(stillAsking, { ok: false, reason: "concurrent_change" });

  // A commit that fails must not silently drop the guard, and the retry must.
  const faulty = new FaultyKv();
  faulty.throwOnCommit = true;
  await releaseKernelDefaultWindowCutover(faulty as unknown as Kv, withPolicy.guard);
  assert.notEqual((await kv.get(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY)).value, null);
  await releaseKernelDefaultWindowCutover(kv as unknown as Kv, withPolicy.guard);
  assert.equal((await kv.get(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY)).value, null);
});

test("kernel default-window cutover refuses a stale marker plus malformed windows", async () => {
  kv.clearData();
  const expectedLimitEntry = await kv.get<number>(DEFAULT_KERNEL_POLICY_LIMIT_KEY);
  const expectedWindowEntry = await kv.get<number>(DEFAULT_KERNEL_POLICY_WINDOW_KEY);

  kv.seed(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, { v: 1, id: "stale" });
  const staleMarker = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.deepEqual(staleMarker, { ok: false, reason: "unavailable" });

  kv.clearData();
  kv.seed([...KERNEL_REPO_WINDOW_V2_PREFIX], windowRow());
  const ownerlessKey = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.deepEqual(ownerlessKey, { ok: false, reason: "unavailable" });
  assert.equal((await kv.get(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY)).value, null);

  kv.clearData();
  kv.seed([...KERNEL_REPO_WINDOW_V2_PREFIX, "acme"], windowRow());
  const repolessKey = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.deepEqual(repolessKey, { ok: false, reason: "unavailable" });

  // A window with no live reservations never blocks the cutover.
  kv.clearData();
  kv.seed(kernelRepoWindowKey("acme", "demo"), windowRow({ reserved_requests: 0, usage_reset_at_ms: Date.now() - 1 }));
  const idle = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.equal(idle.ok, true);
  await releaseKernelDefaultWindowCutover(kv as unknown as Kv, idle.guard);

  // Expired rows that keep reclaiming do not converge: the guard is refused.
  kv.clearData();
  kv.seed(kernelRepoWindowKey("acme", "demo"), windowRow({ reserved_requests: 3, usage_reset_at_ms: Date.now() + WINDOW_MS }));
  for (const requestId of ["expired-1", "expired-2", "expired-3"]) {
    kv.seed(kernelRepoReservationKey("acme", "demo", 5_000, requestId), reservationRow({ request_id: requestId, lease_expires_at_ms: Date.now() - 1 }));
  }
  const racing = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.deepEqual(racing, { ok: false, reason: "unavailable" });
  assert.equal((await kv.get(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY)).value, null);

  kv.clearData();
  kv.seed(kernelRepoWindowKey("acme", "demo"), { v: 2, scope: "repo" });
  const corruptWindow = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.deepEqual(corruptWindow, { ok: false, reason: "unavailable" });
  assert.equal((await kv.get(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY)).value, null);

  kv.clearData();
  kv.seed(kernelOrgPolicyKey("acme"), { v: 2, scope: "org", owner: "acme" });
  kv.seed(["uos_ai", "kernel_quota", "v2", "org_window", "acme"], windowRow({ scope: "org", repo: undefined, reserved_requests: 1 }));
  const corruptPolicy = await acquireKernelDefaultWindowCutover(kv as unknown as Kv, expectedLimitEntry, expectedWindowEntry);
  assert.deepEqual(corruptPolicy, { ok: false, reason: "unavailable" });
  assert.equal((await kv.get(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY)).value, null);
});
