import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isResponsesCompaction, parseCodexInput, parseTurnMetadata } from "../lib/jev_compaction/codex_items.ts";
import { compact } from "../lib/jev_compaction/compact.ts";
import { collectToolCalls } from "../lib/jev_compaction/state.ts";
import type { JevAsker, ToolResult, ToolUse } from "../lib/jev_compaction/types.ts";
import { deepSeekUpstreamModelFor } from "../src/deepseek/index.ts";
import * as kv from "../src/kv.ts";
import { isProviderEnabled, normalizeProviderSelection, normalizeSelectedProviderIds, type ProviderSelection } from "../src/provider/selection.ts";
import { object, type MatrixContext } from "../tools/cloudflare/runtime-matrix/contracts.ts";

type Fault = "admission-provider" | "dispatch-provider" | "extra-admission" | "extra-dispatch" | "jev";
type Observation = { marker: string; metadata: string | null; body: string; id: string };
type ReplayModule = typeof import("../tools/cloudflare/runtime-matrix/context-replay.ts");

function spyFetch(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, {
      preconnect: () => {
        throw new Error("network preconnection is forbidden");
      },
    })
  );
}

async function sourceModule(): Promise<ReplayModule> {
  const fetcher = spyFetch(() => {
    throw new Error("importing the existing source waterfall constant must not open network");
  });
  try {
    const module = await import("../tools/cloudflare/runtime-matrix/context-replay.ts");
    assert.equal(fetcher.mock.calls.length, 0);
    return module;
  } finally {
    fetcher.mockRestore();
  }
}

async function exercise(run: ReplayModule["compactionHeaderControls"], fault?: Fault): Promise<{ context: MatrixContext; observed: Observation[] }> {
  const observed: Observation[] = [];
  const unused = () => {
    throw new Error("compaction header regression must not use database, provider or unrelated capabilities");
  };
  const context: MatrixContext = {
    url: (path) => `http://compaction-header.test${path}`,
    post: unused,
    rpc: unused,
    read: unused,
    lifecycle: (id) => {
      assert(observed.some((request) => request.id === id));
      const attempt = { provider: fault === "admission-provider" ? "lithos" : "deepseek", transport_started: true };
      return Promise.resolve({ attempts: fault === "extra-admission" ? [attempt, attempt] : [attempt], terminal_intent: { delivery: "unknown" } });
    },
    events: () =>
      Promise.resolve(
        observed.flatMap(({ marker }) => {
          const dispatch = { kind: "matrix_dispatch", marker, provider: fault === "dispatch-provider" ? "lithos" : "deepseek" };
          return [dispatch, ...(fault === "extra-dispatch" ? [dispatch] : []), ...(fault === "jev" ? [{ kind: "matrix_compaction_jev", marker }] : [])];
        })
      ),
    cases: [],
  };
  const fetcher = spyFetch(async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, context.url("/v1/responses"));
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), "Bearer fixture-access");
    const body = await request.text();
    const parsed = object(JSON.parse(body));
    assert(typeof parsed.model === "string");
    assert.equal(parsed.model, "deepseek-flash", "the original explicit model must not be switched to a synthetic or Lithos model");
    assert.equal(deepSeekUpstreamModelFor(parsed.model), "deepseek-flash", "the original Bun official-model resolver owns this request");
    assert.equal(parsed.stream, false);
    assert.deepEqual(parsed.reasoning, { effort: "low" });
    assert.equal(parsed.max_output_tokens, 128);
    assert(Array.isArray(parsed.input) && parsed.input.length === 13);
    assert(body.includes("CONTEXT CHECKPOINT COMPACTION"), "compaction-looking prompt text must not enable the header predicate");
    const metadata = request.headers.get("x-codex-turn-metadata");
    assert.equal(
      isResponsesCompaction(parseTurnMetadata(metadata)),
      false,
      "the actual original source predicate must leave this header on the ordinary route"
    );
    const marker = `fixture:matrix:compaction:ordinary-${String(observed.length)}`;
    assert(body.includes(marker));
    const id = `source-compaction-header-${String(observed.length)}`;
    observed.push({ marker, metadata, body, id });
    return Response.json({ status: "completed" }, { headers: { "x-uos-request-id": id } });
  });
  try {
    await run(context);
    return { context, observed };
  } finally {
    fetcher.mockRestore();
  }
}

