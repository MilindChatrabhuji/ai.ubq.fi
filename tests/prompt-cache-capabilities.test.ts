import { test } from "bun:test";
import assert from "node:assert/strict";
import { mergeCodexModelPromptCacheCapabilities, normalizeCodexModelsPayload, normalizePromptCacheCapabilities } from "../src/models/codex-models.ts";

const promptCacheEvidence = {
  version: 1,
  providers: [
    {
      id: "codex_chatgpt",
      controls: {
        key: true,
        implicit: true,
        explicit_breakpoints: true,
        modes: ["implicit", "explicit"],
        ttls: ["30m"],
        legacy_retentions: ["24h"],
        breakpoint_block_types: {
          responses: ["input_text", "input_image", "input_file"],
          chat_completions: ["text", "image_url", "file"],
        },
        expected_usage_fields: ["cached_tokens", "cache_write_tokens"],
        source: "catalog",
        verified_at_ms: 1_000,
      },
    },
    {
      id: "metered",
      controls: {
        key: false,
        source: "inferred",
        verified_at_ms: 1_001,
      },
      scope: {
        probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
        account_slots: "unknown",
        token_refresh: "unknown",
        conversation_id: "independent",
        effective_model: "gpt-cache-fixture",
        reproducible_cycles: 3,
        source: "live_probe",
        verified_at_ms: 1_002,
      },
    },
  ],
};

test("Codex model normalization retains only versioned prompt-cache metadata", () => {
  const snapshot = normalizeCodexModelsPayload({
    source: "catalog-fixture",
    updated_at_ms: 1_100,
    models: [
      { slug: "gpt-cache-fixture", prompt_cache: promptCacheEvidence },
      { slug: "gpt-cache-unsupported", prompt_cache: false },
      {
        slug: "gpt-cache-invalid",
        prompt_cache: {
          version: 1,
          providers: [
            {
              id: "codex_chatgpt",
              controls: { source: "catalog", verified_at_ms: 1_003, modes: ["keyed"] },
            },
          ],
        },
      },
    ],
  });

  assert.ok(snapshot);
  assert.deepEqual(snapshot.models[0]?.prompt_cache, promptCacheEvidence);
  assert.equal(snapshot.models[1]?.prompt_cache, false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.models[2], "prompt_cache"), false);
});

test("prompt-cache metadata rejects unknown shape and duplicate provider identities", () => {
  assert.equal(normalizePromptCacheCapabilities({ version: 2, providers: [] }), null);
  assert.equal(normalizePromptCacheCapabilities({ version: 1, providers: [] }), null);
  assert.equal(
    normalizePromptCacheCapabilities({
      version: 1,
      providers: [{ id: "codex_chatgpt" }, { id: "codex_chatgpt" }],
    }),
    null
  );
  assert.equal(
    normalizePromptCacheCapabilities({
      version: 1,
      providers: [{ id: "codex_chatgpt", unknown: true }],
    }),
    null
  );
});

test("prompt-cache metadata exposes only gateway-supported cache controls", () => {
  const normalized = normalizePromptCacheCapabilities({
    version: 1,
    providers: [
      {
        id: "codex_chatgpt",
        controls: {
          ttls: ["5m", "30m", "1h"],
          legacy_retentions: ["24h", "unsupported"],
          breakpoint_block_types: {
            responses: ["input_text", "input_audio"],
            chat_completions: ["text", "input_audio", "refusal"],
          },
          source: "catalog",
          verified_at_ms: 1_010,
        },
      },
    ],
  });

  assert.deepEqual(normalized, {
    version: 1,
    providers: [
      {
        id: "codex_chatgpt",
        controls: {
          ttls: ["30m"],
          legacy_retentions: ["24h"],
          breakpoint_block_types: {
            responses: ["input_text"],
            chat_completions: ["text"],
          },
          source: "catalog",
          verified_at_ms: 1_010,
        },
      },
    ],
  });
});

test("prompt-cache scope requires three reproducible cycles before publication", () => {
  const earlyScope = {
    version: 1,
    providers: [
      {
        id: "codex_chatgpt",
        scope: {
          probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
          account_slots: "shared",
          token_refresh: "preserved",
          conversation_id: "independent",
          reproducible_cycles: 2,
          source: "live_probe",
          verified_at_ms: 1_100,
        },
      },
    ],
  };
  assert.equal(normalizePromptCacheCapabilities(earlyScope), null);

  const earlyUnknown = {
    ...earlyScope,
    providers: [
      {
        ...earlyScope.providers[0],
        scope: {
          ...earlyScope.providers[0].scope,
          account_slots: "unknown",
          token_refresh: "unknown",
          conversation_id: "unknown",
        },
      },
    ],
  };
  assert.equal(normalizePromptCacheCapabilities(earlyUnknown), null);

  const verifiedScope = {
    ...earlyScope,
    providers: [
      {
        ...earlyScope.providers[0],
        scope: { ...earlyScope.providers[0].scope, reproducible_cycles: 3 },
      },
    ],
  };
  assert.deepEqual(normalizePromptCacheCapabilities(verifiedScope), verifiedScope);

  const missingProfile = {
    ...verifiedScope,
    providers: [
      {
        ...verifiedScope.providers[0],
        scope: {
          ...verifiedScope.providers[0].scope,
          probe_profile: undefined,
        },
      },
    ],
  };
  assert.equal(normalizePromptCacheCapabilities(missingProfile), null);

  const wrongProfile = {
    ...verifiedScope,
    providers: [
      {
        ...verifiedScope.providers[0],
        scope: {
          ...verifiedScope.providers[0].scope,
          probe_profile: "responses_explicit_input_text_keyed_30m",
        },
      },
    ],
  };
  assert.equal(normalizePromptCacheCapabilities(wrongProfile), null);

  const priorExperimentDefinition = {
    ...verifiedScope,
    providers: [
      {
        ...verifiedScope.providers[0],
        scope: {
          ...verifiedScope.providers[0].scope,
          probe_profile: "responses_implicit_input_text_keyed",
        },
      },
    ],
  };
  assert.equal(normalizePromptCacheCapabilities(priorExperimentDefinition), null);
});

test("catalog prompt-cache merges retain same-slug provider evidence without cross-provider collapse", () => {
  const previous = normalizeCodexModelsPayload({
    source: "probe",
    updated_at_ms: 1_200,
    models: [{ slug: "gpt-cache-fixture", prompt_cache: promptCacheEvidence }],
  });
  const next = normalizeCodexModelsPayload({
    source: "catalog",
    updated_at_ms: 1_300,
    models: [
      {
        slug: "gpt-cache-fixture",
        prompt_cache: {
          version: 1,
          providers: [
            {
              id: "codex_chatgpt",
              controls: { implicit: false, source: "catalog", verified_at_ms: 1_300 },
            },
          ],
        },
      },
    ],
  });
  assert.ok(previous);
  assert.ok(next);

  const merged = mergeCodexModelPromptCacheCapabilities(next, previous);
  assert.deepEqual(merged.models[0]?.prompt_cache, {
    version: 1,
    providers: [
      {
        id: "codex_chatgpt",
        controls: { implicit: false, source: "catalog", verified_at_ms: 1_300 },
      },
      promptCacheEvidence.providers[1],
    ],
  });
});
