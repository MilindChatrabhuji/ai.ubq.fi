import { KvU64 } from "#kv";
import type { Kv, KvEntryMaybe, KvKey } from "#kv";
import { getKv } from "../kv.ts";
import { RELEASE_GIT_SHA } from "../release.ts";
import { sha256Hex } from "../utils.ts";

/**
 * Durable Stage 0 evidence is deliberately scoped to an immutable artifact.
 * A local checkout has `unknown` baked into release.ts, so it can never create
 * evidence that a deployed cache-scope experiment could consume.
 */
export const PROMPT_CACHE_TELEMETRY_GATE_KV_PREFIX = ["uos_ai", "prompt_cache_telemetry_gate", "v1"] as const;
export const PROMPT_CACHE_TELEMETRY_MIN_COMPLETED = 10_000;
export const PROMPT_CACHE_TELEMETRY_MIN_COMPLETED_PER_ROUTE = 1_000;

export const PROMPT_CACHE_TELEMETRY_PROVIDERS = ["chatgpt_codex", "metered", "surplus"] as const;
export const PROMPT_CACHE_TELEMETRY_ROUTES = ["responses", "chat.completions"] as const;

export type PromptCacheTelemetryProvider = (typeof PROMPT_CACHE_TELEMETRY_PROVIDERS)[number];
export type PromptCacheTelemetryRoute = (typeof PROMPT_CACHE_TELEMETRY_ROUTES)[number];

export type PromptCacheTelemetryEvent = Readonly<{
  provider: string | null;
  model: string | null;
  route: string;
  status: number;
  completed: boolean;
  usageTelemetryStatus: string;
  /** True only when a valid upstream cache_write_tokens field was observed; zero is present. */
  cacheWriteTokensPresent: boolean;
}>;

export type PromptCacheTelemetryGateOptions = Readonly<{
  /** Supplying a KV instance makes focused tests and explicit control-plane reads deterministic. */
  kv?: Kv | null;
  /** Defaults to the immutable source identity baked into this artifact. */
  release?: string;
}>;

export type PromptCacheTelemetryRecordResult = Readonly<{
  status: "recorded" | "ignored" | "unavailable";
  reason: "recorded" | "unknown_release" | "not_completed_2xx" | "unsupported_provider" | "unsupported_route" | "invalid_model" | "kv_unavailable";
  release: string | null;
  provider: PromptCacheTelemetryProvider | null;
  route: PromptCacheTelemetryRoute | null;
  /** A domain-separated SHA-256 digest; raw model text is never persisted or returned. */
  model_hash: string | null;
}>;

export type PromptCacheTelemetryBaselineTarget = Readonly<{
  provider: string;
  model: string;
}>;

/**
 * Opaque keys are useful for administrative migration/attestation tooling that
 * must seed or inspect durable counters without ever learning a raw model name.
 */
export type PromptCacheTelemetryCounterKeys = Readonly<{
  release: string;
  provider: PromptCacheTelemetryProvider;
  model_hash: string;
  routes: readonly Readonly<{
    route: PromptCacheTelemetryRoute;
    completed: KvKey;
    reported: KvKey;
    cache_write_reported: KvKey;
    invalid: KvKey;
  }>[];
}>;

export type PromptCacheTelemetryCounterSummary = Readonly<{
  /** Decimal U64 strings keep this result safe to JSON serialize without losing precision. */
  completed: string;
  reported: string;
  /** Completed responses with a valid cache_write_tokens field, including a valid zero. */
  cache_write_reported: string;
  /** Completed responses whose upstream usage object was present but invalid. */
  invalid: string;
  reported_coverage: number | null;
  reported_coverage_passed: boolean;
  cache_write_reported_coverage: number | null;
  cache_write_reported_coverage_passed: boolean;
}>;

export type PromptCacheTelemetryRouteBaseline = PromptCacheTelemetryCounterSummary &
  Readonly<{
    route: PromptCacheTelemetryRoute;
    observed: boolean;
    completed_minimum_passed: boolean;
  }>;

