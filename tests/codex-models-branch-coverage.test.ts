import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  CODEX_CHATGPT_PROMPT_CACHE_PROVIDER,
  compareCodexClientVersions,
  compactPromptCacheCapabilities,
  type CodexModelsSnapshot,
  getCodexModelPromptCacheProvider,
  getCodexModelsSnapshotDefaultModel,
  getUniqueCodexModelBySlug,
  isCodexModelPromptCacheScopeExperimentEligible,
  isConcretePromptCacheScope,
  mergeCodexModelPromptCacheCapabilities,
  mergePromptCacheCapabilities,
  normalizeCodexModelsPayload,
  normalizePromptCacheCapabilities,
  PROMPT_CACHE_SCOPE_PROBE_PROFILE,
  type PromptCacheScope,
  withCodexModelPromptCacheScope,
} from "../src/models/codex-models.ts";

type Json = Record<string, unknown>;

const validControls = (): Json => ({
  key: true,
  implicit: true,
  explicit_breakpoints: true,
  modes: ["implicit"],
  ttls: ["30m"],
  legacy_retentions: ["24h"],
  breakpoint_block_types: { responses: ["input_text"], chat_completions: ["text"] },
  expected_usage_fields: ["cached_tokens", "cache_write_tokens"],
  source: "catalog",
  verified_at_ms: 1_000,
});

const validScope = (): Json => ({
  probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
  account_slots: "account_scoped",
  token_refresh: "preserved",
  conversation_id: "scoped",
  effective_model: "gpt-5-codex",
  reproducible_cycles: 3,
  source: "live_probe",
  verified_at_ms: 2_000,
});

const providerWithControls = (controls: Json = validControls(), id = CODEX_CHATGPT_PROMPT_CACHE_PROVIDER): Json => ({ id, controls });

const capabilitiesWith = (provider: Json): Json => ({ version: 1, providers: [provider] });

const capabilitiesWithControls = (controls: Json = validControls(), id = CODEX_CHATGPT_PROMPT_CACHE_PROVIDER): Json =>
  capabilitiesWith(providerWithControls(controls, id));

const capabilitiesWithScope = (scope: Json = validScope()): Json =>
  capabilitiesWith({ id: CODEX_CHATGPT_PROMPT_CACHE_PROVIDER, controls: validControls(), scope });

/**
 * Snapshot fixture. `models` stays `unknown` on purpose: several cases below
 * store malformed entries to drive the runtime shape guards a stored record can
 * still contain.
 */
const snapshotOf = (models: unknown, overrides: Partial<CodexModelsSnapshot> = {}): CodexModelsSnapshot =>
  ({ models, source: "codex_cli", updated_at_ms: 1, ...overrides }) as CodexModelsSnapshot;

/** Capabilities accepted today, so any mutation in a case below is the only change. */
const assertValidBaseline = (): void => {
  const normalized = normalizePromptCacheCapabilities(capabilitiesWithScope());
  assert.ok(normalized !== null && normalized !== false);
  assert.equal(normalized.providers.length, 1);
};

// ---------------------------------------------------------------------------
// normalizePromptCacheCapabilities: envelope and provider guards
// ---------------------------------------------------------------------------

test("prompt cache capabilities reject every malformed envelope", () => {
  assertValidBaseline();
  const cases: readonly unknown[] = [
    null,
    "providers",
    [{ version: 1, providers: [] }],
    { version: 2, providers: [providerWithControls()] },
    { version: 1 },
    { version: 1, providers: [] },
    { version: 1, providers: "none" },
    { version: 1, providers: [providerWithControls()], extra: true },
  ];

  for (const value of cases) {
    assert.equal(normalizePromptCacheCapabilities(value), null, `expected null for ${JSON.stringify(value)}`);
  }
  assert.equal(normalizePromptCacheCapabilities(false), false);
});

test("prompt cache capabilities reject an unidentifiable or duplicate provider", () => {
  assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: "   ", controls: validControls() })), null);
  assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: 7, controls: validControls() })), null);
  assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: "a b", controls: validControls(), scope: {} })), null);
  assert.equal(normalizePromptCacheCapabilities({ version: 1, providers: [{ id: "dup" }, { id: "dup" }] }), null);
  assert.deepEqual(normalizePromptCacheCapabilities({ version: 1, providers: [{ id: "  spaced  " }] }), {
    version: 1,
    providers: [{ id: "spaced" }],
  });
});

test("a declared controls block that is not a plain object invalidates the provider", () => {
  for (const controls of ["catalog", 7, null, [validControls()]]) {
    assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls })), null);
  }
  assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), extra: 1 } })), null);
});

