import type { Kv, KvKey } from "#kv";
// Per-account overage-usage setting: when an operator explicitly allows
// overage spending for a Codex subscription, an exhausted account may probe
// (and thereby serve through the paid backup balance) instead of waiting for a
// banked-reset redemption. The default is false: resets first, overage only
// when no redemption is available.

import { getKv } from "../kv.ts";
import type { CodexAuthPoolState } from "../types.ts";
import { isRecord, sha256Hex } from "../utils.ts";
import { routingAccountIdentity } from "./capacity-routing.ts";

export const CODEX_OVERAGE_USAGE_PREFIX = ["uos_ai", "codex_overage_usage", "account", "v1"] as const;

/** The routing path evaluates this setting synchronously, so a bounded cache mirrors the KV rows. */
const OVERAGE_USAGE_CACHE_TTL_MS = 5_000;

/** The admin-facing account hash is the same unsalted hash the other settings surfaces use. */
export const codexOverageUsageKey = (accountIdHash: string): KvKey => [...CODEX_OVERAGE_USAGE_PREFIX, accountIdHash];

let allowedRoutingHashes: ReadonlySet<string> = new Set();
let cacheLoadedAtMs = 0;

/** A strong read; an absent or malformed row never permits overage spending. */
export const readOverageUsage = async (kv: Kv, accountIdHash: string): Promise<boolean> => {
  const entry = await kv.get(codexOverageUsageKey(accountIdHash), { consistency: "strong" });
  return isRecord(entry.value) && entry.value.allow === true;
};

export const writeOverageUsage = async (kv: Kv, accountIdHash: string, allow: boolean): Promise<void> => {
  await kv.set(codexOverageUsageKey(accountIdHash), { allow });
};

/**
 * Refresh the routing-facing cache from the configured pool. The cache is keyed
 * by the routing identity hash because routing evaluation is synchronous; the
 * KV rows stay keyed by the admin-facing account hash. A KV failure keeps the
 * previous cache and its timestamp so the next request retries.
 */
export const loadOverageUsageSettings = async (pool: CodexAuthPoolState, force = false): Promise<void> => {
  const now = Date.now();
  if (!force && now - cacheLoadedAtMs < OVERAGE_USAGE_CACHE_TTL_MS) return;
  try {
    const kv = await getKv();
    if (!kv) return;
    const rows = await Promise.all(
      pool.accounts.map(async (account) => {
        const [adminHash, identity] = await Promise.all([sha256Hex(account.account_id), routingAccountIdentity(account)]);
        return { routingHash: identity.accountIdHash, allow: await readOverageUsage(kv, adminHash) };
      })
    );
    allowedRoutingHashes = new Set(rows.filter((row) => row.allow).map((row) => row.routingHash));
    cacheLoadedAtMs = now;
  } catch {
    // Keep the previous cache so an unreadable KV cannot silently disable a
    // setting mid-flight; the timestamp stays old so the next request retries.
  }
};

/** Routing evaluation's synchronous lookup. Absent cache entries are false. */
export const overageUsageAllowedSync = (routingAccountIdHash: string): boolean => allowedRoutingHashes.has(routingAccountIdHash);

export const resetOverageUsageCacheForTest = (): void => {
  allowedRoutingHashes = new Set();
  cacheLoadedAtMs = 0;
};
