import type { Kv } from "#kv";
import {
  beginCodexCacheScopeExperiment,
  CodexCacheScopeExperimentError,
  type CodexCacheScopeExperimentSession,
  fetchCodexResponsesForCacheScopeExperiment,
  refreshCodexCacheScopeExperimentSlot,
} from "../codex/index.ts";
import { promoteCodexPromptCacheScope, type PromptCacheScopePromotionResult } from "../catalog/promotion.ts";
import { type PromptCacheScope } from "../models/codex-models.ts";
import { getKv } from "../kv.ts";

import {
  activeStateEvidenceIsConsistent,
  buildExperimentRequest,
  CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER,
  campaignLeaseKey,
  cycleLeaseKey,
  evidenceKey,
  ownsCampaignLease,
  ownsLease,
  parseEvidence,
  parseState,
  sameTargetDefinition,
  stateKey,
  CACHE_SCOPE_DISCRIMINATOR_INDEXES,
  CACHE_SCOPE_EXPECTED_SIGNALS,
  CACHE_SCOPE_EXPECTED_SLOTS,
  CACHE_SCOPE_STEP_NAMES,
  classifyCycle,
  hasMixedPrefixScaleCacheSignals,
  matchesCycleReusableCounter,
  parseTargetBinding,
  PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES,
  PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLE_DEADLINE_MS,
  PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER,
  PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLES_PER_CYCLE,
  PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLE_DEADLINE_MS,
  PromptCacheScopeExperimentBusyError,
  PromptCacheScopeExperimentFailedError,
  PromptCacheScopeExperimentUnavailableError,
  readPromptCacheScopeExperimentCompletedUsage,
  sharedObservation,
  throwIfAborted,
} from "./scope-experiment-model.ts";
import type {
  CacheSignal,
  CampaignLease,
  ConcreteScopeObservation,
  CycleEvidence,
  ExperimentLease,
  ExperimentState,
  InconclusiveReason,
  PromptCacheScopeExperimentResult,
  PromptCacheScopeExperimentTelemetryBaseline,
  ReadSampleResult,
  PromptCacheScopeSample,
  PromptCacheScopeTargetBinding,
  StoredEvidence,
} from "./scope-experiment-model.ts";
import { acquireCycle, renewLease, resolveBoundTarget, sameTargetCore } from "./scope-experiment-targets.ts";
export {
  PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX,
  PromptCacheScopeExperimentFailedError,
  PromptCacheScopeExperimentBusyError,
  PromptCacheScopeExperimentUnavailableError,
  readPromptCacheScopeExperimentCompletedUsage,
} from "./scope-experiment-model.ts";
export { assertPromptCacheScopeExperimentTelemetryBaseline, readPromptCacheScopeExperimentTelemetryBaseline } from "./scope-experiment-targets.ts";

const existingCycles = (state: ExperimentState, evidenceValue: unknown): readonly CycleEvidence[] => {
  const evidence = parseEvidence(evidenceValue);
  if (!activeStateEvidenceIsConsistent(state, evidence)) {
    throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment evidence is inconsistent.");
  }
  return evidence?.cycles ?? [];
};

/** Durable state must still be the exact campaign row this cycle claimed. */
const requirePersistedState = (value: unknown, state: ExperimentState): ExperimentState => {
  const persisted = parseState(value);
  if (!persisted) {
    throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment state changed concurrently.");
  }
  if (
    persisted.started_at_ms !== state.started_at_ms ||
    persisted.campaign_owner !== state.campaign_owner ||
    !sameTargetDefinition(persisted.target, state.target)
  ) {
    throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment state changed concurrently.");
  }
  return persisted;
};

