import type { Kv, KvEntry, KvEntryMaybe, KvKey, KvListOptions, KvListSelector } from "#kv";
// Shared harness for the openai-compat suites: module imports, the KV stub,
// fixtures and the SSE/fetch helpers that every part imports.

import assert from "node:assert/strict";

// This suite asserts exact fetch and KV budgets, so the event-driven maintenance
// hooks must not run in the background while it measures them.
export const { setProviderCapacitySampleTriggerForTest } = await import("../../src/provider/capacity-events.ts");
export const { setPaidFallbackTerminalSweepForTest } = await import("../../src/paid-fallback/index.ts");
import type { CodexBankedResetConfig } from "../../src/codex/banked-reset.ts";
import type { CodexUsageResetProvider } from "../../src/codex/banked-reset-provider.ts";
import type { CodexAuthPoolState } from "../../src/types.ts";
import { DEFAULT_MODEL_KEY, DEFAULT_REASONING_EFFORT_KEY } from "../../src/defaults.ts";
import { setKvForTest } from "../../src/kv.ts";

export const keyToString = (key: KvKey): string => JSON.stringify(key);
export const DEFAULT_TEST_MODEL = "gpt-5-fixture-default";
export const TERRA_TEST_MODEL = "gpt-5.6-terra";
export const TEMPORARY_FREE_SURPLUS_TEST_MODEL = "glm-5.2";
export const TEST_CODEX_MODELS_KEY = ["ubq_ai", "codex_models"] as const;

export const kvStore = new Map<string, unknown>();
export type OpenAiAtomicOp = { type: "set" | "delete"; key: KvKey; value?: unknown };
export let atomicCommitFailure: ((ops: readonly OpenAiAtomicOp[]) => Error | null) | null = null;
export const atomicCommitObservation: {
  observer: ((ops: readonly OpenAiAtomicOp[]) => void) | null;
} = { observer: null };
export let exposePaidFallbackLedgerEntries = false;

export const setAtomicCommitFailure = (value: ((ops: readonly OpenAiAtomicOp[]) => Error | null) | null): void => {
  atomicCommitFailure = value;
};

export const setExposePaidFallbackLedgerEntries = (value: boolean): void => {
  exposePaidFallbackLedgerEntries = value;
};
kvStore.set(keyToString(DEFAULT_REASONING_EFFORT_KEY), "low");
kvStore.set(keyToString(["ubq_ai", "codex_auth"]), {
  accounts: [
    {
      access_token: "access",
      refresh_token: "refresh",
      account_id: "acct",
      updated_at_ms: Date.now(),
    },
  ],
  updated_at_ms: Date.now(),
});
kvStore.set(keyToString(TEST_CODEX_MODELS_KEY), {
  source: "chatgpt_codex",
  client_version: "0.125.0",
  updated_at_ms: Date.now(),
  models: [
    {
      slug: DEFAULT_TEST_MODEL,
      display_name: "GPT-5 Fixture Default",
      context_window: 272000,
      max_context_window: 1000000,
      auto_compact_token_limit: null,
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
      reasoning_effort_wire_map: { ultra: "max" },
    },
    {
      slug: TERRA_TEST_MODEL,
      display_name: "GPT-5.6 Terra fixture",
      context_window: 272000,
      max_context_window: 1000000,
      auto_compact_token_limit: null,
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
      reasoning_effort_wire_map: { ultra: "max" },
    },
  ],
});
kvStore.set(keyToString(["uos_ai", "voyage_api_key"]), "voyage_test_key");

