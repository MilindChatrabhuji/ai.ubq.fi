import type { Kv } from "#kv";
import { apiKeyHashKey, apiKeyIdKey } from "../api-keys.ts";
import { apiKeyPolicyFromHashRecord } from "../api-key-policy.ts";

import { buildRuntimeConfig, RUNTIME_CONFIG_V2_KEY } from "../runtime-config.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyRequestLogRecord } from "../types.ts";

import { KV_READ_INCIDENT_V2_MIGRATION_KEY, apiKeyHashPolicyMatches } from "./kv-migration-paid-fallback.ts";
import { currentLegacyUsage, inspectStrictApiKeyPairs, migrateBoundedCounterHandoff, migrateKernelQuotaV2, migrationPolicyNow } from "./kv-migration-usage.ts";
import { type LegacyPaidFallbackLedgerCandidate, inspectPendingPaidFallbackLedgers, projectLegacyPaidFallbackV3 } from "./kv-migration-projection.ts";
export {
  classifyKvMigrationKey,
  defaultIncludeLegacyForProfile,
  importKvMigrationLines,
  parseKvMigrationEntryLine,
  safeKvMigrationValueType,
} from "./kv-migration-base.ts";
export type { KvMigrationDecisionAction, KvMigrationProfile } from "./kv-migration-base.ts";
export { KV_READ_INCIDENT_V2_MIGRATION_KEY } from "./kv-migration-paid-fallback.ts";
export { validateKvMigrationTarget } from "./kv-migration-validation.ts";

export type KvReadIncidentV2MigrationResult = Readonly<{
  api_keys: number;
  bounded_counters: number;
  handoff_phase: "no_bounded_keys" | "predeploy_seed" | "postdeploy_reconcile" | "mixed";
  bounded_baselines_created: number;
  bounded_baselines_reconciled: number;
  legacy_usage_delta_applied: number;
  kernel_repo_records: number;
  kernel_org_records: number;
  paid_fallback_records: number;
  runtime_config_written: boolean;
}>;

type MigratedApiKeyPair = Readonly<{ record: ApiKeyRecord; hashRecord: ApiKeyHashRecord }>;

type ApiKeyMigrationProgress = {
  apiKeys: number;
  boundedCounters: number;
  boundedBaselinesCreated: number;
  boundedBaselinesReconciled: number;
  legacyUsageDeltaApplied: number;
};

/** Upgrades one api-key pair to the V3 quota ledger and migrates its counter. */
const migrateApiKeyQuotaV3 = async (
  kv: Kv,
  record: ApiKeyRecord,
  migrationNowMs: number,
  handoffAlreadyInitialized: boolean,
  progress: ApiKeyMigrationProgress
): Promise<MigratedApiKeyPair> => {
  const [idEntry, hashEntry] = await Promise.all([
    kv.get<ApiKeyRecord>(apiKeyIdKey(record.id), { consistency: "strong" }),
    kv.get<ApiKeyHashRecord>(apiKeyHashKey(record.hash), { consistency: "strong" }),
  ]);
  if (!idEntry.value || !hashEntry.value) throw new Error(`API key changed during quota V3 migration: ${record.id}`);
  if (idEntry.value.hash !== record.hash || !apiKeyHashPolicyMatches(idEntry.value, hashEntry.value)) {
    throw new Error(`API key changed during quota V3 migration: ${record.id}`);
  }
  const upgradedRecord: ApiKeyRecord = { ...idEntry.value, usage_quota_version: 3 };
  const upgradedHash: ApiKeyHashRecord = { ...hashEntry.value, usage_quota_version: 3 };
  if (idEntry.value.usage_quota_version !== 3 || hashEntry.value.usage_quota_version !== 3) {
    const upgraded = await kv
      .atomic()
      .check(idEntry)
      .check(hashEntry)
      .set(apiKeyIdKey(record.id), upgradedRecord)
      .set(apiKeyHashKey(record.hash), upgradedHash)
      .commit();
    if (!upgraded.ok) throw new Error(`API key changed during quota V3 migration: ${record.id}`);
  }
  const policy = apiKeyPolicyFromHashRecord(upgradedRecord.hash, upgradedHash, migrationPolicyNow(upgradedRecord, migrationNowMs));
  if (!policy) throw new Error(`API key ${record.id} policy could not be normalized`);
  progress.apiKeys += 1;
  const handoff = await migrateBoundedCounterHandoff(kv, policy, currentLegacyUsage(upgradedRecord, migrationNowMs), migrationNowMs, handoffAlreadyInitialized);
  if (policy.usage_limit_requests !== -1) {
    if (handoff.baseline_created) progress.boundedBaselinesCreated += 1;
    if (handoff.baseline_reconciled) progress.boundedBaselinesReconciled += 1;
    progress.boundedCounters += 1;
  }
  progress.legacyUsageDeltaApplied += handoff.legacy_usage_delta_applied;
  return { record: upgradedRecord, hashRecord: upgradedHash };
};

