import type { Kv, KvEntryMaybe } from "#kv";
import { CODEX_AUTH_POOL_KV_KEY, CODEX_MODELS_KV_KEY, parseCodexAuthPool } from "../codex/index.ts";
import {
  CODEX_CHATGPT_PROMPT_CACHE_PROVIDER,
  type CodexModelsSnapshot,
  getCodexModelPromptCacheProvider,
  isCodexModelPromptCacheScopeExperimentEligible,
  PROMPT_CACHE_SCOPE_PROBE_PROFILE,
  type PromptCacheScopeProbeProfile,
} from "../models/codex-models.ts";
import { getKv } from "../kv.ts";
import { getString, isRecord, sha256Hex } from "../utils.ts";

/**
 * This is intentionally a catalog capability identity, not the terminal
 * telemetry transport identity. The latter is exposed on each target too.
 */
export const PROMPT_CACHE_SCOPE_TARGET_CODEX_PROVIDER = CODEX_CHATGPT_PROMPT_CACHE_PROVIDER;
export const PROMPT_CACHE_SCOPE_TARGET_METERED_PROVIDER = "metered" as const;
export const PROMPT_CACHE_SCOPE_TARGET_CODEX_TELEMETRY_PROVIDER = "chatgpt_codex" as const;
export const PROMPT_CACHE_SCOPE_TARGET_METERED_TELEMETRY_PROVIDER = "metered" as const;

export type PromptCacheScopeTargetProvider = typeof PROMPT_CACHE_SCOPE_TARGET_CODEX_PROVIDER | typeof PROMPT_CACHE_SCOPE_TARGET_METERED_PROVIDER;

export type PromptCacheScopeTargetTelemetryProvider =
  typeof PROMPT_CACHE_SCOPE_TARGET_CODEX_TELEMETRY_PROVIDER | typeof PROMPT_CACHE_SCOPE_TARGET_METERED_TELEMETRY_PROVIDER;

/**
 * metered model policy is tenant-key-specific. The inventory must only consume
 * an explicitly supplied, authoritative roster; it never discovers one.
 */
export type MeteredFallbackRoster = Readonly<{ status: "unknown" }> | Readonly<{ status: "authoritative"; model_ids: readonly string[] }>;

export type PromptCacheScopeTargetTopology =
  | Readonly<{
      kind: "codex_account_pool";
      configured_slot_count: 0 | 1 | 2;
      auth_pool_versionstamp: string | null;
    }>
  | Readonly<{ kind: "single_credential" }>;

export type PromptCacheScopeTargetTopologyKind = PromptCacheScopeTargetTopology["kind"];

export type PromptCacheScopeTargetProbeability =
  | Readonly<{ status: "probeable"; adapter: "codex_two_slot" }>
  | Readonly<{
      status: "unprobeable";
      reason:
        | "catalog_binding_unavailable"
        | "codex_cache_unqualified"
        | "codex_auth_pool_binding_unavailable"
        | "two_codex_slots_required"
        | "current_two_slot_adapter_does_not_apply";
    }>;

export type PromptCacheScopeTarget = Readonly<{
  /** Stable across catalog/auth-pool refreshes. It is safe to use in v3 state and evidence keys. */
  id: string;
  provider: PromptCacheScopeTargetProvider;
  /** Terminal telemetry uses the transport identity, not the capability-provider identity. */
  telemetry_provider: PromptCacheScopeTargetTelemetryProvider;
  model: string;
  /** Deliberately conservative: no model-name family inference is permitted. */
  model_family_id: string;
  model_family_source: "exact_model";
  probe_profile: PromptCacheScopeProbeProfile;
  catalog_model_present: true;
  codex_cache_qualification: "qualified" | "unqualified";
  topology: PromptCacheScopeTargetTopology;
  probeability: PromptCacheScopeTargetProbeability;
  /** Dynamic KV fence; compare immediately before a dispatch. */
  catalog_versionstamp: string | null;
  /** The exact catalog client-version binding forwarded by the Codex probe transport. */
  catalog_client_version: string | null;
  /** Dynamic KV fence for Codex targets; metered does not use the Codex auth pool. */
  codex_auth_pool_versionstamp: string | null;
  /**
   * Opaque, ordered-pool identity. It changes when an account is added,
   * removed, replaced, or reordered, but deliberately survives token refresh.
   */
  codex_auth_pool_identity_fingerprint: string | null;
  /** Stable digest of the target's relevant catalog capability evidence. */
  capability_fingerprint: string;
}>;

