import { test, beforeEach, afterEach } from "bun:test";
import type { Kv } from "#kv";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 7 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  type CodexAuthPoolState,
  CountingKv,
  DEFAULT_TEST_MODEL,
  TEST_CODEX_MODELS_KEY,
  baseSseChunks,
  encodeJsonBase64Url,
  getResponseTelemetry,
  handleChatCompletions,
  handleResponses,
  keyToString,
  kvStore,
  parseWarnings,
  readPromptCacheAnalytics,
  recordPromptCacheAnalytics,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  resetRuntimeConfigCacheForTest,
  sseResponse,
  withFetchMock,
  withTerminalRequestLog,
} from "./helpers/openai-compat-harness.ts";

test("openai: cache token usage reaches Chat clients and internal telemetry", async () =>
  runSequence(async (step) => {
    const usage = {
      input_tokens: 2006,
      input_tokens_details: { cached_tokens: 1920, cache_write_tokens: 0 },
      output_tokens: 300,
      total_tokens: 2306,
    };
    const completed = () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_cache", created_at: 1 } })}\n\n`,
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            model: DEFAULT_TEST_MODEL,
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "cache telemetry output" }],
              },
            ],
            usage,
          },
        })}\n\n`,
      ]);

    await step("ttl-only cache options report the documented implicit mode", async () => {
      const response = await withFetchMock(
        () => completed(),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: DEFAULT_TEST_MODEL,
                prompt_cache_options: { ttl: "30m" },
                input: "ttl-only cache policy",
              }),
            })
          )
      );
      assert.equal(response.status, 200);
      assert.equal(getResponseTelemetry(response)?.promptCacheMode, "implicit");
    });

    await step("keyed Codex warnings retain cache usage through persisted analytics", async () => {
      const analyticsKv = new CountingKv();
      const analyticsNow = 1_800_000_000_000;
      const authKey = keyToString(["ubq_ai", "codex_auth"]);
      const routingKey = keyToString(CODEX_ACCOUNT_ROUTING_KV_KEY);
      const activeKey = keyToString(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY);
      const previousAuth = kvStore.get(authKey);
      const previousRouting = kvStore.get(routingKey);
      const previousActive = kvStore.get(activeKey);
      const now = Date.now();
      const accessToken = (label: string): string =>
        `${encodeJsonBase64Url({ alg: "none" })}.${encodeJsonBase64Url({ exp: Math.floor((now + 60 * 60_000) / 1_000) })}.${label}`;
      const accountOne = {
        access_token: accessToken("affinity-account-one"),
        refresh_token: "affinity-refresh-one",
        account_id: "affinity-account-one",
        updated_at_ms: now,
      };
      const accountTwo = {
        access_token: accessToken("affinity-account-two"),
        refresh_token: "affinity-refresh-two",
        account_id: "affinity-account-two",
        updated_at_ms: now,
      };
      const analyticsUsage = {
        input_tokens: 2048,
        input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 512 },
        output_tokens: 16,
        total_tokens: 2064,
      };
      const analyticsCompleted = () =>
        sseResponse([
          `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_cache_analytics" } })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              model: DEFAULT_TEST_MODEL,
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "cache analytics output" }],
                },
              ],
              usage: analyticsUsage,
            },
          })}\n\n`,
        ]);
      const requests = [
        {
          route: "chat.completions",
          request: new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              prompt_cache_key: "stable-analytics-key",
              prompt_cache_options: { ttl: "30m" },
              messages: [{ role: "user", content: "stable cache analytics prefix" }],
            }),
          }),
          handle: handleChatCompletions,
          expectsCacheOptionsWarning: true,
          expectedActiveGeneration: 1,
          expectedAccountId: accountTwo.account_id,
          expectedPromptCacheMode: "implicit",
          accounts: [accountTwo, accountOne],
        },
        {
          route: "responses",
          request: new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              prompt_cache_key: "stable-analytics-key",
              input: "stable cache analytics prefix",
            }),
          }),
          handle: handleResponses,
          expectsCacheOptionsWarning: false,
          expectedActiveGeneration: 1,
          expectedAccountId: accountTwo.account_id,
          expectedPromptCacheMode: "unspecified",
          accounts: [accountTwo],
        },
      ] as const;

      try {
        for (const [index, fixture] of requests.entries()) {
          const keyId = `affinity-analytics-${index}`;
          const principal = `api-key:${keyId}`;
          kvStore.set(authKey, { accounts: fixture.accounts, updated_at_ms: now } satisfies CodexAuthPoolState);
          // Each principal fixture starts from a cold bootstrap so the first
          // configured account is elected with active generation 1.
          kvStore.delete(routingKey);
          kvStore.delete(activeKey);
          resetCodexAuthCacheForTest();
          resetCodexAccountRoutingForTest();

          const forwarded: { body: Record<string, unknown> | null; accountId: string | null } = {
            body: null,
            accountId: null,
          };
          const response = await withFetchMock(
            (_url, bodyText, init) => {
              forwarded.body = JSON.parse(bodyText ?? "{}") as Record<string, unknown>;
              forwarded.accountId = new Headers(init?.headers).get("ChatGPT-Account-ID");
              return analyticsCompleted();
            },
            () =>
              fixture.handle(fixture.request, {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                idempotencyPrincipal: principal,
              })
          );
          assert.equal(response.status, 200);
          assert.equal(forwarded.accountId, fixture.expectedAccountId);
          assert.equal(forwarded.body?.prompt_cache_key, "stable-analytics-key");
          assert.equal(Object.prototype.hasOwnProperty.call(forwarded.body, "prompt_cache_options"), false);
          if (fixture.expectsCacheOptionsWarning) {
            assert.match(response.headers.get("x-uos-warning") ?? "", /prompt_cache_options_ignored/);
          } else {
            assert.doesNotMatch(response.headers.get("x-uos-warning") ?? "", /prompt_cache_options_ignored/);
          }
          assert.equal(getResponseTelemetry(response)?.activeGeneration, fixture.expectedActiveGeneration);
          assert.equal(getResponseTelemetry(response)?.activeTransitionReason, null);
          assert.equal(getResponseTelemetry(response)?.promptCacheKeyPresent, true);
          assert.equal(getResponseTelemetry(response)?.cachedInputTokens, 1024);
          assert.equal(getResponseTelemetry(response)?.cacheWriteInputTokens, 512);

          const recordedAnalyticsEvents: Parameters<typeof recordPromptCacheAnalytics>[0][] = [];
          const logged = await withTerminalRequestLog(response, {
            route: fixture.route,
            startedAtMonotonicMs: performance.now(),
            requestId: `cache-analytics-${index}`,
            recordCacheAnalytics: (event) => {
              recordedAnalyticsEvents.push(event);
              return recordPromptCacheAnalytics(event, {
                kv: analyticsKv as unknown as Kv,
                release: "0123456789abcdef0123456789abcdef01234567",
                now: () => analyticsNow,
              });
            },
            recordTelemetry: () =>
              Promise.resolve({
                status: "ignored" as const,
                reason: "unknown_release" as const,
                release: null,
                provider: null,
                route: null,
                model_hash: null,
              }),
          });
          const recordedAnalyticsEvent = recordedAnalyticsEvents[0];
          assert.ok(recordedAnalyticsEvent);
          assert.deepEqual(
            {
              provider: recordedAnalyticsEvent.provider,
              model: recordedAnalyticsEvent.model,
              route: recordedAnalyticsEvent.route,
              promptCacheKeyPresent: recordedAnalyticsEvent.promptCacheKeyPresent,
              promptCacheMode: recordedAnalyticsEvent.promptCacheMode,
              fallbackReason: recordedAnalyticsEvent.fallbackReason,
            },
            {
              provider: "chatgpt_codex",
              model: DEFAULT_TEST_MODEL,
              route: fixture.route,
              promptCacheKeyPresent: true,
              promptCacheMode: fixture.expectedPromptCacheMode,
              fallbackReason: null,
            }
          );
          assert.equal("affinityOutcome" in recordedAnalyticsEvent, false);
          assert.equal("activeGeneration" in recordedAnalyticsEvent, false);
          await logged.body?.cancel();
        }
      } finally {
        if (previousAuth === undefined) kvStore.delete(authKey);
        else kvStore.set(authKey, previousAuth);
        if (previousRouting === undefined) kvStore.delete(routingKey);
        else kvStore.set(routingKey, previousRouting);
        if (previousActive === undefined) kvStore.delete(activeKey);
        else kvStore.set(activeKey, previousActive);
        resetCodexAuthCacheForTest();
        resetCodexAccountRoutingForTest();
      }

      const analytics = await readPromptCacheAnalytics({
        kv: analyticsKv as unknown as Kv,
        now: () => analyticsNow,
      });
      assert.deepEqual(analytics.buckets[0], {
        bucket_start_at_ms: analyticsNow,
        bucket_end_at_ms: analyticsNow + 15 * 60_000,
        input_tokens: 4096,
        cached_input_tokens: 2048,
        cache_write_input_tokens: 1024,
        cache_write_reported_sample_count: 2,
        cached_percentage: 50,
        sample_count: 2,
      });
    });

    await step("buffered Chat maps standard usage details", async () => {
      const response = await withFetchMock(
        () => completed(),
        () => {
          // Start from a cold active row so the single configured account
          // bootstraps at active generation 1 for this fixture.
          kvStore.delete(keyToString(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY));
          return handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, messages: [{ role: "user", content: "ping" }] }),
            })
          );
        }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { usage?: Record<string, unknown> };
      assert.deepEqual(body.usage, {
        prompt_tokens: 2006,
        completion_tokens: 300,
        total_tokens: 2306,
        prompt_tokens_details: { cached_tokens: 1920, cache_write_tokens: 0 },
      });
      assert.deepEqual(getResponseTelemetry(response), {
        provider: "chatgpt_codex",
        fallbackReason: null,
        model: DEFAULT_TEST_MODEL,
        reasoning: "low",
        outputTokenAllowance: null,
        rateLimitWaitMs: null,
        rateLimitFailoverModel: null,
        inputTokens: 2006,
        cachedInputTokens: 1920,
        cacheWriteInputTokens: 0,
        outputTokens: 300,
        totalTokens: 2306,
        usageObserved: true,
        usageTelemetryStatus: "reported",
        promptCacheKeyPresent: false,
        promptCacheMode: "unspecified",
        explicitBreakpointCount: 0,
        accountSlot: 1,
        activeGeneration: 1,
        activeTransitionReason: null,
        quotaUsedPercent: undefined,
        completed: true,
        semanticOutputObserved: true,
        upstreamEventKinds: ["response.created", "response.completed"],
        streamTerminalType: "response.completed",
        failureKind: null,
        responseCreatedObserved: true,
        syntheticTerminalType: null,
        stream: false,
        providerRequestId: null,
        firstProviderDispatchMs: null,
        firstProviderHeadersMs: null,
        firstCodexDispatchMs: null,
        firstCodexHeadersMs: null,
        firstUpstreamSseEventMs: null,
        firstSemanticCommitmentMs: null,
        streamTerminalMs: null,
        attemptedProviders: ["chatgpt_codex"],
        removedProviderTriggerClass: null,
        removedProviderCircuitTransition: null,
        removedProviderSelectedModel: null,
        removedProviderTaskType: null,
        removedProviderSemanticCommitment: null,
        removedProviderLatencyMs: null,
        removedProviderTerminalStatus: null,
      });
    });

    await step("streamed Chat emits the standard final usage chunk only when requested", async () => {
      const response = await withFetchMock(
        () => completed(),
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: DEFAULT_TEST_MODEL,
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: "user", content: "ping" }],
              }),
            })
          )
      );
      const text = await response.text();
      const usageChunk = text.split("\n\n").find((chunk) => chunk.includes('"choices":[]')) ?? "";
      assert.ok(usageChunk);
      assert.match(usageChunk, /"cached_tokens":1920/);
      assert.match(usageChunk, /"cache_write_tokens":0/);
      assert.ok(text.indexOf(usageChunk) < text.indexOf("data: [DONE]"));
    });

    await step("streamed Chat records cache telemetry without a requested public usage chunk", async () => {
      const response = await withFetchMock(
        () => completed(),
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: DEFAULT_TEST_MODEL,
                stream: true,
                messages: [{ role: "user", content: "ping" }],
              }),
            })
          )
      );
      const text = await response.text();
      assert.doesNotMatch(text, /"choices":\[\]/);
      assert.equal(getResponseTelemetry(response)?.cachedInputTokens, 1920);
      assert.equal(getResponseTelemetry(response)?.cacheWriteInputTokens, 0);
      assert.equal(getResponseTelemetry(response)?.usageTelemetryStatus, "reported");
    });

    await step("streamed Responses preserves cache usage bytes while recording the same telemetry", async () => {
      const response = await withFetchMock(
        () => completed(),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, stream: true, input: "ping" }),
            })
          )
      );
      const text = await response.text();
      assert.match(text, /"cached_tokens":1920/);
      assert.match(text, /"cache_write_tokens":0/);
      assert.equal(getResponseTelemetry(response)?.cachedInputTokens, 1920);
      assert.equal(getResponseTelemetry(response)?.cacheWriteInputTokens, 0);
      assert.equal(getResponseTelemetry(response)?.usageTelemetryStatus, "reported");
    });

    await step("failed, partial, and invalid provider usage remains observable without fabricating public values", async () => {
      const failed = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.failed",
              response: {
                model: DEFAULT_TEST_MODEL,
                status: "failed",
                usage: {
                  input_tokens: 100,
                  input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 },
                  output_tokens: 0,
                  total_tokens: 100,
                },
              },
            })}\n\n`,
          ]),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "fail" }),
            })
          )
      );
      assert.equal(failed.status, 200);
      assert.deepEqual(getResponseTelemetry(failed), {
        ...getResponseTelemetry(failed),
        completed: false,
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        totalTokens: 100,
        usageObserved: true,
        usageTelemetryStatus: "reported",
        streamTerminalType: "response.failed",
      });

      const partial = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                model: DEFAULT_TEST_MODEL,
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "partial usage output" }],
                  },
                ],
                usage: { input_tokens: 11, input_tokens_details: { cached_tokens: 10 } },
              },
            })}\n\n`,
          ]),
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, messages: [{ role: "user", content: "partial" }] }),
            })
          )
      );
      assert.equal(((await partial.json()) as { usage?: unknown }).usage, undefined);
      assert.equal(getResponseTelemetry(partial)?.cachedInputTokens, 10);
      assert.equal(getResponseTelemetry(partial)?.usageTelemetryStatus, "partial");

      const absentCachedTokens = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                model: DEFAULT_TEST_MODEL,
                output: [
                  {
                    id: "msg_absent_cached_tokens",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  },
                ],
                usage: { input_tokens: 11, output_tokens: 0, total_tokens: 11 },
              },
            })}\n\n`,
          ]),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "missing cache detail" }),
            })
          )
      );
      assert.equal(getResponseTelemetry(absentCachedTokens)?.usageObserved, true);
      assert.equal(getResponseTelemetry(absentCachedTokens)?.cachedInputTokens, null);
      assert.equal(getResponseTelemetry(absentCachedTokens)?.usageTelemetryStatus, "partial");

      const absentUsage = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                model: DEFAULT_TEST_MODEL,
                output: [
                  {
                    id: "msg_absent_usage",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  },
                ],
              },
            })}\n\n`,
          ]),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "absent usage" }),
            })
          )
      );
      assert.equal(getResponseTelemetry(absentUsage)?.usageObserved, false);
      assert.equal(getResponseTelemetry(absentUsage)?.usageTelemetryStatus, "missing");
      assert.equal("usage" in ((await absentUsage.json()) as Record<string, unknown>), false);

      const cacheReadAboveInput = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                model: DEFAULT_TEST_MODEL,
                output: [
                  {
                    id: "msg_cache_read_above_input",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  },
                ],
                usage: {
                  input_tokens: 10,
                  input_tokens_details: { cached_tokens: 11 },
                  output_tokens: 0,
                  total_tokens: 10,
                },
              },
            })}\n\n`,
          ]),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "cache read above input" }),
            })
          )
      );
      assert.equal(getResponseTelemetry(cacheReadAboveInput)?.cachedInputTokens, 11);
      assert.equal(getResponseTelemetry(cacheReadAboveInput)?.usageTelemetryStatus, "invalid");

      const overlappingCacheAccounting = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                model: DEFAULT_TEST_MODEL,
                output: [
                  {
                    id: "msg_overlapping_cache_accounting",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  },
                ],
                usage: {
                  input_tokens: 100,
                  input_tokens_details: { cached_tokens: 80, cache_write_tokens: 80 },
                  output_tokens: 0,
                  total_tokens: 100,
                },
              },
            })}\n\n`,
          ]),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "overlapping cache accounting" }),
            })
          )
      );
      assert.equal(getResponseTelemetry(overlappingCacheAccounting)?.cachedInputTokens, 80);
      assert.equal(getResponseTelemetry(overlappingCacheAccounting)?.cacheWriteInputTokens, 80);
      assert.equal(getResponseTelemetry(overlappingCacheAccounting)?.usageTelemetryStatus, "reported");

      const inconsistentUsage = {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 1,
        total_tokens: 12,
      };
      const inconsistentTotals = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                model: DEFAULT_TEST_MODEL,
                output: [
                  {
                    id: "msg_inconsistent_totals",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  },
                ],
                usage: inconsistentUsage,
              },
            })}\n\n`,
          ]),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "inconsistent totals" }),
            })
          )
      );
      assert.equal(getResponseTelemetry(inconsistentTotals)?.usageTelemetryStatus, "invalid");
      assert.deepEqual(((await inconsistentTotals.json()) as { usage?: unknown }).usage, inconsistentUsage);

      const incomplete = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.incomplete",
              response: {
                model: DEFAULT_TEST_MODEL,
                status: "incomplete",
                usage: {
                  input_tokens: 100,
                  input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 },
                  output_tokens: 0,
                  total_tokens: 100,
                },
              },
            })}\n\n`,
          ]),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "incomplete" }),
            })
          )
      );
      assert.equal(incomplete.status, 200);
      assert.deepEqual(getResponseTelemetry(incomplete), {
        ...getResponseTelemetry(incomplete),
        completed: false,
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        totalTokens: 100,
        usageObserved: true,
        usageTelemetryStatus: "reported",
        streamTerminalType: "response.incomplete",
      });

      const malformedUsage = await withFetchMock(
        () =>
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                model: DEFAULT_TEST_MODEL,
                output: [
                  {
                    id: "msg_malformed_usage",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  },
                ],
                usage: null,
              },
            })}\n\n`,
          ]),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "malformed usage" }),
            })
          )
      );
      assert.equal(getResponseTelemetry(malformedUsage)?.usageObserved, true);
      assert.equal(getResponseTelemetry(malformedUsage)?.usageTelemetryStatus, "invalid");
    });
  }));

