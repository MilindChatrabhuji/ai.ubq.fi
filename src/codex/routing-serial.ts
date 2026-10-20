import type { Kv } from "#kv";
// Codex serial admission selection, split out of src/codex_account_routing.ts.

import { getKv } from "../kv.ts";
import { codexAccountEligibility, codexSubscriptionHash, loadProviderSelectionCached } from "../provider/selection.ts";
import { type CodexAuthPoolState, type CodexAuthState } from "../types.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  type CodexAccountRoutingState,
  type CodexActiveAccountSelection,
  type CodexActiveAccountTransitionReason,
  type CodexCapacityRoutingObservation,
  type RouteSelection,
  type RoutingAccount,
  isVersionstamp,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
  setRoutingStateCache,
} from "./routing-state.ts";
import { normalizeRoutingState, parseStoredCapacityObservationStore, routingAccountIdentity } from "./capacity-routing.ts";
import { evaluateCodexRoutingAccount, foldCodexRoutingEvaluation, parseCodexAuthPoolSnapshot } from "./routing-evaluation.ts";
import type { CodexRoutingAccountEvaluation, CodexRoutingAccumulation, CodexRoutingAccumulator, CodexRoutingSlotIdentity } from "./routing-evaluation.ts";
import { codexModelUnavailableAccounts } from "../models/codex-models-availability.ts";

import * as serialDecisions from "../authority/native-codex.ts";
import type { CodexSerialAdmissionPlan } from "../authority/native-codex-contracts.ts";
import { codexEvaluationMetadata, hydrateCodexRouteSelection } from "./routing-evaluation.ts";
import { foldCodexRoutingEvaluation as foldMetadata } from "../authority/native-codex-evaluation.ts";
import { nativeCodexAccountMetadata } from "./routing-state.ts";
const activeSelectionForAccount = (
  account: RoutingAccount,
  poolVersionstamp: string,
  generation: number,
  now: number,
  transitionReason: CodexActiveAccountTransitionReason | null
): CodexActiveAccountSelection | null =>
  serialDecisions.activeSelectionForAccount(nativeCodexAccountMetadata(account), poolVersionstamp, generation, now, transitionReason);
type SerialSelectionDecision = Readonly<{
  selection: RouteSelection;
  nextActive: CodexActiveAccountSelection | null;
  metadata: serialDecisions.SerialSelectionDecision;
}>;
const serialSelectionDecision = (
  active: CodexActiveAccountSelection | null,
  pool: CodexAuthPoolState,
  evaluations: SerialRoutingEvaluations,
  poolVersionstamp: string,
  now: number,
  poolSnapshotJson: string,
  capacitySnapshotJson: string
): SerialSelectionDecision | null => {
  const byAccountId = new Map(
    [...evaluations.byAccountId.values()].map((evaluation) => [evaluation.account.accountIdHash, codexEvaluationMetadata(evaluation)])
  );
  const identityByAccountId = new Map([...evaluations.identityByAccountId.values()].map((identity) => [identity.accountIdHash, identity]));
  const accumulated = {
    available: [],
    blockedAccounts: [],
    skipped: [],
    retryAt: null,
    hasQuotaBlock: false,
    hasUpstreamTimeoutBlock: false,
    modelUnavailable: null,
  } as import("../authority/native-codex-evaluation.ts").CodexRoutingAccumulator;
  for (const evaluation of byAccountId.values()) foldMetadata(accumulated, evaluation);
  const cohort = pool.accounts.flatMap((auth) => {
    const identity = evaluations.identityByAccountId.get(auth.account_id);
    return identity ? [identity] : [];
  });
  const metadata = serialDecisions.serialSelectionDecision(
    active,
    cohort,
    { accumulated, byAccountId, identityByAccountId },
    poolVersionstamp,
    now,
    null,
    null
  );
  if (metadata === null) return null;
  const selection = hydrateCodexRouteSelection(
    metadata.selection,
    [...evaluations.byAccountId.values()].map((evaluation) => evaluation.account),
    poolSnapshotJson,
    capacitySnapshotJson
  );
  return { selection, nextActive: metadata.nextActive, metadata };
};

type SerialRoutingEvaluations = Readonly<{
  accumulated: CodexRoutingAccumulation;
  byAccountId: ReadonlyMap<string, CodexRoutingAccountEvaluation>;
  identityByAccountId: ReadonlyMap<string, CodexRoutingSlotIdentity>;
}>;