export type PromptCacheScopeTargetMeteredRosterDiagnostic = Readonly<{
  status: MeteredFallbackRoster["status"];
  /** Sorted, de-duplicated authoritative IDs; empty when the roster is unknown. */
  model_ids: readonly string[];
  /** Authoritative roster IDs absent from the current canonical Codex catalog. */
  non_catalog_model_ids: readonly string[];
}>;

export type PromptCacheScopeTargetInventory = Readonly<{
  status: "ready" | "unavailable";
  reason: "ready" | "catalog_unavailable" | "catalog_invalid" | "kv_unavailable" | "auth_pool_unavailable";
  /** Always sorted by stable target identity. Empty means fail closed or no eligible roster intersection. */
  targets: readonly PromptCacheScopeTarget[];
  metered_fallback_roster: PromptCacheScopeTargetMeteredRosterDiagnostic;
  /**
   * Stable inventory definition fingerprint. It deliberately excludes mutable
   * KV versionstamps, which are exposed separately for a dispatch-time fence.
   */
  inventory_fingerprint: string | null;
  /** Dynamic fingerprint over the current catalog/auth-pool version bindings. */
  binding_fingerprint: string | null;
}>;

export type DerivePromptCacheScopeTargetInventoryInput = Readonly<{
  snapshot: CodexModelsSnapshot | null | undefined;
  catalogVersionstamp: string | null | undefined;
  codexAuthPool: unknown;
  codexAuthPoolVersionstamp: string | null | undefined;
  meteredFallbackRoster: MeteredFallbackRoster | undefined;
}>;

export type LoadPromptCacheScopeTargetInventoryOptions = Readonly<{
  /** Injection keeps the loader deterministic in focused tests. */
  kv?: Kv | null;
  meteredFallbackRoster?: MeteredFallbackRoster;
}>;

type CatalogModel = Readonly<{
  id: string;
  record: Record<string, unknown> | null;
  ambiguous: boolean;
}>;

type Catalog = Readonly<{ snapshot: CodexModelsSnapshot; models: readonly CatalogModel[] }>;

type CodexAuthPoolBinding = Readonly<{
  configuredSlotCount: 0 | 1 | 2;
  usableTwoSlotBinding: boolean;
  identityFingerprint: string | null;
}>;

const UNKNOWN_METERED_ROSTER: MeteredFallbackRoster = { status: "unknown" };
const FINGERPRINT_VERSION = "prompt-cache-scope-targets-v3";
const AUTH_POOL_IDENTITY_FINGERPRINT_VERSION = "codex-auth-pool-identity-v1";

const normalizedString = (value: unknown): string | null => {
  const normalized = getString(value)?.trim();
  // A whitespace-only value is absent, not an empty authoritative string.
  if (!normalized) return null;
  return normalized;
};

const normalizedVersionstamp = (value: unknown): string | null => normalizedString(value);

const canonicalModelId = (value: Record<string, unknown>): string | null =>
  normalizedString(value.slug) ?? normalizedString(value.id) ?? normalizedString(value.model) ?? normalizedString(value.name);

/**
 * Code-unit ascending string order. This is exactly what an argument-less
 * `Array.prototype.sort()` does for strings, so it keeps every existing
 * ordering (and therefore every existing fingerprint) byte-identical while
 * still giving `sort` an explicit comparator.
 */
