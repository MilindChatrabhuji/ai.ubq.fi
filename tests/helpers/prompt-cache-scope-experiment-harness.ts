import { KvU64 } from "#kv";
import type { AtomicOperation, Kv, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
// Shared harness for this suite, moved out of the original test file.

import assert from "node:assert/strict";

const encodeKey = (key: KvKey): string => JSON.stringify(key);

/** Deterministic per-step cache telemetry cycles for these transport stubs. */
const CACHE_READ_CYCLE = [0, 2_560, 0, 2_560, 2_560, 2_560, 2_560, 2_560, 2_560, 2_560] as const;
/** Writes lead with three hits (the mixed-discriminator fixtures). */
const CACHE_WRITE_CYCLE_LEADING = [2_560, 2_560, 2_560, 0, 0, 0, 0, 0, 0, 0] as const;
/** Writes alternate hit and miss (the refresh/rotation fixtures). */
const CACHE_WRITE_CYCLE_ALTERNATING = [2_560, 0, 2_560, 0, 0, 0, 0, 0, 0, 0] as const;

/** Code-unit ascending string order: exactly what an argument-less `Array.prototype.sort()` does. */
const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/** Total lookup into a fixed telemetry cycle; these fixtures never exceed one cycle. */
const cycleValue = (cycle: readonly number[], step: number): number => {
  const value = cycle.at(step);
  if (value === undefined) throw new Error(`cache telemetry cycle has no step ${step}`);
  return value;
};

/** URL text of a fetch input, matching the transport's own routing. */
const fetchInputUrl = (input: RequestInfo | URL): string => {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
};

/** The captured request body, which these transports always send as a JSON string. */
const requestBodyText = (init?: RequestInit): string => {
  const body = init?.body ?? "";
  if (typeof body !== "string") throw new Error("scope experiment requests must send a JSON string body");
  return body;
};

type AtomicWrite = Readonly<{ type: "set" | "delete"; key: KvKey; value?: unknown }>;

class ExperimentKv {
  readonly values = new Map<string, unknown>();
  private readonly _revisions = new Map<string, number>();
  private _nextRevision = 1;
  atomicCalls = 0;
  beforeGet: ((key: KvKey) => void | Promise<void>) | null = null;
  afterAtomicCommit: ((writes: readonly AtomicWrite[]) => void) | null = null;

  clear(): void {
    this.values.clear();
    this._revisions.clear();
    this._nextRevision = 1;
    this.atomicCalls = 0;
    this.beforeGet = null;
    this.afterAtomicCommit = null;
  }

  put(key: KvKey, value: unknown): void {
    this._write(key, value);
  }

  private _versionstamp(key: KvKey): string | null {
    const revision = this._revisions.get(encodeKey(key));
    return revision === undefined ? null : String(revision).padStart(20, "0");
  }

  private _write(key: KvKey, value: unknown, revision = this._nextRevision++): void {
    const encoded = encodeKey(key);
    this.values.set(encoded, value);
    this._revisions.set(encoded, revision);
  }

  private _remove(key: KvKey, _revision = this._nextRevision++): void {
    this.values.delete(encodeKey(key));
    this._revisions.delete(encodeKey(key));
  }

  async get<T>(key: KvKey, options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    if (options) assert.equal(options.consistency, "strong");
    await this.beforeGet?.(key);
    return {
      key,
      value: (this.values.get(encodeKey(key)) ?? null) as T | null,
      versionstamp: this._versionstamp(key),
    } as KvEntryMaybe<T>;
  }

  set(key: KvKey, value: unknown, _options?: { expireIn?: number }): Promise<KvCommitResult> {
    this._write(key, value);
    const versionstamp = this._versionstamp(key);
    assert.ok(versionstamp, "a written key must expose a versionstamp");
    return Promise.resolve({ ok: true, versionstamp });
  }

  delete(key: KvKey): Promise<void> {
    this._remove(key);
    return Promise.resolve();
  }

  atomic(): AtomicOperation {
    this.atomicCalls += 1;
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const writes: AtomicWrite[] = [];
    const chain = {
      check: (...entries: { key: KvKey; versionstamp: string | null }[]) => {
        checks.push(...entries);
        return chain;
      },
      set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
        writes.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        writes.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        if (checks.some((entry) => this._versionstamp(entry.key) !== entry.versionstamp)) {
          return Promise.resolve({ ok: false, versionstamp: null } as const);
        }
        const revision = this._nextRevision++;
        for (const write of writes) {
          if (write.type === "set") this._write(write.key, write.value, revision);
          else this._remove(write.key, revision);
        }
        this.afterAtomicCommit?.(writes);
        return Promise.resolve({ ok: true, versionstamp: String(revision).padStart(20, "0") } as const);
      },
    };
    return chain as unknown as AtomicOperation;
  }
}

