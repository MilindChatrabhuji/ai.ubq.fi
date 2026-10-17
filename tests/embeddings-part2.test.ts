import { test, beforeEach, afterEach } from "bun:test";
import type { KvKey } from "#kv";
import { installHarness, cleanupHarness } from "./helpers/embeddings-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// embeddings suite part: tests moved out of tests/embeddings.test.ts.

import assert from "node:assert/strict";
import {
  EMBEDDINGS_JOB_TTL_MS,
  type TestDimension,
  VOYAGE_RATE_LIMIT_KEY,
  embeddingsCacheKey,
  embeddingsJobKey,
  embeddingsJobLookupKey,
  embeddingsProfileKey,
  getKv,
  handleEmbeddingsJobCreate,
  handleEmbeddingsJobGet,
  handleUosEmbeddings,
  keyHasPrefix,
  keyToString,
  kvExpirations,
  kvStore,
  resetVoyageRateLimit,
  responseErrorCode,
  setFailNextAtomicCommit,
  sha256Hex,
  testVector,
  uosIdempotencyUsageContext,
  uosIdempotentRequest,
  voyageOkResponse,
  waitForAdmission,
  withFetchMock,
} from "./helpers/embeddings-harness.ts";

test("uos embeddings: returns 502 when upstream vector length does not match the resolved dimension", async () => {
  resetVoyageRateLimit();
  const response = await withFetchMock(
    () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: Array.from({ length: 255 }, (_, index) => index / 255) }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input: `wrong-sync-length-${crypto.randomUUID()}`,
            input_type: "query",
            dimensions: 256,
          }),
        })
      )
  );

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-uos-upstream"), "voyage");
  const payload = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
  assert.equal(payload.error?.code, "upstream_dimension_mismatch");
  assert.match(String(payload.error.message), /length 255; expected 256/);
});

test("uos embeddings: sync retry reuses the exact resolved Voyage options", async () => {
  resetVoyageRateLimit();
  const bodies: Record<string, unknown>[] = [];
  const input = `sync-retry-options-${crypto.randomUUID()}`;

  const response = await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "0.001" },
        });
      }
      return voyageOkResponse(1, 512);
    },
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input,
            input_type: "query",
            dimensions: 512,
            truncation: false,
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(bodies[0], {
    model: "voyage-4-large",
    input,
    input_type: "query",
    output_dimension: 512,
    output_dtype: "float",
    truncation: false,
  });
});

test("uos embeddings: exhausted upstream 429 preserves status and Retry-After", async () => {
  resetVoyageRateLimit();
  const bodies: Record<string, unknown>[] = [];
  const input = `sync-exhausted-429-${crypto.randomUUID()}`;

  const response = await withFetchMock(
    (_url, bodyText) => {
      bodies.push(JSON.parse(bodyText ?? "null") as Record<string, unknown>);
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "0.001" },
      });
    },
    () =>
      handleUosEmbeddings(
        new Request("https://ai.ubq.fi/uos/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input,
            input_type: "query",
            dimensions: 512,
            truncation: false,
          }),
        })
      )
  );

  assert.equal(bodies.length, 3);
  assert.ok(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0])));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(response.headers.get("x-uos-upstream"), "voyage");
  const payload = (await response.json()) as { error?: { type?: unknown; code?: unknown } };
  assert.equal(payload.error?.type, "rate_limit_error");
  assert.equal(payload.error.code, "rate_limit_exceeded");
});

test("embeddings: 429 includes Retry-After when KV rate limited", async () => {
  const kv = await getKv();
  assert.ok(kv);
  await kv.set(VOYAGE_RATE_LIMIT_KEY, { window_start_ms: Date.now(), requests: 3, tokens: 0 });
  try {
    const response = await withFetchMock(
      () => {
        throw new Error("Embeddings should be rate limited before upstream fetch");
      },
      () =>
        handleUosEmbeddings(
          new Request("https://ai.ubq.fi/uos/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "voyage-4-large", input: "rate-limit-test" }),
          })
        )
    );
    assert.equal(response.status, 429);
    const retryAfter = response.headers.get("Retry-After");
    assert.ok(retryAfter);
    const retryAfterSeconds = Number(retryAfter);
    assert.ok(Number.isFinite(retryAfterSeconds));
    assert.ok(retryAfterSeconds >= 1);
    assert.ok(retryAfterSeconds <= 60);
  } finally {
    await kv.delete(VOYAGE_RATE_LIMIT_KEY);
  }
});

