import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { AtomicOperation, Kv, KvCommitError, KvEntryMaybe, KvKey, KvListIterator, KvListSelector } from "#kv";
import { test } from "bun:test";
// Coverage tests for the admin kernel handlers (src/admin/kernel.ts) and the
// kernel auth usage ledger (src/kernel/usage.ts). The KV is an in-process
// substitute so every handler-visible branch can be driven without a real
// database; assertions check the HTTP contract and the KV state it leaves.

import assert from "node:assert/strict";
import {
  handleAdminCodexResetSettings,
  handleAdminKernelPolicyQueueList,
  handleAdminKernelPubKeysCreate,
  handleAdminKernelPubKeysDelete,
  handleAdminKernelPubKeysList,
  handleAdminKernelUsageDelete,
  handleAdminKernelUsageGet,
  handleAdminKernelUsageSet,
  handleAdminProvidersQuotaProjection,
  handleAdminProvidersQuotaProjectionBackfill,
} from "../src/admin/kernel.ts";
import { codexResetUsageKey, readCodexResetUsage } from "../src/codex/reset-settings.ts";
import { getKernelOrgUsageLimitSnapshot, getKernelUsageLimitSnapshot } from "../src/kernel/quota-v2.ts";
import {
  getKernelOrgUsage,
  getKernelUsage,
  KERNEL_AUTH_USAGE_PREFIX,
  kernelOrgUsageDailyKey,
  kernelOrgUsageKey,
  kernelUsageDailyKey,
  kernelUsageKey,
  listKernelOrgUsageRecords,
  listKernelUsageRecords,
} from "../src/kernel/usage.ts";
import { setKvForTest } from "../src/kv.ts";
import { paidFallbackUsageRollupKey, type PaidFallbackUsageRollup } from "../src/paid-fallback/rollups.ts";
import { sha256Hex } from "../src/utils.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const KERNEL_PUBKEYS_KEY: KvKey = ["uos_ai", "kernel_pubkeys"];
const KERNEL_POLICY_QUEUE_KEY: KvKey = ["uos_ai", "kernel_policy_queue"];
const DEFAULT_CUTOVER_KEY: KvKey = ["uos_ai", "kernel_quota", "v2", "default_window_cutover"];
const CODEX_AUTH_POOL_KEY: KvKey = ["ubq_ai", "codex_auth"];
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

const VALID_PEM = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----";

/** The same in-memory KV as the shared harness, plus a programmable CAS failure. */
class ConflictKv extends CountingKv {
  commitsToFail = 0;
  override atomic(): AtomicOperation {
    const operation = super.atomic();
    const commit = operation.commit.bind(operation);
    operation.commit = async () => {
      if (this.commitsToFail > 0) {
        this.commitsToFail -= 1;
        return { ok: false } as KvCommitError;
      }
      return await commit();
    };
    return operation;
  }
}

/** A KV whose read and list operations always fail, for fail-closed paths. */
class ThrowingKv extends CountingKv {
  failGet = false;
  failList = false;
  override get<T = unknown>(key: KvKey): Promise<KvEntryMaybe<T>> {
    if (this.failGet) throw new Error("kv get failed");
    return super.get<T>(key);
  }
  override list<T = unknown>(selector: KvListSelector): KvListIterator<T> {
    if (this.failList) throw new Error("kv list failed");
    return super.list<T>(selector);
  }
}

const kv = new ConflictKv();
setKvForTest(kv as unknown as Kv);

type ErrorBody = { error: { message: string; type: string; code: string | null } };

const readBody = async (response: Response): Promise<Record<string, unknown>> => (await response.json()) as Record<string, unknown>;
const readError = async (response: Response): Promise<ErrorBody> => (await response.json()) as ErrorBody;

const jsonRequest = (url: string, method: string, body: unknown): Request =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

const deletePubKey = (appId: string): Request => new Request(`https://ai.ubq.fi/admin/kernel-pubkeys?app_id=${appId}`, { method: "DELETE" });

const usageBody = (body: unknown): Request => jsonRequest("https://ai.ubq.fi/admin/kernel-usage", "POST", body);
const usageDelete = (body: unknown): Request => jsonRequest("https://ai.ubq.fi/admin/kernel-usage", "DELETE", body);

const policyRecord = (scope: "repo" | "org", owner: string, repo: string | undefined, limit: number, windowMs: number) =>
  ({
    v: 2,
    scope,
    owner,
    ...(repo === undefined ? {} : { repo }),
    usage_limit_requests: limit,
    window_ms: windowMs,
    expires_at_ms: -1,
    created_at_ms: 1,
    updated_at_ms: 2,
  }) as Record<string, unknown>;

const windowRecord = (scope: "repo" | "org", owner: string, repo: string | undefined, usageRequests: number, reservedRequests: number, windowMs: number) =>
  ({
    v: 2,
    scope,
    owner,
    ...(repo === undefined ? {} : { repo }),
    usage_requests: usageRequests,
    reserved_requests: reservedRequests,
    usage_reset_at_ms: Date.now() + windowMs,
    applied_window_ms: windowMs,
    created_at_ms: 1,
    updated_at_ms: 2,
  }) as Record<string, unknown>;

const repoPolicyKey = (owner: string, repo: string): KvKey => ["uos_ai", "kernel_quota", "v2", "repo_policy", owner, repo];
const orgPolicyKey = (owner: string): KvKey => ["uos_ai", "kernel_quota", "v2", "org_policy", owner];
const repoWindowKey = (owner: string, repo: string): KvKey => ["uos_ai", "kernel_quota", "v2", "repo_window", owner, repo];

const seedRepoPolicy = (owner: string, repo: string, limit: number, windowMs: number, usageRequests = 0): void => {
  kv.seed(repoPolicyKey(owner, repo), policyRecord("repo", owner, repo, limit, windowMs));
  kv.seed(repoWindowKey(owner, repo), windowRecord("repo", owner, repo, usageRequests, 0, windowMs));
};

