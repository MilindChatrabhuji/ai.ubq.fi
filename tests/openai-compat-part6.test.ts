import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 6 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  DEFAULT_TEST_MODEL,
  baseSseChunks,
  extractUsageTokens,
  getResponseTelemetry,
  handleChatCompletions,
  handleResponses,
  parseWarnings,
  responsesRequest,
  sseResponse,
  withFetchMock,
  withTerminalRequestLog,
} from "./helpers/openai-compat-harness.ts";

test("openai: buffered Chat preserves final-only text alongside function calls", async () => {
  const call = {
    id: "fc_final_text",
    type: "function_call",
    call_id: "call_final_text",
    name: "lookup",
    arguments: "{}",
  };
  const response = await withFetchMock(
    () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            output: [
              {
                id: "msg_final_text",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "I will look that up." }],
              },
              call,
            ],
          },
        })}\n\n`,
      ]),
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, messages: [{ role: "user", content: "tools" }] }),
        })
      )
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }[];
  };
  assert.equal(payload.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(payload.choices[0]?.message?.content, "I will look that up.");
  assert.deepEqual(payload.choices[0]?.message?.tool_calls, [{ id: "call_final_text", type: "function", function: { name: "lookup", arguments: "{}" } }]);
});

test("openai: buffered Chat preserves final text from response.output", async () => {
  const response = await withFetchMock(
    () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "response.output",
          output: [
            {
              id: "msg_output_event",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Text supplied by response.output." }],
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
      ]),
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, messages: [{ role: "user", content: "text" }] }),
        })
      )
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  assert.equal(payload.choices?.[0]?.message?.content, "Text supplied by response.output.");
});

test("openai: contentless response.completed fails Chat without success framing", async () =>
  runSequence(async (step) => {
    const usage = { input_tokens: 1642, output_tokens: 2048, total_tokens: 3690 };
    const completed = `data: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_empty", model: DEFAULT_TEST_MODEL, output: [], usage },
    })}\n\n`;

    for (const stream of [false, true]) {
      await step(stream ? "streamed" : "buffered", async () => {
        const observedTerminalUsages: { completed: boolean; inputTokens: number | null }[] = [];
        const response = await withFetchMock(
          () => sseResponse([completed]),
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  stream,
                  reasoning_effort: "low",
                  max_completion_tokens: 2048,
                  messages: [{ role: "user", content: "contentless completion" }],
                }),
              }),
              {
                keyId: null,
                kernelRepo: null,
                kernelOrg: null,
                onTerminalUsage: (terminalUsage, terminalCompleted) => {
                  observedTerminalUsages.push({
                    completed: terminalCompleted,
                    inputTokens: terminalUsage?.inputTokens ?? null,
                  });
                },
              }
            )
        );

        assert.equal(response.status, 502);
        assert.doesNotMatch(response.headers.get("Content-Type") ?? "", /text\/event-stream/i);
        assert.deepEqual(await response.json(), {
          error: {
            message: "Upstream response completed with no translated semantic output.",
            type: "server_error",
            code: "empty_upstream_completion",
            param: null,
          },
        });

        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.completed, false);
        assert.equal(telemetry.semanticOutputObserved, false);
        assert.equal(telemetry.outputTokenAllowance, 2048);
        assert.deepEqual(telemetry.upstreamEventKinds, ["response.completed"]);
        assert.equal(telemetry.streamTerminalType, "error");
        assert.equal(telemetry.failureKind, "empty_upstream_completion");
        assert.equal(telemetry.inputTokens, 1642);
        assert.equal(telemetry.outputTokens, 2048);
        assert.equal(telemetry.totalTokens, 3690);
        assert.deepEqual(observedTerminalUsages, [{ completed: false, inputTokens: 1642 }]);
      });
    }
  }));

test("openai: partial Chat output followed by failure is not an empty completion", async () =>
  runSequence(async (step) => {
    const events = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial output" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          output: [],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      })}\n\n`,
    ];
    for (const stream of [false, true]) {
      await step(stream ? "streamed" : "buffered", async () => {
        const response = await withFetchMock(
          () => sseResponse(events),
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  stream,
                  messages: [{ role: "user", content: "partial then fail" }],
                }),
              })
            )
        );
        const serialized = await response.text();
        assert.match(serialized, /upstream_stream_error/);
        assert.doesNotMatch(serialized, /empty_upstream_completion|data: \[DONE\]/);
        assert.equal(getResponseTelemetry(response)?.semanticOutputObserved, true);
        assert.equal(getResponseTelemetry(response)?.completed, false);
      });
    }
  }));

