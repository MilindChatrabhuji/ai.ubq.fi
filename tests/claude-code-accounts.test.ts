import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKv, type Kv } from "#kv";
import { setKvForTest } from "../src/kv.ts";
import {
  CLAUDE_CODE_ACCOUNTS_KEY,
  isClaudeCodeAccountCurrent,
  loadClaudeCodeAccountStore,
  removeClaudeCodeAccount,
  resolveClaudeCodeAccount,
  selectClaudeCodeAccount,
  updateClaudeCodeAccount,
  type ClaudeCodeAccountBinding,
} from "../src/provider/claude-code-accounts.ts";
import {
  CLAUDE_CODE_AUTH_KV_KEY,
  CLAUDE_CODE_WORKSPACE_KV_KEY,
  resetClaudeCodeCredentialCacheForTest,
  resolveClaudeCodeCredential,
} from "../src/provider/claude-code-credentials.ts";
import {
  CLAUDE_CODE_QUOTA_KV_KEY,
  clearClaudeCodeQuotaGuards,
  loadClaudeCodeQuotaState,
  observeClaudeCodeQuota,
  recordClaudeCodeQuotaOutcome,
  registerClaudeCodeObservationRecorder,
  type ClaudeCodeAcceptedObservation,
} from "../src/provider/claude-code-quota.ts";
import { getClaudeCodeProviderHealth, recordClaudeCodeProviderHealth, resetProviderHealthThrottleForTest } from "../src/provider/health.ts";

let kv: Kv;
beforeEach(async () => {
  kv = await openKv(":memory:");
  setKvForTest(kv);
  resetClaudeCodeCredentialCacheForTest();
  resetProviderHealthThrottleForTest();
});
afterEach(() => {
  setKvForTest(null);
  kv.close();
});
const env = (name: string): string | null => (name === "CLAUDE_CODE_OAUTH_TOKEN" ? "sk-ant-oat-fixture-first-account" : null);
const binding = async (): Promise<ClaudeCodeAccountBinding> => {
  const account = await resolveClaudeCodeAccount(kv, env);
  assert(account);
  return account;
};
const observation = (utilization = "0.25", now = Date.now()) =>
  observeClaudeCodeQuota(
    new Headers({
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": utilization,
    }),
    now
  );

test("singleton bootstrap preserves original keys and never attributes the legacy global quota", async () => {
  const credential = { secret: "sk-ant-oat-fixture-singleton", kind: "oauth", hint: "configured", label: "not verified identity", updated_at_ms: 1234 };
  const workspace = { id: "wrkspc_singleton", name: null, source: "kv", discovered_at_ms: null, verified_at_ms: null, last_error: null };
  await kv.set(CLAUDE_CODE_AUTH_KV_KEY, credential);
  await kv.set(CLAUDE_CODE_WORKSPACE_KV_KEY, workspace);
  await kv.set(CLAUDE_CODE_QUOTA_KV_KEY, { windows: {}, updated_at_ms: 1234, blocked_until_ms: Date.now() + 60_000 });
  const account = await binding();
  assert.equal(account.credential.secret, credential.secret);
  assert.equal(account.workspace?.id, workspace.id);
  assert.equal(await loadClaudeCodeQuotaState(kv, account), null);
  assert.deepEqual((await kv.get(CLAUDE_CODE_AUTH_KV_KEY)).value, credential);
  assert.deepEqual((await kv.get(CLAUDE_CODE_WORKSPACE_KV_KEY)).value, workspace);
  assert.equal((await loadClaudeCodeAccountStore(kv)).active_account_id, account.account_id);
});

test("durable identity/cohort and global active survive cache resets and same-binding updates", async () => {
  const first = await binding();
  const second = await updateClaudeCodeAccount(kv, { createNew: true, credential: { ...first.credential, secret: "sk-ant-oat-fixture-second-account" } });
  const edited = await updateClaudeCodeAccount(kv, { accountId: first.account_id, credential: { ...first.credential, label: "renamed locally" } });
  resetClaudeCodeCredentialCacheForTest();
  assert.equal((await binding()).account_id, first.account_id);
  assert.equal(edited.account_cohort_id, first.account_cohort_id);
  assert.equal(edited.evidence_generation, first.evidence_generation);
  assert.notEqual(second.account_cohort_id, first.account_cohort_id);
  assert(await selectClaudeCodeAccount(kv, second.account_id));
  assert.equal((await binding()).account_id, second.account_id);
  assert.equal((await loadClaudeCodeAccountStore(kv)).active_reason, "admin_selection");
});

