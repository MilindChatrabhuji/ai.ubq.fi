import type { Kv, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { CLAUDE_CODE_ACCOUNTS_KEY } from "../src/provider/claude-code-accounts.ts";
import {
  buildClaudeCodeRequest,
  CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS,
  CLAUDE_CODE_OAUTH_BETA,
  CLAUDE_CODE_SYSTEM_ATTRIBUTION,
  classifyClaudeCodeErrorBody,
  classifyClaudeCodeResponse,
  claudeCodeCredentialKind,
  claudeCodeRequestHeaders,
  parseClaudeCodeAllowedKeyIds,
  readClaudeCodeAllowedKeyIds,
  resolveClaudeCodeEligibility,
} from "../src/provider/claude-code.ts";
import {
  CLAUDE_CODE_AUTH_KV_KEY,
  CLAUDE_CODE_CREDENTIAL_CACHE_TTL_MS,
  CLAUDE_CODE_WORKSPACE_KV_KEY,
  clearClaudeCodeStoredCredential,
  loadClaudeCodeStoredCredential,
  loadClaudeCodeWorkspaceState,
  mergeClaudeCodeWorkspaceState,
  parseClaudeCodeWorkspaceId,
  partialClaudeCodeCredentialHint,
  readClaudeCodeEnvCredential,
  resetClaudeCodeCredentialCacheForTest,
  resolveClaudeCodeCredential,
  resolveClaudeCodeWorkspace,
  storeClaudeCodeStoredCredential,
  storeClaudeCodeWorkspaceState,
} from "../src/provider/claude-code-credentials.ts";
import {
  CLAUDE_CODE_CONFIG_COOLDOWN_MS,
  CLAUDE_CODE_MIN_BLOCK_MS,
  CLAUDE_CODE_QUOTA_KV_KEY,
  CLAUDE_CODE_RESET_MARGIN_MS,
  CLAUDE_CODE_TRANSIENT_COOLDOWN_MS,
  claudeCodeQuotaBlocked,
  claudeCodeQuotaCoolingDown,
  clearClaudeCodeQuotaGuards,
  loadClaudeCodeQuotaState,
  mergeClaudeCodeQuotaState,
  observeClaudeCodeQuota,
  parseClaudeCodeQuotaState,
  recordClaudeCodeQuotaOutcome,
} from "../src/provider/claude-code-quota.ts";

const keyOf = (key: KvKey): string => JSON.stringify(key);

/** Minimal Kv stand-in for the keys this tier reads and writes. */
class QuotaKv {
  readonly values = new Map<string, unknown>();
  failWrites = false;

  atomic() {
    const writes: (() => void)[] = [];
    const operation = {
      check: (..._entries: unknown[]) => operation,
      set: (key: KvKey, value: unknown) => {
        writes.push(() => this.values.set(keyOf(key), value));
        return operation;
      },
      commit: () => {
        if (this.failWrites) return Promise.reject(new Error("KV write failed"));
        for (const write of writes) write();
        return Promise.resolve({ ok: true, versionstamp: "00000000000000000002" });
      },
    };
    return operation;
  }

  get<T>(key: KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: stored === undefined ? null : "00000000000000000001",
    } as KvEntryMaybe<T>);
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    if (this.failWrites) return Promise.reject(new Error("KV write failed"));
    this.values.set(keyOf(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" } as KvCommitResult);
  }

  delete(key: KvKey): Promise<void> {
    this.values.delete(keyOf(key));
    return Promise.resolve();
  }
}

const envLookup =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | null =>
    values[name] ?? null;
const allowed = new Set(["owner-key"]);
const oauthCredential = {
  kind: "oauth",
  secret: "token-1",
  hint: "token-1",
  label: null,
  source: "CLAUDE_CODE_OAUTH_TOKEN",
  updated_at_ms: null,
} as const;
const emptyObservation = (nowMs: number) => ({ windows: {}, standard: {}, representative_claim: null, observed_at_ms: nowMs });

test("credential and allowlist reads are explicit and empty by default", () => {
  assert.equal(readClaudeCodeEnvCredential(envLookup({})), null);
  assert.equal(readClaudeCodeEnvCredential(envLookup({ CLAUDE_CODE_OAUTH_TOKEN: "  " })), null);
  assert.equal(readClaudeCodeEnvCredential(envLookup({ CLAUDE_CODE_OAUTH_TOKEN: " token-1 " }))?.secret, "token-1");
  assert.equal(readClaudeCodeEnvCredential(envLookup({ CLAUDE_CODE_OAUTH_TOKEN: " token-1 " }))?.kind, "oauth");
  assert.equal(readClaudeCodeEnvCredential(envLookup({ CLAUDE_CODE_OAUTH_TOKEN: " token-1 " }))?.source, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.deepEqual([...parseClaudeCodeAllowedKeyIds(undefined)], []);
  assert.deepEqual([...parseClaudeCodeAllowedKeyIds("  ")], []);
  assert.deepEqual([...parseClaudeCodeAllowedKeyIds("a, b\n c")], ["a", "b", "c"]);
  assert.deepEqual([...readClaudeCodeAllowedKeyIds(envLookup({ CLAUDE_CODE_ALLOWED_KEY_IDS: "owner-key" }))], ["owner-key"]);
});

test("CLAUDE_API_KEY is the primary environment credential and wins over the legacy OAuth token", () => {
  const apiKey = readClaudeCodeEnvCredential(envLookup({ CLAUDE_API_KEY: " sk-ant-usr-1A6exampleBwAA " }));
  assert(apiKey);
  assert.equal(apiKey.kind, "api_key");
  assert.equal(apiKey.secret, "sk-ant-usr-1A6exampleBwAA");
  assert.equal(apiKey.source, "CLAUDE_API_KEY");
  const both = readClaudeCodeEnvCredential(envLookup({ CLAUDE_API_KEY: "sk-ant-usr-key", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token" }));
  assert.equal(both?.source, "CLAUDE_API_KEY");
  const oauthOnly = readClaudeCodeEnvCredential(envLookup({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token" }));
  assert.equal(oauthOnly?.kind, "oauth");
});

test("credential kinds and partial hints never expose the secret", () => {
  assert.equal(claudeCodeCredentialKind("sk-ant-api03-abc"), "api_key");
  assert.equal(claudeCodeCredentialKind("sk-ant-usr-1A6abc"), "api_key");
  assert.equal(claudeCodeCredentialKind("sk-ant-oat01-abc"), "oauth");
  assert.equal(claudeCodeCredentialKind("sk-ant-ort01-abc"), "oauth");
  assert.equal(claudeCodeCredentialKind("something-else"), "api_key");
  const hint = partialClaudeCodeCredentialHint("sk-ant-usr-1A6ABCDEFGHIJKLMNOPBwAA");
  assert.equal(hint, "sk-ant-usr-1A6...BwAA");
  assert.equal(hint.includes("ABCDEFGH"), false, "the middle of the secret never appears in a hint");
  assert.equal(partialClaudeCodeCredentialHint("short"), "configured");
});

test("a stored credential beats the bootstrapped environment and removal never resurrects it", async () => {
  resetClaudeCodeCredentialCacheForTest();
  const kv = new QuotaKv();
  const env = envLookup({ CLAUDE_API_KEY: "sk-ant-usr-env-key" });
  const fromEnv = await resolveClaudeCodeCredential(kv as unknown as Kv, env);
  assert.equal(fromEnv?.source, "CLAUDE_API_KEY");

  const stored = await storeClaudeCodeStoredCredential(kv as unknown as Kv, { secret: "sk-ant-usr-kv-key", label: "primary" });
  assert(stored);
  assert.equal(stored.kind, "api_key");
  assert.equal(stored.hint, "configured", "a short secret is never partially revealed");
  const resolved = await resolveClaudeCodeCredential(kv as unknown as Kv, env);
  assert(resolved);
  assert.equal(resolved.source, "kv");
  assert.equal(resolved.secret, "sk-ant-usr-kv-key");
  assert.equal(resolved.label, "primary");
  assert.equal(resolved.updated_at_ms !== null, true);
  assert.equal(kv.values.has(keyOf(CLAUDE_CODE_ACCOUNTS_KEY)), true);

  const loaded = await loadClaudeCodeStoredCredential(kv as unknown as Kv);
  assert.equal(loaded?.secret, "sk-ant-usr-kv-key");
  assert.equal(kv.values.has(keyOf(CLAUDE_CODE_AUTH_KV_KEY)), false, "new roster credentials do not overwrite retained singleton keys");

  await clearClaudeCodeStoredCredential(kv as unknown as Kv);
  const afterClear = await resolveClaudeCodeCredential(kv as unknown as Kv, env);
  assert.equal(afterClear, null);
  assert.equal(CLAUDE_CODE_CREDENTIAL_CACHE_TTL_MS, 60_000);
  resetClaudeCodeCredentialCacheForTest();
});

test("workspace resolution prefers a KV pin, then the environment pin, then discovery state", async () => {
  const kv = new QuotaKv();
  assert.equal(await resolveClaudeCodeWorkspace(kv as unknown as Kv, envLookup({})), null);
  const fromEnv = await resolveClaudeCodeWorkspace(kv as unknown as Kv, envLookup({ CLAUDE_CODE_WORKSPACE_ID: "wrkspc_01FBEp5VyCHs7ghEnJqk6giF" }));
  assert.deepEqual(fromEnv, { id: "wrkspc_01FBEp5VyCHs7ghEnJqk6giF", name: null, source: "env" });

  const discovered = mergeClaudeCodeWorkspaceState(null, { id: "wrkspc_01ErorW3iFLRvQy55cpNWtEt", name: "Default", source: "discovered" });
  await storeClaudeCodeWorkspaceState(kv as unknown as Kv, discovered);
  const fromDiscovery = await resolveClaudeCodeWorkspace(kv as unknown as Kv, envLookup({}));
  assert.deepEqual(fromDiscovery, { id: "wrkspc_01ErorW3iFLRvQy55cpNWtEt", name: "Default", source: "discovered" });
  assert.equal((await loadClaudeCodeWorkspaceState(kv as unknown as Kv))?.name, "Default");

  const pinned = mergeClaudeCodeWorkspaceState(discovered, { id: "wrkspc_01FBEp5VyCHs7ghEnJqk6giF", source: "kv", verified: true });
  await storeClaudeCodeWorkspaceState(kv as unknown as Kv, pinned);
  const resolved = await resolveClaudeCodeWorkspace(kv as unknown as Kv, envLookup({}));
  assert(resolved);
  assert.equal(resolved.id, "wrkspc_01FBEp5VyCHs7ghEnJqk6giF");
  assert.equal(resolved.source, "kv");
  assert.equal((await loadClaudeCodeWorkspaceState(kv as unknown as Kv))?.verified_at_ms !== null, true);

  assert.equal(parseClaudeCodeWorkspaceId("wrkspc_abc"), "wrkspc_abc");
  assert.equal(parseClaudeCodeWorkspaceId("abc"), null);
  assert.equal(parseClaudeCodeWorkspaceId("  "), null);
  assert.equal(kv.values.has(keyOf([...CLAUDE_CODE_WORKSPACE_KV_KEY])), true);
});

test("eligibility is the conjunction of model, provider, principal, credential, and quota gates", () => {
  const base = {
    model: "claude-opus-5-5",
    keyId: "owner-key",
    providerEnabled: true,
    allowedKeyIds: allowed,
    credential: oauthCredential,
    quota: null,
  } as const;
  assert.deepEqual(resolveClaudeCodeEligibility(base), { eligible: true, credential: oauthCredential, workspace: null });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, model: "gpt-5.6-sol" }), { eligible: false, reason: "model_unsupported" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, providerEnabled: false }), { eligible: false, reason: "provider_disabled" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, keyId: null }), { eligible: false, reason: "principal_not_allowed" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, keyId: "other-key" }), { eligible: false, reason: "principal_not_allowed" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, credential: null }), { eligible: false, reason: "credential_missing" });
});

test("an active durable block or cooldown removes eligibility until it expires", () => {
  const nowMs = 1_800_000_000_000;
  const blocked = {
    windows: {},
    standard: {},
    representative_claim: null,
    blocked_until_ms: nowMs + 60_000,
    block_window: "5h" as const,
    cooldown_until_ms: null,
    last_error: null,
    updated_at_ms: nowMs,
  };
  const base = { model: "claude-opus-5-5", keyId: "owner-key", providerEnabled: true, allowedKeyIds: allowed, credential: oauthCredential, nowMs } as const;
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, quota: blocked }), { eligible: false, reason: "quota_blocked" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, quota: { ...blocked, blocked_until_ms: nowMs - 1 } }), {
    eligible: true,
    credential: oauthCredential,
    workspace: null,
  });
  const cooling = { ...blocked, blocked_until_ms: null, cooldown_until_ms: nowMs + 1_000 };
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, quota: cooling }), { eligible: false, reason: "cooling_down" });
});

