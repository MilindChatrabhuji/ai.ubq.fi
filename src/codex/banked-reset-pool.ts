import type { Kv, KvEntryMaybe } from "#kv";
// Codex banked reset pool evaluation and shadow decisions, split out of src/codex_banked_reset.ts.

import { getKv } from "../kv.ts";
import { readCodexResetUsage as readBankedResetUsage } from "./reset-settings.ts";
import { providerTreatsRedeemOutcomeAsFinal, type ResetInventory, type ResetInventoryCredit } from "./banked-reset-provider.ts";
import type { CodexResetShadowDecisionRecord } from "../types.ts";
import { sha256Hex } from "../utils.ts";
import type {
  CodexBankedResetConfig,
  CodexBankedResetDependencies,
  CodexBankedResetOutcome,
  CodexBankedResetPoolCandidate,
  CodexBankedResetPoolOutcome,
  ResetContext,
} from "./banked-reset.ts";
import {
  CODEX_RESET_SHADOW_DECISION_KV_PREFIX,
  MAX_CAS_ATTEMPTS,
  boundedInventorySignal,
  codexResetShadowDecisionKey,
  defaultTelemetry,
  emit,
  isNonEmptyText,
  isSafeMs,
  isSafeNonnegativeInteger,
  metric,
  parseCodexResetShadowDecisionRecord,
  readUsageGate,
  telemetryFields,
} from "./banked-reset.ts";
import {
  makeResetContext,
  quotaWindowIsOpen,
  readClock,
  readCurrentFences,
  selectInventoryCredit,
  validInventory,
  withFenceChecks,
} from "./banked-reset-claim.ts";
import { attemptCodexBankedReset, openResetKv } from "./banked-reset-submission.ts";

type ResolvedPoolCandidate = Readonly<{
  pool: CodexBankedResetPoolCandidate;
  context: ResetContext;
}>;

type SelectedPoolCredit = Readonly<{
  resolved: ResolvedPoolCandidate;
  credit: ResetInventoryCredit;
  creditIdHash: string;
}>;

const poolOutcome = (
  kind: CodexBankedResetPoolOutcome["kind"],
  reason: string,
  selected: CodexBankedResetPoolCandidate | null = null,
  reset: CodexBankedResetOutcome | null = null
): CodexBankedResetPoolOutcome => ({ kind, reason, selected, reset });

const sameShadowFences = (left: CodexResetShadowDecisionRecord["fences"], right: CodexResetShadowDecisionRecord["fences"]): boolean =>
  left.length === right.length &&
  left.every((fence, index) => {
    // The lengths are equal, so this index is always inside `right`.
    const other = right[index];
    return (
      fence.slot === other.slot &&
      fence.account_id_hash === other.account_id_hash &&
      fence.quota_generation === other.quota_generation &&
      fence.routing_generation === other.routing_generation &&
      fence.quota_reset_at_ms === other.quota_reset_at_ms
    );
  });

const loadCurrentPoolConfig = (
  dependencies: CodexBankedResetDependencies
): Readonly<{ config: CodexBankedResetConfig; reason: null }> | Readonly<{ config: null; reason: string }> => {
  try {
    const config = dependencies.reloadConfig?.() ?? dependencies.config;
    if (!config.enabled) return { config: null, reason: "feature_disabled" };
    if (config.mode === "disabled") return { config: null, reason: "mode_disabled" };
    if (config.maxPerAccountPerDay <= 0) return { config: null, reason: "per_account_day_limit_invalid" };
    if (config.maxPerAccountPerWindow !== 1) return { config: null, reason: "per_account_window_limit_invalid" };
    return { config, reason: null };
  } catch {
    return { config: null, reason: "configuration_unavailable" };
  }
};

/**
 * An existing decision for this exact episode is a duplicate; anything else --
 * an unparseable record, a different episode, or an expired decision -- is
 * unusable and fails closed.
 */
const duplicateShadowDecision = (
  value: unknown,
  record: CodexResetShadowDecisionRecord,
  nowMs: number
): Readonly<{ kind: "duplicate"; record: CodexResetShadowDecisionRecord }> | null => {
  const existing = parseCodexResetShadowDecisionRecord(value);
  if (!existing) return null;
  if (existing.episode_hash !== record.episode_hash || existing.expires_at_ms <= nowMs) return null;
  return { kind: "duplicate", record: existing };
};

