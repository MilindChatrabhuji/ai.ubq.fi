import { test } from "bun:test";
import type { Kv } from "#kv";
import assert from "node:assert/strict";

import { CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT } from "../src/recent-model-context.ts";
import {
  CODEX_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS,
  CODEX_SUBSCRIPTION_MAX_CONTEXT_WINDOW_TOKENS,
  codexSubscriptionMetadataHint,
} from "../src/models/metadata.ts";
import { codexSnapshotMetadataHint, resolveModelMetadata } from "../src/models/metadata.ts";
import { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest, type OpenRouterModelMetadata } from "../src/models/openrouter-models.ts";

const enrichment = (overrides: Partial<OpenRouterModelMetadata> = {}): OpenRouterModelMetadata => ({
  id: "openai/gpt-5.6-sol",
  context_window_tokens: 1_050_000,
  max_context_window_tokens: 1_050_000,
  reasoning: { supported_efforts: ["max", "high", "medium"], default_effort: "medium", mandatory: false },
  ...overrides,
});

test("an id no source describes resolves to unknown instead of a curated guess", () => {
  // These ids were previously answered by the curated tables, which are now
  // disabled: with no source, the honest answer is "nothing is known".
  for (const id of ["glm-5.3", "claude-sonnet-5", "deepseek-v4-pro", "gpt-5.6-terra"]) {
    const resolved = resolveModelMetadata(id, { openRouter: null });
    assert.equal(resolved.context_window_tokens, null, id);
    assert.equal(resolved.max_context_window_tokens, null, id);
    assert.equal(resolved.auto_compact_token_limit_tokens, null, id);
    assert.equal(resolved.effective_context_window_percent, null, id);
    assert.equal(resolved.supported_reasoning_levels, null, id);
    assert.equal(resolved.default_reasoning_effort, null, id);
    assert.equal(resolved.context_source, "unknown", id);
    assert.equal(resolved.reasoning_source, "unknown", id);
  }
});

test("reasoning stays Codex-authoritative while the window follows the widest source", () => {
  const resolved = resolveModelMetadata("gpt-5.6-sol", {
    codex: {
      context_window_tokens: 272_000,
      max_context_window_tokens: 400_000,
      supported_reasoning_levels: ["low", "high"],
      default_reasoning_effort: "high",
    },
    provider: { context_window_tokens: 1_000_000, supported_reasoning_levels: ["none"] },
    openRouter: enrichment(),
  });
  assert.equal(resolved.context_window_tokens, 1_050_000);
  assert.equal(resolved.max_context_window_tokens, 1_050_000);
  assert.equal(resolved.context_source, "openrouter");
  assert.deepEqual(resolved.supported_reasoning_levels, ["low", "high"]);
  assert.equal(resolved.default_reasoning_effort, "high");
  assert.equal(resolved.reasoning_source, "codex_upload");
});

test("a serving provider's own declaration outranks a narrower enrichment entry", () => {
  const resolved = resolveModelMetadata("deepseek-flash", {
    provider: { context_window_tokens: 1_000_000, max_context_window_tokens: 1_000_000 },
    openRouter: enrichment({ id: "~deepseek/deepseek-flash-latest", context_window_tokens: 65_536, max_context_window_tokens: 65_536 }),
  });
  assert.equal(resolved.context_window_tokens, 1_000_000);
  assert.equal(resolved.context_source, "provider_discovery");
  // Reasoning was not declared by the provider, so enrichment supplies it.
  assert.equal(resolved.reasoning_source, "openrouter");
  assert.deepEqual(resolved.supported_reasoning_levels, ["max", "high", "medium"]);
});

test("enrichment is the last resort, and the resolved context derives the auto-compact limit", () => {
  const resolved = resolveModelMetadata("gpt-5.6-sol", { openRouter: enrichment() });
  assert.equal(resolved.context_window_tokens, 1_050_000);
  assert.equal(resolved.max_context_window_tokens, 1_050_000);
  assert.equal(resolved.auto_compact_token_limit_tokens, 892_500);
  assert.equal(resolved.context_source, "openrouter");
  assert.equal(resolved.effective_context_window_percent, CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT);
  assert.equal(resolved.default_reasoning_effort, "medium");
});

test("a declared auto-compact limit is preserved inside the resolved window", () => {
  const narrow = resolveModelMetadata("gpt-5.6-sol", {
    codex: { context_window_tokens: 272_000, auto_compact_token_limit_tokens: 200_000 },
    openRouter: null,
  });
  assert.equal(narrow.context_window_tokens, 272_000);
  assert.equal(narrow.auto_compact_token_limit_tokens, 200_000);

  // Widening the advertised window does not discard a first-party compaction
  // limit: it is advice the client may follow or override.
  const widened = resolveModelMetadata("gpt-5.6-sol", {
    codex: { context_window_tokens: 272_000, auto_compact_token_limit_tokens: 200_000 },
    openRouter: enrichment(),
  });
  assert.equal(widened.context_window_tokens, 1_050_000);
  assert.equal(widened.auto_compact_token_limit_tokens, 200_000);
});

