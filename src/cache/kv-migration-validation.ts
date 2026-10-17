import type { Kv, KvEntryMaybe } from "#kv";
// KV migration target validation, split out of src/kv_migration.ts.

import {
  API_KEY_USAGE_V3_REQUEST_PREFIX,
  API_KEY_USAGE_V3_WINDOW_PREFIX,
  type ApiKeyPolicy,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3WindowKey,
  normalizeApiKeyUsageWindowV3,
} from "../api-key-policy.ts";
import { KERNEL_ORG_POLICY_V2_PREFIX, KERNEL_ORG_WINDOW_V2_PREFIX, KERNEL_REPO_POLICY_V2_PREFIX, KERNEL_REPO_WINDOW_V2_PREFIX } from "../kernel/quota-v2.ts";
import { normalizeRuntimeConfig, RUNTIME_CONFIG_V2_KEY } from "../runtime-config.ts";
import type { ApiKeyRecord, ApiKeyUsageWindowV3 } from "../types.ts";
import { CODEX_RESET_USAGE_PREFIX } from "../codex/reset-settings.ts";
import { isRecord } from "../utils.ts";
import type { KvMigrationValidationResult } from "./kv-migration-base.ts";
import { listKvMigrationCount } from "./kv-migration-base.ts";
import {
  API_KEY_USAGE_V2_MIGRATION_BASELINE_PREFIX,
  PAID_FALLBACK_LEDGER_PREFIX,
  inspectPaidFallbackV3,
  paidFallbackLedgerReference,
  pendingPaidFallbackLedgerReferenceFromEntry,
} from "./kv-migration-paid-fallback.ts";
import type { ApiKeyUsageV2MigrationBaseline, StrictApiKeyPair } from "./kv-migration-usage.ts";
import {
  apiKeyUsageV2MigrationBaselineKey,
  countReconciledBoundedCounterBaselines,
  inspectApiKeyUsageV3,
  inspectKernelQuotaV2,
  inspectStrictApiKeyPairs,
  migrationPolicyNow,
  normalizeApiKeyUsageV2MigrationBaseline,
} from "./kv-migration-usage.ts";

type KvMigrationTargetCounts = Readonly<{
  apiIds: number;
  apiHashes: number;
  boundedCounters: number;
  boundedCounterBaselines: number;
  reconciledBoundedCounterBaselines: number;
  paidFallbackLedger: number;
  kernelLimits: number;
  kernelOrgLimits: number;
  apiKeyUsageV3Windows: number;
  apiKeyUsageV3Requests: number;
  kernelV2RepoPolicies: number;
  kernelV2OrgPolicies: number;
  kernelV2RepoWindows: number;
  kernelV2OrgWindows: number;
  passkeyUsers: number;
  passkeyCredentials: number;
  agentMessages: number;
  embeddingCache: number;
  legacyModelKeyConfigs: number;
  legacyModelKeyHealth: number;
  codexResetUsage: number;
}>;