const shadowDecisionRecord = async (
  kv: Kv,
  record: CodexResetShadowDecisionRecord,
  nowMs: number,
  settingsEntries: KvEntryMaybe<unknown>[]
): Promise<Readonly<{ kind: "written" | "duplicate"; record: CodexResetShadowDecisionRecord }> | null> => {
  const key = codexResetShadowDecisionKey(record.episode_hash);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    let entry: KvEntryMaybe<unknown>;
    try {
      entry = await kv.get(key, { consistency: "strong" });
    } catch {
      return null;
    }
    if (entry.value !== null) return duplicateShadowDecision(entry.value, record, nowMs);
    try {
      const usage = record.selected_account_id_hash ? await readBankedResetUsage(kv, record.selected_account_id_hash) : { allowed: true, entries: [] };
      if (!usage.allowed) return null;
      const committed = await withFenceChecks(kv.atomic().check(entry), [...usage.entries, ...settingsEntries])
        .set(key, record)
        .commit();
      if (committed.ok) return { kind: "written", record };
    } catch {
      return null;
    }
  }
  return null;
};

const readShadowDecision = async (kv: Kv, episodeHash: string): Promise<CodexResetShadowDecisionRecord | null> => {
  try {
    const entry = await kv.get(codexResetShadowDecisionKey(episodeHash), { consistency: "strong" });
    return entry.value === null ? null : parseCodexResetShadowDecisionRecord(entry.value);
  } catch {
    return null;
  }
};

/** Read-only, redacted administrative projection of recent shadow evidence. */
export const listCodexResetShadowDecisions = async (kvOverride?: Kv | null): Promise<readonly CodexResetShadowDecisionRecord[] | null> => {
  let kv: Kv | null;
  try {
    kv = kvOverride === undefined ? await getKv() : kvOverride;
  } catch {
    return null;
  }
  if (!kv) return null;
  const decisions: CodexResetShadowDecisionRecord[] = [];
  try {
    for await (const entry of kv.list({ prefix: CODEX_RESET_SHADOW_DECISION_KV_PREFIX }, { limit: 100 })) {
      const parsed = parseCodexResetShadowDecisionRecord(entry.value);
      if (parsed) decisions.push(parsed);
    }
  } catch {
    return null;
  }
  decisions.sort((left, right) => right.created_at_ms - left.created_at_ms || left.episode_hash.localeCompare(right.episode_hash));
  return decisions;
};

/**
 * Evaluate one complete currently fenced blocked cohort. Shadow reads each
 * blocked account's inventory and persists exactly one redacted decision.
 * Live without a decision first performs that same read-only arm phase. A
 * later live evaluation repeats the fence and inventory proof; it reaches the
 * durable ledger only when the exact account and exact opaque credit still
 * match.
 */
/** Pool candidates in ascending slot order, or the reason the pool is malformed. */
const orderPoolCandidates = (
  candidates: readonly CodexBankedResetPoolCandidate[]
): Readonly<{ kind: "ordered"; ordered: readonly CodexBankedResetPoolCandidate[] }> | Readonly<{ kind: "failure"; reason: string }> => {
  if (!candidates.length) return { kind: "failure", reason: "full_pool_missing" };
  const ordered = [...candidates].sort((left, right) => left.slot - right.slot);
  if (!poolSlotsAreValid(ordered)) return { kind: "failure", reason: "full_pool_invalid" };
  return { kind: "ordered", ordered };
};

/** Slots must be safe non-negative integers and unique after the sort. */
const poolSlotsAreValid = (ordered: readonly CodexBankedResetPoolCandidate[]): boolean => {
  let previousSlot: number | null = null;
  for (const candidate of ordered) {
    if (!isSafeNonnegativeInteger(candidate.slot)) return false;
    if (previousSlot !== null && previousSlot === candidate.slot) return false;
    previousSlot = candidate.slot;
  }
  return true;
};

const anyPoolProviderTreatsRedeemOutcomeAsFinal = (ordered: readonly CodexBankedResetPoolCandidate[]): boolean =>
  ordered.some(({ provider }) => providerTreatsRedeemOutcomeAsFinal(provider));