test("embedding jobs: create returns job + result when not rate limited", async () => {
  resetVoyageRateLimit();
  const input = `job-ok-${crypto.randomUUID()}`;
  const response = await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as { input?: unknown };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return voyageOkResponse(count);
    },
    () =>
      handleEmbeddingsJobCreate(
        new Request("https://ai.ubq.fi/uos/embedding-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input, input_type: "document" }),
        }),
        "test_token"
      )
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    id?: unknown;
    object?: unknown;
    status?: unknown;
    upstream_model?: unknown;
    input_type?: unknown;
    dimensions?: unknown;
    output_dtype?: unknown;
    encoding_format?: unknown;
    truncation?: unknown;
    result?: { object?: unknown; data?: unknown[]; model?: unknown };
  };
  assert.equal(payload.object, "embeddings.job");
  assert.equal(typeof payload.id, "string");
  assert.equal(payload.status, "succeeded");
  assert.equal(payload.upstream_model, "voyage-4-large");
  assert.equal(payload.input_type, "document");
  assert.equal(payload.dimensions, 1024);
  assert.equal(payload.output_dtype, "float");
  assert.equal(payload.encoding_format, "float");
  assert.equal(payload.truncation, true);
  assert.equal(payload.result?.object, "list");
  assert.equal(payload.result.model, "voyage-4-large");
  assert.ok(Array.isArray(payload.result.data));
});

test("embedding jobs: wrong-length upstream vector is a terminal failed job", async () => {
  resetVoyageRateLimit();
  const authToken = `wrong-length-token-${crypto.randomUUID()}`;
  const created = await withFetchMock(
    () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: Array.from({ length: 511 }, (_, index) => index / 511) }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
    () =>
      handleEmbeddingsJobCreate(
        new Request("https://ai.ubq.fi/uos/embedding-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input: `wrong-job-length-${crypto.randomUUID()}`,
            input_type: "document",
            dimensions: 512,
          }),
        }),
        authToken
      )
  );

  assert.equal(created.status, 200);
  assert.equal(created.headers.get("x-uos-upstream"), "voyage");
  const payload = (await created.json()) as {
    id?: unknown;
    status?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  assert.equal(payload.status, "failed");
  assert.equal(payload.error?.code, "embeddings_job_upstream_dimension_mismatch");
  assert.match(String(payload.error.message), /length 511; expected 512/);
  assert.equal(typeof payload.id, "string");

  const jobId = payload.id as string;
  const polled = await withFetchMock(
    () => {
      throw new Error("A terminally failed job must not retry upstream");
    },
    () => handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), authToken, jobId)
  );
  assert.equal(polled.status, 200);
  assert.equal(polled.headers.get("x-uos-upstream"), "voyage");
  const polledPayload = (await polled.json()) as { status?: unknown; error?: { code?: unknown } };
  assert.equal(polledPayload.status, "failed");
  assert.equal(polledPayload.error?.code, "embeddings_job_upstream_dimension_mismatch");
});

test("embedding jobs: remain resolvable across token refresh when scoped to kernel repo", async () => {
  resetVoyageRateLimit();
  const usageContext = {
    keyId: null,
    kernelRepo: { owner: "ubiquity", repo: "ai.ubq.fi" },
    kernelOrg: { owner: "ubiquity" },
  };

  const input = `job-token-refresh-${crypto.randomUUID()}`;
  const created = await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as { input?: unknown };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return voyageOkResponse(count);
    },
    () =>
      handleEmbeddingsJobCreate(
        new Request("https://ai.ubq.fi/uos/embedding-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input, input_type: "document" }),
        }),
        "token_a",
        usageContext
      )
  );

  assert.equal(created.status, 200);
  const createdPayload = (await created.json()) as { id?: unknown; status?: unknown };
  assert.equal(createdPayload.status, "succeeded");
  assert.equal(typeof createdPayload.id, "string");
  const jobId = createdPayload.id as string;

  const got = await withFetchMock(
    () => {
      throw new Error("Embeddings job get should not hit upstream when already succeeded");
    },
    () => handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), "token_b", jobId, usageContext)
  );

  assert.equal(got.status, 200);
  const gotPayload = (await got.json()) as { id?: unknown; status?: unknown };
  assert.equal(gotPayload.id, jobId);
  assert.equal(gotPayload.status, "succeeded");
});

test("embedding jobs: create queues with 202 + Retry-After when KV rate limited", async () => {
  const kv = await getKv();
  assert.ok(kv);
  const rateKey: KvKey = ["embeddings", "v1", "rate", "voyage"];
  await kv.set(rateKey, { window_start_ms: Date.now(), requests: 3, tokens: 0 });
  try {
    const input = `job-queued-${crypto.randomUUID()}`;
    const response = await withFetchMock(
      () => {
        throw new Error("Embeddings job should be queued before upstream fetch");
      },
      () =>
        handleEmbeddingsJobCreate(
          new Request("https://ai.ubq.fi/uos/embedding-jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "voyage-4-large", input, input_type: "query" }),
          }),
          "test_token"
        )
    );

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("x-uos-upstream"), "voyage");
    const retryAfter = response.headers.get("Retry-After");
    assert.ok(retryAfter);
    const retryAfterSeconds = Number(retryAfter);
    assert.ok(Number.isFinite(retryAfterSeconds));
    assert.ok(retryAfterSeconds >= 1);
    assert.ok(retryAfterSeconds <= 60);

    const payload = (await response.json()) as { status?: unknown; id?: unknown };
    assert.equal(payload.status, "queued");
    assert.equal(typeof payload.id, "string");
  } finally {
    await kv.delete(rateKey);
  }
});

