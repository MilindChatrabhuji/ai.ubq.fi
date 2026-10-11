import assert from "node:assert/strict";

import {
  createChatMessageElement,
  createChatStatsAccumulator,
  formatCacheHitPercent,
  formatChatDuration,
  formatChatStatsLine,
  formatChatTokens,
  parseChatCompletionStreamEvent,
  parseChatSseEvent,
  readChatCompletionDecodeTokens,
  readChatCompletionMessageText,
  readChatCompletionUsage,
  recordCompletedChatResponse,
  renderChatStats,
  resetChatStatsAccumulator,
  setChatMessageContent,
  splitChatSseEvents,
} from "../static/chat-stats.js";

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly ownerDocument: FakeDocument;
  parentElement: FakeElement | null = null;
  hidden = true;
  textContent = "";
  title = "";

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  querySelector(selector: string): FakeElement | null {
    const dataName = /^\[data-([a-z-]+)\]$/.exec(selector)?.[1];
    if (!dataName) return null;
    const datasetKey = dataName.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return this.children.find((child) => datasetKey in child.dataset) ?? null;
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
}

class FakeDocument {
  createElement(_tag: string): FakeElement {
    return new FakeElement(this);
  }
}

Deno.test("chat stats aggregate completed responses with weighted averages", () => {
  const stats = createChatStatsAccumulator();
  assert.equal(
    recordCompletedChatResponse(stats, {
      llmMs: 1_000,
      decodeMs: 500,
      decodeTokens: 10,
      ttftMs: 100,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 25 },
      },
    }),
    true
  );
  assert.equal(
    recordCompletedChatResponse(stats, {
      llmMs: 3_000,
      decodeMs: 1_500,
      decodeTokens: 90,
      ttftMs: 900,
      usage: {
        prompt_tokens: 900,
        completion_tokens: 90,
        total_tokens: 990,
        prompt_tokens_details: { cached_tokens: 675 },
      },
    }),
    true
  );

  assert.equal(formatChatStatsLine(stats), "2 turns · 2 steps | LLM avg 2s | TTFT avg 0.5s · 50 tok/s | " + "Cache hit 70% | Input 1K tok · Output 100 tok");
});

Deno.test("chat message text preserves non-streaming refusals", () => {
  assert.equal(
    readChatCompletionMessageText({
      choices: [{ message: { role: "assistant", content: null, refusal: "I cannot help with that." } }],
    }),
    "I cannot help with that."
  );
  assert.equal(
    readChatCompletionMessageText({
      choices: [{ message: { role: "assistant", content: "Normal response", refusal: "Ignored fallback" } }],
    }),
    "Normal response"
  );
  assert.equal(readChatCompletionMessageText({ choices: [{ message: { content: null } }] }), null);
  assert.equal(readChatCompletionMessageText({ choices: [{ message: { content: "  \n" } }] }), null);
});

Deno.test("chat stats align decode tokens with visible streamed output", () => {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 90,
    completion_tokens_details: { reasoning_tokens: 80 },
  };
  assert.equal(readChatCompletionDecodeTokens(usage, "high"), 10);
  assert.equal(readChatCompletionDecodeTokens({ prompt_tokens: 100, completion_tokens: 90 }, "high"), null);
  assert.equal(readChatCompletionDecodeTokens({ prompt_tokens: 100, completion_tokens: 90 }, "none"), 90);
  assert.equal(readChatCompletionDecodeTokens({ ...usage, completion_tokens_details: { reasoning_tokens: 91 } }, "high"), null);
});

Deno.test("chat stats omit metrics that the browser cannot measure", () => {
  const stats = createChatStatsAccumulator();
  recordCompletedChatResponse(stats, { llmMs: 900 });
  const line = formatChatStatsLine(stats);
  assert.equal(line, "1 turns · 1 steps | LLM avg 0.9s");
  assert.doesNotMatch(line, /Tool call|TTFT|tok\/s|Cache hit|Input|Output|NaN|Infinity/);
});

