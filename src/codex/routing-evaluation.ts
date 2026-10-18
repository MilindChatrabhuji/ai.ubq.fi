// Native auth/model/overage boundaries around source-owned pure evaluation.
import { getString, isRecord } from "../utils.ts";
import { type CodexAuthPoolState, type CodexAuthState } from "../types.ts";
import { parseCodexAuthPool } from "./auth.ts";
import { codexModelUnavailableAccounts } from "../models/codex-models-availability.ts";
import { overageUsageAllowedSync } from "./overage-settings.ts";
import {
  type CodexAccountRoutingState,
  type CodexActiveAccountSnapshot,
  type CodexCapacityRoutingObservation,
  type CodexBlockedRoutingAccount,
  type RoutingAccount,
  type RouteSelection,
  isSafeMs,
  nativeCodexAccountMetadata,
} from "./routing-state.ts";
import type { CodexRoutingAccount, CodexRouteSelection } from "../authority/native-codex-contracts.ts";
import * as decisions from "../authority/native-codex-evaluation.ts";
type CodexRoutingSlotIdentity = decisions.CodexRoutingSlotIdentity;
type CodexRoutingAccountEvaluation = Omit<decisions.CodexRoutingAccountEvaluation, "account" | "routedAccount" | "blockedAccount"> &
  Readonly<{
    account: RoutingAccount & Readonly<{ routingGeneration: number }>;
    routedAccount: RoutingAccount | null;
    blockedAccount: CodexBlockedRoutingAccount | null;
  }>;
type CodexRoutingAccumulator = Omit<decisions.CodexRoutingAccumulator, "available" | "blockedAccounts"> & {
  available: RoutingAccount[];
  blockedAccounts: CodexBlockedRoutingAccount[];
};
type CodexRoutingAccumulation = Readonly<CodexRoutingAccumulator>;

const hydrateAccount = <T extends CodexRoutingAccount>(account: T, auth: CodexAuthState): T & Readonly<{ auth: CodexAuthState }> => ({ auth, ...account });
export const codexEvaluationMetadata = (evaluated: CodexRoutingAccountEvaluation): decisions.CodexRoutingAccountEvaluation => ({
  ...evaluated,
  account: { ...nativeCodexAccountMetadata(evaluated.account), routingGeneration: evaluated.account.routingGeneration },
  routedAccount: evaluated.routedAccount === null ? null : nativeCodexAccountMetadata(evaluated.routedAccount),
  blockedAccount:
    evaluated.blockedAccount === null
      ? null
      : {
          ...nativeCodexAccountMetadata(evaluated.blockedAccount),
          quotaResetAtMs: evaluated.blockedAccount.quotaResetAtMs,
          routingGeneration: evaluated.blockedAccount.routingGeneration,
        },
});
const accumulationMetadata = (accumulated: CodexRoutingAccumulation): decisions.CodexRoutingAccumulation => ({
  ...accumulated,
  available: accumulated.available.map(nativeCodexAccountMetadata),
  blockedAccounts: accumulated.blockedAccounts.map((account) => ({
    ...nativeCodexAccountMetadata(account),
    quotaResetAtMs: account.quotaResetAtMs,
    routingGeneration: account.routingGeneration,
  })),
});
export const hydrateCodexRouteSelection = (
  selection: CodexRouteSelection,
  accounts: readonly RoutingAccount[],
  poolSnapshotJson: string | null = null,
  capacitySnapshotJson: string | null = null
): RouteSelection => {
  const authFor = (account: CodexRoutingAccount): CodexAuthState => {
    const found = accounts.find((candidate) => candidate.accountIdHash === account.accountIdHash && candidate.slot === account.slot);
    if (!found) throw new Error("Native Codex account metadata lost its trusted pool binding");
    return found.auth;
  };
  if (selection.kind === "eligible")
    return {
      ...selection,
      accounts: selection.accounts.map((account) => hydrateAccount(account, authFor(account))),
      blockedAccounts: selection.blockedAccounts.map((account) => hydrateAccount(account, authFor(account))),
    };
  if (selection.kind === "quota_blocked")
    return {
      ...selection,
      blockedAccounts: selection.blockedAccounts.map((account) => hydrateAccount(account, authFor(account))),
      poolSnapshotJson,
      capacitySnapshotJson,
    };
  return selection;
};
const evaluateCodexRoutingAccount = (
  state: CodexAccountRoutingState,
  auth: CodexAuthState,
  mapped: CodexRoutingSlotIdentity,
  model: string | null,
  observationsByAccount: ReadonlyMap<string, CodexCapacityRoutingObservation>,
  now: number,
  modelUnavailable: ReadonlyMap<string, string | null>
): CodexRoutingAccountEvaluation => {
  const evaluated = decisions.evaluateCodexRoutingAccount(state, mapped, model, observationsByAccount, now, {
    modelUnavailable: modelUnavailable.has(auth.account_id) ? { detail: modelUnavailable.get(auth.account_id) ?? null } : null,
    overageUsageAllowed: overageUsageAllowedSync(mapped.accountIdHash),
  });
  return {
    ...evaluated,
    account: hydrateAccount(evaluated.account, auth),
    routedAccount: evaluated.routedAccount === null ? null : hydrateAccount(evaluated.routedAccount, auth),
    blockedAccount: evaluated.blockedAccount === null ? null : hydrateAccount(evaluated.blockedAccount, auth),
  };
};
const foldCodexRoutingEvaluation = (accumulator: CodexRoutingAccumulator, evaluated: CodexRoutingAccountEvaluation): void => {
  const trustedAccounts = [...accumulator.available, ...accumulator.blockedAccounts, evaluated.account];
  const metadata = { ...accumulationMetadata(accumulator) };
  decisions.foldCodexRoutingEvaluation(metadata, codexEvaluationMetadata(evaluated));
  const authFor = (account: CodexRoutingAccount): CodexAuthState => {
    const found = trustedAccounts.find((candidate) => candidate.accountIdHash === account.accountIdHash && candidate.slot === account.slot);
    if (!found) throw new Error("Native Codex accumulation lost its trusted pool binding");
    return found.auth;
  };
  Object.assign(accumulator, metadata, {
    available: metadata.available.map((account) => hydrateAccount(account, authFor(account))),
    blockedAccounts: metadata.blockedAccounts.map((account) => hydrateAccount(account, authFor(account))),
  });
};
const classifyCodexRouteSelection = (
  accumulated: CodexRoutingAccumulation,
  fullCohortExhausted = false,
  activeSnapshot: CodexActiveAccountSnapshot = { selection: null },
  poolSnapshotJson: string | null = null,
  capacitySnapshotJson: string | null = null,
  fullCohortUnavailable = false
): RouteSelection =>
  hydrateCodexRouteSelection(
    decisions.classifyCodexRouteSelection(accumulationMetadata(accumulated), fullCohortExhausted, activeSnapshot, null, null, fullCohortUnavailable),
    [...accumulated.available, ...accumulated.blockedAccounts],
    poolSnapshotJson,
    capacitySnapshotJson
  );
