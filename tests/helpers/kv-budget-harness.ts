import { setKvForTest } from "../../src/kv.ts";
import { KvU64 } from "#kv";
import type { AtomicOperation, Kv, KvCommitResult, KvEntry, KvEntryMaybe, KvKey, KvListIterator, KvListSelector } from "#kv";
// Shared harness for this suite, moved out of the original test file.

import assert from "node:assert/strict";

// This suite asserts exact fetch and KV budgets, so the event-driven maintenance
// hooks must not run in the background while it measures them.
const { setProviderCapacitySampleTriggerForTest } = await import("../../src/provider/capacity-events.ts");
const { setPaidFallbackTerminalSweepForTest } = await import("../../src/paid-fallback/index.ts");
import { sha256Base64Url } from "../../src/utils.ts";

const encodeKey = (key: KvKey): string => JSON.stringify(key);
const textEncoder = new TextEncoder();

const kvFingerprint = (value: unknown): string => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item));

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  let encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
  // base64 padding is a trailing run of "=". Stripping it one character at a
  // time is linear and removes exactly what the former `/=+$/g` replacement did,
  // which eslint's sonarjs/super-linear-regex flagged for backtracking.
  while (encoded.endsWith("=")) encoded = encoded.slice(0, -1);
  return encoded;
};

const encodeJsonBase64Url = (value: unknown): string => encodeBase64Url(textEncoder.encode(JSON.stringify(value)));

const toPublicKeyPem = (spki: Uint8Array): string => {
  let binary = "";
  for (const byte of spki) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
};

type CountingKvMutation = { kind: "set"; key: KvKey; value: unknown } | { kind: "delete"; key: KvKey } | { kind: "sum"; key: KvKey; value: bigint };

const isSumMutation = (mutation: CountingKvMutation): boolean => mutation.kind === "sum";

const isKernelReservationMutation = (mutation: CountingKvMutation): boolean =>
  mutation.kind === "set" &&
  mutation.key[0] === "uos_ai" &&
  mutation.key[1] === "kernel_quota" &&
  mutation.key[2] === "v2" &&
  String(mutation.key[3]).endsWith("reservation") &&
  typeof mutation.value === "object" &&
  mutation.value !== null &&
  (mutation.value as { state?: unknown }).state === "reserved";

const isKernelSettlementMutation = (mutation: CountingKvMutation): boolean =>
  mutation.kind === "set" &&
  mutation.key[0] === "uos_ai" &&
  mutation.key[1] === "kernel_quota" &&
  mutation.key[2] === "v2" &&
  String(mutation.key[3]).endsWith("reservation") &&
  typeof mutation.value === "object" &&
  mutation.value !== null &&
  ((mutation.value as { state?: unknown }).state === "committed" || (mutation.value as { state?: unknown }).state === "released");

const isApiKeyV3DispatchMutation = (mutation: CountingKvMutation): boolean =>
  mutation.kind === "set" &&
  mutation.key[0] === "uos_ai" &&
  mutation.key[1] === "api_key_usage" &&
  mutation.key[2] === "v3" &&
  typeof mutation.value === "object" &&
  mutation.value !== null &&
  (mutation.value as { state?: unknown }).state === "dispatched";

class CountingKv {
  readonly values = new Map<string, unknown>();
  private readonly _versions = new Map<string, { fingerprint: string; revision: number }>();
  private _nextRevision = 1;
  reads = 0;
  readUnits = 0;
  writes = 0;
  sums = 0;
  sumCommitAttempts = 0;
  failNextSumCommits = 0;
  failNextCommits = 0;
  failApiKeyV3Reads = false;
  failKernelQuotaReads = false;
  kernelQuotaReadGate: Promise<void> | null = null;
  failNextKernelSettlementCommits = 0;
  onKernelReservationCommit: (() => void) | null = null;
  sumCommitDelayMs = 0;
  apiKeyV3DispatchCommitGate: Promise<void> | null = null;
  onApiKeyV3DispatchCommit: (() => void) | null = null;
  retries = 0;
  listCalls = 0;
  readonly readKeys: KvKey[] = [];
  readonly writeKeys: KvKey[] = [];