const kv = new ExperimentKv();

const { setKvForTest } = await import("../../src/kv.ts");
const { resetCodexAuthCacheForTest, CODEX_AUTH_POOL_KV_KEY, CODEX_MODELS_KV_KEY, storeCodexModelsSnapshot } = await import("../../src/codex/index.ts");
const { resetRuntimeConfigCacheForTest, RUNTIME_CONFIG_V2_KEY } = await import("../../src/runtime-config.ts");
const {
  PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX,
  PromptCacheScopeExperimentBusyError,
  PromptCacheScopeExperimentUnavailableError,
  assertPromptCacheScopeExperimentTelemetryBaseline,
  readPromptCacheScopeExperimentTelemetryBaseline,
  readPromptCacheScopeExperimentCompletedUsage,
  runPromptCacheScopeExperiment,
} = await import("../../src/cache/scope-experiment.ts");
const { promoteCodexPromptCacheScope } = await import("../../src/catalog/promotion.ts");
const { resolvePromptCacheTelemetryCounterKeys } = await import("../../src/cache/telemetry-gate.ts");
const { getCodexProviderHealth, resetProviderHealthThrottleForTest } = await import("../../src/provider/health.ts");
const { loadPromptCacheScopeTargetInventory } = await import("../../src/cache/scope-targets.ts");
const { handleAdminCodexCacheScopeExperiment, handleAdminCodexCacheScopeExperimentTelemetryBaseline } = await import("../../src/admin/index.ts");

const MODEL = "gpt-5.6-cache-scope-fixture";
const TELEMETRY_RELEASE = "0123456789abcdef0123456789abcdef01234567";
const targetKeyParts = (model: string): readonly string[] => [
  "codex_chatgpt",
  "chatgpt_codex",
  "codex_account_pool",
  "responses_implicit_input_text_keyed_cycle_isolated_v5",
  model,
];
const evidenceKeyFor = (model: string): KvKey => [...PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX, "evidence", ...targetKeyParts(model)];
const stateKeyFor = (model: string): KvKey => [...PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX, "state", ...targetKeyParts(model)];
const evidenceKey = evidenceKeyFor(MODEL);
const stateKey = stateKeyFor(MODEL);
const leaseKey = (model: string): KvKey => [
  ...PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX,
  "cycle_lease",
  "codex_chatgpt",
  "chatgpt_codex",
  "codex_account_pool",
  "responses_implicit_input_text_keyed_cycle_isolated_v5",
  model,
];
const campaignLeaseKey: KvKey = [
  ...PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX,
  "campaign",
  "codex_chatgpt",
  "chatgpt_codex",
  "responses_implicit_input_text_keyed_cycle_isolated_v5",
];

const makeAuth = (label: string) => ({
  access_token: `access-${label}`,
  refresh_token: `refresh-${label}`,
  account_id: `account-${label}`,
  updated_at_ms: Date.now(),
});