const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/** JSON-like canonicalization keeps fingerprints independent of object key insertion order. */
const canonicalJson = (value: unknown, ancestors = new WeakSet<object>()): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
  if (isRecord(value)) {
    if (ancestors.has(value)) return JSON.stringify("[cycle]");
    ancestors.add(value);
    const serialized = Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`)
      .join(",");
    ancestors.delete(value);
    return `{${serialized}}`;
  }
  return JSON.stringify(typeof value);
};

const normalizeMeteredFallbackRoster = (value: MeteredFallbackRoster | undefined): MeteredFallbackRoster => {
  if (value?.status !== "authoritative" || !Array.isArray(value.model_ids)) return UNKNOWN_METERED_ROSTER;
  const modelIds = new Set<string>();
  for (const rawModelId of value.model_ids) {
    const modelId = normalizedString(rawModelId);
    // A malformed purportedly-authoritative input is not authority.
    if (!modelId) return UNKNOWN_METERED_ROSTER;
    modelIds.add(modelId);
  }
  return { status: "authoritative", model_ids: [...modelIds].sort(compareStrings) };
};

const normalizeCatalog = (value: unknown): Catalog | null => {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const updatedAtMs = value.updated_at_ms;
  if (!normalizedString(value.source) || typeof updatedAtMs !== "number" || !Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) return null;

  const recordsById = new Map<string, Record<string, unknown>[]>();
  for (const rawModel of value.models) {
    // The inventory is a complete canonical roster. Silently dropping an
    // unreadable member would turn a partial catalog into paid work for the
    // remaining records, so a single malformed entry makes it unavailable.
    if (!isRecord(rawModel) || Array.isArray(rawModel)) return null;
    const modelId = canonicalModelId(rawModel);
    if (!modelId) return null;
    const existing = recordsById.get(modelId);
    if (existing) existing.push(rawModel);
    else recordsById.set(modelId, [rawModel]);
  }
  if (!recordsById.size) return null;

  const models = [...recordsById.entries()]
    .map(([id, records]): CatalogModel => ({
      id,
      // `records` is dense, so a single entry always has an element at index 0.
      record: records.length === 1 ? records[0] : null,
      ambiguous: records.length !== 1,
    }))
    .sort((left, right) => compareStrings(left.id, right.id));
  return { snapshot: value as CodexModelsSnapshot, models };
};

/** Only a one- or two-account pool is representable; anything else counts as none. */
const configuredSlotCountFrom = (accountCount: number): 0 | 1 | 2 => {
  if (accountCount === 1) return 1;
  if (accountCount === 2) return 2;
  return 0;
};

const inspectCodexAuthPoolBinding = async (value: unknown): Promise<CodexAuthPoolBinding> => {
  const rawAccounts = isRecord(value) && Array.isArray(value.accounts) ? value.accounts : [];
  const configuredSlotCount: 0 | 1 | 2 = configuredSlotCountFrom(rawAccounts.length);
  const parsed = parseCodexAuthPool(value);
  return {
    configuredSlotCount,
    usableTwoSlotBinding: parsed?.accounts.length === 2,
    identityFingerprint: parsed
      ? `sha256:${await sha256Hex(
          canonicalJson({
            v: AUTH_POOL_IDENTITY_FINGERPRINT_VERSION,
            ordered_account_ids: parsed.accounts.map((account) => account.account_id),
          })
        )}`
      : null,
  };
};

export const buildPromptCacheScopeTargetId = (
  provider: PromptCacheScopeTargetProvider,
  telemetryProvider: PromptCacheScopeTargetTelemetryProvider,
  topologyKind: PromptCacheScopeTargetTopologyKind,
  model: string,
  probeProfile: PromptCacheScopeProbeProfile = PROMPT_CACHE_SCOPE_PROBE_PROFILE
): string => `${FINGERPRINT_VERSION}:${provider}:${telemetryProvider}:${topologyKind}:${probeProfile}:${encodeURIComponent(model)}`;

const codexProbeability = (
  qualification: PromptCacheScopeTarget["codex_cache_qualification"],
  catalogVersionstamp: string | null,
  authPool: CodexAuthPoolBinding,
  authPoolVersionstamp: string | null
): PromptCacheScopeTargetProbeability => {
  if (!catalogVersionstamp) return { status: "unprobeable", reason: "catalog_binding_unavailable" };
  if (qualification !== "qualified") return { status: "unprobeable", reason: "codex_cache_unqualified" };
  if (authPool.configuredSlotCount !== 2) return { status: "unprobeable", reason: "two_codex_slots_required" };
  if (!authPool.usableTwoSlotBinding || !authPoolVersionstamp || !authPool.identityFingerprint) {
    return { status: "unprobeable", reason: "codex_auth_pool_binding_unavailable" };
  }
  return { status: "probeable", adapter: "codex_two_slot" };
};

const unavailableInventory = (
  reason: Exclude<PromptCacheScopeTargetInventory["reason"], "ready">,
  roster: MeteredFallbackRoster
): PromptCacheScopeTargetInventory => {
  const normalizedRoster = normalizeMeteredFallbackRoster(roster);
  return {
    status: "unavailable",
    reason,
    targets: [],
    metered_fallback_roster: {
      status: normalizedRoster.status,
      model_ids: normalizedRoster.status === "authoritative" ? normalizedRoster.model_ids : [],
      non_catalog_model_ids: [],
    },
    inventory_fingerprint: null,
    binding_fingerprint: null,
  };
};

const targetCapabilityFingerprint = async (
  target: Readonly<{
    provider: PromptCacheScopeTargetProvider;
    telemetryProvider: PromptCacheScopeTargetTelemetryProvider;
    topologyKind: PromptCacheScopeTargetTopologyKind;
    model: string;
    qualification: PromptCacheScopeTarget["codex_cache_qualification"];
    catalogModel: CatalogModel;
    snapshot: CodexModelsSnapshot;
  }>
): Promise<string> => {
  const codexCapability = target.catalogModel.record
    ? getCodexModelPromptCacheProvider(target.snapshot, target.model, CODEX_CHATGPT_PROMPT_CACHE_PROVIDER)
    : null;
  // Published scope is the experiment's mutable output, not an input
  // capability. Including it would make A's successful publication change the
  // campaign inventory and cause a bodyless follow-up to reselect A rather
  // than continue to B. Only catalog-owned controls may fence dispatch.
  const codexCapabilityInput = codexCapability ? { id: codexCapability.id, controls: codexCapability.controls ?? null } : null;
  const material = canonicalJson({
    version: FINGERPRINT_VERSION,
    provider: target.provider,
    telemetry_provider: target.telemetryProvider,
    topology_kind: target.topologyKind,
    model: target.model,
    probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
    catalog_entry: target.catalogModel.ambiguous ? "ambiguous" : "unique",
    codex_cache_qualification: target.qualification,
    codex_prompt_cache_capability: codexCapabilityInput,
  });
  return `sha256:${await sha256Hex(material)}`;
};

/**
 * Catalog-owned Codex prompt-cache qualification for one canonical catalog
 * model. An ambiguous catalog entry is never qualified, whatever the published
 * capability says.
 */
const codexCacheQualification = (snapshot: CodexModelsSnapshot, model: CatalogModel): PromptCacheScopeTarget["codex_cache_qualification"] =>
  !model.ambiguous && isCodexModelPromptCacheScopeExperimentEligible(snapshot, model.id) ? "qualified" : "unqualified";

/**
 * Pure, read-only target derivation. Identity and capability fingerprints are
 * stable across refreshes; versionstamps stay separate so a future dispatcher
 * can fence every transition without silently retargeting a campaign.
 */
export const derivePromptCacheScopeTargetInventory = async (input: DerivePromptCacheScopeTargetInventoryInput): Promise<PromptCacheScopeTargetInventory> => {
  const roster = normalizeMeteredFallbackRoster(input.meteredFallbackRoster);
  const catalog = normalizeCatalog(input.snapshot);
  if (!catalog) return unavailableInventory(input.snapshot ? "catalog_invalid" : "catalog_unavailable", roster);

  const catalogVersionstamp = normalizedVersionstamp(input.catalogVersionstamp);
  const catalogClientVersion = normalizedString(catalog.snapshot.client_version);
  const authPoolVersionstamp = normalizedVersionstamp(input.codexAuthPoolVersionstamp);
  const authPool = await inspectCodexAuthPoolBinding(input.codexAuthPool);
  const catalogIds = new Set(catalog.models.map((model) => model.id));
  const meteredModelIds = roster.status === "authoritative" ? roster.model_ids.filter((model) => catalogIds.has(model)) : [];
  const nonCatalogMeteredModelIds = roster.status === "authoritative" ? roster.model_ids.filter((model) => !catalogIds.has(model)) : [];

  const targetDrafts: Readonly<{
    provider: PromptCacheScopeTargetProvider;
    telemetryProvider: PromptCacheScopeTargetTelemetryProvider;
    model: CatalogModel;
    qualification: PromptCacheScopeTarget["codex_cache_qualification"];
  }>[] = [];
  for (const model of catalog.models) {
    const qualification = codexCacheQualification(catalog.snapshot, model);
    targetDrafts.push({
      provider: PROMPT_CACHE_SCOPE_TARGET_CODEX_PROVIDER,
      telemetryProvider: PROMPT_CACHE_SCOPE_TARGET_CODEX_TELEMETRY_PROVIDER,
      model,
      qualification,
    });
  }
  for (const modelId of meteredModelIds) {
    const model = catalog.models.find((candidate) => candidate.id === modelId);
    if (!model) continue;
    const qualification = codexCacheQualification(catalog.snapshot, model);
    targetDrafts.push({
      provider: PROMPT_CACHE_SCOPE_TARGET_METERED_PROVIDER,
      telemetryProvider: PROMPT_CACHE_SCOPE_TARGET_METERED_TELEMETRY_PROVIDER,
      model,
      qualification,
    });
  }

  const targets = await Promise.all(
    targetDrafts.map(async (draft): Promise<PromptCacheScopeTarget> => {
      const topologyKind: PromptCacheScopeTargetTopologyKind =
        draft.provider === PROMPT_CACHE_SCOPE_TARGET_CODEX_PROVIDER ? "codex_account_pool" : "single_credential";
      const id = buildPromptCacheScopeTargetId(draft.provider, draft.telemetryProvider, topologyKind, draft.model.id);
      const capabilityFingerprint = await targetCapabilityFingerprint({
        provider: draft.provider,
        telemetryProvider: draft.telemetryProvider,
        topologyKind,
        model: draft.model.id,
        qualification: draft.qualification,
        catalogModel: draft.model,
        snapshot: catalog.snapshot,
      });
      if (draft.provider === PROMPT_CACHE_SCOPE_TARGET_CODEX_PROVIDER) {
        return {
          id,
          provider: draft.provider,
          telemetry_provider: draft.telemetryProvider,
          model: draft.model.id,
          model_family_id: draft.model.id,
          model_family_source: "exact_model",
          probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
          catalog_model_present: true,
          codex_cache_qualification: draft.qualification,
          topology: {
            kind: "codex_account_pool",
            configured_slot_count: authPool.configuredSlotCount,
            auth_pool_versionstamp: authPoolVersionstamp,
          },
          probeability: codexProbeability(draft.qualification, catalogVersionstamp, authPool, authPoolVersionstamp),
          catalog_versionstamp: catalogVersionstamp,
          catalog_client_version: catalogClientVersion,
          codex_auth_pool_versionstamp: authPoolVersionstamp,
          codex_auth_pool_identity_fingerprint: authPool.identityFingerprint,
          capability_fingerprint: capabilityFingerprint,
        };
      }
      return {
        id,
        provider: draft.provider,
        telemetry_provider: draft.telemetryProvider,
        model: draft.model.id,
        model_family_id: draft.model.id,
        model_family_source: "exact_model",
        probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
        catalog_model_present: true,
        codex_cache_qualification: draft.qualification,
        topology: { kind: "single_credential" },
        probeability: { status: "unprobeable", reason: "current_two_slot_adapter_does_not_apply" },
        catalog_versionstamp: catalogVersionstamp,
        catalog_client_version: catalogClientVersion,
        codex_auth_pool_versionstamp: null,
        codex_auth_pool_identity_fingerprint: null,
        capability_fingerprint: capabilityFingerprint,
      };
    })
  );
  targets.sort((left, right) => compareStrings(left.id, right.id));

  const inventoryMaterial = canonicalJson({
    version: FINGERPRINT_VERSION,
    probe_profile: PROMPT_CACHE_SCOPE_PROBE_PROFILE,
    metered_fallback_roster: {
      status: roster.status,
      model_ids: roster.status === "authoritative" ? roster.model_ids : [],
      non_catalog_model_ids: nonCatalogMeteredModelIds,
    },
    targets: targets.map((target) => ({
      id: target.id,
      provider: target.provider,
      telemetry_provider: target.telemetry_provider,
      model: target.model,
      model_family_id: target.model_family_id,
      model_family_source: target.model_family_source,
      probe_profile: target.probe_profile,
      catalog_model_present: target.catalog_model_present,
      codex_cache_qualification: target.codex_cache_qualification,
      topology:
        target.topology.kind === "codex_account_pool"
          ? { kind: target.topology.kind, configured_slot_count: target.topology.configured_slot_count }
          : target.topology,
      capability_fingerprint: target.capability_fingerprint,
    })),
  });
  const bindingMaterial = canonicalJson({
    version: FINGERPRINT_VERSION,
    targets: targets.map((target) => ({
      id: target.id,
      catalog_versionstamp: target.catalog_versionstamp,
      catalog_client_version: target.catalog_client_version,
      codex_auth_pool_versionstamp: target.codex_auth_pool_versionstamp,
      codex_auth_pool_identity_fingerprint: target.codex_auth_pool_identity_fingerprint,
    })),
  });

  return {
    status: "ready",
    reason: "ready",
    targets,
    metered_fallback_roster: {
      status: roster.status,
      model_ids: roster.status === "authoritative" ? roster.model_ids : [],
      non_catalog_model_ids: nonCatalogMeteredModelIds,
    },
    inventory_fingerprint: `sha256:${await sha256Hex(inventoryMaterial)}`,
    binding_fingerprint: `sha256:${await sha256Hex(bindingMaterial)}`,
  };
};

/**
 * The loader is deliberately limited to two strong point reads. In particular,
 * it does not list tenant API-key policy records to invent a metered roster.
 */
export const loadPromptCacheScopeTargetInventory = async (
  options: LoadPromptCacheScopeTargetInventoryOptions = {}
): Promise<PromptCacheScopeTargetInventory> => {
  const roster = options.meteredFallbackRoster ?? UNKNOWN_METERED_ROSTER;
  const kv = options.kv === undefined ? await getKv() : options.kv;
  if (!kv) return unavailableInventory("kv_unavailable", roster);

  let catalogEntry: KvEntryMaybe<CodexModelsSnapshot>;
  let authPoolEntry: KvEntryMaybe<unknown>;
  try {
    [catalogEntry, authPoolEntry] = await Promise.all([
      kv.get<CodexModelsSnapshot>(CODEX_MODELS_KV_KEY, { consistency: "strong" }),
      kv.get(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" }),
    ]);
  } catch {
    return unavailableInventory("auth_pool_unavailable", roster);
  }
  if (!catalogEntry.value) return unavailableInventory("catalog_unavailable", roster);
  return await derivePromptCacheScopeTargetInventory({
    snapshot: catalogEntry.value,
    catalogVersionstamp: catalogEntry.versionstamp,
    codexAuthPool: authPoolEntry.value,
    codexAuthPoolVersionstamp: authPoolEntry.versionstamp,
    meteredFallbackRoster: roster,
  });
};
