import { test, beforeEach, afterEach } from "bun:test";
import type { KvKey } from "#kv";
import { installHarness, cleanupHarness } from "./helpers/embeddings-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// embeddings suite part: tests moved out of tests/embeddings.test.ts.

import assert from "node:assert/strict";
import {
  EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS,
  EMBEDDINGS_IDEMPOTENCY_MAX_RESPONSE_CHUNKS,
  EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS,
  type TestDimension,
  bumpKvVersion,
  embeddingsCacheGlobalIndexKey,
  embeddingsCacheKey,
  embeddingsProfileKey,
  handleEmbeddingsJobCreate,
  handleEmbeddingsJobGet,
  handleUosEmbeddings,
  keyHasPrefix,
  keyToString,
  kvExpirations,
  kvStore,
  kvStub,
  resetVoyageRateLimit,
  responseErrorCode,
  setFailNextAtomicCommit,
  sha256Hex,
  testVector,
  uosEmbeddingsIdempotencyFingerprint,
  uosEmbeddingsIdempotencyRecordKey,
  uosEmbeddingsIdempotencyResponsePrefix,
  uosIdempotencyUsageContext,
  uosIdempotentRequest,
  voyageOkResponse,
  withFetchMock,
} from "./helpers/embeddings-harness.ts";

test("embeddings: normalizes string input", async () => {
  resetVoyageRateLimit();
  const response = await withFetchMock(
    (url, bodyText, headers) => {
      assert.equal(url, "https://api.voyageai.com/v1/embeddings");
      assert.equal(headers.get("authorization"), "Bearer voyage_test_key");
      const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
      assert.deepEqual(body, {
        model: "voyage-4-large",
        input: "hello",
        input_type: "document",
        output_dimension: 1024,
        output_dtype: "float",
        truncation: true,
      });
      assert.equal("encoding_format" in body, false);
      assert.equal("output_encoding" in body, false);
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return voyageOkResponse(count);
    },
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: "hello", user: null }),
        })
      )
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    object?: string;
    model?: string;
    data?: { object?: string; index?: number; embedding?: unknown }[];
    usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
  };
  assert.equal(payload.object, "list");
  assert.equal(payload.model, "voyage-4-large");
  assert.equal(typeof payload.usage?.prompt_tokens, "number");
  assert.equal(typeof payload.usage?.total_tokens, "number");
  assert.equal(payload.usage?.prompt_tokens, 5);
  assert.equal(payload.usage.total_tokens, 5);
  assert.ok(Array.isArray(payload.data));
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0]?.object, "embedding");
  assert.equal(payload.data[0]?.index, 0);
  assert.ok(Array.isArray(payload.data[0]?.embedding));
  assert.equal((payload.data[0]?.embedding as unknown[]).length, 1024);
  assert.equal(response.headers.get("x-uos-upstream"), "voyage");
});

test("uos embeddings: forwards synchronous query and document profiles", async () => {
  const cases = [
    {
      inputType: "query" as const,
      dimensions: 256 as const,
      truncation: false,
    },
    {
      inputType: "document" as const,
      dimensions: 2048 as const,
      truncation: true,
    },
  ];
  const seenBodies: Record<string, unknown>[] = [];

  await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
      seenBodies.push(body);
      return voyageOkResponse(1, body.output_dimension as TestDimension);
    },
    async () => {
      for (const item of cases) {
        resetVoyageRateLimit();
        const response = await handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input: `${item.inputType}-${crypto.randomUUID()}`,
              input_type: item.inputType,
              dimensions: item.dimensions,
              truncation: item.truncation,
            }),
          })
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "voyage");
        const payload = (await response.json()) as { data?: { embedding?: unknown }[] };
        assert.equal((payload.data?.[0]?.embedding as unknown[]).length, item.dimensions);
      }
    }
  );

  assert.equal(seenBodies.length, 2);
  for (let index = 0; index < cases.length; index += 1) {
    const expected = cases[index];
    const body = seenBodies[index];
    assert.ok(expected);
    assert.ok(body);
    assert.equal(body.model, "voyage-4-large");
    assert.equal(body.input_type, expected.inputType);
    assert.equal(body.output_dimension, expected.dimensions);
    assert.equal(body.output_dtype, "float");
    assert.equal(body.truncation, expected.truncation);
    assert.equal("encoding_format" in body, false);
    assert.equal("output_encoding" in body, false);
  }
});

test("uos embeddings idempotency: replays the stored validated response without another Voyage call", async () => {
  resetVoyageRateLimit();
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const input = `idempotency-replay-${crypto.randomUUID()}`;
  const usageContext = uosIdempotencyUsageContext("account-replay");
  let upstreamCalls = 0;

  await withFetchMock(
    () => {
      upstreamCalls += 1;
      return voyageOkResponse(1);
    },
    async () => {
      const first = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("x-uos-idempotency-replayed"), null);
      const firstBody = await first.text();

      const replay = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get("x-uos-idempotency-replayed"), "true");
      assert.equal(await replay.text(), firstBody);
    }
  );

  assert.equal(upstreamCalls, 1);
});

test("uos embeddings idempotency: same principal and key reject a different ordered request fingerprint", async () => {
  resetVoyageRateLimit();
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const usageContext = uosIdempotencyUsageContext("account-conflict");
  let upstreamCalls = 0;

  await withFetchMock(
    () => {
      upstreamCalls += 1;
      return voyageOkResponse(2);
    },
    async () => {
      const first = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, ["first", "second"]), usageContext);
      assert.equal(first.status, 200);

      const conflict = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, ["second", "first"]), usageContext);
      assert.equal(conflict.status, 409);
      assert.equal(await responseErrorCode(conflict), "embedding_idempotency_conflict");
    }
  );

  assert.equal(upstreamCalls, 1);
});

