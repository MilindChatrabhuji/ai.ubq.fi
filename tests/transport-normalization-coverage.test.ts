import { test } from "bun:test";
import assert from "node:assert/strict";

import { CodexError } from "../src/codex/index.ts";
import {
  normalizeChatMessage,
  normalizeFunctionCallOutputItem,
  normalizeModelList,
  normalizeResponseContentItem,
  normalizeResponseMessageItem,
  validatePromptCacheControls,
} from "../src/input-normalization.ts";
import { ApiKeyQuotaDispatchError } from "../src/api-key-policy.ts";
import { CerebrasError } from "../src/provider/cerebras.ts";
import { DeepSeekError } from "../src/deepseek/index.ts";
import { LithosError } from "../src/provider/lithos.ts";
import { MeteredError } from "../src/provider/metered.ts";
import { SurplusError } from "../src/provider/surplus.ts";
import {
  apiKeyQuotaDispatchErrorResponse,
  cancelResponseBody,
  chatChunkHasAnswerBearingOutput,
  chatCompletionHasAnswerBearingOutput,
  deepSeekChatBodyDiagnostic,
  formatErrorSnippet,
  isAnswerBearingCompletion,
  logRedactedUpstreamError,
  normalizeProviderRequestId,
  providerRequestIdFromResponse,
  streamCerebrasChatCompletion,
  toCerebrasErrorResponse,
  toCerebrasUpstreamErrorResponse,
  toCodexErrorResponse,
  toDeepSeekErrorResponse,
  toDeepSeekUpstreamErrorResponse,
  toLithosErrorResponse,
  toLithosUpstreamErrorResponse,
  toPreHeaderErrorResponse,
} from "../src/upstream-wire.ts";

/**
 * Coverage for the Chat/Responses input normalizers and the upstream wire
 * helpers. Every case asserts the observable contract of the function under
 * test: normalized values, the exact `{ ok: false, param, message }` rejection,
 * or the HTTP status/body/headers of a translated upstream error.
 */

/** Serialized Responses input items of an accepted Chat message, or an empty list. */
const messageInput = (result: ReturnType<typeof normalizeChatMessage>): unknown[] => {
  if (!result.ok) assert.fail(`${result.param}: ${result.message}`);
  return [...result.value.input];
};

test("prompt cache controls: accepts the documented fields and rejects every malformed one", () => {
  assert.deepEqual(validatePromptCacheControls({}), { ok: true, value: undefined });
  assert.deepEqual(validatePromptCacheControls({ prompt_cache_key: "key", prompt_cache_retention: "24h" }), { ok: true, value: undefined });
  assert.deepEqual(validatePromptCacheControls({ prompt_cache_options: { mode: "implicit", ttl: "30m" } }), { ok: true, value: undefined });

  assert.deepEqual(validatePromptCacheControls({ prompt_cache_key: 7 }), {
    ok: false,
    param: "prompt_cache_key",
    message: "prompt_cache_key must be a string",
  });
  assert.deepEqual(validatePromptCacheControls({ prompt_cache_options: [] }), {
    ok: false,
    param: "prompt_cache_options",
    message: "prompt_cache_options must be an object",
  });
  assert.deepEqual(validatePromptCacheControls({ prompt_cache_options: { unknown: true } }), {
    ok: false,
    param: "prompt_cache_options.unknown",
    message: "Unknown prompt cache option: unknown",
  });
  assert.deepEqual(validatePromptCacheControls({ prompt_cache_options: { mode: "eager" } }), {
    ok: false,
    param: "prompt_cache_options.mode",
    message: "prompt_cache_options.mode must be implicit or explicit",
  });
  assert.deepEqual(validatePromptCacheControls({ prompt_cache_options: { ttl: "1h" } }), {
    ok: false,
    param: "prompt_cache_options.ttl",
    message: "prompt_cache_options.ttl must be 30m",
  });
  assert.deepEqual(validatePromptCacheControls({ prompt_cache_retention: "forever" }), {
    ok: false,
    param: "prompt_cache_retention",
    message: "prompt_cache_retention must be in_memory or 24h",
  });
});

test("chat messages: content parts are normalized with their cache breakpoints", () => {
  const text = normalizeChatMessage({ role: "user", content: [{ type: "text", text: "hello", prompt_cache_breakpoint: { mode: "explicit" } }] }, 0);
  assert.deepEqual(messageInput(text), [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello", prompt_cache_breakpoint: { mode: "explicit" } }],
    },
  ]);

  const assistant = normalizeChatMessage({ role: "assistant", content: "hi" }, 1);
  assert.deepEqual(messageInput(assistant), [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }]);

  const image = normalizeChatMessage(
    { role: "user", content: [{ type: "image_url", image_url: { url: " https://example.test/a.png ", detail: "original" } }] },
    2
  );
  assert.deepEqual(messageInput(image), [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.test/a.png", detail: "original" }] },
  ]);

  const file = normalizeChatMessage({ role: "user", content: [{ type: "file", file: { file_id: "file-1", filename: "a.txt" } }] }, 3);
  assert.deepEqual(messageInput(file), [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file-1", filename: "a.txt" }] }]);

  const refusal = normalizeChatMessage({ role: "assistant", content: [{ type: "refusal", refusal: "no" }] }, 4);
  assert.deepEqual(messageInput(refusal), [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "no" }] }]);
});

