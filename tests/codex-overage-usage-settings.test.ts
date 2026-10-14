// Per-account overage-usage setting: store round-trip, admin surface contract,
// routing-cache refresh, and per-account isolation. The KV is an in-process
// substitute so the handler contract and the durable rows can both be asserted.

import assert from "node:assert/strict";
import { handleAdminCodexOverageUsage } from "../src/admin/kernel.ts";
import { routingAccountIdentity } from "../src/codex/capacity-routing.ts";
import { resetCodexAuthCacheForTest } from "../src/codex/index.ts";
import {
  codexOverageUsageKey,
  loadOverageUsageSettings,
  overageUsageAllowedSync,
  readOverageUsage,
  resetOverageUsageCacheForTest,
  writeOverageUsage,
} from "../src/codex/overage-settings.ts";
import { setKvForTest } from "../src/kv.ts";
import type { CodexAuthPoolState } from "../src/types.ts";
import { sha256Hex } from "../src/utils.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const CODEX_AUTH_POOL_KEY: Deno.KvKey = ["ubq_ai", "codex_auth"];
const OVERAGE_URL = "https://ai.ubq.fi/admin/providers/codex/overage-usage";

const kv = new CountingKv();
setKvForTest(kv as unknown as Deno.Kv);

/** The same valid persisted pool shape the sibling admin settings tests seed. */
const codexPoolEntry = (accountIds: readonly string[]): Record<string, unknown> => {
  const encoded = btoa(JSON.stringify({ exp: Math.floor((Date.now() + 60 * 60 * 1_000) / 1_000) }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  let end = encoded.length;
  while (end > 0 && encoded[end - 1] === "=") end -= 1;
  const payload = encoded.slice(0, end);
  return {
    accounts: accountIds.map((accountId) => ({
      access_token: `h.${payload}.s`,
      refresh_token: "refresh",
      account_id: accountId,
      updated_at_ms: Date.now(),
    })),
    updated_at_ms: Date.now(),
  };
};

const readBody = async (response: Response): Promise<Record<string, unknown>> => (await response.json()) as Record<string, unknown>;

const patchRequest = (body: unknown): Request =>
  new Request(OVERAGE_URL, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

Deno.test("the overage usage store round-trips and absent rows read as false", async () => {
  resetOverageUsageCacheForTest();
  const accountIdHash = await sha256Hex("overage-store-account");
  assert.equal(await readOverageUsage(kv as unknown as Deno.Kv, accountIdHash), false);
  assert.equal((await kv.get(codexOverageUsageKey(accountIdHash))).value, null);

  await writeOverageUsage(kv as unknown as Deno.Kv, accountIdHash, true);
  assert.deepEqual((await kv.get(codexOverageUsageKey(accountIdHash))).value, { allow: true });
  assert.equal(await readOverageUsage(kv as unknown as Deno.Kv, accountIdHash), true);

  await writeOverageUsage(kv as unknown as Deno.Kv, accountIdHash, false);
  assert.deepEqual((await kv.get(codexOverageUsageKey(accountIdHash))).value, { allow: false });
  assert.equal(await readOverageUsage(kv as unknown as Deno.Kv, accountIdHash), false);

  // A malformed row never enables overage spending.
  kv.seed(codexOverageUsageKey(accountIdHash), { allow: "yes" });
  assert.equal(await readOverageUsage(kv as unknown as Deno.Kv, accountIdHash), false);
});

Deno.test("the admin overage surface lists every account, persists a patch, and refreshes the routing cache", async () => {
  kv.clearData();
  resetCodexAuthCacheForTest();
  resetOverageUsageCacheForTest();
  kv.seed(CODEX_AUTH_POOL_KEY, codexPoolEntry(["overage-account-one"]));
  const accountIdHash = await sha256Hex("overage-account-one");
  const cohortId = await sha256Hex("uos-prompt-cache-account-cohort-v1\u0000overage-account-one");

  const listed = await handleAdminCodexOverageUsage(new Request(OVERAGE_URL));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("Cache-Control"), "no-store");
  const listBody = await readBody(listed);
  const rows = listBody.data as { slot: number; account_id_hash: string; account_cohort_id: string; allow: boolean }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, 1);
  assert.equal(rows[0].account_id_hash, accountIdHash);
  assert.equal(rows[0].account_cohort_id, cohortId);
  assert.equal(rows[0].allow, false);
  assert.equal(Object.hasOwn(rows[0], "account_id"), false);
  assert.equal(Object.hasOwn(rows[0], "access_token"), false);

  const patched = await handleAdminCodexOverageUsage(patchRequest({ account_id_hash: accountIdHash, allow: true }));
  assert.equal(patched.status, 200);
  assert.deepEqual(await readBody(patched), { account_id_hash: accountIdHash, allow: true });
  assert.deepEqual((await kv.get(codexOverageUsageKey(accountIdHash))).value, { allow: true });

  const pool = (await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KEY)).value;
  assert.ok(pool);
  const identity = await routingAccountIdentity(pool.accounts[0]);
  assert.equal(overageUsageAllowedSync(identity.accountIdHash), true);

  const relisted = await handleAdminCodexOverageUsage(new Request(OVERAGE_URL));
  const relistedRows = (await readBody(relisted)).data as { allow: boolean }[];
  assert.equal(relistedRows[0].allow, true);
});

