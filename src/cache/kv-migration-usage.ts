import type { Kv, KvEntry, KvEntryMaybe, KvKey, KvU64 } from "#kv";
// Bounded counter handoff and kernel quota v2 migration, split out of src/kv_migration.ts.

import { API_KEY_HASH_PREFIX, API_KEY_ID_PREFIX } from "../api-keys.ts";
import {
  API_KEY_USAGE_V3_REQUEST_PREFIX,
  API_KEY_USAGE_V3_WINDOW_PREFIX,
  type ApiKeyPolicy,
  apiKeyUsageV2Key,
  apiKeyUsageV3RetentionMs,
  apiKeyUsageV3WindowKey,
  makeApiKeyUsageWindowV3,
  normalizeApiKeyUsageRequestV3,
  normalizeApiKeyUsageWindowV3,
} from "../api-key-policy.ts";
import {
  KERNEL_ORG_POLICY_V2_PREFIX,
  KERNEL_ORG_RESERVATION_V2_PREFIX,
  KERNEL_ORG_WINDOW_V2_PREFIX,
  KERNEL_REPO_POLICY_V2_PREFIX,
  KERNEL_REPO_RESERVATION_V2_PREFIX,
  KERNEL_REPO_WINDOW_V2_PREFIX,
  kernelOrgPolicyKey,
  kernelOrgWindowKey,
  type KernelQuotaPolicyV2,
  type KernelQuotaWindowV2,
  kernelRepoPolicyKey,
  kernelRepoWindowKey,
  normalizeKernelQuotaPolicyV2,
  normalizeKernelQuotaReservationRowV2,
  normalizeKernelQuotaWindowV2,
  reconcileKernelQuotaWindowReservations,
} from "../kernel/quota-v2.ts";
import {
  DEFAULT_KERNEL_POLICY_LIMIT_KEY,
  DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS,
  DEFAULT_KERNEL_POLICY_WINDOW_KEY,
  DEFAULT_KERNEL_POLICY_WINDOW_MS,
} from "../defaults.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../types.ts";
import { isRecord } from "../utils.ts";
import {
  API_KEY_USAGE_V2_MIGRATION_BASELINE_PREFIX,
  apiKeyHashPolicyMatches,
  hasStrictApiKeyCorePolicy,
  hasStrictApiKeyHashCorePolicy,
  isApiKeyHash,
  isApiKeyId,
  isPositiveSafeInteger,
  isSafeUsageCount,
} from "./kv-migration-paid-fallback.ts";

type StrictApiKeyPair = Readonly<{
  record: ApiKeyRecord;
  hashRecord: ApiKeyHashRecord;
}>;

type ApiKeyUsageV2MigrationBaseline = Readonly<{
  version: 1;
  key_id: string;
  policy_version: string;
  window_start_ms: number;
  last_legacy_usage_requests: number;
  seeded_at_ms: number;
  reconciled_at_ms: number | null;
  reconciliation_runs: number;
}>;

const apiKeyUsageV2MigrationBaselineKey = (policy: Pick<ApiKeyPolicy, "key_id" | "policy_version" | "window_start_ms">) =>
  [...API_KEY_USAGE_V2_MIGRATION_BASELINE_PREFIX, policy.key_id, policy.policy_version, policy.window_start_ms] as const;

const normalizeApiKeyUsageV2MigrationBaseline = (value: unknown): ApiKeyUsageV2MigrationBaseline | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !isApiKeyId(record.key_id) ||
    typeof record.policy_version !== "string" ||
    !record.policy_version ||
    !isSafeUsageCount(record.window_start_ms) ||
    !isSafeUsageCount(record.last_legacy_usage_requests) ||
    !isPositiveSafeInteger(record.seeded_at_ms) ||
    !(record.reconciled_at_ms === null || isPositiveSafeInteger(record.reconciled_at_ms)) ||
    !isSafeUsageCount(record.reconciliation_runs)
  )
    return null;
  return record as ApiKeyUsageV2MigrationBaseline;
};

type BoundedCounterHandoffResult = Readonly<{
  baseline_created: boolean;
  baseline_reconciled: boolean;
  legacy_usage_delta_applied: number;
}>;

const currentLegacyUsage = (record: ApiKeyRecord, nowMs: number): number => (nowMs < record.usage_reset_at_ms ? record.usage_requests : 0);

// Revoked keys no longer advance their legacy window. Keep migration and
// validation pinned to the last stored window instead of rolling them forward.
const migrationPolicyNow = (record: ApiKeyRecord, nowMs: number): number => (record.revoked_at_ms === null ? nowMs : Math.max(0, record.usage_reset_at_ms - 1));

// The first V3 aggregate for a revoked historical window must remain available
// long enough for the post-migration validation pass.
const migrationV3RetentionMs = (windowResetAtMs: number, nowMs: number): number => apiKeyUsageV3RetentionMs(windowResetAtMs, Math.min(nowMs, windowResetAtMs));

type BoundedCounterKeys = Readonly<{ baselineKey: KvKey; counterKey: KvKey; windowKey: KvKey }>;

