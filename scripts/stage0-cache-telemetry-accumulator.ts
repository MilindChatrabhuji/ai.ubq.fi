// Stage 0 telemetry accumulator, split out of scripts/stage0-cache-telemetry-gate.ts.

import { createHash } from "node:crypto";

import {
  ACTIVE_TRANSITION_REASON_KEYS,
  type CacheDimensionCohortReport,
  type CacheTokenSummary,
  INFERENCE_TERMINAL_OUTCOMES,
  type InferenceOutcomeCohortReport,
  type InferenceProvider,
  type InferenceRoute,
  type InferenceTerminalOutcome,
  type LatencySummary,
  MAX_RETAINED_REQUEST_IDS,
  type MutableCacheDimensionCohort,
  type MutableCacheTokenSummary,
  type MutableCohort,
  type MutableInferenceOutcomeCohort,
  type MutableLatencySummary,
  type MutableValidReportedCacheMetrics,
  PROMPT_CACHE_MODE_VALUES,
  type PromptCacheMode,
  type ReleaseIdentity,
  type ReleaseReportIdentity,
  STAGE0_AGGREGATE_MIN_COMPLETED,
  STAGE0_COHORT_MIN_COMPLETED,
  STAGE0_MIN_REPORTED_COVERAGE,
  Stage0CacheTelemetryGateError,
  type Stage0CacheTelemetryReport,
  type Stage0CohortReport,
  type TerminalEvent,
  type UsageTelemetryStatus,
  type ValidReportedCacheMetrics,
} from "./stage0-cache-telemetry-types.ts";
import { fail, parseTerminalEvent } from "./stage0-cache-telemetry-parse.ts";

const createCacheTokenSummary = (): MutableCacheTokenSummary => ({
  sum_tokens: 0,
  observed_events: 0,
  null_events: 0,
  zero_events: 0,
  positive_events: 0,
});

const createValidReportedCacheMetrics = (): MutableValidReportedCacheMetrics => ({
  reported_events: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_observed_events: 0,
  cache_write_cached_input_tokens: 0,
  cache_write_input_tokens: 0,
});

const addSafely = (left: number, right: number, lineNumber: number): number => {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) fail(lineNumber, "terminal event aggregation exceeds the safe integer range");
  return sum;
};

const increment = <TKey extends string>(counts: Map<TKey, number>, key: TKey, lineNumber: number): void => {
  counts.set(key, addSafely(counts.get(key) ?? 0, 1, lineNumber));
};

const addCacheToken = (summary: MutableCacheTokenSummary, value: number | null, lineNumber: number): void => {
  if (value === null) {
    summary.null_events = addSafely(summary.null_events, 1, lineNumber);
    return;
  }

  summary.sum_tokens = addSafely(summary.sum_tokens, value, lineNumber);
  summary.observed_events = addSafely(summary.observed_events, 1, lineNumber);
  if (value === 0) summary.zero_events = addSafely(summary.zero_events, 1, lineNumber);
  else summary.positive_events = addSafely(summary.positive_events, 1, lineNumber);
};

const toCacheTokenSummary = (summary: MutableCacheTokenSummary): CacheTokenSummary => ({ ...summary });

const addLatency = (summary: MutableLatencySummary, value: number | null): void => {
  if (value !== null) summary.push(value);
};

const toLatencySummary = (summary: MutableLatencySummary): LatencySummary => {
  if (summary.length === 0) {
    return { observed_events: 0, min_ms: null, p50_ms: null, p95_ms: null, max_ms: null };
  }
  const sorted = [...summary].sort((left, right) => left - right);
  const percentile = (ratio: number): number => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  return {
    observed_events: sorted.length,
    min_ms: sorted[0],
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: sorted[sorted.length - 1],
  };
};

