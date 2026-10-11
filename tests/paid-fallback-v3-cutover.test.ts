import assert from "node:assert/strict";

type StoredEntry = {
  key: Deno.KvKey;
  value: unknown;
  versionstamp: string;
};

const encodeKey = (key: Deno.KvKey): string => JSON.stringify(key);
const clone = <T>(value: T): T => structuredClone(value);
const startsWithKey = (key: Deno.KvKey, prefix: Deno.KvKey): boolean => prefix.every((part, index) => key[index] === part);

class MemoryKv {
  readonly entries = new Map<string, StoredEntry>();
  #version = 0;

  #nextVersionstamp(): string {
    this.#version += 1;
    return String(this.#version).padStart(20, "0");
  }

  get<T = unknown>(key: Deno.KvKey): Promise<Deno.KvEntryMaybe<T>> {
    const entry = this.entries.get(encodeKey(key));
    return Promise.resolve({
      key: clone(key),
      value: entry ? (clone(entry.value) as T) : null,
      versionstamp: entry?.versionstamp ?? null,
    } as Deno.KvEntryMaybe<T>);
  }

  set(key: Deno.KvKey, value: unknown): Promise<Deno.KvCommitResult> {
    const versionstamp = this.#nextVersionstamp();
    this.entries.set(encodeKey(key), {
      key: clone(key),
      value: clone(value),
      versionstamp,
    });
    return Promise.resolve({ ok: true, versionstamp });
  }

  list<T = unknown>(selector: Deno.KvListSelector): Deno.KvListIterator<T> {
    const prefix = "prefix" in selector ? selector.prefix : [];
    const entries = [...this.entries.values()].filter((entry) => startsWithKey(entry.key, prefix));
    const iterator = (function* (): Generator<Deno.KvEntry<T>> {
      for (const entry of entries) {
        yield {
          key: clone(entry.key),
          value: clone(entry.value) as T,
          versionstamp: entry.versionstamp,
        };
      }
    })() as unknown as Deno.KvListIterator<T>;
    Object.defineProperty(iterator, "cursor", { get: () => "" });
    return iterator;
  }

  atomic(): Deno.AtomicOperation {
    const checks: { key: Deno.KvKey; versionstamp: string | null }[] = [];
    const mutations: ({ type: "set"; key: Deno.KvKey; value: unknown } | { type: "delete"; key: Deno.KvKey })[] = [];
    const operation = {
      check: (entry: { key: Deno.KvKey; versionstamp: string | null }) => {
        checks.push({ key: clone(entry.key), versionstamp: entry.versionstamp });
        return operation;
      },
      set: (key: Deno.KvKey, value: unknown) => {
        mutations.push({ type: "set", key: clone(key), value: clone(value) });
        return operation;
      },
      delete: (key: Deno.KvKey) => {
        mutations.push({ type: "delete", key: clone(key) });
        return operation;
      },
      commit: (): Promise<Deno.KvCommitResult | Deno.KvCommitError> => {
        const changed = checks.some((check) => (this.entries.get(encodeKey(check.key))?.versionstamp ?? null) !== check.versionstamp);
        if (changed) return Promise.resolve({ ok: false });
        const versionstamp = this.#nextVersionstamp();
        for (const mutation of mutations) {
          if (mutation.type === "delete") {
            this.entries.delete(encodeKey(mutation.key));
          } else {
            this.entries.set(encodeKey(mutation.key), {
              key: clone(mutation.key),
              value: clone(mutation.value),
              versionstamp,
            });
          }
        }
        return Promise.resolve({ ok: true, versionstamp });
      },
    };
    return operation as unknown as Deno.AtomicOperation;
  }

  close(): void {}
}

const memoryKv = new MemoryKv();
const kv = memoryKv as unknown as Deno.Kv;
const denoWithKv = Deno as unknown as { openKv?: () => Promise<Deno.Kv> };
const originalOpenKv = denoWithKv.openKv;
denoWithKv.openKv = () => Promise.resolve(kv);

