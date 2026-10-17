import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import { serveHttp } from "#http";
import type { NetAddr } from "#http";
import { runSequence } from "./helpers/sequence.ts";
import assert from "node:assert/strict";

import { handleLithosChatCompletions, handleLithosResponses } from "../src/provider/lithos-handlers.ts";
import { LITHOS_CHAT_COMPLETIONS_URL } from "../src/provider/lithos.ts";
import {
  clearLithosFailoverWindows,
  lithosFailoverTargetAt,
  lithosOpenFailoverWindow,
  lithosRefusalWait,
  LITHOS_STREAMED_REFUSAL_WAIT_POLICY,
  waitForLithosRetry,
} from "../src/provider/lithos-rate-limits.ts";

const ULTRA = "deepseek-ai/DeepSeek-V4.1-Flash-ultra";
const FAST = "deepseek-ai/DeepSeek-V4.1-Flash-fast";
const BASE = "deepseek-ai/DeepSeek-V4.1-Flash";

test("Lithos tier windows expire independently in both reset orders and model families", () => {
  try {
    for (const family of ["deepseek-ai/DeepSeek-V4.1-Flash", "moonshotai/Kimi-K3"]) {
      const ultra = `${family}-ultra`;
      const fast = `${family}-fast`;
      for (const [ultraWait, fastWait] of [
        [60_000, 1_000],
        [1_000, 60_000],
      ]) {
        clearLithosFailoverWindows();
        lithosOpenFailoverWindow(ultra, 1_000, ultraWait, fast);
        lithosOpenFailoverWindow(ultra, 1_000, fastWait, family);
        assert.equal(lithosFailoverTargetAt(ultra, 1_999), family);
        assert.equal(lithosFailoverTargetAt(ultra, 2_000), ultraWait === 1_000 ? null : fast);
        assert.equal(lithosFailoverTargetAt(fast, 2_000), fastWait === 1_000 ? null : family);
        assert.equal(lithosFailoverTargetAt(ultra, 61_000), null);
        assert.equal(lithosFailoverTargetAt(fast, 61_000), null);
      }
    }
  } finally {
    clearLithosFailoverWindows();
  }
});

test("out-of-order shallow refusals cannot borrow the fast deadline and same-rung windows never shorten", () => {
  clearLithosFailoverWindows();
  try {
    lithosOpenFailoverWindow(ULTRA, 1_000, 60_000, BASE);
    lithosOpenFailoverWindow(ULTRA, 1_500, 1_000, FAST);
    assert.equal(lithosFailoverTargetAt(ULTRA, 2_499), BASE);
    assert.equal(lithosFailoverTargetAt(ULTRA, 2_500), null);
    assert.equal(lithosFailoverTargetAt(FAST, 2_500), BASE);

    // A direct fast refusal and one reached through ultra share one bucket.
    lithosOpenFailoverWindow(FAST, 3_000, 1_000, BASE);
    assert.equal(lithosFailoverTargetAt(FAST, 60_999), BASE);
    assert.equal(lithosFailoverTargetAt(FAST, 61_000), null);
    lithosOpenFailoverWindow(FAST, 61_000, 1_000, BASE);
    lithosOpenFailoverWindow(ULTRA, 61_000, 60_000, FAST);
    assert.equal(lithosFailoverTargetAt(ULTRA, 61_999), BASE);
    assert.equal(lithosFailoverTargetAt(ULTRA, 62_000), FAST);

    lithosOpenFailoverWindow(ULTRA, 62_000, 1_000, FAST);
    assert.equal(lithosFailoverTargetAt(ULTRA, 120_999), FAST);
    assert.equal(lithosFailoverTargetAt(ULTRA, 121_000), null);
  } finally {
    clearLithosFailoverWindows();
  }
});

