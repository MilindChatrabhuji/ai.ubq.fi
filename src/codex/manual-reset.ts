import type { Kv, KvEntryMaybe, KvKey } from "#kv";
import { getKv } from "../kv.ts";
import { config } from "../config.ts";
import { isRecord, sha256Hex } from "../utils.ts";
import { getJwtExpMs, parseCodexAuthPool } from "./auth.ts";
import type { CodexAuthState } from "../types.ts";
import { normalizeRoutingState, routingAccountIdentity } from "./capacity-routing.ts";
import {
  codexResetAccountDailyKey,
  codexResetRedemptionKey,
  loadCodexBankedResetConfig,
  parseCodexResetRedemptionRecord,
  policyReason,
  type CodexBankedResetConfig,
} from "./banked-reset.ts";
import { attemptCodexBankedReset } from "./banked-reset-submission.ts";
import { createUpstreamCodexUsageResetProvider, type CodexUsageResetProvider } from "./banked-reset-provider.ts";
import { additionalRateLimitsForRouting, codexUsageUrl, parseCodexUsage } from "../provider/capacity-parse.ts";
import { codexAccountEligibility, normalizeProviderSelection, PROVIDER_SELECTION_KV_KEY } from "../provider/selection.ts";
import {
  applyCapacityObservation,
  capacityHeadroomForObservation,
  parseStoredCapacityObservationStore,
  planCapacityObservationStore,
  quotaClass,
  quotaBlockForClass,
} from "../authority/native-codex-capacity.ts";
import { activeSelectionForAccount } from "../authority/native-codex.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
  setRoutingStateCache,
  type CodexCapacityRoutingObservation,
  type CodexAccountRoutingState,
} from "./routing-state.ts";

