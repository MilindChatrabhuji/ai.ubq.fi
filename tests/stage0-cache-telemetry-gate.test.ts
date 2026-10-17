import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  analyzeStage0CacheTelemetryLines,
  STAGE0_AGGREGATE_MIN_COMPLETED,
  STAGE0_COHORT_MIN_COMPLETED,
  STAGE0_MIN_REPORTED_COVERAGE,
  Stage0CacheTelemetryGateError,
} from "../scripts/stage0-cache-telemetry-gate.ts";

const TERMINAL_MARKER = "[ai.ubq.fi] request_terminal";

let nextRequestId = 0;

const terminalLine = (overrides: Record<string, unknown> = {}): string =>
  `${TERMINAL_MARKER} ${JSON.stringify({
    request_id: `req-input-only-${nextRequestId++}`,
    route: "responses",
    status: 200,
    provider: "chatgpt_codex",
    model: "gpt-cache-fixture",
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    usage_observed: true,
    usage_telemetry_status: "reported",
    prompt_cache_key_present: false,
    prompt_cache_mode: "unspecified",
    account_slot: null,
    active_generation: null,
    active_transition_reason: null,
    stream: false,
    stream_terminal_type: "response.completed",
    git_sha: "0123456789abcdef",
    deno_revision: "deploy-a",
    router_revision: null,
    ...overrides,
  })}`;

/**
 * Explicit form of the comparator `Array.prototype.sort` uses when none is
 * supplied: both operands are stringified, then compared by UTF-16 code unit.
 * Spelled out so the ordering is stated rather than implied.
 */