Deno.test("chat stats keep cache-write details out of the OpenAI prompt total", () => {
  assert.deepEqual(
    readChatCompletionUsage({
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 },
    }),
    {
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 20,
    }
  );
  const stats = createChatStatsAccumulator();
  recordCompletedChatResponse(stats, {
    llmMs: 1_000,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 },
    },
  });
  assert.match(formatChatStatsLine(stats), /Cache hit 40% \| Input 100 tok · Output 25 tok$/);
});

Deno.test("chat stats preserve unknown cache measurements instead of publishing a measured zero", () => {
  for (const details of [undefined, { cached_tokens: -0.1, cache_write_tokens: 0.9 }]) {
    assert.deepEqual(readChatCompletionUsage({ prompt_tokens: 100, completion_tokens: 10, ...(details ? { prompt_tokens_details: details } : {}) }), {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
    });
  }
  assert.deepEqual(readChatCompletionUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }), {
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  });
});

Deno.test("chat stats omit throughput without measured tokens or elapsed LLM time", () => {
  const withoutUsage = createChatStatsAccumulator();
  recordCompletedChatResponse(withoutUsage, { llmMs: 1_000, decodeMs: 500 });
  assert.doesNotMatch(formatChatStatsLine(withoutUsage), /tok\/s/);

  const withoutElapsedTime = createChatStatsAccumulator();
  recordCompletedChatResponse(withoutElapsedTime, {
    llmMs: 1_000,
    decodeMs: 0,
    decodeTokens: 90,
    usage: { prompt_tokens: 100, completion_tokens: 90, total_tokens: 190 },
  });
  assert.doesNotMatch(formatChatStatsLine(withoutElapsedTime), /tok\/s/);

  const withoutDecodeInterval = createChatStatsAccumulator();
  recordCompletedChatResponse(withoutDecodeInterval, {
    llmMs: 1_000,
    usage: { prompt_tokens: 100, completion_tokens: 90, total_tokens: 190 },
  });
  assert.doesNotMatch(formatChatStatsLine(withoutDecodeInterval), /tok\/s/);
});

Deno.test("chat stats omit token aggregates until every completed response reports usage", () => {
  const stats = createChatStatsAccumulator();
  recordCompletedChatResponse(stats, {
    llmMs: 1_000,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 50 },
    },
  });
  recordCompletedChatResponse(stats, { llmMs: 3_000 });

  const line = formatChatStatsLine(stats);
  assert.equal(line, "2 turns · 2 steps | LLM avg 2s");
  assert.doesNotMatch(line, /tok\/s|Cache hit|Input|Output/);
});

Deno.test("chat stats omit throughput unless every completed response has measurable timing", () => {
  const stats = createChatStatsAccumulator();
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 50 },
  };
  recordCompletedChatResponse(stats, { llmMs: 1_000, decodeMs: 500, usage });
  recordCompletedChatResponse(stats, { llmMs: 1_000, decodeMs: 0, decodeTokens: 10, usage });

  const line = formatChatStatsLine(stats);
  assert.doesNotMatch(line, /tok\/s/);
  assert.match(line, /Cache hit 50% \| Input 200 tok · Output 20 tok$/);
});

Deno.test("chat stats keep partial cache ratios below 100 percent", () => {
  assert.equal(formatCacheHitPercent(1_000, 1_000), "100");
  assert.equal(formatCacheHitPercent(999, 1_000), "99.9");
  assert.equal(formatCacheHitPercent(null, 1_000), null);
});

Deno.test("chat stats use compact token and duration formatting", () => {
  assert.equal(formatChatTokens(517), "517");
  assert.equal(formatChatTokens(12_200), "12.2K");
  assert.equal(formatChatTokens(517_000), "517K");
  assert.equal(formatChatTokens(1_200_000), "1.2M");
  assert.equal(formatChatDuration(45_200), "45.2s");
  assert.equal(formatChatDuration(162_000), "2m42s");
});

