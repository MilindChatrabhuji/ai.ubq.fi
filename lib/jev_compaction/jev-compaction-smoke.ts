/**
 * Prototype acceptance harness for the gateway Jev compaction slice.
 *
 * It runs the real gateway handler (`createServeHandler(handler)`) over real
 * loopback HTTP with a real in-memory KV, seeded API key and quota accounting,
 * and one fake upstream that must never see a marked compaction request. Jev is
 * injected, so this run is credential-free and makes no external call: it proves
 * the gateway wiring, the local answer, the ordinary-route passthrough and the
 * fail-closed paths. Real Jev and the stock Codex client are a separate
 * acceptance run against a served candidate.
 *
 * Run from the worktree root (the script sets the existing fixture dummy
 * `DEEPSEEK_API_KEY` in-process for its mocked ordinary provider; it never reads,
 * prints or forwards a real DeepSeek credential):
 *   bun --no-env-file run lib/jev_compaction/jev-compaction-smoke.ts
 * Run with a scrubbed environment; --no-env-file prevents dotenv loading but
 * does not remove inherited provider credentials.
 *
 * One JSON object is printed: PASS/failure class plus structural counts only,
 * never a credential, transcript, or provider payload.
 */
import assert from "node:assert/strict";
import { serveHttp } from "#http";
import { openKv, type Kv } from "#kv";
import { nativeKvDevelopmentPaths, prepareNativeKvForDevelopment } from "../../src/runtime/native-kv-bootstrap.ts";
import { preparedNativeKvArtifactBinding, verifyNativeKvArtifact, type NativeKvArtifactBinding } from "../../src/storage/native-addon.ts";
import { PAID_FALLBACK_NO_LIMIT } from "../../src/api-keys.ts";
import { apiKeyPolicyFromHashRecord, apiKeyUsageV3RequestKey, apiKeyUsageV3WindowKey, resetApiKeyPolicyCacheForTest } from "../../src/api-key-policy.ts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "../../src/deepseek/index.ts";
import { setInferenceAdmissionControllerForTest } from "../../src/handler/admission.ts";
import { createInferenceAdmissionController } from "../../src/inference-admission.ts";
import { setJevCompactionAskerForTest } from "../../src/jev_compaction/compaction.ts";
import { setKvForTest } from "../../src/kv.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../../src/types.ts";
import { sha256Base64Url } from "../../src/utils.ts";
import type { JevAsker, JevQuestions, JevResponse } from "./types.ts";

const METADATA_HEADER = "x-codex-turn-metadata";
const METADATA = JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses" } });
const COMPACTION_PROMPT = "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM.";
const KEPT_MARKER = "SMOKE_KEEP_MARKER_release_notes";
const SUMMARY_MARKER = "# fast-jev-compaction memory summary";
/** Existing test-fixture mechanism: a synthetic value for the mocked provider. */
const DUMMY_DEEPSEEK_KEY = "jev-smoke-dummy-deepseek-key";

type Report = {
  status: "PASS" | "FAIL";
  failure_class: string;
  compaction_status: number;
  compaction_summary_chars: number;
  compaction_dropped: number;
  compaction_structural_header: string;
  compaction_terminal_records: number;
  compaction_completed: boolean;
  compaction_usage_observed: boolean;
  compaction_provider: string;
  compaction_reservation_state: string;
  ordinary_status: number;
  ordinary_upstream_saw_summary: boolean;
  ordinary_upstream_saw_new_message: boolean;
  upstream_calls: number;
  jev_calls: number;
  jev_questions: number;
  refused_status: number;
  refusal_upstream_calls: number;
  refusal_settled_incomplete: boolean;
  total_ms: number;
};

const report: Report = {
  status: "FAIL",
  failure_class: "not-started",
  compaction_status: 0,
  compaction_summary_chars: 0,
  compaction_dropped: 0,
  compaction_structural_header: "",
  compaction_terminal_records: 0,
  compaction_completed: false,
  compaction_usage_observed: false,
  compaction_provider: "",
  compaction_reservation_state: "",
  ordinary_status: 0,
  ordinary_upstream_saw_summary: false,
  ordinary_upstream_saw_new_message: false,
  upstream_calls: 0,
  jev_calls: 0,
  jev_questions: 0,
  refused_status: 0,
  refusal_upstream_calls: 0,
  refusal_settled_incomplete: false,
  total_ms: 0,
};

const text = (role: string, value: string) => ({ type: "message", role, content: [{ type: "input_text", text: value }] });
const call = (callId: string, command: string) => ({ type: "function_call", call_id: callId, name: "shell", arguments: JSON.stringify({ command }) });
const output = (callId: string, value: string) => ({ type: "function_call_output", call_id: callId, output: value });