test("embedding jobs: queued query and document profiles persist through poll", async () => {
  const kv = await getKv();
  assert.ok(kv);
  await kv.set(VOYAGE_RATE_LIMIT_KEY, { window_start_ms: Date.now(), requests: 3, tokens: 0 });
  const authToken = `queued-profiles-${crypto.randomUUID()}`;
  const cases = [
    {
      input: `queued-query-${crypto.randomUUID()}`,
      inputType: "query" as const,
      dimensions: 256 as const,
      truncation: false,
    },
    {
      input: `queued-document-${crypto.randomUUID()}`,
      inputType: "document" as const,
      dimensions: 2048 as const,
      truncation: true,
    },
  ];
  const jobIds: string[] = [];

  try {
    for (const item of cases) {
      const created = await withFetchMock(
        () => {
          throw new Error("The saturated gateway limit must queue before upstream");
        },
        () =>
          handleEmbeddingsJobCreate(
            new Request("https://ai.ubq.fi/uos/embedding-jobs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "voyage-4-large",
                input: item.input,
                input_type: item.inputType,
                dimensions: item.dimensions,
                truncation: item.truncation,
              }),
            }),
            authToken
          )
      );

      assert.equal(created.status, 202);
      assert.equal(created.headers.get("x-uos-upstream"), "voyage");
      const body = (await created.json()) as {
        id?: unknown;
        status?: unknown;
        upstream_model?: unknown;
        input_type?: unknown;
        dimensions?: unknown;
        output_dtype?: unknown;
        encoding_format?: unknown;
        truncation?: unknown;
      };
      assert.equal(body.status, "queued");
      assert.equal(body.upstream_model, "voyage-4-large");
      assert.equal(body.input_type, item.inputType);
      assert.equal(body.dimensions, item.dimensions);
      assert.equal(body.output_dtype, "float");
      assert.equal(body.encoding_format, "float");
      assert.equal(body.truncation, item.truncation);
      assert.equal(typeof body.id, "string");
      jobIds.push(body.id as string);
    }

    const tokenHash = await sha256Hex(authToken);
    for (let index = 0; index < jobIds.length; index += 1) {
      const jobId = jobIds[index];
      const item = cases[index];
      assert.ok(jobId);
      assert.ok(item);
      const profileKey = embeddingsProfileKey(item.inputType, item.dimensions, "float", item.truncation);
      const jobKey = embeddingsJobKey(tokenHash, profileKey, jobId);
      const lookupKey = embeddingsJobLookupKey(tokenHash, jobId);
      assert.ok(kvStore.has(keyToString(jobKey)));
      assert.deepEqual(kvStore.get(keyToString(lookupKey)), { cache_profile_key: profileKey });
      assert.equal(kvExpirations.get(keyToString(jobKey)), EMBEDDINGS_JOB_TTL_MS);
      assert.equal(kvExpirations.get(keyToString(lookupKey)), EMBEDDINGS_JOB_TTL_MS);

      const other = cases[(index + 1) % cases.length];
      assert.ok(other);
      const otherProfileKey = embeddingsProfileKey(other.inputType, other.dimensions, "float", other.truncation);
      assert.equal(kvStore.has(keyToString(embeddingsJobKey(tokenHash, otherProfileKey, jobId))), false);
      assert.equal(kvStore.has(keyToString(["embeddings", "jobs", "v2", tokenHash, jobId])), false);
    }

    await kv.delete(VOYAGE_RATE_LIMIT_KEY);
    const seenBodies: Record<string, unknown>[] = [];
    await withFetchMock(
      (_url, bodyText) => {
        const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
        seenBodies.push(body);
        return voyageOkResponse(1, body.output_dimension as TestDimension);
      },
      async () => {
        for (let index = 0; index < jobIds.length; index += 1) {
          const jobId = jobIds[index];
          assert.ok(jobId);
          const polled = await handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), authToken, jobId);
          assert.equal(polled.status, 200);
          assert.equal(polled.headers.get("x-uos-upstream"), "voyage");
          const payload = (await polled.json()) as {
            status?: unknown;
            input_type?: unknown;
            dimensions?: unknown;
            truncation?: unknown;
            result?: { data?: { embedding?: unknown }[] };
          };
          const expected = cases[index];
          assert.ok(expected);
          assert.equal(payload.status, "succeeded");
          assert.equal(payload.input_type, expected.inputType);
          assert.equal(payload.dimensions, expected.dimensions);
          assert.equal(payload.truncation, expected.truncation);
          assert.equal((payload.result?.data?.[0]?.embedding as unknown[]).length, expected.dimensions);
        }
      }
    );

    assert.equal(seenBodies.length, cases.length);
    for (let index = 0; index < cases.length; index += 1) {
      const expected = cases[index];
      assert.ok(expected);
      assert.deepEqual(seenBodies[index], {
        model: "voyage-4-large",
        input: expected.input,
        input_type: expected.inputType,
        output_dimension: expected.dimensions,
        output_dtype: "float",
        truncation: expected.truncation,
      });
    }
  } finally {
    await kv.delete(VOYAGE_RATE_LIMIT_KEY);
  }
});

