import type { KvEntry, KvKey, KvListOptions, KvListSelector } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";

import { handleAgentMessagesList, handleAgentMessagesPost } from "../src/agent-messages.ts";
import {
  aggregateResponseTelemetry,
  attachResponseTelemetry,
  classifyPreHeaderFailure,
  classifyStreamFailure,
  countExplicitPromptCacheBreakpoints,
  createResponseTelemetryState,
  extractChatUsageTokens,
  getResponseTelemetry,
  isTimeoutFailure,
  promptCacheKeyPresent,
  promptCacheModeFor,
  recordAttemptedProvider,
  recordFirstCodexDispatch,
  recordFirstCodexHeaders,
  recordRemovedProviderFields,
  recordResponsesEventTelemetry,
  recordResponsesFailureTelemetry,
  recordStreamTerminalType,
  recordTerminalUsage,
  selectRemovedProviderTelemetry,
  streamErrorResponse,
  supportsReasoningProgressRelease,
} from "../src/openai-telemetry.ts";
import type { ResponseTelemetryState, UsageContext } from "../src/openai-telemetry.ts";
import { ResponsesStreamError } from "../src/responses-stream.ts";
import { CODEX_AUTH_REAUTH_WARNING, CodexError } from "../src/codex/auth.ts";

/* --------------------------------------------------------- agent messages */

type StoredMessage = Readonly<{
  id: string;
  owner: string;
  repo: string;
  state_id: string;
  agent_id: string;
  channel: string | null;
  kind: string | null;
  body: string;
  metadata: Record<string, unknown> | null;
  created_at_ms: number;
}>;

const githubAuth =
  (owner = "acme", repo = "demo", stateId = "state-1") =>
  () =>
    Promise.resolve({
      ok: true as const,
      token: "ghs_test_token",
      method: { kind: "github_token" as const, owner, repo, state_id: stateId, limit_scope: "org" as const },
    });

const rejectedAuth = () => Promise.resolve({ ok: false as const, response: new Response("unauthorized", { status: 401 }) });

const apiKeyAuth = () =>
  Promise.resolve({
    ok: true as const,
    token: "uos_key",
    method: {
      kind: "kv_api_key" as const,
      key_id: "key-1",
      policy: {
        token_hash: "hash",
        key_id: "key-1",
        expires_at_ms: -1,
        usage_limit_requests: -1,
        window_ms: 60_000,
        window_start_ms: 0,
        usage_reset_at_ms: 60_000,
        policy_version: "v3:60000",
        paid_fallback_enabled: false,
        paid_fallback_limit_microcredits: 0,
        paid_fallback_spent_microcredits: 0,
        paid_fallback_reserved_microcredits: 0,
        paid_fallback_reservation_request_id: null,
      },
    },
  });

/** A list-capable in-memory KV that records the selector and options it received. */
class MessageKv {
  readonly entries: KvEntry<unknown>[] = [];
  readonly selectors: KvListSelector[] = [];
  readonly options: KvListOptions[] = [];
  cursor = "";

  set(key: KvKey, value: unknown): Promise<unknown> {
    this.entries.push({ key, value, versionstamp: "00000000000000000001" });
    return Promise.resolve({ ok: true });
  }

