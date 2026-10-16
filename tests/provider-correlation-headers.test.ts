import { test } from "bun:test";
import assert from "node:assert/strict";

import { PROVIDER_NATIVE_CORRELATION_HEADERS, scrubProviderNativeCorrelationHeaders } from "../src/handler/http.ts";

/**
 * Every spelling a provider reader accepts must be scrubbed, or that
 * provider's own correlation header survives to the client. This pins the
 * vocabulary: adding a reader header without adding it here fails the test.
 */
const READER_ACCEPTED_HEADERS = [
  // getCerebrasProviderRequestId
  "x-request-id",
  "x-api-request-id",
  "x-cerebras-request-id",
  // getDeepSeekProviderRequestId
  "x-ds-request-id",
  "x-deepseek-request-id",
  // The gateway's own bounded replacement is never reflected either.
  "x-uos-provider-request-id",
] as const;

test("provider native correlation header vocabulary stays complete and canonical", () => {
  const declared = new Set<string>(PROVIDER_NATIVE_CORRELATION_HEADERS);
  for (const header of READER_ACCEPTED_HEADERS) {
    assert.equal(declared.has(header), true, `${header} must be scrubbed`);
  }
  assert.equal(declared.size, PROVIDER_NATIVE_CORRELATION_HEADERS.length, "the vocabulary must not repeat a header");
  for (const header of PROVIDER_NATIVE_CORRELATION_HEADERS) {
    assert.equal(header, header.toLowerCase(), `${header} must be lowercase`);
  }
  // x-oneapi-request-id is a documented legacy spelling of a Codex relay and
  // is scrubbed even though no current reader names it.
  assert.equal(declared.has("x-oneapi-request-id"), true);
});

test("scrubbing removes every provider native correlation header", () => {
  const headers = new Headers();
  for (const header of PROVIDER_NATIVE_CORRELATION_HEADERS) headers.set(header, `provider-native-${header}`);
  headers.set("x-uos-warning", "kept");
  headers.set("content-type", "application/json");

  scrubProviderNativeCorrelationHeaders(headers);

  for (const header of PROVIDER_NATIVE_CORRELATION_HEADERS) {
    assert.equal(headers.get(header), null, `${header} must not survive`);
  }
  assert.equal(headers.get("x-uos-warning"), "kept");
  assert.equal(headers.get("content-type"), "application/json");
});