  private _versionstamp(key: KvKey): string | null {
    const encoded = encodeKey(key);
    if (!this.values.has(encoded)) return null;
    const fingerprint = kvFingerprint(this.values.get(encoded));
    const existing = this._versions.get(encoded);
    if (existing?.fingerprint !== fingerprint) {
      const revision = this._nextRevision++;
      this._versions.set(encoded, { fingerprint, revision });
      return String(revision).padStart(20, "0");
    }
    return String(existing.revision).padStart(20, "0");
  }

  private _write(key: KvKey, value: unknown): void {
    const encoded = encodeKey(key);
    this.values.set(encoded, value);
    this._versions.set(encoded, { fingerprint: kvFingerprint(value), revision: this._nextRevision++ });
  }

  private _remove(key: KvKey): void {
    const encoded = encodeKey(key);
    this.values.delete(encoded);
    this._versions.delete(encoded);
    this._nextRevision += 1;
  }

  resetCounts(): void {
    this.reads = 0;
    this.readUnits = 0;
    this.writes = 0;
    this.sums = 0;
    this.sumCommitAttempts = 0;
    this.failNextSumCommits = 0;
    this.failNextCommits = 0;
    this.failKernelQuotaReads = false;
    this.kernelQuotaReadGate = null;
    this.failNextKernelSettlementCommits = 0;
    this.onKernelReservationCommit = null;
    this.sumCommitDelayMs = 0;
    this.apiKeyV3DispatchCommitGate = null;
    this.onApiKeyV3DispatchCommit = null;
    this.retries = 0;
    this.listCalls = 0;
    this.readKeys.length = 0;
    this.writeKeys.length = 0;
  }

