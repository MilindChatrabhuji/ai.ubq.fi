import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import { type KvEntryMaybe, type KvKey } from "#kv";
import assert from "node:assert/strict";
import { SentinelKvStub } from "./helpers/sentinel-kv-stub.ts";

const credentialNames = [
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "LITHOSAI_API_KEY",
  "VOYAGEAI_API_KEY",
  "METERED_API_KEY",
  "SURPLUS_API_KEY",
  "OPENROUTER_API_KEY",
] as const;
assert.equal(
  credentialNames.some((name) => Boolean(process.env[name])),
  false,
  "this acceptance process must start without provider credentials"
);

const { setKvForTest } = await import("../src/kv.ts");
const { CODEX_AUTH_POOL_KV_KEY, CODEX_MODELS_KV_KEY, resetCodexAuthCacheForTest } = await import("../src/codex/auth.ts");
const { fetchCodexModels, loadFullCodexModelsSnapshot } = await import("../src/models/codex-models-fetch.ts");
const {
  codexModelUnavailableAccounts,
  getCodexAccountModelsCacheForTest,
  recordCodexAccountCatalogs,
  recordCodexModelUnsupported,
  resetCodexAccountModelsCacheForTest,
} = await import("../src/models/codex-models-availability.ts");
const { setProviderCapacitySampleTriggerForTest } = await import("../src/provider/capacity-events.ts");
const { buildModelCatalogSnapshot } = await import("../src/models/catalog.ts");
const { RUNTIME_CONFIG_V2_KEY, resetRuntimeConfigCacheForTest } = await import("../src/runtime-config.ts");
const { handleCodexCatalogModels } = await import("../src/catalog/index.ts");
const { resetCodexCatalogMemoForTest } = await import("../src/catalog/store.ts");
setProviderCapacitySampleTriggerForTest(() => {});

const ACCOUNT = "bounded-catalog-account";
const MODEL = "bounded-catalog-model";
const VERSION = "0.160.0";
const BYTE_CAP = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const catalog = JSON.stringify({ models: [{ slug: MODEL, supported_reasoning_levels: [{ effort: "ultra", description: "Native tier" }] }] });

const seedRejection = async (): Promise<SentinelKvStub> => {
  const kv = new SentinelKvStub();
  setKvForTest(kv);
  resetCodexAuthCacheForTest();
  resetCodexAccountModelsCacheForTest();
  await kv.set(CODEX_AUTH_POOL_KV_KEY, {
    accounts: [{ account_id: ACCOUNT, access_token: "synthetic-access", refresh_token: "synthetic-refresh", updated_at_ms: Date.now() }],
    updated_at_ms: Date.now(),
  });
  await recordCodexModelUnsupported(ACCOUNT, MODEL);
  return kv;
};

/** A watchdog diagnoses an unbounded observer without leaving its timer behind. */
const withinBudget = async (pending: Promise<Response>): Promise<Response> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Catalog observation exceeded its one-second deadline plus tolerance"));
        }, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Instrument native tee readers while preserving their real cancellation semantics. */
const traceClone = (response: Response) => {
  const trace = { clone: null as Response | null, bytesRead: 0, releases: 0, cancellation: null as Promise<void> | null, cancellationSettled: false };
  const markCancellationSettled = (): void => {
    trace.cancellationSettled = true;
  };
  const nativeClone = response.clone.bind(response);
  response.clone = () => {
    const clone = nativeClone();
    trace.clone = clone;
    assert.ok(clone.body);
    const nativeGetReader = clone.body.getReader.bind(clone.body);
    Object.defineProperty(clone.body, "getReader", {
      value: () => {
        const reader = nativeGetReader();
        const nativeRead = reader.read.bind(reader);
        const nativeCancel = reader.cancel.bind(reader);
        const nativeRelease = reader.releaseLock.bind(reader);
        reader.read = async (): Promise<{ done: true; value: undefined } | { done: false; value: Uint8Array<ArrayBuffer> }> => {
          const result = await nativeRead();
          if (result.done) return { done: true, value: undefined };
          trace.bytesRead += result.value.byteLength;
          return { done: false, value: result.value };
        };
        reader.cancel = (reason) => {
          trace.cancellation = nativeCancel(reason);
          void trace.cancellation.then(markCancellationSettled, markCancellationSettled);
          return trace.cancellation;
        };
        reader.releaseLock = () => {
          trace.releases += 1;
          nativeRelease();
        };
        return reader;
      },
    });
    clone.text = () => Promise.reject(new Error("The observer must not decode the full cloned body with text()"));
    return clone;
  };
  return trace;
};

