import assert from "node:assert/strict";
import {
  buildClaudeCodeRequest,
  CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS,
  CLAUDE_CODE_OAUTH_BETA,
  classifyClaudeCodeResponse,
  claudeCodeRequestHeaders,
  parseClaudeCodeAllowedKeyIds,
  readClaudeCodeAllowedKeyIds,
  readClaudeCodeToken,
  resolveClaudeCodeEligibility,
} from "../src/provider/claude-code.ts";
import {
  CLAUDE_CODE_MIN_BLOCK_MS,
  CLAUDE_CODE_QUOTA_KV_KEY,
  CLAUDE_CODE_RESET_MARGIN_MS,
  CLAUDE_CODE_TRANSIENT_COOLDOWN_MS,
  claudeCodeQuotaBlocked,
  claudeCodeQuotaCoolingDown,
  loadClaudeCodeQuotaState,
  mergeClaudeCodeQuotaState,
  observeClaudeCodeQuota,
  parseClaudeCodeQuotaState,
  recordClaudeCodeQuotaOutcome,
} from "../src/provider/claude-code-quota.ts";

const keyOf = (key: Deno.KvKey): string => JSON.stringify(key);

/** Minimal Deno.Kv stand-in for the two keys this tier reads and writes. */
class QuotaKv {
  readonly values = new Map<string, unknown>();
  failWrites = false;

  get<T>(key: Deno.KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<Deno.KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: stored === undefined ? null : "00000000000000000001",
    } as Deno.KvEntryMaybe<T>);
  }

  set(key: Deno.KvKey, value: unknown): Promise<Deno.KvCommitResult> {
    if (this.failWrites) return Promise.reject(new Error("KV write failed"));
    this.values.set(keyOf(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" } as Deno.KvCommitResult);
  }
}

const envLookup =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | null =>
    values[name] ?? null;
const allowed = new Set(["owner-key"]);

Deno.test("credential and allowlist reads are explicit and empty by default", () => {
  assert.equal(readClaudeCodeToken(envLookup({})), null);
  assert.equal(readClaudeCodeToken(envLookup({ CLAUDE_CODE_OAUTH_TOKEN: "  " })), null);
  assert.equal(readClaudeCodeToken(envLookup({ CLAUDE_CODE_OAUTH_TOKEN: " token-1 " })), "token-1");
  assert.deepEqual([...parseClaudeCodeAllowedKeyIds(undefined)], []);
  assert.deepEqual([...parseClaudeCodeAllowedKeyIds("  ")], []);
  assert.deepEqual([...parseClaudeCodeAllowedKeyIds("a, b\n c")], ["a", "b", "c"]);
  assert.deepEqual([...readClaudeCodeAllowedKeyIds(envLookup({ CLAUDE_CODE_ALLOWED_KEY_IDS: "owner-key" }))], ["owner-key"]);
});

Deno.test("eligibility is the conjunction of model, provider, principal, credential, and quota gates", () => {
  const base = { model: "claude-opus-5-5", keyId: "owner-key", providerEnabled: true, allowedKeyIds: allowed, token: "token-1", quota: null } as const;
  assert.deepEqual(resolveClaudeCodeEligibility(base), { eligible: true, token: "token-1" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, model: "gpt-5.6-sol" }), { eligible: false, reason: "model_unsupported" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, providerEnabled: false }), { eligible: false, reason: "provider_disabled" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, keyId: null }), { eligible: false, reason: "principal_not_allowed" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, keyId: "other-key" }), { eligible: false, reason: "principal_not_allowed" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, token: null }), { eligible: false, reason: "token_missing" });
});

Deno.test("an active durable block or cooldown removes eligibility until it expires", () => {
  const nowMs = 1_800_000_000_000;
  const blocked = {
    windows: {},
    representative_claim: null,
    blocked_until_ms: nowMs + 60_000,
    block_window: "5h" as const,
    cooldown_until_ms: null,
    updated_at_ms: nowMs,
  };
  const base = { model: "claude-opus-5-5", keyId: "owner-key", providerEnabled: true, allowedKeyIds: allowed, token: "token-1", nowMs } as const;
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, quota: blocked }), { eligible: false, reason: "quota_blocked" });
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, quota: { ...blocked, blocked_until_ms: nowMs - 1 } }), { eligible: true, token: "token-1" });
  const cooling = { ...blocked, blocked_until_ms: null, cooldown_until_ms: nowMs + 1_000 };
  assert.deepEqual(resolveClaudeCodeEligibility({ ...base, quota: cooling }), { eligible: false, reason: "cooling_down" });
});

