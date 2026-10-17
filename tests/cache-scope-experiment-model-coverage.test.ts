import { test } from "bun:test";
// Prompt-cache scope experiment coverage, split out of
// tests/cache-kv-migration-usage-coverage.test.ts so both files stay under the 1500-line cap.

import assert from "node:assert/strict";

import { PROMPT_CACHE_SCOPE_PROBE_PROFILE } from "../src/models/codex-models.ts";
import {
  activeStateEvidenceIsConsistent,
  classifyCycle,
  hasMixedPrefixScaleCacheSignals,
  matchesCycleReusableCounter,
  parseEvidence,
  parseState,
  parseTargetBinding,
  PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER,
  PromptCacheScopeExperimentFailedError,
  readPromptCacheScopeExperimentCompletedUsage,
  sharedObservation,
  throwIfAborted,
  type CacheSignal,
  type PromptCacheScopeSample,
} from "../src/cache/scope-experiment-model.ts";

const SCOPE_MODEL = "gpt-5.6-sol";

const targetBinding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "target-1",
  provider: PROMPT_CACHE_SCOPE_EXPERIMENT_PROVIDER,
  telemetry_provider: "chatgpt_codex",
  topology_kind: "codex_account_pool",
  model: SCOPE_MODEL,
  probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
  capability_fingerprint: "capability-1",
  inventory_fingerprint: "inventory-1",
  catalog_versionstamp: "catalog-1",
  runtime_versionstamp: "runtime-1",
  auth_pool_versionstamp: "auth-pool-1",
  auth_pool_identity_fingerprint: "identity-1",
  catalog_client_version: null,
  ...overrides,
});

const observation = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
  account_slots: "shared",
  token_refresh: "preserved",
  conversation_id: "independent",
  effective_model: SCOPE_MODEL,
  ...overrides,
});

const PROBE_INPUT_TOKENS = 2_560;
const PROBE_OUTPUT_TOKENS = 12;

/**
 * One cache-signal shape per probe step: `read` reports the reusable prefix as a
 * cache read, `write` as a cache write, and `none` reports neither. The
 * discriminator steps (2, 5, 7) carry exactly one signal.
 */
const SIGNAL_SHAPES = ["write", "read", "write", "read", "read", "read", "read", "write", "read", "read"] as const;

const probeSample = (step: (typeof PROBE_STEPS)[number], shape: (typeof SIGNAL_SHAPES)[number], slot: number): PromptCacheScopeSample => {
  const cached = shape === "read" ? 2_560 : 0;
  const written = shape === "write" ? 2_560 : 0;
  const usage = {
    input_tokens: PROBE_INPUT_TOKENS,
    cached_tokens: cached,
    cache_write_tokens: written,
    output_tokens: PROBE_OUTPUT_TOKENS,
    total_tokens: PROBE_INPUT_TOKENS + PROBE_OUTPUT_TOKENS,
  };
  return { step, slot, raw_usage: usage, usage, elapsed_ms: 120 };
};

const PROBE_STEPS = [
  "slot_1_warm",
  "slot_1_repeat",
  "slot_2_first",
  "slot_2_repeat",
  "slot_1_after_slot_2",
  "slot_1_after_refresh",
  "slot_1_post_refresh_repeat",
  "slot_1_conversation_changed",
  "slot_1_conversation_changed_repeat",
  "slot_1_original_conversation_recheck",
] as const;

const PROBE_SLOTS = [1, 1, 2, 2, 1, 1, 1, 1, 1, 1] as const;

const probeCycleSamples = (overrides: Partial<PromptCacheScopeSample> = {}): PromptCacheScopeSample[] =>
  PROBE_STEPS.map((step, index) => ({ ...probeSample(step, SIGNAL_SHAPES[index], PROBE_SLOTS[index]), ...overrides }));

const PROBE_CLASSIFICATION = {
  probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
  account_slots: "account_scoped",
  token_refresh: "preserved",
  conversation_id: "scoped",
  effective_model: SCOPE_MODEL,
};

/**
 * A signal sequence whose step at `index` carries no cache signal. The declared
 * element type is `CacheSignal`, but persisted evidence is read from KV and this
 * models a row that reached the classifier without one.
 */