test("openai: accepts standard cache breakpoints but omits them from the Codex wire", async () =>
  runSequence(async (step) => {
    await step("Responses preserves content while omitting breakpoints", async () => {
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
                prompt_cache_options: { mode: "explicit" },
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [
                      { type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } },
                      {
                        type: "input_image",
                        image_url: "https://example.test/stable.png",
                        prompt_cache_breakpoint: { mode: "explicit" },
                      },
                      {
                        type: "input_file",
                        file_id: "file_stable",
                        detail: "high",
                        prompt_cache_breakpoint: { mode: "explicit" },
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
      assert.ok(warnings.includes("prompt_cache_breakpoint_ignored"));
      assert.ok(recordedBody);
      const recorded = recordedBody as unknown as Record<string, unknown>;
      const content = ((recorded.input as Record<string, unknown>[])[0]?.content ?? []) as Record<string, unknown>[];
      assert.deepEqual(
        content.map((item) => item.prompt_cache_breakpoint),
        [undefined, undefined, undefined]
      );
      assert.deepEqual(content[2], {
        type: "input_file",
        file_id: "file_stable",
        detail: "high",
      });
    });

    await step("Responses preserves function-call output content and file detail", async () => {
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
                prompt_cache_options: { mode: "explicit" },
                input: [
                  {
                    type: "function_call_output",
                    call_id: "call_cache_result",
                    output: [
                      { type: "input_text", text: "stable tool result", prompt_cache_breakpoint: { mode: "explicit" } },
                      {
                        type: "input_image",
                        image_url: "https://example.test/tool-result.png",
                        prompt_cache_breakpoint: { mode: "explicit" },
                      },
                      {
                        type: "input_file",
                        file_id: "file_tool_result",
                        detail: "low",
                        prompt_cache_breakpoint: { mode: "explicit" },
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
      assert.ok(warnings.includes("prompt_cache_breakpoint_ignored"));
      assert.ok(recordedBody);
      const input = (recordedBody as unknown as Record<string, unknown>).input as Record<string, unknown>[];
      assert.deepEqual(input[0]?.output, [
        { type: "input_text", text: "stable tool result" },
        {
          type: "input_image",
          image_url: "https://example.test/tool-result.png",
        },
        {
          type: "input_file",
          file_id: "file_tool_result",
          detail: "low",
        },
      ]);
      assert.equal(getResponseTelemetry(response)?.explicitBreakpointCount, 3);
    });

    await step("Chat preserves text/image and ordered developer input while omitting breakpoints", async () => {
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
                model: DEFAULT_TEST_MODEL,
                prompt_cache_key: "stable-support-prefix",
                prompt_cache_options: { mode: "explicit" },
                messages: [
                  {
                    role: "system",
                    content: [{ type: "text", text: "stable system", prompt_cache_breakpoint: { mode: "explicit" } }],
                  },
                  { role: "developer", content: [{ type: "text", text: "second stable instruction" }] },
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "question", prompt_cache_breakpoint: { mode: "explicit" } },
                      {
                        type: "image_url",
                        image_url: { url: "https://example.test/question.png" },
                        prompt_cache_breakpoint: { mode: "explicit" },
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
      assert.ok(warnings.includes("prompt_cache_breakpoint_ignored"));
      assert.ok(recordedBody);
      const recorded = recordedBody as unknown as Record<string, unknown>;
      assert.equal("instructions" in recorded, false);
      const input = recorded.input as Record<string, unknown>[];
      assert.deepEqual(
        input.map((item) => item.role),
        ["developer", "developer", "user"]
      );
      const first = input[0]?.content as Record<string, unknown>[];
      const last = input[2]?.content as Record<string, unknown>[];
      assert.equal(first[0]?.prompt_cache_breakpoint, undefined);
      assert.deepEqual(
        last.map((item) => item.prompt_cache_breakpoint),
        [undefined, undefined]
      );
      assert.equal(getResponseTelemetry(response)?.explicitBreakpointCount, 3);
      assert.equal(getResponseTelemetry(response)?.promptCacheKeyPresent, true);
      assert.equal(getResponseTelemetry(response)?.promptCacheMode, "explicit");
    });

    await step("Chat rejects a breakpoint on assistant output content", async () => {
      const response = await handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "prior reply", prompt_cache_breakpoint: { mode: "explicit" } }],
              },
              { role: "user", content: "continue" },
            ],
          }),
        })
      );
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error?: { param?: string } };
      assert.equal(body.error?.param, "messages[0].content[0].prompt_cache_breakpoint");
    });

    await step("Chat preserves tool output while omitting its breakpoint", async () => {
      let dispatches = 0;
      let recordedBody: Record<string, unknown> | null = null;
      const response = await withFetchMock(
        (_url, bodyText) => {
          dispatches += 1;
          recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
          return sseResponse(baseSseChunks());
        },
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: DEFAULT_TEST_MODEL,
                messages: [
                  {
                    role: "tool",
                    tool_call_id: "call_stable_tool_output",
                    content: [
                      {
                        type: "text",
                        text: "stable tool result",
                        prompt_cache_breakpoint: { mode: "explicit" },
                      },
                    ],
                  },
                ],
              }),
            })
          )
      );
      assert.equal(response.status, 200);
      assert.ok(parseWarnings(response.headers.get("x-uos-warning")).includes("prompt_cache_breakpoint_ignored"));
      assert.equal(dispatches, 1);
      assert.ok(recordedBody);
      const input = (recordedBody as unknown as Record<string, unknown>).input as Record<string, unknown>[];
      assert.deepEqual(input[0]?.output, [{ type: "input_text", text: "stable tool result" }]);
      assert.equal(getResponseTelemetry(response)?.explicitBreakpointCount, 1);
    });

    await step("Chat maps native file parts and preserves an interleaved developer prefix", async () => {
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
                model: DEFAULT_TEST_MODEL,
                prompt_cache_options: { mode: "explicit" },
                messages: [
                  {
                    role: "system",
                    content: [{ type: "text", text: "stable system", prompt_cache_breakpoint: { mode: "explicit" } }],
                  },
                  { role: "user", content: "first question" },
                  { role: "developer", content: [{ type: "text", text: "stable developer" }] },
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "Read these files", prompt_cache_breakpoint: { mode: "explicit" } },
                      {
                        type: "file",
                        file: { file_id: "file_stable", filename: "stable.txt" },
                        prompt_cache_breakpoint: { mode: "explicit" },
                      },
                      {
                        type: "file",
                        file: { file_data: "data:text/plain;base64,c3RhYmxl", filename: "inline.txt" },
                        prompt_cache_breakpoint: { mode: "explicit" },
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
      assert.ok(warnings.includes("prompt_cache_breakpoint_ignored"));
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      assert.equal("instructions" in recorded, false);
      const input = recorded.input as Record<string, unknown>[];
      assert.deepEqual(
        input.map((item) => item.role),
        ["developer", "user", "developer", "user"]
      );
      assert.deepEqual(input[0]?.content, [{ type: "input_text", text: "stable system" }]);
      assert.deepEqual(input[2]?.content, [{ type: "input_text", text: "stable developer" }]);
      assert.deepEqual(input[3]?.content, [
        { type: "input_text", text: "Read these files" },
        {
          type: "input_file",
          file_id: "file_stable",
          filename: "stable.txt",
        },
        {
          type: "input_file",
          file_data: "data:text/plain;base64,c3RhYmxl",
          filename: "inline.txt",
        },
      ]);
      assert.equal(getResponseTelemetry(response)?.explicitBreakpointCount, 4);
    });
  }));