const compareAsText = (a: string | null, b: string | null): number => {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

test("Stage 0 cache telemetry analyzer groups completed inference and preserves null cache values", () => {
  const report = analyzeStage0CacheTelemetryLines([
    "an unrelated log line",
    terminalLine({ cached_input_tokens: 0, cache_write_input_tokens: 0 }),
    terminalLine({ cached_input_tokens: null, cache_write_input_tokens: 20, usage_telemetry_status: "partial" }),
    // Cache reads and writes can overlap. The analyzer reports them separately
    // and intentionally never calculates an uncached remainder.
    terminalLine({ input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 80 }),
    terminalLine({
      route: "chat.completions",
      status: 201,
      provider: "metered",
      model: "gpt-chat-fixture",
      cached_input_tokens: 7,
      cache_write_input_tokens: null,
    }),
    terminalLine({ route: "embeddings", model: null, stream_terminal_type: "response.completed" }),
    terminalLine({ stream_terminal_type: "cancelled", model: null, status: 499 }),
  ]);

  assert.equal(report.terminal_events, 6);
  assert.deepEqual(report.status_totals, { "200": 4, "201": 1, "499": 1 });
  assert.equal(report.completed_inference, 4);
  assert.deepEqual(report.completed_status_totals, { "200": 3, "201": 1 });
  assert.deepEqual(report.usage_telemetry_status_totals, { partial: 1, reported: 3 });
  assert.deepEqual(report.valid_reported_cache_metrics, {
    reported_events: 3,
    cache_read: {
      aggregate_input_tokens: 300,
      aggregate_cached_input_tokens: 87,
      ratio: 0.29,
    },
    // Read/write values may overlap. This is a same-event counter-sum ratio,
    // not a reconstructed uncached bucket.
    cache_write_payback: {
      observed_events: 2,
      aggregate_cached_input_tokens: 80,
      aggregate_cache_write_input_tokens: 80,
      ratio: 1,
    },
  });
  assert.deepEqual(report.observed_completed_cache_read_input_tokens, {
    sum_tokens: 87,
    observed_events: 3,
    null_events: 1,
    zero_events: 1,
    positive_events: 2,
  });
  assert.deepEqual(report.observed_completed_cache_write_input_tokens, {
    sum_tokens: 100,
    observed_events: 3,
    null_events: 1,
    zero_events: 1,
    positive_events: 2,
  });
  assert.deepEqual(report.reported_over_completed, { reported: 3, completed: 4, ratio: 0.75 });
  assert.equal(Object.hasOwn(report as object, "uncached_input_tokens"), false);
  assert.doesNotMatch(JSON.stringify(report), /"input_tokens":/);
  assert.equal(report.cohorts.length, 2);
  assert.equal(report.cohorts[0]?.completed_inference, 3);
  assert.deepEqual(report.cohorts[0]?.valid_reported_cache_metrics.cache_read, {
    aggregate_input_tokens: 200,
    aggregate_cached_input_tokens: 80,
    ratio: 0.4,
  });
  assert.equal(report.cohorts[0]?.model, "model_1");
  assert.equal(report.cohorts[1]?.model, "model_2");
  assert.equal(report.cohorts[1]?.route, "chat.completions");
  assert.equal(report.cohorts[1]?.completed_inference, 1);
  assert.equal(report.cohorts[0]?.completed_1k_gate.passed, false);
  assert.equal(report.cohorts[0]?.reported_coverage_99_5_gate.passed, false);
  assert.equal(report.cohorts[1]?.reported_coverage_99_5_gate.passed, true);
  assert.equal(report.gates.reported_coverage_99_5.all_observed_cohorts_passed, false);
});

test("Stage 0 cache telemetry analyzer emits stable privacy-safe model and account cohorts", () => {
  const rawModel = "gpt-private-model-must-not-appear";
  const otherRawModel = "zzzz-other-private-model-must-not-appear";
  const accountA = "a".repeat(64);
  const accountB = "b".repeat(64);
  const report = analyzeStage0CacheTelemetryLines([
    terminalLine({ model: rawModel, account_slot: 17, account_cohort_id: accountA }),
    terminalLine({ model: rawModel, account_slot: 17, account_cohort_id: accountA }),
    terminalLine({ model: rawModel, account_slot: 17, account_cohort_id: accountB }),
    terminalLine({ provider: "surplus", model: "gpt-paid-model", account_slot: null, account_cohort_id: null }),
  ]);

  const codexCohorts = report.cache_dimension_cohorts.filter((cohort) => cohort.provider === "chatgpt_codex");
  assert.equal(codexCohorts.length, 2);
  assert.deepEqual(
    codexCohorts.map((cohort) => cohort.completed_inference).sort((a, b) => a - b),
    [1, 2]
  );
  assert.deepEqual(codexCohorts.map((cohort) => cohort.account_cohort_id).sort(compareAsText), [accountA, accountB]);
  assert.deepEqual([...new Set(codexCohorts.map((cohort) => cohort.model_cohort_id))].length, 1);
  assert.deepEqual([...new Set(codexCohorts.map((cohort) => cohort.account_slot_cohort))], ["slot_1"]);

  const reordered = analyzeStage0CacheTelemetryLines([
    terminalLine({ model: otherRawModel, account_slot: 17, account_cohort_id: accountB }),
    terminalLine({ model: rawModel, account_slot: 17, account_cohort_id: accountA }),
  ]);
  const reorderedRawModel = reordered.cache_dimension_cohorts.find((cohort) => cohort.account_cohort_id === accountA);
  assert.ok(reorderedRawModel);
  assert.equal(reorderedRawModel.model_cohort_id, codexCohorts[0]?.model_cohort_id);
  assert.notEqual(reorderedRawModel.model, codexCohorts[0]?.model);
  const movedAccount = analyzeStage0CacheTelemetryLines([terminalLine({ model: rawModel, account_slot: 93, account_cohort_id: accountA })])
    .cache_dimension_cohorts[0];
  assert.equal(movedAccount.account_cohort_id, accountA);
  assert.equal(movedAccount.model_cohort_id, codexCohorts[0]?.model_cohort_id);
  assert.doesNotMatch(JSON.stringify(movedAccount), /"account_slot":93/);
  const differentModel = analyzeStage0CacheTelemetryLines([terminalLine({ model: `${rawModel}-different`, account_slot: 17, account_cohort_id: accountA })]);
  assert.notEqual(differentModel.cache_dimension_cohorts[0]?.model_cohort_id, codexCohorts[0]?.model_cohort_id);

  const paidCohort = report.cache_dimension_cohorts.find((cohort) => cohort.provider === "surplus");
  assert.ok(paidCohort);
  assert.equal(paidCohort.account_slot_cohort, "unassigned");
  assert.equal(paidCohort.account_cohort_id, null);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(rawModel));
  assert.doesNotMatch(serialized, /"account_slot":17/);
  const reorderedSerialized = JSON.stringify(reordered);
  assert.doesNotMatch(reorderedSerialized, new RegExp(rawModel));
  assert.doesNotMatch(reorderedSerialized, new RegExp(otherRawModel));

  const slotAndAccountRows = [
    terminalLine({ model: rawModel, account_slot: 93, account_cohort_id: accountA }),
    terminalLine({ model: rawModel, account_slot: 17, account_cohort_id: accountB }),
    terminalLine({ model: rawModel, account_slot: 17, account_cohort_id: accountA }),
  ];
  const forwardDimensions = analyzeStage0CacheTelemetryLines(slotAndAccountRows).cache_dimension_cohorts;
  const reverseDimensions = analyzeStage0CacheTelemetryLines([...slotAndAccountRows].reverse()).cache_dimension_cohorts;
  assert.deepEqual(reverseDimensions, forwardDimensions);
  assert.doesNotMatch(JSON.stringify(forwardDimensions), /"account_slot":(?:17|93)/);
});

