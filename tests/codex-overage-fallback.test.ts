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
} from "./helpers/codex-auth-cache-harness.ts";
import { loadOverageUsageSettings, resetOverageUsageCacheForTest, writeOverageUsage } from "../src/codex/overage-settings.ts";
import { sha256Hex } from "../src/utils.ts";
import type { Kv } from "#kv";

type UpstreamCall = Readonly<{ kind: "inference" | "inventory" | "consume"; accountId: string }>;

/**
 * Drive the real blocked-cohort path against a mocked upstream. The inventory
 * response decides whether a banked reset is redeemable for this episode.
 */
const runBlockedRequest = async (
  requestId: string,
  inventoryResponse: () => Response,
  allowOverage = false
): Promise<{ response: Response; calls: readonly UpstreamCall[]; logs: readonly string[] }> => {
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
  if (allowOverage) {
    await writeOverageUsage(kv as unknown as Kv, await sha256Hex("account-one"), true);
    await loadOverageUsageSettings(kv.auth, true);
  }
  await seedStableBankedResetBlock("account-one");
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
    const response = await fetchCodexResponses({ input: requestId }, bankedResetRequestOptions(requestId));
    return { response, calls, logs };
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

test("a redeemable credit arms the live cohort and never falls back while arming is pending", async () => {
  const { response, calls, logs } = await runBlockedRequest("overage-fallback-arming-pending", () =>
    Response.json({
      available_count: 1,
      credits: [{ id: "credit-account-one", status: "available", reset_type: "codex_rate_limits", expires_at: null }],
    })
  );

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
    "arming must not serve overage"
  );
  assert.ok(logs.some((line) => line.includes("codex_banked_reset_preflight") && line.includes('"reason":"live_armed"')));
});

beforeEach(installHarness);
afterEach(cleanupHarness);