/** Pool policy gate: the usable configuration, or the reason the pool stops. */
const loadPoolSubmissionConfig = (
  ordered: readonly CodexBankedResetPoolCandidate[],
  dependencies: CodexBankedResetDependencies
): Readonly<{ kind: "config"; config: CodexBankedResetConfig }> | Readonly<{ kind: "failure"; reason: string }> => {
  const loadedConfig = loadCurrentPoolConfig(dependencies);
  if (!loadedConfig.config) return { kind: "failure", reason: loadedConfig.reason };
  const config = loadedConfig.config;
  if (config.mode === "live" && config.maxPerAccountPerDay !== 1) {
    return {
      kind: "failure",
      reason: anyPoolProviderTreatsRedeemOutcomeAsFinal(ordered) ? "terminal_outcome_account_day_limit_must_be_one" : "per_account_day_limit_invalid",
    };
  }
  return { kind: "config", config };
};

/** Every candidate must produce a valid reset context, or the pool is unusable. */
const resolvePoolCandidates = async (
  ordered: readonly CodexBankedResetPoolCandidate[],
  hash: (value: string) => Promise<string>
): Promise<ResolvedPoolCandidate[] | null> => {
  const resolved = await Promise.all(
    ordered.map(async (pool) => {
      const context = await makeResetContext(pool.candidate, hash);
      return context ? ({ pool, context } satisfies ResolvedPoolCandidate) : null;
    })
  );
  if (resolved.some((candidate) => candidate === null)) return null;
  return resolved as ResolvedPoolCandidate[];
};

/** The redacted fence evidence that identifies one episode. */
const poolFences = (complete: readonly ResolvedPoolCandidate[]): CodexResetShadowDecisionRecord["fences"] =>
  complete.map(({ pool, context }) => ({
    slot: pool.slot,
    account_id_hash: context.account.accountIdHash,
    quota_generation: context.account.quotaGeneration,
    routing_generation: pool.candidate.routingGeneration,
    quota_reset_at_ms: pool.candidate.quotaResetAtMs,
  }));

/** Episode hash, or null when the hash cannot be used as an audit key. */
const poolEpisodeHash = async (
  settingsVersion: string,
  fences: CodexResetShadowDecisionRecord["fences"],
  hash: (value: string) => Promise<string>
): Promise<string | null> => {
  const episodeHash = await hash(
    `uos_ai\u0000codex_reset_shadow_episode\u0000${settingsVersion}\u0000${fences
      .map(
        (fence) => `${fence.slot}\u0000${fence.account_id_hash}\u0000${fence.quota_generation}\u0000${fence.routing_generation}\u0000${fence.quota_reset_at_ms}`
      )
      .join("\u0001")}`
  );
  return isNonEmptyText(episodeHash) ? episodeHash : null;
};

/**
 * Re-check every fence. A selection based on any stale account state is not
 * audit evidence and can never become a live spend.
 */
const stalePoolFenceReason = async (kv: Kv, complete: readonly ResolvedPoolCandidate[]): Promise<string | null> => {
  for (const { pool } of complete) {
    const current = await readCurrentFences(kv, pool.candidate);
    if (current.kind !== "valid") return current.kind === "stale" ? "routing_fence_stale" : current.code;
  }
  return null;
};

/** A persisted audit decision only counts while it proves this exact episode. */
const auditedDecisionMatches = (audited: CodexResetShadowDecisionRecord, fences: CodexResetShadowDecisionRecord["fences"], nowMs: number): boolean =>
  audited.expires_at_ms > nowMs && audited.decision_reason === "selected" && sameShadowFences(audited.fences, fences);

/** Live mode reads its arm evidence; `audited === null` means arming is needed. */
const resolveLiveArmingState = async (
  kv: Kv,
  config: CodexBankedResetConfig,
  dependencies: CodexBankedResetDependencies,
  episodeHash: string,
  fences: CodexResetShadowDecisionRecord["fences"],
  nowMs: number
): Promise<
  | Readonly<{ kind: "state"; audited: CodexResetShadowDecisionRecord | null; liveNeedsArming: boolean }>
  | Readonly<{ kind: "outcome"; outcome: CodexBankedResetPoolOutcome }>