test("compaction header controls follow the original source model and predicate while refusing weakened admission, dispatch or Jev evidence", async () => {
  const opener = spyOn(kv, "getKv").mockImplementation(() => {
    throw new Error("real KV access is forbidden");
  });
  try {
    const { compactionHeaderControls } = await sourceModule();
    assert.equal(isResponsesCompaction(parseTurnMetadata(JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses" } }))), true);
    const { context, observed } = await exercise(compactionHeaderControls);
    assert.equal(observed.length, 4);
    assert.deepEqual(
      observed.map(({ metadata }) => metadata),
      [
        null,
        "{not json",
        JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses_compaction_v2" } }),
        JSON.stringify({ request_kind: "turn", compaction: { implementation: "responses" } }),
      ]
    );
    const first = observed[0];
    assert(first);
    for (const request of observed) {
      assert.equal(request.body.replaceAll(request.marker, first.marker), first.body, "all four controls must retain the same original request body");
    }
    assert.deepEqual(context.cases, ["matrix_compaction_header_absent_malformed_wrong_implementation_and_ordinary_turn_do_not_invoke_jev"]);
    for (const fault of ["admission-provider", "dispatch-provider", "extra-admission", "extra-dispatch", "jev"] as const) {
      await assert.rejects(exercise(compactionHeaderControls, fault), assert.AssertionError, `the unchanged strict assertions must reject ${fault}`);
    }
    assert.equal(opener.mock.calls.length, 0);
  } finally {
    opener.mockRestore();
  }
});

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

async function originalQuestions(body: Record<string, unknown>, mode: "failure" | "partial"): Promise<string[]> {
  const { COMPACTION_OPTIONS } = await import("../src/jev_compaction/compaction.ts");
  const original = JSON.stringify(body.input);
  const transcript = parseCodexInput(body.input);
  assert(transcript);
  assert.equal(transcript.messages.length, 12);
  const calls = collectToolCalls(transcript.messages, COMPACTION_OPTIONS.preserveRecentMessages);
  assert.deepEqual(
    calls.map((call) => ({
      id: call.id,
      callId: call.tool_use_id,
      tool: call.tool,
      input: call.input,
      callIndex: call.callIndex,
      resultIndex: call.resultIndex,
      pinned: call.pinned,
    })),
    [
      { id: "t1", callId: "old_a", tool: "shell", input: { command: "read old evidence" }, callIndex: 2, resultIndex: 3, pinned: false },
      { id: "t2", callId: "old_b", tool: "shell", input: { command: "read more old evidence" }, callIndex: 4, resultIndex: 5, pinned: false },
    ]
  );
  for (const call of calls) {
    const tool: ToolUse | undefined = transcript.messages.at(call.callIndex)?.toolUses.at(0);
    const result: ToolResult | undefined = transcript.messages.at(call.resultIndex)?.toolResults?.at(0);
    assert(tool && result);
    assert.equal(tool.tool_use_id, call.tool_use_id);
    assert.equal(result.tool_use_id, call.tool_use_id);
    assert.equal(result.text.length, 4900);
    assert.equal(digest(result.text), "4103c9be01eb1089fdeb25375b6d644663e32e228b5ee1593e6a49399667d22d");
  }
  const batches: string[][] = [];
  const asker: JevAsker = {
    ask: (_state, questions) => {
      const names = Object.keys(questions);
      batches.push(names);
      if (mode === "failure") return Promise.reject(new Error("controlled original-source decision failure"));
      return Promise.resolve({ answers: Object.fromEntries(names.slice(1).map((name) => [name, { noul: 0.1 }])) });
    },
  };
  await assert.rejects(compact(transcript.messages, asker, COMPACTION_OPTIONS), Error);
  assert.deepEqual(batches, [["call_t1", "result_t1", "call_t2", "result_t2"]]);
  assert.equal(JSON.stringify(body.input), original, "original parsing and compaction must preserve the exact request input");
  const names = batches[0];
  assert(names);
  return [...names];
}

function observedMessages(input: unknown): Record<string, unknown>[] {
  assert(Array.isArray(input));
  return input.flatMap<Record<string, unknown>>((value: unknown) => {
    const item = object(value);
    if (item.type === "function_call_output") {
      assert(typeof item.output === "string");
      return [{ role: "tool", tool_call_id: item.call_id, sha256: digest(item.output) }];
    }
    if (item.type !== "message") return [];
    assert(Array.isArray(item.content));
    return [{ role: item.role, sha256: digest(item.content.map((part: unknown) => String(object(part).text)).join("")) }];
  });
}

function completedStream(id: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of [
        { type: "response.output_text.delta", delta: "matrix " },
        { type: "response.completed", response: { status: "completed" } },
      ])
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "x-uos-request-id": id } });
}

