import type { Kv, KvEntryMaybe } from "#kv";
// Prompt cache scope experiment target binding, telemetry baseline and leases, split out of src/prompt_cache_scope_experiment.ts.

import { PROMPT_CACHE_SCOPE_PROBE_PROFILE } from "../models/codex-models.ts";
import { getKv } from "../kv.ts";
import { type PromptCacheTelemetryBaselineResult, readPromptCacheTelemetryBaseline } from "./telemetry-gate.ts";
import { loadPromptCacheScopeTargetInventory, type PromptCacheScopeTarget, type PromptCacheScopeTargetInventory } from "./scope-targets.ts";
import { normalizeRuntimeConfig, RUNTIME_CONFIG_V2_KEY, type RuntimeConfigV2 } from "../runtime-config.ts";
import { getString, isRecord } from "../utils.ts";
import {
  activeStateEvidenceIsConsistent,
  campaignLeaseKey,
  CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER,
  cycleLeaseKey,
  evidenceKey,
  isSafeNonNegativeInteger,
  ownsCampaignLease,
  ownsLease,
  parseEvidence,
  parseState,
  PROMPT_CACHE_SCOPE_EXPERIMENT_LEASE_MS,
  PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER,
  PROMPT_CACHE_SCOPE_EXPERIMENT_SESSION_MS,
  PromptCacheScopeExperimentBusyError,
  PromptCacheScopeExperimentFailedError,
  PromptCacheScopeExperimentUnavailableError,
  sameLiteralField,
  sameTargetDefinition,
  stateKey,
} from "./scope-experiment-model.ts";
import type {
  CampaignLease,
  ExperimentLease,
  ExperimentState,
  InconclusiveReason,
  PromptCacheScopeExperimentTelemetryBaseline,
  PromptCacheScopeExperimentTelemetryBaselineTestOptions,
  PromptCacheScopeTargetBinding,
  RuntimeBinding,
  StoredEvidence,
} from "./scope-experiment-model.ts";

type ResolvedScopeTarget = Readonly<{ binding: PromptCacheScopeTargetBinding }>;
type ScopeTargetResolution = Readonly<{ status: "resolved"; value: ResolvedScopeTarget }> | Readonly<{ status: "inconclusive"; reason: InconclusiveReason }>;

const loadRuntimeBinding = async (kv: Kv): Promise<RuntimeBinding | null> => {
  const entry = await kv.get<RuntimeConfigV2>(RUNTIME_CONFIG_V2_KEY, { consistency: "strong" });
  const runtime = normalizeRuntimeConfig(entry.value);
  if (!runtime || !entry.versionstamp) return null;
  return { versionstamp: entry.versionstamp, default_model: runtime.default_model };
};

const targetBindingFromInventory = (
  inventory: PromptCacheScopeTargetInventory,
  target: PromptCacheScopeTarget,
  runtime: RuntimeBinding
): PromptCacheScopeTargetBinding | null => {
  const inventoryFingerprint = getString(inventory.inventory_fingerprint)?.trim();
  const catalogVersionstamp = getString(target.catalog_versionstamp)?.trim();
  const authPoolVersionstamp = getString(target.codex_auth_pool_versionstamp)?.trim();
  const authPoolIdentityFingerprint = getString(target.codex_auth_pool_identity_fingerprint)?.trim();
  const model = target.model.trim();
  const targetId = target.id.trim();
  const capabilityFingerprint = target.capability_fingerprint.trim();
  const clientVersion = target.catalog_client_version === null ? null : target.catalog_client_version.trim() || null;
  if (
    inventory.status !== "ready" ||
    !inventoryFingerprint ||
    !catalogVersionstamp ||
    !authPoolVersionstamp ||
    !authPoolIdentityFingerprint ||
    !model ||
    !targetId ||
    !capabilityFingerprint ||
    target.provider !== PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER ||
    target.telemetry_provider !== CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER ||
    target.topology.kind !== "codex_account_pool" ||
    target.probeability.status !== "probeable"
  )
    return null;
  return {
    id: targetId,
    provider: PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER,
    telemetry_provider: CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER,
    topology_kind: "codex_account_pool",
    model,
    probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
    capability_fingerprint: capabilityFingerprint,
    inventory_fingerprint: inventoryFingerprint,
    catalog_versionstamp: catalogVersionstamp,
    runtime_versionstamp: runtime.versionstamp,
    auth_pool_versionstamp: authPoolVersionstamp,
    auth_pool_identity_fingerprint: authPoolIdentityFingerprint,
    catalog_client_version: clientVersion,
  };
};

