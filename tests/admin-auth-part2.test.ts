import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { KvU64 } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/admin-auth-harness.ts";
// admin-auth suite part: tests moved out of tests/admin-auth.test.ts.

import assert from "node:assert/strict";
import {
  handleAdminApiKeysCreate,
  handleAdminApiKeysDelete,
  handleAdminApiKeysPaidFallbacks,
  handleAdminApiKeysUnrevoke,
  handleAdminCodexResetSettings,
  keyToString,
  kvStore,
  kvStoreHasPrefix,
  listApiKeyRequestLogs,
  recordApiKeyRequestLog,
  setAtomicCommitsBeforeFailure,
  setAtomicCommitsToFail,
  urlOf,
} from "./helpers/admin-auth-harness.ts";

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("admin paid fallback history exposes V3 request lifecycle and billing fields", async () => {
  kvStore.clear();
  const keyId = "4ba83596-d68e-447a-9281-0f1c92e8a87e";
  kvStore.set(keyToString(["ubq_ai", "api_keys", "id", keyId]), {
    id: keyId,
    name: "Test key",
  });

  await recordApiKeyRequestLog(keyId, {
    route: "responses",
    path: "/v1/responses",
    method: "post",
    status_code: 200,
    stream: true,
    model: "gpt-5.6-sol",
    reasoning: "max",
    created_at_ms: 1_000,
  });
  await recordApiKeyRequestLog(keyId, {
    route: "chat.completions",
    path: "/v1/chat/completions",
    method: "post",
    status_code: 400,
    stream: false,
    model: "gpt-5.6-luna",
    reasoning: "high",
    created_at_ms: 2_000,
    provider: "voyage",
  });

  await recordApiKeyRequestLog(keyId, {
    route: "chat.completions",
    path: "/v1/chat/completions",
    method: "post",
    status_code: 200,
    stream: true,
    model: "google/gemini-2.5-flash",
    reasoning: null,
    created_at_ms: 3_000,
    provider: "openrouter",
  });

  const newest = await listApiKeyRequestLogs(keyId, { limit: 1 });
  assert.equal(newest.length, 1);
  assert.equal(newest[0].created_at_ms, 3_000);
  assert.equal(newest[0].method, "POST");
  assert.equal(newest[0].provider, "openrouter", "an OpenRouter request log keeps its own provider");
  const previous = await listApiKeyRequestLogs(keyId, { limit: 2 });
  assert.equal(previous[1].provider, "voyage");

  const settledRequest = {
    v: 3,
    key_id: keyId,
    request_id: "request-v3-settled",
    policy_version: "60000",
    route: "responses",
    path: "/v1/responses",
    model: "gpt-5.6-sol",
    stream: true,
    reasoning: "max",
    provider: "surplus",
    window_reset_at_ms: 61_000,
    reserved_microcredits: 125_000,
    quota_per_credit: 500_000,
    provider_request_id: "provider-v3-settled",
    provider_quota: 14.496,
    input_tokens: 31,
    output_tokens: 17,
    dispatch_state: "dispatched",
    terminal_state: "completed",
    spend_microcredits: 28_992,
    billing_state: "settled",
    reconciliation_attempts: 2,
    last_reconciliation_at_ms: 2_500,
    dispatched_at_ms: 1_100,
    terminal_at_ms: 2_000,
    settled_at_ms: 2_500,
    created_at_ms: 1_000,
    updated_at_ms: 2_500,
  } as const;
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, settledRequest.request_id]), settledRequest);

  const response = await handleAdminApiKeysPaidFallbacks(new Request(`https://ai.ubq.fi/admin/api-keys/${keyId}/paid-fallbacks?limit=20`), keyId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = (await response.json()) as {
    ok?: boolean;
    object?: string;
    data?: {
      created_at_ms?: number;
      request_id?: string;
      model?: string | null;
      reasoning?: string | null;
      provider?: string;
      reserved_microcredits?: number;
      dispatch_state?: string;
      terminal_state?: string;
      billing_state?: string;
      provider_request_id?: string | null;
      provider_quota?: number | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
      reconciliation_attempts?: number;
      last_reconciliation_at_ms?: number | null;
      spend_microcredits?: number | null;
      dispatched_at_ms?: number | null;
      terminal_at_ms?: number | null;
      settled_at_ms?: number | null;
    }[];
  };
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "ok"), false);
  assert.equal(payload.object, "list");
  assert.equal(payload.data?.length, 1);
  assert.equal(payload.data[0]?.request_id, settledRequest.request_id);
  assert.equal(payload.data[0]?.model, "gpt-5.6-sol");
  assert.equal(payload.data[0]?.reasoning, "max");
  assert.equal(payload.data[0]?.provider, "surplus");
  assert.equal(payload.data[0]?.reserved_microcredits, 125_000);
  assert.equal(payload.data[0]?.dispatch_state, "dispatched");
  assert.equal(payload.data[0]?.terminal_state, "completed");
  assert.equal(payload.data[0]?.billing_state, "settled");
  assert.equal(payload.data[0]?.provider_request_id, "provider-v3-settled");
  assert.equal(payload.data[0]?.provider_quota, 14.496);
  assert.equal(payload.data[0]?.input_tokens, 31);
  assert.equal(payload.data[0]?.output_tokens, 17);
  assert.equal(payload.data[0]?.reconciliation_attempts, 2);
  assert.equal(payload.data[0]?.last_reconciliation_at_ms, 2_500);
  assert.equal(payload.data[0]?.spend_microcredits, 28_992);
  assert.equal(payload.data[0]?.dispatched_at_ms, 1_100);
  assert.equal(payload.data[0]?.terminal_at_ms, 2_000);
  assert.equal(payload.data[0]?.settled_at_ms, 2_500);
});

