import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test, beforeEach, afterEach } from "bun:test";
import type { Kv, KvKey } from "#kv";
import { installHarness, cleanupHarness } from "./helpers/embeddings-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// Coverage suite for the Voyage embeddings transport, request parsing, cache maintenance,
// and the embeddings job runner's failure paths.

import assert from "node:assert/strict";
import {
  embeddingsJobKey,
  embeddingsJobLookupKey,
  embeddingsProfileKey,
  getKv,
  handleEmbeddingsJobCreate,
  handleEmbeddingsJobGet,
  keyToString,
  kvStore,
  kvStub,
  resetVoyageRateLimit,
  setFailNextAtomicCommit,
  sha256Hex,
  testVector,
  voyageOkResponse,
  withFetchMock,
} from "./helpers/embeddings-harness.ts";
import {
  applyVoyageRateLimit,
  chunkByTokenBudget,
  decryptEmbeddingsJobInput,
  encryptEmbeddingsJobInput,
  estimateTokenCount,
  estimateTokens,
  fetchVoyageEmbeddings,
  floatEmbeddingToBase64,
  getEnv,
  isValidEmbeddingVector,
  normalizeEmbeddingsJobInputRecord,
  parseEmbeddingsJobRequest,
  parseUosEmbeddingsRequest,
  readVoyageApiKey,
  resolveEmbeddingsJobTokenSeed,
  sleep,
  sleepUnlessAborted,
  tryReserveVoyageBudget,
  writeEmbeddingsCacheEntryBestEffort,
} from "../src/embeddings/voyage.ts";
import {
  embeddingsJobInputKey,
  EMBEDDINGS_MAX_CHARS_PER_INPUT,
  EMBEDDINGS_MAX_INPUTS_PER_REQUEST,
  EMBEDDINGS_MAX_TOTAL_CHARS,
  VOYAGE_RATE_LIMIT_KEY,
  VOYAGE_RATE_LIMIT_RPM,
  VOYAGE_RATE_LIMIT_TPM,
} from "../src/embeddings/ledger.ts";
import { setKvForTest } from "../src/kv.ts";

type ErrorFields = Readonly<{ message?: string; code?: string; param?: string | null; type?: string }>;
type EmbeddingsParseResult = ReturnType<typeof parseUosEmbeddingsRequest>;

const errorOf = async (response: Response): Promise<ErrorFields> => {
  const payload = (await response.json()) as { error?: ErrorFields };
  return payload.error ?? {};
};

const VOYAGE_API_KEY_KV = ["uos_ai", "voyage_api_key"] as const;

/** `src/embeddings/ledger.ts` cache keys, addressed by the resolved profile key. */
const cacheKeyFor = (cacheProfileKey: string, hash: string): KvKey => ["embeddings", "v2", "cache", cacheProfileKey, hash];
const globalIndexKeyFor = (createdAtMs: number, cacheProfileKey: string, hash: string): KvKey => [
  "embeddings",
  "v2",
  "cache_index_global",
  createdAtMs,
  cacheProfileKey,
  hash,
];

/** The harness owns a shared in-memory store; restore the one row the embeddings routes need. */
const resetStore = (): void => {
  kvStore.clear();
  kvStore.set(keyToString(VOYAGE_API_KEY_KV), "voyage_test_key");
};

const parseFailure = async (result: EmbeddingsParseResult): Promise<ErrorFields> => {
  if (result.ok) throw new Error("expected a parse failure");
  return await errorOf(result.response);
};