test("chat messages: malformed content parts are rejected with their exact param", () => {
  const reject = (value: unknown, param: string, message: string) => {
    const result = normalizeChatMessage(value, 0);
    assert.deepEqual(result, { ok: false, param, message });
  };

  reject({ role: "user", content: [{ type: "text", text: "x", extra: true }] }, "messages[0].content[0].extra", "Unknown content field: extra");
  reject({ role: "user", content: [{ type: "text", text: 5 }] }, "messages[0].content[0].text", "messages[0].content[0].text must be a string");
  reject(
    { role: "assistant", content: [{ type: "text", text: "x", prompt_cache_breakpoint: { mode: "explicit" } }] },
    "messages[0].content[0].prompt_cache_breakpoint",
    "prompt_cache_breakpoint is not supported for assistant output content in this gateway"
  );
  reject(
    { role: "user", content: [{ type: "text", text: "x", prompt_cache_breakpoint: { mode: "eager" } }] },
    "messages[0].content[0].prompt_cache_breakpoint.mode",
    "messages[0].content[0].prompt_cache_breakpoint.mode must be explicit"
  );
  reject(
    { role: "user", content: [{ type: "text", text: "x", prompt_cache_breakpoint: { mode: "explicit", extra: true } }] },
    "messages[0].content[0].prompt_cache_breakpoint.extra",
    "Unknown cache breakpoint field: extra"
  );
  reject(
    { role: "user", content: [{ type: "text", text: "x", prompt_cache_breakpoint: "explicit" }] },
    "messages[0].content[0].prompt_cache_breakpoint",
    "messages[0].content[0].prompt_cache_breakpoint must be an object"
  );
  reject(
    { role: "user", content: [{ type: "refusal", refusal: "no" }] },
    "messages[0].content[0].type",
    "messages[0].content[0].type is only valid for assistant messages"
  );
  reject(
    {
      role: "assistant",
      content: [
        { type: "text", text: "x" },
        { type: "refusal", refusal: "no" },
      ],
    },
    "messages[0].content[1].type",
    "assistant refusal content must be the only part"
  );
  reject(
    { role: "assistant", content: [{ type: "refusal", refusal: 5 }] },
    "messages[0].content[0].refusal",
    "messages[0].content[0].refusal must be a string"
  );
  reject(
    { role: "assistant", content: [{ type: "refusal", refusal: "no", prompt_cache_breakpoint: { mode: "explicit" } }] },
    "messages[0].content[0].prompt_cache_breakpoint",
    "prompt_cache_breakpoint is not supported for refusal content in this gateway"
  );
  reject(
    { role: "assistant", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] },
    "messages[0].content[0].type",
    "messages[0].content[0].type is only valid for user messages"
  );
  reject(
    { role: "user", content: [{ type: "image_url", image_url: "https://example.test/a.png" }] },
    "messages[0].content[0].image_url",
    "messages[0].content[0].image_url must be an object"
  );
  reject(
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png", size: 1 } }] },
    "messages[0].content[0].image_url.size",
    "Unknown image_url field: size"
  );
  reject(
    { role: "user", content: [{ type: "image_url", image_url: { url: "  " } }] },
    "messages[0].content[0].image_url.url",
    "messages[0].content[0].image_url.url must contain a URL"
  );
  reject(
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png", detail: "huge" } }] },
    "messages[0].content[0].image_url.detail",
    "messages[0].content[0].image_url.detail must be one of auto, low, high, or original"
  );
  reject(
    { role: "assistant", content: [{ type: "file", file: { file_id: "f" } }] },
    "messages[0].content[0].type",
    "messages[0].content[0].type is only valid for user messages"
  );
  reject({ role: "user", content: [{ type: "file", file: "f" }] }, "messages[0].content[0].file", "messages[0].content[0].file must be an object");
  reject({ role: "user", content: [{ type: "file", file: { file_id: "f", size: 1 } }] }, "messages[0].content[0].file.size", "Unknown file field: size");
  reject(
    { role: "user", content: [{ type: "file", file: { file_id: 5 } }] },
    "messages[0].content[0].file.file_id",
    "messages[0].content[0].file.file_id must be a string"
  );
  reject(
    { role: "user", content: [{ type: "file", file: {} }] },
    "messages[0].content[0].file.file_id",
    "messages[0].content[0].file must include file_id or file_data"
  );
  reject(
    { role: "user", content: [{ type: "file", file: { file_id: "f", prompt_cache_breakpoint: { mode: "explicit" } } }] },
    "messages[0].content[0].file.prompt_cache_breakpoint",
    "Unknown file field: prompt_cache_breakpoint"
  );
  reject(
    { role: "user", content: [{ type: "input_audio", prompt_cache_breakpoint: { mode: "explicit" } }] },
    "messages[0].content[0].prompt_cache_breakpoint",
    "prompt_cache_breakpoint is not supported for input_audio content in this gateway"
  );
  reject({ role: "user", content: [{ type: "input_audio" }] }, "messages[0].content[0].type", "messages[0].content[0].type is not supported");
  reject({ role: "user", content: ["text"] }, "messages[0].content[0]", "messages[0].content[0] must be an object");
  reject({ role: "user", content: 7 }, "messages[0].content", "messages[0].content must be a string or an array");
});