export const kvStub = {
  get: (key: KvKey) =>
    Promise.resolve({
      key,
      value: kvStore.get(keyToString(key)) ?? null,
      versionstamp: kvStore.has(keyToString(key)) ? "00000000000000000001" : null,
    } as KvEntryMaybe<unknown>),
  getMany: (keys: readonly KvKey[]) =>
    Promise.resolve(
      keys.map((key) => ({
        key,
        value: kvStore.get(keyToString(key)) ?? null,
        versionstamp: kvStore.has(keyToString(key)) ? "00000000000000000001" : null,
      }))
    ),
  set: (key: KvKey, value: unknown) => {
    kvStore.set(keyToString(key), value);
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: function* (selector: KvListSelector, _options?: KvListOptions) {
    if (!exposePaidFallbackLedgerEntries || !("prefix" in selector)) return;
    for (const [encoded, value] of kvStore) {
      const key = JSON.parse(encoded) as KvKey;
      if (!selector.prefix.every((part, index) => key[index] === part)) continue;
      yield { key, value, versionstamp: "00000000000000000001" } as KvEntry<unknown>;
    }
  },
  atomic: () => {
    const ops: OpenAiAtomicOp[] = [];
    const chain = {
      check: () => chain,
      set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
        ops.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        const failure = atomicCommitFailure?.(ops) ?? null;
        if (failure) return Promise.reject(failure);
        atomicCommitObservation.observer?.(ops.slice());
        for (const op of ops) {
          if (op.type === "set") kvStore.set(keyToString(op.key), op.value);
          else kvStore.delete(keyToString(op.key));
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

export const { extractUsageTokens, getResponseTelemetry } = await import("../../src/openai-telemetry.ts");
export const { isAnswerBearingCompletion } = await import("../../src/upstream-wire.ts");
export const { setCodexBankedResetOptionsForTest } = await import("../../src/openai.ts");
export const { handleResponses } = await import("../../src/responses-handler.ts");
export const { handleChatCompletions } = await import("../../src/chat/envelope.ts");
export const { handleModelCapabilities, handleModels, handlePublicModelCatalog } = await import("../../src/models/catalog.ts");
export const { fetchMeteredModels, METERED_MODELS_CACHE_TTL_MS, resetMeteredModelsCacheForTest, setMeteredModelsFetchForTest } =
  await import("../../src/provider/metered.ts");
export const { fetchSurplusModels, resetSurplusModelsCacheForTest, SURPLUS_MODELS_CACHE_TTL_MS } = await import("../../src/provider/surplus.ts");
export const { ApiKeyQuotaDispatchError } = await import("../../src/api-key-policy.ts");
export const { withCors } = await import("../../src/http.ts");
export const { default: gatewayHandler } = await import("../../src/handler/index.ts");
export const { withTerminalRequestLog } = await import("../../src/handler/terminal-log.ts");
export const { resetRuntimeConfigCacheForTest } = await import("../../src/runtime-config.ts");
export const { buildFailoverWarningEvents } = await import("../../src/responses-failover-stream.ts");
export const { DEBUG_ROUTING_KEY, resetDebugRoutingCacheForTest } = await import("../../src/debug-routing.ts");
export const { setRemovedProviderApiKeyForTest, setRemovedProviderTestAdapterForTest } = await import("../../src/paid-fallback/removed-provider.ts");
export const { CODEX_AUTH_REAUTH_MESSAGE, CODEX_AUTH_REAUTH_WARNING, resetCodexAuthCacheForTest } = await import("../../src/codex/index.ts");
export const { attemptCodexBankedReset } = await import("../../src/codex/banked-reset-submission.ts");
export const {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  getCodexQuotaBlockFence,
  isCodexQuotaBlockFenceCurrent,
  markCodexQuotaBlocked,
  markCodexUpstreamTimeout,
  resetCodexAccountRoutingForTest,
  selectCodexRoutingAccounts,
} = await import("../../src/codex/account-routing.ts");
export const { projectCerebrasToolSchema, setCerebrasFetchTimeoutMsForTest } = await import("../../src/provider/cerebras.ts");
export const { DEEPSEEK_CHAT_COMPLETIONS_URL, DEEPSEEK_FLASH_MODEL, DEEPSEEK_V4_FLASH_MODEL, projectDeepSeekRequest, setDeepSeekFetchTimeoutMsForTest } =
  await import("../../src/deepseek/index.ts");
export const { recordCodexProviderHealth, resetProviderHealthThrottleForTest, getMeteredProviderHealth, getSurplusProviderHealth } =
  await import("../../src/provider/health.ts");

export const TEXT_ENCODER = new TextEncoder();
export const utf8ByteLength = (value: string): number => TEXT_ENCODER.encode(value).byteLength;

export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T | PromiseLike<T>) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(value: T): void {
    this.#resolve(value);
  }
}

export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export const encodeBase64Url = (bytes: Uint8Array): string => {
  const base64 = encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
  let end = base64.length;
  while (end > 0 && base64[end - 1] === "=") end -= 1;
  return base64.slice(0, end);
};

export const encodeJsonBase64Url = (value: unknown): string => encodeBase64Url(TEXT_ENCODER.encode(JSON.stringify(value)));

export const toPublicKeyPem = (spki: Uint8Array): string => {
  const b64 = encodeBase64(spki);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
};
export const sseResponse = (chunks: string[]): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(TEXT_ENCODER.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

export const baseSseChunks = () => [
  `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", created_at: 0 } })}\n\n`,
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "pong" })}\n\n`,
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      model: DEFAULT_TEST_MODEL,
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  })}\n\n`,
];

export const authoritativeCodexQuotaResponse = (headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  responseHeaders.set("Retry-After", new Date((Math.floor(Date.now() / 1_000) + 60) * 1_000).toUTCString());
  return new Response(JSON.stringify({ error: { message: "Primary limited", type: "usage_limit_reached" } }), { status: 429, headers: responseHeaders });
};

export const responsesRequest = (body: Record<string, unknown> = {}, signal?: AbortSignal): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true, ...body }),
    signal,
  });

export const parseResponsesSseValues = (value: string): Record<string, unknown>[] =>
  [...value.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]) as Record<string, unknown>);

