import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import { type AtomicOperation, type Kv, type KvCommitResult, type KvEntryMaybe, type KvKey } from "#kv";
import assert from "node:assert/strict";
import {
  CODEX_AUTH_POOL_KV_KEY,
  fetchCodexResponses,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  markCodexResponseCompleted,
  resetCodexAuthCacheForTest,
} from "../src/codex/index.ts";
import { resetCodexAccountRoutingForTest } from "../src/codex/account-routing.ts";
import { setKvForTest } from "../src/kv.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";
import { sha256Hex } from "../src/utils.ts";

/**
 * Ordinary routing is one durable global active subscription. The retired
 * per-key affinity records are still present in production KV; this fixture
 * proves they are never read for selection and never rewritten by inference.
 */
const OLD_AFFINITY_PREFIX = ["uos_ai", "codex_account_affinity", "v1"] as const;

type StoredValue = Readonly<{ value: unknown; version: number }>;

const keyOf = (key: KvKey): string => JSON.stringify(key);
const versionstamp = (version: number): string => String(version).padStart(20, "0");

class AffinityKv {
  readonly values = new Map<string, StoredValue>();

  put(key: KvKey, value: unknown): void {
    const encoded = keyOf(key);
    this.values.set(encoded, { value, version: (this.values.get(encoded)?.version ?? 0) + 1 });
  }

  get<T>(key: KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored?.value ?? null) as T | null,
      versionstamp: stored ? versionstamp(stored.version) : null,
    } as KvEntryMaybe<T>);
  }

  getMany<T extends readonly unknown[]>(keys: readonly KvKey[]): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }> {
    // Snapshot every value and versionstamp synchronously so one resolved tuple
    // cannot mix rows from different write generations.
    const snapshot = keys.map((key) => {
      const stored = this.values.get(keyOf(key));
      return {
        key,
        value: (stored?.value ?? null) as T[number] | null,
        versionstamp: stored ? versionstamp(stored.version) : null,
      } as KvEntryMaybe<T[number]>;
    });
    return Promise.resolve(snapshot as { [K in keyof T]: KvEntryMaybe<T[K]> });
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    this.put(key, value);
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({ ok: true, versionstamp: versionstamp(stored?.version ?? 1) } satisfies KvCommitResult);
  }

  atomic(): AtomicOperation {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const writes: { key: KvKey; value: unknown }[] = [];
    const chain = {
      check: (...entries: { key: KvKey; versionstamp: string | null }[]) => {
        checks.push(...entries);
        return chain;
      },
      set: (key: KvKey, value: unknown) => {
        writes.push({ key, value });
        return chain;
      },
      commit: () => {
        for (const entry of checks) {
          const stored = this.values.get(keyOf(entry.key));
          const current = stored ? versionstamp(stored.version) : null;
          if (current !== entry.versionstamp) return Promise.resolve({ ok: false } as const);
        }
        for (const write of writes) this.put(write.key, write.value);
        const last = writes.at(-1);
        const stored = last ? this.values.get(keyOf(last.key)) : undefined;
        return Promise.resolve({ ok: true, versionstamp: versionstamp(stored?.version ?? 1) } as const);
      },
    };
    return chain as unknown as AtomicOperation;
  }
}

const account = (label: string): CodexAuthState => ({
  account_id: `account-${label}`,
  access_token: `access-${label}`,
  refresh_token: `refresh-${label}`,
  updated_at_ms: Date.now(),
});

const oldAffinityRow = (targetAccountId: string): Readonly<{ account_cohort_hash: string; expires_at_ms: number }> => ({
  account_cohort_hash: `uos-prompt-cache-account-cohort-v1\u0000${targetAccountId}`,
  expires_at_ms: Date.now() + 60 * 60_000,
});

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};
const accountHeader = (init?: RequestInit): string => new Headers(init?.headers).get("ChatGPT-Account-ID") ?? "";

test("opposing old persisted affinity rows never split ordinary traffic", async () => {
  const kv = new AffinityKv();
  const originalFetch = globalThis.fetch;
  const pool: CodexAuthPoolState = { accounts: [account("one"), account("two")], updated_at_ms: Date.now() };
  const affinityIdentity = await sha256Hex("uos_ai\u0000codex_account_affinity_identity_v1\u0000fixture-principal\u0000fixture-key");
  const oldRowKey = [...OLD_AFFINITY_PREFIX, affinityIdentity] as const;
  const oldRow = oldAffinityRow("account-two");
  kv.put(CODEX_AUTH_POOL_KV_KEY, pool);
  kv.put(oldRowKey, oldRow);
  const storedBefore = JSON.stringify(kv.values.get(keyOf(oldRowKey)));
  const calls: string[] = [];
  const sessions: (string | null)[] = [];
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();

  try {
    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.endsWith("/responses")) return Promise.resolve(new Response("unexpected", { status: 404 }));
      calls.push(accountHeader(init));
      sessions.push(new Headers(init?.headers).get("session-id"));
      return Promise.resolve(new Response(JSON.stringify({ id: `response-${calls.length}` }), { status: 200 }));
    });

    // Same explicit key twice, a different key, and no key at all: the durable
    // active account is the first configured account for every request.
    for (const body of [
      { model: "gpt-affinity-fixture", input: "same-key-1", prompt_cache_key: "fixture-key" },
      { model: "gpt-affinity-fixture", input: "same-key-2", prompt_cache_key: "fixture-key" },
      { model: "gpt-affinity-fixture", input: "different-key", prompt_cache_key: "other-key" },
      { model: "gpt-affinity-fixture", input: "unkeyed" },
    ]) {
      const response = await fetchCodexResponses(body, { cacheScope: "fixture-principal" });
      assert.equal(response.status, 200);
      assert.deepEqual(getCodexResponseActiveTelemetry(response), { activeGeneration: 1, activeTransitionReason: null });
      assert.equal(getCodexResponseSlot(response), 1);
      await markCodexResponseCompleted(response);
      await response.arrayBuffer();
    }

    assert.deepEqual(calls, ["account-one", "account-one", "account-one", "account-one"]);
    assert.equal(sessions[0], sessions[1], "the repeated explicit cache key keeps one native session identity");
    assert.notEqual(sessions[1], sessions[2]);
    assert.equal(sessions[3], null);
    assert.equal(JSON.stringify(kv.values.get(keyOf(oldRowKey))), storedBefore, "retired affinity rows are neither read nor rewritten");
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
  }
});

