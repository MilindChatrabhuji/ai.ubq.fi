import { test } from "bun:test";
import assert from "node:assert/strict";
import * as codex429 from "../src/authority/native-codex-429.ts";
import * as capacity from "../src/authority/native-codex-capacity.ts";
import type { CodexAccountRoutingState, CodexRoutingAccount, CodexRoutingSlot } from "../src/authority/native-codex-contracts.ts";

// BEGIN SHARED_CODEX429_VECTORS
const proveCodex429 = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const requireCodex429 = <T>(value: T | null, message: string): T => {
  if (value === null) throw new Error(message);
  return value;
};

const classifyCodex429Vectors = async (now: number) => {
  const deadline = now + 60_000;
  const usage = JSON.stringify({ error: { type: "usage_limit_reached" } });
  const stableBody = JSON.stringify({ error: { type: "usage_limit_reached", resets_at: deadline / 1_000 } });
  const classified: Record<string, unknown> = {};
  const classify = async (name: string, bytes: string | Uint8Array<ArrayBuffer>, retryAfter?: string) => {
    const headers = new Headers({ "content-type": "application/json", "x-request-id": "synthetic-429" });
    if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
    const parsed = await codex429.classifyCodex429(new Response(bytes, { status: 429, statusText: "Too Many Requests", headers }), now);
    const responseBytes = [...new Uint8Array(await parsed.response.clone().arrayBuffer())];
    const expectedBytes = [...(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)];
    proveCodex429(JSON.stringify(responseBytes) === JSON.stringify(expectedBytes), `${name}: complete upstream bytes changed`);
    proveCodex429(parsed.response.status === 429 && parsed.response.headers.get("x-request-id") === "synthetic-429", `${name}: response metadata changed`);
    classified[name] = { ...parsed, response: { bytes: responseBytes, headers: [...parsed.response.headers], status: parsed.response.status } };
    return parsed;
  };

  const absolute = await classify("body-absolute", stableBody);
  proveCodex429(absolute.usageLimitReached && absolute.retryAtMs === deadline && absolute.resetDeadlineIsStable, "body deadline lost");
  const relative = await classify("header-relative", usage, "120");
  proveCodex429(relative.retryAtMs === now + 120_000 && !relative.resetDeadlineIsStable, "relative deadline became stable");
  const date = await classify("header-absolute", usage, new Date(deadline).toUTCString());
  proveCodex429(date.retryAtMs === deadline && date.resetDeadlineIsStable && date.quotaBlockSource === "header_retry_after", "HTTP date lost");
  const conflict = await classify("absolute-conflict", stableBody, new Date(now + 120_000).toUTCString());
  proveCodex429(
    conflict.retryAtMs === now + 120_000 && conflict.resetDeadlineConflict && !conflict.resetDeadlineIsStable,
    "absolute conflict reopened redemption"
  );
  const shorter = await classify("relative-shorter", stableBody, "30");
  proveCodex429(shorter.retryAtMs === deadline && !shorter.resetDeadlineConflict && shorter.resetDeadlineIsStable, "shorter relative delay changed identity");
  const longer = await classify("relative-longer", stableBody, "120");
  proveCodex429(longer.retryAtMs === now + 120_000 && longer.resetDeadlineConflict && !longer.resetDeadlineIsStable, "longer relative delay lost ambiguity");

  for (const [name, body] of [
    ["duplicate-error", '{"error":{"type":"other"},"error":{"type":"usage_limit_reached","resets_at":1700000060}}'],
    ["duplicate-escaped-key", '{"error":{"type":"other","t\\u0079pe":"usage_limit_reached","resets_at":1700000060}}'],
    ["malformed-json", '{"error":{"type":"usage_limit_reached"}'],
    ["wrong-shape", '[{"error":{"type":"usage_limit_reached"}}]'],
    ["ordinary-429", '{"error":{"type":"rate_limit_error"}}'],
  ]) {
    const parsed = await classify(name, body, "15");
    proveCodex429(!parsed.usageLimitReached && parsed.retryAtMs === now + 15_000 && !parsed.resetDeadlineIsStable, `${name}: ambiguous body became exhaustion`);
  }
  const malformedUtf8 = await classify("malformed-utf8", new Uint8Array([0xff, ...new TextEncoder().encode(stableBody)]), "15");
  proveCodex429(!malformedUtf8.usageLimitReached, "malformed UTF-8 became exhaustion");
  const invalidReset = await classify("invalid-body-reset", '{"error":{"type":"usage_limit_reached","resets_at":1700000060.5}}');
  proveCodex429(invalidReset.usageLimitReached && invalidReset.retryAtMs === null, "fractional reset became a deadline");
  const retryAfter: Record<string, unknown> = {};
  for (const value of ["0", "-1", "+1", "1.5", "1e2", "9007199254740991", "Tue, 14 Nov 2023 22:14:20 GMT", "Wed, 14 Nov 2023 22:14:20 GMT"]) {
    retryAfter[value] = codex429.futureRetryAfterDeadline(new Headers({ "retry-after": value }), now);
  }
  proveCodex429(retryAfter["Tue, 14 Nov 2023 22:14:20 GMT"] !== null && retryAfter["Wed, 14 Nov 2023 22:14:20 GMT"] === null, "noncanonical date was accepted");
  proveCodex429(
    Object.entries(retryAfter)
      .filter(([key]) => key !== "Tue, 14 Nov 2023 22:14:20 GMT")
      .every(([, value]) => value === null),
    "invalid Retry-After was accepted"
  );

  const oversized = await codex429.classifyCodex429(new Response("x".repeat(65_537), { status: 429, headers: { "retry-after": "15" } }), now);
  const oversizedBody = await oversized.response.json();
  proveCodex429(!oversized.usageLimitReached && oversizedBody.error.code === "codex_rate_limit_response_truncated", "oversized response was forwarded");
  const cancellations: string[] = [];
  const stalled = await codex429.classifyCodex429(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stableBody));
        },
        cancel() {
          cancellations.push("cancelled");
        },
      }),
      { status: 429, headers: { "retry-after": "15" } }
    ),
    now
  );
  const stalledBody = await stalled.response.json();
  proveCodex429(
    cancellations.length === 1 && !stalled.usageLimitReached && stalledBody.error.code === "codex_rate_limit_response_truncated",
    "incomplete response became exhaustion"
  );

  return {
    classified,
    retryAfter,
    oversized: { body: oversizedBody, retryAtMs: oversized.retryAtMs },
    incomplete: { body: stalledBody, cancelled: cancellations.length === 1, retryAtMs: stalled.retryAtMs },
    absolute,
    relative,
    invalidReset,
  };
};

