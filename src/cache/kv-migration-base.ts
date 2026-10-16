// KV migration types, prefix tables and validators, split out of src/kv_migration.ts.

import type { Kv, KvKey } from "#kv";
import { API_KEY_USAGE_V3_REQUEST_PREFIX, API_KEY_USAGE_V3_RETENTION_MS, API_KEY_USAGE_V3_WINDOW_PREFIX } from "../api-key-policy.ts";
import { API_KEY_REQUEST_LOG_RETENTION_MS } from "../analytics.ts";
import { type KvEntryJson, toKey, toValue } from "../kv-conversion/profile-json.ts";
import { CODEX_RESET_USAGE_PREFIX } from "../codex/reset-settings.ts";
import { EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS, EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS } from "../embeddings/ledger.ts";
import {
  KERNEL_ORG_RESERVATION_V2_PREFIX,
  KERNEL_ORG_WINDOW_V2_PREFIX,
  KERNEL_QUOTA_RESERVATION_RETENTION_MS,
  KERNEL_REPO_RESERVATION_V2_PREFIX,
  KERNEL_REPO_WINDOW_V2_PREFIX,
  normalizeKernelQuotaReservationRowV2,
  normalizeKernelQuotaWindowV2,
} from "../kernel/quota-v2.ts";
import { PAID_FALLBACK_REQUEST_LOG_RETENTION_MS } from "../paid-fallback/ledger-state.ts";
import { isRecord } from "../utils.ts";

export type KvMigrationProfile = "local" | "prod";
export type KvMigrationDecisionAction = "import" | "skip" | "optional";

export type KvMigrationDecision = Readonly<{
  action: KvMigrationDecisionAction;
  group: string;
  reason: string;
}>;

export type KvMigrationCounters = {
  total: number;
  imported: number;
  skipped: number;
  optional: number;
  errors: number;
};

export type KvMigrationClassifyOptions = Readonly<{
  profile: KvMigrationProfile;
  includeCache: boolean;
  includeLegacy: boolean;
}>;

export type KvMigrationImportOptions = KvMigrationClassifyOptions &
  Readonly<{
    overwrite: boolean;
    dryRun: boolean;
  }>;

export type KvMigrationImportResult = KvMigrationCounters & {
  groups: Record<string, number>;
};

export type KvMigrationValidationResult = {
  counts: {
    api_key_ids: number;
    api_key_hashes: number;
    api_key_bounded_counters_v2: number;
    api_key_bounded_counter_baselines_v2: number;
    api_key_bounded_counter_reconciled_baselines_v2: number;
    api_key_usage_v3_windows: number;
    api_key_usage_v3_requests: number;
    paid_fallback_ledger: number;
    paid_fallback_v3_windows: number;
    paid_fallback_v3_requests: number;
    paid_fallback_v3_pending: number;
    paid_fallback_v3_reconciliation_leases: number;
    paid_fallback_v3_deletion_guards: number;
    kernel_repo_limits: number;
    kernel_org_limits: number;
    kernel_v2_repo_policies: number;
    kernel_v2_org_policies: number;
    kernel_v2_repo_windows: number;
    kernel_v2_org_windows: number;
    kernel_v2_repo_reservations: number;
    kernel_v2_org_reservations: number;
    passkey_users: number;
    passkey_credentials: number;
    agent_messages: number;
    embeddings_v2_at_most_10000: number;
    legacy_model_key_configs: number;
    legacy_model_key_health: number;
    codex_reset_usage: number;
  };
  settings_present: {
    codex_auth: boolean;
    codex_models: boolean;
    default_model: boolean;
    default_reasoning_effort: boolean;
    default_kernel_policy_limit_requests: boolean;
    default_kernel_policy_window_ms: boolean;
    voyage_api_key: boolean;
    kernel_pubkeys: boolean;
    runtime_config_v2: boolean;
  };
  errors: string[];
};