const persistIntermediate = async (kv: Kv, state: ExperimentState, cycleOwner: string, cycle: CycleEvidence, nextState: ExperimentState): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [stateEntry, evidenceEntry, cycleEntry, campaignEntry] = await Promise.all([
      kv.get<ExperimentState>(stateKey(state.target), { consistency: "strong" }),
      kv.get<StoredEvidence>(evidenceKey(state.target), { consistency: "strong" }),
      kv.get<ExperimentLease>(cycleLeaseKey(state.target), { consistency: "strong" }),
      kv.get<CampaignLease>(campaignLeaseKey(state.target), { consistency: "strong" }),
    ]);
    if (!ownsLease(cycleEntry.value, cycleOwner) || !ownsCampaignLease(campaignEntry.value, state)) {
      throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment lost its lease.");
    }
    const persistedState = requirePersistedState(stateEntry.value, state);
    if (persistedState.next_cycle !== state.next_cycle) {
      throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment state changed concurrently.");
    }
    const cycles = [...existingCycles(state, evidenceEntry.value), cycle];
    const evidence: StoredEvidence = {
      v: 3,
      target: nextState.target,
      outcome: nextState.next_cycle === PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES + 1 ? "ready_to_promote" : "in_progress",
      started_at_ms: state.started_at_ms,
      verified_at_ms: Date.now(),
      cycles,
    };
    const atomic = kv
      .atomic()
      .check(stateEntry)
      .check(evidenceEntry)
      .check(cycleEntry)
      .check(campaignEntry)
      .set(stateKey(nextState.target), nextState, { expireIn: Math.max(1, nextState.expires_at_ms - Date.now()) })
      .set(evidenceKey(nextState.target), evidence, { expireIn: Math.max(1, nextState.expires_at_ms - Date.now()) });
    if (nextState.next_cycle <= PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES) atomic.delete(cycleLeaseKey(state.target));
    const commit = await atomic.commit();
    if (commit.ok) return;
  }
  throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment evidence could not be persisted.");
};

type FinalizeOptions = Readonly<{
  scope?: ConcreteScopeObservation;
  reason?: InconclusiveReason;
  cycle?: CycleEvidence;
  completedCycles?: number;
}>;

const finalizeResult = (
  state: ExperimentState,
  outcome: "completed" | "inconclusive" | "failed",
  evidence: StoredEvidence,
  options: FinalizeOptions
): PromptCacheScopeExperimentResult => ({
  provider: PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER,
  telemetry_provider: CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER,
  target_id: state.target.id,
  model: state.target.model,
  status: outcome === "completed" ? "completed" : "inconclusive",
  completed_cycles: options.completedCycles ?? state.classifications.length + (options.cycle?.classification ? 1 : 0),
  verified_at_ms: evidence.verified_at_ms,
  ...(options.scope ? { scope: options.scope } : {}),
  ...(options.reason ? { inconclusive_reason: options.reason } : {}),
});

const finalize = async (
  kv: Kv,
  state: ExperimentState,
  cycleOwner: string,
  outcome: "completed" | "inconclusive" | "failed",
  options: FinalizeOptions = {}
): Promise<PromptCacheScopeExperimentResult> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [stateEntry, evidenceEntry, cycleEntry, campaignEntry] = await Promise.all([
      kv.get<ExperimentState>(stateKey(state.target), { consistency: "strong" }),
      kv.get<StoredEvidence>(evidenceKey(state.target), { consistency: "strong" }),
      kv.get<ExperimentLease>(cycleLeaseKey(state.target), { consistency: "strong" }),
      kv.get<CampaignLease>(campaignLeaseKey(state.target), { consistency: "strong" }),
    ]);
    if (!ownsLease(cycleEntry.value, cycleOwner) || !ownsCampaignLease(campaignEntry.value, state)) {
      throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment lost its lease.");
    }
    const persistedState = requirePersistedState(stateEntry.value, state);
    const prior = parseEvidence(evidenceEntry.value);
    if (!activeStateEvidenceIsConsistent(persistedState, prior)) {
      throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment evidence changed concurrently.");
    }
    const cycles = [...(prior?.cycles ?? []), ...(options.cycle ? [options.cycle] : [])];
    const evidence: StoredEvidence = {
      v: 3,
      target: state.target,
      outcome,
      started_at_ms: state.started_at_ms,
      verified_at_ms: Date.now(),
      cycles,
      ...(options.reason ? { inconclusive_reason: options.reason } : {}),
    };
    const commit = await kv
      .atomic()
      .check(stateEntry)
      .check(evidenceEntry)
      .check(cycleEntry)
      .check(campaignEntry)
      // Terminal evidence is the durable per-target campaign ledger. It is
      // redacted and must outlive the 15-minute active session so later
      // bodyless invocations can advance to sibling targets rather than
      // silently reprobe an already-terminal one.
      .set(evidenceKey(state.target), evidence)
      .delete(stateKey(state.target))
      .delete(cycleLeaseKey(state.target))
      .delete(campaignLeaseKey(state.target))
      .commit();
    if (!commit.ok) continue;
    return finalizeResult(state, outcome, evidence, options);
  }
  throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment final result could not be persisted.");
};

