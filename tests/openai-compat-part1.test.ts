import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 1 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_AUTH_REAUTH_MESSAGE,
  CODEX_AUTH_REAUTH_WARNING,
  type CodexAuthPoolState,
  type CodexUsageResetProvider,
  DEBUG_ROUTING_KEY,
  DEFAULT_TEST_MODEL,
  Deferred,
  TERRA_TEST_MODEL,
  baseSseChunks,
  buildFailoverWarningEvents,
  clearBankedResetRecords,
  createUnknownBankedResetFixture,
  createVerifiedBankedResetFixture,
  encodeJsonBase64Url,
  extractResponseOutputText,
  handleChatCompletions,
  handleResponses,
  keyToString,
  kvStore,
  kvStub,
  liveBankedResetFixtureConfig,
  markCodexUpstreamTimeout,
  parseWarnings,
  resetCodexAuthCacheForTest,
  resetDebugRoutingCacheForTest,
  selectCodexRoutingAccounts,
  setCodexBankedResetOptionsForTest,
  sseResponse,
  utf8ByteLength,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

test("openai: verified banked reset recovers the fenced account before Responses delivery", async () =>
  runSequence(async (step) => {
    for (const clientWantsStream of [false, true]) {
      await step(clientWantsStream ? "streamed" : "buffered", async () => {
        const delivery = clientWantsStream ? "streamed" : "buffered";
        const postResetText = `post-reset-${delivery}`;
        const upstreamUrls: string[] = [];
        const result = await withFetchMock(
          (url, bodyText) => {
            upstreamUrls.push(url);
            assert.ok(bodyText);
            const upstreamBody = JSON.parse(bodyText) as Record<string, unknown>;
            assert.equal(upstreamBody.stream, true, "Codex transport must remain SSE-shaped for both client modes.");
            const resetResponseId = `resp_${delivery}`;
            return sseResponse([
              `data: ${JSON.stringify({ type: "response.created", response: { id: resetResponseId, created_at: 0 } })}\n\n`,
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta: postResetText })}\n\n`,
              `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  model: DEFAULT_TEST_MODEL,
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              })}\n\n`,
            ]);
          },
          async () => {
            clearBankedResetRecords();
            try {
              const resetProviderCalls = await createVerifiedBankedResetFixture();
              const response = await handleResponses(
                new Request("https://ai.ubq.fi/v1/responses", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: DEFAULT_TEST_MODEL,
                    input: "recover an already verified reset",
                    ...(clientWantsStream ? { stream: true } : {}),
                  }),
                })
              );
              const responseStatus = response.status;
              const responseContentType = response.headers.get("Content-Type");
              const responseUpstream = response.headers.get("x-uos-upstream");
              // A streamed response owns the recovery probe until its terminal
              // event is consumed and validated; merely creating the Response
              // is not proof of successful recovery.
              const responseBody = await response.text();
              const authPool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as CodexAuthPoolState;
              const routingAfterRecovery = await selectCodexRoutingAccounts(authPool, authPool.accounts, Date.now(), DEFAULT_TEST_MODEL);
              return {
                responseStatus,
                responseContentType,
                responseUpstream,
                responseBody,
                resetProviderCalls,
                routingAfterRecovery: routingAfterRecovery.kind,
              };
            } finally {
              clearBankedResetRecords();
            }
          }
        );

        // The only mocked transport is the one permitted post-reset inference.
        // The banked-reset fake is in-memory, and recovery cannot call the
        // shipped unavailable provider when it finds the verified record.
        assert.deepEqual(upstreamUrls, ["https://chatgpt.com/backend-api/codex/responses"]);
        assert.deepEqual(result.resetProviderCalls, ["inventory", "redeem", "verify"]);
        assert.equal(result.routingAfterRecovery, "eligible", "the verified decision must clear its exact quota fence");
        assert.equal(result.responseStatus, 200);
        assert.equal(result.responseUpstream, "chatgpt_codex");
        if (clientWantsStream) {
          assert.equal(result.responseContentType, "text/event-stream");
          assert.match(result.responseBody, new RegExp(postResetText));
          assert.match(result.responseBody, /response\.completed/);
        } else {
          const payload = JSON.parse(result.responseBody) as Record<string, unknown>;
          assert.equal(extractResponseOutputText(payload), postResetText);
        }
      });
    }
  }));

test("openai: verified banked reset recovers the fenced account before Chat delivery", async () =>
  runSequence(async (step) => {
    for (const clientWantsStream of [false, true]) {
      await step(clientWantsStream ? "streamed" : "buffered", async () => {
        const delivery = clientWantsStream ? "streamed" : "buffered";
        const postResetText = `chat-post-reset-${delivery}`;
        const upstreamUrls: string[] = [];
        const result = await withFetchMock(
          (url, bodyText) => {
            upstreamUrls.push(url);
            assert.ok(bodyText);
            const resetResponseId = `chat_${delivery}`;
            return sseResponse([
              `data: ${JSON.stringify({ type: "response.created", response: { id: resetResponseId, created_at: 0 } })}\n\n`,
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta: postResetText })}\n\n`,
              `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  model: DEFAULT_TEST_MODEL,
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              })}\n\n`,
            ]);
          },
          async () => {
            clearBankedResetRecords();
            try {
              const resetProviderCalls = await createVerifiedBankedResetFixture();
              const response = await handleChatCompletions(
                new Request("https://ai.ubq.fi/v1/chat/completions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: DEFAULT_TEST_MODEL,
                    messages: [{ role: "user", content: "recover an already verified reset" }],
                    ...(clientWantsStream ? { stream: true } : {}),
                  }),
                })
              );
              return { response, resetProviderCalls };
            } finally {
              clearBankedResetRecords();
            }
          }
        );

        assert.deepEqual(upstreamUrls, ["https://chatgpt.com/backend-api/codex/responses"]);
        assert.deepEqual(result.resetProviderCalls, ["inventory", "redeem", "verify"]);
        assert.equal(result.response.status, 200);
        if (clientWantsStream) {
          assert.equal(result.response.headers.get("Content-Type"), "text/event-stream");
          const stream = await result.response.text();
          assert.match(stream, new RegExp(postResetText));
          assert.match(stream, /data: \[DONE\]/);
        } else {
          const payload = (await result.response.json()) as { choices?: { message?: { content?: unknown } }[] };
          assert.equal(payload.choices?.[0]?.message?.content, postResetText);
        }
      });
    }
  }));