test("uos embeddings idempotency: a concurrent replay cannot dispatch Voyage twice", async () => {
  resetVoyageRateLimit();
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const input = `idempotency-concurrent-${crypto.randomUUID()}`;
  const usageContext = uosIdempotencyUsageContext("account-concurrent");
  let upstreamCalls = 0;
  let signalUpstreamEntered = () => {};
  const upstreamEntered = new Promise<void>((resolve) => {
    signalUpstreamEntered = resolve;
  });
  let releaseUpstream = (_response: Response) => {};
  const upstreamResult = new Promise<Response>((resolve) => {
    releaseUpstream = resolve;
  });

  await withFetchMock(
    async () => {
      upstreamCalls += 1;
      signalUpstreamEntered();
      return await upstreamResult;
    },
    async () => {
      const firstPromise = handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      await upstreamEntered;

      const concurrent = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      assert.equal(concurrent.status, 409);
      assert.equal(concurrent.headers.get("Retry-After"), "1");
      assert.equal(await responseErrorCode(concurrent), "embedding_idempotency_in_progress");
      assert.equal(upstreamCalls, 1);

      releaseUpstream(voyageOkResponse(1));
      const first = await firstPromise;
      assert.equal(first.status, 200);
    }
  );

  assert.equal(upstreamCalls, 1);
});

test("uos embeddings idempotency: keyed requests fail before Voyage when durable KV is unavailable", async () => {
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const usageContext = uosIdempotencyUsageContext("account-no-kv");
  let upstreamCalls = 0;

  const response = await withFetchMock(
    () => {
      upstreamCalls += 1;
      return voyageOkResponse(1);
    },
    () => handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, `idempotency-no-kv-${crypto.randomUUID()}`), usageContext, { kv: null })
  );

  assert.equal(response.status, 503);
  assert.equal(await responseErrorCode(response), "embedding_idempotency_unavailable");
  assert.equal(upstreamCalls, 0);
});

test("embeddings: quota dispatch failures release idempotency and promptly requeue jobs", async () => {
  const { ApiKeyQuotaDispatchError } = await import("../src/api-key-policy.ts");
  const idempotencyKey = `embedding-quota-dispatch-${crypto.randomUUID()}`;
  const input = `quota-dispatch-${crypto.randomUUID()}`;
  const principal = "account-quota-dispatch";
  const usageContext = uosIdempotencyUsageContext(principal);
  const quotaFailureContext = {
    ...usageContext,
    beforeProviderDispatch: () => Promise.reject(new ApiKeyQuotaDispatchError("simulated dispatch CAS failure")),
  };
  let upstreamCalls = 0;

  await withFetchMock(
    () => {
      upstreamCalls += 1;
      return voyageOkResponse(1);
    },
    async () => {
      resetVoyageRateLimit();
      const failed = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), quotaFailureContext);
      assert.equal(failed.status, 503);
      assert.equal(await responseErrorCode(failed), "api_key_quota_reservation_unavailable");
      assert.equal(upstreamCalls, 0);

      const retried = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      assert.equal(retried.status, 200);
      assert.equal(upstreamCalls, 1);

      const jobToken = `quota-job-${crypto.randomUUID()}`;
      const jobQueued = await handleEmbeddingsJobCreate(
        new Request("https://ai.ubq.fi/uos/embedding-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input: `quota-job-${crypto.randomUUID()}`,
            input_type: "document",
          }),
        }),
        jobToken,
        quotaFailureContext
      );
      assert.equal(jobQueued.status, 202);
      assert.equal(jobQueued.headers.get("Retry-After"), "1");
      const queuedJob = (await jobQueued.json()) as { id?: unknown; status?: unknown };
      assert.equal(queuedJob.status, "queued");
      assert.equal(typeof queuedJob.id, "string");
      const queuedJobId = queuedJob.id as string;
      assert.equal(upstreamCalls, 1);

      resetVoyageRateLimit();
      const completedJob = await handleEmbeddingsJobGet(
        new Request(`https://ai.ubq.fi/uos/embedding-jobs/${queuedJobId}`),
        jobToken,
        queuedJobId,
        usageContext
      );
      assert.equal(completedJob.status, 200);
      const completedPayload = (await completedJob.json()) as { status?: unknown };
      assert.equal(completedPayload.status, "succeeded");
      assert.equal(upstreamCalls, 2);
    }
  );
});

test("uos embeddings idempotency: an outcome-unknown dispatch is durable and never sent again", async () => {
  resetVoyageRateLimit();
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const input = `idempotency-indeterminate-${crypto.randomUUID()}`;
  const usageContext = uosIdempotencyUsageContext("account-indeterminate");
  let upstreamCalls = 0;

  await withFetchMock(
    () => {
      upstreamCalls += 1;
      throw new TypeError("simulated connection loss after dispatch");
    },
    async () => {
      const first = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      assert.equal(first.status, 409);
      assert.equal(await responseErrorCode(first), "embedding_idempotency_indeterminate");

      const replay = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      assert.equal(replay.status, 409);
      assert.equal(await responseErrorCode(replay), "embedding_idempotency_indeterminate");
    }
  );

  assert.equal(upstreamCalls, 1);
});