test("Stage 0 cache telemetry analyzer reports completed latency by cache dimension", () => {
  const report = analyzeStage0CacheTelemetryLines([
    terminalLine({ latency_ms: 10 }),
    terminalLine({ latency_ms: 20 }),
    terminalLine({ latency_ms: 100 }),
    terminalLine({ prompt_cache_mode: "explicit", prompt_cache_key_present: true }),
  ]);

  const latency = { observed_events: 3, min_ms: 10, p50_ms: 20, p95_ms: 100, max_ms: 100 };
  assert.deepEqual(report.completed_latency_ms, latency);
  assert.equal(report.cache_dimension_cohorts.length, 2);
  const implicit = report.cache_dimension_cohorts.find((cohort) => cohort.prompt_cache_mode === "unspecified" && !cohort.prompt_cache_key_present);
  assert.ok(implicit);
  assert.equal(implicit.completed_inference, 3);
  assert.deepEqual(implicit.completed_latency_ms, latency);
  const explicit = report.cache_dimension_cohorts.find((cohort) => cohort.prompt_cache_mode === "explicit" && cohort.prompt_cache_key_present);
  assert.ok(explicit);
  assert.equal(explicit.completed_inference, 1);
  assert.deepEqual(explicit.completed_latency_ms, {
    observed_events: 0,
    min_ms: null,
    p50_ms: null,
    p95_ms: null,
    max_ms: null,
  });
});

test("Stage 0 cache telemetry analyzer keeps invalid completed usage out of reported coverage", () => {
  const report = analyzeStage0CacheTelemetryLines([
    terminalLine({
      input_tokens: null,
      cached_input_tokens: null,
      cache_write_input_tokens: null,
      usage_observed: true,
      usage_telemetry_status: "invalid",
    }),
  ]);

  assert.equal(report.completed_inference, 1);
  assert.deepEqual(report.usage_telemetry_status_totals, { invalid: 1 });
  assert.deepEqual(report.reported_over_completed, { reported: 0, completed: 1, ratio: 0 });
  assert.equal(report.valid_reported_cache_metrics.reported_events, 0);
  assert.deepEqual(report.inference_terminal_outcomes.outcome_totals, {
    completed: 1,
    failed: 0,
    incomplete: 0,
    cancelled: 0,
  });
});

test("Stage 0 cache telemetry analyzer preserves model-unavailable account transitions", () => {
  // The terminal logger carries the selected account's routing reason on both
  // successful and failed requests after skipping a model-ineligible account.
  const routing = {
    model: "gpt-daybreak-blue-latest",
    account_slot: 2,
    account_cohort_id: "a".repeat(64),
    active_generation: 2,
    active_transition_reason: "model_unavailable",
  };
  const report = analyzeStage0CacheTelemetryLines([
    terminalLine({ ...routing, cached_input_tokens: 25 }),
    terminalLine({
      ...routing,
      status: 502,
      stream_terminal_type: "response.failed",
      input_tokens: null,
      cached_input_tokens: null,
      cache_write_input_tokens: null,
      usage_observed: false,
      usage_telemetry_status: "missing",
    }),
  ]);

  assert.deepEqual(report.inference_terminal_outcomes.active_transition_reason_totals, {
    none: 0,
    quota_exhausted: 0,
    credential_invalid: 0,
    account_removed_or_replaced: 0,
    model_unavailable: 2,
  });
  assert.deepEqual(report.inference_terminal_outcomes.outcome_totals, { completed: 1, failed: 1, incomplete: 0, cancelled: 0 });
  assert.equal(report.inference_terminal_outcomes.terminal_without_usage, 1);
  assert.equal(report.completed_inference, 1);
  assert.equal(report.cohorts.length, 1);
  assert.equal(report.cohorts[0].provider, "chatgpt_codex");
  assert.equal(report.cohorts[0].route, "responses");
  assert.equal(report.cohorts[0].completed_inference, 1);
  assert.equal(report.cache_dimension_cohorts.length, 1);
  assert.equal(report.cache_dimension_cohorts[0].account_cohort_id, routing.account_cohort_id);
  assert.deepEqual(report.valid_reported_cache_metrics.cache_read, {
    aggregate_input_tokens: 100,
    aggregate_cached_input_tokens: 25,
    ratio: 0.25,
  });
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([terminalLine({ ...routing, active_transition_reason: "model_unavailable_typo" })]),
    /invalid active_transition_reason field/
  );
});