const jobRequest = (body: string | Record<string, unknown>): Request =>
  new Request("https://ai.ubq.fi/uos/embedding-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const jobPayload = async (response: Response): Promise<Record<string, unknown>> => (await response.json()) as Record<string, unknown>;

const withDeniedKv = async <T>(fn: () => Promise<T>): Promise<T> => {
  setKvForTest(null);
  try {
    return await fn();
  } finally {
    setKvForTest(kvStub);
  }
};

const delegateKv = (overrides: Record<string, unknown>): Kv => ({ ...(kvStub as unknown as Record<string, unknown>), ...overrides }) as unknown as Kv;

/** A commit that reports success without applying anything, to exercise the read-back guard. */
const nonPersistingKv = (): Kv =>
  delegateKv({
    atomic: () => {
      const chain = {
        check: () => chain,
        set: () => chain,
        delete: () => chain,
        commit: () => Promise.resolve({ ok: true }),
      };
      return chain;
    },
  });

const withKv = async <T>(kv: Kv, fn: () => Promise<T>): Promise<T> => {
  setKvForTest(kv);
  try {
    return await fn();
  } finally {
    setKvForTest(kvStub);
  }
};

test("embeddings request parsing rejects every malformed field for both contracts", async () => {
  const syncCases: readonly (readonly [Record<string, unknown>, string, string | undefined])[] = [
    [{ model: "voyage-4-large", input: 7 }, "input must be a string or an array of strings", "input"],
    [{ model: "voyage-4-large", input: ["ok", 7] }, "input must be a string or an array of strings", "input"],
    [{ model: "voyage-4-large", input: [] }, "input must be a non-empty string or a non-empty array", "input"],
    [
      { model: "voyage-4-large", input: "x".repeat(EMBEDDINGS_MAX_CHARS_PER_INPUT + 1) },
      `Input too large: ${EMBEDDINGS_MAX_CHARS_PER_INPUT + 1} chars (max ${EMBEDDINGS_MAX_CHARS_PER_INPUT})`,
      "input",
    ],
    [
      { model: "voyage-4-large", input: "€".repeat(EMBEDDINGS_MAX_CHARS_PER_INPUT) },
      `Input too large for embeddings provider: ~${(EMBEDDINGS_MAX_CHARS_PER_INPUT * 3) / 4} tokens (max ${VOYAGE_RATE_LIMIT_TPM}).`,
      "input",
    ],
    [
      {
        model: "voyage-4-large",
        input: ["x".repeat(20_000), "x".repeat(20_000), "x".repeat(20_000), "x".repeat(20_000), "x".repeat(20_000), "x".repeat(20_000)],
      },
      `Request too large: ${EMBEDDINGS_MAX_TOTAL_CHARS + 20_000} chars total (max ${EMBEDDINGS_MAX_TOTAL_CHARS})`,
      "input",
    ],
    [{ input: "hello" }, "model is required and must be a non-empty string", "model"],
    [{ model: "text-embedding-3-small", input: "hello" }, "Unsupported embedding model: text-embedding-3-small", "model"],
    [{ model: "voyage-4-large", input: "hello", dimensions: 3 }, "dimensions must be one of: 256, 512, 1024, 2048", "dimensions"],
    [{ model: "voyage-4-large", input: "hello", dimensions: 1.5 }, "dimensions must be an integer", "dimensions"],
    [{ model: "voyage-4-large", input: "hello", encoding_format: "float32" }, 'encoding_format must be one of: "float", "base64"', "encoding_format"],
    [{ model: "voyage-4-large", input: "hello", encoding_format: 5 }, "encoding_format must be a string", "encoding_format"],
    [{ model: "voyage-4-large", input: "hello", input_type: "other" }, 'input_type must be one of: "query", "document"', "input_type"],
    [{ model: "voyage-4-large", input: "hello", truncation: "yes" }, "truncation must be a boolean", "truncation"],
    [{ model: "voyage-4-large", input: "hello", user: 7 }, "user must be a string", "user"],
    [{ model: "voyage-4-large", input: "hello", unexpected: true }, "Unrecognized request argument supplied: unexpected", undefined],
  ];
  for (const [body, message, param] of syncCases) {
    const error = await parseFailure(parseUosEmbeddingsRequest(body));
    assert.equal(error.message, message);
    if (param !== undefined) assert.equal(error.param, param);
  }

  const jobMissingInputType = await parseFailure(parseEmbeddingsJobRequest({ model: "voyage-4-large", input: "hello" }));
  assert.equal(jobMissingInputType.message, 'input_type is required and must be one of: "query", "document"');
  const jobBase64 = await parseFailure(
    parseEmbeddingsJobRequest({ model: "voyage-4-large", input: "hello", input_type: "document", encoding_format: "base64" })
  );
  assert.equal(jobBase64.message, 'encoding_format must be "float" for embeddings jobs');

  const parsed = parseUosEmbeddingsRequest({ model: "voyage-4-large", input: "hello", user: null });
  assert.ok(parsed.ok, "expected a parsed request");
  assert.deepEqual(parsed.value.inputs, ["hello"]);
  assert.equal(parsed.value.total_chars, 5);
  assert.deepEqual(parsed.value.profile, {
    upstream: "voyage",
    upstream_model: "voyage-4-large",
    input_type: "document",
    dimensions: 1024,
    output_dtype: "float",
    encoding_format: "float",
    truncation: true,
    cache_profile_key: embeddingsProfileKey("document", 1024, "float", true),
  });
});

test("embeddings token estimation chunks inputs by item and token budget", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokenCount(["abcd", "abcd"]), 2);

  const items = Array.from({ length: 4 }, (_, index) => ({ hash: `h${index}`, text: "x".repeat(400) }));
  const byTokens = chunkByTokenBudget(items, EMBEDDINGS_MAX_INPUTS_PER_REQUEST, 250).map((chunk) => chunk.map((item) => item.hash));
  assert.deepEqual(byTokens, [
    ["h0", "h1"],
    ["h2", "h3"],
  ]);
  const byItems = chunkByTokenBudget(items, 1, VOYAGE_RATE_LIMIT_TPM).map((chunk) => chunk.map((item) => item.hash));
  assert.deepEqual(byItems, [["h0"], ["h1"], ["h2"], ["h3"]]);
  assert.deepEqual(chunkByTokenBudget([], 5, 5), []);
  assert.deepEqual(
    chunkByTokenBudget(items, 0, VOYAGE_RATE_LIMIT_TPM).map((chunk) => chunk.length),
    [1, 1, 1, 1]
  );
});