test("uos embeddings idempotency: an abandoned dispatched ledger fails closed without Voyage", async () => {
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const input = `idempotency-abandoned-${crypto.randomUUID()}`;
  const principal = "account-abandoned";
  const ledgerKey = await uosEmbeddingsIdempotencyRecordKey(principal, idempotencyKey);
  const fingerprint = await uosEmbeddingsIdempotencyFingerprint([input]);
  const now = Date.now();
  kvStore.set(keyToString(ledgerKey), {
    v: 1,
    fingerprint,
    state: "dispatched",
    owner_request_id: "crashed-request",
    created_at_ms: now - 120_000,
    updated_at_ms: now - 120_000,
    lease_until_ms: now - 60_000,
    response_status: null,
    response_content_type: null,
    response_generation: null,
    response_chunk_count: null,
    response_sha256: null,
  });
  let upstreamCalls = 0;

  try {
    const response = await withFetchMock(
      () => {
        upstreamCalls += 1;
        return voyageOkResponse(1);
      },
      () => handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), uosIdempotencyUsageContext(principal))
    );

    assert.equal(response.status, 409);
    assert.equal(await responseErrorCode(response), "embedding_idempotency_indeterminate");
    assert.equal(upstreamCalls, 0);
    const stored = kvStore.get(keyToString(ledgerKey)) as { state?: unknown } | undefined;
    assert.equal(stored?.state, "indeterminate");
  } finally {
    kvStore.delete(keyToString(ledgerKey));
  }
});

test("uos embeddings idempotency: confirmed HTTP failures re-arm the key for a later retry", async () => {
  resetVoyageRateLimit();
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const input = `idempotency-explicit-retry-${crypto.randomUUID()}`;
  const usageContext = uosIdempotencyUsageContext("account-explicit-retry");
  let upstreamCalls = 0;

  await withFetchMock(
    () => {
      upstreamCalls += 1;
      if (upstreamCalls <= 3) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "0.001" },
        });
      }
      return voyageOkResponse(1);
    },
    async () => {
      const failed = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      assert.equal(failed.status, 429);
      assert.equal(await responseErrorCode(failed), "rate_limit_exceeded");

      const retry = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get("x-uos-idempotency-replayed"), null);
    }
  );

  assert.equal(upstreamCalls, 4);
});

test("uos embeddings idempotency: an expired owner cannot overwrite the published response generation", async () => {
  resetVoyageRateLimit();
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const input = `idempotency-owner-generation-${crypto.randomUUID()}`;
  const principal = "account-owner-generation";
  const usageContext = uosIdempotencyUsageContext(principal);
  const ledgerKey = await uosEmbeddingsIdempotencyRecordKey(principal, idempotencyKey);
  const responsePrefix = await uosEmbeddingsIdempotencyResponsePrefix(principal, idempotencyKey);
  const fingerprint = await uosEmbeddingsIdempotencyFingerprint([input]);
  const expiredGeneration = "expired-owner";
  const now = Date.now();
  kvStore.set(keyToString(ledgerKey), {
    v: 1,
    fingerprint,
    state: "reserved",
    owner_request_id: expiredGeneration,
    created_at_ms: now - 120_000,
    updated_at_ms: now - 120_000,
    lease_until_ms: now - 60_000,
    response_status: null,
    response_content_type: null,
    response_generation: null,
    response_chunk_count: null,
    response_sha256: null,
  });
  bumpKvVersion(keyToString(ledgerKey));
  let upstreamCalls = 0;

  try {
    await withFetchMock(
      () => {
        upstreamCalls += 1;
        return voyageOkResponse(1);
      },
      async () => {
        const first = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
        assert.equal(first.status, 200);
        const firstBody = await first.text();
        const stored = kvStore.get(keyToString(ledgerKey)) as {
          state?: unknown;
          response_generation?: unknown;
          response_chunk_count?: unknown;
        };
        assert.equal(stored.state, "succeeded");
        assert.equal(typeof stored.response_generation, "string");
        assert.notEqual(stored.response_generation, expiredGeneration);
        assert.equal(typeof stored.response_chunk_count, "number");

        const publishedGeneration = stored.response_generation as string;
        const publishedChunkKey: KvKey = [...responsePrefix, publishedGeneration, 0];
        const ledgerExpiresInMs = kvExpirations.get(keyToString(ledgerKey));
        const publishedChunkExpiresInMs = kvExpirations.get(keyToString(publishedChunkKey));
        assert.equal(ledgerExpiresInMs, EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS);
        assert.equal(publishedChunkExpiresInMs, EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS);
        // The response chunks the gateway actually wrote must outlive the ledger
        // record, otherwise a replay could resurrect an expired ledger entry.
        assert(publishedChunkExpiresInMs > ledgerExpiresInMs);

        // A late write from the expired owner lands in its own generation and
        // cannot corrupt the response generation already published by CAS.
        const expiredChunkKey: KvKey = [...responsePrefix, expiredGeneration, 0];
        await kvStub.set(expiredChunkKey, "late stale owner body", { expireIn: EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS });
        assert.equal(kvExpirations.get(keyToString(expiredChunkKey)), EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS);

        const replay = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), usageContext);
        assert.equal(replay.status, 200);
        assert.equal(replay.headers.get("x-uos-idempotency-replayed"), "true");
        assert.equal(await replay.text(), firstBody);
      }
    );
    assert.equal(upstreamCalls, 1);
  } finally {
    for (const rawKey of [...kvStore.keys()]) {
      const key = JSON.parse(rawKey) as KvKey;
      if (keyHasPrefix(key, ledgerKey) || keyHasPrefix(key, responsePrefix)) {
        kvStore.delete(rawKey);
        kvExpirations.delete(rawKey);
      }
    }
  }
});