test("single-account catalog: stalled observation returns the original stream without learning partial JSON", async () => {
  await seedRejection();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(encoder.encode(catalog));
    },
  });
  const upstream = new Response(stream, { status: 200, statusText: "Catalog ready", headers: { "Content-Type": "application/json", ETag: '"raw-stalled"' } });
  const trace = traceClone(upstream);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.resolve(upstream));
  const started = performance.now();
  const pending = fetchCodexModels({ clientVersion: VERSION });
  let closed = false;
  try {
    const response = await withinBudget(pending);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 2_000, `native stalled observation returned in ${elapsed.toFixed(0)}ms`);
    assert.equal(response, upstream);
    assert.equal(response.statusText, "Catalog ready");
    assert.equal(response.headers.get("ETag"), '"raw-stalled"');
    assert.equal(response.bodyUsed, false);
    assert.equal(trace.clone?.body?.locked, false);
    assert.equal(trace.releases, 1);
    assert.equal(trace.cancellationSettled, false, "the native tee cancellation stays pending until the original finishes");
    assert.equal(codexModelUnavailableAccounts(MODEL, [ACCOUNT]).has(ACCOUNT), true, "even a valid JSON prefix is not complete evidence");
    assert.equal(getCodexAccountModelsCacheForTest().store?.accounts[ACCOUNT], undefined);
    controller?.enqueue(encoder.encode("\n"));
    controller?.close();
    closed = true;
    assert.equal(await response.text(), `${catalog}\n`, "the original reads bytes supplied after observation timed out");
    await trace.cancellation;
    assert.equal(trace.cancellationSettled, true);
    console.log(`stalled catalog returned in ${elapsed.toFixed(0)}ms; original bytes preserved; native tee cancellation settled after original read`);
  } finally {
    if (!closed) controller?.close();
    await pending;
    globalThis.fetch = originalFetch;
  }
});