const addValidReportedCacheMetrics = (metrics: MutableValidReportedCacheMetrics, event: TerminalEvent, lineNumber: number): void => {
  if (event.usage_telemetry_status !== "reported" || event.input_tokens === null || event.cached_input_tokens === null) return;

  metrics.reported_events = addSafely(metrics.reported_events, 1, lineNumber);
  metrics.input_tokens = addSafely(metrics.input_tokens, event.input_tokens, lineNumber);
  metrics.cached_input_tokens = addSafely(metrics.cached_input_tokens, event.cached_input_tokens, lineNumber);
  if (event.cache_write_input_tokens === null) return;

  metrics.cache_write_observed_events = addSafely(metrics.cache_write_observed_events, 1, lineNumber);
  metrics.cache_write_cached_input_tokens = addSafely(metrics.cache_write_cached_input_tokens, event.cached_input_tokens, lineNumber);
  metrics.cache_write_input_tokens = addSafely(metrics.cache_write_input_tokens, event.cache_write_input_tokens, lineNumber);
};

const toValidReportedCacheMetrics = (metrics: MutableValidReportedCacheMetrics): ValidReportedCacheMetrics => ({
  reported_events: metrics.reported_events,
  cache_read: {
    aggregate_input_tokens: metrics.input_tokens,
    aggregate_cached_input_tokens: metrics.cached_input_tokens,
    ratio: metrics.input_tokens === 0 ? null : metrics.cached_input_tokens / metrics.input_tokens,
  },
  cache_write_payback: {
    observed_events: metrics.cache_write_observed_events,
    aggregate_cached_input_tokens: metrics.cache_write_cached_input_tokens,
    aggregate_cache_write_input_tokens: metrics.cache_write_input_tokens,
    ratio: metrics.cache_write_input_tokens === 0 ? null : metrics.cache_write_cached_input_tokens / metrics.cache_write_input_tokens,
  },
});

const toSortedCounts = <TKey extends string>(counts: Map<TKey, number>): Record<TKey, number> =>
  Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) as Record<TKey, number>;

const toFixedCounts = <TKey extends string>(keys: readonly TKey[], counts: Map<TKey, number>): Record<TKey, number> =>
  Object.fromEntries(keys.map((key) => [key, counts.get(key) ?? 0])) as Record<TKey, number>;

const toOpaqueModelLabels = (models: Iterable<string>): Map<string, string> =>
  new Map([...new Set(models)].sort((left, right) => left.localeCompare(right)).map((model, index) => [model, `model_${index + 1}`] as const));

const stableOpaqueLabel = (domain: string, value: string): string => createHash("sha256").update(`${domain}\u0000${value}`).digest("hex");

/**
 * Reads an opaque cohort label this pass already registered.  A miss is an
 * internal invariant violation, and it must never fall back to the raw label:
 * these labels exist to keep provider model names and account slots opaque.
 */
const requireOpaqueLabel = <TKey>(labels: ReadonlyMap<TKey, string>, key: TKey): string => {
  const label = labels.get(key);
  if (label === undefined) throw new Error("opaque cohort label is missing for an observed cohort");
  return label;
};

const extendOpaqueModelLabels = (labels: ReadonlyMap<string, string>, models: Iterable<string>): Map<string, string> => {
  const extended = new Map(labels);
  for (const model of [...new Set(models)].filter((model) => !extended.has(model)).sort((left, right) => left.localeCompare(right))) {
    extended.set(model, `model_${extended.size + 1}`);
  }
  return extended;
};

const reportedOverCompleted = (reported: number, completed: number): { reported: number; completed: number; ratio: number | null } => ({
  reported,
  completed,
  ratio: completed === 0 ? null : reported / completed,
});

const sameRelease = (left: ReleaseIdentity, right: ReleaseIdentity): boolean =>
  left.git_sha === right.git_sha && left.deno_revision === right.deno_revision && left.router_revision === right.router_revision;

const toReleaseReportIdentity = (release: ReleaseIdentity): ReleaseReportIdentity => ({
  git_sha: release.git_sha,
  deno_revision: "validated",
  router_revision: release.router_revision === null ? null : "validated",
});