test("chat messages: assistant and tool turns are projected onto the Responses input items", () => {
  // An assistant turn with no content but a tool call is still a function call.
  const assistantToolCall = normalizeChatMessage(
    { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    0
  );
  assert.equal(assistantToolCall.ok, true);
  assert.deepEqual(assistantToolCall.value.input, [{ type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" }]);

  // A refusal is appended after the natural-language content.
  const refusal = normalizeChatMessage({ role: "assistant", content: "hello", refusal: "cannot" }, 1);
  assert.deepEqual(refusal.ok ? refusal.value.input : [], [
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "hello" },
        { type: "output_text", text: "cannot" },
      ],
    },
  ]);

  // A tool result becomes a function_call_output carrying its text array.
  const tool = normalizeChatMessage({ role: "tool", tool_call_id: "call-1", content: [{ type: "text", text: "42" }] }, 2);
  assert.deepEqual(tool.ok ? tool.value.input : [], [{ type: "function_call_output", call_id: "call-1", output: [{ type: "input_text", text: "42" }] }]);

  // System and developer turns carry instructions instead of input.
  const system = normalizeChatMessage({ role: "system", content: "be brief" }, 3);
  assert.equal(system.ok ? system.value.instruction : null, "be brief");
  assert.deepEqual(system.ok ? system.value.input : [], []);
  const developer = normalizeChatMessage({ role: "developer", content: [{ type: "text", text: "rules" }] }, 4);
  assert.equal(developer.ok ? developer.value.instruction : null, "rules");
});

test("chat messages: assistant, tool and role errors are rejected with their exact param", () => {
  const reject = (value: unknown, param: string, message: string) => {
    assert.deepEqual(normalizeChatMessage(value, 0), { ok: false, param, message });
  };

  reject({ role: "assistant", refusal: 5 }, "messages[0].refusal", "messages[0].refusal must be a string or null");
  reject({ role: "assistant", refusal: null }, "messages[0].content", "messages[0].content must be a string or an array");
  reject({ role: "assistant", content: null }, "messages[0].content", "assistant messages require content, refusal, or tool_calls");
  reject({ role: "tool", content: "x" }, "messages[0].tool_call_id", "messages[0].tool_call_id must be a non-empty string");
  reject({ role: "tool", tool_call_id: "call-1", content: 7 }, "messages[0].content", "messages[0].content must be a string or an array");
  reject(
    { role: "tool", tool_call_id: "call-1", content: [{ type: "image_url" }] },
    "messages[0].content[0].type",
    "messages[0].content[0].type must be a text content part"
  );
  reject(
    { role: "tool", tool_call_id: "call-1", content: [{ type: "text", text: "x", extra: true }] },
    "messages[0].content[0].extra",
    "Unknown content field: extra"
  );
  reject(
    { role: "tool", tool_call_id: "call-1", content: [{ type: "text", text: "x", prompt_cache_breakpoint: { mode: "eager" } }] },
    "messages[0].content[0].prompt_cache_breakpoint.mode",
    "messages[0].content[0].prompt_cache_breakpoint.mode must be explicit"
  );
  reject(
    { role: "tool", tool_call_id: "call-1", content: [{ type: "text", text: 5 }] },
    "messages[0].content[0].text",
    "messages[0].content[0].text must be a string"
  );
  reject({ role: "tool", tool_call_id: "call-1", content: [7] }, "messages[0].content[0]", "messages[0].content[0] must be an object");
  reject({ role: "system", content: "x", tool_calls: [] }, "messages[0].tool_calls", "tool_calls are only valid for assistant messages");
  reject({ role: "user", content: "x", tool_calls: [] }, "messages[0].tool_calls", "tool_calls are only valid for assistant messages");
  reject({ role: "user", content: "x", tool_call_id: "call-1" }, "messages[0].tool_call_id", "tool_call_id is only valid for tool messages");
  reject(
    { role: "assistant", prompt_cache_breakpoint: { mode: "explicit" } },
    "messages[0].prompt_cache_breakpoint",
    "prompt_cache_breakpoint is only valid on supported input content blocks"
  );
  reject({ role: 5, content: "x" }, "messages[0].role", "messages[0].role must be a string");
  reject({ role: "owner", content: "x" }, "messages[0].role", "messages[0].role is not supported");
  reject("not-a-message", "messages[0]", "messages[0] must be an object");
});

test("chat tool calls: malformed function call shapes are rejected", () => {
  const reject = (call: unknown, param: string, message: string) => {
    assert.deepEqual(normalizeChatMessage({ role: "assistant", content: null, tool_calls: [call] }, 0), { ok: false, param, message });
  };

  reject("call", "messages[0].tool_calls[0]", "messages[0].tool_calls[0] must be an object");
  reject(
    { id: "call-1", type: "function", function: { name: "n", arguments: "{}" }, extra: 1 },
    "messages[0].tool_calls[0].extra",
    "Unknown tool call field: extra"
  );
  reject(
    { id: "call-1", type: "other", function: { name: "n", arguments: "{}" } },
    "messages[0].tool_calls[0].type",
    "messages[0].tool_calls[0].type must be function"
  );
  reject(
    { id: "  ", type: "function", function: { name: "n", arguments: "{}" } },
    "messages[0].tool_calls[0].id",
    "messages[0].tool_calls[0].id must be a non-empty string"
  );
  reject({ id: "call-1", type: "function", function: "n" }, "messages[0].tool_calls[0].function", "messages[0].tool_calls[0].function must be an object");
  reject(
    { id: "call-1", type: "function", function: { name: "n", arguments: "{}", extra: 1 } },
    "messages[0].tool_calls[0].function.extra",
    "Unknown tool call function field: extra"
  );
  reject(
    { id: "call-1", type: "function", function: { name: " ", arguments: "{}" } },
    "messages[0].tool_calls[0].function.name",
    "messages[0].tool_calls[0].function.name must be a non-empty string"
  );
  reject(
    { id: "call-1", type: "function", function: { name: "n", arguments: 5 } },
    "messages[0].tool_calls[0].function.arguments",
    "messages[0].tool_calls[0].function.arguments must be a string"
  );
  assert.deepEqual(normalizeChatMessage({ role: "assistant", content: null, tool_calls: "none" }, 0), {
    ok: false,
    param: "messages[0].tool_calls",
    message: "messages[0].tool_calls must be an array",
  });
});

test("responses content items: text, image and file blocks are normalized", () => {
  const text = normalizeResponseContentItem({ type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } }, "input[0]", "user");
  assert.deepEqual(text, { ok: true, value: { type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } } });
  const output = normalizeResponseContentItem({ type: "output_text", text: "hi", annotations: [] }, "input[0]", "assistant");
  assert.deepEqual(output, { ok: true, value: { type: "output_text", text: "hi" } });
  const image = normalizeResponseContentItem({ type: "input_image", file_id: " file-1 ", detail: "low" }, "input[1]", "user");
  assert.deepEqual(image, { ok: true, value: { type: "input_image", file_id: "file-1", detail: "low" } });
  const file = normalizeResponseContentItem({ type: "input_file", file_data: "ZGF0YQ==", filename: null }, "input[2]", "user");
  assert.deepEqual(file, { ok: true, value: { type: "input_file", file_data: "ZGF0YQ==", filename: null } });
  const fileWithUrl = normalizeResponseContentItem({ type: "input_file", file_url: "https://example.test/a.pdf" }, "input[3]", "user");
  assert.deepEqual(fileWithUrl, { ok: true, value: { type: "input_file", file_url: "https://example.test/a.pdf" } });
});

