// Cerebras rejects a replayed assistant `reasoning_content` on both wires.

import assert from "node:assert/strict";

import { getResponseTelemetry, handleChatCompletions, handleResponses, specialProviderChatRequest, withFetchMock } from "./helpers/openai-compat-harness.ts";
import { CEREBRAS_CHAT_COMPLETIONS_URL, CEREBRAS_QWEN_3_8_27B_MODEL } from "../src/provider/cerebras.ts";

/**
 * Cerebras validates every message field instead of ignoring the ones it does
 * not implement, so the `reasoning_content` the shared Responses translation
 * replays on a tool-bearing assistant turn failed the whole request before the
 * model was reached: HTTP 400 `wrong_api_format` naming
 * `messages.N.assistant.reasoning_content` (Codex session
 * 01a0fea8-58df-7d93-af95-49f80cec6a1b, 2026-10-02, model qwen-3.8-27b). The
 * two cases below capture the exact upstream JSON from the Chat Completions
 * route and from the Responses route, because both build their own body and
 * each had to stop sending the field while keeping content, tool calls and
 * message order.
 *
 * These fixtures are recorded-shaped: no test here makes a network call.
 */

const CEREBRAS_API_KEY_ENV = "CEREBRAS_API_KEY";
const CEREBRAS_API_KEY = "cerebras_reasoning_strip_key";
const QWEN = CEREBRAS_QWEN_3_8_27B_MODEL;

/** Runs `run` with the provider credential configured, restoring the ambient value after. */
const withCerebrasKey = async (run: () => Promise<void>): Promise<void> => {
  const previous = Deno.env.get(CEREBRAS_API_KEY_ENV);
  Deno.env.set(CEREBRAS_API_KEY_ENV, CEREBRAS_API_KEY);
  try {
    await run();
  } finally {
    if (previous === undefined) Deno.env.delete(CEREBRAS_API_KEY_ENV);
    else Deno.env.set(CEREBRAS_API_KEY_ENV, previous);
  }
};

type UpstreamCall = Readonly<{ url: string; body: Record<string, unknown> }>;

/** One recorded buffered Chat completion, shaped like the vendor's wire. */
const chatCompletion = (message: Record<string, unknown>, finishReason = "stop", id = "chatcmpl-cerebras-strip"): Response =>
  Response.json({
    id,
    object: "chat.completion",
    created: 1_790_100_100,
    model: QWEN,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 41, completion_tokens: 12, total_tokens: 53 },
  });

const messagesOf = (call: UpstreamCall | undefined): Record<string, unknown>[] => {
  assert.ok(call, "the transport must dispatch the upstream call");
  const messages = call.body.messages;
  assert.ok(Array.isArray(messages), "the dispatched body must carry messages");
  return messages as Record<string, unknown>[];
};

Deno.test("cerebras chat: a replayed assistant reasoning_content is absent upstream while content and the tool round trip survive", async () => {
  await withCerebrasKey(async () => {
    const calls: UpstreamCall[] = [];
    const upstreamText = JSON.stringify({ error: { message: "messages.3.assistant.reasoning_content is unsupported" } });

    const response = await withFetchMock(
      (url, bodyText) => {
        const body = typeof bodyText === "string" ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        calls.push({ url, body });
        const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
        const assistant = messages.find((message) => message.role === "assistant");
        // The provider's own contract: any assistant turn that carries the
        // field fails the whole request before the model is reached.
        if (assistant && "reasoning_content" in assistant) return new Response(upstreamText, { status: 400 });
        return chatCompletion({ role: "assistant", content: "The file has 12 lines." });
      },
      () =>
        handleChatCompletions(
          specialProviderChatRequest({
            model: QWEN,
            reasoning_effort: "none",
            stream: false,
            messages: [
              { role: "system", content: "Follow the house style." },
              { role: "user", content: "Count the lines in notes.txt." },
              {
                role: "assistant",
                content: "Let me look.",
                reasoning_content: "I should call the read tool.",
                tool_calls: [{ id: "call_read_1", type: "function", function: { name: "read_file", arguments: '{"path":"notes.txt"}' } }],
              },
              { role: "tool", tool_call_id: "call_read_1", content: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12" },
            ],
          })
        )
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as { choices?: { message?: Record<string, unknown> }[] };
    assert.equal(payload.choices?.[0]?.message?.content, "The file has 12 lines.");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CEREBRAS_CHAT_COMPLETIONS_URL);

    const messages = messagesOf(calls[0]);
    // Nothing on the wire carries the unsupported field, and no message was
    // dropped: the system, user, assistant and tool turns keep their order.
    assert.deepEqual(
      messages.map((message) => message.role),
      ["system", "user", "assistant", "tool"]
    );
    assert.equal(
      messages.some((message) => "reasoning_content" in message),
      false
    );
    assert.deepEqual(messages[0], { role: "system", content: "Follow the house style." });
    assert.deepEqual(messages[1], { role: "user", content: "Count the lines in notes.txt." });
    // The provisional assistant text, the call and its result all survive.
    assert.deepEqual(messages[2], {
      role: "assistant",
      content: "Let me look.",
      tool_calls: [{ id: "call_read_1", type: "function", function: { name: "read_file", arguments: '{"path":"notes.txt"}' } }],
    });
    assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_read_1", content: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12" });
  });
});