const todayKey = (nowMs = Date.now()): string => {
  const date = new Date(nowMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

const usageEntry = (owner: string, repo: string, requestCount: number): Record<string, unknown> => ({
  owner,
  repo,
  total_requests: requestCount,
  stream_requests: 1,
  non_stream_requests: requestCount - 1,
  completed_requests: requestCount - 1,
  error_requests: 1,
  input_tokens: 10,
  output_tokens: 20,
  total_tokens: 30,
  first_seen_at_ms: 1_000,
  last_seen_at_ms: 2_000,
  last_model: "gpt-5.6-sol",
  last_reasoning: "low",
  last_route: "/v1/responses",
});

const orgUsageEntry = (owner: string, requestCount: number): Record<string, unknown> => {
  const entry = usageEntry(owner, "unused", requestCount);
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "repo"));
};

const rollupEntry = (bucketStartAtMs: number, model: string, provider: string, requestCount: number): PaidFallbackUsageRollup => ({
  v: 1,
  bucket_start_at_ms: bucketStartAtMs,
  model,
  provider,
  request_count: requestCount,
  quota_sum: requestCount * 100,
  input_tokens: requestCount * 10,
  cached_input_tokens: 0,
  output_tokens: requestCount * 20,
  spend_microcredits: requestCount * 1_000,
  first_request_at_ms: bucketStartAtMs,
  last_request_at_ms: bucketStartAtMs + HOUR_MS - 1,
  updated_at_ms: bucketStartAtMs,
});

const codexPoolEntry = (accountId: string): Record<string, unknown> => {
  const encoded = btoa(JSON.stringify({ exp: Math.floor((Date.now() + 60 * 60 * 1_000) / 1_000) }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  // Strip the trailing `=` padding without a `=+$` regex: an unbounded
  // quantifier before `$` is a super-linear backtracking pattern.
  let end = encoded.length;
  while (end > 0 && encoded[end - 1] === "=") end -= 1;
  const payload = encoded.slice(0, end);
  return {
    accounts: [{ access_token: `h.${payload}.s`, refresh_token: "refresh", account_id: accountId, updated_at_ms: Date.now() }],
    updated_at_ms: Date.now(),
  };
};

test("kernel pubkey list reports the stored keys and fails closed without KV", async () => {
  kv.clearData();
  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 7, pem: VALID_PEM, owner: "acme", added_at_ms: 5 }]);
  const ok = await handleAdminKernelPubKeysList();
  assert.equal(ok.status, 200);
  assert.deepEqual(await readBody(ok), { data: [{ app_id: 7, pem: VALID_PEM, owner: "acme", added_at_ms: 5 }] });

  kv.clearData();
  const empty = await handleAdminKernelPubKeysList();
  assert.equal(empty.status, 200);
  assert.deepEqual(await readBody(empty), { data: [] });

  setKvForTest(null);
  try {
    const unavailable = await handleAdminKernelPubKeysList();
    assert.equal(unavailable.status, 500);
    assert.equal((await readError(unavailable)).error.message, "Deno KV is not available");
  } finally {
    setKvForTest(kv as unknown as Kv);
  }
});

test("kernel pubkey create rejects invalid bodies, app ids and PEM values", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminKernelPubKeysCreate(new Request("https://ai.ubq.fi/admin/kernel-pubkeys", { method: "POST", body: "{}" }));
    assert.equal(unavailable.status, 500);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  const nonJson = await handleAdminKernelPubKeysCreate(
    new Request("https://ai.ubq.fi/admin/kernel-pubkeys", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })
  );
  assert.equal(nonJson.status, 400);
  assert.equal((await readError(nonJson)).error.message, "Invalid JSON body");

  const arrayBody = await handleAdminKernelPubKeysCreate(new Request("https://ai.ubq.fi/admin/kernel-pubkeys", { method: "POST", body: JSON.stringify([1]) }));
  assert.equal(arrayBody.status, 400);

  const missingAppId = await handleAdminKernelPubKeysCreate(usageBody({ pem: VALID_PEM }));
  assert.equal(missingAppId.status, 400);
  assert.equal((await readError(missingAppId)).error.message, "app_id is required and must be a number");

  const stringAppId = await handleAdminKernelPubKeysCreate(usageBody({ app_id: "7", pem: VALID_PEM }));
  assert.equal(stringAppId.status, 400);

  for (const pem of [7, "", "-----BEGIN PUBLIC KEY-----\nabc", "abc\n-----END PUBLIC KEY-----"]) {
    const invalidPem = await handleAdminKernelPubKeysCreate(usageBody({ app_id: 1, pem }));
    assert.equal(invalidPem.status, 400);
    assert.equal((await readError(invalidPem)).error.message, "pem must be a valid RS256 public PEM");
  }

  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 9, pem: VALID_PEM, owner: "acme", added_at_ms: 5 }]);
  const duplicate = await handleAdminKernelPubKeysCreate(usageBody({ app_id: 9, pem: VALID_PEM }));
  assert.equal(duplicate.status, 409);
  assert.equal((await readError(duplicate)).error.message, "Public key for App ID 9 already exists");
});

test("kernel pubkey create stores the key with its owner and reports a lost compare-and-set", async () => {
  kv.clearData();
  const createdAtMs = Date.now();
  const response = await handleAdminKernelPubKeysCreate(usageBody({ app_id: 11, pem: `  ${VALID_PEM}  ` }));
  assert.equal(response.status, 200);
  const body = await readBody(response);
  const record = body.data as { app_id: number; pem: string; owner: string; added_at_ms: number };
  assert.deepEqual(body.ok, true);
  assert.equal(record.app_id, 11);
  assert.equal(record.pem, VALID_PEM);
  assert.equal(record.owner, "unknown");
  assert.ok(record.added_at_ms >= createdAtMs);

  const stored = await kv.get<{ app_id: number; pem: string; owner: string }[]>(KERNEL_PUBKEYS_KEY).then((entry) => entry.value);
  assert.deepEqual(stored, [{ app_id: 11, pem: VALID_PEM, owner: "unknown", added_at_ms: record.added_at_ms }]);

  const owned = await handleAdminKernelPubKeysCreate(usageBody({ app_id: 12, pem: VALID_PEM, owner: "acme" }));
  assert.equal(owned.status, 200);
  assert.equal(((await readBody(owned)).data as { owner: string }).owner, "acme");

  kv.commitsToFail = 1;
  const conflicted = await handleAdminKernelPubKeysCreate(usageBody({ app_id: 13, pem: VALID_PEM }));
  assert.equal(conflicted.status, 409);
  assert.equal((await readError(conflicted)).error.message, "Concurrent modification; retry");
  assert.equal((await kv.get<unknown[]>(KERNEL_PUBKEYS_KEY)).value?.length, 2);
  kv.commitsToFail = 0;
});

