import { test } from "bun:test";
import assert from "node:assert/strict";

import { getCodexAccountEmail } from "../src/codex/index.ts";

// Base64url drops the `=` padding. Trimming it with an unanchored `/=+$/` regex
// is super-linear (measured ~1.6s per 20k-character run of `=`), so the
// trailing run is removed with an explicit linear scan instead.
const stripBase64Padding = (base64: string): string => {
  let end = base64.length;
  while (end > 0 && base64[end - 1] === "=") end -= 1;
  return base64.slice(0, end);
};

const encodeBase64Url = (value: unknown): string =>
  stripBase64Padding(btoa(JSON.stringify(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const tokenWithPayload = (payload: unknown): string => `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url(payload)}.signature`;

test("Codex account email is read from the provider profile claim", () => {
  const token = tokenWithPayload({
    "https://api.openai.com/profile": { email: "first@example.com" },
  });
  assert.equal(getCodexAccountEmail(token), "first@example.com");
});

test("Codex account email falls back to the top-level claim and rejects invalid tokens", () => {
  assert.equal(getCodexAccountEmail(tokenWithPayload({ email: "second@example.com" })), "second@example.com");
  assert.equal(getCodexAccountEmail("not-a-jwt"), null);
  assert.equal(getCodexAccountEmail(tokenWithPayload({ email: "not-an-email" })), null);
});