const DURABLE_PREFIXES: { group: string; prefix: KvKey }[] = [
  { group: "api_keys_id", prefix: ["ubq_ai", "api_keys", "id"] },
  { group: "api_keys_hash", prefix: ["ubq_ai", "api_keys", "hash"] },
  { group: "api_keys_usage", prefix: ["ubq_ai", "api_keys", "usage"] },
  { group: "api_keys_usage_daily", prefix: ["ubq_ai", "api_keys", "usage_daily"] },
  { group: "api_keys_request_log", prefix: ["ubq_ai", "api_keys", "request_log"] },
  { group: "api_key_usage_v2", prefix: ["uos_ai", "api_key_usage", "v2"] },
  { group: "api_key_usage_v3_windows", prefix: ["uos_ai", "api_key_usage", "v3", "window"] },
  { group: "api_key_usage_v3_requests", prefix: ["uos_ai", "api_key_usage", "v3", "request"] },
  { group: "paid_fallback_ledger", prefix: ["uos_ai", "paid_fallback", "ledger"] },
  { group: "paid_fallback_v3_windows", prefix: ["uos_ai", "paid_fallback", "v3", "window"] },
  { group: "paid_fallback_v3_requests", prefix: ["uos_ai", "paid_fallback", "v3", "request"] },
  {
    group: "paid_fallback_v3_usage_rollups",
    prefix: ["uos_ai", "paid_fallback", "v3", "usage_rollup"],
  },
  {
    group: "paid_fallback_v3_ledger_stats",
    prefix: ["uos_ai", "paid_fallback", "v3", "ledger_stats"],
  },
  {
    group: "metered_quota_balance_history",
    prefix: ["uos_ai", "metered_quota", "v1", "balance_history"],
  },
  {
    group: "provider_capacity_rollups",
    prefix: ["uos_ai", "provider_capacity", "v1", "rollup"],
  },
  { group: "paid_fallback_v3_pending", prefix: ["uos_ai", "paid_fallback", "v3", "pending"] },
  {
    group: "paid_fallback_v3_reconciliation_leases",
    prefix: ["uos_ai", "paid_fallback", "v3", "reconciliation_lease"],
  },
  {
    group: "paid_fallback_v3_deletion_guards",
    prefix: ["uos_ai", "paid_fallback", "v3", "deletion_guard"],
  },
  { group: "runtime_config_v2", prefix: ["uos_ai", "runtime_config", "v2"] },
  { group: "kernel_usage", prefix: ["ubq_ai", "kernel_auth", "usage"] },
  { group: "kernel_usage_daily", prefix: ["ubq_ai", "kernel_auth", "usage_daily"] },
  { group: "kernel_quota_v2_repo_policy", prefix: ["uos_ai", "kernel_quota", "v2", "repo_policy"] },
  { group: "kernel_quota_v2_org_policy", prefix: ["uos_ai", "kernel_quota", "v2", "org_policy"] },
  { group: "kernel_quota_v2_repo_window", prefix: ["uos_ai", "kernel_quota", "v2", "repo_window"] },
  { group: "kernel_quota_v2_org_window", prefix: ["uos_ai", "kernel_quota", "v2", "org_window"] },
  {
    group: "kernel_quota_v2_repo_reservation",
    prefix: ["uos_ai", "kernel_quota", "v2", "repo_reservation"],
  },
  {
    group: "kernel_quota_v2_org_reservation",
    prefix: ["uos_ai", "kernel_quota", "v2", "org_reservation"],
  },
  // Kept importable until the two-phase incident migration has replayed old
  // isolate increments into the split V2 window records.
  { group: "kernel_limits_legacy", prefix: ["ubq_ai", "kernel_auth", "limits"] },
  { group: "kernel_org_usage", prefix: ["ubq_ai", "kernel_auth", "org_usage"] },
  { group: "kernel_org_usage_daily", prefix: ["ubq_ai", "kernel_auth", "org_usage_daily"] },
  { group: "kernel_org_limits_legacy", prefix: ["ubq_ai", "kernel_auth", "org_limits"] },
  { group: "defaults", prefix: ["default"] },
  { group: "kernel_pubkeys", prefix: ["uos_ai", "kernel_pubkeys"] },
  { group: "voyage_api_key", prefix: ["uos_ai", "voyage_api_key"] },
  { group: "codex_prompts", prefix: ["uos_ai", "codex_instructions"] },
  { group: "codex_prompts_chunks", prefix: ["uos_ai", "codex_instructions_chunk"] },
  { group: "codex_reset_usage", prefix: CODEX_RESET_USAGE_PREFIX },
  { group: "kernel_policy_queue", prefix: ["uos_ai", "kernel_policy_queue"] },
  { group: "migrations", prefix: ["uos_ai", "migrations"] },
  {
    group: "embeddings_idempotency_responses",
    prefix: ["embeddings", "idempotency", "v1", "response"],
  },
  { group: "embeddings_idempotency", prefix: ["embeddings", "idempotency", "v1"] },
  { group: "passkey_users", prefix: ["uos_ai", "auth", "users"] },
  { group: "passkey_handles", prefix: ["uos_ai", "auth", "handles"] },
  { group: "passkey_credentials", prefix: ["uos_ai", "auth", "credentials"] },
  { group: "agent_messages", prefix: ["agent_messages"] },
];