test("kernel pubkey delete validates app_id, reports 404 and removes the stored key", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminKernelPubKeysDelete(new Request("https://ai.ubq.fi/admin/kernel-pubkeys?app_id=1", { method: "DELETE" }));
    assert.equal(unavailable.status, 500);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  const missingParam = await handleAdminKernelPubKeysDelete(new Request("https://ai.ubq.fi/admin/kernel-pubkeys", { method: "DELETE" }));
  assert.equal(missingParam.status, 400);
  assert.equal((await readError(missingParam)).error.message, "app_id query parameter is required and must be a number");

  const nonNumeric = await handleAdminKernelPubKeysDelete(deletePubKey("abc"));
  assert.equal(nonNumeric.status, 400);

  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 21, pem: VALID_PEM, owner: "acme", added_at_ms: 5 }]);
  const notFound = await handleAdminKernelPubKeysDelete(deletePubKey("22"));
  assert.equal(notFound.status, 404);
  assert.equal((await readError(notFound)).error.code, "not_found");

  const deleted = await handleAdminKernelPubKeysDelete(deletePubKey("21"));
  assert.equal(deleted.status, 200);
  assert.deepEqual(await readBody(deleted), { ok: true, deleted_app_id: 21 });
  assert.deepEqual((await kv.get<unknown[]>(KERNEL_PUBKEYS_KEY)).value, []);
});

test("kernel pubkey delete reports a lost compare-and-set without dropping the key", async () => {
  kv.clearData();
  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 31, pem: VALID_PEM, owner: "acme", added_at_ms: 5 }]);
  kv.commitsToFail = 1;
  const conflicted = await handleAdminKernelPubKeysDelete(deletePubKey("31"));
  assert.equal(conflicted.status, 409);
  assert.equal((await readError(conflicted)).error.message, "Concurrent modification; retry");
  assert.equal((await kv.get<unknown[]>(KERNEL_PUBKEYS_KEY)).value?.length, 1);
  kv.commitsToFail = 0;
});

test("kernel policy queue reports only gaps without an org or repo policy", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminKernelPolicyQueueList();
    assert.equal(unavailable.status, 500);
    assert.equal((await readError(unavailable)).error.message, "Deno KV is not available");
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  const empty = await handleAdminKernelPolicyQueueList();
  assert.equal(empty.status, 200);
  assert.deepEqual(await readBody(empty), { data: [] });

  const queueItem = (owner: string, repo: string, lastSeenAtMs: number) => ({
    owner,
    repo,
    request_count: 3,
    first_seen_at_ms: 1_000,
    last_seen_at_ms: lastSeenAtMs,
    last_route: "/v1/responses",
  });
  kv.seed(KERNEL_POLICY_QUEUE_KEY, [queueItem("acme", "alpha", 1), queueItem("acme", "beta", 2), queueItem("beta", "gamma", 3)]);
  kv.seed(orgPolicyKey("acme"), policyRecord("org", "acme", undefined, 10, 60_000));
  kv.seed(repoPolicyKey("acme", "beta"), policyRecord("repo", "acme", "beta", 10, 60_000));

  const listed = await handleAdminKernelPolicyQueueList();
  assert.equal(listed.status, 200);
  const pending = (await readBody(listed)).data as { owner: string; repo: string }[];
  assert.deepEqual(
    pending.map((item) => `${item.owner}/${item.repo}`),
    ["beta/gamma"]
  );
});

test("kernel usage inventory reports repo and org records with normalized daily series", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?inventory=1"));
    assert.equal(unavailable.status, 500);
    assert.equal((await readError(unavailable)).error.message, "Deno KV is not available");
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  kv.seed(kernelUsageKey("acme", "demo"), usageEntry("acme", "demo", 9));
  kv.seed(kernelUsageDailyKey("acme", "demo"), {
    days: [
      { day: "1970-01-01", request_count: 5 },
      { day: "not-a-day", request_count: 4 },
    ],
  });
  kv.seed(kernelUsageKey("acme", "beta"), { owner: 5, repo: "  ", total_requests: "nope" });
  kv.seed([...KERNEL_AUTH_USAGE_PREFIX, "lone-owner"], { ...usageEntry("lone-owner", "unused", 2), repo: 7 });
  kv.seed(kernelOrgUsageKey("acme"), orgUsageEntry("acme", 7));
  kv.seed(kernelOrgUsageDailyKey("acme"), { days: [{ day: todayKey(), request_count: 6 }] });

  const repoInventory = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?inventory=true&scope=repo"));
  assert.equal(repoInventory.status, 200);
  const repoBody = await readBody(repoInventory);
  assert.equal(repoBody.ok, true);
  assert.equal(repoBody.scope, "repo");
  const repoUsage = repoBody.usage as {
    owner: string;
    repo: string;
    total_requests: number;
    last_model: string | null;
    daily_requests: number[];
  }[];
  assert.deepEqual(
    repoUsage.map((entry) => `${entry.owner}/${entry.repo}`),
    ["acme/beta", "acme/demo", "lone-owner/"]
  );
  assert.deepEqual(repoUsage[0].total_requests, 0);
  assert.deepEqual(repoUsage[0].last_model, null);
  const series = repoUsage[1].daily_requests;
  assert.equal(series.length, 30);
  assert.deepEqual(new Set(series), new Set([0]));

  const orgInventory = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?inventory=1&scope=org"));
  assert.equal(orgInventory.status, 200);
  const orgBody = await readBody(orgInventory);
  assert.equal(orgBody.scope, "org");
  const orgUsage = orgBody.usage as { owner: string; daily_requests: number[] }[];
  assert.deepEqual(
    orgUsage.map((entry) => entry.owner),
    ["acme"]
  );
  assert.ok(orgUsage[0].daily_requests.includes(6));

  const shortSeries = await getKernelUsage("acme", "demo", { includeDaily: true, dailyDays: 3 });
  assert.deepEqual(shortSeries?.daily_requests, [0, 0, 0]);
  const withoutDaily = await getKernelUsage("acme", "demo");
  assert.equal(withoutDaily?.daily_requests, undefined);
  assert.equal(withoutDaily?.total_requests, 9);
  const orgShort = await getKernelOrgUsage("acme", { includeDaily: true, dailyDays: 1 });
  assert.deepEqual(orgShort?.daily_requests, [6]);
  assert.equal(await getKernelUsage("nobody", "nothing"), null);
  assert.equal(await getKernelOrgUsage("nobody"), null);
});