test("responses content items: every malformed block is rejected with its exact param", () => {
  // The block under test is always the first content item; the reported param
  // names the offending field inside (or the block itself).
  const reject = (value: unknown, param: string, message: string, role: "user" | "assistant" = "user") => {
    assert.deepEqual(normalizeResponseContentItem(value, "input[0]", role), { ok: false, param, message });
  };

  reject(7, "input[0]", "input[0] must be an object");
  reject({ text: "hi" }, "input[0].type", "input[0].type must be a string");
  reject({ type: "input_audio" }, "input[0].type", "input[0].type is not supported");
  reject({ type: "output_text", text: "hi" }, "input[0].type", "input[0].type is only valid for assistant messages");
  reject({ type: "input_text", text: "hi", extra: 1 }, "input[0].extra", "Unknown content field: extra");
  reject({ type: "input_text", text: 5 }, "input[0].text", "input[0].text must be a string");
  reject({ type: "output_text", text: "hi", annotations: "none" }, "input[0].annotations", "input[0].annotations must be an array", "assistant");
  reject(
    { type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "eager" } },
    "input[0].prompt_cache_breakpoint.mode",
    "input[0].prompt_cache_breakpoint.mode must be explicit"
  );
  reject({ type: "input_image" }, "input[0].image_url", "input[0] must include exactly one of image_url or file_id");
  reject(
    { type: "input_image", image_url: "https://a.test/x.png", file_id: "file-1" },
    "input[0].image_url",
    "input[0] must include exactly one of image_url or file_id"
  );
  reject({ type: "input_image", image_url: 5 }, "input[0].image_url", "input[0] must include exactly one of image_url or file_id");
  reject({ type: "input_image", file_id: 5 }, "input[0].image_url", "input[0] must include exactly one of image_url or file_id");
  reject(
    { type: "input_image", image_url: "https://a.test/x.png", detail: 5 },
    "input[0].detail",
    "input[0].detail must be one of auto, low, high, or original"
  );
  reject(
    { type: "input_image", image_url: "https://a.test/x.png", prompt_cache_breakpoint: "explicit" },
    "input[0].prompt_cache_breakpoint",
    "input[0].prompt_cache_breakpoint must be an object"
  );
  reject({ type: "input_file" }, "input[0].file_id", "input[0] must include file_id, file_data, or file_url");
  reject({ type: "input_file", file_id: 5 }, "input[0].file_id", "input[0] must include file_id, file_data, or file_url");
  reject({ type: "input_file", file_id: "f", filename: 5 }, "input[0].filename", "input[0].filename must be a string or null");
  reject({ type: "input_file", file_id: "f", detail: "original" }, "input[0].detail", "input[0].detail must be one of auto, low, or high");
  reject(
    { type: "input_file", file_id: "f", prompt_cache_breakpoint: { mode: "eager" } },
    "input[0].prompt_cache_breakpoint.mode",
    "input[0].prompt_cache_breakpoint.mode must be explicit"
  );
  reject({ type: "input_file", file_id: "f", extra: 1 }, "input[0].extra", "Unknown content field: extra");
});

test("responses message items: role, content and breakpoint fences are enforced", () => {
  const stringContent = normalizeResponseMessageItem({ role: "assistant", type: "message", content: "hi" }, "input[0]");
  assert.deepEqual(stringContent, { ok: true, value: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } });
  const arrayContent = normalizeResponseMessageItem({ role: "developer", content: [{ type: "input_text", text: "hi" }] }, "input[1]");
  assert.deepEqual(arrayContent, { ok: true, value: { type: "message", role: "developer", content: [{ type: "input_text", text: "hi" }] } });

  const reject = (value: unknown, param: string, message: string) => {
    assert.deepEqual(normalizeResponseMessageItem(value, "input[0]"), { ok: false, param, message });
  };
  reject(7, "input[0]", "input[0] must be an object");
  reject(
    { role: "user", content: "x", prompt_cache_breakpoint: { mode: "explicit" } },
    "input[0].prompt_cache_breakpoint",
    "prompt_cache_breakpoint is only valid on supported input content blocks"
  );
  reject({ role: "user", content: "x", type: "function_call" }, "input[0].type", "input[0].type must be message");
  reject({ role: "tool", content: "x" }, "input[0].role", "input[0].role is invalid");
  reject({ role: 5, content: "x" }, "input[0].role", "input[0].role is invalid");
  reject({ role: "user" }, "input[0].content", "input[0].content must be a string or an array");
  reject({ role: "user", content: [{ type: "input_audio" }] }, "input[0].content[0].type", "input[0].content[0].type is not supported");
});

test("function call outputs: standard content blocks are normalized and other items pass through", () => {
  const normalized = normalizeFunctionCallOutputItem(
    { type: "function_call_output", call_id: "call-1", output: [{ type: "input_text", text: "42" }] },
    "input[0]"
  );
  assert.deepEqual(normalized, {
    ok: true,
    value: { type: "function_call_output", call_id: "call-1", output: [{ type: "input_text", text: "42" }] },
  });
  const invalid = normalizeFunctionCallOutputItem({ type: "function_call_output", call_id: "call-1", output: [{ type: "input_audio" }] }, "input[0]");
  assert.deepEqual(invalid, { ok: false, param: "input[0].output[0].type", message: "input[0].output[0].type is not supported" });
  // A string output is an opaque passthrough, not a content list.
  const passthrough = normalizeFunctionCallOutputItem({ type: "function_call_output", call_id: "call-1", output: "42" }, "input[0]");
  assert.deepEqual(passthrough, { ok: true, value: { type: "function_call_output", call_id: "call-1", output: "42" } });
});

