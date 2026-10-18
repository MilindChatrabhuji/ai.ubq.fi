import { test } from "bun:test";
import assert from "node:assert/strict";
import * as policy from "../src/authority/native-api-key-policy.ts";
import * as paid from "../src/authority/native-paid-policy.ts";
import * as nativePolicy from "../src/api-key-policy.ts";
import * as nativeAdmin from "../src/admin/api-keys.ts";
import * as nativePaid from "../src/paid-fallback/index.ts";
import { DEFAULT_USAGE_LIMIT_REQUESTS, getDefaultExpiryMs } from "../src/api-keys.ts";
import type { ApiKeyHashRecord, ApiKeyRecord } from "../src/types.ts";

// BEGIN SHARED_PRINCIPAL_VECTORS
const provePolicy = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const policyFixture = (): ApiKeyRecord => ({
  id: "synthetic-key",
  name: "original",
  prefix: "u_synthetic",
  hash: "synthetic-hash",
  created_at_ms: 1_800_000_000_000,
  expires_at_ms: -1,
  revoked_at_ms: null,
  usage_limit_requests: 3,
  usage_requests: 2,
  usage_reset_at_ms: 1_800_000_060_000,
  window_ms: 60_000,
  usage_quota_version: 3,
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  paid_fallback_model_ids: [],
  paid_fallback_quota_per_credit: 0,
  paid_fallback_max_exposure_microcredits: {},
  paid_fallback_pricing_checked_at_ms: null,
});

const parsingVectors = () => {
  const now = 1_800_000_000_000;
  const record = policyFixture();
  const hash = policy.apiKeyHashRecordFor(record);
  const parsed = policy.apiKeyPolicyFromHashRecord(record.hash, hash, now);
  provePolicy(parsed?.policy_version === "v3:60000" && parsed.window_start_ms === now && parsed.usage_limit_requests === 3, "native H identity changed");
  const failures = [
    null,
    {},
    { ...hash, usage_quota_version: 2 },
    { ...hash, paid_fallback_enabled: "false" },
    { ...hash, paid_fallback_spent_microcredits: -1 },
    { ...hash, paid_fallback_reserved_microcredits: 0.5 },
    { ...hash, paid_fallback_reservation_request_id: " " },
    { ...hash, paid_fallback_enabled: true, paid_fallback_limit_microcredits: 0 },
  ];
  provePolicy(
    failures.every((value) => policy.apiKeyPolicyFromHashRecord(record.hash, value as ApiKeyHashRecord, now) === null),
    "malformed H became policy"
  );
  // Revocation/expiry authorization is deliberately outside the projection parser.
  const expired = policy.apiKeyPolicyFromHashRecord(record.hash, { ...hash, expires_at_ms: now - 1 }, now);
  const revoked = policy.apiKeyPolicyFromHashRecord(record.hash, { ...hash, revoked_at_ms: now - 1 }, now);
  provePolicy(expired?.expires_at_ms === now - 1 && revoked !== null, "projection silently changed native authorization ownership");
  const rollover = policy.apiKeyPolicyFromHashRecord(record.hash, hash, now + 60_000);
  provePolicy(rollover?.window_start_ms === now + 60_000 && rollover.usage_reset_at_ms === now + 120_000, "window rollover changed");
  const unlimited = policy.apiKeyPolicyFromHashRecord(
    record.hash,
    { ...hash, usage_limit_requests: -1, paid_fallback_enabled: true, paid_fallback_limit_microcredits: -1 },
    now
  );
  provePolicy(unlimited?.usage_limit_requests === -1 && unlimited.paid_fallback_limit_microcredits === -1, "unlimited sentinel changed");

  const defaults = { expiryMs: now + 444_000, usageLimitRequests: 73 };
  const created = policy.resolveApiKeyCreateFields({}, now, defaults);
  provePolicy(created.ok && created.fields.expiresAtMs === defaults.expiryMs && created.fields.usageLimitRequests === 73, "configured defaults were replaced");
  const zero = policy.resolveApiKeyCreateFields({ expires_at_ms: -1, usage_limit_requests: 0 }, now, defaults);
  provePolicy(zero.ok && zero.fields.usageLimitRequests === 0, "zero changed from real deny limit");
  const precedence = policy.resolveApiKeyCreateFields(
    { expires_at_ms: now, usage_limit_requests: -2, window_ms: null, paid_fallback_enabled: "bad" },
    now,
    defaults
  );
  provePolicy(!precedence.ok && precedence.error.startsWith("expires_at_ms"), "create validation order changed");
  const invalidWindow = policy.resolveApiKeyCreateFields({ window_ms: null }, now, defaults);
  provePolicy(!invalidWindow.ok && invalidWindow.error === "window_ms must be a positive number", "explicit null window became default");
  const paidInvalid = policy.resolveApiKeyUpdatePaidFallback({ paid_fallback_enabled: true }, record);
  provePolicy(!paidInvalid.ok && paidInvalid.error.includes("positive or -1"), "invalid paid enable accepted");
  const paidEnable = policy.resolveApiKeyUpdatePaidFallback({ paid_fallback_enabled: true, paid_fallback_limit_credits: -1 }, record);
  provePolicy(paidEnable.ok && paidEnable.needsInitialization && paidEnable.paidFallback.paidFallbackLimitMicrocredits === -1, "pricing I/O decision changed");
  const paidExisting = policy.resolveApiKeyUpdatePaidFallback({}, { ...record, paid_fallback_enabled: true, paid_fallback_limit_microcredits: -1 });
  provePolicy(paidExisting.ok && !paidExisting.needsInitialization, "existing paid policy reinitialized");
  return { parsed, expired, revoked, rollover, unlimited, created, zero, precedence, invalidWindow, paidInvalid, paidEnable, paidExisting };
};