const withMissingStepSignal = (signals: readonly CacheSignal[], index: number): CacheSignal[] =>
  signals.map((signal, position) => (position === index ? (undefined as unknown as CacheSignal) : signal));

/** Discriminator steps 2, 5 and 7 all read, which resolves every axis to the "first" side. */
const SIGNAL_SHAPES_INDEPENDENT = ["write", "read", "read", "read", "read", "read", "read", "read", "read", "read"] as const;

/** Builds one classified cycle fixture whose scope is derived by the module itself. */
const probeCycle = (
  shapes: readonly (typeof SIGNAL_SHAPES)[number][] = SIGNAL_SHAPES
): Readonly<{ samples: PromptCacheScopeSample[]; signals: CacheSignal[]; classification: NonNullable<ReturnType<typeof classifyCycle>> }> => {
  const samples = PROBE_STEPS.map((step, index) => probeSample(step, shapes[index], PROBE_SLOTS[index]));
  const signals = shapes.map((shape) => (shape === "read" ? "read" : "write") as CacheSignal);
  const classification = classifyCycle(SCOPE_MODEL, samples, signals);
  if (classification === null) throw new Error(`${shapes.join(",")} is not a classifying probe cycle`);
  return { samples, signals, classification };
};

test("scope experiment: the failure error keeps its own name and message", () => {
  const error = new PromptCacheScopeExperimentFailedError("campaign aborted");

  assert.equal(error.name, "PromptCacheScopeExperimentFailedError");
  assert.equal(error.message, "campaign aborted");
  assert.ok(error instanceof Error);
});

test("scope experiment: a complete target binding round-trips and every literal fence is enforced", () => {
  const binding = parseTargetBinding(targetBinding());
  assert.equal(binding?.id, "target-1");
  assert.equal(binding.model, SCOPE_MODEL);
  assert.equal(binding.catalog_client_version, null);

  const withClientVersion = parseTargetBinding(targetBinding({ catalog_client_version: " 1.2.3 " }));
  assert.equal(withClientVersion?.catalog_client_version, "1.2.3");

  const rejects: readonly unknown[] = [
    null,
    "target",
    [],
    targetBinding({ provider: "openai" }),
    targetBinding({ telemetry_provider: "openrouter" }),
    targetBinding({ topology_kind: "single_account" }),
    targetBinding({ probe_profile: "other-profile" }),
    // Extra or missing keys fail the exact-key check.
    { ...targetBinding(), extra: true },
    Object.fromEntries(Object.entries(targetBinding()).filter(([key]) => key !== "id")),
    ...["id", "model", "capability_fingerprint", "inventory_fingerprint", "catalog_versionstamp", "runtime_versionstamp", "auth_pool_versionstamp"].map(
      (field) => targetBinding({ [field]: "   " })
    ),
    targetBinding({ id: 7 }),
    targetBinding({ auth_pool_identity_fingerprint: null }),
    targetBinding({ catalog_client_version: "  " }),
  ];
  for (const value of rejects) {
    assert.equal(parseTargetBinding(value), null, `expected rejection of ${JSON.stringify(value)}`);
  }
});

test("scope experiment: state parsing accepts a fresh campaign and rejects drifted counters", () => {
  const now = Date.now();
  const state = {
    v: 3,
    target: targetBinding(),
    campaign_owner: "owner-1",
    started_at_ms: now - 60_000,
    expires_at_ms: now + 60_000,
    auth_pool_versionstamp: "auth-pool-1",
    next_cycle: 1,
    classifications: [],
  };
  const parsed = parseState(state);
  assert.equal(parsed?.campaign_owner, "owner-1");
  assert.equal(parsed.next_cycle, 1);
  assert.equal(parsed.pending_scope, undefined);

  const rejects: readonly unknown[] = [
    null,
    "state",
    { ...state, v: 2 },
    Object.fromEntries(Object.entries(state).filter(([key]) => key !== "target")),
    { ...state, extra: true },
    { ...state, next_cycle: "1" },
    { ...state, next_cycle: 0 },
    // One classification for a cycle count that demands two.
    { ...state, next_cycle: 3, classifications: [observation()] },
    // Too many classifications for the declared cycle.
    { ...state, next_cycle: 2, classifications: [observation(), observation()] },
    // A pending scope that is not a concrete observation.
    { ...state, next_cycle: 2, classifications: [observation()], pending_scope: {} },
    // A pending scope on a cycle count that has not finished.
    { ...state, next_cycle: 2, classifications: [observation()], pending_scope: observation() },
    { ...state, started_at_ms: 0 },
    { ...state, started_at_ms: now + 60_000 },
    { ...state, expires_at_ms: now - 120_000, started_at_ms: now - 60_000 },
    { ...state, auth_pool_versionstamp: "other" },
  ];
  for (const value of rejects) {
    assert.equal(parseState(value), null, `expected rejection of ${JSON.stringify(value)}`);
  }
});