test("voyage rate limiting reserves, refuses and recovers from a lost commit", async () => {
  const kv = kvStub;
  resetVoyageRateLimit();
  const reserved = await tryReserveVoyageBudget(kv, 10);
  assert.deepEqual(reserved, { ok: true });
  assert.deepEqual(kvStore.get(keyToString(VOYAGE_RATE_LIMIT_KEY)), {
    window_start_ms: (kvStore.get(keyToString(VOYAGE_RATE_LIMIT_KEY)) as { window_start_ms: number }).window_start_ms,
    requests: 1,
    tokens: 10,
  });

  // An unusable stored state is replaced by a fresh window instead of failing the request.
  kvStore.set(keyToString(VOYAGE_RATE_LIMIT_KEY), { window_start_ms: -1, requests: -2, tokens: -3 });
  assert.deepEqual(await tryReserveVoyageBudget(kv, 1), { ok: true });
  kvStore.set(keyToString(VOYAGE_RATE_LIMIT_KEY), { window_start_ms: Date.now(), requests: VOYAGE_RATE_LIMIT_RPM, tokens: 0 });
  const refused = await tryReserveVoyageBudget(kv, 1);
  assert.ok(!refused.ok, "expected the request limit to refuse the reservation");
  assert.equal(refused.wait_ms > 0 && refused.wait_ms <= 60_000, true);

  kvStore.set(keyToString(VOYAGE_RATE_LIMIT_KEY), { window_start_ms: Date.now(), requests: 0, tokens: VOYAGE_RATE_LIMIT_TPM });
  const tokenRefused = await tryReserveVoyageBudget(kv, 1);
  assert.equal(tokenRefused.ok, false);

  resetVoyageRateLimit();
  setFailNextAtomicCommit(() => true);
  assert.deepEqual(await tryReserveVoyageBudget(kv, 1), { ok: false, wait_ms: 0 });
  const recovered = await applyVoyageRateLimit(kv, 1, Date.now() + 2_000);
  assert.deepEqual(recovered, { ok: true });
  assert.equal((kvStore.get(keyToString(VOYAGE_RATE_LIMIT_KEY)) as { requests?: number }).requests, 1);

  assert.deepEqual(await applyVoyageRateLimit(kv, 1, Date.now() - 1), { ok: false, wait_ms: 0 });

  kvStore.set(keyToString(VOYAGE_RATE_LIMIT_KEY), { window_start_ms: Date.now() - 59_990, requests: VOYAGE_RATE_LIMIT_RPM, tokens: 0 });
  const afterWait = await applyVoyageRateLimit(kv, 1, Date.now() + 5_000);
  assert.deepEqual(afterWait, { ok: true });
  resetVoyageRateLimit();
});

test("embeddings sleep helpers honor aborts and deadlines", async () => {
  let resumed = false;
  const pending = sleep(1).then(() => {
    resumed = true;
  });
  assert.equal(resumed, false);
  await pending;
  assert.equal(resumed, true);

  assert.equal(await sleepUnlessAborted(1, new AbortController().signal), true);

  const preAborted = new AbortController();
  preAborted.abort(new Error("already cancelled"));
  assert.equal(await sleepUnlessAborted(10_000, preAborted.signal), false);

  const controller = new AbortController();
  const sleeping = sleepUnlessAborted(10_000, controller.signal);
  controller.abort(new Error("cancelled while sleeping"));
  assert.equal(await sleeping, false);
});

test("embeddings job token seeds prefer stable principals", () => {
  assert.equal(resolveEmbeddingsJobTokenSeed("job-1", null), "job-1");
  assert.equal(resolveEmbeddingsJobTokenSeed("job-1", "bearer-token"), "bearer-token");
  assert.equal(resolveEmbeddingsJobTokenSeed("job-1", "bearer-token", { keyId: "key-9", kernelRepo: null, kernelOrg: null }), "uos_api_key_id:key-9");
  assert.equal(
    resolveEmbeddingsJobTokenSeed("job-1", "bearer-token", { keyId: null, kernelRepo: { owner: "ubiquity", repo: "ai.ubq.fi" }, kernelOrg: null }),
    "uos_kernel_repo:ubiquity/ai.ubq.fi"
  );
});

test("voyage environment and API key lookups fail closed", async () => {
  // The test runtime grants env access only to the fixed allowlist, so an unlisted
  // variable raises a permission error that the helper must swallow.
  assert.equal(getEnv("HOME"), undefined);
  const priorEnvKey = process.env.VOYAGEAI_API_KEY;
  try {
    process.env.VOYAGEAI_API_KEY = "  env-voyage-key  ";
    assert.equal(await readVoyageApiKey(null), "env-voyage-key");
    assert.equal(await readVoyageApiKey(kvStub), "env-voyage-key");
    Reflect.deleteProperty(process.env, "VOYAGEAI_API_KEY");
    assert.equal(await readVoyageApiKey(null), null);

    kvStore.set(keyToString(VOYAGE_API_KEY_KV), "   ");
    assert.equal(await readVoyageApiKey(kvStub), null);
    kvStore.set(keyToString(VOYAGE_API_KEY_KV), "  kv-voyage-key  ");
    assert.equal(await readVoyageApiKey(kvStub), "kv-voyage-key");
  } finally {
    if (priorEnvKey === undefined) Reflect.deleteProperty(process.env, "VOYAGEAI_API_KEY");
    else process.env.VOYAGEAI_API_KEY = priorEnvKey;
  }
});

