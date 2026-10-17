import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyCodexAuthPlan,
  type AssessedCodexAuthCandidate,
  type CodexAuthCandidate,
  codexAuthCandidateFromAuthJson,
  codexAuthCandidateKey,
  codexAuthCandidatesFromPool,
  isCodexAuthCandidateUsable,
  planCodexAuthRepair,
  rankCodexAuthCandidates,
} from "../src/codex/auth-repair.ts";
import { accountAction, anyCodexAuthSlotNeedsRepair, reportStatus } from "../scripts/codex-auth-repair.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";

const NOW_MS = Date.UTC(2026, 8, 16, 18, 0, 0);

/** Drops base64url `=` padding without a backtracking-prone trailing regex. */
const stripBase64Padding = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "=") end -= 1;
  return value.slice(0, end);
};

/** Builds a three-part token whose payload carries the requested `exp` claim. */
const tokenExpiringAt = (expMs: number | null): string => {
  const encode = (value: unknown): string => {
    const base64 = btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_");
    return stripBase64Padding(base64);
  };
  const payload = expMs === null ? {} : { exp: Math.floor(expMs / 1000) };
  return `header.${encode(payload)}.signature`;
};

const account = (accountId: string, expMs: number | null, refresh = `refresh-${accountId}`): CodexAuthState => ({
  account_id: accountId,
  access_token: tokenExpiringAt(expMs),
  refresh_token: refresh,
  updated_at_ms: NOW_MS - 60_000,
});

const poolOf = (accounts: readonly CodexAuthState[]): CodexAuthPoolState => ({ accounts, updated_at_ms: NOW_MS - 60_000 });

const candidate = (
  source: CodexAuthCandidate["source"],
  accountId: string,
  expMs: number | null,
  options: Readonly<{ refresh?: string; updated_at_ms?: number | null }> = {}
): CodexAuthCandidate => ({
  source,
  account_id: accountId,
  access_token: tokenExpiringAt(expMs),
  refresh_token: options.refresh ?? `refresh-${accountId}`,
  updated_at_ms: options.updated_at_ms === undefined ? NOW_MS : options.updated_at_ms,
});

const assessed = (value: CodexAuthCandidate, probe: AssessedCodexAuthCandidate["probe"]): AssessedCodexAuthCandidate => ({
  candidate: value,
  access_exp_ms: expFromToken(value.access_token),
  probe,
});

const expFromToken = (token: string): number | null => {
  const part = token.split(".")[1] ?? "";
  if (!part) return null;
  try {
    const parsed = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
};

const valid = (status = 200): AssessedCodexAuthCandidate["probe"] => ({ outcome: "valid", status });
const invalid = (status = 401): AssessedCodexAuthCandidate["probe"] => ({ outcome: "invalid", status });
const inconclusive = (status: number | null = null): AssessedCodexAuthCandidate["probe"] => ({ outcome: "inconclusive", status });

const localAccount = (slot: number, value: CodexAuthState, probe: AssessedCodexAuthCandidate["probe"], refreshDiverged: boolean | null = null) => ({
  slot,
  account: value,
  probe,
  refresh_diverged: refreshDiverged,
});

test("isCodexAuthCandidateUsable requires an accepted token that has not expired", () => {
  const live = candidate("vps-pool", "acct-a", NOW_MS + 3_600_000);
  assert.equal(isCodexAuthCandidateUsable(assessed(live, valid()), NOW_MS), true);
  assert.equal(isCodexAuthCandidateUsable(assessed(live, valid(429)), NOW_MS), true);
  assert.equal(isCodexAuthCandidateUsable(assessed(live, invalid()), NOW_MS), false);
  assert.equal(isCodexAuthCandidateUsable(assessed(live, inconclusive()), NOW_MS), false);

  // A token the upstream still accepts can be seconds from expiry; the claim is
  // checked on its own so a stale credential is never adopted.
  const expired = candidate("vps-pool", "acct-a", NOW_MS - 1);
  assert.equal(isCodexAuthCandidateUsable(assessed(expired, valid()), NOW_MS), false);
});

test("rankCodexAuthCandidates prefers the longest-lived credential and drops unusable ones", () => {
  const shortLived = assessed(candidate("vps-pool", "acct-a", NOW_MS + 60_000), valid());
  const longLived = assessed(candidate("local-auth-json", "acct-a", NOW_MS + 86_400_000), valid());
  const rejected = assessed(candidate("vps-auth-json", "acct-a", NOW_MS + 172_800_000), invalid());

  const ranked = rankCodexAuthCandidates([shortLived, longLived, rejected], NOW_MS);
  assert.deepEqual(
    ranked.map((entry) => entry.candidate.source),
    ["local-auth-json", "vps-pool"]
  );
});

test("rankCodexAuthCandidates breaks expiry ties by freshness and then by source order", () => {
  const expMs = NOW_MS + 3_600_000;
  const stale = candidate("vps-auth-json", "acct-a", expMs, { updated_at_ms: NOW_MS - 90_000 });
  const fresh = candidate("vps-pool", "acct-a", expMs, { updated_at_ms: NOW_MS - 1_000 });
  const untimed = candidate("vps-pool", "acct-b", expMs, { updated_at_ms: null });

  const ranked = rankCodexAuthCandidates([assessed(stale, valid()), assessed(fresh, valid()), assessed(untimed, valid())], NOW_MS);
  assert.deepEqual(
    ranked.map((entry) => entry.candidate.updated_at_ms),
    [NOW_MS - 1_000, NOW_MS - 90_000, null]
  );

  const sameExpirySameFreshness = [
    assessed(candidate("vps-auth-json", "acct-a", expMs), valid()),
    assessed(candidate("local-auth-json", "acct-a", expMs), valid()),
  ];
  assert.deepEqual(
    rankCodexAuthCandidates(sameExpirySameFreshness, NOW_MS).map((entry) => entry.candidate.source),
    ["local-auth-json", "vps-auth-json"]
  );
});

test("planCodexAuthRepair leaves an authenticating account untouched", () => {
  const local = account("acct-a", NOW_MS + 3_600_000);
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, local, valid())],
    candidates: [assessed(candidate("vps-pool", "acct-a", NOW_MS + 86_400_000), valid())],
    nowMs: NOW_MS,
  });

  assert.equal(plan.selections.length, 0);
  assert.equal(plan.unrepairable.length, 0);
  assert.deepEqual(plan.healthy, [{ slot: 1, account_id: "acct-a", refresh_diverged: null }]);
});