test("kernel usage ledger fails closed when KV reads and listings fail", async () => {
  const throwing = new ThrowingKv();
  setKvForTest(throwing as unknown as Kv);
  try {
    throwing.failGet = true;
    assert.equal(await getKernelUsage("acme", "demo"), null);
    assert.equal(await getKernelOrgUsage("acme"), null);
    throwing.failGet = false;
    throwing.failList = true;
    assert.equal(await listKernelUsageRecords(), null);
    assert.equal(await listKernelOrgUsageRecords(), null);

    const responses = await Promise.all([
      handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?inventory=1")),
      handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?inventory=1&scope=org")),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 500);
      const error = await readError(response);
      assert.equal(error.error.code, "server_error");
      assert.match(error.error.message, /Failed to load kernel (org )?usage inventory/);
    }
  } finally {
    setKvForTest(kv as unknown as Kv);
  }
});

test("kernel usage list projects declared limits, their usage and malformed policy rows", async () => {
  kv.clearData();
  seedRepoPolicy("acme", "demo", 12, 60_000, 3);
  seedRepoPolicy("acme", "beta", -1, 60_000);
  kv.seed([...KERNEL_AUTH_USAGE_PREFIX, "acme", "demo"], usageEntry("acme", "demo", 3));
  kv.seed(orgPolicyKey("acme"), policyRecord("org", "acme", undefined, 5, 60_000));
  kv.seed(["uos_ai", "kernel_quota", "v2", "org_window", "acme"], undefined);
  // Policy rows the projection must drop: prefix-only key, repo-less repo key, and a corrupt value.
  kv.seed(["uos_ai", "kernel_quota", "v2", "repo_policy"], policyRecord("repo", "acme", "demo", 1, 60_000));
  kv.seed(["uos_ai", "kernel_quota", "v2", "repo_policy", "ghost"], policyRecord("repo", "ghost", undefined, 1, 60_000));
  kv.seed(["uos_ai", "kernel_quota", "v2", "repo_policy", "acme", "corrupt"], { v: 2, scope: "repo", owner: "acme", repo: "corrupt" });
  kv.seed(["uos_ai", "kernel_quota", "v2", "org_policy", "ghost-org"], { v: 2, scope: "org", owner: "ghost-org" });

  const repoList = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?list=1&include_usage=1"));
  assert.equal(repoList.status, 200);
  const repoBody = await readBody(repoList);
  assert.deepEqual(repoBody.scope, "repo");
  const repoLimits = repoBody.limits as { owner: string; repo: string; usage_limit_requests: number; usage: { total_requests: number } | null }[];
  assert.deepEqual(
    repoLimits.map((record) => `${record.owner}/${record.repo}`),
    ["acme/beta", "acme/demo"]
  );
  assert.deepEqual(repoLimits[0].usage_limit_requests, -1);
  assert.equal(repoLimits[0].usage, null);
  assert.equal(repoLimits[1].usage?.total_requests, 3);

  const orgList = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?list=true&scope=org&include_usage=true"));
  assert.equal(orgList.status, 200);
  const orgLimits = (await readBody(orgList)).limits as { owner: string; usage: unknown }[];
  assert.deepEqual(
    orgLimits.map((record) => record.owner),
    ["acme"]
  );
  assert.equal(orgLimits[0].usage, null);

  const withoutUsage = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?list=yes&scope=org"));
  assert.equal(withoutUsage.status, 200);
  const plainLimits = (await readBody(withoutUsage)).limits as Record<string, unknown>[];
  assert.equal(plainLimits[0].usage, undefined);
  assert.equal(Object.hasOwn(plainLimits[0], "usage"), false);
});

test("kernel usage get validates its target and fails closed on a corrupt policy", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?owner=acme&repo=demo"));
    assert.equal(unavailable.status, 500);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  const missingOwner = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage"));
  assert.equal(missingOwner.status, 400);
  assert.equal((await readError(missingOwner)).error.message, "owner query parameter is required");

  const missingRepo = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?owner=acme"));
  assert.equal(missingRepo.status, 400);
  assert.equal((await readError(missingRepo)).error.message, "repo query parameter is required");

  const blankOwner = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?owner=%20&repo=demo"));
  assert.equal(blankOwner.status, 400);

  kv.seed(repoPolicyKey("acme", "broken"), { v: 2, scope: "repo", owner: "acme", repo: "broken" });
  const corrupt = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?owner=acme&repo=broken"));
  assert.equal(corrupt.status, 500);
  assert.equal((await readError(corrupt)).error.message, "Failed to load kernel usage limit");
  assert.equal(await getKernelUsageLimitSnapshot("acme", "broken"), null);

  kv.seed(orgPolicyKey("acme"), { v: 2, scope: "org", owner: "acme" });
  const corruptOrg = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?scope=org&owner=acme"));
  assert.equal(corruptOrg.status, 500);
  assert.equal((await readError(corruptOrg)).error.message, "Failed to load kernel org usage limit");
  assert.equal(await getKernelOrgUsageLimitSnapshot("acme"), null);
});

