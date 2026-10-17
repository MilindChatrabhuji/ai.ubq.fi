import type { Kv, KvEntryMaybe, KvKey } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  additionalRateLimitsForRouting,
  codexAccountLabel,
  codexUsageUrl,
  isSafeTimestamp,
  parseCodexUsage,
  providerCapacityLastAvailableKey,
  readCapacitySnapshot,
  readStoredCodexSource,
  readStoredHistoryPoint,
  readStoredSnapshot,
  safeNow,
  unavailableCodexSource,
  unavailableMeteredSource,
} from "../src/provider/capacity-parse.ts";
import type { ProviderCapacityCodexSource, ProviderCapacityMeteredSource, ProviderCapacitySource } from "../src/provider/capacity-contract.ts";
import { PROVIDER_CAPACITY_SNAPSHOT_KEY } from "../src/provider/capacity-contract.ts";

/**
 * Branch coverage for the provider capacity parser.
 *
 * Every guard in this module has a rejection path and an acceptance path, so
 * each case below feeds the malformed value and the well-formed value and
 * asserts the parsed result (or null) the gateway stores and routes on.
 */

const SHA256 = "a".repeat(64);

/** Narrow the snapshot's source union so each provider's fields stay typed. */
const codexSources = (sources: readonly ProviderCapacitySource[]): ProviderCapacityCodexSource[] =>
  sources.filter((source): source is ProviderCapacityCodexSource => source.source === "codex");
const meteredSources = (sources: readonly ProviderCapacitySource[]): ProviderCapacityMeteredSource[] =>
  sources.filter((source): source is ProviderCapacityMeteredSource => source.source === "metered");

const codexSource = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: "codex",
  label: "codex@example.test",
  slot: 1,
  account_cohort_id: SHA256,
  state: "available",
  source_observed_at_ms: 1_700_000_000_000,
  snapshot_at_ms: 1_700_000_000_000,
  failure_kind: null,
  failure_status: null,
  windows: { primary: { limit_window_seconds: 18_000, used_percent: 12.5, reset_at_ms: 1_700_000_600_000 }, secondary: null },
  additional_rate_limits: [],
  ...overrides,
});

const meteredWallet = (): ProviderCapacityMeteredSource["wallet"] => ({
  balance_credits: 5,
  baseline_credits: 10,
  refill_cycle_remaining_percent: 50,
  refill_cycle_used_percent: 50,
  unlimited_quota: false,
  total_available: 5,
  total_granted: 10,
  total_used: 5,
  cycle_started_at_ms: 1_700_000_000_000,
  last_credit_at_ms: 1_700_000_000_000,
  confidence: "provisional",
  cache_state: "fresh",
  reset_at_ms: null,
});

const meteredSource = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: "metered",
  label: "Metered fallback",
  state: "available",
  source_observed_at_ms: 1_700_000_000_000,
  snapshot_at_ms: 1_700_000_000_000,
  wallet: {
    balance_credits: 5,
    baseline_credits: 10,
    refill_cycle_remaining_percent: 50,
    refill_cycle_used_percent: 50,
    unlimited_quota: false,
    total_available: 5,
    total_granted: 10,
    total_used: 5,
    cycle_started_at_ms: 1_700_000_000_000,
    last_credit_at_ms: 1_700_000_000_000,
    confidence: "provisional",
    cache_state: "fresh",
    reset_at_ms: null,
  },
  ...overrides,
});

const storedSnapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  snapshot_at_ms: 1_700_000_000_000,
  stale_after_ms: 900_000,
  sources: [codexSource({ slot: 1 }), codexSource({ slot: 2, account_cohort_id: null }), meteredSource()],
  ...overrides,
});

test("capacity parse: an account label falls back to the slot for a blank email", () => {
  assert.equal(codexAccountLabel(1), "Codex account 1");
  assert.equal(codexAccountLabel(2, null), "Codex account 2");
  assert.equal(codexAccountLabel(1, "   "), "Codex account 1");
  assert.equal(codexAccountLabel(1, "  codex@example.test  "), "codex@example.test");
});

test("capacity parse: a clock that answers with an unusable value falls back to the wall clock", () => {
  const fixed = safeNow(() => 1_700_000_000_123.9);
  assert.equal(fixed, 1_700_000_000_123);
  const before = Date.now();
  const fallback = safeNow(() => -1);
  const after = Date.now();
  assert.ok(fallback >= before && fallback <= after);
  assert.ok(safeNow(() => Number.NaN) >= before);
  assert.equal(isSafeTimestamp(0), true);
  assert.equal(isSafeTimestamp(-1), false);
  assert.equal(isSafeTimestamp("0"), false);
  assert.equal(isSafeTimestamp(1.5), false);
});