test("observations read the documented unified headers and reject malformed values", () => {
  const headers = new Headers({
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": "1783180800",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
  });
  const observation = observeClaudeCodeQuota(headers, 1_800_000_000_000);
  assert(observation);
  assert.deepEqual(observation.windows["5h"], {
    status: "allowed",
    utilization: 0.25,
    reset_at_ms: 1_783_180_800_000,
    observed_at_ms: 1_800_000_000_000,
  });
  assert.equal(observation.representative_claim, "five_hour");
  assert.equal(observeClaudeCodeQuota(new Headers(), 1_800_000_000_000), null);
  const malformed = new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "not-a-number",
    "anthropic-ratelimit-unified-5h-reset": "-5",
  });
  assert.equal(observeClaudeCodeQuota(malformed, 1_800_000_000_000), null);
  const statusOnly = observeClaudeCodeQuota(new Headers({ "anthropic-ratelimit-unified-7d-status": "limited" }), 1_800_000_000_000);
  assert(statusOnly);
  assert.deepEqual(statusOnly.windows["7d"], { status: "limited", utilization: null, reset_at_ms: null, observed_at_ms: 1_800_000_000_000 });
});

test("standard per-family rate limits are captured for API-key credentials", () => {
  const headers = new Headers({
    "anthropic-ratelimit-requests-limit": "50",
    "anthropic-ratelimit-requests-remaining": "49",
    "anthropic-ratelimit-requests-reset": "1783180800",
    "anthropic-ratelimit-input-tokens-limit": "40000",
    "anthropic-ratelimit-input-tokens-remaining": "39000",
    "anthropic-ratelimit-output-tokens-limit": "8000",
  });
  const observation = observeClaudeCodeQuota(headers, 1_800_000_000_000);
  assert(observation);
  assert.deepEqual(observation.standard.requests, { limit: 50, remaining: 49, reset_at_ms: 1_783_180_800_000, observed_at_ms: 1_800_000_000_000 });
  assert.equal(observation.standard["input-tokens"]?.limit, 40_000);
  assert.equal(observation.standard["output-tokens"]?.remaining, null);
  assert.equal(Object.keys(observation.windows).length, 0);
});