const assertRequestBodyStable = (body: Record<string, unknown>, expectedBody: string): void => {
  if (JSON.stringify(body) !== expectedBody) {
    throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment request body drifted.");
  }
};

/**
 * Row five refreshes the pinned slot exactly once. It returns the session and
 * binding the caller must use next, plus the reason the cycle stops, if any.
 */
const refreshMidCycleSession = async (
  kv: Kv,
  state: ExperimentState,
  cycleOwner: string,
  binding: PromptCacheScopeTargetBinding,
  session: CodexCacheScopeExperimentSession,
  cycleSignal: AbortSignal
): Promise<Readonly<{ reason: InconclusiveReason | null; session: CodexCacheScopeExperimentSession; binding: PromptCacheScopeTargetBinding }>> => {
  const beforeRefresh = await resolveBoundTarget(kv, binding);
  if (beforeRefresh.status !== "resolved") return { reason: beforeRefresh.reason, session, binding };
  const refreshedBinding = beforeRefresh.value.binding;
  await renewLease(kv, state, cycleOwner);
  const refresh = await refreshCodexCacheScopeExperimentSlot(session, 1, cycleSignal);
  if (refresh.status === "auth_pool_drift") return { reason: "auth_pool_drift", session, binding: refreshedBinding };
  if (!refresh.tokenChanged) return { reason: "refresh_unchanged", session: refresh.session, binding: refreshedBinding };
  return {
    reason: null,
    session: refresh.session,
    binding: { ...refreshedBinding, auth_pool_versionstamp: refresh.session.authPoolVersionstamp },
  };
};

/** A sample is evidence only when its signal and counters match the cycle's shape. */
const validateSampleSignal = (
  parsed: Extract<ReadSampleResult, { status: "sample" }>,
  index: number,
  reusableTokens: number | undefined
): InconclusiveReason | null => {
  const expectedSignal = CACHE_SCOPE_EXPECTED_SIGNALS[index] ?? null;
  if (expectedSignal !== null && parsed.signal !== expectedSignal) return "invalid_cache_signal";
  if (index > 0 && (reusableTokens === undefined || !matchesCycleReusableCounter(parsed.sample.usage, reusableTokens))) {
    return "invalid_cache_signal";
  }
  // Stop before another paid request: the mixed tuple cannot identify the
  // side of this discriminator that supplied the reusable prefix.
  if (CACHE_SCOPE_DISCRIMINATOR_INDEXES.has(index) && hasMixedPrefixScaleCacheSignals(parsed.sample.usage)) {
    return "invalid_cache_signal";
  }
  return null;
};

