import { test } from "bun:test";
import type { AtomicOperation, Kv, KvCommitError, KvCommitResult, KvEntryMaybe, KvKey, KvListIterator, KvListOptions, KvListSelector } from "#kv";
import type { NetAddr } from "#http";
import { setKvForTest } from "../src/kv.ts";
import { openKv } from "#kv";
import assert from "node:assert/strict";

// Type-only: erased at runtime, so the dynamic imports below still see the KV stub.
import type { LocalDevelopmentPricingInitializer } from "../src/auth/local-development-key.ts";
import type { ServeRuntimeOptions } from "../src/auth/local-admin.ts";

/**
 * Minimal in-memory Deno.Kv for the local-development provisioning tests. The
 * standard test task runs without `--unstable-kv`, so `Deno.openKv` is stubbed
 * before the modules under test import `src/kv.ts`.
 */
class MemoryKv {
  #entries = new Map<string, { key: KvKey; value: unknown; versionstamp: string }>();
  #version = 0;

  #nextVersionstamp(): string {
    this.#version += 1;
    return String(this.#version).padStart(20, "0");
  }

  #keyOf(key: KvKey): string {
    return JSON.stringify(key);
  }

  get(key: KvKey): Promise<KvEntryMaybe<unknown>> {
    const entry = this.#entries.get(this.#keyOf(key));
    return Promise.resolve(
      (entry ? { key: entry.key, value: entry.value, versionstamp: entry.versionstamp } : { key, value: null, versionstamp: null }) as KvEntryMaybe<unknown>
    );
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    const versionstamp = this.#nextVersionstamp();
    this.#entries.set(this.#keyOf(key), { key, value, versionstamp });
    return Promise.resolve({ ok: true, versionstamp } as KvCommitResult);
  }

  atomic(): AtomicOperation {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const mutations: { key: KvKey; value: unknown }[] = [];
    const currentVersionstamp = (key: KvKey): string | null => this.#entries.get(this.#keyOf(key))?.versionstamp ?? null;
    const operation = {
      check: (entry: { key: KvKey; versionstamp: string | null }) => {
        checks.push({ key: entry.key, versionstamp: entry.versionstamp });
        return operation;
      },
      set: (key: KvKey, value: unknown) => {
        mutations.push({ key, value });
        return operation;
      },
      delete: (key: KvKey) => {
        mutations.push({ key, value: null });
        return operation;
      },
      commit: (): Promise<KvCommitResult | KvCommitError> => {
        if (checks.some((check) => currentVersionstamp(check.key) !== check.versionstamp)) {
          return Promise.resolve({ ok: false } as KvCommitError);
        }
        const versionstamp = this.#nextVersionstamp();
        for (const mutation of mutations) {
          this.#entries.set(this.#keyOf(mutation.key), { key: mutation.key, value: mutation.value, versionstamp });
        }
        return Promise.resolve({ ok: true, versionstamp } as KvCommitResult);
      },
    };
    return operation as unknown as AtomicOperation;
  }

  close(): void {
    this.#entries.clear();
  }
}

const memoryKv = new MemoryKv();
setKvForTest(memoryKv as unknown as Kv);

const { API_KEY_NO_EXPIRATION_MS, API_KEY_NO_USAGE_LIMIT, PAID_FALLBACK_NO_LIMIT, apiKeyHashKey, apiKeyIdKey } = await import("../src/api-keys.ts");
const { API_KEY_USAGE_V3_REQUEST_PREFIX, API_KEY_USAGE_V3_WINDOW_PREFIX, apiKeyUsageV3WindowKey } = await import("../src/api-key-policy.ts");
const { apiKeyRequestLogPrefix } = await import("../src/analytics.ts");
const { handleAdminApiKeysDelete, handleAdminApiKeysRevoke, handleAdminApiKeysUnrevoke } = await import("../src/admin/api-key-mutations.ts");
const { admitPaidFallbackV3, deletePaidFallbackStateV3, releaseUndispatchedPaidFallbackV3 } = await import("../src/paid-fallback/ledger-admission.ts");
const {
  getPaidFallbackOutstandingV3,
  paidFallbackDeletionGuardV3Key,
  paidFallbackPendingV3Key,
  paidFallbackReconciliationLeaseV3Key,
  paidFallbackRequestV3Key,
  paidFallbackRequestV3Prefix,
  paidFallbackWindowV3Key,
} = await import("../src/paid-fallback/ledger-state.ts");
const { hasStrictPaidFallbackKeyPolicy } = await import("../src/paid-fallback/index.ts");
const { LOCAL_DEVELOPMENT_KEY_ID, ensureLocalDevelopmentApiKey, resolveLocalDevelopmentApiKeyPolicy, setLocalDevelopmentPricingDeadlineMsForTest } =
  await import("../src/auth/local-development-key.ts");
