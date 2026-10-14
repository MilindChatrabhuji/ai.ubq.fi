import { test } from "bun:test";
import assert from "node:assert/strict";

import { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest, setOpenRouterModelsFetchForTest } from "../src/models/openrouter-models.ts";
import { handleOpenRouterChatCompletions, handleOpenRouterResponses } from "../src/provider/openrouter-handlers.ts";

type Wire = "chat" | "responses";

const PRO_MODEL = "openai/gpt-6-astra-pro";
const DEFAULT_TOOLS = [{ type: "openrouter:web_search" }, { type: "openrouter:web_fetch" }];
const MODEL_IDS = [PRO_MODEL, "openai/gpt-4o", `${PRO_MODEL}:batch`, "~openai/gpt-6.1-sol-pro", "vendor/alpha", "openaiish/model"];

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const withServedCatalogue = async (run: () => Promise<void>): Promise<void> => {
  resetOpenRouterModelsCacheForTest();
  setOpenRouterModelsFetchForTest(() => Promise.resolve(jsonResponse({ data: MODEL_IDS.map((id) => ({ id })) })));
  try {
    const snapshot = await fetchOpenRouterModels();
    assert.equal(snapshot?.models.length, MODEL_IDS.length);
    await run();
  } finally {
    setOpenRouterModelsFetchForTest(null);
    resetOpenRouterModelsCacheForTest();
  }
};

const upstreamAnswer = (wire: Wire, stream: boolean): Response => {
  const usage = wire === "chat" ? { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } : { input_tokens: 3, output_tokens: 2, total_tokens: 5 };
  if (!stream) {
    return jsonResponse(
      wire === "chat"
        ? {
            id: "gen-tools",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "research ready" }, finish_reason: "stop" }],
            usage,
          }
        : {
            id: "resp_tools",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "research ready" }] }],
            usage,
          }
    );
  }
  const frames =
    wire === "chat"
      ? [
          `data: ${JSON.stringify({ id: "gen-tools", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "research ready" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: "gen-tools", object: "chat.completion.chunk", choices: [], usage })}\n\n`,
          "data: [DONE]\n\n",
        ]
      : [
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "research ready" })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_tools", usage } })}\n\n`,
        ];
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
};

