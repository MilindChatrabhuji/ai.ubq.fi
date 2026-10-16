import { test } from "bun:test";
import assert from "node:assert/strict";
import { runHealthCheck } from "../scripts/health-check.ts";

test("health check rejects --auth before making a network request", async () => {
  let fetchCalls = 0;
  const errors: string[] = [];
  const exitCode = await runHealthCheck(["--url", "https://ai.ubq.fi", "--auth"], {
    fetcher: () => {
      fetchCalls += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
    log: () => {},
    error: (message) => errors.push(message),
  });

  assert.equal(exitCode, 2);
  assert.equal(fetchCalls, 0);
  assert.match(errors.join("\n"), /--auth is no longer supported/);
});