test("openai: empty Chat terminal diagnostics are bounded and content-free", async () => {
  const secretPrompt = "private prompt that must not enter diagnostics";
  const secretEventPayload = "private provider output that must not enter diagnostics";
  const unknownEventType = "response.future_private_output";
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const response = await withFetchMock(
      () =>
        new Response(
          sseResponse([
            `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_empty_log" } })}\n\n`,
            `data: ${JSON.stringify({ type: "response.in_progress", response: { id: "resp_empty_log" } })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.reasoning_summary_text.delta",
              summary_index: 0,
              delta: "private reasoning summary",
            })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.reasoning_summary_text.done",
              summary_index: 0,
              text: "private reasoning summary",
            })}\n\n`,
            `data: ${JSON.stringify({ type: "response.reasoning_text.delta", content_index: 0, delta: "private reasoning" })}\n\n`,
            `data: ${JSON.stringify({ type: "response.reasoning_text.done", content_index: 0, text: "private reasoning" })}\n\n`,
            `data: ${JSON.stringify({ type: "response.reasoning_summary_part.added", summary_index: 0 })}\n\n`,
            `data: ${JSON.stringify({ type: "response.reasoning_summary_part.done", summary_index: 0 })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.content_part.added",
              item_id: "msg_empty_log",
              content_index: 0,
              part: { type: "output_text", text: "" },
            })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.content_part.done",
              item_id: "msg_empty_log",
              content_index: 0,
              part: { type: "output_text", text: "" },
            })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.custom_tool_call_input.delta",
              item_id: "tool_empty_log",
              delta: "private tool input",
            })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.custom_tool_call_input.done",
              item_id: "tool_empty_log",
              input: "private tool input",
            })}\n\n`,
            `data: ${JSON.stringify({ type: unknownEventType, output: secretEventPayload })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_empty_log",
                model: DEFAULT_TEST_MODEL,
                output: [],
                usage: { input_tokens: 10, output_tokens: 2048, total_tokens: 2058 },
              },
            })}\n\n`,
          ]).body,
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "X-Request-Id": "provider-empty-log",
            },
          }
        ),
      () =>
        handleChatCompletions(
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              reasoning_effort: "low",
              max_completion_tokens: 2048,
              messages: [{ role: "user", content: secretPrompt }],
            }),
          })
        )
    );
    const loggedResponse = await withTerminalRequestLog(response, {
      route: "chat.completions",
      telemetryResponse: response,
      startedAtMonotonicMs: performance.now(),
      requestId: "empty-chat-terminal-log",
    });
    assert.equal(loggedResponse.status, 502);
    await loggedResponse.json();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (logs.some((entry) => entry[0] === "[ai.ubq.fi] request_terminal")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    const terminalLogs = logs
      .filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal")
      .map((entry) => JSON.parse(String(entry[1])) as Record<string, unknown>);
    assert.equal(terminalLogs.length, 1);
    const terminal = terminalLogs[0];
    assert.equal(terminal.provider_request_id, "provider-empty-log");
    assert.equal(terminal.output_token_allowance, 2048);
    assert.equal(terminal.semantic_output_observed, false);
    assert.deepEqual(terminal.upstream_event_kinds, [
      "response.created",
      "response.in_progress",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_text.delta",
      "response.reasoning_text.done",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_part.done",
      "response.content_part.added",
      "response.content_part.done",
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "unrecognized",
      "response.completed",
    ]);
    assert.equal(terminal.stream_terminal_type, "error");
    assert.equal(terminal.failure_kind, "empty_upstream_completion");
    assert.equal(terminal.input_tokens, 10);
    assert.equal(terminal.output_tokens, 2048);
    const serializedTerminal = JSON.stringify(terminal);
    assert.equal(serializedTerminal.includes(secretPrompt), false);
    assert.equal(serializedTerminal.includes(secretEventPayload), false);
    assert.equal(serializedTerminal.includes(unknownEventType), false);
  } finally {
    console.info = originalInfo;
  }
});