test("kernel usage get returns repo and org snapshots with their committed usage", async () => {
  kv.clearData();
  seedRepoPolicy("acme", "demo", 4, 60_000, 3);
  kv.seed(kernelUsageKey("acme", "demo"), usageEntry("acme", "demo", 3));
  kv.seed(orgPolicyKey("acme"), policyRecord("org", "acme", undefined, 40, 60_000));
  kv.seed(["uos_ai", "kernel_quota", "v2", "org_window", "acme"], windowRecord("org", "acme", undefined, 2, 0, 60_000));
  kv.seed(kernelOrgUsageKey("acme"), orgUsageEntry("acme", 2));
  // A pre-reservation window without the reserved_requests field must be reconciled, not rejected.
  kv.seed(repoWindowKey("acme", "legacy"), { ...windowRecord("repo", "acme", "legacy", 1, 0, 60_000), reserved_requests: undefined });

  const repoSnapshot = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?owner=acme&repo=demo&include_usage=1"));
  assert.equal(repoSnapshot.status, 200);
  const repoBody = await readBody(repoSnapshot);
  assert.deepEqual(repoBody.repo, { owner: "acme", repo: "demo" });
  const repoLimit = repoBody.limit as Record<string, unknown>;
  assert.equal(repoLimit.owner, "acme");
  assert.equal(repoLimit.repo, "demo");
  assert.equal(repoLimit.usage_limit_requests, 4);
  assert.equal(repoLimit.usage_requests, 3);
  assert.equal(repoLimit.window_ms, 60_000);
  assert.equal(repoLimit.expires_at_ms, -1);
  assert.equal(repoLimit.created_at_ms, 1);
  assert.equal(typeof repoLimit.updated_at_ms, "number");
  assert.equal(repoLimit.source, "kv");
  assert.equal((repoBody.usage as { total_requests: number }).total_requests, 3);

  const orgSnapshot = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?scope=ORG&owner=acme"));
  assert.equal(orgSnapshot.status, 200);
  const orgBody = await readBody(orgSnapshot);
  assert.deepEqual(orgBody.org, { owner: "acme" });
  assert.equal((orgBody.limit as { source: string }).source, "kv");
  assert.equal((orgBody.limit as { usage_requests: number }).usage_requests, 2);
  assert.equal((orgBody.usage as { total_requests: number }).total_requests, 2);

  kv.seed(repoPolicyKey("acme", "legacy"), policyRecord("repo", "acme", "legacy", 1, 60_000));
  const legacy = await handleAdminKernelUsageGet(new Request("https://ai.ubq.fi/admin/kernel-usage?owner=acme&repo=legacy"));
  assert.equal(legacy.status, 200);
  assert.equal((await readBody(legacy)).ok, true);
});

test("kernel usage set rejects invalid targets, limits and flags", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", usage_limit_requests: 5 }));
    assert.equal(unavailable.status, 500);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  const nonJson = await handleAdminKernelUsageSet(jsonRequest("https://ai.ubq.fi/admin/kernel-usage", "POST", "{"));
  assert.equal(nonJson.status, 400);
  assert.equal((await readError(nonJson)).error.message, "Invalid JSON body");

  const missingOwner = await handleAdminKernelUsageSet(usageBody({ usage_limit_requests: 5 }));
  assert.equal(missingOwner.status, 400);
  assert.equal((await readError(missingOwner)).error.message, "owner is required");

  const invalidOwner = await handleAdminKernelUsageSet(usageBody({ owner: "a cme", usage_limit_requests: 5 }));
  assert.equal(invalidOwner.status, 400);

  const repoScopeWithoutRepo = await handleAdminKernelUsageSet(usageBody({ owner: "acme", scope: "repo", usage_limit_requests: 5 }));
  assert.equal(repoScopeWithoutRepo.status, 400);
  assert.equal((await readError(repoScopeWithoutRepo)).error.message, "repo is required for scope=repo");

  const orgScopeWithRepo = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", scope: "org", usage_limit_requests: 5 }));
  assert.equal(orgScopeWithRepo.status, 400);
  assert.equal((await readError(orgScopeWithRepo)).error.message, "repo must be omitted for scope=org");

  const missingLimit = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo" }));
  assert.equal(missingLimit.status, 400);
  assert.equal((await readError(missingLimit)).error.message, "usage_limit_requests must be a non-negative number, -1, or 'unlimited'");

  for (const usageLimit of ["lots", -2, Number.NaN]) {
    const invalidLimit = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", usage_limit_requests: usageLimit }));
    assert.equal(invalidLimit.status, 400);
  }

  const invalidWindow = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", usage_limit_requests: 5, window_ms: 0 }));
  assert.equal(invalidWindow.status, 400);
  assert.equal((await readError(invalidWindow)).error.message, "window_ms must be a positive number");

  const invalidExpiry = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", usage_limit_requests: 5, expires_at_ms: 1 }));
  assert.equal(invalidExpiry.status, 400);
  assert.equal((await readError(invalidExpiry)).error.message, "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1");

  const invalidReset = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", usage_limit_requests: 5, reset_usage: "yes" }));
  assert.equal(invalidReset.status, 400);
  assert.equal((await readError(invalidReset)).error.message, "reset_usage must be a boolean");

  assert.deepEqual((await kv.get(repoPolicyKey("acme", "demo"))).value, null);
});

test("kernel usage set writes repo and org policies with their window overrides", async () => {
  kv.clearData();
  const repoSet = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", usage_limit_requests: 7, window_ms: 120_000, expires_at_ms: -1 }));
  assert.equal(repoSet.status, 200);
  const repoBody = await readBody(repoSet);
  assert.deepEqual(repoBody.repo, { owner: "acme", repo: "demo" });
  assert.equal((repoBody.limit as { usage_limit_requests: number }).usage_limit_requests, 7);
  assert.equal((repoBody.limit as { window_ms: number }).window_ms, 120_000);
  assert.equal((repoBody.limit as { expires_at_ms: number }).expires_at_ms, -1);
  assert.equal((repoBody.limit as { source: string }).source, "kv");

  const repoSnapshot = await getKernelUsageLimitSnapshot("acme", "demo");
  assert.equal(repoSnapshot?.record.usage_limit_requests, 7);
  assert.equal(repoSnapshot.record.window_ms, 120_000);
  assert.equal(repoSnapshot.source, "kv");

  const orgSet = await handleAdminKernelUsageSet(usageBody({ owner: "acme", scope: "org", usage_limit_requests: "unlimited" }));
  assert.equal(orgSet.status, 200);
  const orgBody = await readBody(orgSet);
  assert.deepEqual(orgBody.org, { owner: "acme" });
  assert.equal((orgBody.limit as { usage_limit_requests: number }).usage_limit_requests, -1);
  assert.equal(orgBody.scope, "org");
  const orgSnapshot = await getKernelOrgUsageLimitSnapshot("acme");
  assert.equal(orgSnapshot?.record.usage_limit_requests, -1);

  // reset_usage clears a counted window while keeping the policy.
  kv.seed(repoWindowKey("acme", "demo"), windowRecord("repo", "acme", "demo", 4, 0, 120_000));
  const reset = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", usage_limit_requests: 7, reset_usage: true }));
  assert.equal(reset.status, 200);
  assert.equal((await readBody(reset)).ok, true);
  const windows = await kv.get<{ usage_requests: number }>(repoWindowKey("acme", "demo")).then((entry) => entry.value);
  assert.equal(windows?.usage_requests, 0);
});