test("capacity parse: the usage URL and last-available key are built from the contract", () => {
  assert.match(codexUsageUrl(), /\/backend-api\/wham\/usage$/);
  assert.deepEqual(providerCapacityLastAvailableKey(2).at(-1), 2);
});

test("capacity parse: a codex usage payload requires a rate-limit object and keeps partial windows", () => {
  assert.equal(parseCodexUsage(null), null);
  assert.equal(parseCodexUsage({}), null);
  assert.equal(parseCodexUsage({ rate_limit: "not-an-object" }), null);

  // Every field missing leaves a null window rather than a bogus one.
  assert.deepEqual(parseCodexUsage({ rate_limit: {} }), { primary: null, secondary: null, additional_rate_limits: [] });

  const parsed = parseCodexUsage({
    rate_limit: {
      primary_window: { limit_window_seconds: 18_000, used_percent: 0, reset_at: 1_700_000_600 },
      secondary_window: { limit_window_seconds: 604_800, used_percent: 100, reset_at: 1_800_000_000 },
    },
    additional_rate_limits: [
      { limit_name: " Spark ", metered_feature: " spark ", rate_limit: { primary_window: { used_percent: 0 } } },
      { limit_name: "  ", rate_limit: {} },
      "skip",
    ],
  });
  assert.deepEqual(parsed?.primary, { limit_window_seconds: 18_000, used_percent: 0, reset_at_ms: 1_700_000_600_000 });
  assert.deepEqual(parsed.secondary, { limit_window_seconds: 604_800, used_percent: 100, reset_at_ms: 1_800_000_000_000 });
  assert.deepEqual(parsed.additional_rate_limits, [
    {
      limit_name: "Spark",
      metered_feature: "spark",
      windows: { primary: { limit_window_seconds: null, used_percent: 0, reset_at_ms: null }, secondary: null },
    },
  ]);

  // Percent, window and reset bounds each reject their own field.
  const rejected = parseCodexUsage({
    rate_limit: {
      primary_window: { limit_window_seconds: -1, used_percent: 101, reset_at: -1 },
      secondary_window: { limit_window_seconds: 1.5, used_percent: Number.NaN, reset_at: Number.MAX_SAFE_INTEGER },
    },
  });
  assert.deepEqual(rejected, { primary: null, secondary: null, additional_rate_limits: [] });

  // An additional limit with no usable window is dropped entirely.
  assert.deepEqual(parseCodexUsage({ rate_limit: {}, additional_rate_limits: [{ limit_name: "x", rate_limit: {} }] })?.additional_rate_limits, []);
  // So is one whose name or feature is not a string, or whose rate_limit is not an object.
  assert.deepEqual(
    parseCodexUsage({
      rate_limit: {},
      additional_rate_limits: [
        { limit_name: 5, rate_limit: { primary_window: { used_percent: 0 } } },
        { limit_name: "x", metered_feature: 5, rate_limit: { primary_window: { used_percent: 0 } } },
        { limit_name: "x", rate_limit: "later" },
      ],
    })?.additional_rate_limits,
    [{ limit_name: "x", metered_feature: null, windows: { primary: { limit_window_seconds: null, used_percent: 0, reset_at_ms: null }, secondary: null } }]
  );
  assert.deepEqual(parseCodexUsage({ rate_limit: {}, additional_rate_limits: "none" })?.additional_rate_limits, []);
});

