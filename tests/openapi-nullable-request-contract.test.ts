import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_TEST_MODEL,
  baseSseChunks,
  cleanupHarness,
  handleChatCompletions,
  handleResponses,
  installHarness,
  sseResponse,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

beforeEach(installHarness);
afterEach(cleanupHarness);

// The published request schemas promise that a client may send null for every property whose type includes "null". Each
// such promise is checked here by sending exactly that request through the real handler (its envelope parsers, model
// resolution and Codex request projection) against a mocked upstream: a 400 means the published contract is wrong.

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

const chatRequest = (extra: Record<string, unknown>): Request =>
  new Request("https://ai.ubq.fi/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, messages: [{ role: "user", content: "ping" }], ...extra }),
  });
const responsesRequest = (extra: Record<string, unknown>): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", ...extra }),
  });

/** The status the gateway answers, and the 400 message when it refuses the request itself. */
const statusFor = async (send: () => Promise<Response>): Promise<string> => {
  const response = await withFetchMock(() => sseResponse(baseSseChunks()), send);
  if (response.status !== 400) {
    await response.body?.cancel();
    return String(response.status);
  }
  const payload = (await response.json()) as { error?: { message?: string } };
  return `400 ${payload.error?.message ?? ""}`;
};

test("every published nullable Chat Completions field accepts null at runtime", async () => {
  const fields = nullableProperties("ChatCompletionRequest");
  assert.ok(fields.length > 10, "the Chat contract must still publish its nullable official fields");
  const refused: string[] = [];
  for (const field of fields) {
    const status = await statusFor(() => handleChatCompletions(chatRequest({ [field]: null })));
    if (status !== "200") refused.push(`${field}: ${status}`);
  }
  assert.deepEqual(refused, [], "a field published as nullable must not be refused when it is null");
});

test("every published nullable Responses field accepts null at runtime", async () => {
  const fields = nullableProperties("ResponseRequest");
  assert.ok(fields.length > 10, "the Responses contract must still publish its nullable official fields");
  const refused: string[] = [];
  for (const field of fields) {
    const status = await statusFor(() => handleResponses(responsesRequest({ [field]: null })));
    if (status !== "200") refused.push(`${field}: ${status}`);
  }
  assert.deepEqual(refused, [], "a field published as nullable must not be refused when it is null");
});

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