test("kernel usage set reports a concurrent modification conflict", async () => {
  kv.clearData();
  kv.commitsToFail = 3;
  const conflicted = await handleAdminKernelUsageSet(usageBody({ owner: "acme", repo: "demo", usage_limit_requests: 7 }));
  assert.equal(conflicted.status, 409);
  assert.equal((await readError(conflicted)).error.message, "Concurrent modification; retry");

  kv.commitsToFail = 3;
  const orgConflicted = await handleAdminKernelUsageSet(usageBody({ owner: "acme", scope: "org", usage_limit_requests: 7 }));
  assert.equal(orgConflicted.status, 409);
  assert.equal((await readError(orgConflicted)).error.message, "Concurrent modification; retry");
  kv.commitsToFail = 0;
});

test("kernel usage delete validates its target and reports 404, conflict and success", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminKernelUsageDelete(usageDelete({ owner: "acme", repo: "demo" }));
    assert.equal(unavailable.status, 500);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  const nonJson = await handleAdminKernelUsageDelete(jsonRequest("https://ai.ubq.fi/admin/kernel-usage", "DELETE", "{"));
  assert.equal(nonJson.status, 400);

  const missingOwner = await handleAdminKernelUsageDelete(usageDelete({ repo: "demo" }));
  assert.equal(missingOwner.status, 400);
  assert.equal((await readError(missingOwner)).error.message, "owner is required");

  const repoMissing = await handleAdminKernelUsageDelete(usageDelete({ owner: "acme", repo: "demo" }));
  assert.equal(repoMissing.status, 404);
  assert.equal((await readError(repoMissing)).error.message, "Kernel usage limit not found");

  const orgMissing = await handleAdminKernelUsageDelete(usageDelete({ owner: "acme", scope: "org" }));
  assert.equal(orgMissing.status, 404);
  assert.equal((await readError(orgMissing)).error.message, "Kernel org usage limit not found");

  seedRepoPolicy("acme", "demo", 7, 60_000);
  kv.seed(orgPolicyKey("acme"), policyRecord("org", "acme", undefined, 7, 60_000));

  // A held default-window cutover lease blocks policy deletion.
  kv.seed(DEFAULT_CUTOVER_KEY, { v: 2, id: "cutover", created_at_ms: Date.now(), expires_at_ms: Date.now() + 60_000 });
  const conflicted = await handleAdminKernelUsageDelete(usageDelete({ owner: "acme", repo: "demo" }));
  assert.equal(conflicted.status, 409);
  assert.equal((await readError(conflicted)).error.message, "Active Kernel quota reservations must settle before deletion");
  const orgConflicted = await handleAdminKernelUsageDelete(usageDelete({ owner: "acme", scope: "org" }));
  assert.equal(orgConflicted.status, 409);
  await kv.delete(DEFAULT_CUTOVER_KEY);

  const repoDeleted = await handleAdminKernelUsageDelete(usageDelete({ owner: "acme", repo: "demo" }));
  assert.equal(repoDeleted.status, 200);
  assert.deepEqual(await readBody(repoDeleted), { ok: true, scope: "repo", repo: { owner: "acme", repo: "demo" }, deleted: true });
  assert.deepEqual((await kv.get(repoPolicyKey("acme", "demo"))).value, null);
  assert.equal((await getKernelUsageLimitSnapshot("acme", "demo"))?.source, "default");

  const orgDeleted = await handleAdminKernelUsageDelete(usageDelete({ owner: "acme", scope: "org" }));
  assert.equal(orgDeleted.status, 200);
  assert.deepEqual(await readBody(orgDeleted), { ok: true, scope: "org", org: { owner: "acme" }, deleted: true });
  assert.deepEqual((await kv.get(orgPolicyKey("acme"))).value, null);
  assert.equal((await getKernelOrgUsageLimitSnapshot("acme"))?.source, "default");
});

test("kernel usage delete fails closed when every compare-and-set is lost", async () => {
  kv.clearData();
  seedRepoPolicy("acme", "demo", 7, 60_000);
  kv.commitsToFail = 3;
  const failed = await handleAdminKernelUsageDelete(usageDelete({ owner: "acme", repo: "demo" }));
  assert.equal(failed.status, 500);
  assert.equal((await readError(failed)).error.message, "Failed to delete kernel usage limit");
  kv.commitsToFail = 0;
  assert.notEqual((await kv.get(repoPolicyKey("acme", "demo"))).value, null);
});