Deno.test("chat message content never contains a stats footer", () => {
  const documentRef = new FakeDocument();
  const message = createChatMessageElement(documentRef, "assistant", "First token");

  setChatMessageContent(message, "Complete streamed response");

  assert.equal(message.querySelector("[data-message-content]")?.textContent, "Complete streamed response");
  assert.equal(message.querySelector("[data-message-stats]"), null);
  assert.equal(message.children.length, 1);
});

Deno.test("chat stats reset clears and hides the single bar", () => {
  const stats = createChatStatsAccumulator();
  recordCompletedChatResponse(stats, { llmMs: 1_200 });
  const bar = new FakeElement(new FakeDocument());

  assert.equal(renderChatStats(bar, stats), "1 turns · 1 steps | LLM avg 1.2s");
  assert.equal(bar.hidden, false);

  resetChatStatsAccumulator(stats);
  assert.equal(renderChatStats(bar, stats), "");
  assert.equal(bar.textContent, "");
  assert.equal(bar.title, "");
  assert.equal(bar.hidden, true);
});

Deno.test("chat stats reject incomplete response samples without changing averages", () => {
  const stats = createChatStatsAccumulator();
  recordCompletedChatResponse(stats, { llmMs: 1_000, ttftMs: 250 });
  const completedStats = structuredClone(stats);

  assert.equal(recordCompletedChatResponse(stats, {}), false);
  assert.deepEqual(stats, completedStats);
});

Deno.test("chat stream events preserve refusals, usage, completion, and failures", () => {
  assert.deepEqual(parseChatCompletionStreamEvent('{"choices":[{"delta":{"refusal":"I cannot help with that."}}]}'), {
    kind: "event",
    delta: "I cannot help with that.",
    usage: undefined,
  });
  assert.deepEqual(parseChatCompletionStreamEvent('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}'), {
    kind: "event",
    delta: "",
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
  assert.deepEqual(parseChatCompletionStreamEvent("[DONE]"), { kind: "done" });
  assert.deepEqual(parseChatCompletionStreamEvent('{"error":{"message":"The upstream stream ended unexpectedly.","code":"upstream_stream_error"}}'), {
    kind: "error",
    message: "The upstream stream ended unexpectedly.",
  });
  assert.deepEqual(parseChatCompletionStreamEvent("not JSON"), { kind: "invalid" });
  assert.deepEqual(parseChatCompletionStreamEvent("{}"), { kind: "invalid" });
  assert.deepEqual(parseChatCompletionStreamEvent('{"choices":"bad"}'), { kind: "invalid" });
  assert.deepEqual(parseChatCompletionStreamEvent('{"choices":[{"delta":"bad"}]}'), { kind: "invalid" });
  assert.deepEqual(parseChatCompletionStreamEvent('{"choices":[],"usage":{}}'), { kind: "invalid" });
});

Deno.test("chat SSE framing accepts all line endings and a final unterminated event", () => {
  assert.deepEqual(splitChatSseEvents("data: first\r\n\r\ndata: second\n\ndata: final", true), {
    events: ["data: first", "data: second", "data: final"],
    remaining: "",
  });

  assert.deepEqual(splitChatSseEvents("data: partial\r\n"), {
    events: [],
    remaining: "data: partial\r\n",
  });

  assert.deepEqual(splitChatSseEvents("data: lf-crlf\n\r\ndata: crlf-lf\r\n\n"), {
    events: ["data: lf-crlf", "data: crlf-lf"],
    remaining: "",
  });
});

Deno.test("chat SSE parsing accepts CR-only comments and multiline data", () => {
  assert.deepEqual(parseChatSseEvent(': keep-alive\rdata: {"choices":[\rdata: {"delta":{"content":"CR stream"}}\rdata: ]}'), {
    kind: "event",
    delta: "CR stream",
    usage: undefined,
  });
});
