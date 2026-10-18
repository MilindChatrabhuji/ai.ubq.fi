import type { Kv, KvKey } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CodexModelsSnapshot } from "../src/models/codex-models.ts";
import { loadFullCodexModelsSnapshot } from "../src/codex/index.ts";
import { buildRuntimeConfig, normalizeRuntimeConfig, RUNTIME_CONFIG_MAX_BYTES, RuntimeConfigError } from "../src/runtime-config.ts";

const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

test("runtime config compacts a near-limit full catalog into one 4 KiB read unit", () => {
  const fullSnapshot: CodexModelsSnapshot = {
    models: [
      {
        slug: "gpt-compact-test",
        display_name: "GPT Compact Test",
        description: "x".repeat(57_000),
        visibility: "list",
        supported_in_api: true,
        context_window: 272_000,
        max_context_window: 1_000_000,
        auto_compact_token_limit: 250_000,
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: null }, "low", "medium", "high", "xhigh", "ultra"],
        reasoning_effort_wire_map: { ultra: "max" },
      },
    ],
    source: "chatgpt_codex",
    client_version: "0.201.0",
    updated_at_ms: 1_000_000,
  };
  assert.ok(jsonBytes(fullSnapshot) > 55_000);
  assert.ok(jsonBytes(fullSnapshot) < 60_000);

  const runtime = buildRuntimeConfig(fullSnapshot, {
    defaultModel: "gpt-compact-test",
    defaultReasoningEffort: "xhigh",
    nowMs: 1_000_001,
  });

  assert.ok(jsonBytes(runtime) <= RUNTIME_CONFIG_MAX_BYTES);
  assert.deepEqual(runtime.codex_models.models, [
    {
      slug: "gpt-compact-test",
      default_reasoning_level: "high",
      supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "ultra"],
      reasoning_effort_wire_map: { ultra: "max" },
    },
  ]);
  assert.deepEqual(normalizeRuntimeConfig(runtime), runtime);
});

test("runtime config rejects an extreme model inventory instead of crossing one read unit", () => {
  const fullSnapshot: CodexModelsSnapshot = {
    models: Array.from({ length: 200 }, (_, index) => ({
      slug: `gpt-runtime-model-${String(index).padStart(3, "0")}`,
      supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "ultra"],
      reasoning_effort_wire_map: { ultra: "max" },
    })),
    source: "chatgpt_codex",
    client_version: "0.201.0",
    updated_at_ms: 1_000_000,
  };
  assert.ok(jsonBytes(fullSnapshot) < 60_000);
  assert.throws(
    () => buildRuntimeConfig(fullSnapshot, { nowMs: 1_000_001 }),
    (error: unknown) => error instanceof RuntimeConfigError && error.message.includes("too large")
  );
});

test("runtime config keeps prompt-cache controls compact and excludes probe scope evidence", () => {
  const promptCache = {
    version: 1,
    providers: [
      {
        id: "codex_chatgpt",
        controls: {
          key: true,
          modes: ["implicit", "explicit"],
          source: "catalog",
          verified_at_ms: 1_000_000,
        },
        scope: {
          probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
          account_slots: "shared",
          token_refresh: "preserved",
          conversation_id: "independent",
          effective_model: "gpt-cache-runtime-".repeat(500),
          reproducible_cycles: 3,
          source: "live_probe",
          verified_at_ms: 1_000_001,
        },
      },
    ],
  };
  const runtime = buildRuntimeConfig(
    {
      models: [{ slug: "gpt-cache-runtime", prompt_cache: promptCache }],
      source: "chatgpt_codex",
      updated_at_ms: 1_000_000,
    },
    { nowMs: 1_000_002 }
  );

  assert.deepEqual(runtime.codex_models.models[0]?.prompt_cache, {
    version: 1,
    providers: [
      {
        id: "codex_chatgpt",
        controls: promptCache.providers[0].controls,
      },
    ],
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      (runtime.codex_models.models[0]?.prompt_cache as { providers?: Record<string, unknown>[] }).providers?.[0] ?? {},
      "scope"
    ),
    false
  );
  assert.ok(jsonBytes(runtime) <= RUNTIME_CONFIG_MAX_BYTES);
  assert.deepEqual(normalizeRuntimeConfig(runtime), runtime);
});

test("full Codex model loader preserves catalog fields outside the inference runtime record", async () => {
  const fullSnapshot: CodexModelsSnapshot = {
    models: [
      {
        slug: "gpt-full-loader",
        display_name: "GPT Full Loader",
        description: "Admin-only catalog detail",
        context_window: 272_000,
      },
    ],
    source: "chatgpt_codex",
    client_version: "0.201.0",
    updated_at_ms: 1_000_000,
  };
  const kv = {
    get: (key: KvKey) => Promise.resolve({ key, value: fullSnapshot, versionstamp: "00000000000000000001" }),
  } as unknown as Kv;

  assert.deepEqual(await loadFullCodexModelsSnapshot(kv), fullSnapshot);
  const runtime = buildRuntimeConfig(fullSnapshot, { nowMs: 1_000_001 });
  assert.equal(Object.prototype.hasOwnProperty.call(runtime.codex_models.models[0], "description"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(runtime.codex_models.models[0], "context_window"), false);
});