const sameTargetCore = (left: PromptCacheScopeTargetBinding, right: PromptCacheScopeTargetBinding): boolean =>
  left.id === right.id &&
  sameLiteralField(left.provider, right.provider) &&
  sameLiteralField(left.telemetry_provider, right.telemetry_provider) &&
  sameLiteralField(left.topology_kind, right.topology_kind) &&
  left.model === right.model &&
  sameLiteralField(left.probe_profile, right.probe_profile) &&
  left.capability_fingerprint === right.capability_fingerprint &&
  left.auth_pool_identity_fingerprint === right.auth_pool_identity_fingerprint &&
  left.catalog_client_version === right.catalog_client_version;

const loadInventoryAndRuntime = async (kv: Kv): Promise<Readonly<{ inventory: PromptCacheScopeTargetInventory; runtime: RuntimeBinding }> | null> => {
  const [inventory, runtime] = await Promise.all([loadPromptCacheScopeTargetInventory({ kv }), loadRuntimeBinding(kv)]);
  if (inventory.status !== "ready" || !runtime) return null;
  return { inventory, runtime };
};

/**
 * Re-read the canonical target before a paid sample. Runtime/default-model
 * changes are harmless when the exact target is stable. Catalog capability,
 * inventory, auth-pool, and client-version bindings instead fence dispatch.
 */
const resolveBoundTarget = async (kv: Kv, expected: PromptCacheScopeTargetBinding): Promise<ScopeTargetResolution> => {
  const loaded = await loadInventoryAndRuntime(kv);
  if (!loaded) return { status: "inconclusive", reason: "target_catalog_drift" };
  const current = loaded.inventory.targets.find((target) => target.id === expected.id);
  const currentBinding = current ? targetBindingFromInventory(loaded.inventory, current, loaded.runtime) : null;
  if (!currentBinding) {
    return { status: "inconclusive", reason: "target_catalog_drift" };
  }
  if (currentBinding.auth_pool_identity_fingerprint !== expected.auth_pool_identity_fingerprint) {
    return { status: "inconclusive", reason: "auth_pool_drift" };
  }
  if (!sameTargetCore(currentBinding, expected)) return { status: "inconclusive", reason: "target_catalog_drift" };
  if (currentBinding.inventory_fingerprint !== expected.inventory_fingerprint) {
    return { status: "inconclusive", reason: "inventory_drift" };
  }
  if (currentBinding.auth_pool_versionstamp !== expected.auth_pool_versionstamp) {
    return { status: "inconclusive", reason: "auth_pool_drift" };
  }
  return { status: "resolved", value: { binding: currentBinding } };
};

type SelectedCampaignTarget = Readonly<{ binding: PromptCacheScopeTargetBinding; active_state?: ExperimentState }>;

/** One target's parsed durable campaign pair, as read for campaign selection. */
type TargetCampaignRecord = Readonly<{ binding: PromptCacheScopeTargetBinding; state: ExperimentState | null; evidence: StoredEvidence | null }>;

/**
 * The public route has no target selector. It resumes an existing campaign or
 * chooses the first nonterminal probeable Codex target from the canonical
 * stable ordering. Malformed durable state/evidence is a hard no-dispatch
 * condition rather than an invitation to overwrite it.
 */