export type PromptCacheTelemetryBaselineResult = Readonly<{
  status: "eligible" | "not_ready" | "unavailable";
  reason:
    | "eligible"
    | "unknown_release"
    | "unsupported_target"
    | "kv_unavailable"
    | "invalid_counter"
    | "aggregate_completed_below_minimum"
    | "route_completed_below_minimum"
    | "aggregate_reported_coverage_below_minimum"
    | "route_reported_coverage_below_minimum"
    | "aggregate_cache_write_reported_coverage_below_minimum"
    | "route_cache_write_reported_coverage_below_minimum";
  release: string | null;
  provider: PromptCacheTelemetryProvider | null;
  model_hash: string | null;
  aggregate: PromptCacheTelemetryCounterSummary | null;
  routes: readonly PromptCacheTelemetryRouteBaseline[];
}>;

type CounterPair = Readonly<{
  completed: bigint;
  reported: bigint;
  cacheWriteReported: bigint;
  invalid: bigint;
}>;

const RELEASE_SHA = /^[a-f0-9]{7,64}$/i;
const MAX_MODEL_CHARS = 256;
const COVERAGE_NUMERATOR = 199n;
const COVERAGE_DENOMINATOR = 200n;

const normalizedRelease = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const release = value.trim();
  if (!release || release.toLowerCase() === "unknown" || !RELEASE_SHA.test(release)) return null;
  return release.toLowerCase();
};

const hasAsciiControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const normalizedModel = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_CHARS || hasAsciiControlCharacter(model)) return null;
  return model;
};

const asProvider = (value: unknown): PromptCacheTelemetryProvider | null =>
  typeof value === "string" && (PROMPT_CACHE_TELEMETRY_PROVIDERS as readonly string[]).includes(value) ? (value as PromptCacheTelemetryProvider) : null;

const asRoute = (value: unknown): PromptCacheTelemetryRoute | null =>
  typeof value === "string" && (PROMPT_CACHE_TELEMETRY_ROUTES as readonly string[]).includes(value) ? (value as PromptCacheTelemetryRoute) : null;

const isCompleted2xx = (event: PromptCacheTelemetryEvent): boolean =>
  event.completed && Number.isInteger(event.status) && event.status >= 200 && event.status < 300;

const resolveRelease = (options: PromptCacheTelemetryGateOptions): string | null => normalizedRelease(options.release ?? RELEASE_GIT_SHA);

const resolveKv = async (options: PromptCacheTelemetryGateOptions): Promise<Kv | null> => {
  try {
    return options.kv === undefined ? await getKv() : options.kv;
  } catch {
    return null;
  }
};

const modelHash = async (model: string): Promise<string> => await sha256Hex(`uos-prompt-cache-telemetry-model-v1\u0000${model}`);

const counterKey = (
  release: string,
  provider: PromptCacheTelemetryProvider,
  modelHashValue: string,
  route: PromptCacheTelemetryRoute,
  counter: "completed" | "reported" | "cache_write_reported" | "invalid"
): KvKey => [...PROMPT_CACHE_TELEMETRY_GATE_KV_PREFIX, release, provider, modelHashValue, route, counter];

const recordResult = (
  status: PromptCacheTelemetryRecordResult["status"],
  reason: PromptCacheTelemetryRecordResult["reason"],
  input: Readonly<{
    release?: string | null;
    provider?: PromptCacheTelemetryProvider | null;
    route?: PromptCacheTelemetryRoute | null;
    modelHash?: string | null;
  }> = {}
): PromptCacheTelemetryRecordResult => ({
  status,
  reason,
  release: input.release ?? null,
  provider: input.provider ?? null,
  route: input.route ?? null,
  model_hash: input.modelHash ?? null,
});

const isKvU64 = (value: unknown): value is KvU64 => value instanceof KvU64 && typeof value.value === "bigint" && value.value >= 0n;