test("a retired affinity row cannot keep traffic on an authoritatively exhausted account", async () => {
  const kv = new AffinityKv();
  const originalFetch = globalThis.fetch;
  const pool: CodexAuthPoolState = { accounts: [account("one"), account("two")], updated_at_ms: Date.now() };
  const affinityIdentity = await sha256Hex("uos_ai\u0000codex_account_affinity_identity_v1\u0000fixture-principal\u0000fixture-key");
  const oldRowKey = [...OLD_AFFINITY_PREFIX, affinityIdentity] as const;
  kv.put(CODEX_AUTH_POOL_KV_KEY, pool);
  kv.put(oldRowKey, oldAffinityRow("account-one"));
  const storedBefore = JSON.stringify(kv.values.get(keyOf(oldRowKey)));
  const calls: string[] = [];
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();

  try {
    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.endsWith("/responses")) return Promise.resolve(new Response("unexpected", { status: 404 }));
      const accountId = accountHeader(init);
      calls.push(accountId);
      if (accountId === "account-one") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": new Date(Date.now() + 3_600_000).toUTCString() },
          })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "served-by-sibling" }), { status: 200 }));
    });

    const first = await fetchCodexResponses(
      { model: "gpt-affinity-fixture", input: "exhaust", prompt_cache_key: "fixture-key" },
      { cacheScope: "fixture-principal" }
    );
    assert.equal(first.status, 200);
    assert.deepEqual(calls, ["account-one", "account-two"]);
    assert.deepEqual(getCodexResponseActiveTelemetry(first), { activeGeneration: 2, activeTransitionReason: "quota_exhausted" });
    await markCodexResponseCompleted(first);
    await first.arrayBuffer();

    // The old affinity row points at the exhausted account and must not pull
    // later traffic back to it.
    const second = await fetchCodexResponses(
      { model: "gpt-affinity-fixture", input: "after-switch", prompt_cache_key: "fixture-key" },
      { cacheScope: "fixture-principal" }
    );
    assert.equal(second.status, 200);
    assert.equal(calls.at(-1), "account-two");
    await markCodexResponseCompleted(second);
    await second.arrayBuffer();
    assert.equal(JSON.stringify(kv.values.get(keyOf(oldRowKey))), storedBefore);
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
  }
});

test("a late retired affinity row cannot restore the former active account", async () => {
  const kv = new AffinityKv();
  const originalFetch = globalThis.fetch;
  const pool: CodexAuthPoolState = { accounts: [account("one"), account("two")], updated_at_ms: Date.now() };
  const calls: string[] = [];
  kv.put(CODEX_AUTH_POOL_KV_KEY, pool);
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();

  try {
    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.endsWith("/responses")) return Promise.resolve(new Response("unexpected", { status: 404 }));
      const accountId = accountHeader(init);
      calls.push(accountId);
      if (accountId === "account-one") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": new Date(Date.now() + 60_000).toUTCString() },
          })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "sibling" }), { status: 200 }));
    });

    const switched = await fetchCodexResponses({ model: "gpt-affinity-fixture", input: "switch" });
    assert.equal(switched.status, 200);
    await markCodexResponseCompleted(switched);
    await switched.arrayBuffer();
    assert.deepEqual(calls, ["account-one", "account-two"]);

    // A stale writer (or old isolate) can only write the retired record; the
    // next admission still uses the durable active account.
    kv.put([...OLD_AFFINITY_PREFIX, await sha256Hex("late-affinity-identity")], oldAffinityRow("account-one"));
    const next = await fetchCodexResponses({ model: "gpt-affinity-fixture", input: "after-late-row" });
    assert.equal(next.status, 200);
    assert.equal(calls.at(-1), "account-two");
    assert.deepEqual(getCodexResponseActiveTelemetry(next), { activeGeneration: 2, activeTransitionReason: "quota_exhausted" });
    await markCodexResponseCompleted(next);
    await next.arrayBuffer();
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
  }
});
