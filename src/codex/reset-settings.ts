import type { Kv, KvKey } from "#kv";
import { CODEX_AUTH_POOL_KV_KEY, parseCodexAuthPool } from "./auth.ts";
import type { CodexAuthPoolState } from "../types.ts";
import { isRecord, sha256Hex } from "../utils.ts";

export const CODEX_RESET_USAGE_PREFIX = ["uos_ai", "codex_reset_usage"] as const;

// The pre-migration global opt-out switch. It is read only until the migration
// completion marker exists and is never deleted, so a rollback to a revision
// that still reads it sees the operator's original decision.
export const CODEX_BANKED_RESET_USAGE_LEGACY_KEY = ["uos_ai", "codex_banked_reset_usage", "v1"] as const;

// The one-way completion marker. It lives under the existing migrations prefix
// because every row under `codex_reset_usage` must be a per-account record: the
// KV migration validator rejects any other key shape under that prefix.
export const CODEX_RESET_USAGE_MIGRATION_KEY = ["uos_ai", "migrations", "codex_reset_usage_legacy_global_v1"] as const;

// Stable account identity, independent of API keys and subscription ordering.
export const codexResetUsageKey = (accountIdHash: string): KvKey => [...CODEX_RESET_USAGE_PREFIX, "account", "v1", accountIdHash];

/**
 * The pre-migration switch was fail-closed: only an explicit `true` or an
 * absent row allowed a reset, so an explicit `false` and every malformed value
 * are an opt-out the migration must preserve.
 */
const isLegacyOptOut = (value: unknown): boolean => value === false || (value !== null && typeof value !== "boolean");

/**
 * Completes the one-way migration in one bounded atomic transaction whose
 * precondition is the exact strong auth-pool snapshot it enumerated: the pool
 * entry, the legacy switch and every per-subscription row are read with strong
 * consistency, then a single commit re-checks those versionstamps while seeding
 * the absent rows as `{ enabled: false }` and writing the completion marker.
 * `parseCodexAuthPool` caps the pool, so the commit carries a fixed, small
 * number of checks and mutations.
 *
 * An account configured after the enumeration read therefore invalidates the
 * commit instead of escaping the persisted global opt-out: nothing is written,
 * the marker stays absent, and the next guarded read retries this completion
 * from a fresh snapshot. An explicit per-subscription decision is never
 * overwritten, a stale legacy decision is never recorded, an absent, malformed
 * or empty pool stays `pending` so the opt-out can never retire early, and the
 * legacy key is left in place for rollback.
 */
export const migrateLegacyCodexResetOptOut = async (kv: Kv): Promise<"done" | "pending"> => {
  const marker = await kv.get(CODEX_RESET_USAGE_MIGRATION_KEY, { consistency: "strong" });
  if (marker.value !== null) return "done";

  const [legacy, poolEntry] = await Promise.all([
    kv.get(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, { consistency: "strong" }),
    kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" }),
  ]);
  const pool = parseCodexAuthPool(poolEntry.value);
  if (!pool) return "pending";

  const preservedOptOut = isLegacyOptOut(legacy.value);
  const accountIdHashes = preservedOptOut ? await Promise.all(pool.accounts.map((account) => sha256Hex(account.account_id))) : [];
  let atomic = kv.atomic().check(poolEntry).check(legacy).check(marker);
  for (const accountIdHash of accountIdHashes) {
    const key = codexResetUsageKey(accountIdHash);
    const entry = await kv.get(key, { consistency: "strong" });
    if (entry.value === null) atomic = atomic.check(entry).set(key, { enabled: false });
  }
  atomic = atomic.set(CODEX_RESET_USAGE_MIGRATION_KEY, { completed_at_ms: Date.now(), preserved_opt_out: preservedOptOut });
  return (await atomic.commit()).ok ? "done" : "pending";
};

/**
 * Admission guard for the read path while the completion marker is absent.
 * If completion is still `pending` (empty pool or a snapshot conflict), this
 * seeds the account only when the persisted global opt-out applies and it has
 * no explicit per-subscription row. The seed is fenced on the marker staying
 * absent, so an account that first appears after a completed migration follows
 * current defaults instead of inheriting a seeded opt-out.
 */
const ensureLegacyGlobalOptOutMigratedForAccount = async (kv: Kv, accountIdHash: string): Promise<void> => {
  const [marker, legacy] = await Promise.all([
    kv.get(CODEX_RESET_USAGE_MIGRATION_KEY, { consistency: "strong" }),
    kv.get(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, { consistency: "strong" }),
  ]);
  if (marker.value !== null || !isLegacyOptOut(legacy.value)) return;
  const key = codexResetUsageKey(accountIdHash);
  await kv.atomic().check(marker).check({ key, versionstamp: null }).set(key, { enabled: false }).commit();
};

export const readCodexResetUsage = async (kv: Kv, accountIdHash: string) => {
  // A guarded read retries the bounded completion, so a snapshot conflict is
  // resolved by the next read instead of pinning the legacy switch forever.
  if ((await migrateLegacyCodexResetOptOut(kv)) !== "done") await ensureLegacyGlobalOptOutMigratedForAccount(kv, accountIdHash);
  const entry = await kv.get(codexResetUsageKey(accountIdHash), { consistency: "strong" });
  return {
    allowed: entry.value === null || (isRecord(entry.value) && entry.value.enabled === true),
    entries: [entry],
  };
};