test("native persistent close/reopen retains account cohort, global active and observed quota", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-account-restart-"));
  let database: Kv | null = null;
  try {
    database = await openKv(join(directory, "fixture.sqlite3"));
    const first = await resolveClaudeCodeAccount(database, env);
    assert(first);
    await recordClaudeCodeQuotaOutcome(database, { binding: first, observation: observation(), served: true });
    database.close();
    database = null;
    resetClaudeCodeCredentialCacheForTest();
    database = await openKv(join(directory, "fixture.sqlite3"));
    const restarted = await resolveClaudeCodeAccount(database, () => null);
    assert(restarted);
    assert.equal(restarted.account_id, first.account_id);
    assert.equal(restarted.account_cohort_id, first.account_cohort_id);
    assert.equal((await loadClaudeCodeQuotaState(database, restarted))?.windows["5h"]?.utilization, 0.25);
  } finally {
    database?.close();
    await rm(directory, { recursive: true });
  }
});

test("removal leaves a durable tombstone instead of resurrecting singleton or environment credentials", async () => {
  await kv.set(CLAUDE_CODE_AUTH_KV_KEY, { secret: "sk-ant-oat-fixture-retained", kind: "oauth", updated_at_ms: 1234 });
  const first = await binding();
  assert(await removeClaudeCodeAccount(kv, first.account_id));
  assert.equal(await resolveClaudeCodeCredential(kv, env), null);
  assert.equal((await loadClaudeCodeAccountStore(kv, env)).accounts.length, 0);
  assert((await kv.get(CLAUDE_CODE_AUTH_KV_KEY)).value, "retained legacy key is not a new import grant");
});

test("malformed existing roster fails closed rather than importing a credential again", async () => {
  await kv.set(CLAUDE_CODE_ACCOUNTS_KEY, { v: 1, accounts: "corrupt" });
  await assert.rejects(() => resolveClaudeCodeAccount(kv, env), /invalid/);
});

test("credential and workspace replacement rotate the persisted cohort and reject late old evidence", async () => {
  const first = await binding();
  await recordClaudeCodeQuotaOutcome(kv, { binding: first, observation: observation(), served: true });
  const second = await updateClaudeCodeAccount(kv, { credential: { ...first.credential, secret: "sk-ant-oat-fixture-rotated" } });
  assert.equal(second.account_id, first.account_id);
  assert.notEqual(second.account_cohort_id, first.account_cohort_id);
  assert.equal(await isClaudeCodeAccountCurrent(kv, first), false);
  assert.equal(
    await recordClaudeCodeQuotaOutcome(kv, { binding: first, observation: observation("1"), exhaustion: { window: "5h", reset_at_ms: Date.now() + 60_000 } }),
    null
  );
  assert.equal(await loadClaudeCodeQuotaState(kv, second), null);
  const third = await updateClaudeCodeAccount(kv, {
    workspace: { id: "wrkspc_new", name: null, source: "kv", discovered_at_ms: null, verified_at_ms: null, last_error: null },
  });
  assert.notEqual(third.account_cohort_id, second.account_cohort_id);
  assert.equal(await loadClaudeCodeQuotaState(kv, third), null);
});

test("a still-valid non-active account may record only its own cohort", async () => {
  const first = await binding();
  const second = await updateClaudeCodeAccount(kv, {
    createNew: true,
    activate: true,
    credential: { ...first.credential, secret: "sk-ant-oat-fixture-other" },
  });
  assert(await isClaudeCodeAccountCurrent(kv, first));
  assert(await recordClaudeCodeQuotaOutcome(kv, { binding: first, observation: observation(), served: true }));
  assert.equal((await loadClaudeCodeQuotaState(kv, first))?.windows["5h"]?.utilization, 0.25);
  assert.equal(await loadClaudeCodeQuotaState(kv, second), null);
});