test("controls require a known source, a safe timestamp and boolean switches", () => {
  const invalid: readonly Json[] = [
    { ...validControls(), source: "bogus" },
    { ...validControls(), source: undefined },
    { ...validControls(), verified_at_ms: -1 },
    { ...validControls(), verified_at_ms: 1_000.5 },
    { ...validControls(), verified_at_ms: "1000" },
    { ...validControls(), verified_at_ms: undefined },
    { ...validControls(), key: "true" },
    { ...validControls(), implicit: 1 },
    { ...validControls(), explicit_breakpoints: null },
  ];

  for (const controls of invalid) {
    assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls })), null, `controls ${JSON.stringify(controls)}`);
  }
  const accepted = normalizePromptCacheCapabilities(
    capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), key: false, implicit: false, explicit_breakpoints: false } })
  );
  assert.ok(accepted !== null && accepted !== false);
  assert.deepEqual(accepted.providers[0]?.controls?.key, false);
  assert.deepEqual(accepted.providers[0]?.controls?.implicit, false);
  assert.deepEqual(accepted.providers[0]?.controls?.explicit_breakpoints, false);
});

test("an optional list control with a non-array or blank entry invalidates the whole record", () => {
  const invalid: readonly Json[] = [
    { ...validControls(), modes: "implicit" },
    { ...validControls(), modes: ["implicit", 5] },
    { ...validControls(), modes: ["implicit", "bogus"] },
    { ...validControls(), ttls: "30m" },
    { ...validControls(), ttls: ["30m", ""] },
    { ...validControls(), ttls: ["30m", "   "] },
    { ...validControls(), legacy_retentions: "24h" },
    { ...validControls(), expected_usage_fields: "cached_tokens" },
    { ...validControls(), expected_usage_fields: ["cached_tokens", "bogus"] },
    { ...validControls(), breakpoint_block_types: "input_text" },
    { ...validControls(), breakpoint_block_types: { responses: "input_text" } },
    { ...validControls(), breakpoint_block_types: { responses: ["input_text"], chat_completions: "text" } },
    { ...validControls(), breakpoint_block_types: { responses: ["input_text"], unknown: ["input_text"] } },
  ];

  for (const controls of invalid) {
    assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls })), null, `controls ${JSON.stringify(controls)}`);
  }
});

test("gateway-unsupported list values are dropped or invalidate an exhaustive declaration", () => {
  const droppedTtls = normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), ttls: ["30m", "2h"] } }));
  assert.ok(droppedTtls !== null && droppedTtls !== false);
  assert.deepEqual(droppedTtls.providers[0]?.controls?.ttls, ["30m"]);

  const droppedRetentions = normalizePromptCacheCapabilities(
    capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), legacy_retentions: ["24h", "forever"] } })
  );
  assert.ok(droppedRetentions !== null && droppedRetentions !== false);
  assert.deepEqual(droppedRetentions.providers[0]?.controls?.legacy_retentions, ["24h"]);

  const droppedAll = normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), ttls: ["2h"] } }));
  assert.ok(droppedAll !== null && droppedAll !== false);
  assert.equal("ttls" in (droppedAll.providers[0]?.controls ?? {}), false);

  const deduplicated = normalizePromptCacheCapabilities(
    capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), modes: ["implicit", "implicit", "explicit"] } })
  );
  assert.ok(deduplicated !== null && deduplicated !== false);
  assert.deepEqual(deduplicated.providers[0]?.controls?.modes, ["implicit", "explicit"]);

  // Every advertised block type is filtered away, so nothing supported is left to publish.
  for (const value of [{ responses: ["bogus"] }, { chat_completions: ["bogus"] }, { responses: [], chat_completions: [] }]) {
    assert.equal(
      normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), breakpoint_block_types: value } })),
      null,
      `block types ${JSON.stringify(value)}`
    );
  }

  const partial = normalizePromptCacheCapabilities(
    capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), breakpoint_block_types: { responses: ["input_text", "bogus"] } } })
  );
  assert.ok(partial !== null && partial !== false);
  assert.deepEqual(partial.providers[0]?.controls?.breakpoint_block_types, { responses: ["input_text"] });

  const chatOnly = normalizePromptCacheCapabilities(
    capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), breakpoint_block_types: { chat_completions: ["text", "residual"] } } })
  );
  assert.ok(chatOnly !== null && chatOnly !== false);
  assert.deepEqual(chatOnly.providers[0]?.controls?.breakpoint_block_types, { chat_completions: ["text"] });
});

// ---------------------------------------------------------------------------
// normalizePromptCacheCapabilities: scope guards
// ---------------------------------------------------------------------------