Deno.test("the admin overage surface rejects malformed bodies and stale subscriptions", async () => {
  kv.clearData();
  resetCodexAuthCacheForTest();
  kv.seed(CODEX_AUTH_POOL_KEY, codexPoolEntry(["overage-account-one"]));
  const accountIdHash = await sha256Hex("overage-account-one");

  const nonJson = await handleAdminCodexOverageUsage(patchRequest("{"));
  assert.equal(nonJson.status, 400);
  for (const body of [{}, { account_id_hash: accountIdHash }, { account_id_hash: accountIdHash, allow: "yes" }, { allow: true }]) {
    const invalid = await handleAdminCodexOverageUsage(patchRequest(body));
    assert.equal(invalid.status, 400);
  }

  const stale = await handleAdminCodexOverageUsage(patchRequest({ account_id_hash: await sha256Hex("missing-account"), allow: true }));
  assert.equal(stale.status, 409);
  assert.equal(((await readBody(stale)).error as { message?: string } | undefined)?.message, "Subscription changed. Reload Providers.");
  assert.equal((await kv.get(codexOverageUsageKey(accountIdHash))).value, null);
});

Deno.test("the admin overage surface exposes the upstream balance and limit, or usage unavailable", async () => {
  const originalFetch = globalThis.fetch;
  kv.clearData();
  resetCodexAuthCacheForTest();
  resetOverageUsageCacheForTest();
  kv.seed(CODEX_AUTH_POOL_KEY, codexPoolEntry(["overage-account-one"]));
  const stubUsage = (response: () => Response | Promise<Response>) => {
    globalThis.fetch = (input) => {
      let url: string;
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.toString();
      else url = input.url;
      if (!url.endsWith("/backend-api/wham/usage")) throw new Error(`unexpected request ${url}`);
      return Promise.resolve(response());
    };
  };
  try {
    // The balance stays the upstream decimal string, and only the two
    // diagnostics fields are projected.
    stubUsage(() => Response.json({ credits: { balance: "12.50", overage_limit_reached: false }, plan_type: "prolite" }));
    const listed = await handleAdminCodexOverageUsage(new Request(OVERAGE_URL));
    assert.equal(listed.status, 200);
    const row = ((await readBody(listed)).data as { overage: Record<string, unknown> | null }[])[0];
    assert.deepEqual(row.overage, { balance: "12.50", overage_limit_reached: false });
    assert.deepEqual(Object.keys(row.overage), ["balance", "overage_limit_reached"]);

    stubUsage(() => Response.json({ credits: { balance: "3.00", overage_limit_reached: true } }));
    const reached = await handleAdminCodexOverageUsage(new Request(OVERAGE_URL));
    const reachedRow = ((await readBody(reached)).data as { overage: { overage_limit_reached: boolean | null } | null }[])[0];
    assert.equal(reachedRow.overage?.overage_limit_reached, true);

    // An upstream failure or an unusable payload reads as null without
    // failing the settings surface.
    for (const response of [() => new Response(null, { status: 500 }), () => Response.json({ credits: { balance: 12.5 } })]) {
      stubUsage(response);
      const unavailable = await handleAdminCodexOverageUsage(new Request(OVERAGE_URL));
      assert.equal(unavailable.status, 200);
      const unavailableRow = ((await readBody(unavailable)).data as { overage: unknown }[])[0];
      assert.equal(unavailableRow.overage, null);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("one subscription's overage choice never changes another account's value", async () => {
  kv.clearData();
  resetCodexAuthCacheForTest();
  resetOverageUsageCacheForTest();
  kv.seed(CODEX_AUTH_POOL_KEY, codexPoolEntry(["overage-account-one", "overage-account-two"]));
  const firstHash = await sha256Hex("overage-account-one");
  const secondHash = await sha256Hex("overage-account-two");

  const patched = await handleAdminCodexOverageUsage(patchRequest({ account_id_hash: firstHash, allow: true }));
  assert.equal(patched.status, 200);

  const listed = await handleAdminCodexOverageUsage(new Request(OVERAGE_URL));
  const rows = (await readBody(listed)).data as { account_id_hash: string; allow: boolean }[];
  assert.deepEqual(
    rows.map((row) => ({ hash: row.account_id_hash, allow: row.allow })),
    [
      { hash: firstHash, allow: true },
      { hash: secondHash, allow: false },
    ]
  );

  const pool = (await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KEY)).value;
  assert.ok(pool);
  const identities = await Promise.all(pool.accounts.map(routingAccountIdentity));
  await loadOverageUsageSettings(pool, true);
  assert.equal(overageUsageAllowedSync(identities[0].accountIdHash), true);
  assert.equal(overageUsageAllowedSync(identities[1].accountIdHash), false);

  // An unreadable or absent cache entry is false; clearing the cache cannot
  // turn the unset sibling on.
  resetOverageUsageCacheForTest();
  assert.equal(overageUsageAllowedSync(identities[0].accountIdHash), false);
  assert.equal(overageUsageAllowedSync(identities[1].accountIdHash), false);
});
