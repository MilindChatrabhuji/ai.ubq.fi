import { getJwtExpMs, parseCodexAuthFromAuthJson, parseCodexAuthPool, upsertCodexAuthAccount } from "./index.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../types.ts";

/**
 * Cross-machine Codex credential repair.
 *
 * The Mac and the VPS keep independent KV auth pools that are seeded from the
 * same synchronized `~/.codex/auth.json`. Because each host refreshes its own
 * access token, one host can end up holding a token the other has already
 * rotated away; the host left behind starts answering 401 until a human
 * re-uploads a credential. This module plans a narrow repair: keep every
 * account that still authenticates, and for an account that does not, adopt a
 * credential read from another host only after that credential has itself been
 * proven to authenticate. A probe that cannot decide an account does not mark
 * it broken: only an explicit rejection or a verified access-token expiry
 * establishes that a replacement is warranted.
 *
 * Validation is deliberately read-only. It is an account-bound `GET` against
 * the Codex usage endpoint, so it never runs inference and never reaches the
 * OAuth token endpoint, which means a check can never rotate a shared refresh
 * token and can never invalidate the other host's copy.
 */

/** Where a candidate credential was read from, in the order sources are consulted. */
export type CodexAuthCandidateSource = "local-auth-json" | "vps-pool" | "vps-auth-json";

/** A credential offered as a replacement for one account. */
export type CodexAuthCandidate = Readonly<{
  source: CodexAuthCandidateSource;
  account_id: string;
  access_token: string;
  refresh_token: string;
  /** Freshness reported by the source, or null when the source has no usable timestamp. */
  updated_at_ms: number | null;
}>;

/** The read-only outcome of authenticating one access token upstream. */
export type CodexAuthProbeResult =
  | Readonly<{ outcome: "valid"; status: number }>
  | Readonly<{ outcome: "invalid"; status: number }>
  | Readonly<{ outcome: "inconclusive"; status: number | null }>;

/** A candidate paired with the evidence used to rank and accept it. */
export type AssessedCodexAuthCandidate = Readonly<{
  candidate: CodexAuthCandidate;
  access_exp_ms: number | null;
  probe: CodexAuthProbeResult;
}>;

/** One local pool account with its own probe result. */
export type CodexAuthRepairAccount = Readonly<{
  slot: number;
  account: CodexAuthState;
  probe: CodexAuthProbeResult;
  /**
   * True when no candidate offers the same refresh token this account already
   * holds, false when one does, and null when no candidate source was read, so
   * the steady-state path never claims a comparison it did not make.
   */
  refresh_diverged: boolean | null;
}>;

/** A repairable account and the credential chosen for it. */
export type CodexAuthRepairSelection = Readonly<{
  slot: number;
  account_id: string;
  candidate: CodexAuthCandidate;
  access_exp_ms: number | null;
  /** Every candidate for this account that was not chosen, with its probe outcome. */
  rejected: readonly Readonly<{ source: CodexAuthCandidateSource; outcome: CodexAuthProbeResult["outcome"]; status: number | null }>[];
}>;

export type CodexAuthRepairPlan = Readonly<{
  selections: readonly CodexAuthRepairSelection[];
  /** Accounts that need a replacement but have no candidate that authenticates. */
  unrepairable: readonly Readonly<{
    slot: number;
    account_id: string;
    reason: "no_candidates" | "no_valid_candidate";
    rejected: readonly Readonly<{ source: CodexAuthCandidateSource; outcome: CodexAuthProbeResult["outcome"]; status: number | null }>[];
  }>[];
  /** Accounts whose own credential still authenticates. */
  healthy: readonly Readonly<{ slot: number; account_id: string; refresh_diverged: boolean | null }>[];
  /**
   * Accounts kept as they are because their own probe could not decide them
   * and no verified expiry exists: an inconclusive probe is not evidence that
   * the credential is unusable, so nothing may replace it.
   */
  inconclusive: readonly Readonly<{
    slot: number;
    account_id: string;
    probe: Readonly<{ outcome: "inconclusive"; status: number | null }>;
    refresh_diverged: boolean | null;
  }>[];
}>;