const selectCampaignTarget = async (kv: Kv, inventory: PromptCacheScopeTargetInventory, runtime: RuntimeBinding): Promise<SelectedCampaignTarget> => {
  const bindings = inventory.targets
    .map((target) => targetBindingFromInventory(inventory, target, runtime))
    .filter((target): target is PromptCacheScopeTargetBinding => target !== null);
  if (!bindings.length) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment has no probeable Codex target in the current inventory.");
  }

  const records = await Promise.all(
    bindings.map(async (binding) => {
      const [stateEntry, evidenceEntry] = await Promise.all([
        kv.get<ExperimentState>(stateKey(binding), { consistency: "strong" }),
        kv.get<StoredEvidence>(evidenceKey(binding), { consistency: "strong" }),
      ]);
      const state = stateEntry.value === null ? null : parseState(stateEntry.value);
      const evidence = evidenceEntry.value === null ? null : parseEvidence(evidenceEntry.value);
      if ((stateEntry.value !== null && !state) || (evidenceEntry.value !== null && !evidence)) {
        throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment has malformed target-scoped durable state.");
      }
      if (state && !activeStateEvidenceIsConsistent(state, evidence)) {
        throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment has inconsistent target-scoped durable evidence.");
      }
      return { binding, state, evidence };
    })
  );

  const active = records.filter(
    (record): record is TargetCampaignRecord & Readonly<{ state: ExperimentState }> => record.state !== null && record.state.expires_at_ms > Date.now()
  );
  if (active.length > 1) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment found more than one active provider campaign.");
  }
  if (active.length === 1) {
    const record = active[0];
    const state = record.state;
    if (!sameTargetCore(state.target, record.binding)) {
      throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment target changed while its campaign was active.");
    }
    if (state.target.inventory_fingerprint !== record.binding.inventory_fingerprint) {
      throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment inventory changed while its campaign was active.");
    }
    return { binding: record.binding, active_state: state };
  }

  for (const record of records) {
    const terminal =
      record.evidence &&
      record.evidence.started_at_ms > 0 &&
      sameTargetDefinition(record.evidence.target, record.binding) &&
      record.evidence.outcome === "completed";
    if (!terminal) return { binding: record.binding };
  }
  throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment has no nonterminal probeable Codex target in the current inventory.");
};

type ResolvedPromptCacheScopeExperimentTelemetryBaseline = Readonly<{
  target: PromptCacheScopeTargetBinding;
  baseline: PromptCacheTelemetryBaselineResult;
}>;

/**
 * Resolves the one server-owned campaign target before reading its immutable
 * release telemetry. The target binding must remain private: it contains raw
 * model and account-pool identity material that is only needed to fence a
 * paid dispatch.
 */
const resolvePromptCacheScopeExperimentTelemetryBaseline = async (
  options: PromptCacheScopeExperimentTelemetryBaselineTestOptions = {}
): Promise<ResolvedPromptCacheScopeExperimentTelemetryBaseline> => {
  const kv = options.kv === undefined ? await getKv() : options.kv;
  if (!kv) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiments require Deno KV.");
  }
  const loaded = await loadInventoryAndRuntime(kv);
  if (!loaded) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment requires a current full target inventory and runtime configuration.");
  }
  const selected = await selectCampaignTarget(kv, loaded.inventory, loaded.runtime);
  const resolved = await resolveBoundTarget(kv, selected.binding);
  if (resolved.status !== "resolved") {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment target changed before its Stage 0 baseline could be checked.");
  }
  const baseline = await readPromptCacheTelemetryBaseline(
    { provider: CODEX_CHATGPT_PROMPT_CACHE_TELEMETRY_PROVIDER, model: resolved.value.binding.model },
    { ...options, kv }
  );
  return { target: resolved.value.binding, baseline };
};

/**
 * Read-only Stage 0 diagnostics for the one server-owned campaign target.
 * The result intentionally excludes its raw target binding; it does not
 * attest a later paid request, which must repeat the fenced read itself.
 */
export const readPromptCacheScopeExperimentTelemetryBaseline = async (
  options: PromptCacheScopeExperimentTelemetryBaselineTestOptions = {}
): Promise<PromptCacheTelemetryBaselineResult> => (await resolvePromptCacheScopeExperimentTelemetryBaseline(options)).baseline;

/**
 * The live matrix is a paid, stateful control-plane action. Keep its Stage 0
 * prerequisite at the public admin boundary so direct unit fixtures can
 * exercise the fenced runner without inventing a deployed release baseline.
 */