test("OpenRouter's window wins when it knows the id, so the gateway advertises the real capability", () => {
  // The Codex catalog understates what the endpoint accepts (916k verified), so a
  // wider third-party window is advertised and the client chooses its own budget.
  const resolved = resolveModelMetadata("gpt-5.6-sol", {
    codex: { context_window_tokens: 272_000, max_context_window_tokens: 872_000, supported_reasoning_levels: ["low", "high"] },
    codexSubscription: codexSubscriptionMetadataHint(),
    openRouter: enrichment({ context_window_tokens: 1_050_000, max_context_window_tokens: 1_050_000 }),
  });
  assert.equal(resolved.context_window_tokens, 1_050_000);
  assert.equal(resolved.max_context_window_tokens, 1_050_000);
  assert.equal(resolved.auto_compact_token_limit_tokens, 892_500);
  assert.equal(resolved.context_source, "openrouter");
  // Tiers still come from the upload, which stays authoritative for them.
  assert.equal(resolved.reasoning_source, "codex_upload");
});

test("first-party windows fill ids OpenRouter does not know, and the subscription bound fills the rest", () => {
  const firstParty = resolveModelMetadata("codex-only-model", {
    codex: { context_window_tokens: 8_000 },
    openRouter: null,
  });
  assert.equal(firstParty.context_window_tokens, 8_000);
  assert.equal(firstParty.context_source, "codex_upload");

  const silent = resolveModelMetadata("codex-only-model", { codexSubscription: codexSubscriptionMetadataHint(), openRouter: null });
  assert.equal(silent.context_window_tokens, CODEX_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS);
  assert.equal(silent.max_context_window_tokens, CODEX_SUBSCRIPTION_MAX_CONTEXT_WINDOW_TOKENS);
  assert.equal(silent.context_source, "codex_subscription");
});

test("a narrower third-party entry never shrinks a first-party window", () => {
  const resolved = resolveModelMetadata("gpt-5.6-sol", {
    codex: { context_window_tokens: 400_000, max_context_window_tokens: 400_000 },
    codexSubscription: codexSubscriptionMetadataHint(),
    openRouter: enrichment({ context_window_tokens: 300_000, max_context_window_tokens: 300_000 }),
  });
  assert.equal(resolved.context_window_tokens, 400_000);
  assert.equal(resolved.max_context_window_tokens, 400_000);
  assert.equal(resolved.context_source, "codex_upload");
});

test("OpenRouter breaks ties, keeping capability provenance when widths agree", () => {
  const tied = resolveModelMetadata("gpt-5.6-sol", {
    codex: { context_window_tokens: 1_050_000 },
    openRouter: enrichment({ context_window_tokens: 1_050_000, max_context_window_tokens: 1_050_000 }),
  });
  assert.equal(tied.context_window_tokens, 1_050_000);
  assert.equal(tied.context_source, "openrouter");
});

test("ids Codex does not serve keep their provider or enrichment window", () => {
  const resolved = resolveModelMetadata("glm-5.3", {
    openRouter: enrichment({ id: "z-ai/glm-5.3", context_window_tokens: 1_310_720, max_context_window_tokens: 1_310_720 }),
  });
  assert.equal(resolved.context_window_tokens, 1_310_720);
  assert.equal(resolved.context_source, "openrouter");
});

test("a mandatory-reasoning model does not gain a none tier it does not advertise", () => {
  const resolved = resolveModelMetadata("glm-5.3", {
    openRouter: enrichment({
      id: "z-ai/glm-5.3",
      reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "max", mandatory: true },
    }),
  });
  assert.deepEqual(resolved.supported_reasoning_levels, ["max", "high", "low"]);
  assert.equal(resolved.default_reasoning_effort, "max");
});

test("every advertised tier survives, including ones the gateway does not know", () => {
  const resolved = resolveModelMetadata("qwen3.8", {
    openRouter: enrichment({
      id: "qwen/qwen3.8",
      reasoning: { supported_efforts: ["none", "thinking", "hyper"], default_effort: "thinking", mandatory: false },
    }),
  });
  assert.deepEqual(resolved.supported_reasoning_levels, ["none", "thinking", "hyper"]);
});

test("the Codex snapshot adapter maps explicit null defaults to none", () => {
  assert.deepEqual(codexSnapshotMetadataHint(null), null);
  const hint = codexSnapshotMetadataHint({
    context_window: 400_000,
    auto_compact_token_limit: null,
    supported_reasoning_levels: [null, "low", { effort: "high" }, { effort: "" }],
    default_reasoning_level: null,
  });
  assert.ok(hint, "the adapter returns a hint for a real record");
  assert.equal(hint.context_window_tokens, 400_000);
  assert.equal(hint.auto_compact_token_limit_tokens, null);
  assert.equal(hint.default_reasoning_effort, "none");
  const resolved = resolveModelMetadata("any-model", { codex: hint, openRouter: null });
  assert.deepEqual(resolved.supported_reasoning_levels, ["none", "low", "high"]);
  assert.equal(resolved.default_reasoning_effort, "none");
  assert.equal(resolved.context_source, "codex_upload");
});