/** Counts every durable row group the migration validation reports on. */
const countKvMigrationTargetRows = async (kv: Kv): Promise<KvMigrationTargetCounts> => {
  const [
    apiIds,
    apiHashes,
    boundedCounters,
    boundedCounterBaselines,
    reconciledBoundedCounterBaselines,
    paidFallbackLedger,
    kernelLimits,
    kernelOrgLimits,
    apiKeyUsageV3Windows,
    apiKeyUsageV3Requests,
    kernelV2RepoPolicies,
    kernelV2OrgPolicies,
    kernelV2RepoWindows,
    kernelV2OrgWindows,
    passkeyUsers,
    passkeyCredentials,
    agentMessages,
    embeddingCache,
    legacyModelKeyConfigs,
    legacyModelKeyHealth,
    codexResetUsage,
  ] = await Promise.all([
    listKvMigrationCount(kv, ["ubq_ai", "api_keys", "id"]),
    listKvMigrationCount(kv, ["ubq_ai", "api_keys", "hash"]),
    listKvMigrationCount(kv, ["uos_ai", "api_key_usage", "v2"]),
    listKvMigrationCount(kv, API_KEY_USAGE_V2_MIGRATION_BASELINE_PREFIX),
    countReconciledBoundedCounterBaselines(kv),
    listKvMigrationCount(kv, ["uos_ai", "paid_fallback", "ledger"]),
    listKvMigrationCount(kv, ["ubq_ai", "kernel_auth", "limits"]),
    listKvMigrationCount(kv, ["ubq_ai", "kernel_auth", "org_limits"]),
    listKvMigrationCount(kv, API_KEY_USAGE_V3_WINDOW_PREFIX),
    listKvMigrationCount(kv, API_KEY_USAGE_V3_REQUEST_PREFIX),
    listKvMigrationCount(kv, KERNEL_REPO_POLICY_V2_PREFIX),
    listKvMigrationCount(kv, KERNEL_ORG_POLICY_V2_PREFIX),
    listKvMigrationCount(kv, KERNEL_REPO_WINDOW_V2_PREFIX),
    listKvMigrationCount(kv, KERNEL_ORG_WINDOW_V2_PREFIX),
    listKvMigrationCount(kv, ["uos_ai", "auth", "users"]),
    listKvMigrationCount(kv, ["uos_ai", "auth", "credentials"]),
    listKvMigrationCount(kv, ["agent_messages"]),
    listKvMigrationCount(kv, ["embeddings", "v2"], 10_000),
    listKvMigrationCount(kv, ["key", "config"]),
    listKvMigrationCount(kv, ["key", "health"]),
    listKvMigrationCount(kv, CODEX_RESET_USAGE_PREFIX),
  ]);
  return {
    apiIds,
    apiHashes,
    boundedCounters,
    boundedCounterBaselines,
    reconciledBoundedCounterBaselines,
    paidFallbackLedger,
    kernelLimits,
    kernelOrgLimits,
    apiKeyUsageV3Windows,
    apiKeyUsageV3Requests,
    kernelV2RepoPolicies,
    kernelV2OrgPolicies,
    kernelV2RepoWindows,
    kernelV2OrgWindows,
    passkeyUsers,
    passkeyCredentials,
    agentMessages,
    embeddingCache,
    legacyModelKeyConfigs,
    legacyModelKeyHealth,
    codexResetUsage,
  };
};

/** True when the reservation has a matching row in the dedicated ledger. */
const hasPendingPaidFallbackLedger = async (kv: Kv, keyId: string, requestId: string): Promise<boolean> => {
  const expected = paidFallbackLedgerReference(keyId, requestId);
  for await (const ledger of kv.list({ prefix: [...PAID_FALLBACK_LEDGER_PREFIX, keyId] })) {
    const reference = pendingPaidFallbackLedgerReferenceFromEntry(ledger, PAID_FALLBACK_LEDGER_PREFIX);
    if (reference === expected) return true;
  }
  return false;
};

/** Reports a bounded key whose V3 aggregate or migration baseline is invalid. */
const auditApiKeyBoundedAggregates = async (kv: Kv, policy: ApiKeyPolicy, record: ApiKeyRecord, errors: string[]): Promise<void> => {
  const v3Window = normalizeApiKeyUsageWindowV3((await kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(policy))).value);
  if (
    v3Window?.key_id !== policy.key_id ||
    v3Window.policy_version !== policy.policy_version ||
    v3Window.window_start_ms !== policy.window_start_ms ||
    v3Window.window_reset_at_ms !== policy.usage_reset_at_ms
  ) {
    errors.push(`bounded V3 aggregate is missing or invalid: ${record.id}`);
  }
  const baseline = normalizeApiKeyUsageV2MigrationBaseline((await kv.get<ApiKeyUsageV2MigrationBaseline>(apiKeyUsageV2MigrationBaselineKey(policy))).value);
  if (baseline?.key_id !== policy.key_id || baseline.policy_version !== policy.policy_version || baseline.window_start_ms !== policy.window_start_ms) {
    errors.push(`bounded counter migration baseline is missing, stale, or invalid: ${record.id}`);
  }
};