  async get<T>(key: KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    if (this.kernelQuotaReadGate && key[0] === "uos_ai" && key[1] === "kernel_quota" && key[2] === "v2") {
      await this.kernelQuotaReadGate;
    }
    if (this.failApiKeyV3Reads && key[0] === "uos_ai" && key[1] === "api_key_usage" && key[2] === "v3") {
      return Promise.reject(new Error("injected API-key V3 ledger read failure"));
    }
    if (this.failKernelQuotaReads && key[0] === "uos_ai" && key[1] === "kernel_quota" && key[2] === "v2") {
      return Promise.reject(new Error("injected Kernel quota read failure"));
    }
    this.reads += 1;
    this.readKeys.push(key);
    const value = this.values.get(encodeKey(key)) as T | undefined;
    const bytes =
      value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item))).length;
    this.readUnits += Math.max(1, Math.ceil(bytes / 4096));
    return {
      key,
      value: value ?? null,
      versionstamp: this._versionstamp(key),
    } as KvEntryMaybe<T>;
  }

  getMany<T extends readonly unknown[]>(
    keys: readonly KvKey[],
    _options?: { consistency?: "strong" | "eventual" }
  ): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }> {
    if (this.failApiKeyV3Reads && keys.some((key) => key[0] === "uos_ai" && key[1] === "api_key_usage" && key[2] === "v3")) {
      return Promise.reject(new Error("injected API-key V3 ledger read failure"));
    }
    this.reads += 1;
    this.readKeys.push(...keys);
    const entries = keys.map((key) => {
      const value = this.values.get(encodeKey(key));
      const bytes =
        value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item))).length;
      this.readUnits += Math.max(1, Math.ceil(bytes / 4096));
      return {
        key,
        value: value ?? null,
        versionstamp: this._versionstamp(key),
      };
    });
    return Promise.resolve(entries as { [K in keyof T]: KvEntryMaybe<T[K]> });
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    this._write(key, value);
    this.writes += 1;
    this.writeKeys.push(key);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" });
  }

  delete(key: KvKey): Promise<void> {
    this._remove(key);
    this.writes += 1;
    this.writeKeys.push(key);
    return Promise.resolve();
  }

  list<T>(selector: KvListSelector): KvListIterator<T> {
    this.listCalls += 1;
    const prefix = "prefix" in selector ? selector.prefix : [];
    const entries = [...this.values].filter(([encoded]) => {
      const key = JSON.parse(encoded) as KvKey;
      return prefix.every((part, index) => part === key[index]);
    });
    return (function* () {
      for (const [encoded, value] of entries) {
        const key = JSON.parse(encoded) as KvKey;
        yield { key, value, versionstamp: "00000000000000000001" } as KvEntry<T>;
      }
    })() as unknown as KvListIterator<T>;
  }

  atomic(): AtomicOperation {
    const checks: KvEntryMaybe<unknown>[] = [];
    const mutations: CountingKvMutation[] = [];
    const operation = {
      check: (entry: KvEntryMaybe<unknown>) => {
        checks.push(entry);
        return operation;
      },
      set: (key: KvKey, value: unknown) => {
        mutations.push({ kind: "set", key, value });
        return operation;
      },
      delete: (key: KvKey) => {
        mutations.push({ kind: "delete", key });
        return operation;
      },
      sum: (key: KvKey, value: bigint) => {
        mutations.push({ kind: "sum", key, value });
        return operation;
      },
      commit: async () => {
        if (this.failNextCommits > 0) {
          this.failNextCommits -= 1;
          return { ok: false, versionstamp: null };
        }
        if (mutations.some(isKernelReservationMutation) && this.onKernelReservationCommit) {
          const callback = this.onKernelReservationCommit;
          this.onKernelReservationCommit = null;
          callback();
        }
        if (checks.some((entry) => this._versionstamp(entry.key) !== entry.versionstamp)) {
          return { ok: false, versionstamp: null };
        }
        if (mutations.some(isSumMutation)) {
          await this._commitSumMutation();
        }
        if (mutations.some(isKernelSettlementMutation) && this.failNextKernelSettlementCommits > 0) {
          this.failNextKernelSettlementCommits -= 1;
          throw new Error("injected Kernel quota settlement failure");
        }
        if (mutations.some(isApiKeyV3DispatchMutation)) {
          this.onApiKeyV3DispatchCommit?.();
          if (this.apiKeyV3DispatchCommitGate) await this.apiKeyV3DispatchCommitGate;
        }
        for (const mutation of mutations) this._applyMutation(mutation);
        return { ok: true, versionstamp: "00000000000000000001" };
      },
    };
    return operation as unknown as AtomicOperation;
  }

  private async _commitSumMutation(): Promise<void> {
    this.sumCommitAttempts += 1;
    if (this.failNextSumCommits > 0) {
      this.failNextSumCommits -= 1;
      throw new Error("injected API-key usage sum failure");
    }
    if (this.sumCommitDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.sumCommitDelayMs));
    }
  }

  private _applyMutation(mutation: CountingKvMutation): void {
    const encoded = encodeKey(mutation.key);
    if (mutation.kind === "delete") this._remove(mutation.key);
    else if (mutation.kind === "set") this._write(mutation.key, mutation.value);
    else {
      const current = this.values.get(encoded) as KvU64 | undefined;
      this._write(mutation.key, new KvU64((current?.value ?? 0n) + mutation.value));
      this.sums += 1;
    }
    this.writes += 1;
    this.writeKeys.push(mutation.key);
  }
}

const kv = new CountingKv();

const { default: handler } = await import("../../src/handler/index.ts");
const { authenticateAdmin, authenticateClient } = await import("../../src/auth/index.ts");
const { PASSKEY_RELAY_COOKIE_NAME, passkeySessionKey, passkeyUserKey } = await import("../../src/auth/passkeys.ts");
const { createRequestDeliveryLifecycle } = await import("../../src/handler/serve-handler.ts");
const { handleResponses } = await import("../../src/responses-handler.ts");
const {
  API_KEY_USAGE_V3_REQUEST_PREFIX,
  ApiKeyQuotaDispatchError,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  authenticateApiKeyToken,
  makeApiKeyUsageWindowV3,
  reserveApiKeyUsageV3,
  invalidateApiKeyPolicy,
  resetApiKeyPolicyCacheForTest,
} = await import("../../src/api-key-policy.ts");
const {
  deleteKernelOrgUsageLimit,
  KERNEL_QUOTA_RESERVATION_LEASE_MS,
  kernelOrgReservationKey,
  kernelOrgWindowKey,
  kernelRepoPolicyKey,
  reserveEffectiveKernelUsageLimit,
  reserveKernelOrgUsageLimit,
  setKernelOrgUsageLimit,
  setKernelUsageLimit,
} = await import("../../src/kernel/quota-v2.ts");
const { handleAdminDefaults } = await import("../../src/admin/index.ts");
const { DEFAULT_KERNEL_POLICY_LIMIT_KEY, DEFAULT_KERNEL_POLICY_WINDOW_KEY } = await import("../../src/defaults.ts");
const { paidFallbackRequestV3Key } = await import("../../src/paid-fallback/ledger-state.ts");
const { setStreamFirstEventDeadlineMsForTest } = await import("../../src/inference-deadline.ts");
const { loadRuntimeConfig, RUNTIME_CONFIG_CACHE_TTL_MS, RUNTIME_CONFIG_V2_KEY, resetRuntimeConfigCacheForTest } = await import("../../src/runtime-config.ts");
const { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } = await import("../../src/codex/index.ts");
const { CODEX_ACCOUNT_ROUTING_KV_KEY, CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY } =
  await import("../../src/codex/account-routing.ts");