test("a Codex record without an explicit default keeps no default effort", () => {
  const hint = codexSnapshotMetadataHint({ context_window: 100_000, supported_reasoning_levels: ["low", "high"] });
  assert.ok(hint, "the adapter returns a hint for a real record");
  assert.equal(hint.default_reasoning_effort, undefined);
  const resolved = resolveModelMetadata("any-model", { codex: hint, openRouter: null });
  assert.equal(resolved.default_reasoning_effort, null);
  assert.deepEqual(resolved.supported_reasoning_levels, ["low", "high"]);
});

test("a default-only source advertises only its own effort and retains precedence", () => {
  const codex = resolveModelMetadata("default-only-model", {
    codex: { default_reasoning_effort: "high" },
    provider: { supported_reasoning_levels: ["low"], default_reasoning_effort: "low" },
    openRouter: enrichment(),
  });
  assert.deepEqual(codex.supported_reasoning_levels, ["high"]);
  assert.equal(codex.default_reasoning_effort, "high");
  assert.equal(codex.reasoning_source, "codex_upload");

  const provider = resolveModelMetadata("default-only-model", {
    codex: { default_reasoning_effort: " " },
    provider: { supported_reasoning_levels: [], default_reasoning_effort: "thinking" },
    openRouter: enrichment(),
  });
  assert.deepEqual(provider.supported_reasoning_levels, ["thinking"]);
  assert.equal(provider.default_reasoning_effort, "thinking");
  assert.equal(provider.reasoning_source, "provider_discovery");

  const openRouter = resolveModelMetadata("default-only-model", {
    openRouter: enrichment({ reasoning: { supported_efforts: [], default_effort: "hyper", mandatory: false } }),
  });
  assert.deepEqual(openRouter.supported_reasoning_levels, ["hyper"]);
  assert.equal(openRouter.default_reasoning_effort, "hyper");
  assert.equal(openRouter.reasoning_source, "openrouter");
});

test("a default-only Codex null remains explicit none while an omitted default stays unknown", () => {
  const explicitNone = resolveModelMetadata("default-only-model", {
    codex: codexSnapshotMetadataHint({ default_reasoning_level: null }),
    provider: { supported_reasoning_levels: ["high"] },
    openRouter: null,
  });
  assert.deepEqual(explicitNone.supported_reasoning_levels, ["none"]);
  assert.equal(explicitNone.default_reasoning_effort, "none");
  assert.equal(explicitNone.reasoning_source, "codex_upload");

  for (const record of [{}, { default_reasoning_level: "" }, { default_reasoning_level: 42 }]) {
    const unknown = resolveModelMetadata("default-only-model", { codex: codexSnapshotMetadataHint(record), openRouter: null });
    assert.equal(unknown.supported_reasoning_levels, null);
    assert.equal(unknown.default_reasoning_effort, null);
    assert.equal(unknown.reasoning_source, "unknown");
  }
});

test("the versioned catalog publishes a default-only source and keeps an unknown model none-only", async () => {
  const { handleModels } = await import("../src/models/catalog.ts");
  const { setKvForTest } = await import("../src/kv.ts");
  const { CountingKv } = await import("./helpers/counting-kv.ts");
  const { resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
  const { resetProviderSelectionCacheForTest } = await import("../src/provider/selection.ts");
  const keys = ["CEREBRAS_API_KEY", "DEEPSEEK_API_KEY", "LITHOSAI_API_KEY", "METERED_API_KEY", "SURPLUS_API_KEY", "OPENROUTER_API_KEY"];
  const originals = keys.map((key) => process.env[key]);
  for (const key of keys) Reflect.deleteProperty(process.env, key);
  process.env.OPENROUTER_API_KEY = "synthetic-catalog-key";
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  resetProviderSelectionCacheForTest();
  resetOpenRouterModelsCacheForTest();
  try {
    await fetchOpenRouterModels({
      force: true,
      fetcher: () =>
        Promise.resolve(Response.json({ data: [{ id: "synthetic/default-only", reasoning: { default_effort: "high" } }, { id: "synthetic/unknown" }] })),
    });
    const response = await handleModels(new Request("https://ai.ubq.fi/v1/models?client_version=0.200.0"));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: Record<string, unknown>[] };
    const declared = payload.models.find((model) => model.slug === "synthetic/default-only");
    assert.equal(declared?.default_reasoning_level, "high");
    assert.deepEqual(declared.supported_reasoning_levels, [{ effort: "high", description: "Reasoning effort: high" }]);
    assert.equal(resolveModelMetadata("synthetic/default-only").reasoning_source, "openrouter");
    const unknown = payload.models.find((model) => model.slug === "synthetic/unknown");
    assert.equal(unknown?.default_reasoning_level, "none");
    assert.deepEqual(unknown.supported_reasoning_levels, [{ effort: "none", description: "No reasoning" }]);
    assert.equal(resolveModelMetadata("synthetic/unknown").reasoning_source, "unknown");
  } finally {
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    resetProviderSelectionCacheForTest();
    resetOpenRouterModelsCacheForTest();
    kv.close();
    for (const [index, key] of keys.entries()) {
      const original = originals[index];
      if (original === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = original;
    }
  }
});