/** Accumulate every ordered account's routing outcome, preserving selection order. */
const accumulateCodexRoutingAccounts = (
  state: CodexAccountRoutingState,
  byId: ReadonlyMap<string, CodexRoutingSlotIdentity>,
  orderedAccounts: readonly CodexAuthState[],
  model: string | null,
  observationsByAccount: ReadonlyMap<string, CodexCapacityRoutingObservation>,
  now: number
): CodexRoutingAccumulation => {
  const accumulator: CodexRoutingAccumulator = {
    available: [],
    blockedAccounts: [],
    skipped: [],
    retryAt: null,
    hasQuotaBlock: false,
    hasUpstreamTimeoutBlock: false,
    modelUnavailable: null,
  };
  const unavailableAccounts = codexModelUnavailableAccounts(
    model,
    orderedAccounts.map((auth) => auth.account_id)
  );
  for (const auth of orderedAccounts) {
    const mapped = byId.get(auth.account_id);
    if (!mapped) continue;
    foldCodexRoutingEvaluation(accumulator, evaluateCodexRoutingAccount(state, auth, mapped, model, observationsByAccount, now, unavailableAccounts));
  }
  return { ...accumulator };
};

const parseCodexAuthPoolSnapshot = (value: unknown): CodexAuthPoolState | null => {
  if (!isRecord(value) || !Array.isArray(value.accounts) || !isSafeMs(value.updated_at_ms) || value.accounts.length < 1) return null;
  const accountIds = new Set<string>();
  for (const candidate of value.accounts) {
    if (!isRecord(candidate)) return null;
    const accountId = getString(candidate.account_id);
    const accessToken = getString(candidate.access_token);
    if (!accountId || !accessToken || !isSafeMs(candidate.updated_at_ms) || accountIds.has(accountId)) return null;
    accountIds.add(accountId);
  }
  // Preserve validated ownership and the canonical maximum-pool bound.
  return parseCodexAuthPool(value);
};

export { accumulateCodexRoutingAccounts, classifyCodexRouteSelection, evaluateCodexRoutingAccount, foldCodexRoutingEvaluation, parseCodexAuthPoolSnapshot };
export type { CodexRoutingAccumulation, CodexRoutingAccumulator, CodexRoutingAccountEvaluation, CodexRoutingSlotIdentity };