test("scope evidence rejects unknown members, profiles and classifications", () => {
  const invalid: readonly Json[] = [
    { ...validScope(), probe_profile: "responses_implicit_v0" },
    { ...validScope(), account_slots: "private" },
    { ...validScope(), token_refresh: "rotated" },
    { ...validScope(), conversation_id: "global" },
    { ...validScope(), source: "catalog" },
    { ...validScope(), reproducible_cycles: 2 },
    { ...validScope(), reproducible_cycles: "3" },
    { ...validScope(), verified_at_ms: undefined },
    { ...validScope(), effective_model: "   " },
    { ...validScope(), extra: true },
  ];

  for (const scope of invalid) {
    assert.equal(normalizePromptCacheCapabilities(capabilitiesWithScope(scope)), null, `scope ${JSON.stringify(scope)}`);
  }
  assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", scope: "scope" })), null);
  assert.equal(normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", scope: null })), null);
});

test("a scope without an effective model keeps the other verified fields", () => {
  const scope = validScope();
  delete scope.effective_model;
  const normalized = normalizePromptCacheCapabilities(capabilitiesWithScope(scope));

  assert.ok(normalized !== null && normalized !== false);
  assert.deepEqual(normalized.providers[0]?.scope, {
    probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
    account_slots: "account_scoped",
    token_refresh: "preserved",
    conversation_id: "scoped",
    reproducible_cycles: 3,
    source: "live_probe",
    verified_at_ms: 2_000,
  });

  const trailing = normalizePromptCacheCapabilities(capabilitiesWithScope({ ...validScope(), effective_model: "  gpt-5-codex  " }));
  assert.ok(trailing !== null && trailing !== false);
  assert.equal(trailing.providers[0]?.scope?.effective_model, "gpt-5-codex");
});

// ---------------------------------------------------------------------------
// compactPromptCacheCapabilities
// ---------------------------------------------------------------------------

test("compaction keeps controls providers and drops probe-only scope", () => {
  assert.equal(compactPromptCacheCapabilities(false), false);
  assert.equal(compactPromptCacheCapabilities(null), null);
  assert.equal(compactPromptCacheCapabilities("bogus"), null);
  assert.equal(compactPromptCacheCapabilities({ version: 1, providers: [{ id: "noise", scope: validScope() }] }), null);

  const compacted = compactPromptCacheCapabilities(capabilitiesWithScope());
  assert.ok(compacted !== null && compacted !== false);
  assert.deepEqual(
    compacted.providers.map((provider) => provider.id),
    [CODEX_CHATGPT_PROMPT_CACHE_PROVIDER]
  );
  assert.equal("scope" in compacted.providers[0], false);
  assert.deepEqual(compacted.providers[0].controls, compacted.providers[0].controls);
});

// ---------------------------------------------------------------------------
// Snapshot lookup helpers
// ---------------------------------------------------------------------------

test("exact-slug lookup resolves every id spelling and rejects ambiguity", () => {
  const bySlugModel: Record<string, unknown> = { slug: "gpt-5-codex" };
  const byIdModel: Record<string, unknown> = { id: "gpt-5-codex" };
  const byModelModel: Record<string, unknown> = { model: "gpt-5-codex" };
  const byNameModel: Record<string, unknown> = { name: "  gpt-5-codex  " };
  const fixtures: readonly Readonly<{ snapshot: CodexModelsSnapshot; model: Record<string, unknown> }>[] = [
    { snapshot: snapshotOf([bySlugModel]), model: bySlugModel },
    { snapshot: snapshotOf([byIdModel]), model: byIdModel },
    { snapshot: snapshotOf([byModelModel]), model: byModelModel },
    { snapshot: snapshotOf([byNameModel]), model: byNameModel },
  ];

  for (const { snapshot, model } of fixtures) {
    assert.deepEqual(getUniqueCodexModelBySlug(snapshot, "gpt-5-codex"), model);
    assert.equal(getUniqueCodexModelBySlug(snapshot, "  gpt-5-codex  "), model);
  }

  assert.equal(getUniqueCodexModelBySlug(snapshotOf([{ slug: "gpt-5-codex" }, { id: "gpt-5-codex" }]), "gpt-5-codex"), null);
  assert.equal(getUniqueCodexModelBySlug(snapshotOf([{ slug: "gpt-5-codex" }]), "   "), null);
  assert.equal(getUniqueCodexModelBySlug(snapshotOf([]), "gpt-5-codex"), null);
  assert.equal(getUniqueCodexModelBySlug(snapshotOf(["not-a-record"]), "gpt-5-codex"), null);
  assert.equal(getUniqueCodexModelBySlug(snapshotOf("none"), "gpt-5-codex"), null);
  assert.equal(getUniqueCodexModelBySlug(snapshotOf([{ slug: "   " }]), "gpt-5-codex"), null);
});

test("provider lookup reports absence instead of guessing", () => {
  const withCache = snapshotOf([{ slug: "gpt-5-codex", prompt_cache: capabilitiesWithScope() }]);
  const provider = getCodexModelPromptCacheProvider(withCache, "gpt-5-codex", CODEX_CHATGPT_PROMPT_CACHE_PROVIDER);
  assert.deepEqual(provider, {
    id: CODEX_CHATGPT_PROMPT_CACHE_PROVIDER,
    controls: validControls(),
    scope: validScope(),
  });

  assert.equal(getCodexModelPromptCacheProvider(withCache, "missing", CODEX_CHATGPT_PROMPT_CACHE_PROVIDER), null);
  assert.equal(getCodexModelPromptCacheProvider(withCache, "gpt-5-codex", "other_provider"), null);
  assert.equal(getCodexModelPromptCacheProvider(snapshotOf([{ slug: "gpt-5-codex" }]), "gpt-5-codex", CODEX_CHATGPT_PROMPT_CACHE_PROVIDER), null);
  assert.equal(
    getCodexModelPromptCacheProvider(snapshotOf([{ slug: "gpt-5-codex", prompt_cache: false }]), "gpt-5-codex", CODEX_CHATGPT_PROMPT_CACHE_PROVIDER),
    null
  );
  assert.equal(getCodexModelPromptCacheProvider(snapshotOf([{ slug: "gpt-5-codex", prompt_cache: { version: 1, providers: [] } }]), "gpt-5-codex", "x"), null);
});

test("scope-experiment eligibility requires the exact plain-key control set", () => {
  const eligible = snapshotOf([{ slug: "gpt-5-codex", prompt_cache: capabilitiesWithControls() }]);
  assert.equal(isCodexModelPromptCacheScopeExperimentEligible(eligible, "gpt-5-codex"), true);

  const cases: readonly Json[] = [
    { ...validControls(), key: false },
    { ...validControls(), implicit: false },
    { ...validControls(), expected_usage_fields: ["cached_tokens"] },
    { ...validControls(), expected_usage_fields: [] },
    { ...validControls(), expected_usage_fields: undefined },
  ];
  for (const controls of cases) {
    const snapshot = snapshotOf([{ slug: "gpt-5-codex", prompt_cache: capabilitiesWithControls(controls) }]);
    assert.equal(isCodexModelPromptCacheScopeExperimentEligible(snapshot, "gpt-5-codex"), false, `controls ${JSON.stringify(controls)}`);
  }

  assert.equal(isCodexModelPromptCacheScopeExperimentEligible(eligible, "unknown"), false);
  assert.equal(isCodexModelPromptCacheScopeExperimentEligible(snapshotOf([{ slug: "gpt-5-codex" }]), "gpt-5-codex"), false);
  // Explicit-only option modes describe the other wire shape and cannot disqualify this one.
  const explicitOnly = snapshotOf([
    {
      slug: "gpt-5-codex",
      prompt_cache: capabilitiesWithControls({ ...validControls(), modes: ["explicit"], implicit: true, key: true }),
    },
  ]);
  assert.equal(isCodexModelPromptCacheScopeExperimentEligible(explicitOnly, "gpt-5-codex"), true);
});

test("only a complete reproducible scope counts as concrete", () => {
  const scope = capabilitiesWithScope();
  const normalized = normalizePromptCacheCapabilities(scope);
  assert.ok(normalized !== null && normalized !== false);
  const hosted = normalized.providers[0]?.scope;
  assert.ok(hosted);
  assert.equal(isConcretePromptCacheScope(hosted), true);
  assert.equal(isConcretePromptCacheScope({ ...hosted, reproducible_cycles: 4 }, 4), true);
  assert.equal(isConcretePromptCacheScope({ ...hosted, reproducible_cycles: 4 }), false);
  assert.equal(isConcretePromptCacheScope({ ...hosted, account_slots: "unknown" }), false);
  assert.equal(isConcretePromptCacheScope({ ...hosted, token_refresh: "unknown" }), false);
  assert.equal(isConcretePromptCacheScope({ ...hosted, conversation_id: "unknown" }), false);
  assert.equal(isConcretePromptCacheScope({ ...hosted, effective_model: undefined }), false);
  assert.equal(isConcretePromptCacheScope({ ...hosted, effective_model: "   " }), false);
  assert.equal(isConcretePromptCacheScope({ ...hosted, probe_profile: "other" } as unknown as PromptCacheScope), false);
  assert.equal(isConcretePromptCacheScope({ ...hosted, source: "catalog" } as unknown as PromptCacheScope), false);
  assert.equal(isConcretePromptCacheScope({ ...hosted, source: "live_probe" }), true);
});

// ---------------------------------------------------------------------------
// withCodexModelPromptCacheScope
// ---------------------------------------------------------------------------

test("scope attachment requires a unique model, a present provider and a valid scope", () => {
  const model: Record<string, unknown> = { slug: "gpt-5-codex", prompt_cache: capabilitiesWithControls() };
  const other: Record<string, unknown> = { slug: "other", prompt_cache: capabilitiesWithControls() };
  const snapshot = snapshotOf([model, other]);
  const attached = withCodexModelPromptCacheScope(snapshot, "gpt-5-codex", CODEX_CHATGPT_PROMPT_CACHE_PROVIDER, validScope() as unknown as PromptCacheScope);

  assert.ok(attached);
  assert.equal(model.prompt_cache === capabilitiesWithControls(), false, "the source snapshot must not be mutated");
  const attachedCache = normalizePromptCacheCapabilities(attached.models[0]?.prompt_cache);
  assert.ok(attachedCache !== null && attachedCache !== false);
  assert.equal(attachedCache.providers[0]?.scope?.effective_model, "gpt-5-codex");
  assert.equal(attached.models[1]?.prompt_cache === other.prompt_cache, true);
  assert.equal(attached.models[1] === other, true, "unrelated providers stay catalog-owned");

  assert.equal(withCodexModelPromptCacheScope(snapshot, "missing", CODEX_CHATGPT_PROMPT_CACHE_PROVIDER, validScope() as unknown as PromptCacheScope), null);
  assert.equal(
    withCodexModelPromptCacheScope(
      snapshotOf([{ slug: "gpt-5-codex" }]),
      "gpt-5-codex",
      CODEX_CHATGPT_PROMPT_CACHE_PROVIDER,
      validScope() as unknown as PromptCacheScope
    ),
    null
  );
  assert.equal(
    withCodexModelPromptCacheScope(
      snapshotOf([{ slug: "gpt-5-codex", prompt_cache: false }]),
      "gpt-5-codex",
      CODEX_CHATGPT_PROMPT_CACHE_PROVIDER,
      validScope() as unknown as PromptCacheScope
    ),
    null
  );
  assert.equal(withCodexModelPromptCacheScope(snapshot, "gpt-5-codex", "absent_provider", validScope() as unknown as PromptCacheScope), null);
  assert.equal(
    withCodexModelPromptCacheScope(snapshot, "gpt-5-codex", CODEX_CHATGPT_PROMPT_CACHE_PROVIDER, {
      ...validScope(),
      reproducible_cycles: 1,
    } as unknown as PromptCacheScope),
    null
  );
});

// ---------------------------------------------------------------------------
// mergePromptCacheCapabilities
// ---------------------------------------------------------------------------

test("prompt cache merge precedence covers false, absent and invalid sides", () => {
  assert.equal(mergePromptCacheCapabilities(capabilitiesWithScope(), false), false);
  assert.equal(mergePromptCacheCapabilities(null, null), null);
  assert.equal(mergePromptCacheCapabilities("bogus", "bogus"), null);

  const next = capabilitiesWithControls(validControls());
  const normalizedNext = normalizePromptCacheCapabilities(next);
  assert.ok(normalizedNext !== null && normalizedNext !== false);
  const nextControls = normalizedNext.providers[0]?.controls;
  assert.ok(nextControls);

  assert.deepEqual(mergePromptCacheCapabilities(null, next), normalizedNext);
  assert.deepEqual(mergePromptCacheCapabilities(false, next), normalizedNext);

  // The incoming catalog carries no scope, so the live-probe scope survives.
  const mergedWithScope = mergePromptCacheCapabilities(capabilitiesWithScope(), next);
  assert.ok(mergedWithScope !== null && mergedWithScope !== false);
  assert.deepEqual(mergedWithScope.providers[0]?.controls, nextControls);
  assert.equal(mergedWithScope.providers[0]?.scope?.effective_model, "gpt-5-codex");
  assert.equal(mergedWithScope.providers.length, 1);
});

test("prompt cache merge keeps control-only and scope-only providers from both sides", () => {
  const previousOnly = capabilitiesWith({ id: "retired_provider", scope: validScope() });
  const nextOnly = capabilitiesWith({ id: "fresh_provider", controls: validControls() });
  const merged = mergePromptCacheCapabilities(previousOnly, nextOnly);

  assert.ok(merged !== null && merged !== false);
  assert.deepEqual(
    merged.providers.map((provider) => provider.id),
    ["fresh_provider", "retired_provider"]
  );

  const previousControls = capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), key: true, implicit: true } });
  const nextControls = capabilitiesWith({ id: "codex_chatgpt", controls: { ...validControls(), source: "live_probe", key: false } });
  const overridden = mergePromptCacheCapabilities(previousControls, nextControls);
  assert.ok(overridden !== null && overridden !== false);
  assert.equal(overridden.providers[0]?.controls?.key, false);
  assert.equal(overridden.providers[0]?.controls?.implicit, true);
  assert.equal(overridden.providers[0]?.controls?.source, "live_probe");

  const previousScope = capabilitiesWith({ id: "codex_chatgpt", controls: validControls(), scope: validScope() });
  const nextScope = capabilitiesWith({ id: "codex_chatgpt", scope: validScope() });
  const scopeKept = mergePromptCacheCapabilities(previousScope, nextScope);
  assert.ok(scopeKept !== null && scopeKept !== false);
  assert.equal(scopeKept.providers[0]?.controls?.source, "catalog");
  assert.ok(scopeKept.providers[0]?.scope);
});