test("uos embeddings idempotency: rejects an oversized stored response chunk count without reading chunks", async () => {
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const input = `idempotency-chunk-bound-${crypto.randomUUID()}`;
  const principal = "account-chunk-bound";
  const ledgerKey = await uosEmbeddingsIdempotencyRecordKey(principal, idempotencyKey);
  const fingerprint = await uosEmbeddingsIdempotencyFingerprint([input]);
  const oversizedChunkCount = EMBEDDINGS_IDEMPOTENCY_MAX_RESPONSE_CHUNKS + 1;
  const now = Date.now();
  kvStore.set(keyToString(ledgerKey), {
    v: 1,
    fingerprint,
    state: "succeeded",
    owner_request_id: null,
    created_at_ms: now,
    updated_at_ms: now,
    lease_until_ms: null,
    response_status: 200,
    response_content_type: "application/json",
    response_generation: "oversized-generation",
    response_chunk_count: oversizedChunkCount,
    response_sha256: await sha256Hex("oversized"),
  });
  bumpKvVersion(keyToString(ledgerKey));
  let upstreamCalls = 0;

  try {
    const response = await withFetchMock(
      () => {
        upstreamCalls += 1;
        return voyageOkResponse(1);
      },
      () => handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, input), uosIdempotencyUsageContext(principal))
    );

    assert.equal(response.status, 409);
    assert.equal(await responseErrorCode(response), "embedding_idempotency_indeterminate");
    assert.equal(upstreamCalls, 0);
    const stored = kvStore.get(keyToString(ledgerKey)) as {
      state?: unknown;
      response_chunk_count?: unknown;
    };
    assert.equal(stored.state, "succeeded");
    assert.equal(stored.response_chunk_count, oversizedChunkCount);
  } finally {
    kvStore.delete(keyToString(ledgerKey));
  }
});

test("uos embeddings idempotency: a malformed stored value is not mistaken for an absent CAS entry", async () => {
  const idempotencyKey = `embedding-job-${crypto.randomUUID()}`;
  const principal = "account-malformed-ledger";
  const ledgerKey = await uosEmbeddingsIdempotencyRecordKey(principal, idempotencyKey);
  kvStore.set(keyToString(ledgerKey), null);
  bumpKvVersion(keyToString(ledgerKey));
  let upstreamCalls = 0;

  try {
    const response = await withFetchMock(
      () => {
        upstreamCalls += 1;
        return voyageOkResponse(1);
      },
      () =>
        handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, `idempotency-malformed-ledger-${crypto.randomUUID()}`), uosIdempotencyUsageContext(principal))
    );

    assert.equal(response.status, 409);
    assert.equal(await responseErrorCode(response), "embedding_idempotency_indeterminate");
    assert.equal(upstreamCalls, 0);
    assert.equal(kvStore.has(keyToString(ledgerKey)), true);
    assert.equal(kvStore.get(keyToString(ledgerKey)), null);
  } finally {
    kvStore.delete(keyToString(ledgerKey));
  }
});

test("uos embeddings: accepts every supported standard dimension with the canonical model", async () => {
  const dimensions: TestDimension[] = [256, 512, 1024, 2048];

  await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
      assert.equal(body.model, "voyage-4-large");
      assert.equal(body.input_type, "document");
      assert.equal(body.output_dtype, "float");
      assert.equal(body.truncation, true);
      assert.equal("encoding_format" in body, false);
      assert.equal("output_encoding" in body, false);
      return voyageOkResponse(1, body.output_dimension as TestDimension);
    },
    async () => {
      for (const dimension of dimensions) {
        resetVoyageRateLimit();
        const response = await handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input: `v1-dim-${dimension}-${crypto.randomUUID()}`,
              dimensions: dimension,
            }),
          })
        );
        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
          model?: unknown;
          data?: { embedding?: unknown }[];
        };
        assert.equal(payload.model, "voyage-4-large");
        assert.equal((payload.data?.[0]?.embedding as unknown[]).length, dimension);
      }
    }
  );
});

test("uos embeddings: reject malformed synchronous fields", async () => {
  const requests: (() => Promise<Response>)[] = [
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-3-large",
            input: "x",
          }),
        })
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: "x", dimensions: 768 }),
        })
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: "x", dimensions: 256.5 }),
        })
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: "x", input_type: "index" }),
        })
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: "x", encoding_format: "binary" }),
        })
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input: "x",
            truncation: "false",
          }),
        })
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input: "x",
            user: 42,
          }),
        })
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input: [1],
          }),
        })
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: "x", unsupported: true }),
        })
      ),
  ];

  for (const makeRequest of requests) {
    const response = await makeRequest();
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("x-uos-upstream"), "voyage");
  }
});