const CODEX_BOOTSTRAP_PREFIXES: { group: string; prefix: KvKey }[] = [
  { group: "codex_auth", prefix: ["ubq_ai", "codex_auth"] },
  { group: "codex_models", prefix: ["ubq_ai", "codex_models"] },
];

const LEGACY_DURABLE_PREFIXES: { group: string; prefix: KvKey }[] = [
  { group: "legacy_model_key_config", prefix: ["key", "config"] },
  { group: "legacy_model_key_health", prefix: ["key", "health"] },
];

const TRANSIENT_PREFIXES: { group: string; prefix: KvKey }[] = [
  { group: "passkey_challenges", prefix: ["uos_ai", "auth", "challenges"] },
  { group: "passkey_sessions", prefix: ["uos_ai", "auth", "sessions"] },
  { group: "embeddings_rate", prefix: ["embeddings", "v1", "rate"] },
  { group: "embeddings_jobs", prefix: ["embeddings", "jobs"] },
  {
    group: "paid_fallback_v3_backfill_cursor",
    prefix: ["uos_ai", "paid_fallback", "v3", "rollup_backfill_cursor"],
  },
  {
    group: "paid_fallback_v3_backfill_window_cursor",
    prefix: ["uos_ai", "paid_fallback", "v3", "rollup_backfill_window_cursor"],
  },
];

const EMBEDDINGS_CACHE_PREFIXES: { group: string; prefix: KvKey }[] = [
  { group: "embeddings_cache_index", prefix: ["embeddings", "v2", "cache_index"] },
  { group: "embeddings_cache_index_by_hash", prefix: ["embeddings", "v2", "cache_index_by_hash"] },
  { group: "embeddings_cache_values", prefix: ["embeddings", "v2"] },
];

const keyStartsWith = (key: KvKey, prefix: KvKey): boolean => {
  if (key.length < prefix.length) return false;
  return prefix.every((part, index) => key[index] === part);
};

const findPrefix = (key: KvKey, prefixes: { group: string; prefix: KvKey }[]) => prefixes.find((entry) => keyStartsWith(key, entry.prefix)) ?? null;

export const defaultIncludeLegacyForProfile = (profile: KvMigrationProfile): boolean => profile === "local";

export const classifyKvMigrationKey = (key: KvKey, options: KvMigrationClassifyOptions): KvMigrationDecision => {
  const transient = findPrefix(key, TRANSIENT_PREFIXES);
  if (transient) return { action: "skip", group: transient.group, reason: "transient_runtime_state" };

  const codex = findPrefix(key, CODEX_BOOTSTRAP_PREFIXES);
  if (codex) {
    if (options.profile === "local") {
      return { action: "import", group: codex.group, reason: "local_replay" };
    }
    return { action: "skip", group: codex.group, reason: "refreshed_by_deploy_bootstrap" };
  }

  const durable = findPrefix(key, DURABLE_PREFIXES);
  if (durable) return { action: "import", group: durable.group, reason: "durable" };

  const legacyDurable = findPrefix(key, LEGACY_DURABLE_PREFIXES);
  if (legacyDurable) {
    if (options.includeLegacy) {
      return { action: "import", group: legacyDurable.group, reason: "legacy_durable" };
    }
    return { action: "skip", group: legacyDurable.group, reason: "legacy_skipped" };
  }

  const cache = findPrefix(key, EMBEDDINGS_CACHE_PREFIXES);
  if (cache) {
    if (options.includeCache) return { action: "import", group: cache.group, reason: "cache_requested" };
    return { action: "optional", group: cache.group, reason: "cache_skipped_by_default" };
  }

  return { action: "skip", group: "unknown", reason: "unknown_prefix" };
};