test("guard clear preserves observed windows but invalidates older in-flight publication", async () => {
  const first = await binding();
  await recordClaudeCodeQuotaOutcome(kv, {
    binding: first,
    observation: observation(),
    config_error: { kind: "workspace_required", status: 400, message: "workspace required" },
  });
  const cleared = await clearClaudeCodeQuotaGuards(kv, first);
  assert.equal(cleared?.cooldown_until_ms, null);
  const current = await binding();
  assert.equal(current.account_cohort_id, first.account_cohort_id);
  assert.notEqual(current.evidence_generation, first.evidence_generation);
  assert.equal(await recordClaudeCodeQuotaOutcome(kv, { binding: first, observation: observation("1"), transient: { retry_after_ms: 5000 } }), null);
  assert.equal((await loadClaudeCodeQuotaState(kv, current))?.windows["5h"]?.utilization, 0.25);
});

test("accepted recorder gets raw missing-window semantics and is never called for empty or rejected evidence", async () => {
  const events: ClaudeCodeAcceptedObservation[] = [];
  const dispose = registerClaudeCodeObservationRecorder((_kv, event) => {
    events.push(event);
    return Promise.resolve();
  });
  try {
    const first = await binding();
    const raw = observation("0.15", 1000);
    await recordClaudeCodeQuotaOutcome(kv, { binding: first, observation: raw, response_status: 200, served: true, nowMs: 2000 });
    assert.equal(events.length, 1);
    const event = events[0];
    assert(event);
    assert.deepEqual(event.observation, raw);
    assert.equal(event.observation.windows["7d"], undefined);
    assert.equal(event.source_observed_at_ms, 1000);
    assert.equal(event.sampled_at_ms, 2000);
    assert.equal(event.credential_kind, "oauth");
    assert.equal(event.state, "available");
    await recordClaudeCodeQuotaOutcome(kv, { binding: first, observation: null, served: true });
    await recordClaudeCodeQuotaOutcome(kv, {
      binding: first,
      observation: { windows: {}, standard: {}, representative_claim: null, observed_at_ms: 3000 },
      served: true,
    });
    await updateClaudeCodeAccount(kv, { credential: { ...first.credential, secret: "sk-ant-oat-fixture-replaced" } });
    await recordClaudeCodeQuotaOutcome(kv, { binding: first, observation: observation() });
    assert.equal(events.length, 1);
  } finally {
    dispose();
  }
});

test("concurrent accepted observations preserve independent window families under real KV CAS", async () => {
  const account = await binding();
  const weekly = observeClaudeCodeQuota(new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.1" }));
  await Promise.all([
    recordClaudeCodeQuotaOutcome(kv, { binding: account, observation: observation(), served: true }),
    recordClaudeCodeQuotaOutcome(kv, { binding: account, observation: weekly, served: true }),
  ]);
  const quota = await loadClaudeCodeQuotaState(kv, account);
  assert(quota);
  assert.equal(quota.windows["5h"]?.utilization, 0.25);
  assert.equal(quota.windows["7d"]?.utilization, 0.1);
});

test("health cannot cross credential replacement or a guarded clear generation", async () => {
  const first = await binding();
  await recordClaudeCodeProviderHealth("success", 200, Date.now, "req_first", first);
  assert.equal((await getClaudeCodeProviderHealth(Date.now, first)).state, "healthy");
  const second = await updateClaudeCodeAccount(kv, { credential: { ...first.credential, secret: "sk-ant-oat-fixture-health-replaced" } });
  await recordClaudeCodeProviderHealth("auth_invalid", 401, Date.now, "req_late", first);
  assert.equal((await getClaudeCodeProviderHealth(Date.now, second)).state, "unknown");
  await clearClaudeCodeQuotaGuards(kv, second);
  await recordClaudeCodeProviderHealth("upstream_error", 503, Date.now, "req_late_clear", second);
  assert.equal((await getClaudeCodeProviderHealth(Date.now, await binding())).state, "unknown");
});