/** Three obsolete unpinned call/result pairs, a pinned keep marker and Codex's injected prompt. */
const compactionInput = (): unknown[] => [
  text("user", `Goal: finish the release notes and keep ${KEPT_MARKER} verbatim.`),
  text("assistant", "Starting with the old build logs."),
  call("old_a", "tail -n 400 /tmp/old/build.log"),
  output("old_a", "SMOKE_RESULT_A obsolete build log line. ".repeat(60)),
  call("old_b", "grep -c deprecated /tmp/old/metrics.csv"),
  output("old_b", "SMOKE_RESULT_B obsolete metric line. ".repeat(60)),
  call("old_c", "ls -la /tmp/old/cache"),
  output("old_c", "SMOKE_RESULT_C obsolete cache line. ".repeat(60)),
  text("assistant", "The old investigation is finished; those logs are obsolete."),
  text("user", "Recent follow-up one: draft the release notes outline."),
  text("assistant", "Drafted the outline."),
  text("user", "Recent follow-up two: check the artifact wording."),
  text("assistant", "Checked."),
  text("user", `Final goal: ${KEPT_MARKER} stays verbatim.`),
  text("user", COMPACTION_PROMPT),
];

/** Drops every unpinned call and result; the pinned newest messages stay. */
const dropEverythingAsker = (): JevAsker => ({
  ask(_state, questions: JevQuestions): Promise<JevResponse> {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) answers[name] = { noul: 0.1 };
    report.jev_calls += 1;
    report.jev_questions += Object.keys(questions).length;
    return Promise.resolve({ answers });
  },
});

const chatChunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-jev-smoke",
    object: "chat.completion.chunk",
    created: 1_780_000_009,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;

const sseBody = (frames: readonly string[]): string => `${frames.join("")}data: [DONE]\n\n`;

const post = (base: string, token: string, payload: Record<string, unknown>, metadata?: string, signal?: AbortSignal): Promise<Response> =>
  fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(metadata ? { [METADATA_HEADER]: metadata } : {}),
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
};

const startGateway = async (): Promise<{
  url: string;
  token: string;
  kv: Kv;
  policy: NonNullable<ReturnType<typeof apiKeyPolicyFromHashRecord>>;
  stop: () => Promise<void>;
}> => {
  const kv = await openKv(":memory:");
  const keyId = "jev-compaction-smoke-key";
  const token = `u_${"c".repeat(64)}`;
  const tokenHash = await sha256Base64Url(token);
  const now = Date.now();
  const windowMs = 60 * 60_000;
  const commonPolicy = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 500,
    usage_requests: 0,
    usage_reset_at_ms: now + windowMs,
    window_ms: windowMs,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: PAID_FALLBACK_NO_LIMIT,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  } satisfies Omit<ApiKeyHashRecord, "id">;
  const keyRecord: ApiKeyRecord = {
    id: keyId,
    name: "jev compaction smoke key",
    prefix: token.slice(0, 10),
    hash: tokenHash,
    created_at_ms: now,
    ...commonPolicy,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: now,
  };
  await kv.set(["ubq_ai", "api_keys", "id", keyId], keyRecord);
  await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], { id: keyId, ...commonPolicy } satisfies ApiKeyHashRecord);
  const policy = apiKeyPolicyFromHashRecord(tokenHash, { id: keyId, ...commonPolicy }, now);
  assert.ok(policy, "the seeded key must resolve to a live policy");

  setKvForTest(kv);
  resetApiKeyPolicyCacheForTest();
  setInferenceAdmissionControllerForTest(createInferenceAdmissionController({ maxActive: 8, maxWaiting: 8, maxQueueWaitMs: 500 }));
  const { default: handler } = await import("../../src/handler/index.ts");
  const { createServeHandler } = await import("../../src/handler/serve-handler.ts");
  const gateway = serveHttp({ hostname: "127.0.0.1", port: 0 }, createServeHandler(handler));
  const address = await gateway.ready;
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    kv,
    policy,
    stop: async () => {
      setKvForTest(null);
      setInferenceAdmissionControllerForTest(null);
      await gateway.shutdown();
      kv.close();
    },
  };
};

/** One fake DeepSeek chat upstream; every ordinary responses request lands here. */
const startUpstream = async (calls: string[]): Promise<{ url: string; stop: () => Promise<void> }> => {
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, async (request) => {
    calls.push(await request.text());
    return new Response(
      sseBody([
        chatChunk({ role: "assistant", content: "smoke ordinary answer" }, null),
        chatChunk({}, "stop", { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }),
      ]),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  });
  const address = await server.ready;
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () => server.shutdown(),
  };
};

