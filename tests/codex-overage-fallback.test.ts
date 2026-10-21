import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test, beforeEach, afterEach } from "bun:test";
// Integration coverage for the no-reset overage fallback: an explicitly
// allowed account may make exactly one bounded overage probe after a fully
// exhausted cohort cannot redeem a banked reset, while the default-off account
// is refused. A real spend that is still arming never probes.

import assert from "node:assert/strict";
import {
  installHarness,
  cleanupHarness,
  auth,
  bankedResetRequestOptions,
  config,
  fetchCodexResponses,
  fixedStartMs,
  getCodexRoutingError,
  kv,
  pool,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  seedStableBankedResetBlock,
  selectCodexRoutingAccountsStrong,
} from "./helpers/codex-auth-cache-harness.ts";
import { loadOverageUsageSettings, resetOverageUsageCacheForTest, writeOverageUsage } from "../src/codex/overage-settings.ts";
import { codexResetRedemptionKey } from "../src/codex/banked-reset.ts";
import { sha256Hex } from "../src/utils.ts";
import type { Kv } from "#kv";
import type { CodexResetRedemptionRecord } from "../src/types.ts";

type UpstreamCall = Readonly<{ kind: "inference" | "inventory" | "consume"; accountId: string }>;
type BlockedRun = Readonly<{ responses: Response[]; calls: readonly UpstreamCall[]; logs: readonly string[] }>;

/**
 * Drive the real blocked-cohort path against a mocked upstream. The inventory
 * response decides whether a banked reset is redeemable for this episode.
 */
const runBlockedSequence = async (
  requestIds: readonly string[],
  inventoryResponse: () => Response,
  options: Readonly<{ allowOverage?: boolean | readonly boolean[]; mode?: "live" | "shadow"; seedUnsubmittedReset?: boolean; parallel?: boolean }> = {}
): Promise<BlockedRun> => {
  const { allowOverage = false, mode = "live" } = options;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalInfo = console.info;
  const originalDeployFlag = config.isDeploy;
  const originalCodexBaseUrl = config.codexBaseUrl;
  const calls: UpstreamCall[] = [];
  const logs: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = true;
  (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = "https://upstream-reset.test/backend-api/codex";
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  resetOverageUsageCacheForTest();
  await seedStableBankedResetBlock("account-one");
  if (options.seedUnsubmittedReset) {
    const routing = await selectCodexRoutingAccountsStrong(kv.auth, kv.auth.accounts, fixedStartMs);
    assert.equal(routing.kind, "quota_blocked");
    const blocked = routing.blockedAccounts.at(0);
    assert.ok(blocked);
    const accountHash = await sha256Hex("account-one");
    const credentialVersionInput = `uos_ai\u0000codex_reset_credential_version\u0000${blocked.credentialVersion}`;
    const credentialVersion = `v1:${await sha256Hex(credentialVersionInput)}`;
    const quotaGenerationInput = `uos_ai\u0000codex_reset_generation\u0000${accountHash}\u0000${blocked.quotaResetAtMs}`;
    const quotaGeneration = `v1:${await sha256Hex(quotaGenerationInput)}`;
    const idempotencyInput = `uos_ai\u0000codex_reset_idempotency\u0000${accountHash}\u0000${quotaGeneration}`;
    const idempotencyKey = `uos_ai_codex_reset_v1_${await sha256Hex(idempotencyInput)}`;
    const idempotencyKeyHash = await sha256Hex(idempotencyKey);
    const record: CodexResetRedemptionRecord = {
      v: 1,
      account_id_hash: accountHash,
      credential_version: credentialVersion,
      quota_generation: quotaGeneration,
      routing_generation: blocked.routingGeneration,
      idempotency_key_hash: idempotencyKeyHash,
      state: "claimed",
      owner_token: "fixture-stale-owner",
      fence: 1,
      lease_expires_at_ms: fixedStartMs + 30_000,
      provider_receipt_id: null,
      created_at_ms: fixedStartMs - 1_000,
      updated_at_ms: fixedStartMs - 1_000,
      submitted_at_ms: null,
      verified_at_ms: null,
      last_error_code: null,
    };
    await kv.set(codexResetRedemptionKey(accountHash, quotaGeneration), record);
  }
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    if (request.url.endsWith("/backend-api/codex/responses")) {
      calls.push({ kind: "inference", accountId });
      return Promise.resolve(Response.json({ id: `response-${accountId}` }));
    }
    if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits")) {
      calls.push({ kind: "inventory", accountId });
      return Promise.resolve(inventoryResponse());
    }
    if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits/consume")) {
      calls.push({ kind: "consume", accountId });
      return Promise.resolve(Response.json({ code: "reset", windows_reset: 1 }));
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });
  console.info = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const requestOptionsFor = (requestId: string) => {
      const base = bankedResetRequestOptions(requestId);
      return {
        ...base,
        bankedReset: {
          ...base.bankedReset,
          config: { ...base.bankedReset.config, mode },
        },
      };
    };
    if (options.parallel) {
      const requestAllowsOverage = typeof allowOverage === "boolean" ? allowOverage : (allowOverage[0] ?? false);
      await writeOverageUsage(kv as unknown as Kv, await sha256Hex("account-one"), requestAllowsOverage);
      await loadOverageUsageSettings(kv.auth, true);
      const responses = await Promise.all(requestIds.map((requestId) => fetchCodexResponses({ input: requestId }, requestOptionsFor(requestId))));
      return { responses, calls, logs };
    }
    const responses: Response[] = [];
    for (const [index, requestId] of requestIds.entries()) {
      const requestAllowsOverage = typeof allowOverage === "boolean" ? allowOverage : (allowOverage[index] ?? false);
      await writeOverageUsage(kv as unknown as Kv, await sha256Hex("account-one"), requestAllowsOverage);
      await loadOverageUsageSettings(kv.auth, true);
      const response = await fetchCodexResponses({ input: requestId }, requestOptionsFor(requestId));
      responses.push(response);
    }
    return { responses, calls, logs };
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    resetOverageUsageCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    console.info = originalInfo;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = originalCodexBaseUrl;
  }
};

