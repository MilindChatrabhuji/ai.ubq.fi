import type { Kv, KvCommitResult, KvKey, KvListOptions, KvListSelector } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { ADMIN_ERROR_BUCKET_MS, ADMIN_ERROR_LOG_PREFIX, listAdminErrorHistory, recordAdminError } from "../src/admin/error-log.ts";

class SetOnlyKv {
  readonly writes: { key: KvKey; value: unknown; options?: { expireIn?: number } }[] = [];

  set(key: KvKey, value: unknown, options?: { expireIn?: number }): Promise<KvCommitResult> {
    this.writes.push({ key, value, options });
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" });
  }
}

const terminal = (overrides: Partial<Parameters<typeof recordAdminError>[0]> = {}) => ({
  request_id: "request-1",
  route: "responses",
  status: 503,
  provider: "chatgpt_codex",
  model: "gpt-5.6-terra",
  reasoning: "max",
  stream: true,
  terminal_type: "http.error",
  failure_kind: "codex_admission_busy",
  delivery_outcome: "delivered" as const,
  created_at_ms: 1_777_000_000_000,
  latency_ms: 1_692,
  git_sha: "fixture-sha",
  deno_revision: "fixture-revision",
  ...overrides,
});

test("admin error ledger stores every HTTP failure with bounded diagnostics", async () => {
  const kv = new SetOnlyKv();
  await recordAdminError(terminal(), kv as unknown as Kv);

  assert.equal(kv.writes.length, 1);
  assert.deepEqual(kv.writes[0].key, [...ADMIN_ERROR_LOG_PREFIX, 1_777_000_000_000, "request-1"]);
  assert.deepEqual(kv.writes[0].value, { ...terminal(), version: 1 });
  assert.ok((kv.writes[0].options?.expireIn ?? 0) > 0);
});

test("admin error ledger excludes successful completed requests", async () => {
  const kv = new SetOnlyKv();
  await recordAdminError(terminal({ status: 200, terminal_type: "response.completed", failure_kind: null }), kv as unknown as Kv);
  assert.equal(kv.writes.length, 0);
});

test("admin error history hides only affected cancellations and collects analytics in one scan", async () => {
  const records = [
    terminal({
      request_id: "legacy-cancellation",
      status: 200,
      terminal_type: "error",
      failure_kind: "missing_sse_terminal",
      delivery_outcome: "interrupted",
      git_sha: "ce37210d58746a2ed3aec34c38b370f7060639e1",
    }),
    terminal({
      request_id: "post-fix-premature-eof",
      status: 200,
      terminal_type: "error",
      failure_kind: "missing_sse_terminal",
      delivery_outcome: "interrupted",
      git_sha: "post-fix-sha",
    }),
    terminal({
      request_id: "stream-read-error",
      status: 200,
      terminal_type: "error",
      failure_kind: "stream_read_error",
      delivery_outcome: "delivered",
    }),
    terminal({ request_id: "http-error", status: 503, created_at_ms: ADMIN_ERROR_BUCKET_MS + 1 }),
    terminal({ request_id: "older-http-error", status: 500, created_at_ms: ADMIN_ERROR_BUCKET_MS * 2 + 1 }),
  ].map((value) => ({ value: { ...value, version: 1 } }));
  let listCalls = 0;
  let listOptions: KvListOptions | undefined;
  const kv = {
    list: (_selector: KvListSelector, options?: KvListOptions) => ({
      *[Symbol.asyncIterator]() {
        listCalls += 1;
        listOptions = options;
        yield* records;
      },
    }),
  };

  const history = await listAdminErrorHistory(3, kv as unknown as Kv);
  assert.deepEqual(
    history.data.map((record) => record.request_id),
    ["post-fix-premature-eof", "stream-read-error", "http-error"]
  );
  assert.deepEqual(history.five_xx_buckets, [
    { bucket_start_at_ms: ADMIN_ERROR_BUCKET_MS, count: 1 },
    { bucket_start_at_ms: ADMIN_ERROR_BUCKET_MS * 2, count: 1 },
  ]);
  assert.equal(listCalls, 1);
  assert.deepEqual(listOptions, { reverse: true, batchSize: 500 });
});

test("admin error history preserves records outside the exact legacy cancellation signature", async () => {
  const records = [
    terminal({
      request_id: "server-missing-terminal",
      status: 500,
      terminal_type: "error",
      failure_kind: "missing_sse_terminal",
      delivery_outcome: "interrupted",
    }),
    terminal({
      request_id: "delivered-missing-terminal",
      status: 200,
      terminal_type: "error",
      failure_kind: "missing_sse_terminal",
      delivery_outcome: "delivered",
    }),
  ].map((value) => ({ value: { ...value, version: 1 } }));
  const kv = {
    list: () => ({
      *[Symbol.asyncIterator]() {
        yield* records;
      },
    }),
  };

  assert.deepEqual(
    (await listAdminErrorHistory(2, kv as unknown as Kv)).data.map((record) => record.request_id),
    ["server-missing-terminal", "delivered-missing-terminal"]
  );
});

test("admin error analytics counts every inference 5xx in fifteen-minute buckets", async () => {
  const records = [
    terminal({ request_id: "one", status: 500, created_at_ms: ADMIN_ERROR_BUCKET_MS + 1 }),
    terminal({ request_id: "two", status: 503, created_at_ms: ADMIN_ERROR_BUCKET_MS + 2 }),
    terminal({ request_id: "three", status: 429, created_at_ms: ADMIN_ERROR_BUCKET_MS + 3 }),
    terminal({ request_id: "four", status: 599, created_at_ms: ADMIN_ERROR_BUCKET_MS * 2 + 1 }),
  ].map((value) => ({ value: { ...value, version: 1 } }));
  const kv = {
    list: () => ({
      *[Symbol.asyncIterator]() {
        yield* records;
      },
    }),
  };

  assert.deepEqual((await listAdminErrorHistory(1, kv as unknown as Kv)).five_xx_buckets, [
    { bucket_start_at_ms: ADMIN_ERROR_BUCKET_MS, count: 2 },
    { bucket_start_at_ms: ADMIN_ERROR_BUCKET_MS * 2, count: 1 },
  ]);
});