test("response classification keeps durable exhaustion, transient limits, and auth failures apart", () => {
  assert.deepEqual(classifyClaudeCodeResponse(200, new Headers()), { kind: "ok", exhaustion: null, retry_after_ms: null, detail: null });
  const durable = new Headers({
    "anthropic-ratelimit-unified-5h-status": "limited",
    "anthropic-ratelimit-unified-5h-reset": "1783180800",
  });
  assert.deepEqual(classifyClaudeCodeResponse(429, durable), {
    kind: "durable_exhaustion",
    exhaustion: { window: "5h", reset_at_ms: 1_783_180_800_000 },
    retry_after_ms: null,
    detail: null,
  });
  const utilizationFull = new Headers({ "anthropic-ratelimit-unified-7d-utilization": "1", "anthropic-ratelimit-unified-7d-reset": "1783180800" });
  assert.deepEqual(classifyClaudeCodeResponse(429, utilizationFull).exhaustion, { window: "7d", reset_at_ms: 1_783_180_800_000 });
  const transient = new Headers({ "retry-after": "30" });
  assert.deepEqual(classifyClaudeCodeResponse(429, transient), { kind: "transient_rate_limited", exhaustion: null, retry_after_ms: 30_000, detail: null });
  const transientAllowed = new Headers({ "anthropic-ratelimit-unified-5h-status": "allowed", "anthropic-ratelimit-unified-5h-utilization": "0.9" });
  assert.equal(classifyClaudeCodeResponse(429, transientAllowed).kind, "transient_rate_limited");
  assert.equal(classifyClaudeCodeResponse(401, new Headers()).kind, "auth_invalid");
  assert.equal(classifyClaudeCodeResponse(403, new Headers()).kind, "forbidden");
  assert.equal(classifyClaudeCodeResponse(529, new Headers()).kind, "upstream_error");
  assert.equal(classifyClaudeCodeResponse(400, new Headers()).kind, "request_rejected");
});