/** A `POST /v1/responses` request for the DeepSeek adapter fixtures. */
export const deepSeekResponsesRequest = (body: Record<string, unknown>): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Parses the named `event:` frames of a Responses SSE body back into values. */
export const parseResponsesSseEvents = (text: string): Record<string, unknown>[] =>
  text
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => JSON.parse(frame.split("\ndata: ")[1]) as Record<string, unknown>);

/** One normalized DeepSeek Chat SSE chunk frame, as the adapter would receive it. */
export const deepSeekStreamChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}, id = "deepseek-responses-stream"): string =>
  `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1_780_000_101,
    model: DEEPSEEK_FLASH_MODEL,
    choices: [{ index: 0, delta, finish_reason: null, ...extra }],
  })}\n\n`;

/**
 * Chat Completions request for a model-addressed special provider. The
 * deliberately contradictory `x-uos-upstream` header proves model-driven
 * routing wins: the gateway never reads that header from a request.
 */
export const specialProviderChatRequest = (body: Record<string, unknown>, signal?: AbortSignal): Request =>
  new Request("https://ai.ubq.fi/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-uos-upstream": "chatgpt_codex" },
    body: JSON.stringify(body),
    signal,
  });

/** The Responses-route twin of `specialProviderChatRequest`. */
export const specialProviderResponsesRequest = (body: Record<string, unknown>, signal?: AbortSignal): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-uos-upstream": "chatgpt_codex" },
    body: JSON.stringify(body),
    signal,
  });

/** A `void` promise gate: the resolution itself carries no payload. */
export type VoidGate = { promise: Promise<void>; resolve: () => void };

/** Captures a promise executor's `resolve` so a fixture can release a blocked stream pull later. */
export const captureResolve = (gate: { resolve: () => void }): Promise<void> =>
  new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });

/** Parks a stream pull until the test cancels the stream: it never settles. */
export const neverSettlingPromise = (): Promise<void> => new Promise<void>(() => {});

/** Waits `milliseconds` without nesting a promise executor deeper into a stream callback. */
export const delayBy = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Normalizes an abort reason into the Error every fixture rejection must carry. */
export const abortReason = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Upstream request was aborted", { cause: reason });
};

/** Mimics a fetch that only settles once the gateway aborts its request. */
export const rejectOnAbort = (signal: AbortSignal, onAbort?: () => void): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    const rejectWithReason = (): void => {
      onAbort?.();
      reject(abortReason(signal));
    };
    if (signal.aborted) rejectWithReason();
    else signal.addEventListener("abort", rejectWithReason, { once: true });
  });

/** Slices the recorded atomic commits that wrote one key. */
export const atomicWritesForKey = (commits: readonly OpenAiAtomicOp[][], key: KvKey): OpenAiAtomicOp[] =>
  commits.flatMap((operations) => operations.filter((operation) => operation.type === "set" && keyToString(operation.key) === keyToString(key)));

/** Deletes every provider-health record this fixture wrote for `accountId`. */
export const clearProviderHealthKeysFor = (accountId: string): void => {
  for (const encoded of [...kvStore.keys()]) {
    const key = JSON.parse(encoded) as unknown[];
    const isFixtureKey = key[0] === "uos_ai" && key[1] === "provider_health" && key[2] === "v1" && key[3] === "codex" && key[4] === accountId;
    if (isFixtureKey) kvStore.delete(encoded);
  }
};

export const seedPaidFallbackKey = (
  id: string,
  options: {
    enabled?: boolean;
    limitMicrocredits?: number;
    spentMicrocredits?: number;
    reservedMicrocredits?: number;
    reservationRequestId?: string | null;
    modelIds?: readonly string[];
    v3SettledMicrocredits?: number;
  } = {}
): void => {
  kvStore.delete(keyToString(CODEX_ACCOUNT_ROUTING_KV_KEY));
  resetCodexAccountRoutingForTest();
  resetCodexAuthCacheForTest();
  const now = Date.now();
  const windowMs = 60_000;
  const windowResetAtMs = now + windowMs;
  const limitMicrocredits = options.limitMicrocredits ?? 1_000_000;
  const pricingCheckedAtMs = now;
  const hash = `hash-${id}`;
  const common = {
    paid_fallback_enabled: options.enabled ?? true,
    paid_fallback_limit_microcredits: limitMicrocredits,
    paid_fallback_spent_microcredits: options.spentMicrocredits ?? 0,
    paid_fallback_reserved_microcredits: options.reservedMicrocredits ?? 0,
    paid_fallback_reservation_request_id: options.reservationRequestId ?? null,
  };
  kvStore.set(keyToString(["ubq_ai", "api_keys", "id", id]), {
    id,
    name: `Key ${id}`,
    prefix: "u_test",
    hash,
    created_at_ms: now,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: windowResetAtMs,
    window_ms: windowMs,
    ...common,
    paid_fallback_model_ids: options.modelIds ?? [DEFAULT_TEST_MODEL],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { [DEFAULT_TEST_MODEL]: 250_000 },
    paid_fallback_pricing_checked_at_ms: pricingCheckedAtMs,
  });
  kvStore.set(keyToString(["ubq_ai", "api_keys", "hash", hash]), {
    id,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: windowResetAtMs,
    window_ms: windowMs,
    ...common,
  });
  if (options.v3SettledMicrocredits !== undefined) {
    kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "window", id, windowResetAtMs]), {
      v: 3,
      key_id: id,
      policy_version: `${windowMs}:${pricingCheckedAtMs}`,
      window_reset_at_ms: windowResetAtMs,
      limit_microcredits: limitMicrocredits,
      settled_microcredits: options.v3SettledMicrocredits,
      reserved_microcredits: 0,
      pending_count: 0,
      updated_at_ms: now,
    });
  }
};