/** Evaluate every configured account, preserving pool order without headroom ranking. */
const evaluateSerialRoutingAccounts = async (
  state: CodexAccountRoutingState,
  pool: CodexAuthPoolState,
  model: string | null,
  capacityObservations: readonly CodexCapacityRoutingObservation[],
  now: number,
  slotPool: CodexAuthPoolState = pool
): Promise<SerialRoutingEvaluations> => {
  // Slot identity is a durable position in the full configured pool. Resolving
  // it from a narrowed admission cohort would renumber the surviving accounts,
  // commit an active row no full-pool slot owns, and fail the final fence.
  const identities = await Promise.all(slotPool.accounts.map(routingAccountIdentity));
  const byId = new Map<string, CodexRoutingSlotIdentity>();
  for (const [slot, auth] of slotPool.accounts.entries()) {
    const identity = identities.at(slot);
    if (identity !== undefined) byId.set(auth.account_id, { slot, accountIdHash: identity.accountIdHash, credentialVersion: identity.credentialVersion });
  }
  const observationsByAccount = new Map(capacityObservations.map((observation) => [observation.account_id_hash, observation]));
  const accumulator: CodexRoutingAccumulator = {
    available: [],
    blockedAccounts: [],
    skipped: [],
    retryAt: null,
    hasQuotaBlock: false,
    hasUpstreamTimeoutBlock: false,
    modelUnavailable: null,
  };
  const byAccountId = new Map<string, CodexRoutingAccountEvaluation>();
  const unavailableAccounts = codexModelUnavailableAccounts(
    model,
    pool.accounts.map((auth) => auth.account_id)
  );
  for (const auth of pool.accounts) {
    const mapped = byId.get(auth.account_id);
    if (!mapped) continue;
    const evaluated = evaluateCodexRoutingAccount(state, auth, mapped, model, observationsByAccount, now, unavailableAccounts);
    byAccountId.set(auth.account_id, evaluated);
    foldCodexRoutingEvaluation(accumulator, evaluated);
  }
  return { accumulated: { ...accumulator }, byAccountId, identityByAccountId: byId };
};

/** One coherent strong snapshot of the four rows every admission decision linearizes on, in a fixed order. */
const readStrongCodexRoutingRows = async (kv: Kv) => {
  const [activeEntry, authEntry, routingEntry, capacityEntry] = await kv.getMany<[unknown, unknown, CodexAccountRoutingState, unknown]>(
    [CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, CODEX_AUTH_POOL_KV_KEY, CODEX_ACCOUNT_ROUTING_KV_KEY, CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY],
    { consistency: "strong" }
  );
  return { activeEntry, authEntry, routingEntry, capacityEntry };
};

type CodexSerialAdmissionRows = Readonly<{
  active: CodexActiveAccountSelection | null;
  durablePool: CodexAuthPoolState;
  durableRouting: CodexAccountRoutingState | null;
  normalized: CodexAccountRoutingState;
  poolVersionstamp: string;
  evaluations: SerialRoutingEvaluations;
  poolSnapshotJson: string;
  capacitySnapshotJson: string;
}>;

/**
 * The configured subscriptions the operator has left eligible for routing.
 * Durable slots keep tracking every configured account — the routing state is
 * passed the full pool — so re-enabling a subscription resumes its recorded
 * quota history instead of rebuilding it. Only the accounts an admission may
 * select are narrowed here.
 *
 * Narrowing the pool is itself the operator's decision, so a reduced cohort is
 * the cohort: "every account is exhausted" and the banked-reset cohort both
 * describe the subscriptions that are still switched on.
 */
export const selectedCodexSubscriptionPool = async (pool: CodexAuthPoolState): Promise<CodexAuthPoolState> => {
  const eligibility = codexAccountEligibility(await loadProviderSelectionCached());
  if (eligibility.kind === "all") return pool;
  if (eligibility.kind === "none") return pool.accounts.length ? { ...pool, accounts: [] } : pool;
  const enabled = new Set<string>(eligibility.hashes);
  const accounts: CodexAuthState[] = [];
  for (const account of pool.accounts) {
    if (enabled.has(await codexSubscriptionHash(account.account_id))) accounts.push(account);
  }
  return accounts.length === pool.accounts.length ? pool : { ...pool, accounts };
};

/**
 * Parse one strong-read snapshot. Any malformed or unavailable durable row
 * fails the admission before any decision or write.
 */
const prepareCodexSerialAdmissionRows = async (
  rows: Awaited<ReturnType<typeof readStrongCodexRoutingRows>>,
  now: number,
  model: string | null
): Promise<CodexSerialAdmissionRows | null> => {
  const active = rows.activeEntry.value === null ? null : parseCodexActiveAccountSelection(rows.activeEntry.value);
  if (rows.activeEntry.value !== null && active === null) return null;
  const durablePool = rows.authEntry.value === null ? null : parseCodexAuthPoolSnapshot(rows.authEntry.value);
  const poolVersionstamp = rows.authEntry.versionstamp;
  if (!durablePool || !isVersionstamp(poolVersionstamp)) return null;
  const durableRouting = rows.routingEntry.value === null ? null : parseCodexAccountRoutingState(rows.routingEntry.value);
  if (rows.routingEntry.value !== null && durableRouting === null) return null;
  const normalized = await normalizeRoutingState(durableRouting, durablePool, now, true);
  const observations = parseStoredCapacityObservationStore(rows.capacityEntry.value);
  // The admission pool and the decision pool must be the same pool, or a
  // switched-off subscription could still be elected as the active account.
  // Slot identity stays the full pool's, so the narrowed cohort cannot
  // renumber the slot the decision commits and the final fence resolves.
  const routingPool = await selectedCodexSubscriptionPool(durablePool);
  const evaluations = await evaluateSerialRoutingAccounts(normalized, routingPool, model, observations, now, durablePool);
  return {
    active,
    durablePool: routingPool,
    durableRouting,
    normalized,
    poolVersionstamp,
    evaluations,
    poolSnapshotJson: JSON.stringify(rows.authEntry.value ?? null),
    capacitySnapshotJson: JSON.stringify(rows.capacityEntry.value ?? null),
  };
};