const runCycle = async (
  kv: Kv,
  state: ExperimentState,
  cycleOwner: string,
  cycleNumber: number,
  initialSession: CodexCacheScopeExperimentSession
): Promise<Readonly<{ evidence: CycleEvidence; session: CodexCacheScopeExperimentSession; binding: PromptCacheScopeTargetBinding }>> => {
  const cycleSignal = AbortSignal.timeout(PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLE_DEADLINE_MS);
  const body = buildExperimentRequest(state.target.model, crypto.randomUUID(), `uos-cache-scope-v5-${crypto.randomUUID()}`);
  const expectedBody = JSON.stringify(body);
  const conversationA = crypto.randomUUID();
  const conversationB = crypto.randomUUID();
  const conversations = [
    conversationA,
    conversationA,
    conversationA,
    conversationA,
    conversationA,
    conversationA,
    conversationA,
    conversationB,
    conversationB,
    conversationA,
  ] as const;
  const samples: PromptCacheScopeSample[] = [];
  const signals: CacheSignal[] = [];
  let session = initialSession;
  let binding = state.target;
  const inconclusive = (
    reason: InconclusiveReason
  ): Readonly<{ evidence: CycleEvidence; session: CodexCacheScopeExperimentSession; binding: PromptCacheScopeTargetBinding }> => ({
    evidence: { cycle: cycleNumber, samples, inconclusive_reason: reason },
    session,
    binding,
  });

  for (let index = 0; index < PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLES_PER_CYCLE; index += 1) {
    throwIfAborted(cycleSignal);
    if (index === 5) {
      const refresh = await refreshMidCycleSession(kv, state, cycleOwner, binding, session, cycleSignal);
      session = refresh.session;
      binding = refresh.binding;
      if (refresh.reason !== null) return inconclusive(refresh.reason);
    }
    await renewLease(kv, state, cycleOwner);
    // Every paid sample re-reads the canonical inventory. Exact target
    // capability, inventory, auth-pool, and client-version drift stops before
    // dispatch; a runtime default-only change simply refreshes the binding.
    const currentTarget = await resolveBoundTarget(kv, binding);
    if (currentTarget.status !== "resolved") return inconclusive(currentTarget.reason);
    binding = currentTarget.value.binding;
    assertRequestBodyStable(body, expectedBody);
    const startedAtMs = performance.now();
    const sampleSignal = AbortSignal.any([cycleSignal, AbortSignal.timeout(PROMPT_CACHE_SCOPE_EXPERIMENT_SAMPLE_DEADLINE_MS)]);
    const response = await fetchCodexResponsesForCacheScopeExperiment(body, {
      session,
      slot: CACHE_SCOPE_EXPECTED_SLOTS[index],
      conversationId: conversations[index],
      clientVersion: binding.catalog_client_version,
      signal: sampleSignal,
    });
    const parsed = await readPromptCacheScopeExperimentCompletedUsage(response, CACHE_SCOPE_EXPECTED_SLOTS[index], binding.model, startedAtMs, sampleSignal);
    if (parsed.status === "inconclusive") return inconclusive(parsed.reason);
    const invalidReason = validateSampleSignal(parsed, index, samples[0]?.usage.cache_write_tokens);
    if (invalidReason !== null) return inconclusive(invalidReason);
    samples.push({ step: CACHE_SCOPE_STEP_NAMES[index], ...parsed.sample });
    signals.push(parsed.signal);
  }
  const classification = classifyCycle(binding.model, samples, signals);
  return classification ? { evidence: { cycle: cycleNumber, samples, classification }, session, binding } : inconclusive("slot_drift");
};

const resultForIntermediate = (state: ExperimentState): PromptCacheScopeExperimentResult => ({
  provider: PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER,
  telemetry_provider: CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER,
  target_id: state.target.id,
  model: state.target.model,
  status: "in_progress",
  completed_cycles: state.classifications.length,
  verified_at_ms: Date.now(),
});

/** The promotion refusals use a different vocabulary from the runner's reasons. */
type PromotionFailureReason = Extract<PromptCacheScopePromotionResult, { status: "inconclusive" }>["reason"];

const PROMOTION_INCONCLUSIVE_REASONS = new Map<PromotionFailureReason, InconclusiveReason>([
  ["model_drift", "target_catalog_drift"],
  ["catalog_drift", "target_catalog_drift"],
  ["capability_changed", "target_catalog_drift"],
  ["auth_pool_drift", "auth_pool_drift"],
  ["runtime_drift", "runtime_drift"],
]);

const promotionInconclusiveReason = (reason: PromotionFailureReason): InconclusiveReason => PROMOTION_INCONCLUSIVE_REASONS.get(reason) ?? "promotion_conflict";

type ScopePromotion = Readonly<{ status: "promoted" }> | Readonly<{ status: "inconclusive"; reason: InconclusiveReason }>;

