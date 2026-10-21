// Native Codex auth-bearing routing facade and isolate cache.
import type { CodexAuthState } from "../types.ts";
import { codexActiveAccountSelectionCurrent, type CodexRoutingAccount, type CodexAccountRoutingState } from "../authority/native-codex-contracts.ts";
import type { CodexActiveAccountSnapshot } from "../authority/native-codex-contracts.ts";
export * from "../authority/native-codex-contracts.ts";
export type RoutingAccount = CodexRoutingAccount & Readonly<{ auth: CodexAuthState }>;
/** Shared routing-state cache: the capacity and probe paths write it, selectors read it. */
export const routingStateCache: {
  state: CodexAccountRoutingState | null;
  versionstamp: string | null;
  loadedAtMs: number;
} = { state: null, versionstamp: null, loadedAtMs: 0 };

/** Accessors for the routing-state cache, which the probe and selection code shares. */
export const isCodexActiveAccountSelectionCurrent = (value: unknown, account: RoutingAccount, activeGeneration: number): boolean =>
  codexActiveAccountSelectionCurrent(value, nativeCodexAccountMetadata(account), activeGeneration);
export const setRoutingStateCache = (state: CodexAccountRoutingState | null, versionstamp?: string | null): void => {
  routingStateCache.state = state;
  routingStateCache.versionstamp = versionstamp ?? null;
  routingStateCache.loadedAtMs = Date.now();
};

export const getCachedRoutingState = (): CodexAccountRoutingState | null => routingStateCache.state;

/** A durable provider-deadline circuit that may have an existing reset record to reconcile. */
export type CodexBlockedRoutingAccount = RoutingAccount &
  Readonly<{
    quotaResetAtMs: number;
    routingGeneration: number;
  }>;

export type RouteSelection =
  | Readonly<{
      kind: "eligible";
      accounts: readonly RoutingAccount[];
      skippedSlots: readonly number[];
      /** Stable absolute quota fences omitted from ordinary eligible routing. */
      blockedAccounts: readonly CodexBlockedRoutingAccount[];
    }>
  | Readonly<{
      kind: "quota_blocked";
      skippedSlots: readonly number[];
      retryAtMs: number | null;
      /** Stable absolute quota fences omitted from ordinary eligible routing. */
      blockedAccounts: readonly CodexBlockedRoutingAccount[];
      /**
       * Every current pool account proved authoritative applicable quota or
       * capacity exhaustion. Credential failures never authorize quota resets.
       */
      fullCohortExhausted: boolean;
      /** Every current subscription is quota-exhausted or has invalid current credentials. */
      fullCohortUnavailable?: boolean;
      /** The active-selection row exactly as this strong read observed it. */
      activeSnapshot: CodexActiveAccountSnapshot;
      /**
       * Canonical strong-read snapshots for pre-election reset fences. Ordered
       * pool membership, credential material, pool update identity, and the
       * stored capacity observations must all stay exactly as observed through
       * inventory and consume.
       */
      poolSnapshotJson: string | null;
      capacitySnapshotJson: string | null;
    }>
  | Readonly<{
      kind: "upstream_blocked";
      skippedSlots: readonly number[];
      retryAtMs: number | null;
      blockedAccounts: readonly [];
    }>
  | Readonly<{
      /**
       * No configured account can serve the named model. This is neither a
       * quota nor a credential outcome: no fence was written, so the request is
       * answered as an unavailable model rather than a retryable failure.
       */
      kind: "model_unavailable";
      model: string;
      /** Upstream's own detail text when a live rejection was observed. */
      detail: string | null;
      skippedSlots: readonly number[];
    }>
  | Readonly<{ kind: "credentials_invalid"; skippedSlots: readonly number[]; fullCohortUnavailable?: boolean }>
  | Readonly<{ kind: "routing_unavailable" }>;

/** Project a native request account before entering the credential-free decision graph. */
export const nativeCodexAccountMetadata = (account: RoutingAccount): CodexRoutingAccount =>
  Object.fromEntries(Object.entries(account).filter(([field]) => field !== "auth")) as CodexRoutingAccount;