test("embeddings cache writes recover from quota errors and abandon unusable ones", async () => {
  resetStore();
  const profile = embeddingsProfileKey("document", 1024, "float", true);
  const vector = testVector(1024);
  const deadlineMs = Date.now() + 30_000;

  // A non-quota failure is abandoned immediately and nothing is cached.
  setFailNextAtomicCommit(() => new Error("cache write transport failed"));
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, profile, "hash-abandoned", vector, Date.now(), deadlineMs), { isNew: false });
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-abandoned"))), false);

  // A quota failure evicts the oldest entry and then stores the new one.
  const oldCreatedAtMs = Date.now() - 60_000;
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, profile, "hash-old", vector, oldCreatedAtMs, deadlineMs), { isNew: true });
  setFailNextAtomicCommit(() => new Error("KV storage quota exceeded"));
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, profile, "hash-new", vector, Date.now(), deadlineMs), { isNew: true });
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-new"))), true);
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-old"))), false);
  assert.equal(kvStore.has(keyToString(globalIndexKeyFor(oldCreatedAtMs, profile, "hash-old"))), false);

  // Every eviction candidate can be unusable; the write is then abandoned instead of failing.
  resetStore();
  const unusableCandidates = [
    keyToString(["embeddings", "v2", "cache_index_global", "not-a-number", profile, "hash-x"]),
    keyToString(["embeddings", "v2", "cache_index_global", 1, "", "hash-y"]),
    keyToString(["embeddings", "v2", "cache_index_global", 1, profile, 7]),
  ];
  for (const key of unusableCandidates) kvStore.set(key, 1);
  setFailNextAtomicCommit(() => new Error("insufficient storage for embeddings cache"));
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, profile, "hash-skipped", vector, Date.now(), deadlineMs), { isNew: false });
  for (const key of unusableCandidates) assert.equal(kvStore.has(key), true);
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-skipped"))), false);
  setFailNextAtomicCommit(null);

  // An expired deadline never attempts a write.
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, profile, "hash-late", vector, Date.now(), Date.now() - 1), { isNew: false });
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-late"))), false);

  // A legacy entry without a by-hash pointer is evicted only while its value still matches.
  const legacyCreatedAtMs = Date.now() - 30_000;
  const legacyHash = "hash-legacy";
  kvStore.set(keyToString(globalIndexKeyFor(legacyCreatedAtMs, profile, legacyHash)), 1);
  kvStore.set(keyToString(cacheKeyFor(profile, legacyHash)), { embedding: vector, created_at: new Date(legacyCreatedAtMs).toISOString() });
  setFailNextAtomicCommit(() => new Error("embedded cache quota exceeded"));
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, profile, "hash-after-legacy", vector, Date.now(), deadlineMs), { isNew: true });
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, legacyHash))), false);
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-after-legacy"))), true);
});

test("float embeddings encode to base64 as little-endian float32", () => {
  assert.equal(floatEmbeddingToBase64([1]), "AACAPw==");
  assert.equal(floatEmbeddingToBase64([0, -2.5]), "AAAAAAAAIMA=");
  const pairBytes = Uint8Array.from(atob(floatEmbeddingToBase64([0, -2.5])), (character) => character.charCodeAt(0));
  const pairView = new DataView(pairBytes.buffer);
  assert.equal(pairView.getFloat32(0, true), 0);
  assert.equal(pairView.getFloat32(4, true), -2.5);

  const large = Array.from({ length: 20_000 }, (_, index) => index - 10_000);
  const encoded = floatEmbeddingToBase64(large);
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  assert.equal(bytes.length, 80_000);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getFloat32(0, true), -10_000);
  assert.equal(view.getFloat32(79_996, true), 9_999);
});

test("embeddings job input records validate, encrypt and decrypt", async () => {
  assert.equal(normalizeEmbeddingsJobInputRecord(null), null);
  assert.equal(normalizeEmbeddingsJobInputRecord({}), null);
  assert.equal(normalizeEmbeddingsJobInputRecord({ v: 2, iv_b64: "a", data_b64: "b", created_at_ms: 1 }), null);
  assert.equal(normalizeEmbeddingsJobInputRecord({ v: 1, iv_b64: "", data_b64: "b", created_at_ms: 1 }), null);
  assert.equal(normalizeEmbeddingsJobInputRecord({ v: 1, iv_b64: "a", data_b64: "b" }), null);
  assert.equal(normalizeEmbeddingsJobInputRecord({ v: 1, iv_b64: "a", data_b64: "b", created_at_ms: -1 }), null);
  const record = normalizeEmbeddingsJobInputRecord({ v: 1, iv_b64: "a", data_b64: "b", created_at_ms: 12.7 });
  assert.deepEqual(record, { v: 1, iv_b64: "a", data_b64: "b", created_at_ms: 12 });

  const encrypted = await encryptEmbeddingsJobInput("seed-one", "secret input text");
  assert.equal(encrypted.v, 1);
  assert.equal(typeof encrypted.created_at_ms, "number");
  assert.equal(await decryptEmbeddingsJobInput("seed-one", encrypted), "secret input text");
  assert.equal(await decryptEmbeddingsJobInput("seed-two", encrypted), null);
  assert.equal(await decryptEmbeddingsJobInput("seed-one", { ...encrypted, iv_b64: "!!!", data_b64: "abc" }), null);
});