test("openai: an unknown banked reset returns an ordinary error with no successful stream bytes", async () =>
  runSequence(async (step) => {
    const routes = [
      {
        name: "Responses",
        request: (stream: boolean) =>
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              input: "unknown reset",
              ...(stream ? { stream: true } : {}),
            }),
          }),
        handle: handleResponses,
      },
      {
        name: "Chat",
        request: (stream: boolean) =>
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              messages: [{ role: "user", content: "unknown reset" }],
              ...(stream ? { stream: true } : {}),
            }),
          }),
        handle: handleChatCompletions,
      },
    ] as const;

    for (const route of routes) {
      for (const stream of [false, true]) {
        await step(`${route.name} ${stream ? "streamed" : "buffered"}`, async () => {
          const result = await withFetchMock(
            () => {
              throw new Error("An unknown reset must not dispatch a post-reset inference request.");
            },
            async () => {
              clearBankedResetRecords();
              try {
                const resetProviderCalls = await createUnknownBankedResetFixture();
                const response = await route.handle(route.request(stream));
                return { response, resetProviderCalls };
              } finally {
                clearBankedResetRecords();
              }
            }
          );

          assert.deepEqual(result.resetProviderCalls, ["inventory", "redeem"]);
          assert.equal(result.response.status, 429);
          assert.doesNotMatch(result.response.headers.get("Content-Type") ?? "", /text\/event-stream/i);
          const body = await result.response.text();
          assert.doesNotMatch(body, /(?:^|\n)data:\s|response\.(?:created|output_text\.delta|completed)/);
          const payload = JSON.parse(body) as { error?: { code?: unknown } };
          assert.equal(payload.error?.code, "codex_quota_blocked");
        });
      }
    }
  }));

test("openai: legacy timeout circuits do not short-circuit later requests", async () => {
  let inferenceCalls = 0;
  const response = await withFetchMock(
    () => {
      inferenceCalls += 1;
      return sseResponse(baseSseChunks());
    },
    async () => {
      const authPool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as CodexAuthPoolState;
      const selected = await selectCodexRoutingAccounts(authPool, authPool.accounts, Date.now());
      assert.equal(selected.kind, "eligible");

      await markCodexUpstreamTimeout(selected.accounts[0]);
      return await handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "timeout circuit" }),
        })
      );
    }
  );

  assert.equal(response.status, 200);
  assert.equal(inferenceCalls, 1);
  assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
  await response.text();
});

