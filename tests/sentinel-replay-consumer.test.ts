import { test, afterAll } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { buildPermissionsNative } from "../scripts/build-permissions.ts";
/**
 * Acceptance tests for the fixed local Sentinel replay consumer.
 *
 * Every case invokes the real fixed command as a child process inside a
 * disposable snapshot: the source tree is copied into a temporary directory
 * under the checkout, the fixtures and trusted dispatch metadata are written
 * there, and the child runs with a locked local dependencies, disabled dotenv discovery,
 * read-only child confinement, and no application environment. The shared checkout source is
 * never mutated and no network or live API is contacted.
 */

import assert from "node:assert/strict";
import {
  SENTINEL_REPLAY_MAX_UPSTREAM_ATTEMPTS,
  SENTINEL_REPLAY_MAX_UPSTREAM_BYTES,
  SENTINEL_REPLAY_MAX_UPSTREAM_CHUNKS,
  SENTINEL_REPLAY_UPSTREAM_FILE_MAX_BYTES,
} from "../src/sentinel/replay-limits.ts";
import {
  SENTINEL_UPSTREAM_MAX_HEADER_VALUE_CHARS,
  SENTINEL_UPSTREAM_MAX_TIMING_MS,
  SENTINEL_UPSTREAM_SAFE_RESPONSE_HEADER_NAMES,
} from "../src/sentinel/upstream-capture.ts";

const REPO_ROOT = process.cwd();
// Scratch lives under .data/, which git, Prettier and ESLint already ignore. A
// snapshot abandoned by an interrupted run therefore can never be mistaken for
// source by a repo-wide format, lint or dead-code gate.
const SCRATCH_PARENT = `${REPO_ROOT}/.data`;
await mkdir(SCRATCH_PARENT, { recursive: true });
const SCRATCH_ROOT = await mkdtemp(join(SCRATCH_PARENT, "m06-sentinel-replay-consumer-"));
const permissionsArtifact = await buildPermissionsNative(join(SCRATCH_ROOT, "permissions"));
const DEPENDENCIES_ROOT = realpathSync(join(REPO_ROOT, "node_modules"));
const SOURCE_ROOT = `${SCRATCH_ROOT}/source`;

afterAll(async () => {
  await rm(SCRATCH_ROOT, { recursive: true, force: true });
});

const copyTree = async (source: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = `${source}/${entry.name}`;
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
};

await copyTree(`${REPO_ROOT}/src`, `${SOURCE_ROOT}/src`);
await mkdir(`${SOURCE_ROOT}/scripts`, { recursive: true });
await copyFile(`${REPO_ROOT}/scripts/replay.ts`, `${SOURCE_ROOT}/scripts/replay.ts`);
await copyFile(`${REPO_ROOT}/scripts/replay-chat-stream.ts`, `${SOURCE_ROOT}/scripts/replay-chat-stream.ts`);
await copyTree(`${REPO_ROOT}/tests/helpers`, `${SOURCE_ROOT}/tests/helpers`);

await copyFile(join(REPO_ROOT, "package.json"), join(SOURCE_ROOT, "package.json"));
await copyFile(join(REPO_ROOT, "bun.lock"), join(SOURCE_ROOT, "bun.lock"));
const FIXED_ARGS = ["--no-env-file", "--no-install", "run", "replay-child.ts"];

type CaseFile = Readonly<{ path: string; content: string | Uint8Array }>;
type ChildResult = Readonly<{ code: number; stdout: string; stderr: string }>;

const materializeCase = async (files: readonly CaseFile[]): Promise<string> => {
  const dir = await mkdtemp(join(SCRATCH_ROOT, "case-"));
  await copyTree(SOURCE_ROOT, dir);
  for (const file of files) {
    const target = `${dir}/${file.path}`;
    await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await writeFile(target, file.content);
  }
  const launcher = [
    'import { applyLinuxPermissions } from "./src/runtime/permissions-linux.ts";',
    "applyLinuxPermissions(" + JSON.stringify({ read: [dir, DEPENDENCIES_ROOT], write: [] }) + ", " + JSON.stringify(permissionsArtifact) + ");",
    'await import("./scripts/replay.ts");',
  ].join("\n");
  await writeFile(join(dir, "replay-child.ts"), launcher);
  return dir;
};

const withCase = async <T>(files: readonly CaseFile[], fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await materializeCase(files);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true }).catch(() => {});
  }
};