test("uos embeddings: rejects OpenAI model names without dispatching Voyage", async () => {
  let upstreamCalls = 0;
  await withFetchMock(
    () => {
      upstreamCalls += 1;
      return voyageOkResponse(1);
    },
    async () => {
      for (const model of ["text-embedding-3-small", "text-embedding-3-large"]) {
        const response = await handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, input: "must-not-dispatch" }),
          })
        );
        assert.equal(response.status, 400);
        const payload = (await response.json()) as { error?: { code?: unknown; param?: unknown } };
        assert.equal(payload.error?.code, "model_not_found");
        assert.equal(payload.error.param, "model");
      }
    }
  );
  assert.equal(upstreamCalls, 0);
});

test("embedding jobs retain their strict Voyage float profile", async () => {
  const requests = [
    { model: "text-embedding-3-small", input: "x", input_type: "document" },
    { model: "voyage-4-large", input: "x" },
    { model: "voyage-4-large", input: "x", input_type: "document", encoding_format: "base64" },
    { model: "voyage-4-large", input: "x", input_type: "document", user: "not-supported" },
  ];
  let upstreamCalls = 0;

  await withFetchMock(
    () => {
      upstreamCalls += 1;
      return voyageOkResponse(1);
    },
    async () => {
      for (const body of requests) {
        const response = await handleEmbeddingsJobCreate(
          new Request("https://ai.ubq.fi/uos/embedding-jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          `jobs-strict-${crypto.randomUUID()}`
        );
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("x-uos-upstream"), "voyage");
      }
    }
  );

  assert.equal(upstreamCalls, 0);
});

test("embeddings: serves cache hits without calling upstream", async () => {
  resetVoyageRateLimit();
  const model = "voyage-4-large";
  const input = `cache-hit-${crypto.randomUUID()}`;
  const hash = await sha256Hex(input);
  const cacheKey = embeddingsCacheKey(hash);
  const cachedEmbedding = testVector(1024, 9.9);
  kvStore.set(keyToString(cacheKey), { embedding: cachedEmbedding, created_at: new Date().toISOString() });

  try {
    const response = await withFetchMock(
      () => {
        throw new Error("Embeddings should not hit upstream when cache is populated");
      },
      () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, input }),
          })
        )
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as { data?: { embedding?: unknown }[] };
    assert.ok(Array.isArray(payload.data));
    assert.deepEqual(payload.data[0]?.embedding, cachedEmbedding);
  } finally {
    kvStore.delete(keyToString(cacheKey));
  }
});

test("embeddings cache: separates query, document, dimensions, encoding, and truncation profiles", async () => {
  const input = `profile-separation-${crypto.randomUUID()}`;
  const hash = await sha256Hex(input);
  const oldIncompleteKey: KvKey = ["embeddings", "v1", "text-embedding-3-small", hash];
  kvStore.set(keyToString(oldIncompleteKey), {
    embedding: testVector(256, 99),
    created_at: new Date().toISOString(),
  });

  const requests = [
    {
      key: embeddingsCacheKey(hash, "query", 256, "float", true),
      run: () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input,
              input_type: "query",
              dimensions: 256,
            }),
          })
        ),
    },
    {
      key: embeddingsCacheKey(hash, "document", 256, "float", true),
      run: () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input,
              input_type: "document",
              dimensions: 256,
            }),
          })
        ),
    },
    {
      key: embeddingsCacheKey(hash, "query", 512, "float", true),
      run: () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input,
              input_type: "query",
              dimensions: 512,
            }),
          })
        ),
    },
    {
      key: embeddingsCacheKey(hash, "query", 256, "float", false),
      run: () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input,
              input_type: "query",
              dimensions: 256,
              truncation: false,
            }),
          })
        ),
    },
    {
      key: embeddingsCacheKey(hash, "document", 256, "base64", true),
      run: () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input,
              dimensions: 256,
              encoding_format: "base64",
            }),
          })
        ),
    },
  ];

  let upstreamCalls = 0;
  try {
    await withFetchMock(
      (_url, bodyText) => {
        upstreamCalls += 1;
        const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
        return voyageOkResponse(1, body.output_dimension as TestDimension);
      },
      async () => {
        for (const item of requests) {
          resetVoyageRateLimit();
          assert.equal((await item.run()).status, 200);
        }
        assert.equal(upstreamCalls, requests.length);

        for (const item of requests) {
          resetVoyageRateLimit();
          assert.equal((await item.run()).status, 200);
        }
      }
    );

    assert.equal(upstreamCalls, requests.length);
    for (const item of requests) {
      assert.ok(kvStore.get(keyToString(item.key)));
    }
  } finally {
    kvStore.delete(keyToString(oldIncompleteKey));
    for (const item of requests) kvStore.delete(keyToString(item.key));
  }
});

test("embeddings cache: ignores a cached vector with the wrong resolved dimension", async () => {
  resetVoyageRateLimit();
  const input = `wrong-cache-length-${crypto.randomUUID()}`;
  const hash = await sha256Hex(input);
  const cacheKey = embeddingsCacheKey(hash, "document", 512);
  kvStore.set(keyToString(cacheKey), {
    embedding: testVector(256),
    created_at: new Date().toISOString(),
  });

  let upstreamCalls = 0;
  try {
    const response = await withFetchMock(
      (_url, bodyText) => {
        upstreamCalls += 1;
        const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
        return voyageOkResponse(1, body.output_dimension as TestDimension);
      },
      () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input,
              dimensions: 512,
            }),
          })
        )
    );

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls, 1);
    const payload = (await response.json()) as { data?: { embedding?: unknown }[] };
    assert.equal((payload.data?.[0]?.embedding as unknown[]).length, 512);
  } finally {
    kvStore.delete(keyToString(cacheKey));
  }
});

