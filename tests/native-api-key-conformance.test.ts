import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AtomicOperation, Kv } from "#kv";
import * as apiKeyV3 from "../src/authority/native-api-key.ts";
import type { ApiKeyPolicy } from "../src/authority/native-contracts.ts";
import { apiKeyHashKey } from "../src/api-keys.ts";
import { apiKeyPolicyFromHashRecord, reserveApiKeyUsageV3 } from "../src/api-key-policy.ts";
import type { ApiKeyHashRecord } from "../src/types.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

// BEGIN SHARED_API_KEY_VECTORS
/** This exact synthetic vector function also runs against the real pure module in workerd. */
export const runApiKeyConformanceVectors = () => {
  const now = 10_000_000;
  const policy: ApiKeyPolicy = {
    token_hash: "synthetic",
    key_id: "key",
    expires_at_ms: -1,
    usage_limit_requests: 1,
    window_ms: 60_000,
    window_start_ms: now,
    usage_reset_at_ms: now + 60_000,
    policy_version: "v3:60000",
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  const empty = { request: null, window: null };
  const reserved = apiKeyV3.planApiKeyUsageReservation(policy, "request", "responses", empty, now);
  if (reserved.kind !== "write") throw new Error("Synthetic reservation was not writable");
  const snapshot = { request: reserved.request, window: reserved.window };
  const before = JSON.stringify(snapshot);
  const dispatched = apiKeyV3.planApiKeyUsageDispatch(policy, "request", "responses", "claude_code", snapshot, now + 1);
  if (dispatched.kind !== "write") throw new Error("Synthetic dispatch was not writable");
  const dispatchedSnapshot = { request: dispatched.request, window: dispatched.window };
  const cancelled = apiKeyV3.planApiKeyUsageDispatchCancellation(policy, "request", "responses", "claude_code", dispatchedSnapshot, now + 2);
  if (cancelled.kind !== "write") throw new Error("Synthetic cancellation was not writable");
  const released = apiKeyV3.planApiKeyUsageReservedRelease(policy, "request", "lease_expired", snapshot, now + 300_000);
  const results = {
    window: [apiKeyV3.currentApiKeyUsageWindow(now + 60_000, 60_000, now), apiKeyV3.currentApiKeyUsageWindow(now + 60_000, 60_000, now + 60_000)],
    version: apiKeyV3.apiKeyUsageV3PolicyVersion(60_000),
    retention: [
      apiKeyV3.apiKeyUsageV3RetentionMs(policy.usage_reset_at_ms, now),
      apiKeyV3.apiKeyUsageV3RetentionMs(policy.usage_reset_at_ms, now + 1),
      apiKeyV3.apiKeyUsageV3RetentionMs(policy.usage_reset_at_ms, now + 700_000_000),
    ],
    reserved,
    unlimited: apiKeyV3.planApiKeyUsageReservation(
      { ...policy, usage_limit_requests: -1 },
      "unlimited",
      "responses",
      { request: null, window: { ...reserved.window, committed_requests: 100 } },
      now
    ),
    zero: apiKeyV3.planApiKeyUsageReservation({ ...policy, usage_limit_requests: 0 }, "zero", "responses", empty, now),
    full: apiKeyV3.planApiKeyUsageReservation(policy, "other", "responses", { request: null, window: reserved.window }, now),
    reuse: apiKeyV3.planApiKeyUsageReservation(policy, "request", "responses", { request: reserved.request, window: {} }, now),
    consumed: apiKeyV3.planApiKeyUsageReservation(policy, "request", "responses", dispatchedSnapshot, now),
    identityConflict: apiKeyV3.planApiKeyUsageReservation(policy, "request", "chat.completions", snapshot, now),
    malformedRequest: apiKeyV3.planApiKeyUsageReservation(policy, "request", "responses", { request: {}, window: null }, now),
    malformedWindow: apiKeyV3.planApiKeyUsageReservation(policy, "request", "responses", { request: null, window: {} }, now),
    dispatched,
    repeatedDispatch: apiKeyV3.planApiKeyUsageDispatch(policy, "request", "responses", "surplus", dispatchedSnapshot, now + 2),
    expiredDispatch: apiKeyV3.planApiKeyUsageDispatch(policy, "request", "responses", "chatgpt_codex", snapshot, now + 300_001),
    cancelled,
    repeatedCancellation: apiKeyV3.planApiKeyUsageDispatchCancellation(
      policy,
      "request",
      "responses",
      "claude_code",
      { request: cancelled.request, window: cancelled.window },
      now + 3
    ),
    foreignProvider: apiKeyV3.planApiKeyUsageDispatchCancellation(policy, "request", "responses", "surplus", dispatchedSnapshot, now + 2),
    released,
    releaseDispatched: apiKeyV3.planApiKeyUsageReservedRelease(policy, "request", "done", dispatchedSnapshot, now + 2),
    missingRelease: apiKeyV3.planApiKeyUsageReservedRelease(policy, "request", "done", empty, now),
    lease: [
      apiKeyV3.isApiKeyUsageReservationExpired(reserved.request, now + 299_999),
      apiKeyV3.isApiKeyUsageReservationExpired(reserved.request, now + 300_000),
    ],
    providerNormalization: apiKeyV3.API_KEY_USAGE_PROVIDERS.map(
      (provider) => apiKeyV3.normalizeApiKeyUsageRequestV3({ ...dispatched.request, provider }) !== null
    ),
    unknownProvider: apiKeyV3.normalizeApiKeyUsageRequestV3({ ...dispatched.request, provider: "openlux" }),
    snapshotUnchanged: before === JSON.stringify(snapshot),
  };
  return results;
};
// END SHARED_API_KEY_VECTORS

test("native API V3 pure plans preserve policy identity, named write sets, lease and dispatch transitions", () => {
  const result = runApiKeyConformanceVectors();
  assert.equal(result.version, "v3:60000");
  assert.deepEqual(result.window, [
    { start: 10_000_000, reset: 10_060_000 },
    { start: 10_060_000, reset: 10_120_000 },
  ]);
  assert.deepEqual(result.retention, [604_860_000, 604_859_999, 1]);
  assert.deepEqual(result.reserved.checks, ["policy", "window", "request"]);
  assert.equal(result.reserved.window.reserved_requests, 1);
  assert.equal(result.reserved.request.lease_expires_at_ms - result.reserved.request.reserved_at_ms, 300_000);
  assert.equal(result.unlimited.kind, "write");
  assert.equal(result.zero.kind, "full");
  assert.equal(result.full.kind, "full");
  assert.deepEqual(result.reuse, { kind: "reuse" });
  assert.deepEqual(result.consumed, { kind: "unavailable", reason: "identity_consumed" });
  assert.deepEqual(result.identityConflict, { kind: "unavailable", reason: "identity_conflict" });
  assert.deepEqual(result.malformedRequest, { kind: "unavailable", reason: "request_malformed" });
  assert.deepEqual(result.malformedWindow, { kind: "unavailable", reason: "window_malformed" });
  assert.deepEqual(result.dispatched.checks, ["request", "window"]);
  assert.equal(result.dispatched.window.reserved_requests, 0);
  assert.equal(result.dispatched.window.committed_requests, 1);
  assert.deepEqual(result.repeatedDispatch, { kind: "already_dispatched" });
  // Native dispatch does not add a new lease-expiry or hash-policy fence after reservation.
  assert.equal(result.expiredDispatch.kind, "write");
  assert.deepEqual(result.cancelled.checks, ["request", "window"]);
  assert.equal(result.cancelled.window.committed_requests, 0);
  assert.equal(result.cancelled.request.provider, null);
  assert.equal(result.cancelled.request.release_reason, "transport_cancelled_before_fetch");
  assert.deepEqual(result.repeatedCancellation, { kind: "settled" });
  assert.deepEqual(result.foreignProvider, { kind: "invalid" });
  assert.equal(result.released.kind, "write");
  assert.deepEqual(result.releaseDispatched, { kind: "settled" });
  assert.deepEqual(result.missingRelease, { kind: "missing" });
  assert.deepEqual(result.lease, [false, true]);
  assert.ok(result.providerNormalization.every(Boolean));
  assert.equal(result.unknownProvider, null);
  assert.equal(result.snapshotUnchanged, true);
});

const syntheticRecord = (): ApiKeyHashRecord => ({
  id: "source-cas",
  expires_at_ms: -1,
  revoked_at_ms: null,
  usage_limit_requests: 1,
  usage_requests: 0,
  usage_reset_at_ms: Date.now() + 3_600_000,
  window_ms: 3_600_000,
  usage_quota_version: 3,
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
});

class ConflictKv extends CountingKv {
  attempts = 0;
  override atomic(): AtomicOperation {
    const operation = super.atomic();
    operation.commit = () => {
      this.attempts += 1;
      return Promise.resolve({ ok: false });
    };
    return operation;
  }
}

test("native API V3 wrapper retains five CAS attempts and leaves a failed reservation uncreated", async () => {
  const kv = new ConflictKv();
  const record = syntheticRecord();
  const policy = apiKeyPolicyFromHashRecord("synthetic", record, Date.now());
  assert.ok(policy);
  kv.seed(apiKeyHashKey("synthetic"), record);
  const decision = await reserveApiKeyUsageV3(policy, "request", "responses", { kv: kv as unknown as Kv });
  assert.equal(decision.ok, false);
  assert.equal(decision.response.status, 503);
  assert.equal(kv.attempts, 5);
  assert.equal(kv.entries.size, 1);
  assert.equal(kv.commands.filter((command) => command.command === "get" && command.keys[0]?.[2] === "hash").length, 5);
});

test("native API V3 wrapper keeps the hash snapshot in reservation CAS and rereads a racing zero limit", async () => {
  const record = syntheticRecord();
  class PolicyRaceKv extends CountingKv {
    changed = false;
    override atomic(): AtomicOperation {
      const operation = super.atomic();
      const commit = operation.commit.bind(operation);
      operation.commit = () => {
        if (!this.changed) {
          this.changed = true;
          this.seed(apiKeyHashKey("synthetic"), { ...record, usage_limit_requests: 0 });
        }
        return commit();
      };
      return operation;
    }
  }
  const kv = new PolicyRaceKv();
  const policy = apiKeyPolicyFromHashRecord("synthetic", record, Date.now());
  assert.ok(policy);
  kv.seed(apiKeyHashKey("synthetic"), record);
  const decision = await reserveApiKeyUsageV3(policy, "request", "responses", { kv: kv as unknown as Kv });
  assert.equal(decision.ok, false);
  assert.equal(decision.response.status, 429);
  assert.equal(kv.entries.size, 1);
  const lostCommit = kv.commands.find((command) => command.command === "atomic.commit");
  assert.equal(lostCommit?.atomicResult, "conflict");
  assert.equal(lostCommit.atomicChecks, 3);
  assert.equal(lostCommit.atomicMutations, 2);
  assert.deepEqual(
    lostCommit.keys.slice(0, 3).map((key) => (key[2] === "hash" ? "policy" : key[3])),
    ["policy", "window", "request"]
  );
});