test("scope experiment: a finished campaign requires the pending scope to agree with all three cycles", () => {
  const now = Date.now();
  const classifications = [observation(), observation(), observation()];
  const pending = observation();
  const state = {
    v: 3,
    target: targetBinding(),
    campaign_owner: "owner-1",
    started_at_ms: now - 60_000,
    expires_at_ms: now + 60_000,
    auth_pool_versionstamp: "auth-pool-1",
    next_cycle: 4,
    classifications,
    pending_scope: pending,
  };
  const parsed = parseState(state);
  assert.deepEqual(parsed?.pending_scope, pending);
  assert.deepEqual(parsed.classifications, classifications);

  // A pending scope that disagrees with the agreed scope is rejected.
  assert.equal(parseState({ ...state, pending_scope: observation({ account_slots: "account_scoped" }) }), null);
  // As is a missing pending scope on the finished cycle.
  assert.equal(parseState({ ...state, pending_scope: undefined }), null);
  // And a disagreeing set of cycles.
  assert.equal(parseState({ ...state, classifications: [observation(), observation(), observation({ token_refresh: "changed" })] }), null);
});

test("scope experiment: sharedObservation agrees only on a non-empty unanimous sequence", () => {
  const shared = observation() as Parameters<typeof sharedObservation>[0][number];
  assert.equal(sharedObservation([]), null);
  assert.deepEqual(sharedObservation([shared, shared]), shared);
  assert.equal(sharedObservation([shared, observation({ conversation_id: "scoped" }) as typeof shared]), null);
});

test("scope experiment: cycle classification derives the concrete scope from the discriminator steps", () => {
  const cycle = probeCycle();
  const samples = cycle.samples;
  const signals = cycle.signals;

  assert.deepEqual(classifyCycle(SCOPE_MODEL, samples, signals), PROBE_CLASSIFICATION);

  // A shorter cycle, a slot drift, a size drift and a mixed discriminator all fail closed.
  assert.equal(classifyCycle(SCOPE_MODEL, samples.slice(0, 9), signals.slice(0, 9)), null);
  assert.equal(classifyCycle(SCOPE_MODEL, probeCycleSamples({ slot: 2 }), signals), null);
  // One row reporting a different input size breaks the prefix comparison.
  assert.equal(
    classifyCycle(
      SCOPE_MODEL,
      samples.map((sample, index) => (index === 4 ? { ...sample, usage: { ...sample.usage, input_tokens: 3_000 } } : sample)),
      signals
    ),
    null
  );
  // A uniformly larger input is still prefix-scale, so it classifies.
  assert.deepEqual(
    classifyCycle(
      SCOPE_MODEL,
      samples.map((sample) => ({ ...sample, usage: { ...sample.usage, input_tokens: 5_000, total_tokens: 5_012 } })),
      signals
    ),
    PROBE_CLASSIFICATION
  );

  // A shorter cycle and a slot drift fail closed.
  const mixed = samples.map((sample, index) =>
    index === 2 ? { ...sample, usage: { ...sample.usage, cached_tokens: 2_560, cache_write_tokens: 2_560 } } : sample
  );
  assert.equal(hasMixedPrefixScaleCacheSignals(mixed[2].usage), true);
  assert.equal(classifyCycle(SCOPE_MODEL, mixed, signals), null);
  // A discriminator step reporting no cache signal cannot resolve its axis.
  assert.equal(classifyCycle(SCOPE_MODEL, samples, withMissingStepSignal(signals, 5)), null);
  // A non-discriminator step whose signal disagrees with the probe shape is rejected.
  assert.equal(
    classifyCycle(
      SCOPE_MODEL,
      samples,
      signals.map((signal, index) => (index === 3 ? "write" : signal))
    ),
    null
  );
  // A cycle that never wrote the prefix has no reusable counter to attribute.
  const readOnly = samples[0].usage;
  assert.equal(classifyCycle(SCOPE_MODEL, probeCycleSamples({ usage: { ...readOnly, cached_tokens: 2_560, cache_write_tokens: 0 } }), signals), null);
  // A reusable counter that only some rows report cannot describe one prefix.
  assert.equal(
    classifyCycle(SCOPE_MODEL, probeCycleSamples({ usage: { ...samples[0].usage, cached_tokens: 2_560, cache_write_tokens: 2_560 } }), signals),
    null
  );
});