test("illegal and nonfinite windows are ignored, base stays legal, and clear resets all rungs", () => {
  clearLithosFailoverWindows();
  try {
    for (const waitMs of [NaN, Infinity, -Infinity, 0, -1]) {
      lithosOpenFailoverWindow(ULTRA, 1_000, waitMs, FAST);
    }
    for (const nowMs of [NaN, Infinity, -Infinity]) lithosOpenFailoverWindow(ULTRA, nowMs, 1_000, FAST);
    lithosOpenFailoverWindow(ULTRA, Number.MAX_VALUE, Number.MAX_VALUE, FAST);
    for (const target of [ULTRA, "moonshotai/Kimi-K3", `${ULTRA}-chat`]) lithosOpenFailoverWindow(ULTRA, 1_000, 60_000, target);
    lithosOpenFailoverWindow(BASE, 1_000, 60_000, FAST);
    assert.equal(lithosFailoverTargetAt(ULTRA, 1_000), null);
    assert.equal(lithosFailoverTargetAt(BASE, 1_000), null);
    lithosOpenFailoverWindow(ULTRA, 1_000, 60_000, FAST);
    lithosOpenFailoverWindow(FAST, 1_000, 60_000, BASE);
    assert.equal(lithosFailoverTargetAt(ULTRA, 1_000), BASE);
    assert.equal(lithosFailoverTargetAt(BASE, 1_000), null);
    clearLithosFailoverWindows();
    assert.equal(lithosFailoverTargetAt(ULTRA, 1_000), null);
    assert.equal(lithosFailoverTargetAt(FAST, 1_000), null);
  } finally {
    clearLithosFailoverWindows();
  }
});

type HttpFixture = Readonly<{ models: string[]; setHandler: (handler: (model: string, index: number) => Response) => void }>;

const completion = (model: string): Response =>
  Response.json({
    id: "chatcmpl-tier-window",
    object: "chat.completion",
    created: 1_790_160_326,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: "fixture answer", reasoning_content: "fixture reasoning", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });

const refusal = (waitMs: number, retryable = true): Response =>
  Response.json(
    { error: { message: "Fixture input token limit", type: "input_tokens", code: "rate_limit_exceeded" } },
    { status: 429, headers: { "retry-after-ms": String(waitMs), ...(retryable ? {} : { "x-should-retry": "false" }) } }
  );