export type StoredPaidFallbackRequest = {
  dispatch_state?: string;
  terminal_state?: string;
  billing_state?: string;
  provider?: string;
  provider_request_id?: string | null;
  reconciliation_attempts?: number;
};

export const getStoredPaidFallbackRequest = (keyId: string, requestId: string): StoredPaidFallbackRequest | null =>
  (kvStore.get(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, requestId])) as StoredPaidFallbackRequest | undefined) ?? null;

export const waitForPaidFallbackTerminal = async (keyId: string, requestId: string, expected: string): Promise<StoredPaidFallbackRequest> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = getStoredPaidFallbackRequest(keyId, requestId);
    if (request?.terminal_state === expected) return request;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const request = getStoredPaidFallbackRequest(keyId, requestId);
  assert.fail(`Expected ${keyId}/${requestId} terminal_state=${expected}, received ${request?.terminal_state ?? "missing"}`);
};

export const parseWarnings = (value: string | null): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

export const extractResponseOutputText = (payload: Record<string, unknown>): string => {
  const output = payload.output;
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const part = contentItem as { type?: unknown; text?: unknown };
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("");
};

export type FetchMockQueue = {
  chain: Promise<void>;
};

export const fetchMockQueue: FetchMockQueue = (() => {
  const key = "__uosFetchMockQueue";
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const existing = globalRecord[key];
  if (existing && typeof existing === "object") {
    const chain = (existing as { chain?: unknown }).chain;
    if (chain instanceof Promise) return existing as FetchMockQueue;
  }
  const created: FetchMockQueue = { chain: Promise.resolve() };
  globalRecord[key] = created;
  return created;
})();

export const withFetchMock = async <T>(
  handler: (url: string, bodyText: string | null, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>
): Promise<T> => {
  const prev = fetchMockQueue.chain;
  let release = () => {};
  fetchMockQueue.chain = new Promise<void>((resolve) => {
    release = () => {
      resolve(undefined);
    };
  });
  await prev;

  const snapshot = kvStore.get(keyToString(TEST_CODEX_MODELS_KEY)) as
    { models?: (Record<string, unknown> & { slug?: string })[]; source?: string; updated_at_ms?: number; client_version?: string } | undefined;
  if (snapshot?.models?.length) {
    const explicitDefault = kvStore.get(keyToString(DEFAULT_MODEL_KEY));
    const storedReasoningEffort = kvStore.get(keyToString(DEFAULT_REASONING_EFFORT_KEY));
    kvStore.set(keyToString(["uos_ai", "runtime_config", "v2"]), {
      version: 2,
      default_model: typeof explicitDefault === "string" ? explicitDefault : (snapshot.models[0]?.slug ?? DEFAULT_TEST_MODEL),
      default_reasoning_effort: typeof storedReasoningEffort === "string" ? storedReasoningEffort : "low",
      codex_models: snapshot,
      updated_at_ms: Date.now(),
    });
  } else {
    kvStore.delete(keyToString(["uos_ai", "runtime_config", "v2"]));
  }
  resetRuntimeConfigCacheForTest();
  // Each mocked exchange is an independent gateway isolate/request fixture.
  // Circuit behavior itself is covered by codex-account-routing.test.ts.
  kvStore.delete(keyToString(["uos_ai", "codex_account_routing", "v2"]));
  resetCodexAuthCacheForTest();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      let url: string;
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.toString();
      else url = input.url;
      const bodyText = typeof init?.body === "string" ? init.body : null;
      return await handler(url, bodyText, init);
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    release();
  }
};

export const clearBankedResetRecords = (): void => {
  for (const encodedKey of [...kvStore.keys()]) {
    const key = JSON.parse(encodedKey) as unknown[];
    if (key[0] === "uos_ai" && key[1] === "codex_reset_redemption") kvStore.delete(encodedKey);
  }
};