test("capacity parse: an unanchored additional window is filtered out of the routing view", () => {
  const snapshotAtMs = 1_700_000_000_000;
  // A window whose reset is exactly "snapshot plus one full window" was computed
  // from the snapshot rather than anchored to a real quota cycle.
  const unanchored = {
    limit_name: "Unanchored",
    metered_feature: null,
    windows: { primary: { limit_window_seconds: 18_000, used_percent: 0, reset_at_ms: snapshotAtMs + 18_000_000 }, secondary: null },
  };
  const used = {
    limit_name: "Used",
    metered_feature: null,
    windows: { primary: { limit_window_seconds: 18_000, used_percent: 5, reset_at_ms: snapshotAtMs + 18_000_000 }, secondary: null },
  };
  const anchored = {
    limit_name: "Anchored",
    metered_feature: null,
    windows: { primary: { limit_window_seconds: 18_000, used_percent: 0, reset_at_ms: snapshotAtMs + 60_000 }, secondary: null },
  };
  // Both windows are unanchored, so the row has no surviving window at all.
  const partial = {
    limit_name: "Partial",
    metered_feature: null,
    windows: {
      primary: { limit_window_seconds: 18_000, used_percent: 0, reset_at_ms: snapshotAtMs + 18_000_000 },
      secondary: { limit_window_seconds: 18_000, used_percent: 0, reset_at_ms: snapshotAtMs + 18_000_000 },
    },
  };

  // An unanchored row is dropped while the used and genuinely anchored rows survive.
  assert.deepEqual(additionalRateLimitsForRouting([unanchored, used, anchored], snapshotAtMs), [used, anchored]);
  // A row with no surviving window at all disappears.
  assert.deepEqual(additionalRateLimitsForRouting([partial], snapshotAtMs), []);
  // An unanchored secondary window is cleared while the primary stays.
  const bothWindows = {
    limit_name: "Both",
    metered_feature: null,
    windows: {
      primary: { limit_window_seconds: 18_000, used_percent: 0, reset_at_ms: snapshotAtMs + 60_000 },
      secondary: { limit_window_seconds: 18_000, used_percent: 0, reset_at_ms: snapshotAtMs + 18_000_000 },
    },
  };
  assert.deepEqual(additionalRateLimitsForRouting([bothWindows], snapshotAtMs), [
    { ...bothWindows, windows: { primary: bothWindows.windows.primary, secondary: null } },
  ]);
  // A window whose multiplied lifetime is not a safe integer is not unanchored.
  const overflowing = {
    limit_name: "Overflow",
    metered_feature: null,
    windows: { primary: { limit_window_seconds: Number.MAX_SAFE_INTEGER, used_percent: 0, reset_at_ms: snapshotAtMs }, secondary: null },
  };
  assert.deepEqual(additionalRateLimitsForRouting([overflowing], snapshotAtMs), [overflowing]);
});

test("capacity parse: stored codex sources round-trip only well-formed rows", () => {
  const fallback = 1_700_000_000_000;
  const stored = readStoredCodexSource(codexSource(), fallback);
  assert.equal(stored?.state, "available");
  assert.equal(stored.failure_kind, null);
  assert.equal(stored.account_cohort_id, SHA256);
  assert.deepEqual(stored.windows.primary, { limit_window_seconds: 18_000, used_percent: 12.5, reset_at_ms: 1_700_000_600_000 });

  // The optional snapshot timestamp defaults to the caller's fallback.
  const withoutSnapshot = readStoredCodexSource(codexSource({ snapshot_at_ms: undefined }), fallback);
  assert.equal(withoutSnapshot?.snapshot_at_ms, fallback);

  // An unavailable source without failure fields defaults to not_configured.
  const unavailable = readStoredCodexSource(codexSource({ slot: 2, state: "unavailable", failure_kind: undefined, failure_status: undefined }), fallback);
  assert.equal(unavailable?.failure_kind, "not_configured");
  assert.equal(unavailable.failure_status, null);

  // An unavailable source keeps its recorded failure.
  const failing = readStoredCodexSource(codexSource({ state: "unavailable", failure_kind: "http_error", failure_status: 503 }), fallback);
  assert.equal(failing?.failure_kind, "http_error");
  assert.equal(failing.failure_status, 503);

  const rejects: readonly unknown[] = [
    null,
    "codex",
    codexSource({ source: "metered" }),
    codexSource({ slot: 3 }),
    codexSource({ state: "unknown" }),
    codexSource({ source_observed_at_ms: "now" }),
    codexSource({ snapshot_at_ms: "now" }),
    codexSource({ failure_kind: "made_up" }),
    codexSource({ state: "available", failure_kind: "http_error" }),
    codexSource({ state: "available", failure_status: 500 }),
    codexSource({ windows: null }),
  ];
  for (const value of rejects) {
    assert.equal(readStoredCodexSource(value, fallback), null, `expected rejection of ${JSON.stringify(value)}`);
  }

  // An out-of-range status is dropped rather than failing an available source.
  const outOfRange = readStoredCodexSource(codexSource({ failure_status: 99 }), fallback);
  assert.equal(outOfRange?.failure_status, null);
  assert.equal(outOfRange.state, "available");
});

