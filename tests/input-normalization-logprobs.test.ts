import { test } from "bun:test";
import assert from "node:assert/strict";

import { normalizeResponseContentItem, normalizeResponseMessageItem } from "../src/input-normalization.ts";
import { fetchMeteredResponses } from "../src/provider/metered.ts";
import { fetchSurplusResponses } from "../src/provider/surplus.ts";
import {
  buildResponsesUpstreamBodies,
  normalizeResponsesInput,
  readResponsesRequest,
  resolveResponsesStreamSettings,
  validateResponsesRequestFields,
} from "../src/responses-request.ts";
import codexRequest from "./fixtures/codex-0.163.0-logprobs.json";

test("Responses replay accepts and drops empty and populated output_text logprobs", async () => {
  for (const logprobs of [[], [{ token: "reply", bytes: [114, 101, 112, 108, 121], logprob: -0.01, top_logprobs: [] }]]) {
    const normalized = normalizeResponsesInput([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply", annotations: [], logprobs }] },
    ]);
    if (!normalized.ok) assert.fail("output_text logprobs must normalize");
    const expected = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] }];
    assert.deepEqual(normalized.value, expected);

    const bodies = buildResponsesUpstreamBodies("gpt-6.1-sol", normalized.value, undefined, { effort: "low" }, {});
    assert.deepEqual(bodies.codexBody.input, expected);
    assert.deepEqual(bodies.removedProviderBody.input, expected);
    for (const send of [fetchSurplusResponses, fetchMeteredResponses]) {
      const serialized: string[] = [];
      const result = await send(bodies.codexBody, {
        apiKey: "fixture-key",
        fetcher: (_url, init) => {
          if (typeof init?.body !== "string") assert.fail("the provider request body must be serialized JSON");
          serialized.push(init.body);
          return Promise.resolve(new Response("{}", { headers: { "Content-Type": "application/json" } }));
        },
      });
      assert.equal(serialized.length, 1);
      assert.deepEqual(JSON.parse(serialized[0]).input, expected);
      await result.response.body?.cancel();
    }
  }
});

test("Responses replay rejects non-array logprobs at the exact nested field", () => {
  for (const logprobs of [null, "invalid", {}, 0, true]) {
    assert.deepEqual(normalizeResponseMessageItem({ role: "assistant", content: [{ type: "output_text", text: "reply", logprobs }] }, "input[9]"), {
      ok: false,
      param: "input[9].content[0].logprobs",
      message: "input[9].content[0].logprobs must be an array",
    });
  }
});

test("Responses replay keeps rejecting unknown output_text fields and logprobs on input_text", () => {
  assert.deepEqual(
    normalizeResponseContentItem({ type: "output_text", text: "reply", logprobs: [], unknown_field: true }, "input[9].content[0]", "assistant"),
    { ok: false, param: "input[9].content[0].unknown_field", message: "Unknown content field: unknown_field" }
  );
  assert.deepEqual(normalizeResponseContentItem({ type: "input_text", text: "prompt", logprobs: [] }, "input[0].content[0]", "user"), {
    ok: false,
    param: "input[0].content[0].logprobs",
    message: "Unknown content field: logprobs",
  });
});

test("the scrubbed Codex 0.163.0 HTTP request normalizes through provider body assembly", async () => {
  const original = structuredClone(codexRequest);
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(codexRequest),
  });
  const parsed = await readResponsesRequest(request);
  if (!parsed.ok) assert.fail("the captured request must parse");
  const { rawBody, rawRecord } = parsed.value;
  assert.equal(validateResponsesRequestFields(rawRecord, rawBody), null);
  const settings = resolveResponsesStreamSettings(rawRecord, rawBody);
  if (!settings.ok) assert.fail("the captured stream settings must normalize");
  assert.equal(settings.value.clientWantsStream, true);

  const normalized = normalizeResponsesInput(rawBody.input);
  if (!normalized.ok) assert.fail("the captured request input must normalize");
  assert.equal(normalized.value.length, 9);
  assert.deepEqual(normalized.value[0], codexRequest.input[0]);
  assert.deepEqual(normalized.value[7], {
    type: "message",
    role: "assistant",
    content: [
      { type: "output_text", text: "Synthetic fixture text." },
      { type: "output_text", text: "Synthetic fixture text." },
    ],
  });

  const bodies = buildResponsesUpstreamBodies(codexRequest.model, normalized.value, undefined, codexRequest.reasoning, rawRecord);
  assert.deepEqual(bodies.codexBody.input, normalized.value);
  assert.deepEqual(bodies.removedProviderBody.input, normalized.value);
  assert.equal(JSON.stringify(bodies).includes('"logprobs"'), false);
  assert.equal(JSON.stringify(bodies).includes('"annotations"'), false);
  assert.deepEqual(codexRequest, original);
});