test("error bodies separate workspace, billing, and credential scoping rejections from generic failures", () => {
  const rejected = classifyClaudeCodeResponse(400, new Headers());
  const workspaceRequired = classifyClaudeCodeErrorBody(
    rejected,
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.",
      },
    })
  );
  assert.equal(workspaceRequired.kind, "workspace_required");
  assert(workspaceRequired.detail?.includes("not scoped to a workspace"));

  const notFound = classifyClaudeCodeErrorBody(
    classifyClaudeCodeResponse(404, new Headers()),
    JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Workspace `72cde404-5c32-4031-b07f-26df74e0980c` not found." } })
  );
  assert.equal(notFound.kind, "workspace_not_found");

  const billing = classifyClaudeCodeErrorBody(
    rejected,
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    })
  );
  assert.equal(billing.kind, "billing_blocked");

  const generic = classifyClaudeCodeErrorBody(
    rejected,
    JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be at least 1" } })
  );
  assert.equal(generic.kind, "request_rejected");
  assert(generic.detail?.startsWith("max_tokens"));
  assert.equal(classifyClaudeCodeErrorBody(classifyClaudeCodeResponse(200, new Headers()), null).kind, "ok");
});

test("quota state merges newest window observations and never resurrects stale windows", () => {
  const early = {
    windows: { "5h": { status: "allowed", utilization: 0.1, reset_at_ms: 1_783_000_000_000, observed_at_ms: 1_800_000_000_000 } },
    standard: {},
    representative_claim: null,
    observed_at_ms: 1_800_000_000_000,
  };
  const later = {
    windows: { "5h": { status: "allowed", utilization: 0.4, reset_at_ms: 1_783_000_000_000, observed_at_ms: 1_800_000_100_000 } },
    standard: {},
    representative_claim: "five_hour",
    observed_at_ms: 1_800_000_100_000,
  };
  const merged = mergeClaudeCodeQuotaState(mergeClaudeCodeQuotaState(null, early, null, 1_800_000_000_000), later, null, 1_800_000_100_000);
  assert.equal(merged.windows["5h"]?.utilization, 0.4);
  assert.equal(merged.representative_claim, "five_hour");
  const stale = mergeClaudeCodeQuotaState(merged, early, null, 1_800_000_200_000);
  assert.equal(stale.windows["5h"]?.utilization, 0.4, "an older observation never replaces a newer one");
});

