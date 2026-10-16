import type { AtomicOperation, Kv, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
// Shared harness for the codex-auth-cache suites, moved out of tests/codex-auth-cache.test.ts.

import assert from "node:assert/strict";
import type { CodexBankedResetConfig } from "../../src/codex/banked-reset.ts";
import { setKvForTest } from "../../src/kv.ts";
import type { CodexUsageResetProvider } from "../../src/codex/banked-reset-provider.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../../src/types.ts";

const AUTH_KEY = ["ubq_ai", "codex_auth"] as const;

type FakeKvWrite = { type: "set" | "delete"; key: KvKey; value?: unknown };

/** `void` may not appear as a call-site type argument, so name the deferred shape. */
type VoidDeferred = PromiseWithResolvers<void>;

const isAuthKey = (key: KvKey): boolean => JSON.stringify(key) === JSON.stringify(AUTH_KEY);

/** Upstream error type a banked-reset probe status maps to. */
const probeErrorType = (status: number): string => {
  if (status === 429) return "usage_limit_reached";
  if (status === 401) return "authentication_error";
  return "forbidden";
};

const isProviderHealthSuccessWrite = (write: FakeKvWrite): boolean =>
  write.key[0] === "uos_ai" &&
  write.key[1] === "provider_health" &&
  write.key[2] === "v1" &&
  (write.value as { event?: unknown } | undefined)?.event === "success";

class AuthKv {
  auth: CodexAuthPoolState;
  reads = 0;
  routingReads = 0;
  routingCommitFailures = 0;
  nextReadGate: Promise<void> | null = null;
  onRoutingRead: ((read: number) => void | Promise<void>) | null = null;
  providerHealthSuccessCommitGate: Promise<void> | null = null;
  onProviderHealthSuccessCommit: (() => void) | null = null;
  onProviderHealthSuccessCommitted: (() => void) | null = null;
  authVersion = 1;
  readonly extra = new Map<string, { value: unknown; version: number }>();

  constructor(auth: CodexAuthPoolState) {
    this.auth = auth;
  }

  get<T>(key: KvKey, options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    assert.equal(options?.consistency, "strong");
    if (JSON.stringify(key) !== JSON.stringify(AUTH_KEY)) {
      const routingRead = ++this.routingReads;
      const hook = this.onRoutingRead;
      return Promise.resolve(hook?.(routingRead)).then(() => {
        const entry = this.extra.get(JSON.stringify(key));
        return {
          key,
          value: (entry?.value ?? null) as T | null,
          versionstamp: entry ? String(entry.version).padStart(20, "0") : null,
        } as KvEntryMaybe<T>;
      });
    }
    this.reads += 1;
    const value = this.auth as T;
    const versionstamp = String(this.authVersion).padStart(20, "0");
    const gate = this.nextReadGate;
    this.nextReadGate = null;
    return (gate ?? Promise.resolve()).then(() => ({ key, value, versionstamp }));
  }

  getMany<T extends readonly unknown[]>(
    keys: readonly KvKey[],
    options?: { consistency?: "strong" | "eventual" }
  ): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }> {
    assert.equal(options?.consistency, "strong");
    // Capture every value and versionstamp synchronously, before any
    // routing-read hook or auth-read gate can mutate the fixture, so the
    // resolved tuple is one coherent snapshot.
    const snapshot = keys.map((key) => this.#snapshotRead(key));
    const gate = snapshot.some((entry) => entry.authRead) ? this.nextReadGate : null;
    if (gate !== null) this.nextReadGate = null;
    return Promise.resolve()
      .then(async () => {
        for (const entry of snapshot) {
          if (entry.routingRead !== null) await this.onRoutingRead?.(entry.routingRead);
        }
      })
      .then(() => gate ?? undefined)
      .then(
        () =>
          snapshot.map((entry) => entry.entry) as {
            [K in keyof T]: KvEntryMaybe<T[K]>;
          }
      );
  }

  /** One synchronous row snapshot plus the read accounting its `get` would record. */
  #snapshotRead(key: KvKey): Readonly<{ entry: KvEntryMaybe<unknown>; authRead: boolean; routingRead: number | null }> {
    if (isAuthKey(key)) {
      this.reads += 1;
      return {
        entry: { key, value: this.auth, versionstamp: String(this.authVersion).padStart(20, "0") },
        authRead: true,
        routingRead: null,
      };
    }
    const routingRead = ++this.routingReads;
    const stored = this.extra.get(JSON.stringify(key));
    return {
      entry:
        stored === undefined ? { key, value: null, versionstamp: null } : { key, value: stored.value, versionstamp: String(stored.version).padStart(20, "0") },
      authRead: false,
      routingRead,
    };
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    if (JSON.stringify(key) === JSON.stringify(AUTH_KEY)) {
      this.auth = value as CodexAuthPoolState;
      this.authVersion += 1;
    } else {
      const encoded = JSON.stringify(key);
      this.extra.set(encoded, { value, version: (this.extra.get(encoded)?.version ?? 0) + 1 });
    }
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" });
  }

  atomic(): AtomicOperation {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const writes: FakeKvWrite[] = [];
    const chain = {
      check: (...entries: { key: KvKey; versionstamp: string | null }[]) => {
        checks.push(...entries);
        return chain;
      },
      set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
        writes.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        writes.push({ type: "delete", key });
        return chain;
      },
      commit: async () => {
        const providerHealthSuccess = writes.some(isProviderHealthSuccessWrite);
        if (providerHealthSuccess) {
          this.onProviderHealthSuccessCommit?.();
          await this.providerHealthSuccessCommitGate;
        }
        if (this.routingCommitFailures > 0 && writes.some((write) => !isAuthKey(write.key))) {
          this.routingCommitFailures -= 1;
          return Promise.resolve({ ok: false } as const);
        }
        for (const check of checks) {
          if (this.#checkVersion(check.key) !== check.versionstamp) return Promise.resolve({ ok: false } as const);
        }
        for (const write of writes) this.#applyWrite(write);
        if (providerHealthSuccess) this.onProviderHealthSuccessCommitted?.();
        return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" } as const);
      },
    };
    return chain as unknown as AtomicOperation;
  }

  /** Versionstamp the atomic check for `key` must match, or null when absent. */
  #checkVersion(key: KvKey): string | null {
    if (isAuthKey(key)) return String(this.authVersion).padStart(20, "0");
    const encoded = JSON.stringify(key);
    const entry = this.extra.get(encoded);
    return entry === undefined ? null : String(entry.version).padStart(20, "0");
  }

  /** Applies one committed atomic write to the in-memory store. */
  #applyWrite(write: FakeKvWrite): void {
    if (isAuthKey(write.key)) {
      if (write.type === "set") this.auth = write.value as CodexAuthPoolState;
      this.authVersion += 1;
      return;
    }
    const encoded = JSON.stringify(write.key);
    if (write.type === "delete") this.extra.delete(encoded);
    else this.extra.set(encoded, { value: write.value, version: (this.extra.get(encoded)?.version ?? 0) + 1 });
  }
}