const { apiKeyHashKey, apiKeyIdKey } = await import("../src/api-keys.ts");
const {
  recordMeteredAmbiguousFailure,
  recordMeteredTerminal,
  recordMeteredUndispatchedCancellation,
  recordMeteredUpstreamResponse,
  recordSurplusUsage,
  reservePaidFallback,
} = await import("../src/paid-fallback/index.ts");
const { reconcilePaidFallbackV3 } = await import("../src/paid-fallback/ledger-backfill.ts");
const { paidFallbackPendingV3Key, paidFallbackRequestV3Key, paidFallbackWindowV3Key } = await import("../src/paid-fallback/ledger-state.ts");
const { getKv } = await import("../src/kv.ts");
await getKv();
type ApiKeyRecord = import("../src/types.ts").ApiKeyRecord;
type PaidFallbackRequestV3 = import("../src/types.ts").PaidFallbackRequestV3;
type PaidFallbackWindowV3 = import("../src/types.ts").PaidFallbackWindowV3;

denoWithKv.openKv = originalOpenKv;

const keyId = "v3-cutover-key";
const keyHash = "v3-cutover-hash";
const legacyRequestLogPrefix: Deno.KvKey = ["ubq_ai", "api_keys", "request_log", keyId];

const countPrefix = async (prefix: Deno.KvKey): Promise<number> => {
  const keys: Deno.KvKey[] = [];
  for await (const entry of memoryKv.list({ prefix })) keys.push(entry.key);
  return keys.length;
};

const reservationInput = (requestId: string, createdAtMs: number) =>
  ({
    keyId,
    requestId,
    createdAtMs,
    model: "gpt-5-codex",
    route: "responses",
    path: "/v1/responses",
    stream: true,
    reasoning: "high",
    reason: "primary_429",
  }) as const;

const reserve = async (requestId: string, createdAtMs: number) => {
  const decision = await reservePaidFallback(reservationInput(requestId, createdAtMs));
  assert.equal(decision.kind, "reserved");

  return decision.reservation;
};

const readRequest = async (requestId: string): Promise<PaidFallbackRequestV3> => {
  const entry = await memoryKv.get<PaidFallbackRequestV3>(paidFallbackRequestV3Key(keyId, requestId));
  assert.ok(entry.value);
  return entry.value;
};

const assertLegacyStateUnchanged = async (expected: ApiKeyRecord): Promise<void> => {
  const idEntry = await memoryKv.get<ApiKeyRecord>(apiKeyIdKey(keyId));
  const hashEntry = await memoryKv.get<Record<string, unknown>>(apiKeyHashKey(keyHash));
  assert.deepEqual(idEntry.value, expected);
  assert.equal(hashEntry.value?.paid_fallback_spent_microcredits, expected.paid_fallback_spent_microcredits);
  assert.equal(hashEntry.value.paid_fallback_reserved_microcredits, expected.paid_fallback_reserved_microcredits);
  assert.equal(hashEntry.value.paid_fallback_reservation_request_id, expected.paid_fallback_reservation_request_id);
  assert.equal(await countPrefix(legacyRequestLogPrefix), 0);
};