export const safeKvMigrationValueType = (valueJson: unknown): string => {
  if (!valueJson || typeof valueJson !== "object") return typeof valueJson;
  const type = (valueJson as { type?: unknown }).type;
  return typeof type === "string" ? type : "object";
};

export const parseKvMigrationEntryLine = (line: string): { key: KvKey; value: unknown; raw: KvEntryJson } => {
  const raw = JSON.parse(line) as KvEntryJson;
  return {
    key: toKey(raw.key),
    value: toValue(raw.value),
    raw,
  };
};

type KvMigrationImportEntry = Readonly<{ key: KvKey; value: unknown; raw: KvEntryJson }>;

type MigrationExpireIn = number | null | "skip";

const boundedMigrationExpireIn = (anchorMs: unknown, retentionMs: number, nowMs: number): MigrationExpireIn => {
  if (typeof anchorMs !== "number" || !Number.isSafeInteger(anchorMs) || anchorMs < 0) return "skip";
  const expiresAtMs = anchorMs + retentionMs;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return "skip";
  return expiresAtMs - nowMs;
};

const apiKeyUsageV3RequestWindowResetAtMs = (key: KvKey): number | null => {
  const offset = API_KEY_USAGE_V3_REQUEST_PREFIX.length;
  if (key.length !== offset + 4) return null;
  const policyVersion = key[offset + 1];
  const windowStartMs = key[offset + 2];
  if (typeof policyVersion !== "string" || typeof windowStartMs !== "number" || !Number.isSafeInteger(windowStartMs) || windowStartMs < 0) return null;
  const windowMs = Number(policyVersion.slice("v3:".length));
  if (!policyVersion.startsWith("v3:") || !Number.isSafeInteger(windowMs) || windowMs <= 0 || policyVersion !== `v3:${windowMs}`) return null;
  const windowResetAtMs = windowStartMs + windowMs;
  return Number.isSafeInteger(windowResetAtMs) ? windowResetAtMs : null;
};

/**
 * Profile NDJSON does not carry the source KV expiry metadata.  These rows are
 * nevertheless bounded state, so restore the same anchored retention instead
 * of turning an old source row into a permanent destination row.
 */