test("authenticated UOS embeddings do not write ordinary request history", async () => {
  kvStore.clear();
  kvStore.set(keyToString(["uos_ai", "voyage_api_key"]), "voyage-test-key");
  const token = `u_${"a".repeat(64)}`;
  const createdResponse = await handleAdminApiKeysCreate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Voyage analytics route",
        token,
        usage_limit_requests: -1,
        paid_fallback_enabled: false,
      }),
    })
  );
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()) as { id?: unknown };
  assert.equal(typeof created.id, "string");
  const keyId = created.id as string;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    assert.equal(url, "https://api.voyageai.com/v1/embeddings");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as Record<string, unknown>;
    assert.equal(body.model, "voyage-4-large");
    assert.equal(body.input_type, "document");
    assert.equal(body.output_dimension, 1024);
    assert.equal(body.output_dtype, "float");
    assert.equal(body.truncation, false);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, (_, index) => index / 1024) }],
          usage: { total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  });

  try {
    const { default: handler } = await import("../src/handler/index.ts");
    const response = await handler(
      new Request("https://ai.ubq.fi/uos/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "voyage-4-large",
          input: "analytics provider proof",
          input_type: "document",
          dimensions: 1024,
          truncation: false,
          encoding_format: "float",
        }),
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "voyage");

    assert.deepEqual(await listApiKeyRequestLogs(keyId, { limit: 10 }), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API key request log endpoint validates key existence and limit", async () => {
  kvStore.clear();
  const missing = await handleAdminApiKeysPaidFallbacks(new Request("https://ai.ubq.fi/admin/api-keys/missing/paid-fallbacks?limit=20"), "missing");
  assert.equal(missing.status, 404);

  const keyId = "existing";
  kvStore.set(keyToString(["ubq_ai", "api_keys", "id", keyId]), { id: keyId });
  const invalidLimit = await handleAdminApiKeysPaidFallbacks(new Request(`https://ai.ubq.fi/admin/api-keys/${keyId}/paid-fallbacks?limit=not-a-number`), keyId);
  assert.equal(invalidLimit.status, 400);
});