test("quota projection reports retention, rollups and unavailable scans", async () => {
  kv.clearData();
  const hourBucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  kv.seed(paidFallbackUsageRollupKey(hourBucket, "gpt-5.6-sol", "metered", 0), rollupEntry(hourBucket, "gpt-5.6-sol", "metered", 4));
  kv.seed(paidFallbackUsageRollupKey(hourBucket, "gpt-5.6-sol", "surplus", 0), rollupEntry(hourBucket, "gpt-5.6-sol", "surplus", 2));

  const response = await handleAdminProvidersQuotaProjection(new Request("https://ai.ubq.fi/admin/providers/quota-projection"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await readBody(response);
  assert.equal(body.window_days, 30);
  assert.equal(body.balance_window_days, 7);
  assert.equal(body.rollup_scan, "ok");
  assert.equal(body.balance_history_scan, "ok");
  assert.deepEqual(body.balance_history, []);
  assert.deepEqual(body.retention, {
    rollup_bucket_ms: HOUR_MS,
    rollup_window_ms: 30 * DAY_MS,
    balance_history_source_bucket_ms: HOUR_MS,
    balance_history_bucket_ms: HOUR_MS,
    balance_history_window_ms: 7 * DAY_MS,
  });
  assert.deepEqual(body.quota, {
    configured: false,
    available: false,
    cache_state: null,
    confidence: null,
    unlimited_quota: false,
    balance_quota: null,
    baseline_quota: null,
    quota_per_credit: null,
    balance_credits: null,
    baseline_credits: null,
    remaining_percent: null,
    used_percent: null,
    total_available: null,
    total_granted: null,
    total_used: null,
    observed_at_ms: null,
    cycle_started_at_ms: null,
    last_credit_at_ms: null,
    latest_refill_amount_credits: null,
    latest_refill_completed_at_ms: null,
  });

  const models = body.models as {
    model: string;
    provider: string;
    quota_source: string | null;
    usage: { window_days: number; request_count: number }[];
    estimates: unknown[];
  }[];
  assert.deepEqual(
    models.map((entry) => `${entry.model}/${entry.provider}`),
    ["gpt-5.6-sol/metered", "gpt-5.6-sol/surplus"]
  );
  assert.equal(models[0].quota_source, "metered");
  assert.equal(models[1].quota_source, null);
  assert.deepEqual(
    models[0].usage.map((window) => window.window_days),
    [30]
  );
  assert.equal(models[0].usage[0].request_count, 4);
  assert.equal(models[0].estimates.length, 1);
  assert.equal(models[1].estimates.length, 0);
  assert.equal(Object.hasOwn(body, "snapshot"), false);
});

test("quota projection normalizes window parameters and tolerates a missing ledger", async () => {
  kv.clearData();
  const sevenDay = await handleAdminProvidersQuotaProjection(
    new Request("https://ai.ubq.fi/admin/providers/quota-projection?window_days=7&balance_window_days=90")
  );
  const sevenBody = await readBody(sevenDay);
  assert.equal(sevenBody.window_days, 7);
  assert.equal(sevenBody.balance_window_days, 90);
  assert.equal((sevenBody.retention as { balance_history_window_ms: number }).balance_history_window_ms, 90 * DAY_MS);
  assert.deepEqual(sevenBody.models, []);

  const ninetyDay = await handleAdminProvidersQuotaProjection(new Request("https://ai.ubq.fi/admin/providers/quota-projection?window_days=90"));
  assert.equal((await readBody(ninetyDay)).window_days, 90);

  const unsupported = await handleAdminProvidersQuotaProjection(
    new Request("https://ai.ubq.fi/admin/providers/quota-projection?window_days=13&balance_window_days=3")
  );
  const unsupportedBody = await readBody(unsupported);
  assert.equal(unsupportedBody.window_days, 30);
  assert.equal(unsupportedBody.balance_window_days, 7);

  setKvForTest(null);
  try {
    const withoutKv = await handleAdminProvidersQuotaProjection();
    assert.equal(withoutKv.status, 200);
    const body = await readBody(withoutKv);
    assert.equal(body.rollup_scan, "unavailable");
    assert.equal(body.balance_history_scan, "unavailable");
    assert.deepEqual(body.balance_history, []);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }
});

test("quota projection resamples stored balance history for the configured account", async () => {
  kv.clearData();
  const apiKey = "metered-projection-key";
  const previous = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = apiKey;
  try {
    const { meterQuotaAccountFingerprint, readMeteredAccountCredentials } = await import("../src/metered-quota.ts");
    const fingerprint = await meterQuotaAccountFingerprint(readMeteredAccountCredentials());
    assert.ok(fingerprint);
    const observedAtMs = Date.now() - HOUR_MS;
    const bucketStartAtMs = Math.floor(observedAtMs / HOUR_MS) * HOUR_MS;
    kv.seed(["uos_ai", "metered_quota", "v1", "balance_history", fingerprint, bucketStartAtMs], {
      v: 1,
      bucket_start_at_ms: bucketStartAtMs,
      observed_at_ms: observedAtMs,
      balance_quota: 5_000,
      baseline_quota: 10_000,
      quota_per_credit: 500_000,
      remaining_percent: 50,
      unlimited_quota: false,
      total_available: null,
      total_granted: null,
      total_used: null,
    });

    const response = await handleAdminProvidersQuotaProjection(new Request("https://ai.ubq.fi/admin/providers/quota-projection?window_days=7"));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    assert.equal(body.balance_history_scan, "ok");
    const history = body.balance_history as { bucket_start_at_ms: number; observed_at_ms: number; balance_quota: number }[];
    assert.equal(history.length, 1);
    assert.equal(history[0].bucket_start_at_ms, bucketStartAtMs);
    assert.equal(history[0].observed_at_ms, observedAtMs);
    assert.equal(history[0].balance_quota, 5_000);
  } finally {
    if (previous === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = previous;
  }
});

test("quota projection backfill honours its limit and fails closed without KV", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminProvidersQuotaProjectionBackfill();
    assert.equal(unavailable.status, 503);
    assert.equal((await readError(unavailable)).error.message, "KV is unavailable");
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  const empty = await handleAdminProvidersQuotaProjectionBackfill(new Request("https://ai.ubq.fi/admin/providers/quota-projection/backfill?limit=abc"));
  assert.equal(empty.status, 200);
  const emptyBody = await readBody(empty);
  assert.equal(emptyBody.completed, true);
  assert.deepEqual(emptyBody.requests, { scanned: 0, processed: 0, rollups_written: 0, failed: 0, truncated: false });
  assert.deepEqual(emptyBody.windows, { scanned: 0, rewritten: 0, truncated: false });

  const bounded = await handleAdminProvidersQuotaProjectionBackfill(new Request("https://ai.ubq.fi/admin/providers/quota-projection/backfill?limit=5"));
  assert.equal(bounded.status, 200);
  assert.equal((await readBody(bounded)).completed, true);

  const capped = await handleAdminProvidersQuotaProjectionBackfill(new Request("https://ai.ubq.fi/admin/providers/quota-projection/backfill?limit=20000"));
  assert.equal(capped.status, 200);
});

test("codex reset settings list and patch the account switch", async () => {
  kv.clearData();
  setKvForTest(null);
  try {
    const unavailable = await handleAdminCodexResetSettings(new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets"));
    assert.equal(unavailable.status, 503);
    assert.equal((await readError(unavailable)).error.message, "Settings storage unavailable");
  } finally {
    setKvForTest(kv as unknown as Kv);
  }

  kv.seed(CODEX_AUTH_POOL_KEY, codexPoolEntry("account-coverage-1"));
  const accountIdHash = await sha256Hex("account-coverage-1");
  const cohortId = await sha256Hex("uos-prompt-cache-account-cohort-v1\u0000account-coverage-1");

  const listed = await handleAdminCodexResetSettings(new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets"));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("Cache-Control"), "no-store");
  const listBody = await readBody(listed);
  const rows = listBody.data as { slot: number; account_id_hash: string; account_cohort_id: string; enabled: boolean; available_count: number | null }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, 1);
  assert.equal(rows[0].account_id_hash, accountIdHash);
  assert.equal(rows[0].account_cohort_id, cohortId);
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].available_count, null);
  assert.equal(Object.hasOwn(rows[0], "account_id"), false);
  assert.equal(Object.hasOwn(rows[0], "access_token"), false);

  const patchBody = { account_id_hash: accountIdHash, enabled: false };
  const patched = await handleAdminCodexResetSettings(
    new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets", { method: "PATCH", body: JSON.stringify(patchBody) })
  );
  assert.equal(patched.status, 200);
  assert.deepEqual(await readBody(patched), patchBody);
  assert.deepEqual((await kv.get(codexResetUsageKey(accountIdHash))).value, { enabled: false });
  assert.equal((await readCodexResetUsage(kv as unknown as Kv, accountIdHash)).allowed, false);

  const relisted = await handleAdminCodexResetSettings(new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets"));
  const relistedRows = (await readBody(relisted)).data as { enabled: boolean }[];
  assert.equal(relistedRows[0].enabled, false);

  const reenabled = await handleAdminCodexResetSettings(
    new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets", {
      method: "PATCH",
      body: JSON.stringify({ account_id_hash: accountIdHash, enabled: true }),
    })
  );
  assert.equal(reenabled.status, 200);
  assert.equal((await readCodexResetUsage(kv as unknown as Kv, accountIdHash)).allowed, true);
});