// ---------------------------------------------------------------------------
// mergeCodexModelPromptCacheCapabilities
// ---------------------------------------------------------------------------

test("model-level cache merge preserves evidence per matching slug only", () => {
  const previous = snapshotOf([
    { slug: "gpt-5-codex", prompt_cache: capabilitiesWithScope() },
    { slug: "retired", prompt_cache: capabilitiesWithScope() },
    "not-a-record",
    { slug: "   " },
    { id: "by-id", prompt_cache: capabilitiesWithScope() },
  ]);
  const next = snapshotOf([{ slug: "gpt-5-codex" }, { slug: "new-model" }, { slug: "retired" }, { id: "by-id" }, "not-a-record"]);

  const merged = mergeCodexModelPromptCacheCapabilities(next, previous);

  assert.notEqual(merged, next);
  const codexCache = normalizePromptCacheCapabilities(merged.models[0]?.prompt_cache);
  assert.ok(codexCache !== null && codexCache !== false);
  assert.ok(codexCache.providers[0]?.scope);
  assert.equal("prompt_cache" in (merged.models[1] as Json), false);
  assert.ok(merged.models[2]?.prompt_cache);
  assert.ok(merged.models[3]?.prompt_cache);
  assert.equal(merged.models[4], "not-a-record");
});