/** A missing sibling counter counts as zero; a present but malformed one is invalid. */
const siblingCounter = (missing: boolean, value: unknown): bigint | null => {
  if (missing) return 0n;
  return isKvU64(value) ? value.value : null;
};

const counterPair = (completedValue: unknown, reportedValue: unknown, cacheWriteReportedValue: unknown, invalidValue: unknown): CounterPair | null => {
  const completedMissing = completedValue === null;
  const reportedMissing = reportedValue === null;
  const cacheWriteReportedMissing = cacheWriteReportedValue === null;
  const invalidMissing = invalidValue === null;
  if (completedMissing && reportedMissing && cacheWriteReportedMissing && invalidMissing) {
    return { completed: 0n, reported: 0n, cacheWriteReported: 0n, invalid: 0n };
  }
  if (completedMissing || !isKvU64(completedValue)) return null;
  const reported = siblingCounter(reportedMissing, reportedValue);
  const cacheWriteReported = siblingCounter(cacheWriteReportedMissing, cacheWriteReportedValue);
  const invalid = siblingCounter(invalidMissing, invalidValue);
  if (reported === null || cacheWriteReported === null || invalid === null) return null;
  if (reported > completedValue.value || cacheWriteReported > reported || invalid > completedValue.value) return null;
  if (reported + invalid > completedValue.value) return null;
  return { completed: completedValue.value, reported, cacheWriteReported, invalid };
};

const coverage = (numerator: bigint, counters: CounterPair): number | null =>
  counters.completed === 0n ? null : Number((numerator * 1_000_000n) / counters.completed) / 1_000_000;

const passesCoverage = (numerator: bigint, counters: CounterPair): boolean =>
  counters.completed > 0n && numerator * COVERAGE_DENOMINATOR >= counters.completed * COVERAGE_NUMERATOR;

const counterSummary = (counters: CounterPair): PromptCacheTelemetryCounterSummary => ({
  completed: counters.completed.toString(),
  reported: counters.reported.toString(),
  cache_write_reported: counters.cacheWriteReported.toString(),
  invalid: counters.invalid.toString(),
  reported_coverage: coverage(counters.reported, counters),
  reported_coverage_passed: passesCoverage(counters.reported, counters),
  cache_write_reported_coverage: coverage(counters.cacheWriteReported, counters),
  cache_write_reported_coverage_passed: passesCoverage(counters.cacheWriteReported, counters),
});

const unavailableBaseline = (
  reason: Extract<PromptCacheTelemetryBaselineResult["reason"], "unknown_release" | "unsupported_target" | "kv_unavailable">,
  input: Readonly<{
    release?: string | null;
    provider?: PromptCacheTelemetryProvider | null;
    modelHash?: string | null;
  }> = {}
): PromptCacheTelemetryBaselineResult => ({
  status: reason === "kv_unavailable" ? "unavailable" : "not_ready",
  reason,
  release: input.release ?? null,
  provider: input.provider ?? null,
  model_hash: input.modelHash ?? null,
  aggregate: null,
  routes: [],
});

/**
 * Resolves only opaque Deno KV counter keys for a valid target. It performs no
 * writes and returns null for an unknown release or unsupported target.
 */
export const resolvePromptCacheTelemetryCounterKeys = async (
  target: PromptCacheTelemetryBaselineTarget,
  options: PromptCacheTelemetryGateOptions = {}
): Promise<PromptCacheTelemetryCounterKeys | null> => {
  const release = resolveRelease(options);
  const provider = asProvider(target.provider);
  const model = normalizedModel(target.model);
  if (!release || !provider || !model) return null;
  try {
    const hashedModel = await modelHash(model);
    return {
      release,
      provider,
      model_hash: hashedModel,
      routes: PROMPT_CACHE_TELEMETRY_ROUTES.map((route) => ({
        route,
        completed: counterKey(release, provider, hashedModel, route, "completed"),
        reported: counterKey(release, provider, hashedModel, route, "reported"),
        cache_write_reported: counterKey(release, provider, hashedModel, route, "cache_write_reported"),
        invalid: counterKey(release, provider, hashedModel, route, "invalid"),
      })),
    };
  } catch {
    return null;
  }
};

