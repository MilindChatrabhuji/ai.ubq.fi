import { test } from "bun:test";
import assert from "node:assert/strict";

import { normalizeCerebrasChatCompletion } from "../src/provider/cerebras.ts";

const completion = (usage: unknown): Record<string, unknown> => ({
  id: "chatcmpl-cerebras-1",
  object: "chat.completion",
  created: 1_780_000_000,
  model: "gpt-oss-120b",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage,
});

const usageOf = (usage: unknown): unknown => {
  const result = normalizeCerebrasChatCompletion(completion(usage), "gpt-oss-120b");
  if (!result.ok) throw new Error(`expected the Cerebras usage to normalize: ${result.message}`);
  return result.value.usage;
};

test("cerebras: relays the documented cache-read and reasoning counters under their official names", () => {
  // Shaped like a real gpt-oss-120b response: the provider nests the counters
  // beside prediction bookkeeping this gateway does not report.
  assert.deepEqual(
    usageOf({
      prompt_tokens: 4472,
      completion_tokens: 31,
      total_tokens: 4503,
      prompt_tokens_details: { cached_tokens: 4352, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 20, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
    }),
    {
      prompt_tokens: 4472,
      completion_tokens: 31,
      total_tokens: 4503,
      prompt_tokens_details: { cached_tokens: 4352 },
      completion_tokens_details: { reasoning_tokens: 20 },
    }
  );
});

test("cerebras: an unreported counter stays absent instead of becoming a measured zero", () => {
  assert.deepEqual(usageOf({ prompt_tokens: 71, completion_tokens: 31, total_tokens: 102 }), {
    prompt_tokens: 71,
    completion_tokens: 31,
    total_tokens: 102,
  });
  // An explicit provider zero is a measurement, so it is relayed as one.
  assert.deepEqual(usageOf({ prompt_tokens: 71, completion_tokens: 31, total_tokens: 102, prompt_tokens_details: { cached_tokens: 0 } }), {
    prompt_tokens: 71,
    completion_tokens: 31,
    total_tokens: 102,
    prompt_tokens_details: { cached_tokens: 0 },
  });
});

test("cerebras: a counter larger than the total it is a subset of is dropped as unreadable", () => {
  assert.deepEqual(usageOf({ prompt_tokens: 71, completion_tokens: 31, total_tokens: 102, prompt_tokens_details: { cached_tokens: 72 } }), {
    prompt_tokens: 71,
    completion_tokens: 31,
    total_tokens: 102,
  });
  assert.deepEqual(usageOf({ prompt_tokens: 71, completion_tokens: 31, total_tokens: 102, completion_tokens_details: { reasoning_tokens: 32 } }), {
    prompt_tokens: 71,
    completion_tokens: 31,
    total_tokens: 102,
  });
});