test("model-level cache merge returns the same snapshot when nothing can be added", () => {
  const next = snapshotOf([{ slug: "gpt-5-codex" }]);

  assert.equal(mergeCodexModelPromptCacheCapabilities(next, null), next);
  assert.equal(mergeCodexModelPromptCacheCapabilities(next, undefined), next);
  assert.equal(mergeCodexModelPromptCacheCapabilities(next, snapshotOf([])), next);
  assert.equal(mergeCodexModelPromptCacheCapabilities(next, snapshotOf("none")), next);
  // The previous snapshot advertises a different model, so no evidence may travel.
  assert.equal(mergeCodexModelPromptCacheCapabilities(next, snapshotOf([{ slug: "other", prompt_cache: capabilitiesWithScope() }])), next);
  // Cached evidence exists but the incoming entry carries its own answer.
  assert.equal(
    mergeCodexModelPromptCacheCapabilities(
      snapshotOf([{ slug: "gpt-5-codex", prompt_cache: false }]),
      snapshotOf([{ slug: "gpt-5-codex", prompt_cache: capabilitiesWithScope() }])
    ).models[0]?.prompt_cache,
    false
  );
  // A model without any slug cannot inherit evidence.
  assert.deepEqual(mergeCodexModelPromptCacheCapabilities(snapshotOf([{}]), snapshotOf([{ slug: "gpt-5-codex" }])).models, [{}]);
});