test("deleting a revoked API key removes its mirrored policy and analytics", async () => {
  kvStore.clear();
  const keyId = "key-delete-cleanup";
  const neighboringKeyId = `${keyId}-neighbor`;
  const hash = "hash-delete-cleanup";
  const commonPolicy = {
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 2_000_000,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  kvStore.set(keyToString(["ubq_ai", "api_keys", "id", keyId]), {
    id: keyId,
    name: "Delete cleanup",
    prefix: "u_delete",
    hash,
    created_at_ms: Date.now() - 10_000,
    expires_at_ms: -1,
    revoked_at_ms: Date.now() - 1_000,
    usage_limit_requests: 50,
    usage_requests: 1,
    usage_reset_at_ms: Date.now() + 60_000,
    window_ms: 60_000,
    ...commonPolicy,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_pricing_checked_at_ms: null,
  });
  kvStore.set(keyToString(["ubq_ai", "api_keys", "hash", hash]), {
    id: keyId,
    expires_at_ms: -1,
    revoked_at_ms: Date.now() - 1_000,
    usage_limit_requests: 50,
    usage_requests: 1,
    usage_reset_at_ms: Date.now() + 60_000,
    window_ms: 60_000,
    ...commonPolicy,
  });
  kvStore.set(keyToString(["ubq_ai", "api_keys", "usage", keyId]), { key_id: keyId });
  kvStore.set(keyToString(["ubq_ai", "api_keys", "usage_daily", keyId]), { key_id: keyId, days: [] });
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "ledger", keyId, Date.now(), "request-delete"]), { id: "request-delete", key_id: keyId });
  kvStore.set(keyToString(["ubq_ai", "api_keys", "request_log", keyId, Date.now(), "legacy-request-delete"]), { id: "legacy-request-delete", key_id: keyId });
  kvStore.set(keyToString(["uos_ai", "api_key_usage", "v2", keyId, "policy", Date.now()]), { value: 1n } as KvU64);
  const v3WindowResetAtMs = Date.now() + 60_000;
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, "request-v3-settled"]), {
    v: 3,
    key_id: keyId,
    request_id: "request-v3-settled",
    billing_state: "settled",
  });
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, "request-v3-not-billed"]), {
    v: 3,
    key_id: keyId,
    request_id: "request-v3-not-billed",
    billing_state: "not_billed",
  });
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "window", keyId, v3WindowResetAtMs]), {
    v: 3,
    key_id: keyId,
    window_reset_at_ms: v3WindowResetAtMs,
    settled_microcredits: 28_992,
    reserved_microcredits: 0,
    pending_count: 0,
  });
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "reconciliation_lease", keyId]), {
    token: "stale-delete-lease",
    expires_at_ms: Date.now() + 60_000,
  });

  const neighboringPaidFallbackKey = ["uos_ai", "paid_fallback", "ledger", neighboringKeyId, Date.now(), "request-neighbor"] as const;
  const neighboringLegacyLogKey = ["ubq_ai", "api_keys", "request_log", neighboringKeyId, Date.now(), "legacy-request-neighbor"] as const;
  const neighboringCounterKey = ["uos_ai", "api_key_usage", "v2", neighboringKeyId, "policy", Date.now()] as const;
  const neighboringV3RequestKey = ["uos_ai", "paid_fallback", "v3", "request", neighboringKeyId, "request-v3-neighbor"] as const;
  kvStore.set(keyToString(neighboringPaidFallbackKey), { id: "request-neighbor", key_id: neighboringKeyId });
  kvStore.set(keyToString(neighboringLegacyLogKey), { id: "legacy-request-neighbor", key_id: neighboringKeyId });
  kvStore.set(keyToString(neighboringCounterKey), { value: 1n } as KvU64);
  kvStore.set(keyToString(neighboringV3RequestKey), {
    v: 3,
    key_id: neighboringKeyId,
    request_id: "request-v3-neighbor",
    billing_state: "settled",
  });

  const deleteRequest = () =>
    handleAdminApiKeysDelete(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: keyId }),
      })
    );

  const unresolvedRequestKey = ["uos_ai", "paid_fallback", "v3", "request", keyId, "request-v3-unresolved"] as const;
  const unresolvedPendingKey = ["uos_ai", "paid_fallback", "v3", "pending", keyId, "request-v3-unresolved"] as const;
  kvStore.set(keyToString(unresolvedRequestKey), {
    v: 3,
    key_id: keyId,
    request_id: "request-v3-unresolved",
    billing_state: "unresolved",
  });
  kvStore.set(keyToString(unresolvedPendingKey), {
    created_at_ms: Date.now() - 86_400_000,
    next_reconciliation_at_ms: Date.now() + 60_000,
  });

  setAtomicCommitsToFail(1);
  const guardConflict = await deleteRequest();
  assert.equal(guardConflict.status, 409);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "deletion_guard", keyId]), false);
  assert.equal(kvStore.has(keyToString(unresolvedRequestKey)), true);

  const blocked = await deleteRequest();
  assert.equal(blocked.status, 409);
  const blockedPayload = (await blocked.json()) as {
    error?: { code?: string; message?: string };
  };
  assert.equal(blockedPayload.error?.code, "paid_fallback_billing_outstanding");
  assert.match(blockedPayload.error.message ?? "", /unresolved=1/);
  assert.match(blockedPayload.error.message ?? "", /markers=1/);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "api_keys", "id", keyId])), true);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "deletion_guard", keyId]), true);
  kvStore.delete(keyToString(unresolvedRequestKey));
  kvStore.delete(keyToString(unresolvedPendingKey));

  // The V3 deletion guard and terminal-state cleanup commit first. Fail the
  // following API-key CAS to prove the retained guard makes deletion retryable.
  setAtomicCommitsBeforeFailure(1);
  const conflicted = await deleteRequest();
  assert.equal(conflicted.status, 409);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "api_keys", "id", keyId])), true);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "api_keys", "hash", hash])), true);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "ledger", keyId]), true);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "request", keyId]), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "window", keyId]), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "deletion_guard", keyId]), true);
  assert.equal(kvStoreHasPrefix(["ubq_ai", "api_keys", "request_log", keyId]), true);
  assert.equal(kvStoreHasPrefix(["uos_ai", "api_key_usage", "v2", keyId]), true);
  const unrevoke = await handleAdminApiKeysUnrevoke(
    new Request("https://ai.ubq.fi/admin/api-keys/unrevoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: keyId }),
    })
  );
  assert.equal(unrevoke.status, 409);
  const unrevokePayload = (await unrevoke.json()) as { error?: { code?: string } };
  assert.equal(unrevokePayload.error?.code, "paid_fallback_deletion_in_progress");

  const response = await deleteRequest();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: keyId });
  assert.equal(kvStore.has(keyToString(["ubq_ai", "api_keys", "id", keyId])), false);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "api_keys", "hash", hash])), false);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "api_keys", "usage", keyId])), false);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "api_keys", "usage_daily", keyId])), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "ledger", keyId]), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "request", keyId]), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "window", keyId]), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "pending", keyId]), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "reconciliation_lease", keyId]), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "paid_fallback", "v3", "deletion_guard", keyId]), true);
  assert.equal(kvStoreHasPrefix(["ubq_ai", "api_keys", "request_log", keyId]), false);
  assert.equal(kvStoreHasPrefix(["uos_ai", "api_key_usage", "v2", keyId]), false);
  assert.equal(kvStore.has(keyToString(neighboringPaidFallbackKey)), true);
  assert.equal(kvStore.has(keyToString(neighboringV3RequestKey)), true);
  assert.equal(kvStore.has(keyToString(neighboringLegacyLogKey)), true);
  assert.equal(kvStore.has(keyToString(neighboringCounterKey)), true);
});