test("embeddings: writes cache entries on upstream misses", async () => {
  resetVoyageRateLimit();
  const model = "voyage-4-large";
  const input = `cache-miss-${crypto.randomUUID()}`;
  const hash = await sha256Hex(input);
  const cacheProfileKey = embeddingsProfileKey();
  const cacheKey = embeddingsCacheKey(hash);
  const byHashKey: KvKey = ["embeddings", "v2", "cache_index_by_hash", cacheProfileKey, hash];
  const fixedNowMs = 1_700_000_000_000;
  const indexKey: KvKey = ["embeddings", "v2", "cache_index", cacheProfileKey, fixedNowMs, hash];
  kvStore.delete(keyToString(cacheKey));
  kvStore.delete(keyToString(byHashKey));
  kvStore.delete(keyToString(indexKey));
  const originalNow = Date.now;
  Date.now = () => fixedNowMs;

  try {
    const response = await withFetchMock(
      (_url, bodyText) => {
        const body = JSON.parse(bodyText ?? "null") as { input?: unknown };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return voyageOkResponse(count);
      },
      () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, input }),
          })
        )
    );

    assert.equal(response.status, 200);
    const stored = kvStore.get(keyToString(cacheKey)) as { embedding?: unknown } | undefined;
    assert.ok(stored);
    assert.ok(Array.isArray(stored.embedding));
    assert.equal(kvStore.get(keyToString(byHashKey)), fixedNowMs);
    assert.equal(kvStore.get(keyToString(indexKey)), 1);
  } finally {
    Date.now = originalNow;
    kvStore.delete(keyToString(cacheKey));
    kvStore.delete(keyToString(byHashKey));
    kvStore.delete(keyToString(indexKey));
  }
});

test("embeddings cache: retries cache write when atomic commit fails", async () => {
  resetVoyageRateLimit();
  const model = "voyage-4-large";
  const cacheProfileKey = embeddingsProfileKey();
  const input = `cache-atomic-fail-${crypto.randomUUID()}`;
  const hash = await sha256Hex(input);
  const cacheKey = embeddingsCacheKey(hash);
  const pointerMs = 1_700_000_000_000;
  const byHashKey: KvKey = ["embeddings", "v2", "cache_index_by_hash", cacheProfileKey, hash];
  const indexKey: KvKey = ["embeddings", "v2", "cache_index", cacheProfileKey, pointerMs, hash];
  kvStore.set(keyToString(byHashKey), pointerMs);
  kvStore.delete(keyToString(cacheKey));
  kvStore.delete(keyToString(indexKey));

  setFailNextAtomicCommit((checks) => checks.some((entry) => keyToString(entry.key) === keyToString(byHashKey)));

  try {
    const response = await withFetchMock(
      (_url, bodyText) => {
        const body = JSON.parse(bodyText ?? "null") as { input?: unknown };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return voyageOkResponse(count);
      },
      () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, input }),
          })
        )
    );
    assert.equal(response.status, 200);
    const stored = kvStore.get(keyToString(cacheKey)) as { embedding?: unknown; created_at?: unknown } | undefined;
    assert.ok(stored);
    assert.ok(Array.isArray(stored.embedding));
    assert.equal(stored.created_at, new Date(pointerMs).toISOString());
    assert.equal(kvStore.get(keyToString(byHashKey)), pointerMs);
    assert.equal(kvStore.get(keyToString(indexKey)), 1);
  } finally {
    setFailNextAtomicCommit(null);
    kvStore.delete(keyToString(byHashKey));
    kvStore.delete(keyToString(cacheKey));
    kvStore.delete(keyToString(indexKey));
  }
});

