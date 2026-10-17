import { writePackage } from "./fixture-release.ts";
import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnFixture, outputFixture, type FixtureOutput } from "./fixture-process.ts";
import { createTestNativeKvPreload, currentTestNativeKvBinding } from "../../scripts/test-native-kv.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureParent = `${root}.cleanup-evidence/mac-event-maintenance-fixtures`;
const revision = "a".repeat(40);
const decoder = new TextDecoder();

const moduleUrl = (path: string): string => new URL(`../../${path}`, import.meta.url).href;
const importSource = (path: string): string => JSON.stringify(moduleUrl(path));

const bootstrapSource = (fixture: string): string => `
import assert from "node:assert/strict";
import { openKv, KvU64 } from ${importSource("src/storage/kv.ts")};
import { apiKeyIdKey } from ${importSource("src/api-keys.ts")};
import { getKv, setKvForTest } from ${importSource("src/kv.ts")};
import { admitPaidFallbackV3, updatePaidFallbackRequestV3 } from ${importSource("src/paid-fallback/ledger-admission.ts")};
import { markPaidFallbackTerminalV3, reconcileDuePaidFallbacksV3 } from ${importSource("src/paid-fallback/ledger-backfill.ts")};
import { recordMeteredTerminal, reservePaidFallback } from ${importSource("src/paid-fallback/index.ts")};
import { paidFallbackRequestV3Key, paidFallbackWindowV3Key, paidFallbackPendingV3Key,
  paidFallbackReconciliationLeaseV3Key } from ${importSource("src/paid-fallback/ledger-state.ts")};
import { recordPromptCacheAnalytics, prunePromptCacheAnalytics, promptCacheAnalyticsCounterKey,
  PROMPT_CACHE_ANALYTICS_BUCKET_MS, PROMPT_CACHE_ANALYTICS_RETENTION_MS } from ${importSource("src/cache/prompt-analytics.ts")};

const fixture = ${JSON.stringify(fixture)};
const realNow = Date.now;
const realSetTimeout = setTimeout;
let clock = realNow();
Date.now = () => clock;
const nativeOpen = openKv;
const mac = await nativeOpen(fixture + "/.data/kv-bun.sqlite3");
const isolated = await nativeOpen(fixture + "/.data/isolated.sqlite3");
await isolated.set(["isolation"], "untouched");
const isolatedBefore = await isolated.get(["isolation"]);
const logRows = [];
const state = { intervalArms: 0, intervalCallbacks: [], startupReconciles: 0, startupPrunes: 0,
  startupSettled: 0, stopCalls: 0, stopSettled: 0, closeCalls: 0, providerReads: 0,
  timeoutArms: 0,
  sameKv: false, nativeOpenCalls: 0, shutdownTelemetry: 0, serveCalls: 0,
  actualHostOs: process.platform, targetEntryOs: "darwin", realMacKernel: process.platform === "darwin" };
globalThis.maintenanceFixture = state;
globalThis.setInterval = (callback) => { state.intervalArms += 1; state.intervalCallbacks.push(callback); return 1; };
globalThis.clearInterval = () => {};
globalThis.setTimeout = (...args) => { state.timeoutArms += 1; return realSetTimeout(...args); };
globalThis.fetch = (input) => {
  const url = new URL(String(input));
  assert.equal(url.origin + url.pathname, "https://api.openlux.ai/api/log/token", "only the provider-log endpoint may run");
  assert.equal(url.searchParams.get("key"), "synthetic-mac-fixture");
  state.providerReads += 1;
  return Promise.resolve(Response.json({ success: true, data: logRows }));
};
const waitFor = async (predicate, description) => {
  const deadline = performance.now() + 5_000;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(description);
    await new Promise(resolve => realSetTimeout(resolve, 5));
  }
};
const input = (requestId, keyId = "fixture-key") => ({ keyId, requestId, createdAtMs: clock,
  policyVersion: "fixture-policy", limitMicrocredits: 1_000_000, maximumExposureMicrocredits: 250_000,
  initialSettledMicrocredits: 0, quotaPerCredit: 500_000, windowResetAtMs: clock + 8 * 60 * 60_000,
  model: "gpt-5-codex", route: "responses", path: "/v1/responses", stream: false, reasoning: "high" });
const seedAdmissionPolicy = async keyId => {
  await mac.set(apiKeyIdKey(keyId), {
    id: keyId, name: "Mac fixture", prefix: "u_fixture", hash: "fixture-hash",
    created_at_ms: clock - 60_000, expires_at_ms: -1, revoked_at_ms: null,
    usage_limit_requests: 100, usage_requests: 0, usage_reset_at_ms: clock + 8 * 60 * 60_000,
    window_ms: 8 * 60 * 60_000, paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 250_000, paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0, paid_fallback_reservation_request_id: null,
    paid_fallback_model_ids: ["gpt-5-codex"], paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { "gpt-5-codex": 250_000 },
    paid_fallback_pricing_checked_at_ms: Math.max(1, clock - 1),
  });
};
const seedBilling = async (requestId, includeLog = true, keyId = "fixture-key") => {
  const admission = await admitPaidFallbackV3(input(requestId, keyId));
  assert.equal(admission.kind, "reserved");
  await updatePaidFallbackRequestV3(admission.reservation, {
    provider: "metered", provider_request_id: "provider-" + requestId, dispatch_state: "dispatched",
  });
  if (includeLog) logRows.push({ request_id: "provider-" + requestId, quota: 25_000, prompt_tokens: 5,
    completion_tokens: 6, model_name: "gpt-5-codex", created_at: Math.trunc(clock / 1_000) });
  return admission.reservation;
};
const settled = async (requestId, keyId = "fixture-key") =>
  (await mac.get(paidFallbackRequestV3Key(keyId, requestId))).value?.billing_state === "settled";
const assertReleased = async reservation => {
  assert.equal(await settled(reservation.request_id, reservation.key_id), true);
  const window = await mac.get(paidFallbackWindowV3Key(reservation.key_id, reservation.window_reset_at_ms));
  assert.equal(window.value.reserved_microcredits, 0);
  assert.equal(window.value.pending_count, 0);
};
const expiredCounterKey = () => promptCacheAnalyticsCounterKey(
  Math.floor((clock - PROMPT_CACHE_ANALYTICS_RETENTION_MS - 60_000) / PROMPT_CACHE_ANALYTICS_BUCKET_MS)
    * PROMPT_CACHE_ANALYTICS_BUCKET_MS, "sample_count");

// Positive native baseline establishes the real settlement/prune contract before
// checking that the launcher's helper performs the same work without a timer.
setKvForTest(mac);
const baseline = await seedBilling("baseline");
await markPaidFallbackTerminalV3(baseline, "completed");
const baselineCounter = expiredCounterKey();
await mac.set(baselineCounter, new KvU64(1n));
assert.equal(await reconcileDuePaidFallbacksV3(clock, mac), 1);
await assertReleased(baseline);
assert.equal((await prunePromptCacheAnalytics({ kv: mac, now: () => clock })).status, "pruned");
assert.equal((await mac.get(baselineCounter)).value, null);

const startup = await seedBilling("startup");
await markPaidFallbackTerminalV3(startup, "completed");
const startupCounter = expiredCounterKey();
await mac.set(startupCounter, new KvU64(1n));
setKvForTest(null);

let finishServe;
const finished = new Promise(resolve => { finishServe = resolve; });
state.kv = mac;
state.serve = () => { state.serveCalls += 1; return { finished, shutdown: () => { finishServe(); return Promise.resolve(); } }; };
const close = mac.close.bind(mac);
mac.close = () => {
  assert.equal(state.stopSettled >= 1, true, "startup jobs must settle before KV close");
  assert.equal(state.shutdownTelemetry, 1);
  state.closeCalls += 1;
  console.log(JSON.stringify({ fixture: "mac-event-maintenance", ...state, kv: undefined, serve: undefined, stop: undefined, intervalCallbacks: undefined }));
  close();
};
const entry = import(${JSON.stringify(`${fixture}/.data/releases/${revision}/scripts/serve-mac.ts`)});
await waitFor(() => state.serveCalls === 1 && state.startupSettled === 2, "startup maintenance did not settle");
assert.equal(await getKv(), mac);
assert.equal(state.sameKv, true);
assert.equal(state.nativeOpenCalls, 1, "the Mac entry must reuse its initialized database");
assert.equal(state.startupReconciles, 1);
assert.equal(state.startupPrunes, 1);
assert.equal(state.timeoutArms, 0, "the Mac entry must not register request-owned retry timers");
await assertReleased(startup);
assert.equal((await mac.get(startupCounter)).value, null);
assert.equal(state.intervalArms, 0, "the actual Mac entry must not register periodic maintenance");

const readsBeforeIdle = state.providerReads;
clock += 2 * 60 * 60_000;
for (const callback of state.intervalCallbacks) callback();
await new Promise(resolve => realSetTimeout(resolve, 10));
assert.equal(state.providerReads, readsBeforeIdle, "clock advance without an event must do no billing work");
assert.equal(state.startupReconciles, 1);
assert.equal(state.startupPrunes, 1);

// A terminal event with no visible provider log performs one best-effort read,
// then deliberately leaves durable exposure pending while this Mac is quiet.
// The later log and blocked admission below prove both fail-closed accounting
// and the existing event-driven recovery path.
const delayedKey = "delayed-key";
await seedAdmissionPolicy(delayedKey);
const delayed = await seedBilling("delayed-log", false, delayedKey);
const readsBeforeDeferred = state.providerReads;
await recordMeteredTerminal(delayed, "completed");
await waitFor(async () => {
  const request = (await mac.get(paidFallbackRequestV3Key(delayedKey, delayed.request_id))).value;
  const pending = (await mac.get(paidFallbackPendingV3Key(delayedKey, delayed.request_id))).value;
  return state.providerReads === readsBeforeDeferred + 1 && request?.billing_state === "pending" && pending?.next_reconciliation_at_ms > clock;
}, "the missing provider log did not defer the native settlement");
const deferredRequest = (await mac.get(paidFallbackRequestV3Key(delayedKey, delayed.request_id))).value;
assert.equal(deferredRequest?.spend_microcredits, null);
const deferredWindow = (await mac.get(paidFallbackWindowV3Key(delayedKey, delayed.window_reset_at_ms))).value;
assert.equal(deferredWindow?.reserved_microcredits, 250_000);
assert.equal(deferredWindow?.pending_count, 1);
const readsBeforeQuiet = state.providerReads;
clock += 2 * 60 * 60_000;
await new Promise(resolve => realSetTimeout(resolve, 10));
assert.equal(state.providerReads, readsBeforeQuiet, "an idle Mac must not retry a deferred settlement");
assert.equal(state.timeoutArms, 0, "a quiet Mac must not arm deferred settlement timers");
assert.equal(await settled(delayed.request_id, delayedKey), false);
logRows.push({ request_id: "provider-delayed-log", quota: 25_000, prompt_tokens: 5,
  completion_tokens: 6, model_name: "gpt-5-codex", created_at: Math.trunc((clock - 2 * 60 * 60_000) / 1_000) });
assert.equal(await settled(delayed.request_id, delayedKey), false, "a late log alone is not an event");
const readsBeforeBlockedAdmission = state.providerReads;
const recovered = await reservePaidFallback({ keyId: delayedKey, requestId: "after-quiet", createdAtMs: clock,
  model: "gpt-5-codex", route: "responses", path: "/v1/responses", stream: false, reasoning: "high", reason: "primary_429" });
assert.equal(recovered.kind, "reserved");
assert.equal(recovered.reservation.reserved_microcredits, 200_000);
assert.equal(state.providerReads, readsBeforeBlockedAdmission + 1, "a blocked admission must perform the due recovery read");
const settledDelayed = (await mac.get(paidFallbackRequestV3Key(delayedKey, delayed.request_id))).value;
assert.equal(settledDelayed?.billing_state, "settled");
assert.equal(settledDelayed?.spend_microcredits, 50_000);
const recoveredWindow = (await mac.get(paidFallbackWindowV3Key(delayedKey, delayed.window_reset_at_ms))).value;
assert.equal(recoveredWindow?.settled_microcredits, 50_000);
assert.equal(recoveredWindow?.reserved_microcredits, 200_000);
assert.equal(recoveredWindow?.pending_count, 1);
assert.equal((await mac.get(paidFallbackPendingV3Key(delayedKey, delayed.request_id))).value, null);
assert.equal((await mac.get(paidFallbackReconciliationLeaseV3Key(delayedKey))).value, null);

const later = await seedBilling("later-event");
await recordMeteredTerminal(later, "completed");
await waitFor(() => settled("later-event"), "the existing terminal event did not reconcile the Mac KV");
await assertReleased(later);
await waitFor(async () => (await mac.get(paidFallbackPendingV3Key("fixture-key", "later-event"))).value === null
  && (await mac.get(paidFallbackReconciliationLeaseV3Key("fixture-key"))).value === null,
  "the terminal event must release its native lease before KV shutdown");
const laterCounter = expiredCounterKey();
await mac.set(laterCounter, new KvU64(1n));
assert.equal(await getKv(), mac, "the event must retain the initialized native fixture handle");
const analytics = await recordPromptCacheAnalytics({ provider: "chatgpt_codex", model: "fixture-model",
  route: "responses", status: 200, completed: true, usageTelemetryStatus: "reported",
  inputTokens: 100, cachedInputTokens: 25, cacheWriteInputTokens: null,
  promptCacheKeyPresent: false, promptCacheMode: "implicit", fallbackReason: null },
  { now: () => clock, release: ${JSON.stringify(revision)} });
assert.equal(analytics.status, "recorded");
await waitFor(async () => (await mac.get(laterCounter)).value === null,
  "the existing new-bucket analytics event did not prune the Mac KV");
assert.deepEqual(await isolated.get(["isolation"]), isolatedBefore);
let isolatedRows = 0;
for await (const unused of isolated.list({ prefix: [] })) isolatedRows += 1;
assert.equal(isolatedRows, 1, "the distinct database must not receive Mac ledger/analytics writes");
isolated.close();
const stop = state.stop;
const firstStop = stop();
assert.equal(stop(), firstStop, "the existing stop closure must stay idempotent");
await firstStop;
finishServe();
await entry;
`;

