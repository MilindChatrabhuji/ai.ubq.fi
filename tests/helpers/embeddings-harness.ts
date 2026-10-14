import { setKvForTest } from "../../src/kv.ts";
import type { Kv, KvEntry, KvEntryMaybe, KvKey, KvListOptions, KvListSelector } from "#kv";
// Shared harness for this suite, moved out of the original test file.

import { DEFAULT_REASONING_EFFORT_KEY } from "../../src/defaults.ts";
import { sha256Hex } from "../../src/utils.ts";

const keyToString = (key: KvKey): string => JSON.stringify(key);
const keyHasPrefix = (key: KvKey, prefix: KvKey): boolean => {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (key[i] !== prefix[i]) return false;
  }
  return true;
};

const compareKeyPart = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return String(a).localeCompare(String(b));
};

const compareKeys = (a: KvKey, b: KvKey): number => {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const diff = compareKeyPart(a[i], b[i]);
    if (diff !== 0) return diff;
  }
  return 0;
};

const kvStore = new Map<string, unknown>();
const kvExpirations = new Map<string, number | undefined>();
const kvVersions = new Map<string, number>();
const VOYAGE_RATE_LIMIT_KEY: KvKey = ["embeddings", "v1", "rate", "voyage"];
const EMBEDDINGS_JOB_TTL_MS = 24 * 60 * 60_000;
const EMBEDDINGS_IDEMPOTENCY_MAX_RESPONSE_CHUNKS = 256;
const EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS = 7 * 24 * 60 * 60_000;
const EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS = EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS + 24 * 60 * 60_000;
const resetVoyageRateLimit = (): void => {
  kvStore.delete(keyToString(VOYAGE_RATE_LIMIT_KEY));
};
type TestInputType = "query" | "document";
type TestDimension = 256 | 512 | 1024 | 2048;
type TestEncodingFormat = "float" | "base64";

const embeddingsProfileKey = (
  inputType: TestInputType = "document",
  dimensions: TestDimension = 1024,
  encodingFormat: TestEncodingFormat = "float",
  truncation = true
): string => JSON.stringify(["voyage-profile-v2", "voyage-4-large", inputType, dimensions, "float", encodingFormat, truncation]);

const embeddingsCacheKey = (
  hash: string,
  inputType: TestInputType = "document",
  dimensions: TestDimension = 1024,
  encodingFormat: TestEncodingFormat = "float",
  truncation = true
): KvKey => ["embeddings", "v2", "cache", embeddingsProfileKey(inputType, dimensions, encodingFormat, truncation), hash];

const embeddingsCacheGlobalIndexKey = (createdAtMs: number, cacheProfileKey: string, hash: string): KvKey => [
  "embeddings",
  "v2",
  "cache_index_global",
  createdAtMs,
  cacheProfileKey,
  hash,
];

const embeddingsJobKey = (tokenHash: string, cacheProfileKey: string, jobId: string): KvKey => ["embeddings", "jobs", "v2", tokenHash, cacheProfileKey, jobId];

const embeddingsJobLookupKey = (tokenHash: string, jobId: string): KvKey => ["embeddings", "jobs", "v2", "lookup", tokenHash, jobId];

const testVector = (dimensions: TestDimension, seed = 0): number[] => Array.from({ length: dimensions }, (_, index) => seed + index / Math.max(1, dimensions));
// Keep these in sync with tests/openai-compat.test.ts so whichever test imports
// src/openai.ts first doesn't change behavior.
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
kvStore.set(keyToString(["ubq_ai", "codex_models"]), {
  source: "chatgpt_codex",
  client_version: "0.125.0",
  updated_at_ms: Date.now(),
  models: [
    {
      slug: "gpt-5-fixture-default",
      display_name: "GPT-5 Fixture Default",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
    },
  ],
});
kvStore.set(keyToString(["uos_ai", "voyage_api_key"]), "voyage_test_key");

const originalVoyageApiKey = process.env["VOYAGEAI_API_KEY"];

let failNextAtomicCommit: ((checks: readonly KvEntryMaybe<unknown>[], ops: readonly { type: string; key: KvKey }[]) => boolean | Error) | null = null;

export const setFailNextAtomicCommit = (value: typeof failNextAtomicCommit): void => {
  failNextAtomicCommit = value;
};