test("embeddings cache: eviction cleans stale duplicate index keys without deleting embeddings", async () => {
  resetVoyageRateLimit();
  const model = "voyage-4-large";
  const cacheProfileKey = embeddingsProfileKey();
  const nowMs = 1_700_000_000_000;

  const hashA = await sha256Hex(`stale-index-${crypto.randomUUID()}`);
  const pointerMs = nowMs - 1_000;
  const staleMs = nowMs - 2_000;
  const cacheKeyA = embeddingsCacheKey(hashA);
  const byHashKeyA: KvKey = ["embeddings", "v2", "cache_index_by_hash", cacheProfileKey, hashA];
  const indexKeyStale: KvKey = ["embeddings", "v2", "cache_index", cacheProfileKey, staleMs, hashA];
  const indexKeyActive: KvKey = ["embeddings", "v2", "cache_index", cacheProfileKey, pointerMs, hashA];
  const globalIndexKeyStale = embeddingsCacheGlobalIndexKey(staleMs, cacheProfileKey, hashA);
  const globalIndexKeyActive = embeddingsCacheGlobalIndexKey(pointerMs, cacheProfileKey, hashA);
  kvStore.set(keyToString(byHashKeyA), pointerMs);
  const activeEmbedding = testVector(1024, 1);
  kvStore.set(keyToString(cacheKeyA), {
    embedding: activeEmbedding,
    created_at: new Date(pointerMs).toISOString(),
  });
  kvStore.set(keyToString(indexKeyStale), 1);
  kvStore.set(keyToString(indexKeyActive), 1);
  kvStore.set(keyToString(globalIndexKeyStale), 1);
  kvStore.set(keyToString(globalIndexKeyActive), 1);

  // Populate enough older entries so a quota-eviction batch cleans the stale index key
  // without touching the active index key for hashA.
  const oldKeyStrings: string[] = [];
  for (let i = 0; i < 511; i += 1) {
    const hashOld = `old_${i}_${crypto.randomUUID().replace(/-/g, "")}`;
    const createdAtMs = nowMs - 100_000 - i;
    const cacheKeyOld = embeddingsCacheKey(hashOld);
    const byHashKeyOld: KvKey = ["embeddings", "v2", "cache_index_by_hash", cacheProfileKey, hashOld];
    const indexKeyOld: KvKey = ["embeddings", "v2", "cache_index", cacheProfileKey, createdAtMs, hashOld];
    const globalIndexKeyOld = embeddingsCacheGlobalIndexKey(createdAtMs, cacheProfileKey, hashOld);
    kvStore.set(keyToString(cacheKeyOld), {
      embedding: testVector(1024),
      created_at: new Date(createdAtMs).toISOString(),
    });
    kvStore.set(keyToString(byHashKeyOld), createdAtMs);
    kvStore.set(keyToString(indexKeyOld), 1);
    kvStore.set(keyToString(globalIndexKeyOld), 1);
    oldKeyStrings.push(keyToString(cacheKeyOld), keyToString(byHashKeyOld), keyToString(indexKeyOld), keyToString(globalIndexKeyOld));
  }

  const originalNow = Date.now;
  Date.now = () => nowMs;

  const inputB = `evict-${crypto.randomUUID()}`;
  const hashB = await sha256Hex(inputB);
  const cacheKeyB = embeddingsCacheKey(hashB);
  const byHashKeyB: KvKey = ["embeddings", "v2", "cache_index_by_hash", cacheProfileKey, hashB];
  const indexKeyB: KvKey = ["embeddings", "v2", "cache_index", cacheProfileKey, nowMs, hashB];
  const globalIndexKeyB = embeddingsCacheGlobalIndexKey(nowMs, cacheProfileKey, hashB);
  kvStore.delete(keyToString(cacheKeyB));
  kvStore.delete(keyToString(byHashKeyB));
  kvStore.delete(keyToString(indexKeyB));
  kvStore.delete(keyToString(globalIndexKeyB));

  try {
    // Simulate KV storage quota failure on the first attempt to cache inputB.
    setFailNextAtomicCommit((_checks, ops) => {
      const hitsCacheWrite = ops.some((op) => op.type === "set" && keyToString(op.key) === keyToString(cacheKeyB));
      return hitsCacheWrite ? new Error("KV quota exceeded") : false;
    });

    const response = await withFetchMock(
      (_url, bodyText) => {
        const body = JSON.parse(bodyText ?? "null") as { input?: unknown };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return voyageOkResponse(count);
      },
      () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, input: inputB }),
          })
        )
    );
    assert.equal(response.status, 200);
    assert.equal(kvStore.get(keyToString(indexKeyStale)), undefined);
    assert.equal(kvStore.get(keyToString(globalIndexKeyStale)), undefined);
    assert.deepEqual(kvStore.get(keyToString(cacheKeyA)), {
      embedding: activeEmbedding,
      created_at: new Date(pointerMs).toISOString(),
    });
    assert.equal(kvStore.get(keyToString(byHashKeyA)), pointerMs);
    assert.equal(kvStore.get(keyToString(indexKeyActive)), 1);
    assert.equal(kvStore.get(keyToString(globalIndexKeyActive)), 1);
    assert.ok(kvStore.get(keyToString(cacheKeyB)));
    assert.equal(kvStore.get(keyToString(byHashKeyB)), nowMs);
    assert.equal(kvStore.get(keyToString(indexKeyB)), 1);
    assert.equal(kvStore.get(keyToString(globalIndexKeyB)), 1);
  } finally {
    Date.now = originalNow;
    setFailNextAtomicCommit(null);
    kvStore.delete(keyToString(byHashKeyA));
    kvStore.delete(keyToString(cacheKeyA));
    kvStore.delete(keyToString(indexKeyStale));
    kvStore.delete(keyToString(indexKeyActive));
    kvStore.delete(keyToString(globalIndexKeyStale));
    kvStore.delete(keyToString(globalIndexKeyActive));
    kvStore.delete(keyToString(cacheKeyB));
    kvStore.delete(keyToString(byHashKeyB));
    kvStore.delete(keyToString(indexKeyB));
    kvStore.delete(keyToString(globalIndexKeyB));
    for (const key of oldKeyStrings) kvStore.delete(key);
  }
});