const { configureAdminAuthForListener, configureAdminAuthPeerForRequest, configureMacLocalAdminAuthBypassForListener } =
  await import("../src/auth/local-admin.ts");
const { authenticateClient, handleV1Auth } = await import("../src/auth/index.ts");
const { getKv } = await import("../src/kv.ts");
const kvEntry = await getKv();
assert.ok(kvEntry);

const loopbackAddress: NetAddr = { transport: "tcp", hostname: "127.0.0.1", port: 8000 };
const enabledOptions: ServeRuntimeOptions = Object.freeze({ disableAdminAuth: true });
const disabledOptions: ServeRuntimeOptions = Object.freeze({ disableAdminAuth: false });

const pricing: Awaited<ReturnType<LocalDevelopmentPricingInitializer>> = {
  paid_fallback_model_ids: ["gpt-6-astra"],
  paid_fallback_quota_per_credit: 1_000,
  paid_fallback_pricing_checked_at_ms: Date.now(),
  paid_fallback_max_exposure_microcredits: {},
};

const initializePolicy: LocalDevelopmentPricingInitializer = () => Promise.resolve(pricing);

const withPaidProviderKey = async (run: () => Promise<void>): Promise<void> => {
  const previous = process.env.SURPLUS_API_KEY;
  process.env.SURPLUS_API_KEY = "test-surplus-key";
  try {
    await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = previous;
  }
};

test("loopback development provisions one unlimited, non-expiring local API key", async () => {
  await withPaidProviderKey(async () => {
    const status = await ensureLocalDevelopmentApiKey(memoryKv as unknown as Kv, { initializePolicy });
    assert.equal(status, "created");

    const idEntry = await memoryKv.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID));
    const record = idEntry.value as Record<string, unknown>;
    assert.ok(record);
    assert.equal(hasStrictPaidFallbackKeyPolicy(record), true);
    assert.equal(record.paid_fallback_enabled, true);
    assert.equal(record.paid_fallback_limit_microcredits, PAID_FALLBACK_NO_LIMIT);
    assert.equal(record.usage_limit_requests, API_KEY_NO_USAGE_LIMIT);
    assert.equal(record.expires_at_ms, API_KEY_NO_EXPIRATION_MS);
    assert.equal(record.revoked_at_ms, null);

    // The quota ledger reads the hash row by `policy.token_hash`, so both rows
    // and the initial usage window must exist.
    assert.ok(await memoryKv.get(apiKeyHashKey(record.hash as string)));
    const policy = await resolveLocalDevelopmentApiKeyPolicy(memoryKv as unknown as Kv);
    assert.ok(policy);
    assert.equal(policy.key_id, LOCAL_DEVELOPMENT_KEY_ID);
    assert.equal(policy.paid_fallback_enabled, true);
    assert.equal(policy.paid_fallback_limit_microcredits, PAID_FALLBACK_NO_LIMIT);
    assert.equal(policy.usage_limit_requests, API_KEY_NO_USAGE_LIMIT);
    assert.ok(await memoryKv.get(apiKeyUsageV3WindowKey(policy)));
  });
});

test("local development key provisioning is idempotent and never rewrites a record", async () => {
  await withPaidProviderKey(async () => {
    const before = await memoryKv.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID));
    const status = await ensureLocalDevelopmentApiKey(memoryKv as unknown as Kv, { initializePolicy });
    assert.equal(status, "present");
    const after = await memoryKv.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID));
    assert.equal(after.versionstamp, before.versionstamp);
  });
});

test("local development key provisioning reports an unavailable pricing snapshot without writing", async () => {
  await withPaidProviderKey(async () => {
    const isolated = new MemoryKv();
    const status = await ensureLocalDevelopmentApiKey(isolated as unknown as Kv, {
      initializePolicy: () => Promise.reject(new Error("pricing unavailable")),
    });
    assert.equal(status, "unavailable");
    const idEntry = await isolated.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID));
    assert.equal(idEntry.value, null);
  });
});