const runBlockedRequest = async (
  requestId: string,
  inventoryResponse: () => Response,
  allowOverage = false
): Promise<Readonly<{ response: Response; calls: readonly UpstreamCall[]; logs: readonly string[] }>> => {
  const { responses, calls, logs } = await runBlockedSequence([requestId], inventoryResponse, { allowOverage });
  const response = responses.at(0);
  assert.ok(response);
  return { response, calls, logs };
};

test("the default off setting refuses overage even when no reset is redeemable", async () => {
  const { response, calls, logs } = await runBlockedRequest("overage-fallback-empty-inventory", () => Response.json({ available_count: 0, credits: [] }));

  assert.equal(response.status, 429);
  assert.equal(getCodexRoutingError(response), "codex_quota_blocked");
  assert.deepEqual(
    calls.filter((call) => call.kind === "inference"),
    []
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "consume"),
    []
  );
  assert.equal(
    logs.some((line) => line.includes("codex_overage_served")),
    false,
    "an operator-disabled account must not spend overage"
  );
});

test("an explicitly allowed blocked cohort still falls back to exactly one bounded overage probe", async () => {
  const { response, calls, logs } = await runBlockedRequest(
    "overage-fallback-allowed-empty-inventory",
    () => Response.json({ available_count: 0, credits: [] }),
    true
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    calls.filter((call) => call.kind === "inference").map((call) => call.accountId),
    ["account-one"]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "consume"),
    []
  );
  assert.ok(
    logs.some((line) => line.includes("codex_overage_served") && line.includes('"reason":"no_eligible_credit"')),
    "the fallback records the redemption-unavailable reason"
  );
});

test("a selected shadow reset allows the enabled bounded overage probe", async () => {
  const inventory = () =>
    Response.json({
      available_count: 1,
      credits: [{ id: "credit-account-one", status: "available", reset_type: "codex_rate_limits", expires_at: null }],
    });
  const { responses, calls, logs } = await runBlockedSequence(["overage-shadow-first"], inventory, {
    allowOverage: true,
    mode: "shadow",
  });

  assert.deepEqual(
    responses.map((response) => response.status),
    [200]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "inference").map((call) => call.accountId),
    ["account-one"]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "consume"),
    []
  );
  assert.ok(logs.some((line) => line.includes("codex_overage_served") && line.includes('"reason":"shadow_selected"')));
});