Deno.test("Metered runtime lifecycle hard-cuts legacy counters and request logs in favor of V3", async () => {
  const now = Date.now();
  const record: ApiKeyRecord = {
    id: keyId,
    name: "V3 cutover",
    prefix: "u_v3",
    hash: keyHash,
    created_at_ms: now - 60_000,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 100,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 5_000_000,
    paid_fallback_spent_microcredits: 4_900_000,
    paid_fallback_reserved_microcredits: 200_000,
    paid_fallback_reservation_request_id: "legacy-stale-reservation",
    paid_fallback_model_ids: ["gpt-5-codex"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { "gpt-5-codex": 250_000 },
    paid_fallback_pricing_checked_at_ms: now - 30_000,
  };
  const hashRecord = {
    id: record.id,
    expires_at_ms: record.expires_at_ms,
    revoked_at_ms: record.revoked_at_ms,
    usage_limit_requests: record.usage_limit_requests,
    usage_requests: record.usage_requests,
    usage_reset_at_ms: record.usage_reset_at_ms,
    window_ms: record.window_ms,
    usage_quota_version: record.usage_quota_version,
    paid_fallback_enabled: record.paid_fallback_enabled,
    paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
    paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
    paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
    paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
  };
  await memoryKv.set(apiKeyIdKey(keyId), record);
  await memoryKv.set(apiKeyHashKey(keyHash), hashRecord);

  const originalEnvGet = Deno.env.get.bind(Deno.env);
  Deno.env.get = (name: string): string | undefined => (name === "METERED_API_KEY" ? "test-metered-key" : originalEnvGet(name));
  try {
    const terminalReservation = await reserve("terminal-missing-id", now);
    assert.equal(terminalReservation.reserved_microcredits, 250_000);
    assert.equal(terminalReservation.quota_used_percent, 0);
    await recordMeteredUpstreamResponse(terminalReservation, new Response(null, { status: 502 }), null);
    await recordMeteredTerminal(terminalReservation, "incomplete");
    const terminal = await readRequest("terminal-missing-id");
    assert.equal(terminal.dispatch_state, "dispatched");
    assert.equal(terminal.terminal_state, "incomplete");
    assert.equal(terminal.provider_request_id, null);
    assert.equal(terminal.billing_state, "pending");
    assert.equal(terminal.reserved_microcredits, 250_000);
    assert.equal(terminal.reconciliation_attempts, 1);
    assert.ok((await memoryKv.get(paidFallbackPendingV3Key(keyId, terminal.request_id))).value);

    const ambiguousReservation = await reserve("ambiguous", now + 1);
    await recordMeteredAmbiguousFailure(ambiguousReservation);
    const ambiguous = await readRequest("ambiguous");
    assert.equal(ambiguous.dispatch_state, "dispatched");
    assert.equal(ambiguous.terminal_state, "ambiguous");
    assert.equal(ambiguous.billing_state, "pending");
    assert.equal(ambiguous.reserved_microcredits, 250_000);
    assert.ok((await memoryKv.get(paidFallbackPendingV3Key(keyId, ambiguous.request_id))).value);

    const dispatchedReservation = await reserve("dispatched-http-error", now + 2);
    await recordMeteredUpstreamResponse(dispatchedReservation, new Response(null, { status: 503 }), "provider-request-id", "surplus");
    const dispatched = await readRequest("dispatched-http-error");
    assert.equal(dispatched.dispatch_state, "dispatched");
    assert.equal(dispatched.terminal_state, "pending");
    assert.equal(dispatched.provider_request_id, "provider-request-id");
    assert.equal(dispatched.provider, "surplus");
    assert.equal(dispatched.billing_state, "pending");
    assert.equal(dispatched.reserved_microcredits, 250_000);

    const cancelledReservation = await reserve("cancelled-before-dispatch", now + 3);
    await recordMeteredUndispatchedCancellation(cancelledReservation);
    const cancelled = await readRequest("cancelled-before-dispatch");
    assert.equal(cancelled.dispatch_state, "not_dispatched");
    assert.equal(cancelled.terminal_state, "cancelled");
    assert.equal(cancelled.billing_state, "not_billed");
    assert.equal(cancelled.spend_microcredits, 0);
    assert.equal((await memoryKv.get(paidFallbackPendingV3Key(keyId, cancelled.request_id))).value, null);

    const window = await memoryKv.get<PaidFallbackWindowV3>(paidFallbackWindowV3Key(keyId, terminalReservation.window_reset_at_ms));
    assert.equal(window.value?.settled_microcredits, 0);
    assert.equal(window.value.reserved_microcredits, 750_000);
    assert.equal(window.value.pending_count, 3);
    await assertLegacyStateUnchanged(record);
  } finally {
    Deno.env.get = originalEnvGet;
  }
});

Deno.test("Surplus usage settles cache read and write pricing, while incomplete usage stays pending", async () => {
  memoryKv.entries.clear();
  const now = Date.now();
  const record: ApiKeyRecord = {
    id: keyId,
    name: "Surplus billing",
    prefix: "u_v3",
    hash: keyHash,
    created_at_ms: now - 60_000,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 100,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 5_000_000,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
    paid_fallback_model_ids: ["gpt-5-codex"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { "gpt-5-codex": 250_000 },
    paid_fallback_pricing_checked_at_ms: now - 30_000,
  };
  await memoryKv.set(apiKeyIdKey(keyId), record);
  await memoryKv.set(apiKeyHashKey(keyHash), {
    id: record.id,
    expires_at_ms: record.expires_at_ms,
    revoked_at_ms: record.revoked_at_ms,
    usage_limit_requests: record.usage_limit_requests,
    usage_requests: record.usage_requests,
    usage_reset_at_ms: record.usage_reset_at_ms,
    window_ms: record.window_ms,
    usage_quota_version: record.usage_quota_version,
    paid_fallback_enabled: record.paid_fallback_enabled,
    paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
    paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
    paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
    paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
  });

  const originalEnvGet = Deno.env.get.bind(Deno.env);
  Deno.env.get = (name: string): string | undefined => (name === "METERED_API_KEY" ? "test-metered-key" : originalEnvGet(name));
  try {
    const settledReservation = await reserve("surplus-settled", now);
    await recordMeteredUpstreamResponse(settledReservation, new Response(null, { status: 200 }), null, "surplus");
    await recordMeteredTerminal(settledReservation, "completed", "surplus");
    const surplusSettlementId = `surplus:${settledReservation.request_id}`;
    await recordSurplusUsage(
      settledReservation,
      surplusSettlementId,
      "gpt-5-codex",
      {
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 30,
        output_tokens: 10,
      },
      {
        input_price_per_token: 0.000001,
        cache_read_price_per_token: 0.0000001,
        cache_write_price_per_token: 0.000002,
        output_price_per_token: 0.000003,
      }
    );
    const settled = await readRequest("surplus-settled");
    assert.equal(settled.provider_request_id, null);
    assert.equal(settled.billing_state, "settled");
    assert.equal(settled.provider_quota, 86);
    assert.equal(settled.spend_microcredits, 172);
    const settledWindowBeforeReplay = await memoryKv.get<PaidFallbackWindowV3>(paidFallbackWindowV3Key(keyId, settledReservation.window_reset_at_ms));
    await recordSurplusUsage(
      settledReservation,
      surplusSettlementId,
      "gpt-5-codex",
      {
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 30,
        output_tokens: 10,
      },
      {
        input_price_per_token: 0.000001,
        cache_read_price_per_token: 0.0000001,
        cache_write_price_per_token: 0.000002,
        output_price_per_token: 0.000003,
      }
    );
    const settledAfterReplay = await readRequest("surplus-settled");
    const settledWindowAfterReplay = await memoryKv.get<PaidFallbackWindowV3>(paidFallbackWindowV3Key(keyId, settledReservation.window_reset_at_ms));
    assert.equal(settledAfterReplay.spend_microcredits, settled.spend_microcredits);
    assert.equal(settledWindowAfterReplay.value?.settled_microcredits, settledWindowBeforeReplay.value?.settled_microcredits);
    assert.equal(settledWindowAfterReplay.value?.reserved_microcredits, settledWindowBeforeReplay.value?.reserved_microcredits);

    // Real native Surplus measurements must override the catalog estimate.
    // An odd 69-microcredit charge cannot round through 500,000 quota/credit
    // into 70 microcredits, and an explicitly free completion stays free.
    for (const fixture of [
      { id: "surplus-native-fill", cost: 1056, cached: null, written: 1028 },
      { id: "surplus-native-read", cost: 69, cached: 1028, written: null },
      { id: "surplus-native-free", cost: 0, cached: null, written: null },
    ]) {
      const reservation = await reserve(fixture.id, now);
      await recordMeteredUpstreamResponse(reservation, new Response(null, { status: 200 }), null, "surplus");
      await recordMeteredTerminal(reservation, "completed", "surplus");
      const usage = {
        input_tokens: 1043,
        cached_input_tokens: fixture.cached,
        cache_write_input_tokens: fixture.written,
        output_tokens: 4,
        buyer_cost_micro: fixture.cost,
      };
      const pricing = {
        input_price_per_token: 0.000001,
        output_price_per_token: 0.000003,
        cache_read_price_per_token: 0.0000001,
        cache_write_price_per_token: 0.000002,
      };
      await recordSurplusUsage(reservation, `surplus:${fixture.id}`, "gpt-5-codex", usage, pricing);
      const actual = await readRequest(fixture.id);
      assert.equal(actual.billing_state, "settled");
      assert.equal(actual.spend_microcredits, fixture.cost);
      assert.equal(actual.cached_input_tokens, fixture.cached, "unknown cache reads must stay unknown in the authoritative settlement");
      const windowBeforeReplay = await memoryKv.get<PaidFallbackWindowV3>(paidFallbackWindowV3Key(keyId, reservation.window_reset_at_ms));
      await recordSurplusUsage(reservation, `surplus:${fixture.id}`, "gpt-5-codex", usage, pricing);
      const windowAfterReplay = await memoryKv.get<PaidFallbackWindowV3>(paidFallbackWindowV3Key(keyId, reservation.window_reset_at_ms));
      assert.equal((await readRequest(fixture.id)).spend_microcredits, fixture.cost);
      assert.equal(windowAfterReplay.value?.settled_microcredits, windowBeforeReplay.value?.settled_microcredits);
      assert.equal(windowAfterReplay.value?.reserved_microcredits, windowBeforeReplay.value?.reserved_microcredits);
    }

    for (const buyerCostMicro of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, null]) {
      const id = `surplus-native-invalid-${String(buyerCostMicro)}`;
      const reservation = await reserve(id, now);
      await recordMeteredUpstreamResponse(reservation, new Response(null, { status: 200 }), null, "surplus");
      await recordMeteredTerminal(reservation, "completed", "surplus");
      await recordSurplusUsage(
        reservation,
        `surplus:${id}`,
        "gpt-5-codex",
        { input_tokens: 1043, cached_input_tokens: 1028, cache_write_input_tokens: null, output_tokens: 4, buyer_cost_micro: buyerCostMicro },
        { input_price_per_token: 0.000001, output_price_per_token: 0.000003 }
      );
      const actual = await readRequest(id);
      assert.equal(actual.billing_state, "pending", "a malformed authoritative charge must not fall back to guessed pricing");
      assert.equal(actual.spend_microcredits, null);
    }

    const nativeUnmeasured = await reserve("surplus-native-unmeasured-cost", now);
    await recordMeteredUpstreamResponse(nativeUnmeasured, new Response(null, { status: 200 }), null, "surplus");
    await recordMeteredTerminal(nativeUnmeasured, "completed", "surplus");
    await recordSurplusUsage(
      nativeUnmeasured,
      "surplus:native-unmeasured",
      "gpt-5-codex",
      { input_tokens: 1043, cached_input_tokens: null, cache_write_input_tokens: 1028, output_tokens: 4 },
      { input_price_per_token: 0.000001, output_price_per_token: 0.000003, cache_write_price_per_token: 0.000002, require_provider_cost: true }
    );
    assert.equal((await readRequest(nativeUnmeasured.request_id)).billing_state, "pending", "native gross cache writes must not use legacy additive pricing");
    assert.equal((await readRequest(nativeUnmeasured.request_id)).spend_microcredits, null);

    const incompleteReservation = await reserve("surplus-incomplete", now + 1);
    await recordMeteredUpstreamResponse(incompleteReservation, new Response(null, { status: 200 }), "surplus-incomplete-request", "surplus");
    await recordMeteredTerminal(incompleteReservation, "completed", "surplus");
    await recordSurplusUsage(
      incompleteReservation,
      "surplus-incomplete-request",
      "gpt-5-codex",
      { input_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null, output_tokens: 10 },
      { input_price_per_token: 0.000001, output_price_per_token: 0.000003 }
    );

    let meteredLogCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      meteredLogCalls += 1;
      return Promise.reject(new Error("Surplus reconciliation must not call Metered logs"));
    };
    try {
      await reconcilePaidFallbackV3(keyId, Date.now(), kv);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const incomplete = await readRequest("surplus-incomplete");
    assert.equal(meteredLogCalls, 0);
    assert.equal(incomplete.billing_state, "pending");
    assert.equal(incomplete.spend_microcredits, null);
    assert.ok((await memoryKv.get(paidFallbackPendingV3Key(keyId, incomplete.request_id))).value);

    const meteredReservation = await reserve("metered-must-ignore-surplus-cost", now);
    await recordMeteredUpstreamResponse(meteredReservation, new Response(null, { status: 200 }), "metered-request", "metered");
    await recordMeteredTerminal(meteredReservation, "completed", "metered");
    await recordSurplusUsage(
      meteredReservation,
      "surplus:must-not-match-metered",
      "gpt-5-codex",
      { input_tokens: 1043, cached_input_tokens: 1028, cache_write_input_tokens: null, output_tokens: 4, buyer_cost_micro: 69 },
      { input_price_per_token: 0.000001, output_price_per_token: 0.000003 }
    );
    assert.equal((await readRequest(meteredReservation.request_id)).billing_state, "pending");
    assert.equal((await readRequest(meteredReservation.request_id)).spend_microcredits, null);
  } finally {
    Deno.env.get = originalEnvGet;
  }
});