test("scope experiment: the reusable counter matcher accepts zero or the exact cycle counter", () => {
  const usage = probeCycleSamples()[0].usage;
  assert.equal(matchesCycleReusableCounter(usage, 2_560), true);
  assert.equal(matchesCycleReusableCounter({ ...usage, cached_tokens: 0, cache_write_tokens: 0 }, 2_560), true);
  assert.equal(matchesCycleReusableCounter({ ...usage, cached_tokens: 2_500, cache_write_tokens: 0 }, 2_560), false);
});

test("scope experiment: stored evidence accepts a coherent campaign and rejects incomplete cycles", () => {
  const now = Date.now();
  const samples = probeCycleSamples();
  const evidence = {
    v: 3,
    target: targetBinding(),
    outcome: "in_progress",
    started_at_ms: now - 60_000,
    verified_at_ms: now,
    cycles: [{ cycle: 1, samples, classification: PROBE_CLASSIFICATION }],
  };
  const parsed = parseEvidence(evidence);
  assert.equal(parsed?.cycles.length, 1);
  assert.equal(parsed.outcome, "in_progress");
  assert.deepEqual(parsed.cycles[0].classification, PROBE_CLASSIFICATION);

  const rejects: readonly unknown[] = [
    null,
    "evidence",
    { ...evidence, v: 2 },
    { ...evidence, extra: true },
    { ...evidence, outcome: "unknown" },
    { ...evidence, verified_at_ms: now - 120_000, started_at_ms: now - 60_000 },
    { ...evidence, started_at_ms: now + 60_000 },
    // A cycle numbered out of sequence.
    { ...evidence, cycles: [{ cycle: 2, samples, classification: PROBE_CLASSIFICATION }] },
    // A cycle with a zero number.
    { ...evidence, cycles: [{ cycle: 0, samples, classification: PROBE_CLASSIFICATION }] },
    // A cycle with neither a classification nor a reason.
    { ...evidence, cycles: [{ cycle: 1, samples }] },
    // A cycle with both a classification and a reason.
    { ...evidence, cycles: [{ cycle: 1, samples, classification: PROBE_CLASSIFICATION, inconclusive_reason: "slot_drift" }] },
    // A cycle whose samples are not a probe sequence.
    { ...evidence, cycles: [{ cycle: 1, samples: samples.slice(0, 4), classification: PROBE_CLASSIFICATION }] },
    // A cycle whose recorded classification disagrees with its samples.
    { ...evidence, cycles: [{ cycle: 1, samples, classification: observation() }] },
    // A cycle whose samples carry no cache signal at all.
    {
      ...evidence,
      cycles: [
        {
          cycle: 1,
          samples: samples.map((sample) => ({
            ...sample,
            raw_usage: { ...sample.usage, cached_tokens: 0, cache_write_tokens: 0 },
            usage: { ...sample.usage, cached_tokens: 0, cache_write_tokens: 0 },
          })),
          classification: PROBE_CLASSIFICATION,
        },
      ],
    },
    // An inconclusive cycle reasons with a value outside the vocabulary.
    { ...evidence, cycles: [{ cycle: 1, samples: [], inconclusive_reason: "not_a_reason" }] },
  ];
  for (const value of rejects) {
    assert.equal(parseEvidence(value as Record<string, unknown>), null, `expected rejection of ${JSON.stringify(value)}`);
  }
});