/** Invoke the real Bun consumer with no application environment or writable child paths. */
const runFixedConsumer = async (dir: string): Promise<ChildResult> => {
  const child = Bun.spawn([process.execPath, ...FIXED_ARGS], {
    cwd: dir,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
};

const TEST_MARKER_PREFIX = "sentinel-replay-test:";
const CAUSAL_FAILURE_LINE = "sentinel-causal-failure:stream terminated unexpectedly\n";
const UNAVAILABLE_LINE = "sentinel-replay-unavailable: replay input is unavailable\n";
const CANARY = "sk-canary-do-not-log-0123456789abcdef";
const DEFAULT_IDS = ["alpha", "beta", "gamma"] as const;

const markers = (ids: readonly string[]): string => ids.map((id) => `${TEST_MARKER_PREFIX}${id}\n`).join("");

type FixtureProvider = "chatgpt_codex" | "surplus" | "metered" | "cerebras" | "deepseek";
type FixtureTerminal = "pending" | "fetch_error" | "eof" | "read_error" | "cancelled";
type FixtureAttempt = Readonly<{
  provider: FixtureProvider;
  status: number | null;
  content_type: string | null;
  chunks_base64: readonly string[];
  terminal: FixtureTerminal;
}>;
type FixtureTrace = Readonly<{
  version: 1 | 2;
  attempts: readonly FixtureAttempt[];
  attempts_truncated: boolean;
  bytes_truncated: boolean;
  chunks_truncated: boolean;
}>;

const attempt = (
  provider: FixtureProvider,
  chunks: readonly string[],
  terminal: FixtureTerminal,
  overrides: Readonly<{ status?: number | null; content_type?: string | null }> = {}
): FixtureAttempt => ({
  provider,
  // An explicitly absent override falls back to the default; an explicit null
  // is a meaningful fixture value and is preserved.
  status: overrides.status === undefined ? 200 : overrides.status,
  content_type: overrides.content_type === undefined ? "text/event-stream" : overrides.content_type,
  chunks_base64: chunks.map((chunk) => btoa(chunk)),
  terminal,
});

const trace = (
  attempts: readonly FixtureAttempt[],
  flags: Partial<Pick<FixtureTrace, "attempts_truncated" | "bytes_truncated" | "chunks_truncated">> = {}
): FixtureTrace => ({
  version: 1,
  attempts,
  attempts_truncated: false,
  bytes_truncated: false,
  chunks_truncated: false,
  ...flags,
});

const sse = (value: Record<string, unknown>): string => `data: ${JSON.stringify(value)}\n\n`;
const created = (id: string): string => sse({ type: "response.created", response: { id, object: "response", status: "in_progress" } });
const inProgress = (id: string): string => sse({ type: "response.in_progress", response: { id, object: "response", status: "in_progress" } });
const delta = (id: string, text: string): string =>
  sse({
    type: "response.output_text.delta",
    response_id: id,
    item_id: "msg_fixture",
    output_index: 0,
    content_index: 0,
    delta: text,
  });
const itemDone = (id: string, text: string): string =>
  sse({
    type: "response.output_item.done",
    response_id: id,
    output_index: 0,
    item: {
      id: "msg_fixture",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  });
const completed = (id: string, text: string, output: readonly Record<string, unknown>[] | null = null): string =>
  sse({
    type: "response.completed",
    response: {
      id,
      object: "response",
      status: "completed",
      output: output ?? [
        {
          id: "msg_fixture",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    },
  });

const responsesBody = (stream: boolean, text = "hello"): Record<string, unknown> => ({
  model: "gpt-5.6-codex",
  stream,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
});

const requestEnvelope = (body: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    endpoint: "/v1/responses",
    method: "POST",
    request_id: "fixture-request",
    ...extra,
    body: JSON.stringify(body),
  });

const metadata = (requestPath: string, upstreamPath: string, testIds: readonly string[]): string =>
  JSON.stringify({ version: "v1", requestPath, upstreamPath, testIds });

const replayCase = (options: {
  trace: FixtureTrace;
  stream: boolean;
  testIds?: readonly string[];
  requestBody?: Record<string, unknown>;
  extraEnvelope?: Record<string, unknown>;
  report?: boolean;
}): readonly CaseFile[] => [
  {
    path: ".sentinel-replay-input.json",
    content: JSON.stringify({
      version: "v1",
      requestPath: "fixtures/request.json",
      upstreamPath: "fixtures/upstream.json",
      testIds: options.testIds ?? DEFAULT_IDS,
      ...(options.report ? { report: "structured-v1" } : {}),
    }),
  },
  {
    path: "fixtures/request.json",
    content: requestEnvelope(options.requestBody ?? responsesBody(options.stream), options.extraEnvelope),
  },
  { path: "fixtures/upstream.json", content: JSON.stringify(options.trace) },
];

const assertUnavailable = (result: ChildResult, label: string): void => {
  assert.equal(result.code, 2, `${label}: expected the static unavailable exit`);
  assert.equal(result.stdout, UNAVAILABLE_LINE, `${label}: exactly one fixed static unavailable line`);
  assert.equal(result.stderr, "", `${label}: stderr must stay empty`);
};

/** The same frozen verdict, with the additive opt-in report line before it. */
const assertUnavailableWithReport = (result: ChildResult, label: string): void => {
  assert.equal(result.code, 2, `${label}: expected the static unavailable exit`);
  const lines = result.stdout.split("\n");
  const reportIndex = lines.findIndex((line) => line.startsWith(REPORT_PREFIX));
  assert.ok(reportIndex >= 0, `${label}: the opt-in report line must be present`);
  assert.equal(lines.slice(reportIndex + 1).join("\n"), UNAVAILABLE_LINE, `${label}: exactly one fixed static unavailable line after the report`);
  assert.equal(result.stderr, "", `${label}: stderr must stay empty`);
};

const REPORT_PREFIX = "sentinel-replay-report:";

/** Parse the additive structured report line; absent unless the metadata opts in. */
const replayReport = (result: ChildResult): Record<string, unknown> => {
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith(REPORT_PREFIX));
  assert.ok(line, "the structured report line must be present when requested");
  const parsed: unknown = JSON.parse(line.slice(REPORT_PREFIX.length));
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
};

const chatBody = (stream: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: "deepseek-flash",
  stream,
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

const chatChunk = (deltaValue: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "deepseek-flash",
    choices: [{ index: 0, delta: deltaValue, finish_reason: finishReason }],
  })}\n\n`;

const chatCompletion = (message: Record<string, unknown>, finishReason: string): string =>
  JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "deepseek-flash",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });

/** A DeepSeek replay case: chat-completions request body plus a recorded chain. */
const chatReplayCase = (options: { trace: FixtureTrace; stream: boolean; requestBody?: Record<string, unknown>; report?: boolean }): readonly CaseFile[] =>
  replayCase({
    trace: options.trace,
    stream: options.stream,
    requestBody: options.requestBody ?? chatBody(options.stream),
    report: options.report,
  });

test("a recorded DeepSeek chat stream is replayed through the real DeepSeek parser and validity rule", async () => {
  const chunks = [chatChunk({ role: "assistant", content: "" }), chatChunk({ content: "hello" }), chatChunk({}, "stop"), "data: [DONE]\n\n"];
  await withCase(chatReplayCase({ trace: trace([attempt("deepseek", chunks, "eof")]), stream: true, report: true }), async (dir) => {
    const result = await runFixedConsumer(dir);
    assert.equal(result.code, 0, "a complete recorded DeepSeek stream must replay");
    assert.equal(result.stdout.endsWith(markers(DEFAULT_IDS)), true, "the trusted markers close the output after any report line");
    const report = replayReport(result);
    assert.equal(report.provider, "deepseek");
    assert.equal(report.request_wire, "chat.completions");
    assert.equal(report.classification, "converted_completed");
    assert.equal(report.outcome, "completed");
    assert.equal(report.provider_error_mapping, "not_applicable");
  });
});

test("a recorded DeepSeek empty completion is not replayed as a success", async () => {
  // A tool-call-free, refusal-free, reasoning-only stop is exactly the
  // degenerate completion the gateway's own validity rule refuses.
  const chunks = [chatChunk({ role: "assistant", reasoning_content: "thinking only" }), chatChunk({}, "stop"), "data: [DONE]\n\n"];
  await withCase(chatReplayCase({ trace: trace([attempt("deepseek", chunks, "eof")]), stream: true, report: true }), async (dir) => {
    const result = await runFixedConsumer(dir);
    assertUnavailableWithReport(result, "reasoning-only DeepSeek stop");
    const report = replayReport(result);
    assert.equal(report.classification, "empty_completion");
    assert.equal(report.outcome, "unavailable");
    assert.equal(report.unavailable_reason, "gateway_empty_completion_rule_not_exported");
  });
});

test("an interrupted DeepSeek stream replays the real parser's premature EOF as the causal failure", async () => {
  const chunks = [chatChunk({ role: "assistant" }), chatChunk({ content: "partial" })];
  await withCase(chatReplayCase({ trace: trace([attempt("deepseek", chunks, "eof")]), stream: true, report: true }), async (dir) => {
    const result = await runFixedConsumer(dir);
    assert.equal(result.code, 1, "an unterminated recorded stream is the causal failure");
    assert.equal(result.stdout.endsWith(`${markers(DEFAULT_IDS)}${CAUSAL_FAILURE_LINE}`), true);
    const report = replayReport(result);
    assert.equal(report.classification, "recorded_premature_eof");
    assert.equal(report.outcome, "causal");
  });
});

test("a recorded DeepSeek HTTP error is replayed through the real transport and its mapping is not claimed", async () => {
  const body = JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error", code: "rate_limit_exceeded" } });
  await withCase(
    chatReplayCase({
      trace: trace([attempt("deepseek", [body], "eof", { status: 429, content_type: "application/json" })]),
      stream: false,
      report: true,
    }),
    async (dir) => {
      const result = await runFixedConsumer(dir);
      assertUnavailableWithReport(result, "DeepSeek HTTP error");
      const report = replayReport(result);
      assert.equal(report.classification, "provider_http_error_replayed");
      assert.deepEqual(report.attempt_statuses, [429]);
      assert.equal(report.provider_error_mapping, "not_exercised");
      assert.equal(report.unavailable_reason, "gateway_error_mapping_not_exported");
    }
  );
});

test("a buffered DeepSeek completion is normalized and validated by the real gateway functions", async () => {
  await withCase(
    chatReplayCase({
      trace: trace([attempt("deepseek", [chatCompletion({ role: "assistant", content: "hello" }, "stop")], "eof", { content_type: "application/json" })]),
      stream: false,
    }),
    async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.equal(result.code, 0, "a valid buffered completion must replay");
      assert.equal(result.stdout, markers(DEFAULT_IDS));
    }
  );
  // An upstream that contradicts the requested model is rejected by the real
  // normalizer rather than accepted as a completion.
  const mismatched = JSON.parse(chatCompletion({ role: "assistant", content: "hello" }, "stop")) as Record<string, unknown>;
  mismatched.model = "some-other-model";
  await withCase(
    chatReplayCase({
      trace: trace([attempt("deepseek", [JSON.stringify(mismatched)], "eof", { content_type: "application/json" })]),
      stream: false,
      report: true,
    }),
    async (dir) => {
      const result = await runFixedConsumer(dir);
      assertUnavailableWithReport(result, "mismatched buffered model");
      assert.equal(replayReport(result).classification, "invalid_completion");
    }
  );
});

test("a multi-attempt recorded chain is replayed in order through the real transports", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "hello"), itemDone("resp_fixture", "hello"), completed("resp_fixture", "hello")];
  await withCase(
    replayCase({
      trace: trace([
        attempt("chatgpt_codex", ['{"error":{"code":"upstream_http_5xx"}}'], "eof", { status: 500, content_type: "application/json" }),
        attempt("chatgpt_codex", chunks, "eof"),
      ]),
      stream: true,
      report: true,
    }),
    async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.equal(result.code, 0, "the retried chain's final attempt must replay");
      const report = replayReport(result);
      assert.equal(report.attempts, 2);
      assert.deepEqual(report.attempt_statuses, [500, 200]);
      assert.deepEqual(report.attempt_terminals, ["eof", "eof"]);
      assert.equal(report.replay_coverage, "partial", "a multi-attempt chain is never full single-attempt coverage");
      assert.equal(report.retry_policy, "not_replayed");
    }
  );
});

test("a recorded read failure is the causal failure only when the real parser observed it", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "partial")];
  await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "read_error")]), stream: true }), async (dir) => {
    const result = await runFixedConsumer(dir);
    assert.equal(result.code, 1, "a recorded upstream read failure is the causal failure");
    assert.equal(result.stdout, `${markers(DEFAULT_IDS)}${CAUSAL_FAILURE_LINE}`);
  });
});

test("the structured report line is additive and never appears without the opt-in", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "hello"), itemDone("resp_fixture", "hello"), completed("resp_fixture", "hello")];
  await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "cancelled")]), stream: true }), async (dir) => {
    const result = await runFixedConsumer(dir);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.includes(REPORT_PREFIX), false, "the frozen output shape must stay unchanged without the opt-in");
    assert.equal(result.stdout, markers(DEFAULT_IDS));
  });
  // An unknown report value is a malformed metadata document, not a new feature.
  await withCase(
    [
      {
        path: ".sentinel-replay-input.json",
        content: JSON.stringify({
          version: "v1",
          requestPath: "fixtures/request.json",
          upstreamPath: "fixtures/upstream.json",
          testIds: DEFAULT_IDS,
          report: "yaml",
        }),
      },
      { path: "fixtures/request.json", content: requestEnvelope(responsesBody(true)) },
      { path: "fixtures/upstream.json", content: JSON.stringify(trace([])) },
    ],
    async (dir) => {
      assertUnavailable(await runFixedConsumer(dir), "unknown report mode");
    }
  );
});

test("fixed consumer replays a complete recorded codex stream through the owned response stream", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "hello"), itemDone("resp_fixture", "hello"), completed("resp_fixture", "hello")];
  await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "cancelled")]), stream: true }), async (dir) => {
    const result = await runFixedConsumer(dir);
    assert.equal(result.code, 0, "a complete streamed replay must succeed");
    assert.equal(result.stdout, markers(DEFAULT_IDS), "markers only, in trusted order");
    assert.equal(result.stderr, "");
  });
});

test("fixed consumer replays a complete recorded codex stream through the buffered converter", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "hello"), itemDone("resp_fixture", "hello"), completed("resp_fixture", "hello")];
  await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "cancelled")]), stream: false }), async (dir) => {
    const result = await runFixedConsumer(dir);
    assert.equal(result.code, 0, "a complete buffered replay must succeed");
    assert.equal(result.stdout, markers(DEFAULT_IDS));
    assert.equal(result.stderr, "");
  });
});

test("fixed consumer accepts maximal padded timed v2 framing and rejects each exceeded shared bound", async () => {
  const chunkBytes = SENTINEL_REPLAY_MAX_UPSTREAM_BYTES / SENTINEL_REPLAY_MAX_UPSTREAM_CHUNKS;
  const chunksPerAttempt = SENTINEL_REPLAY_MAX_UPSTREAM_CHUNKS / SENTINEL_REPLAY_MAX_UPSTREAM_ATTEMPTS;
  assert.equal(chunkBytes % 3, 1, "every separately encoded chunk must require base64 padding");
  const headers = Object.fromEntries(SENTINEL_UPSTREAM_SAFE_RESPONSE_HEADER_NAMES.map((name) => [name, "x".repeat(SENTINEL_UPSTREAM_MAX_HEADER_VALUE_CHARS)]));
  const startedAtMs = Number.MAX_SAFE_INTEGER - SENTINEL_UPSTREAM_MAX_TIMING_MS;
  const timedAttempts = Array.from({ length: SENTINEL_REPLAY_MAX_UPSTREAM_ATTEMPTS }, (_value, attemptIndex) => {
    const finalAttempt = attemptIndex === SENTINEL_REPLAY_MAX_UPSTREAM_ATTEMPTS - 1;
    const chunks = Array.from({ length: chunksPerAttempt }, (_chunk, chunkIndex) => {
      if (!finalAttempt) return " ".repeat(chunkBytes);
      let event = "";
      if (chunkIndex === 0) event = created("resp_maximal") + delta("resp_maximal", "hello");
      if (chunkIndex === chunksPerAttempt - 1) event = completed("resp_maximal", "hello");
      return `${event}: ${"x".repeat(chunkBytes - event.length - 4)}\n\n`;
    });
    return {
      ...attempt("chatgpt_codex", chunks, "eof", { status: finalAttempt ? 200 : 500, content_type: finalAttempt ? "text/event-stream" : "application/json" }),
      headers,
      headers_truncated: false,
      chunk_times_ms: chunks.map(() => SENTINEL_UPSTREAM_MAX_TIMING_MS),
      started_at_ms: startedAtMs,
      headers_at_ms: startedAtMs + 1,
      ended_at_ms: Number.MAX_SAFE_INTEGER,
    };
  });
  const fixture: FixtureTrace = { ...trace(timedAttempts), version: 2 };
  const encodedChunks = timedAttempts.flatMap((entry) => entry.chunks_base64);
  assert.equal(encodedChunks.length, SENTINEL_REPLAY_MAX_UPSTREAM_CHUNKS);
  assert.equal(
    encodedChunks.every((chunk) => chunk.endsWith("==")),
    true,
    "each chunk is padded individually"
  );
  assert.equal(
    encodedChunks.reduce((bytes, chunk) => bytes + atob(chunk).length, 0),
    SENTINEL_REPLAY_MAX_UPSTREAM_BYTES
  );
  const serialized = JSON.stringify(fixture);
  assert.ok(serialized.length < SENTINEL_REPLAY_UPSTREAM_FILE_MAX_BYTES, "maximal v2 fields fit the imported file bound");
  // JSON permits trailing whitespace: exercise the exact shared file boundary
  // without changing the decoded trace, rather than copying an old size formula.
  const boundaryFile = serialized.padEnd(SENTINEL_REPLAY_UPSTREAM_FILE_MAX_BYTES, " ");
  assert.equal(new TextEncoder().encode(boundaryFile).byteLength, SENTINEL_REPLAY_UPSTREAM_FILE_MAX_BYTES);
  const filesFor = (content: string): readonly CaseFile[] =>
    replayCase({ trace: fixture, stream: true, report: true }).map((file) => (file.path === "fixtures/upstream.json" ? { ...file, content } : file));
  await withCase(filesFor(boundaryFile), async (dir) => {
    const result = await runFixedConsumer(dir);
    assert.equal(result.code, 0, "the real CLI must accept all decoded, chunk, attempt and file limits together");
    assert.equal(result.stdout.endsWith(markers(DEFAULT_IDS)), true);
    assert.equal(result.stderr, "");
    const report = replayReport(result);
    assert.equal(report.attempts, SENTINEL_REPLAY_MAX_UPSTREAM_ATTEMPTS);
    assert.deepEqual(
      report.attempt_statuses,
      timedAttempts.map((entry) => entry.status)
    );
    assert.equal(report.outcome, "completed");
  });
  const firstAttempt = timedAttempts.at(0);
  assert.ok(firstAttempt);
  const firstChunk = firstAttempt.chunks_base64.at(0);
  assert.ok(firstChunk);
  const oversizedBytes = {
    ...fixture,
    attempts: [{ ...firstAttempt, chunks_base64: [btoa(`${atob(firstChunk)}x`), ...firstAttempt.chunks_base64.slice(1)] }, ...timedAttempts.slice(1)],
  };
  const oversizedChunks = {
    ...fixture,
    attempts: [
      {
        ...firstAttempt,
        chunks_base64: [...firstAttempt.chunks_base64, btoa("")],
        chunk_times_ms: [...firstAttempt.chunk_times_ms, SENTINEL_UPSTREAM_MAX_TIMING_MS],
      },
      ...timedAttempts.slice(1),
    ],
  };
  const oversizedAttempts = {
    ...fixture,
    attempts: [...timedAttempts, { ...firstAttempt, chunks_base64: [], chunk_times_ms: [] }],
  };
  for (const [label, content] of [
    ["decoded byte bound plus one", JSON.stringify(oversizedBytes)],
    ["chunk bound plus one", JSON.stringify(oversizedChunks)],
    ["attempt bound plus one", JSON.stringify(oversizedAttempts)],
    ["shared file bound plus one", `${boundaryFile} `],
  ] as const) {
    await withCase(filesFor(content), async (dir) => {
      assertUnavailableWithReport(await runFixedConsumer(dir), label);
    });
  }
});

test("fixed consumer preserves trusted marker order and emits no extra output", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "x"), completed("resp_fixture", "x")];
  const ids = ["zeta", "alpha", "middle", "A.b:C_d"];
  await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "cancelled")]), stream: true, testIds: ids }), async (dir) => {
    const result = await runFixedConsumer(dir);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, markers(ids));
    assert.equal(result.stderr, "");
  });
});

test("recognized premature EOF before semantic output is reported as the causal failure", async () => {
  const chunks = [created("resp_fixture"), inProgress("resp_fixture")];
  for (const stream of [true, false]) {
    await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "eof")]), stream }), async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.equal(result.code, 1, `stream=${stream}: premature EOF must exit 1`);
      assert.equal(result.stdout, markers(DEFAULT_IDS) + CAUSAL_FAILURE_LINE);
      assert.equal(result.stderr, "");
    });
  }
});

test("recognized premature EOF after semantic output is reported as the causal failure", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "partial"), itemDone("resp_fixture", "partial")];
  for (const stream of [true, false]) {
    await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "eof")]), stream }), async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.equal(result.code, 1, `stream=${stream}: post-semantic premature EOF must exit 1`);
      assert.equal(result.stdout, markers(DEFAULT_IDS) + CAUSAL_FAILURE_LINE);
      assert.equal(result.stderr, "");
    });
  }
});

test("premature EOF is never reported as success for a missing terminal", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "partial")];
  for (const stream of [true, false]) {
    await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "eof")]), stream }), async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.notEqual(result.code, 0, `stream=${stream}: a missing terminal must never be a success`);
      assert.equal(result.stdout, markers(DEFAULT_IDS) + CAUSAL_FAILURE_LINE);
    });
  }
});

test("malformed and identity-changing events after semantic output are never the causal failure", async () => {
  // The buffered converter maps every iterator failure to the same fixed 502
  // body and the owned stream maps it to the same fixed failure event, so the
  // exact converter text alone must never turn these into a premature EOF.
  const malformed = [created("resp_fixture"), delta("resp_fixture", "partial"), "data: {not-json}\n\n"];
  const changedIdentity = [created("resp_fixture"), delta("resp_fixture", "partial"), inProgress("resp_other")];
  for (const stream of [true, false]) {
    for (const [label, chunks] of [
      ["malformed event", malformed],
      ["changed identity", changedIdentity],
    ] as const) {
      await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "eof")]), stream }), async (dir) => {
        const result = await runFixedConsumer(dir);
        assertUnavailable(result, `${label} after semantic output stream=${stream}`);
        assert.equal(result.stdout.includes(CAUSAL_FAILURE_LINE), false, `${label} stream=${stream}`);
      });
    }
  }
});

test("forged upstream synthetic-looking failures are never the causal failure", async () => {
  const forgedFailed = [
    created("resp_fixture"),
    sse({
      type: "response.failed",
      response: {
        id: "resp_fixture",
        object: "response",
        status: "failed",
        error: { code: "server_error", message: "The upstream stream ended unexpectedly." },
      },
    }),
  ];
  const forgedError = [created("resp_fixture"), sse({ type: "error", code: "server_error", message: "The upstream stream ended unexpectedly.", param: null })];
  for (const stream of [true, false]) {
    for (const [label, chunks] of [
      ["forged response.failed", forgedFailed],
      ["forged error event", forgedError],
    ] as const) {
      await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "eof")]), stream }), async (dir) => {
        const result = await runFixedConsumer(dir);
        assertUnavailable(result, `${label} stream=${stream}`);
        assert.equal(result.stdout.includes(CAUSAL_FAILURE_LINE), false, `${label} stream=${stream}`);
      });
    }
  }
});

test("paid Surplus replay preserves the real provider normalization with a synthetic key", async () => {
  const chunks = [created("resp_surplus"), delta("resp_surplus", "surplus text"), completed("resp_surplus", "surplus text")];
  for (const stream of [true, false]) {
    await withCase(replayCase({ trace: trace([attempt("surplus", chunks, "cancelled")]), stream }), async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.equal(result.code, 0, `stream=${stream}: the real Surplus fetch path must complete`);
      assert.equal(result.stdout, markers(DEFAULT_IDS));
      assert.equal(result.stderr, "");
    });
  }
});

test("paid Metered replay completes through the real provider fetch path", async () => {
  const chunks = [
    created("resp_metered"),
    delta("resp_metered", "metered text"),
    itemDone("resp_metered", "metered text"),
    completed("resp_metered", "metered text"),
  ];
  for (const stream of [true, false]) {
    await withCase(replayCase({ trace: trace([attempt("metered", chunks, "cancelled")]), stream }), async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.equal(result.code, 0, `stream=${stream}: the real Metered fetch path must complete`);
      assert.equal(result.stdout, markers(DEFAULT_IDS));
      assert.equal(result.stderr, "");
    });
  }
});

test("upstream-declared failures and empty completions stay unavailable", async () => {
  const declaredFailure = [
    created("resp_fixture"),
    sse({
      type: "response.failed",
      response: {
        id: "resp_fixture",
        object: "response",
        status: "failed",
        error: { code: "upstream_error", message: "provider refused" },
      },
    }),
  ];
  const emptyCompletion = [created("resp_fixture"), completed("resp_fixture", "", [])];
  for (const stream of [true, false]) {
    for (const [label, chunks, terminal] of [
      ["declared failure", declaredFailure, "cancelled"],
      ["empty completion", emptyCompletion, "cancelled"],
    ] as const) {
      await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, terminal)]), stream }), async (dir) => {
        const result = await runFixedConsumer(dir);
        assertUnavailable(result, `${label} stream=${stream}`);
        assert.equal(result.stdout.includes(TEST_MARKER_PREFIX), false, "no markers for unavailable input");
      });
    }
  }
});

test("completed responses without real semantic output are never successful", async () => {
  // The gateway rejects a committed response.completed with no semantic event
  // (prepareResponsesAttempt), and the actual converted output must also carry
  // completed status, response identity and semantic content reported by the
  // same responsesEventSemanticKind utility. None of these may be a success.
  const reasoningOnly = [created("resp_fixture"), completed("resp_fixture", "", [{ type: "reasoning", summary: [] }])];
  const malformedOutputItem = [created("resp_fixture"), completed("resp_fixture", "", [{}])];
  // The precommit content-part text is real semantic output, but the buffered
  // converter does not repair this malformed terminal output, so the actual
  // completed Response object still carries no usable semantic content.
  const malformedAfterSemanticText = [
    created("resp_fixture"),
    sse({
      type: "response.content_part.done",
      response_id: "resp_fixture",
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "hello", annotations: [] },
    }),
    completed("resp_fixture", "hello", [{}]),
  ];
  for (const stream of [true, false]) {
    for (const [label, chunks] of [
      ["reasoning-only completion", reasoningOnly],
      ["output:[{}] completion", malformedOutputItem],
      ["malformed completion after semantic text", malformedAfterSemanticText],
    ] as const) {
      await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "cancelled")]), stream }), async (dir) => {
        const result = await runFixedConsumer(dir);
        assertUnavailable(result, `${label} stream=${stream}`);
        assert.equal(result.stdout.includes(CAUSAL_FAILURE_LINE), false, `${label} stream=${stream}`);
      });
    }
  }
});

test("malformed recorded SSE is unavailable instead of the expected failure", async () => {
  const chunks = [created("resp_fixture"), "data: {not-json}\n\n"];
  for (const stream of [true, false]) {
    await withCase(replayCase({ trace: trace([attempt("chatgpt_codex", chunks, "cancelled")]), stream }), async (dir) => {
      const result = await runFixedConsumer(dir);
      assertUnavailable(result, `malformed SSE stream=${stream}`);
    });
  }
});

test("truncated, empty, multi-attempt and unsupported attempts are unavailable", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "x"), completed("resp_fixture", "x")];
  const cases: readonly (readonly [string, FixtureTrace])[] = [
    ["empty trace", trace([])],
    ["attempts truncated", trace([attempt("chatgpt_codex", chunks, "cancelled")], { attempts_truncated: true })],
    ["bytes truncated", trace([attempt("chatgpt_codex", chunks, "cancelled")], { bytes_truncated: true })],
    ["chunks truncated", trace([attempt("chatgpt_codex", chunks, "cancelled")], { chunks_truncated: true })],
    ["multi-attempt fallback", trace([attempt("chatgpt_codex", chunks, "read_error"), attempt("surplus", chunks, "cancelled")])],
    ["cerebras provider", trace([attempt("cerebras", chunks, "cancelled")])],
    ["non-200 status", trace([attempt("chatgpt_codex", chunks, "cancelled", { status: 500 })])],
    ["non-SSE content type", trace([attempt("chatgpt_codex", chunks, "cancelled", { content_type: "application/json" })])],
    ["pending terminal", trace([attempt("chatgpt_codex", chunks, "pending")])],
  ];
  for (const [label, fixture] of cases) {
    await withCase(replayCase({ trace: fixture, stream: true }), async (dir) => {
      const result = await runFixedConsumer(dir);
      assertUnavailable(result, label);
    });
  }
});

test("unsupported request bodies and envelopes are unavailable", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "x"), completed("resp_fixture", "x")];
  const fixtures = trace([attempt("chatgpt_codex", chunks, "cancelled")]);
  const bodies: readonly (readonly [string, string])[] = [
    ["chat completions body", requestEnvelope({ model: "gpt-5.6-codex", messages: [{ role: "user", content: "hi" }] })],
    ["missing input", requestEnvelope({ model: "gpt-5.6-codex", stream: true })],
    ["non-boolean stream", requestEnvelope({ model: "gpt-5.6-codex", stream: "yes", input: "hi" })],
    ["non-object body", JSON.stringify({ version: 1, endpoint: "/v1/responses", body: '"text"' })],
    ["missing body", JSON.stringify({ version: 1, endpoint: "/v1/responses" })],
    ["truncated body json", JSON.stringify({ version: 1, endpoint: "/v1/responses", body: '{"model":"gpt-5.6-codex","input":' })],
  ];
  for (const [label, request] of bodies) {
    await withCase(
      [
        {
          path: ".sentinel-replay-input.json",
          content: metadata("fixtures/request.json", "fixtures/upstream.json", DEFAULT_IDS),
        },
        { path: "fixtures/request.json", content: request },
        { path: "fixtures/upstream.json", content: JSON.stringify(fixtures) },
      ],
      async (dir) => {
        const result = await runFixedConsumer(dir);
        assertUnavailable(result, label);
      }
    );
  }
});

test("malformed, oversized, escaped and duplicate dispatch metadata are unavailable", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "x"), completed("resp_fixture", "x")];
  const fixtures = JSON.stringify(trace([attempt("chatgpt_codex", chunks, "cancelled")]));
  const sixtyFiveIds = Array.from({ length: 65 }, (_value, index) => `id-${index}`);
  const metadataCases: readonly (readonly [string, string])[] = [
    ["invalid json", "{not-json"],
    [
      "wrong version",
      JSON.stringify({
        version: "v2",
        requestPath: "fixtures/request.json",
        upstreamPath: "fixtures/upstream.json",
        testIds: DEFAULT_IDS,
      }),
    ],
    ["missing test ids", JSON.stringify({ version: "v1", requestPath: "fixtures/request.json", upstreamPath: "fixtures/upstream.json" })],
    [
      "extra keys",
      JSON.stringify({
        version: "v1",
        requestPath: "fixtures/request.json",
        upstreamPath: "fixtures/upstream.json",
        testIds: DEFAULT_IDS,
        extra: true,
      }),
    ],
    ["absolute path", metadata("/etc/passwd", "fixtures/upstream.json", DEFAULT_IDS)],
    ["traversal path", metadata("../outside.json", "fixtures/upstream.json", DEFAULT_IDS)],
    ["empty segment", metadata("fixtures//request.json", "fixtures/upstream.json", DEFAULT_IDS)],
    ["dot segment", metadata("./fixtures/request.json", "fixtures/upstream.json", DEFAULT_IDS)],
    ["duplicate paths", metadata("fixtures/upstream.json", "fixtures/upstream.json", DEFAULT_IDS)],
    ["missing file", metadata("fixtures/missing.json", "fixtures/upstream.json", DEFAULT_IDS)],
    ["no test ids", metadata("fixtures/request.json", "fixtures/upstream.json", [])],
    ["duplicate test ids", metadata("fixtures/request.json", "fixtures/upstream.json", ["dup", "dup"])],
    ["invalid test id", metadata("fixtures/request.json", "fixtures/upstream.json", ["bad id"])],
    ["too many test ids", metadata("fixtures/request.json", "fixtures/upstream.json", sixtyFiveIds)],
    ["oversized metadata", metadata(`fixtures/${"a".repeat(17 * 1024)}.json`, "fixtures/upstream.json", DEFAULT_IDS)],
  ];
  for (const [label, dispatch] of metadataCases) {
    await withCase(
      [
        { path: ".sentinel-replay-input.json", content: dispatch },
        { path: "fixtures/request.json", content: requestEnvelope(responsesBody(false)) },
        { path: "fixtures/upstream.json", content: fixtures },
      ],
      async (dir) => {
        const result = await runFixedConsumer(dir);
        assertUnavailable(result, label);
      }
    );
  }

  // Fatal UTF-8 parsing must fail closed on every input file.
  const invalidBytes = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
  await withCase(
    [
      { path: ".sentinel-replay-input.json", content: invalidBytes },
      { path: "fixtures/request.json", content: requestEnvelope(responsesBody(false)) },
      { path: "fixtures/upstream.json", content: fixtures },
    ],
    async (dir) => {
      assertUnavailable(await runFixedConsumer(dir), "invalid utf8 metadata");
    }
  );
  await withCase(
    [
      {
        path: ".sentinel-replay-input.json",
        content: metadata("fixtures/request.json", "fixtures/upstream.json", DEFAULT_IDS),
      },
      { path: "fixtures/request.json", content: invalidBytes },
      { path: "fixtures/upstream.json", content: fixtures },
    ],
    async (dir) => {
      assertUnavailable(await runFixedConsumer(dir), "invalid utf8 request");
    }
  );
});

test("symlinked fixture files and symlinked ancestors are unavailable", async () => {
  const chunks = [created("resp_fixture"), delta("resp_fixture", "x"), completed("resp_fixture", "x")];
  const fixtures = JSON.stringify(trace([attempt("chatgpt_codex", chunks, "cancelled")]));
  const dispatch = metadata("fixtures/request.json", "fixtures/upstream.json", DEFAULT_IDS);
  const files: readonly CaseFile[] = [
    { path: ".sentinel-replay-input.json", content: dispatch },
    { path: "fixtures/real-request.json", content: requestEnvelope(responsesBody(false)) },
    { path: "fixtures/upstream.json", content: fixtures },
  ];

  await withCase(files, async (dir) => {
    await symlink("real-request.json", `${dir}/fixtures/request.json`);
    assertUnavailable(await runFixedConsumer(dir), "symlinked request file");
  });

  await withCase(
    [
      {
        path: ".sentinel-replay-input.json",
        content: metadata("linkdir/request.json", "fixtures/upstream.json", DEFAULT_IDS),
      },
      { path: "fixtures/request.json", content: requestEnvelope(responsesBody(false)) },
      { path: "fixtures/upstream.json", content: fixtures },
    ],
    async (dir) => {
      await symlink("fixtures", `${dir}/linkdir`);
      assertUnavailable(await runFixedConsumer(dir), "symlinked ancestor directory");
    }
  );
});

test("no request, upstream or secret-like canary bytes reach stdout or stderr", async () => {
  const canaryChunks = [created("resp_canary"), delta("resp_canary", CANARY), completed("resp_canary", CANARY)];
  const cleanTrace = trace([attempt("chatgpt_codex", canaryChunks, "cancelled")]);
  await withCase(
    [
      {
        path: ".sentinel-replay-input.json",
        content: metadata("fixtures/request.json", "fixtures/upstream.json", DEFAULT_IDS),
      },
      { path: "fixtures/request.json", content: requestEnvelope(responsesBody(true, CANARY), { note: CANARY }) },
      { path: "fixtures/upstream.json", content: JSON.stringify(cleanTrace) },
    ],
    async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, markers(DEFAULT_IDS));
      assert.equal(result.stdout.includes(CANARY), false, "stdout must never carry request or upstream content");
      assert.equal(result.stderr.includes(CANARY), false, "stderr must never carry request or upstream content");
    }
  );

  const eofTrace = trace([attempt("chatgpt_codex", [created("resp_canary"), delta("resp_canary", CANARY)], "eof")]);
  await withCase(
    [
      {
        path: ".sentinel-replay-input.json",
        content: metadata("fixtures/request.json", "fixtures/upstream.json", DEFAULT_IDS),
      },
      { path: "fixtures/request.json", content: requestEnvelope(responsesBody(true, CANARY)) },
      { path: "fixtures/upstream.json", content: JSON.stringify(eofTrace) },
    ],
    async (dir) => {
      const result = await runFixedConsumer(dir);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, markers(DEFAULT_IDS) + CAUSAL_FAILURE_LINE);
      assert.equal(result.stdout.includes(CANARY), false);
      assert.equal(result.stderr.includes(CANARY), false);
    }
  );

  await withCase(
    [
      { path: ".sentinel-replay-input.json", content: `{"version":"v1","canary":"${CANARY}",` },
      { path: "fixtures/request.json", content: requestEnvelope(responsesBody(false)) },
      { path: "fixtures/upstream.json", content: JSON.stringify(cleanTrace) },
    ],
    async (dir) => {
      const result = await runFixedConsumer(dir);
      assertUnavailable(result, "malformed metadata canary");
      assert.equal(result.stdout.includes(CANARY), false);
    }
  );
});