test("planCodexAuthRepair treats a probe-valid but already expired local token as broken", () => {
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, account("acct-a", NOW_MS - 1_000), valid())],
    candidates: [assessed(candidate("vps-pool", "acct-a", NOW_MS + 3_600_000), valid())],
    nowMs: NOW_MS,
  });

  assert.equal(plan.healthy.length, 0);
  assert.equal(plan.selections.length, 1);
  assert.equal(plan.selections[0].candidate.source, "vps-pool");
});

test("planCodexAuthRepair preserves an unexpired slot whose probe was inconclusive", () => {
  // A timeout and a 403/5xx are all undecidable: none of them is evidence that
  // the credential is unusable, so a valid candidate must not be adopted.
  const undecidableProbes: AssessedCodexAuthCandidate["probe"][] = [inconclusive(null), inconclusive(403), inconclusive(503)];
  for (const probe of undecidableProbes) {
    const pool = poolOf([account("acct-a", NOW_MS + 3_600_000)]);
    const plan = planCodexAuthRepair({
      accounts: [localAccount(1, pool.accounts[0], probe)],
      candidates: [assessed(candidate("vps-pool", "acct-a", NOW_MS + 86_400_000), valid())],
      nowMs: NOW_MS,
    });

    assert.deepEqual(plan.selections, []);
    assert.deepEqual(plan.unrepairable, []);
    assert.deepEqual(plan.healthy, []);
    assert.deepEqual(plan.inconclusive, [{ slot: 1, account_id: "acct-a", probe, refresh_diverged: null }]);

    const applied = applyCodexAuthPlan(pool, plan, NOW_MS);
    assert.ok(applied);
    assert.deepEqual(applied.accounts, pool.accounts);
    assert.equal(applied.accounts[0].access_token, pool.accounts[0].access_token);
  }
});

test("planCodexAuthRepair repairs a slot whose access token has verifiably expired even when the probe was inconclusive", () => {
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, account("acct-a", NOW_MS - 1_000), inconclusive(503))],
    candidates: [assessed(candidate("vps-pool", "acct-a", NOW_MS + 3_600_000), valid())],
    nowMs: NOW_MS,
  });

  assert.deepEqual(plan.inconclusive, []);
  assert.equal(plan.selections.length, 1);
  assert.equal(plan.selections[0].candidate.source, "vps-pool");
});