/**
 * Commit one admission decision against the exact rows it was derived from.
 * The routing write precedes the active write, and the isolate cache is
 * refreshed only after a successful commit. A conflict reloads every row.
 */
const commitCodexSerialAdmission = async (
  kv: Kv,
  rows: Awaited<ReturnType<typeof readStrongCodexRoutingRows>>,
  prepared: CodexSerialAdmissionRows,
  decision: SerialSelectionDecision
): Promise<boolean> => {
  const plan: CodexSerialAdmissionPlan = serialDecisions.planCodexSerialCommit(
    {
      active: rows.activeEntry.versionstamp,
      pool: rows.authEntry.versionstamp,
      routing: rows.routingEntry.versionstamp,
      capacity: rows.capacityEntry.versionstamp,
    },
    prepared.durableRouting,
    prepared.normalized,
    decision.metadata
  );
  let operation = kv
    .atomic()
    .check({ key: rows.activeEntry.key, versionstamp: plan.checks.active })
    .check({ key: rows.authEntry.key, versionstamp: plan.checks.pool })
    .check({ key: rows.routingEntry.key, versionstamp: plan.checks.routing })
    .check({ key: rows.capacityEntry.key, versionstamp: plan.checks.capacity });
  if (plan.writes.routing !== null) operation = operation.set(CODEX_ACCOUNT_ROUTING_KV_KEY, plan.writes.routing);
  if (plan.writes.active !== null) operation = operation.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, plan.writes.active);
  const committed = await operation.commit();
  if (!committed.ok) return false;
  setRoutingStateCache(prepared.normalized, plan.writes.routing !== null ? committed.versionstamp : rows.routingEntry.versionstamp);
  return true;
};

/**
 * FIFO admission tail per KV instance. Concurrent routing admissions in one
 * isolate otherwise snapshot the same pre-bootstrap rows and exhaust their
 * three CAS attempts as conflicts, so only the short strong-selection and
 * same-identity fence decisions are serialized; auth refresh, transport,
 * inference, and streams stay concurrent. Stored promises are release-only and
 * never reject.
 */
const admissionTails = new WeakMap<Kv, Promise<void>>();

/**
 * Run one short routing-admission action under the per-KV FIFO tail. This
 * caller's release-only promise is installed before it waits, and is always
 * released, so a failure can never poison later callers.
 */
const withCodexAdmission = async <T>(kv: Kv, action: () => Promise<T>): Promise<T> => {
  const priorAdmission = admissionTails.get(kv) ?? Promise.resolve();
  let releaseAdmission = (): void => {};
  const admissionRelease = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  admissionTails.set(kv, admissionRelease);
  try {
    await priorAdmission;
    return await action();
  } finally {
    releaseAdmission();
    if (admissionTails.get(kv) === admissionRelease) admissionTails.delete(kv);
  }
};

/**
 * Every ordinary admission strongly reads the active selection, auth pool,
 * and routing state. A missing active row is the one bootstrap case; any
 * malformed or unavailable durable state fails before upstream dispatch.
 */
const selectSerialCodexRoutingAccounts = async (
  _suppliedPool: CodexAuthPoolState,
  _orderedAccounts: readonly CodexAuthState[],
  now: number,
  model: string | null
): Promise<RouteSelection> => {
  try {
    const kv = await getKv();
    if (!kv) return { kind: "routing_unavailable" };
    return await withCodexAdmission(kv, async (): Promise<RouteSelection> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const rows = await readStrongCodexRoutingRows(kv);
        const prepared = await prepareCodexSerialAdmissionRows(rows, now, model);
        if (prepared === null) return { kind: "routing_unavailable" };
        const decision = serialSelectionDecision(
          prepared.active,
          prepared.durablePool,
          prepared.evaluations,
          prepared.poolVersionstamp,
          now,
          prepared.poolSnapshotJson,
          prepared.capacitySnapshotJson
        );
        if (decision === null) return { kind: "routing_unavailable" };
        if (!(await commitCodexSerialAdmission(kv, rows, prepared, decision))) continue;
        return decision.selection;
      }
      return { kind: "routing_unavailable" };
    });
  } catch {
    return { kind: "routing_unavailable" };
  }
};

/** Exact value binding to the active row one strong read observed. */

export { activeSelectionForAccount, evaluateSerialRoutingAccounts, readStrongCodexRoutingRows, selectSerialCodexRoutingAccounts, withCodexAdmission };