test("responses model list and capability entries normalize the documented shapes", () => {
  assert.equal(normalizeModelList("list"), null);
  assert.deepEqual(normalizeModelList({ data: [{ id: "gpt-5", created: -5 }, "skip", { slug: "alias", owned_by: "vendor" }] }), {
    object: "list",
    data: [
      { id: "gpt-5", object: "model", created: 0, owned_by: "openai" },
      { id: "alias", object: "model", created: 0, owned_by: "vendor" },
    ],
  });
  assert.deepEqual(normalizeModelList({ models: [{ name: "gpt-5" }], updated_at_ms: 1_800_000_000_000 }), {
    object: "list",
    data: [{ id: "gpt-5", object: "model", created: 1_800_000_000, owned_by: "openai" }],
  });
  assert.equal(normalizeModelList({ data: [] })?.data.length, 0);
});

test("upstream wire: error snippets are trimmed, bounded and never invented", () => {
  assert.equal(formatErrorSnippet("  boom  "), "boom");
  assert.equal(formatErrorSnippet(new Error("  ")), "");
  assert.equal(formatErrorSnippet(""), "");
  assert.equal(formatErrorSnippet(42), "42");
  assert.equal(formatErrorSnippet("x".repeat(400)).length, 283);
  assert.equal(formatErrorSnippet("x".repeat(400), 10), `${"x".repeat(10)}...`);
  assert.equal(formatErrorSnippet("short", 10), "short");
});

test("upstream wire: the redacted diagnostic keeps only gateway-owned codes", () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    logRedactedUpstreamError("label", new MeteredError("m", "metered_upstream_unreachable", 502));
    logRedactedUpstreamError("label", new SurplusError("s", "surplus_upstream_unreachable", 502));
    logRedactedUpstreamError("label", new MeteredError("m", "not_a_gateway_code" as never, 502));
    logRedactedUpstreamError("label", new DOMException("aborted", "AbortError"));
    logRedactedUpstreamError("label", new TypeError("bad"));
    logRedactedUpstreamError("label", Object.assign(new Error("voyage"), { status: 429 }));
    logRedactedUpstreamError("label", Object.assign(new Error("odd"), { status: 99 }));
    logRedactedUpstreamError("label", "not-an-error");
  } finally {
    console.error = original;
  }

  assert.deepEqual(logged, [
    ["label", { error_class: "MeteredError", status: 502, code: "metered_upstream_unreachable" }],
    ["label", { error_class: "SurplusError", status: 502, code: "surplus_upstream_unreachable" }],
    ["label", { error_class: "MeteredError", status: 502, code: null }],
    ["label", { error_class: "DOMException", status: null, code: null }],
    ["label", { error_class: "TypeError", status: null, code: null }],
    ["label", { error_class: "Error", status: 429, code: null }],
    ["label", { error_class: "Error", status: null, code: null }],
    ["label", { error_class: "unknown", status: null, code: null }],
  ]);
});

test("upstream wire: redacted Codex ownership diagnostics preserve codes without leaking private errors", () => {
  const logged: unknown[][] = [];
  const original = console.error;
  const messageMarker = "SECRET_MESSAGE_793";
  const causeMarker = "SECRET_CAUSE_793";
  const unknownCodeMarker = "unknown_SECRET_CODE_793";
  const cause = new Error(causeMarker);
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    logRedactedUpstreamError("label", new CodexError(messageMarker, "codex_auth_owner_conflict", 409, cause));
    logRedactedUpstreamError("label", new CodexError(messageMarker, "codex_auth_owner_unavailable", 503, cause));
    logRedactedUpstreamError("label", new CodexError(messageMarker, unknownCodeMarker as never, 503, cause));
  } finally {
    console.error = original;
  }

  assert.deepEqual(logged, [
    ["label", { error_class: "CodexError", status: 409, code: "codex_auth_owner_conflict" }],
    ["label", { error_class: "CodexError", status: 503, code: "codex_auth_owner_unavailable" }],
    ["label", { error_class: "CodexError", status: 503, code: null }],
  ]);
  const output = JSON.stringify(logged);
  for (const marker of [messageMarker, causeMarker, unknownCodeMarker]) assert.equal(output.includes(marker), false);
});

test("upstream wire: provider request ids are bounded, printable and trimmed", () => {
  assert.equal(normalizeProviderRequestId("  req-1  "), "req-1");
  assert.equal(normalizeProviderRequestId(undefined), null);
  assert.equal(normalizeProviderRequestId(""), null);
  assert.equal(normalizeProviderRequestId("x".repeat(257)), null);
  assert.equal(normalizeProviderRequestId("bad\nheader"), null);
  assert.equal(providerRequestIdFromResponse(new Response("", { headers: { "X-Oneapi-Request-Id": "req-2" } })), "req-2");
  assert.equal(providerRequestIdFromResponse(new Response("", { headers: {} })), null);
});

