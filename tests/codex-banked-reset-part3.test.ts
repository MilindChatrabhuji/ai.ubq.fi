import { test } from "bun:test";
// codex-banked-reset suite part: tests moved out of tests/codex-banked-reset.test.ts.

import assert from "node:assert/strict";
import {
  type CodexResetRedemptionRecord,
  type CodexUsageResetProviderContract,
  FakeCodexUsageResetProvider,
  MemoryKv,
  TestClock,
  attemptCodexBankedReset,
  candidate,
  dependencies,
  parseCodexBankedResetConfig,
  parseCodexResetRedemptionRecord,
  provenContract,
  providerSupportsLiveRedemption,
  providerSupportsResetType,
  unavailableCodexUsageResetProvider,
} from "./helpers/codex-banked-reset-harness.ts";

test("config and durable-record parsers are strict, and an unproven provider contract keeps live mode disabled", async () => {
  const defaults = parseCodexBankedResetConfig(() => undefined);
  assert.deepEqual(
    {
      enabled: defaults.enabled,
      mode: defaults.mode,
      maxPerAccountPerDay: defaults.maxPerAccountPerDay,
      maxPerAccountPerWindow: defaults.maxPerAccountPerWindow,
    },
    { enabled: true, mode: "shadow", maxPerAccountPerDay: 0, maxPerAccountPerWindow: 1 }
  );

  const environment = new Map<string, string>([
    ["CODEX_BANKED_RESET_ENABLED", " true "],
    ["CODEX_BANKED_RESET_MODE", " LIVE "],
    ["CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_DAY", "2"],
    ["CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_WINDOW", "1"],
  ]);
  const parsedConfig = parseCodexBankedResetConfig((key) => environment.get(key));
  assert.equal(parsedConfig.enabled, true);
  assert.equal(parsedConfig.mode, "live");
  assert.equal(parsedConfig.maxPerAccountPerDay, 2);
  assert.equal(parsedConfig.maxPerAccountPerWindow, 1);
  assert.equal("maxGlobalPerDay" in parsedConfig, false, "the retired global cap field is gone");
  assert.equal(parseCodexBankedResetConfig(() => "1").enabled, false);
  assert.equal(parseCodexBankedResetConfig(() => "1.5").maxPerAccountPerDay, 0);
  // The retired global environment variable is no longer read at all.
  const retiredEnvironment = parseCodexBankedResetConfig((key) => (key === "CODEX_BANKED_RESET_MAX_GLOBAL_PER_DAY" ? "0" : undefined));
  assert.equal(retiredEnvironment.maxPerAccountPerDay, 0);

  const submittedAtMs = 1_700_000_000_001;
  const validRecord: CodexResetRedemptionRecord = {
    v: 1,
    account_id_hash: "account-hash",
    credential_version: "credential-v1",
    quota_generation: "generation-v1",
    routing_generation: 1,
    idempotency_key_hash: "idempotency-hash",
    state: "submitted",
    owner_token: "owner",
    fence: 1,
    lease_expires_at_ms: 1_700_000_030_000,
    provider_receipt_id: "receipt",
    created_at_ms: 1_700_000_000_000,
    updated_at_ms: 1_700_000_000_001,
    submitted_at_ms: submittedAtMs,
    verified_at_ms: null,
    last_error_code: null,
  };
  assert.deepEqual(parseCodexResetRedemptionRecord(validRecord), validRecord);
  assert.equal(parseCodexResetRedemptionRecord({ ...validRecord, fence: -1 }), null);
  assert.equal(parseCodexResetRedemptionRecord({ ...validRecord, provider_receipt_id: "" }), null);
  assert.equal(parseCodexResetRedemptionRecord({ ...validRecord, state: "future_state" }), null);

  const semanticInvalidRecords: Readonly<{ name: string; value: Record<string, unknown> }>[] = [
    {
      name: "claimed cannot carry a submission timestamp",
      value: {
        ...validRecord,
        state: "claimed",
        submitted_at_ms: validRecord.created_at_ms,
        provider_receipt_id: null,
      },
    },
    {
      name: "claimed cannot carry a receipt",
      value: { ...validRecord, state: "claimed", submitted_at_ms: null },
    },
    {
      name: "submitted requires its submission timestamp",
      value: { ...validRecord, submitted_at_ms: null },
    },
    {
      name: "unknown requires a stable error code",
      value: { ...validRecord, state: "unknown", last_error_code: null },
    },
    {
      name: "verified requires a verified timestamp",
      value: { ...validRecord, state: "verified" },
    },
    {
      name: "verified cannot predate submission",
      value: { ...validRecord, state: "verified", verified_at_ms: submittedAtMs - 1 },
    },
    {
      name: "rejected requires a stable error code",
      value: { ...validRecord, state: "rejected", submitted_at_ms: null, provider_receipt_id: null },
    },
    {
      name: "timestamps cannot regress",
      value: { ...validRecord, updated_at_ms: validRecord.created_at_ms - 1 },
    },
  ];
  for (const invalid of semanticInvalidRecords) {
    assert.equal(parseCodexResetRedemptionRecord(invalid.value), null, invalid.name);
  }

  const unprovenContract: CodexUsageResetProviderContract = {
    ...provenContract(),
    idempotency: { callerSupplied: false, retentionMs: null },
    lookup: { byIdempotencyKey: false, byProviderReceiptId: false },
    verification: { independentlyVerifiable: false },
    supportedResetTypes: [],
  };
  assert.equal(providerSupportsLiveRedemption(new FakeCodexUsageResetProvider()), true);
  assert.equal(providerSupportsLiveRedemption(unavailableCodexUsageResetProvider), false);
  assert.equal(providerSupportsLiveRedemption(new FakeCodexUsageResetProvider(unprovenContract)), false);
  assert.equal(providerSupportsResetType(new FakeCodexUsageResetProvider(), "codex_rate_limits"), true);

  const malformedContractProvider = new FakeCodexUsageResetProvider();
  (malformedContractProvider as unknown as { contract: unknown }).contract = {
    idempotency: null,
    supportedResetTypes: "not-an-array",
  };
  assert.equal(providerSupportsLiveRedemption(malformedContractProvider), false);
  assert.equal(providerSupportsResetType(malformedContractProvider, "codex_rate_limits"), false);

  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider(unprovenContract);
  const result = await attemptCodexBankedReset(candidate(), dependencies(kv, provider, new TestClock()));
  assert.equal(result.kind, "skipped");
  assert.equal(result.reason, "provider_contract_unproven");
  assert.equal(provider.callCount, 0);
  assert.equal(provider.commitCount, 0);

  const malformedResult = await attemptCodexBankedReset(
    candidate({ requestId: "malformed-provider-contract" }),
    dependencies(new MemoryKv(), malformedContractProvider, new TestClock())
  );
  assert.equal(malformedResult.kind, "skipped");
  assert.equal(malformedResult.reason, "provider_contract_unproven");
  assert.equal(malformedContractProvider.callCount, 0);
});
