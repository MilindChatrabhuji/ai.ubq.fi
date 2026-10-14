import type { Kv, KvEntryMaybe, KvKey } from "#kv";
// Prompt cache scope promotion, split out of src/codex_catalog.ts.

import { CODEX_AUTH_POOL_KV_KEY, CODEX_MODELS_KV_KEY, type CodexModelsSnapshot, preserveCodexDefaultModel } from "../codex/index.ts";
import {
  CODEX_CHATGPT_PROMPT_CACHE_PROVIDER,
  getUniqueCodexModelBySlug,
  isCodexModelPromptCacheScopeExperimentEligible,
  isConcretePromptCacheScope,
  type PromptCacheScope,
  withCodexModelPromptCacheScope,
} from "../models/codex-models.ts";
import { buildRuntimeConfig, cacheRuntimeConfig, normalizeRuntimeConfig, RUNTIME_CONFIG_V2_KEY, type RuntimeConfigV2 } from "../runtime-config.ts";
import { getString, isRecord } from "../utils.ts";
import { PROMPT_CACHE_SCOPE_PROMOTION_LEASE_MS } from "./types.ts";
import type { RefreshLease } from "./types.ts";

export type PromptCacheScopePromotionLease = Readonly<{
  key: KvKey;
  owner: string;
}>;

export type PromptCacheScopePromotionResult =
  | Readonly<{ status: "promoted" }>
  | Readonly<{
      status: "inconclusive";
      reason:
        | "invalid_scope"
        | "lease_lost"
        | "snapshot_unavailable"
        | "runtime_unavailable"
        | "model_drift"
        | "auth_pool_drift"
        | "capability_changed"
        | "catalog_drift"
        | "runtime_drift"
        | "cas_conflict";
    }>;

/** The inconclusive half of a promotion result. */
type PromptCacheScopePromotionFailure = Extract<PromptCacheScopePromotionResult, { status: "inconclusive" }>;

/** The values a validated promotion attempt needs to run its compare-and-swap. */
type PromptCacheScopePromotionReady = Readonly<{
  status: "ready";
  nextSnapshot: CodexModelsSnapshot;
  nextRuntime: RuntimeConfigV2;
}>;

/** The inputs one promotion attempt validates against the stored catalog state. */
type PromptCacheScopePromotionInput = Readonly<{
  model: string;
  scope: PromptCacheScope;
  lease: PromptCacheScopePromotionLease;
  authPoolVersionstamp: string;
  /**
   * The scope runner binds a campaign to one exact full-catalog revision.
   * A model may be non-default, but it may never publish against a catalog
   * revision other than the one whose controls it actually probed.
   */
  catalogVersionstamp: string;
  /** The same fence for the compact runtime/default-model configuration. */
  runtimeVersionstamp: string;
}>;

/** The strong reads one promotion attempt validates against each other. */
type PromptCacheScopePromotionEntries = Readonly<{
  snapshot: KvEntryMaybe<CodexModelsSnapshot>;
  runtime: KvEntryMaybe<RuntimeConfigV2>;
  lease: KvEntryMaybe<unknown>;
  authPool: KvEntryMaybe<unknown>;
}>;

const ownsPromptCacheScopePromotionLease = (value: unknown, owner: string): boolean =>
  isRecord(value) &&
  value.owner === owner &&
  typeof value.lease_until_ms === "number" &&
  Number.isFinite(value.lease_until_ms) &&
  value.lease_until_ms > Date.now();

/**
 * Evaluate one promotion attempt without writing anything: every fence, every
 * drift check and both rebuilt views, in their original order. The caller owns
 * the compare-and-swap, so a failure here leaves the store untouched.
 */