/**
 * Counts only terminal, successful inference completions. Completed and
 * telemetry-status counters are summed in one atomic Deno KV commit, so a
 * read can never observe a reported or invalid event without its denominator.
 */
export const recordPromptCacheTelemetry = async (
  event: PromptCacheTelemetryEvent,
  options: PromptCacheTelemetryGateOptions = {}
): Promise<PromptCacheTelemetryRecordResult> => {
  const release = resolveRelease(options);
  if (!release) return recordResult("ignored", "unknown_release");
  if (!isCompleted2xx(event)) return recordResult("ignored", "not_completed_2xx", { release });

  const provider = asProvider(event.provider);
  if (!provider) return recordResult("ignored", "unsupported_provider", { release });
  const route = asRoute(event.route);
  if (!route) return recordResult("ignored", "unsupported_route", { release, provider });
  const model = normalizedModel(event.model);
  if (!model) return recordResult("ignored", "invalid_model", { release, provider, route });

  let hashedModel: string;
  try {
    hashedModel = await modelHash(model);
  } catch {
    return recordResult("unavailable", "kv_unavailable", { release, provider, route });
  }

  const kv = await resolveKv(options);
  if (!kv) {
    return recordResult("unavailable", "kv_unavailable", {
      release,
      provider,
      route,
      modelHash: hashedModel,
    });
  }

  try {
    const operation = kv.atomic().sum(counterKey(release, provider, hashedModel, route, "completed"), 1n);
    if (event.usageTelemetryStatus === "reported") {
      operation.sum(counterKey(release, provider, hashedModel, route, "reported"), 1n);
      if (event.cacheWriteTokensPresent) {
        operation.sum(counterKey(release, provider, hashedModel, route, "cache_write_reported"), 1n);
      }
    }
    if (event.usageTelemetryStatus === "invalid") {
      operation.sum(counterKey(release, provider, hashedModel, route, "invalid"), 1n);
    }
    const committed = await operation.commit();
    if (!committed.ok) {
      return recordResult("unavailable", "kv_unavailable", { release, provider, route, modelHash: hashedModel });
    }
  } catch {
    return recordResult("unavailable", "kv_unavailable", { release, provider, route, modelHash: hashedModel });
  }

  return recordResult("recorded", "recorded", { release, provider, route, modelHash: hashedModel });
};

/**
 * Reads only the target provider/model cohort for the immutable current
 * release. It is intentionally fail-closed: malformed counters, an unknown
 * release, missing KV, or any threshold miss are never eligible.
 */
