import { test } from "bun:test";
import assert from "node:assert/strict";
import { extractChatUsageTokens, extractUsageTokens, toChatUsage } from "../src/openai-telemetry.ts";

const chatUsage = (details?: unknown): Record<string, unknown> => ({
  prompt_tokens: 100,
  completion_tokens: 10,
  total_tokens: 110,
  ...(details === undefined ? {} : { prompt_tokens_details: details }),
});

test("Chat and Responses cache usage retain identical reported, partial and invalid counters", () => {
  const cases = [
    undefined,
    { cached_tokens: 0 },
    { cached_tokens: 80, cache_write_tokens: 20 },
    { cached_tokens: 101 },
    { cached_tokens: -0.1 },
    { cached_tokens: 0.9 },
    { cached_tokens: "0" },
    { cached_tokens: 80, cache_write_tokens: 0.9 },
    { cached_tokens: 80, cache_write_tokens: -0.1 },
    null,
    [],
  ];
  for (const details of cases) {
    assert.deepEqual(
      extractChatUsageTokens(chatUsage(details)),
      extractUsageTokens({
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        ...(details === undefined ? {} : { input_tokens_details: details }),
      })
    );
  }
  for (const cachedTokens of [-0.1, 0.9]) {
    const usage = extractChatUsageTokens(chatUsage({ cached_tokens: cachedTokens }));
    assert.ok(usage);
    assert.equal(usage.cachedInputTokens, null, "a fractional counter must not become a measured cache miss");
    assert.equal(usage.status, "invalid");
  }
});

test("Chat usage preserves measured counters when another token field is missing or malformed", () => {
  assert.deepEqual(extractChatUsageTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }), {
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: null,
    outputTokens: null,
    totalTokens: null,
    status: "partial",
  });
  for (const promptTokens of [-0.1, 100.9, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(extractChatUsageTokens({ ...chatUsage({ cached_tokens: 80 }), prompt_tokens: promptTokens }), {
      inputTokens: null,
      cachedInputTokens: 80,
      cacheWriteInputTokens: null,
      outputTokens: 10,
      totalTokens: 110,
      status: "invalid",
    });
  }
});

test("usage translation keeps unmeasured cache counters absent and preserves measured zero", () => {
  assert.equal(extractChatUsageTokens(null), null);
  assert.equal(extractChatUsageTokens(undefined), null);
  assert.deepEqual(toChatUsage(extractChatUsageTokens(chatUsage())), chatUsage());
  assert.deepEqual(toChatUsage(extractChatUsageTokens(chatUsage({ cached_tokens: 0 }))), chatUsage({ cached_tokens: 0 }));
  assert.equal(toChatUsage(extractChatUsageTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } })), null);
});

test("usage retains an original exact Surplus charge and distinguishes absent or malformed amounts", () => {
  for (const buyerCostMicro of [0, 69, 1056]) {
    assert.equal(extractChatUsageTokens({ ...chatUsage({ cached_tokens: 0 }), buyer_cost_micro: buyerCostMicro })?.buyerCostMicro, buyerCostMicro);
    assert.equal(
      extractUsageTokens({
        input_tokens: 1043,
        output_tokens: 4,
        total_tokens: 1047,
        input_tokens_details: { cached_tokens: 1028 },
        buyer_cost_micro: buyerCostMicro,
      })?.buyerCostMicro,
      buyerCostMicro
    );
  }
  assert.equal(Object.prototype.hasOwnProperty.call(extractChatUsageTokens(chatUsage()), "buyerCostMicro"), false);
  for (const buyerCostMicro of [-1, 0.1, "69", Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    const usage = extractChatUsageTokens({ ...chatUsage({ cached_tokens: 0 }), buyer_cost_micro: buyerCostMicro });
    assert.equal(Object.prototype.hasOwnProperty.call(usage, "buyerCostMicro"), true);
    assert.equal(usage?.buyerCostMicro, null);
  }
});