test("durable blocks extend past the reset margin, survive merges, and expire", () => {
  const nowMs = 1_800_000_000_000;
  const observation = emptyObservation(nowMs);
  const blocked = mergeClaudeCodeQuotaState(null, observation, { window: "5h", reset_at_ms: nowMs + 100_000 }, nowMs);
  assert.equal(blocked.blocked_until_ms, nowMs + 100_000 + CLAUDE_CODE_RESET_MARGIN_MS);
  assert.equal(blocked.block_window, "5h");
  assert.equal(claudeCodeQuotaBlocked(blocked, nowMs + 1_000), true);
  const stillBlocked = mergeClaudeCodeQuotaState(blocked, observation, null, nowMs + 50_000);
  assert.equal(stillBlocked.blocked_until_ms, blocked.blocked_until_ms);
  const expired = mergeClaudeCodeQuotaState(blocked, observation, null, nowMs + 100_000 + CLAUDE_CODE_RESET_MARGIN_MS + 1);
  assert.equal(expired.blocked_until_ms, null);
  const noReset = mergeClaudeCodeQuotaState(null, observation, { window: "7d", reset_at_ms: null }, nowMs);
  assert.equal(noReset.blocked_until_ms, nowMs + CLAUDE_CODE_MIN_BLOCK_MS);
});