test("openai: Chat refusal output remains semantic in buffered and streamed modes", async () =>
  runSequence(async (step) => {
    const refusalText = "I cannot help with that request.";
    const refusalItem = {
      id: "msg_refusal",
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: refusalText }],
    };
    const cases = [
      {
        name: "refusal delta and done",
        events: [
          `data: ${JSON.stringify({
            type: "response.refusal.delta",
            item_id: "msg_refusal",
            output_index: 0,
            content_index: 0,
            delta: "I cannot ",
          })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.refusal.done",
            item_id: "msg_refusal",
            output_index: 0,
            content_index: 0,
            refusal: refusalText,
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
      {
        name: "final response output refusal",
        events: [`data: ${JSON.stringify({ type: "response.completed", response: { output: [refusalItem] } })}\n\n`],
      },
      {
        name: "output-item-done refusal",
        events: [
          `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: refusalItem })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
      {
        name: "content-part-done refusal",
        events: [
          `data: ${JSON.stringify({
            type: "response.content_part.done",
            item_id: "msg_refusal",
            output_index: 0,
            content_index: 0,
            part: { type: "refusal", refusal: refusalText },
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
      {
        name: "response.output plus repeated output-item-done refusal",
        events: [
          `data: ${JSON.stringify({ type: "response.output", output: [refusalItem] })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: refusalItem })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
      {
        name: "response.output plus repeated content-part-done refusal",
        events: [
          `data: ${JSON.stringify({ type: "response.output", output: [refusalItem] })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.content_part.done",
            item_id: "msg_refusal",
            output_index: 0,
            content_index: 0,
            part: refusalItem.content[0],
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
    ];

    for (const testCase of cases) {
      for (const stream of [false, true]) {
        await step(`${testCase.name} (${stream ? "streamed" : "buffered"})`, async () => {
          const response = await withFetchMock(
            () => sseResponse(testCase.events),
            () =>
              handleChatCompletions(
                new Request("https://ai.ubq.fi/v1/chat/completions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: DEFAULT_TEST_MODEL,
                    stream,
                    messages: [{ role: "user", content: "refuse" }],
                  }),
                })
              )
          );
          assert.equal(response.status, 200);
          if (!stream) {
            const payload = (await response.json()) as {
              choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }[];
            };
            assert.equal(payload.choices?.[0]?.message?.content, null);
            assert.equal(payload.choices[0]?.message?.refusal, refusalText);
            assert.equal(payload.choices[0]?.finish_reason, "stop");
          } else {
            const serialized = await response.text();
            const chunks = [...serialized.matchAll(/^data: (.+)$/gm)]
              .map((match) => match[1])
              .filter((value) => value !== "[DONE]")
              .map(
                (value) =>
                  JSON.parse(value) as {
                    choices?: { delta?: { refusal?: unknown }; finish_reason?: unknown }[];
                  }
              );
            const refusal = chunks
              .map((chunk) => chunk.choices?.[0]?.delta?.refusal)
              .filter((value): value is string => typeof value === "string")
              .join("");
            assert.equal(refusal, refusalText);
            assert.equal(chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason === "stop").length, 1);
            assert.equal(serialized.match(/data: \[DONE\]/g)?.length, 1);
          }
          assert.equal(getResponseTelemetry(response)?.semanticOutputObserved, true);
          assert.equal(getResponseTelemetry(response)?.completed, true);
        });
      }
    }
  }));

test("openai: streamed Chat preserves final-only text alongside function calls", async () => {
  const call = {
    id: "fc_stream_final_text",
    type: "function_call",
    call_id: "call_stream_final_text",
    name: "lookup",
    arguments: "{}",
  };
  const response = await withFetchMock(
    () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            output: [
              {
                id: "msg_stream_final_text",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "I will look that up." }],
              },
              call,
            ],
          },
        })}\n\n`,
      ]),
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            stream: true,
            messages: [{ role: "user", content: "tools" }],
          }),
        })
      )
  );
  const text = await response.text();
  assert.match(text, /I will look that up\./);
  assert.match(text, /"tool_calls"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /data: \[DONE\]/);
});