type BoundedCounterEntries = Readonly<{
  baselineEntry: KvEntryMaybe<ApiKeyUsageV2MigrationBaseline>;
  counterEntry: KvEntryMaybe<KvU64>;
  windowEntry: KvEntryMaybe<ApiKeyUsageWindowV3>;
}>;

/** Seeds the first V2 migration baseline and V3 window for a bounded counter. */
const seedBoundedCounterBaseline = async (
  kv: Kv,
  policy: ApiKeyPolicy,
  keys: BoundedCounterKeys,
  entries: BoundedCounterEntries,
  observedV2Usage: number,
  existingWindow: ApiKeyUsageWindowV3 | null,
  nowMs: number,
  handoffAlreadyInitialized: boolean
): Promise<BoundedCounterHandoffResult | null> => {
  const baseline: ApiKeyUsageV2MigrationBaseline = {
    version: 1,
    key_id: policy.key_id,
    policy_version: policy.policy_version,
    window_start_ms: policy.window_start_ms,
    last_legacy_usage_requests: observedV2Usage,
    seeded_at_ms: nowMs,
    reconciled_at_ms: handoffAlreadyInitialized ? nowMs : null,
    reconciliation_runs: handoffAlreadyInitialized ? 1 : 0,
  };
  const seededWindow: ApiKeyUsageWindowV3 = {
    ...(existingWindow ?? makeApiKeyUsageWindowV3(policy, nowMs)),
    committed_requests: Math.max(existingWindow?.committed_requests ?? 0, observedV2Usage),
    updated_at_ms: nowMs,
  };
  const committed = await kv
    .atomic()
    .check(entries.baselineEntry)
    .check(entries.counterEntry)
    .check(entries.windowEntry)
    .set(keys.baselineKey, baseline)
    .set(keys.windowKey, seededWindow, { expireIn: migrationV3RetentionMs(seededWindow.window_reset_at_ms, nowMs) })
    .commit();
  if (!committed.ok) return null;
  return {
    baseline_created: true,
    baseline_reconciled: handoffAlreadyInitialized,
    legacy_usage_delta_applied: observedV2Usage,
  };
};

/** Applies one legacy-usage delta to an existing baseline and V3 window. */
const updateBoundedCounterBaseline = async (
  kv: Kv,
  policy: ApiKeyPolicy,
  keys: BoundedCounterKeys,
  entries: BoundedCounterEntries,
  observedV2Usage: number,
  existingWindow: ApiKeyUsageWindowV3 | null,
  nowMs: number,
  handoffAlreadyInitialized: boolean
): Promise<BoundedCounterHandoffResult | null> => {
  const baseline = normalizeApiKeyUsageV2MigrationBaseline(entries.baselineEntry.value);
  if (baseline?.key_id !== policy.key_id || baseline.policy_version !== policy.policy_version || baseline.window_start_ms !== policy.window_start_ms) {
    throw new Error(`Bounded counter handoff baseline is invalid: ${policy.key_id}`);
  }
  if (!existingWindow) throw new Error(`V3 API-key window is missing: ${policy.key_id}`);
  const nextLegacyUsage = Math.max(baseline.last_legacy_usage_requests, observedV2Usage);
  const legacyDelta = nextLegacyUsage - baseline.last_legacy_usage_requests;
  const updatedBaseline: ApiKeyUsageV2MigrationBaseline = {
    ...baseline,
    last_legacy_usage_requests: nextLegacyUsage,
    reconciled_at_ms: handoffAlreadyInitialized ? nowMs : null,
    reconciliation_runs: handoffAlreadyInitialized ? baseline.reconciliation_runs + 1 : 0,
  };
  const updatedWindow: ApiKeyUsageWindowV3 = {
    ...existingWindow,
    committed_requests: existingWindow.committed_requests + legacyDelta,
    updated_at_ms: nowMs,
  };
  const atomic = kv
    .atomic()
    .check(entries.baselineEntry)
    .check(entries.counterEntry)
    .check(entries.windowEntry)
    .set(keys.baselineKey, updatedBaseline)
    .set(keys.windowKey, updatedWindow, { expireIn: migrationV3RetentionMs(updatedWindow.window_reset_at_ms, nowMs) });
  const committed = await atomic.commit();
  if (!committed.ok) return null;
  return {
    baseline_created: false,
    baseline_reconciled: handoffAlreadyInitialized,
    legacy_usage_delta_applied: legacyDelta,
  };
};