async function exerciseSetup(changeQuestions?: (names: string[]) => void): Promise<void> {
  const opener = spyOn(kv, "getKv").mockImplementation(() => {
    throw new Error("real KV access is forbidden");
  });
  const { compactionFallbackCases } = await sourceModule();
  const source = await import("../src/deepseek/waterfall.ts");
  const selections: string[][] = [];
  const requests: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const states = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, string>();
  const blocked: unknown[] = [];
  let selection: ProviderSelection | null = null;
  const unused = () => {
    throw new Error("setup regression must not open unrelated capabilities");
  };
  const context: MatrixContext = {
    url: (path) => `http://compaction-setup.test${path}`,
    post: (path, value, token) => {
      const body = object(value);
      if (path === "/admin/providers/selection") {
        selection = normalizeProviderSelection({ ...body, updated_at_ms: 1 });
        assert(selection);
        selections.push([...selection.provider_ids]);
        return Promise.resolve(Response.json({ stored: true, provider_ids: selection.provider_ids }));
      }
      if (path === "/admin/api-keys") {
        const id = `setup-key-${String(keys.size)}`;
        const credential = `fixture-${id}`;
        keys.set(credential, id);
        return Promise.resolve(Response.json({ token: credential, id }));
      }
      assert.equal(path, "/v1/responses");
      assert(token && keys.has(token));
      blocked.push(body);
      return Promise.resolve(Response.json({ error: { code: "fixture_quota" } }, { status: 429 }));
    },
    rpc: unused,
    read: unused,
    lifecycle: (id) => {
      const state = states.get(id);
      assert(state);
      return Promise.resolve(state);
    },
    events: () => Promise.resolve(events),
    cases: [],
  };
  const fetcher = spyFetch(async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, context.url("/v1/responses"));
    const body = object(await request.json());
    assert(typeof body.model === "string");
    const serialized = JSON.stringify(body);
    const marker = /fixture:matrix:compaction:[a-z0-9_-]+/u.exec(serialized)?.[0];
    assert(marker);
    const eligible = isResponsesCompaction(parseTurnMetadata(request.headers.get("x-codex-turn-metadata")));
    const id = `setup-request-${String(requests.length)}`;
    requests.push(body);
    const hopCount = marker.endsWith(":failure") ? 2 : 1;
    const providers = eligible
      ? source
          .deepSeekWaterfallPlan({
            enabled: () => isProviderEnabled("ubiquity", selection),
            configured: (provider) => ["lithos", "deepseek", "openrouter"].includes(provider),
          })
          .slice(0, hopCount)
      : ["deepseek"];
    if (eligible) {
      assert.equal(body.model, source.DEEPSEEK_WATERFALL_MODEL_ID);
      assert(source.isDeepSeekWaterfallModel(body.model));
      assert.equal(isProviderEnabled("ubiquity", selection), true);
      assert.equal(providers[0], "lithos", "the actual source plan must reach the existing Lithos fixture rung");
      assert.equal(source.isDeepSeekWaterfallRetryStatus(429), true);
      const questions = await originalQuestions(body, marker.endsWith(":failure") ? "failure" : "partial");
      changeQuestions?.(questions);
      events.push({ kind: "matrix_compaction_jev", marker, model: "~typesafe/jev-latest", questions });
    } else {
      assert.equal(body.model, "deepseek-flash");
      assert.equal(body.stream, false);
      assert.equal(isProviderEnabled("ubiquity", selection), false);
      assert.equal(deepSeekUpstreamModelFor(body.model), "deepseek-flash");
    }
    for (const provider of providers) events.push({ kind: "matrix_dispatch", marker, provider, compaction_messages: observedMessages(body.input) });
    const credential = request.headers.get("authorization")?.replace(/^Bearer /u, "");
    states.set(id, {
      context: { request_id: id },
      api: { request_id: id, key_id: credential ? keys.get(credential) : null },
      attempts: providers.map((provider) => ({ provider, transport_started: true })),
      terminal_intent: { delivery: "unknown" },
    });
    return eligible ? completedStream(id) : Response.json({ status: "completed" }, { headers: { "x-uos-request-id": id } });
  });
  try {
    await compactionFallbackCases(context);
    const original = normalizeSelectedProviderIds(["lithos", "deepseek", "openrouter"]);
    assert.deepEqual(selections, [original, [...original, "ubiquity"], original]);
    assert.equal(requests.length, 6);
    assert.deepEqual(
      requests.map((request) => request.model),
      ["deepseek-flash", "deepseek-flash", "deepseek-flash", "deepseek-flash", source.DEEPSEEK_WATERFALL_MODEL_ID, source.DEEPSEEK_WATERFALL_MODEL_ID]
    );
    assert.deepEqual(
      blocked,
      ["failure", "partial"].map((mode) => ({ model: "deepseek-flash", input: `fixture:matrix:compaction:quota-${mode}`, stream: false }))
    );
    assert.equal(context.cases.length, 3, "the existing header and both unchanged fallback assertion groups must complete");
    assert.equal(opener.mock.calls.length, 0);
  } finally {
    fetcher.mockRestore();
    opener.mockRestore();
  }
}

test("fallback setup retains exact original-source question pairs, waterfall, selection and request bytes", async () => {
  await exerciseSetup();
});

test("exact source question names reject zero-based, missing, extra, swapped and regrouped pairs", async () => {
  const faults: { name: string; change: (names: string[]) => void }[] = [
    {
      name: "zero-based ID",
      change: (names) => {
        names[0] = "call_t0";
      },
    },
    {
      name: "missing question",
      change: (names) => {
        names.pop();
      },
    },
    {
      name: "extra question",
      change: (names) => {
        names.push("call_t3");
      },
    },
    {
      name: "swapped call/result",
      change: (names) => {
        names.splice(0, 2, ...names.slice(0, 2).reverse());
      },
    },
    {
      name: "swapped tool pairs",
      change: (names) => {
        names.push(...names.splice(0, 2));
      },
    },
    {
      name: "regrouped names",
      change: (names) => {
        names.splice(0, 4, "call_t1", "call_t2", "result_t1", "result_t2");
      },
    },
  ];
  for (const fault of faults) await assert.rejects(exerciseSetup(fault.change), assert.AssertionError, fault.name);
});