/** Publishes one concrete scope against the campaign's exact catalog revision. */
const promoteScope = async (kv: Kv, state: ExperimentState, cycleOwner: string, scope: ConcreteScopeObservation): Promise<ScopePromotion> => {
  const promotion = await promoteCodexPromptCacheScope(kv, {
    model: state.target.model,
    scope: {
      ...scope,
      reproducible_cycles: PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES,
      source: "live_probe",
      verified_at_ms: Date.now(),
    } satisfies PromptCacheScope,
    lease: { key: cycleLeaseKey(state.target), owner: cycleOwner },
    authPoolVersionstamp: state.auth_pool_versionstamp,
    catalogVersionstamp: state.target.catalog_versionstamp,
    runtimeVersionstamp: state.target.runtime_versionstamp,
  });
  return promotion.status === "promoted" ? { status: "promoted" } : { status: "inconclusive", reason: promotionInconclusiveReason(promotion.reason) };
};

/**
 * A successful promotion is recorded before the terminal write is awaited, so a
 * failure while finalizing can never downgrade promoted evidence to `failed`.
 */
type PromotionReceipt = { promoted: boolean };

const promoteResolvedScope = async (
  kv: Kv,
  state: ExperimentState,
  cycleOwner: string,
  scope: ConcreteScopeObservation,
  receipt: PromotionReceipt
): Promise<PromptCacheScopeExperimentResult> => {
  const promotion = await promoteScope(kv, state, cycleOwner, scope);
  if (promotion.status === "inconclusive") {
    return await finalize(kv, state, cycleOwner, "inconclusive", { reason: promotion.reason });
  }
  receipt.promoted = true;
  return await finalize(kv, state, cycleOwner, "completed", { scope });
};

const promotePendingScope = async (
  kv: Kv,
  state: ExperimentState,
  cycleOwner: string,
  receipt: PromotionReceipt
): Promise<PromptCacheScopeExperimentResult> => {
  const scope = state.pending_scope;
  if (!scope) return await finalize(kv, state, cycleOwner, "inconclusive", { reason: "cycle_disagreement" });
  return await promoteResolvedScope(kv, state, cycleOwner, scope, receipt);
};

type CycleCompletion =
  | Readonly<{ status: "finished"; result: PromptCacheScopeExperimentResult }>
  | Readonly<{ status: "ready_to_promote"; state: ExperimentState; scope: ConcreteScopeObservation }>;

/** Runs one fixed cycle, persists it, and reports whether only promotion is left. */
const completeCycle = async (
  kv: Kv,
  state: ExperimentState,
  cycleOwner: string,
  initialSession: CodexCacheScopeExperimentSession
): Promise<CycleCompletion> => {
  const cycle = await runCycle(kv, state, cycleOwner, state.next_cycle, initialSession);
  const classification = cycle.evidence.classification;
  if (!classification) {
    return {
      status: "finished",
      result: await finalize(kv, state, cycleOwner, "inconclusive", {
        reason: cycle.evidence.inconclusive_reason ?? "incomplete_telemetry",
        cycle: cycle.evidence,
      }),
    };
  }
  const classifications = [...state.classifications, classification];
  const nextCycle = state.next_cycle + 1;
  const agreed = classifications.length === PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES && sharedObservation(classifications) !== null;
  if (classifications.length === PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES && !agreed) {
    return {
      status: "finished",
      result: await finalize(kv, state, cycleOwner, "inconclusive", {
        reason: "cycle_disagreement",
        cycle: cycle.evidence,
        completedCycles: classifications.length,
      }),
    };
  }
  const nextState: ExperimentState = {
    ...state,
    target: cycle.binding,
    auth_pool_versionstamp: cycle.session.authPoolVersionstamp,
    next_cycle: nextCycle,
    classifications,
    ...(nextCycle === PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES + 1 ? { pending_scope: classification } : {}),
  };
  await persistIntermediate(kv, state, cycleOwner, cycle.evidence, nextState);
  if (nextCycle <= PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES) {
    return { status: "finished", result: resultForIntermediate(nextState) };
  }
  return { status: "ready_to_promote", state: nextState, scope: classification };
};

/** Maps a thrown cycle failure onto the error the admin route reports. */
const experimentFailure = (error: unknown): Error => {
  if (error instanceof PromptCacheScopeExperimentFailedError) return error;
  if (error instanceof CodexCacheScopeExperimentError) return new PromptCacheScopeExperimentFailedError(error.message);
  return new PromptCacheScopeExperimentFailedError(error instanceof Error ? error.message : "Prompt-cache scope experiment cycle failed.");
};

