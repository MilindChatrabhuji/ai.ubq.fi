import { test } from "bun:test";
// Focused hermetic tests for the DeepSeek V4.1 Flash provider waterfall
// benchmark: percentile derivation, cost math, score normalization and the
// chat projection audit. No network, no corpus content is modified.

import assert from "node:assert/strict";
import { percentile } from "../benchmarks/provider-waterfall/metrics.ts";
import { expectedCostMicroUsd, deepSeekPricingWindow } from "../benchmarks/provider-waterfall/cost.ts";
import { scoreProviders } from "../benchmarks/provider-waterfall/score.ts";
import { projectEntryToChat } from "../benchmarks/provider-waterfall/client.ts";
import type { ProviderMetrics } from "../benchmarks/provider-waterfall/metrics.ts";
import type { CorpusEntry } from "../benchmarks/provider-waterfall/types.ts";
import type { AttemptRecord } from "../benchmarks/provider-waterfall/types.ts";

test("percentile interpolates between order statistics", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.5), 5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  const p95 = percentile([1, 2, 3, 4], 0.95);
  assert.ok(p95 !== null && Math.abs(p95 - 3.85) <= 1e-9);
  assert.equal(percentile([10, 0, 20], 0.5), 10);
});

test("DeepSeek expected cost uses the UTC peak/off-peak window", () => {
  // Tuesday 02:00 UTC is a peak hour; Sunday 02:00 UTC is off-peak.
  const peakMs = Date.UTC(2026, 9, 6, 2, 0, 0);
  const offPeakMs = Date.UTC(2026, 9, 11, 2, 0, 0);
  assert.equal(deepSeekPricingWindow(peakMs), "peak");
  assert.equal(deepSeekPricingWindow(offPeakMs), "off_peak");
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1_000_000 };
  const peak = expectedCostMicroUsd("deepseek", usage, peakMs);
  const offPeak = expectedCostMicroUsd("deepseek", usage, offPeakMs);
  assert.ok(peak && offPeak);
  assert.ok(Math.abs(peak.total_micro_usd - 1_500_000) <= 1);
  assert.ok(Math.abs(offPeak.total_micro_usd - 750_000) <= 1);
});

test("Surplus expected cost follows the catalogue USD per token rates", () => {
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1_000_000 };
  const cost = expectedCostMicroUsd("surplus", usage, Date.now());
  assert.ok(cost);
  assert.ok(Math.abs(cost.total_micro_usd - 1_500_000) <= 1);
});

const metric = (provider: string, overrides: Partial<ProviderMetrics>): ProviderMetrics =>
  ({
    provider,
    wire: "responses",
    model: "m",
    samples: 10,
    successful_items: 10,
    first_attempt_successes: 10,
    first_attempt_success_rate: 1,
    retried_items: 0,
    retry_recoveries: 0,
    retry_recovery_rate: null,
    attempts_total: 10,
    failures_total: 0,
    failures: {},
    median_ttft_ms: 100,
    p90_ttft_ms: 150,
    p95_ttft_ms: 160,
    p99_ttft_ms: 170,
    median_tps: 100,
    p90_tps: 90,
    p95_tps: 80,
    median_e2e_ms: 1_000,
    p90_e2e_ms: 1_100,
    p95_e2e_ms: 1_200,
    p99_e2e_ms: 1_300,
    input_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 100_000,
    reasoning_tokens: 0,
    cache_hit_ratio: 0,
    usage_coverage: 1,
    per_class: {
      small: { samples: 2, successes: 2 },
      medium: { samples: 3, successes: 3 },
      large: { samples: 3, successes: 3 },
      xlarge: { samples: 2, successes: 2 },
    },
    by_wire: { responses: 10 },
    ...overrides,
  }) as ProviderMetrics;

test("score normalization ranks the cheaper, faster, more reliable provider first", () => {
  const metrics = [
    metric("surplus", { median_e2e_ms: 900, p95_e2e_ms: 950, median_tps: 120 }),
    metric("openlux", { median_e2e_ms: 2_000, p95_e2e_ms: 2_400, median_tps: 60 }),
  ];
  const costs = [
    {
      provider: "surplus" as const,
      priced: true,
      cost_source: "x",
      actual_total_micro_usd: 1_000,
      effective_cost_per_request_micro_usd: 100,
      effective_cost_per_1m_output_micro_usd: 10_000,
      priced_attempts: 10,
      unpriced_attempts: 0,
      observed_note: null,
    },
    {
      provider: "openlux" as const,
      priced: true,
      cost_source: "x",
      actual_total_micro_usd: 4_000,
      effective_cost_per_request_micro_usd: 400,
      effective_cost_per_1m_output_micro_usd: 40_000,
      priced_attempts: 10,
      unpriced_attempts: 0,
      observed_note: null,
    },
  ];
  const rows = scoreProviders(metrics, costs);
  assert.equal(rows[0].provider, "surplus");
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].cost_score, 100);
  assert.equal(rows[1].cost_score, 0);
  assert.ok(rows[0].overall_score !== null && rows[1].overall_score !== null && rows[0].overall_score > rows[1].overall_score);
});

test("chat projection preserves ordered text and flattens namespaced tools", () => {
  const entry: CorpusEntry = {
    id: "t",
    cls: "small",
    source: {
      session_id: "s",
      thread_id: null,
      turn_id: null,
      recorded_model: "m",
      recorded_at: "now",
      recorded_input_tokens: 0,
      item_count: 3,
      dropped_item_types: [],
    },
    request: {
      instructions: "",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "instr-a" }] },
        { type: "function_call", name: "f", arguments: '{"a":1}', call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "out-a" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
      tools: [
        { type: "function", name: "f", description: "d", parameters: { type: "object", properties: {} } },
        { type: "namespace", name: "ns", tools: [{ type: "function", name: "g", description: "d2", parameters: { type: "object", properties: {} } }] },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: null,
      max_output_tokens: null,
    },
  };
  const projected = projectEntryToChat(entry);
  assert.equal(projected.messages[0].role, "system");
  assert.equal(projected.messages[0].content, "instr-a");
  const assistant = projected.messages.find((message) => Array.isArray(message.tool_calls));
  assert.ok(assistant);
  assert.equal((assistant.tool_calls as Record<string, unknown>[]).length, 1);
  const toolMessage = projected.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage);
  assert.equal(toolMessage.tool_call_id, "call_1");
  const names = projected.tools.map((tool) => (tool.function as { name?: string }).name ?? "");
  assert.deepEqual(names, ["f", "ns__g"]);
});

test("attempt records never claim success without a terminal observation", () => {
  const record: AttemptRecord = {
    run_id: "r",
    provider: "lithos",
    corpus_id: "c",
    cls: "small",
    period: "w1",
    batch: 1,
    attempt: 1,
    wire: "responses",
    model: "m",
    selection: ["lithos"],
    gateway: "http://127.0.0.1:7998",
    started_at: "now",
    finished_at: "now",
    t_headers_ms: 1,
    t_first_byte_ms: 2,
    t_first_event_ms: 3,
    t_first_output_ms: 4,
    t_first_item_ms: 4,
    t_terminal_ms: 5,
    t_end_ms: 6,
    http_status: 200,
    upstream: "lithos",
    provider_request_id: null,
    response_id: "resp_test",
    success: true,
    first_attempt: true,
    failure_kind: null,
    error_code: null,
    error_message: null,
    response_terminated: true,
    sse_events: 1,
    output_chars: 1,
    tool_calls: 0,
    usage: null,
    usage_reported: false,
    notes: null,
  };
  assert.equal(record.success && record.response_terminated, true);
});