const fixedStartMs = 1_000_000;
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
/** URL of a fetch input, for the request-shape fixtures below. */
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

/** A transport rejection reason as an Error; a DOMException already is one. */
const abortReasonError = (reason: unknown): Error => (reason instanceof Error ? reason : new Error(`transport aborted: ${String(reason)}`, { cause: reason }));
const encodeBase64Url = (value: unknown): string =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/={1,2}$/, "");
const accessToken = (label: string): string => `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url({ exp: (fixedStartMs + 60 * 60_000) / 1000 })}.${label}`;
const auth = (label: string): CodexAuthState => ({
  access_token: accessToken(label),
  refresh_token: `refresh-${label}`,
  account_id: `account-${label}`,
  updated_at_ms: fixedStartMs,
});
const staleAuth = (label: string): CodexAuthState => ({
  ...auth(label),
  access_token: `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url({ exp: (fixedStartMs + 30_000) / 1000 })}.${label}`,
});
const pool = (...accounts: CodexAuthState[]): CodexAuthPoolState => ({
  accounts,
  updated_at_ms: fixedStartMs,
});

const kv = new AuthKv(pool(auth("old")));

const { config } = await import("../../src/config.ts");

const {
  cacheCodexAuthPool,
  CODEX_AUTH_REAUTH_WARNING,
  CODEX_QUOTA_BLOCKED_ERROR_CODE,
  CodexError,
  beginCodexCacheScopeExperiment,
  fetchCodexResponses,
  fetchCodexResponsesForCacheScopeExperiment,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  getCodexRoutingError,
  getCodexRoutingProbe,
  markCodexResponseCompleted,
  orderCodexAuthAccounts,
  releaseCodexResponseProbe,
  resetCodexAuthCacheForTest,
} = await import("../../src/codex/index.ts");
const {
  claimCodexRoutingProbe,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_HALF_OPEN_LEASE_MS,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  markCodexQuotaBlocked,
  markCodexUpstreamTimeout,
  parseCodexActiveAccountSelection,
  parseCodexAccountRoutingState,
  recordCodexCapacityRoutingObservations,
  resetCodexAccountRoutingForTest,
  selectCodexRoutingAccounts,
  selectCodexRoutingAccountsStrong,
} = await import("../../src/codex/account-routing.ts");
const { resetProviderHealthThrottleForTest } = await import("../../src/provider/health.ts");