const migrateBoundedCounterHandoff = async (
  kv: Kv,
  policy: ApiKeyPolicy,
  legacyUsageRequests: number,
  nowMs: number,
  handoffAlreadyInitialized: boolean
): Promise<BoundedCounterHandoffResult> => {
  const keys: BoundedCounterKeys = {
    baselineKey: apiKeyUsageV2MigrationBaselineKey(policy),
    counterKey: apiKeyUsageV2Key(policy),
    windowKey: apiKeyUsageV3WindowKey(policy),
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [baselineEntry, counterEntry, windowEntry] = await Promise.all([
      kv.get<ApiKeyUsageV2MigrationBaseline>(keys.baselineKey, { consistency: "strong" }),
      kv.get<KvU64>(keys.counterKey, { consistency: "strong" }),
      kv.get<ApiKeyUsageWindowV3>(keys.windowKey, { consistency: "strong" }),
    ]);
    const entries: BoundedCounterEntries = { baselineEntry, counterEntry, windowEntry };
    if (entries.counterEntry.value !== null && typeof entries.counterEntry.value.value !== "bigint") {
      throw new Error(`Legacy V2 API-key counter is invalid: ${policy.key_id}`);
    }
    const observedV2Usage = entries.counterEntry.value === null ? legacyUsageRequests : Number(entries.counterEntry.value.value);
    if (!isSafeUsageCount(observedV2Usage)) {
      throw new Error(`Legacy V2 API-key counter is out of range: ${policy.key_id}`);
    }
    const existingWindow = normalizeApiKeyUsageWindowV3(entries.windowEntry.value);
    if (
      existingWindow &&
      (existingWindow.key_id !== policy.key_id ||
        existingWindow.policy_version !== policy.policy_version ||
        existingWindow.window_start_ms !== policy.window_start_ms ||
        existingWindow.window_reset_at_ms !== policy.usage_reset_at_ms)
    ) {
      throw new Error(`V3 API-key window identity is invalid: ${policy.key_id}`);
    }
    const handoff =
      entries.baselineEntry.value === null
        ? await seedBoundedCounterBaseline(kv, policy, keys, entries, observedV2Usage, existingWindow, nowMs, handoffAlreadyInitialized)
        : await updateBoundedCounterBaseline(kv, policy, keys, entries, observedV2Usage, existingWindow, nowMs, handoffAlreadyInitialized);
    if (handoff !== null) return handoff;
  }
  throw new Error(`Bounded counter handoff changed concurrently: ${policy.key_id}`);
};

const countReconciledBoundedCounterBaselines = async (kv: Kv): Promise<number> => {
  let count = 0;
  for await (const entry of kv.list({ prefix: API_KEY_USAGE_V2_MIGRATION_BASELINE_PREFIX })) {
    const baseline = normalizeApiKeyUsageV2MigrationBaseline(entry.value);
    if (baseline && baseline.reconciled_at_ms !== null) count += 1;
  }
  return count;
};

type LegacyKernelLimitRecord = Readonly<{
  usage_limit_requests: number;
  usage_requests: number;
  usage_reset_at_ms: number;
  window_ms: number;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}>;

const legacyKernelNumber = (value: unknown, fallback: number): number => {
  if (typeof value === "string") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.trunc(value);
};

const normalizeLegacyKernelLimit = (value: unknown, defaults: { limit: number; windowMs: number }, nowMs: number): LegacyKernelLimitRecord | null => {
  if (!isRecord(value)) return null;
  const limit = legacyKernelNumber(value.usage_limit_requests, defaults.limit);
  const usage = Math.max(0, legacyKernelNumber(value.usage_requests, 0));
  const windowMs = legacyKernelNumber(value.window_ms, defaults.windowMs);
  const resetAtMs = legacyKernelNumber(value.usage_reset_at_ms, nowMs + Math.max(1, windowMs));
  const expiresAtMs = legacyKernelNumber(value.expires_at_ms, -1);
  if (!(limit === -1 || limit >= 0) || windowMs <= 0 || resetAtMs <= 0 || !(expiresAtMs === -1 || expiresAtMs >= 0)) return null;
  return {
    usage_limit_requests: limit,
    usage_requests: usage,
    usage_reset_at_ms: resetAtMs,
    window_ms: windowMs,
    expires_at_ms: expiresAtMs,
    created_at_ms: Math.max(0, legacyKernelNumber(value.created_at_ms, nowMs)),
    updated_at_ms: Math.max(0, legacyKernelNumber(value.updated_at_ms, nowMs)),
  };
};

const migrationKernelDefaults = async (kv: Kv): Promise<{ limit: number; windowMs: number }> => {
  const [limitEntry, windowEntry] = await Promise.all([
    kv.get(DEFAULT_KERNEL_POLICY_LIMIT_KEY, { consistency: "strong" }),
    kv.get(DEFAULT_KERNEL_POLICY_WINDOW_KEY, { consistency: "strong" }),
  ]);
  const limit = legacyKernelNumber(limitEntry.value, DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS);
  const windowMs = legacyKernelNumber(windowEntry.value, DEFAULT_KERNEL_POLICY_WINDOW_MS);
  return {
    limit: limit === -1 || limit >= 0 ? limit : DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS,
    windowMs: windowMs > 0 ? windowMs : DEFAULT_KERNEL_POLICY_WINDOW_MS,
  };
};