test("local development key provisioning bounds a pricing initializer that never settles", async () => {
  await withPaidProviderKey(async () => {
    const isolated = new MemoryKv();
    let entered = 0;
    const enteredSignals: AbortSignal[] = [];
    let resolvePricing: (value: Awaited<ReturnType<LocalDevelopmentPricingInitializer>>) => void = () => {};
    const pendingPricing = new Promise<Awaited<ReturnType<LocalDevelopmentPricingInitializer>>>((resolve) => {
      resolvePricing = resolve;
    });
    setLocalDevelopmentPricingDeadlineMsForTest(1_000);
    try {
      const startedAt = performance.now();
      const status = await ensureLocalDevelopmentApiKey(isolated as unknown as Kv, {
        initializePolicy: (signal) => {
          entered += 1;
          if (signal) enteredSignals.push(signal);
          return pendingPricing;
        },
      });
      const elapsedMs = performance.now() - startedAt;
      // Entry proves the fixed deadline ended the wait rather than a skipped initializer.
      assert.equal(entered, 1);
      assert.equal(status, "unavailable");
      assert.ok(elapsedMs >= 750, `provisioning must wait for the deadline (${Math.round(elapsedMs)}ms)`);
      assert.ok(elapsedMs < 10_000, `provisioning must stay bounded (${Math.round(elapsedMs)}ms)`);
      // The abandoned attempt is still handed a cooperative abort at the deadline.
      // Read through the array: a `let` assigned only inside the initializer stays
      // narrowed to its null initializer under control-flow analysis.
      const enteredSignal = enteredSignals.at(0);
      assert.equal(enteredSignal?.aborted, true);
      assert.equal(enteredSignal.reason.name, "TimeoutError");
      assert.equal((await isolated.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID))).value, null);
      // A late result from the abandoned attempt must never publish a key.
      resolvePricing(pricing);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal((await isolated.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID))).value, null);
    } finally {
      setLocalDevelopmentPricingDeadlineMsForTest(null);
    }
  });
});

test("local development key provisioning keeps a normal pricing initialization inside the deadline", async () => {
  await withPaidProviderKey(async () => {
    const isolated = new MemoryKv();
    setLocalDevelopmentPricingDeadlineMsForTest(1_000);
    try {
      assert.equal(await ensureLocalDevelopmentApiKey(isolated as unknown as Kv, { initializePolicy }), "created");
      const record = (await isolated.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID))).value as Record<string, unknown> | null;
      assert.ok(record);
      assert.deepEqual(record.paid_fallback_model_ids, pricing.paid_fallback_model_ids);
      assert.equal(record.paid_fallback_pricing_checked_at_ms, pricing.paid_fallback_pricing_checked_at_ms);
    } finally {
      setLocalDevelopmentPricingDeadlineMsForTest(null);
    }
  });
});

test("local development key provisioning discards a cancelled pricing snapshot", async () => {
  await withPaidProviderKey(async () => {
    const isolated = new MemoryKv();
    const controller = new AbortController();
    let entered = 0;
    let resolvePricing: (value: Awaited<ReturnType<LocalDevelopmentPricingInitializer>>) => void = () => {};
    const pendingPricing = new Promise<Awaited<ReturnType<LocalDevelopmentPricingInitializer>>>((resolve) => {
      resolvePricing = resolve;
    });
    const attempt = ensureLocalDevelopmentApiKey(isolated as unknown as Kv, {
      signal: controller.signal,
      initializePolicy: () => {
        entered += 1;
        return pendingPricing;
      },
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    assert.equal(await attempt, "unavailable");
    assert.equal(entered, 1);
    resolvePricing(pricing);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await isolated.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID))).value, null);
  });
});