test("a duplicate shadow decision allows the enabled bounded overage probe", async () => {
  const { responses, calls, logs } = await runBlockedSequence(
    ["overage-shadow-seed", "overage-shadow-duplicate"],
    () =>
      Response.json({
        available_count: 1,
        credits: [{ id: "credit-account-one", status: "available", reset_type: "codex_rate_limits", expires_at: null }],
      }),
    { allowOverage: [false, true], mode: "shadow" }
  );

  assert.deepEqual(
    responses.map((response) => response.status),
    [429, 200]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "inference").map((call) => call.accountId),
    ["account-one"]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "consume"),
    []
  );
  assert.ok(
    logs.some((line) => line.includes("codex_overage_served") && line.includes('"reason":"already_would_spend_once"')),
    logs.join("\n")
  );
});

test("an unsubmitted stale reset claim allows the enabled bounded overage probe", async () => {
  const { responses, calls, logs } = await runBlockedSequence(
    ["overage-unsubmitted-reset"],
    () =>
      Response.json({
        available_count: 1,
        credits: [{ id: "credit-account-one", status: "available", reset_type: "codex_rate_limits", expires_at: null }],
      }),
    { allowOverage: true, mode: "live", seedUnsubmittedReset: true }
  );

  assert.equal(responses.at(0)?.status, 200);
  assert.deepEqual(
    calls.filter((call) => call.kind === "inference").map((call) => call.accountId),
    ["account-one"]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "consume"),
    []
  );
  assert.ok(logs.some((line) => line.includes("codex_overage_served") && line.includes('"reason":"unsubmitted_transaction"')));
});

test("concurrent enabled overage requests do not contend for one probe lease", async () => {
  const { responses, calls, logs } = await runBlockedSequence(
    ["overage-concurrent-one", "overage-concurrent-two"],
    () =>
      Response.json({
        available_count: 1,
        credits: [{ id: "credit-account-one", status: "available", reset_type: "codex_rate_limits", expires_at: null }],
      }),
    { allowOverage: true, mode: "live", seedUnsubmittedReset: true, parallel: true }
  );

  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "inference").map((call) => call.accountId),
    ["account-one", "account-one"]
  );
  assert.equal(logs.filter((line) => line.includes("codex_overage_served")).length, 2);
});

test("shadow-only reset outcomes still refuse overage when the account setting is off", async () => {
  const { responses, calls, logs } = await runBlockedSequence(
    ["overage-shadow-disabled"],
    () =>
      Response.json({
        available_count: 1,
        credits: [{ id: "credit-account-one", status: "available", reset_type: "codex_rate_limits", expires_at: null }],
      }),
    { allowOverage: false, mode: "shadow" }
  );

  assert.equal(responses.at(0)?.status, 429);
  assert.deepEqual(
    calls.filter((call) => call.kind === "inference"),
    []
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "consume"),
    []
  );
  assert.ok(logs.some((line) => line.includes("codex_banked_reset_preflight") && line.includes('"reason":"shadow_selected"')));
  assert.equal(
    logs.some((line) => line.includes("codex_overage_served")),
    false
  );
});

test("a redeemable credit is consumed before overage", async () => {
  const { response, calls, logs } = await runBlockedRequest(
    "overage-fallback-live-credit",
    () =>
      Response.json({
        available_count: 1,
        credits: [{ id: "credit-account-one", status: "available", reset_type: "codex_rate_limits", expires_at: null }],
      }),
    true
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    calls.filter((call) => call.kind === "consume"),
    [{ kind: "consume", accountId: "account-one" }]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "inference").map((call) => call.accountId),
    ["account-one"]
  );
  assert.ok(logs.some((line) => line.includes("codex_reset_verified")));
  assert.equal(
    logs.some((line) => line.includes("codex_overage_served")),
    false,
    "a live reset must not fall back to overage"
  );
});

beforeEach(installHarness);
afterEach(cleanupHarness);