class Stage0CacheTelemetryAccumulator {
  #release: ReleaseIdentity | null = null;
  // Retained only for the current stdin stream. Request identifiers are never
  // included in errors or output, but a duplicated terminal event must not
  // inflate a Stage 0 evidence gate.
  #seenRequestIds = new Set<string>();
  #terminalEvents = 0;
  #completedInference = 0;
  #reportedCompleted = 0;
  #statusTotals = new Map<string, number>();
  #completedStatusTotals = new Map<string, number>();
  #usageTelemetryStatusTotals = new Map<UsageTelemetryStatus, number>();
  #validReportedCacheMetrics = createValidReportedCacheMetrics();
  #cacheReadInputTokens = createCacheTokenSummary();
  #cacheWriteInputTokens = createCacheTokenSummary();
  #completedLatencyMs: MutableLatencySummary = [];
  #cohorts = new Map<string, MutableCohort>();
  #cacheDimensionCohorts = new Map<string, MutableCacheDimensionCohort>();
  #inferenceTerminalEvents = 0;
  #inferenceTerminalWithoutUsage = 0;
  #inferenceOutcomeTotals = new Map<InferenceTerminalOutcome, number>();
  #inferenceUsageTelemetryStatusTotals = new Map<UsageTelemetryStatus, number>();
  #promptCacheKeyPresentEvents = 0;
  #promptCacheKeyAbsentEvents = 0;
  #promptCacheModeTotals = new Map<PromptCacheMode, number>();
  #assignedAccountSlotEvents = 0;
  #unassignedAccountSlotEvents = 0;
  #assignedAccountSlots = new Set<number>();
  #assignedActiveGenerationEvents = 0;
  #unassignedActiveGenerationEvents = 0;
  #activeTransitionReasonTotals = new Map<(typeof ACTIVE_TRANSITION_REASON_KEYS)[number], number>();
  #inferenceOutcomeCohorts = new Map<string, MutableInferenceOutcomeCohort>();