test("openai: a post-reset 429 is returned once without a successful stream", async () =>
  runSequence(async (step) => {
    const routes = [
      {
        name: "Responses",
        request: (stream: boolean) =>
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              input: "post-reset 429",
              ...(stream ? { stream: true } : {}),
            }),
          }),
        handle: handleResponses,
      },
      {
        name: "Chat",
        request: (stream: boolean) =>
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              messages: [{ role: "user", content: "post-reset 429" }],
              ...(stream ? { stream: true } : {}),
            }),
          }),
        handle: handleChatCompletions,
      },
    ] as const;

    for (const route of routes) {
      for (const stream of [false, true]) {
        await step(`${route.name} ${stream ? "streamed" : "buffered"}`, async () => {
          let upstreamCalls = 0;
          const result = await withFetchMock(
            () => {
              upstreamCalls += 1;
              return new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
                status: 429,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": new Date(Date.now() + 60_000).toUTCString(),
                },
              });
            },
            async () => {
              clearBankedResetRecords();
              try {
                const resetProviderCalls = await createVerifiedBankedResetFixture();
                const response = await route.handle(route.request(stream));
                return { response, resetProviderCalls };
              } finally {
                clearBankedResetRecords();
              }
            }
          );

          assert.equal(upstreamCalls, 1);
          assert.deepEqual(result.resetProviderCalls, ["inventory", "redeem", "verify"]);
          assert.equal(result.response.status, 429);
          assert.doesNotMatch(result.response.headers.get("Content-Type") ?? "", /text\/event-stream/i);
          const body = await result.response.text();
          assert.doesNotMatch(body, /(?:^|\n)data:\s|response\.(?:created|output_text\.delta|completed)/);
        });
      }
    }
  }));

test("openai: a replayed failover warning never reaches the upstream request", async () => {
  // PR #92 (2026-08-14) guarded this and its merge never landed, so the notice
  // this gateway injects could be replayed back upstream as ordinary input.
  const warningItem = buildFailoverWarningEvents("removed/model", "resp_replayed").item;
  let upstreamBody: Record<string, unknown> | null = null;

  await withFetchMock(
    (_url, bodyText) => {
      upstreamBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse([
        `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_ok", created_at: 0 } })}\n\n`,
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { model: DEFAULT_TEST_MODEL, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        })}\n\n`,
      ]);
    },
    async () => {
      await handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            input: [warningItem, { type: "message", role: "user", content: "continue" }],
          }),
        })
      );
    }
  );

  assert.ok(upstreamBody, "the gateway must have contacted the upstream");
  const serialized = JSON.stringify(upstreamBody);
  assert.ok(!serialized.includes("removed_provider:"), "the gateway's own failover notice must not be sent upstream as input");
  assert.ok(serialized.includes("continue"), "the real user turn must still reach the upstream");
});

test("openai: public handlers wait for verified banked redemption before one retry and delivery", async () =>
  runSequence(async (step) => {
    const routes = [
      {
        name: "Responses",
        request: (stream: boolean) =>
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              input: "qualifying reset flow",
              ...(stream ? { stream: true } : {}),
            }),
          }),
        handle: handleResponses,
        read: async (response: Response, stream: boolean, text: string): Promise<void> => {
          if (stream) {
            assert.equal(response.headers.get("Content-Type"), "text/event-stream");
            assert.match(await response.text(), new RegExp(text));
            return;
          }
          assert.equal(extractResponseOutputText((await response.json()) as Record<string, unknown>), text);
        },
      },
      {
        name: "Chat",
        request: (stream: boolean) =>
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              messages: [{ role: "user", content: "qualifying reset flow" }],
              ...(stream ? { stream: true } : {}),
            }),
          }),
        handle: handleChatCompletions,
        read: async (response: Response, stream: boolean, text: string): Promise<void> => {
          if (stream) {
            assert.equal(response.headers.get("Content-Type"), "text/event-stream");
            const body = await response.text();
            assert.match(body, new RegExp(text));
            assert.match(body, /data: \[DONE\]/);
            return;
          }
          const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
          assert.equal(payload.choices?.[0]?.message?.content, text);
        },
      },
    ] as const;

    for (const route of routes) {
      for (const stream of [false, true]) {
        await step(`${route.name} ${stream ? "streamed" : "buffered"}`, async () => {
          const verificationGate = new Deferred<void>();
          const verificationEntered = new Deferred<void>();
          const providerCalls: string[] = [];
          const provider: CodexUsageResetProvider = {
            contract: {
              idempotency: { callerSupplied: true, retentionMs: 86_400_000 },
              lookup: { byIdempotencyKey: true, byProviderReceiptId: true },
              verification: { independentlyVerifiable: true },
              receiptIdsSafeToPersistAndLog: false,
              supportedResetTypes: ["codex_rate_limits"],
            },
            readInventory: () => {
              providerCalls.push("inventory");
              return Promise.resolve({
                availableCount: 1,
                observedAtMs: Date.now(),
                credits: [{ id: "fixture-credit", status: "available", resetType: "codex_rate_limits", expiresAtMs: null }],
              });
            },
            redeem: () => {
              providerCalls.push("redeem");
              return Promise.resolve({ kind: "completed", providerReceiptId: "endpoint-fixture-receipt" } as const);
            },
            lookup: () => {
              providerCalls.push("lookup");
              return Promise.resolve({ kind: "completed", providerReceiptId: "endpoint-fixture-receipt" } as const);
            },
            verifyApplied: async () => {
              providerCalls.push("verify");
              verificationEntered.resolve(undefined);
              await verificationGate.promise;
              return true;
            },
          };
          const upstreamUrls: string[] = [];
          const postResetText = `${route.name}-${stream ? "stream" : "buffer"}-verified`;
          const result = await withFetchMock(
            (url) => {
              upstreamUrls.push(url);
              if (upstreamUrls.length === 1) {
                return new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
                  status: 429,
                  headers: {
                    "Content-Type": "application/json",
                    "Retry-After": new Date(Date.now() + 60_000).toUTCString(),
                  },
                });
              }
              if (upstreamUrls.length === 2) {
                return sseResponse([
                  `data: ${JSON.stringify({ type: "response.created", response: { id: "post_reset", created_at: 0 } })}\n\n`,
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: postResetText })}\n\n`,
                  `data: ${JSON.stringify({
                    type: "response.completed",
                    response: {
                      model: DEFAULT_TEST_MODEL,
                      output: [],
                      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                  })}\n\n`,
                ]);
              }
              throw new Error("A verified banked reset may retry inference only once.");
            },
            async () => {
              clearBankedResetRecords();
              setCodexBankedResetOptionsForTest({
                config: liveBankedResetFixtureConfig(),
                provider,
                kv: kvStub,
                now: () => Date.now(),
                newOwnerToken: () => `endpoint-${route.name}-${stream ? "stream" : "buffer"}`,
              });
              try {
                let responseResolved = false;
                const responsePromise = route.handle(route.request(stream)).then((response) => {
                  responseResolved = true;
                  return response;
                });
                await verificationEntered.promise;
                await Promise.resolve();
                assert.equal(responseResolved, false, "no public response may be committed before verification");
                assert.deepEqual(upstreamUrls, ["https://chatgpt.com/backend-api/codex/responses"]);
                assert.deepEqual(providerCalls, ["inventory", "redeem", "verify"]);
                verificationGate.resolve(undefined);
                return await responsePromise;
              } finally {
                setCodexBankedResetOptionsForTest(null);
                clearBankedResetRecords();
              }
            }
          );

          assert.deepEqual(upstreamUrls, ["https://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com/backend-api/codex/responses"]);
          assert.deepEqual(providerCalls, ["inventory", "redeem", "verify"]);
          assert.equal(result.status, 200);
          await route.read(result, stream, postResetText);
        });
      }
    }
  }));