const probeStatus = (probe: CodexAuthProbeResult): number | null => probe.status;

/**
 * A candidate is acceptable only when the upstream accepted its access token
 * *and* that token still has time left on it. A token can pass a probe and
 * still be useless moments later, so the expiry read from the token itself is
 * checked independently of the network result.
 */
export const isCodexAuthCandidateUsable = (assessed: AssessedCodexAuthCandidate, nowMs: number): boolean => {
  if (assessed.probe.outcome !== "valid") return false;
  return assessed.access_exp_ms === null || assessed.access_exp_ms > nowMs;
};

/**
 * True only when the evidence establishes that the local credential is
 * unusable: the upstream rejected it outright, or the access token's own
 * expiry has already passed. A probe that answered neither way (a timeout, a
 * 403, a 5xx) decides nothing, so it never justifies a replacement by itself;
 * the same predicate gates the CLI's paid candidate reads so an inconclusive
 * slot cannot trigger them.
 */
export const needsCodexAuthReplacement = (probe: CodexAuthProbeResult, accessExpMs: number | null, nowMs: number): boolean =>
  probe.outcome === "invalid" || (accessExpMs !== null && accessExpMs <= nowMs);

/**
 * Orders usable candidates so the caller can take the first one: most
 * remaining access-token life first, then the freshest source timestamp, then
 * the source order the caller supplied. A credential with no readable expiry
 * sorts last because it carries the least evidence.
 */
export const rankCodexAuthCandidates = (candidates: readonly AssessedCodexAuthCandidate[], nowMs: number): readonly AssessedCodexAuthCandidate[] => {
  const sourceOrder = new Map<CodexAuthCandidateSource, number>([
    ["local-auth-json", 0],
    ["vps-pool", 1],
    ["vps-auth-json", 2],
  ]);
  return [...candidates]
    .filter((assessed) => isCodexAuthCandidateUsable(assessed, nowMs))
    .sort((left, right) => {
      const leftExp = left.access_exp_ms;
      const rightExp = right.access_exp_ms;
      if (leftExp !== rightExp) {
        if (leftExp === null) return 1;
        if (rightExp === null) return -1;
        return rightExp - leftExp;
      }
      const leftUpdated = left.candidate.updated_at_ms;
      const rightUpdated = right.candidate.updated_at_ms;
      if (leftUpdated !== rightUpdated) {
        if (leftUpdated === null) return 1;
        if (rightUpdated === null) return -1;
        return rightUpdated - leftUpdated;
      }
      return (sourceOrder.get(left.candidate.source) ?? 99) - (sourceOrder.get(right.candidate.source) ?? 99);
    });
};

/**
 * Decides, per account, whether to keep the local credential, adopt another
 * host's, or report that the account cannot be repaired. Accounts that still
 * authenticate are never rewritten, and a slot whose probe was inconclusive is
 * preserved rather than repaired: a healthy slot cannot be disturbed by a
 * repair run, and neither can a slot whose health is simply unknown.
 */