test("openai: identical cacheable Chat requests render byte-identical upstream bodies", async () => {
  const bodies: string[] = [];
  const requestBody = {
    model: DEFAULT_TEST_MODEL,
    prompt_cache_key: "stable-cache-prefix",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: "Stable instructions", prompt_cache_breakpoint: { mode: "explicit" } }],
      },
      { role: "user", content: [{ type: "text", text: "Variable question" }] },
    ],
  };

  await withFetchMock(
    (_url, bodyText) => {
      assert.ok(bodyText);
      bodies.push(bodyText);
      return sseResponse(baseSseChunks());
    },
    async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await handleChatCompletions(
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          })
        );
        assert.equal(response.status, 200);
      }
    }
  );

  assert.deepEqual(bodies, [bodies[0], bodies[0]]);
  assert.doesNotMatch(bodies[0], /"(?:account_id|conversation_id|request_id|timestamp)"/);
});

test("openai: known-unsupported prompt caching rejects controls and breakpoints before dispatch", async () =>
  runSequence(async (step) => {
    const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
    const runtimeConfigKey = keyToString(["uos_ai", "runtime_config", "v2"]);
    const previousSnapshot = kvStore.get(snapshotKey);
    const previousRuntimeConfig = kvStore.get(runtimeConfigKey);
    kvStore.set(snapshotKey, {
      source: "chatgpt_codex",
      client_version: "0.125.0",
      updated_at_ms: Date.now(),
      models: [
        {
          slug: DEFAULT_TEST_MODEL,
          supported_reasoning_levels: ["none", "medium"],
          prompt_cache: false,
        },
      ],
    });

    const cases = [
      {
        route: "responses",
        body: { input: "ping", prompt_cache_options: { mode: "implicit" } },
        param: "prompt_cache_options",
      },
      {
        route: "responses",
        body: {
          input: [{ type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }],
        },
        param: "input[0].prompt_cache_breakpoint",
      },
      {
        route: "chat.completions",
        body: {
          messages: [{ role: "user", content: "ping" }],
          prompt_cache_key: "stable-prefix",
        },
        param: "prompt_cache_key",
      },
      {
        route: "chat.completions",
        body: {
          messages: [{ role: "user", content: "ping" }],
          prompt_cache_retention: "24h",
        },
        param: "prompt_cache_retention",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }],
            },
          ],
        },
        param: "messages[0].content[0].prompt_cache_breakpoint",
      },
      {
        route: "responses",
        body: {
          input: [
            {
              type: "function_call_output",
              call_id: "call_cache_result",
              output: [
                {
                  type: "input_text",
                  text: "stable tool result",
                  prompt_cache_breakpoint: { mode: "explicit" },
                },
              ],
            },
          ],
        },
        param: "input[0].output[0].prompt_cache_breakpoint",
      },
    ] as const;

    try {
      for (const testCase of cases) {
        await step(`${testCase.route}/${testCase.param}`, async () => {
          let dispatches = 0;
          const response = await withFetchMock(
            () => {
              dispatches += 1;
              return sseResponse(baseSseChunks());
            },
            () =>
              testCase.route === "chat.completions"
                ? handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                    })
                  )
                : handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                    })
                  )
          );
          assert.equal(response.status, 400);
          assert.equal(dispatches, 0);
          const payload = (await response.json()) as { error?: { message?: string; type?: string; param?: string } };
          assert.equal(payload.error?.message, `Prompt caching is not supported for model '${DEFAULT_TEST_MODEL}'.`);
          assert.equal(payload.error.type, "invalid_request_error");
          assert.equal(payload.error.param, testCase.param);
        });
      }

      await step("omitted metadata remains unknown and forwards standard controls", async () => {
        kvStore.set(snapshotKey, {
          source: "chatgpt_codex",
          client_version: "0.125.0",
          updated_at_ms: Date.now(),
          models: [{ slug: DEFAULT_TEST_MODEL, supported_reasoning_levels: ["none", "medium"] }],
        });

        let dispatches = 0;
        const response = await withFetchMock(
          () => {
            dispatches += 1;
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
                  prompt_cache_options: { mode: "implicit" },
                }),
              })
            )
        );
        assert.equal(response.status, 200);
        assert.equal(dispatches, 1);
      });
    } finally {
      if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
      else kvStore.set(snapshotKey, previousSnapshot);
      if (previousRuntimeConfig === undefined) kvStore.delete(runtimeConfigKey);
      else kvStore.set(runtimeConfigKey, previousRuntimeConfig);
      resetRuntimeConfigCacheForTest();
    }
  }));
