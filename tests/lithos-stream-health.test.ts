import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Kv, KvEntryMaybe, KvKey } from "#kv";

import { getLithosProviderHealth, resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { setKvForTest } from "../src/kv.ts";
import { streamLithosChatCompletion, streamLithosResponses } from "../src/provider/lithos-streams.ts";

const values = new Map<string, unknown>();
const keyOf = (key: KvKey): string => JSON.stringify(key);
const kvStub = {
  get: (key: KvKey) => Promise.resolve({ key, value: values.get(keyOf(key)) ?? null, versionstamp: null } as KvEntryMaybe<unknown>),
  atomic: () => {
    const sets: { key: KvKey; value: unknown }[] = [];
    const chain = {
      set: (key: KvKey, value: unknown) => {
        sets.push({ key, value });
        return chain;
      },
      commit: () => {
        for (const entry of sets) values.set(keyOf(entry.key), entry.value);
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
} as unknown as Kv;

setKvForTest(kvStub);

const flushHealth = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("in-band Lithos 429 and 401 refusals retain their classified stream health", async () => {
  values.clear();
  resetProviderHealthThrottleForTest();
  const signal = new AbortController().signal;

  for (const [status, event, state] of [
    [429, "quota_exhausted", "exhausted"],
    [401, "auth_invalid", "invalid"],
  ] as const) {
    for (const wire of ["chat", "responses"] as const) {
      const upstream = Response.json({ error: { message: "fixture refusal", code: status === 429 ? "rate_limit_exceeded" : "invalid_api_key" } }, { status });
      const response =
        wire === "chat"
          ? streamLithosChatCompletion(upstream, null, undefined, signal, signal, "deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-ai/DeepSeek-V4.1-Flash")
          : streamLithosResponses(
              upstream,
              "deepseek-ai/DeepSeek-V4.1-Flash",
              `resp_${status}`,
              1_800_000_000,
              { tools: [], tool_choice: "auto", parallel_tool_calls: true, instructions: null },
              new Map(),
              new Set(),
              null,
              undefined,
              signal,
              signal,
              "deepseek-ai/DeepSeek-V4.1-Flash",
              "deepseek-ai/DeepSeek-V4.1-Flash"
            );

      assert.equal(response.status, 200);
      assert.match(await response.text(), /fixture refusal/);
      await flushHealth();
      const health = await getLithosProviderHealth();
      assert.equal(health.state, state);
      assert.equal(health.last_event, event);
      assert.equal(health.last_status, status);
    }
  }
});