test("openai: Chat recovers completed output text without duplicating streamed deltas", async () =>
  runSequence(async (step) => {
    const completedText = '{"subjects":[{"title":"Recovered"}]}';
    const finalOutput = [
      {
        id: "msg_done_text",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: completedText }],
      },
    ];
    const cases = [
      {
        name: "done-only text with empty terminal output",
        events: [
          `data: ${JSON.stringify({
            type: "response.output_text.done",
            item_id: "msg_done_text",
            output_index: 0,
            content_index: 0,
            text: completedText,
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
      {
        name: "output-item-done text with empty terminal output",
        events: [
          `data: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: finalOutput[0],
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
      {
        name: "content-part-done text with empty terminal output",
        events: [
          `data: ${JSON.stringify({
            type: "response.content_part.done",
            item_id: "msg_done_text",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: completedText, annotations: [] },
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
      {
        name: "delta prefix plus repeated done and terminal text",
        events: [
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            item_id: "msg_done_text",
            output_index: 0,
            content_index: 0,
            delta: completedText.slice(0, 12),
          })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.output_text.done",
            item_id: "msg_done_text",
            output_index: 0,
            content_index: 0,
            text: completedText,
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: finalOutput } })}\n\n`,
        ],
      },
      {
        name: "response.output plus repeated output-item-done text",
        events: [
          `data: ${JSON.stringify({ type: "response.output", output: finalOutput })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: finalOutput[0],
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
      {
        name: "response.output plus repeated content-part-done text",
        events: [
          `data: ${JSON.stringify({ type: "response.output", output: finalOutput })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.content_part.done",
            item_id: "msg_done_text",
            output_index: 0,
            content_index: 0,
            part: finalOutput[0].content[0],
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
        ],
      },
    ];

    for (const testCase of cases) {
      for (const stream of [false, true]) {
        await step(`${testCase.name} (${stream ? "streamed" : "buffered"})`, async () => {
          const response = await withFetchMock(
            () => sseResponse(testCase.events),
            () =>
              handleChatCompletions(
                new Request("https://ai.ubq.fi/v1/chat/completions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: DEFAULT_TEST_MODEL,
                    stream,
                    messages: [{ role: "user", content: "subjects" }],
                  }),
                })
              )
          );
          assert.equal(response.status, 200);
          if (!stream) {
            const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
            assert.equal(payload.choices?.[0]?.message?.content, completedText);
            return;
          }

          const serialized = await response.text();
          const chunks = [...serialized.matchAll(/^data: (.+)$/gm)]
            .map((match) => match[1])
            .filter((value) => value !== "[DONE]")
            .map(
              (value) =>
                JSON.parse(value) as {
                  choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
                }
            );
          const content = chunks
            .map((chunk) => chunk.choices?.[0]?.delta?.content)
            .filter((value): value is string => typeof value === "string")
            .join("");
          assert.equal(content, completedText);
          assert.equal(chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason === "stop").length, 1);
          assert.equal(serialized.match(/data: \[DONE\]/g)?.length, 1);
        });
      }
    }
  }));