const handleCycleFailure = async (kv: Kv, state: ExperimentState, cycleOwner: string, error: unknown, promotionSucceeded: boolean): Promise<Error> => {
  if (error instanceof PromptCacheScopeExperimentBusyError || error instanceof PromptCacheScopeExperimentUnavailableError) return error;
  if (!promotionSucceeded) {
    try {
      await finalize(kv, state, cycleOwner, "failed");
    } catch {
      // A lost lease already fences this run. Its short expiry is the safe
      // fallback when terminal evidence cannot be persisted.
    }
  }
  return experimentFailure(error);
};

/** Fences the Stage 0 attestation before any OAuth-mutating campaign lease. */
const prepareCampaignRun = async (
  telemetryBaseline: PromptCacheScopeExperimentTelemetryBaseline
): Promise<Readonly<{ kv: Kv; session: CodexCacheScopeExperimentSession; binding: PromptCacheScopeTargetBinding }>> => {
  const kv = await getKv();
  if (!kv) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiments require Deno KV.");
  }
  const baselineTarget = parseTargetBinding(telemetryBaseline.target);
  if (!baselineTarget) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment requires a current-release Stage 0 telemetry baseline.");
  }
  // Close the Stage 0 TOCTOU window before acquiring an OAuth-mutating
  // campaign lease. A bodyless request may never resolve a different target.
  const preflight = await resolveBoundTarget(kv, baselineTarget);
  if (preflight.status !== "resolved") {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment target changed after its Stage 0 telemetry baseline.");
  }
  return { kv, session: await beginCodexCacheScopeExperiment(), binding: preflight.value.binding };
};

/** The claimed campaign row must still fence this session and target. */
const campaignGuardReason = (
  state: ExperimentState,
  binding: PromptCacheScopeTargetBinding,
  session: CodexCacheScopeExperimentSession
): InconclusiveReason | null => {
  if (state.expires_at_ms <= Date.now()) return "session_expired";
  if (state.auth_pool_versionstamp !== session.authPoolVersionstamp) return "auth_pool_drift";
  if (!sameTargetCore(state.target, binding)) return "target_catalog_drift";
  return null;
};

/**
 * Runs exactly one fixed ten-row cycle per invocation. The route is bodyless;
 * model, slots, prompt key, conversations, and provider stay gateway-owned.
 * The caller must supply the Stage 0 attestation it just read. The runner
 * fences target identity and refreshes only benign runtime-default changes.
 */
export const runPromptCacheScopeExperiment = async (
  telemetryBaseline: PromptCacheScopeExperimentTelemetryBaseline
): Promise<PromptCacheScopeExperimentResult> => {
  const { kv, session: initialSession, binding } = await prepareCampaignRun(telemetryBaseline);
  const { state, cycle_owner: cycleOwner } = await acquireCycle(kv, binding, initialSession.authPoolVersionstamp);
  const receipt: PromotionReceipt = { promoted: false };

  try {
    const guardReason = campaignGuardReason(state, binding, initialSession);
    if (guardReason !== null) {
      return await finalize(kv, state, cycleOwner, "inconclusive", { reason: guardReason });
    }

    const rebound = await resolveBoundTarget(kv, state.target);
    if (rebound.status !== "resolved") {
      return await finalize(kv, state, cycleOwner, "inconclusive", { reason: rebound.reason });
    }
    const boundState: ExperimentState = { ...state, target: rebound.value.binding };

    if (state.next_cycle === PROMPT_CACHE_SCOPE_EXPERIMENT_CYCLES + 1) {
      return await promotePendingScope(kv, boundState, cycleOwner, receipt);
    }
    const completion = await completeCycle(kv, boundState, cycleOwner, initialSession);
    if (completion.status === "finished") return completion.result;
    return await promoteResolvedScope(kv, completion.state, cycleOwner, completion.scope, receipt);
  } catch (error) {
    throw await handleCycleFailure(kv, state, cycleOwner, error, receipt.promoted);
  }
};