/** Legacy entry already mirrored by a V2 policy row: drop the legacy row. */
const deleteMigratedLegacyKernelEntry = async (
  kv: Kv,
  legacyEntry: KvEntry<unknown>,
  policyEntry: KvEntryMaybe<KernelQuotaPolicyV2>,
  windowEntry: KvEntryMaybe<KernelQuotaWindowV2>,
  owner: string,
  repo: string | undefined
): Promise<void> => {
  const committed = await kv.atomic().check(legacyEntry).check(policyEntry).check(windowEntry).delete(legacyEntry.key).commit();
  if (!committed.ok) throw new Error(`legacy kernel quota changed concurrently: ${owner}/${repo ?? ""}`);
};

/** Builds the V2 window row for a legacy kernel limit entry. */
const migratedKernelWindow = (
  currentWindow: KernelQuotaWindowV2 | null,
  legacy: LegacyKernelLimitRecord,
  context: Readonly<{ scope: "repo" | "org"; owner: string; repo: string | undefined; effectiveWindowMs: number; nowMs: number }>
): KernelQuotaWindowV2 => {
  const sameWindow =
    currentWindow !== null && currentWindow.applied_window_ms === context.effectiveWindowMs && currentWindow.usage_reset_at_ms === legacy.usage_reset_at_ms;
  if (sameWindow) {
    return {
      ...currentWindow,
      usage_requests: Math.max(currentWindow.usage_requests, legacy.usage_requests),
      updated_at_ms: context.nowMs,
    };
  }
  return {
    v: 2,
    scope: context.scope,
    owner: context.owner,
    ...(context.scope === "repo" ? { repo: context.repo } : {}),
    usage_requests: legacy.usage_reset_at_ms <= context.nowMs ? 0 : legacy.usage_requests,
    reserved_requests: 0,
    usage_reset_at_ms: legacy.usage_reset_at_ms <= context.nowMs ? context.nowMs + context.effectiveWindowMs : legacy.usage_reset_at_ms,
    applied_window_ms: context.effectiveWindowMs,
    created_at_ms: legacy.created_at_ms,
    updated_at_ms: context.nowMs,
  };
};

/** Owner/repo identity carried by one legacy kernel quota key. */
const legacyKernelIdentity = (key: KvKey, prefix: KvKey, scope: "repo" | "org"): Readonly<{ owner: string; repo: string | undefined }> => {
  const ownerPart = key[prefix.length];
  const repoPart = key[prefix.length + 1];
  if (typeof ownerPart !== "string" || !ownerPart || (scope === "repo" && (typeof repoPart !== "string" || !repoPart))) {
    throw new Error(`legacy kernel quota key is malformed: ${JSON.stringify(key)}`);
  }
  return { owner: ownerPart, repo: scope === "repo" ? (repoPart as string) : undefined };
};

/** V2 policy and window keys for one kernel quota scope. */
const kernelV2Keys = (scope: "repo" | "org", owner: string, repo: string | undefined): Readonly<{ policyKey: KvKey; windowKey: KvKey }> =>
  scope === "repo" && repo !== undefined
    ? { policyKey: kernelRepoPolicyKey(owner, repo), windowKey: kernelRepoWindowKey(owner, repo) }
    : { policyKey: kernelOrgPolicyKey(owner), windowKey: kernelOrgWindowKey(owner) };

/** Writes the V2 policy and window rows for one legacy kernel limit entry. */
const writeMigratedKernelPolicy = async (
  kv: Kv,
  context: Readonly<{
    legacyEntry: KvEntry<unknown>;
    legacy: LegacyKernelLimitRecord;
    keys: Readonly<{ policyKey: KvKey; windowKey: KvKey }>;
    policyEntry: KvEntryMaybe<KernelQuotaPolicyV2>;
    windowEntry: KvEntryMaybe<KernelQuotaWindowV2>;
    identity: Readonly<{ owner: string; repo: string | undefined }>;
    scope: "repo" | "org";
    defaultBacked: boolean;
    defaults: { limit: number; windowMs: number };
    nowMs: number;
  }>
): Promise<void> => {
  const { legacyEntry, legacy, keys, identity, scope, defaultBacked, defaults, nowMs } = context;
  const effectiveWindowMs = defaultBacked ? defaults.windowMs : legacy.window_ms;
  const currentWindow = await reconcileKernelQuotaWindowReservations(kv, context.windowEntry, scope, identity.owner, identity.repo);
  const window = migratedKernelWindow(currentWindow, legacy, { scope, owner: identity.owner, repo: identity.repo, effectiveWindowMs, nowMs });
  const policy: KernelQuotaPolicyV2 = {
    v: 2,
    scope,
    owner: identity.owner,
    ...(scope === "repo" ? { repo: identity.repo } : {}),
    usage_limit_requests: legacy.usage_limit_requests,
    window_ms: legacy.window_ms,
    expires_at_ms: legacy.expires_at_ms,
    created_at_ms: legacy.created_at_ms,
    updated_at_ms: nowMs,
  };
  let atomic = kv.atomic().check(legacyEntry).check(context.policyEntry).check(context.windowEntry).set(keys.windowKey, window).delete(legacyEntry.key);
  atomic = defaultBacked ? atomic.delete(keys.policyKey) : atomic.set(keys.policyKey, policy);
  const committed = await atomic.commit();
  if (!committed.ok) throw new Error(`legacy kernel quota changed concurrently: ${identity.owner}/${identity.repo ?? ""}`);
};