test("the hostname-only legacy fallback never attaches the paid local development key", async () => {
  // Control: the paid principal exists, so a hostname-only decision would
  // attach it. The checked bypass is active with a loopback peer bound, exactly
  // as the loopback development server configures them.
  assert.ok(await resolveLocalDevelopmentApiKeyPolicy(memoryKv as unknown as Kv));
  configureAdminAuthForListener(enabledOptions, loopbackAddress);
  configureAdminAuthPeerForRequest(loopbackAddress);
  const legacyRequest = (headers?: HeadersInit) => new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", headers });

  try {
    // A mismatching Origin fails the peer/origin-checked path, leaving only the
    // legacy hostname fallback: it must stay policy-free.
    const crossOriginAuth = await authenticateClient(legacyRequest({ origin: "https://attacker.example" }));
    if (!crossOriginAuth.ok) throw new Error("The legacy fallback still authenticates loopback hostname requests");
    assert.equal(crossOriginAuth.method.kind, "disabled");

    const whoami = await handleV1Auth(legacyRequest({ origin: "https://attacker.example" }));
    assert.equal(whoami.status, 200);
    const body = await whoami.json();
    assert.equal(body.auth.mode, "disabled");
    assert.equal(body.auth.method.kind, "disabled");
    assert.equal(body.auth.is_admin, false);
    assert.equal(body.auth.is_super_admin, false);
    assert.equal("key" in body.auth.method, false);

    // The same loopback hostname with a matching Origin passes the checked
    // bypass and still receives the paid local principal.
    const sameOriginAuth = await authenticateClient(legacyRequest({ origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" }));
    if (!sameOriginAuth.ok) throw new Error("Same-origin loopback requests authenticate without a credential");
    if (sameOriginAuth.method.kind !== "kv_api_key") throw new Error("Expected the checked loopback paid principal");
    assert.equal(sameOriginAuth.method.key_id, LOCAL_DEVELOPMENT_KEY_ID);
    assert.equal(sameOriginAuth.method.policy.paid_fallback_enabled, true);
  } finally {
    configureAdminAuthForListener(disabledOptions, loopbackAddress);
    configureAdminAuthPeerForRequest(null);
  }
});

test("the hostname-only legacy fallback stays policy-free without a local development key", async () => {
  const isolated = new MemoryKv();
  try {
    setKvForTest(isolated as unknown as Kv);
    assert.equal(await resolveLocalDevelopmentApiKeyPolicy(isolated as unknown as Kv), null);
    configureAdminAuthForListener(enabledOptions, loopbackAddress);
    configureAdminAuthPeerForRequest(loopbackAddress);
    const auth = await authenticateClient(
      new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", headers: { origin: "https://attacker.example" } })
    );
    if (!auth.ok) throw new Error("The legacy fallback still authenticates loopback hostname requests");
    assert.equal(auth.method.kind, "disabled");
  } finally {
    configureAdminAuthForListener(disabledOptions, loopbackAddress);
    configureAdminAuthPeerForRequest(null);
    setKvForTest(memoryKv as unknown as Kv);
  }
});

test("the loopback bypass authenticates as the unlimited local development key", async () => {
  await withPaidProviderKey(async () => {
    // 127.42.9.3 is inside 127.0.0.0/8 but outside the legacy dev-host list, so
    // these requests exercise the explicit listener bypass only.
    const localRequest = () => new Request("http://127.42.9.3/v1/chat/completions", { method: "POST" });
    configureAdminAuthForListener(enabledOptions, loopbackAddress);
    configureAdminAuthPeerForRequest(loopbackAddress);
    try {
      const localAuth = await authenticateClient(localRequest());
      if (!localAuth.ok) throw new Error("Loopback requests authenticate without a credential");
      if (localAuth.method.kind !== "kv_api_key") throw new Error("Expected the local development key principal");
      assert.equal(localAuth.method.key_id, LOCAL_DEVELOPMENT_KEY_ID);
      assert.equal(localAuth.method.policy.paid_fallback_enabled, true);
      assert.equal(localAuth.method.policy.paid_fallback_limit_microcredits, PAID_FALLBACK_NO_LIMIT);
      assert.equal(localAuth.method.policy.usage_limit_requests, API_KEY_NO_USAGE_LIMIT);

      // Revoking the local key is the operator's off switch: the principal
      // degrades to the policy-free `disabled` method instead of failing auth.
      const idKey = apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID);
      const record = (await memoryKv.get(idKey)).value as Record<string, unknown>;
      await memoryKv.set(idKey, { ...record, revoked_at_ms: Date.now() });
      assert.equal(await resolveLocalDevelopmentApiKeyPolicy(memoryKv as unknown as Kv), null);
      const revokedAuth = await authenticateClient(localRequest());
      if (!revokedAuth.ok) throw new Error("Loopback requests stay authenticated");
      assert.equal(revokedAuth.method.kind, "disabled");

      // A non-loopback peer never receives the local principal.
      configureAdminAuthPeerForRequest({ transport: "tcp", hostname: "192.0.2.10", port: 8000 });
      const remoteAuth = await authenticateClient(localRequest());
      assert.equal(remoteAuth.ok, false);
    } finally {
      configureAdminAuthForListener(disabledOptions, loopbackAddress);
      configureAdminAuthPeerForRequest(null);
    }
  });
});

test("the Mac LAN listener grants the local principal to an actual loopback peer only", async () => {
  await withPaidProviderKey(async () => {
    // Both requests use a loopback URL; only the bound peer decides, so a LAN
    // client that forges a loopback Host is still authenticated.
    const localRequest = new Request("http://127.42.9.3/v1/chat/completions", { method: "POST" });
    const lanRequest = new Request("http://127.42.9.3/v1/chat/completions", { method: "POST" });
    configureMacLocalAdminAuthBypassForListener({ transport: "tcp", hostname: "0.0.0.0", port: 7999 });
    try {
      configureAdminAuthPeerForRequest({ transport: "tcp", hostname: "127.0.0.1", port: 7999 }, localRequest);
      configureAdminAuthPeerForRequest({ transport: "tcp", hostname: "192.0.2.10", port: 7999 }, lanRequest);

      const lanAuth = await authenticateClient(lanRequest);
      if (lanAuth.ok) throw new Error("A LAN peer must stay authenticated");
      assert.equal(lanAuth.response.status, 401);

      const localAuth = await authenticateClient(localRequest);
      if (!localAuth.ok) throw new Error("Loopback requests authenticate without a credential");
      // The revocation case above may degrade the principal to the policy-free
      // `disabled` method; the local development key path is asserted there.
      assert.ok(localAuth.method.kind === "kv_api_key" || localAuth.method.kind === "disabled");
    } finally {
      configureAdminAuthForListener(disabledOptions, loopbackAddress);
      configureAdminAuthPeerForRequest(null);
    }
  });
});

const localKeyMutationRequest = (id = LOCAL_DEVELOPMENT_KEY_ID) =>
  new Request("http://127.0.0.1/admin/api-keys", { method: "POST", body: JSON.stringify({ id }) });

const withNativeLocalKeyKv = async (run: (kv: Kv) => Promise<void>): Promise<void> => {
  const isolated = await openKv(":memory:");
  setKvForTest(isolated);
  try {
    await withPaidProviderKey(() => run(isolated));
  } finally {
    setKvForTest(memoryKv as unknown as Kv);
    isolated.close();
  }
};

test("native KV re-provisions a completely deleted local key and admits paid work", async () => {
  await withNativeLocalKeyKv(async (isolated) => {
    const idKey = apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID);
    const guardKey = paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID);
    const unrelatedGuardKey = paidFallbackDeletionGuardV3Key("unrelated-key");
    await isolated.set(unrelatedGuardKey, { created_at_ms: Date.now() });
    const unrelatedGuard = await isolated.get(unrelatedGuardKey);
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
    const originalPolicy = await resolveLocalDevelopmentApiKeyPolicy(isolated);
    assert.ok(originalPolicy);
    assert.equal((await handleAdminApiKeysRevoke(localKeyMutationRequest())).status, 200);
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "revoked");
    assert.equal((await handleAdminApiKeysDelete(localKeyMutationRequest())).status, 200);
    assert.equal((await isolated.get(idKey)).value, null);
    assert.equal((await isolated.get(apiKeyHashKey(originalPolicy.token_hash))).value, null);
    assert.equal((await isolated.get(apiKeyUsageV3WindowKey(originalPolicy))).value, null);
    const completedGuard = (await isolated.get<Record<string, unknown>>(guardKey)).value;
    assert.ok(completedGuard);
    const completion = completedGuard.local_deletion as Record<string, unknown>;
    assert.equal(typeof completion.owner, "string");
    assert.equal(typeof completion.completed_at_ms, "number");
    assert.equal((await getPaidFallbackOutstandingV3(LOCAL_DEVELOPMENT_KEY_ID, isolated))?.has_outstanding, false);

    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
    assert.equal((await isolated.get(guardKey)).value, null);
    assert.deepEqual(await isolated.get(unrelatedGuardKey), unrelatedGuard);
    const policy = await resolveLocalDevelopmentApiKeyPolicy(isolated);
    assert.ok(policy);
    assert.notEqual(policy.token_hash, originalPolicy.token_hash);
    const policyCheck = await isolated.get(apiKeyHashKey(policy.token_hash), { consistency: "strong" });
    const admission = await admitPaidFallbackV3({
      keyId: policy.key_id,
      requestId: "native-reprovision",
      createdAtMs: Date.now(),
      policyVersion: policy.policy_version,
      limitMicrocredits: policy.paid_fallback_limit_microcredits,
      maximumExposureMicrocredits: null,
      initialSettledMicrocredits: 0,
      quotaPerCredit: pricing.paid_fallback_quota_per_credit,
      windowResetAtMs: policy.usage_reset_at_ms,
      model: "gpt-6-astra",
      route: "responses",
      path: "/v1/responses",
      stream: false,
      reasoning: null,
      policyCheck,
    });
    assert.equal(admission.kind, "reserved");
    await releaseUndispatchedPaidFallbackV3(admission.reservation);
    assert.equal((await getPaidFallbackOutstandingV3(LOCAL_DEVELOPMENT_KEY_ID, isolated))?.has_outstanding, false);
  });
});