test("openai: defaults + ignore temperature", async () =>
  runSequence(async (step) => {
    await step("chat uses default model/reasoning and ignores temperature", async () => {
      let recordedBody: Record<string, unknown> | null = null;

      const response = await withFetchMock(
        (_url, bodyText) => {
          recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
          return sseResponse(baseSseChunks());
        },
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messages: [{ role: "user", content: "ping" }],
                temperature: 0.2,
                max_tokens: 12,
                moderation: { model: "omni-moderation-latest" },
                prompt_cache_options: { mode: "implicit", ttl: "30m" },
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      const payload = (await response.json()) as { model?: string };
      assert.equal(payload.model, DEFAULT_TEST_MODEL);
      const warnings = parseWarnings(response.headers.get("x-uos-warning"));
      assert.ok(warnings.includes("temperature_ignored"));
      assert.ok(warnings.includes("max_output_tokens_ignored"));
      assert.ok(warnings.includes("moderation_ignored"));
      assert.ok(warnings.includes("prompt_cache_options_ignored"));
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.equal(recorded.model, DEFAULT_TEST_MODEL);
      assert.deepEqual(recorded.reasoning, { effort: "low" });
      assert.equal("temperature" in recorded, false);
      assert.equal("max_output_tokens" in recorded, false);
      assert.equal("moderation" in recorded, false);
      assert.equal("prompt_cache_options" in recorded, false);
    });

    await step("chat preserves none reasoning effort upstream", async () => {
      let recordedBody: Record<string, unknown> | null = null;

      const response = await withFetchMock(
        (_url, bodyText) => {
          recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
          return sseResponse(baseSseChunks());
        },
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messages: [{ role: "user", content: "ping" }],
                reasoning_effort: "none",
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.deepEqual(recorded.reasoning, { effort: "none" });
    });

    await step("chat accepts null reasoning effort as unspecified", async () => {
      let recordedBody: Record<string, unknown> | null = null;

      const response = await withFetchMock(
        (_url, bodyText) => {
          recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
          return sseResponse(baseSseChunks());
        },
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messages: [{ role: "user", content: "ping" }],
                reasoning_effort: null,
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.deepEqual(recorded.reasoning, { effort: "low" });
    });

    await step("responses uses default model/reasoning and ignores temperature", async () => {
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
                input: "ping",
                temperature: 0.7,
                max_output_tokens: 24,
                moderation: { model: "omni-moderation-latest" },
                prompt_cache_options: { mode: "implicit", ttl: "30m" },
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      const payload = (await response.json()) as Record<string, unknown> & { model?: string; reasoning?: unknown };
      assert.equal(payload.model, DEFAULT_TEST_MODEL);
      assert.equal(extractResponseOutputText(payload), "pong");
      const warnings = parseWarnings(response.headers.get("x-uos-warning"));
      assert.ok(warnings.includes("temperature_ignored"));
      assert.ok(warnings.includes("max_output_tokens_ignored"));
      assert.ok(warnings.includes("moderation_ignored"));
      assert.ok(warnings.includes("prompt_cache_options_ignored"));
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.equal(recorded.model, DEFAULT_TEST_MODEL);
      assert.deepEqual(recorded.reasoning, { effort: "low" });
      assert.equal("temperature" in recorded, false);
      assert.equal("max_output_tokens" in recorded, false);
      assert.equal("moderation" in recorded, false);
      assert.equal("prompt_cache_options" in recorded, false);
    });

    await step("responses accepts and strips Codex CLI client metadata", async () => {
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
                input: "ping",
                client_metadata: {
                  session_id: "session_test",
                  thread_id: "thread_test",
                  request_kind: "turn",
                },
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.deepEqual(parseWarnings(response.headers.get("x-uos-warning")), []);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.equal("client_metadata" in recorded, false);
    });

    await step("responses rejects malformed Codex CLI client metadata", async () => {
      const response = await handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            input: "ping",
            client_metadata: { session_id: 123 },
          }),
        })
      );

      assert.equal(response.status, 400);
      const payload = (await response.json()) as { error?: { param?: string } };
      assert.equal(payload.error?.param, "client_metadata");
    });

    await step("responses rejects array-valued Codex CLI client metadata", async () => {
      const response = await handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            input: "ping",
            client_metadata: ["session_test"],
          }),
        })
      );

      assert.equal(response.status, 400);
      const payload = (await response.json()) as { error?: { param?: string } };
      assert.equal(payload.error?.param, "client_metadata");
    });

    await step("responses preserves none reasoning upstream", async () => {
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
                input: "ping",
                reasoning: { effort: "none" },
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.deepEqual(recorded.reasoning, { effort: "none" });
    });

    await step("responses accepts null reasoning as unspecified", async () => {
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
                input: "ping",
                reasoning: null,
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.deepEqual(recorded.reasoning, { effort: "low" });
    });

    await step("responses accepts null reasoning fields as unspecified", async () => {
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
                input: "ping",
                reasoning: {
                  effort: null,
                  summary: null,
                  generate_summary: null,
                },
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.deepEqual(recorded.reasoning, { effort: "low" });
    });

    await step("responses accepts official context_management parameter", async () => {
      let recordedBody: Record<string, unknown> | null = null;
      const contextManagement = [{ type: "compaction", compact_threshold: 2000 }];

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
                input: "ping",
                context_management: contextManagement,
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.deepEqual(recorded.context_management, contextManagement);
    });

    await step("responses keeps previous_response_id as an explicit ignored warning", async () => {
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
                input: "The full input remains part of this request.",
                previous_response_id: "resp_prior_context_is_not_used",
                stream: true,
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(parseWarnings(response.headers.get("x-uos-warning")).includes("previous_response_id_ignored"));
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.equal("previous_response_id" in recorded, false);
      assert.deepEqual(recorded.input, [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "The full input remains part of this request." }],
        },
      ]);
      await response.text();
    });
  }));

