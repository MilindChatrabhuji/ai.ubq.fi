import type { Kv, KvKey } from "#kv";
// Prompt cache scope experiment model: constants, records, parsing and usage classification, split out of src/prompt_cache_scope_experiment.ts.

import { CodexCacheScopeExperimentError, getCodexResponseSlot, markCodexResponseCompleted, releaseCodexResponseProbe } from "../codex/index.ts";
import {
  CODEX_CHATGPT_PROMPT_CACHE_PROVIDER,
  PROMPT_CACHE_SCOPE_PROBE_PROFILE,
  type PromptCacheAccountSlots,
  type PromptCacheConversationId,
  type PromptCacheTokenRefresh,
} from "../models/codex-models.ts";
import { extractUsageTokens } from "../openai-telemetry.ts";

import { readResponsesStream } from "../responses-stream.ts";
import { getString, isRecord } from "../utils.ts";
import type { ResponseInputItem } from "../types.ts";

export const PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER = CODEX_CHATGPT_PROMPT_CACHE_PROVIDER;
const CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER = "chatgpt_codex" as const;
/**
 * v5 is a hard cutover from the prior cycle shape. This namespace is the
 * durable experiment-definition fence; every key also includes the fixed
 * probe profile and exact target.
 */
export const PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX = ["uos_ai", "prompt_cache_scope_experiment", "v5"] as const;
export const PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES = 3;
export const PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLES_PER_CYCLE = 10;

const PROMPT_CACHE_SCOPE_EXPERIMENT_LEASE_MS = 120_000;
const PROMPT_CACHE_SCOPE_EXPERIMENT_SESSION_MS = 15 * 60_000;
const PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLE_DEADLINE_MS = 100_000;
const PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLE_DEADLINE_MS = 7_000;

const CACHE_SCOPE_STEP_NAMES = [
  "slot_1_warm",
  "slot_1_repeat",
  "slot_2_first",
  "slot_2_repeat",
  "slot_1_after_slot_2",
  "slot_1_after_refresh",
  "slot_1_post_refresh_repeat",
  "slot_1_conversation_changed",
  "slot_1_conversation_changed_repeat",
  "slot_1_original_conversation_recheck",
] as const;
const CACHE_SCOPE_EXPECTED_SLOTS = [1, 1, 2, 2, 1, 1, 1, 1, 1, 1] as const;
const CACHE_SCOPE_DISCRIMINATOR_INDEXES = new Set([2, 5, 7]);

/**
 * Test-only dependency injection. The admin route calls the assertion without
 * arguments, binding the gate to this immutable artifact's release identity.
 */
type PromptCacheScopeExperimentTelemetryBaselineTestOptions = Readonly<{
  kv?: Kv | null;
  release?: string;
}>;

/**
 * An in-process attestation created immediately after the immutable-release
 * Stage 0 read. It is intentionally not returned from the admin endpoint:
 * the runner uses it only to ensure that it cannot silently retarget paid
 * work after the gate has selected a model.
 */
export type PromptCacheScopeExperimentTelemetryBaseline = Readonly<{
  target: PromptCacheScopeTargetBinding;
}>;

type CacheScopeStepName = (typeof CACHE_SCOPE_STEP_NAMES)[number];
type CacheSignal = "read" | "write";
const CACHE_SCOPE_EXPECTED_SIGNALS: readonly (CacheSignal | null)[] = ["write", "read", null, "read", "read", null, "read", null, "read", "read"];
type InconclusiveReason =
  | "auth_pool_drift"
  | "capability_changed"
  | "cycle_disagreement"
  | "effective_model_drift"
  | "incomplete_telemetry"
  | "invalid_cache_signal"
  | "invalid_input_size"
  | "inventory_drift"
  | "lease_lost"
  | "model_drift"
  | "promotion_conflict"
  | "refresh_unchanged"
  | "runtime_drift"
  | "session_expired"
  | "slot_drift"
  | "target_catalog_drift";

type ConcreteScopeObservation = Readonly<{
  probe_profile: typeof PROMPT_CACHE_SCOPE_PROBE_PROFILE;
  account_slots: Exclude<PromptCacheAccountSlots, "unknown">;
  token_refresh: Exclude<PromptCacheTokenRefresh, "unknown">;
  conversation_id: Exclude<PromptCacheConversationId, "unknown">;
  effective_model: string;
}>;

type NormalizedUsage = Readonly<{
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  total_tokens: number;
}>;

type PromptCacheScopeSample = Readonly<{
  step: CacheScopeStepName;
  slot: number;
  /**
   * The provider-reported five-counter tuple before gateway normalization.
   * It deliberately excludes all other response fields so durable experiment
   * evidence remains redacted.
   */
  raw_usage: NormalizedUsage;
  usage: NormalizedUsage;
  elapsed_ms: number;
}>;