/** Exercise the real request builders and capture exactly what the mocked provider receives. */
const dispatch = async (wire: Wire, model = PRO_MODEL, fields: Record<string, unknown> = {}): Promise<Readonly<Record<string, unknown>>> => {
  const raw = { model, ...(wire === "chat" ? { messages: [{ role: "user", content: "research" }] } : { input: "research" }), stream: false, ...fields };
  const original = structuredClone(raw);
  const captured: { body: Readonly<Record<string, unknown>> | null; calls: number } = { body: null, calls: 0 };
  const fetchUpstream = (body: Readonly<Record<string, unknown>>): Promise<Response> => {
    captured.calls += 1;
    captured.body = body;
    return Promise.resolve(upstreamAnswer(wire, raw.stream));
  };
  const path = wire === "chat" ? "/v1/chat/completions" : "/v1/responses";
  const handle = wire === "chat" ? handleOpenRouterChatCompletions : handleOpenRouterResponses;
  const response = await handle(new Request(`https://ai.ubq.fi${path}`, { method: "POST" }), raw, model, undefined, {
    fetchChat: fetchUpstream,
    fetchResponses: fetchUpstream,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-uos-upstream"), "openrouter");
  assert.match(await response.text(), /research ready/);
  assert.equal(captured.calls, 1);
  assert.ok(captured.body);
  assert.equal(captured.body.model, model);
  assert.deepEqual(raw, original, "building an upstream request must not change the caller's body or nested tools");
  return captured.body;
};

const functionTool = (wire: Wire) => {
  const definition = { name: "lookup_record", description: "Look up a private record", parameters: { type: "object", properties: {} } };
  return wire === "chat" ? { type: "function", function: definition } : { type: "function", ...definition };
};

test("OpenRouter dispatch gives current and older OpenAI models web tools on both wires and stream modes", async () => {
  await withServedCatalogue(async () => {
    for (const wire of ["chat", "responses"] as const) {
      for (const model of [PRO_MODEL, "openai/gpt-4o", "~openai/gpt-6.1-sol-pro"]) {
        for (const stream of [false, true]) {
          const controls =
            wire === "chat" ? { reasoning_effort: "xhigh", max_completion_tokens: 4_096 } : { reasoning: { effort: "xhigh" }, max_output_tokens: 4_096 };
          const body = await dispatch(wire, model, { stream, ...controls });
          assert.deepEqual(body.tools, DEFAULT_TOOLS);
          assert.equal(body.stream, stream);
          assert.equal(body.tool_choice, undefined, "the model should keep choosing whether research is needed");
          for (const [key, value] of Object.entries(controls)) assert.deepEqual(body[key], value);
        }
      }
    }
  });
});

test("OpenRouter web defaults retain client function tools, schemas, and automatic tool controls", async () => {
  await withServedCatalogue(async () => {
    for (const wire of ["chat", "responses"] as const) {
      const clientTool = functionTool(wire);
      const tools = Object.freeze([Object.freeze(clientTool)]);
      const limits = wire === "responses" ? { max_tool_calls: 7 } : {};
      const body = await dispatch(wire, PRO_MODEL, { tools, tool_choice: "auto", parallel_tool_calls: false, ...limits });
      assert.deepEqual(body.tools, [clientTool, ...DEFAULT_TOOLS]);
      assert.notEqual(body.tools, tools, "appending defaults must allocate a new array");
      assert.equal((body.tools as unknown[])[0], clientTool, "the caller's tool definition remains intact");
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(body.max_tool_calls, wire === "responses" ? 7 : undefined);
    }
  });
});

test("OpenRouter retains configured server and native web tools without adding duplicate equivalents", async () => {
  await withServedCatalogue(async () => {
    const searchTypes = ["openrouter:web_search", "web_search", "web_search_preview", "web_search_2025_08_26", "web_search_preview_2025_03_11"];
    for (const wire of ["chat", "responses"] as const) {
      for (const type of searchTypes) {
        const search = { type, parameters: { engine: "exa", allowed_domains: ["example.com"], max_results: 2 } };
        const searchOnly = await dispatch(wire, PRO_MODEL, { tools: [search] });
        assert.deepEqual(searchOnly.tools, [search, { type: "openrouter:web_fetch" }]);
        assert.equal((searchOnly.tools as unknown[])[0], search);
        for (const fetchType of ["openrouter:web_fetch", "web_fetch", "web_fetch_20250910"]) {
          const fetchTool = { type: fetchType, parameters: { max_uses: 3, max_content_tokens: 500 } };
          const tools = [search, fetchTool];
          const complete = await dispatch(wire, PRO_MODEL, { tools });
          assert.equal(complete.tools, tools, "an already configured research tool set must pass through unchanged");
          assert.deepEqual(complete.tools, tools);
        }
      }
      const fetchTool = { type: "openrouter:web_fetch", parameters: { blocked_domains: ["example.com"] } };
      assert.deepEqual((await dispatch(wire, PRO_MODEL, { tools: [fetchTool] })).tools, [fetchTool, { type: "openrouter:web_search" }]);
    }
  });
});

test("OpenRouter defaults respect empty tools and disabled, required, or constrained tool choices", async () => {
  await withServedCatalogue(async () => {
    for (const wire of ["chat", "responses"] as const) {
      const empty: unknown[] = [];
      assert.equal((await dispatch(wire, PRO_MODEL, { tools: empty })).tools, empty);
      const tools = [functionTool(wire)];
      const forced = wire === "chat" ? { type: "function", function: { name: "lookup_record" } } : { type: "function", name: "lookup_record" };
      const choices = ["none", "required", forced, { type: "allowed_tools", mode: "auto", tools: [forced] }, null, "invalid-choice"];
      for (const toolChoice of choices) {
        const body = await dispatch(wire, PRO_MODEL, { tools, tool_choice: toolChoice });
        assert.equal(body.tools, tools, "defaults must not broaden an explicitly constrained tool set");
        assert.equal(body.tool_choice, toolChoice);
      }
      const requiredWithoutTools = await dispatch(wire, PRO_MODEL, { tool_choice: "required" });
      assert.equal(requiredWithoutTools.tools, undefined, "defaults must not make an invalid required-tool request valid");
    }
  });
});

test("OpenRouter defaults preserve deprecated function controls and malformed tools for upstream validation", async () => {
  await withServedCatalogue(async () => {
    for (const wire of ["chat", "responses"] as const) {
      for (const legacy of [
        { functions: [{ name: "legacy_lookup" }] },
        { functions: [] },
        { function_call: "none" },
        { function_call: { name: "legacy_lookup" } },
      ]) {
        const body = await dispatch(wire, PRO_MODEL, legacy);
        assert.equal(body.tools, undefined, "web defaults must not introduce modern tools alongside legacy functions");
        for (const [key, value] of Object.entries(legacy)) assert.equal(body[key], value);
      }
      for (const tools of [null, "not-an-array", { type: "function" }, 42]) {
        assert.equal((await dispatch(wire, PRO_MODEL, { tools })).tools, tools, "malformed tools must reach upstream unchanged");
      }
    }
  });
});

test("OpenRouter leaves batch and other vendors unchanged while retaining their explicit tools", async () => {
  await withServedCatalogue(async () => {
    for (const wire of ["chat", "responses"] as const) {
      for (const model of [`${PRO_MODEL}:batch`, "vendor/alpha", "openaiish/model"]) {
        assert.equal((await dispatch(wire, model)).tools, undefined);
        const tools = [functionTool(wire)];
        assert.equal((await dispatch(wire, model, { tools })).tools, tools);
      }
    }
  });
});