test("the repair CLI renders an inconclusive slot as inconclusive and never probes sources for it", () => {
  const pool = poolOf([account("acct-a", NOW_MS + 3_600_000)]);
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, pool.accounts[0], inconclusive(403))],
    candidates: [assessed(candidate("vps-pool", "acct-a", NOW_MS + 86_400_000), valid())],
    nowMs: NOW_MS,
  });

  // The run cannot certify the pool, so it must not report health, and the row
  // must name the undecidable state instead of calling it kept.
  assert.equal(reportStatus(plan, false), "inconclusive");
  assert.equal(accountAction(undefined, undefined, plan.inconclusive[0], false), "inconclusive");
  assert.equal(reportStatus(planCodexAuthRepair({ accounts: [localAccount(1, pool.accounts[0], valid())], candidates: [], nowMs: NOW_MS }), false), "healthy");

  // SSH and candidate probes are paid only for a real repair need: neither an
  // unexpired inconclusive slot nor a 5xx may trigger them, while a rejected or
  // verifiably expired slot still does.
  const undecidable = [
    { account: account("acct-a", NOW_MS + 3_600_000), probe: inconclusive(null) },
    { account: account("acct-b", NOW_MS + 3_600_000), probe: inconclusive(503) },
  ];
  assert.equal(anyCodexAuthSlotNeedsRepair(undecidable, NOW_MS), false);
  assert.equal(anyCodexAuthSlotNeedsRepair([{ account: account("acct-a", NOW_MS + 3_600_000), probe: invalid() }], NOW_MS), true);
  assert.equal(anyCodexAuthSlotNeedsRepair([{ account: account("acct-b", NOW_MS - 1_000), probe: inconclusive(null) }], NOW_MS), true);
});

test("planCodexAuthRepair repairs a rejected slot from the best candidate for that account", () => {
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, account("acct-a", NOW_MS + 3_600_000), invalid())],
    candidates: [
      assessed(candidate("local-auth-json", "acct-a", NOW_MS + 60_000), valid()),
      assessed(candidate("vps-pool", "acct-a", NOW_MS + 86_400_000), valid()),
      assessed(candidate("vps-auth-json", "acct-a", NOW_MS + 172_800_000), invalid()),
    ],
    nowMs: NOW_MS,
  });

  assert.equal(plan.selections.length, 1);
  assert.equal(plan.selections[0].slot, 1);
  assert.equal(plan.selections[0].account_id, "acct-a");
  assert.equal(plan.selections[0].candidate.source, "vps-pool");
  assert.deepEqual(
    plan.selections[0].rejected.map((entry) => `${entry.source}:${entry.outcome}`),
    ["local-auth-json:valid", "vps-auth-json:invalid"]
  );
});

test("planCodexAuthRepair never adopts another account's credential", () => {
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, account("acct-a", NOW_MS + 3_600_000), invalid())],
    candidates: [assessed(candidate("vps-pool", "acct-b", NOW_MS + 86_400_000), valid())],
    nowMs: NOW_MS,
  });

  assert.equal(plan.selections.length, 0);
  assert.equal(plan.unrepairable.length, 1);
  assert.equal(plan.unrepairable[0].reason, "no_candidates");
});

test("planCodexAuthRepair reports a blocked account when no candidate authenticates", () => {
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, account("acct-a", NOW_MS + 3_600_000), invalid())],
    candidates: [
      assessed(candidate("vps-pool", "acct-a", NOW_MS + 86_400_000), invalid()),
      assessed(candidate("vps-auth-json", "acct-a", NOW_MS + 3_600_000), inconclusive()),
    ],
    nowMs: NOW_MS,
  });

  assert.equal(plan.selections.length, 0);
  assert.equal(plan.unrepairable[0].reason, "no_valid_candidate");
  assert.deepEqual(
    plan.unrepairable[0].rejected.map((entry) => `${entry.source}:${entry.outcome}`),
    ["vps-pool:invalid", "vps-auth-json:inconclusive"]
  );
});

test("planCodexAuthRepair decides each slot independently", () => {
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, account("acct-a", NOW_MS + 3_600_000), valid(), true), localAccount(2, account("acct-b", NOW_MS + 3_600_000), invalid())],
    candidates: [
      assessed(candidate("vps-pool", "acct-a", NOW_MS + 86_400_000, { refresh: "other" }), valid()),
      assessed(candidate("vps-pool", "acct-b", NOW_MS + 86_400_000), valid()),
    ],
    nowMs: NOW_MS,
  });

  assert.deepEqual(
    plan.selections.map((entry) => entry.slot),
    [2]
  );
  assert.deepEqual(plan.healthy, [{ slot: 1, account_id: "acct-a", refresh_diverged: true }]);
});