const mutationVectors = () => {
  const now = 1_800_000_000_000;
  const record = policyFixture();
  const before = JSON.stringify(record);
  const fields: policy.ApiKeyUpdateFields = {
    name: record.name,
    expiresAtMs: -1,
    usageLimitRequests: 0,
    windowMs: 60_000,
    resetUsage: true,
    paidFallbackEnabled: false,
    paidFallbackLimitMicrocredits: 0,
    paidFallbackModelIds: record.paid_fallback_model_ids,
    paidFallbackQuotaPerCredit: 0,
    paidFallbackMaxExposureMicrocredits: record.paid_fallback_max_exposure_microcredits ?? {},
    paidFallbackPricingCheckedAtMs: null,
  };
  const reset = policy.buildApiKeyUpdateRecord(record, fields, now, fields.windowMs);
  provePolicy(
    reset.replaceQuotaWindow && reset.updated.usage_reset_at_ms === now + 60_001 && reset.updated.usage_requests === 0,
    "same-ms reset reused an aggregate"
  );
  provePolicy(reset.updated.paid_fallback_reserved_microcredits === record.paid_fallback_reserved_microcredits, "reset lost pending exposure");
  const changed = policy.apiKeyUpdateChanged(record, reset.updated, -1, 60_000, true);
  const audit = policy.apiKeyUpdateAuditChanges(record, reset.updated, -1, 60_000, true);
  provePolicy(changed && audit.usage_limit_requests === 0 && audit.reset_usage === true && !Object.hasOwn(audit, "hash"), "update audit changed");
  const exposureOnly = { ...record, paid_fallback_max_exposure_microcredits: { model: 4 } };
  provePolicy(!policy.apiKeyUpdateChanged(record, exposureOnly, -1, 60_000, false), "extraction changed original max-exposure-only comparison");
  const first = policy.buildApiKeyRevocationRecord(record, -1, now);
  const again = policy.buildApiKeyRevocationRecord(first, -1, now + 1);
  provePolicy(again.revoked_at_ms === now, "repeat revoke replaced the first timestamp");
  provePolicy(Object.keys(policy.apiKeyRevokeAuditChanges(first, again)).length === 0, "replayed revoke invented audit changes");
  const unrevoke = policy.buildApiKeyUnrevocationRecord(first, -1);
  provePolicy(unrevoke.revoked_at_ms === null && policy.apiKeyUnrevokeDecision(unrevoke, {}) === "blocked", "deletion guard lost priority over active key");
  provePolicy(
    policy.apiKeyUnrevokeDecision(unrevoke, null) === "unchanged" && policy.apiKeyDeleteDecision(unrevoke) === "requires_revocation",
    "active key lifecycle changed"
  );
  provePolicy(policy.apiKeyDeleteDecision(first) === "delete", "revoked key deletion refused");
  const guard = { created_at_ms: now, local_deletion: { owner: null, completed_at_ms: null } };
  provePolicy(policy.retryableLocalDeletionGuard(guard)?.created_at_ms === now, "retry tombstone timestamp changed");
  provePolicy(
    policy.retryableLocalDeletionGuard({ ...guard, local_deletion: { owner: "other", completed_at_ms: null } }) === null,
    "foreign deletion claim became retryable"
  );
  const paidFields = paid.paidFallbackHashFields(record);
  const createPolicy = {
    ...paidFields,
    paid_fallback_model_ids: record.paid_fallback_model_ids,
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: null,
  };
  const created = policy.buildApiKeyCreateRecords(
    { id: record.id, name: record.name, prefix: record.prefix, hash: record.hash },
    { expiresAtMs: -1, usageLimitRequests: 0, windowMs: 60_000, paidFallbackEnabled: false, paidFallbackLimitMicrocredits: 0 },
    createPolicy,
    now
  );
  provePolicy(
    created.record.usage_requests === 0 && !Object.hasOwn(created.hashRecord, "hash") && !Object.hasOwn(created.hashRecord, "paid_fallback_model_ids"),
    "H projection leaked ID-only policy fields"
  );
  provePolicy(paid.hasStrictPaidFallbackPolicy(created.hashRecord) && paid.hasStrictPaidFallbackKeyPolicy(created.record), "source-paid validation changed");
  provePolicy(
    !paid.hasStrictPaidFallbackKeyPolicy({ ...record, paid_fallback_enabled: true, paid_fallback_limit_microcredits: -1 }),
    "unpriced enabled record accepted"
  );
  const shadowPolicy = { ...createPolicy, id: "pricing-extra", usage_limit_requests: 8 };
  const independentHash = policy.buildApiKeyCreateRecords(
    { id: record.id, name: record.name, prefix: record.prefix, hash: record.hash },
    { expiresAtMs: -1, usageLimitRequests: 0, windowMs: 60_000, paidFallbackEnabled: false, paidFallbackLimitMicrocredits: 0 },
    shadowPolicy,
    now
  );
  provePolicy(
    independentHash.record.id === "pricing-extra" && independentHash.hashRecord.id === record.id && independentHash.hashRecord.usage_limit_requests === 0,
    "create H stopped using its independent native identity and quota inputs"
  );
  provePolicy(JSON.stringify(record) === before, "pure mutation altered its source row");
  return { reset, changed, audit, first, again, unrevoke, guard: policy.retryableLocalDeletionGuard(guard), created, independentHash, paidFields };
};