test("native KV retains local deletion guards while billing or cleanup remains", async () => {
  const fixtures: [KvKey, unknown][] = [
    [paidFallbackRequestV3Key(LOCAL_DEVELOPMENT_KEY_ID, "pending"), { billing_state: "pending" }],
    [paidFallbackRequestV3Key(LOCAL_DEVELOPMENT_KEY_ID, "unresolved"), { billing_state: "unresolved" }],
    [paidFallbackPendingV3Key(LOCAL_DEVELOPMENT_KEY_ID, "pending-marker"), { created_at_ms: Date.now() }],
    [paidFallbackRequestV3Key(LOCAL_DEVELOPMENT_KEY_ID, "settled"), { billing_state: "settled" }],
    [paidFallbackWindowV3Key(LOCAL_DEVELOPMENT_KEY_ID, Date.now()), { pending_count: 0 }],
    [paidFallbackReconciliationLeaseV3Key(LOCAL_DEVELOPMENT_KEY_ID), { token: "synthetic", expires_at_ms: Date.now() + 60_000 }],
    [[...API_KEY_USAGE_V3_WINDOW_PREFIX, LOCAL_DEVELOPMENT_KEY_ID, "old-policy", 1], { reserved_requests: 0 }],
    [[...API_KEY_USAGE_V3_REQUEST_PREFIX, LOCAL_DEVELOPMENT_KEY_ID, "old-policy", 1, "old-request"], { state: "committed" }],
    [[...apiKeyRequestLogPrefix(LOCAL_DEVELOPMENT_KEY_ID), 1, "old-request"], { request_id: "old-request" }],
  ];
  for (const [key, value] of fixtures) {
    await withNativeLocalKeyKv(async (isolated) => {
      const guardKey = paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID);
      await isolated.set(guardKey, { created_at_ms: Date.now(), local_deletion: { owner: "synthetic-completed", completed_at_ms: Date.now() } });
      const guard = await isolated.get(guardKey);
      await isolated.set(key, value);
      const retained = await isolated.get(key);
      assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "conflict", JSON.stringify(key));
      assert.equal((await isolated.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID))).value, null);
      assert.deepEqual(await isolated.get(guardKey), guard);
      assert.deepEqual(await isolated.get(key), retained);
    });
  }
});