test("single-account catalog: oversized observation stops at 4 MiB and preserves the full original", async () => {
  await seedRejection();
  const content = encoder.encode(catalog + " ".repeat(BYTE_CAP * 2));
  const chunkBytes = 64 * 1024;
  let offset = 0;
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === content.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkBytes, content.byteLength);
        controller.enqueue(content.slice(offset, end));
        offset = end;
      },
    }),
    { headers: { "Content-Type": "application/json", ETag: '"raw-oversized"' } }
  );
  const trace = traceClone(upstream);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.resolve(upstream));
  try {
    const response = await withinBudget(fetchCodexModels({ clientVersion: VERSION }));
    assert.equal(response, upstream);
    assert.equal(response.headers.get("ETag"), '"raw-oversized"');
    assert.equal(response.bodyUsed, false);
    assert.equal(trace.bytesRead, BYTE_CAP + chunkBytes, "one overflow chunk establishes that the byte cap was exceeded");
    assert.equal(trace.clone?.body?.locked, false);
    assert.equal(trace.releases, 1);
    assert.equal(trace.cancellationSettled, false, "overflow cancellation must not delay return while the original is unread");
    assert.equal(getCodexAccountModelsCacheForTest().store?.accounts[ACCOUNT], undefined, "a valid truncated prefix never becomes catalog evidence");
    assert.equal(codexModelUnavailableAccounts(MODEL, [ACCOUNT]).has(ACCOUNT), true);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content);
    await trace.cancellation;
    assert.equal(trace.cancellationSettled, true);
    console.log(`oversized clone stopped after ${trace.bytesRead} stream bytes; original ${content.byteLength} bytes preserved`);
  } finally {
    await upstream.body?.cancel().catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test("single-account catalog: complete evidence restores only the advertised account and model before return", async () => {
  await seedRejection();
  await recordCodexModelUnsupported(ACCOUNT, "absent-model");
  await recordCodexModelUnsupported("sibling", MODEL);
  await recordCodexAccountCatalogs([{ accountId: "sibling", clientVersion: VERSION, slugs: ["sibling-only"] }]);
  const upstream = new Response(catalog, { headers: { "Content-Type": "application/json", ETag: '"raw-complete"' } });
  const trace = traceClone(upstream);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.resolve(upstream));
  try {
    const response = await fetchCodexModels({ clientVersion: VERSION });
    assert.equal(response, upstream);
    assert.equal(response.headers.get("ETag"), '"raw-complete"');
    assert.equal(trace.releases, 1);
    assert.equal(trace.cancellation, null);
    assert.equal(codexModelUnavailableAccounts(MODEL, [ACCOUNT]).has(ACCOUNT), false);
    assert.equal(codexModelUnavailableAccounts("absent-model", [ACCOUNT]).has(ACCOUNT), true);
    assert.equal(codexModelUnavailableAccounts(MODEL, ["sibling"]).has("sibling"), true);
    assert.deepEqual(getCodexAccountModelsCacheForTest().store?.accounts.sibling.slugs, ["sibling-only"]);
    assert.equal(await response.text(), catalog);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("single-account catalog: 304, malformed, failed and errored bodies never create availability evidence", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const upstream of [
      new Response(null, { status: 304, headers: { ETag: '"raw-not-modified"' } }),
      new Response("not json"),
      new Response('{"data":[]}'),
      new Response(catalog, { status: 500 }),
      new Response(
        new ReadableStream({
          start: (controller) => {
            controller.error(new Error("synthetic stream failure"));
          },
        })
      ),
    ]) {
      await seedRejection();
      const trace = traceClone(upstream);
      globalThis.fetch = createFetchMock(() => Promise.resolve(upstream));
      const response = await fetchCodexModels({ clientVersion: VERSION, ifNoneMatch: '"raw-not-modified"' });
      assert.equal(response, upstream);
      assert.equal(codexModelUnavailableAccounts(MODEL, [ACCOUNT]).has(ACCOUNT), true);
      assert.equal(getCodexAccountModelsCacheForTest().store?.accounts[ACCOUNT], undefined);
      if (response.status === 304 || !response.ok) assert.equal(trace.clone, null, "unsuccessful responses have no body observation");
      await response.text().catch(() => {});
      await trace.cancellation?.catch(() => {});
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog observation preserves the optional full-snapshot read failure boundary", async () => {
  const kv = await seedRejection();
  resetRuntimeConfigCacheForTest();
  await kv.set(RUNTIME_CONFIG_V2_KEY, {
    version: 2,
    default_model: MODEL,
    default_reasoning_effort: "none",
    codex_models: { source: "chatgpt_codex", client_version: VERSION, updated_at_ms: Date.now(), models: [{ slug: MODEL }] },
    updated_at_ms: Date.now(),
  });
  const nativeGet = kv.get.bind(kv);
  kv.get = <T = unknown>(key: KvKey): Promise<KvEntryMaybe<T>> =>
    JSON.stringify(key) === JSON.stringify(CODEX_MODELS_KV_KEY) ? Promise.reject(new Error("synthetic optional read failure")) : nativeGet<T>(key);
  assert.equal(await loadFullCodexModelsSnapshot(kv), null);
  const snapshot = await buildModelCatalogSnapshot();
  assert.ok(
    snapshot.models.some((model) => model.id === MODEL),
    "the real catalog builder still serves the runtime fallback"
  );
});

test("bounded single-account observation keeps versioned client validators separate from upstream revalidation", async () => {
  const kv = await seedRejection();
  resetCodexCatalogMemoForTest();
  resetRuntimeConfigCacheForTest();
  const originalFetch = globalThis.fetch;
  const rawEtag = '"upstream-bounded-catalog"';
  let upstreamIfNoneMatch: string | null = null;
  globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    upstreamIfNoneMatch = new Headers(init?.headers).get("If-None-Match");
    return Promise.resolve(new Response(catalog, { headers: { "Content-Type": "application/json", ETag: rawEtag } }));
  });
  try {
    const request = (etag?: string) => new Request(`https://ai.ubq.fi/v1/models?client_version=${VERSION}`, { headers: etag ? { "If-None-Match": etag } : {} });
    const first = await handleCodexCatalogModels(request(), VERSION);
    assert.equal(first.status, 200);
    const clientEtag = first.headers.get("ETag");
    assert.match(clientEtag ?? "", /^"uos-catalog-[a-f0-9]{32}"$/);
    assert.notEqual(clientEtag, rawEtag);
    assert.equal(await first.text(), catalog);
    const key = ["ubq_ai", "codex_catalog", VERSION];
    const entry = await kv.get<Record<string, unknown>>(key);
    assert.equal(entry.value?.etag, rawEtag, "upstream ETag stays source metadata");
    await kv.set(key, { ...entry.value, fetched_at_ms: Date.now() - 310_000 });
    resetCodexCatalogMemoForTest();
    globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      upstreamIfNoneMatch = new Headers(init?.headers).get("If-None-Match");
      return Promise.resolve(new Response(null, { status: 304, headers: { ETag: rawEtag } }));
    });
    const matched = await handleCodexCatalogModels(request(clientEtag ?? undefined), VERSION);
    assert.equal(upstreamIfNoneMatch, rawEtag);
    assert.equal(matched.status, 304);
    assert.equal(matched.headers.get("ETag"), clientEtag);
    assert.equal(await matched.text(), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