test("scope experiment: sample rows must carry a known step, matching slot and identical usage tuples", () => {
  const sample = probeCycleSamples()[0];
  const valid = {
    v: 3,
    target: targetBinding(),
    outcome: "in_progress",
    started_at_ms: Date.now() - 60_000,
    verified_at_ms: Date.now(),
    cycles: [{ cycle: 1, samples: [sample], classification: PROBE_CLASSIFICATION }],
  };
  // A single-sample cycle cannot classify, so it is rejected through the cycle path.
  assert.equal(parseEvidence(valid), null);

  const rejects: readonly unknown[] = [
    { ...valid, cycles: [{ cycle: 1, samples: [{ ...sample, step: "unknown_step" }], classification: PROBE_CLASSIFICATION }] },
    { ...valid, cycles: [{ cycle: 1, samples: [{ ...sample, slot: 2 }], classification: PROBE_CLASSIFICATION }] },
    { ...valid, cycles: [{ cycle: 1, samples: [{ ...sample, elapsed_ms: -1 }], classification: PROBE_CLASSIFICATION }] },
    {
      ...valid,
      cycles: [{ cycle: 1, samples: [{ ...sample, raw_usage: { ...sample.usage, cached_tokens: 1 } }], classification: PROBE_CLASSIFICATION }],
    },
    { ...valid, cycles: [{ cycle: 1, samples: [{ ...sample, extra: true }], classification: PROBE_CLASSIFICATION }] },
  ];
  for (const value of rejects) {
    assert.equal(parseEvidence(value as Record<string, unknown>), null, `expected rejection of ${JSON.stringify(value)}`);
  }
});

test("scope experiment: an inconclusive cycle must carry a reason while an unclassified one must match the evidence", () => {
  const now = Date.now();
  const base = {
    v: 3,
    target: targetBinding(),
    started_at_ms: now - 60_000,
    verified_at_ms: now,
  };
  // A trailing inconclusive cycle is coherent when it repeats the evidence reason.
  const inconclusive = {
    ...base,
    outcome: "inconclusive",
    inconclusive_reason: "slot_drift",
    cycles: [{ cycle: 1, samples: [], inconclusive_reason: "slot_drift" }],
  };
  assert.deepEqual(parseEvidence(inconclusive)?.inconclusive_reason, "slot_drift");
  // A trailing cycle that reasons differently is not coherent.
  assert.equal(parseEvidence({ ...inconclusive, cycles: [{ cycle: 1, samples: [], inconclusive_reason: "lease_lost" }] }), null);
  // An earlier cycle must be classified for the sequence to be coherent.
  assert.equal(
    parseEvidence({
      ...inconclusive,
      cycles: [
        { cycle: 1, samples: [], inconclusive_reason: "slot_drift" },
        { cycle: 2, samples: [], inconclusive_reason: "slot_drift" },
      ],
    }),
    null
  );
  // `failed` evidence may not carry an inconclusive reason.
  assert.equal(parseEvidence({ ...base, outcome: "failed", inconclusive_reason: "slot_drift", cycles: [] }), null);
});

