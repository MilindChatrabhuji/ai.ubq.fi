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
import { loadClaudeCodeAccessPolicy, storeClaudeCodeAccessPolicy } from "../src/provider/claude-code-access.ts";
import { attemptClaudeCodeSubscription } from "../src/paid-fallback/claude-code-route.ts";
import { claudeCodePoolProofForModel } from "../src/provider/claude-code-quota.ts";
import { resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { resetClaudeCodeModelsCacheForTest } from "../src/provider/claude-code-models.ts";
import { rememberAnthropicReplay } from "../src/provider/anthropic-replay.ts";

let kv: Kv;
beforeEach(async () => {
  kv = await openKv(":memory:");
  setKvForTest(kv);
  resetClaudeCodeCredentialCacheForTest();
  resetProviderHealthThrottleForTest();
  resetProviderSelectionCacheForTest();
  resetClaudeCodeModelsCacheForTest();
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

test("a pristine passive read stays unpersisted and allows later intentional first environment bootstrap", async () => {
  assert.equal(await resolveClaudeCodeAccount(kv, () => null), null);
  assert.deepEqual((await loadClaudeCodeAccountStore(kv, () => null)).accounts, []);
  assert.equal((await kv.get(CLAUDE_CODE_ACCOUNTS_KEY)).value, null);
  const first = await resolveClaudeCodeAccount(kv, env);
  assert(first);
  assert.equal(first.credential.secret, env("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.equal((await loadClaudeCodeAccountStore(kv)).active_account_id, first.account_id);
});

test("targeted missing-account deletion leaves pristine state untouched while explicit clear persists a tombstone", async () => {
  assert.equal(await removeClaudeCodeAccount(kv, "nonexistent-account"), false);
  assert.equal((await kv.get(CLAUDE_CODE_ACCOUNTS_KEY)).value, null);
  assert.equal(await removeClaudeCodeAccount(kv), false);
  assert.deepEqual((await loadClaudeCodeAccountStore(kv, env)).accounts, []);
  assert.notEqual((await kv.get(CLAUDE_CODE_ACCOUNTS_KEY)).value, null);
  resetClaudeCodeCredentialCacheForTest();
  assert.equal(await resolveClaudeCodeAccount(kv, env), null);
});

test("an explicit first credential import creates the absent roster through native CAS", async () => {
  const imported = await updateClaudeCodeAccount(kv, {
    credential: {
      secret: "sk-ant-oat-fixture-first-import",
      kind: "oauth",
      source: "kv",
      hint: "fixture import",
      label: "unverified fixture label",
      updated_at_ms: Date.now(),
    },
  });
  const store = await loadClaudeCodeAccountStore(kv);
  assert.equal(store.accounts.length, 1);
  assert.equal(store.active_account_id, imported.account_id);
  assert.equal(store.active_reason, "first_configured");
});

test("concurrent native first bootstrap and explicit deletion always settle to the durable tombstone", async () => {
  const [bootstrapped] = await Promise.all([resolveClaudeCodeAccount(kv, env), removeClaudeCodeAccount(kv)]);
  const store = await loadClaudeCodeAccountStore(kv, env);
  assert.deepEqual(store.accounts, []);
  assert.equal(store.active_account_id, null);
  assert.equal(await resolveClaudeCodeAccount(kv, env), null);
  if (bootstrapped) assert.equal(await isClaudeCodeAccountCurrent(kv, bootstrapped), false);
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

test("actual credential invalidity keeps nonempty header history unavailable without inventing missing windows", async () => {
  const events: ClaudeCodeAcceptedObservation[] = [];
  const dispose = registerClaudeCodeObservationRecorder((_kv, event) => {
    events.push(event);
    return Promise.resolve();
  });
  try {
    const account = await binding();
    await recordClaudeCodeQuotaOutcome(kv, { binding: account, observation: observation(), model_id: routeModel, response_status: 401, auth_invalid: true });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.state, "unavailable");
    assert.equal(events[0]?.response_status, 401);
    assert.equal(events[0]?.observation.windows["7d"], undefined);
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

test("a rejected history writer cannot turn a committed quota outcome into failure", async () => {
  const account = await binding();
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const dispose = registerClaudeCodeObservationRecorder(() => Promise.reject(new Error("private failure details must not be logged")));
  try {
    assert(await recordClaudeCodeQuotaOutcome(kv, { binding: account, observation: observation(), served: true }));
    assert.equal((await loadClaudeCodeQuotaState(kv, account))?.windows["5h"]?.utilization, 0.25);
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes("private failure details"), false);
  } finally {
    dispose();
    console.warn = warn;
  }
});

test("principal policy seeds exactly the explicit environment and empty stored deny survives restart and account import", async () => {
  const seeded = await loadClaudeCodeAccessPolicy(kv, (name) => (name === "CLAUDE_CODE_ALLOWED_KEY_IDS" ? "owner-a, owner-b" : null));
  assert.deepEqual(seeded.allowed_key_ids, ["owner-a", "owner-b"]);
  assert.equal(seeded.source, "env");
  await storeClaudeCodeAccessPolicy(kv, []);
  await binding();
  resetClaudeCodeCredentialCacheForTest();
  const explicit = await loadClaudeCodeAccessPolicy(kv, () => "new-unapproved-principal");
  assert.equal(explicit.source, "kv");
  assert.deepEqual(explicit.allowed_key_ids, []);
});

test("new duplicate credential/workspace entries cannot impersonate separate capacity", async () => {
  const account = await binding();
  await assert.rejects(() => updateClaudeCodeAccount(kv, { createNew: true, credential: account.credential }), /already configured/);
  assert.equal((await loadClaudeCodeAccountStore(kv)).accounts.length, 1);
});

const routeModel = "claude-fixture-model";
const routeEnv = (name: string): string | null => (name === "CLAUDE_CODE_ALLOWED_KEY_IDS" ? "fixture-owner" : env(name));
const route = (fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, model = routeModel) =>
  attemptClaudeCodeSubscription(
    { model, input: "fixture only", stream: false },
    { model, usageContext: { keyId: "fixture-owner", kernelRepo: null, kernelOrg: null }, env: routeEnv, fetcher }
  );
const success = (model = routeModel): Response =>
  Response.json({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "FIXTURE_OK" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 1 },
  });
const exhausted = (): Response =>
  Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "fixture quota exhausted" } },
    {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-5h-status": "limited",
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    }
  );
const secondAccount = async (first: ClaudeCodeAccountBinding) =>
  await updateClaudeCodeAccount(kv, { createNew: true, credential: { ...first.credential, secret: "sk-ant-oat-fixture-second" } });

test("authoritative exhaustion switches the global active once and shares one admission lifetime", async () => {
  const first = await binding();
  const second = await secondAccount(first);
  const seen: string[] = [];
  let claims = 0;
  let transportStarts = 0;
  const result = await attemptClaudeCodeSubscription(
    { model: routeModel, input: "fixture", stream: false },
    {
      model: routeModel,
      env: routeEnv,
      usageContext: {
        keyId: "fixture-owner",
        kernelRepo: null,
        kernelOrg: null,
        beforeProviderDispatch: () => {
          claims++;
          return Promise.resolve({
            markTransportStarted: () => {
              transportStarts++;
            },
            cancelBeforeTransport: () => Promise.resolve(),
          });
        },
      },
      fetcher: (_input, init) => {
        const bearer = new Headers(init?.headers).get("authorization") ?? "missing";
        seen.push(bearer);
        return Promise.resolve(bearer === `Bearer ${first.credential.secret}` ? exhausted() : success());
      },
    }
  );
  assert.equal(result?.response.status, 200);
  await result.response.body?.cancel();
  assert.equal(claims, 1);
  assert.equal(transportStarts, 1);
  assert.equal(seen.length, 2);
  assert.equal((await binding()).account_id, second.account_id);
  assert.equal((await loadClaudeCodeAccountStore(kv)).active_reason, "authoritative_unavailability");
  resetClaudeCodeCredentialCacheForTest();
  assert.equal((await binding()).account_id, second.account_id, "headroom and cache reset never restore the retired active");
});

test("only fresh strong proof for every selected account permits paid continuation", async () => {
  const first = await binding();
  await secondAccount(first);
  let calls = 0;
  assert.equal(
    await route(() => {
      calls++;
      return Promise.resolve(exhausted());
    }),
    null
  );
  assert.equal(calls, 2);
  assert.equal(
    await route(() => {
      calls++;
      return Promise.resolve(success());
    }),
    null
  );
  assert.equal(calls, 2, "fresh exact-model full-pool proof avoids another subscription call");
});

test("an exhausted plus transient pool retains the original failure and never claims exhaustion", async () => {
  const first = await binding();
  const second = await secondAccount(first);
  const failure = { type: "error", error: { type: "overloaded_error", message: "fixture transient, not capacity" } };
  const result = await route((_input, init) =>
    Promise.resolve(
      new Headers(init?.headers).get("authorization") === `Bearer ${first.credential.secret}` ? exhausted() : Response.json(failure, { status: 503 })
    )
  );
  assert(result, "null would authorize paid continuation");
  assert.equal(result.response.status, 503);
  assert.deepEqual(
    await result.response.json(),
    { error: { ...failure.error, code: "overloaded_error" } },
    "the existing OpenAI error normalization preserves the original status, message and classification"
  );
  assert.equal((await binding()).account_id, second.account_id);
  assert.equal(claudeCodePoolProofForModel(await loadClaudeCodeQuotaState(kv, second), second, routeModel), null);
});

test("unknown/transient active state cannot switch to an otherwise available second account", async () => {
  const first = await binding();
  await secondAccount(first);
  let calls = 0;
  const result = await route(() => {
    calls++;
    return Promise.resolve(Response.json({ error: { type: "overloaded_error", message: "fixture busy" } }, { status: 503 }));
  });
  assert.equal(result?.response.status, 503);
  await result.response.body?.cancel();
  assert.equal(calls, 1);
  assert.equal((await binding()).account_id, first.account_id);
});

test("a transport failure never switches active or authorizes paid continuation", async () => {
  const first = await binding();
  await secondAccount(first);
  const failed = await route(() => Promise.reject(new TypeError("fixture disconnected")));
  assert(failed);
  assert.equal(failed.response.status, 502);
  assert.equal((await failed.response.json()).error.code, "claude_code_upstream_unreachable");
  assert.equal((await binding()).account_id, first.account_id);
});

test("quota proof is exact-model and expires at its recorded reset boundary", async () => {
  const first = await binding();
  await secondAccount(first);
  const now = Date.now();
  await recordClaudeCodeQuotaOutcome(kv, {
    binding: first,
    model_id: routeModel,
    observation: observation("1", now),
    exhaustion: { window: "5h", reset_at_ms: now + 60_000 },
    response_status: 429,
    nowMs: now,
  });
  const state = await loadClaudeCodeQuotaState(kv, first);
  assert(claudeCodePoolProofForModel(state, first, routeModel, now));
  assert.equal(claudeCodePoolProofForModel(state, first, "claude-different", now), null);
  assert.equal(claudeCodePoolProofForModel(state, first, routeModel, now + 600_000), null);
  const result = await route(() => Promise.resolve(success("claude-different")), "claude-different");
  assert.equal(result?.response.status, 200);
  await result.response.body?.cancel();
  assert.equal((await binding()).account_id, first.account_id);
});

test("success invalidates current exact-model/credential proof but not a newer rejection", async () => {
  const account = await binding();
  const now = Date.now();
  await recordClaudeCodeQuotaOutcome(kv, {
    binding: account,
    model_id: routeModel,
    observation: observation("1"),
    auth_invalid: true,
    response_observed_at_ms: now,
  });
  assert(claudeCodePoolProofForModel(await loadClaudeCodeQuotaState(kv, account), account, routeModel));
  await recordClaudeCodeQuotaOutcome(kv, { binding: account, model_id: routeModel, observation: null, served: true, response_observed_at_ms: now - 1000 });
  assert(claudeCodePoolProofForModel(await loadClaudeCodeQuotaState(kv, account), account, routeModel));
  await recordClaudeCodeQuotaOutcome(kv, { binding: account, model_id: routeModel, observation: null, served: true, response_observed_at_ms: now + 1000 });
  assert.equal(claudeCodePoolProofForModel(await loadClaudeCodeQuotaState(kv, account), account, routeModel), null);
});

test("stored principal deny remains authoritative across an otherwise successful configured pool", async () => {
  await binding();
  await storeClaudeCodeAccessPolicy(kv, []);
  let calls = 0;
  assert.equal(
    await route(() => {
      calls++;
      return Promise.resolve(success());
    }),
    null
  );
  assert.equal(calls, 0);
  assert.deepEqual((await loadClaudeCodeAccessPolicy(kv, routeEnv)).allowed_key_ids, []);
});

test("principal revocation during admission cancels before transport and cannot become provider exhaustion", async () => {
  const account = await binding();
  let transports = 0;
  let cancellations = 0;
  const revoked = await attemptClaudeCodeSubscription(
    { model: routeModel, input: "fixture", stream: false },
    {
      model: routeModel,
      env: routeEnv,
      usageContext: {
        keyId: "fixture-owner",
        kernelRepo: null,
        kernelOrg: null,
        beforeProviderDispatch: async () => {
          await storeClaudeCodeAccessPolicy(kv, []);
          return {
            markTransportStarted: () => {
              transports++;
            },
            cancelBeforeTransport: () => {
              cancellations++;
              return Promise.resolve();
            },
          };
        },
      },
      fetcher: () => {
        transports++;
        return Promise.resolve(success());
      },
    }
  );
  assert(revoked);
  assert.equal(revoked.response.status, 403);
  assert.equal((await revoked.response.json()).error.code, "claude_code_request_invalid");
  assert.equal(transports, 0);
  assert.equal(cancellations, 1);
  assert.equal(claudeCodePoolProofForModel(await loadClaudeCodeQuotaState(kv, account), account, routeModel), null);
  assert.equal((await getClaudeCodeProviderHealth(Date.now, account)).state, "unknown");
});

test("native reasoning replay cannot cross account credential/workspace cohorts", async () => {
  const account = await binding();
  const id = crypto.randomUUID();
  const output = [
    {
      type: "message",
      id: `msg_resp_${id}_0`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "fixture reply", annotations: [] }],
    },
  ];
  assert(
    rememberAnthropicReplay({
      scope: `fixture-owner:${account.account_id}:${account.account_cohort_id}`,
      provider: "claude_code",
      model: routeModel,
      output,
      nativeBlocks: [
        { type: "thinking", thinking: "fixture private reasoning", signature: "fixture signature" },
        { type: "text", text: "fixture reply" },
      ],
    })
  );
  const body = { model: routeModel, stream: false, input: [{ role: "user", content: "fixture first" }, ...output, { role: "user", content: "fixture next" }] };
  let transports = 0;
  const fetcher = () => {
    transports++;
    return Promise.resolve(success());
  };
  const options = { model: routeModel, env: routeEnv, usageContext: { keyId: "fixture-owner", kernelRepo: null, kernelOrg: null }, fetcher };
  const same = await attemptClaudeCodeSubscription(body, options);
  assert.equal(same?.response.status, 200);
  await same.response.body?.cancel();
  assert.equal(transports, 1);
  await updateClaudeCodeAccount(kv, { credential: { ...account.credential, secret: "sk-ant-oat-fixture-replay-replacement" } });
  const changed = await attemptClaudeCodeSubscription(body, options);
  assert.equal(changed?.response.status, 400);
  assert.equal((await changed.response.json()).error.code, "claude_code_request_invalid");
  assert.equal(transports, 1, "no signature is replayed under the replacement credential");
});
