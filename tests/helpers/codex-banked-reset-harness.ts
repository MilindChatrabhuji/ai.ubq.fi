import type { AtomicOperation, Kv, KvCommitError, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
// Shared harness for this suite, moved out of the original test file.

import assert from "node:assert/strict";
import {
  CODEX_BANKED_RESET_LEASE_MS,
  type CodexBankedResetCandidate,
  type CodexBankedResetConfig,
  type CodexBankedResetDependencies,
  type CodexBankedResetFence,
  type CodexBankedResetTelemetry,
  parseCodexResetShadowDecisionRecord,
} from "../../src/codex/banked-reset.ts";
import { attemptCodexBankedReset, reconcileCodexBankedReset } from "../../src/codex/banked-reset-submission.ts";
import {
  type CodexUsageResetProvider,
  type CodexUsageResetProviderContract,
  type LookupRedeemResetInput,
  type RedeemResetInput,
  type RedeemResetResult,
  type ResetAccountContext,
  type ResetInventory,
} from "../../src/codex/banked-reset-provider.ts";
import type { CodexResetRedemptionRecord } from "../../src/types.ts";

const clone = <T>(value: T): T => structuredClone(value);
const encodeKey = (key: KvKey): string => JSON.stringify(key);

type StoredEntry = Readonly<{
  key: KvKey;
  value: unknown;
  versionstamp: string;
}>;

/** A small KV fake with versionstamps and deliberately injectable CAS failures. */
class MemoryKv {
  readonly entries = new Map<string, StoredEntry>();
  readonly failCommitNumbers = new Set<number>();
  readonly atomicCheckBatches: KvKey[][] = [];
  atomicCommitCount = 0;
  beforeAtomicCommit: ((commitNumber: number) => void) | null = null;
  beforeGet: ((key: KvKey, getNumber: number) => Promise<void> | null | undefined) | null = null;
  getFailure: Error | null = null;
  getCount = 0;
  #version = 0;

  #nextVersionstamp(): string {
    this.#version += 1;
    return String(this.#version).padStart(20, "0");
  }

  #put(key: KvKey, value: unknown, versionstamp: string): void {
    this.entries.set(encodeKey(key), {
      key: clone(key),
      value: clone(value),
      versionstamp,
    });
  }

  versionstamp(key: KvKey): string | null {
    return this.entries.get(encodeKey(key))?.versionstamp ?? null;
  }

  async get<T>(key: KvKey, _options?: unknown): Promise<KvEntryMaybe<T>> {
    if (this.getFailure) throw this.getFailure;
    const pause = this.beforeGet?.(clone(key), ++this.getCount);
    if (pause) await pause;
    const entry = this.entries.get(encodeKey(key));
    return {
      key: clone(key),
      value: entry ? (clone(entry.value) as T) : null,
      versionstamp: entry?.versionstamp ?? null,
    } as KvEntryMaybe<T>;
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    const versionstamp = this.#nextVersionstamp();
    this.#put(key, value, versionstamp);
    return Promise.resolve({ ok: true, versionstamp });
  }

  redemptionRecord(key: KvKey): CodexResetRedemptionRecord | null {
    const value = this.entries.get(encodeKey(key))?.value;
    return value === undefined ? null : (clone(value) as CodexResetRedemptionRecord);
  }

  atomic(): AtomicOperation {
    const checks: Readonly<{ key: KvKey; versionstamp: string | null }>[] = [];
    const writes: Readonly<{ key: KvKey; value: unknown }>[] = [];
    const operation = {
      check: (entry: Readonly<{ key: KvKey; versionstamp: string | null }>) => {
        checks.push({ key: clone(entry.key), versionstamp: entry.versionstamp });
        return operation;
      },
      set: (key: KvKey, value: unknown) => {
        writes.push({ key: clone(key), value: clone(value) });
        return operation;
      },
      commit: (): Promise<KvCommitResult | KvCommitError> => {
        this.atomicCommitCount += 1;
        this.atomicCheckBatches.push(checks.map((check) => clone(check.key)));
        this.beforeAtomicCommit?.(this.atomicCommitCount);
        if (this.failCommitNumbers.has(this.atomicCommitCount)) return Promise.resolve({ ok: false });
        if (checks.some((check) => this.versionstamp(check.key) !== check.versionstamp)) {
          return Promise.resolve({ ok: false });
        }

        const versionstamp = this.#nextVersionstamp();
        for (const write of writes) this.#put(write.key, write.value, versionstamp);
        return Promise.resolve({ ok: true, versionstamp });
      },
    };
    return operation as unknown as AtomicOperation;
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(value: T): void {
    this.#resolve(value);
  }
}

const provenContract = (): CodexUsageResetProviderContract => ({
  idempotency: { callerSupplied: true, retentionMs: 86_400_000 },
  lookup: { byIdempotencyKey: true, byProviderReceiptId: true },
  verification: { independentlyVerifiable: true },
  receiptIdsSafeToPersistAndLog: true,
  supportedResetTypes: ["codex_rate_limits"],
});

type FakeProviderCall = Readonly<{
  method: "readInventory" | "redeem" | "lookup" | "verifyApplied";
  accountId: string;
  quotaGeneration: string;
  idempotencyKey: string | null;
  commitCount: number;
  providerReceiptId: string | null;
  timeoutStage: "before_provider_commit" | "after_provider_commit" | null;
}>;

/**
 * Sanitized boundary fixtures, not inferred provider wire payloads. There is
 * no approved live adapter yet, so these cover every result shape accepted by
 * the injectable provider contract while keeping tests completely offline.
 */
const sanitizedProviderFixtures = Object.freeze({
  inventory_available: Object.freeze({
    availableCount: 1,
    observedAtMs: 1_700_000_000_000,
    credits: [{ id: "fixture-credit", status: "available", resetType: "codex_rate_limits", expiresAtMs: null }],
  }),
  inventory_empty: Object.freeze({
    availableCount: 0,
    observedAtMs: 1_700_000_000_000,
    credits: [],
  }),
  redemption_completed: Object.freeze({ kind: "completed", providerReceiptId: "fixture-completed" } as const),
  redemption_accepted: Object.freeze({ kind: "accepted", providerReceiptId: "fixture-accepted" } as const),
  redemption_already_redeemed: Object.freeze({ kind: "already_redeemed", providerReceiptId: "fixture-replay" } as const),
  redemption_rejected: Object.freeze({ kind: "rejected", reason: "fixture-definitive-rejection" } as const),
  authentication_error: Object.freeze({ kind: "rejected", reason: "fixture-authentication-error" } as const),
  rate_limit: Object.freeze({ kind: "unknown", providerReceiptId: null } as const),
  server_error: Object.freeze({ kind: "unknown", providerReceiptId: null } as const),
  malformed_success: Object.freeze({ kind: "completed" }),
  schema_drift: Object.freeze({ kind: "future_completed", providerReceiptId: "fixture-unknown" }),
  lookup_pending: Object.freeze({ kind: "unknown", providerReceiptId: null } as const),
  lookup_completed: Object.freeze({ kind: "completed", providerReceiptId: "fixture-lookup-completed" } as const),
  lookup_rejected: Object.freeze({ kind: "rejected", reason: "fixture-lookup-rejected" } as const),
  lookup_not_found: Object.freeze({ kind: "rejected", reason: "fixture-lookup-not-found" } as const),
});

class FakeCodexUsageResetProvider implements CodexUsageResetProvider {
  readonly contract: CodexUsageResetProviderContract;
  readonly calls: FakeProviderCall[] = [];
  readonly inventoryInputs: ResetAccountContext[] = [];
  readonly redeemInputs: RedeemResetInput[] = [];
  readonly lookupInputs: LookupRedeemResetInput[] = [];
  readonly verificationInputs: ResetAccountContext[] = [];
  inventory: ResetInventory = {
    availableCount: 1,
    observedAtMs: 1_700_000_000_000,
    credits: [{ id: "test-credit", status: "available", resetType: "codex_rate_limits", expiresAtMs: null }],
  };
  redeemResult: RedeemResetResult = { kind: "completed", providerReceiptId: "receipt-completed" };
  lookupResult: RedeemResetResult = { kind: "completed", providerReceiptId: "receipt-lookup" };
  verifyResult: unknown = true;
  inventoryFailure: Error | null = null;
  redeemFailure: Error | null = null;
  /** Simulates a response loss after the provider has already committed. */
  redeemFailureAfterCommit: Error | null = null;
  lookupFailure: Error | null = null;
  verifyFailure: Error | null = null;
  inventoryGate: Promise<void> | null = null;
  inventoryEntered: Deferred<void> | null = null;
  redeemGate: Promise<void> | null = null;
  redeemEntered: Deferred<void> | null = null;
  verifyGate: Promise<void> | null = null;
  verifyEntered: Deferred<void> | null = null;
  commitOnRedeem: boolean | null = null;
  commitCount = 0;

  constructor(contract: CodexUsageResetProviderContract = provenContract()) {
    this.contract = contract;
  }

  get callCount(): number {
    return this.inventoryInputs.length + this.redeemInputs.length + this.lookupInputs.length + this.verificationInputs.length;
  }

  #record(
    method: FakeProviderCall["method"],
    input: ResetAccountContext | RedeemResetInput | LookupRedeemResetInput,
    providerReceiptId: string | null = null,
    timeoutStage: FakeProviderCall["timeoutStage"] = null
  ): void {
    const withKey = input as Partial<RedeemResetInput>;
    this.calls.push({
      method,
      accountId: input.accountId,
      quotaGeneration: input.quotaGeneration,
      idempotencyKey: typeof withKey.idempotencyKey === "string" ? withKey.idempotencyKey : null,
      commitCount: this.commitCount,
      providerReceiptId,
      timeoutStage,
    });
  }

  async readInventory(input: ResetAccountContext, _signal: AbortSignal): Promise<ResetInventory> {
    this.inventoryInputs.push(clone(input));
    this.#record("readInventory", input);
    this.inventoryEntered?.resolve(undefined);
    const gate = this.inventoryGate;
    this.inventoryGate = null;
    if (gate) await gate;
    if (this.inventoryFailure) throw this.inventoryFailure;
    return clone(this.inventory);
  }

  async redeem(input: RedeemResetInput, _signal: AbortSignal): Promise<RedeemResetResult> {
    this.redeemInputs.push(clone(input));
    this.redeemEntered?.resolve(undefined);
    if (this.redeemGate) await this.redeemGate;
    if (this.redeemFailure) {
      this.#record("redeem", input, null, "before_provider_commit");
      throw this.redeemFailure;
    }
    const result = clone(this.redeemResult);
    if (this.commitOnRedeem ?? (result.kind === "completed" || result.kind === "accepted")) this.commitCount += 1;
    const receipt = "providerReceiptId" in result && typeof result.providerReceiptId === "string" ? result.providerReceiptId : null;
    if (this.redeemFailureAfterCommit) {
      this.#record("redeem", input, receipt, "after_provider_commit");
      throw this.redeemFailureAfterCommit;
    }
    this.#record("redeem", input, receipt);
    return result;
  }

  lookup(input: LookupRedeemResetInput, _signal: AbortSignal): Promise<RedeemResetResult> {
    this.lookupInputs.push(clone(input));
    const receipt =
      "providerReceiptId" in this.lookupResult && typeof this.lookupResult.providerReceiptId === "string" ? this.lookupResult.providerReceiptId : null;
    this.#record("lookup", input, receipt);
    if (this.lookupFailure) return Promise.reject(this.lookupFailure);
    return Promise.resolve(clone(this.lookupResult));
  }

  async verifyApplied(input: ResetAccountContext, _signal: AbortSignal): Promise<boolean> {
    this.verificationInputs.push(clone(input));
    this.verifyEntered?.resolve(undefined);
    const gate = this.verifyGate;
    this.verifyGate = null;
    if (gate) await gate;
    this.#record("verifyApplied", input);
    if (this.verifyFailure) return Promise.reject(this.verifyFailure);
    return this.verifyResult as boolean;
  }
}