type CycleEvidence = Readonly<{
  cycle: number;
  samples: readonly PromptCacheScopeSample[];
  classification?: ConcreteScopeObservation;
  inconclusive_reason?: InconclusiveReason;
}>;

/**
 * The target definition is stable across benign catalog metadata refreshes;
 * the dynamic catalog/runtime/auth versionstamps fence the next dispatch or
 * publication. The inventory fingerprint covers the complete provider/model
 * roster, so an active campaign cannot silently skip a new or removed target.
 */
type PromptCacheScopeTargetBinding = Readonly<{
  id: string;
  provider: typeof PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER;
  telemetry_provider: typeof CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER;
  topology_kind: "codex_account_pool";
  model: string;
  probe_profile: typeof PROMPT_CACHE_SCOPE_PROBE_PROFILE;
  capability_fingerprint: string;
  inventory_fingerprint: string;
  catalog_versionstamp: string;
  runtime_versionstamp: string;
  auth_pool_versionstamp: string;
  auth_pool_identity_fingerprint: string;
  catalog_client_version: string | null;
}>;

type StoredEvidence = Readonly<{
  v: 3;
  target: PromptCacheScopeTargetBinding;
  outcome: "in_progress" | "ready_to_promote" | "completed" | "inconclusive" | "failed";
  started_at_ms: number;
  verified_at_ms: number;
  cycles: readonly CycleEvidence[];
  inconclusive_reason?: InconclusiveReason;
}>;

type ExperimentState = Readonly<{
  v: 3;
  target: PromptCacheScopeTargetBinding;
  campaign_owner: string;
  started_at_ms: number;
  expires_at_ms: number;
  auth_pool_versionstamp: string;
  next_cycle: number;
  classifications: readonly ConcreteScopeObservation[];
  pending_scope?: ConcreteScopeObservation;
}>;

type ExperimentLease = Readonly<{ owner: string; lease_until_ms: number }>;
type CampaignLease = Readonly<{
  owner: string;
  target_id: string;
  inventory_fingerprint: string;
  lease_until_ms: number;
}>;

export type PromptCacheScopeExperimentResult = Readonly<{
  provider: typeof PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER;
  telemetry_provider: typeof CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER;
  target_id: string;
  model: string;
  status: "in_progress" | "completed" | "inconclusive";
  completed_cycles: number;
  verified_at_ms: number;
  scope?: ConcreteScopeObservation;
  inconclusive_reason?: InconclusiveReason;
}>;

export class PromptCacheScopeExperimentBusyError extends Error {
  constructor() {
    super("A prompt-cache scope experiment campaign is already running for the active provider.");
    this.name = "PromptCacheScopeExperimentBusyError";
  }
}

export class PromptCacheScopeExperimentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptCacheScopeExperimentUnavailableError";
  }
}

export class PromptCacheScopeExperimentFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptCacheScopeExperimentFailedError";
  }
}

const isSafeNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every((key) => hasOwn(value, key));

const targetKeyParts = (
  target: Pick<PromptCacheScopeTargetBinding, "provider" | "telemetry_provider" | "topology_kind" | "probe_profile" | "model">
): readonly string[] => [target.provider, target.telemetry_provider, target.topology_kind, target.probe_profile, target.model];

const stateKey = (target: PromptCacheScopeTargetBinding): KvKey => [...PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX, "state", ...targetKeyParts(target)];
const evidenceKey = (target: PromptCacheScopeTargetBinding): KvKey => [...PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX, "evidence", ...targetKeyParts(target)];
const cycleLeaseKey = (target: PromptCacheScopeTargetBinding): KvKey => [...PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX, "cycle_lease", ...targetKeyParts(target)];
/** OAuth refresh mutates a shared Codex pool, so this fence is provider-wide. */
const campaignLeaseKey = (target: Pick<PromptCacheScopeTargetBinding, "provider" | "telemetry_provider" | "probe_profile">): KvKey => [
  ...PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX,
  "campaign",
  target.provider,
  target.telemetry_provider,
  target.probe_profile,
];

const isConcreteObservation = (value: unknown): value is ConcreteScopeObservation =>
  isRecord(value) &&
  !Array.isArray(value) &&
  hasExactKeys(value, ["probe_profile", "account_slots", "token_refresh", "conversation_id", "effective_model"]) &&
  value.probe_profile === PROMPT_CACHE_SCOPE_PROBE_PROFILE &&
  (value.account_slots === "shared" || value.account_slots === "account_scoped") &&
  (value.token_refresh === "preserved" || value.token_refresh === "changed") &&
  (value.conversation_id === "independent" || value.conversation_id === "scoped") &&
  Boolean(getString(value.effective_model)?.trim());