test("upstream wire: codex errors translate to their documented status and warning headers", async () => {
  const quota = toCodexErrorResponse(new ApiKeyQuotaDispatchError("quota", { status: 429, code: "rate_limit_exceeded" }), "chatgpt_codex");
  assert.equal(quota.status, 429);
  assert.equal(quota.headers.get("x-uos-upstream"), "chatgpt_codex");
  assert.equal((await quota.clone().json()).error.code, "rate_limit_exceeded");

  const offline = toCodexErrorResponse(new Error("connect failed"), null);
  assert.equal(offline.status, 502);
  assert.equal(offline.headers.get("x-uos-upstream"), null);
  assert.deepEqual((await offline.json()).error.message, "Codex upstream request failed: connect failed");

  const silent = toCodexErrorResponse(new Error("  "), null);
  assert.equal((await silent.json()).error.message, "Codex upstream request failed.");

  const metered = toCodexErrorResponse(new Error("metered down"), "metered");
  assert.equal(metered.status, 502);
  assert.equal((await metered.json()).error.code, "metered_upstream_unreachable");
  assert.equal(metered.headers.get("x-uos-upstream"), "metered");

  const surplus = toCodexErrorResponse(new Error("surplus down"), "surplus");
  assert.equal((await surplus.json()).error.code, "surplus_upstream_unreachable");

  const cancelled = toPreHeaderErrorResponse(new Error("cancelled"), "cancelled", "lithos");
  assert.equal(cancelled.status, 499);
  assert.equal(cancelled.headers.get("x-uos-upstream"), "lithos");
  const deadline = toPreHeaderErrorResponse(new Error("timeout"), "deadline");
  assert.equal(deadline.status, 504);
  assert.equal((await deadline.json()).error.code, "gateway_timeout");
  // A Codex gateway timeout keeps its own translation instead of the generic 504.
  const codexTimeout = toPreHeaderErrorResponse(new CodexError("timeout", "gateway_timeout", 504), "deadline");
  assert.equal(codexTimeout.status, 504);
  assert.equal(codexTimeout.headers.get("x-uos-warning"), null);
  const passthrough = toPreHeaderErrorResponse(new Error("boom"), "error", "deepseek");
  assert.equal(passthrough.status, 502);
  assert.equal(passthrough.headers.get("x-uos-upstream"), "deepseek");
});

test("upstream wire: every provider error translation maps its own error classes", async () => {
  const quota = new ApiKeyQuotaDispatchError("quota", { status: 503, code: "api_key_quota_reservation_unavailable", headers: { "x-uos-warning": "w" } });
  assert.equal(toCerebrasErrorResponse(quota).status, 503);
  assert.equal(toCerebrasErrorResponse(quota).headers.get("x-uos-warning"), "w");
  const cerebrasServer = toCerebrasErrorResponse(new CerebrasError("upstream 500", "cerebras_upstream_unreachable", 502));
  assert.equal(cerebrasServer.status, 502);
  assert.equal((await cerebrasServer.json()).error.type, "server_error");
  const cerebrasClient = toCerebrasErrorResponse(new CerebrasError("bad request", "cerebras_request_invalid", 400));
  assert.equal((await cerebrasClient.json()).error.type, "invalid_request_error");
  assert.equal(toCerebrasErrorResponse(new DOMException("took too long", "TimeoutError")).status, 504);
  assert.equal(toCerebrasErrorResponse(new DOMException("aborted", "AbortError")).status, 499);
  const cerebrasFallback = toCerebrasErrorResponse("odd failure");
  assert.equal(cerebrasFallback.status, 502);
  assert.equal((await cerebrasFallback.json()).error.code, "cerebras_upstream_unreachable");

  assert.equal(toDeepSeekErrorResponse(quota).status, 503);
  assert.equal(toDeepSeekErrorResponse(new DeepSeekError("upstream 500", "deepseek_upstream_unreachable", 502)).status, 502);
  assert.equal(toDeepSeekErrorResponse(new DeepSeekError("bad request", "deepseek_request_invalid", 400)).status, 400);
  assert.equal(toDeepSeekErrorResponse(new DOMException("took too long", "TimeoutError")).status, 504);
  assert.equal(toDeepSeekErrorResponse(new DOMException("aborted", "AbortError")).status, 499);
  const deepseekFallback = toDeepSeekErrorResponse("odd failure");
  assert.equal((await deepseekFallback.json()).error.code, "deepseek_upstream_unreachable");
  assert.equal(deepseekFallback.headers.get("x-uos-upstream"), "deepseek");

  assert.equal(toLithosErrorResponse(quota).status, 503);
  assert.equal(toLithosErrorResponse(new LithosError("upstream 500", "lithos_upstream_invalid_response", 502)).status, 502);
  assert.equal(toLithosErrorResponse(new LithosError("bad request", "lithos_request_invalid", 400)).status, 400);
  assert.equal(toLithosErrorResponse(new DOMException("took too long", "TimeoutError")).status, 504);
  assert.equal(toLithosErrorResponse(new DOMException("aborted", "AbortError")).status, 499);
  const lithosFallback = toLithosErrorResponse("odd failure");
  assert.equal((await lithosFallback.json()).error.code, "lithos_upstream_unreachable");
  assert.equal(lithosFallback.headers.get("x-uos-upstream"), "lithos");

  const dispatch = apiKeyQuotaDispatchErrorResponse(new ApiKeyQuotaDispatchError("quota", { status: 429, code: "rate_limit_exceeded" }));
  assert.equal(dispatch.status, 429);
  assert.equal((await dispatch.clone().json()).error.param, null);
});

test("upstream wire: answer-bearing output ignores reasoning and reads both chat shapes", () => {
  assert.equal(isAnswerBearingCompletion({ text: "", toolCallCount: 0 }), false);
  assert.equal(isAnswerBearingCompletion({ text: "", refusal: "no", toolCallCount: 0 }), true);
  assert.equal(isAnswerBearingCompletion({ text: "", toolCallCount: 2 }), true);

  assert.equal(chatCompletionHasAnswerBearingOutput({ choices: [{ message: { content: "hi" } }] }), true);
  assert.equal(chatCompletionHasAnswerBearingOutput({ choices: [{ message: { reasoning: "thinking" } }] }), false);
  assert.equal(chatCompletionHasAnswerBearingOutput({ choices: [{ message: { tool_calls: [{}] } }] }), true);
  assert.equal(chatCompletionHasAnswerBearingOutput({ choices: ["skip", { message: "skip" }] }), false);
  assert.equal(chatCompletionHasAnswerBearingOutput({}), false);

  assert.equal(chatChunkHasAnswerBearingOutput({ choices: [{ delta: { content: "hi" } }] }), true);
  assert.equal(chatChunkHasAnswerBearingOutput({ choices: [{ delta: { reasoning_content: "thinking" } }] }), false);
  assert.equal(chatChunkHasAnswerBearingOutput({ choices: [7] }), false);
});