> => {
  if (config.mode !== "live" || dependencies.allowLiveWithoutShadowForTest) return { kind: "state", audited: null, liveNeedsArming: false };
  const audited = await readShadowDecision(kv, episodeHash);
  if (audited && !auditedDecisionMatches(audited, fences, nowMs)) {
    return { kind: "outcome", outcome: poolOutcome("skipped", "shadow_decision_missing_or_expired") };
  }
  return { kind: "state", audited, liveNeedsArming: audited === null };
};

/** The episode evidence: proven contexts, fences, hash, and live arm state. */
const preparePoolEpisode = async (
  kv: Kv,
  ordered: readonly CodexBankedResetPoolCandidate[],
  config: CodexBankedResetConfig,
  dependencies: CodexBankedResetDependencies,
  hash: (value: string) => Promise<string>,
  nowMs: number
): Promise<
  | Readonly<{
      kind: "episode";
      complete: ResolvedPoolCandidate[];
      eligible: ResolvedPoolCandidate[];
      settingsEntries: KvEntryMaybe<unknown>[];
      fences: CodexResetShadowDecisionRecord["fences"];
      episodeHash: string;
      audited: CodexResetShadowDecisionRecord | null;
      liveNeedsArming: boolean;
    }>
  | Readonly<{ kind: "outcome"; outcome: CodexBankedResetPoolOutcome }>
> => {
  const complete = await resolvePoolCandidates(ordered, hash);
  if (!complete) return { kind: "outcome", outcome: poolOutcome("skipped", "invalid_quota_generation") };
  if (complete.some(({ pool }) => !quotaWindowIsOpen(pool.candidate, nowMs))) {
    return { kind: "outcome", outcome: poolOutcome("skipped", "quota_window_expired") };
  }
  // Reset settings are owned by the subscription: a disabled account is removed
  // from this episode's candidate list, while an unreadable record fails the
  // whole episode closed instead of silently spending.
  let settings: { entry: ResolvedPoolCandidate; usage: Awaited<ReturnType<typeof readBankedResetUsage>> }[];
  try {
    settings = await Promise.all(complete.map(async (entry) => ({ entry, usage: await readBankedResetUsage(kv, entry.context.account.accountIdHash) })));
  } catch {
    return { kind: "outcome", outcome: poolOutcome("skipped", "configuration_unavailable") };
  }
  const eligible = settings.filter(({ usage }) => usage.allowed).map(({ entry }) => entry);
  if (!eligible.length) return { kind: "outcome", outcome: poolOutcome("skipped", "usage_disabled") };
  const settingsEntries = settings.flatMap(({ usage }) => usage.entries);
  const settingsVersion = settingsEntries.map((entry) => entry.versionstamp ?? "unset").join(",");
  const fences = poolFences(complete);
  const episodeHash = await poolEpisodeHash(settingsVersion, fences, hash);
  if (!episodeHash) return { kind: "outcome", outcome: poolOutcome("skipped", "episode_hash_unavailable") };
  const arming = await resolveLiveArmingState(kv, config, dependencies, episodeHash, fences, nowMs);
  if (arming.kind === "outcome") return { kind: "outcome", outcome: arming.outcome };
  return {
    kind: "episode",
    complete,
    eligible,
    settingsEntries,
    fences,
    episodeHash,
    audited: arming.audited,
    liveNeedsArming: arming.liveNeedsArming,
  };
};

/** The pool was already rejected as `full_pool_missing`, so it is never empty. */
const firstResolvedPoolCandidate = (complete: readonly ResolvedPoolCandidate[]): ResolvedPoolCandidate => {
  const first = complete.at(0);
  if (!first) throw new Error("codex banked reset pool is empty");
  return first;
};