const parseTargetBinding = (value: unknown): PromptCacheScopeTargetBinding | null => {
  if (
    !isRecord(value) ||
    Array.isArray(value) ||
    !hasExactKeys(value, [
      "id",
      "provider",
      "telemetry_provider",
      "topology_kind",
      "model",
      "probe_profile",
      "capability_fingerprint",
      "inventory_fingerprint",
      "catalog_versionstamp",
      "runtime_versionstamp",
      "auth_pool_versionstamp",
      "auth_pool_identity_fingerprint",
      "catalog_client_version",
    ]) ||
    value.provider !== PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER ||
    value.telemetry_provider !== CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER ||
    value.topology_kind !== "codex_account_pool" ||
    value.probe_profile !== PROMPT_CACHE_SCOPE_PROBE_PROFILE
  )
    return null;
  // Each required string is trimmed exactly once, so the non-empty checks below
  // are the same validation the binding used to re-assert with `!`.
  const id = getString(value.id)?.trim();
  const model = getString(value.model)?.trim();
  const capabilityFingerprint = getString(value.capability_fingerprint)?.trim();
  const inventoryFingerprint = getString(value.inventory_fingerprint)?.trim();
  const catalogVersionstamp = getString(value.catalog_versionstamp)?.trim();
  const runtimeVersionstamp = getString(value.runtime_versionstamp)?.trim();
  const authPoolVersionstamp = getString(value.auth_pool_versionstamp)?.trim();
  const authPoolIdentityFingerprint = getString(value.auth_pool_identity_fingerprint)?.trim();
  const clientVersion = value.catalog_client_version === null ? null : getString(value.catalog_client_version)?.trim();
  if (
    !id ||
    !model ||
    !capabilityFingerprint ||
    !inventoryFingerprint ||
    !catalogVersionstamp ||
    !runtimeVersionstamp ||
    !authPoolVersionstamp ||
    !authPoolIdentityFingerprint ||
    (value.catalog_client_version !== null && !clientVersion)
  )
    return null;
  return {
    id,
    provider: PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER,
    telemetry_provider: CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER,
    topology_kind: "codex_account_pool",
    model,
    probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
    capability_fingerprint: capabilityFingerprint,
    inventory_fingerprint: inventoryFingerprint,
    catalog_versionstamp: catalogVersionstamp,
    runtime_versionstamp: runtimeVersionstamp,
    auth_pool_versionstamp: authPoolVersionstamp,
    auth_pool_identity_fingerprint: authPoolIdentityFingerprint,
    catalog_client_version: clientVersion ?? null,
  };
};

/**
 * Provider, telemetry provider, topology kind, and probe profile are
 * literal-typed by construction, so a direct comparison reads as statically
 * always true. They are still read back from durable KV records, so the
 * identity fence stays in place and is compared through a plain `string` view.
 */
const sameLiteralField = (left: string, right: string): boolean => left === right;

const sameTargetDefinition = (left: PromptCacheScopeTargetBinding, right: PromptCacheScopeTargetBinding): boolean =>
  left.id === right.id &&
  sameLiteralField(left.provider, right.provider) &&
  sameLiteralField(left.telemetry_provider, right.telemetry_provider) &&
  sameLiteralField(left.topology_kind, right.topology_kind) &&
  left.model === right.model &&
  sameLiteralField(left.probe_profile, right.probe_profile) &&
  left.capability_fingerprint === right.capability_fingerprint &&
  left.inventory_fingerprint === right.inventory_fingerprint &&
  left.auth_pool_identity_fingerprint === right.auth_pool_identity_fingerprint;

const sameObservation = (left: ConcreteScopeObservation, right: ConcreteScopeObservation): boolean =>
  sameLiteralField(left.probe_profile, right.probe_profile) &&
  left.account_slots === right.account_slots &&
  left.token_refresh === right.token_refresh &&
  left.conversation_id === right.conversation_id &&
  left.effective_model === right.effective_model;

/**
 * The first observation is the sequence's reference. An empty sequence is not a
 * match, and `at(0)` types the out-of-range read that a plain index signature
 * omits.
 */
const sharedObservation = (observations: readonly ConcreteScopeObservation[]): ConcreteScopeObservation | null => {
  const first = observations.at(0);
  return first !== undefined && observations.every((observation) => sameObservation(observation, first)) ? first : null;
};