const { fetchMeteredModels, resetMeteredModelsCacheForTest } = await import("../../src/provider/metered.ts");
const { resetSurplusModelsCacheForTest } = await import("../../src/provider/surplus.ts");
const { getCodexProviderHealth, resetProviderHealthThrottleForTest } = await import("../../src/provider/health.ts");

const MODEL = "gpt-5-kv-budget";
const now = Date.now();
const runtime = {
  version: 2,
  default_model: MODEL,
  default_reasoning_effort: "medium",
  codex_models: {
    source: "chatgpt_codex",
    client_version: "0.150.0",
    updated_at_ms: now,
    models: [
      {
        slug: MODEL,
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["none", "low", "medium", "high"],
      },
    ],
  },
  updated_at_ms: now,
};
const codexAuthPool = (accountCount = 1) => ({
  accounts: Array.from({ length: accountCount }, (_, index) => ({
    access_token: `access-${index + 1}`,
    refresh_token: `refresh-${index + 1}`,
    account_id: `acct-${index + 1}`,
    updated_at_ms: Date.now(),
  })),
  updated_at_ms: Date.now(),
});

const seedKey = async (token: string, id: string, limit: number) => {
  const hash = await sha256Base64Url(token);
  const record = {
    id,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: limit,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    usage_quota_version: 3 as const,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  kv.values.set(encodeKey(["ubq_ai", "api_keys", "hash", hash]), record);
  return { hash, record };
};

const seedPaidFallbackKey = async (token: string, id: string) => {
  const hash = await sha256Base64Url(token);
  const resetAtMs = Date.now() + 60_000;
  const policy = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: resetAtMs,
    window_ms: 60_000,
    usage_quota_version: 3 as const,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 1_000_000,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  kv.values.set(encodeKey(["ubq_ai", "api_keys", "hash", hash]), { id, ...policy });
  kv.values.set(encodeKey(["ubq_ai", "api_keys", "id", id]), {
    id,
    name: "First fallback quota",
    prefix: token.slice(0, 12),
    hash,
    created_at_ms: Date.now(),
    ...policy,
    paid_fallback_model_ids: [MODEL],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { [MODEL]: 250_000 },
    paid_fallback_pricing_checked_at_ms: Date.now(),
  });
  return { hash, record: { id, ...policy } };
};

const request = (token: string): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: "ping" }),
  });

const streamingRequest = (token: string, route: "responses" | "chat"): Request =>
  new Request(route === "responses" ? "https://ai.ubq.fi/v1/responses" : "https://ai.ubq.fi/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(route === "responses" ? { input: "ping", stream: true } : { messages: [{ role: "user", content: "ping" }], stream: true }),
  });

const fetchInputUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const completedSseEvent = (inputTokens = 1, outputTokens = 1): string =>
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      model: MODEL,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "fixture output" }],
        },
      ],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    },
  })}\n\n`;

// Responses precommit now waits for semantic output before returning a
// provider stream to the caller. These fixtures intentionally keep the
// upstream open so the tests can exercise completion, truncation, and
// cancellation after dispatch; emit a small semantic delta before that
// lifecycle action instead of leaving the stream at setup-only response.created.
const semanticSseEvent = (text = "fixture output"): string => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;

const sse = (usage: Record<string, unknown> = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }): Response =>
  new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        model: MODEL,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "fixture output" }],
          },
        ],
        usage,
      },
    })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );

const authoritativeCodexQuotaResponse = (): Response =>
  new Response(JSON.stringify({ error: { message: "Primary limited", type: "usage_limit_reached" } }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": new Date((Math.floor(Date.now() / 1_000) + 60) * 1_000).toUTCString(),
    },
  });

// A completion latch whose `resolve()` takes no value. It is deliberately not
// generic: `deferred<void>()` would spell `void` at a call-site type-argument
// position, which @typescript-eslint/no-invalid-void-type rejects, and `void` is
// the only instantiation these tests use.
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const usageWindow = (
  policy: NonNullable<ReturnType<typeof apiKeyPolicyFromHashRecord>>
): { committed_requests: number; reserved_requests: number; window_reset_at_ms: number } => {
  const value = kv.values.get(encodeKey(apiKeyUsageV3WindowKey(policy)));
  assert.ok(value, "V3 aggregate must exist");
  const window = value as { committed_requests: number; reserved_requests: number; window_reset_at_ms: number };
  return {
    committed_requests: window.committed_requests,
    reserved_requests: window.reserved_requests,
    window_reset_at_ms: window.window_reset_at_ms,
  };
};

const prepareApiKeyInference = async (tokenDigit: string, keyId: string, limit: number) => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${tokenDigit.repeat(64)}`;
  const { hash, record } = await seedKey(token, keyId, limit);
  const policy = apiKeyPolicyFromHashRecord(hash, record, Date.now());
  assert.ok(policy);
  return { token, hash, record, policy };
};

const kernelTestKeyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"]
);

const seedKernelTestPublicKey = async (): Promise<void> => {
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", kernelTestKeyPair.publicKey));
  kv.values.set(encodeKey(["uos_ai", "kernel_pubkeys"]), [{ pem: toPublicKeyPem(publicKey) }]);
};

const makeKernelTestToken = async (apiToken: string, owner: string, repo: string): Promise<string> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = encodeJsonBase64Url({ alg: "RS256", typ: "JWT" });
  const payload = encodeJsonBase64Url({
    iss: "ubiquity-os-kernel",
    aud: "ai.ubq.fi",
    iat: nowSeconds,
    exp: nowSeconds + 600,
    jti: `jti_${crypto.randomUUID()}`,
    owner,
    repo,
    installation_id: null,
    auth_token_sha256: await sha256Base64Url(apiToken),
    state_id: `state_${crypto.randomUUID()}`,
  });
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kernelTestKeyPair.privateKey, textEncoder.encode(signingInput)));
  return `${signingInput}.${encodeBase64Url(signature)}`;
};

const withKernelTestToken = async (request: Request, apiToken: string, owner: string, repo: string): Promise<Request> => {
  const headers = new Headers(request.headers);
  headers.set("X-Ubiquity-Kernel-Token", await makeKernelTestToken(apiToken, owner, repo));
  return new Request(request, { headers });
};

// Helpers that lived between tests in the original file.

const seedKernelDefaultLimit = (limit: number, windowMs = 60_000): void => {
  kv.values.set(encodeKey(DEFAULT_KERNEL_POLICY_LIMIT_KEY), limit);
  kv.values.set(encodeKey(DEFAULT_KERNEL_POLICY_WINDOW_KEY), windowMs);
};

const validStreamingSse = (): Response =>
  new Response(`data: ${JSON.stringify({ type: "response.created", response: { id: crypto.randomUUID() } })}\n\n` + semanticSseEvent() + completedSseEvent(), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

const requiredTerminalTiming = (terminal: Record<string, unknown>, field: string): number => {
  const value = terminal[field];
  if (typeof value !== "number") assert.fail(`${field} must be a number`);
  assert.ok(Number.isFinite(value), `${field} must be finite`);
  assert.ok(value >= 0, `${field} must be nonnegative`);
  return value;
};

const assertOrderedTerminalTimings = (terminal: Record<string, unknown>, expectsDownstreamDrain: boolean): void => {
  const ordered = [
    "first_codex_dispatch_ms",
    "first_codex_headers_ms",
    "first_upstream_sse_event_ms",
    "first_semantic_commitment_ms",
    "stream_terminal_ms",
    "latency_ms",
  ].map((field) => requiredTerminalTiming(terminal, field));
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(ordered[index - 1] <= ordered[index], "terminal timing fields must be ordered");
  }
  if (!expectsDownstreamDrain) {
    assert.equal(terminal.downstream_drain_ms, null);
    return;
  }
  const downstreamDrain = requiredTerminalTiming(terminal, "downstream_drain_ms");
  assert.ok(ordered[4] + downstreamDrain <= ordered[5]);
};