// ---------------------------------------------------------------------------
// Version parsing and default model selection
// ---------------------------------------------------------------------------

test("client version parsing and comparison reject malformed versions", () => {
  assert.equal(compareCodexClientVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareCodexClientVersions("1.3.0", "1.2.9"), 1);
  assert.equal(compareCodexClientVersions(" 1.2.3 ", "1.2.3"), 0);
  assert.equal(compareCodexClientVersions("1.2", "1.2.3"), null);
  assert.equal(compareCodexClientVersions("1.2.3", "latest"), null);
  assert.equal(compareCodexClientVersions("99999999999999999999.0.0", "1.0.0"), null);
  assert.equal(compareCodexClientVersions("1.2.3-rc.4", "1.2.3"), null);
});

test("the default model comes from the first entry with a usable identifier", () => {
  assert.equal(getCodexModelsSnapshotDefaultModel(null), null);
  assert.equal(getCodexModelsSnapshotDefaultModel(snapshotOf([])), null);
  assert.equal(getCodexModelsSnapshotDefaultModel(snapshotOf("none")), null);
  assert.equal(getCodexModelsSnapshotDefaultModel(snapshotOf(["nope", {}, { slug: "   " }])), null);
  assert.equal(getCodexModelsSnapshotDefaultModel(snapshotOf([{}, { id: "second" }])), "second");
  assert.equal(getCodexModelsSnapshotDefaultModel(snapshotOf([{ model: "third" }])), "third");
  assert.equal(getCodexModelsSnapshotDefaultModel(snapshotOf([{ name: "  fourth  " }])), "fourth");
});

// ---------------------------------------------------------------------------
// normalizeCodexModelsPayload
// ---------------------------------------------------------------------------

test("payload envelopes accept a bare array and a data wrapper", () => {
  const fromArray = normalizeCodexModelsPayload([{ slug: "gpt-5-codex" }]);
  assert.ok(fromArray);
  assert.equal(fromArray.source, "codex_cli");
  assert.equal(fromArray.client_version, undefined);
  assert.ok(fromArray.updated_at_ms > 0);

  const fromData = normalizeCodexModelsPayload({ data: [{ slug: "gpt-5-codex" }], source: "upstream", client_version: "1.2.3", updated_at_ms: 7 });
  assert.ok(fromData);
  assert.equal(fromData.source, "upstream");
  assert.equal(fromData.client_version, "1.2.3");
  assert.equal(fromData.updated_at_ms, 7);
});