test("openai: Responses byte baseline keeps request and stream directions separate", async () => {
  const contextManagement = [{ type: "compaction", compact_threshold: 2000 }];
  const clientRequestBody = JSON.stringify({
    model: DEFAULT_TEST_MODEL,
    input: "ping",
    stream: true,
    context_management: contextManagement,
  });
  const upstreamChunks = baseSseChunks();
  const upstreamStreamBody = upstreamChunks.join("");
  let serializedCodexRequest: string | null = null;

  const response = await withFetchMock(
    (_url, bodyText, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.equal(headers.get("Content-Encoding"), null);
      assert.ok(bodyText);
      serializedCodexRequest = bodyText;
      return sseResponse(upstreamChunks);
    },
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: clientRequestBody,
        })
      )
  );

  assert.equal(response.status, 200);
  const downstreamStreamBody = await response.text();
  assert.ok(serializedCodexRequest);
  assert.deepEqual(JSON.parse(serializedCodexRequest), {
    model: DEFAULT_TEST_MODEL,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "ping" }],
      },
    ],
    store: false,
    stream: true,
    reasoning: { effort: "low" },
    context_management: contextManagement,
  });
  assert.deepEqual(
    {
      inboundClientRequestBodyBytes: utf8ByteLength(clientRequestBody),
      outboundCodexRequestBodyBytes: utf8ByteLength(serializedCodexRequest),
      inboundCodexStreamBodyBytes: utf8ByteLength(upstreamStreamBody),
      outboundClientStreamBodyBytes: utf8ByteLength(downstreamStreamBody),
    },
    {
      inboundClientRequestBodyBytes: 132,
      outboundCodexRequestBodyBytes: 251,
      inboundCodexStreamBodyBytes: 296,
      outboundClientStreamBodyBytes: 296,
    }
  );
  assert.equal(downstreamStreamBody, upstreamStreamBody);
});