// Helpers that lived between tests in the original file.

const liveBankedResetConfig = (): CodexBankedResetConfig => ({
  enabled: true,
  mode: "live",
  maxPerAccountPerDay: 1,
  maxPerAccountPerWindow: 1,
});

const bankedResetRequestOptions = (requestId: string) => ({
  clientVersion: "0.145.0",
  requestId,
  bankedReset: {
    config: liveBankedResetConfig(),
    kv: kv as unknown as Kv,
    now: () => fixedStartMs,
    newOwnerToken: () => `owner-${requestId}`,
  },
});

const stableBankedResetRetryAfter = new Date(fixedStartMs + 60_000).toUTCString();

const seedStableBankedResetBlock = async (accountId = "account-one", observedAtMs = fixedStartMs): Promise<void> => {
  const initial = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, fixedStartMs);
  assert.equal(initial.kind, "eligible");

  const account = initial.accounts.find((candidate) => candidate.auth.account_id === accountId);
  assert.ok(account);
  await markCodexQuotaBlocked(
    account,
    new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
    }),
    observedAtMs
  );
  resetCodexAccountRoutingForTest();
};

const scriptedResetProvider = (
  options: Readonly<{
    verify?: boolean;
    redeemKind?: "completed" | "unknown" | "already_redeemed";
    onInventory?: () => void | Promise<void>;
    onRedeem?: () => void;
    onVerify?: () => void;
    redeemGate?: Promise<void>;
  }> = {}
) => {
  const calls: string[] = [];
  const inventoryAccountIds: string[] = [];
  const idempotencyKeys: string[] = [];
  const redeemAccountIds: string[] = [];
  const provider: CodexUsageResetProvider = {
    contract: {
      idempotency: { callerSupplied: true, retentionMs: 86_400_000 },
      lookup: { byIdempotencyKey: true, byProviderReceiptId: true },
      verification: { independentlyVerifiable: true },
      receiptIdsSafeToPersistAndLog: true,
      supportedResetTypes: ["codex_rate_limits"],
    },
    readInventory: async (input) => {
      calls.push("inventory");
      inventoryAccountIds.push(input.accountId);
      await options.onInventory?.();
      return {
        availableCount: 1,
        observedAtMs: fixedStartMs,
        credits: [{ id: "fixture-credit", status: "available", resetType: "codex_rate_limits", expiresAtMs: null }],
      };
    },
    redeem: async (input) => {
      calls.push("redeem");
      idempotencyKeys.push(input.idempotencyKey);
      redeemAccountIds.push(input.accountId);
      options.onRedeem?.();
      if (options.redeemGate) await options.redeemGate;
      if (options.redeemKind === "unknown") return { kind: "unknown", providerReceiptId: null };
      if (options.redeemKind === "already_redeemed") return { kind: "already_redeemed", providerReceiptId: "receipt-sanitized" };
      return { kind: "completed", providerReceiptId: "receipt-sanitized" };
    },
    lookup: (input) => {
      calls.push("lookup");
      idempotencyKeys.push(input.idempotencyKey);
      return Promise.resolve({ kind: "completed", providerReceiptId: "receipt-sanitized" });
    },
    verifyApplied: () => {
      calls.push("verify");
      options.onVerify?.();
      return Promise.resolve(options.verify ?? true);
    },
  };
  return { provider, calls, inventoryAccountIds, idempotencyKeys, redeemAccountIds };
};