test("Stage 0 cache telemetry analyzer reports bounded failed and incomplete terminal outcomes", () => {
  const rawCacheKey = "cache-key-secret-must-not-appear";
  const completed = terminalLine({
    model: "gpt-completed-secret",
    input_tokens: 100,
    cached_input_tokens: 50,
    cache_write_input_tokens: 0,
    prompt_cache_key: rawCacheKey,
    prompt_cache_key_present: true,
    prompt_cache_mode: "explicit",
    account_slot: 1,
    active_generation: 1,
    active_transition_reason: null,
  });
  const preferredUnavailable = terminalLine({
    model: "gpt-preferred-unavailable-secret",
    active_generation: null,
    active_transition_reason: "quota_exhausted",
  });
  const remapped = terminalLine({
    model: "gpt-remapped-secret",
    active_generation: 2,
    active_transition_reason: "account_removed_or_replaced",
  });
  const invalidCompleted = terminalLine({
    model: "gpt-invalid-secret",
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    usage_observed: true,
    usage_telemetry_status: "invalid",
    prompt_cache_key_present: false,
    prompt_cache_mode: "implicit",
    account_slot: 3,
    active_generation: 3,
    active_transition_reason: null,
  });
  const failedWithUsage = terminalLine({
    status: 502,
    model: "gpt-failed-secret",
    input_tokens: 80,
    cached_input_tokens: 32,
    cache_write_input_tokens: 8,
    stream: true,
    stream_terminal_type: "response.failed",
    prompt_cache_key: rawCacheKey,
    prompt_cache_key_present: true,
    prompt_cache_mode: "explicit",
    account_slot: 2,
    active_generation: null,
    active_transition_reason: "credential_invalid",
  });
  const failedWithoutUsage = terminalLine({
    status: 504,
    model: "gpt-failed-secret",
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    usage_observed: false,
    usage_telemetry_status: "missing",
    stream: true,
    stream_terminal_type: "response.failed",
    prompt_cache_key_present: false,
    prompt_cache_mode: "unspecified",
    account_slot: null,
    active_generation: null,
    active_transition_reason: null,
  });
  const incompleteWithUsage = terminalLine({
    route: "chat.completions",
    status: 200,
    provider: "metered",
    model: "gpt-incomplete-secret",
    input_tokens: 60,
    cached_input_tokens: 12,
    cache_write_input_tokens: null,
    stream: true,
    stream_terminal_type: "response.incomplete",
    prompt_cache_key_present: false,
    prompt_cache_mode: "legacy_retention",
    account_slot: 3,
    active_generation: 3,
    active_transition_reason: "quota_exhausted",
  });

  const report = analyzeStage0CacheTelemetryLines([
    completed,
    preferredUnavailable,
    remapped,
    invalidCompleted,
    failedWithUsage,
    failedWithoutUsage,
    incompleteWithUsage,
  ]);
  const completedOnlyReport = analyzeStage0CacheTelemetryLines([completed, preferredUnavailable, remapped, invalidCompleted]);
  const outcomes = report.inference_terminal_outcomes;

  // Failed and incomplete terminals are available for diagnosis but do not
  // participate in the completed-only evidence gates.
  assert.equal(report.completed_inference, 4);
  assert.deepEqual(report.gates, completedOnlyReport.gates);
  assert.deepEqual(report.cohorts, completedOnlyReport.cohorts);
  assert.deepEqual(report.usage_telemetry_status_totals, { invalid: 1, reported: 3 });
  assert.deepEqual(report.reported_over_completed, { reported: 3, completed: 4, ratio: 0.75 });

  assert.equal(outcomes.terminal_events, 7);
  assert.equal(outcomes.terminal_without_usage, 1);
  assert.deepEqual(outcomes.outcome_totals, { completed: 4, failed: 2, incomplete: 1, cancelled: 0 });
  assert.deepEqual(outcomes.usage_telemetry_status_totals, { invalid: 1, missing: 1, reported: 5 });
  assert.deepEqual(outcomes.prompt_cache_key_presence, { present: 2, absent: 5 });
  assert.deepEqual(outcomes.prompt_cache_mode_totals, {
    implicit: 1,
    explicit: 2,
    legacy_retention: 1,
    unspecified: 3,
  });
  assert.deepEqual(outcomes.account_slot_summary, {
    assigned_terminal_events: 4,
    unassigned_terminal_events: 3,
    distinct_assigned_slots: 3,
  });
  assert.deepEqual(outcomes.active_generation_summary, {
    assigned_terminal_events: 4,
    unassigned_terminal_events: 3,
  });
  assert.deepEqual(outcomes.active_transition_reason_totals, {
    none: 3,
    quota_exhausted: 2,
    credential_invalid: 1,
    account_removed_or_replaced: 1,
    model_unavailable: 0,
  });

  const failedCohort = outcomes.cohorts.find((cohort) => cohort.outcome === "failed" && cohort.usage_telemetry_status_totals.missing === 1);
  assert.ok(failedCohort);
  assert.equal(failedCohort.stream, true);
  assert.equal(failedCohort.terminal_events, 2);
  assert.equal(failedCohort.terminal_without_usage, 1);
  assert.deepEqual(failedCohort.valid_reported_cache_metrics.cache_read, {
    aggregate_input_tokens: 80,
    aggregate_cached_input_tokens: 32,
    ratio: 0.4,
  });
  assert.deepEqual(failedCohort.observed_cache_read_input_tokens, {
    sum_tokens: 32,
    observed_events: 1,
    null_events: 1,
    zero_events: 0,
    positive_events: 1,
  });

  const incompleteCohort = outcomes.cohorts.find((cohort) => cohort.outcome === "incomplete");
  assert.ok(incompleteCohort);
  assert.equal(incompleteCohort.route, "chat.completions");
  assert.equal(incompleteCohort.stream, true);
  assert.equal(incompleteCohort.observed_cache_read_input_tokens.sum_tokens, 12);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(rawCacheKey));
  assert.doesNotMatch(serialized, /gpt-(?:completed|invalid|failed|incomplete)-secret/);
  assert.doesNotMatch(serialized, /"account_slot":/);
});