const planPromptCacheScopePromotion = (
  input: PromptCacheScopePromotionInput,
  model: string,
  entries: PromptCacheScopePromotionEntries
): PromptCacheScopePromotionReady | PromptCacheScopePromotionFailure => {
  const { snapshot: snapshotEntry, runtime: runtimeEntry, lease: leaseEntry, authPool: authPoolEntry } = entries;
  if (!ownsPromptCacheScopePromotionLease(leaseEntry.value, input.lease.owner)) {
    return { status: "inconclusive", reason: "lease_lost" };
  }
  if (authPoolEntry.versionstamp !== input.authPoolVersionstamp) {
    return { status: "inconclusive", reason: "auth_pool_drift" };
  }

  const snapshot = snapshotEntry.value;
  if (
    !snapshot ||
    !Array.isArray(snapshot.models) ||
    !getString(snapshot.source)?.trim() ||
    !Number.isSafeInteger(snapshot.updated_at_ms) ||
    snapshot.updated_at_ms <= 0
  ) {
    return { status: "inconclusive", reason: "snapshot_unavailable" };
  }
  if (snapshotEntry.versionstamp !== input.catalogVersionstamp) {
    return { status: "inconclusive", reason: "catalog_drift" };
  }
  if (!getUniqueCodexModelBySlug(snapshot, model)) {
    return { status: "inconclusive", reason: "model_drift" };
  }
  if (!isCodexModelPromptCacheScopeExperimentEligible(snapshot, model)) {
    return { status: "inconclusive", reason: "capability_changed" };
  }

  const currentRuntime = normalizeRuntimeConfig(runtimeEntry.value);
  if (!currentRuntime) return { status: "inconclusive", reason: "runtime_unavailable" };
  if (runtimeEntry.versionstamp !== input.runtimeVersionstamp) {
    return { status: "inconclusive", reason: "runtime_drift" };
  }
  // Scope evidence belongs to a catalog model, not necessarily the active
  // default. Rebuilding the compact view must retain the configured default
  // verbatim when the probed model is non-default.
  const defaultModel = preserveCodexDefaultModel(snapshot, currentRuntime.default_model);
  if (!defaultModel) return { status: "inconclusive", reason: "runtime_unavailable" };

  const nextSnapshot = withCodexModelPromptCacheScope(snapshot, model, CODEX_CHATGPT_PROMPT_CACHE_PROVIDER, input.scope);
  if (!nextSnapshot) return { status: "inconclusive", reason: "model_drift" };

  try {
    const nextRuntime = buildRuntimeConfig(nextSnapshot, {
      defaultModel,
      defaultReasoningEffort: currentRuntime.default_reasoning_effort,
      nowMs: input.scope.verified_at_ms,
    });
    return { status: "ready", nextSnapshot, nextRuntime };
  } catch {
    return { status: "inconclusive", reason: "runtime_unavailable" };
  }
};

/**
 * Publish a concrete live scope observation without replacing catalog-owned
 * controls or another model's evidence. The catalog and compact runtime view
 * are committed together, and the warm runtime cache changes only after that
 * compare-and-swap succeeds.
 */
export const promoteCodexPromptCacheScope = async (kv: Kv, input: PromptCacheScopePromotionInput): Promise<PromptCacheScopePromotionResult> => {
  const model = input.model.trim();
  if (
    !model ||
    !input.authPoolVersionstamp.trim() ||
    !input.catalogVersionstamp.trim() ||
    !input.runtimeVersionstamp.trim() ||
    input.scope.effective_model?.trim() !== model ||
    !isConcretePromptCacheScope(input.scope, 3)
  ) {
    return { status: "inconclusive", reason: "invalid_scope" };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [snapshotEntry, runtimeEntry, leaseEntry, authPoolEntry] = await Promise.all([
      kv.get<CodexModelsSnapshot>(CODEX_MODELS_KV_KEY, { consistency: "strong" }),
      kv.get<RuntimeConfigV2>(RUNTIME_CONFIG_V2_KEY, { consistency: "strong" }),
      kv.get(input.lease.key, { consistency: "strong" }),
      kv.get(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" }),
    ]);
    const attemptPlan = planPromptCacheScopePromotion(input, model, {
      snapshot: snapshotEntry,
      runtime: runtimeEntry,
      lease: leaseEntry,
      authPool: authPoolEntry,
    });
    if (attemptPlan.status === "inconclusive") return attemptPlan;

    const renewedLease: RefreshLease = {
      owner: input.lease.owner,
      lease_until_ms: Date.now() + PROMPT_CACHE_SCOPE_PROMOTION_LEASE_MS,
    };
    const commit = await kv
      .atomic()
      .check(snapshotEntry)
      .check(runtimeEntry)
      .check(leaseEntry)
      .check(authPoolEntry)
      .set(CODEX_MODELS_KV_KEY, attemptPlan.nextSnapshot)
      .set(RUNTIME_CONFIG_V2_KEY, attemptPlan.nextRuntime)
      .set(input.lease.key, renewedLease, { expireIn: PROMPT_CACHE_SCOPE_PROMOTION_LEASE_MS * 2 })
      .commit();
    if (!commit.ok) continue;
    cacheRuntimeConfig(attemptPlan.nextRuntime);
    return { status: "promoted" };
  }
  return { status: "inconclusive", reason: "cas_conflict" };
};