export const liveBankedResetFixtureConfig = (): CodexBankedResetConfig => ({
  enabled: true,
  mode: "live",
  maxPerAccountPerDay: 1,
  maxPerAccountPerWindow: 1,
});

export const createVerifiedBankedResetFixture = async (): Promise<readonly string[]> => {
  const authPool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as CodexAuthPoolState;
  const now = Date.now();
  const selection = await selectCodexRoutingAccounts(authPool, authPool.accounts, now, DEFAULT_TEST_MODEL);
  if (selection.kind !== "eligible") throw new Error(`Expected an eligible fixture account, got ${selection.kind}.`);
  const routing = selection.accounts[0];
  // A banked reset requires the complete cohort to be authoritatively
  // exhausted, so every configured account receives the stable quota fence.
  let blockedResetAtMs: number | null = null;
  for (const account of selection.accounts) {
    const blocked = await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(now + 60_000).toUTCString() },
      }),
      now
    );
    if (!blocked.usageLimitReached || blocked.retryAtMs === null) {
      throw new Error("Expected a durable usage-limit quota fence.");
    }
    blockedResetAtMs ??= blocked.retryAtMs;
  }
  if (blockedResetAtMs === null) throw new Error("Expected at least one blocked account.");
  const routingGeneration = await getCodexQuotaBlockFence(routing, blockedResetAtMs);
  if (routingGeneration === null) throw new Error("Expected the durable quota fence to be readable.");
  const quotaResetAtMs = blockedResetAtMs;

  const calls: string[] = [];
  const provider: CodexUsageResetProvider = {
    contract: {
      idempotency: { callerSupplied: true, retentionMs: 86_400_000 },
      lookup: { byIdempotencyKey: true, byProviderReceiptId: true },
      verification: { independentlyVerifiable: true },
      receiptIdsSafeToPersistAndLog: true,
      supportedResetTypes: ["codex_rate_limits"],
    },
    readInventory: () => {
      calls.push("inventory");
      return Promise.resolve({
        availableCount: 1,
        observedAtMs: now,
        credits: [{ id: "fixture-credit", status: "available", resetType: "codex_rate_limits", expiresAtMs: null }],
      });
    },
    redeem: () => {
      calls.push("redeem");
      return Promise.resolve({ kind: "completed", providerReceiptId: "fixture-receipt" } as const);
    },
    lookup: () => {
      calls.push("lookup");
      return Promise.resolve({ kind: "completed", providerReceiptId: "fixture-receipt" } as const);
    },
    verifyApplied: () => {
      calls.push("verify");
      return Promise.resolve(true);
    },
  };
  const reset = await attemptCodexBankedReset(
    {
      accountId: routing.auth.account_id,
      credentialVersion: routing.credentialVersion,
      quotaResetAtMs: blockedResetAtMs,
      routingGeneration,
      fences: [
        {
          key: CODEX_ACCOUNT_ROUTING_KV_KEY,
          isCurrent: (value) => isCodexQuotaBlockFenceCurrent(value, routing, quotaResetAtMs, routingGeneration),
        },
      ],
      requestId: "openai-compat-verified-reset-fixture",
    },
    {
      config: liveBankedResetFixtureConfig(),
      provider,
      kv: kvStub,
      now: () => now,
      newOwnerToken: () => "openai-compat-verified-reset-owner",
    }
  );
  assert.equal(reset.kind, "verified");
  assert.equal(reset.record?.routing_generation, routingGeneration);
  return calls;
};

/**
 * This creates a durable ambiguous transaction using only an in-memory fake.
 * The public handlers deliberately keep the shipped provider unavailable, so
 * their recovery-only path must return the ordinary quota error without ever
 * committing a successful response stream.
 */