const fixtureSources = (fixture: string): Record<string, string> => ({
  "ops/release-artifact.ts": `export const verifyReleasePayload = () => Promise.resolve({ schema: 3, native_kv: {} });`,
  "ops/native-kv-release.ts": `export const nativeKvReleaseBinding = () => ({});`,
  "src/storage/native-addon.ts": `export const prepareNativeKvBackend = () => {};`,
  "src/runtime/native-kv-bootstrap.ts": `export const prepareNativeKvForDevelopment = () => Promise.resolve();`,
  "src/config.ts": `export const config = { isDeploy: false }; export const runtimeGitSha = () => ${JSON.stringify(revision)};`,
  "src/kv.ts": `import { initializeKv as install, getKv } from ${importSource("src/kv.ts")};
    export { getKv }; export const initializeKv = kv => { install(kv); globalThis.maintenanceFixture.sameKv = true; };`,
  "src/codex/reset-settings.ts": `export const migrateLegacyCodexResetOptOut = () => Promise.resolve("not_required");`,
  "src/auth/local-admin.ts": `export const parseServeRuntimeOptions = () => ({ disableAdminAuth: false });
    export const configureAdminAuthForListener = () => false;
    export const configureAdminAuthPeerForRequest = () => {};
    export const configureMacLocalAdminAuthBypassForListener = () => {};`,
  "src/auth/local-development-key.ts": `export const ensureLocalDevelopmentApiKey = () => Promise.resolve("exists");`,
  "src/cache/prompt-analytics.ts": `import { prunePromptCacheAnalytics as prune } from ${importSource("src/cache/prompt-analytics.ts")};
    export const closeOptionalPromptCacheAnalytics = () => Promise.resolve();
    export const optionalPromptCacheAnalyticsSnapshot = () => null;
    export const prunePromptCacheAnalytics = async options => {
      globalThis.maintenanceFixture.startupPrunes += 1;
      const value = await prune(options); globalThis.maintenanceFixture.startupSettled += 1; return value;
    };`,
  "src/paid-fallback/ledger-backfill.ts": `import { reconcileDuePaidFallbacksV3 as reconcile } from ${importSource("src/paid-fallback/ledger-backfill.ts")};
    export const reconcileDuePaidFallbacksV3 = async (now, kv) => {
      globalThis.maintenanceFixture.startupReconciles += 1;
      const value = await reconcile(now, kv); globalThis.maintenanceFixture.startupSettled += 1; return value;
    };`,
  "src/handler/serve-handler.ts": `export const createServeHandler = () => () => new Response("fixture"); export const createServeUpgradeHandler = () => () => undefined;`,
  "serve.ts": `import { application as handler, startMacMaintenance as start, shutdownOptionalTelemetry as drain } from "./maintenance.ts";
    export const application = handler;
    export const startMacMaintenance = kv => {
      const stop = start(kv); globalThis.maintenanceFixture.stop = stop;
      return () => {
        globalThis.maintenanceFixture.stopCalls += 1;
        const pending = stop(); pending.then(() => { globalThis.maintenanceFixture.stopSettled += 1; }); return pending;
      };
    };
    export const shutdownOptionalTelemetry = async () => {
      await drain(); globalThis.maintenanceFixture.shutdownTelemetry += 1;
    };`,
  "fixture-kv.ts": `export * from ${importSource("src/storage/kv.ts")}; export const openKv = async path => { const state = globalThis.maintenanceFixture;
    state.nativeOpenCalls += 1; if (path !== ${JSON.stringify(fixture + "/.data/kv-bun.sqlite3")}) throw new Error("wrong KV"); return state.kv; };`,
  "fixture-http.ts": `export * from ${importSource("src/runtime/http.ts")}; export const serveHttp = () => globalThis.maintenanceFixture.serve();`,
  "bootstrap.ts": bootstrapSource(fixture),
});