test("recorded outcomes persist windows, blocks, and cooldowns through KV", async () => {
  const kv = new QuotaKv();
  const nowMs = 1_800_000_000_000;
  const headers = new Headers({
    "anthropic-ratelimit-unified-5h-status": "limited",
    "anthropic-ratelimit-unified-5h-reset": String(Math.trunc((nowMs + 60_000) / 1_000)),
    "anthropic-ratelimit-unified-5h-utilization": "1",
  });
  const classification = classifyClaudeCodeResponse(429, headers, nowMs);
  const recorded = await recordClaudeCodeQuotaOutcome(kv as unknown as Kv, {
    observation: observeClaudeCodeQuota(headers, nowMs),
    exhaustion: classification.exhaustion,
    transient: null,
    nowMs,
  });
  assert.equal(recorded?.blocked_until_ms, nowMs + 60_000 + CLAUDE_CODE_RESET_MARGIN_MS);
  const reloaded = await loadClaudeCodeQuotaState(kv as unknown as Kv);
  assert.equal(reloaded?.windows["5h"]?.utilization, 1);
  assert.equal(claudeCodeQuotaBlocked(reloaded, nowMs), true);

  const transient = await recordClaudeCodeQuotaOutcome(kv as unknown as Kv, {
    observation: null,
    exhaustion: null,
    transient: { retry_after_ms: null },
    nowMs,
  });
  assert(transient);
  assert.equal(transient.cooldown_until_ms, nowMs + CLAUDE_CODE_TRANSIENT_COOLDOWN_MS);
  assert.equal(transient.blocked_until_ms, nowMs + 60_000 + CLAUDE_CODE_RESET_MARGIN_MS, "a transient limit never touches the durable block");
  assert.equal(claudeCodeQuotaCoolingDown(transient, nowMs + 1_000), true);
  const reloadedState = await loadClaudeCodeQuotaState(kv as unknown as Kv);
  assert(reloadedState);
  assert.equal(reloadedState.cooldown_until_ms, nowMs + CLAUDE_CODE_TRANSIENT_COOLDOWN_MS);
  assert.deepEqual([...kv.values.keys()], [keyOf([...CLAUDE_CODE_QUOTA_KV_KEY])]);

  const state = parseClaudeCodeQuotaState({ ...transient, blocked_until_ms: null });
  assert(state);
  assert.equal(state.blocked_until_ms, null);
  assert.equal(parseClaudeCodeQuotaState({ windows: {}, updated_at_ms: 0 }), null);
});

test("a configuration rejection records its reason and a bounded cooldown, and a served request clears it", async () => {
  const kv = new QuotaKv();
  const nowMs = 1_800_000_000_000;
  const recorded = await recordClaudeCodeQuotaOutcome(kv as unknown as Kv, {
    observation: null,
    config_error: { kind: "billing_blocked", status: 400, message: "Your credit balance is too low to access the Anthropic API.", retry_after_ms: null },
    nowMs,
  });
  assert(recorded?.last_error?.message);
  assert.equal(recorded.cooldown_until_ms, nowMs + CLAUDE_CODE_CONFIG_COOLDOWN_MS);
  assert.equal(recorded.last_error.kind, "billing_blocked");
  assert.equal(recorded.last_error.status, 400);
  assert(recorded.last_error.message.includes("credit balance"));
  assert.equal(claudeCodeQuotaCoolingDown(recorded, nowMs + 1_000), true);
  assert.equal(recorded.blocked_until_ms, null, "a billing rejection is not a quota block");

  const served = await recordClaudeCodeQuotaOutcome(kv as unknown as Kv, { observation: null, served: true, nowMs: nowMs + 20 * 60_000 });
  assert.equal(served?.last_error, null, "serving the request clears the recorded configuration error");

  const cleared = await clearClaudeCodeQuotaGuards(kv as unknown as Kv);
  assert(cleared);
  assert.equal(cleared.cooldown_until_ms, null);
  assert.equal(cleared.blocked_until_ms, null);
  assert.equal(cleared.last_error, null);
  assert.equal(await clearClaudeCodeQuotaGuards(null), null);
});