const kvVersionstamp = (rawKey: string): string | null => (kvStore.has(rawKey) ? String(kvVersions.get(rawKey) ?? 1).padStart(20, "0") : null);

const bumpKvVersion = (rawKey: string): void => {
  kvVersions.set(rawKey, (kvVersions.get(rawKey) ?? 0) + 1);
};

const kvStub = {
  get: (key: KvKey) => {
    const rawKey = keyToString(key);
    return Promise.resolve({
      key,
      value: kvStore.get(rawKey) ?? null,
      versionstamp: kvVersionstamp(rawKey),
    } as KvEntryMaybe<unknown>);
  },
  set: (key: KvKey, value: unknown, options?: { expireIn?: number }) => {
    const rawKey = keyToString(key);
    kvStore.set(rawKey, value);
    kvExpirations.set(rawKey, options?.expireIn);
    bumpKvVersion(rawKey);
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    const rawKey = keyToString(key);
    kvStore.delete(rawKey);
    kvExpirations.delete(rawKey);
    bumpKvVersion(rawKey);
    return Promise.resolve();
  },
  list: function* (selector: KvListSelector, options?: KvListOptions) {
    const prefix = "prefix" in selector ? selector.prefix : null;
    if (!prefix) {
      yield* [];
      return;
    }
    const limit = Math.max(0, Math.trunc(options?.limit ?? Infinity));
    const entries: KvEntry<unknown>[] = [];
    for (const [rawKey, value] of kvStore.entries()) {
      let key: unknown;
      try {
        key = JSON.parse(rawKey);
      } catch {
        key = null;
      }
      if (!Array.isArray(key)) continue;
      if (!keyHasPrefix(key as KvKey, prefix)) continue;
      entries.push({ key: key as KvKey, value } as KvEntry<unknown>);
    }
    entries.sort((a, b) => compareKeys(a.key, b.key));
    for (const entry of entries.slice(0, limit)) {
      yield entry;
    }
  },
  atomic: () => {
    const checks: KvEntryMaybe<unknown>[] = [];
    const ops: { type: "set" | "delete"; key: KvKey; value?: unknown; expireIn?: number }[] = [];
    const chain = {
      check: (entry: KvEntryMaybe<unknown>) => {
        checks.push(entry);
        return chain;
      },
      set: (key: KvKey, value: unknown, options?: { expireIn?: number }) => {
        ops.push({ type: "set", key, value, expireIn: options?.expireIn });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        for (const check of checks) {
          if (kvVersionstamp(keyToString(check.key)) !== check.versionstamp) {
            return Promise.resolve({ ok: false } as const);
          }
        }
        if (failNextAtomicCommit) {
          const failure = failNextAtomicCommit(
            checks,
            ops.map((op) => ({ type: op.type, key: op.key }))
          );
          if (failure) {
            failNextAtomicCommit = null;
            if (failure instanceof Error) throw failure;
            return Promise.resolve({ ok: false } as const);
          }
        }
        for (const op of ops) {
          const rawKey = keyToString(op.key);
          if (op.type === "set") {
            kvStore.set(rawKey, op.value);
            kvExpirations.set(rawKey, op.expireIn);
          } else {
            kvStore.delete(rawKey);
            kvExpirations.delete(rawKey);
          }
          bumpKvVersion(rawKey);
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

const { handleUosEmbeddings } = await import("../../src/embeddings/handlers.ts");
const { handleEmbeddingsJobCreate, handleEmbeddingsJobGet } = await import("../../src/embeddings/jobs.ts");
const { getKv } = await import("../../src/kv.ts");

type FetchMockQueue = {
  chain: Promise<void>;
};

const fetchMockQueue: FetchMockQueue = (() => {
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

const requestInputUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const withFetchMock = async <T>(
  handler: (url: string, bodyText: string | null, headers: Headers) => Response | Promise<Response>,
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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestInputUrl(input);
      const bodyText = typeof init?.body === "string" ? init.body : null;
      const headers = new Headers(init?.headers);
      return await handler(url, bodyText, headers);
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

const voyageOkResponse = (count: number, dimensions: TestDimension = 1024): Response => {
  const vectors = Array.from({ length: count }, (_, i) => ({
    embedding: testVector(dimensions, i + 0.1),
  }));
  const totalTokens = count * 5;
  return new Response(JSON.stringify({ data: vectors, usage: { total_tokens: totalTokens } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const uosIdempotencyUsageContext = (principal: string) => ({
  keyId: null,
  kernelRepo: null,
  kernelOrg: null,
  idempotencyPrincipal: principal,
});

const uosIdempotentRequest = (
  idempotencyKey: string,
  input: string | string[],
  overrides: Partial<{
    input_type: TestInputType;
    dimensions: TestDimension;
    truncation: boolean;
  }> = {}
): Request =>
  new Request("https://ai.ubq.fi/uos/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      model: "voyage-4-large",
      input,
      input_type: overrides.input_type ?? "document",
      dimensions: overrides.dimensions ?? 1024,
      truncation: overrides.truncation ?? false,
    }),
  });

const responseErrorCode = async (response: Response): Promise<string | null> => {
  const payload = (await response.json()) as { error?: { code?: unknown } };
  return typeof payload.error?.code === "string" ? payload.error.code : null;
};

const uosEmbeddingsIdempotencyRecordKey = async (principal: string, idempotencyKey: string): Promise<KvKey> => [
  "embeddings",
  "idempotency",
  "v1",
  await sha256Hex(`uos-embeddings-principal-v1:${principal}`),
  await sha256Hex(`uos-embeddings-key-v1:${idempotencyKey}`),
];

const uosEmbeddingsIdempotencyResponsePrefix = async (principal: string, idempotencyKey: string): Promise<KvKey> => [
  "embeddings",
  "idempotency",
  "v1",
  "response",
  await sha256Hex(`uos-embeddings-principal-v1:${principal}`),
  await sha256Hex(`uos-embeddings-key-v1:${idempotencyKey}`),
];

const uosEmbeddingsIdempotencyFingerprint = async (
  input: string[],
  inputType: TestInputType = "document",
  dimensions: TestDimension = 1024,
  truncation = false
): Promise<string> =>
  await sha256Hex(
    JSON.stringify([
      "uos-embeddings-idempotency-v1",
      "voyage",
      "voyage-4-large",
      inputType,
      dimensions,
      "float",
      "float",
      truncation,
      await Promise.all(input.map((item) => sha256Hex(item))),
    ])
  );

// Helpers that lived between tests in the original file.

const waitForAdmission = async (predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

export {
  EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS,
  EMBEDDINGS_IDEMPOTENCY_MAX_RESPONSE_CHUNKS,
  EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS,
  EMBEDDINGS_JOB_TTL_MS,
  VOYAGE_RATE_LIMIT_KEY,
  bumpKvVersion,
  compareKeyPart,
  compareKeys,
  embeddingsCacheGlobalIndexKey,
  embeddingsCacheKey,
  embeddingsJobKey,
  embeddingsJobLookupKey,
  embeddingsProfileKey,
  fetchMockQueue,
  getKv,
  handleEmbeddingsJobCreate,
  handleEmbeddingsJobGet,
  handleUosEmbeddings,
  keyHasPrefix,
  keyToString,
  kvExpirations,
  kvStore,
  kvStub,
  kvVersions,
  kvVersionstamp,
  originalVoyageApiKey,
  requestInputUrl,
  resetVoyageRateLimit,
  responseErrorCode,
  testVector,
  uosEmbeddingsIdempotencyFingerprint,
  uosEmbeddingsIdempotencyRecordKey,
  uosEmbeddingsIdempotencyResponsePrefix,
  uosIdempotencyUsageContext,
  uosIdempotentRequest,
  voyageOkResponse,
  waitForAdmission,
  withFetchMock,
};
export type { FetchMockQueue, TestDimension, TestEncodingFormat, TestInputType };
export { sha256Hex } from "../../src/utils.ts";

let harnessEnvironment: Map<string, string | undefined> | null = null;

/** Reinstall this fixture explicitly when a Bun test file uses the cached harness. */
export const installHarness = (): void => {
  harnessEnvironment ??= new Map(["VOYAGEAI_API_KEY"].map((name) => [name, process.env[name]]));
  delete process.env["VOYAGEAI_API_KEY"];
  setKvForTest(kvStub);
};
export const resetHarness = (): void => {
  setFailNextAtomicCommit(null);
  resetVoyageRateLimit();
  installHarness();
};
export const cleanupHarness = (): void => {
  for (const [name, value] of harnessEnvironment ?? []) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  harnessEnvironment = null;
  setKvForTest(null);
};