export const readPromptCacheTelemetryBaseline = async (
  target: PromptCacheTelemetryBaselineTarget,
  options: PromptCacheTelemetryGateOptions = {}
): Promise<PromptCacheTelemetryBaselineResult> => {
  const release = resolveRelease(options);
  if (!release) return unavailableBaseline("unknown_release");

  const provider = asProvider(target.provider);
  const model = normalizedModel(target.model);
  if (!provider || !model) return unavailableBaseline("unsupported_target", { release, provider });

  let hashedModel: string;
  try {
    hashedModel = await modelHash(model);
  } catch {
    return unavailableBaseline("kv_unavailable", { release, provider });
  }

  const kv = await resolveKv(options);
  if (!kv) return unavailableBaseline("kv_unavailable", { release, provider, modelHash: hashedModel });

  let entriesByRoute: readonly Readonly<{
    route: PromptCacheTelemetryRoute;
    completed: KvEntryMaybe<KvU64>;
    reported: KvEntryMaybe<KvU64>;
    cacheWriteReported: KvEntryMaybe<KvU64>;
    invalid: KvEntryMaybe<KvU64>;
  }>[];
  try {
    entriesByRoute = await Promise.all(
      PROMPT_CACHE_TELEMETRY_ROUTES.map(async (route) => {
        const [completed, reported, cacheWriteReported, invalid] = await Promise.all([
          kv.get<KvU64>(counterKey(release, provider, hashedModel, route, "completed"), { consistency: "strong" }),
          kv.get<KvU64>(counterKey(release, provider, hashedModel, route, "reported"), { consistency: "strong" }),
          kv.get<KvU64>(counterKey(release, provider, hashedModel, route, "cache_write_reported"), { consistency: "strong" }),
          kv.get<KvU64>(counterKey(release, provider, hashedModel, route, "invalid"), { consistency: "strong" }),
        ]);
        return { route, completed, reported, cacheWriteReported, invalid };
      })
    );
  } catch {
    return unavailableBaseline("kv_unavailable", { release, provider, modelHash: hashedModel });
  }

  const countersByRoute: Readonly<{ route: PromptCacheTelemetryRoute; counters: CounterPair }>[] = [];
  for (const { route, completed, reported, cacheWriteReported, invalid } of entriesByRoute) {
    const counters = counterPair(completed.value, reported.value, cacheWriteReported.value, invalid.value);
    if (!counters) {
      return {
        ...unavailableBaseline("kv_unavailable", { release, provider, modelHash: hashedModel }),
        status: "not_ready",
        reason: "invalid_counter",
      };
    }
    countersByRoute.push({ route, counters });
  }

  const aggregate: CounterPair = countersByRoute.reduce<CounterPair>(
    (total, entry) => ({
      completed: total.completed + entry.counters.completed,
      reported: total.reported + entry.counters.reported,
      cacheWriteReported: total.cacheWriteReported + entry.counters.cacheWriteReported,
      invalid: total.invalid + entry.counters.invalid,
    }),
    { completed: 0n, reported: 0n, cacheWriteReported: 0n, invalid: 0n }
  );
  const routes = countersByRoute.map(
    ({ route, counters }) =>
      ({
        route,
        observed: counters.completed > 0n,
        ...counterSummary(counters),
        completed_minimum_passed: counters.completed >= BigInt(PROMPT_CACHE_TELEMETRY_MIN_COMPLETED_PER_ROUTE),
      }) satisfies PromptCacheTelemetryRouteBaseline
  );

  const aggregateSummary = counterSummary(aggregate);
  const aggregateCompletedPassed = aggregate.completed >= BigInt(PROMPT_CACHE_TELEMETRY_MIN_COMPLETED);
  const observedRoutes = routes.filter((route) => route.observed);
  const everyObservedRouteCompleted = observedRoutes.every((route) => route.completed_minimum_passed);
  const everyObservedRouteReported = observedRoutes.every((route) => route.reported_coverage_passed);
  const everyObservedRouteCacheWriteReported = observedRoutes.every((route) => route.cache_write_reported_coverage_passed);

  // Ordered fail-closed gate list: the first unmet threshold names the reason.
  const eligibilityGates: readonly Readonly<{ passed: boolean; reason: PromptCacheTelemetryBaselineResult["reason"] }>[] = [
    { passed: aggregateCompletedPassed, reason: "aggregate_completed_below_minimum" },
    { passed: everyObservedRouteCompleted, reason: "route_completed_below_minimum" },
    { passed: aggregateSummary.reported_coverage_passed, reason: "aggregate_reported_coverage_below_minimum" },
    { passed: everyObservedRouteReported, reason: "route_reported_coverage_below_minimum" },
    { passed: aggregateSummary.cache_write_reported_coverage_passed, reason: "aggregate_cache_write_reported_coverage_below_minimum" },
    { passed: everyObservedRouteCacheWriteReported, reason: "route_cache_write_reported_coverage_below_minimum" },
  ];
  const failedGate = eligibilityGates.find((gate) => !gate.passed);
  const reason: PromptCacheTelemetryBaselineResult["reason"] = failedGate ? failedGate.reason : "eligible";

  return {
    status: reason === "eligible" ? "eligible" : "not_ready",
    reason,
    release,
    provider,
    model_hash: hashedModel,
    aggregate: aggregateSummary,
    routes,
  };
};
