import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEEPSEEK_CHAT_COMPLETIONS_URL, DEEPSEEK_FLASH_MODEL } from "../src/deepseek/index.ts";
import { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest } from "../src/models/openrouter-models.ts";
import { CEREBRAS_CHAT_COMPLETIONS_URL, CEREBRAS_GPT_OSS_120B_MODEL } from "../src/provider/cerebras.ts";
import { LITHOS_CHAT_COMPLETIONS_URL, LITHOS_MODEL_IDS } from "../src/provider/lithos.ts";
import { OPENROUTER_CHAT_COMPLETIONS_URL, OPENROUTER_RESPONSES_URL } from "../src/provider/openrouter.ts";
import { createFetchMock } from "./helpers/fetch-mock.ts";

import {
  DEFAULT_TEST_MODEL,
  baseSseChunks,
  cleanupHarness,
  handleChatCompletions,
  handleResponses,
  installHarness,
  sseResponse,
  withFetchMock,
  withProviderSelection,
} from "./helpers/openai-compat-harness.ts";

beforeEach(installHarness);
afterEach(cleanupHarness);

// The published request schemas promise that a client may send null for every property whose type includes "null". Each
// such promise is checked here by sending exactly that request through the real handler (its envelope parsers, model
// resolution and each provider's request projection) against a mocked upstream: a 400 means the published contract is wrong.

type PublishedProperty = Readonly<{ type?: string | readonly string[]; minimum?: number; "x-uos-extension"?: string }>;
type PublishedSchema = Readonly<{ properties: Record<string, PublishedProperty> }>;
const document = JSON.parse(readFileSync(new URL("../static/openapi.json", import.meta.url), "utf8")) as Readonly<{
  components: Readonly<{ schemas: Record<string, PublishedSchema> }>;
}>;

const publishedProperty = (schema: string, name: string): PublishedProperty => {
  const schemas = document.components.schemas;
  if (!Object.hasOwn(schemas, schema) || !Object.hasOwn(schemas[schema].properties, name)) throw new Error(`OpenAPI ${schema}.${name} is missing`);
  return schemas[schema].properties[name];
};
const acceptsNull = (property: PublishedProperty): boolean => (Array.isArray(property.type) ? property.type.includes("null") : property.type === "null");
const nullableProperties = (schema: string): string[] =>
  Object.entries(document.components.schemas[schema].properties)
    .filter(([, property]) => property["x-uos-extension"] === undefined && acceptsNull(property))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));

type ProviderRoute = Readonly<{ provider: string; model: string; apiKeyEnv?: string; chatUrl?: string; responsesUrl?: string }>;
const PROVIDER_ROUTES: readonly ProviderRoute[] = [
  { provider: "Codex", model: DEFAULT_TEST_MODEL },
  { provider: "Cerebras", model: CEREBRAS_GPT_OSS_120B_MODEL, apiKeyEnv: "CEREBRAS_API_KEY", chatUrl: CEREBRAS_CHAT_COMPLETIONS_URL },
  { provider: "Lithos", model: LITHOS_MODEL_IDS[0], apiKeyEnv: "LITHOSAI_API_KEY", chatUrl: LITHOS_CHAT_COMPLETIONS_URL },
  { provider: "DeepSeek", model: DEEPSEEK_FLASH_MODEL, apiKeyEnv: "DEEPSEEK_API_KEY", chatUrl: DEEPSEEK_CHAT_COMPLETIONS_URL },
  {
    provider: "OpenRouter",
    model: "vendor/nullable-contract-fixture",
    apiKeyEnv: "OPENROUTER_API_KEY",
    chatUrl: OPENROUTER_CHAT_COMPLETIONS_URL,
    responsesUrl: OPENROUTER_RESPONSES_URL,
  },
];
const withProviderRoute = async (route: ProviderRoute, run: () => Promise<void>): Promise<void> => {
  const previousKey = route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined;
  if (route.apiKeyEnv) process.env[route.apiKeyEnv] = "nullable-contract-test-key";
  try {
    if (route.provider === "OpenRouter") {
      resetOpenRouterModelsCacheForTest();
      await fetchOpenRouterModels({ force: true, fetcher: createFetchMock(() => Promise.resolve(Response.json({ data: [{ id: route.model }] }))) });
    }
    await withProviderSelection(null, run);
  } finally {
    if (route.provider === "OpenRouter") resetOpenRouterModelsCacheForTest();
    if (route.apiKeyEnv) {
      if (previousKey === undefined) Reflect.deleteProperty(process.env, route.apiKeyEnv);
      else process.env[route.apiKeyEnv] = previousKey;
    }
  }
};