test("subscription reset settings persist by account identity across slot reordering", async () => {
  kvStore.clear();
  const accounts = ["account-a", "account-b"].map((accountId) => ({
    account_id: accountId,
    access_token: "test-access",
    refresh_token: "test-refresh",
    updated_at_ms: 100,
  }));
  const poolKey = keyToString(["ubq_ai", "codex_auth"]);
  kvStore.set(poolKey, { accounts, updated_at_ms: 100 });
  const url = "http://localhost/admin/providers/codex/banked-resets";
  const initial = await (await handleAdminCodexResetSettings(new Request(url))).json();
  assert.equal(initial.data.length, 2);
  assert.equal(initial.data[0].enabled, true);
  const identity = initial.data[0].account_id_hash;
  const update = (enabled: unknown, accountIdHash = identity) =>
    handleAdminCodexResetSettings(
      new Request(url, {
        method: "PATCH",
        body: JSON.stringify({ account_id_hash: accountIdHash, enabled }),
      })
    );
  assert.equal((await update(false)).status, 200);
  kvStore.set(poolKey, { accounts: [...accounts].reverse(), updated_at_ms: 101 });
  const reordered = await (await handleAdminCodexResetSettings(new Request(url))).json();
  assert.equal(reordered.data[0].enabled, true);
  assert.equal(reordered.data[1].account_id_hash, identity);
  assert.equal(reordered.data[1].enabled, false);
  assert.equal((await update(true)).status, 200);
  for (const value of ["true", null, 1]) assert.equal((await update(value)).status, 400);
  assert.equal((await update(false, "removed-account")).status, 409);
  kvStore.clear();
});