test("openai: the codex_503 debug scenario forces a Codex outage response without contacting Codex", async () => {
  // The debug routing set covered 401, 403, and 429 - all auth or rate-limit
  // shapes. A provider outage is the remaining case: the upstream is
  // unreachable or degraded, which operators hit in production and cannot
  // otherwise reproduce on demand.
  const debugKey = keyToString(DEBUG_ROUTING_KEY);
  const previousDebugRouting = kvStore.get(debugKey);
  kvStore.set(debugKey, {
    scenario: "codex_503",
    expires_at_ms: Date.now() + 60_000,
    updated_at_ms: Date.now(),
  });
  resetDebugRoutingCacheForTest();

  let codexContacted = false;
  try {
    const response = await withFetchMock(
      (url) => {
        if (url.includes("chatgpt.com")) {
          codexContacted = true;
          throw new Error(`Codex must not be contacted while the outage is forced: ${url}`);
        }
        throw new Error(`no other provider is configured for this fixture: ${url}`);
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
          })
        )
    );

    // The scenario short-circuits before any Codex dispatch and surfaces a 503
    // that carries the Codex upstream identity.
    assert.equal(codexContacted, false, "the forced scenario must short-circuit before any Codex dispatch");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    assert.equal(payload.error?.code, "debug_forced_codex");
    assert.match(payload.error.message ?? "", /forced Codex 503/);
  } finally {
    if (previousDebugRouting === undefined) kvStore.delete(debugKey);
    else kvStore.set(debugKey, previousDebugRouting);
    resetDebugRoutingCacheForTest();
  }
});

test("openai: every codex debug scenario short-circuits without contacting Codex", async () => {
  // A table test so a future scenario cannot be added to the union and silently
  // fall through to a real upstream dispatch.
  const debugKey = keyToString(DEBUG_ROUTING_KEY);
  const previousDebugRouting = kvStore.get(debugKey);
  const scenarios = ["codex_401", "codex_403", "codex_429", "codex_503"] as const;
  const expected: Record<(typeof scenarios)[number], number> = {
    codex_401: 401,
    codex_403: 403,
    codex_429: 429,
    codex_503: 503,
  };

  try {
    for (const scenario of scenarios) {
      kvStore.set(debugKey, { scenario, expires_at_ms: Date.now() + 60_000, updated_at_ms: Date.now() });
      resetDebugRoutingCacheForTest();
      let contacted = false;
      const response = await withFetchMock(
        (url) => {
          if (url.includes("chatgpt.com")) {
            contacted = true;
            throw new Error(`Codex must not be contacted for ${scenario}`);
          }
          throw new Error(`unexpected upstream for ${scenario}: ${url}`);
        },
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
            })
          )
      );
      assert.equal(contacted, false, `${scenario} must short-circuit before dispatch`);
      assert.equal(response.status, expected[scenario], `${scenario} must surface its own status`);
    }
  } finally {
    if (previousDebugRouting === undefined) kvStore.delete(debugKey);
    else kvStore.set(debugKey, previousDebugRouting);
    resetDebugRoutingCacheForTest();
  }
});

test("openai: a forced debug scenario survives a non-2xx upstream to reach the client", async () => {
  // `toOpenAiUpstreamErrorResponse` rebuilds the header set from scratch for a
  // non-2xx upstream. It carries x-uos-upstream, x-uos-warning, and Retry-After
  // explicitly, so any other header the gateway set is dropped unless it is
  // named there too. The scenario name is useless if operators cannot read it
  // back, so this pins it.
  const debugKey = keyToString(DEBUG_ROUTING_KEY);
  const previousDebugRouting = kvStore.get(debugKey);
  kvStore.set(debugKey, {
    scenario: "codex_503",
    expires_at_ms: Date.now() + 60_000,
    updated_at_ms: Date.now(),
  });
  resetDebugRoutingCacheForTest();
  try {
    const response = await withFetchMock(
      () => {
        throw new Error("the forced scenario must short-circuit before any upstream call");
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
          })
        )
    );
    assert.equal(response.status, 503);
    assert.equal(
      response.headers.get("x-uos-debug-scenario"),
      "codex_503",
      "the operator must be able to read back which debug scenario produced this response"
    );
  } finally {
    if (previousDebugRouting === undefined) kvStore.delete(debugKey);
    else kvStore.set(debugKey, previousDebugRouting);
    resetDebugRoutingCacheForTest();
  }
});