/** Durable cycle evidence agrees when every classified cycle reports one scope. */
const classificationEvidenceAgrees = (cycles: readonly CycleEvidence[]): boolean => {
  const first: ConcreteScopeObservation | undefined = cycles[0]?.classification;
  return first !== undefined && cycles.every((cycle) => cycle.classification !== undefined && sameObservation(cycle.classification, first));
};

const parseState = (value: unknown): ExperimentState | null => {
  if (
    !isRecord(value) ||
    value.v !== 3 ||
    Array.isArray(value) ||
    !hasOnlyKeys(value, [
      "v",
      "target",
      "campaign_owner",
      "started_at_ms",
      "expires_at_ms",
      "auth_pool_versionstamp",
      "next_cycle",
      "classifications",
      "pending_scope",
    ]) ||
    !["target", "campaign_owner", "started_at_ms", "expires_at_ms", "auth_pool_versionstamp", "next_cycle", "classifications"].every((key) =>
      hasOwn(value, key)
    )
  )
    return null;
  const target = parseTargetBinding(value.target);
  const campaignOwner = getString(value.campaign_owner)?.trim();
  const authPoolVersionstamp = getString(value.auth_pool_versionstamp)?.trim();
  const nextCycle = value.next_cycle;
  const classifications = Array.isArray(value.classifications) ? value.classifications : null;
  const now = Date.now();
  if (typeof nextCycle !== "number" || !Number.isSafeInteger(nextCycle)) return null;
  if (
    !target ||
    !campaignOwner ||
    !authPoolVersionstamp ||
    authPoolVersionstamp !== target.auth_pool_versionstamp ||
    !isSafeNonNegativeInteger(value.started_at_ms) ||
    !isSafeNonNegativeInteger(value.expires_at_ms) ||
    value.started_at_ms <= 0 ||
    value.started_at_ms > now ||
    value.expires_at_ms <= value.started_at_ms ||
    nextCycle < 1 ||
    nextCycle > PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES + 1 ||
    !classifications ||
    !classifications.every(isConcreteObservation) ||
    classifications.some((classification) => classification.effective_model !== target.model)
  )
    return null;
  if (classifications.length !== Math.min(nextCycle - 1, PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES)) {
    return null;
  }
  const pending = value.pending_scope;
  if (pending !== undefined && !isConcreteObservation(pending)) return null;
  if (nextCycle === PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES + 1) {
    const agreedScope = sharedObservation(classifications);
    if (!isConcreteObservation(pending) || pending.effective_model !== target.model || agreedScope === null || !sameObservation(pending, agreedScope))
      return null;
  }
  if (nextCycle <= PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES && pending !== undefined) return null;
  return {
    v: 3,
    target,
    campaign_owner: campaignOwner,
    started_at_ms: value.started_at_ms,
    expires_at_ms: value.expires_at_ms,
    auth_pool_versionstamp: authPoolVersionstamp,
    next_cycle: nextCycle,
    classifications,
    ...(pending !== undefined ? { pending_scope: pending } : {}),
  };
};

const ownsLease = (value: unknown, owner: string): boolean =>
  isRecord(value) && value.owner === owner && isSafeNonNegativeInteger(value.lease_until_ms) && value.lease_until_ms > Date.now();

const ownsCampaignLease = (value: unknown, state: ExperimentState): boolean =>
  isRecord(value) &&
  value.owner === state.campaign_owner &&
  value.target_id === state.target.id &&
  value.inventory_fingerprint === state.target.inventory_fingerprint &&
  isSafeNonNegativeInteger(value.lease_until_ms) &&
  value.lease_until_ms > Date.now();

const cancelResponse = (response: Response): void => {
  try {
    const cancelled = response.body?.cancel();
    if (cancelled) void cancelled.catch(() => {});
  } catch {
    // Cancellation is diagnostic cleanup only.
  }
};

const CACHE_SCOPE_MIN_REUSABLE_TOKENS = 2_000;
const staticPrefix = Array.from({ length: 2_560 }, () => "cache").join(" ");

const buildExperimentRequest = (model: string, cycleId: string, cacheKey: string): Record<string, unknown> => {
  // Cache lookup is prefix-based. Keep this nonce stable for all ten rows in a
  // cycle but before the reusable material, so no prior cycle can satisfy its
  // initial cacheable prefix.
  const input: ResponseInputItem[] = [
    {
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: `cache-scope-cycle:${cycleId}\n\n${staticPrefix}`,
        },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Reply with exactly: cache scope experiment." }],
    },
  ];
  return {
    model,
    input,
    store: false,
    stream: true,
    reasoning: { effort: "none" },
    prompt_cache_key: cacheKey,
  };
};