/** Migrates one legacy kernel limit entry into the V2 policy and window rows. */
const migrateLegacyKernelEntry = async (
  kv: Kv,
  legacyEntry: KvEntry<unknown>,
  legacyPrefix: KvKey,
  scope: "repo" | "org",
  defaults: { limit: number; windowMs: number },
  nowMs: number
): Promise<void> => {
  const identity = legacyKernelIdentity(legacyEntry.key, legacyPrefix, scope);
  const legacy = normalizeLegacyKernelLimit(legacyEntry.value, defaults, nowMs);
  if (!legacy) throw new Error(`legacy kernel quota value is malformed: ${JSON.stringify(legacyEntry.key)}`);
  const defaultBacked = legacy.expires_at_ms === -1 && legacy.usage_limit_requests === defaults.limit && legacy.window_ms === defaults.windowMs;
  const keys = kernelV2Keys(scope, identity.owner, identity.repo);
  const [policyEntry, windowEntry] = await Promise.all([
    kv.get<KernelQuotaPolicyV2>(keys.policyKey, { consistency: "strong" }),
    kv.get<KernelQuotaWindowV2>(keys.windowKey, { consistency: "strong" }),
  ]);
  if (normalizeKernelQuotaPolicyV2(policyEntry.value, scope, identity.owner, identity.repo)) {
    await deleteMigratedLegacyKernelEntry(kv, legacyEntry, policyEntry, windowEntry, identity.owner, identity.repo);
    return;
  }
  await writeMigratedKernelPolicy(kv, {
    legacyEntry,
    legacy,
    keys,
    policyEntry,
    windowEntry,
    identity,
    scope,
    defaultBacked,
    defaults,
    nowMs,
  });
};

const migrateLegacyKernelScope = async (kv: Kv, scope: "repo" | "org", defaults: { limit: number; windowMs: number }, nowMs: number): Promise<number> => {
  const legacyPrefix = scope === "repo" ? (["ubq_ai", "kernel_auth", "limits"] as const) : (["ubq_ai", "kernel_auth", "org_limits"] as const);
  let migrated = 0;
  for await (const legacyEntry of kv.list({ prefix: legacyPrefix })) {
    await migrateLegacyKernelEntry(kv, legacyEntry, legacyPrefix, scope, defaults, nowMs);
    migrated += 1;
  }
  return migrated;
};

const migrateKernelQuotaV2 = async (kv: Kv, nowMs: number): Promise<{ repo: number; org: number }> => {
  const defaults = await migrationKernelDefaults(kv);
  return {
    repo: await migrateLegacyKernelScope(kv, "repo", defaults, nowMs),
    org: await migrateLegacyKernelScope(kv, "org", defaults, nowMs),
  };
};

type ApiKeyUsageV3Inventory = Readonly<{
  windows: number;
  requests: number;
  errors: string[];
}>;

const apiKeyUsageV3WindowReference = (keyId: string, policyVersion: string, windowStartMs: number): string =>
  JSON.stringify([keyId, policyVersion, windowStartMs]);

type ApiKeyUsageV3WindowMap = Map<string, ApiKeyUsageWindowV3>;