export const runPrincipalPolicyVectors = () => ({ parsing: parsingVectors(), mutation: mutationVectors() });
// END SHARED_PRINCIPAL_VECTORS

test("pure principal policy preserves source validation, defaults, lifecycle and audit decisions", () => {
  const vectors = runPrincipalPolicyVectors();
  assert.equal(vectors.mutation.reset.updated.usage_reset_at_ms, 1_800_000_060_001);
  assert.deepEqual(vectors.mutation.audit, { usage_limit_requests: 0, reset_usage: true });
});

test("native public policy facades consume the same decisions without changing configured defaults", () => {
  const now = 1_800_000_000_000;
  const record = policyFixture();
  const hash = policy.apiKeyHashRecordFor(record);
  for (const value of [undefined, null, -1, 0, 1.9, "invalid", Number.POSITIVE_INFINITY]) {
    assert.equal(nativeAdmin.normalizeApiKeyUsageLimit(value), policy.normalizeApiKeyUsageLimit(value, DEFAULT_USAGE_LIMIT_REQUESTS));
    assert.equal(nativeAdmin.normalizeApiKeyExpiresAtMs(value, now), policy.normalizeApiKeyExpiresAtMs(value, now, getDefaultExpiryMs(now)));
  }
  for (const candidate of [hash, { ...hash, revoked_at_ms: now }, { ...hash, usage_quota_version: 2 }, {}]) {
    assert.deepEqual(
      nativePolicy.apiKeyPolicyFromHashRecord(record.hash, candidate as ApiKeyHashRecord, now),
      policy.apiKeyPolicyFromHashRecord(record.hash, candidate as ApiKeyHashRecord, now)
    );
    assert.equal(nativePaid.hasStrictPaidFallbackPolicy(candidate), paid.hasStrictPaidFallbackPolicy(candidate));
  }
  assert.equal(nativePaid.hasStrictPaidFallbackKeyPolicy(record), paid.hasStrictPaidFallbackKeyPolicy(record));
  assert.deepEqual(nativePaid.paidFallbackHashFields(record), paid.paidFallbackHashFields(record));
  assert.equal(nativePolicy.looksLikeUosApiKey("u_" + "a".repeat(64)), policy.looksLikeUosApiKey("u_" + "a".repeat(64)));
});