/** The already-persisted shadow decision for this episode, when it still holds. */
const existingShadowDecisionOutcome = async (
  kv: Kv,
  config: CodexBankedResetConfig,
  dependencies: CodexBankedResetDependencies,
  complete: readonly ResolvedPoolCandidate[],
  episodeHash: string,
  fences: CodexResetShadowDecisionRecord["fences"],
  nowMs: number
): Promise<CodexBankedResetPoolOutcome | null> => {
  if (config.mode !== "shadow") return null;
  const existing = await readShadowDecision(kv, episodeHash);
  if (existing === null) return null;
  if (existing.expires_at_ms <= nowMs) return null;
  if (!sameShadowFences(existing.fences, fences)) return null;
  const selected = complete.find(({ context }) => context.account.accountIdHash === existing.selected_account_id_hash) ?? null;
  // A subscription disabled after its decision was persisted must not report a
  // duplicate would-spend, let alone arm a live spend. An unreadable record
  // fails this duplicate path closed through the same structured outcome the
  // rest of the evaluator returns, instead of rejecting out of it.
  if (selected) {
    const gate = await readUsageGate(kv, selected.context.account.accountIdHash);
    if (gate.kind === "failure") return poolOutcome("skipped", gate.code);
  }
  const telemetry = dependencies.telemetry ?? defaultTelemetry;
  const telemetryCandidate = selected ?? firstResolvedPoolCandidate(complete);
  const fields = telemetryFields(telemetryCandidate.context, telemetryCandidate.pool.candidate, {
    episode_hash: episodeHash,
    credit_id_hash: existing.selected_credit_id_hash,
    selected: existing.selected_account_id_hash !== null,
    reason: existing.decision_reason,
  });
  emit(telemetry, "codex_reset_duplicate_prevented", { ...fields, reason: "shadow_decision_exists" });
  metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
  const wouldSpend =
    existing.decision_reason === "selected" && existing.selected_account_id_hash !== null && existing.selected_credit_id_hash !== null && selected !== null;
  return poolOutcome("shadow", wouldSpend ? "already_would_spend_once" : existing.decision_reason, wouldSpend ? selected.pool : null);
};

/**
 * Evaluate one complete currently fenced blocked cohort. Shadow reads each
 * blocked account's inventory and persists exactly one redacted decision.
 * Live without a decision first performs that same read-only arm phase. A
 * later live evaluation repeats the fence and inventory proof; it reaches the
 * durable ledger only when the exact account and exact opaque credit still
 * match.
 */
export const evaluateCodexBankedResetPool = async (
  candidates: readonly CodexBankedResetPoolCandidate[],
  dependencies: CodexBankedResetDependencies
): Promise<CodexBankedResetPoolOutcome> => {
  const clock = dependencies.now ?? Date.now;
  const nowMs = readClock(clock);
  if (nowMs === null) return poolOutcome("skipped", "invalid_clock");
  const orderedResult = orderPoolCandidates(candidates);
  if (orderedResult.kind === "failure") return poolOutcome("skipped", orderedResult.reason);
  const ordered = orderedResult.ordered;
  const configResult = loadPoolSubmissionConfig(ordered, dependencies);
  if (configResult.kind === "failure") return poolOutcome("skipped", configResult.reason);
  const config = configResult.config;
  const kv = await openResetKv(dependencies);
  if (!kv) return poolOutcome("skipped", "kv_unavailable");
  const hash = dependencies.hash ?? sha256Hex;
  const episode = await preparePoolEpisode(kv, ordered, config, dependencies, hash, nowMs);
  if (episode.kind === "outcome") return episode.outcome;
  const staleFence = await stalePoolFenceReason(kv, episode.complete);
  if (staleFence) return poolOutcome("skipped", staleFence);
  const duplicateShadow = await existingShadowDecisionOutcome(kv, config, dependencies, episode.complete, episode.episodeHash, episode.fences, nowMs);
  if (duplicateShadow) return duplicateShadow;

  const observed = await observePoolInventories(kv, episode.eligible, clock);
  if (observed.kind === "outcome") return observed.outcome;
  const selection = await selectPoolCredits(observed.inventoryResults, observed.nowMs, hash);
  if (selection.kind === "outcome") return selection.outcome;
  const decisionResult = buildShadowDecision(episode.episodeHash, observed.nowMs, selection.decisionReason, selection.selected, episode.fences);
  if (decisionResult.kind === "outcome") return decisionResult.outcome;
  const decision = decisionResult.decision;
  if (config.mode === "shadow") {
    return await persistShadowDecisionOutcome(
      kv,
      decision,
      episode.episodeHash,
      dependencies,
      episode.complete,
      episode.settingsEntries,
      selection,
      observed.nowMs
    );
  }
  return await runLivePoolSubmission(kv, dependencies, episode, decision, selection, observed.nowMs);
};