test("voyage transport reports upstream status, payload and abort failures", async () => {
  const baseParams = {
    apiKey: "voyage-test-key",
    model: "voyage-4-large" as const,
    inputs: ["hello"],
    inputType: "document" as const,
    dimensions: 1024 as const,
    outputDtype: "float" as const,
    truncation: true,
    deadlineMs: Date.now() + 10_000,
  };

  const single = await withFetchMock(
    (url, bodyText, headers) => {
      assert.equal(url, "https://api.voyageai.com/v1/embeddings");
      assert.equal(headers.get("authorization"), "Bearer voyage-test-key");
      assert.equal((JSON.parse(bodyText ?? "null") as { input?: unknown }).input, "hello");
      return voyageOkResponse(1);
    },
    () => fetchVoyageEmbeddings(baseParams)
  );
  assert.equal(single.vectors.length, 1);
  assert.equal(single.totalTokens, 5);

  const multiple = await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as { input?: unknown[] };
      assert.equal(Array.isArray(body.input), true);
      return new Response(JSON.stringify({ data: [{ embedding: testVector(1024) }, { embedding: testVector(1024, 1) }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    () => fetchVoyageEmbeddings({ ...baseParams, inputs: ["a", "b"] })
  );
  assert.equal(multiple.vectors.length, 2);
  assert.equal(multiple.totalTokens, null);

  await withFetchMock(
    () => new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
    async () => {
      await assert.rejects(fetchVoyageEmbeddings(baseParams), (error: Error & { status?: number; retry_after_ms?: number }) => {
        assert.equal(error.message, "Voyage embeddings failed (429).");
        assert.equal(error.status, 429);
        assert.equal(error.retry_after_ms, 2_000);
        return true;
      });
    }
  );

  await withFetchMock(
    () => new Response("rate limited", { status: 503, headers: { "Retry-After": new Date(Date.now() + 3_000).toUTCString() } }),
    async () => {
      await assert.rejects(fetchVoyageEmbeddings(baseParams), (error: Error & { retry_after_ms?: number }) => {
        assert.equal(typeof error.retry_after_ms, "number");
        assert.equal((error.retry_after_ms ?? 0) > 0, true);
        assert.equal((error.retry_after_ms ?? 0) <= 3_000, true);
        return true;
      });
    }
  );

  await withFetchMock(
    () => new Response("not json at all", { status: 200 }),
    async () => {
      await assert.rejects(fetchVoyageEmbeddings(baseParams), /Voyage embeddings returned invalid JSON\./);
    }
  );

  await withFetchMock(
    () => new Response(JSON.stringify({ data: [{ embedding: "nope" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      await assert.rejects(fetchVoyageEmbeddings(baseParams), /missing embedding vector/);
    }
  );

  await withFetchMock(
    () => new Response(JSON.stringify({ data: [{ embedding: [1, "two"] }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      await assert.rejects(fetchVoyageEmbeddings(baseParams), /contained non-numeric values/);
    }
  );

  const controller = new AbortController();
  controller.abort(new Error("client cancelled"));
  let cancelledBeforeTransport = false;
  let markedTransportStarted = false;
  await assert.rejects(
    fetchVoyageEmbeddings({
      ...baseParams,
      downstreamSignal: controller.signal,
      beforeProviderDispatch: () =>
        Promise.resolve({
          cancelBeforeTransport: () => {
            cancelledBeforeTransport = true;
            return Promise.resolve();
          },
          markTransportStarted: () => {
            markedTransportStarted = true;
          },
        }),
    }),
    /client cancelled/
  );
  assert.equal(cancelledBeforeTransport, true);
  assert.equal(markedTransportStarted, false);

  // A past deadline aborts the in-flight request through the internal timeout.
  const originalFetch = globalThis.fetch;
  let observedAbort = false;
  globalThis.fetch = createFetchMock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          observedAbort = true;
          const reason = signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort);
      })
  );
  try {
    await assert.rejects(fetchVoyageEmbeddings({ ...baseParams, deadlineMs: Date.now() - 1 }), (error: Error) => {
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.equal(observedAbort, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedding job create rejects malformed bodies, missing KV and missing provider keys", async () => {
  resetStore();
  const invalidJson = await handleEmbeddingsJobCreate(jobRequest("{"), "coverage-token");
  assert.equal(invalidJson.status, 400);
  assert.equal((await errorOf(invalidJson)).message, "Invalid JSON body");

  const invalidFields = await handleEmbeddingsJobCreate(jobRequest({ model: "voyage-4-large", input: "hello" }), "coverage-token");
  assert.equal(invalidFields.status, 400);
  assert.match((await errorOf(invalidFields)).message ?? "", /input_type is required/);

  const noKv = await withDeniedKv(() =>
    handleEmbeddingsJobCreate(jobRequest({ model: "voyage-4-large", input: "hello", input_type: "document" }), "coverage-token")
  );
  assert.equal(noKv.status, 503);
  assert.equal((await errorOf(noKv)).message, "Embeddings jobs require Deno KV");

  kvStore.delete(keyToString(VOYAGE_API_KEY_KV));
  const noProvider = await handleEmbeddingsJobCreate(jobRequest({ model: "voyage-4-large", input: "hello", input_type: "document" }), "coverage-token");
  assert.equal(noProvider.status, 503);
  const noProviderPayload = await errorOf(noProvider);
  assert.equal(noProviderPayload.code, "server_error");
  assert.match(noProviderPayload.message ?? "", /VOYAGEAI_API_KEY/);

  resetStore();
  setFailNextAtomicCommit(() => true);
  const persistFailed = await handleEmbeddingsJobCreate(jobRequest({ model: "voyage-4-large", input: "hello", input_type: "document" }), "coverage-token");
  assert.equal(persistFailed.status, 502);
  assert.equal((await errorOf(persistFailed)).message, "Embeddings job could not be persisted.");

  const readBackFailed = await withKv(nonPersistingKv(), () =>
    handleEmbeddingsJobCreate(jobRequest({ model: "voyage-4-large", input: "hello", input_type: "document" }), "coverage-token")
  );
  assert.equal(readBackFailed.status, 502);
  assert.equal((await errorOf(readBackFailed)).message, "Embeddings job could not be persisted.");
});

test("embedding job get reports missing jobs, mismatched profiles and unavailable KV", async () => {
  resetStore();
  const unknown = await handleEmbeddingsJobGet(new Request("https://ai.ubq.fi/uos/embedding-jobs/embjob_missing"), "coverage-token", "embjob_missing");
  assert.equal(unknown.status, 404);
  assert.equal((await errorOf(unknown)).message, "Embeddings job not found");

  const tokenHash = await sha256Hex("coverage-token");
  const jobId = "embjob_mismatched";
  kvStore.set(keyToString(embeddingsJobLookupKey(tokenHash, jobId)), { cache_profile_key: "profile-lookup" });
  kvStore.set(keyToString(embeddingsJobKey(tokenHash, "profile-lookup", jobId)), { id: jobId, cache_profile_key: "profile-other" });
  const mismatched = await handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), "coverage-token", jobId);
  assert.equal(mismatched.status, 404);

  const noKv = await withDeniedKv(() => handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), "coverage-token", jobId));
  assert.equal(noKv.status, 503);
  assert.equal((await errorOf(noKv)).message, "Embeddings jobs require Deno KV");
});

const queuedJob = async (authToken: string, input: string | string[]): Promise<{ jobId: string; profileKey: string; hash: string }> => {
  const created = await withFetchMock(
    () => new Response("too many requests", { status: 429, headers: { "Retry-After": "30" } }),
    () => handleEmbeddingsJobCreate(jobRequest({ model: "voyage-4-large", input, input_type: "document" }), authToken)
  );
  assert.equal(created.status, 202);
  const payload = await jobPayload(created);
  assert.equal(payload.status, "queued");
  const jobId = payload.id as string;
  const tokenHash = await sha256Hex(authToken);
  const lookup = kvStore.get(keyToString(embeddingsJobLookupKey(tokenHash, jobId))) as { cache_profile_key: string };
  const job = kvStore.get(keyToString(embeddingsJobKey(tokenHash, lookup.cache_profile_key, jobId))) as { input_hashes: string[] };
  return { jobId, profileKey: lookup.cache_profile_key, hash: job.input_hashes[0] };
};

const pollJob = (jobId: string, authToken: string): Promise<Response> =>
  handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), authToken, jobId);

test("embedding job polling fails closed when inputs or results disappear", async () => {
  const authToken = `coverage-inputs-${crypto.randomUUID()}`;
  resetVoyageRateLimit();
  resetStore();
  const { jobId, profileKey, hash } = await queuedJob(authToken, `missing-input-${crypto.randomUUID()}`);
  const tokenHash = await sha256Hex(authToken);

  kvStore.delete(keyToString(embeddingsJobInputKey(tokenHash, profileKey, jobId, hash)));
  const missingInput = await pollJob(jobId, authToken);
  assert.equal(missingInput.status, 200);
  const missingPayload = await jobPayload(missingInput);
  assert.equal(missingPayload.status, "failed");
  assert.equal((missingPayload.error as { code?: string }).code, "embeddings_job_input_missing");
  assert.match(String((missingPayload.error as { message?: string }).message), /expired or was unavailable/);

  resetVoyageRateLimit();
  resetStore();
  const undecryptable = await queuedJob(authToken, `undecryptable-input-${crypto.randomUUID()}`);
  const undecryptableTokenHash = await sha256Hex(authToken);
  kvStore.set(keyToString(embeddingsJobInputKey(undecryptableTokenHash, undecryptable.profileKey, undecryptable.jobId, undecryptable.hash)), {
    v: 1,
    iv_b64: btoa("0123456789ab"),
    data_b64: btoa("0123456789abcdef0123456789abcdef"),
    created_at_ms: Date.now(),
  });
  const decryptFailed = await pollJob(undecryptable.jobId, authToken);
  const decryptPayload = await jobPayload(decryptFailed);
  assert.equal(decryptPayload.status, "failed");
  assert.equal((decryptPayload.error as { code?: string }).code, "embeddings_job_input_decrypt_failed");

  // A succeeded job whose cached vectors were evicted is reported as failed, not as a broken result.
  resetVoyageRateLimit();
  resetStore();
  const succeeded = await withFetchMock(
    () => voyageOkResponse(1),
    () => handleEmbeddingsJobCreate(jobRequest({ model: "voyage-4-large", input: `evicted-${crypto.randomUUID()}`, input_type: "document" }), authToken)
  );
  assert.equal(succeeded.status, 200);
  const succeededPayload = await jobPayload(succeeded);
  assert.equal(succeededPayload.status, "succeeded");
  const succeededJobId = succeededPayload.id as string;
  const succeededTokenHash = await sha256Hex(authToken);
  const succeededLookup = kvStore.get(keyToString(embeddingsJobLookupKey(succeededTokenHash, succeededJobId))) as { cache_profile_key: string };
  const storedJob = kvStore.get(keyToString(embeddingsJobKey(succeededTokenHash, succeededLookup.cache_profile_key, succeededJobId))) as {
    cache_profile_key: string;
    input_hashes: string[];
  };
  for (const inputHash of storedJob.input_hashes) {
    kvStore.delete(keyToString(cacheKeyFor(storedJob.cache_profile_key, inputHash)));
  }
  const evicted = await withFetchMock(
    () => {
      throw new Error("an evicted result must not dispatch upstream");
    },
    () => pollJob(succeededJobId, authToken)
  );
  const evictedPayload = await jobPayload(evicted);
  assert.equal(evictedPayload.status, "failed");
  assert.equal((evictedPayload.error as { code?: string }).code, "embeddings_job_result_missing");
});

test("embedding job polling reports upstream failures and count mismatches", async () => {
  const authToken = `coverage-upstream-${crypto.randomUUID()}`;
  resetVoyageRateLimit();
  resetStore();
  const counted = await queuedJob(authToken, [`count-mismatch-a-${crypto.randomUUID()}`, "count-mismatch-b"]);
  const mismatched = await withFetchMock(
    () => new Response(JSON.stringify({ data: [{ embedding: testVector(1024) }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    () => pollJob(counted.jobId, authToken)
  );
  const mismatchedPayload = await jobPayload(mismatched);
  assert.equal(mismatchedPayload.status, "failed");
  assert.equal((mismatchedPayload.error as { code?: string }).code, "embeddings_job_upstream_mismatch");
  assert.match(String((mismatchedPayload.error as { message?: string }).message), /size mismatch/);

  resetVoyageRateLimit();
  resetStore();
  const rejected = await queuedJob(authToken, `upstream-400-${crypto.randomUUID()}`);
  const badRequest = await withFetchMock(
    () => new Response("bad request", { status: 400 }),
    () => pollJob(rejected.jobId, authToken)
  );
  const badRequestPayload = await jobPayload(badRequest);
  assert.equal(badRequestPayload.status, "failed");
  assert.equal((badRequestPayload.error as { code?: string }).code, "embeddings_job_upstream_error");
  assert.match(String((badRequestPayload.error as { message?: string }).message), /Embeddings upstream request failed/);
});

test("embedding job polling serves a cached completion and refuses queued jobs without a provider key", async () => {
  const authToken = `coverage-cached-${crypto.randomUUID()}`;
  resetVoyageRateLimit();
  resetStore();
  const cached = await queuedJob(authToken, `cached-${crypto.randomUUID()}`);
  const vector = testVector(1024);
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, cached.profileKey, cached.hash, vector, Date.now(), Date.now() + 30_000), { isNew: true });

  const served = await withFetchMock(
    () => {
      throw new Error("a cache-hit poll must not dispatch upstream");
    },
    () => pollJob(cached.jobId, authToken)
  );
  assert.equal(served.status, 200);
  const servedPayload = await jobPayload(served);
  assert.equal(servedPayload.status, "succeeded");
  const result = servedPayload.result as { object?: string; data?: { embedding?: unknown }[] };
  assert.equal(result.object, "list");
  assert.deepEqual(result.data?.[0]?.embedding, vector);

  resetVoyageRateLimit();
  resetStore();
  const unconfigured = await queuedJob(authToken, `no-provider-${crypto.randomUUID()}`);
  kvStore.delete(keyToString(VOYAGE_API_KEY_KV));
  const noProvider = await withFetchMock(
    () => {
      throw new Error("an unconfigured provider must not dispatch");
    },
    () => pollJob(unconfigured.jobId, authToken)
  );
  assert.equal(noProvider.status, 503);
  assert.match((await errorOf(noProvider)).message ?? "", /VOYAGEAI_API_KEY/);
});

test("embeddings cache entries are addressed by the resolved profile", () => {
  const profile = embeddingsProfileKey("query", 512, "base64", false);
  assert.match(profile, /voyage-profile-v2/);
  assert.notEqual(profile, embeddingsProfileKey("document", 512, "base64", false));
  assert.equal(isValidEmbeddingVector(testVector(512), 512), true);
  assert.equal(isValidEmbeddingVector(testVector(512), 1024), false);
  const nonFinite = testVector(512);
  nonFinite[0] = Number.NaN;
  assert.equal(isValidEmbeddingVector(nonFinite, 512), false);
  assert.equal(isValidEmbeddingVector("nope", 512), false);
});

test("embeddings KV access is memoized for the harness stub", async () => {
  const kv = await getKv();
  assert.equal(kv === kvStub, true);
});

/** Fails every atomic commit that writes the Voyage rate-limit row, mimicking a lost CAS. */
const rateLimitStuckKv = (): Kv =>
  delegateKv({
    atomic: () => {
      const ops: { type: "set" | "delete"; key: KvKey; value?: unknown }[] = [];
      const chain = {
        check: () => chain,
        set: (key: KvKey, value: unknown) => {
          ops.push({ type: "set", key, value });
          return chain;
        },
        delete: (key: KvKey) => {
          ops.push({ type: "delete", key });
          return chain;
        },
        commit: () => {
          if (ops.some((op) => keyToString(op.key) === keyToString(VOYAGE_RATE_LIMIT_KEY))) return Promise.resolve({ ok: false });
          for (const op of ops) {
            if (op.type === "set") kvStore.set(keyToString(op.key), op.value);
            else kvStore.delete(keyToString(op.key));
          }
          return Promise.resolve({ ok: true });
        },
      };
      return chain;
    },
  });

const alwaysThrowingCommitKv = (message: string): Kv =>
  delegateKv({
    atomic: () => {
      const chain = {
        check: () => chain,
        set: () => chain,
        delete: () => chain,
        commit: () => {
          throw new Error(message);
        },
      };
      return chain;
    },
  });

test("embeddings cache writes treat a negative by-hash pointer as a miss", async () => {
  resetStore();
  const profile = embeddingsProfileKey("document", 1024, "float", true);
  const vector = testVector(1024);
  const deadlineMs = Date.now() + 30_000;

  // A negative by-hash pointer is not a usable timestamp, so the entry is written fresh.
  kvStore.set(keyToString(["embeddings", "v2", "cache_index_by_hash", profile, "hash-negative"]), -7);
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, profile, "hash-negative", vector, Date.now(), deadlineMs), { isNew: true });
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-negative"))), true);
});

test("embeddings cache writes abandon a ledger that always rejects commits", async () => {
  resetStore();
  const profile = embeddingsProfileKey("document", 1024, "float", true);
  const vector = testVector(1024);
  const deadlineMs = Date.now() + 30_000;
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(kvStub, profile, "hash-evictable", vector, Date.now() - 1_000, deadlineMs), { isNew: true });

  const stuck = alwaysThrowingCommitKv("KV storage quota exceeded");
  assert.deepEqual(await writeEmbeddingsCacheEntryBestEffort(stuck, profile, "hash-stuck", vector, Date.now(), deadlineMs), { isNew: false });
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-stuck"))), false);
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-evictable"))), true);
});

test("voyage rate limiting tolerates unusable state and a permanently stuck ledger", async () => {
  resetVoyageRateLimit();
  kvStore.set(keyToString(VOYAGE_RATE_LIMIT_KEY), { window_start_ms: 1, requests: "many", tokens: 0 });
  assert.deepEqual(await tryReserveVoyageBudget(kvStub, 4), { ok: true });
  const reservedState = kvStore.get(keyToString(VOYAGE_RATE_LIMIT_KEY)) as { requests: number; tokens: number };
  assert.deepEqual({ requests: reservedState.requests, tokens: reservedState.tokens }, { requests: 1, tokens: 4 });

  resetVoyageRateLimit();
  setFailNextAtomicCommit(() => true);
  const recovered = await applyVoyageRateLimit(kvStub, 2, Date.now() + 2_000);
  assert.deepEqual(recovered, { ok: true });

  resetVoyageRateLimit();
  const stuck = rateLimitStuckKv();
  const exhausted = await applyVoyageRateLimit(stuck, 1, Date.now() + 200);
  assert.deepEqual(exhausted, { ok: false, wait_ms: 0 });
  resetVoyageRateLimit();
});

test("embedding job creation requeues when the rate-limit ledger is stuck", async () => {
  const authToken = `coverage-stuck-${crypto.randomUUID()}`;
  resetVoyageRateLimit();
  resetStore();
  const response = await withKv(rateLimitStuckKv(), () =>
    withFetchMock(
      () => {
        throw new Error("a stuck reservation must not dispatch upstream");
      },
      () => handleEmbeddingsJobCreate(jobRequest({ model: "voyage-4-large", input: `stuck-${crypto.randomUUID()}`, input_type: "document" }), authToken)
    )
  );
  assert.equal(response.status, 202);
  const payload = await jobPayload(response);
  assert.equal(payload.status, "queued");
  assert.equal(payload.retry_after_seconds, 1);
  resetVoyageRateLimit();
});

test("voyage transport ignores unusable Retry-After values", async () => {
  const baseParams = {
    apiKey: "voyage-test-key",
    model: "voyage-4-large" as const,
    inputs: ["hello"],
    inputType: "document" as const,
    dimensions: 1024 as const,
    outputDtype: "float" as const,
    truncation: true,
    deadlineMs: Date.now() + 10_000,
  };
  for (const retryAfter of ["later", "   ", "-5"]) {
    await withFetchMock(
      () => new Response("upstream unavailable", { status: 502, headers: { "Retry-After": retryAfter } }),
      async () => {
        await assert.rejects(fetchVoyageEmbeddings(baseParams), (error: Error & { status?: number; retry_after_ms?: number }) => {
          assert.equal(error.status, 502);
          assert.equal(error.retry_after_ms, undefined);
          return true;
        });
      }
    );
  }
});

/** Every cache-entry commit reports a lost CAS, so the create-index retry loop exhausts. */
const refusingCacheCommitKv = (): Kv =>
  delegateKv({
    atomic: () => {
      const ops: { type: "set" | "delete"; key: KvKey; value?: unknown }[] = [];
      const chain = {
        check: () => chain,
        set: (key: KvKey, value: unknown) => {
          ops.push({ type: "set", key, value });
          return chain;
        },
        delete: (key: KvKey) => {
          ops.push({ type: "delete", key });
          return chain;
        },
        commit: () => {
          if (ops.some((op) => op.key[0] === "embeddings" && op.key[2] === "cache")) return Promise.resolve({ ok: false });
          for (const op of ops) {
            if (op.type === "set") kvStore.set(keyToString(op.key), op.value);
            else kvStore.delete(keyToString(op.key));
          }
          return Promise.resolve({ ok: true });
        },
      };
      return chain;
    },
  });

test("embeddings cache writes give up after repeated create-index CAS losses", async () => {
  resetStore();
  const profile = embeddingsProfileKey("document", 1024, "float", true);
  const vector = testVector(1024);
  const result = await writeEmbeddingsCacheEntryBestEffort(refusingCacheCommitKv(), profile, "hash-refused", vector, Date.now(), Date.now() + 30_000);
  assert.deepEqual(result, { isNew: false });
  assert.equal(kvStore.has(keyToString(cacheKeyFor(profile, "hash-refused"))), false);
});