/** Only the real Lithos HTTP destination is redirected to this disposable loopback server. */
const withHttpFixture = async (run: (fixture: HttpFixture) => Promise<void>): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.LITHOSAI_API_KEY;
  console.info("Lithos HTTP fixture preexisting credential present", previousKey !== undefined);
  const models: string[] = [];
  let handler: (model: string, index: number) => Response = completion;
  const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
    assert.equal(request.headers.get("authorization"), "Bearer lith_sk_tier_window_fixture");
    const body = (await request.json()) as { model: string };
    models.push(body.model);
    return handler(body.model, models.length);
  });
  await server.ready;
  const address = server.addr as NetAddr;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, LITHOS_CHAT_COMPLETIONS_URL, "no alternate provider or discovery request is authorized");
    return originalFetch(`http://127.0.0.1:${address.port}/chat/completions`, init);
  });
  process.env.LITHOSAI_API_KEY = "lith_sk_tier_window_fixture";
  try {
    await run({
      models,
      setHandler: (next) => {
        handler = next;
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) Reflect.deleteProperty(process.env, "LITHOSAI_API_KEY");
    else process.env.LITHOSAI_API_KEY = previousKey;
    await server.shutdown();
    await server.finished;
    clearLithosFailoverWindows();
  }
};

const dispatch = async (route: string, model: string, stream = false): Promise<Response> => {
  const body = route === "chat" ? { model, messages: [{ role: "user", content: "hi" }], stream } : { model, input: "hi", stream };
  const request = new Request(`https://ai.ubq.fi/v1/${route === "chat" ? "chat/completions" : "responses"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await (route === "chat" ? handleLithosChatCompletions(request, body, model) : handleLithosResponses(request, body, model));
};

test("real Lithos Chat and Responses HTTP dispatch returns to each recovered rung at its own reset", async () =>
  runSequence(async (step) => {
    const originalNow = Date.now;
    try {
      for (const route of ["chat", "responses"]) {
        for (const [ultraWait, fastWait] of [
          [60_000, 1_000],
          [1_000, 60_000],
        ]) {
          await step(`${route}: ultra ${ultraWait}ms, fast ${fastWait}ms`, async () => {
            clearLithosFailoverWindows();
            const started = originalNow();
            let nowMs = started;
            Date.now = () => nowMs;
            await withHttpFixture(async ({ models, setHandler }) => {
              setHandler((model, index) => {
                if (index === 1) return refusal(ultraWait);
                if (index === 2) return refusal(fastWait);
                return completion(model);
              });
              const first = await dispatch(route, ULTRA);
              assert.equal(first.status, 200);
              await first.text();
              assert.deepEqual(models, [ULTRA, FAST, BASE]);
              setHandler(completion);
              for (const [elapsed, requested, expected] of [
                [999, ULTRA, BASE],
                [1_000, ULTRA, ultraWait === 1_000 ? ULTRA : FAST],
                [1_000, FAST, fastWait === 1_000 ? FAST : BASE],
                [60_000, ULTRA, ULTRA],
              ] as const) {
                nowMs = started + elapsed;
                const previousCalls = models.length;
                const response = await dispatch(route, requested);
                assert.equal(response.status, 200);
                await response.text();
                assert.deepEqual(models.slice(previousCalls), [expected]);
              }
              console.info("Lithos tier-window HTTP proof", JSON.stringify({ route, ultraWait, fastWait, models }));
            });
          });
        }
      }
    } finally {
      Date.now = originalNow;
      clearLithosFailoverWindows();
    }
  }));

test("a no-retry tier is not dispatched again after a later tier names the wait window", async () => {
  await withHttpFixture(async ({ models, setHandler }) => {
    setHandler((model, index) => {
      if (index === 1) return refusal(1, false);
      if (index <= 3) return refusal(1);
      return completion(model);
    });
    const response = await dispatch("chat", ULTRA);
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(models, [ULTRA, FAST, BASE, FAST]);
  });
});

test("real Lithos HTTP transient failure does not fail over to another tier or provider", async () => {
  clearLithosFailoverWindows();
  await withHttpFixture(async ({ models, setHandler }) => {
    setHandler(() =>
      Response.json({ error: { message: "Fixture upstream unavailable", type: "server_error", code: "upstream_unavailable" } }, { status: 503 })
    );
    const response = await dispatch("chat", ULTRA);
    assert.equal(response.status, 503);
    await response.text();
    assert.deepEqual(models, [ULTRA]);
  });
});

test("real Lithos HTTP deferred 504 is preserved in both streamed terminals", async () => {
  for (const route of ["chat", "responses"]) {
    await withHttpFixture(async ({ models, setHandler }) => {
      setHandler((_model, index) =>
        index <= 3
          ? refusal(1)
          : Response.json(
              { error: { message: "provider gateway timed out", code: "provider_gateway_timeout" } },
              { status: 504, headers: { "content-type": "application/json" } }
            )
      );
      const response = await dispatch(route, ULTRA, true);
      const text = await response.text();
      assert.equal(response.status, 200, route);
      assert.deepEqual(models, [ULTRA, FAST, BASE, ULTRA], route);
      assert.match(text, /provider_gateway_timeout/, route);
      assert.match(text, /provider gateway timed out/, route);
      if (route === "responses") assert.match(text, /"type":"response\.failed"/, route);
    });
  }
});

test("619 abort reasons and existing bounded retry waits survive independent tier windows", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    const controller = new AbortController();
    const reason = new DOMException("Tier window fixture", name);
    controller.abort(reason);
    await assert.rejects(waitForLithosRetry(10_000, controller.signal), (error) => error === reason);
    const waiting = new AbortController();
    const pending = waitForLithosRetry(10_000, waiting.signal);
    waiting.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
  }
  const headers = new Headers({ "retry-after-ms": "75000" });
  assert.equal(lithosRefusalWait(headers, 0, 0)?.waitMs, 75_000);
  assert.equal(lithosRefusalWait(new Headers({ "retry-after-ms": "75001" }), 0, 0), null);
  assert.equal(lithosRefusalWait(headers, 45_001, 0), null);
  assert.equal(lithosRefusalWait(headers, 0, 2), null);
  assert.equal(lithosRefusalWait(headers, 225_000, 4, LITHOS_STREAMED_REFUSAL_WAIT_POLICY)?.waitMs, 75_000);
  assert.equal(lithosRefusalWait(headers, 225_001, 4, LITHOS_STREAMED_REFUSAL_WAIT_POLICY), null);
  assert.equal(lithosRefusalWait(headers, 0, 5, LITHOS_STREAMED_REFUSAL_WAIT_POLICY), null);
});
