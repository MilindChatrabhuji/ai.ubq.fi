import assert from "node:assert/strict";
import { toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";
import { CEREBRAS_RESPONSES_PROFILE, DEEPSEEK_RESPONSES_PROFILE, LITHOS_RESPONSES_PROFILE } from "../src/deepseek/responses.ts";
import { CEREBRAS_QWEN_3_8_27B_MODEL } from "../src/provider/cerebras.ts";

Deno.test("Responses translation preserves Cerebras's documented caller cache key without inventing controls", () => {
  const request = {
    input: "Stable prefix",
    prompt_cache_key: "explicit-stable-key",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "24h",
  };
  const original = structuredClone(request);
  const translated = toDeepSeekResponsesChatBody(request, CEREBRAS_QWEN_3_8_27B_MODEL, false, CEREBRAS_RESPONSES_PROFILE);
  assert.equal(translated.ok, true);
  assert.equal(translated.value.body.prompt_cache_key, request.prompt_cache_key);
  assert.equal(Object.hasOwn(translated.value.body, "prompt_cache_options"), false);
  assert.equal(Object.hasOwn(translated.value.body, "prompt_cache_retention"), false);
  assert.deepEqual(request, original);

  const unkeyed = toDeepSeekResponsesChatBody({ input: request.input }, CEREBRAS_QWEN_3_8_27B_MODEL, false, CEREBRAS_RESPONSES_PROFILE);
  assert.equal(unkeyed.ok, true);
  assert.equal(Object.hasOwn(unkeyed.value.body, "prompt_cache_key"), false);
});

Deno.test("implicit provider profiles retain their existing wire without asserting unverified cache controls", () => {
  for (const [profile, model] of [
    [DEEPSEEK_RESPONSES_PROFILE, "deepseek-flash"],
    [LITHOS_RESPONSES_PROFILE, "deepseek-ai/DeepSeek-V4.1-Flash"],
  ] as const) {
    const translated = toDeepSeekResponsesChatBody(
      { input: "Stable prefix", prompt_cache_key: "explicit-key", prompt_cache_options: { mode: "implicit" }, prompt_cache_retention: "24h" },
      model,
      false,
      profile
    );
    assert.equal(translated.ok, true);
    for (const field of ["prompt_cache_key", "prompt_cache_options", "prompt_cache_retention", "cache_control"]) {
      assert.equal(Object.hasOwn(translated.value.body, field), false);
    }
  }
});