test("capacity parse: a stored codex source normalizes labels, cohort ids and windows", () => {
  const stored = readStoredCodexSource(
    codexSource({
      label: "   ",
      slot: 2,
      account_cohort_id: "not-a-digest",
      windows: {
        primary: { limit_window_seconds: null, used_percent: null, reset_at_ms: null },
        secondary: { limit_window_seconds: 60, used_percent: 1, reset_at_ms: 5 },
      },
      additional_rate_limits: [
        {
          limit_name: " spark ",
          metered_feature: "  ",
          windows: { primary: { limit_window_seconds: null, used_percent: null, reset_at_ms: null }, secondary: null },
        },
        { limit_name: 5, windows: {} },
        { limit_name: "   ", windows: {} },
        { limit_name: "no-windows", windows: "later" },
        { limit_name: "bad-feature", windows: {}, metered_feature: 5 },
        "skip",
        null,
      ],
    }),
    1_700_000_000_000
  );

  assert.equal(stored?.label, "Codex account 2");
  assert.equal(stored.account_cohort_id, null);
  assert.deepEqual(stored.windows.primary, { limit_window_seconds: null, used_percent: null, reset_at_ms: null });
  assert.deepEqual(stored.windows.secondary, { limit_window_seconds: 60, used_percent: 1, reset_at_ms: 5 });
  assert.deepEqual(stored.additional_rate_limits, [
    {
      limit_name: "spark",
      metered_feature: null,
      windows: { primary: { limit_window_seconds: null, used_percent: null, reset_at_ms: null }, secondary: null },
    },
  ]);

  // A stored list that is not an array reads as no additional limits at all.
  const noLimits = readStoredCodexSource(codexSource({ additional_rate_limits: "none" }), 1);
  assert.deepEqual(noLimits?.additional_rate_limits, []);
  assert.deepEqual(stored.windows.secondary, { limit_window_seconds: 60, used_percent: 1, reset_at_ms: 5 });

  // A stored window with an out-of-range field is rejected.
  const rejectedWindow = readStoredCodexSource(
    codexSource({ windows: { primary: { limit_window_seconds: -1, used_percent: 5, reset_at_ms: 1 }, secondary: null } }),
    1
  );
  assert.deepEqual(rejectedWindow?.windows.primary, null);
  // A window that is not an object is rejected too.
  const rejectedShape = readStoredCodexSource(codexSource({ windows: { primary: "later", secondary: null } }), 1);
  assert.deepEqual(rejectedShape?.windows.primary, null);
});

test("capacity parse: a stored metered source validates its state, wallet and enumerations", () => {
  const stored = readStoredSnapshot(storedSnapshot());
  assert.ok(stored);
  const wallet = meteredSources(stored.sources)[0]?.wallet;
  assert.equal(wallet.confidence, "provisional");
  assert.equal(wallet.cache_state, "fresh");
  assert.equal(wallet.unlimited_quota, false);
  assert.equal(codexSources(stored.sources)[0]?.account_cohort_id, SHA256);
  assert.equal(codexSources(stored.sources)[1]?.account_cohort_id, null);

  // Unknown enumeration values degrade to null instead of failing the record.
  const degraded = readStoredSnapshot(
    storedSnapshot({
      sources: [
        codexSource({ slot: 1 }),
        codexSource({ slot: 2 }),
        meteredSource({ wallet: { ...meteredWallet(), confidence: "guessed", cache_state: "warm" } }),
      ],
    })
  );
  assert.equal(meteredSources(degraded?.sources ?? [])[0]?.wallet.confidence, null);
  assert.equal(meteredSources(degraded?.sources ?? [])[0]?.wallet.cache_state, null);

  // Non-numeric wallet fields fall back to null rather than leaking the value.
  const coerced = readStoredSnapshot(
    storedSnapshot({
      sources: [
        codexSource({ slot: 1 }),
        codexSource({ slot: 2 }),
        meteredSource({ wallet: { ...meteredWallet(), balance_credits: "5", unlimited_quota: "yes", cycle_started_at_ms: -1 } }),
      ],
    })
  );
  assert.equal(meteredSources(coerced?.sources ?? [])[0]?.wallet.balance_credits, null);
  assert.equal(meteredSources(coerced?.sources ?? [])[0]?.wallet.unlimited_quota, null);
  assert.equal(meteredSources(coerced?.sources ?? [])[0]?.wallet.cycle_started_at_ms, null);
});

test("capacity parse: a stored snapshot requires both codex slots and a metered source", () => {
  assert.equal(readStoredSnapshot(null), null);
  assert.equal(readStoredSnapshot({ snapshot_at_ms: "now", sources: [] }), null);
  assert.equal(readStoredSnapshot({ snapshot_at_ms: 1_700_000_000_000, sources: "none" }), null);
  // A missing metered source invalidates the snapshot.
  assert.equal(readStoredSnapshot(storedSnapshot({ sources: [codexSource({ slot: 1 }), codexSource({ slot: 2 })] })), null);
  // So does a malformed codex slot.
  assert.equal(readStoredSnapshot(storedSnapshot({ sources: [codexSource({ slot: 1, state: "unknown" }), codexSource({ slot: 2 }), meteredSource()] })), null);
  assert.equal(readStoredSnapshot(storedSnapshot({ sources: [codexSource({ slot: 1 }), meteredSource()] })), null);
});