test("upstream wire: a buffered Cerebras completion is re-framed as a chat SSE stream with its tool calls", async () => {
  const completion = {
    id: "chatcmpl-1",
    created: 1_800_000_000,
    model: "gpt-oss-120b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "hello",
          reasoning: "why",
          refusal: "nope",
          tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: "{}" } }, "skip", { id: "call-2" }],
        },
        finish_reason: "tool_calls",
      },
      "skip",
    ],
    usage: { total_tokens: 9 },
  };
  const response = streamCerebrasChatCompletion(completion, true, { "x-uos-upstream": "cerebras" });

  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
  const frames = (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((line) => line.replace(/^data: /, ""));
  assert.equal(frames.at(-1), "[DONE]");
  assert.deepEqual(JSON.parse(frames[0]).choices[0].delta, {
    role: "assistant",
    reasoning: "why",
    content: "hello",
    refusal: "nope",
    tool_calls: [
      // The `"skip"` string and the `{ id: "call-2" }` entry carry no `function`
      // object, so the re-framer drops both rather than emitting empty deltas.
      { index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
    ],
  });
  assert.deepEqual(JSON.parse(frames[1]).choices[0], { index: 0, delta: {}, finish_reason: "tool_calls" });
  assert.deepEqual(JSON.parse(frames[2]), {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1_800_000_000,
    model: "gpt-oss-120b",
    choices: [],
    usage: { total_tokens: 9 },
  });

  // Without usage the stream still terminates, and an empty completion yields just the terminator.
  const minimal = streamCerebrasChatCompletion({}, false, {});
  assert.deepEqual((await minimal.text()).split("\n\n").filter(Boolean), ["data: [DONE]"]);
});

test("upstream wire: provider error bodies are bounded, whitelisted and never reflected wholesale", async () => {
  const cerebras = await toCerebrasUpstreamErrorResponse(
    new Response(JSON.stringify({ error: { message: "  upstream exploded  ", code: "invalid_request" } }), {
      status: 429,
      headers: { "Retry-After": "7", "x-ratelimit-requests-limit": "100" },
    })
  );
  assert.equal(cerebras.status, 429);
  const cerebrasBody = (await cerebras.json()) as { error: { message: string; code: string } };
  assert.equal(cerebrasBody.error.message, "upstream exploded");
  assert.equal(cerebrasBody.error.code, "invalid_request");
  assert.equal(cerebras.headers.get("Retry-After"), "7");

  // A non-JSON body keeps the generic message instead of reflecting provider text.
  const nonJson = await toCerebrasUpstreamErrorResponse(new Response("<html>bad gateway</html>", { status: 502 }));
  const nonJsonBody = (await nonJson.json()) as { error: { message: string; code: string; type: string } };
  assert.equal(nonJsonBody.error.message, "Cerebras upstream returned an error.");
  assert.equal(nonJsonBody.error.code, "cerebras_upstream_error");
  assert.equal(nonJsonBody.error.type, "server_error");

  // A non-object JSON body is not a whitelist source either.
  const numberBody = await toCerebrasUpstreamErrorResponse(new Response("7", { status: 408 }));
  assert.equal(((await numberBody.json()) as { error: { message: string } }).error.message, "Cerebras upstream returned an error.");

  const deepseek = await toDeepSeekUpstreamErrorResponse(
    new Response(JSON.stringify({ error: { message: "deepseek exploded", code: "deepseek_code" } }), { status: 503, headers: { "Retry-After": "3" } }),
    undefined,
    { model: "deepseek-chat" }
  );
  assert.equal(deepseek.status, 503);
  assert.equal(((await deepseek.json()) as { error: { code: string } }).error.code, "deepseek_code");
  assert.equal(deepseek.headers.get("x-uos-upstream"), "deepseek");

  const deepseekNonJson = await toDeepSeekUpstreamErrorResponse(new Response("[]", { status: 502 }));
  assert.equal(((await deepseekNonJson.json()) as { error: { code: string } }).error.code, "deepseek_upstream_error");

  const lithos = await toLithosUpstreamErrorResponse(
    new Response(JSON.stringify({ object: "error", message: "engine refused", type: "BadRequestError", code: 400 }), {
      status: 429,
      headers: { "retry-after-ms": "1500", "Retry-After": "2", "x-ratelimit-requests-remaining": "0" },
    }),
    undefined,
    { model: "moonshotai/Kimi-K3" }
  );
  assert.equal(lithos.status, 429);
  assert.equal(lithos.headers.get("x-should-retry"), null);
  const lithosBody = (await lithos.json()) as { error: { message: string; code: string; type: string } };
  assert.equal(lithosBody.error.message, "engine refused");
  assert.equal(lithosBody.error.code, "rate_limit_exceeded");
  assert.equal(lithosBody.error.type, "rate_limit_error");

  // A documented terminal status is marked non-retryable for the client.
  const outOfCredit = await toLithosUpstreamErrorResponse(
    new Response(JSON.stringify({ error: { message: "no credit", code: "insufficient_credit" } }), { status: 402 })
  );
  assert.equal(outOfCredit.headers.get("x-should-retry"), "false");
  assert.equal(((await outOfCredit.json()) as { error: { code: string; type: string } }).error.code, "insufficient_credit");

  // A vendor instruction wins over the gateway's own terminal-status default.
  const vendorRetry = await toLithosUpstreamErrorResponse(new Response("{}", { status: 402, headers: { "x-should-retry": "true" } }));
  assert.equal(vendorRetry.headers.get("x-should-retry"), "true");

  const authFailure = await toLithosUpstreamErrorResponse(new Response("{}", { status: 401 }));
  assert.equal(((await authFailure.json()) as { error: { code: string } }).error.code, "auth_invalid");
  const missingModel = await toLithosUpstreamErrorResponse(new Response("{}", { status: 404 }));
  assert.equal(((await missingModel.json()) as { error: { code: string } }).error.code, "model_not_found");
  const budget = await toLithosUpstreamErrorResponse(new Response(JSON.stringify({ error: { type: "input_tokens" } }), { status: 429 }));
  assert.equal(((await budget.json()) as { error: { code: string } }).error.code, "rate_limit_exceeded");
  const overloaded = await toLithosUpstreamErrorResponse(new Response(JSON.stringify({ error: { type: "provider_overloaded" } }), { status: 429 }));
  assert.equal(((await overloaded.json()) as { error: { code: string } }).error.code, "provider_overloaded");
  const generic = await toLithosUpstreamErrorResponse(new Response("not json", { status: 500 }));
  const genericBody = (await generic.json()) as { error: { code: string; message: string } };
  assert.equal(genericBody.error.code, "lithos_upstream_error");
  assert.equal(genericBody.error.message, "LithosAI upstream returned an error.");
});