const rawUsageSample = (value: unknown): NormalizedUsage | null => {
  if (!isRecord(value) || Array.isArray(value)) return null;
  const details = isRecord(value.input_tokens_details) && !Array.isArray(value.input_tokens_details) ? value.input_tokens_details : null;
  if (!details) return null;
  const inputTokens = value.input_tokens;
  const cachedTokens = details.cached_tokens;
  const cacheWriteTokens = details.cache_write_tokens;
  const outputTokens = value.output_tokens;
  const totalTokens = value.total_tokens;
  if (
    !isSafeNonNegativeInteger(inputTokens) ||
    !isSafeNonNegativeInteger(cachedTokens) ||
    !isSafeNonNegativeInteger(cacheWriteTokens) ||
    !isSafeNonNegativeInteger(outputTokens) ||
    !isSafeNonNegativeInteger(totalTokens)
  )
    return null;
  return {
    input_tokens: inputTokens,
    cached_tokens: cachedTokens,
    cache_write_tokens: cacheWriteTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
};

const sameUsage = (left: NormalizedUsage, right: NormalizedUsage): boolean =>
  left.input_tokens === right.input_tokens &&
  left.cached_tokens === right.cached_tokens &&
  left.cache_write_tokens === right.cache_write_tokens &&
  left.output_tokens === right.output_tokens &&
  left.total_tokens === right.total_tokens;

const isPrefixScaleCounter = (tokens: number, inputTokens: number): boolean =>
  tokens === 0 || (tokens >= CACHE_SCOPE_MIN_REUSABLE_TOKENS && tokens <= inputTokens);

const hasMixedPrefixScaleCacheSignals = (usage: NormalizedUsage): boolean =>
  isPrefixScaleCounter(usage.cached_tokens, usage.input_tokens) &&
  isPrefixScaleCounter(usage.cache_write_tokens, usage.input_tokens) &&
  usage.cached_tokens > 0 &&
  usage.cache_write_tokens > 0;

/**
 * The warm write is the cycle's observed counter for the server-owned prefix.
 * Every later non-zero counter must match it exactly before it can carry scope
 * evidence; a merely prefix-scale counter could describe another breakpoint.
 */
const matchesCycleReusableCounter = (usage: NormalizedUsage, reusableTokens: number): boolean =>
  (usage.cached_tokens === 0 || usage.cached_tokens === reusableTokens) && (usage.cache_write_tokens === 0 || usage.cache_write_tokens === reusableTokens);

const cacheSignal = (usage: NormalizedUsage): CacheSignal | null => {
  // The probe has a fixed ~2,560-token reusable prefix. A smaller counter can
  // describe unrelated transient cache activity, not the tested prefix.
  if (!isPrefixScaleCounter(usage.cached_tokens, usage.input_tokens) || !isPrefixScaleCounter(usage.cache_write_tokens, usage.input_tokens)) return null;
  // OpenAI reports cache reads and writes as independent dimensions. A request
  // can read an earlier matching breakpoint while also writing a later one, so
  // a positive cached_tokens value is still conclusive cache-read evidence.
  if (usage.cached_tokens > 0) return "read";
  if (usage.cache_write_tokens > 0) return "write";
  return null;
};

/**
 * A discriminator row resolves an axis only when it reports exactly one cache
 * signal. Any other value, including a missing row, must never be attributed to
 * either side of the discriminator.
 */
const triStateFromSignal = <T>(signal: CacheSignal | undefined, whenRead: T, whenWrite: T): T | null => {
  if (signal === "read") return whenRead;
  if (signal === "write") return whenWrite;
  return null;
};

type ReadSampleResult =
  | Readonly<{ status: "sample"; sample: Omit<PromptCacheScopeSample, "step">; signal: CacheSignal }>
  | Readonly<{ status: "inconclusive"; reason: InconclusiveReason }>;

type ReportedUsage = Readonly<{ raw: NormalizedUsage; usage: NormalizedUsage }>;

/**
 * The provider tuple is conclusive only when the gateway's own parser reports
 * the same five counters. Anything else is incomplete telemetry, not evidence.
 */
const reportedUsage = (value: unknown): ReportedUsage | null => {
  const raw = rawUsageSample(value);
  const normalized = extractUsageTokens(value);
  if (!raw || !normalized) return null;
  if (
    normalized.status !== "reported" ||
    normalized.inputTokens === null ||
    normalized.cachedInputTokens === null ||
    normalized.cacheWriteInputTokens === null ||
    normalized.outputTokens === null ||
    normalized.totalTokens === null
  )
    return null;
  const usage: NormalizedUsage = {
    input_tokens: normalized.inputTokens,
    cached_tokens: normalized.cachedInputTokens,
    cache_write_tokens: normalized.cacheWriteInputTokens,
    output_tokens: normalized.outputTokens,
    total_tokens: normalized.totalTokens,
  };
  return sameUsage(raw, usage) ? { raw, usage } : null;
};

/** Classifies one completed terminal response against the bound target and probe shape. */
const sampleFromCompletedResponse = (response: Record<string, unknown>, expectedSlot: number, expectedModel: string, startedAtMs: number): ReadSampleResult => {
  if (getString(response.model)?.trim() !== expectedModel) {
    return { status: "inconclusive", reason: "effective_model_drift" };
  }
  const reported = reportedUsage(response.usage);
  if (!reported) return { status: "inconclusive", reason: "incomplete_telemetry" };
  const { raw, usage } = reported;
  if (usage.input_tokens < CACHE_SCOPE_MIN_REUSABLE_TOKENS || usage.input_tokens > 4_000) {
    return { status: "inconclusive", reason: "invalid_input_size" };
  }
  const signalValue = cacheSignal(usage);
  if (!signalValue) return { status: "inconclusive", reason: "invalid_cache_signal" };
  return {
    status: "sample",
    signal: signalValue,
    sample: {
      slot: expectedSlot,
      raw_usage: raw,
      usage,
      elapsed_ms: Math.max(0, Math.round(performance.now() - startedAtMs)),
    },
  };
};

const settleResponseProbe = async (response: Response, responseCompleted: boolean): Promise<void> => {
  try {
    if (responseCompleted) await markCodexResponseCompleted(response);
    else await releaseCodexResponseProbe(response);
  } catch {
    // Provider-health and probe transitions are best effort after terminal handling.
  }
};

export const readPromptCacheScopeExperimentCompletedUsage = async (
  response: Response,
  expectedSlot: number,
  expectedModel: string,
  startedAtMs: number,
  signal: AbortSignal
): Promise<ReadSampleResult> => {
  let responseCompleted = false;
  try {
    if (!response.ok || !response.body) {
      cancelResponse(response);
      throw new CodexCacheScopeExperimentError("Prompt-cache scope experiment did not receive a readable upstream response.");
    }
    if (getCodexResponseSlot(response) !== expectedSlot) {
      cancelResponse(response);
      return { status: "inconclusive", reason: "slot_drift" };
    }
    let terminalResponse: Record<string, unknown> | null = null;
    for await (const event of readResponsesStream(response.body, signal)) {
      if (event.type === "response.completed" && isRecord(event.value.response) && !Array.isArray(event.value.response)) {
        terminalResponse = event.value.response;
        responseCompleted = true;
        break;
      }
      if (event.terminal) break;
    }
    if (!terminalResponse) {
      throw new CodexCacheScopeExperimentError("Prompt-cache scope experiment did not receive a completed terminal response.");
    }
    return sampleFromCompletedResponse(terminalResponse, expectedSlot, expectedModel, startedAtMs);
  } catch (error) {
    if (error instanceof CodexCacheScopeExperimentError) throw error;
    throw new CodexCacheScopeExperimentError(
      error instanceof Error ? `Prompt-cache scope experiment stream failed: ${error.message}` : "Prompt-cache scope experiment stream failed."
    );
  } finally {
    await settleResponseProbe(response, responseCompleted);
  }
};

const classifyCycle = (model: string, samples: readonly PromptCacheScopeSample[], signals: readonly CacheSignal[]): ConcreteScopeObservation | null => {
  if (samples.length !== PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLES_PER_CYCLE || signals.length !== samples.length) {
    return null;
  }
  if (
    samples.some((sample, index) => sample.slot !== CACHE_SCOPE_EXPECTED_SLOTS[index]) ||
    samples.some((sample) => sample.usage.input_tokens !== samples[0]?.usage.input_tokens)
  )
    return null;
  // `at(0)` types the out-of-range read that a plain index signature omits, so
  // the round's first reusable counter stays a checked value.
  const reusableTokens = samples.at(0)?.usage.cache_write_tokens;
  if (reusableTokens === undefined || reusableTokens === 0 || samples.some((sample) => !matchesCycleReusableCounter(sample.usage, reusableTokens))) return null;
  // A simultaneous read/write cannot attribute the tested prefix to either
  // side of a discriminator, so it must never authorize a concrete scope.
  if (samples.some((sample, index) => CACHE_SCOPE_DISCRIMINATOR_INDEXES.has(index) && hasMixedPrefixScaleCacheSignals(sample.usage))) return null;
  if (signals.some((signal, index) => CACHE_SCOPE_EXPECTED_SIGNALS[index] !== null && signal !== CACHE_SCOPE_EXPECTED_SIGNALS[index])) return null;
  const accountSlots = triStateFromSignal(signals[2], "shared" as const, "account_scoped" as const);
  const tokenRefresh = triStateFromSignal(signals[5], "preserved" as const, "changed" as const);
  const conversationId = triStateFromSignal(signals[7], "independent" as const, "scoped" as const);
  if (!accountSlots || !tokenRefresh || !conversationId) return null;
  return {
    probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
    account_slots: accountSlots,
    token_refresh: tokenRefresh,
    conversation_id: conversationId,
    effective_model: model,
  };
};

const INCONCLUSIVE_REASONS = new Set<InconclusiveReason>([
  "auth_pool_drift",
  "capability_changed",
  "cycle_disagreement",
  "effective_model_drift",
  "incomplete_telemetry",
  "invalid_cache_signal",
  "invalid_input_size",
  "inventory_drift",
  "lease_lost",
  "model_drift",
  "promotion_conflict",
  "refresh_unchanged",
  "runtime_drift",
  "session_expired",
  "slot_drift",
  "target_catalog_drift",
]);

const isNormalizedUsage = (value: unknown): value is NormalizedUsage =>
  isRecord(value) &&
  !Array.isArray(value) &&
  hasExactKeys(value, ["input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens", "total_tokens"]) &&
  isSafeNonNegativeInteger(value.input_tokens) &&
  isSafeNonNegativeInteger(value.cached_tokens) &&
  isSafeNonNegativeInteger(value.cache_write_tokens) &&
  isSafeNonNegativeInteger(value.output_tokens) &&
  isSafeNonNegativeInteger(value.total_tokens);

const isPromptCacheScopeSample = (value: unknown): value is PromptCacheScopeSample => {
  if (
    !isRecord(value) ||
    Array.isArray(value) ||
    !hasExactKeys(value, ["step", "slot", "raw_usage", "usage", "elapsed_ms"]) ||
    typeof value.step !== "string" ||
    !CACHE_SCOPE_STEP_NAMES.includes(value.step as CacheScopeStepName)
  )
    return false;
  const stepIndex = CACHE_SCOPE_STEP_NAMES.indexOf(value.step as CacheScopeStepName);
  return (
    value.slot === CACHE_SCOPE_EXPECTED_SLOTS[stepIndex] &&
    isNormalizedUsage(value.raw_usage) &&
    isNormalizedUsage(value.usage) &&
    sameUsage(value.raw_usage, value.usage) &&
    isSafeNonNegativeInteger(value.elapsed_ms)
  );
};

const isCycleEvidence = (value: unknown, model: string): value is CycleEvidence => {
  if (
    !isRecord(value) ||
    Array.isArray(value) ||
    !hasOnlyKeys(value, ["cycle", "samples", "classification", "inconclusive_reason"]) ||
    !hasOwn(value, "cycle") ||
    !hasOwn(value, "samples") ||
    !isSafeNonNegativeInteger(value.cycle) ||
    value.cycle < 1 ||
    value.cycle > PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES ||
    !Array.isArray(value.samples) ||
    value.samples.length > PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLES_PER_CYCLE ||
    !value.samples.every(isPromptCacheScopeSample) ||
    value.samples.some((sample, index) => sample.step !== CACHE_SCOPE_STEP_NAMES[index])
  )
    return false;

  const hasClassification = hasOwn(value, "classification");
  const hasReason = hasOwn(value, "inconclusive_reason");
  if (hasClassification === hasReason) return false;
  if (!hasReason) {
    if (
      !isConcreteObservation(value.classification) ||
      value.classification.effective_model !== model ||
      value.samples.length !== PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLES_PER_CYCLE
    )
      return false;
    const signals: CacheSignal[] = [];
    for (const sample of value.samples) {
      const signal = cacheSignal(sample.usage);
      if (!signal) return false;
      signals.push(signal);
    }
    const classification = classifyCycle(model, value.samples, signals);
    return classification !== null && sameObservation(value.classification, classification);
  }
  return typeof value.inconclusive_reason === "string" && INCONCLUSIVE_REASONS.has(value.inconclusive_reason as InconclusiveReason);
};

const parseEvidence = (value: unknown): StoredEvidence | null => {
  if (
    !isRecord(value) ||
    Array.isArray(value) ||
    !hasOnlyKeys(value, ["v", "target", "outcome", "started_at_ms", "verified_at_ms", "cycles", "inconclusive_reason"]) ||
    value.v !== 3
  )
    return null;
  const target = parseTargetBinding(value.target);
  const outcome = String(value.outcome) as StoredEvidence["outcome"];
  const hasInconclusiveReason = hasOwn(value, "inconclusive_reason");
  const now = Date.now();
  if (
    !target ||
    !isSafeNonNegativeInteger(value.started_at_ms) ||
    !isSafeNonNegativeInteger(value.verified_at_ms) ||
    value.started_at_ms <= 0 ||
    value.verified_at_ms < value.started_at_ms ||
    value.verified_at_ms > now ||
    !Array.isArray(value.cycles) ||
    value.cycles.length > PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES ||
    !["in_progress", "ready_to_promote", "completed", "inconclusive", "failed"].includes(outcome) ||
    (hasInconclusiveReason && (typeof value.inconclusive_reason !== "string" || !INCONCLUSIVE_REASONS.has(value.inconclusive_reason as InconclusiveReason))) ||
    !value.cycles.every((cycle, index) => isCycleEvidence(cycle, target.model) && cycle.cycle === index + 1)
  )
    return null;
  const cycles = value.cycles as readonly CycleEvidence[];
  const allClassified = cycles.every((cycle) => cycle.classification !== undefined);
  const classificationsAgree = allClassified && classificationEvidenceAgrees(cycles);
  const finalCycle = cycles.at(-1);
  const inconclusiveCyclesCoherent =
    cycles.length === 0 ||
    (cycles.slice(0, -1).every((cycle) => cycle.classification !== undefined) &&
      (finalCycle?.classification !== undefined || finalCycle?.inconclusive_reason === value.inconclusive_reason));
  if (
    (outcome === "in_progress" && (hasInconclusiveReason || !allClassified || cycles.length >= PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES)) ||
    ((outcome === "ready_to_promote" || outcome === "completed") &&
      (hasInconclusiveReason || cycles.length !== PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES || !classificationsAgree)) ||
    (outcome === "inconclusive" && (!hasInconclusiveReason || !inconclusiveCyclesCoherent)) ||
    (outcome === "failed" && (hasInconclusiveReason || !allClassified))
  )
    return null;
  return {
    v: 3,
    target,
    outcome,
    started_at_ms: value.started_at_ms,
    verified_at_ms: value.verified_at_ms,
    cycles,
    ...(hasInconclusiveReason ? { inconclusive_reason: value.inconclusive_reason as InconclusiveReason } : {}),
  };
};

/** Active state and evidence are one atomic campaign record, never independent hints. */
const activeStateEvidenceIsConsistent = (state: ExperimentState, evidence: StoredEvidence | null): boolean => {
  if (state.classifications.length === 0) return evidence === null;
  if (
    !evidence ||
    !sameTargetDefinition(evidence.target, state.target) ||
    evidence.started_at_ms !== state.started_at_ms ||
    evidence.cycles.length !== state.classifications.length ||
    !evidence.cycles.every((cycle, index) => cycle.classification !== undefined && sameObservation(cycle.classification, state.classifications[index]))
  )
    return false;
  return evidence.outcome === (state.next_cycle === PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES + 1 ? "ready_to_promote" : "in_progress");
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Prompt-cache scope experiment was aborted.", "AbortError");
  }
};