test("embedding jobs: retryable upstream failures requeue and preserve the resolved profile", async () => {
  const retryableStatuses = [429, 500, 502, 503, 504] as const;

  for (const status of retryableStatuses) {
    resetVoyageRateLimit();
    const authToken = `job-retry-${status}-${crypto.randomUUID()}`;
    const input = `job-retry-input-${status}-${crypto.randomUUID()}`;
    const bodies: Record<string, unknown>[] = [];

    const created = await withFetchMock(
      (_url, bodyText) => {
        bodies.push(JSON.parse(bodyText ?? "null") as Record<string, unknown>);
        return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status,
          headers: {
            "Content-Type": "application/json",
            ...(status === 429 ? { "Retry-After": "0.001" } : {}),
          },
        });
      },
      () =>
        handleEmbeddingsJobCreate(
          new Request("https://ai.ubq.fi/uos/embedding-jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voyage-4-large",
              input,
              input_type: "query",
              dimensions: 512,
              truncation: false,
            }),
          }),
          authToken
        )
    );

    assert.equal(created.status, 202);
    assert.ok(created.headers.get("Retry-After"));
    const createdPayload = (await created.json()) as {
      id?: unknown;
      status?: unknown;
      input_type?: unknown;
      dimensions?: unknown;
      truncation?: unknown;
      error?: unknown;
    };
    assert.equal(createdPayload.status, "queued");
    assert.equal(createdPayload.input_type, "query");
    assert.equal(createdPayload.dimensions, 512);
    assert.equal(createdPayload.truncation, false);
    assert.equal(createdPayload.error, null);
    assert.equal(typeof createdPayload.id, "string");
    const jobId = createdPayload.id as string;

    const polled = await withFetchMock(
      (_url, bodyText) => {
        bodies.push(JSON.parse(bodyText ?? "null") as Record<string, unknown>);
        return voyageOkResponse(1, 512);
      },
      () => handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), authToken, jobId)
    );

    assert.equal(polled.status, 200);
    const polledPayload = (await polled.json()) as {
      status?: unknown;
      input_type?: unknown;
      dimensions?: unknown;
      truncation?: unknown;
    };
    assert.equal(polledPayload.status, "succeeded");
    assert.equal(polledPayload.input_type, "query");
    assert.equal(polledPayload.dimensions, 512);
    assert.equal(polledPayload.truncation, false);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], bodies[0]);
    assert.deepEqual(bodies[0], {
      model: "voyage-4-large",
      input,
      input_type: "query",
      output_dimension: 512,
      output_dtype: "float",
      truncation: false,
    });
  }
});