test("native KV deletion guard CAS rejects a concurrent deletion during local provisioning", async () => {
  for (const retainedGuard of [false, true]) {
    await withNativeLocalKeyKv(async (isolated) => {
      const guardKey = paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID);
      if (retainedGuard) await isolated.set(guardKey, { created_at_ms: 1, local_deletion: { owner: "synthetic-completed", completed_at_ms: 2 } });
      let concurrentGuard: KvEntryMaybe<unknown> | null = null;
      assert.equal(
        await ensureLocalDevelopmentApiKey(isolated, {
          initializePolicy: async () => {
            if (retainedGuard) await isolated.set(guardKey, { created_at_ms: 2 });
            else assert.equal((await deletePaidFallbackStateV3(LOCAL_DEVELOPMENT_KEY_ID, isolated)).kind, "deleted");
            concurrentGuard = await isolated.get(guardKey);
            return pricing;
          },
        }),
        "conflict"
      );
      assert.ok(concurrentGuard);
      assert.deepEqual(await isolated.get(guardKey), concurrentGuard);
      assert.equal((await isolated.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID))).value, null);
      const entries = [];
      for await (const entry of isolated.list({ prefix: API_KEY_USAGE_V3_WINDOW_PREFIX })) entries.push(entry);
      assert.equal(entries.length, 0);
    });
  }
});