test("openai: contentless native Responses and reasoning-only completions fail before success", async () =>
  runSequence(async (step) => {
    const cases = [
      { variant: "empty", surfaces: ["responses"] as const },
      { variant: "reasoning_only", surfaces: ["chat", "responses"] as const },
    ] as const;

    for (const testCase of cases) {
      for (const surface of testCase.surfaces) {
        for (const stream of [false, true]) {
          await step(`${testCase.variant} ${surface} ${stream ? "streamed" : "buffered"}`, async () => {
            const observations: boolean[] = [];
            const observedInputTokens: (number | null)[] = [];
            let fetches = 0;
            const response = await withFetchMock(
              () => {
                fetches += 1;
                const createdResponseId = `resp_${testCase.variant}`;
                return sseResponse([
                  `data: ${JSON.stringify({ type: "response.created", response: { id: createdResponseId } })}\n\n`,
                  ...(testCase.variant === "reasoning_only"
                    ? [
                        `data: ${JSON.stringify({
                          type: "response.reasoning_summary_text.delta",
                          response_id: `resp_${testCase.variant}`,
                          item_id: `reasoning_${testCase.variant}`,
                          output_index: 0,
                          summary_index: 0,
                          delta: "hidden reasoning",
                        })}\n\n`,
                      ]
                    : []),
                  `data: ${JSON.stringify({
                    type: "response.completed",
                    response: {
                      id: `resp_${testCase.variant}`,
                      status: "completed",
                      output:
                        testCase.variant === "reasoning_only" ? [{ type: "reasoning", summary: [{ type: "summary_text", text: "hidden reasoning" }] }] : [],
                      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
                    },
                  })}\n\n`,
                ]);
              },
              () =>
                surface === "chat"
                  ? handleChatCompletions(
                      new Request("https://ai.ubq.fi/v1/chat/completions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          model: DEFAULT_TEST_MODEL,
                          stream,
                          messages: [{ role: "user", content: "hello" }],
                        }),
                      }),
                      {
                        keyId: null,
                        kernelRepo: null,
                        kernelOrg: null,
                        onTerminalUsage: (usage, completed) => {
                          observations.push(completed);
                          observedInputTokens.push(usage?.inputTokens ?? null);
                        },
                      }
                    )
                  : handleResponses(responsesRequest({ stream }), {
                      keyId: null,
                      kernelRepo: null,
                      kernelOrg: null,
                      onTerminalUsage: (usage, completed) => {
                        observations.push(completed);
                        observedInputTokens.push(usage?.inputTokens ?? null);
                      },
                    })
            );
            const releasedReasoningStream = testCase.variant === "reasoning_only" && stream;
            if (releasedReasoningStream) {
              assert.equal(response.status, 200);
              assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/i);
              const serialized = await response.text();
              assert.match(serialized, /empty_upstream_completion/);
              assert.doesNotMatch(serialized, /data: \[DONE\]/);
            } else {
              assert.equal(response.status, 502);
              assert.doesNotMatch(response.headers.get("Content-Type") ?? "", /text\/event-stream/i);
              const payload = (await response.json()) as { error?: { code?: string; type?: string; param?: unknown } };
              assert.equal(payload.error?.code, "empty_upstream_completion");
              assert.equal(payload.error.type, "server_error");
              assert.equal(payload.error.param, null);
            }
            const telemetry = getResponseTelemetry(response);
            assert.equal(telemetry?.completed, false);
            assert.equal(telemetry.failureKind, "empty_upstream_completion");
            assert.equal(telemetry.semanticOutputObserved, false);
            assert.equal(telemetry.inputTokens, 3);
            assert.equal(telemetry.outputTokens, 4);
            assert.equal(telemetry.totalTokens, 7);
            assert.deepEqual(observations, [false]);
            assert.deepEqual(observedInputTokens, [3]);
            assert.equal(fetches, 1);
          });
        }
      }
    }
  }));

test("openai: native Responses preserves a refusal-only terminal", async () =>
  runSequence(async (step) => {
    const refusalItem = {
      id: "msg_native_refusal",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "Request declined." }],
    };
    for (const stream of [false, true]) {
      await step(stream ? "streamed" : "buffered", async () => {
        const response = await withFetchMock(
          () =>
            sseResponse([
              `data: ${JSON.stringify({
                type: "response.completed",
                response: { id: "resp_native_refusal", status: "completed", output: [refusalItem] },
              })}\n\n`,
            ]),
          () => handleResponses(responsesRequest({ stream }))
        );
        assert.equal(response.status, 200);
        if (stream) {
          assert.match(await response.text(), /Request declined\./);
        } else {
          const payload = (await response.json()) as { output?: unknown };
          assert.deepEqual(payload.output, [refusalItem]);
        }
      });
    }
  }));