test("Stage 0 cache telemetry analyzer retains every known inference terminal type outside eligibility", () => {
  const missingUsage = {
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    usage_observed: false,
    usage_telemetry_status: "missing",
    stream: true,
  };
  const report = analyzeStage0CacheTelemetryLines([
    terminalLine({ ...missingUsage, status: 502, stream_terminal_type: "error" }),
    terminalLine({ ...missingUsage, status: 200, stream_terminal_type: "eof" }),
    terminalLine({ ...missingUsage, status: 504, stream_terminal_type: "deadline" }),
    terminalLine({ ...missingUsage, status: 499, model: null, stream_terminal_type: "cancelled" }),
  ]);
  const outcomes = report.inference_terminal_outcomes;

  assert.equal(report.completed_inference, 0);
  assert.equal(report.gates.aggregate_completed_10k.observed_completed, 0);
  assert.deepEqual(outcomes.outcome_totals, {
    completed: 0,
    failed: 3,
    incomplete: 0,
    cancelled: 1,
  });
  assert.equal(outcomes.terminal_without_usage, 4);
  assert.deepEqual(
    outcomes.cohorts.map((cohort) => [cohort.outcome, cohort.stream_terminal_type]).sort((a, b) => compareAsText(a.join(","), b.join(","))),
    [
      ["cancelled", "cancelled"],
      ["failed", "deadline"],
      ["failed", "eof"],
      ["failed", "error"],
    ]
  );
  assert.equal(outcomes.cohorts.find((cohort) => cohort.outcome === "cancelled")?.model, "model_unknown");
});