type PoolInventoryObservation = Readonly<{ resolvedCandidate: ResolvedPoolCandidate; inventory: ResetInventory | null }>;

/** Read every candidate's inventory concurrently; a failed read is recorded as null. */
const readPoolInventories = async (complete: readonly ResolvedPoolCandidate[]): Promise<readonly PoolInventoryObservation[]> =>
  await Promise.all(
    complete.map(async (resolvedCandidate) => {
      try {
        const inventory = await resolvedCandidate.pool.provider.readInventory(
          resolvedCandidate.context.account,
          boundedInventorySignal(resolvedCandidate.pool.candidate.signal)
        );
        return { resolvedCandidate, inventory } as const;
      } catch {
        return { resolvedCandidate, inventory: null } as const;
      }
    })
  );

/** Narrows an observation to one that carries a real inventory. */
const hasPoolInventory = (
  observation: PoolInventoryObservation
): observation is Readonly<{ resolvedCandidate: ResolvedPoolCandidate; inventory: ResetInventory }> => observation.inventory !== null;

/**
 * Read every inventory, then re-prove the fences and the observed windows.
 * A selection based on any stale account state is not audit evidence and can
 * never become a live spend.
 */
const observePoolInventories = async (
  kv: Kv,
  complete: readonly ResolvedPoolCandidate[],
  clock: () => number
): Promise<
  | Readonly<{ kind: "observed"; inventoryResults: readonly PoolInventoryObservation[]; nowMs: number }>
  | Readonly<{ kind: "outcome"; outcome: CodexBankedResetPoolOutcome }>
> => {
  const inventoryResults = await readPoolInventories(complete);
  const nowMs = readClock(clock);
  if (nowMs === null) return { kind: "outcome", outcome: poolOutcome("skipped", "invalid_clock") };
  if (inventoryResults.some(({ inventory }) => inventory === null)) {
    return { kind: "outcome", outcome: poolOutcome("skipped", "inventory_unavailable") };
  }
  const staleFence = await stalePoolFenceReason(kv, complete);
  if (staleFence) return { kind: "outcome", outcome: poolOutcome("skipped", staleFence) };
  if (complete.some(({ pool }) => !quotaWindowIsOpen(pool.candidate, nowMs))) {
    return { kind: "outcome", outcome: poolOutcome("skipped", "quota_window_expired") };
  }
  return { kind: "observed", inventoryResults, nowMs };
};

/**
 * A pool inventory is only selectable while it validates and no credit that is
 * still marked available has already expired.
 */
const poolInventoryIsUsable = (inventory: ResetInventory, nowMs: number): boolean =>
  validInventory(inventory, nowMs) &&
  !inventory.credits.some((credit) => credit.status === "available" && credit.expiresAtMs !== null && credit.expiresAtMs <= nowMs);

/** Pick one usable credit per candidate and rank them deterministically. */
const selectPoolCredits = async (
  inventoryResults: readonly PoolInventoryObservation[],
  nowMs: number,
  hash: (value: string) => Promise<string>
): Promise<
  | Readonly<{ kind: "selection"; selected: SelectedPoolCredit | null; decisionReason: string }>
  | Readonly<{ kind: "outcome"; outcome: CodexBankedResetPoolOutcome }>
> => {
  const selectedCredits: SelectedPoolCredit[] = [];
  let decisionReason = "inventory_empty";
  for (const observation of inventoryResults) {
    if (!hasPoolInventory(observation)) continue;
    const inventory = observation.inventory;
    if (!poolInventoryIsUsable(inventory, nowMs)) {
      decisionReason = "inventory_response_invalid_or_expired";
      selectedCredits.length = 0;
      break;
    }
    const selection = selectInventoryCredit(inventory, observation.resolvedCandidate.pool.provider, nowMs);
    if (selection.kind !== "selected") {
      if (selection.kind === "no_eligible_credit") decisionReason = "inventory_no_eligible_codex_credit";
      continue;
    }
    const creditIdHash = await hash(`uos_ai\u0000codex_reset_credit\u0000${selection.credit.id}`);
    if (!isNonEmptyText(creditIdHash)) return { kind: "outcome", outcome: poolOutcome("skipped", "credit_hash_unavailable") };
    selectedCredits.push({ resolved: observation.resolvedCandidate, credit: selection.credit, creditIdHash });
  }
  selectedCredits.sort((left, right) => {
    const leftExpiry = left.credit.expiresAtMs ?? Number.POSITIVE_INFINITY;
    const rightExpiry = right.credit.expiresAtMs ?? Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry || left.resolved.pool.slot - right.resolved.pool.slot || left.credit.id.localeCompare(right.credit.id);
  });
  const selected = selectedCredits.at(0) ?? null;
  if (selected) return { kind: "selection", selected, decisionReason: "selected" };
  return { kind: "selection", selected: null, decisionReason: decisionReason === "inventory_empty" ? "no_eligible_credit" : decisionReason };
};