test("embedding jobs: locked and CAS-contention 202 responses identify Voyage", async () => {
  const kv = await getKv();
  assert.ok(kv);
  await kv.set(VOYAGE_RATE_LIMIT_KEY, { window_start_ms: Date.now(), requests: 3, tokens: 0 });
  const authToken = `job-lock-${crypto.randomUUID()}`;
  const created = await withFetchMock(
    () => {
      throw new Error("The saturated gateway limit must queue before upstream");
    },
    () =>
      handleEmbeddingsJobCreate(
        new Request("https://ai.ubq.fi/uos/embedding-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input: `job-lock-input-${crypto.randomUUID()}`,
            input_type: "query",
          }),
        }),
        authToken
      )
  );
  const createdBody = (await created.json()) as { id?: unknown };
  assert.equal(typeof createdBody.id, "string");
  const jobId = createdBody.id as string;
  const tokenHash = await sha256Hex(authToken);
  const jobKey = embeddingsJobKey(tokenHash, embeddingsProfileKey("query"), jobId);
  const stored = kvStore.get(keyToString(jobKey)) as Record<string, unknown> | undefined;
  assert.ok(stored);
  await kv.delete(VOYAGE_RATE_LIMIT_KEY);

  try {
    kvStore.set(keyToString(jobKey), {
      ...stored,
      status: "running",
      locked_until_ms: Date.now() + 30_000,
    });
    const locked = await withFetchMock(
      () => {
        throw new Error("A locked job must not call upstream");
      },
      () => handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), authToken, jobId)
    );
    assert.equal(locked.status, 202);
    assert.equal(locked.headers.get("x-uos-upstream"), "voyage");

    kvStore.set(keyToString(jobKey), {
      ...stored,
      status: "queued",
      locked_until_ms: null,
    });
    setFailNextAtomicCommit((_checks, ops) => ops.some((op) => op.type === "set" && keyToString(op.key) === keyToString(jobKey)));
    const contended = await withFetchMock(
      () => {
        throw new Error("A contended job lock must not call upstream");
      },
      () => handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), authToken, jobId)
    );
    assert.equal(contended.status, 202);
    assert.equal(contended.headers.get("x-uos-upstream"), "voyage");
  } finally {
    setFailNextAtomicCommit(null);
    await kv.delete(VOYAGE_RATE_LIMIT_KEY);
  }
});