export const createUnknownBankedResetFixture = async (): Promise<readonly string[]> => {
  const authPool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as CodexAuthPoolState;
  const now = Date.now();
  const selection = await selectCodexRoutingAccounts(authPool, authPool.accounts, now, DEFAULT_TEST_MODEL);
  if (selection.kind !== "eligible") throw new Error(`Expected an eligible fixture account, got ${selection.kind}.`);
  const routing = selection.accounts[0];
  // Recovery-only evaluation needs the complete cohort authoritatively
  // exhausted; a partial cohort would be served by ordinary capacity instead.
  let blockedResetAtMs: number | null = null;
  for (const account of selection.accounts) {
    const blocked = await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(now + 60_000).toUTCString() },
      }),
      now
    );
    if (!blocked.usageLimitReached || blocked.retryAtMs === null) {
      throw new Error("Expected a durable usage-limit quota fence.");
    }
    blockedResetAtMs ??= blocked.retryAtMs;
  }
  if (blockedResetAtMs === null) throw new Error("Expected at least one blocked account.");
  const routingGeneration = await getCodexQuotaBlockFence(routing, blockedResetAtMs);
  if (routingGeneration === null) throw new Error("Expected the durable quota fence to be readable.");
  const quotaResetAtMs = blockedResetAtMs;

  const calls: string[] = [];
  const provider: CodexUsageResetProvider = {
    contract: {
      idempotency: { callerSupplied: true, retentionMs: 86_400_000 },
      lookup: { byIdempotencyKey: true, byProviderReceiptId: true },
      verification: { independentlyVerifiable: true },
      receiptIdsSafeToPersistAndLog: true,
      supportedResetTypes: ["codex_rate_limits"],
    },
    readInventory: () => {
      calls.push("inventory");
      return Promise.resolve({
        availableCount: 1,
        observedAtMs: now,
        credits: [{ id: "fixture-credit", status: "available", resetType: "codex_rate_limits", expiresAtMs: null }],
      });
    },
    redeem: () => {
      calls.push("redeem");
      return Promise.resolve({ kind: "unknown", providerReceiptId: null } as const);
    },
    lookup: () => {
      calls.push("lookup");
      return Promise.resolve({ kind: "unknown", providerReceiptId: null } as const);
    },
    verifyApplied: () => {
      calls.push("verify");
      return Promise.resolve(false);
    },
  };
  const reset = await attemptCodexBankedReset(
    {
      accountId: routing.auth.account_id,
      credentialVersion: routing.credentialVersion,
      quotaResetAtMs: blockedResetAtMs,
      routingGeneration,
      fences: [
        {
          key: CODEX_ACCOUNT_ROUTING_KV_KEY,
          isCurrent: (value) => isCodexQuotaBlockFenceCurrent(value, routing, quotaResetAtMs, routingGeneration),
        },
      ],
      requestId: "openai-compat-unknown-reset-fixture",
    },
    {
      config: liveBankedResetFixtureConfig(),
      provider,
      kv: kvStub,
      now: () => now,
      newOwnerToken: () => "openai-compat-unknown-reset-owner",
    }
  );
  assert.equal(reset.kind, "pending");
  assert.equal(reset.record?.state, "unknown");
  return calls;
};

export type { CodexBankedResetConfig } from "../../src/codex/banked-reset.ts";
export type { CodexUsageResetProvider } from "../../src/codex/banked-reset-provider.ts";
export type { CodexAuthPoolState } from "../../src/types.ts";
export { DEFAULT_MODEL_KEY, DEFAULT_REASONING_EFFORT_KEY } from "../../src/defaults.ts";
export { setStreamFirstEventDeadlineMsForTest } from "../../src/inference-deadline.ts";
export { setPaidProviderFirstHeadersDeadlineMsForTest } from "../../src/inference-deadline.ts";
export { readPromptCacheAnalytics } from "../../src/cache/prompt-analytics.ts";
export { sha256Base64Url } from "../../src/utils.ts";
export { RELEASE_GIT_SHA } from "../../src/release.ts";
export { MAX_RESPONSES_SSE_EVENT_BYTES } from "../../src/responses-stream.ts";
export { sha256Hex } from "../../src/utils.ts";
export { recordPromptCacheAnalytics } from "../../src/cache/prompt-analytics.ts";
export { CountingKv } from "./counting-kv.ts";
export { setKvForTest } from "../../src/kv.ts";

// Helpers that lived between tests in the original file.

export const seedPaidReasoningProvider = async (provider: "surplus" | "metered"): Promise<void> => {
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  if (provider === "surplus") {
    delete process.env.METERED_API_KEY;
    process.env.SURPLUS_API_KEY = "surplus-test-key";
    await fetchSurplusModels({
      apiKey: "surplus-test-key",
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: DEFAULT_TEST_MODEL,
                pricing: { prompt: 0.000001, completion: 0.000003 },
              },
            ],
          })
        ),
    });
  } else {
    process.env.METERED_API_KEY = "metered-test-key";
    delete process.env.SURPLUS_API_KEY;
    await fetchMeteredModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai", "openai-response"] }],
          })
        ),
    });
  }
};

/** Mutable state shared with the paid-provider reasoning-progress stream fixture. */

export type ReasoningProgressState = {
  stopped: boolean;
  semanticEmitted: boolean;
  upstreamCancellations: number;
};

/** Builds the upstream SSE body that emits hidden reasoning before its semantic output. */