  list<T>(selector: KvListSelector, options?: KvListOptions): AsyncIterableIterator<KvEntry<T>> & { readonly cursor: string } {
    this.selectors.push(selector);
    this.options.push(options ?? {});
    const entries = this.entries.map((entry) => ({ ...entry, value: entry.value as T }));
    const cursor = this.cursor;
    const iterator = {
      cursor,
      next: (): Promise<IteratorResult<KvEntry<T>>> =>
        Promise.resolve(entries.length > 0 ? { value: entries.shift() as KvEntry<T>, done: false } : { value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }
}

const jsonPost = (url: string, body: unknown): Request =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const message = (overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  id: "message-1",
  owner: "acme",
  repo: "demo",
  state_id: "state-1",
  agent_id: "agent-1",
  channel: null,
  kind: null,
  body: "hello",
  metadata: null,
  created_at_ms: 1_700_000_000_000,
  ...overrides,
});

test("agent message posting refuses an unusable token, binding or body", async () => {
  const kv = new MessageKv();
  const post = (body: unknown, deps: Parameters<typeof handleAgentMessagesPost>[1] = {}) =>
    handleAgentMessagesPost(jsonPost("https://ai.ubq.fi/agent/messages", body), { authenticateClient: githubAuth(), kv, ...deps });

  const rejected = await handleAgentMessagesPost(jsonPost("https://ai.ubq.fi/agent/messages", {}), { authenticateClient: rejectedAuth });
  assert.equal(rejected.status, 401);
  const wrongMethod = await handleAgentMessagesPost(jsonPost("https://ai.ubq.fi/agent/messages", {}), { authenticateClient: apiKeyAuth });
  assert.equal(wrongMethod.status, 403);
  assert.equal(((await wrongMethod.json()) as { error: { message: string } }).error.message, "GitHub token auth required");

  const withoutKv = await handleAgentMessagesPost(jsonPost("https://ai.ubq.fi/agent/messages", {}), { authenticateClient: githubAuth(), kv: null });
  assert.equal(withoutKv.status, 503);
  assert.equal((await post("not an object")).status, 400, "a non-object body is refused");

  for (const agentId of [undefined, "", "   ", 7, "a".repeat(121), "agent\ninjected"]) {
    assert.equal((await post({ agent_id: agentId, body: "hello" })).status, 400, `agent_id ${JSON.stringify(agentId)} must be refused`);
  }
  for (const body of [undefined, "", "   ", 42, "b".repeat(8001)]) {
    const response = await post({ agent_id: "agent-1", body });
    if (body === "   ") {
      assert.equal(response.status, 400, "a whitespace-only body is refused");
      continue;
    }
    assert.equal(response.status, 400, `body ${String(body).slice(0, 12)} must be refused`);
  }

  assert.equal((await post({ agent_id: "agent-1", body: "hi", channel: "" })).status, 400, "an empty channel is refused rather than dropped");
  assert.equal((await post({ agent_id: "agent-1", body: "hi", channel: "a".repeat(121) })).status, 400);
  assert.equal((await post({ agent_id: "agent-1", body: "hi", channel: 42 })).status, 400);
  assert.equal((await post({ agent_id: "agent-1", body: "hi", kind: "line\nbreak" })).status, 400);
  assert.equal((await post({ agent_id: "agent-1", body: "hi", kind: {} })).status, 400);
  const arrayMetadata = await post({ agent_id: "agent-1", body: "hi", metadata: [] });
  assert.equal(arrayMetadata.status, 200, "an array is JSON-encodable metadata");
  assert.deepEqual(((await arrayMetadata.json()) as { message: StoredMessage }).message.metadata, []);
  assert.equal((await post({ agent_id: "agent-1", body: "hi", metadata: { blob: "m".repeat(8001) } })).status, 400);

  const writesBefore = kv.entries.length;
  const created = await post({ agent_id: "  agent-1  ", body: "  hello  ", channel: " general ", kind: " note ", metadata: { run: 1 } });
  assert.equal(created.status, 200);
  const createdBody = (await created.json()) as { message: StoredMessage };
  assert.equal(createdBody.message.agent_id, "agent-1", "the agent id is trimmed");
  assert.equal(createdBody.message.channel, "general");
  assert.equal(createdBody.message.kind, "note");
  assert.equal(createdBody.message.body, "  hello  ", "the body keeps its own whitespace");
  assert.deepEqual(createdBody.message.metadata, { run: 1 });
  assert.equal(createdBody.message.owner, "acme");
  assert.equal(kv.entries.length, writesBefore + 1, "exactly one message is written per accepted post");
});

test("agent message listing filters, bounds and cursor-walks the scan", async () => {
  const kv = new MessageKv();
  const list = (query: string, deps: Parameters<typeof handleAgentMessagesList>[1] = {}) =>
    handleAgentMessagesList(new Request(`https://ai.ubq.fi/agent/messages${query}`), { authenticateClient: githubAuth(), kv, ...deps });

  const rejected = await handleAgentMessagesList(new Request("https://ai.ubq.fi/agent/messages"), { authenticateClient: rejectedAuth });
  assert.equal(rejected.status, 401);
  const wrongMethod = await handleAgentMessagesList(new Request("https://ai.ubq.fi/agent/messages"), { authenticateClient: apiKeyAuth });
  assert.equal(wrongMethod.status, 403);
  const withoutKv = await handleAgentMessagesList(new Request("https://ai.ubq.fi/agent/messages"), { authenticateClient: githubAuth(), kv: null });
  assert.equal(withoutKv.status, 503);

  kv.entries.push(
    { key: ["agent_messages", "acme", "demo", "state-1", 1, "a"], value: message({ id: "a", created_at_ms: 1_000, channel: "general" }), versionstamp: "1" },
    {
      key: ["agent_messages", "acme", "demo", "state-1", 2, "b"],
      value: message({ id: "b", created_at_ms: 2_000, agent_id: "agent-2", channel: "general" }),
      versionstamp: "1",
    },
    { key: ["agent_messages", "acme", "demo", "state-1", 3, "c"], value: message({ id: "c", created_at_ms: 3_000 }), versionstamp: "1" }
  );

  const all = await list("");
  assert.equal(all.status, 200);
  const allBody = (await all.json()) as { messages: StoredMessage[]; next_since: number | null; next_cursor: string | null; has_more: boolean };
  assert.deepEqual(
    allBody.messages.map((entry) => entry.id),
    ["a", "b", "c"]
  );
  assert.equal(allBody.next_since, 3_000);
  assert.equal(allBody.has_more, false);
  assert.equal(allBody.next_cursor, null);
  assert.deepEqual(kv.selectors[0], { prefix: ["agent_messages", "acme", "demo", "state-1"] });
  assert.equal(kv.options[0].limit, 50, "an unfiltered scan asks for the requested page only");

  const filtered = await list("?channel=general&limit=2");
  const filteredBody = (await filtered.json()) as { messages: StoredMessage[] };
  assert.deepEqual(
    filteredBody.messages.map((entry) => entry.id),
    ["a", "b"],
    "the channel filter drops non-matching entries"
  );
  assert.equal(kv.options[1].limit, 4, "a filtered scan over-fetches");
  const agentFiltered = await list("?agent_id=agent-2");
  assert.deepEqual(
    ((await agentFiltered.json()) as { messages: StoredMessage[] }).messages.map((entry) => entry.id),
    ["b"]
  );
  const sinceFiltered = await list("?since=2000");
  assert.deepEqual(
    ((await sinceFiltered.json()) as { messages: StoredMessage[] }).messages.map((entry) => entry.id),
    ["b", "c"],
    "the since filter keeps messages at or after its instant"
  );

  const clamped = await list("?limit=0");
  assert.equal(((await clamped.json()) as { messages: StoredMessage[] }).messages.length, 3, "a non-positive limit falls back to the default page");
  assert.equal(kv.options.at(-1)?.limit, 50, "a non-positive limit falls back to the default");
  const huge = await list("?limit=100000");
  assert.equal(((await huge.json()) as { messages: StoredMessage[] }).messages.length, 3, "the capped limit still returns the available page");
  assert.equal(kv.options.at(-1)?.limit, 200, "the limit is capped");
  const unusable = await list("?since=not-a-number");
  assert.equal((await unusable.json()) instanceof Object, true);

  kv.cursor = "cursor-token";
  const walked = await list("?cursor=%20cursor-token%20");
  const walkedBody = (await walked.json()) as { next_cursor: string | null; has_more: boolean };
  const lastOptions = kv.options.at(-1);
  assert.ok(lastOptions);
  assert.equal(lastOptions.cursor, "cursor-token", "the cursor is trimmed and passed through");
  assert.equal(walkedBody.next_cursor, "cursor-token");
  assert.equal(walkedBody.has_more, true);
});

/* ------------------------------------------------------ openai telemetry */

const telemetryContext = (overrides: Partial<UsageContext> = {}): { context: UsageContext; state: ResponseTelemetryState } => {
  const state = createResponseTelemetryState();
  return {
    context: {
      keyId: "key-1",
      kernelRepo: null,
      kernelOrg: null,
      responseTelemetry: state,
      startedAtMonotonicMs: performance.now(),
      ...overrides,
    },
    state,
  };
};

test("prompt cache modes and breakpoints follow the request shape", () => {
  assert.equal(promptCacheModeFor({ prompt_cache_options: { mode: "explicit" } }), "explicit");
  assert.equal(promptCacheModeFor({ prompt_cache_options: { ttl: "1h" } }), "implicit", "options without a mode are implicit");
  assert.equal(promptCacheModeFor({ prompt_cache_options: [] }), "unspecified", "an array is not a usable options object");
  assert.equal(promptCacheModeFor({ prompt_cache_options: "explicit" }), "unspecified");
  assert.equal(promptCacheModeFor({}), "unspecified");
  assert.equal(promptCacheModeFor({ prompt_cache_retention: null }), "legacy_retention", "an explicitly present legacy retention counts");

  assert.equal(promptCacheKeyPresent({ prompt_cache_key: "  cache-key  " }), true);
  assert.equal(promptCacheKeyPresent({ prompt_cache_key: "   " }), false);
  assert.equal(promptCacheKeyPresent({ prompt_cache_key: 7 }), false);
  assert.equal(promptCacheKeyPresent({}), false);

  assert.equal(
    countExplicitPromptCacheBreakpoints([
      { type: "message", content: [{ prompt_cache_breakpoint: { mode: "explicit" } }, { prompt_cache_breakpoint: { mode: "implicit" } }] },
      { type: "message", content: "not-an-array" },
      { type: "function_call_output", output: [{ prompt_cache_breakpoint: { mode: "explicit" } }] },
    ]),
    2,
    "only explicit breakpoints in recognized content shapes are counted"
  );
  assert.equal(countExplicitPromptCacheBreakpoints([]), 0);
});

test("chat usage extraction preserves partial measurements and rejects malformed token counts", () => {
  assert.deepEqual(extractChatUsageTokens({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })?.inputTokens, 10);
  assert.equal(extractChatUsageTokens(null), null);
  assert.equal(extractChatUsageTokens([]), null);
  const partial = extractChatUsageTokens({ prompt_tokens: 10, completion_tokens: 5 });
  assert.ok(partial);
  assert.equal(partial.inputTokens, 10);
  assert.equal(partial.totalTokens, null, "a missing total remains unknown without discarding measured counters");
  assert.equal(partial.status, "partial");
  for (const promptTokens of [-1, 1.5]) {
    const invalid = extractChatUsageTokens({ prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: 6 });
    assert.ok(invalid);
    assert.equal(invalid.inputTokens, null, "malformed counts must not be rounded into a token measurement");
    assert.equal(invalid.status, "invalid");
  }
  const cached = extractChatUsageTokens({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 4 },
  });
  assert.equal(cached?.cachedInputTokens, 4, "cached prompt tokens are carried through");
  const unusableDetails = extractChatUsageTokens({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: [4] });
  assert.equal(unusableDetails?.cachedInputTokens ?? null, null, "an array is not a usable details object");
});

test("terminal usage and stream terminal telemetry land on the response state", () => {
  const { context, state } = telemetryContext();
  recordTerminalUsage(
    context,
    { inputTokens: 3, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: 2, totalTokens: 5, status: "reported" },
    true
  );
  assert.equal(state.inputTokens, 3);
  assert.equal(state.completed, true);
  assert.equal(state.usageTelemetryStatus, "reported");

  recordTerminalUsage(context, null, false);
  assert.equal(state.usageObserved, false, "a missing usage observation is recorded as such");
  assert.equal(state.usageTelemetryStatus, "missing");
  recordTerminalUsage(undefined, null, false);

  let callback: { usage: unknown; completed: boolean } | null = null;
  const observed = telemetryContext({
    onTerminalUsage: (usage, completed) => {
      callback = { usage, completed };
    },
  });
  recordTerminalUsage(observed.context, null, true);
  assert.deepEqual(callback, { usage: null, completed: true }, "the terminal usage callback observes the outcome");
  const throwing = telemetryContext({
    onTerminalUsage: () => {
      throw new Error("observer failed");
    },
  });
  assert.doesNotThrow(() => {
    recordTerminalUsage(throwing.context, null, true);
  }, "an observer failure never changes response delivery");

  recordStreamTerminalType(context, "error");
  assert.equal(state.streamTerminalType, "error");
  recordStreamTerminalType(undefined, "error");
  const completedStream = telemetryContext();
  completedStream.state.firstSemanticCommitmentMs = 12;
  recordStreamTerminalType(completedStream.context, "error");
  assert.equal(completedStream.state.streamTerminalType, "error");
});

test("provider dispatch and removed-provider telemetry are recorded only when a context exists", () => {
  const { context, state } = telemetryContext();
  recordFirstCodexDispatch(context);
  recordFirstCodexHeaders(context);
  assert.equal(typeof state.firstCodexDispatchMs, "number");
  assert.equal(typeof state.firstCodexHeadersMs, "number");
  const again = state.firstCodexDispatchMs;
  recordFirstCodexDispatch(context);
  assert.equal(state.firstCodexDispatchMs, again, "a timing is recorded once");
  recordFirstCodexDispatch(telemetryContext({ startedAtMonotonicMs: Number.NaN }).context);
  recordFirstCodexDispatch(undefined);

  recordAttemptedProvider(context, "cerebras");
  recordAttemptedProvider(context, "cerebras");
  assert.deepEqual(state.attemptedProviders, ["cerebras"], "an attempt is recorded once");
  recordAttemptedProvider(undefined, "cerebras");

  selectRemovedProviderTelemetry(context);
  assert.equal(state.provider, "removed_provider");
  assert.equal(state.accountSlot, null);
  selectRemovedProviderTelemetry(undefined);

  recordRemovedProviderFields(context, { triggerClass: "quota", circuitTransition: null, selectedModel: "gpt-6", taskType: undefined });
  assert.equal(state.removedProviderTriggerClass, "quota");
  assert.equal(state.removedProviderCircuitTransition, null);
  assert.equal(state.removedProviderSelectedModel, "gpt-6");
  assert.equal(state.removedProviderTaskType, null, "an absent field is left untouched");
  recordRemovedProviderFields(undefined, { triggerClass: "quota" });

  assert.equal(supportsReasoningProgressRelease("chatgpt_codex"), true);
  assert.equal(supportsReasoningProgressRelease("lithos"), false);
});

test("stream failure classification prefers the timeout, then cancellation, then the stream error kind", () => {
  const live = new AbortController();
  const downstream = new AbortController();
  assert.equal(classifyStreamFailure(new CodexError("timeout", "gateway_timeout", 504), live.signal, downstream.signal), "deadline");
  assert.equal(classifyStreamFailure(new Error("deadline"), live.signal, downstream.signal), "error");
  assert.equal(isTimeoutFailure(new Error("plain")), false);
  const timeoutError = new Error("timed out");
  timeoutError.name = "TimeoutError";
  assert.equal(isTimeoutFailure(timeoutError), true);

  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(classifyStreamFailure(new Error("aborted"), live.signal, cancelled.signal), "cancelled");
  assert.equal(classifyPreHeaderFailure(new Error("aborted"), live.signal, cancelled.signal), "cancelled");

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(classifyStreamFailure(new Error("aborted"), aborted.signal, downstream.signal), "deadline");
  assert.equal(classifyPreHeaderFailure(new Error("aborted"), aborted.signal, downstream.signal), "deadline");
  assert.equal(classifyStreamFailure(new ResponsesStreamError("inactive", { kind: "inactivity_timeout" }), live.signal, downstream.signal), "deadline");
  assert.equal(classifyStreamFailure(new ResponsesStreamError("eof", { kind: "premature_eof" }), live.signal, downstream.signal), "eof");
  assert.equal(classifyStreamFailure(new ResponsesStreamError("drift", { kind: "malformed_event" }), live.signal, downstream.signal), "error");
  assert.equal(classifyStreamFailure("not an error", live.signal, downstream.signal), "error");
  assert.equal(classifyPreHeaderFailure(new ResponsesStreamError("drift", { kind: "malformed_event" }), live.signal, downstream.signal), "error");
});

test("event and failure telemetry recognise the bounded event kinds", () => {
  const { context, state } = telemetryContext();
  const event = (type: string, value: Record<string, unknown> = {}) => ({ raw: `event: ${type}`, type, terminal: false, value });
  recordResponsesEventTelemetry(context, event("response.created"));
  assert.equal(state.responseCreatedObserved, true);
  recordResponsesEventTelemetry(context, event("response.output_text.delta"));
  recordResponsesEventTelemetry(context, event("response.output_text.delta"));
  assert.deepEqual(state.upstreamEventKinds, ["response.created", "response.output_text.delta"], "each kind is recorded once");
  recordResponsesEventTelemetry(context, event("some.unknown.event"));
  assert.equal(state.upstreamEventKinds.includes("unrecognized"), true, "an unrecognized kind is bounded");

  recordResponsesEventTelemetry(context, event("response.incomplete", { response: { incomplete_details: { reason: "provider_overloaded" } } }));
  assert.equal(state.failureKind, "response_incomplete:provider_overloaded");
  recordResponsesEventTelemetry(context, event("response.incomplete", { response: { incomplete_details: { reason: "cosmetic" } } }));
  assert.equal(state.failureKind, "response_incomplete:provider_overloaded", "an unrecognized reason leaves the failure kind alone");
  recordResponsesEventTelemetry(context, event("response.incomplete", { response: {} }));
  recordResponsesEventTelemetry(context, event("response.incomplete", { response: { incomplete_details: {} } }));
  recordResponsesEventTelemetry(undefined, event("response.created"));
  recordResponsesFailureTelemetry(undefined, new Error("no context"));
  recordResponsesFailureTelemetry(context, new ResponsesStreamError("eof", { kind: "premature_eof" }));
  assert.equal(state.failureKind, "premature_eof");
  recordResponsesFailureTelemetry(context, new ResponsesStreamError("drift", { kind: "malformed_event" }), {
    failureKind: "premature_eof",
    responseCreatedObserved: true,
    semanticCommitmentObserved: false,
    syntheticTerminalType: "error",
    upstreamTerminal: null,
  });
  assert.equal(state.failureKind, "premature_eof", "explicit failure details win over the error's own kind");
  assert.equal(state.syntheticTerminalType, "error");
});

test("aggregating source telemetry reports a shared provider, mixed providers and missing data", () => {
  const source = (provider: string, overrides: Partial<ReturnType<typeof createResponseTelemetryState>> = {}) => {
    const response = new Response("source");
    attachResponseTelemetry(response, { ...createResponseTelemetryState(), provider, ...overrides });
    return response;
  };
  const target = new Response("target");

  attachResponseTelemetry(target, { ...createResponseTelemetryState(), provider: "cerebras" });
  const single = aggregateResponseTelemetry([target], target);
  assert.equal(getResponseTelemetry(single)?.provider, "cerebras");

  const mixed = aggregateResponseTelemetry([source("cerebras"), source("lithos")], new Response("target"));
  assert.equal(getResponseTelemetry(mixed)?.provider, "mixed", "different providers aggregate as mixed");
  const none = aggregateResponseTelemetry([new Response("unregistered")], new Response("target"));
  assert.equal(getResponseTelemetry(none)?.provider ?? null, null, "an unregistered source contributes nothing");

  const unreported = aggregateResponseTelemetry([source("cerebras")], new Response("target"));
  assert.equal(getResponseTelemetry(unreported)?.usageTelemetryStatus, "missing", "a source that never reported usage is missing, not reported");
  const partial = aggregateResponseTelemetry([source("cerebras", { usageTelemetryStatus: "reported" }), source("cerebras")], new Response("target"));
  assert.equal(getResponseTelemetry(partial)?.usageTelemetryStatus, "missing", "an incomplete usable set is not reported");
  const invalid = aggregateResponseTelemetry(
    [source("cerebras", { usageTelemetryStatus: "invalid" }), source("cerebras", { usageTelemetryStatus: "reported" })],
    new Response("target")
  );
  assert.equal(getResponseTelemetry(invalid)?.usageTelemetryStatus, "invalid", "one invalid member poisons the aggregate");
  const reported = aggregateResponseTelemetry(
    [source("cerebras", { usageTelemetryStatus: "reported" }), source("cerebras", { usageTelemetryStatus: "reported" })],
    new Response("target")
  );
  assert.equal(getResponseTelemetry(reported)?.usageTelemetryStatus, "reported");

  const quotas = aggregateResponseTelemetry(
    [source("cerebras", { quotaUsedPercent: 20 }), source("cerebras", { quotaUsedPercent: 55 })],
    new Response("target")
  );
  assert.equal(getResponseTelemetry(quotas)?.quotaUsedPercent, 55, "the highest reported usage percent wins");
  const unknownQuota = aggregateResponseTelemetry([source("cerebras", { quotaUsedPercent: null })], new Response("target"));
  assert.equal(getResponseTelemetry(unknownQuota)?.quotaUsedPercent, null);
  const absentQuota = aggregateResponseTelemetry([source("cerebras")], new Response("target"));
  assert.equal(getResponseTelemetry(absentQuota)?.quotaUsedPercent ?? undefined, undefined);

  const semantic = aggregateResponseTelemetry([source("cerebras", { semanticOutputObserved: true }), source("cerebras")], new Response("target"));
  assert.equal(getResponseTelemetry(semantic)?.semanticOutputObserved, true);
  const allFalse = aggregateResponseTelemetry(
    [source("cerebras", { semanticOutputObserved: false }), source("cerebras", { semanticOutputObserved: false })],
    new Response("target")
  );
  assert.equal(getResponseTelemetry(allFalse)?.semanticOutputObserved, false);
  const unknownSemantic = aggregateResponseTelemetry(
    [source("cerebras", { semanticOutputObserved: false }), source("cerebras", { semanticOutputObserved: null })],
    new Response("target")
  );
  assert.equal(getResponseTelemetry(unknownSemantic)?.semanticOutputObserved, null);
});

test("stream error responses merge warnings, name the upstream and keep the auth warning explicit", async () => {
  const plain = streamErrorResponse(502, "upstream failed", "upstream_error", "cerebras", []);
  assert.equal(plain.status, 502);
  assert.equal(plain.headers.get("x-uos-upstream"), "cerebras");
  assert.equal(plain.headers.get("x-uos-warning"), null, "a warning-free failure carries no warning header");

  const warned = streamErrorResponse(429, "quota", "rate_limit_exceeded", "lithos", ["a", "a", "b"], "rate_limit_error", null);
  assert.equal(warned.headers.get("x-uos-warning"), "a, b", "warning headers are deduplicated");
  const warnedBody = (await warned.json()) as { error: { type?: string; param?: string | null } };
  assert.equal(warnedBody.error.type, "rate_limit_error");
  assert.equal(warnedBody.error.param, null);

  const authWarned = streamErrorResponse(502, "refresh failed", "codex_auth_refresh_failed", "chatgpt_codex", [CODEX_AUTH_REAUTH_WARNING]);
  const authBody = (await authWarned.json()) as { error: { message: string } };
  assert.match(authBody.error.message, /re-authentication/, "the auth warning appends its re-authentication message");
  assert.equal(authWarned.headers.get("x-uos-warning"), CODEX_AUTH_REAUTH_WARNING);

  const noOptions = streamErrorResponse(503, "unavailable", "server_error", "metered", []);
  assert.equal(noOptions.status, 503);
  assert.equal(noOptions.headers.get("x-uos-warning"), null);
});
