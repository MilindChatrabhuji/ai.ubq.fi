import { test } from "bun:test";
import assert from "node:assert/strict";
import { CODEX_CLIENT_RETRY_AFTER_MAX_SECONDS, codexRetryAfterSeconds } from "../src/codex/dispatch.ts";

test("a weekly quota deadline is capped to a client-sized retry", () => {
  const now = 1_000_000;
  assert.equal(codexRetryAfterSeconds(now + 7 * 24 * 60 * 60_000, now), CODEX_CLIENT_RETRY_AFTER_MAX_SECONDS);
});

test("a short retry keeps its real remaining seconds", () => {
  const now = 1_000_000;
  assert.equal(codexRetryAfterSeconds(now + 45_000, now), 45);
});

test("an elapsed or near deadline still asks for a positive retry", () => {
  const now = 1_000_000;
  assert.equal(codexRetryAfterSeconds(now - 10_000, now), 1);
  assert.equal(codexRetryAfterSeconds(now + 1, now), 1);
});