const migrationExpireIn = (key: KvKey, value: unknown, nowMs: number): MigrationExpireIn => {
  const record = isRecord(value) ? value : null;
  if (keyStartsWith(key, API_KEY_USAGE_V3_WINDOW_PREFIX)) {
    return boundedMigrationExpireIn(record?.window_reset_at_ms, API_KEY_USAGE_V3_RETENTION_MS, nowMs);
  }
  if (keyStartsWith(key, API_KEY_USAGE_V3_REQUEST_PREFIX)) {
    // V3 request rows predate the reset timestamp field. Reconstruct the
    // matching aggregate window from the request key, as the source writer
    // anchors both rows to that window rather than to admission time.
    return boundedMigrationExpireIn(apiKeyUsageV3RequestWindowResetAtMs(key), API_KEY_USAGE_V3_RETENTION_MS, nowMs);
  }
  if (keyStartsWith(key, ["uos_ai", "paid_fallback", "ledger"])) {
    return boundedMigrationExpireIn(record?.created_at_ms, API_KEY_REQUEST_LOG_RETENTION_MS, nowMs);
  }
  if (keyStartsWith(key, ["uos_ai", "paid_fallback", "v3", "window"])) {
    return boundedMigrationExpireIn(record?.window_reset_at_ms, PAID_FALLBACK_REQUEST_LOG_RETENTION_MS, nowMs);
  }
  if (keyStartsWith(key, ["uos_ai", "paid_fallback", "v3", "request"])) {
    return boundedMigrationExpireIn(record?.created_at_ms, PAID_FALLBACK_REQUEST_LOG_RETENTION_MS, nowMs);
  }
  // Pending markers are written without a TTL and remain the durable source
  // of unresolved work until reconciliation removes them.
  if (keyStartsWith(key, ["uos_ai", "paid_fallback", "v3", "pending"])) return null;
  if (keyStartsWith(key, ["uos_ai", "paid_fallback", "v3", "reconciliation_lease"])) {
    return boundedMigrationExpireIn(record?.expires_at_ms, 0, nowMs);
  }
  // Response chunks carry no timestamp in their value, so retain only one
  // bounded response lifetime instead of turning an unanchored row permanent.
  if (keyStartsWith(key, ["embeddings", "idempotency", "v1", "response"])) return EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS;
  if (keyStartsWith(key, ["embeddings", "idempotency", "v1"])) {
    return boundedMigrationExpireIn(record?.updated_at_ms ?? record?.created_at_ms ?? nowMs, EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS, nowMs);
  }
  if (keyStartsWith(key, KERNEL_REPO_WINDOW_V2_PREFIX) || keyStartsWith(key, KERNEL_ORG_WINDOW_V2_PREFIX)) {
    return boundedMigrationExpireIn(record?.usage_reset_at_ms, KERNEL_QUOTA_RESERVATION_RETENTION_MS, nowMs);
  }
  if (keyStartsWith(key, KERNEL_REPO_RESERVATION_V2_PREFIX) || keyStartsWith(key, KERNEL_ORG_RESERVATION_V2_PREFIX)) {
    return boundedMigrationExpireIn(record?.window_reset_at_ms, KERNEL_QUOTA_RESERVATION_RETENTION_MS, nowMs);
  }
  return null;
};

type KernelWindowIdentity =
  | Readonly<{ scope: "repo"; owner: string; repo: string }>
  | Readonly<{ scope: "org"; owner: string; repo: undefined }>;

const kernelWindowIdentity = (key: KvKey): KernelWindowIdentity | null => {
  if (keyStartsWith(key, KERNEL_REPO_WINDOW_V2_PREFIX) && key.length === KERNEL_REPO_WINDOW_V2_PREFIX.length + 2) {
    const owner = key[KERNEL_REPO_WINDOW_V2_PREFIX.length];
    const repo = key[KERNEL_REPO_WINDOW_V2_PREFIX.length + 1];
    if (typeof owner === "string" && owner && typeof repo === "string" && repo) return { scope: "repo", owner, repo };
  }
  if (keyStartsWith(key, KERNEL_ORG_WINDOW_V2_PREFIX) && key.length === KERNEL_ORG_WINDOW_V2_PREFIX.length + 1) {
    const owner = key[KERNEL_ORG_WINDOW_V2_PREFIX.length];
    if (typeof owner === "string" && owner) return { scope: "org", owner, repo: undefined };
  }
  return null;
};

/** Adds the reservation aggregate to an imported legacy window when it was absent. */
const reconcileImportedKernelWindows = async (kv: Kv, windowKeys: ReadonlyMap<string, KvKey>, nowMs: number): Promise<void> => {
  for (const key of windowKeys.values()) {
    const identity = kernelWindowIdentity(key);
    if (!identity) continue;
    const entry = await kv.get(key, { consistency: "strong" });
    const window = normalizeKernelQuotaWindowV2(entry.value, identity.scope, identity.owner, identity.repo);
    if (!window || (isRecord(entry.value) && Object.hasOwn(entry.value, "reserved_requests"))) continue;

    const reservationPrefix =
      identity.scope === "repo"
        ? [...KERNEL_REPO_RESERVATION_V2_PREFIX, identity.owner, identity.repo, window.created_at_ms]
        : [...KERNEL_ORG_RESERVATION_V2_PREFIX, identity.owner, window.created_at_ms];
    let reservedRequests = 0;
    for await (const reservationEntry of kv.list({ prefix: reservationPrefix }, { consistency: "strong" })) {
      const requestId = reservationEntry.key.at(-1);
      const reservation = normalizeKernelQuotaReservationRowV2(reservationEntry.value, identity.scope, identity.owner, identity.repo);
      if (
        typeof requestId === "string" &&
        reservation !== null &&
        reservation.request_id === requestId &&
        reservation.window_created_at_ms === window.created_at_ms &&
        reservation.state === "reserved"
      ) {
        reservedRequests += 1;
      }
    }
    const reconciledWindow = { ...window, reserved_requests: reservedRequests };
    const expireIn = Math.max(1, window.usage_reset_at_ms + KERNEL_QUOTA_RESERVATION_RETENTION_MS - nowMs);
    const committed = await kv.atomic().check(entry).set(key, reconciledWindow, { expireIn }).commit();
    if (!committed.ok) throw new Error(`kernel quota window changed during migration: ${JSON.stringify(key)}`);
  }
};