Deno.test("cerebras chat: the turn after a tool result keeps the whole history and completes", async () => {
  await withCerebrasKey(async () => {
    const calls: UpstreamCall[] = [];

    const response = await withFetchMock(
      (url, bodyText) => {
        const body = typeof bodyText === "string" ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        calls.push({ url, body });
        return chatCompletion({ role: "assistant", content: "The file has 12 lines." }, "stop", "chatcmpl-cerebras-strip-2");
      },
      () =>
        handleChatCompletions(
          specialProviderChatRequest({
            model: QWEN,
            reasoning_effort: "none",
            stream: false,
            messages: [
              { role: "system", content: "Follow the house style." },
              { role: "user", content: "Count the lines in notes.txt." },
              {
                role: "assistant",
                content: null,
                reasoning_content: "I should call the read tool.",
                tool_calls: [{ id: "call_read_1", type: "function", function: { name: "read_file", arguments: '{"path":"notes.txt"}' } }],
              },
              { role: "tool", tool_call_id: "call_read_1", content: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12" },
            ],
          })
        )
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as { choices?: { message?: Record<string, unknown> }[] };
    assert.equal(payload.choices?.[0]?.message?.content, "The file has 12 lines.");
    // The request was dispatched once and carries the whole history, so the
    // tool result reached the model on the same turn that produced the answer.
    assert.equal(calls.length, 1);
    const dispatched = messagesOf(calls[0]);
    assert.deepEqual(
      dispatched.map((message) => message.role),
      ["system", "user", "assistant", "tool"]
    );
    assert.deepEqual(dispatched[2], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_read_1", type: "function", function: { name: "read_file", arguments: '{"path":"notes.txt"}' } }],
    });
    assert.deepEqual(dispatched[3], { role: "tool", tool_call_id: "call_read_1", content: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12" });
    assert.equal("reasoning_content" in dispatched[2], false);
  });
});

Deno.test("cerebras responses: replayed reasoning items are absent upstream while the client keeps its reasoning and tool call", async () => {
  await withCerebrasKey(async () => {
    const calls: UpstreamCall[] = [];
    const upstreamText = JSON.stringify({
      error: { message: "messages.3.assistant.reasoning_content and messages.4.assistant.reasoning_content are unsupported" },
    });

    const response = await withFetchMock(
      (url, bodyText) => {
        const body = typeof bodyText === "string" ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        calls.push({ url, body });
        const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
        // Each replayed assistant turn is refused exactly as the provider did,
        // so the fixture cannot pass by accident.
        if (messages.some((message) => message.role === "assistant" && "reasoning_content" in message)) return new Response(upstreamText, { status: 400 });
        return chatCompletion(
          {
            role: "assistant",
            content: null,
            reasoning: "I should call the read tool.",
            tool_calls: [{ id: "call_read_2", type: "function", function: { name: "lookup", arguments: '{"query":"notes"}' } }],
          },
          "tool_calls"
        );
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: QWEN,
              instructions: "Follow the house style.",
              reasoning: { effort: "none" },
              stream: false,
              tools: [
                {
                  type: "function",
                  name: "lookup",
                  description: "Looks one value up.",
                  parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"] },
                },
              ],
              input: [
                { type: "message", role: "user", content: "Look up the notes." },
                { type: "reasoning", summary: [{ type: "summary_text", text: "The user wants a lookup." }] },
                { type: "function_call", call_id: "call_read_2", name: "lookup", arguments: '{"query":"notes"}' },
                { type: "function_call_output", call_id: "call_read_2", output: '{"found":true}' },
              ],
            }),
          })
        )
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(payload.status, "completed");
    assert.equal(getResponseTelemetry(response)?.provider, "cerebras");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CEREBRAS_CHAT_COMPLETIONS_URL);
    const messages = messagesOf(calls[0]);
    assert.equal(
      messages.some((message) => "reasoning_content" in message),
      false
    );
    // The replayed reasoning item is the field under test: its text is what the
    // translation used to append to the assistant turn.
    assert.equal(
      messages.some((message) => JSON.stringify(message).includes("The user wants a lookup.")),
      false
    );
    // Message order and the tool round trip are unchanged: collapsed system
    // first, then the user turn, the tool-call turn and its result.
    assert.deepEqual(
      messages.map((message) => message.role),
      ["system", "user", "assistant", "tool"]
    );
    assert.deepEqual(messages[2], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_read_2", type: "function", function: { name: "lookup", arguments: '{"query":"notes"}' } }],
    });
    assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_read_2", content: '{"found":true}' });

    // The client still receives the provider's reasoning and the tool call it
    // asked for, so only the upstream request contract changed.
    const output = payload.output as Record<string, unknown>[];
    assert.equal(output[0]?.type, "reasoning");
    assert.deepEqual(output[0]?.summary, [{ type: "summary_text", text: "I should call the read tool." }]);
    assert.equal(output[1]?.type, "function_call");
    assert.equal(output[1]?.call_id, "call_read_2");
    assert.equal(output[1]?.name, "lookup");
    assert.equal(output[1]?.arguments, '{"query":"notes"}');
  });
});