const prepareSmokeKv = async (): Promise<void> => {
  let binding: NativeKvArtifactBinding | undefined;
  try {
    binding = preparedNativeKvArtifactBinding();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Prepare the verified native KV artifact before starting a child") throw error;
  }
  if (binding) verifyNativeKvArtifact({ ...binding, inputsManifest: nativeKvDevelopmentPaths().inputs });
  else await prepareNativeKvForDevelopment();
};

const main = async (): Promise<void> => {
  await prepareSmokeKv();
  const started = performance.now();
  // Existing test-fixture mechanism: the mocked ordinary provider needs a
  // DeepSeek key present, so set the synthetic value and restore it afterwards.
  // The value is never logged, and no inherited real key is used or forwarded.
  const inheritedDeepSeekKey = process.env["DEEPSEEK_API_KEY"];
  process.env["DEEPSEEK_API_KEY"] = DUMMY_DEEPSEEK_KEY;
  const terminalRecords: Array<Record<string, unknown>> = [];
  const originalConsoleInfo = console.info;
  console.info = (...args: unknown[]): void => {
    if (args[0] === "[ai.ubq.fi] request_terminal" && typeof args[1] === "string") {
      try {
        terminalRecords.push(JSON.parse(args[1]) as Record<string, unknown>);
      } catch {
        // Structural capture only; a malformed log line is ignored.
      }
    }
    originalConsoleInfo(...args);
  };
  const upstreamCalls: string[] = [];
  const upstream = await startUpstream(upstreamCalls);
  const originalFetch = globalThis.fetch;
  const fixtureFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    if (url === DEEPSEEK_CHAT_COMPLETIONS_URL) return originalFetch(`${upstream.url}/chat/completions`, init);
    return originalFetch(input, init);
  };
  globalThis.fetch = Object.assign(fixtureFetch, { preconnect: originalFetch.preconnect });
  const gateway = await startGateway();
  setJevCompactionAskerForTest(dropEverythingAsker());
  try {
    // 1. A marked compaction request is answered locally by the injected Jev.
    const compaction = await post(
      gateway.url,
      gateway.token,
      { model: "deepseek-flash", stream: true, input: compactionInput() },
      METADATA,
      AbortSignal.timeout(20_000)
    );
    report.compaction_status = compaction.status;
    report.compaction_structural_header = compaction.headers.get("x-jev-compaction") ?? "";
    const compactionText = await compaction.text();
    assert.equal(compaction.status, 200, "the marked compaction must be answered with a completed response");
    assert.ok(compactionText.includes(SUMMARY_MARKER), "the Jev summary marker must be present");
    assert.ok(compactionText.includes(KEPT_MARKER), "pinned content must be kept verbatim");
    assert.ok(compactionText.includes("event: response.completed"), "the summary must terminate with response.completed");
    assert.ok(compactionText.includes("[tool call old_a]"), "a dropped call must keep its provenance line");
    assert.ok(compactionText.includes("SMOKE_RESULT_A"), "a dropped result must keep its bounded head");
    assert.ok(!compactionText.includes("SMOKE_RESULT_A obsolete build log line. ".repeat(20)), "a dropped result must be bounded, not full");
    assert.match(report.compaction_structural_header, /calls_dropped=3/);
    report.compaction_dropped = 3;
    report.compaction_summary_chars = compactionText.length;
    assert.equal(upstreamCalls.length, 0, "the fake upstream must never see a marked compaction request");
    assert.equal(report.jev_calls, 1, "exactly one Jev batch is expected for the synthetic transcript");
    const summaryText = compactionText;

    // 1b. The successful local answer settles as completed exactly once, with no
    //     invented main-model usage and the honest gateway provider label.
    const compactionRequestId = compaction.headers.get("x-uos-request-id");
    assert.ok(compactionRequestId, "the compaction response must carry the gateway request id");
    await waitFor(() => terminalRecords.some((entry) => entry.request_id === compactionRequestId), "the compaction terminal record");
    await delay(250);
    const compactionTerminals = terminalRecords.filter((entry) => entry.request_id === compactionRequestId);
    report.compaction_terminal_records = compactionTerminals.length;
    assert.equal(compactionTerminals.length, 1, "the compaction must settle exactly once");
    const terminal: Record<string, unknown> = compactionTerminals[0] ?? {};
    report.compaction_completed =
      terminal.semantic_output_observed === true && terminal.stream_terminal_type === "response.completed" && terminal.failure_kind === null;
    assert.ok(report.compaction_completed, "a successful local compaction must settle as completed");
    report.compaction_usage_observed = terminal.usage_observed === true;
    assert.equal(terminal.usage_observed, false, "a local answer must not report invented main-model usage");
    assert.equal(terminal.input_tokens ?? null, null, "input tokens must stay unknown");
    assert.equal(terminal.output_tokens ?? null, null, "output tokens must stay unknown");
    assert.equal(terminal.total_tokens ?? null, null, "total tokens must stay unknown");
    report.compaction_provider = typeof terminal.provider === "string" ? terminal.provider : "";
    assert.equal(report.compaction_provider, "gateway", "provider provenance must stay the honest gateway label");
    // API-key usage, for the context actually seeded here: this request never
    // dispatched a provider, so the existing executeInference contract releases
    // its reservation unconsumed, and no kernel context exists so there is no
    // kernel reservation to commit. Assert exactly that: no invented charge and
    // no dangling hold. (Nothing asserts a fixture quota that the seed lacks.)
    const usageWindow = await gateway.kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(gateway.policy), { consistency: "strong" });
    assert.equal(usageWindow.value?.committed_requests ?? 0, 0, "a locally answered compaction must not invent a charged request");
    const usageRow = await gateway.kv.get<ApiKeyUsageRequestV3>(apiKeyUsageV3RequestKey(gateway.policy, compactionRequestId), { consistency: "strong" });
    report.compaction_reservation_state = usageRow.value?.state ?? "absent";
    if (usageRow.value) {
      assert.equal(usageRow.value.state, "released", "the unconsumed API-key reservation must be released, never left reserved or dispatched");
    }

    // 2. An unmarked request is untouched: it reaches the upstream, and the
    //    summary the client adopted plus the next user message are both there.
    const nextMessage = "Continue after compaction: publish the release notes.";
    const ordinary = await post(gateway.url, gateway.token, {
      model: "deepseek-flash",
      stream: true,
      input: [text("user", `${summaryText}\n\n${nextMessage}`)],
    });
    report.ordinary_status = ordinary.status;
    await ordinary.text();
    assert.equal(ordinary.status, 200, "the ordinary route must still answer");
    assert.equal(upstreamCalls.length, 1, "the ordinary request must reach the upstream");
    report.upstream_calls = upstreamCalls.length;
    const ordinaryUpstreamBody: string | undefined = upstreamCalls[0];
    assert.ok(ordinaryUpstreamBody, "the ordinary upstream body must be recorded");
    report.ordinary_upstream_saw_summary = ordinaryUpstreamBody.includes(SUMMARY_MARKER);
    report.ordinary_upstream_saw_new_message = ordinaryUpstreamBody.includes(nextMessage);
    assert.ok(report.ordinary_upstream_saw_summary, "the adopted memory must reach the upstream untouched");
    assert.ok(report.ordinary_upstream_saw_new_message, "the follow-up message must reach the upstream untouched");
    assert.equal(report.jev_calls, 1, "an ordinary message must not invoke Jev");

    // 3. A marked compaction with nothing to decide fails closed and stays local.
    const refused = await post(
      gateway.url,
      gateway.token,
      { model: "deepseek-flash", stream: true, input: [text("user", "short"), text("assistant", "short answer")] },
      METADATA
    );
    report.refused_status = refused.status;
    await refused.text();
    report.refusal_upstream_calls = upstreamCalls.length;
    assert.ok(refused.status >= 400, "a compaction with no candidates must fail closed");
    assert.equal(upstreamCalls.length, 1, "a failed compaction must not fall back to the upstream");
    assert.equal(report.jev_calls, 1, "a compaction with no candidates must not invoke Jev");
    const refusedRequestId = refused.headers.get("x-uos-request-id");
    assert.ok(refusedRequestId, "the refused compaction must carry the gateway request id");
    await waitFor(() => terminalRecords.some((entry) => entry.request_id === refusedRequestId), "the refused compaction terminal record");
    const refusedTerminal: Record<string, unknown> = terminalRecords.find((entry) => entry.request_id === refusedRequestId) ?? {};
    report.refusal_settled_incomplete = refusedTerminal.semantic_output_observed !== true;
    assert.ok(report.refusal_settled_incomplete, "a failed compaction must not settle as completed");

    report.status = "PASS";
    report.failure_class = "none";
  } finally {
    report.total_ms = Math.round(performance.now() - started);
    setJevCompactionAskerForTest(null);
    console.info = originalConsoleInfo;
    if (inheritedDeepSeekKey === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = inheritedDeepSeekKey;
    globalThis.fetch = originalFetch;
    await gateway.stop();
    await upstream.stop();
  }
};

try {
  await main();
} catch (error) {
  report.status = "FAIL";
  report.failure_class = error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown";
}

console.log(JSON.stringify(report));
process.exit(report.status === "PASS" ? 0 : 1);