test("payload normalization refuses envelopes without a model list", () => {
  for (const value of [null, "nope", 42, [null], {}, { models: "none" }, { data: "none" }]) {
    assert.equal(normalizeCodexModelsPayload(value), null, `payload ${JSON.stringify(value)}`);
  }
  // The payload loop keeps the stored spelling: only an absent slug is skipped.
  assert.deepEqual(normalizeCodexModelsPayload([{ slug: "   " }])?.models, [{ slug: "   " }]);
  assert.deepEqual(normalizeCodexModelsPayload([{ slug: "dup" }, { slug: "dup" }])?.models, [{ slug: "dup" }]);
  assert.equal(normalizeCodexModelsPayload(["not-a-record"]), null);
});

test("payload normalization keeps the first entry per slug and drops unusable ones", () => {
  const snapshot = normalizeCodexModelsPayload([
    { slug: "gpt-5-codex", display_name: "Codex" },
    { slug: "gpt-5-codex", display_name: "Duplicate" },
    { id: "by-id", description: "By id" },
    { model: "by-model" },
    { name: "by-name" },
    { visibility: "hide", supported_in_api: false, slug: "hidden" },
    "not-a-record",
  ]);

  assert.ok(snapshot);
  assert.deepEqual(
    snapshot.models.map((model) => model.slug),
    ["gpt-5-codex", "by-id", "by-model", "by-name"]
  );
  assert.equal(snapshot.models[0]?.display_name, "Codex");
  assert.equal(snapshot.models[1]?.description, "By id");
  assert.equal(snapshot.models[1]?.display_name, undefined);
});

test("overrides win only when they carry a value", () => {
  const payload = { models: [{ slug: "gpt-5-codex" }], source: "upstream", client_version: "9.9.9", updated_at_ms: 5 };

  const untouched = normalizeCodexModelsPayload(payload, { source: "", clientVersion: "", updatedAtMs: null });
  assert.ok(untouched);
  assert.equal(untouched.source, "upstream");
  assert.equal(untouched.client_version, "9.9.9");
  assert.equal(untouched.updated_at_ms, 5);

  const overridden = normalizeCodexModelsPayload(payload, { source: "chatgpt_codex", clientVersion: "1.0.0", updatedAtMs: 11.9 });
  assert.ok(overridden);
  assert.equal(overridden.source, "chatgpt_codex");
  assert.equal(overridden.client_version, "1.0.0");
  assert.equal(overridden.updated_at_ms, 11);

  const noTimestamp = normalizeCodexModelsPayload({ models: [{ slug: "gpt-5-codex" }] });
  assert.ok(noTimestamp);
  assert.ok(noTimestamp.updated_at_ms > 0);
});

test("model entries normalize context windows, reasoning levels and cache evidence", () => {
  const snapshot = normalizeCodexModelsPayload([
    {
      slug: "gpt-5-codex",
      supported_in_api: true,
      visibility: "list",
      context_window: 400_000,
      max_context_window: 400_000.9,
      auto_compact_token_limit: null,
      effective_context_window_percent: -5,
      default_reasoning_level: null,
      supported_reasoning_levels: [null, "low", { effort: null }, { effort: "high" }, { effort: "ultra" }, 42, { effort: "ultra", wire_effort: "max" }],
      prompt_cache: capabilitiesWithScope(),
    },
    {
      slug: "flat",
      context_window: null,
      default_reasoning_level: "medium",
      supported_reasoning_levels: "none",
    },
    {
      slug: "no-slug-fields",
      context_window: "400000",
      default_reasoning_level: "bogus",
      supported_reasoning_levels: [],
    },
    { slug: "blank-level", default_reasoning_level: "   " },
  ]);

  assert.ok(snapshot);
  const codex = snapshot.models[0] as Json;
  assert.equal(codex.context_window, 400_000);
  assert.equal(codex.max_context_window, 400_000);
  assert.equal(codex.auto_compact_token_limit, null);
  assert.equal(codex.supported_in_api, true);
  assert.equal(codex.visibility, "list");
  assert.equal("effective_context_window_percent" in codex, false);
  assert.equal(codex.default_reasoning_level, "none");
  assert.deepEqual(codex.supported_reasoning_levels, ["none", "low", "none", "high", "ultra", "ultra"]);
  assert.deepEqual(codex.reasoning_effort_wire_map, { ultra: "max" });
  assert.ok(codex.prompt_cache);

  const flat = snapshot.models[1] as Json;
  assert.equal(flat.context_window, null);
  assert.equal("max_context_window" in flat, false);
  assert.equal(flat.default_reasoning_level, "medium");
  assert.equal("supported_reasoning_levels" in flat, false);

  const sparse = snapshot.models[2] as Json;
  assert.equal("context_window" in sparse, false);
  // Tiers are preserved verbatim: no allowlist rejects an unknown advertised value.
  assert.equal(sparse.default_reasoning_level, "bogus");
  assert.equal("reasoning_effort_wire_map" in sparse, false);

  const blankLevel = snapshot.models[3] as Json;
  assert.equal("default_reasoning_level" in blankLevel, false);
});