export const runCodex429ConformanceVectors = async () => {
  const now = 1_700_000_000_000;
  const deadline = now + 60_000;
  const { absolute, relative, invalidReset, ...classification } = await classifyCodex429Vectors(now);
  const account: CodexRoutingAccount = {
    slot: 0,
    accountIdHash: "opaque-account",
    credentialVersion: "opaque-credential",
    quotaHeadroom: null,
    probeRequired: false,
    probeGeneration: null,
    probeToken: null,
    requestedModel: "gpt-test",
    routingGeneration: 7,
    activeGeneration: 3,
    activePoolVersionstamp: "pool-generation",
  };
  const state: CodexAccountRoutingState = {
    v: 2,
    updated_at_ms: now - 1,
    banked_reset_legacy_identity_unresolved: false,
    slots: [{ ...capacity.neutralSlot(account.credentialVersion, account.accountIdHash), generation: 7 }],
  };
  const before = JSON.stringify(state);
  const first = requireCodex429(codex429.quotaBlockTransition(state, account, absolute, now, false, now + 1), "first block missing");
  proveCodex429(JSON.stringify(state) === before && first.updated_at_ms === now + 1, "transition mutated input or lost injected clock");
  proveCodex429(first.slots[0].quota_blocks_by_class?.standard?.blocked_until_ms === deadline && first.slots[0].generation === 8, "standard block changed");
  const later = requireCodex429(codex429.quotaBlockTransition(first, account, relative, now + 1, false, now + 2), "later block missing");
  proveCodex429(
    later.slots[0].observed_reset_at_ms === deadline && later.slots[0].banked_reset_generation_ambiguous,
    "relative update minted a new reset identity"
  );
  const recovery = requireCodex429(codex429.quotaBlockTransition(state, account, absolute, now, true, now + 1), "recovery block missing");
  proveCodex429(
    recovery.slots[0].quota_blocked_until_ms === now + 30_000 && recovery.slots[0].banked_reset_generation_ambiguous,
    "recovery probe became a long circuit"
  );

  const lease = { token: "probe-token", generation: 7, expires_at_ms: now + 30_000, circuit: "quota" as const, quota_class: "spark" as const };
  const leasedState: CodexAccountRoutingState = { ...state, slots: [{ ...state.slots[0], probe_lease: lease }] };
  const foreign = requireCodex429(codex429.quotaBlockTransition(leasedState, account, absolute, now, false, now + 1), "foreign-class block missing");
  proveCodex429(foreign.slots[0].probe_lease === lease && foreign.slots[0].generation === 7, "ordinary request replaced foreign-class lease");
  const sparkAccount = { ...account, requestedModel: "gpt-5.3-codex-spark" };
  proveCodex429(codex429.quotaBlockTransition(leasedState, sparkAccount, absolute, now, false, now) === null, "ordinary request overwrote same-class probe");
  const probe = { ...sparkAccount, probeRequired: true, probeGeneration: 7, probeToken: lease.token, probeCircuit: "quota" as const };
  const spark = requireCodex429(codex429.quotaBlockTransition(leasedState, probe, absolute, now, false, now + 1), "matching probe block missing");
  proveCodex429(
    spark.slots[0].quota_blocks_by_class?.spark?.blocked_until_ms === deadline && spark.slots[0].probe_lease === null,
    "matching Spark probe failed to block"
  );
  proveCodex429(
    codex429.quotaBlockTransition(leasedState, { ...probe, probeToken: "stale-token" }, absolute, now, false, now) === null,
    "stale token wrote a block"
  );
  proveCodex429(
    codex429.quotaBlockTransition(state, { ...account, credentialVersion: "stale-credential" }, absolute, now, false, now) === null,
    "stale credential wrote a block"
  );
  proveCodex429(
    codex429.quotaBlockTransition(state, { ...account, accountIdHash: "other-account" }, absolute, now, false, now) === null,
    "foreign account wrote a block"
  );
  proveCodex429(codex429.quotaBlockTransition(state, account, invalidReset, now, false, now) === null, "missing reset wrote a block");

  const released = requireCodex429(codex429.releaseNonBlockingQuotaProbe(leasedState, probe, now + 1), "matching nonblocking probe was not released");
  proveCodex429(released.slots[0].probe_lease === null && released.updated_at_ms === now + 1, "probe release lost row timestamp or lease");
  proveCodex429(
    codex429.releaseNonBlockingQuotaProbe(leasedState, { ...probe, probeToken: "stale-token" }, now) === null,
    "stale nonblocking probe cleared a lease"
  );
  const timeoutSlot: CodexRoutingSlot = {
    ...first.slots[0],
    generation: 7,
    upstream_timeout_blocked_until_ms: deadline,
    banked_reset_recovery_probe_pending: true,
    probe_lease: { ...lease, circuit: "upstream_timeout", quota_class: null },
  };
  const timeout = requireCodex429(
    codex429.releaseNonBlockingQuotaProbe({ ...state, slots: [timeoutSlot] }, { ...probe, probeCircuit: "upstream_timeout" }, now + 1),
    "timeout release missing"
  );
  proveCodex429(
    timeout.slots[0].upstream_timeout_blocked_until_ms === null && timeout.slots[0].banked_reset_recovery_probe_pending,
    "timeout release changed quota recovery flags"
  );
  return {
    ...classification,
    transitions: { first, later, recovery, foreign, spark, released, timeout },
  };
};
// END SHARED_CODEX429_VECTORS

test("native Codex 429 policy preserves bounded response bytes, reset identity, class leases and injected clocks", async () => {
  const vectors = await runCodex429ConformanceVectors();
  assert.equal(Object.keys(vectors.classified).length, 13);
  assert.equal(vectors.transitions.foreign.slots[0].probe_lease?.token, "probe-token");
  assert.equal(vectors.transitions.later.slots[0].banked_reset_generation_ambiguous, true);
});