import { intentKey, parseManualResetIntent, type ManualIntent } from "./manual-reset-state.ts";
export { CODEX_MANUAL_RESET_PREFIX, parseManualResetIntent } from "./manual-reset-state.ts";
export class ManualResetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly resetStatus: "pending" | "verified" | null = null
  ) {
    super(message);
  }
}
export type ManualResetDependencies = Readonly<{
  kv?: Kv | null;
  reloadConfig?: () => CodexBankedResetConfig;
  fetcher?: typeof fetch;
  now?: () => number;
  provider?: (auth: CodexAuthState) => CodexUsageResetProvider;
}>;
const fail = (status: number, code: string, message: string, resetStatus: "pending" | "verified" | null = null): never => {
  throw new ManualResetError(status, code, message, resetStatus);
};
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const day = (now: number): string => new Date(now).toISOString().slice(0, 10);
const hardPolicy = (read: () => CodexBankedResetConfig): CodexBankedResetConfig => {
  const current = read();
  const reason = policyReason(current, true);
  if (reason)
    fail(
      409,
      reason,
      reason === "feature_disabled" || reason === "mode_disabled"
        ? "Banked resets are globally disabled."
        : "Banked reset limits must permit exactly one redemption per account per day."
    );
  return current;
};
const enabledTarget = (selectionValue: unknown, hash: string): boolean => {
  const selection = normalizeProviderSelection(selectionValue);
  if (selectionValue !== null && selection === null) return false;
  const eligibility = codexAccountEligibility(selection);
  return eligibility.kind === "all" || (eligibility.kind === "only" && eligibility.hashes.includes(hash));
};
const currentTarget = async (poolValue: unknown, hash: string) => {
  const pool = parseCodexAuthPool(poolValue);
  if (!pool) return fail(409, "codex_account_changed", "Subscription changed. Reload Providers.");
  for (const [slot, auth] of pool.accounts.entries())
    if ((await sha256Hex(auth.account_id)) === hash) return { pool, slot, auth, identity: await routingAccountIdentity(auth) };
  return fail(409, "codex_account_changed", "Subscription changed. Reload Providers.");
};
const usageObservation = async (
  target: Awaited<ReturnType<typeof currentTarget>>,
  dependencies: ManualResetDependencies,
  signal: AbortSignal
): Promise<CodexCapacityRoutingObservation> => {
  hardPolicy(dependencies.reloadConfig ?? loadCodexBankedResetConfig);
  const response = await (dependencies.fetcher ?? fetch)(codexUsageUrl(), {
    headers: { Authorization: `Bearer ${target.auth.access_token}`, "ChatGPT-Account-ID": target.auth.account_id, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (!response.ok) {
    void response.body?.cancel();
    return fail(409, "codex_quota_unavailable", "Current subscription quota could not be verified.");
  }
  const usage = parseCodexUsage(await response.json());
  if (!usage || (!usage.primary && !usage.secondary)) return fail(409, "codex_quota_unavailable", "Current subscription quota is unavailable.");
  const at = (dependencies.now ?? Date.now)();
  return {
    slot: target.slot,
    account_id_hash: target.identity.accountIdHash,
    state: "available",
    source_observed_at_ms: at,
    snapshot_at_ms: at,
    windows: { primary: usage.primary, secondary: usage.secondary },
    additional_rate_limits: additionalRateLimitsForRouting(usage.additional_rate_limits, at),
  };
};
const resetDeadline = (observation: CodexCapacityRoutingObservation, now: number): number => {
  const windows = [observation.windows.primary, observation.windows.secondary].filter(
    (window) => window !== null && window.reset_at_ms !== null && window.reset_at_ms > now
  );
  const exhausted = windows.filter((window) => window?.used_percent === 100);
  const deadlines = (exhausted.length ? exhausted : windows).flatMap((window) =>
    window?.reset_at_ms === null || window?.reset_at_ms === undefined ? [] : [window.reset_at_ms]
  );
  if (!deadlines.length) return fail(409, "codex_quota_identity_unavailable", "A current quota window is required before using a reset.");
  return Math.max(...deadlines);
};
const readEntry = <T = unknown>(kv: Kv, key: KvKey): Promise<KvEntryMaybe<T>> => kv.get<T>(key, { consistency: "strong" });
const readManualDailyBudget = async (kv: Kv, hash: string, now: number) => {
  const budget = await readEntry(kv, codexResetAccountDailyKey(hash, day(now)));
  if (budget.value !== null && (!isRecord(budget.value) || budget.value.submission_count !== 0))
    return fail(429, "account_day_limit_reached", "This account has already used its one banked reset for today.");
  return budget;
};
const resolveIntent = async (
  kv: Kv,
  hash: string,
  target: Awaited<ReturnType<typeof currentTarget>>,
  dependencies: ManualResetDependencies,
  signal: AbortSignal,
  routingEntry: KvEntryMaybe<unknown>,
  poolEntry: KvEntryMaybe<unknown>,
  selectionEntry: KvEntryMaybe<unknown>
) => {
  const clock = dependencies.now ?? Date.now;
  const key = intentKey(hash);
  const entry = await readEntry(kv, key);
  const existing = parseManualResetIntent(entry.value);
  if (entry.value !== null && !existing) return fail(409, "codex_reset_intent_invalid", "Saved reset recovery requires operator inspection.");
  if (existing?.promoted_at_ms === null) {
    if (existing.credential_version !== target.identity.credentialVersion)
      return fail(409, "codex_account_changed", "Subscription credentials changed while reset recovery was pending.");
    return { entry, intent: existing };
  }
  if (existing && day(existing.created_at_ms) === day(clock()))
    return fail(409, "codex_reset_already_completed", "This account's banked reset was already completed today.", "verified");
  const budget = await readManualDailyBudget(kv, hash, clock());
  const observation = await usageObservation(target, dependencies, signal);
  const rawRouting = routingEntry.value === null ? null : parseCodexAccountRoutingState(routingEntry.value);
  if (routingEntry.value !== null && !rawRouting) return fail(409, "codex_routing_unavailable", "Subscription routing state is unavailable.");
  const routing = await normalizeRoutingState(rawRouting, target.pool, clock(), true);
  const slot = routing.slots[target.slot];
  if (slot.invalid_credential_version === target.identity.credentialVersion)
    return fail(409, "codex_auth_invalid", "This subscription requires credential recovery before using a reset.");
  const quotaResetAtMs = resetDeadline(observation, clock());
  if (existing?.quota_reset_at_ms === quotaResetAtMs)
    return fail(409, "codex_reset_already_completed", "This quota window's reset action was already completed.", "verified");
  const intent: ManualIntent = {
    v: 1,
    account_id_hash: hash,
    credential_version: target.identity.credentialVersion,
    quota_reset_at_ms: quotaResetAtMs,
    routing_generation: slot.generation,
    quota_signal_at_ms: slot.quota_signal_observed_at_ms,
    created_at_ms: clock(),
    promoted_at_ms: null,
  };
  const committed = await kv.atomic().check(entry).check(poolEntry).check(routingEntry).check(selectionEntry).check(budget).set(key, intent).commit();
  if (!committed.ok) return fail(409, "codex_reset_concurrent_update", "Subscription changed. Reload and retry the action.");
  return { entry: { key, value: intent, versionstamp: committed.versionstamp }, intent };
};
const promotionModels = (observation: CodexCapacityRoutingObservation): string[] => {
  const models: string[] = [];
  if ((capacityHeadroomForObservation(observation, null) ?? 0) > 0) models.push("standard");
  for (const limit of observation.additional_rate_limits) {
    const kind = quotaClass(limit.limit_name);
    if (kind !== "standard" && kind !== "unknown" && (capacityHeadroomForObservation(observation, limit.limit_name) ?? 0) > 0) models.push(limit.limit_name);
  }
  return [...new Set(models)];
};
const validatePromotionTarget = async (
  pool: KvEntryMaybe<unknown>,
  selection: KvEntryMaybe<unknown>,
  pendingEntry: KvEntryMaybe<unknown>,
  redemptionEntry: KvEntryMaybe<unknown>,
  hash: string,
  target: Awaited<ReturnType<typeof currentTarget>>,
  intent: ManualIntent
) => {
  const current = await currentTarget(pool.value, hash);
  if (current.identity.credentialVersion !== intent.credential_version || current.auth.account_id !== target.auth.account_id)
    return fail(409, "codex_account_changed", "Reset verified, but subscription credentials changed before activation.", "verified");
  if (!enabledTarget(selection.value, hash))
    return fail(409, "codex_provider_disabled", "Reset verified, but this subscription is disabled in Active providers.", "verified");
  if (!same(parseManualResetIntent(pendingEntry.value), intent))
    return fail(409, "codex_reset_already_completed", "This reset action was already completed or superseded.", "verified");
  if (parseCodexResetRedemptionRecord(redemptionEntry.value)?.state !== "verified")
    return fail(409, "codex_reset_unverified", "Reset verification is pending.", "pending");
  return current;
};
const parsePromotionState = (activeValue: unknown, routingValue: unknown) => {
  const active = activeValue === null ? null : parseCodexActiveAccountSelection(activeValue);
  const raw = routingValue === null ? null : parseCodexAccountRoutingState(routingValue);
  if ((activeValue !== null && !active) || (routingValue !== null && !raw))
    return fail(409, "codex_routing_unavailable", "Reset verified, but routing could not be activated.", "verified");
  return { active, raw };
};
const recoverPromotionRouting = async (
  raw: CodexAccountRoutingState | null,
  current: Awaited<ReturnType<typeof currentTarget>>,
  observation: CodexCapacityRoutingObservation,
  models: readonly string[],
  clock: () => number
) => {
  let routing = await normalizeRoutingState(raw, current.pool, clock(), true);
  const slot = routing.slots[current.slot];
  if (
    slot.invalid_credential_version === current.identity.credentialVersion ||
    (slot.probe_lease?.expires_at_ms ?? 0) > clock() ||
    (slot.quota_signal_observed_at_ms ?? -1) >= observation.snapshot_at_ms
  )
    return fail(409, "codex_reset_concurrent_update", "Reset verified; a newer account transition must settle before activation.", "verified");
  const currentObservation = { ...observation, slot: current.slot };
  for (const model of models) routing = applyCapacityObservation(routing, currentObservation, clock(), model, clock()) ?? routing;
  if (models.some((model) => (quotaBlockForClass(routing.slots[current.slot], quotaClass(model))?.blocked_until_ms ?? 0) > clock()))
    return fail(409, "codex_reset_concurrent_update", "Reset verified; a newer quota fence remains authoritative.", "verified");
  return routing;
};
const promoteVerified = async (
  kv: Kv,
  hash: string,
  target: Awaited<ReturnType<typeof currentTarget>>,
  intent: ManualIntent,
  redemptionKey: KvKey,
  observation: CodexCapacityRoutingObservation,
  clock: () => number,
  reloadConfig: () => CodexBankedResetConfig
) => {
  const models = promotionModels(observation);
  if (!models.length)
    return fail(
      409,
      "codex_reset_propagation_pending",
      "Reset verified; restored quota is not visible yet. Check again without consuming another reset.",
      "verified"
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    hardPolicy(reloadConfig);
    const [poolEntry, routingEntry, activeEntry, capacityEntry, selectionEntry, pendingEntry, redemptionEntry] = await Promise.all([
      readEntry(kv, CODEX_AUTH_POOL_KV_KEY),
      readEntry(kv, CODEX_ACCOUNT_ROUTING_KV_KEY),
      readEntry(kv, CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY),
      readEntry(kv, CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY),
      readEntry(kv, PROVIDER_SELECTION_KV_KEY),
      readEntry(kv, intentKey(hash)),
      readEntry(kv, redemptionKey),
    ]);
    const current = await validatePromotionTarget(poolEntry, selectionEntry, pendingEntry, redemptionEntry, hash, target, intent);
    const { active, raw } = parsePromotionState(activeEntry.value, routingEntry.value);
    const routing = await recoverPromotionRouting(raw, current, observation, models, clock);
    const durable = parseStoredCapacityObservationStore(capacityEntry.value);
    if (durable.some((item) => item.account_id_hash === observation.account_id_hash && item.snapshot_at_ms > observation.snapshot_at_ms))
      return fail(409, "codex_reset_concurrent_update", "Reset verified; newer quota evidence must be checked before activation.", "verified");
    const currentObservation = { ...observation, slot: current.slot };
    const recovered = routing.slots[current.slot];
    const nextActive = activeSelectionForAccount(
      {
        slot: current.slot,
        ...current.identity,
        quotaHeadroom: null,
        probeRequired: false,
        probeGeneration: null,
        probeToken: null,
        routingGeneration: recovered.generation,
      },
      poolEntry.versionstamp ?? "",
      (active?.generation ?? 0) + 1,
      clock(),
      "manual_reset"
    );
    if (!nextActive) return fail(409, "codex_routing_unavailable", "Reset verified, but account activation could not be prepared.", "verified");
    const observations = planCapacityObservationStore(capacityEntry.versionstamp, durable, [currentObservation], clock()).writes.capacity;
    hardPolicy(reloadConfig);
    const committed = await kv
      .atomic()
      .check(poolEntry)
      .check(routingEntry)
      .check(activeEntry)
      .check(capacityEntry)
      .check(selectionEntry)
      .check(pendingEntry)
      .check(redemptionEntry)
      .set(CODEX_ACCOUNT_ROUTING_KV_KEY, routing)
      .set(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, observations)
      .set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, nextActive)
      .set(intentKey(hash), { ...intent, promoted_at_ms: clock() })
      .commit();
    if (!committed.ok) continue;
    setRoutingStateCache(routing, committed.versionstamp);
    return { reset_status: "verified" as const, active_account_id_hash: hash };
  }
  return fail(409, "codex_reset_concurrent_update", "Reset verified; account activation conflicted. Check again without consuming another reset.", "verified");
};

/** Only the authenticated admin route constructs this explicit manual authorization. No inference is issued. */
export const consumeManualCodexReset = async (hash: string, dependencies: ManualResetDependencies = {}, signal = new AbortController().signal) => {
  const reloadConfig = dependencies.reloadConfig ?? loadCodexBankedResetConfig;
  const configured = hardPolicy(reloadConfig); // Must precede every provider read, including usage and inventory.
  const clock = dependencies.now ?? Date.now;
  const kv = dependencies.kv === undefined ? await getKv() : dependencies.kv;
  if (!kv) return fail(503, "codex_reset_storage_unavailable", "Banked reset storage is unavailable.");
  const [poolEntry, selectionEntry, routingEntry] = await Promise.all([
    readEntry(kv, CODEX_AUTH_POOL_KV_KEY),
    readEntry(kv, PROVIDER_SELECTION_KV_KEY),
    readEntry(kv, CODEX_ACCOUNT_ROUTING_KV_KEY),
  ]);
  const target = await currentTarget(poolEntry.value, hash);
  if (!enabledTarget(selectionEntry.value, hash))
    return fail(409, "codex_provider_disabled", "Enable this subscription in Active providers before using a reset.");
  const expiry = getJwtExpMs(target.auth.access_token);
  if (expiry !== null && expiry <= clock())
    return fail(409, "codex_auth_invalid", "This subscription's credential expired. Restore its account authorization first.");
  const { entry, intent } = await resolveIntent(kv, hash, target, dependencies, signal, routingEntry, poolEntry, selectionEntry);
  const provider =
    dependencies.provider?.(target.auth) ??
    createUpstreamCodexUsageResetProvider({
      codexBaseUrl: config.codexBaseUrl,
      accountId: target.auth.account_id,
      accessToken: target.auth.access_token,
      userAgent: "codex_cli_rs/0.100.0 (ai.ubq.fi)",
      fetch: dependencies.fetcher,
    });
  const candidate = {
    accountId: target.auth.account_id,
    credentialVersion: intent.credential_version,
    quotaResetAtMs: intent.quota_reset_at_ms,
    routingGeneration: intent.routing_generation,
    requestId: null,
    authorization: { kind: "manual_admin" as const, accountIdHash: hash },
    signal,
    fences: [
      {
        key: CODEX_AUTH_POOL_KV_KEY,
        isCurrent: (value: unknown) =>
          parseCodexAuthPool(value)?.accounts.some(
            (account) =>
              account.account_id === target.auth.account_id &&
              account.access_token === target.auth.access_token &&
              account.refresh_token === target.auth.refresh_token
          ) === true,
      },
      { key: PROVIDER_SELECTION_KV_KEY, isCurrent: (value: unknown) => same(value, selectionEntry.value) && enabledTarget(value, hash) },
      { key: intentKey(hash), isCurrent: (value: unknown) => same(value, entry.value) && clock() - intent.created_at_ms < 30_000 },
      {
        key: CODEX_ACCOUNT_ROUTING_KV_KEY,
        isCurrent: (value: unknown) => {
          const state = value === null ? null : parseCodexAccountRoutingState(value);
          const slot = state?.slots[target.slot];
          return value === null
            ? intent.routing_generation === 0
            : slot?.account_id_hash === target.identity.accountIdHash &&
                slot.credential_version === intent.credential_version &&
                slot.generation === intent.routing_generation &&
                slot.quota_signal_observed_at_ms === intent.quota_signal_at_ms;
        },
      },
    ],
  };
  const outcome = await attemptCodexBankedReset(candidate, { kv, config: configured, reloadConfig, provider, now: clock });
  if (outcome.kind !== "verified" || !outcome.record || !outcome.quotaGeneration)
    return fail(
      outcome.kind === "pending" ? 409 : 422,
      outcome.reason,
      `Banked reset was not completed: ${outcome.reason.replaceAll("_", " ")}.`,
      outcome.kind === "pending" ? "pending" : null
    );
  let observation: CodexCapacityRoutingObservation;
  try {
    hardPolicy(reloadConfig);
    observation = await usageObservation(target, dependencies, signal);
  } catch {
    return fail(
      409,
      "codex_reset_usage_pending",
      "Reset verified; current quota verification is pending. Check again without consuming another reset.",
      "verified"
    );
  }
  try {
    return await promoteVerified(kv, hash, target, intent, codexResetRedemptionKey(hash, outcome.quotaGeneration), observation, clock, reloadConfig);
  } catch (error) {
    if (error instanceof ManualResetError) throw new ManualResetError(error.status, error.code, error.message, "verified");
    return fail(
      503,
      "codex_reset_activation_pending",
      "Reset verified; account activation is pending. Check again without consuming another reset.",
      "verified"
    );
  }
};