test("a hidden model is dropped unless the API still serves it", () => {
  const snapshot = normalizeCodexModelsPayload([
    { slug: "hidden", visibility: " HIDE ", supported_in_api: false },
    { slug: "hidden-but-served", visibility: "hide", supported_in_api: true },
    { slug: "visible", visibility: "list" },
  ]);

  assert.ok(snapshot);
  assert.deepEqual(
    snapshot.models.map((model) => model.slug),
    ["hidden-but-served", "visible"]
  );
});

test("a minimal controls record keeps only its required evidence", () => {
  const minimal = { source: "live_probe", verified_at_ms: 3 };
  const normalized = normalizePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls: minimal }));

  assert.ok(normalized !== null && normalized !== false);
  assert.deepEqual(normalized.providers[0]?.controls, minimal);
  assert.equal("key" in (normalized.providers[0]?.controls ?? {}), false);
  assert.equal("implicit" in (normalized.providers[0]?.controls ?? {}), false);
  assert.equal("explicit_breakpoints" in (normalized.providers[0]?.controls ?? {}), false);
  assert.equal("modes" in (normalized.providers[0]?.controls ?? {}), false);
  assert.equal("ttls" in (normalized.providers[0]?.controls ?? {}), false);
  assert.equal("legacy_retentions" in (normalized.providers[0]?.controls ?? {}), false);
  assert.equal("breakpoint_block_types" in (normalized.providers[0]?.controls ?? {}), false);
  assert.equal("expected_usage_fields" in (normalized.providers[0]?.controls ?? {}), false);

  const compacted = compactPromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", controls: minimal }));
  assert.ok(compacted !== null && compacted !== false);
  assert.deepEqual(compacted.providers[0]?.controls, minimal);
});

test("a provider entry must be a plain object with only id, controls and scope", () => {
  assert.equal(normalizePromptCacheCapabilities({ version: 1, providers: ["codex_chatgpt"] }), null);
  assert.equal(normalizePromptCacheCapabilities({ version: 1, providers: [null] }), null);
  assert.equal(normalizePromptCacheCapabilities({ version: 1, providers: [[{ id: "codex_chatgpt" }]] }), null);
  assert.equal(normalizePromptCacheCapabilities({ version: 1, providers: [{ id: "codex_chatgpt", extra: true }] }), null);
  assert.equal(normalizePromptCacheCapabilities({ version: 1, providers: [{ id: "codex_chatgpt", controls: null }] }), null);
  assert.equal(normalizePromptCacheCapabilities({ version: 1, providers: [{ id: "codex_chatgpt", scope: [] }] }), null);

  const identityOnly = normalizePromptCacheCapabilities({ version: 1, providers: [{ id: "codex_chatgpt" }] });
  assert.ok(identityOnly !== null && identityOnly !== false);
  assert.deepEqual(identityOnly, { version: 1, providers: [{ id: "codex_chatgpt" }] });
});

test("scope attachment leaves sibling providers untouched", () => {
  const sibling = { id: "second_provider", controls: validControls() };
  const model: Record<string, unknown> = {
    slug: "gpt-5-codex",
    prompt_cache: { version: 1, providers: [{ id: CODEX_CHATGPT_PROMPT_CACHE_PROVIDER, controls: validControls() }, sibling] },
  };
  const attached = withCodexModelPromptCacheScope(
    snapshotOf([model]),
    "gpt-5-codex",
    CODEX_CHATGPT_PROMPT_CACHE_PROVIDER,
    validScope() as unknown as PromptCacheScope
  );

  assert.ok(attached);
  const cache = normalizePromptCacheCapabilities(attached.models[0]?.prompt_cache);
  assert.ok(cache !== null && cache !== false);
  assert.deepEqual(
    cache.providers.map((provider) => provider.id),
    [CODEX_CHATGPT_PROMPT_CACHE_PROVIDER, "second_provider"]
  );
  assert.ok(cache.providers[0]?.scope);
  assert.deepEqual(cache.providers[1], sibling);
});

test("a profile-only provider merge keeps the provider identity", () => {
  const merged = mergePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt" }), capabilitiesWith({ id: "codex_chatgpt" }));

  assert.ok(merged !== null && merged !== false);
  assert.deepEqual(merged, { version: 1, providers: [{ id: "codex_chatgpt" }] });

  // A provider that only carries scope accepts controls from the catalog side.
  const withControls = mergePromptCacheCapabilities(capabilitiesWith({ id: "codex_chatgpt", scope: validScope() }), capabilitiesWithControls());
  assert.ok(withControls !== null && withControls !== false);
  assert.ok(withControls.providers[0]?.controls);
  assert.equal(withControls.providers[0]?.scope?.account_slots, "account_scoped");
});