test("embedding jobs: poll runs queued job to completion", async () => {
  const kv = await getKv();
  assert.ok(kv);
  const rateKey: KvKey = ["embeddings", "v1", "rate", "voyage"];
  await kv.set(rateKey, { window_start_ms: Date.now(), requests: 3, tokens: 0 });

  const input = `job-poll-${crypto.randomUUID()}`;
  const created = await withFetchMock(
    () => {
      throw new Error("Embeddings job should be queued before upstream fetch");
    },
    () =>
      handleEmbeddingsJobCreate(
        new Request("https://ai.ubq.fi/uos/embedding-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "voyage-4-large",
            input,
            input_type: "query",
            dimensions: 512,
            truncation: false,
          }),
        }),
        "test_token"
      )
  );
  assert.equal(created.status, 202);
  const createdPayload = (await created.json()) as { id?: unknown };
  assert.equal(typeof createdPayload.id, "string");
  const jobId = createdPayload.id as string;

  await kv.delete(rateKey);

  const polled = await withFetchMock(
    (_url, bodyText) => {
      const body = JSON.parse(bodyText ?? "null") as Record<string, unknown>;
      assert.equal(body.model, "voyage-4-large");
      assert.equal(body.input_type, "query");
      assert.equal(body.output_dimension, 512);
      assert.equal(body.output_dtype, "float");
      assert.equal(body.truncation, false);
      assert.equal("encoding_format" in body, false);
      assert.equal("output_encoding" in body, false);
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return voyageOkResponse(count, 512);
    },
    () => handleEmbeddingsJobGet(new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`), "test_token", jobId)
  );

  assert.equal(polled.status, 200);
  const payload = (await polled.json()) as {
    status?: unknown;
    input_type?: unknown;
    dimensions?: unknown;
    truncation?: unknown;
    result?: { data?: { embedding?: unknown }[] };
  };
  assert.equal(payload.status, "succeeded");
  assert.equal(payload.input_type, "query");
  assert.equal(payload.dimensions, 512);
  assert.equal(payload.truncation, false);
  assert.ok(Array.isArray(payload.result?.data));
  assert.equal((payload.result.data[0]?.embedding as unknown[]).length, 512);
});

test("handler: /uos/embeddings reaches authentication instead of the 404 guard", async () => {
  const { default: handler } = await import("../src/handler/index.ts");
  const response = await handler(
    new Request("https://ai.ubq.fi/uos/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "voyage-4-large",
        input: "route-reachability",
        input_type: "document",
      }),
    })
  );

  assert.equal(response.status, 401);
  assert.notEqual(response.status, 404);
});

test("handler: embeddings preflight permits browser idempotency keys", async () => {
  const { default: handler } = await import("../src/handler/index.ts");
  const response = await handler(
    new Request("https://ai.ubq.fi/uos/embeddings", {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key",
      },
    })
  );

  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /HEAD/);
  const allowedHeaders = (response.headers.get("access-control-allow-headers") ?? "").split(",").map((header) => header.trim().toLowerCase());
  assert.ok(allowedHeaders.includes("idempotency-key"));
});

test("handler: an exhausted key still serves local embeddings paths but blocks a dispatch", async () => {
  const { handleAdminApiKeysCreate } = await import("../src/admin/index.ts");
  const { default: handler } = await import("../src/handler/index.ts");
  const token = `u_${crypto.randomUUID().replace(/-/g, "").padEnd(64, "a")}`;
  const created = await handleAdminApiKeysCreate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "exhausted embeddings local paths",
        token,
        usage_limit_requests: 1,
        paid_fallback_enabled: false,
      }),
    })
  );
  assert.equal(created.status, 200);
  const createdPayload = (await created.json()) as { id?: unknown };
  assert.equal(typeof createdPayload.id, "string");
  const keyId = createdPayload.id as string;
  const idempotencyKey = `exhausted-replay-${crypto.randomUUID()}`;
  const idempotencyInput = `exhausted-idempotency-${crypto.randomUUID()}`;
  const jobInput = `exhausted-job-${crypto.randomUUID()}`;
  let jobId = "";

  resetVoyageRateLimit();
  await withFetchMock(
    () => voyageOkResponse(1),
    async () => {
      const seededReplay = await handleUosEmbeddings(uosIdempotentRequest(idempotencyKey, idempotencyInput), uosIdempotencyUsageContext(`api-key:${keyId}`));
      assert.equal(seededReplay.status, 200);
      const seededJob = await handleEmbeddingsJobCreate(
        new Request("https://ai.ubq.fi/uos/embedding-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: jobInput, input_type: "document" }),
        }),
        token,
        { keyId, kernelRepo: null, kernelOrg: null }
      );
      assert.equal(seededJob.status, 200);
      const seededJobPayload = (await seededJob.json()) as { id?: unknown; status?: unknown };
      assert.equal(seededJobPayload.status, "succeeded");
      assert.equal(typeof seededJobPayload.id, "string");
      jobId = seededJobPayload.id as string;
    }
  );

  const cacheInput = `exhausted-cache-${crypto.randomUUID()}`;
  const cacheHash = await sha256Hex(cacheInput);
  kvStore.set(keyToString(embeddingsCacheKey(cacheHash)), { embedding: testVector(1024, 7.7), created_at: new Date().toISOString() });
  const quotaWindowPrefix: KvKey = ["uos_ai", "api_key_usage", "v3", "window", keyId];
  const quotaEntry = [...kvStore.entries()].find(([rawKey]) => keyHasPrefix(JSON.parse(rawKey) as KvKey, quotaWindowPrefix));
  assert.ok(quotaEntry);
  const [rawQuotaKey, rawQuotaWindow] = quotaEntry;
  const quotaKv = await getKv();
  assert.ok(quotaKv);
  await quotaKv.set(JSON.parse(rawQuotaKey) as KvKey, {
    ...(rawQuotaWindow as Record<string, unknown>),
    committed_requests: 1,
    reserved_requests: 0,
    updated_at_ms: Date.now(),
  });

  const embeddingsRequest = (input: string, replayKey?: string): Request =>
    new Request("https://ai.ubq.fi/uos/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(replayKey ? { "Idempotency-Key": replayKey } : {}),
      },
      body: JSON.stringify({ model: "voyage-4-large", input, truncation: !replayKey }),
    });

  let voyageCalls = 0;
  resetVoyageRateLimit();
  try {
    await withFetchMock(
      () => {
        voyageCalls += 1;
        return voyageOkResponse(1);
      },
      async () => {
        const replay = await handler(embeddingsRequest(idempotencyInput, idempotencyKey));
        assert.equal(replay.status, 200);
        assert.equal(replay.headers.get("x-uos-idempotency-replayed"), "true");

        const cached = await handler(embeddingsRequest(cacheInput));
        assert.equal(cached.status, 200);

        const terminalJob = await handler(
          new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        );
        assert.equal(terminalJob.status, 200);
        assert.equal(((await terminalJob.json()) as { status?: unknown }).status, "succeeded");

        const blocked = await handler(embeddingsRequest(`exhausted-miss-${crypto.randomUUID()}`));
        assert.equal(blocked.status, 429);
        assert.ok(blocked.headers.get("Retry-After"));
        assert.equal(blocked.headers.get("RateLimit-Limit"), "1");
        assert.equal(blocked.headers.get("RateLimit-Remaining"), "0");
        assert.match(blocked.headers.get("RateLimit-Policy") ?? "", /^"api-key";q=1;w=\d+$/);
        assert.match(blocked.headers.get("RateLimit") ?? "", /^"api-key";r=0;t=\d+$/);
        assert.equal(((await blocked.json()) as { error?: { type?: unknown } }).error?.type, "rate_limit_error");
      }
    );
    assert.equal(voyageCalls, 0);
  } finally {
    resetVoyageRateLimit();
  }
});

test("handler: authenticated legacy v1 embeddings is a generic 404 without Voyage dispatch", async () => {
  const { handleAdminApiKeysCreate } = await import("../src/admin/index.ts");
  const token = `u_${crypto.randomUUID().replace(/-/g, "").padEnd(64, "a")}`;
  const created = await handleAdminApiKeysCreate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "legacy embeddings route check",
        token,
        usage_limit_requests: 1,
        paid_fallback_enabled: false,
      }),
    })
  );
  assert.equal(created.status, 200);
  const createdPayload = (await created.json()) as { id?: unknown };
  assert.equal(typeof createdPayload.id, "string");
  const keyId = createdPayload.id as string;
  const quotaWindowPrefix: KvKey = ["uos_ai", "api_key_usage", "v3", "window", keyId];
  const quotaWindow = (): { committed_requests?: unknown; reserved_requests?: unknown } | null => {
    for (const [rawKey, value] of kvStore.entries()) {
      const key = JSON.parse(rawKey) as KvKey;
      if (keyHasPrefix(key, quotaWindowPrefix)) {
        return value as { committed_requests?: unknown; reserved_requests?: unknown };
      }
    }
    return null;
  };
  const quotaBefore = quotaWindow();
  assert.ok(quotaBefore);
  assert.equal(quotaBefore.committed_requests, 0);
  assert.equal(quotaBefore.reserved_requests, 0);

  const { default: handler } = await import("../src/handler/index.ts");
  let voyageCalls = 0;
  const response = await withFetchMock(
    () => {
      voyageCalls += 1;
      return voyageOkResponse(1);
    },
    () =>
      handler(
        new Request("https://ai.ubq.fi/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "voyage-4-large", input: "must-not-dispatch" }),
        })
      )
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-uos-upstream"), null);
  assert.equal(await responseErrorCode(response), "not_found");
  assert.equal(voyageCalls, 0);
  const quotaAfter = quotaWindow();
  assert.ok(quotaAfter);
  assert.equal(quotaAfter.committed_requests, 0);
  assert.equal(quotaAfter.reserved_requests, 0);
});

test("handler: idempotency preserves account scopes", async () => {
  const { resolveIdempotencyPrincipal } = await import("../src/handler/http.ts");

  for (const kind of ["auth_tokens_allowlist", "admin_allowlist", "deno_deploy_token"] as const) {
    const first = await resolveIdempotencyPrincipal({
      token: "first-rotating-secret",
      method: { kind },
    });
    const rotated = await resolveIdempotencyPrincipal({
      token: "second-rotating-secret",
      method: { kind },
    });
    assert.equal(first, `auth-method:${kind}`);
    assert.equal(rotated, first);
    assert.equal(first.includes("rotating-secret"), false);
  }

  assert.equal(
    await resolveIdempotencyPrincipal({
      token: "kv-secret-one",
      method: { kind: "kv_api_key", key_id: "stable-key-id" },
    }),
    await resolveIdempotencyPrincipal({
      token: "kv-secret-two",
      method: { kind: "kv_api_key", key_id: "stable-key-id" },
    })
  );
  assert.equal(
    await resolveIdempotencyPrincipal({
      token: "github-secret-one",
      method: {
        kind: "github_token",
        owner: "Ubiquity",
        repo: "AI.UBQ.FI",
        state_id: "state-one",
        limit_scope: "repo",
      },
    }),
    "github-repo:ubiquity/ai.ubq.fi"
  );
  assert.equal(
    await resolveIdempotencyPrincipal({
      token: "passkey-session-one",
      method: {
        kind: "passkey_session",
        user_id: "user-47",
        handle: "user",
        is_admin: false,
        credential_count: 1,
      },
    }),
    "passkey-user:user-47"
  );
});

/** Bounded wait for the admission guard's asynchronous bookkeeping. */

test("handler: saturated admission refuses a queued embedding-job poll before Voyage", async () => {
  const { handleAdminApiKeysCreate } = await import("../src/admin/index.ts");
  const { default: handler } = await import("../src/handler/index.ts");
  const { setInferenceAdmissionControllerForTest } = await import("../src/handler/admission.ts");
  const { createInferenceAdmissionController } = await import("../src/inference-admission.ts");
  const token = `u_${crypto.randomUUID().replace(/-/g, "").padEnd(64, "c")}`;
  const created = await handleAdminApiKeysCreate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "admitted embedding-job polls",
        token,
        usage_limit_requests: 5,
        paid_fallback_enabled: false,
      }),
    })
  );
  assert.equal(created.status, 200);
  const createdPayload = (await created.json()) as { id?: unknown };
  assert.equal(typeof createdPayload.id, "string");
  const keyId = createdPayload.id as string;

  // A queued job keeps its encrypted inputs: polling it is the work-producing
  // read the review found outside the process bound, because the poll calls
  // runEmbeddingsJobAttempt and can dispatch Voyage for the queued job.
  resetVoyageRateLimit();
  kvStore.set(keyToString(VOYAGE_RATE_LIMIT_KEY), { window_start_ms: Date.now(), requests: 3, tokens: 0 });
  const jobInput = `admitted-job-poll-${crypto.randomUUID()}`;
  const queuedJob = await withFetchMock(
    () => {
      throw new Error("a saturated Voyage budget must queue the job before any upstream call");
    },
    () =>
      handleEmbeddingsJobCreate(
        new Request("https://ai.ubq.fi/uos/embedding-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voyage-4-large", input: jobInput, input_type: "document" }),
        }),
        token,
        { keyId, kernelRepo: null, kernelOrg: null }
      )
  );
  assert.equal(queuedJob.status, 202);
  const queuedPayload = (await queuedJob.json()) as { id?: unknown; status?: unknown };
  assert.equal(queuedPayload.status, "queued");
  assert.equal(typeof queuedPayload.id, "string");
  const jobId = queuedPayload.id as string;
  kvStore.delete(keyToString(VOYAGE_RATE_LIMIT_KEY));

  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 1, maxQueueWaitMs: 5_000 });
  setInferenceAdmissionControllerForTest(controller);
  const held = await controller.acquire();
  if (!held.ok) throw new Error("the fixture must hold the only admission permit");
  let voyageCalls = 0;
  try {
    await withFetchMock(
      () => {
        voyageCalls += 1;
        return voyageOkResponse(1);
      },
      async () => {
        const jobPoll = (signal?: AbortSignal): Promise<Response> =>
          handler(
            new Request(`https://ai.ubq.fi/uos/embedding-jobs/${jobId}`, {
              headers: { Authorization: `Bearer ${token}` },
              ...(signal ? { signal } : {}),
            })
          );

        // A queued poll whose caller leaves while it waits for a permit never
        // claims the job and never reaches the provider.
        const queuedAbort = new AbortController();
        const waitingPoll = jobPoll(queuedAbort.signal);
        await waitForAdmission(() => controller.snapshot().waiting === 1, "the queued job poll to wait for a permit");
        assert.equal(voyageCalls, 0, "a job poll waiting for a permit must not dispatch Voyage");
        queuedAbort.abort(new DOMException("client disconnected while the job poll waited", "AbortError"));
        const cancelled = await waitingPoll;
        assert.equal(cancelled.status, 499, "an aborted queued job poll is a cancellation, not work");
        await cancelled.body?.cancel().catch(() => {});
        assert.equal(voyageCalls, 0, "an aborted queued job poll must never reach Voyage");

        // The replacement fills the one waiting slot, so the next poll is
        // refused locally even though it would have dispatched the queued job.
        const queuedPoll = jobPoll();
        await waitForAdmission(() => controller.snapshot().waiting === 1, "the replacement job poll to wait for a permit");
        const overloaded = await jobPoll();
        assert.equal(overloaded.status, 503, "a saturated job poll must be refused locally");
        const overloadPayload = (await overloaded.json()) as { error?: { code?: string } };
        assert.equal(overloadPayload.error?.code, "local_inference_overload");
        assert.ok(overloaded.headers.get("retry-after"), "a local overload carries Retry-After");
        assert.equal(voyageCalls, 0, "a refused job poll must not reach Voyage");

        // Neither refused poll claimed the job: it is still exactly as queued.
        const jobTokenHash = await sha256Hex(`uos_api_key_id:${keyId}`);
        const jobLookup = kvStore.get(keyToString(embeddingsJobLookupKey(jobTokenHash, jobId))) as { cache_profile_key?: unknown } | undefined;
        const cacheProfileKey = jobLookup?.cache_profile_key;
        assert.equal(typeof cacheProfileKey, "string");
        const queuedRecord = kvStore.get(keyToString(embeddingsJobKey(jobTokenHash, cacheProfileKey as string, jobId))) as { status?: unknown };
        assert.equal(queuedRecord.status, "queued", "a refused job poll must leave the queued job unclaimed");

        // Releasing the permit admits the queued poll, which performs the job's
        // single provider dispatch and completes it for later reads.
        held.release();
        const admitted = await queuedPoll;
        assert.equal(admitted.status, 200);
        const admittedPayload = (await admitted.json()) as { status?: unknown };
        assert.equal(admittedPayload.status, "succeeded");
        assert.equal(voyageCalls, 1, "the admitted job poll dispatches Voyage exactly once");
        await waitForAdmission(() => controller.snapshot().active === 0, "the admitted job poll to release its permit");

        // A completed-job read is still served without another provider call.
        const completed = await jobPoll();
        assert.equal(completed.status, 200);
        assert.equal(((await completed.json()) as { status?: unknown }).status, "succeeded");
        assert.equal(voyageCalls, 1, "a completed-job read must not dispatch Voyage");
      }
    );
  } finally {
    held.release();
    setInferenceAdmissionControllerForTest(null);
    resetVoyageRateLimit();
  }
});