const authPoolVersionstamp = async (): Promise<string> => {
  const versionstamp = (await kv.get(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" })).versionstamp;
  if (!versionstamp) throw new Error("missing seeded Codex auth-pool versionstamp");
  return versionstamp;
};

const catalogVersionstamp = async (): Promise<string> => {
  const versionstamp = (await kv.get(CODEX_MODELS_KV_KEY, { consistency: "strong" })).versionstamp;
  if (!versionstamp) throw new Error("missing seeded Codex catalog versionstamp");
  return versionstamp;
};

const runtimeVersionstamp = async (): Promise<string> => {
  const versionstamp = (await kv.get(RUNTIME_CONFIG_V2_KEY, { consistency: "strong" })).versionstamp;
  if (!versionstamp) throw new Error("missing seeded runtime versionstamp");
  return versionstamp;
};

const promotionBinding = async () => ({
  catalogVersionstamp: await catalogVersionstamp(),
  runtimeVersionstamp: await runtimeVersionstamp(),
});

const cacheControls = {
  key: true,
  expected_usage_fields: ["cached_tokens", "cache_write_tokens"],
  source: "catalog",
  verified_at_ms: 1_000,
};

const modelRecord = (model: string, controls = cacheControls): Record<string, unknown> => ({
  slug: model,
  supported_reasoning_levels: ["none"],
  prompt_cache: {
    version: 1,
    providers: [{ id: "codex_chatgpt", controls }],
  },
});

const seed = (options: Readonly<{ models?: readonly string[]; defaultModel?: string }> = {}): void => {
  kv.clear();
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  resetRuntimeConfigCacheForTest();
  const models = options.models ?? [MODEL];
  const defaultModel = options.defaultModel ?? MODEL;
  const snapshot = {
    source: "chatgpt_codex",
    client_version: "0.201.0",
    updated_at_ms: Date.now(),
    models: models.map((model) => modelRecord(model)),
  };
  kv.put(CODEX_AUTH_POOL_KV_KEY, {
    accounts: [makeAuth("one"), makeAuth("two")],
    updated_at_ms: Date.now(),
  });
  kv.put(CODEX_MODELS_KV_KEY, snapshot);
  kv.put(RUNTIME_CONFIG_V2_KEY, {
    version: 2,
    default_model: defaultModel,
    default_reasoning_effort: "none",
    codex_models: snapshot,
    updated_at_ms: Date.now(),
  });
};

const seedStage0Baseline = async (model: string): Promise<void> => {
  const counterKeys = await resolvePromptCacheTelemetryCounterKeys({ provider: "chatgpt_codex", model }, { release: TELEMETRY_RELEASE });
  if (!counterKeys) throw new Error("missing Stage 0 counter keys");
  for (const route of counterKeys.routes) {
    kv.put(route.completed, new KvU64(5_000n));
    kv.put(route.reported, new KvU64(5_000n));
    kv.put(route.cache_write_reported, new KvU64(5_000n));
  }
};

/**
 * Unit fixtures intentionally exercise the fenced runner without fabricating
 * a deploy-attested Stage 0 baseline. The public admin route obtains the
 * corresponding binding from the real baseline assertion.
 */
const scopeBaselineFor = async (model = MODEL) => {
  const inventory = await loadPromptCacheScopeTargetInventory({ kv: kv as unknown as Kv });
  if (inventory.status !== "ready") throw new Error("missing seeded target inventory");
  const target = inventory.targets.find((candidate) => candidate.provider === "codex_chatgpt" && candidate.model === model);
  const runtimeStamp = await runtimeVersionstamp();
  if (!target) throw new Error("missing seeded probeable target");
  if (
    target.probeability.status !== "probeable" ||
    !target.catalog_versionstamp ||
    !target.codex_auth_pool_versionstamp ||
    !target.codex_auth_pool_identity_fingerprint ||
    !inventory.inventory_fingerprint
  )
    throw new Error("missing seeded probeable target");
  return {
    target: {
      id: target.id,
      provider: "codex_chatgpt" as const,
      telemetry_provider: "chatgpt_codex" as const,
      topology_kind: "codex_account_pool" as const,
      model,
      probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5" as const,
      capability_fingerprint: target.capability_fingerprint,
      inventory_fingerprint: inventory.inventory_fingerprint,
      catalog_versionstamp: target.catalog_versionstamp,
      runtime_versionstamp: runtimeStamp,
      auth_pool_versionstamp: target.codex_auth_pool_versionstamp,
      auth_pool_identity_fingerprint: target.codex_auth_pool_identity_fingerprint,
      catalog_client_version: target.catalog_client_version,
    },
  } satisfies Parameters<typeof runPromptCacheScopeExperiment>[0];
};

const runExperiment = async (model = MODEL) => {
  return await runPromptCacheScopeExperiment(await scopeBaselineFor(model));
};

const sseCompleted = (cachedTokens: number, cacheWriteTokens: number, model = MODEL): Response => {
  const usage = {
    input_tokens: 3_000,
    output_tokens: 1,
    total_tokens: 3_001,
    input_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: cacheWriteTokens },
  };
  const event = `data: ${JSON.stringify({ type: "response.completed", response: { model, usage } })}\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

const waitForCodexHealth = async (accountId: string) => {
  const deadline = performance.now() + 2_000;
  for (;;) {
    const health = await getCodexProviderHealth(accountId);
    if (health.state === "healthy") return health;
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${accountId} provider health`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

export {
  CACHE_READ_CYCLE,
  CACHE_WRITE_CYCLE_ALTERNATING,
  CACHE_WRITE_CYCLE_LEADING,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_MODELS_KV_KEY,
  ExperimentKv,
  MODEL,
  PROMPT_CACHE_SCOPE_EXPERIMENT_KV_PREFIX,
  PromptCacheScopeExperimentBusyError,
  PromptCacheScopeExperimentUnavailableError,
  RUNTIME_CONFIG_V2_KEY,
  TELEMETRY_RELEASE,
  assertPromptCacheScopeExperimentTelemetryBaseline,
  authPoolVersionstamp,
  cacheControls,
  campaignLeaseKey,
  catalogVersionstamp,
  compareStrings,
  cycleValue,
  encodeKey,
  evidenceKey,
  evidenceKeyFor,
  fetchInputUrl,
  getCodexProviderHealth,
  handleAdminCodexCacheScopeExperiment,
  handleAdminCodexCacheScopeExperimentTelemetryBaseline,
  kv,
  leaseKey,
  loadPromptCacheScopeTargetInventory,
  makeAuth,
  modelRecord,
  promoteCodexPromptCacheScope,
  promotionBinding,
  readPromptCacheScopeExperimentCompletedUsage,
  readPromptCacheScopeExperimentTelemetryBaseline,
  requestBodyText,
  resetCodexAuthCacheForTest,
  resetProviderHealthThrottleForTest,
  resetRuntimeConfigCacheForTest,
  resolvePromptCacheTelemetryCounterKeys,
  runExperiment,
  runPromptCacheScopeExperiment,
  runtimeVersionstamp,
  scopeBaselineFor,
  seed,
  seedStage0Baseline,
  setKvForTest,
  sseCompleted,
  stateKey,
  stateKeyFor,
  storeCodexModelsSnapshot,
  targetKeyParts,
  waitForCodexHealth,
};
export type { AtomicWrite };

/** Reinstall this fixture explicitly when a Bun test file uses the cached harness. */
export const installHarness = (): void => {
  setKvForTest(kv as unknown as Kv);
};
export const resetHarness = (): void => {
  kv.clear();
  resetCodexAuthCacheForTest();
  resetRuntimeConfigCacheForTest();
  installHarness();
};
export const cleanupHarness = (): void => {
  setKvForTest(null);
};