test("capacity parse: snapshot reads swallow a KV failure and decode a healthy row", async () => {
  const stored = storedSnapshot();
  const healthy = {
    get: (key: KvKey) => {
      assert.deepEqual(key, PROVIDER_CAPACITY_SNAPSHOT_KEY);
      return Promise.resolve({ key, value: stored, versionstamp: "00000000000000000001" } as KvEntryMaybe<unknown>);
    },
  } as unknown as Kv;
  assert.equal((await readCapacitySnapshot(healthy))?.sources.length, 3);

  const failing = {
    get: () => Promise.reject(new Error("kv unavailable")),
  } as unknown as Kv;
  assert.equal(await readCapacitySnapshot(failing), null);

  const empty = {
    get: (key: KvKey) => Promise.resolve({ key, value: null, versionstamp: null } as KvEntryMaybe<unknown>),
  } as unknown as Kv;
  assert.equal(await readCapacitySnapshot(empty), null);
});

test("capacity parse: a stored history point substitutes the unavailable metered source", () => {
  const point = {
    bucket_start_at_ms: 1_700_000_000_000,
    sampled_at_ms: 1_700_000_060_000,
    sources: [codexSource({ slot: 1 }), codexSource({ slot: 2 }), meteredSource()],
  };
  const parsed = readStoredHistoryPoint(point);
  assert.equal(parsed?.bucket_start_at_ms, 1_700_000_000_000);
  assert.equal(parsed.sources[2].state, "available");

  // A point without a metered source falls back to the unavailable stub.
  const withoutMetered = readStoredHistoryPoint({ ...point, sources: [codexSource({ slot: 1 }), codexSource({ slot: 2 })] });
  assert.equal(withoutMetered?.sources[2].state, "unavailable");
  assert.equal(withoutMetered.sources[2].wallet.balance_credits, null);

  // A malformed metered row takes the same fallback.
  const malformedMetered = readStoredHistoryPoint({ ...point, sources: [codexSource({ slot: 1 }), codexSource({ slot: 2 }), meteredSource({ wallet: null })] });
  assert.equal(malformedMetered?.sources[2].state, "unavailable");

  const rejects: readonly unknown[] = [
    null,
    { bucket_start_at_ms: "now", sampled_at_ms: 1, sources: [] },
    { bucket_start_at_ms: 1, sampled_at_ms: -1, sources: [] },
    { bucket_start_at_ms: 1, sampled_at_ms: 1, sources: "none" },
    { bucket_start_at_ms: 1, sampled_at_ms: 1, sources: [codexSource({ slot: 1 })] },
    { bucket_start_at_ms: 1, sampled_at_ms: 1, sources: [codexSource({ slot: 1, state: "unknown" }), codexSource({ slot: 2 })] },
  ];
  for (const value of rejects) {
    assert.equal(readStoredHistoryPoint(value), null, `expected rejection of ${JSON.stringify(value)}`);
  }
});

test("capacity parse: unavailable stubs describe an unobserved provider", () => {
  const codex = unavailableCodexSource(1, 1_700_000_000_000);
  assert.equal(codex.state, "unavailable");
  assert.equal(codex.failure_kind, "not_configured");
  assert.equal(codex.source_observed_at_ms, null);

  const observed = unavailableCodexSource(2, 1_700_000_000_000, "unreachable", 504, true, "offline@example.test", SHA256);
  assert.equal(observed.failure_kind, "unreachable");
  assert.equal(observed.failure_status, 504);
  assert.equal(observed.source_observed_at_ms, 1_700_000_000_000);
  assert.equal(observed.label, "offline@example.test");
  assert.equal(observed.account_cohort_id, SHA256);

  const metered = unavailableMeteredSource(1_700_000_000_000);
  assert.equal(metered.source, "metered");
  assert.equal(metered.wallet.total_available, null);
});

test("capacity parse: the parsed snapshot type keeps its codex sources addressable", () => {
  const parsed = readStoredSnapshot(storedSnapshot());
  assert.ok(parsed);
  const sources = codexSources(parsed.sources);
  assert.deepEqual(
    sources.map((source) => source.slot),
    [1, 2]
  );
});