test("embeddings cache: quota eviction frees entries owned by another profile", async () => {
  resetVoyageRateLimit();
  const oldProfileKey = embeddingsProfileKey("document", 1024, "float", false);
  const newProfileKey = embeddingsProfileKey("query", 256, "float", false);
  const oldCreatedAtMs = 1;
  const newCreatedAtMs = 2;

  const oldHash = await sha256Hex(`old-document-profile-${crypto.randomUUID()}`);
  const oldCacheKey = embeddingsCacheKey(oldHash, "document", 1024, "float", false);
  const oldByHashKey: KvKey = ["embeddings", "v2", "cache_index_by_hash", oldProfileKey, oldHash];
  const oldProfileIndexKey: KvKey = ["embeddings", "v2", "cache_index", oldProfileKey, oldCreatedAtMs, oldHash];
  const oldGlobalIndexKey = embeddingsCacheGlobalIndexKey(oldCreatedAtMs, oldProfileKey, oldHash);
  kvStore.set(keyToString(oldCacheKey), {
    embedding: testVector(1024),
    created_at: new Date(oldCreatedAtMs).toISOString(),
  });
  kvStore.set(keyToString(oldByHashKey), oldCreatedAtMs);
  kvStore.set(keyToString(oldProfileIndexKey), 1);
  kvStore.set(keyToString(oldGlobalIndexKey), 1);

  const input = `new-query-profile-${crypto.randomUUID()}`;
  const newHash = await sha256Hex(input);
  const newCacheKey = embeddingsCacheKey(newHash, "query", 256, "float", false);
  const newByHashKey: KvKey = ["embeddings", "v2", "cache_index_by_hash", newProfileKey, newHash];
  const newProfileIndexKey: KvKey = ["embeddings", "v2", "cache_index", newProfileKey, newCreatedAtMs, newHash];
  const newGlobalIndexKey = embeddingsCacheGlobalIndexKey(newCreatedAtMs, newProfileKey, newHash);
  const originalNow = Date.now;
  Date.now = () => newCreatedAtMs;

  try {
    setFailNextAtomicCommit((_checks, ops) => {
      const hitsNewProfileWrite = ops.some((op) => op.type === "set" && keyToString(op.key) === keyToString(newCacheKey));
      return hitsNewProfileWrite ? new Error("KV quota exceeded") : false;
    });

    const response = await withFetchMock(
      () => voyageOkResponse(1, 256),
      () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input,
              input_type: "query",
              dimensions: 256,
              truncation: false,
            }),
          })
        )
    );

    assert.equal(response.status, 200);
    assert.equal(kvStore.get(keyToString(oldCacheKey)), undefined);
    assert.equal(kvStore.get(keyToString(oldByHashKey)), undefined);
    assert.equal(kvStore.get(keyToString(oldProfileIndexKey)), undefined);
    assert.equal(kvStore.get(keyToString(oldGlobalIndexKey)), undefined);
    assert.ok(kvStore.get(keyToString(newCacheKey)));
    assert.equal(kvStore.get(keyToString(newByHashKey)), newCreatedAtMs);
    assert.equal(kvStore.get(keyToString(newProfileIndexKey)), 1);
    assert.equal(kvStore.get(keyToString(newGlobalIndexKey)), 1);
  } finally {
    Date.now = originalNow;
    setFailNextAtomicCommit(null);
    for (const key of [oldCacheKey, oldByHashKey, oldProfileIndexKey, oldGlobalIndexKey, newCacheKey, newByHashKey, newProfileIndexKey, newGlobalIndexKey]) {
      kvStore.delete(keyToString(key));
    }
  }
});

test("embeddings: returns one data item per array input", async () => {
  resetVoyageRateLimit();
  const response = await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as { input?: unknown };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return voyageOkResponse(count);
    },
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: ["a", "b"] }),
        })
      )
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data?: { index?: number }[] };
  assert.ok(Array.isArray(payload.data));
  assert.equal(payload.data.length, 2);
  assert.equal(payload.data[0]?.index, 0);
  assert.equal(payload.data[1]?.index, 1);
});

test("embeddings: rejects non-string array inputs", async () => {
  const response = await handleUosEmbeddings(
    new Request("https://ai.ubq.fi/uos/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "voyage-4-large", input: ["a", 2] }),
    })
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error?: { param?: unknown } };
  assert.equal(payload.error?.param, "input");
});

test("embeddings: rejects too many inputs", async () => {
  const inputs = Array.from({ length: 129 }, (_, i) => `x${i}`);
  const response = await handleUosEmbeddings(
    new Request("https://ai.ubq.fi/uos/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "voyage-4-large", input: inputs }),
    })
  );
  assert.equal(response.status, 400);
});

test("embeddings: rejects too-large inputs", async () => {
  const tooLarge = "a".repeat(20_001);
  const response = await handleUosEmbeddings(
    new Request("https://ai.ubq.fi/uos/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "voyage-4-large", input: tooLarge }),
    })
  );
  assert.equal(response.status, 400);
});

test("embeddings: encoding_format=base64 returns base64 string embeddings", async () => {
  resetVoyageRateLimit();
  const response = await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
      assert.equal(body.output_dimension, 256);
      assert.equal("encoding_format" in body, false);
      assert.equal("output_encoding" in body, false);
      const embedding = testVector(256);
      embedding[0] = 0.5;
      embedding[1] = -0.5;
      return new Response(
        JSON.stringify({
          data: [{ embedding }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input: "hello",
            dimensions: 256,
            encoding_format: "base64",
            user: "migration-client",
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data?: { embedding?: unknown }[] };
  const emb = payload.data?.[0]?.embedding;
  assert.equal(typeof emb, "string");

  const raw = atob(emb as string);
  assert.equal(raw.length, 256 * 4);
  const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.ok(Math.abs(view.getFloat32(0, true) - 0.5) < 1e-5);
  assert.ok(Math.abs(view.getFloat32(4, true) + 0.5) < 1e-5);
});

test("uos embeddings: rejects fractional dimensions", async () => {
  const response = await handleUosEmbeddings(
    new Request("https://ai.ubq.fi/uos/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "voyage-4-large",
        input: "fractional-dimensions",
        dimensions: 256.5,
      }),
    })
  );

  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error?: { message?: unknown; param?: unknown } };
  assert.match(String(payload.error?.message), /integer/);
  assert.equal(payload.error?.param, "dimensions");
});