export const assertPromptCacheScopeExperimentTelemetryBaseline = async (
  options: PromptCacheScopeExperimentTelemetryBaselineTestOptions = {}
): Promise<PromptCacheScopeExperimentTelemetryBaseline> => {
  const { target, baseline } = await resolvePromptCacheScopeExperimentTelemetryBaseline(options);
  // The live matrix uses the Responses transport. Aggregate telemetry or a
  // Chat-only cohort cannot establish that its terminal usage parser is ready
  // for paid Responses samples.
  const responsesRoute = baseline.routes.find((route) => route.route === "responses");
  if (
    baseline.status !== "eligible" ||
    !responsesRoute?.completed_minimum_passed ||
    !responsesRoute.reported_coverage_passed ||
    !responsesRoute.cache_write_reported_coverage_passed
  ) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment requires a passing current-release Stage 0 telemetry baseline.");
  }
  return { target };
};

type AcquiredCycle = Readonly<{ state: ExperimentState; cycle_owner: string }>;

const hasActiveLease = (value: unknown): boolean => isRecord(value) && isSafeNonNegativeInteger(value.lease_until_ms) && value.lease_until_ms > Date.now();

type CycleEntries = Readonly<{
  state: KvEntryMaybe<ExperimentState>;
  evidence: KvEntryMaybe<StoredEvidence>;
  campaign: KvEntryMaybe<CampaignLease>;
  cycle: KvEntryMaybe<ExperimentLease>;
}>;

const loadCycleEntries = async (kv: Kv, target: PromptCacheScopeTargetBinding): Promise<CycleEntries> => {
  const [state, evidence, campaign, cycle] = await Promise.all([
    kv.get<ExperimentState>(stateKey(target), { consistency: "strong" }),
    kv.get<StoredEvidence>(evidenceKey(target), { consistency: "strong" }),
    kv.get<CampaignLease>(campaignLeaseKey(target), { consistency: "strong" }),
    kv.get<ExperimentLease>(cycleLeaseKey(target), { consistency: "strong" }),
  ]);
  return { state, evidence, campaign, cycle };
};

/**
 * Malformed or inconsistent durable records are a hard no-dispatch condition,
 * never an invitation to overwrite them.
 */
const readCycleRecords = (entries: CycleEntries): Readonly<{ state: ExperimentState | null; evidence: StoredEvidence | null }> => {
  const state = parseState(entries.state.value);
  const evidence = entries.evidence.value === null ? null : parseEvidence(entries.evidence.value);
  if (entries.state.value !== null && !state) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment has malformed target-scoped state.");
  }
  if (entries.evidence.value !== null && !evidence) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment has malformed target-scoped evidence.");
  }
  // An active campaign must never pick up evidence from another target or
  // session. Detect this before claiming a lease, so a corrupted durable
  // record cannot be overwritten after a paid dispatch has started.
  if (state && !activeStateEvidenceIsConsistent(state, evidence)) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment has inconsistent target-scoped durable evidence.");
  }
  return { state, evidence };
};

/** A live campaign keeps its owner and session clock; otherwise a fresh one starts. */
const resolveCampaignState = (
  campaignLeaseValue: unknown,
  activeState: ExperimentState | null,
  target: PromptCacheScopeTargetBinding,
  authPoolVersionstamp: string,
  now: number
): Readonly<{ campaignOwner: string; state: ExperimentState }> => {
  if (!activeState) {
    if (hasActiveLease(campaignLeaseValue)) throw new PromptCacheScopeExperimentBusyError();
    const campaignOwner = crypto.randomUUID();
    return {
      campaignOwner,
      state: {
        v: 3,
        target,
        campaign_owner: campaignOwner,
        started_at_ms: now,
        expires_at_ms: now + PROMPT_CACHE_SCOPE_EXPERIMENT_SESSION_MS,
        auth_pool_versionstamp: authPoolVersionstamp,
        next_cycle: 1,
        classifications: [],
      },
    };
  }
  if (!sameTargetCore(activeState.target, target) || activeState.target.inventory_fingerprint !== target.inventory_fingerprint) {
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment target changed while its campaign was active.");
  }
  if (!ownsCampaignLease(campaignLeaseValue, activeState)) {
    if (hasActiveLease(campaignLeaseValue)) throw new PromptCacheScopeExperimentBusyError();
    throw new PromptCacheScopeExperimentUnavailableError("Prompt-cache scope experiment lost its provider campaign lease.");
  }
  return { campaignOwner: activeState.campaign_owner, state: { ...activeState, target } };
};