export {
  API_KEY_USAGE_V3_REQUEST_PREFIX,
  ApiKeyQuotaDispatchError,
  CODEX_AUTH_POOL_KV_KEY,
  CountingKv,
  DEFAULT_KERNEL_POLICY_LIMIT_KEY,
  DEFAULT_KERNEL_POLICY_WINDOW_KEY,
  KERNEL_QUOTA_RESERVATION_LEASE_MS,
  MODEL,
  PASSKEY_RELAY_COOKIE_NAME,
  RUNTIME_CONFIG_CACHE_TTL_MS,
  RUNTIME_CONFIG_V2_KEY,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  assertOrderedTerminalTimings,
  authenticateAdmin,
  authenticateApiKeyToken,
  authenticateClient,
  authoritativeCodexQuotaResponse,
  codexAuthPool,
  completedSseEvent,
  createRequestDeliveryLifecycle,
  deferred,
  deleteKernelOrgUsageLimit,
  encodeBase64Url,
  encodeJsonBase64Url,
  encodeKey,
  fetchInputUrl,
  fetchMeteredModels,
  getCodexProviderHealth,
  handleAdminDefaults,
  handleResponses,
  invalidateApiKeyPolicy,
  isApiKeyV3DispatchMutation,
  isKernelReservationMutation,
  isKernelSettlementMutation,
  isSumMutation,
  kernelOrgReservationKey,
  kernelOrgWindowKey,
  kernelRepoPolicyKey,
  kernelTestKeyPair,
  kv,
  kvFingerprint,
  loadRuntimeConfig,
  makeApiKeyUsageWindowV3,
  makeKernelTestToken,
  now,
  paidFallbackRequestV3Key,
  passkeySessionKey,
  passkeyUserKey,
  prepareApiKeyInference,
  request,
  requiredTerminalTiming,
  reserveApiKeyUsageV3,
  reserveEffectiveKernelUsageLimit,
  reserveKernelOrgUsageLimit,
  resetApiKeyPolicyCacheForTest,
  resetCodexAuthCacheForTest,
  resetMeteredModelsCacheForTest,
  resetProviderHealthThrottleForTest,
  resetRuntimeConfigCacheForTest,
  resetSurplusModelsCacheForTest,
  runtime,
  seedKernelDefaultLimit,
  seedKernelTestPublicKey,
  seedKey,
  seedPaidFallbackKey,
  semanticSseEvent,
  setKernelOrgUsageLimit,
  setKernelUsageLimit,
  setPaidFallbackTerminalSweepForTest,
  setProviderCapacitySampleTriggerForTest,
  setStreamFirstEventDeadlineMsForTest,
  sse,
  streamingRequest,
  textEncoder,
  toPublicKeyPem,
  usageWindow,
  validStreamingSse,
  waitFor,
  withKernelTestToken,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  handler,
};
export type { CountingKvMutation };
export { sha256Hex } from "../../src/utils.ts";
export { sha256Base64Url } from "../../src/utils.ts";

/** Reinstall this fixture explicitly when a Bun test file uses the cached harness. */
export const installHarness = (): void => {
  setProviderCapacitySampleTriggerForTest(() => {});
  setPaidFallbackTerminalSweepForTest(() => {});
  setKvForTest(kv as unknown as Kv);
};
export const resetHarness = (): void => {
  kv.values.clear();
  installHarness();
};
export const cleanupHarness = (): void => {
  setProviderCapacitySampleTriggerForTest(null);
  setPaidFallbackTerminalSweepForTest(null);
  setKvForTest(null);
};