const chatRequest = (extra: Record<string, unknown>, model = DEFAULT_TEST_MODEL): Request =>
  new Request("https://ai.ubq.fi/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], stream: false, ...extra }),
  });
const responsesRequest = (extra: Record<string, unknown>, model = DEFAULT_TEST_MODEL): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "ping", stream: false, ...extra }),
  });

/** Buffered Chat upstream for the provider adapters; Cerebras GPT-OSS is deliberately never tested as incremental. */
const chatCompletion = (model: string): Response =>
  Response.json({
    id: "chatcmpl_nullable_contract",
    object: "chat.completion",
    created: 1_780_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

/** The gateway status, plus the error message when it refuses the request. Successful probes must reach the intended upstream. */
const statusFor = async (send: () => Promise<Response>, route: ProviderRoute = PROVIDER_ROUTES[0], responses = false): Promise<string> => {
  let upstreamCalls = 0;
  const response = await withFetchMock((url, bodyText) => {
    upstreamCalls += 1;
    const expectedUrl = responses ? (route.responsesUrl ?? route.chatUrl) : route.chatUrl;
    if (expectedUrl) assert.equal(url, expectedUrl, `${route.provider} must use its own upstream`);
    assert.equal((JSON.parse(bodyText ?? "{}") as { model?: string }).model, route.model);
    if (route.provider === "Codex") return sseResponse(baseSseChunks());
    if (responses && route.provider === "OpenRouter") {
      return Response.json({
        id: "resp_nullable_contract",
        object: "response",
        status: "completed",
        model: route.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }
    return chatCompletion(route.model);
  }, send);
  if (response.status === 200) {
    assert.equal(response.headers.get("x-uos-upstream"), route.provider === "Codex" ? "chatgpt_codex" : route.provider.toLowerCase());
    assert.equal(upstreamCalls, 1, `${route.provider} must dispatch exactly once`);
    await response.body?.cancel();
    return "200";
  }
  const payload = (await response.json()) as { error?: { message?: string } };
  return `${response.status} ${payload.error?.message ?? ""}`;
};

for (const route of PROVIDER_ROUTES) {
  test(`${route.provider}: every published nullable Chat Completions field accepts null at runtime`, async () => {
    await withProviderRoute(route, async () => {
      const fields = nullableProperties("ChatCompletionRequest");
      assert.ok(fields.length > 10, "the Chat contract must still publish its nullable official fields");
      const refused: string[] = [];
      for (const field of fields) {
        const status = await statusFor(() => handleChatCompletions(chatRequest({ [field]: null }, route.model)), route);
        if (status !== "200") refused.push(`${field}: ${status}`);
      }
      assert.deepEqual(refused, [], "a field published as nullable must not be refused when it is null");
    });
  });

  test(`${route.provider}: every published nullable Responses field accepts null at runtime`, async () => {
    await withProviderRoute(route, async () => {
      const fields = nullableProperties("ResponseRequest");
      assert.ok(fields.length > 10, "the Responses contract must still publish its nullable official fields");
      const refused: string[] = [];
      for (const field of fields) {
        const status = await statusFor(() => handleResponses(responsesRequest({ [field]: null }, route.model)), route, true);
        if (status !== "200") refused.push(`${field}: ${status}`);
      }
      assert.deepEqual(refused, [], "a field published as nullable must not be refused when it is null");
    });
  });
}

test("Chat fields the runtime refuses as null are published without null and with the runtime bounds", async () => {
  const maxCompletionTokens = publishedProperty("ChatCompletionRequest", "max_completion_tokens");
  assert.equal(maxCompletionTokens.type, "integer");
  assert.equal(maxCompletionTokens.minimum, 1);
  assert.match(
    await statusFor(() => handleChatCompletions(chatRequest({ max_completion_tokens: null }))),
    /^400 max_completion_tokens must be a positive integer/
  );
  assert.match(
    await statusFor(() => handleChatCompletions(chatRequest({ max_completion_tokens: 0 }))),
    /^400 max_completion_tokens must be a positive integer/
  );
  assert.equal(await statusFor(() => handleChatCompletions(chatRequest({ max_completion_tokens: maxCompletionTokens.minimum }))), "200");

  assert.equal(publishedProperty("ChatCompletionRequest", "stream_options").type, "object");
  assert.match(await statusFor(() => handleChatCompletions(chatRequest({ stream_options: null }))), /^400 stream_options must be an object/);
  assert.equal(await statusFor(() => handleChatCompletions(chatRequest({ stream_options: { include_usage: true } }))), "200");
});

test("Responses top_logprobs is published as nullable, like the official CreateResponse field", () => {
  assert.deepEqual(publishedProperty("ResponseRequest", "top_logprobs").type, ["integer", "null"]);
});