test("Stage 0 cache telemetry analyzer applies aggregate, observed-cohort, and coverage thresholds", () => {
  const aggregateLines = Array.from({ length: STAGE0_AGGREGATE_MIN_COMPLETED }, () => terminalLine({ model: "gpt-large-cohort" }));
  const aggregateReport = analyzeStage0CacheTelemetryLines(aggregateLines);

  assert.equal(aggregateReport.gates.aggregate_completed_10k.passed, true);
  assert.equal(aggregateReport.gates.observed_cohort_completed_1k.all_observed_cohorts_passed, true);
  assert.equal(aggregateReport.gates.reported_coverage_99_5.observed_all_completed_passed, true);
  assert.equal(aggregateReport.gates.reported_coverage_99_5.all_observed_cohorts_passed, true);
  assert.equal(aggregateReport.gates.reported_coverage_99_5.minimum_ratio, STAGE0_MIN_REPORTED_COVERAGE);
  assert.equal(aggregateReport.gates.stage0_eligibility.status, "not_evaluated");
  assert.equal(aggregateReport.cohorts[0]?.completed_1k_gate.minimum_completed, STAGE0_COHORT_MIN_COMPLETED);

  const belowAggregateReport = analyzeStage0CacheTelemetryLines(aggregateLines.slice(0, STAGE0_AGGREGATE_MIN_COMPLETED - 1));
  assert.equal(belowAggregateReport.gates.aggregate_completed_10k.passed, false);

  const belowCohortReport = analyzeStage0CacheTelemetryLines(aggregateLines.slice(0, STAGE0_COHORT_MIN_COMPLETED - 1));
  assert.equal(belowCohortReport.cohorts[0]?.completed_1k_gate.passed, false);
  const qualifyingCohortReport = analyzeStage0CacheTelemetryLines(aggregateLines.slice(0, STAGE0_COHORT_MIN_COMPLETED));
  assert.equal(qualifyingCohortReport.cohorts[0]?.completed_1k_gate.passed, true);

  const coverageReport = analyzeStage0CacheTelemetryLines([
    ...Array.from({ length: 199 }, () => terminalLine()),
    terminalLine({ model: "gpt-no-telemetry", cached_input_tokens: null, usage_telemetry_status: "partial" }),
  ]);
  assert.equal(coverageReport.reported_over_completed.ratio, 0.995);
  assert.equal(coverageReport.gates.reported_coverage_99_5.observed_all_completed_passed, true);
  assert.equal(coverageReport.gates.reported_coverage_99_5.all_observed_cohorts_passed, false);
  assert.equal(coverageReport.cohorts.find((cohort) => cohort.usage_telemetry_status_totals.partial === 1)?.reported_coverage_99_5_gate.passed, false);

  const belowCoverageReport = analyzeStage0CacheTelemetryLines([
    ...Array.from({ length: 198 }, () => terminalLine()),
    terminalLine({ cached_input_tokens: null, usage_telemetry_status: "partial" }),
    terminalLine({ cached_input_tokens: null, usage_telemetry_status: "partial" }),
  ]);
  assert.equal(belowCoverageReport.gates.reported_coverage_99_5.observed_all_completed_passed, false);
});