/** Reports why one api-key pair is not fully migrated. */
const auditApiKeyPolicy = async (kv: Kv, pair: StrictApiKeyPair, validationNowMs: number, errors: string[]): Promise<void> => {
  const { record, hashRecord } = pair;
  const reservedRequestId = record.paid_fallback_reservation_request_id;
  if (reservedRequestId !== null) {
    if (!(await hasPendingPaidFallbackLedger(kv, record.id, reservedRequestId))) {
      errors.push(`paid fallback reservation has no pending ledger record: ${record.id}`);
    }
  }
  if (record.usage_quota_version !== 3 || hashRecord.usage_quota_version !== 3) {
    errors.push(`api key quota ledger version is not V3: ${record.id}`);
    return;
  }
  const policy = apiKeyPolicyFromHashRecord(record.hash, hashRecord, migrationPolicyNow(record, validationNowMs));
  if (!policy) {
    errors.push(`api key policy could not be normalized: ${record.id}`);
    return;
  }
  if (record.usage_limit_requests !== -1) await auditApiKeyBoundedAggregates(kv, policy, record, errors);
};

/** Reports a default model that the uploaded Codex snapshot cannot serve. */
const auditCodexModelSnapshot = async (kv: Kv, errors: string[]): Promise<void> => {
  const codexModels = await kv.get<Record<string, unknown>>(["ubq_ai", "codex_models"]);
  const defaultModel = await kv.get<string>(["default", "model"]);
  const modelList = Array.isArray(codexModels.value?.models) ? codexModels.value.models : [];
  if (defaultModel.value && codexModels.value !== null && modelList.length === 0) {
    errors.push(`codex model snapshot is empty or malformed; cannot validate default model: ${defaultModel.value}`);
  }
  if (defaultModel.value && modelList.length) {
    const found = modelList.some((model) => {
      if (!model || typeof model !== "object") return false;
      const record = model as Record<string, unknown>;
      return [record.slug, record.id, record.model, record.name].includes(defaultModel.value);
    });
    if (!found) errors.push(`default model is not present in codex model snapshot: ${defaultModel.value}`);
  }
};

/** Reports reset usage rows whose key or explicit boolean setting is malformed. */
const auditCodexResetUsage = async (kv: Kv, errors: string[]): Promise<void> => {
  for await (const entry of kv.list({ prefix: CODEX_RESET_USAGE_PREFIX })) {
    const key = entry.key;
    const accountHash = key[4];
    const validKey =
      key.length === 5 &&
      key[0] === CODEX_RESET_USAGE_PREFIX[0] &&
      key[1] === CODEX_RESET_USAGE_PREFIX[1] &&
      key[2] === "account" &&
      key[3] === "v1" &&
      typeof accountHash === "string" &&
      accountHash.length > 0;
    if (!validKey) {
      errors.push(`codex reset usage key is malformed: ${JSON.stringify(key)}`);
      continue;
    }
    if (!isRecord(entry.value) || typeof entry.value.enabled !== "boolean") {
      errors.push(`codex reset usage record is malformed: ${JSON.stringify(key)}`);
    }
  }
};

/** Reads every settings key the validation reports presence for. */
const readKvMigrationSettings = async (kv: Kv): Promise<KvEntryMaybe<unknown>[]> => {
  return await Promise.all([
    kv.get(["ubq_ai", "codex_auth"]),
    kv.get(["ubq_ai", "codex_models"]),
    kv.get(["default", "model"]),
    kv.get(["default", "reasoning_effort"]),
    kv.get(["default", "kernel_policy_limit_requests"]),
    kv.get(["default", "kernel_policy_window_ms"]),
    kv.get(["uos_ai", "voyage_api_key"]),
    kv.get(["uos_ai", "kernel_pubkeys"]),
    kv.get(RUNTIME_CONFIG_V2_KEY),
  ]);
};