/** Validates every V3 usage window row and indexes it by its reference. */
const collectApiKeyUsageV3Windows = async (
  kv: Kv,
  knownKeyIds: ReadonlySet<string>,
  errors: string[]
): Promise<Readonly<{ count: number; windows: ApiKeyUsageV3WindowMap }>> => {
  const windows: ApiKeyUsageV3WindowMap = new Map();
  let count = 0;
  for await (const entry of kv.list({ prefix: API_KEY_USAGE_V3_WINDOW_PREFIX })) {
    count += 1;
    const [keyId, policyVersion, windowStartMs] = entry.key.slice(API_KEY_USAGE_V3_WINDOW_PREFIX.length);
    const window = normalizeApiKeyUsageWindowV3(entry.value);
    if (
      entry.key.length !== API_KEY_USAGE_V3_WINDOW_PREFIX.length + 3 ||
      !isApiKeyId(keyId) ||
      typeof policyVersion !== "string" ||
      !policyVersion ||
      !isSafeUsageCount(windowStartMs)
    ) {
      errors.push(`API key usage V3 window is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (window === null) {
      errors.push(`API key usage V3 window is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (window.key_id !== keyId || window.policy_version !== policyVersion || window.window_start_ms !== windowStartMs) {
      errors.push(`API key usage V3 window is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (!knownKeyIds.has(keyId)) errors.push(`API key usage V3 window is orphaned: ${keyId}`);
    windows.set(apiKeyUsageV3WindowReference(keyId, policyVersion, windowStartMs), window);
  }
  return { count, windows };
};

/** Reports a V3 usage request row whose state fields are incomplete. */
const pushApiKeyUsageRequestStateErrors = (request: ApiKeyUsageRequestV3, errors: string[]): void => {
  if (request.state === "dispatched" && (request.provider === null || request.dispatched_at_ms === null)) {
    errors.push(`API key usage V3 dispatched request is incomplete: ${request.key_id}/${request.request_id}`);
  }
  if (request.state === "released" && request.released_at_ms === null) {
    errors.push(`API key usage V3 released request is incomplete: ${request.key_id}/${request.request_id}`);
  }
};

/** Validates every V3 usage request row and tallies reservations per window. */
const collectApiKeyUsageV3Requests = async (
  kv: Kv,
  knownKeyIds: ReadonlySet<string>,
  errors: string[]
): Promise<Readonly<{ count: number; reservedByWindow: Map<string, number>; requestWindows: Set<string> }>> => {
  const reservedByWindow = new Map<string, number>();
  const requestWindows = new Set<string>();
  let count = 0;
  for await (const entry of kv.list({ prefix: API_KEY_USAGE_V3_REQUEST_PREFIX })) {
    count += 1;
    const [keyId, policyVersion, windowStartMs, requestId] = entry.key.slice(API_KEY_USAGE_V3_REQUEST_PREFIX.length);
    const request = normalizeApiKeyUsageRequestV3(entry.value);
    if (
      entry.key.length !== API_KEY_USAGE_V3_REQUEST_PREFIX.length + 4 ||
      !isApiKeyId(keyId) ||
      typeof policyVersion !== "string" ||
      !policyVersion ||
      !isSafeUsageCount(windowStartMs) ||
      !isApiKeyId(requestId)
    ) {
      errors.push(`API key usage V3 request is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (request === null) {
      errors.push(`API key usage V3 request is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (request.key_id !== keyId || request.request_id !== requestId) {
      errors.push(`API key usage V3 request is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (!knownKeyIds.has(keyId)) errors.push(`API key usage V3 request is orphaned: ${keyId}/${requestId}`);
    const reference = apiKeyUsageV3WindowReference(keyId, policyVersion, windowStartMs);
    requestWindows.add(reference);
    if (request.state === "reserved") {
      reservedByWindow.set(reference, (reservedByWindow.get(reference) ?? 0) + 1);
    }
    pushApiKeyUsageRequestStateErrors(request, errors);
  }
  return { count, reservedByWindow, requestWindows };
};

const inspectApiKeyUsageV3 = async (kv: Kv, knownKeyIds: ReadonlySet<string>): Promise<ApiKeyUsageV3Inventory> => {
  const errors: string[] = [];
  const windowInventory = await collectApiKeyUsageV3Windows(kv, knownKeyIds, errors);
  const requestInventory = await collectApiKeyUsageV3Requests(kv, knownKeyIds, errors);

  for (const [reference, window] of windowInventory.windows) {
    const reserved = requestInventory.reservedByWindow.get(reference) ?? 0;
    if (window.reserved_requests !== reserved) {
      errors.push(`API key usage V3 reserved aggregate is inconsistent: ${reference}`);
    }
  }
  for (const reference of requestInventory.requestWindows) {
    if (!windowInventory.windows.has(reference)) errors.push(`API key usage V3 request has no window: ${reference}`);
  }
  return { windows: windowInventory.count, requests: requestInventory.count, errors };
};

type KernelQuotaV2Inventory = Readonly<{
  repoPolicies: number;
  orgPolicies: number;
  repoWindows: number;
  orgWindows: number;
  repoReservations: number;
  orgReservations: number;
  errors: string[];
}>;

type KernelQuotaWindowEntry = Readonly<{ window: KernelQuotaWindowV2; hasReservationAggregate: boolean }>;

const kernelWindowReference = (scope: "repo" | "org", owner: string, repo: string | undefined, createdAtMs: number): string =>
  JSON.stringify(scope === "repo" ? [scope, owner, repo, createdAtMs] : [scope, owner, createdAtMs]);

/** Validates every V2 kernel policy row under one prefix and counts them. */
const inspectKernelQuotaPolicies = async (kv: Kv, prefix: KvKey, scope: "repo" | "org", errors: string[]): Promise<number> => {
  let count = 0;
  for await (const entry of kv.list({ prefix })) {
    count += 1;
    const owner = entry.key[prefix.length];
    const repo = entry.key[prefix.length + 1];
    const validKey =
      typeof owner === "string" &&
      owner &&
      (scope === "org" ? entry.key.length === prefix.length + 1 : typeof repo === "string" && repo && entry.key.length === prefix.length + 2);
    const validValue = validKey && normalizeKernelQuotaPolicyV2(entry.value, scope, owner, scope === "repo" ? (repo as string) : undefined);
    if (!validValue) errors.push(`kernel quota V2 policy is malformed: ${JSON.stringify(entry.key)}`);
  }
  return count;
};

/** Validates every V2 kernel window row under one prefix and indexes it. */
const inspectKernelQuotaWindows = async (
  kv: Kv,
  prefix: KvKey,
  scope: "repo" | "org",
  errors: string[],
  windows: Map<string, KernelQuotaWindowEntry>
): Promise<number> => {
  let count = 0;
  for await (const entry of kv.list({ prefix })) {
    count += 1;
    const owner = entry.key[prefix.length];
    const repo = entry.key[prefix.length + 1];
    const validKey =
      typeof owner === "string" &&
      owner &&
      (scope === "org" ? entry.key.length === prefix.length + 1 : typeof repo === "string" && repo && entry.key.length === prefix.length + 2);
    const scopeRepo = scope === "repo" ? (repo as string) : undefined;
    const window = validKey ? normalizeKernelQuotaWindowV2(entry.value, scope, owner, scopeRepo) : null;
    if (!window) {
      errors.push(`kernel quota V2 window is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    windows.set(kernelWindowReference(scope, window.owner, window.repo, window.created_at_ms), {
      window,
      hasReservationAggregate: isRecord(entry.value) && Object.hasOwn(entry.value, "reserved_requests"),
    });
  }
  return count;
};

/** Validates every V2 kernel reservation row under one prefix and tallies it. */
/** Owner, timestamps and request id carried by one V2 reservation key. */
const kernelReservationKeyIdentity = (
  key: KvKey,
  prefix: KvKey,
  scope: "repo" | "org"
): Readonly<{ owner: string; repo: string | undefined; windowCreatedAtMs: number; requestId: string }> | null => {
  const owner = key[prefix.length];
  const repo = scope === "repo" ? key[prefix.length + 1] : undefined;
  const windowCreatedAtMs = key[prefix.length + (scope === "repo" ? 2 : 1)];
  const requestId = key[prefix.length + (scope === "repo" ? 3 : 2)];
  const validKey =
    typeof owner === "string" &&
    owner &&
    (scope === "org" || (typeof repo === "string" && repo)) &&
    typeof windowCreatedAtMs === "number" &&
    Number.isSafeInteger(windowCreatedAtMs) &&
    windowCreatedAtMs >= 0 &&
    typeof requestId === "string" &&
    requestId &&
    key.length === prefix.length + (scope === "repo" ? 4 : 3);
  if (!validKey || typeof owner !== "string" || typeof windowCreatedAtMs !== "number" || typeof requestId !== "string") return null;
  return { owner, repo: typeof repo === "string" ? repo : undefined, windowCreatedAtMs, requestId };
};

/** Validates every V2 kernel reservation row under one prefix and tallies it. */
const inspectKernelQuotaReservations = async (
  kv: Kv,
  prefix: KvKey,
  scope: "repo" | "org",
  errors: string[],
  reservedByWindow: Map<string, number>,
  resetAtByWindow: Map<string, number>
): Promise<number> => {
  let count = 0;
  for await (const entry of kv.list({ prefix })) {
    count += 1;
    const identity = kernelReservationKeyIdentity(entry.key, prefix, scope);
    if (identity === null) {
      errors.push(`kernel quota V2 reservation is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    const reservation = normalizeKernelQuotaReservationRowV2(entry.value, scope, identity.owner, identity.repo);
    if (reservation === null) {
      errors.push(`kernel quota V2 reservation is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (reservation.request_id !== identity.requestId || reservation.window_created_at_ms !== identity.windowCreatedAtMs) {
      errors.push(`kernel quota V2 reservation is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    const reference = kernelWindowReference(scope, reservation.owner, reservation.repo, reservation.window_created_at_ms);
    const knownResetAtMs = resetAtByWindow.get(reference);
    if (knownResetAtMs !== undefined && knownResetAtMs !== reservation.window_reset_at_ms) {
      errors.push(`kernel quota V2 reservation window identity is inconsistent: ${reference}`);
    } else {
      resetAtByWindow.set(reference, reservation.window_reset_at_ms);
    }
    if (reservation.state === "reserved") {
      reservedByWindow.set(reference, (reservedByWindow.get(reference) ?? 0) + 1);
    }
  }
  return count;
};

const inspectKernelQuotaV2 = async (kv: Kv): Promise<KernelQuotaV2Inventory> => {
  const errors: string[] = [];
  const windows = new Map<string, KernelQuotaWindowEntry>();
  const reservedByWindow = new Map<string, number>();
  const resetAtByWindow = new Map<string, number>();
  const [repoPolicies, orgPolicies, repoWindows, orgWindows, repoReservations, orgReservations] = await Promise.all([
    inspectKernelQuotaPolicies(kv, KERNEL_REPO_POLICY_V2_PREFIX, "repo", errors),
    inspectKernelQuotaPolicies(kv, KERNEL_ORG_POLICY_V2_PREFIX, "org", errors),
    inspectKernelQuotaWindows(kv, KERNEL_REPO_WINDOW_V2_PREFIX, "repo", errors, windows),
    inspectKernelQuotaWindows(kv, KERNEL_ORG_WINDOW_V2_PREFIX, "org", errors, windows),
    inspectKernelQuotaReservations(kv, KERNEL_REPO_RESERVATION_V2_PREFIX, "repo", errors, reservedByWindow, resetAtByWindow),
    inspectKernelQuotaReservations(kv, KERNEL_ORG_RESERVATION_V2_PREFIX, "org", errors, reservedByWindow, resetAtByWindow),
  ]);
  for (const [reference, { window, hasReservationAggregate }] of windows) {
    const reservationResetAtMs = resetAtByWindow.get(reference);
    if (reservationResetAtMs !== undefined && reservationResetAtMs !== window.usage_reset_at_ms) {
      errors.push(`kernel quota V2 reservation window reset is inconsistent: ${reference}`);
    }
    if (hasReservationAggregate && window.reserved_requests !== (reservedByWindow.get(reference) ?? 0)) {
      errors.push(`kernel quota V2 reserved aggregate is inconsistent: ${reference}`);
    }
  }
  for (const reference of reservedByWindow.keys()) {
    if (!windows.has(reference)) {
      errors.push(`kernel quota V2 active reservation has no window: ${reference}`);
    }
  }
  return { repoPolicies, orgPolicies, repoWindows, orgWindows, repoReservations, orgReservations, errors };
};

/** Validates every api-key hash policy row and indexes it by its hash. */
const collectStrictApiKeyHashEntries = async (kv: Kv, errors: string[]): Promise<Map<string, ApiKeyHashRecord>> => {
  const hashEntries = new Map<string, ApiKeyHashRecord>();
  for await (const entry of kv.list({ prefix: API_KEY_HASH_PREFIX })) {
    const hash = entry.key.length === API_KEY_HASH_PREFIX.length + 1 ? entry.key.at(-1) : null;
    if (!isApiKeyHash(hash)) {
      errors.push(`api key hash entry has an invalid key: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (!hasStrictApiKeyHashCorePolicy(entry.value)) {
      errors.push(`api key hash policy has invalid core fields: ${hash}`);
      continue;
    }
    hashEntries.set(hash, entry.value);
  }
  return hashEntries;
};

/** Pairs every api-key id row with its consistent hash policy row. */
const collectStrictApiKeyPairs = async (
  kv: Kv,
  hashEntries: ReadonlyMap<string, ApiKeyHashRecord>,
  errors: string[]
): Promise<Readonly<{ pairs: StrictApiKeyPair[]; referencedHashes: Map<string, number> }>> => {
  const pairs: StrictApiKeyPair[] = [];
  const referencedHashes = new Map<string, number>();
  for await (const entry of kv.list({ prefix: API_KEY_ID_PREFIX })) {
    const keyId = entry.key.length === API_KEY_ID_PREFIX.length + 1 ? entry.key.at(-1) : null;
    if (!isApiKeyId(keyId)) {
      errors.push(`api key id entry has an invalid key: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (!hasStrictApiKeyCorePolicy(entry.value)) {
      errors.push(`api key has invalid v2 policy: ${keyId}`);
      continue;
    }
    const record = entry.value;
    if (record.id !== keyId) {
      errors.push(`api key id key suffix does not match record id: key=${keyId} record=${record.id}`);
      continue;
    }
    const hashRecord = hashEntries.get(record.hash);
    if (!hashRecord || !apiKeyHashPolicyMatches(record, hashRecord)) {
      errors.push(`api key hash policy is missing or inconsistent: ${record.id}`);
      continue;
    }
    referencedHashes.set(record.hash, (referencedHashes.get(record.hash) ?? 0) + 1);
    pairs.push({ record, hashRecord });
  }
  return { pairs, referencedHashes };
};

/** Reports hash policy rows with no (or several) referencing id records. */
const auditReferencedApiKeyHashes = (
  hashEntries: ReadonlyMap<string, ApiKeyHashRecord>,
  referencedHashes: ReadonlyMap<string, number>,
  errors: string[]
): void => {
  for (const hash of hashEntries.keys()) {
    const references = referencedHashes.get(hash) ?? 0;
    if (references === 0) errors.push(`api key hash policy is orphaned: ${hash}`);
    if (references > 1) errors.push(`api key hash policy has multiple id records: ${hash}`);
  }
};

const inspectStrictApiKeyPairs = async (kv: Kv): Promise<{ pairs: StrictApiKeyPair[]; errors: string[] }> => {
  const errors: string[] = [];
  const hashEntries = await collectStrictApiKeyHashEntries(kv, errors);
  const { pairs, referencedHashes } = await collectStrictApiKeyPairs(kv, hashEntries, errors);
  auditReferencedApiKeyHashes(hashEntries, referencedHashes, errors);
  return { pairs, errors };
};

export type { ApiKeyUsageV2MigrationBaseline, StrictApiKeyPair };
export {
  apiKeyUsageV2MigrationBaselineKey,
  countReconciledBoundedCounterBaselines,
  currentLegacyUsage,
  inspectApiKeyUsageV3,
  inspectKernelQuotaV2,
  inspectStrictApiKeyPairs,
  migrateBoundedCounterHandoff,
  migrateKernelQuotaV2,
  migrationPolicyNow,
  normalizeApiKeyUsageV2MigrationBaseline,
};