test("Stage 0 cache telemetry analyzer fails closed without echoing request-level data", () => {
  const secret = "must-not-appear-in-errors-or-output";
  const malformed = `${TERMINAL_MARKER} {"request_id":"${secret}"`;
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([malformed]),
    (error: unknown) => {
      assert.ok(error instanceof Stage0CacheTelemetryGateError);
      assert.match(error.message, /malformed JSON/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );

  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine(), terminalLine({ deno_revision: "deploy-b" })]), /release identity differs/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ git_sha: "unknown" })]), /missing release identity/);
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([terminalLine({ git_sha: secret })]),
    (error: unknown) => {
      assert.ok(error instanceof Stage0CacheTelemetryGateError);
      assert.match(error.message, /invalid git_sha field/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([terminalLine({ request_id: `${secret}\u0001` })]),
    (error: unknown) => {
      assert.ok(error instanceof Stage0CacheTelemetryGateError);
      assert.match(error.message, /invalid request_id field/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ request_id: "x".repeat(129) })]), /invalid request_id field/);
  const releasePayload = "release-secret-must-not-appear";
  const redactedReleaseReport = analyzeStage0CacheTelemetryLines([terminalLine({ deno_revision: releasePayload, router_revision: releasePayload })]);
  assert.deepEqual(redactedReleaseReport.release, {
    git_sha: "0123456789abcdef",
    deno_revision: "validated",
    router_revision: "validated",
  });
  assert.doesNotMatch(JSON.stringify(redactedReleaseReport), new RegExp(releasePayload));
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ provider: null })]), /invalid provider field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ model: null })]), /invalid model field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ route: "response_typo" })]), /unsupported route field/);
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([terminalLine({ stream_terminal_type: "response.finished" })]),
    /unsupported stream_terminal_type field/
  );
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ status: 500 })]), /completed inference event has a non-2xx status field/);
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([terminalLine({ provider: "provider-secret" })]),
    /inference terminal event has an unsupported provider field/
  );
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ model: "x".repeat(129) })]), /inference terminal event has an invalid model field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ usage_observed: false })]), /inconsistent usage_observed/);
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([terminalLine({ input_tokens: null })]),
    /reported inference terminal event is missing cache-read usage fields/
  );
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ cached_input_tokens: "0" })]), /invalid cached_input_tokens field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ cache_write_input_tokens: -1 })]), /invalid cache_write_input_tokens field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ prompt_cache_key_present: "yes" })]), /invalid prompt_cache_key_present field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ prompt_cache_mode: "unknown" })]), /invalid prompt_cache_mode field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ account_slot: -1 })]), /invalid account_slot field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ account_cohort_id: "not-a-sha256-digest" })]), /invalid account_cohort_id field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ active_generation: 0 })]), /invalid active_generation field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ active_transition_reason: "sticky" })]), /invalid active_transition_reason field/);
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([terminalLine({ active_transition_reason: "none" })]),
    /invalid active_transition_reason field/,
    "string none is only the aggregate null bucket, never a wire reason"
  );
  assert.throws(() => analyzeStage0CacheTelemetryLines([terminalLine({ stream: "true" })]), /invalid stream field/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([JSON.stringify({ message: terminalLine() })]), /must use raw log text or a string body envelope/);
  assert.throws(() => analyzeStage0CacheTelemetryLines([`untrusted prefix ${terminalLine()}`]), /must begin with the canonical terminal marker/);
  assert.throws(
    () => analyzeStage0CacheTelemetryLines([JSON.stringify({ body: `untrusted prefix ${terminalLine()}` })]),
    /must begin with the canonical terminal marker/
  );

  const duplicateRequestId = `req-${secret}`;
  const duplicateLines = Array.from({ length: STAGE0_AGGREGATE_MIN_COMPLETED }, () => terminalLine({ request_id: duplicateRequestId }));
  assert.throws(
    () => analyzeStage0CacheTelemetryLines(duplicateLines),
    (error: unknown) => {
      assert.ok(error instanceof Stage0CacheTelemetryGateError);
      assert.match(error.message, /duplicate request_terminal event/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );

  const report = analyzeStage0CacheTelemetryLines([
    terminalLine({
      client_id: secret,
      key_id: secret,
      prompt: secret,
      prompt_cache_key: secret,
      request_id: secret,
    }),
  ]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));

  const modelSecret = "secret-token-abc";
  const modelReport = analyzeStage0CacheTelemetryLines([terminalLine({ model: modelSecret })]);
  assert.equal(modelReport.cohorts[0]?.model, "model_1");
  assert.doesNotMatch(JSON.stringify(modelReport), new RegExp(modelSecret));
});

test("Stage 0 cache telemetry analyzer accepts strict JSON body log envelopes without exposing envelope data", () => {
  const secret = "envelope-secret";
  const report = analyzeStage0CacheTelemetryLines([
    JSON.stringify({
      body: terminalLine({ request_id: "req-envelope", client_id: secret, prompt_cache_key: secret }),
      request_id: secret,
      client_id: secret,
    }),
  ]);

  assert.equal(report.completed_inference, 1);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));

  const infoReport = analyzeStage0CacheTelemetryLines([`INFO ${terminalLine({ request_id: "req-info" })}`]);
  assert.equal(infoReport.completed_inference, 1);
  const infoEnvelopeReport = analyzeStage0CacheTelemetryLines([JSON.stringify({ body: `INFO ${terminalLine({ request_id: "req-info-envelope" })}` })]);
  assert.equal(infoEnvelopeReport.completed_inference, 1);
});

test("Stage 0 cache telemetry analyzer rejects an empty input stream", () => {
  assert.throws(() => analyzeStage0CacheTelemetryLines([]), /no request_terminal events/);
});