test("openai: the admin debug routing endpoint accepts the codex_503 scenario", async () => {
  // The operator surface is the point of the feature: a scenario that the
  // endpoint rejects is not usable. setDebugRoutingConfig validates against the
  // SCENARIOS set, so this also proves the new member reached that set.
  const { handleAdminDebugRouting } = await import("../src/admin/index.ts");
  const debugKey = keyToString(DEBUG_ROUTING_KEY);
  try {
    const response = await handleAdminDebugRouting(
      new Request("https://ai.ubq.fi/admin/debug/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: "codex_503", duration_ms: 60_000 }),
      })
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { routing?: { scenario?: string; expires_at_ms?: number | null } };
    assert.equal(payload.routing?.scenario, "codex_503");
    assert.ok(typeof payload.routing.expires_at_ms === "number", "a non-normal scenario must carry an expiry");
  } finally {
    kvStore.delete(debugKey);
    resetDebugRoutingCacheForTest();
  }
});

test("openai: expired Codex auth returns a 503 re-auth warning through Responses", async () => {
  const authKey = keyToString(["ubq_ai", "codex_auth"]);
  const previousAuth = kvStore.get(authKey);
  const now = Date.now();
  let refreshCalls = 0;
  kvStore.set(authKey, {
    accounts: [
      {
        access_token: "expired-access-token",
        refresh_token: "expired-refresh-token",
        account_id: "expired-account",
        updated_at_ms: now - 10 * 60_000,
      },
    ],
    updated_at_ms: now - 10 * 60_000,
  } satisfies CodexAuthPoolState);

  try {
    const response = await withFetchMock(
      (url) => {
        if (url === "https://auth.openai.com/oauth/token") {
          refreshCalls += 1;
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Inference must not run with expired auth: ${url}`);
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
          })
        )
    );

    const payload = (await response.json()) as { error?: { code?: string; message?: string; type?: string } };
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-uos-warning"), CODEX_AUTH_REAUTH_WARNING);
    assert.equal(payload.error?.code, "codex_auth_invalid");
    assert.equal(payload.error.type, "server_error");
    assert.ok(payload.error.message?.includes(CODEX_AUTH_REAUTH_MESSAGE));
    assert.match(payload.error.message ?? "", /upload a fresh auth\.json/i);
    assert.equal(refreshCalls, 1);
  } finally {
    if (previousAuth === undefined) kvStore.delete(authKey);
    else kvStore.set(authKey, previousAuth);
    resetCodexAuthCacheForTest();
  }
});

test("openai: an expired access token makes a quota-shaped 403 actionable", async () => {
  const authKey = keyToString(["ubq_ai", "codex_auth"]);
  const previousAuth = kvStore.get(authKey);
  const now = Date.now();
  const expiredToken = `${encodeJsonBase64Url({ alg: "none" })}.${encodeJsonBase64Url({
    exp: Math.floor((now - 60_000) / 1000),
  })}.expired`;
  let inferenceCalls = 0;
  kvStore.set(authKey, {
    accounts: [
      {
        access_token: expiredToken,
        refresh_token: "expired-refresh-token",
        account_id: "expired-account",
        updated_at_ms: now,
      },
    ],
    updated_at_ms: now,
  } satisfies CodexAuthPoolState);

  try {
    const response = await withFetchMock(
      (url) => {
        if (url === "https://auth.openai.com/oauth/token") {
          return new Response(
            JSON.stringify({
              access_token: expiredToken,
              refresh_token: "rotated-refresh-token",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        inferenceCalls += 1;
        return new Response(JSON.stringify({ error: { message: "user quota is not enough" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
          })
        )
    );

    const payload = (await response.json()) as { error?: { message?: string } };
    // The expired credential is authoritatively invalidated, so the request
    // reports the actionable re-authentication outcome instead of replaying a
    // quota-shaped 403 that would look like provider capacity.
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-uos-warning"), CODEX_AUTH_REAUTH_WARNING);
    assert.ok(payload.error?.message?.includes(CODEX_AUTH_REAUTH_MESSAGE));
    assert.equal(inferenceCalls, 1);
  } finally {
    if (previousAuth === undefined) kvStore.delete(authKey);
    else kvStore.set(authKey, previousAuth);
    resetCodexAuthCacheForTest();
  }
});

test("openai: Terra Chat Completions accepts but omits the unsupported Codex completion cap", async () => {
  let recordedBody: Record<string, unknown> | null = null;

  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: TERRA_TEST_MODEL,
            messages: [{ role: "user", content: "ping" }],
            temperature: 0,
            max_completion_tokens: 2048,
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  const warnings = parseWarnings(response.headers.get("x-uos-warning"));
  assert.ok(warnings.includes("temperature_ignored"));
  assert.ok(warnings.includes("max_output_tokens_ignored"));
  assert.ok(recordedBody);
  const recorded = recordedBody as Record<string, unknown>;
  assert.equal(recorded.model, TERRA_TEST_MODEL);
  assert.equal("max_output_tokens" in recorded, false);
  assert.equal("max_completion_tokens" in recorded, false);
  assert.equal("temperature" in recorded, false);
});

test("openai: an id-less terminal response repeats Chat Completions content only once", async () => {
  const messageText = "ALPHA-BRAVO";
  const chatRequest = (stream: boolean): Request =>
    new Request("https://ai.ubq.fi/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: TERRA_TEST_MODEL, messages: [{ role: "user", content: "ping" }], stream }),
    });
  // Surplus streams the message with its item id and then repeats the complete
  // message inside `response.completed` without one.
  const frames = [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_repeat", created_at: 1_780_000_000 } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "msg_repeat", type: "message", role: "assistant", content: [] } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_repeat", output_index: 0, content_index: 0, delta: "ALPHA-" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_repeat", output_index: 0, content_index: 0, delta: "BRAVO" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_repeat", output_index: 0, content_index: 0, text: messageText })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.content_part.done",
      item_id: "msg_repeat",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: messageText },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "msg_repeat", type: "message", role: "assistant", content: [{ type: "output_text", text: messageText }] },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_repeat",
        model: TERRA_TEST_MODEL,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: messageText }] }],
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      },
    })}\n\n`,
  ];

  const streamed = await withFetchMock(
    () => sseResponse(frames),
    () => handleChatCompletions(chatRequest(true))
  );
  assert.equal(streamed.status, 200);
  const streamedText = (await streamed.text())
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => {
      const chunk = JSON.parse(frame.slice(6)) as { choices?: { delta?: { content?: unknown } }[] };
      const content = chunk.choices?.[0]?.delta?.content;
      return typeof content === "string" ? content : "";
    })
    .join("");
  assert.equal(streamedText, messageText);

  const buffered = await withFetchMock(
    () => sseResponse(frames),
    () => handleChatCompletions(chatRequest(false))
  );
  assert.equal(buffered.status, 200);
  const payload = (await buffered.json()) as { choices?: { message?: { content?: unknown } }[] };
  assert.equal(payload.choices?.[0]?.message?.content, messageText);
});

test("openai: a terminal response with no id and no deltas is still delivered", async () => {
  const messageText = "ALPHA-BRAVO";
  const frames = [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_terminal_only", created_at: 1_780_000_000 } })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        model: TERRA_TEST_MODEL,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: messageText }] }],
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      },
    })}\n\n`,
  ];
  const response = await withFetchMock(
    () => sseResponse(frames),
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: TERRA_TEST_MODEL, messages: [{ role: "user", content: "ping" }], stream: false }),
        })
      )
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  assert.equal(payload.choices?.[0]?.message?.content, messageText);
});

test("openai: prompt-cache sessions are stable within and isolated across authenticated principals", async () => {
  const identities: Record<string, string | null>[] = [];
  const responseStatuses = await withFetchMock(
    (_url, _bodyText, init) => {
      const headers = new Headers(init?.headers);
      identities.push({
        conversation: headers.get("conversation_id"),
        session: headers.get("session-id"),
        thread: headers.get("thread-id"),
        clientRequest: headers.get("x-client-request-id"),
      });
      return sseResponse(baseSseChunks());
    },
    async () => {
      const invoke = async (principal: string): Promise<number> => {
        const response = await handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              input: "stable prefix",
              prompt_cache_key: "shared-client-key",
            }),
          }),
          {
            keyId: null,
            kernelRepo: null,
            kernelOrg: null,
            idempotencyPrincipal: principal,
          }
        );
        return response.status;
      };
      return [await invoke("api-key:one"), await invoke("api-key:one"), await invoke("api-key:two")];
    }
  );

  assert.deepEqual(responseStatuses, [200, 200, 200]);
  assert.equal(identities.length, 3);
  assert.deepEqual(identities[1], identities[0]);
  assert.notEqual(identities[2]?.conversation, identities[0]?.conversation);
  for (const identity of identities) {
    assert.match(identity.conversation ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(identity.session, identity.conversation);
    assert.equal(identity.thread, identity.conversation);
    assert.equal(identity.clientRequest, identity.conversation);
  }
});