export const reasoningProgressUpstreamResponse = (
  state: ReasoningProgressState,
  ids: { provider: string; route: string; delivery: string; requestId: string },
  reasoningObserved: VoidGate,
  semanticGate: VoidGate
): Response => {
  const responseId = `resp_${ids.provider}_${ids.route}_${ids.delivery}`;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (value: Record<string, unknown>): void => {
          if (!state.stopped) controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(value)}\n\n`));
        };
        enqueue({
          type: "response.created",
          response: { id: responseId, object: "response", status: "in_progress", output: [] },
        });
        enqueue({
          type: "response.reasoning_summary_text.delta",
          response_id: responseId,
          item_id: `reasoning_${responseId}`,
          output_index: 0,
          summary_index: 0,
          delta: "recognized hidden reasoning progress",
        });
        reasoningObserved.resolve();

        void semanticGate.promise.then(() => {
          if (state.stopped) return;
          state.semanticEmitted = true;
          enqueue({
            type: "response.output_text.delta",
            response_id: responseId,
            item_id: `message_${responseId}`,
            output_index: 0,
            content_index: 0,
            delta: "paid progress complete",
          });
          enqueue({
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              model: DEFAULT_TEST_MODEL,
              output: [
                {
                  id: `message_${responseId}`,
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: "paid progress complete", annotations: [] }],
                },
              ],
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          });
          state.stopped = true;
          controller.close();
        });
      },
      cancel() {
        state.upstreamCancellations += 1;
        state.stopped = true;
        semanticGate.resolve();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Api-Request-Id": `provider-${ids.requestId}`,
        "X-Oneapi-Request-Id": `provider-${ids.requestId}`,
      },
    }
  );
};

export const runValidatedTerminalCancellationCase = async (testCase: {
  provider: "chatgpt_codex" | "metered";
  route: "responses" | "chat";
  terminalType: "response.completed" | "response.incomplete";
}): Promise<void> => {
  const { provider, route, terminalType } = testCase;
  const suffix = `${provider}-${route}-${terminalType.replace(".", "-")}`;
  const keyId = `fallback-terminal-cancel-${suffix}`;
  const requestId = `request-${keyId}`;
  if (provider === "metered") seedPaidFallbackKey(keyId);
  const terminalState = terminalType === "response.completed" ? "completed" : "incomplete";
  const observedTerminalUsages: { completed: boolean; inputTokens: number | null }[] = [];
  const context = {
    keyId: provider === "metered" ? keyId : null,
    kernelRepo: null,
    kernelOrg: null,
    requestId,
    startedAtMs: Date.now(),
    onTerminalUsage: (usage: { inputTokens: number | null } | null, completed: boolean) => {
      observedTerminalUsages.push({ completed, inputTokens: usage?.inputTokens ?? null });
    },
  };
  const atomicCommits: OpenAiAtomicOp[][] = [];
  const previousAtomicObserver = atomicCommitObservation.observer;
  if (provider === "metered") {
    resetProviderHealthThrottleForTest();
    atomicCommitObservation.observer = (operations) => atomicCommits.push([...operations]);
  }
  try {
    const response = await withFetchMock(
      (url) => {
        if (provider === "metered" && url !== "https://api.openlux.ai/v1/responses") {
          return authoritativeCodexQuotaResponse();
        }
        return new Response(
          sseResponse([
            `data: ${JSON.stringify({
              type: terminalType,
              response: {
                id: `resp_${suffix}`,
                status: terminalState,
                model: DEFAULT_TEST_MODEL,
                output:
                  terminalType === "response.completed"
                    ? [
                        {
                          type: "message",
                          role: "assistant",
                          content: [{ type: "output_text", text: "terminal output" }],
                        },
                      ]
                    : [],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            })}\n\n`,
          ]).body,
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "X-Request-Id": `provider-${suffix}`,
            },
          }
        );
      },
      async () => {
        const response =
          route === "responses"
            ? await handleResponses(
                new Request("https://ai.ubq.fi/v1/responses", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
                }),
                context
              )
            : await handleChatCompletions(
                new Request("https://ai.ubq.fi/v1/chat/completions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: DEFAULT_TEST_MODEL,
                    messages: [{ role: "user", content: "ping" }],
                    stream: true,
                  }),
                }),
                context
              );
        assert.equal(response.status, 200, suffix);
        assert.ok(response.body, suffix);
        await response.body.cancel("client cancelled after upstream terminal");
        return response;
      }
    );
    const telemetry = getResponseTelemetry(response);
    assert.equal(telemetry?.streamTerminalType, terminalType, suffix);
    assert.equal(telemetry.completed, terminalType === "response.completed", suffix);
    assert.deepEqual(
      observedTerminalUsages,
      [
        {
          completed: terminalType === "response.completed",
          inputTokens: 1,
        },
      ],
      suffix
    );
    if (provider === "metered") {
      const stored = await waitForPaidFallbackTerminal(keyId, requestId, terminalState);
      assert.equal(stored.dispatch_state, "dispatched", suffix);
      assert.notEqual(stored.terminal_state, "cancelled", suffix);
      assert.equal(stored.reconciliation_attempts, 1, suffix);

      const paidRequestKey = ["uos_ai", "paid_fallback", "v3", "request", keyId, requestId] as const;
      const terminalWrites = atomicWritesForKey(atomicCommits, paidRequestKey).filter(
        (operation) =>
          typeof operation.value === "object" && operation.value !== null && (operation.value as { terminal_state?: unknown }).terminal_state === terminalState
      );
      assert.equal(terminalWrites.length, 1, `${suffix} terminal ledger transition`);
      assert.equal(
        atomicWritesForKey(atomicCommits, paidRequestKey).filter(
          (operation) =>
            typeof operation.value === "object" && operation.value !== null && (operation.value as { billing_state?: unknown }).billing_state === "settled"
        ).length,
        0,
        `${suffix} has no unexpected settlement`
      );

      const expectedHealthEvent = terminalType === "response.completed" ? "success" : "upstream_error";
      const expectedHealthStatus = terminalType === "response.completed" ? 200 : null;
      const healthKey = ["uos_ai", "provider_health", "v1", "metered", "default", "current"] as const;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const healthWrites = atomicWritesForKey(atomicCommits, healthKey).filter(
          (operation) =>
            typeof operation.value === "object" && operation.value !== null && (operation.value as { event?: unknown }).event === expectedHealthEvent
        );
        if (healthWrites.length === 1) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      const terminalHealthWrites = atomicWritesForKey(atomicCommits, healthKey).filter(
        (operation) => typeof operation.value === "object" && operation.value !== null && (operation.value as { event?: unknown }).event === expectedHealthEvent
      );
      assert.equal(terminalHealthWrites.length, 1, `${suffix} terminal health transition`);
      const health = terminalHealthWrites[0]?.value as { status?: unknown; provider_request_id?: unknown } | undefined;
      assert.equal(health?.status, expectedHealthStatus, suffix);
      assert.equal(health.provider_request_id, `provider-${suffix}`, suffix);
    }
  } finally {
    atomicCommitObservation.observer = previousAtomicObserver;
    if (provider === "metered") resetProviderHealthThrottleForTest();
  }
};

export const withProviderSelection = async <T>(providerIds: readonly string[] | null, run: () => Promise<T>): Promise<T> => {
  const { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } = await import("../../src/provider/selection.ts");
  const encoded = keyToString(PROVIDER_SELECTION_KV_KEY);
  const previous = kvStore.get(encoded);
  if (providerIds === null) kvStore.delete(encoded);
  else kvStore.set(encoded, { provider_ids: [...providerIds], updated_at_ms: Date.now() });
  resetProviderSelectionCacheForTest();
  try {
    return await run();
  } finally {
    if (previous === undefined) kvStore.delete(encoded);
    else kvStore.set(encoded, previous);
    resetProviderSelectionCacheForTest();
  }
};

export const withDiscoveryKeys = async <T>(meteredKey: string | null, run: () => Promise<T>): Promise<T> => {
  const previousMetered = process.env.METERED_API_KEY;
  const previousSurplus = process.env.SURPLUS_API_KEY;
  delete process.env.SURPLUS_API_KEY;
  if (meteredKey === null) delete process.env.METERED_API_KEY;
  else process.env.METERED_API_KEY = meteredKey;
  try {
    return await run();
  } finally {
    if (previousMetered === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = previousMetered;
    if (previousSurplus === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = previousSurplus;
  }
};

export const clearMeteredAndSurplusProviderHealth = (): void => {
  for (const encoded of [...kvStore.keys()]) {
    const key = JSON.parse(encoded) as unknown[];
    if (key[0] === "uos_ai" && key[1] === "provider_health" && key[2] === "v1" && (key[3] === "metered" || key[3] === "surplus")) {
      kvStore.delete(encoded);
    }
  }
};

/** Seeds both paid catalogs for the model the fallthrough fixtures route. */

export const seedPaidFallthroughProviders = async (): Promise<void> => {
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  await fetchMeteredModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai-response"] }],
        })
      ),
  });
  await fetchSurplusModels({
    apiKey: "surplus-fallthrough-test-key",
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: DEFAULT_TEST_MODEL,
              pricing: { prompt: 0.000001, completion: 0.000003 },
            },
          ],
        })
      ),
  });
};

let harnessEnvironment: Map<string, string | undefined> | null = null;

/** Reinstall this fixture explicitly when a Bun test file uses the cached harness. */
export const installHarness = (): void => {
  harnessEnvironment ??= new Map(["METERED_API_KEY", "SURPLUS_API_KEY"].map((name) => [name, process.env[name]]));
  setProviderCapacitySampleTriggerForTest(() => {});
  setPaidFallbackTerminalSweepForTest(() => {});
  setKvForTest(kvStub);
};
export const resetHarness = (): void => {
  setAtomicCommitFailure(null);
  atomicCommitObservation.observer = null;
  setExposePaidFallbackLedgerEntries(false);
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  installHarness();
};
export const cleanupHarness = (): void => {
  for (const [name, value] of harnessEnvironment ?? []) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  harnessEnvironment = null;
  setProviderCapacitySampleTriggerForTest(null);
  setPaidFallbackTerminalSweepForTest(null);
  setKvForTest(null);
};