Deno.test("observations read the documented unified headers and reject malformed values", () => {
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

Deno.test("response classification keeps durable exhaustion, transient limits, and auth failures apart", () => {
  assert.equal(classifyClaudeCodeResponse(200, new Headers()).kind, "ok");
  const durable = new Headers({
    "anthropic-ratelimit-unified-5h-status": "limited",
    "anthropic-ratelimit-unified-5h-reset": "1783180800",
  });
  assert.deepEqual(classifyClaudeCodeResponse(429, durable), {
    kind: "durable_exhaustion",
    exhaustion: { window: "5h", reset_at_ms: 1_783_180_800_000 },
    retry_after_ms: null,
  });
  const utilizationFull = new Headers({ "anthropic-ratelimit-unified-7d-utilization": "1", "anthropic-ratelimit-unified-7d-reset": "1783180800" });
  assert.deepEqual(classifyClaudeCodeResponse(429, utilizationFull).exhaustion, { window: "7d", reset_at_ms: 1_783_180_800_000 });
  const transient = new Headers({ "retry-after": "30" });
  assert.deepEqual(classifyClaudeCodeResponse(429, transient), { kind: "transient_rate_limited", exhaustion: null, retry_after_ms: 30_000 });
  const transientAllowed = new Headers({ "anthropic-ratelimit-unified-5h-status": "allowed", "anthropic-ratelimit-unified-5h-utilization": "0.9" });
  assert.equal(classifyClaudeCodeResponse(429, transientAllowed).kind, "transient_rate_limited");
  assert.equal(classifyClaudeCodeResponse(401, new Headers()).kind, "auth_invalid");
  assert.equal(classifyClaudeCodeResponse(403, new Headers()).kind, "forbidden");
  assert.equal(classifyClaudeCodeResponse(529, new Headers()).kind, "upstream_error");
  assert.equal(classifyClaudeCodeResponse(400, new Headers()).kind, "request_rejected");
});

Deno.test("quota state merges newest window observations and never resurrects stale windows", () => {
  const early = {
    windows: { "5h": { status: "allowed", utilization: 0.1, reset_at_ms: 1_783_000_000_000, observed_at_ms: 1_800_000_000_000 } },
    representative_claim: null,
    observed_at_ms: 1_800_000_000_000,
  };
  const later = {
    windows: { "5h": { status: "allowed", utilization: 0.4, reset_at_ms: 1_783_000_000_000, observed_at_ms: 1_800_000_100_000 } },
    representative_claim: "five_hour",
    observed_at_ms: 1_800_000_100_000,
  };
  const merged = mergeClaudeCodeQuotaState(mergeClaudeCodeQuotaState(null, early, null, 1_800_000_000_000), later, null, 1_800_000_100_000);
  assert.equal(merged.windows["5h"]?.utilization, 0.4);
  assert.equal(merged.representative_claim, "five_hour");
  const stale = mergeClaudeCodeQuotaState(merged, early, null, 1_800_000_200_000);
  assert.equal(stale.windows["5h"]?.utilization, 0.4, "an older observation never replaces a newer one");
});

Deno.test("durable blocks extend past the reset margin, survive merges, and expire", () => {
  const nowMs = 1_800_000_000_000;
  const observation = { windows: {}, representative_claim: null, observed_at_ms: nowMs };
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

Deno.test("recorded outcomes persist windows, blocks, and cooldowns through KV", async () => {
  const kv = new QuotaKv();
  const nowMs = 1_800_000_000_000;
  const headers = new Headers({
    "anthropic-ratelimit-unified-5h-status": "limited",
    "anthropic-ratelimit-unified-5h-reset": String(Math.trunc((nowMs + 60_000) / 1_000)),
    "anthropic-ratelimit-unified-5h-utilization": "1",
  });
  const classification = classifyClaudeCodeResponse(429, headers, nowMs);
  const recorded = await recordClaudeCodeQuotaOutcome(kv as unknown as Deno.Kv, {
    observation: observeClaudeCodeQuota(headers, nowMs),
    exhaustion: classification.exhaustion,
    transient: null,
    nowMs,
  });
  assert.equal(recorded?.blocked_until_ms, nowMs + 60_000 + CLAUDE_CODE_RESET_MARGIN_MS);
  const reloaded = await loadClaudeCodeQuotaState(kv as unknown as Deno.Kv);
  assert.equal(reloaded?.windows["5h"]?.utilization, 1);
  assert.equal(claudeCodeQuotaBlocked(reloaded, nowMs), true);

  const transient = await recordClaudeCodeQuotaOutcome(kv as unknown as Deno.Kv, {
    observation: null,
    exhaustion: null,
    transient: { retry_after_ms: null },
    nowMs,
  });
  assert(transient);
  assert.equal(transient.cooldown_until_ms, nowMs + CLAUDE_CODE_TRANSIENT_COOLDOWN_MS);
  assert.equal(transient.blocked_until_ms, nowMs + 60_000 + CLAUDE_CODE_RESET_MARGIN_MS, "a transient limit never touches the durable block");
  assert.equal(claudeCodeQuotaCoolingDown(transient, nowMs + 1_000), true);
  const reloadedState = await loadClaudeCodeQuotaState(kv as unknown as Deno.Kv);
  assert(reloadedState);
  assert.equal(reloadedState.cooldown_until_ms, nowMs + CLAUDE_CODE_TRANSIENT_COOLDOWN_MS);
  assert.deepEqual([...kv.values.keys()], [keyOf([...CLAUDE_CODE_QUOTA_KV_KEY])]);

  const state = parseClaudeCodeQuotaState({ ...transient, blocked_until_ms: null });
  assert(state);
  assert.equal(state.blocked_until_ms, null);
  assert.equal(parseClaudeCodeQuotaState({ windows: {}, updated_at_ms: 0 }), null);
});

Deno.test("the native request builder defaults max_tokens, strips router hints, and refuses non-Claude models", () => {
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

Deno.test("subscription headers carry Bearer, the API version, and the OAuth beta without an API key", () => {
  const streaming = claudeCodeRequestHeaders("token-1", true);
  assert.equal(streaming.get("authorization"), "Bearer token-1");
  assert.equal(streaming.get("anthropic-version"), "2023-06-01");
  assert.equal(streaming.get("anthropic-beta"), CLAUDE_CODE_OAUTH_BETA);
  assert.equal(streaming.get("accept"), "text/event-stream");
  assert.equal(streaming.get("x-api-key"), null);
  assert.equal(claudeCodeRequestHeaders("token-1", false).get("accept"), "application/json");
});