test("openai: Chat concatenates multiple finalized message items", async () =>
  runSequence(async (step) => {
    const items = [
      {
        id: "msg_first",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "First. " }],
      },
      {
        id: "msg_second",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Second." }],
      },
    ];
    const events = [
      ...items.map((item, outputIndex) => `data: ${JSON.stringify({ type: "response.output_item.done", output_index: outputIndex, item })}\n\n`),
      `data: ${JSON.stringify({ type: "response.completed", response: { output: items } })}\n\n`,
    ];

    for (const stream of [false, true]) {
      await step(stream ? "streamed" : "buffered", async () => {
        const response = await withFetchMock(
          () => sseResponse(events),
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  stream,
                  messages: [{ role: "user", content: "two messages" }],
                }),
              })
            )
        );
        assert.equal(response.status, 200);
        if (!stream) {
          const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
          assert.equal(payload.choices?.[0]?.message?.content, "First. Second.");
        } else {
          const serialized = await response.text();
          const chunks = [...serialized.matchAll(/^data: (.+)$/gm)]
            .map((match) => match[1])
            .filter((value) => value !== "[DONE]")
            .map(
              (value) =>
                JSON.parse(value) as {
                  choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
                }
            );
          const content = chunks
            .map((chunk) => chunk.choices?.[0]?.delta?.content)
            .filter((value): value is string => typeof value === "string")
            .join("");
          assert.equal(content, "First. Second.");
          assert.equal(chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason === "stop").length, 1);
          assert.equal(serialized.match(/data: \[DONE\]/g)?.length, 1);
        }
        assert.equal(getResponseTelemetry(response)?.semanticOutputObserved, true);
        assert.equal(getResponseTelemetry(response)?.completed, true);
      });
    }
  }));

test("openai: native Responses preserve files and key while omitting unsupported cache controls", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            instructions: null,
            prompt_cache_key: "cache-key",
            prompt_cache_options: { mode: "implicit" },
            prompt_cache_retention: "24h",
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_image", file_id: "file_image", detail: null },
                  {
                    type: "input_file",
                    file_id: "file_id",
                    file_data: "data",
                    file_url: "https://example.test/file",
                    filename: null,
                  },
                ],
              },
            ],
          }),
        })
      )
  );
  assert.equal(response.status, 200);
  const warnings = parseWarnings(response.headers.get("x-uos-warning"));
  assert.ok(warnings.includes("prompt_cache_options_ignored"));
  assert.ok(warnings.includes("prompt_cache_retention_ignored"));
  assert.ok(recordedBody);
  const recorded = recordedBody as Record<string, unknown>;
  assert.equal("instructions" in recorded, false);
  assert.equal(recorded.prompt_cache_key, "cache-key");
  assert.equal("prompt_cache_options" in recorded, false);
  assert.equal("prompt_cache_retention" in recorded, false);
  const content = ((recorded.input as Record<string, unknown>[])[0]?.content ?? []) as Record<string, unknown>[];
  assert.deepEqual(content[0], { type: "input_image", file_id: "file_image", detail: null });
  assert.deepEqual(content[1], {
    type: "input_file",
    file_id: "file_id",
    file_data: "data",
    file_url: "https://example.test/file",
    filename: null,
  });
});

test("openai: cache usage parser retains observed values and marks malformed fields invalid", () => {
  assert.deepEqual(
    extractUsageTokens({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      total_tokens: 12,
    }),
    {
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: null,
      outputTokens: 2,
      totalTokens: 12,
      status: "reported",
    }
  );

  for (const nestedCacheValue of [-1, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      extractUsageTokens({
        input_tokens: 10,
        input_tokens_details: { cached_tokens: nestedCacheValue, cache_write_tokens: 0 },
        output_tokens: 2,
        total_tokens: 12,
      }),
      {
        inputTokens: 10,
        cachedInputTokens: null,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        totalTokens: 12,
        status: "invalid",
      }
    );
  }

  assert.deepEqual(
    extractUsageTokens({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 11, cache_write_tokens: 0 },
      output_tokens: 2,
      total_tokens: 12,
    }),
    {
      inputTokens: 10,
      cachedInputTokens: 11,
      cacheWriteInputTokens: 0,
      outputTokens: 2,
      totalTokens: 12,
      status: "invalid",
    }
  );

  assert.deepEqual(
    extractUsageTokens({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
      output_tokens: 2,
      total_tokens: Number.NaN,
    }),
    {
      inputTokens: 10,
      cachedInputTokens: 8,
      cacheWriteInputTokens: 3,
      outputTokens: 2,
      totalTokens: null,
      status: "invalid",
    }
  );
});
