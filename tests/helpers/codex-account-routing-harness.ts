import type { AtomicOperation, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
// Shared harness for the codex-account-routing suites, moved out of tests/codex-account-routing.test.ts.

import { codexSubscriptionHash, codexSubscriptionSelectionId } from "../../src/provider/selection.ts";
import { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } from "../../src/provider/selection.ts";
import type { CodexAuthPoolState } from "../../src/types.ts";

const key = (value: KvKey): string => JSON.stringify(value);

/** Canonical HTTP-date Retry-After quota fixture shared by the routing tests. */
const httpDateQuotaResponse = (deadline: number) =>
  new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": new Date(deadline).toUTCString() },
  });

/** Delta-seconds Retry-After quota fixture shared by the routing tests. */
const deltaSecondsQuotaResponse = (retryAfter: string) =>
  new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": retryAfter },
  });

/** Synthetic legacy class block written straight to KV to exercise migration. */
const syntheticLegacyBlock = (blockedUntilMs: number, quotaSignalObservedAtMs: number) => ({
  blocked_until_ms: blockedUntilMs,
  source: "header_retry_after" as const,
  quota_signal_observed_at_ms: quotaSignalObservedAtMs,
  observed_reset_at_ms: null,
  observed_reset_at_is_stable: false,
  banked_reset_generation_ambiguous: false,
  banked_reset_recovery_probe_pending: false,
});

/** Narrow a fixture value the test has already proven present. */
const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
};

/** The requested URL of a fetch input, whichever shape the caller passed. */
const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

class RoutingKv {
  values = new Map<string, unknown>();
  versions = new Map<string, number>();

  get<T>(kvKey: KvKey): Promise<KvEntryMaybe<T>> {
    const encoded = key(kvKey);
    const value = this.values.get(encoded) as T | undefined;
    const version = this.versions.get(encoded);
    return Promise.resolve({
      key: kvKey,
      value: value ?? null,
      versionstamp: version === undefined ? null : String(version).padStart(20, "0"),
    } as KvEntryMaybe<T>);
  }

  getMany<T extends readonly unknown[]>(kvKeys: readonly KvKey[]): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }> {
    // Snapshot every value and versionstamp synchronously so one resolved tuple
    // cannot mix rows from different write generations.
    const snapshot = kvKeys.map((kvKey) => {
      const encoded = key(kvKey);
      const value = this.values.get(encoded) as T[number] | undefined;
      const version = this.versions.get(encoded);
      return {
        key: kvKey,
        value: value ?? null,
        versionstamp: version === undefined ? null : String(version).padStart(20, "0"),
      } as KvEntryMaybe<T[number]>;
    });
    return Promise.resolve(snapshot as { [K in keyof T]: KvEntryMaybe<T[K]> });
  }

  set(kvKey: KvKey, value: unknown): Promise<KvCommitResult> {
    const encoded = key(kvKey);
    const version = (this.versions.get(encoded) ?? 0) + 1;
    this.values.set(encoded, value);
    this.versions.set(encoded, version);
    return Promise.resolve({ ok: true, versionstamp: String(version).padStart(20, "0") });
  }

  atomic(): AtomicOperation {
    const writes: { key: KvKey; value: unknown }[] = [];
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const chain = {
      check: (...entries: { key: KvKey; versionstamp: string | null }[]) => {
        checks.push(...entries);
        return chain;
      },
      set: (kvKey: KvKey, value: unknown) => {
        writes.push({ key: kvKey, value });
        return chain;
      },
      commit: () => {
        for (const entry of checks) {
          const current = this.versions.get(key(entry.key));
          const versionstamp = current === undefined ? null : String(current).padStart(20, "0");
          if (versionstamp !== entry.versionstamp) return Promise.resolve({ ok: false } as const);
        }
        let last = 0;
        for (const write of writes) this.values.set(key(write.key), write.value);
        for (const write of writes) {
          const encoded = key(write.key);
          last = (this.versions.get(encoded) ?? 0) + 1;
          this.versions.set(encoded, last);
        }
        return Promise.resolve({ ok: true, versionstamp: String(last).padStart(20, "0") } as const);
      },
    };
    return chain as unknown as AtomicOperation;
  }
}

const pool: CodexAuthPoolState = {
  accounts: [
    { access_token: "access-one", refresh_token: "refresh-one", account_id: "one", updated_at_ms: 1 },
    { access_token: "access-two", refresh_token: "refresh-two", account_id: "two", updated_at_ms: 1 },
  ],
  updated_at_ms: 1,
};

const singlePool: CodexAuthPoolState = {
  accounts: [pool.accounts[0]],
  updated_at_ms: pool.updated_at_ms,
};

// Helpers that lived between tests in the original file.

const seedSubscriptionSelection = async (kv: RoutingKv, accountIds: readonly string[]): Promise<void> => {
  await kv.set(PROVIDER_SELECTION_KV_KEY, {
    provider_ids: await Promise.all(accountIds.map(async (id) => codexSubscriptionSelectionId(await codexSubscriptionHash(id)))),
    updated_at_ms: Date.now(),
  });
  resetProviderSelectionCacheForTest();
};

export {
  RoutingKv,
  deltaSecondsQuotaResponse,
  httpDateQuotaResponse,
  key,
  pool,
  requestUrl,
  required,
  seedSubscriptionSelection,
  singlePool,
  syntheticLegacyBlock,
};
export { setKvForTest } from "../../src/kv.ts";
export { resetCodexAccountRoutingForTest } from "../../src/codex/account-routing.ts";
export { CODEX_AUTH_POOL_KV_KEY, CodexError, fetchCodexResponses, getCodexRoutingError, resetCodexAuthCacheForTest } from "../../src/codex/index.ts";
export {
  claimCodexRoutingProbe,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_CAPACITY_ROUTING_MAX_AGE_MS,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  CODEX_HALF_OPEN_LEASE_MS,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  codexCredentialVersion,
  getCodexQuotaBlockFence,
  markCodexCredentialInvalid,
  markCodexQuotaBlocked,
  markCodexRecoveryProbeQuotaBlocked,
  markCodexSuccess,
  markCodexUpstreamTimeout,
  parseCodexActiveAccountSelection,
  parseCodexAccountRoutingState,
  readCodex429,
  recheckCodexRoutingSlot,
  reconcileCodexQuotaAfterStaleVerifiedReset,
  reconcileCodexQuotaAfterVerifiedReset,
  reconcileCodexRoutingAccount,
  recordCodexCapacityRoutingObservations,
  refreshCodexActiveAccountAdmission,
  selectCodexRoutingAccounts,
  selectCodexRoutingAccountsStrong,
} from "../../src/codex/account-routing.ts";
export { PROVIDER_CAPACITY_SNAPSHOT_KEY } from "../../src/provider/capacity-contract.ts";
export { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } from "../../src/provider/selection.ts";
export type { CodexAuthPoolState } from "../../src/types.ts";