/** The redacted decision record, or the reason it must not be written. */
const buildShadowDecision = (
  episodeHash: string,
  nowMs: number,
  decisionReason: string,
  selected: SelectedPoolCredit | null,
  fences: CodexResetShadowDecisionRecord["fences"]
): Readonly<{ kind: "decision"; decision: CodexResetShadowDecisionRecord }> | Readonly<{ kind: "outcome"; outcome: CodexBankedResetPoolOutcome }> => {
  const episodeExpiresAtMs = Math.min(...fences.map((fence) => fence.quota_reset_at_ms), selected?.credit.expiresAtMs ?? Number.POSITIVE_INFINITY);
  if (!isSafeMs(episodeExpiresAtMs) || episodeExpiresAtMs <= nowMs) {
    return { kind: "outcome", outcome: poolOutcome("skipped", "shadow_decision_expired") };
  }
  return {
    kind: "decision",
    decision: {
      v: 1,
      episode_hash: episodeHash,
      created_at_ms: nowMs,
      expires_at_ms: episodeExpiresAtMs,
      decision_reason: decisionReason,
      selected_account_id_hash: selected?.resolved.context.account.accountIdHash ?? null,
      selected_credit_id_hash: selected?.creditIdHash ?? null,
      selected_credit_expires_at_ms: selected?.credit.expiresAtMs ?? null,
      fences,
    },
  };
};

/** Persist the shadow decision and emit the telemetry that describes it. */
const persistShadowDecisionOutcome = async (
  kv: Kv,
  decision: CodexResetShadowDecisionRecord,
  episodeHash: string,
  dependencies: CodexBankedResetDependencies,
  complete: readonly ResolvedPoolCandidate[],
  settingsEntries: KvEntryMaybe<unknown>[],
  selection: Readonly<{ selected: SelectedPoolCredit | null; decisionReason: string }>,
  nowMs: number
): Promise<CodexBankedResetPoolOutcome> => {
  const selected = selection.selected;
  const persisted = await shadowDecisionRecord(kv, decision, nowMs, settingsEntries);
  if (!persisted) return poolOutcome("skipped", "shadow_decision_unavailable");
  const telemetry = dependencies.telemetry ?? defaultTelemetry;
  const telemetryCandidate = selected?.resolved ?? firstResolvedPoolCandidate(complete);
  const fields = telemetryFields(telemetryCandidate.context, telemetryCandidate.pool.candidate, {
    episode_hash: episodeHash,
    credit_id_hash: selected?.creditIdHash ?? null,
    selected: selected !== null,
    reason: persisted.record.decision_reason,
  });
  if (persisted.kind === "duplicate") {
    emit(telemetry, "codex_reset_duplicate_prevented", { ...fields, reason: "shadow_decision_exists" });
    metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
    return poolOutcome("shadow", "already_would_spend_once", selected?.resolved.pool ?? null);
  }
  emit(telemetry, "codex_reset_eligible", fields);
  emit(telemetry, "codex_reset_shadow_candidate", fields);
  metric(telemetry, "codex_reset_eligible_total", 1, fields);
  metric(telemetry, "codex_reset_shadow_candidates_total", 1, fields);
  return poolOutcome("shadow", selected ? "shadow_selected" : selection.decisionReason, selected?.resolved.pool ?? null);
};