/** Imports one parsed migration entry, or reports that it must be skipped. */
const importKvMigrationEntry = async (
  kv: Kv | null,
  entry: KvMigrationImportEntry,
  options: KvMigrationImportOptions,
  nowMs: number
): Promise<"imported" | "skipped"> => {
  const migrationTtl = migrationExpireIn(entry.key, entry.value, nowMs);
  if (migrationTtl === "skip") return "skipped";
  const setOptions = migrationTtl === null ? undefined : { expireIn: migrationTtl };
  if (kv && !options.overwrite) {
    const existing = await kv.get(entry.key);
    if (existing.value !== null) return "skipped";
    // Re-check the missing destination in the write transaction. A
    // read-then-set pair can otherwise import the same row twice when two
    // migration workers race with overwrite disabled.
    if (!options.dryRun) {
      const committed = await kv.atomic().check(existing).set(entry.key, entry.value, setOptions).commit();
      if (!committed.ok) return "skipped";
      return "imported";
    }
  }
  if (!options.dryRun && kv) {
    await kv.set(entry.key, entry.value, setOptions);
  }
  return "imported";
};

export async function importKvMigrationLines(
  kv: Kv | null,
  lines: AsyncIterable<string> | Iterable<string>,
  options: KvMigrationImportOptions
): Promise<KvMigrationImportResult> {
  const counters: KvMigrationCounters = { total: 0, imported: 0, skipped: 0, optional: 0, errors: 0 };
  const byGroup = new Map<string, number>();
  const migrationNowMs = Date.now();
  const importedKernelWindows = new Map<string, KvKey>();

  for await (const line of lines) {
    if (!line.trim()) continue;
    counters.total += 1;
    try {
      const entry = parseKvMigrationEntryLine(line);
      const decision = classifyKvMigrationKey(entry.key, options);
      byGroup.set(decision.group, (byGroup.get(decision.group) ?? 0) + 1);
      if (decision.action === "skip") {
        counters.skipped += 1;
        continue;
      }
      if (decision.action === "optional") {
        counters.optional += 1;
        continue;
      }
      const kernelWindow = kernelWindowIdentity(entry.key);
      const imported = await importKvMigrationEntry(kv, entry, options, migrationNowMs);
      if (imported === "skipped") counters.skipped += 1;
      else {
        counters.imported += 1;
      }
      if (kernelWindow && migrationExpireIn(entry.key, entry.value, migrationNowMs) !== "skip") {
        importedKernelWindows.set(JSON.stringify(entry.key), entry.key);
      }
    } catch {
      counters.errors += 1;
    }
  }

  if (kv && !options.dryRun && importedKernelWindows.size > 0) {
    try {
      await reconcileImportedKernelWindows(kv, importedKernelWindows, migrationNowMs);
    } catch {
      counters.errors += 1;
    }
  }

  return {
    ...counters,
    groups: Object.fromEntries(Array.from(byGroup.entries()).sort((a, b) => b[1] - a[1])),
  };
}

export const listKvMigrationCount = async (kv: Kv, prefix: KvKey, limit = Number.POSITIVE_INFINITY): Promise<number> => {
  let count = 0;
  const iterator = kv.list({ prefix });
  for (;;) {
    const { done } = await iterator.next();
    if (done) break;
    count += 1;
    if (count >= limit) break;
  }
  return count;
};