const sha256 = async (value: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");

test("Mac entry preserves event maintenance and defers missing settlement logs without periodic intervals", async () => {
  const originalLauncher = await readFile(`${root}scripts/serve-mac.ts`, "utf8");
  const guard = 'if (process.platform !== "darwin") throw new Error("The Mac service requires macOS");';
  assert.equal(originalLauncher.split(guard).length - 1, 1);
  let launcher = originalLauncher;
  const hostGuard = 'if (process.platform !== "linux") throw new Error("Fixture host mismatch");';
  if (process.platform !== "darwin") launcher = launcher.replace(guard, hostGuard);
  assert.equal(launcher.split('import("#kv")').length - 1, 1);
  assert.equal(launcher.split('import("#http")').length - 1, 1);
  launcher = launcher.replace('import("#kv")', 'import("../fixture-kv.ts")').replace('import("#http")', 'import("../fixture-http.ts")');
  const restored = launcher.replace('import("../fixture-kv.ts")', 'import("#kv")').replace('import("../fixture-http.ts")', 'import("#http")');
  assert.equal(process.platform === "darwin" ? restored : restored.replace(hostGuard, guard), originalLauncher);
  const maintenance = await readFile(`${root}serve.ts`, "utf8");
  await mkdir(fixtureParent, { recursive: true });
  const fixture = await mkdtemp(fixtureParent + "/" + "native-");
  const release = `${fixture}/.data/releases/${revision}`;
  const hashes: Record<string, string> = {};
  try {
    await mkdir(`${fixture}/.data`, { recursive: true });
    await mkdir(release, { recursive: true });
    await writePackage(release, { "#kv": "./fixture-kv.ts", "#http": "./fixture-http.ts" });
    await writePackage(fixture, { "#kv": `./.data/releases/${revision}/fixture-kv.ts`, "#http": `./.data/releases/${revision}/fixture-http.ts` });
    for (const [path, source] of Object.entries(fixtureSources(fixture))) {
      const absolute = path === "bootstrap.ts" ? `${fixture}/${path}` : `${release}/${path}`;
      await mkdir(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
      await writeFile(absolute, source);
      hashes[path] = await sha256(await readFile(absolute, "utf8"));
    }
    await mkdir(`${release}/scripts`, { recursive: true });
    await writeFile(`${release}/scripts/serve-mac.ts`, launcher);
    await writeFile(`${release}/maintenance.ts`, maintenance);
    assert.equal(await sha256(await readFile(`${release}/scripts/serve-mac.ts`, "utf8")), await sha256(launcher));
    assert.equal(await sha256(await readFile(`${release}/maintenance.ts`, "utf8")), await sha256(maintenance));
    hashes["scripts/serve-mac.ts"] = await sha256(launcher);
    hashes["maintenance.ts"] = await sha256(maintenance);
    const child = spawnFixture(process.execPath, {
      args: [
        "--no-env-file",
        "--no-install",
        "--define",
        "UOS_TEST_NATIVE_KV_BINDING:" + JSON.stringify(currentTestNativeKvBinding()),
        "--preload",
        createTestNativeKvPreload(fixture),
        `${fixture}/bootstrap.ts`,
      ],
      cwd: fixture,
      clearEnv: true,
      env: { HOME: fixture, METERED_API_KEY: "synthetic-mac-fixture" },
      stdout: "piped",
      stderr: "piped",
    });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20_000);
    let result: FixtureOutput;
    try {
      result = await outputFixture(child);
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(result.code, 0, `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`);
    const probeLine = decoder
      .decode(result.stdout)
      .split("\n")
      .find((line) => line.startsWith('{"fixture":"mac-event-maintenance"'));
    assert.ok(probeLine, "the actual entry must reach KV close with its completed probe");
    const probe = JSON.parse(probeLine) as Record<string, unknown>;
    assert.equal(probe.intervalArms, 0);
    assert.equal(probe.startupReconciles, 1);
    assert.equal(probe.startupPrunes, 1);
    assert.equal(probe.sameKv, true);
    assert.equal(probe.closeCalls, 1);
    assert.equal(probe.nativeOpenCalls, 1);
    assert.equal(probe.serveCalls, 1);
    assert.equal(probe.shutdownTelemetry, 1);
    assert.equal(probe.actualHostOs, process.platform);
    assert.equal(probe.targetEntryOs, "darwin");
    assert.equal(probe.realMacKernel, process.platform === "darwin");
    console.info(
      JSON.stringify({
        fixtureManifest: { ...hashes, actualHostOs: process.platform, targetEntryOs: "darwin", realMacKernel: process.platform === "darwin" },
        probe,
      })
    );
  } finally {
    await rm(fixture, { recursive: true });
  }
});