/** Arm a live episode with the persisted decision for its exact evidence. */
const armLiveWithShadowDecision = async (
  kv: Kv,
  decision: CodexResetShadowDecisionRecord,
  dependencies: CodexBankedResetDependencies,
  settingsEntries: KvEntryMaybe<unknown>[],
  selected: SelectedPoolCredit,
  nowMs: number
): Promise<CodexBankedResetPoolOutcome> => {
  const persisted = await shadowDecisionRecord(kv, decision, nowMs, settingsEntries);
  if (!persisted) return poolOutcome("skipped", "shadow_decision_unavailable");
  if (
    persisted.record.decision_reason !== "selected" ||
    persisted.record.selected_account_id_hash !== selected.resolved.context.account.accountIdHash ||
    persisted.record.selected_credit_id_hash !== selected.creditIdHash ||
    persisted.record.selected_credit_expires_at_ms !== selected.credit.expiresAtMs ||
    !sameShadowFences(persisted.record.fences, decision.fences)
  )
    return poolOutcome("skipped", "shadow_decision_drift");

  const telemetry = dependencies.telemetry ?? defaultTelemetry;
  const fields = telemetryFields(selected.resolved.context, selected.resolved.pool.candidate, {
    episode_hash: decision.episode_hash,
    credit_id_hash: selected.creditIdHash,
    selected: true,
    reason: persisted.record.decision_reason,
  });
  if (persisted.kind === "duplicate") {
    emit(telemetry, "codex_reset_duplicate_prevented", { ...fields, reason: "shadow_decision_exists" });
    metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
  } else {
    emit(telemetry, "codex_reset_eligible", fields);
    emit(telemetry, "codex_reset_shadow_candidate", fields);
    metric(telemetry, "codex_reset_eligible_total", 1, fields);
    metric(telemetry, "codex_reset_shadow_candidates_total", 1, fields);
  }
  return poolOutcome("shadow", "live_armed", selected.resolved.pool);
};

/** The audit evidence must still name this exact account and exact credit. */
const liveAuditMatches = (audited: CodexResetShadowDecisionRecord | null, selected: SelectedPoolCredit, nowMs: number): boolean => {
  if (audited === null) return false;
  if (audited.expires_at_ms <= nowMs) return false;
  return (
    audited.selected_account_id_hash === selected.resolved.context.account.accountIdHash &&
    audited.selected_credit_id_hash === selected.creditIdHash &&
    audited.selected_credit_expires_at_ms === selected.credit.expiresAtMs
  );
};

/** The live tail: arming or audit proof, then one durable submission attempt. */
const runLivePoolSubmission = async (
  kv: Kv,
  dependencies: CodexBankedResetDependencies,
  episode: Readonly<{
    complete: ResolvedPoolCandidate[];
    settingsEntries: KvEntryMaybe<unknown>[];
    episodeHash: string;
    audited: CodexResetShadowDecisionRecord | null;
    liveNeedsArming: boolean;
  }>,
  decision: CodexResetShadowDecisionRecord,
  selection: Readonly<{ selected: SelectedPoolCredit | null; decisionReason: string }>,
  nowMs: number
): Promise<CodexBankedResetPoolOutcome> => {
  // Preserve the precise inventory failure in live mode. This is especially
  // useful for an expired credit after a valid shadow decision: it proves
  // that no external redemption was attempted because the fresh inventory
  // itself was no longer eligible.
  const selected = selection.selected;
  if (!selected) return poolOutcome("skipped", selection.decisionReason);
  if (episode.liveNeedsArming) return await armLiveWithShadowDecision(kv, decision, dependencies, episode.settingsEntries, selected, nowMs);
  if (!dependencies.allowLiveWithoutShadowForTest && !liveAuditMatches(episode.audited, selected, nowMs)) {
    return poolOutcome("skipped", "shadow_decision_drift");
  }
  // The durable claim/submission path must continue to fence every blocked
  // account that established the audited episode, not just the selected
  // owner. Recovery or rotation after the shadow read makes the episode stale
  // and must block the external consume.
  const fullPoolFences = episode.complete.flatMap(({ pool }) => pool.candidate.fences);
  const reset = await attemptCodexBankedReset(
    { ...selected.resolved.pool.candidate, fences: fullPoolFences, selectedCredit: selected.credit },
    { ...dependencies, provider: selected.resolved.pool.provider }
  );
  return poolOutcome(reset.kind, reset.reason, selected.resolved.pool, reset);
};