export {
  AUTH_KEY,
  AuthKv,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_REAUTH_WARNING,
  CODEX_HALF_OPEN_LEASE_MS,
  CODEX_QUOTA_BLOCKED_ERROR_CODE,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  CodexError,
  abortReasonError,
  accessToken,
  auth,
  bankedResetRequestOptions,
  beginCodexCacheScopeExperiment,
  cacheCodexAuthPool,
  claimCodexRoutingProbe,
  config,
  encodeBase64Url,
  fetchCodexResponses,
  fetchCodexResponsesForCacheScopeExperiment,
  fixedStartMs,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  getCodexRoutingError,
  getCodexRoutingProbe,
  isAuthKey,
  isProviderHealthSuccessWrite,
  kv,
  liveBankedResetConfig,
  markCodexQuotaBlocked,
  markCodexResponseCompleted,
  markCodexUpstreamTimeout,
  orderCodexAuthAccounts,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
  pool,
  probeErrorType,
  recordCodexCapacityRoutingObservations,
  releaseCodexResponseProbe,
  requestUrl,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  resetProviderHealthThrottleForTest,
  scriptedResetProvider,
  seedStableBankedResetBlock,
  selectCodexRoutingAccounts,
  selectCodexRoutingAccountsStrong,
  stableBankedResetRetryAfter,
  staleAuth,
  utf8ByteLength,
};
export type { FakeKvWrite, VoidDeferred };
export type { CodexUsageResetProvider } from "../../src/codex/banked-reset-provider.ts";
export type { CodexAuthPoolState } from "../../src/types.ts";
export type { CodexAuthState } from "../../src/types.ts";
export { CODEX_BANKED_RESET_LEASE_MS } from "../../src/codex/banked-reset.ts";
export type { CodexBankedResetConfig } from "../../src/codex/banked-reset.ts";
export { setKvForTest } from "../../src/kv.ts";
export { PROVIDER_CAPACITY_SNAPSHOT_KEY } from "../../src/provider/capacity-contract.ts";

/** Reinstall this fixture explicitly when a Bun test file uses the cached harness. */
export const installHarness = (): void => {
  setKvForTest(kv as unknown as Kv);
};
export const resetHarness = (): void => {
  kv.extra.clear();
  kv.reads = 0;
  kv.routingReads = 0;
  kv.routingCommitFailures = 0;
  kv.nextReadGate = null;
  kv.onRoutingRead = null;
  kv.providerHealthSuccessCommitGate = null;
  kv.onProviderHealthSuccessCommit = null;
  kv.onProviderHealthSuccessCommitted = null;
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  installHarness();
};
export const cleanupHarness = (): void => {
  setKvForTest(null);
};