export const planCodexAuthRepair = (
  input: Readonly<{
    accounts: readonly CodexAuthRepairAccount[];
    candidates: readonly AssessedCodexAuthCandidate[];
    nowMs: number;
  }>
): CodexAuthRepairPlan => {
  const selections: CodexAuthRepairSelection[] = [];
  const unrepairable: CodexAuthRepairPlan["unrepairable"][number][] = [];
  const healthy: CodexAuthRepairPlan["healthy"][number][] = [];
  const inconclusive: CodexAuthRepairPlan["inconclusive"][number][] = [];

  for (const entry of input.accounts) {
    const localExpMs = getJwtExpMs(entry.account.access_token);
    if (!needsCodexAuthReplacement(entry.probe, localExpMs, input.nowMs)) {
      if (entry.probe.outcome === "inconclusive") {
        inconclusive.push({
          slot: entry.slot,
          account_id: entry.account.account_id,
          probe: entry.probe,
          refresh_diverged: entry.refresh_diverged,
        });
      } else {
        healthy.push({ slot: entry.slot, account_id: entry.account.account_id, refresh_diverged: entry.refresh_diverged });
      }
      continue;
    }

    const forAccount = input.candidates.filter((assessed) => assessed.candidate.account_id === entry.account.account_id);
    // `at()` returns `T | undefined`, unlike an unchecked index access, so the
    // empty-candidate case stays a real branch the type system can see.
    const chosen = rankCodexAuthCandidates(forAccount, input.nowMs).at(0);
    // The adopted credential is reported separately, so it is not a rejection.
    const rejected = forAccount
      .filter((assessed) => assessed !== chosen)
      .map((assessed) => ({
        source: assessed.candidate.source,
        outcome: assessed.probe.outcome,
        status: probeStatus(assessed.probe),
      }));
    if (!chosen) {
      unrepairable.push({
        slot: entry.slot,
        account_id: entry.account.account_id,
        reason: forAccount.length === 0 ? "no_candidates" : "no_valid_candidate",
        rejected,
      });
      continue;
    }
    selections.push({
      slot: entry.slot,
      account_id: entry.account.account_id,
      candidate: chosen.candidate,
      access_exp_ms: chosen.access_exp_ms,
      rejected,
    });
  }

  return { selections, unrepairable, healthy, inconclusive };
};

/**
 * Applies a plan to the pool. Only selected accounts are replaced, matched by
 * account id, so slot order, the other account, and every unrelated KV entry
 * are left untouched. The expiry is checked again here because the plan may
 * have spent time in candidate assessment. Returns null when a selected
 * candidate is no longer usable or the pool could not represent the result;
 * callers must treat either case as "write nothing".
 *
 * Each replaced account carries the caller's `nowMs` so a repair is
 * reproducible in tests; the shared `upsertCodexAuthAccount` helper owns the
 * pool-level timestamp, exactly as it does for a gateway refresh.
 */
export const applyCodexAuthPlan = (pool: CodexAuthPoolState, plan: CodexAuthRepairPlan, nowMs: number): CodexAuthPoolState | null => {
  if (plan.selections.some((selection) => selection.access_exp_ms !== null && selection.access_exp_ms <= nowMs)) return null;
  let next: CodexAuthPoolState | null = pool;
  for (const selection of plan.selections) {
    if (!next) return null;
    next = upsertCodexAuthAccount(next, {
      access_token: selection.candidate.access_token,
      refresh_token: selection.candidate.refresh_token,
      account_id: selection.account_id,
      updated_at_ms: nowMs,
    });
  }
  return next;
};

/** Reads a candidate from an `auth.json` document. */
export const codexAuthCandidateFromAuthJson = (value: unknown, source: CodexAuthCandidateSource, updatedAtMs: number | null): CodexAuthCandidate | null => {
  const parsed = parseCodexAuthFromAuthJson(value);
  if (!parsed) return null;
  return { source, ...parsed, updated_at_ms: updatedAtMs };
};

/** Reads every candidate from a stored auth pool. */
export const codexAuthCandidatesFromPool = (value: unknown, source: CodexAuthCandidateSource): readonly CodexAuthCandidate[] => {
  const pool = parseCodexAuthPool(value);
  if (!pool) return [];
  return pool.accounts.map((account) => ({
    source,
    account_id: account.account_id,
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    updated_at_ms: account.updated_at_ms,
  }));
};

/** A stable identity for de-duplicating the same credential seen from several sources. */
export const codexAuthCandidateKey = (candidate: CodexAuthCandidate): string => `${candidate.account_id}\u0000${candidate.access_token}`;