export const validateKvMigrationTarget = async (kv: Kv): Promise<KvMigrationValidationResult> => {
  const errors: string[] = [];
  const counts = await countKvMigrationTargetRows(kv);

  if (counts.apiIds !== counts.apiHashes) {
    errors.push(`api key id/hash count mismatch: ids=${counts.apiIds} hashes=${counts.apiHashes}`);
  }

  const apiKeyInventory = await inspectStrictApiKeyPairs(kv);
  errors.push(...apiKeyInventory.errors);
  const apiKeyUsageV3 = await inspectApiKeyUsageV3(kv, new Set(apiKeyInventory.pairs.map(({ record }) => record.id)));
  errors.push(...apiKeyUsageV3.errors);
  const kernelQuotaV2 = await inspectKernelQuotaV2(kv);
  errors.push(...kernelQuotaV2.errors);
  if (counts.kernelLimits > 0 || counts.kernelOrgLimits > 0) {
    errors.push(`legacy combined kernel quota records remain: repo=${counts.kernelLimits} org=${counts.kernelOrgLimits}`);
  }
  const paidFallbackV3 = await inspectPaidFallbackV3(
    kv,
    new Set(apiKeyInventory.pairs.map(({ record }) => record.id)),
    new Set(apiKeyInventory.pairs.filter(({ record }) => record.paid_fallback_limit_microcredits === -1).map(({ record }) => record.id))
  );
  errors.push(...paidFallbackV3.errors);
  const validationNowMs = Date.now();
  for (const pair of apiKeyInventory.pairs) {
    await auditApiKeyPolicy(kv, pair, validationNowMs, errors);
  }
  await auditCodexModelSnapshot(kv, errors);
  await auditCodexResetUsage(kv, errors);

  const knownSettings = await readKvMigrationSettings(kv);
  if (normalizeRuntimeConfig(knownSettings[8].value) === null) {
    errors.push("runtime config v2 is missing or invalid");
  }

  return {
    counts: {
      api_key_ids: counts.apiIds,
      api_key_hashes: counts.apiHashes,
      api_key_bounded_counters_v2: counts.boundedCounters,
      api_key_bounded_counter_baselines_v2: counts.boundedCounterBaselines,
      api_key_bounded_counter_reconciled_baselines_v2: counts.reconciledBoundedCounterBaselines,
      api_key_usage_v3_windows: counts.apiKeyUsageV3Windows,
      api_key_usage_v3_requests: counts.apiKeyUsageV3Requests,
      paid_fallback_ledger: counts.paidFallbackLedger,
      paid_fallback_v3_windows: paidFallbackV3.windows,
      paid_fallback_v3_requests: paidFallbackV3.requests,
      paid_fallback_v3_pending: paidFallbackV3.pending,
      paid_fallback_v3_reconciliation_leases: paidFallbackV3.reconciliationLeases,
      paid_fallback_v3_deletion_guards: paidFallbackV3.deletionGuards,
      kernel_repo_limits: counts.kernelLimits,
      kernel_org_limits: counts.kernelOrgLimits,
      kernel_v2_repo_policies: counts.kernelV2RepoPolicies,
      kernel_v2_org_policies: counts.kernelV2OrgPolicies,
      kernel_v2_repo_windows: counts.kernelV2RepoWindows,
      kernel_v2_org_windows: counts.kernelV2OrgWindows,
      kernel_v2_repo_reservations: kernelQuotaV2.repoReservations,
      kernel_v2_org_reservations: kernelQuotaV2.orgReservations,
      passkey_users: counts.passkeyUsers,
      passkey_credentials: counts.passkeyCredentials,
      agent_messages: counts.agentMessages,
      embeddings_v2_at_most_10000: counts.embeddingCache,
      legacy_model_key_configs: counts.legacyModelKeyConfigs,
      legacy_model_key_health: counts.legacyModelKeyHealth,
      codex_reset_usage: counts.codexResetUsage,
    },
    settings_present: {
      codex_auth: knownSettings[0].value !== null,
      codex_models: knownSettings[1].value !== null,
      default_model: knownSettings[2].value !== null,
      default_reasoning_effort: knownSettings[3].value !== null,
      default_kernel_policy_limit_requests: knownSettings[4].value !== null,
      default_kernel_policy_window_ms: knownSettings[5].value !== null,
      voyage_api_key: knownSettings[6].value !== null,
      kernel_pubkeys: knownSettings[7].value !== null,
      runtime_config_v2: normalizeRuntimeConfig(knownSettings[8].value) !== null,
    },
    errors,
  };
};