  addLine(line: string, lineNumber: number): void {
    const event = parseTerminalEvent(line, lineNumber);
    if (event === null) return;

    if (this.#seenRequestIds.has(event.request_id)) {
      fail(lineNumber, "duplicate request_terminal event");
    }
    if (this.#seenRequestIds.size >= MAX_RETAINED_REQUEST_IDS) {
      fail(lineNumber, "request_terminal event retention limit exceeded");
    }
    this.#seenRequestIds.add(event.request_id);
    this.#terminalEvents = addSafely(this.#terminalEvents, 1, lineNumber);
    increment(this.#statusTotals, String(event.status), lineNumber);

    if (this.#release === null) this.#release = event.release;
    else if (!sameRelease(this.#release, event.release)) {
      fail(lineNumber, "terminal event release identity differs from an earlier terminal event");
    }

    if (event.inference_outcome !== null) this.#addInferenceOutcome(event, lineNumber);
    if (event.inference_outcome !== "completed") return;
    const provider = (event.provider ?? fail(lineNumber, "completed inference event is missing a provider or model")) as InferenceProvider;
    const model = event.model ?? fail(lineNumber, "completed inference event is missing a provider or model");
    const route = event.route as InferenceRoute;

    this.#completedInference = addSafely(this.#completedInference, 1, lineNumber);
    increment(this.#completedStatusTotals, String(event.status), lineNumber);
    increment(this.#usageTelemetryStatusTotals, event.usage_telemetry_status, lineNumber);
    if (event.usage_telemetry_status === "reported") {
      this.#reportedCompleted = addSafely(this.#reportedCompleted, 1, lineNumber);
    }
    addValidReportedCacheMetrics(this.#validReportedCacheMetrics, event, lineNumber);
    addCacheToken(this.#cacheReadInputTokens, event.cached_input_tokens, lineNumber);
    addCacheToken(this.#cacheWriteInputTokens, event.cache_write_input_tokens, lineNumber);
    addLatency(this.#completedLatencyMs, event.latency_ms);

    const key = JSON.stringify([provider, model, event.route]);
    const existingCohort = this.#cohorts.get(key);
    let cohort: MutableCohort;
    if (existingCohort === undefined) {
      cohort = {
        provider,
        model,
        route: event.route,
        completed_inference: 0,
        status_totals: new Map(),
        usage_telemetry_status_totals: new Map(),
        valid_reported_cache_metrics: createValidReportedCacheMetrics(),
        cache_read_input_tokens: createCacheTokenSummary(),
        cache_write_input_tokens: createCacheTokenSummary(),
        reported: 0,
      };
      this.#cohorts.set(key, cohort);
    } else cohort = existingCohort;
    cohort.completed_inference = addSafely(cohort.completed_inference, 1, lineNumber);
    increment(cohort.status_totals, String(event.status), lineNumber);
    increment(cohort.usage_telemetry_status_totals, event.usage_telemetry_status, lineNumber);
    if (event.usage_telemetry_status === "reported") {
      cohort.reported = addSafely(cohort.reported, 1, lineNumber);
    }
    addValidReportedCacheMetrics(cohort.valid_reported_cache_metrics, event, lineNumber);
    addCacheToken(cohort.cache_read_input_tokens, event.cached_input_tokens, lineNumber);
    addCacheToken(cohort.cache_write_input_tokens, event.cache_write_input_tokens, lineNumber);

    const cacheDimensionKey = JSON.stringify([
      provider,
      model,
      route,
      event.account_slot,
      event.account_cohort_id,
      event.prompt_cache_mode,
      event.prompt_cache_key_present,
    ]);
    const existingCacheDimensionCohort = this.#cacheDimensionCohorts.get(cacheDimensionKey);
    let cacheDimensionCohort: MutableCacheDimensionCohort;
    if (existingCacheDimensionCohort === undefined) {
      cacheDimensionCohort = {
        provider,
        model,
        route,
        account_slot: event.account_slot,
        account_cohort_id: event.account_cohort_id,
        prompt_cache_mode: event.prompt_cache_mode,
        prompt_cache_key_present: event.prompt_cache_key_present,
        completed_inference: 0,
        status_totals: new Map(),
        usage_telemetry_status_totals: new Map(),
        valid_reported_cache_metrics: createValidReportedCacheMetrics(),
        cache_read_input_tokens: createCacheTokenSummary(),
        cache_write_input_tokens: createCacheTokenSummary(),
        latency_ms: [],
      };
      this.#cacheDimensionCohorts.set(cacheDimensionKey, cacheDimensionCohort);
    } else cacheDimensionCohort = existingCacheDimensionCohort;
    cacheDimensionCohort.completed_inference = addSafely(cacheDimensionCohort.completed_inference, 1, lineNumber);
    increment(cacheDimensionCohort.status_totals, String(event.status), lineNumber);
    increment(cacheDimensionCohort.usage_telemetry_status_totals, event.usage_telemetry_status, lineNumber);
    addValidReportedCacheMetrics(cacheDimensionCohort.valid_reported_cache_metrics, event, lineNumber);
    addCacheToken(cacheDimensionCohort.cache_read_input_tokens, event.cached_input_tokens, lineNumber);
    addCacheToken(cacheDimensionCohort.cache_write_input_tokens, event.cache_write_input_tokens, lineNumber);
    addLatency(cacheDimensionCohort.latency_ms, event.latency_ms);
  }

  #addInferenceOutcome(event: TerminalEvent, lineNumber: number): void {
    const outcome = event.inference_outcome ?? fail(lineNumber, "inference terminal event is missing an outcome");
    const provider = event.provider;
    const model = event.model;
    const streamTerminalType = event.stream_terminal_type ?? fail(lineNumber, "inference terminal event is missing a stream_terminal_type");
    const route: InferenceRoute =
      event.route === "responses" || event.route === "chat.completions" ? event.route : fail(lineNumber, "inference terminal event has an invalid route field");

    this.#inferenceTerminalEvents = addSafely(this.#inferenceTerminalEvents, 1, lineNumber);
    increment(this.#inferenceOutcomeTotals, outcome, lineNumber);
    increment(this.#inferenceUsageTelemetryStatusTotals, event.usage_telemetry_status, lineNumber);
    if (event.prompt_cache_key_present) {
      this.#promptCacheKeyPresentEvents = addSafely(this.#promptCacheKeyPresentEvents, 1, lineNumber);
    } else {
      this.#promptCacheKeyAbsentEvents = addSafely(this.#promptCacheKeyAbsentEvents, 1, lineNumber);
    }
    increment(this.#promptCacheModeTotals, event.prompt_cache_mode, lineNumber);
    if (event.account_slot === null) {
      this.#unassignedAccountSlotEvents = addSafely(this.#unassignedAccountSlotEvents, 1, lineNumber);
    } else {
      this.#assignedAccountSlotEvents = addSafely(this.#assignedAccountSlotEvents, 1, lineNumber);
      this.#assignedAccountSlots.add(event.account_slot);
    }
    increment(this.#activeTransitionReasonTotals, event.active_transition_reason ?? "none", lineNumber);
    if (event.active_generation === null) {
      this.#unassignedActiveGenerationEvents = addSafely(this.#unassignedActiveGenerationEvents, 1, lineNumber);
    } else {
      this.#assignedActiveGenerationEvents = addSafely(this.#assignedActiveGenerationEvents, 1, lineNumber);
    }

    const key = JSON.stringify([provider, model, route, event.stream, outcome, streamTerminalType]);
    const existingCohort = this.#inferenceOutcomeCohorts.get(key);
    let cohort: MutableInferenceOutcomeCohort;
    if (existingCohort === undefined) {
      cohort = {
        provider,
        model,
        route,
        stream: event.stream,
        outcome,
        stream_terminal_type: streamTerminalType,
        terminal_events: 0,
        terminal_without_usage: 0,
        status_totals: new Map(),
        usage_telemetry_status_totals: new Map(),
        valid_reported_cache_metrics: createValidReportedCacheMetrics(),
        cache_read_input_tokens: createCacheTokenSummary(),
        cache_write_input_tokens: createCacheTokenSummary(),
      };
      this.#inferenceOutcomeCohorts.set(key, cohort);
    } else cohort = existingCohort;

    cohort.terminal_events = addSafely(cohort.terminal_events, 1, lineNumber);
    increment(cohort.status_totals, String(event.status), lineNumber);
    increment(cohort.usage_telemetry_status_totals, event.usage_telemetry_status, lineNumber);
    if (event.usage_telemetry_status === "missing") {
      this.#inferenceTerminalWithoutUsage = addSafely(this.#inferenceTerminalWithoutUsage, 1, lineNumber);
      cohort.terminal_without_usage = addSafely(cohort.terminal_without_usage, 1, lineNumber);
    }
    addValidReportedCacheMetrics(cohort.valid_reported_cache_metrics, event, lineNumber);
    addCacheToken(cohort.cache_read_input_tokens, event.cached_input_tokens, lineNumber);
    addCacheToken(cohort.cache_write_input_tokens, event.cache_write_input_tokens, lineNumber);
  }

  finish(): Stage0CacheTelemetryReport {
    if (this.#terminalEvents === 0 || this.#release === null) {
      throw new Stage0CacheTelemetryGateError("no request_terminal events were found on stdin");
    }

    const coverage = reportedOverCompleted(this.#reportedCompleted, this.#completedInference);
    const modelCohortLabels = toOpaqueModelLabels([...this.#cohorts.values()].map((cohort) => cohort.model));
    const accountSlotCohortLabels = new Map(
      [...new Set([...this.#cacheDimensionCohorts.values()].map((cohort) => cohort.account_slot).filter((slot): slot is number => slot !== null))]
        .sort((left, right) => left - right)
        .map((slot, index) => [slot, `slot_${index + 1}`] as const)
    );
    const outcomeModelCohortLabels = extendOpaqueModelLabels(
      modelCohortLabels,
      [...this.#inferenceOutcomeCohorts.values()].map((cohort) => cohort.model).filter((model): model is string => model !== null)
    );
    const cohorts = [...this.#cohorts.values()]
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model) || left.route.localeCompare(right.route))
      .map((cohort): Stage0CohortReport => {
        const cohortCoverage = reportedOverCompleted(cohort.reported, cohort.completed_inference);
        return {
          provider: cohort.provider,
          model: requireOpaqueLabel(modelCohortLabels, cohort.model),
          route: cohort.route,
          completed_inference: cohort.completed_inference,
          status_totals: toSortedCounts(cohort.status_totals),
          usage_telemetry_status_totals: toSortedCounts(cohort.usage_telemetry_status_totals),
          valid_reported_cache_metrics: toValidReportedCacheMetrics(cohort.valid_reported_cache_metrics),
          observed_completed_cache_read_input_tokens: toCacheTokenSummary(cohort.cache_read_input_tokens),
          observed_completed_cache_write_input_tokens: toCacheTokenSummary(cohort.cache_write_input_tokens),
          reported_over_completed: cohortCoverage,
          completed_1k_gate: {
            minimum_completed: STAGE0_COHORT_MIN_COMPLETED,
            observed_completed: cohort.completed_inference,
            passed: cohort.completed_inference >= STAGE0_COHORT_MIN_COMPLETED,
          },
          reported_coverage_99_5_gate: {
            minimum_ratio: STAGE0_MIN_REPORTED_COVERAGE,
            reported: cohortCoverage.reported,
            completed: cohortCoverage.completed,
            ratio: cohortCoverage.ratio,
            passed: (cohortCoverage.ratio ?? 0) >= STAGE0_MIN_REPORTED_COVERAGE,
          },
        };
      });
    const cacheDimensionCohorts = [...this.#cacheDimensionCohorts.values()]
      .sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.model.localeCompare(right.model) ||
          left.route.localeCompare(right.route) ||
          (left.account_slot === null ? "unassigned" : requireOpaqueLabel(accountSlotCohortLabels, left.account_slot)).localeCompare(
            right.account_slot === null ? "unassigned" : requireOpaqueLabel(accountSlotCohortLabels, right.account_slot)
          ) ||
          (left.account_cohort_id ?? "").localeCompare(right.account_cohort_id ?? "") ||
          left.prompt_cache_mode.localeCompare(right.prompt_cache_mode) ||
          Number(left.prompt_cache_key_present) - Number(right.prompt_cache_key_present)
      )
      .map((cohort): CacheDimensionCohortReport => ({
        provider: cohort.provider,
        model: requireOpaqueLabel(modelCohortLabels, cohort.model),
        model_cohort_id: stableOpaqueLabel("uos-prompt-cache-telemetry-model-v1", cohort.model),
        route: cohort.route,
        account_slot_cohort: cohort.account_slot === null ? "unassigned" : requireOpaqueLabel(accountSlotCohortLabels, cohort.account_slot),
        account_cohort_id: cohort.account_cohort_id,
        prompt_cache_mode: cohort.prompt_cache_mode,
        prompt_cache_key_present: cohort.prompt_cache_key_present,
        completed_inference: cohort.completed_inference,
        status_totals: toSortedCounts(cohort.status_totals),
        usage_telemetry_status_totals: toSortedCounts(cohort.usage_telemetry_status_totals),
        valid_reported_cache_metrics: toValidReportedCacheMetrics(cohort.valid_reported_cache_metrics),
        observed_completed_cache_read_input_tokens: toCacheTokenSummary(cohort.cache_read_input_tokens),
        observed_completed_cache_write_input_tokens: toCacheTokenSummary(cohort.cache_write_input_tokens),
        completed_latency_ms: toLatencySummary(cohort.latency_ms),
      }));
    const inferenceOutcomeCohorts = [...this.#inferenceOutcomeCohorts.values()]
      .sort(
        (left, right) =>
          (left.provider ?? "unknown").localeCompare(right.provider ?? "unknown") ||
          (left.model ?? "").localeCompare(right.model ?? "") ||
          left.route.localeCompare(right.route) ||
          String(left.stream).localeCompare(String(right.stream)) ||
          left.outcome.localeCompare(right.outcome) ||
          left.stream_terminal_type.localeCompare(right.stream_terminal_type)
      )
      .map((cohort): InferenceOutcomeCohortReport => ({
        provider: cohort.provider ?? "unknown",
        model: cohort.model === null ? "model_unknown" : requireOpaqueLabel(outcomeModelCohortLabels, cohort.model),
        route: cohort.route,
        stream: cohort.stream,
        outcome: cohort.outcome,
        stream_terminal_type: cohort.stream_terminal_type,
        terminal_events: cohort.terminal_events,
        terminal_without_usage: cohort.terminal_without_usage,
        status_totals: toSortedCounts(cohort.status_totals),
        usage_telemetry_status_totals: toSortedCounts(cohort.usage_telemetry_status_totals),
        valid_reported_cache_metrics: toValidReportedCacheMetrics(cohort.valid_reported_cache_metrics),
        observed_cache_read_input_tokens: toCacheTokenSummary(cohort.cache_read_input_tokens),
        observed_cache_write_input_tokens: toCacheTokenSummary(cohort.cache_write_input_tokens),
      }));
    const passingCohorts = cohorts.filter((cohort) => cohort.completed_1k_gate.passed).length;
    const coveragePassingCohorts = cohorts.filter((cohort) => cohort.reported_coverage_99_5_gate.passed).length;

    return {
      version: 1,
      release: toReleaseReportIdentity(this.#release),
      terminal_events: this.#terminalEvents,
      status_totals: toSortedCounts(this.#statusTotals),
      completed_inference: this.#completedInference,
      completed_status_totals: toSortedCounts(this.#completedStatusTotals),
      usage_telemetry_status_totals: toSortedCounts(this.#usageTelemetryStatusTotals),
      valid_reported_cache_metrics: toValidReportedCacheMetrics(this.#validReportedCacheMetrics),
      observed_completed_cache_read_input_tokens: toCacheTokenSummary(this.#cacheReadInputTokens),
      observed_completed_cache_write_input_tokens: toCacheTokenSummary(this.#cacheWriteInputTokens),
      completed_latency_ms: toLatencySummary(this.#completedLatencyMs),
      reported_over_completed: coverage,
      gates: {
        aggregate_completed_10k: {
          minimum_completed: STAGE0_AGGREGATE_MIN_COMPLETED,
          observed_completed: this.#completedInference,
          passed: this.#completedInference >= STAGE0_AGGREGATE_MIN_COMPLETED,
        },
        observed_cohort_completed_1k: {
          minimum_completed_per_cohort: STAGE0_COHORT_MIN_COMPLETED,
          selection: "all_observed_provider_model_route_cohorts",
          material_use_selection: "not_available_from_terminal_events",
          passing_cohorts: passingCohorts,
          below_threshold_cohorts: cohorts.length - passingCohorts,
          all_observed_cohorts_passed: cohorts.length > 0 && passingCohorts === cohorts.length,
        },
        reported_coverage_99_5: {
          minimum_ratio: STAGE0_MIN_REPORTED_COVERAGE,
          reported: coverage.reported,
          completed: coverage.completed,
          observed_all_completed_passed: coverage.ratio !== null && coverage.ratio >= STAGE0_MIN_REPORTED_COVERAGE,
          passing_observed_cohorts: coveragePassingCohorts,
          below_threshold_observed_cohorts: cohorts.length - coveragePassingCohorts,
          all_observed_cohorts_passed: cohorts.length > 0 && coveragePassingCohorts === cohorts.length,
          supported_model_membership: "not_available_from_terminal_events",
        },
        stage0_eligibility: {
          status: "not_evaluated",
          reason: "supported-model membership and materially-used cohort selection are not available in terminal events",
        },
      },
      cohorts,
      cache_dimension_cohorts: cacheDimensionCohorts,
      inference_terminal_outcomes: {
        terminal_events: this.#inferenceTerminalEvents,
        terminal_without_usage: this.#inferenceTerminalWithoutUsage,
        outcome_totals: toFixedCounts(INFERENCE_TERMINAL_OUTCOMES, this.#inferenceOutcomeTotals),
        usage_telemetry_status_totals: toSortedCounts(this.#inferenceUsageTelemetryStatusTotals),
        prompt_cache_key_presence: {
          present: this.#promptCacheKeyPresentEvents,
          absent: this.#promptCacheKeyAbsentEvents,
        },
        prompt_cache_mode_totals: toFixedCounts(PROMPT_CACHE_MODE_VALUES, this.#promptCacheModeTotals),
        account_slot_summary: {
          assigned_terminal_events: this.#assignedAccountSlotEvents,
          unassigned_terminal_events: this.#unassignedAccountSlotEvents,
          distinct_assigned_slots: this.#assignedAccountSlots.size,
        },
        active_generation_summary: {
          assigned_terminal_events: this.#assignedActiveGenerationEvents,
          unassigned_terminal_events: this.#unassignedActiveGenerationEvents,
        },
        active_transition_reason_totals: toFixedCounts(ACTIVE_TRANSITION_REASON_KEYS, this.#activeTransitionReasonTotals),
        cohorts: inferenceOutcomeCohorts,
      },
    };
  }
}

export { Stage0CacheTelemetryAccumulator };