/** Phase label reported for the bounded-counter handoff of this run. */
const boundedCounterHandoffPhase = (boundedCounters: number, reconciled: number): "no_bounded_keys" | "predeploy_seed" | "postdeploy_reconcile" | "mixed" => {
  if (boundedCounters === 0) return "no_bounded_keys";
  if (reconciled === boundedCounters) return "postdeploy_reconcile";
  if (reconciled === 0) return "predeploy_seed";
  return "mixed";
};

/** Copies every pending legacy ledger row into the dedicated ledger. */
const migratePendingPaidFallbackLedgers = async (kv: Kv, candidates: readonly LegacyPaidFallbackLedgerCandidate[]): Promise<number> => {
  let paidFallbackRecords = 0;
  for (const { value, ledgerKey, existing } of candidates) {
    if (existing.value === null) {
      const commit = await kv.atomic().check(existing).set(ledgerKey, value).commit();
      if (!commit.ok) {
        const concurrent = await kv.get<ApiKeyRequestLogRecord>(ledgerKey);
        if (concurrent.value === null) {
          throw new Error(`Paid fallback ledger changed during migration: ${value.id}`);
        }
      }
    }
    paidFallbackRecords += 1;
  }
  return paidFallbackRecords;
};

export const migrateKvReadIncidentV2 = async (kv: Kv): Promise<KvReadIncidentV2MigrationResult> => {
  const migrationNowMs = Date.now();
  const previousMigration = await kv.get<{
    counter_handoff_version?: unknown;
    api_key_quota_v3_handoff_version?: unknown;
  }>(KV_READ_INCIDENT_V2_MIGRATION_KEY, { consistency: "strong" });
  const handoffAlreadyInitialized = previousMigration.value?.api_key_quota_v3_handoff_version === 1;
  const codexModels = await kv.get<Record<string, unknown>>(["ubq_ai", "codex_models"]);
  if (!codexModels.value) throw new Error("Codex model snapshot is missing");
  const defaultModel = await kv.get<string>(["default", "model"]);
  const defaultReasoning = await kv.get<string>(["default", "reasoning_effort"]);
  const runtimeConfig = buildRuntimeConfig(codexModels.value as never, {
    defaultModel: defaultModel.value,
    defaultReasoningEffort: defaultReasoning.value,
  });

  const apiKeyInventory = await inspectStrictApiKeyPairs(kv);
  if (apiKeyInventory.errors.length) {
    throw new Error(`API key policy validation failed: ${apiKeyInventory.errors.join("; ")}`);
  }
  const paidFallbackInventory = await inspectPendingPaidFallbackLedgers(kv, apiKeyInventory.pairs);
  if (paidFallbackInventory.errors.length) {
    throw new Error(`Paid fallback ledger validation failed: ${paidFallbackInventory.errors.join("; ")}`);
  }

  const progress: ApiKeyMigrationProgress = {
    apiKeys: 0,
    boundedCounters: 0,
    boundedBaselinesCreated: 0,
    boundedBaselinesReconciled: 0,
    legacyUsageDeltaApplied: 0,
  };
  const upgradedApiKeyPairs: MigratedApiKeyPair[] = [];
  for (const { record } of apiKeyInventory.pairs) {
    upgradedApiKeyPairs.push(await migrateApiKeyQuotaV3(kv, record, migrationNowMs, handoffAlreadyInitialized, progress));
  }

  const handoffPhase = boundedCounterHandoffPhase(progress.boundedCounters, progress.boundedBaselinesReconciled);
  const paidFallbackRecords = await migratePendingPaidFallbackLedgers(kv, paidFallbackInventory.candidates);
  const kernelMigration = await migrateKernelQuotaV2(kv, migrationNowMs);
  await projectLegacyPaidFallbackV3(kv, upgradedApiKeyPairs, migrationNowMs);

  await kv
    .atomic()
    .set(RUNTIME_CONFIG_V2_KEY, runtimeConfig)
    .set(KV_READ_INCIDENT_V2_MIGRATION_KEY, {
      version: 2,
      counter_handoff_version: 1,
      api_key_quota_v3_handoff_version: 1,
      completed_at_ms: Date.now(),
      api_keys: progress.apiKeys,
      bounded_counters: progress.boundedCounters,
      handoff_phase: handoffPhase,
      bounded_baselines_created: progress.boundedBaselinesCreated,
      bounded_baselines_reconciled: progress.boundedBaselinesReconciled,
      legacy_usage_delta_applied: progress.legacyUsageDeltaApplied,
      kernel_repo_records: kernelMigration.repo,
      kernel_org_records: kernelMigration.org,
      paid_fallback_records: paidFallbackRecords,
    })
    .commit();
  return {
    api_keys: progress.apiKeys,
    bounded_counters: progress.boundedCounters,
    handoff_phase: handoffPhase,
    bounded_baselines_created: progress.boundedBaselinesCreated,
    bounded_baselines_reconciled: progress.boundedBaselinesReconciled,
    legacy_usage_delta_applied: progress.legacyUsageDeltaApplied,
    kernel_repo_records: kernelMigration.repo,
    kernel_org_records: kernelMigration.org,
    paid_fallback_records: paidFallbackRecords,
    runtime_config_written: true,
  };
};