test("codex reset settings expose bounded credit expiries without raw credit ids", async () => {
  const originalFetch = globalThis.fetch;
  kv.clearData();
  kv.seed(CODEX_AUTH_POOL_KEY, codexPoolEntry("account-reset-credits-1"));
  const credit = (id: string, expiresAt: string) => ({
    id,
    status: "available",
    reset_type: "codex_rate_limits",
    expires_at: expiresAt,
  });
  const stub = (inventory: () => Response | Promise<Response>) => {
    globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
      let url: string;
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.toString();
      else url = input.url;
      if (!url.endsWith("/backend-api/wham/rate-limit-reset-credits")) throw new Error(`unexpected request ${url}`);
      return Promise.resolve(inventory());
    });
  };
  try {
    // The detailed list is sorted by earliest expiry and never carries the raw id.
    stub(() =>
      Response.json({
        available_count: 2,
        credits: [credit("opaque-late-credit", "2026-10-20T00:00:00Z"), credit("opaque-soon-credit", "2026-10-12T00:00:00Z")],
      })
    );
    const listed = await handleAdminCodexResetSettings(new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets"));
    assert.equal(listed.status, 200);
    const rows = (await readBody(listed)).data as {
      available_count: number | null;
      credits: { status: string; expires_at_ms: number | null }[] | null;
    }[];
    assert.equal(rows[0].available_count, 2);
    assert.deepEqual(rows[0].credits, [
      { status: "available", expires_at_ms: Date.parse("2026-10-12T00:00:00Z") },
      { status: "available", expires_at_ms: Date.parse("2026-10-20T00:00:00Z") },
    ]);
    assert.equal(JSON.stringify(rows[0]).includes("opaque"), false, "raw credit ids never reach the admin surface");

    // A capped or mismatched detailed list is refused for diagnostics only: the
    // count still renders and the credits read as unavailable.
    stub(() => Response.json({ available_count: 2, credits: [credit("opaque-only-credit", "2026-10-12T00:00:00Z")] }));
    const capped = await handleAdminCodexResetSettings(new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets"));
    assert.equal(capped.status, 200);
    const cappedRow = ((await readBody(capped)).data as { available_count: number | null; credits: unknown }[])[0];
    assert.equal(cappedRow.available_count, 2);
    assert.equal(cappedRow.credits, null);

    // An unavailable upstream yields nulls while the endpoint still succeeds.
    stub(() => new Response(null, { status: 500 }));
    const unavailable = await handleAdminCodexResetSettings(new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets"));
    assert.equal(unavailable.status, 200);
    const unavailableRow = ((await readBody(unavailable)).data as { available_count: number | null; credits: unknown }[])[0];
    assert.equal(unavailableRow.available_count, null);
    assert.equal(unavailableRow.credits, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex reset settings patch rejects invalid bodies and stale subscriptions", async () => {
  kv.clearData();
  kv.seed(CODEX_AUTH_POOL_KEY, codexPoolEntry("account-coverage-2"));
  const accountIdHash = await sha256Hex("account-coverage-2");

  const nonJson = await handleAdminCodexResetSettings(new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets", { method: "PATCH", body: "{" }));
  assert.equal(nonJson.status, 400);
  assert.equal((await readError(nonJson)).error.message, "account_id_hash and boolean enabled are required");

  for (const body of [{}, { account_id_hash: accountIdHash }, { account_id_hash: accountIdHash, enabled: "yes" }]) {
    const invalid = await handleAdminCodexResetSettings(
      new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets", { method: "PATCH", body: JSON.stringify(body) })
    );
    assert.equal(invalid.status, 400);
  }

  const stale = await handleAdminCodexResetSettings(
    new Request("https://ai.ubq.fi/admin/providers/codex/banked-resets", {
      method: "PATCH",
      body: JSON.stringify({ account_id_hash: await sha256Hex("missing-account"), enabled: false }),
    })
  );
  assert.equal(stale.status, 409);
  assert.equal((await readError(stale)).error.message, "Subscription changed. Reload Providers.");
  assert.deepEqual((await kv.get(codexResetUsageKey(accountIdHash))).value, null);
});