const acquireCycle = async (kv: Kv, target: PromptCacheScopeTargetBinding, authPoolVersionstamp: string): Promise<AcquiredCycle> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entries = await loadCycleEntries(kv, target);
    const existing = readCycleRecords(entries).state;
    const now = Date.now();
    const activeState = existing && existing.expires_at_ms > now ? existing : null;
    const resettingPriorSession = !activeState && (entries.state.value !== null || entries.evidence.value !== null);
    if (hasActiveLease(entries.cycle.value)) throw new PromptCacheScopeExperimentBusyError();
    const { campaignOwner, state } = resolveCampaignState(entries.campaign.value, activeState, target, authPoolVersionstamp, now);

    const cycleOwner = crypto.randomUUID();
    const campaignLease: CampaignLease = {
      owner: campaignOwner,
      target_id: state.target.id,
      inventory_fingerprint: state.target.inventory_fingerprint,
      lease_until_ms: state.expires_at_ms,
    };
    const atomic = kv
      .atomic()
      .check(entries.state)
      .check(entries.evidence)
      .check(entries.campaign)
      .check(entries.cycle)
      .set(cycleLeaseKey(target), { owner: cycleOwner, lease_until_ms: now + PROMPT_CACHE_SCOPE_EXPERIMENT_LEASE_MS } satisfies ExperimentLease, {
        expireIn: PROMPT_CACHE_SCOPE_EXPERIMENT_LEASE_MS * 2,
      })
      .set(campaignLeaseKey(target), campaignLease, { expireIn: Math.max(1, state.expires_at_ms - now) })
      .set(stateKey(target), state, { expireIn: Math.max(1, state.expires_at_ms - now) });
    if (resettingPriorSession) atomic.delete(evidenceKey(target));
    const committed = await atomic.commit();
    if (committed.ok) return { state, cycle_owner: cycleOwner };
  }
  throw new PromptCacheScopeExperimentBusyError();
};

const renewLease = async (kv: Kv, state: ExperimentState, cycleOwner: string): Promise<void> => {
  const cycleKey = cycleLeaseKey(state.target);
  const campaignKey = campaignLeaseKey(state.target);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [cycleEntry, campaignEntry] = await Promise.all([
      kv.get<ExperimentLease>(cycleKey, { consistency: "strong" }),
      kv.get<CampaignLease>(campaignKey, { consistency: "strong" }),
    ]);
    if (!ownsLease(cycleEntry.value, cycleOwner) || !ownsCampaignLease(campaignEntry.value, state)) {
      throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment lost its lease.");
    }
    const now = Date.now();
    const commit = await kv
      .atomic()
      .check(cycleEntry)
      .check(campaignEntry)
      .set(cycleKey, { owner: cycleOwner, lease_until_ms: now + PROMPT_CACHE_SCOPE_EXPERIMENT_LEASE_MS } satisfies ExperimentLease, {
        expireIn: PROMPT_CACHE_SCOPE_EXPERIMENT_LEASE_MS * 2,
      })
      .set(
        campaignKey,
        {
          owner: state.campaign_owner,
          target_id: state.target.id,
          inventory_fingerprint: state.target.inventory_fingerprint,
          lease_until_ms: state.expires_at_ms,
        } satisfies CampaignLease,
        { expireIn: Math.max(1, state.expires_at_ms - now) }
      )
      .commit();
    if (commit.ok) return;
  }
  throw new PromptCacheScopeExperimentFailedError("Prompt-cache scope experiment could not renew its lease.");
};
export { acquireCycle, renewLease, resolveBoundTarget, sameTargetCore };