test("upstream wire: the chat-body digest carries shapes and never prompt content", () => {
  const diagnostic = deepSeekChatBodyDiagnostic({
    model: "deepseek-flash",
    reasoning_effort: "high",
    stream: true,
    tools: [{}, {}],
    tool_choice: "auto",
    max_tokens: 128,
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", reasoning_content: "thinking", tool_calls: [{}], content: null },
      { role: "user", content: null },
      "skip",
    ],
  });

  assert.deepEqual(diagnostic, {
    model: "deepseek-flash",
    reasoning_effort: "high",
    stream: true,
    tools: 2,
    tool_choice: "auto",
    max_tokens: 128,
    message_count: 5,
    last_user_index: 3,
    omitted_message_count: 0,
    messages: [
      { index: 0, role: "system", reasoning: "absent", tool_calls: 0, content: "string", after_last_user: false },
      { index: 1, role: "user", reasoning: "absent", tool_calls: 0, content: "parts", after_last_user: false },
      { index: 2, role: "assistant", reasoning: "present", tool_calls: 1, content: "null", after_last_user: false },
      { index: 3, role: "user", reasoning: "absent", tool_calls: 0, content: "null", after_last_user: false },
      { index: 4, role: null, reasoning: "absent", tool_calls: 0, content: "null", after_last_user: true },
    ],
  });

  const malformedSample = deepSeekChatBodyDiagnostic({ messages: [{ role: "user", reasoning_content: "", content: 7 }] });
  assert.equal((malformedSample.messages as unknown[]).length, 1);
});

test("upstream wire: large chat diagnostics log a bounded private tail with original indices", async () => {
  const markers = ["PRIVATE_CONTENT_666", "PRIVATE_TOOL_NAME_666", "PRIVATE_ID_666", "PRIVATE_COOKIE_666", "PRIVATE_METADATA_666"];
  const parts = Array.from({ length: 50_000 }, () => ({ type: markers[4], text: markers[0] }));
  const calls = Array.from({ length: 50_000 }, () => ({ id: markers[2], function: { name: markers[1], arguments: markers[0] } }));
  const messages: unknown[] = Array.from({ length: 50_000 }, () => ({
    role: "assistant",
    content: parts,
    reasoning_content: markers[0],
    tool_calls: calls,
    cookie: markers[3],
  }));
  messages[0] = markers[4];
  messages[7] = { role: "user", content: markers[0] };
  messages[49_999] = { role: markers[4].repeat(10_000), content: parts, tool_calls: calls };
  const diagnostic = deepSeekChatBodyDiagnostic({
    model: markers[4].repeat(10_000),
    reasoning_effort: markers[4],
    tool_choice: markers[4],
    tools: calls,
    max_tokens: Number.POSITIVE_INFINITY,
    messages,
  });
  assert.equal(diagnostic.message_count, 50_000);
  assert.equal(diagnostic.last_user_index, 7);
  assert.equal(diagnostic.omitted_message_count, 49_984);
  assert.equal(diagnostic.model, null);
  assert.equal(diagnostic.reasoning_effort, null);
  assert.equal(diagnostic.tool_choice, null);
  assert.equal(diagnostic.max_tokens, null);
  assert.equal(diagnostic.tools, 50_000);
  const tail = diagnostic.messages as Record<string, unknown>[];
  assert.equal(tail.length, 16);
  assert.deepEqual(
    tail.map((message) => message.index),
    Array.from({ length: 16 }, (_, offset) => 49_984 + offset)
  );
  assert.equal(tail[15].role, null);
  assert.ok(tail.every((message) => message.after_last_user === true && message.content === "parts" && message.tool_calls === 50_000));

  const logged: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => logged.push(args);
  try {
    for (const translate of [toDeepSeekUpstreamErrorResponse, toLithosUpstreamErrorResponse]) {
      const response = await translate(
        new Response(JSON.stringify({ error: { message: "\0".repeat(2_000), code: "\0".repeat(400) } }), { status: 400 }),
        undefined,
        diagnostic
      );
      assert.equal(response.status, 400);
      await response.body?.cancel();
    }
  } finally {
    console.warn = original;
  }
  assert.equal(logged.length, 2);
  for (const [, line] of logged) {
    assert.equal(typeof line, "string");
    const output = String(line);
    assert.ok(new TextEncoder().encode(output).length < 16_384);
    assert.deepEqual((JSON.parse(output) as { request: unknown }).request, diagnostic);
    for (const marker of markers) assert.equal(output.includes(marker), false);
  }
});

test("upstream wire: cancelling an already-closed response body is swallowed", () => {
  let cancelled = 0;
  const response = {
    body: {
      cancel: () => {
        cancelled += 1;
        throw new Error("already closed");
      },
    },
  } as unknown as Response;

  cancelResponseBody(response);
  assert.equal(cancelled, 1);

  const rejecting = {
    body: {
      cancel: () => {
        cancelled += 1;
        return Promise.reject(new Error("stream gone"));
      },
    },
  } as unknown as Response;
  cancelResponseBody(rejecting);
  assert.equal(cancelled, 2);

  cancelResponseBody(new Response(null, { status: 200 }));
  assert.equal(cancelled, 2);
});