type RuntimeBinding = Readonly<{ versionstamp: string; default_model: string }>;
export type {
  CacheSignal,
  CampaignLease,
  ConcreteScopeObservation,
  CycleEvidence,
  ExperimentLease,
  ExperimentState,
  InconclusiveReason,
  PromptCacheScopeExperimentTelemetryBaselineTestOptions,
  PromptCacheScopeSample,
  PromptCacheScopeTargetBinding,
  ReadSampleResult,
  RuntimeBinding,
  StoredEvidence,
};

export {
  CACHE_SCOPE_DISCRIMINATOR_INDEXES,
  CACHE_SCOPE_EXPECTED_SIGNALS,
  CACHE_SCOPE_EXPECTED_SLOTS,
  CACHE_SCOPE_STEP_NAMES,
  CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER,
  PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLE_DEADLINE_MS,
  PROMPT_CACHE_SCOPE_EXPERIMENT_LEASE_MS,
  PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLE_DEADLINE_MS,
  PROMPT_CACHE_SCOPE_EXPERIMENT_SESSION_MS,
  activeStateEvidenceIsConsistent,
  buildExperimentRequest,
  campaignLeaseKey,
  classifyCycle,
  cycleLeaseKey,
  evidenceKey,
  hasMixedPrefixScaleCacheSignals,
  isSafeNonNegativeInteger,
  matchesCycleReusableCounter,
  ownsCampaignLease,
  ownsLease,
  parseEvidence,
  parseState,
  parseTargetBinding,
  sameLiteralField,
  sameTargetDefinition,
  sharedObservation,
  stateKey,
  throwIfAborted,
};