test("native KV keeps provisioning blocked while old deletion scans an empty usage prefix", async () => {
  for (const staleOwner of [false, true])
    await withNativeLocalKeyKv(async (isolated) => {
      assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
      const policy = await resolveLocalDevelopmentApiKeyPolicy(isolated);
      assert.ok(policy);
      // An expired old window leaves an empty prefix before deletion starts.
      await isolated.delete(apiKeyUsageV3WindowKey(policy));
      assert.equal((await handleAdminApiKeysRevoke(localKeyMutationRequest())).status, 200);
      let enterCleanup = (): void => {};
      const cleanupEntered = new Promise<void>((resolve) => {
        enterCleanup = resolve;
      });
      let resumeCleanup = (): void => {};
      const cleanupResumed = new Promise<void>((resolve) => {
        resumeCleanup = resolve;
      });
      const originalList = isolated.list.bind(isolated);
      let pausedCleanup = false;
      isolated.list = <T>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> => {
        const iterator = originalList<T>(selector, options);
        if (!pausedCleanup && JSON.stringify(selector) === JSON.stringify({ prefix: [...API_KEY_USAGE_V3_WINDOW_PREFIX, LOCAL_DEVELOPMENT_KEY_ID] })) {
          pausedCleanup = true;
          const originalNext = iterator.next.bind(iterator);
          iterator.next = async () => {
            enterCleanup();
            await cleanupResumed;
            return await originalNext();
          };
        }
        return iterator;
      };
      const deletion = handleAdminApiKeysDelete(localKeyMutationRequest());
      let replacementGuard: KvEntryMaybe<unknown> | null = null;
      try {
        await cleanupEntered;
        assert.equal((await isolated.get(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID))).value, null);
        assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "conflict");
        if (staleOwner) {
          await isolated.set(paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID), {
            created_at_ms: Date.now(),
            local_deletion: { owner: "replacement-owner", completed_at_ms: null },
          });
          replacementGuard = await isolated.get(paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID));
        }
      } finally {
        resumeCleanup();
        assert.equal((await deletion).status, staleOwner ? 409 : 200);
        isolated.list = originalList;
      }
      if (staleOwner) {
        assert.deepEqual(await isolated.get(paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID)), replacementGuard);
        assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "conflict");
      } else {
        assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
        const replacement = await resolveLocalDevelopmentApiKeyPolicy(isolated);
        assert.ok(replacement);
        assert.ok((await isolated.get(apiKeyUsageV3WindowKey(replacement))).value);
      }
    });
});

test("native KV local deletion refuses overlapping and crashed owners without changing other guards", async () => {
  await withNativeLocalKeyKv(async (isolated) => {
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
    const idKey = apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID);
    const record = (await isolated.get<Record<string, unknown>>(idKey)).value;
    assert.ok(record);
    assert.equal((await handleAdminApiKeysRevoke(localKeyMutationRequest(LOCAL_DEVELOPMENT_KEY_ID))).status, 200);
    let entered = (): void => {};
    const enter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume = (): void => {};
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalList = isolated.list.bind(isolated);
    let paused = false;
    isolated.list = <T>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> => {
      const iterator = originalList<T>(selector, options);
      if (!paused && JSON.stringify(selector) === JSON.stringify({ prefix: paidFallbackRequestV3Prefix(LOCAL_DEVELOPMENT_KEY_ID) })) {
        paused = true;
        const next = iterator.next.bind(iterator);
        iterator.next = async () => {
          entered();
          await resumed;
          return await next();
        };
      }
      return iterator;
    };
    const firstDeletion = handleAdminApiKeysDelete(localKeyMutationRequest(LOCAL_DEVELOPMENT_KEY_ID));
    try {
      await enter;
      const guardKey = paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID);
      const claimed = await isolated.get(guardKey);
      assert.equal((await handleAdminApiKeysDelete(localKeyMutationRequest(LOCAL_DEVELOPMENT_KEY_ID))).status, 409);
      assert.equal((await handleAdminApiKeysUnrevoke(localKeyMutationRequest(LOCAL_DEVELOPMENT_KEY_ID))).status, 409);
      assert.deepEqual(await isolated.get(guardKey), claimed);
      assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "revoked");
    } finally {
      resume();
      assert.equal((await firstDeletion).status, 200);
      isolated.list = originalList;
    }

    // A different ID keeps the original retained-guard deletion semantics.
    const otherId = "unrelated-key";
    const otherGuardKey = paidFallbackDeletionGuardV3Key(otherId);
    await isolated.set(apiKeyIdKey(otherId), { ...record, id: otherId, hash: "synthetic-other-hash", revoked_at_ms: Date.now() });
    await isolated.set(otherGuardKey, { created_at_ms: Date.now() });
    const otherGuard = await isolated.get(otherGuardKey);
    assert.equal((await handleAdminApiKeysDelete(localKeyMutationRequest(otherId))).status, 200);
    assert.deepEqual(await isolated.get(otherGuardKey), otherGuard);

    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
    assert.equal((await handleAdminApiKeysRevoke(localKeyMutationRequest(LOCAL_DEVELOPMENT_KEY_ID))).status, 200);
    const guardKey = paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID);
    await isolated.set(guardKey, { created_at_ms: Date.now(), local_deletion: { owner: "crashed-owner", completed_at_ms: null } });
    const crashed = await isolated.get(guardKey);
    assert.equal((await handleAdminApiKeysDelete(localKeyMutationRequest(LOCAL_DEVELOPMENT_KEY_ID))).status, 409);
    assert.deepEqual(await isolated.get(guardKey), crashed);
    await isolated.delete(idKey);
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "conflict");
    assert.deepEqual(await isolated.get(guardKey), crashed);
    await isolated.set(guardKey, { created_at_ms: Date.now() });
    const legacyGuard = await isolated.get(guardKey);
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "conflict");
    assert.deepEqual(await isolated.get(guardKey), legacyGuard);
  });
});