test("applyCodexAuthPlan replaces only the affected account and preserves the rest", () => {
  const untouched = account("acct-a", NOW_MS + 3_600_000);
  const broken = account("acct-b", NOW_MS + 3_600_000);
  const pool = poolOf([untouched, broken]);
  const replacement = candidate("vps-pool", "acct-b", NOW_MS + 86_400_000, { refresh: "refresh-from-vps" });
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, untouched, valid()), localAccount(2, broken, invalid())],
    candidates: [assessed(replacement, valid())],
    nowMs: NOW_MS,
  });

  const applied = applyCodexAuthPlan(pool, plan, NOW_MS);
  assert.ok(applied);
  assert.equal(applied.accounts.length, 2);
  assert.equal(applied.accounts[0].access_token, untouched.access_token);
  assert.equal(applied.accounts[0].refresh_token, untouched.refresh_token);
  assert.deepEqual(
    applied.accounts.map((entry) => entry.account_id),
    ["acct-a", "acct-b"]
  );
  assert.equal(applied.accounts[1].access_token, replacement.access_token);
  assert.equal(applied.accounts[1].refresh_token, "refresh-from-vps");
  assert.equal(applied.accounts[1].updated_at_ms, NOW_MS);

  // The stored pool is replaced by a new value; the caller holds the old shape.
  assert.notEqual(applied, pool);
  assert.equal(pool.accounts[1].access_token, broken.access_token);
});

test("applyCodexAuthPlan refuses a candidate that expires during assessment", () => {
  const untouched = account("acct-a", NOW_MS + 3_600_000);
  const broken = account("acct-b", NOW_MS + 3_600_000);
  const pool = poolOf([untouched, broken]);
  const replacement = candidate("vps-pool", "acct-b", NOW_MS + 1_000, { refresh: "refresh-from-vps" });
  const plan = planCodexAuthRepair({
    accounts: [localAccount(1, untouched, valid()), localAccount(2, broken, invalid())],
    candidates: [assessed(replacement, valid())],
    nowMs: NOW_MS,
  });

  assert.equal(plan.selections.length, 1);
  assert.equal(applyCodexAuthPlan(pool, plan, NOW_MS + 1_000), null);
  assert.equal(pool.accounts[1].access_token, broken.access_token);
});

test("applyCodexAuthPlan with an empty plan returns an equivalent pool", () => {
  const pool = poolOf([account("acct-a", NOW_MS + 3_600_000)]);
  const plan = planCodexAuthRepair({ accounts: [localAccount(1, pool.accounts[0], valid())], candidates: [], nowMs: NOW_MS });
  const applied = applyCodexAuthPlan(pool, plan, NOW_MS);
  assert.ok(applied);
  assert.deepEqual(applied.accounts, pool.accounts);
});

test("codexAuthCandidateFromAuthJson accepts a real auth.json shape and rejects junk", () => {
  const parsed = codexAuthCandidateFromAuthJson(
    {
      auth_mode: "chatgpt",
      tokens: {
        access_token: tokenExpiringAt(NOW_MS + 3_600_000),
        refresh_token: "refresh-a",
        account_id: "acct-a",
      },
      last_refresh: "2026-09-12T21:16:41.259598Z",
    },
    "vps-auth-json",
    NOW_MS
  );
  assert.ok(parsed);
  assert.equal(parsed.account_id, "acct-a");
  assert.equal(parsed.refresh_token, "refresh-a");
  assert.equal(parsed.updated_at_ms, NOW_MS);

  assert.equal(codexAuthCandidateFromAuthJson({ tokens: {} }, "vps-auth-json", null), null);
  assert.equal(codexAuthCandidateFromAuthJson(null, "vps-auth-json", null), null);
  assert.equal(codexAuthCandidateFromAuthJson({ tokens: { access_token: "a", refresh_token: "b" } }, "vps-auth-json", null), null);
});

test("codexAuthCandidatesFromPool reads every stored account and rejects malformed pools", () => {
  const pool = poolOf([account("acct-a", NOW_MS + 3_600_000), account("acct-b", NOW_MS + 7_200_000)]);
  const candidates = codexAuthCandidatesFromPool(pool, "vps-pool");
  assert.deepEqual(
    candidates.map((entry) => `${entry.source}:${entry.account_id}`),
    ["vps-pool:acct-a", "vps-pool:acct-b"]
  );

  assert.deepEqual(codexAuthCandidatesFromPool(null, "vps-pool"), []);
  assert.deepEqual(codexAuthCandidatesFromPool({ accounts: [] }, "vps-pool"), []);
  assert.deepEqual(codexAuthCandidatesFromPool({ accounts: [{ account_id: "only-an-id" }], updated_at_ms: NOW_MS }, "vps-pool"), []);
});

test("codexAuthCandidateKey deduplicates the same credential seen from two sources", () => {
  const first = candidate("local-auth-json", "acct-a", NOW_MS + 3_600_000);
  const second = { ...first, source: "vps-pool" as const };
  const other = candidate("vps-pool", "acct-a", NOW_MS + 7_200_000);
  assert.equal(codexAuthCandidateKey(first), codexAuthCandidateKey(second));
  assert.notEqual(codexAuthCandidateKey(first), codexAuthCandidateKey(other));
});