test("configuration rejections never silently degrade into request-local cooldowns", async () => {
  const kv = new QuotaKv();
  const nowMs = 1_800_000_000_000;
  const rejected = await recordClaudeCodeQuotaOutcome(kv as unknown as Kv, {
    observation: null,
    exhaustion: null,
    transient: null,
    config_error: { kind: "workspace_not_found", status: 404, message: "Workspace `72cde404` not found.", retry_after_ms: 120_000 },
    nowMs,
  });
  assert(rejected?.last_error);
  assert.equal(rejected.cooldown_until_ms, nowMs + 120_000, "an explicit retry-after bounds the configuration cooldown");
  assert.equal(rejected.last_error.kind, "workspace_not_found");
});

test("the native request builder defaults max_tokens, strips router hints, and refuses non-Claude models", () => {
  const built = buildClaudeCodeRequest({
    model: "claude-opus-5-5",
    input: "hello",
    stream: true,
    instructions: "be brief",
    prompt_cache_key: "affinity-1",
  });
  assert(built);
  assert.equal(built.body.model, "claude-opus-5-5");
  assert.equal(built.body.max_tokens, CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(built.body.stream, true);
  assert.equal(built.body.prompt_cache_key, undefined);
  assert.equal((built.body.messages as unknown[]).length, 1);
  const explicit = buildClaudeCodeRequest({ model: "claude-sonnet-5-5", input: "hi", max_output_tokens: 4_096 });
  assert.equal(explicit?.body.max_tokens, 4_096);
  assert.equal(buildClaudeCodeRequest({ model: "gpt-5.6-sol", input: "hi" }), null);
});

test("the subscription lane leads its system blocks with the native attribution", () => {
  const subscription = buildClaudeCodeRequest({ model: "claude-opus-5-5", input: "hello", instructions: "be brief" }, { systemAttribution: true });
  assert(subscription);
  const system = subscription.body.system as { type: string; text: string }[];
  assert.equal(system[0]?.type, "text");
  assert.equal(system[0]?.text, CLAUDE_CODE_SYSTEM_ATTRIBUTION, "the attribution must be the first system block");
  assert.equal(system[1]?.text, "be brief", "caller system content follows the attribution");

  const apiKey = buildClaudeCodeRequest({ model: "claude-opus-5-5", input: "hello", instructions: "be brief" }, { systemAttribution: false });
  assert(apiKey);
  const apiKeySystem = (apiKey.body.system ?? []) as { text: string }[];
  assert.equal(
    apiKeySystem.some((block) => block.text === CLAUDE_CODE_SYSTEM_ATTRIBUTION),
    false,
    "an API key request never claims the native client attribution"
  );
});

test("OAuth credentials carry Bearer plus the OAuth beta and never an API key header", () => {
  const streaming = claudeCodeRequestHeaders({ kind: "oauth", secret: "token-1" }, { stream: true });
  assert.equal(streaming.get("authorization"), "Bearer token-1");
  assert.equal(streaming.get("anthropic-version"), "2023-06-01");
  assert.equal(streaming.get("anthropic-beta"), CLAUDE_CODE_OAUTH_BETA);
  assert.equal(streaming.get("accept"), "text/event-stream");
  assert.equal(streaming.get("x-api-key"), null);
  assert.equal(streaming.get("anthropic-workspace-id"), null);
  assert.equal(claudeCodeRequestHeaders({ kind: "oauth", secret: "token-1" }, { stream: false }).get("accept"), "application/json");
});

test("API-key credentials carry x-api-key, the workspace header when selected, and no OAuth beta", () => {
  const headers = claudeCodeRequestHeaders(
    { kind: "api_key", secret: "sk-ant-usr-1A6exampleBwAA" },
    { stream: false, workspaceId: "wrkspc_01ErorW3iFLRvQy55cpNWtEt" }
  );
  assert.equal(headers.get("x-api-key"), "sk-ant-usr-1A6exampleBwAA");
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("anthropic-beta"), null);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.get("anthropic-workspace-id"), "wrkspc_01ErorW3iFLRvQy55cpNWtEt");
  const noWorkspace = claudeCodeRequestHeaders({ kind: "api_key", secret: "key" }, { stream: false, workspaceId: null });
  assert.equal(noWorkspace.get("anthropic-workspace-id"), null);
});