test("native KV known outstanding billing refusal releases only its local owner for explicit retry", async () => {
  await withNativeLocalKeyKv(async (isolated) => {
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
    assert.equal((await handleAdminApiKeysRevoke(localKeyMutationRequest())).status, 200);
    const pendingKey = paidFallbackRequestV3Key(LOCAL_DEVELOPMENT_KEY_ID, "pending-billing");
    await isolated.set(pendingKey, { billing_state: "pending" });
    assert.equal((await handleAdminApiKeysDelete(localKeyMutationRequest())).status, 409);
    const guardKey = paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID);
    const guard = (await isolated.get<Record<string, unknown>>(guardKey)).value;
    assert.ok(guard);
    assert.deepEqual(guard.local_deletion, { owner: null, completed_at_ms: null });
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "revoked");
    await isolated.delete(pendingKey);
    assert.equal((await handleAdminApiKeysDelete(localKeyMutationRequest())).status, 200);
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
  });
});

test("native KV releases a local owner after a concurrent revoked-record update", async () => {
  await withNativeLocalKeyKv(async (isolated) => {
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
    assert.equal((await handleAdminApiKeysRevoke(localKeyMutationRequest())).status, 200);

    let entered = (): void => {};
    const enter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume = (): void => {};
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalList = isolated.list.bind(isolated);
    let paused = false;
    isolated.list = <T>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> => {
      const iterator = originalList<T>(selector, options);
      if (!paused && JSON.stringify(selector) === JSON.stringify({ prefix: paidFallbackRequestV3Prefix(LOCAL_DEVELOPMENT_KEY_ID) })) {
        paused = true;
        const next = iterator.next.bind(iterator);
        iterator.next = async () => {
          entered();
          await resumed;
          return await next();
        };
      }
      return iterator;
    };

    const deletion = handleAdminApiKeysDelete(localKeyMutationRequest());
    try {
      await enter;
      const guardKey = paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID);
      const claimed = await isolated.get<Record<string, unknown>>(guardKey);
      const claimedGuard = claimed.value as { local_deletion?: { owner?: unknown } } | null;
      assert.equal(typeof claimedGuard?.local_deletion?.owner, "string");
      assert.equal((await handleAdminApiKeysDelete(localKeyMutationRequest())).status, 409);
      assert.equal((await handleAdminApiKeysUnrevoke(localKeyMutationRequest())).status, 409);
      assert.deepEqual(await isolated.get(guardKey), claimed);

      // This repeats the revoked record write after the local owner is claimed.
      assert.equal((await handleAdminApiKeysRevoke(localKeyMutationRequest())).status, 200);
    } finally {
      resume();
      assert.equal((await deletion).status, 409);
      isolated.list = originalList;
    }

    const released = (await isolated.get<Record<string, unknown>>(paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID))).value;
    assert.deepEqual(released?.local_deletion, { owner: null, completed_at_ms: null });
    assert.equal((await handleAdminApiKeysDelete(localKeyMutationRequest())).status, 200);
    assert.equal(await ensureLocalDevelopmentApiKey(isolated, { initializePolicy }), "created");
  });
});