class TestClock {
  nowMs: number;

  constructor(nowMs = 1_700_000_000_000) {
    this.nowMs = nowMs;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

const testHash = (value: string): Promise<string> => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return Promise.resolve(`test-hash-${(hash >>> 0).toString(16)}-${value.length}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const routingFenceKey = (accountId: string): KvKey => ["test", "codex-banked-reset", "routing", accountId];
const credentialFenceKey = (accountId: string): KvKey => ["test", "codex-banked-reset", "credential", accountId];

const bankedResetFences = (accountId: string, routingGeneration: number, credentialVersion: string): readonly CodexBankedResetFence[] => [
  {
    key: routingFenceKey(accountId),
    isCurrent: (value) => isRecord(value) && value.kind === "routing" && value.routing_generation === routingGeneration,
  },
  {
    key: credentialFenceKey(accountId),
    isCurrent: (value) => isRecord(value) && value.kind === "credential" && value.credential_version === credentialVersion,
  },
];

const candidate = (overrides: Partial<CodexBankedResetCandidate> = {}): CodexBankedResetCandidate => {
  const accountId = overrides.accountId ?? "test-account-a";
  const credentialVersion = overrides.credentialVersion ?? "test-credential-v1";
  const quotaResetAtMs = overrides.quotaResetAtMs ?? 1_700_000_060_000;
  const routingGeneration = overrides.routingGeneration ?? 7;
  return {
    accountId,
    credentialVersion,
    quotaResetAtMs,
    routingGeneration,
    fences: overrides.fences ?? bankedResetFences(accountId, routingGeneration, credentialVersion),
    requestId: overrides.requestId ?? "test-request",
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
};

const seedFences = async (kv: MemoryKv, input: CodexBankedResetCandidate): Promise<void> => {
  await kv.set(routingFenceKey(input.accountId), {
    kind: "routing",
    routing_generation: input.routingGeneration,
  });
  await kv.set(credentialFenceKey(input.accountId), {
    kind: "credential",
    credential_version: input.credentialVersion,
  });
};

const hasKey = (keys: readonly KvKey[], expected: KvKey): boolean => keys.some((key) => encodeKey(key) === encodeKey(expected));

const config = (overrides: Partial<CodexBankedResetConfig> = {}): CodexBankedResetConfig => ({
  enabled: true,
  mode: "live",
  maxPerAccountPerDay: 1,
  maxPerAccountPerWindow: 1,
  ...overrides,
});

const dependencies = (
  kv: MemoryKv,
  provider: CodexUsageResetProvider,
  clock: TestClock,
  configured = config(),
  telemetry: CodexBankedResetTelemetry = {},
  reloadConfig?: () => CodexBankedResetConfig
): CodexBankedResetDependencies => {
  let owner = 0;
  return {
    config: configured,
    provider,
    kv: kv as unknown as Kv,
    now: () => clock.nowMs,
    newOwnerToken: () => `test-owner-${++owner}`,
    hash: testHash,
    telemetry,
    ...(reloadConfig ? { reloadConfig } : {}),
  };
};

const fullPool = (
  first: CodexBankedResetCandidate,
  firstProvider: CodexUsageResetProvider,
  second: CodexBankedResetCandidate,
  secondProvider: CodexUsageResetProvider
) =>
  [
    { slot: 0, candidate: first, provider: firstProvider },
    { slot: 1, candidate: second, provider: secondProvider },
  ] as const;

const inventory = (id: string, expiresAtMs: number | null): ResetInventory => ({
  availableCount: 1,
  observedAtMs: 1_700_000_000_000,
  credits: [{ id, status: "available", resetType: "codex_rate_limits", expiresAtMs }],
});

/** The account hash of a reset result the test has already asserted is present. */
const requiredHash = (value: string | null): string => {
  assert.ok(value, "expected the reset result to carry an account hash");
  return value;
};

const shadowDecisionFrom = (kv: MemoryKv) => {
  const decisions = [...kv.entries.values()]
    .map((entry) => parseCodexResetShadowDecisionRecord(entry.value))
    .filter((decision): decision is NonNullable<typeof decision> => decision !== null);
  assert.equal(decisions.length, 1);
  const decision = decisions.at(0);
  assert.ok(decision, "expected exactly one shadow decision");
  return decision;
};

// Helpers that lived between tests in the original file.

type BankedResetGeneratedEvent =
  | "request"
  | "qualifying_429"
  | "non_qualifying_429"
  | "claim"
  | "submit"
  | "provider_commit"
  | "response_loss"
  | "lookup"
  | "verify"
  | "retry"
  | "crash"
  | "lease_expire"
  | "credential_rotate"
  | "kv_failure";

const BANKED_RESET_GENERATED_EVENTS: readonly BankedResetGeneratedEvent[] = [
  "request",
  "qualifying_429",
  "non_qualifying_429",
  "claim",
  "submit",
  "provider_commit",
  "response_loss",
  "lookup",
  "verify",
  "retry",
  "crash",
  "lease_expire",
  "credential_rotate",
  "kv_failure",
];

type GeneratedResetScenario = {
  reset: CodexBankedResetCandidate;
  deps: CodexBankedResetDependencies;
  provider: FakeCodexUsageResetProvider;
  kv: MemoryKv;
  clock: TestClock;
  sequenceSeed: number;
  qualifyingObservationIsCurrent: boolean;
  lastOutcome: Awaited<ReturnType<typeof attemptCodexBankedReset>> | null;
  postResetInferenceRetries: number;
  credentialWasRotated: boolean;
};

const applyBankedResetEvent = async (scenario: GeneratedResetScenario, event: BankedResetGeneratedEvent, label: string): Promise<void> => {
  switch (event) {
    case "request":
    case "non_qualifying_429":
      // A generic, malformed, or otherwise non-qualifying 429 never
      // enters the state machine's submission path.
      scenario.qualifyingObservationIsCurrent = false;
      scenario.lastOutcome = null;
      break;
    case "qualifying_429":
      scenario.qualifyingObservationIsCurrent = true;
      scenario.lastOutcome = await attemptCodexBankedReset(scenario.reset, scenario.deps);
      break;
    case "claim":
    case "submit":
      if (scenario.qualifyingObservationIsCurrent) scenario.lastOutcome = await attemptCodexBankedReset(scenario.reset, scenario.deps);
      break;
    case "provider_commit":
      scenario.provider.redeemResult = clone(sanitizedProviderFixtures.rate_limit);
      scenario.provider.commitOnRedeem = true;
      if (scenario.qualifyingObservationIsCurrent) scenario.lastOutcome = await attemptCodexBankedReset(scenario.reset, scenario.deps);
      break;
    case "response_loss":
      scenario.provider.redeemFailureAfterCommit = new Error(`response loss ${scenario.sequenceSeed}`);
      if (scenario.qualifyingObservationIsCurrent) scenario.lastOutcome = await attemptCodexBankedReset(scenario.reset, scenario.deps);
      scenario.provider.redeemFailureAfterCommit = null;
      break;
    case "lookup":
      scenario.clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
      scenario.provider.lookupResult = clone(sanitizedProviderFixtures.lookup_pending);
      scenario.lastOutcome = await reconcileCodexBankedReset(scenario.reset, scenario.deps);
      break;
    case "verify":
      scenario.clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
      scenario.provider.lookupResult = clone(sanitizedProviderFixtures.lookup_completed);
      scenario.provider.verifyResult = true;
      scenario.lastOutcome = await reconcileCodexBankedReset(scenario.reset, scenario.deps);
      break;
    case "retry": {
      const retriesBefore = scenario.postResetInferenceRetries;
      const outcome = scenario.lastOutcome;
      let retryPermitted = false;
      // The model can execute its one retry only from a verified durable
      // outcome; it never treats an unknown or rejected state as a permit.
      if (outcome?.kind === "verified" && retriesBefore === 0) {
        retryPermitted = true;
        assert.equal(outcome.record?.state, "verified", label);
        // This is the generated model's post-reset transport. The public
        // Responses/Chat matrix separately drives the real gateway transport;
        // here it makes the retry permit an executable state transition rather
        // than a bookkeeping increment.
        scenario.postResetInferenceRetries += 1;
      }
      assert.equal(scenario.postResetInferenceRetries > retriesBefore, retryPermitted, `${label}: retry must be granted only after verification`);
      assert.ok(scenario.postResetInferenceRetries <= 1, label);
      break;
    }
    case "crash":
    case "lease_expire":
      scenario.clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
      break;
    case "credential_rotate":
      scenario.credentialWasRotated = true;
      await scenario.kv.set(credentialFenceKey(scenario.reset.accountId), {
        kind: "credential",
        credential_version: `rotated-${scenario.sequenceSeed}`,
      });
      break;
    case "kv_failure": {
      scenario.kv.getFailure = new Error(`generated KV outage ${scenario.sequenceSeed}`);
      const failure = await attemptCodexBankedReset(scenario.reset, scenario.deps);
      assert.notEqual(failure.kind, "verified", label);
      scenario.kv.getFailure = null;
      break;
    }
    default:
      // Every generated event is modelled above; this keeps the switch total.
      assert.fail(`${label}: unmodelled generated event`);
  }
};

const assertBankedResetInvariants = (
  scenario: GeneratedResetScenario,
  label: string,
  submissionsBefore: number,
  mode: CodexBankedResetConfig["mode"]
): void => {
  const idempotencyKeys = new Set(scenario.provider.redeemInputs.map((input) => input.idempotencyKey));
  assert.ok(scenario.provider.commitCount <= 1, `${label}: more than one provider commit`);
  assert.ok(scenario.provider.redeemInputs.length <= 1, `${label}: more than one submission`);
  assert.ok(idempotencyKeys.size <= 1, `${label}: different idempotency keys`);
  if (!scenario.qualifyingObservationIsCurrent) {
    assert.equal(scenario.provider.redeemInputs.length, submissionsBefore, `${label}: a non-qualifying response reached submission`);
  }
  if (mode === "disabled" || mode === "shadow") {
    assert.equal(scenario.provider.commitCount, 0, `${label}: inactive mode committed`);
  }
  if (scenario.credentialWasRotated) {
    // A rotated fence may still permit provider-level reconciliation of a
    // prior unknown record, but it cannot start a submission under the
    // stale candidate fence.
    assert.equal(scenario.provider.redeemInputs.length, submissionsBefore, `${label}: stale fence submitted again`);
  }
};

export {
  BANKED_RESET_GENERATED_EVENTS,
  Deferred,
  FakeCodexUsageResetProvider,
  MemoryKv,
  TestClock,
  applyBankedResetEvent,
  assertBankedResetInvariants,
  bankedResetFences,
  candidate,
  clone,
  config,
  credentialFenceKey,
  dependencies,
  encodeKey,
  fullPool,
  hasKey,
  inventory,
  isRecord,
  provenContract,
  requiredHash,
  routingFenceKey,
  sanitizedProviderFixtures,
  seedFences,
  shadowDecisionFrom,
  testHash,
};
export type { BankedResetGeneratedEvent, GeneratedResetScenario };
export type { FakeProviderCall, StoredEntry };
export type { CodexBankedResetConfig } from "../../src/codex/banked-reset.ts";
export type { CodexResetRedemptionRecord } from "../../src/types.ts";
export type { CodexUsageResetProviderContract } from "../../src/codex/banked-reset-provider.ts";
export type { RedeemResetResult } from "../../src/codex/banked-reset-provider.ts";
export type { ResetInventory } from "../../src/codex/banked-reset-provider.ts";
export { CODEX_BANKED_RESET_INVENTORY_MAX_AGE_MS } from "../../src/codex/banked-reset.ts";
export { CODEX_BANKED_RESET_INVENTORY_TIMEOUT_MS } from "../../src/codex/banked-reset.ts";
export { CODEX_BANKED_RESET_LEASE_MS } from "../../src/codex/banked-reset.ts";
/** Retained legacy key: the submission budget never reads or enforces it after the per-account cutover. */
export { codexResetGlobalDailyKey } from "../../src/codex/banked-reset.ts";
export { codexResetAccountDailyKey } from "../../src/codex/banked-reset.ts";
export { codexResetRedemptionKey } from "../../src/codex/banked-reset.ts";
export { codexResetUsageKey } from "../../src/codex/reset-settings.ts";
export { attemptCodexBankedReset };
export { evaluateCodexBankedResetPool } from "../../src/codex/banked-reset-pool.ts";
export { parseCodexBankedResetConfig } from "../../src/codex/banked-reset.ts";
export { parseCodexResetRedemptionRecord } from "../../src/codex/banked-reset.ts";
export { providerSupportsLiveRedemption } from "../../src/codex/banked-reset-provider.ts";
export { providerSupportsResetType } from "../../src/codex/banked-reset-provider.ts";
export { reconcileCodexBankedReset } from "../../src/codex/banked-reset-submission.ts";
export { unavailableCodexUsageResetProvider } from "../../src/codex/banked-reset-provider.ts";
export { parseCodexResetShadowDecisionRecord } from "../../src/codex/banked-reset.ts";
export type { CodexBankedResetTelemetryFields } from "../../src/codex/banked-reset.ts";