test("scope experiment: active state and evidence must describe one campaign", () => {
  const now = Date.now();
  // The state's classification and the cycle's derived scope agree here.
  const independent = probeCycle(SIGNAL_SHAPES_INDEPENDENT);
  assert.deepEqual(independent.classification, observation());
  const state = {
    v: 3,
    target: targetBinding(),
    campaign_owner: "owner-1",
    started_at_ms: now - 60_000,
    expires_at_ms: now + 60_000,
    auth_pool_versionstamp: "auth-pool-1",
    next_cycle: 2,
    classifications: [observation()],
  };
  const parsedState = parseState(state);
  assert.ok(parsedState);

  const evidence = {
    v: 3,
    target: targetBinding(),
    outcome: "in_progress",
    started_at_ms: now - 60_000,
    verified_at_ms: now,
    cycles: [{ cycle: 1, samples: independent.samples, classification: independent.classification }],
  };
  const parsedEvidence = parseEvidence(evidence);
  assert.ok(parsedEvidence);
  assert.equal(activeStateEvidenceIsConsistent(parsedState, parsedEvidence), true);

  // A fresh campaign requires the absence of evidence.
  assert.equal(activeStateEvidenceIsConsistent({ ...parsedState, classifications: [] }, null), true);
  assert.equal(activeStateEvidenceIsConsistent({ ...parsedState, classifications: [] }, parsedEvidence), false);
  // Missing evidence for a classified campaign is inconsistent.
  assert.equal(activeStateEvidenceIsConsistent(parsedState, null), false);
  // A drifted target, start time or cycle count is inconsistent.
  const driftedTarget = parseEvidence({ ...evidence, target: targetBinding({ inventory_fingerprint: "inventory-2" }) });
  assert.ok(driftedTarget);
  assert.equal(activeStateEvidenceIsConsistent(parsedState, driftedTarget), false);
  const driftedStart = parseEvidence({ ...evidence, started_at_ms: now - 30_000 });
  assert.ok(driftedStart);
  assert.equal(activeStateEvidenceIsConsistent(parsedState, driftedStart), false);
  // A cycle whose scope disagrees with the active classification is inconsistent.
  const otherCycle = probeCycle();
  const disagreeing = parseEvidence({ ...evidence, cycles: [{ cycle: 1, samples: otherCycle.samples, classification: otherCycle.classification }] });
  assert.ok(disagreeing);
  assert.equal(activeStateEvidenceIsConsistent(parsedState, disagreeing), false);
  // A cycle count that does not match the classifications is inconsistent.
  const shortCampaign = parseState({ ...state, next_cycle: 1, classifications: [] });
  assert.ok(shortCampaign);
  assert.equal(activeStateEvidenceIsConsistent(shortCampaign, parsedEvidence), false);
});

test("scope experiment: an aborted probe signal raises the supplied reason or a DOMException", () => {
  throwIfAborted(new AbortController().signal);

  const reason = new Error("campaign cancelled");
  const aborted = new AbortController();
  aborted.abort(reason);
  assert.throws(
    () => {
      throwIfAborted(aborted.signal);
    },
    (error: unknown) => error === reason
  );

  const bare = new AbortController();
  bare.abort();
  assert.throws(
    () => {
      throwIfAborted(bare.signal);
    },
    (error: unknown) => error instanceof DOMException && error.name === "AbortError"
  );
});

test("scope experiment: an unreadable upstream response fails closed with a cancellation attempt", async () => {
  const cancelled: string[] = [];
  const unreadable = {
    ok: false,
    status: 502,
    body: {
      cancel: () => {
        cancelled.push("cancelled");
        return Promise.resolve();
      },
    },
  } as unknown as Response;

  await assert.rejects(
    () => readPromptCacheScopeExperimentCompletedUsage(unreadable, 1, SCOPE_MODEL, performance.now(), new AbortController().signal),
    /Prompt-cache scope experiment did not receive a readable upstream response\./
  );
  assert.deepEqual(cancelled, ["cancelled"]);
});

test("scope experiment: a cancellation failure while discarding the body does not mask the failure reason", async () => {
  const exploding = {
    ok: false,
    status: 502,
    body: {
      cancel: () => {
        throw new Error("stream already gone");
      },
    },
  } as unknown as Response;

  await assert.rejects(
    () => readPromptCacheScopeExperimentCompletedUsage(exploding, 1, SCOPE_MODEL, performance.now(), new AbortController().signal),
    /Prompt-cache scope experiment did not receive a readable upstream response\./
  );
});

test("scope experiment: a response without a registered slot is reported as slot drift", async () => {
  const response = new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });

  const result = await readPromptCacheScopeExperimentCompletedUsage(response, 3, SCOPE_MODEL, performance.now(), new AbortController().signal);

  assert.deepEqual(result, { status: "inconclusive", reason: "slot_drift" });
});
