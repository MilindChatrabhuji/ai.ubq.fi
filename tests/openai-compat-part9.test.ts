import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 9 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  TEXT_ENCODER,
  baseSseChunks,
  delayBy,
  getResponseTelemetry,
  handleChatCompletions,
  handleResponses,
  neverSettlingPromise,
  projectCerebrasToolSchema,
  rejectOnAbort,
  setCerebrasFetchTimeoutMsForTest,
  specialProviderChatRequest,
  sseResponse,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

test("openai: Cerebras GPT-OSS Chat Completions adapter is native, bounded, and content-safe", async () =>
  runSequence(async (step) => {
    const envKey = "CEREBRAS_API_KEY";
    const fakeApiKey = "cerebras-test-key";
    const originalApiKey = process.env[envKey];
    const restoreApiKey = (): void => {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = originalApiKey;
    };
    const request = specialProviderChatRequest;
    const canonicalBody = {
      model: "gpt-oss-120b",
      messages: [
        { role: "developer", content: "Use exactly one function tool call." },
        { role: "user", content: "Prepare the dashboard summary." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "assistant_message",
            description: "Return the assistant response envelope.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        },
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
      reasoning_effort: "medium",
      temperature: 0,
      max_completion_tokens: 2048,
      stream: false,
    } as const;
    const refusalBody = {
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: "Request content that the model must refuse." }],
      reasoning_effort: "medium",
      stream: false,
    } as const;
    const completionWithMessage = (id: string, message: Record<string, unknown>): Record<string, unknown> => ({
      id,
      object: "chat.completion",
      created: 1_728_000_006,
      model: "gpt-oss-120b",
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });

    process.env[envKey] = fakeApiKey;
    try {
      await step("projects strict tools to Cerebras supported schema fields", () => {
        const projected = projectCerebrasToolSchema({
          type: "object",
          additionalProperties: false,
          properties: {
            message: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              pattern: "^[A-Z]",
              format: "email",
            },
            references: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              uniqueItems: true,
              items: {
                oneOf: [{ type: "object", properties: { source: { const: "view" } } }],
              },
            },
          },
          required: ["message"],
        });
        assert.deepEqual(projected, {
          type: "object",
          additionalProperties: false,
          properties: {
            message: { type: "string" },
            references: {
              type: "array",
              items: {
                anyOf: [{ type: "object", properties: { source: { enum: ["view"] } } }],
              },
            },
          },
          required: ["message"],
        });

        assert.deepEqual(
          projectCerebrasToolSchema({
            oneOf: [
              {
                type: "object",
                properties: {
                  operationId: { const: "briefings.daily" },
                  arguments: { type: "object", properties: {}, additionalProperties: false },
                  references: { type: "array", items: { type: "string" } },
                },
                required: ["operationId", "arguments", "references"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  operationId: { const: "campaigns.summary" },
                  arguments: {
                    type: "object",
                    properties: { campaignId: { type: "string", minLength: 1 } },
                    required: ["campaignId"],
                    additionalProperties: false,
                  },
                  references: { type: "array", items: { type: "string" } },
                },
                required: ["operationId", "arguments", "references"],
                additionalProperties: false,
              },
            ],
          }),
          {
            type: "object",
            properties: {
              operationId: { enum: ["briefings.daily", "campaigns.summary"] },
              arguments: {
                anyOf: [
                  { type: "object", properties: {}, additionalProperties: false },
                  {
                    type: "object",
                    properties: { campaignId: { type: "string" } },
                    required: ["campaignId"],
                    additionalProperties: false,
                  },
                ],
              },
              references: { type: "array", items: { type: "string" } },
            },
            required: ["arguments", "operationId", "references"],
            additionalProperties: false,
          }
        );

        assert.deepEqual(
          projectCerebrasToolSchema({
            oneOf: [
              {
                type: "object",
                properties: {
                  operationId: { const: "search" },
                  query: { type: "string" },
                },
                required: ["operationId", "query"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  operationId: { const: "read" },
                  documentId: { type: "string" },
                },
                required: ["operationId", "documentId"],
                additionalProperties: false,
              },
            ],
          }),
          {
            type: "object",
            properties: {
              operationId: { enum: ["search", "read"] },
              query: { type: "string" },
              documentId: { type: "string" },
            },
            required: ["operationId"],
            additionalProperties: false,
          }
        );
      });

      await step("never drops property names that collide with schema keywords", () => {
        // D3 regression (gateway commit): a property literally named `pattern`
        // (or format/minLength/...) was deleted by the keyword projection while
        // `required` still named it, so the model "misassigned" arguments into
        // whatever field survived. Property NAMES are not schema keywords.
        const projected = projectCerebrasToolSchema({
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob to match files, e.g. *.py" },
            path: { type: "string", description: "Directory to search (optional)." },
            format: { type: "string", description: "A field named format." },
          },
          required: ["pattern"],
          additionalProperties: false,
        });
        assert.deepEqual((projected as Record<string, unknown>).properties, {
          pattern: { type: "string", description: "Glob to match files, e.g. *.py" },
          path: { type: "string", description: "Directory to search (optional)." },
          format: { type: "string", description: "A field named format." },
        });
        // Keyword FIELDS inside property schemas are still stripped for Cerebras.
        assert.deepEqual(
          projectCerebrasToolSchema({
            type: "object",
            properties: { glob: { type: "string", pattern: "^[A-Z]", minLength: 1 } },
            required: ["glob"],
          }),
          {
            type: "object",
            properties: { glob: { type: "string" } },
            required: ["glob"],
          }
        );
      });

      await step("preserves a property named like a keyword anywhere in the graph", () => {
        const projected = projectCerebrasToolSchema({
          type: "object",
          properties: {
            oneOf: { type: "string" }, // property NAMED oneOf stays a property
            nested: {
              type: "object",
              properties: { uniqueItems: { type: "number" } },
            },
          },
          required: ["oneOf"],
        }) as { properties: Record<string, unknown> };
        assert.equal(typeof projected.properties.oneOf, "object");
        const nestedProps = (projected.properties.nested as { properties: Record<string, { type?: unknown } | undefined> }).properties;
        assert.equal(nestedProps.uniqueItems?.type, "number");
      });

      await step("routes the exact model and preserves native tools/tool choice", async () => {
        const upstreamCalls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
        const logs: unknown[][] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => logs.push(args);
        try {
          const response = await withFetchMock(
            (url, bodyText, init) => {
              upstreamCalls.push({
                url,
                body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
                headers: new Headers(init?.headers),
              });
              return new Response(
                JSON.stringify({
                  id: "chatcmpl_cerebras_fixture",
                  object: "chat.completion",
                  created: 1_728_000_000,
                  model: "gpt-oss-120b",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call_fixture",
                            type: "function",
                            provider_trace: "provider-tool-field-must-not-be-relayed",
                            function: { name: "assistant_message", arguments: '{"message":"Ready"}' },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                  usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 },
                  provider_debug: "provider-body-must-not-be-logged-or-relayed",
                }),
                {
                  status: 200,
                  headers: {
                    "Content-Type": "application/json",
                    "X-Request-Id": "cerebras-header-request-1",
                  },
                }
              );
            },
            () =>
              handleChatCompletions(request(canonicalBody), {
                keyId: null,
                kernelRepo: null,
                kernelOrg: null,
                requestId: "cerebras-success",
                startedAtMs: Date.now(),
                startedAtMonotonicMs: performance.now(),
              })
          );

          assert.equal(response.status, 200);
          assert.deepEqual(
            upstreamCalls.map((call) => call.url),
            ["https://api.cerebras.ai/v1/chat/completions"]
          );
          // The body reaches Cerebras verbatim except for the role projection:
          // `developer` is not a role Cerebras' chat template accepts, so it is
          // mapped onto `system` rather than forwarded (see the dedicated step
          // below for the mapping and the no-mutation guarantee).
          assert.deepEqual(upstreamCalls[0]?.body, {
            ...canonicalBody,
            messages: canonicalBody.messages.map((message) => (message.role === "developer" ? { ...message, role: "system" } : message)),
          });
          assert.equal(upstreamCalls[0]?.headers.get("Authorization"), `Bearer ${fakeApiKey}`);
          assert.equal(upstreamCalls[0]?.headers.get("Content-Type"), "application/json");
          const payload = (await response.json()) as {
            model?: string;
            choices?: { message?: { tool_calls?: Record<string, unknown>[] } }[];
            usage?: Record<string, unknown>;
            provider_debug?: unknown;
          };
          assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
          assert.equal(response.headers.get("x-uos-provider-request-id"), "cerebras-header-request-1");
          assert.equal(payload.model, "gpt-oss-120b");
          assert.equal(payload.provider_debug, undefined);
          assert.deepEqual(payload.choices?.[0]?.message?.tool_calls, [
            {
              id: "call_fixture",
              type: "function",
              function: { name: "assistant_message", arguments: '{"message":"Ready"}' },
            },
          ]);
          assert.deepEqual(payload.usage, { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 });
          const telemetry = getResponseTelemetry(response);
          assert.equal(telemetry?.provider, "cerebras");
          assert.equal(telemetry.providerRequestId, "cerebras-header-request-1");
          assert.equal(telemetry.inputTokens, 13);
          assert.equal(telemetry.outputTokens, 7);
          assert.equal(telemetry.completed, true);
          assert.equal(telemetry.stream, false);
          assert.deepEqual(telemetry.attemptedProviders, ["cerebras"]);
          assert.equal(telemetry.failureKind, null);
          assert.equal(typeof telemetry.firstProviderDispatchMs, "number");
          assert.equal(typeof telemetry.firstProviderHeadersMs, "number");
          const logText = JSON.stringify(logs);
          assert.doesNotMatch(logText, /cerebras-test-key/);
          assert.doesNotMatch(logText, /provider-body-must-not-be-logged-or-relayed/);
        } finally {
          console.error = originalError;
        }
      });

      // The second Cerebras id must be owned by the same route and reach upstream
      // under the provider's exact spelling, not the client's casing.
      await step("routes qwen-3.8-27b to Cerebras with the canonical wire id", async () => {
        const upstreamCalls: { url: string; body: Record<string, unknown> }[] = [];
        const response = await withFetchMock(
          (url, bodyText) => {
            upstreamCalls.push({
              url,
              body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
            });
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_qwen",
                object: "chat.completion",
                created: 1_728_000_010,
                model: "qwen-3.8-27b",
                choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () =>
            handleChatCompletions(request({ ...canonicalBody, model: "QWEN-3.8-27B", reasoning_effort: "none" }), {
              keyId: null,
              kernelRepo: null,
              kernelOrg: null,
              requestId: "cerebras-qwen-success",
              startedAtMs: Date.now(),
              startedAtMonotonicMs: performance.now(),
            })
        );

        assert.equal(response.status, 200);
        assert.deepEqual(
          upstreamCalls.map((call) => call.url),
          ["https://api.cerebras.ai/v1/chat/completions"]
        );
        assert.equal(upstreamCalls[0]?.body.model, "qwen-3.8-27b");
        // `none` is a tier qwen accepts and gpt-oss does not, so it must survive
        // the boundary verbatim rather than being dropped or rewritten.
        assert.equal(upstreamCalls[0]?.body.reasoning_effort, "none");
        assert.equal(upstreamCalls[0]?.body.stream, false);
        assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
        const payload = (await response.json()) as { model?: string };
        assert.equal(payload.model, "qwen-3.8-27b");
        assert.equal(getResponseTelemetry(response)?.provider, "cerebras");
      });

      // Cerebras validates the whole body and refuses ordinary OpenAI fields it
      // does not implement, even as explicit nulls, so a passthrough client used
      // to fail the entire turn with a 400 before the model was reached.
      await step("omits the OpenAI fields Cerebras refuses instead of forwarding them", async () => {
        const seen: Record<string, unknown>[] = [];
        const qwenCompletion = (id: string): string =>
          JSON.stringify({
            id,
            object: "chat.completion",
            created: 1_728_000_020,
            model: "qwen-3.8-27b",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        const response = await withFetchMock(
          (_url, bodyText) => {
            if (bodyText) seen.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(qwenCompletion("chatcmpl_cerebras_unsupported_fields"), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
          () =>
            handleChatCompletions(
              request({
                ...canonicalBody,
                model: "qwen-3.8-27b",
                store: false,
                metadata: { trace: "must-not-be-forwarded" },
                top_logprobs: 3,
              })
            )
        );

        assert.equal(response.status, 200);
        assert.equal(seen.length, 1);
        const body = seen[0] ?? {};
        // The keys must be absent, not blanked: Cerebras rejects `store: null` too.
        assert.equal("store" in body, false, "store must be omitted, not nulled");
        assert.equal("metadata" in body, false, "metadata must be omitted, not nulled");
        // `top_logprobs` alone is invalid upstream; it is only dropped when the
        // request did not also ask for logprobs.
        assert.equal("top_logprobs" in body, false);
        assert.equal(body.model, "qwen-3.8-27b");
      });

      await step("keeps top_logprobs when the request also asks for logprobs", async () => {
        const seen: Record<string, unknown>[] = [];
        const response = await withFetchMock(
          (_url, bodyText) => {
            if (bodyText) seen.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_logprobs",
                object: "chat.completion",
                created: 1_728_000_021,
                model: "qwen-3.8-27b",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () => handleChatCompletions(request({ ...canonicalBody, model: "qwen-3.8-27b", logprobs: true, top_logprobs: 3 }))
        );

        assert.equal(response.status, 200);
        assert.equal(seen[0]?.logprobs, true);
        assert.equal(seen[0]?.top_logprobs, 3);
      });

      // Cerebras fails the whole turn on a role its chat template does not know,
      // so the harness' `developer` system message must be mapped, not forwarded.
      await step("maps the developer role onto system without mutating the caller record", async () => {
        const seen: Record<string, unknown>[] = [];
        const requestBody = {
          ...canonicalBody,
          model: "qwen-3.8-27b",
          messages: [
            { role: "developer", content: "You are terse." },
            { role: "user", content: "go" },
          ],
        };
        const response = await withFetchMock(
          (_url, bodyText) => {
            if (bodyText) seen.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_developer_role",
                object: "chat.completion",
                created: 1_728_000_022,
                model: "qwen-3.8-27b",
                choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () => handleChatCompletions(request(requestBody))
        );

        assert.equal(response.status, 200);
        const messages = seen[0]?.messages as { role: string; content: string }[];
        assert.equal(messages[0]?.role, "system", "developer must reach Cerebras as system");
        assert.equal(messages[0]?.content, "You are terse.", "content must be preserved");
        assert.equal(messages[1]?.role, "user", "unrelated roles must not be rewritten");
        // The caller's own record must survive the projection untouched.
        assert.equal(requestBody.messages[0].role, "developer");
      });

      // Qwen's chat template accepts exactly one `system` message and requires it
      // at index 0, so `system` + `developer` (which is mapped onto `system`)
      // reaches the provider as one leading message. Recorded live 2026-09-28:
      // two `system` messages failed the whole turn with `wrong_api_format`.
      await step("collapses repeated system messages into one leading system message", async () => {
        const seen: Record<string, unknown>[] = [];
        const response = await withFetchMock(
          (_url, bodyText) => {
            if (bodyText) seen.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_system_collapse",
                object: "chat.completion",
                created: 1_728_000_023,
                model: "qwen-3.8-27b",
                choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () =>
            handleChatCompletions(
              request({
                ...canonicalBody,
                model: "qwen-3.8-27b",
                messages: [
                  { role: "system", content: "Follow the house style." },
                  { role: "developer", content: "Answer in one word." },
                  { role: "user", content: "go" },
                ],
              })
            )
        );

        assert.equal(response.status, 200);
        assert.deepEqual(seen[0]?.messages, [
          { role: "system", content: "Follow the house style.\n\nAnswer in one word." },
          { role: "user", content: "go" },
        ]);
      });

      await step("leaves a single leading system message unchanged", async () => {
        const seen: Record<string, unknown>[] = [];
        const response = await withFetchMock(
          (_url, bodyText) => {
            if (bodyText) seen.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_single_system",
                object: "chat.completion",
                created: 1_728_000_024,
                model: "qwen-3.8-27b",
                choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () =>
            handleChatCompletions(
              request({
                ...canonicalBody,
                model: "qwen-3.8-27b",
                messages: [
                  { role: "system", content: "Follow the house style." },
                  { role: "user", content: "go" },
                ],
              })
            )
        );

        assert.equal(response.status, 200);
        assert.deepEqual(seen[0]?.messages, [
          { role: "system", content: "Follow the house style." },
          { role: "user", content: "go" },
        ]);
      });

      // A system message's content may be text parts instead of a plain string;
      // the merged message keeps that text rather than dropping it.
      await step("merges text-part system content into the single leading message", async () => {
        const seen: Record<string, unknown>[] = [];
        const response = await withFetchMock(
          (_url, bodyText) => {
            if (bodyText) seen.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_system_parts",
                object: "chat.completion",
                created: 1_728_000_025,
                model: "qwen-3.8-27b",
                choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () =>
            handleChatCompletions(
              request({
                ...canonicalBody,
                model: "qwen-3.8-27b",
                messages: [
                  { role: "system", content: [{ type: "text", text: "Follow the house style." }] },
                  { role: "developer", content: "Answer in one word." },
                  { role: "user", content: "go" },
                ],
              })
            )
        );

        assert.equal(response.status, 200);
        assert.deepEqual(seen[0]?.messages, [
          { role: "system", content: "Follow the house style.\n\nAnswer in one word." },
          { role: "user", content: "go" },
        ]);
      });

      await step("preserves upstream reasoning 1:1 in buffered Chat responses", async () => {
        const response = await withFetchMock(
          () =>
            new Response(
              JSON.stringify(
                completionWithMessage("chatcmpl_cerebras_reasoning_buffered", {
                  role: "assistant",
                  content: "pong",
                  reasoning: "the model considered the ping before answering pong.",
                })
              ),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request({ ...refusalBody, stream: false }))
        );

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
          choices?: { message?: Record<string, unknown> }[];
        };
        assert.equal(payload.choices?.[0]?.message?.role, "assistant");
        assert.equal(payload.choices[0]?.message?.content, "pong");
        assert.equal(payload.choices[0]?.message?.reasoning, "the model considered the ping before answering pong.");
      });

      await step("preserves upstream reasoning 1:1 in downgraded Chat streams", async () => {
        const response = await withFetchMock(
          () =>
            new Response(
              JSON.stringify(
                completionWithMessage("chatcmpl_cerebras_reasoning_stream", {
                  role: "assistant",
                  content: "pong",
                  reasoning: "streamed reasoning trace.",
                })
              ),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request({ ...refusalBody, stream: true }))
        );

        assert.equal(response.status, 200);
        const streamText = await response.text();
        const firstDataLine = streamText.split("\n").find((line) => line.startsWith("data: {"));
        assert.ok(firstDataLine);
        const firstEvent = JSON.parse(firstDataLine.slice("data: ".length)) as {
          choices?: { delta?: Record<string, unknown> }[];
        };
        // Native mirror: reasoning and the answer ride the same leading delta.
        // Reasoning alone is not sufficient payload for a valid completion.
        assert.equal(firstEvent.choices?.[0]?.delta?.role, "assistant");
        assert.equal(firstEvent.choices[0]?.delta?.content, "pong");
        assert.equal(firstEvent.choices[0]?.delta?.reasoning, "streamed reasoning trace.");
        assert.match(streamText, /data: \[DONE\]/);
      });

      await step("forwards bounded upstream error message/code 1:1", async () => {
        const response = await withFetchMock(
          () =>
            new Response(
              JSON.stringify({
                message: "Tools with mixed values for 'strict' are not allowed. Please set all tools to 'strict: true' or 'strict: false'",
                type: "invalid_request_error",
                param: "tools",
                code: "wrong_api_format",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "X-Request-Id": "cerebras-error-request-1",
                  "Retry-After": "17",
                },
              }
            ),
          () => handleChatCompletions(request(refusalBody))
        );

        assert.equal(response.status, 400);
        assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
        assert.equal(response.headers.get("x-uos-provider-request-id"), "cerebras-error-request-1");
        assert.equal(response.headers.get("Retry-After"), "17");
        const error = (
          (await response.json()) as {
            error?: { message?: string; code?: string; type?: string };
          }
        ).error;
        assert.equal(error?.message, "Tools with mixed values for 'strict' are not allowed. Please set all tools to 'strict: true' or 'strict: false'");
        assert.equal(error.code, "wrong_api_format");
        assert.equal(error.type, "invalid_request_error");
      });

      await step("keeps the generic error when the upstream body is not JSON", async () => {
        const response = await withFetchMock(
          () =>
            new Response("<html>provider diagnostic page</html>", {
              status: 502,
              headers: { "Content-Type": "text/html" },
            }),
          () => handleChatCompletions(request(refusalBody))
        );

        assert.equal(response.status, 502);
        const error = (
          (await response.json()) as {
            error?: { message?: string; code?: string };
          }
        ).error;
        assert.equal(error?.message, "Cerebras upstream returned an error.");
        assert.equal(error.code, "cerebras_upstream_error");
      });

      await step("preserves provider-native refusals in buffered Chat responses", async () => {
        const response = await withFetchMock(
          () =>
            new Response(
              JSON.stringify(
                completionWithMessage("chatcmpl_cerebras_refusal_buffered", {
                  role: "assistant",
                  content: "I cannot provide those instructions.",
                  refusal: "The request conflicts with safety policy.",
                })
              ),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request(refusalBody))
        );

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
          choices?: { message?: Record<string, unknown> }[];
        };
        assert.deepEqual(payload.choices?.[0]?.message, {
          role: "assistant",
          content: "I cannot provide those instructions.",
          refusal: "The request conflicts with safety policy.",
        });
      });

      await step("emits provider-native refusals in downgraded Chat streams", async () => {
        const response = await withFetchMock(
          () =>
            new Response(
              JSON.stringify(
                completionWithMessage("chatcmpl_cerebras_refusal_stream", {
                  role: "assistant",
                  content: null,
                  refusal: "I cannot help with that.",
                })
              ),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request({ ...refusalBody, stream: true }))
        );

        assert.equal(response.status, 200);
        const streamText = await response.text();
        const firstDataLine = streamText.split("\n").find((line) => line.startsWith("data: {"));
        assert.ok(firstDataLine);
        const firstEvent = JSON.parse(firstDataLine.slice("data: ".length)) as {
          choices?: { delta?: Record<string, unknown> }[];
        };
        assert.deepEqual(firstEvent.choices?.[0]?.delta, {
          role: "assistant",
          refusal: "I cannot help with that.",
        });
        assert.match(streamText, /data: \[DONE\]/);
      });

      await step("rejects non-string provider-native refusals", async () => {
        const response = await withFetchMock(
          () =>
            new Response(
              JSON.stringify(
                completionWithMessage("chatcmpl_cerebras_invalid_refusal", {
                  role: "assistant",
                  content: null,
                  refusal: { reason: "policy" },
                })
              ),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request(refusalBody))
        );

        assert.equal(response.status, 502);
        assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
        assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "cerebras_upstream_invalid_response");
      });

      await step("counts a refusal-only completion as semantic output", async () => {
        const response = await withFetchMock(
          () =>
            new Response(
              JSON.stringify(
                completionWithMessage("chatcmpl_cerebras_refusal_only", {
                  role: "assistant",
                  content: null,
                  refusal: "I cannot comply.",
                })
              ),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request(refusalBody))
        );

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
          choices?: { message?: Record<string, unknown> }[];
        };
        assert.deepEqual(payload.choices?.[0]?.message, {
          role: "assistant",
          content: null,
          refusal: "I cannot comply.",
        });
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.semanticOutputObserved, true);
        assert.equal(telemetry.completed, true);
      });

      await step("keeps reading a valid buffered body past the error-body deadline", async () => {
        const delayedPayload = JSON.stringify({
          id: "chatcmpl_cerebras_delayed_body",
          object: "chat.completion",
          created: 1_728_000_000,
          model: "gpt-oss-120b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Ready" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        });
        const response = await withFetchMock(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                async start(controller) {
                  await delayBy(1_050);
                  controller.enqueue(TEXT_ENCODER.encode(delayedPayload));
                  controller.close();
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request(canonicalBody))
        );
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as { id?: string }).id, "chatcmpl_cerebras_delayed_body");
      });

      await step("does not route similarly named models to Cerebras", async () => {
        let cerebrasCalls = 0;
        const response = await withFetchMock(
          (url) => {
            if (url === "https://api.cerebras.ai/v1/chat/completions") cerebrasCalls += 1;
            return sseResponse(baseSseChunks());
          },
          () => handleChatCompletions(request({ ...canonicalBody, model: "gpt-oss-120b-preview" }))
        );
        assert.notEqual(response.status, 200);
        assert.equal(cerebrasCalls, 0);
      });

      await step("rejects none reasoning locally without provider dispatch", async () => {
        let cerebrasCalls = 0;
        const response = await withFetchMock(
          (url) => {
            if (url === "https://api.cerebras.ai/v1/chat/completions") cerebrasCalls += 1;
            return new Response("{}", { status: 200 });
          },
          () =>
            handleChatCompletions(request({ ...canonicalBody, reasoning_effort: "none" }), {
              keyId: null,
              kernelRepo: null,
              kernelOrg: null,
              requestId: "cerebras-none-validation",
              startedAtMs: Date.now(),
              startedAtMonotonicMs: performance.now(),
            })
        );

        assert.equal(response.status, 400);
        const payload = (await response.json()) as {
          error?: { code?: string; message?: string; param?: string; type?: string };
        };
        assert.equal(payload.error?.type, "invalid_request_error");
        assert.equal(payload.error.code, "invalid_request_error");
        assert.equal(payload.error.param, "reasoning_effort");
        assert.match(payload.error.message ?? "", /none.*low.*medium.*high/i);
        assert.equal(cerebrasCalls, 0);
        assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, []);
      });

      await step("defaults omitted reasoning to medium without converting native Chat fields", async () => {
        const withoutReasoning: Record<string, unknown> = { ...canonicalBody };
        delete withoutReasoning.reasoning_effort;
        const upstreamBodies: Record<string, unknown>[] = [];
        const response = await withFetchMock(
          (_url, bodyText) => {
            if (bodyText) upstreamBodies.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_default_reasoning",
                object: "chat.completion",
                created: 1_728_000_001,
                model: "gpt-oss-120b",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Ready" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () => handleChatCompletions(request(withoutReasoning))
        );
        assert.equal(response.status, 200);
        assert.equal(upstreamBodies.length, 1);
        const upstreamBody = upstreamBodies[0];
        assert.equal(upstreamBody.reasoning_effort, "medium");
        assert.deepEqual(upstreamBody.tools, canonicalBody.tools);
        assert.equal(upstreamBody.tool_choice, canonicalBody.tool_choice);
        assert.equal(upstreamBody.stream, false);
      });

      await step("downgrades Chat Completions streaming and serves the same id on Responses", async () => {
        let cerebrasCalls = 0;
        const upstreamBodies: Record<string, unknown>[] = [];
        const streamResponse = await withFetchMock(
          (url, bodyText) => {
            if (url !== "https://api.cerebras.ai/v1/chat/completions") throw new Error(`unexpected URL: ${url}`);
            cerebrasCalls += 1;
            if (bodyText) upstreamBodies.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_buffered_stream",
                object: "chat.completion",
                created: 1_728_000_004,
                model: "gpt-oss-120b",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Ready" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () =>
            handleChatCompletions(request({ ...canonicalBody, stream: true, stream_options: { include_usage: true } }), {
              keyId: null,
              kernelRepo: null,
              kernelOrg: null,
              requestId: "cerebras-buffered-stream-telemetry",
              startedAtMs: Date.now(),
              startedAtMonotonicMs: performance.now(),
            })
        );
        assert.equal(streamResponse.status, 200);
        assert.equal(streamResponse.headers.get("Content-Type"), "text/event-stream");
        assert.equal(streamResponse.headers.get("x-uos-warning"), "gpt_oss_stream_downgraded");
        const telemetry = getResponseTelemetry(streamResponse);
        assert.ok(telemetry);
        assert.equal(telemetry.firstUpstreamSseEventMs, null);
        assert.equal(typeof telemetry.firstSemanticCommitmentMs, "number");
        assert.equal(typeof telemetry.streamTerminalMs, "number");
        const streamText = await streamResponse.text();
        assert.match(streamText, /"object":"chat\.completion\.chunk"/);
        assert.match(streamText, /"content":"Ready"/);
        assert.match(streamText, /"usage":\{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4\}/);
        assert.match(streamText, /data: \[DONE\]/);
        const upstreamBody = upstreamBodies[0];
        assert.equal(upstreamBody.stream, false);
        assert.equal(upstreamBody.stream_options, undefined);
        assert.equal(cerebrasCalls, 1);

        // The same id is owned by the Cerebras route on /v1/responses, so the
        // Responses adapter buffers the provider's non-streaming answer and
        // replays the translated completion instead of refusing the model.
        const responsesResponse = await withFetchMock(
          (url, bodyText) => {
            if (url !== "https://api.cerebras.ai/v1/chat/completions") throw new Error(`unexpected URL: ${url}`);
            cerebrasCalls += 1;
            if (bodyText) upstreamBodies.push(JSON.parse(bodyText) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_responses",
                object: "chat.completion",
                created: 1_728_000_005,
                model: "gpt-oss-120b",
                choices: [{ index: 0, message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "gpt-oss-120b", input: "ping" }),
              })
            )
        );
        assert.equal(responsesResponse.status, 200);
        assert.equal(responsesResponse.headers.get("x-uos-upstream"), "cerebras");
        const responsesPayload = (await responsesResponse.json()) as { status?: string; output?: { content?: { text?: string }[] }[] };
        assert.equal(responsesPayload.status, "completed");
        assert.equal(responsesPayload.output?.[0]?.content?.[0]?.text, "Ready");
        assert.equal(upstreamBodies.at(-1)?.stream, false);
        assert.equal(cerebrasCalls, 2);
      });

      await step("rejects a missing server credential without provider dispatch", async () => {
        Reflect.deleteProperty(process.env, envKey);
        try {
          let cerebrasCalls = 0;
          const response = await withFetchMock(
            (url) => {
              if (url === "https://api.cerebras.ai/v1/chat/completions") cerebrasCalls += 1;
              return sseResponse(baseSseChunks());
            },
            () => handleChatCompletions(request(canonicalBody))
          );
          assert.equal(response.status, 503);
          assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
          assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "cerebras_api_key_missing");
          assert.equal(getResponseTelemetry(response)?.failureKind, "cerebras_api_key_missing");
          assert.equal(cerebrasCalls, 0);
        } finally {
          process.env[envKey] = fakeApiKey;
        }
      });

      await step("normalizes upstream 400/401/408/429/5xx without logging provider bodies", async () => {
        const cases = [
          { status: 400, expectedType: "invalid_request_error" },
          { status: 401, expectedType: "invalid_request_error" },
          { status: 408, expectedType: "server_error" },
          { status: 429, expectedType: "rate_limit_error" },
          { status: 503, expectedType: "server_error" },
        ] as const;
        const cerebrasRateLimitHeaders = {
          "x-ratelimit-limit-requests-minute": "5",
          "x-ratelimit-remaining-requests-minute": "0",
          "x-ratelimit-reset-requests-minute": "42",
          "x-ratelimit-limit-tokens-minute": "30000",
          "x-ratelimit-remaining-tokens-minute": "29999",
          "x-ratelimit-reset-tokens-minute": "42",
          "x-ratelimit-limit-requests-day": "1000",
          "x-ratelimit-remaining-requests-day": "999",
          "x-ratelimit-reset-requests-day": "86400",
          "x-ratelimit-limit-tokens-day": "1000000",
          "x-ratelimit-remaining-tokens-day": "999999",
          "x-ratelimit-reset-tokens-day": "86400",
        };
        for (const testCase of cases) {
          const logs: unknown[][] = [];
          const originalError = console.error;
          console.error = (...args: unknown[]) => logs.push(args);
          try {
            const response = await withFetchMock(
              (url) => {
                assert.equal(url, "https://api.cerebras.ai/v1/chat/completions");
                return new Response(
                  JSON.stringify({
                    error: {
                      message: "provider-body-must-not-be-logged-or-relayed",
                      code: "fixture_failure",
                      // Arbitrary provider diagnostics must NEVER be relayed:
                      // only the standard bounded message/code fields are.
                      provider_debug_marker: "provider-body-must-not-be-logged-or-relayed",
                      trace_id: "provider-trace-must-not-be-relayed",
                    },
                  }),
                  {
                    status: testCase.status,
                    headers: {
                      "Content-Type": "application/json",
                      "X-Request-Id": `cerebras-error-${testCase.status}`,
                      ...(testCase.status === 429 ? { "Retry-After": "17" } : {}),
                      ...cerebrasRateLimitHeaders,
                    },
                  }
                );
              },
              () =>
                handleChatCompletions(request(canonicalBody), {
                  keyId: null,
                  kernelRepo: null,
                  kernelOrg: null,
                  requestId: `cerebras-error-${testCase.status}`,
                  startedAtMs: Date.now(),
                  startedAtMonotonicMs: performance.now(),
                })
            );
            assert.equal(response.status, testCase.status);
            assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
            assert.equal(response.headers.get("x-uos-provider-request-id"), `cerebras-error-${testCase.status}`);
            assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, ["cerebras"]);
            assert.equal(response.headers.get("Retry-After"), testCase.status === 429 ? "17" : null);
            for (const [header, value] of Object.entries(cerebrasRateLimitHeaders)) {
              assert.equal(response.headers.get(header), testCase.status === 429 ? value : null, `${header} on ${testCase.status}`);
            }
            const payload = (await response.json()) as {
              error?: {
                message?: string;
                type?: string;
                code?: string;
                provider_debug_marker?: string;
                trace_id?: string;
              };
            };
            assert.equal(payload.error?.type, testCase.expectedType);
            // D2 (2026-08-29): bounded standard upstream fields ARE forwarded 1:1.
            assert.equal(payload.error.code, "fixture_failure");
            assert.equal(payload.error.message, "provider-body-must-not-be-logged-or-relayed");
            // The body-reflection safety property still holds: unknown provider
            // fields never reach the client.
            assert.equal(payload.error.provider_debug_marker, undefined);
            assert.equal(payload.error.trace_id, undefined);
            assert.equal(getResponseTelemetry(response)?.failureKind, "upstream_http_error");
            const logText = JSON.stringify(logs);
            assert.doesNotMatch(logText, /provider-body-must-not-be-logged-or-relayed/);
            assert.doesNotMatch(logText, /cerebras-test-key/);
          } finally {
            console.error = originalError;
          }
        }
      });

      await step("rejects malformed tool-call output without reflecting provider content", async () => {
        const response = await withFetchMock(
          () =>
            new Response(
              JSON.stringify({
                id: "chatcmpl_cerebras_invalid_tool",
                object: "chat.completion",
                created: 1_728_000_002,
                model: "gpt-oss-120b",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_invalid",
                          type: "function",
                          function: {
                            name: "assistant_message",
                            arguments: { marker: "provider-body-must-not-be-relayed" },
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request(canonicalBody))
        );
        assert.equal(response.status, 502);
        assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
        const payload = (await response.json()) as { error?: { code?: string; message?: string } };
        assert.equal(payload.error?.code, "cerebras_upstream_invalid_response");
        assert.equal(getResponseTelemetry(response)?.failureKind, "invalid_completion_schema");
        assert.doesNotMatch(payload.error.message ?? "", /provider-body-must-not-be-relayed/);
      });

      await step("rejects missing or rewritten native tool-call fields", async () => {
        const malformedCalls = [
          {
            id: "call_missing_type",
            function: { name: "assistant_message", arguments: "{}" },
          },
          {
            id: " call_with_whitespace",
            type: "function",
            function: { name: "assistant_message", arguments: "{}" },
          },
          {
            id: "call_name_whitespace",
            type: "function",
            function: { name: " assistant_message", arguments: "{}" },
          },
        ];
        for (const toolCall of malformedCalls) {
          const response = await withFetchMock(
            () =>
              new Response(
                JSON.stringify({
                  id: "chatcmpl_cerebras_invalid_native_tool",
                  object: "chat.completion",
                  created: 1_728_000_003,
                  model: "gpt-oss-120b",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: null, tool_calls: [toolCall] },
                      finish_reason: "tool_calls",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              ),
            () => handleChatCompletions(request(canonicalBody))
          );
          assert.equal(response.status, 502);
          assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "cerebras_upstream_invalid_response");
          assert.equal(getResponseTelemetry(response)?.failureKind, "invalid_completion_schema");
        }
      });

      await step("classifies transport, incomplete-body, and invalid-JSON failures without provider content", async () => {
        const unreachable = await withFetchMock(
          () => {
            throw new TypeError("provider transport detail must not be exposed");
          },
          () => handleChatCompletions(request(canonicalBody))
        );
        assert.equal(unreachable.status, 502);
        assert.equal(getResponseTelemetry(unreachable)?.streamTerminalType, "error");
        assert.equal(getResponseTelemetry(unreachable)?.failureKind, "upstream_unreachable");

        const incomplete = await withFetchMock(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(TEXT_ENCODER.encode('{"partial":'));
                  controller.error(new Error("provider body detail must not be exposed"));
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
          () => handleChatCompletions(request(canonicalBody))
        );
        assert.equal(incomplete.status, 502);
        assert.equal(getResponseTelemetry(incomplete)?.streamTerminalType, "error");
        assert.equal(getResponseTelemetry(incomplete)?.failureKind, "incomplete_response");

        const invalidJson = await withFetchMock(
          () => new Response('{"invalid":', { status: 200, headers: { "Content-Type": "application/json" } }),
          () => handleChatCompletions(request(canonicalBody))
        );
        assert.equal(invalidJson.status, 502);
        assert.equal(getResponseTelemetry(invalidJson)?.streamTerminalType, "error");
        assert.equal(getResponseTelemetry(invalidJson)?.failureKind, "invalid_json");
      });

      await step("bounds a pre-header timeout and forwards downstream cancellation", async () => {
        setCerebrasFetchTimeoutMsForTest(10);
        try {
          let timeoutCalls = 0;
          const timeoutResponse = await withFetchMock(
            (url, _body, init) => {
              timeoutCalls += 1;
              assert.equal(url, "https://api.cerebras.ai/v1/chat/completions");
              const signal = init?.signal;
              if (!signal) return Promise.reject(new Error("Cerebras request did not receive a cancellation signal"));
              return rejectOnAbort(signal);
            },
            () => handleChatCompletions(request(canonicalBody))
          );
          assert.equal(timeoutCalls, 1);
          assert.equal(timeoutResponse.status, 504);
          assert.equal(timeoutResponse.headers.get("x-uos-upstream"), "cerebras");
          assert.equal(((await timeoutResponse.json()) as { error?: { code?: string } }).error?.code, "gateway_timeout");
          assert.equal(getResponseTelemetry(timeoutResponse)?.streamTerminalType, "deadline");
          assert.equal(getResponseTelemetry(timeoutResponse)?.failureKind, "deadline");
        } finally {
          setCerebrasFetchTimeoutMsForTest(null);
        }

        const controller = new AbortController();
        let downstreamAbortObserved = false;
        let cancellationCalls = 0;
        const cancelledResponse = await withFetchMock(
          (url, _body, init) => {
            cancellationCalls += 1;
            assert.equal(url, "https://api.cerebras.ai/v1/chat/completions");
            const signal = init?.signal;
            if (!signal) return Promise.reject(new Error("Cerebras request did not receive a cancellation signal"));
            const pending = rejectOnAbort(signal, () => {
              downstreamAbortObserved = true;
            });
            controller.abort(new DOMException("client disconnected", "AbortError"));
            return pending;
          },
          () => handleChatCompletions(request(canonicalBody, controller.signal))
        );
        assert.equal(cancellationCalls, 1);
        assert.equal(downstreamAbortObserved, true);
        assert.equal(cancelledResponse.status, 499);
        assert.equal(cancelledResponse.headers.get("x-uos-upstream"), "cerebras");
        assert.equal(getResponseTelemetry(cancelledResponse)?.streamTerminalType, "cancelled");
        assert.equal(getResponseTelemetry(cancelledResponse)?.failureKind, "cancellation");
      });

      await step("maps downstream cancellation while draining a buffered body to 499", async () => {
        const controller = new AbortController();
        let signalSecondRead: (() => void) | null = null;
        const secondReadStarted = new Promise<void>((resolve) => {
          signalSecondRead = resolve;
        });
        let upstreamCancelled = false;
        const response = await withFetchMock(
          () => {
            let emittedPartialChunk = false;
            return new Response(
              new ReadableStream<Uint8Array>({
                pull(streamController) {
                  if (!emittedPartialChunk) {
                    emittedPartialChunk = true;
                    streamController.enqueue(TEXT_ENCODER.encode('{"partial":'));
                    return;
                  }
                  signalSecondRead?.();
                  return neverSettlingPromise();
                },
                cancel() {
                  upstreamCancelled = true;
                },
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "X-Request-Id": "cerebras-body-cancel-request",
                },
              }
            );
          },
          async () => {
            const pending = handleChatCompletions(request(canonicalBody, controller.signal));
            await secondReadStarted;
            controller.abort(new DOMException("client disconnected", "AbortError"));
            return await pending;
          }
        );

        assert.equal(response.status, 499);
        assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
        assert.equal(response.headers.get("x-uos-provider-request-id"), "cerebras-body-cancel-request");
        assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "request_cancelled");
        assert.equal(getResponseTelemetry(response)?.streamTerminalType, "cancelled");
        assert.equal(getResponseTelemetry(response)?.failureKind, "cancellation");
        assert.equal(upstreamCancelled, true);
      });
    } finally {
      restoreApiKey();
      setCerebrasFetchTimeoutMsForTest(null);
    }
  }));
