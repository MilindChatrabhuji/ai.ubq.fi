import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import { type AtomicOperation, type Kv, type KvCommitResult, type KvEntryMaybe, type KvKey } from "#kv";
import assert from "node:assert/strict";

import {
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_AUTH_REFRESH_LEASE_PREFIX,
  CODEX_REFRESH_CLIENT_ID,
  CODEX_REFRESH_TOKEN_URL,
  CODEX_AUTH_REAUTH_WARNING,
  CODEX_CLIENT_VERSION,
  CodexError,
  accessTokenExpired,
  cacheCodexAuthPool,
  codexAuthWarningForError,
  codexProbeByResponse,
  codexProbeTransitionsInFlight,
  codexRoutingErrors,
  getCodexRoutingError,
  codexUserAgent,
  getAuthPoolEntry,
  getCodexAccountEmail,
  getCodexResponseAccountCohortId,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  getCodexRoutingProbe,
  getJwtExpMs,
  inheritCodexResponseActiveTelemetry,
  markCodexResponseCompleted,
  markCodexResponseUpstreamError,
  needsRefresh,
  parseCodexAuthFromAuthJson,
  parseCodexAuthPool,
  releaseCodexResponseProbe,
  refreshesInFlight,
  resetCodexAuthCacheForTest,
  setCodexResponseAccountTelemetry,
  setCodexResponseActiveTelemetry,
  upsertCodexAuthAccount,
  withCodexAuthWarning,
  withCodexWarnings,
} from "../src/codex/auth.ts";
import {
  abortReasonAsError,
  awaitWithoutCancellingSharedWork,
  getCurrentAccountEntry,
  getValidAuth,
  refreshAuthCoordinated,
  refreshAuthStateless,
} from "../src/codex/auth-refresh.ts";
import type { RoutingAccount } from "../src/codex/routing-state.ts";
import { sha256Hex } from "../src/utils.ts";
import { setKvForTest } from "../src/kv.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";

/* ------------------------------------------------------------------ fixtures */

const encodeBase64Url = (value: unknown): string =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/={1,2}$/, "");

/** A decodable JWT-shaped token; only the payload matters to the gateway. */
const jwtLike = (payload: unknown): string => `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url(payload)}.signature`;

const accessTokenExpiringIn = (milliseconds: number): string => jwtLike({ exp: Math.floor((Date.now() + milliseconds) / 1_000) });

const accountAuth = (accountId: string, accessToken: string, refreshToken = `refresh-${accountId}`): CodexAuthState => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  account_id: accountId,
  updated_at_ms: Date.now(),
});

const poolOf = (...accounts: CodexAuthState[]): CodexAuthPoolState => ({ accounts, updated_at_ms: Date.now() });

const routingAccount = (auth: CodexAuthState, extra: Partial<RoutingAccount> = {}): RoutingAccount => ({
  auth,
  slot: 0,
  accountIdHash: "account-one-hash",
  credentialVersion: "credential-one",
  quotaHeadroom: null,
  probeRequired: true,
  probeGeneration: 1,
  probeToken: "probe-token",
  ...extra,
});

/* ------------------------------------------------------------------ fake KV */

type KvWrite = { type: "set" | "delete"; key: KvKey };

const keyOf = (key: KvKey): string => JSON.stringify(key);

/**
 * In-memory KV with observable reads and failure injection. `openKv` is
 * not used by this fixture, so every KV-dependent path receives
 * this stub through `setKvForTest`.
 */
class ScriptedKv {
  readonly values = new Map<string, unknown>();
  readonly versions = new Map<string, number>();
  readonly gets: string[] = [];
  readonly writes: KvWrite[] = [];
  readonly commitAttempts: KvWrite[] = [];
  commitFailures = 0;
  commitThrows = 0;
  failLeaseDeleteCommit = false;
  rejectNextAuthGet = false;
  onGet: ((key: KvKey) => void) | null = null;

  /** The same stub viewed as the KV binding production code receives. */
  get binding(): Kv {
    return this as unknown as Kv;
  }

  get<T>(key: KvKey, options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    assert.equal(options?.consistency, "strong", "credential reads must be strong");
    const encoded = keyOf(key);
    this.gets.push(encoded);
    this.onGet?.(key);
    if (this.rejectNextAuthGet && encoded === keyOf(CODEX_AUTH_POOL_KV_KEY)) {
      this.rejectNextAuthGet = false;
      return Promise.reject(new Error("kv unavailable"));
    }
    const value = this.values.get(encoded) as T | undefined;
    const version = this.versions.get(encoded);
    return Promise.resolve({
      key,
      value: value ?? null,
      versionstamp: version === undefined ? null : String(version).padStart(20, "0"),
    } as KvEntryMaybe<T>);
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    this.writes.push({ type: "set", key });
    this.#apply({ type: "set", key, value });
    return Promise.resolve({ ok: true, versionstamp: String(this.versions.get(keyOf(key)) ?? 0).padStart(20, "0") });
  }

  atomic(): AtomicOperation {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const writes: { type: "set" | "delete"; key: KvKey; value?: unknown }[] = [];
    const chain = {
      check: (...entries: { key: KvKey; versionstamp: string | null }[]) => {
        checks.push(...entries);
        return chain;
      },
      set: (key: KvKey, value: unknown) => {
        writes.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        writes.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        this.commitAttempts.push(...writes);
        if (this.failLeaseDeleteCommit && writes.length === 1 && writes[0].type === "delete" && writes[0].key[1] === "codex_auth_refresh") {
          this.failLeaseDeleteCommit = false;
          return Promise.reject(new Error("release unavailable"));
        }
        if (this.commitThrows > 0) {
          this.commitThrows -= 1;
          return Promise.reject(new Error("commit unavailable"));
        }
        if (this.commitFailures > 0) {
          this.commitFailures -= 1;
          return Promise.resolve({ ok: false } as const);
        }
        for (const check of checks) {
          const current = this.versions.get(keyOf(check.key));
          const versionstamp = current === undefined ? null : String(current).padStart(20, "0");
          if (versionstamp !== check.versionstamp) return Promise.resolve({ ok: false } as const);
        }
        for (const write of writes) this.#apply(write);
        return Promise.resolve({ ok: true, versionstamp: "00000000000000000009" } as const);
      },
    };
    return chain as unknown as AtomicOperation;
  }

  /** Runs one isolated test with this stub installed and every codex singleton reset. */
  static async run(run: (kv: ScriptedKv) => Promise<void>): Promise<void> {
    const kv = new ScriptedKv();
    setKvForTest(kv as unknown as Kv);
    resetCodexAuthCacheForTest();
    resetProviderHealthThrottleForTest();
    try {
      await run(kv);
    } finally {
      setKvForTest(null);
      resetCodexAuthCacheForTest();
      resetProviderHealthThrottleForTest();
    }
  }

  #apply(write: { type: "set" | "delete"; key: KvKey; value?: unknown }): void {
    const encoded = keyOf(write.key);
    if (write.type === "delete") {
      this.values.delete(encoded);
      this.writes.push({ type: "delete", key: write.key });
      this.versions.set(encoded, (this.versions.get(encoded) ?? 0) + 1);
      return;
    }
    this.writes.push({ type: "set", key: write.key });
    this.values.set(encoded, write.value);
    this.versions.set(encoded, (this.versions.get(encoded) ?? 0) + 1);
  }
}

/** Waits for one fire-and-forget health write without depending on wall-clock time. */
const settleAsyncWork = async (predicate: () => boolean, attempts = 50): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return predicate();
};

/* --------------------------------------------------------------------- tests */

test("codexUserAgent keeps the higher of the requested and pinned client versions", () => {
  assert.equal(codexUserAgent("0.99.0"), `codex_cli_rs/${CODEX_CLIENT_VERSION} (ai.ubq.fi)`, "an older patch line keeps the pinned version");
  assert.equal(codexUserAgent("0.100.1"), "codex_cli_rs/0.100.1 (ai.ubq.fi)");
  assert.equal(codexUserAgent("2.0"), "codex_cli_rs/2.0 (ai.ubq.fi)", "a two-part version is accepted verbatim");
  assert.equal(codexUserAgent("  0.200.0  "), "codex_cli_rs/0.200.0 (ai.ubq.fi)", "surrounding whitespace is trimmed");
  assert.equal(codexUserAgent(null), `codex_cli_rs/${CODEX_CLIENT_VERSION} (ai.ubq.fi)`);
  assert.equal(codexUserAgent(""), `codex_cli_rs/${CODEX_CLIENT_VERSION} (ai.ubq.fi)`, "an empty version never replaces the pinned one");
  assert.equal(codexUserAgent("1"), "codex_cli_rs/1 (ai.ubq.fi)", "an unparsable version is reported verbatim rather than guessed at");
  assert.equal(codexUserAgent("1.-2.3"), "codex_cli_rs/1.-2.3 (ai.ubq.fi)", "a negative component is unparsable and kept verbatim");
});

test("parseCodexAuthFromAuthJson accepts only a complete token triple", () => {
  assert.deepEqual(parseCodexAuthFromAuthJson({ tokens: { access_token: "a", refresh_token: "r", account_id: "id" } }), {
    access_token: "a",
    refresh_token: "r",
    account_id: "id",
  });
  assert.equal(parseCodexAuthFromAuthJson({ tokens: null }), null);
  assert.equal(parseCodexAuthFromAuthJson({}), null);
  assert.equal(parseCodexAuthFromAuthJson({ tokens: { access_token: "a", refresh_token: "r" } }), null);
  assert.equal(parseCodexAuthFromAuthJson(null), null);
});

test("parseCodexAuthPool rejects a pool that is not a bounded, unique, complete account list", () => {
  const valid = poolOf(accountAuth("one", "access-one"));
  assert.deepEqual(parseCodexAuthPool(valid), valid);
  assert.equal(parseCodexAuthPool({ accounts: [accountAuth("one", "a")] }), null, "a missing pool timestamp is rejected");
  assert.equal(parseCodexAuthPool({ accounts: [7], updated_at_ms: 1 }), null, "a non-object account is rejected");
  assert.equal(parseCodexAuthPool({ accounts: [], updated_at_ms: 1 }), null);
  assert.equal(parseCodexAuthPool({ accounts: [accountAuth("a", "x"), accountAuth("b", "y"), accountAuth("c", "z")], updated_at_ms: 1 }), null);
  assert.equal(
    parseCodexAuthPool({ accounts: [accountAuth("same", "x"), accountAuth("same", "y")], updated_at_ms: 1 }),
    null,
    "a duplicated account id is rejected"
  );
  assert.equal(parseCodexAuthPool({ accounts: [{ access_token: "a", refresh_token: "r", account_id: "one" }], updated_at_ms: 1 }), null);
});

test("upsertCodexAuthAccount replaces, appends and refuses to grow the pool", () => {
  const first = accountAuth("one", "access-one");
  const second = accountAuth("two", "access-two");
  const replaced = upsertCodexAuthAccount(poolOf(first, second), accountAuth("one", "access-one-new"));
  assert.ok(replaced);
  assert.equal(replaced.accounts.length, 2);
  assert.equal(replaced.accounts[0].access_token, "access-one-new");
  assert.equal(replaced.accounts[1].account_id, "two");

  const appended = upsertCodexAuthAccount(poolOf(first), second);
  assert.ok(appended);
  assert.deepEqual(
    appended.accounts.map((account) => account.account_id),
    ["one", "two"]
  );

  assert.equal(upsertCodexAuthAccount(poolOf(first, second), accountAuth("three", "access-three")), null, "a full pool refuses a new account");
  const seeded = upsertCodexAuthAccount(null, first);
  assert.ok(seeded);
  assert.deepEqual(
    seeded.accounts.map((account) => account.account_id),
    ["one"]
  );
});

test("JWT expiry parsing, refresh need and expiry checks agree on the same token", () => {
  const expiring = accessTokenExpiringIn(60_000);
  const healthy = accessTokenExpiringIn(10 * 60_000);
  assert.equal(getJwtExpMs(expiring), Math.floor((Date.now() + 60_000) / 1_000) * 1_000);
  assert.equal(getJwtExpMs("a.b"), null);
  assert.equal(getJwtExpMs("a..c"), null, "an empty payload segment carries no claims");
  assert.equal(getJwtExpMs(`${encodeBase64Url({ alg: "none" })}.${btoa("not json")}.sig`), null, "an undecodable payload is not guessed at");
  assert.equal(getJwtExpMs(`${encodeBase64Url({ alg: "none" })}.${encodeBase64Url([1, 2])}.sig`), null, "a non-object payload has no expiry");
  assert.equal(getJwtExpMs(`${encodeBase64Url({ alg: "none" })}.${encodeBase64Url({ exp: "soon" })}.sig`), null, "a non-numeric expiry is not guessed at");
  assert.equal(getJwtExpMs(7), null);

  assert.equal(needsRefresh({ ...accountAuth("one", expiring), updated_at_ms: Date.now() }), true, "a token inside the refresh window is refreshed");
  assert.equal(needsRefresh({ ...accountAuth("one", healthy), updated_at_ms: Date.now() }), false);
  const opaque = accountAuth("one", "opaque-token");
  assert.equal(needsRefresh({ ...opaque, updated_at_ms: Date.now() - 8 * 60_000 }), true, "an opaque token falls back to its age");
  assert.equal(needsRefresh({ ...opaque, updated_at_ms: Date.now() }), false);

  assert.equal(accessTokenExpired({ ...accountAuth("one", accessTokenExpiringIn(-1_000)), updated_at_ms: Date.now() }), true);
  assert.equal(accessTokenExpired({ ...accountAuth("one", healthy), updated_at_ms: Date.now() }), false);
  assert.equal(accessTokenExpired(opaque), false, "an opaque token has no provable expiry");
});

test("getCodexAccountEmail reads only a usable provider email claim", () => {
  assert.equal(getCodexAccountEmail(jwtLike({ "https://api.openai.com/profile": { email: "dev@example.com" } })), "dev@example.com");
  assert.equal(getCodexAccountEmail(jwtLike({ email: "  fallback@example.com  " })), "fallback@example.com");
  assert.equal(getCodexAccountEmail(jwtLike({ email: "no-at-sign" })), null);
  assert.equal(getCodexAccountEmail(jwtLike({ email: "control\u0001@example.com" })), null, "a control character never reaches a caller");
  assert.equal(getCodexAccountEmail(jwtLike({ email: `${"a".repeat(320)}@example.com` })), null, "an over-long address is rejected");
  assert.equal(getCodexAccountEmail(jwtLike({ email: "" })), null);
  assert.equal(getCodexAccountEmail(jwtLike([1, 2])), null, "a non-object payload has no email claim");
  assert.equal(getCodexAccountEmail("a"), null, "a token without a payload segment has no claims");
});

test("codexAuthWarningForError maps only re-authentication failures to the dashboard warning", () => {
  assert.equal(codexAuthWarningForError(new CodexError("invalid", "codex_auth_invalid", 503)), CODEX_AUTH_REAUTH_WARNING);
  assert.equal(codexAuthWarningForError(new CodexError("refresh failed", "codex_auth_refresh_failed", 503)), CODEX_AUTH_REAUTH_WARNING);
  assert.equal(codexAuthWarningForError(new CodexError("reused", "refresh_token_reused", 401)), CODEX_AUTH_REAUTH_WARNING);
  assert.equal(codexAuthWarningForError(new CodexError("missing", "codex_auth_missing", 503)), null);
  assert.equal(codexAuthWarningForError(new Error("plain")), null);
  assert.equal(codexAuthWarningForError("not an error"), null);
});

test("withCodexWarnings merges, dedupes and only decorates a response that needs it", async () => {
  const plain = new Response("body", { status: 200 });
  assert.equal(withCodexWarnings(plain, []), plain, "a warning-free response is returned untouched");
  assert.equal(plain.headers.get("x-uos-warning"), null);

  const alreadyWarned = new Response("body", { status: 200, headers: { "x-uos-warning": "first" } });
  const mergeInput = alreadyWarned.clone();
  const undecorated = withCodexWarnings(alreadyWarned, []);
  assert.notEqual(undecorated, alreadyWarned);
  assert.equal(undecorated.headers.get("x-uos-warning"), "first");
  assert.equal(undecorated.status, 200);
  assert.equal(await undecorated.text(), "body");

  const merged = withCodexWarnings(mergeInput, ["second", "first"]);
  assert.equal(merged.headers.get("x-uos-warning"), "first, second", "an existing warning is never duplicated");
  assert.equal(alreadyWarned.headers.get("x-uos-warning"), "first", "the original response keeps its own headers");

  const authWarned = withCodexAuthWarning(new Response("body", { status: 502 }), CODEX_AUTH_REAUTH_WARNING);
  assert.equal(authWarned.headers.get("x-uos-warning"), CODEX_AUTH_REAUTH_WARNING);
  assert.equal(authWarned.status, 502);
});

test("response-local routing telemetry follows a decorated response and never explains a response that was not admitted", async () => {
  const auth = accountAuth("account-one", "access-one");
  const probe = routingAccount(auth);
  const response = new Response("body", { status: 200 });
  assert.deepEqual(
    getCodexResponseActiveTelemetry(response),
    { activeGeneration: null, activeTransitionReason: null },
    "an unadmitted response has no telemetry"
  );

  const undecided = new Response("body", { status: 200 });
  setCodexResponseActiveTelemetry(undecided, routingAccount(auth, { activeGeneration: undefined }));
  assert.deepEqual(getCodexResponseActiveTelemetry(undecided), { activeGeneration: null, activeTransitionReason: null });

  setCodexResponseActiveTelemetry(response, routingAccount(auth, { activeGeneration: 7, activeTransitionReason: "quota_exhausted" }));
  setCodexResponseAccountTelemetry(response, 1, "account-one");
  const decorated = withCodexWarnings(response, ["codex_quota_blocked"]);
  assert.notEqual(decorated, response);
  assert.deepEqual(getCodexResponseActiveTelemetry(decorated), { activeGeneration: 7, activeTransitionReason: "quota_exhausted" });
  assert.equal(getCodexResponseSlot(decorated), 1, "the admitted slot survives decoration");
  const cohort = await getCodexResponseAccountCohortId(decorated);
  assert.match(cohort ?? "", /^[0-9a-f]{64}$/, "the account cohort is an opaque digest");

  const sameAccount = new Response("other", { status: 200 });
  setCodexResponseAccountTelemetry(sameAccount, 0, "account-one");
  assert.equal(await getCodexResponseAccountCohortId(sameAccount), cohort, "the same account yields the same cohort digest");
  const otherAccount = new Response("other", { status: 200 });
  setCodexResponseAccountTelemetry(otherAccount, 0, "account-two");
  assert.notEqual(await getCodexResponseAccountCohortId(otherAccount), cohort);
  const anonymous = new Response("other", { status: 200 });
  assert.equal(await getCodexResponseAccountCohortId(anonymous), null);

  const target = new Response("target", { status: 200 });
  inheritCodexResponseActiveTelemetry(target, decorated);
  assert.deepEqual(getCodexResponseActiveTelemetry(target), { activeGeneration: 7, activeTransitionReason: "quota_exhausted" });
  const untouched = new Response("untouched", { status: 200 });
  inheritCodexResponseActiveTelemetry(untouched, anonymous);
  assert.deepEqual(getCodexResponseActiveTelemetry(untouched), { activeGeneration: null, activeTransitionReason: null });
  inheritCodexResponseActiveTelemetry(untouched, decorated);
  assert.deepEqual(getCodexResponseActiveTelemetry(untouched), { activeGeneration: 7, activeTransitionReason: "quota_exhausted" });

  const probeCarrier = new Response("probe", { status: 200 });
  setCodexResponseAccountTelemetry(probeCarrier, 1, "account-one");
  codexProbeByResponse.set(probeCarrier, probe);
  const probeDecorated = withCodexWarnings(probeCarrier, ["codex_upstream_degraded"]);
  assert.equal(getCodexRoutingProbe(probeDecorated)?.probeToken, "probe-token", "the recovery probe survives decoration");
  assert.deepEqual(getCodexResponseActiveTelemetry(probeDecorated), { activeGeneration: null, activeTransitionReason: null });
});

test("a terminal response records its outcome exactly once, even after decoration", async () => {
  await ScriptedKv.run(async (kv) => {
    const healthWrites = (): number => kv.writes.filter((write) => write.key[1] === "provider_health").length;

    const completed = new Response("ok", { status: 200 });
    setCodexResponseAccountTelemetry(completed, 0, "account-one");
    await markCodexResponseCompleted(completed);
    assert.ok(await settleAsyncWork(() => healthWrites() > 0), "a completed response records a provider-health success");
    const afterFirst = healthWrites();
    await markCodexResponseCompleted(completed);
    await releaseCodexResponseProbe(completed);
    assert.equal(healthWrites(), afterFirst, "a second terminal call on the same response records nothing new");

    const decorated = new Response("ok", { status: 200 });
    setCodexResponseAccountTelemetry(decorated, 0, "account-two");
    await releaseCodexResponseProbe(decorated);
    const afterDecoration = withCodexWarnings(decorated, ["codex_some_warning"]);
    await markCodexResponseCompleted(afterDecoration);
    await settleAsyncWork(() => false, 5);
    assert.equal(healthWrites(), afterFirst, "the terminal outcome survives decoration instead of being recorded twice");

    const failed = new Response("upstream broke", { status: 502 });
    setCodexResponseAccountTelemetry(failed, 0, "account-three");
    await markCodexResponseUpstreamError(failed);
    await markCodexResponseUpstreamError(failed);
    await settleAsyncWork(() => false, 5);
    assert.equal(healthWrites(), afterFirst, "a non-2xx response records no upstream-error health transition");

    const degraded = new Response("degraded", { status: 200 });
    setCodexResponseAccountTelemetry(degraded, 0, "account-four");
    await markCodexResponseUpstreamError(degraded);
    assert.ok(await settleAsyncWork(() => healthWrites() > afterFirst), "a trustworthy 2xx failure degrades provider health");
  });
});

test("getAuthPoolEntry serves the warm cache, coalesces concurrent reads and works without any KV binding", async () => {
  const pool = poolOf(accountAuth("one", accessTokenExpiringIn(10 * 60_000)));
  await ScriptedKv.run(async (kv) => {
    await kv.set(CODEX_AUTH_POOL_KV_KEY, pool);
    const first = await getAuthPoolEntry();
    assert.deepEqual(first.pool, pool);
    assert.equal(first.kv, kv, "a stored pool keeps its KV binding so a refresh can persist");
    const readsAfterFirst = kv.gets.filter((key) => key === keyOf(CODEX_AUTH_POOL_KV_KEY)).length;

    const warm = await getAuthPoolEntry();
    assert.equal(warm.pool, first.pool, "the warm cache serves the same pool object");
    assert.equal(kv.gets.filter((key) => key === keyOf(CODEX_AUTH_POOL_KV_KEY)).length, readsAfterFirst, "a warm read never touches KV");

    resetCodexAuthCacheForTest();
    setKvForTest(kv as unknown as Kv);
    const [concurrentA, concurrentB] = await Promise.all([getAuthPoolEntry(true), getAuthPoolEntry(true)]);
    assert.deepEqual(concurrentA.pool, pool);
    assert.equal(concurrentB.pool, concurrentA.pool, "overlapping strong reads share one in-flight pool read");
    assert.equal(
      kv.gets.filter((key) => key === keyOf(CODEX_AUTH_POOL_KV_KEY)).length,
      readsAfterFirst + 1,
      "single-flight collapses overlapping reads into one KV read"
    );
  });
});

test("getAuthPoolEntry fails closed without a KV binding and still serves a cached pool", async () => {
  const isolated = async (run: () => Promise<void>): Promise<void> => {
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    try {
      await run();
    } finally {
      setKvForTest(null);
      resetCodexAuthCacheForTest();
    }
  };

  await isolated(async () => {
    const cached = poolOf(accountAuth("one", accessTokenExpiringIn(10 * 60_000)));
    cacheCodexAuthPool(cached);
    const withoutKv = await getAuthPoolEntry(true);
    assert.deepEqual(withoutKv.pool, cached, "without a KV binding the cached pool is still served");
    assert.equal(withoutKv.kv, null);
    assert.equal(withoutKv.entry, null);
  });

  await isolated(async () => {
    // Without KV or a credential/home input there is no auth seed to fall back to:
    // the read fails closed instead of inventing credentials.
    assert.equal(process.env.CODEX_AUTH_JSON_B64, undefined);
    assert.equal(process.env.HOME, undefined);
    await assert.rejects(
      getAuthPoolEntry(true),
      (error: unknown) => error instanceof CodexError && error.code === "codex_auth_invalid" && error.status === 503
    );
  });
});

test("releaseCodexResponseProbe detaches a probe once and leaves the transition set empty", async () => {
  await ScriptedKv.run(async () => {
    const response = new Response("body", { status: 200 });
    setCodexResponseAccountTelemetry(response, 0, "account-one");
    codexProbeByResponse.set(response, routingAccount(accountAuth("account-one", "access-one")));
    await releaseCodexResponseProbe(response);
    assert.equal(getCodexRoutingProbe(response), null, "the released probe is detached from the response");
    assert.equal(codexProbeTransitionsInFlight.size, 0, "no probe transition is left in flight");
    await releaseCodexResponseProbe(response);
    assert.equal(getCodexRoutingProbe(response), null);
  });
});

test("a codex error carries its code, status and cause for the fallback adapter", () => {
  const cause = new Error("socket closed");
  const error = new CodexError("refresh unreachable", "codex_auth_refresh_unreachable", 502, cause);
  assert.equal(error.name, "CodexError");
  assert.equal(error.code, "codex_auth_refresh_unreachable");
  assert.equal(error.status, 502);
  assert.equal((error as { cause?: unknown }).cause, cause);
  assert.equal(new CodexError("plain", "codex_auth_missing", 503).cause, undefined);
});
/* ----------------------------------------------------------- auth refresh */

type FetchCall = { url: string; method: string | undefined; body: Record<string, unknown>; headers: Headers };

/** Replaces `fetch` for one test; the OAuth endpoint is never reached for real. */
const withStubbedFetch = async <TResult>(handler: (call: FetchCall) => Response | Error, run: (calls: FetchCall[]) => Promise<TResult>): Promise<TResult> => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call: FetchCall = { url, method: init?.method, body, headers: new Headers(init?.headers) };
    calls.push(call);
    const result = handler(call);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

const failureOf = async (run: () => Promise<unknown>): Promise<CodexError> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof CodexError, `expected a CodexError, received ${String(error)}`);
    return error;
  }
  throw new Error("expected the call to fail");
};

test("getCurrentAccountEntry reports an account that is no longer configured", async () => {
  await ScriptedKv.run(async (kv) => {
    const pool = poolOf(accountAuth("one", accessTokenExpiringIn(10 * 60_000)));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, pool);
    const entry = await getCurrentAccountEntry("one", true);
    assert.equal(entry.auth.account_id, "one");
    assert.deepEqual(entry.pool, pool);
    assert.equal(entry.kv, kv);

    const missing = await failureOf(() => getCurrentAccountEntry("gone", true));
    assert.equal(missing.code, "codex_auth_missing");
    assert.equal(missing.status, 503);
  });
});

test("refreshAuthStateless sends one official refresh request and reports each provider rejection with its own code", async () => {
  const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
  const cases: { name: string; status: number; payload: unknown; code: string; expectedStatus: number }[] = [
    { name: "a reused refresh token", status: 429, payload: { error: { code: "refresh_token_reused" } }, code: "refresh_token_reused", expectedStatus: 503 },
    { name: "an exact invalid_grant code", status: 400, payload: { error: "invalid_grant" }, code: "codex_auth_refresh_failed", expectedStatus: 401 },
    {
      name: "a described expired grant",
      status: 403,
      payload: { error_description: "refresh token expired" },
      code: "codex_auth_refresh_failed",
      expectedStatus: 401,
    },
    { name: "an undescribed 500", status: 500, payload: { error: { message: "internal" } }, code: "codex_auth_refresh_failed", expectedStatus: 503 },
    { name: "an unrecognized status", status: 418, payload: { detail: "teapot" }, code: "codex_auth_refresh_failed", expectedStatus: 503 },
  ];
  for (const testCase of cases) {
    await withStubbedFetch(
      () => jsonResponse(testCase.status, testCase.payload),
      async () => {
        const error = await failureOf(() => refreshAuthStateless(stale));
        assert.equal(error.code, testCase.code, testCase.name);
        assert.equal(error.status, testCase.expectedStatus, testCase.name);
      }
    );
  }

  await withStubbedFetch(
    () => new Response("<html>gateway error</html>", { status: 502 }),
    async () => {
      const error = await failureOf(() => refreshAuthStateless(stale));
      assert.equal(error.code, "codex_auth_refresh_failed");
      assert.equal(error.status, 503);
      assert.equal(error.message, "Codex auth refresh failed (status 502).", "an advisory body is ignored and the status stays authoritative");
    }
  );

  await withStubbedFetch(
    () => new Response("not json", { status: 200 }),
    async () => {
      const error = await failureOf(() => refreshAuthStateless(stale));
      assert.equal(error.code, "codex_auth_refresh_failed");
      assert.equal(error.status, 503);
      assert.match(error.message, /missing access_token/);
    }
  );

  await withStubbedFetch(
    () => new Error("network down"),
    async () => {
      const error = await failureOf(() => refreshAuthStateless(stale));
      assert.equal(error.code, "codex_auth_refresh_unreachable");
      assert.equal(error.status, 502);
    }
  );

  await withStubbedFetch(
    () => jsonResponse(200, { access_token: "fresh-access", refresh_token: "fresh-refresh" }),
    async (calls) => {
      const refreshed = await refreshAuthStateless(stale);
      assert.equal(refreshed.access_token, "fresh-access");
      assert.equal(refreshed.refresh_token, "fresh-refresh");
      assert.equal(refreshed.account_id, "one", "the account identity is never taken from the response");
      assert.ok(refreshed.updated_at_ms > 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, CODEX_REFRESH_TOKEN_URL);
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, {
        client_id: CODEX_REFRESH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: stale.refresh_token,
        scope: "openid profile email",
      });
    }
  );

  await withStubbedFetch(
    () => jsonResponse(200, { access_token: "only-access" }),
    async () => {
      const refreshed = await refreshAuthStateless(stale);
      assert.equal(refreshed.refresh_token, stale.refresh_token, "a response without a rotated refresh token keeps the stored one");
    }
  );
});

test("refreshAuthCoordinated adopts credentials another writer rotated during the refresh", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    const pool = poolOf(stale);
    await kv.set(CODEX_AUTH_POOL_KV_KEY, pool);
    const entry = await getCurrentAccountEntry("one", true);
    const rotated = accountAuth("one", "rotated-access", "rotated-refresh");

    const refreshed = await withStubbedFetch(
      () => {
        // Another writer persists its rotation while this refresh is in flight.
        cacheCodexAuthPool(poolOf(rotated));
        return jsonResponse(200, { access_token: "fetch-access", refresh_token: "fetch-refresh" });
      },
      async (calls) => {
        const result = await refreshAuthCoordinated(entry);
        assert.equal(calls.length, 1);
        return result;
      }
    );
    assert.equal(refreshed.access_token, "rotated-access", "a concurrent rotation wins over this request's own response");
    assert.equal(refreshed.refresh_token, "rotated-refresh");
    const stored = kv.values.get(keyOf(CODEX_AUTH_POOL_KV_KEY)) as CodexAuthPoolState;
    assert.equal(stored.accounts[0].access_token, stale.access_token, "the durable row was never overwritten by the racing refresh");
  });
});

test("refreshAuthCoordinated claims the cross-isolate lease, persists the rotated token and releases the lease", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);

    const refreshed = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "persisted-access", refresh_token: "persisted-refresh" }),
      async (calls) => {
        const result = await refreshAuthCoordinated(entry);
        assert.equal(calls.length, 1);
        return result;
      }
    );
    assert.equal(refreshed.access_token, "persisted-access");
    const stored = kv.values.get(keyOf(CODEX_AUTH_POOL_KV_KEY)) as CodexAuthPoolState;
    assert.equal(stored.accounts[0].access_token, "persisted-access", "the refreshed token is persisted with a compare-and-set");
    assert.equal(stored.accounts[0].refresh_token, "persisted-refresh");

    const leaseWrites = kv.writes.filter((write) => write.key[1] === "codex_auth_refresh");
    assert.ok(
      leaseWrites.some((write) => write.type === "set"),
      "the refresh runs under a claimed lease"
    );
    assert.ok(
      leaseWrites.some((write) => write.type === "delete"),
      "the lease is released after the refresh"
    );
    assert.equal(refreshesInFlight.size, 0, "no refresh attempt is left in flight");
  });
});

test("a waiter adopts the lease owner's rotated credentials instead of refreshing again", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    const rotated = accountAuth("one", "owner-rotated-access");
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);
    const leaseKey = [...CODEX_AUTH_REFRESH_LEASE_PREFIX, await sha256Hex("one")];
    await kv.set(leaseKey, { owner: "other-isolate", lease_until_ms: Date.now() + 120 });
    // The owner persists its rotation while this isolate waits on the lease.
    kv.onGet = (key) => {
      if (keyOf(key) === keyOf(leaseKey)) kv.values.set(keyOf(CODEX_AUTH_POOL_KV_KEY), poolOf(rotated));
    };

    const refreshed = await withStubbedFetch(
      () => new Error("a waiter must never reach the auth server"),
      async (calls) => {
        const result = await refreshAuthCoordinated(entry);
        assert.equal(calls.length, 0, "the waiter adopts the owner's token instead of issuing OAuth");
        return result;
      }
    );
    assert.equal(refreshed.access_token, "owner-rotated-access");
    const lease = kv.values.get(keyOf(leaseKey)) as { owner: string };
    assert.equal(lease.owner, "other-isolate", "the waiter never steals an observed lease");
  });
});

test("a lease that cannot be claimed falls open to a bounded direct refresh and a failed release stays harmless", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);
    kv.commitFailures = 3;

    const refreshed = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "unclaimed-access", refresh_token: "unclaimed-refresh" }),
      async (calls) => {
        const result = await refreshAuthCoordinated(entry);
        assert.equal(calls.length, 1);
        return result;
      }
    );
    assert.equal(refreshed.access_token, "unclaimed-access", "an unclaimable lease still refreshes, just without coordination");
  });

  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);
    kv.failLeaseDeleteCommit = true;

    const refreshed = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "release-failed-access", refresh_token: "release-failed-refresh" }),
      async () => await refreshAuthCoordinated(entry)
    );
    assert.equal(refreshed.access_token, "release-failed-access", "a lease release failure never masks completed refresh work");
    const releaseAttempts = kv.commitAttempts.filter((write) => write.key[1] === "codex_auth_refresh" && write.type === "delete");
    assert.equal(releaseAttempts.length, 1, "the release was attempted and its failure was swallowed");
  });
});

test("the coordinated refresh fails open when its own strong pool re-read is unavailable", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);
    kv.rejectNextAuthGet = true;

    const refreshed = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "fail-open-access", refresh_token: "fail-open-refresh" }),
      async () => await refreshAuthCoordinated({ ...entry, auth: stale })
    );
    assert.equal(refreshed.access_token, "fail-open-access", "an unavailable coordination read falls back to the supplied in-memory account");
  });
});

test("the coordinated refresh skips coordination entirely without a KV binding", async () => {
  setKvForTest(null);
  resetCodexAuthCacheForTest();
  try {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    const refreshed = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "no-kv-access", refresh_token: "no-kv-refresh" }),
      async () => await refreshAuthCoordinated({ kv: null, entry: null, pool: poolOf(stale), auth: stale })
    );
    assert.equal(refreshed.access_token, "no-kv-access");
  } finally {
    setKvForTest(null);
    resetCodexAuthCacheForTest();
  }
});

test("a refresh that loses every compare-and-set reports the conflict instead of claiming success", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);
    kv.commitFailures = 10;

    const error = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "never-persisted", refresh_token: "never-persisted-refresh" }),
      () => failureOf(() => refreshAuthCoordinated(entry))
    );
    assert.equal(error.code, "codex_auth_refresh_failed");
    assert.equal(error.status, 503);
    assert.match(error.message, /could not persist after concurrent updates/);
  });
});

test("a pool that disappears during a refresh is reported instead of silently replaced", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));

    const error = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "orphaned-access", refresh_token: "orphaned-refresh" }),
      async () => {
        kv.values.delete(keyOf(CODEX_AUTH_POOL_KV_KEY));
        return await failureOf(() => refreshAuthCoordinated({ kv: kv.binding, entry: null, pool: poolOf(stale), auth: stale }));
      }
    );
    assert.equal(error.code, "codex_auth_missing");
    assert.equal(error.status, 503);
    assert.match(error.message, /disappeared during refresh/);
  });
});

test("a pool rotated in KV during the refresh is adopted instead of the response's own token", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const rotated = accountAuth("one", "kv-rotated-access", "kv-rotated-refresh");

    const refreshed = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "fetch-access", refresh_token: "fetch-refresh" }),
      async () => {
        kv.values.set(keyOf(CODEX_AUTH_POOL_KV_KEY), poolOf(rotated));
        return await refreshAuthCoordinated({ kv: kv.binding, entry: null, pool: poolOf(stale), auth: stale });
      }
    );
    assert.equal(refreshed.access_token, "kv-rotated-access", "the durable rotation is the authority");
    const stored = kv.values.get(keyOf(CODEX_AUTH_POOL_KV_KEY)) as CodexAuthPoolState;
    assert.equal(stored.accounts[0].access_token, "kv-rotated-access");
  });
});

test("getValidAuth reuses a healthy token without touching the auth server", async () => {
  await ScriptedKv.run(async (kv) => {
    const healthy = accountAuth("one", accessTokenExpiringIn(10 * 60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(healthy));
    const entry = await getCurrentAccountEntry("one", true);

    const unchanged = await withStubbedFetch(
      () => new Error("no refresh should be needed"),
      async (calls) => {
        const result = await getValidAuth(entry);
        assert.equal(calls.length, 0, "a token outside the refresh window is used as is");
        return result;
      }
    );
    assert.equal(unchanged.access_token, healthy.access_token);
  });
});

test("getValidAuth coalesces concurrent refreshes of one stale account into a single request", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);

    const [first, second] = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "shared-access", refresh_token: "shared-refresh" }),
      async (calls) => {
        const results = await Promise.all([getValidAuth(entry), getValidAuth(entry)]);
        assert.equal(calls.length, 1, "two concurrent callers share one refresh");
        return results;
      }
    );
    assert.equal(first.access_token, "shared-access");
    assert.equal(second.access_token, "shared-access");
    assert.equal(refreshesInFlight.size, 0, "the shared refresh is removed once it settles");
  });
});

test("version, telemetry and warning decoration keep the exact edge values", async () => {
  assert.equal(codexUserAgent(CODEX_CLIENT_VERSION), `codex_cli_rs/${CODEX_CLIENT_VERSION} (ai.ubq.fi)`, "an equal version keeps the requested spelling");

  const invalidPayload = `${encodeBase64Url({ alg: "none" })}.${btoa("not json")}.signature`;
  assert.equal(getCodexAccountEmail(invalidPayload), null, "an undecodable payload yields no email claim");

  const explicitNullReason = new Response("body", { status: 200 });
  setCodexResponseActiveTelemetry(explicitNullReason, routingAccount(accountAuth("one", "a"), { activeGeneration: 7 }));
  assert.deepEqual(getCodexResponseActiveTelemetry(explicitNullReason), { activeGeneration: 7, activeTransitionReason: null });

  const routed = new Response("body", { status: 429 });
  codexRoutingErrors.set(routed, "codex_quota_blocked");
  const decorated = withCodexWarnings(routed, ["codex_quota_blocked"]);
  assert.equal(getCodexRoutingError(decorated), "codex_quota_blocked", "the routing error survives decoration for the fallback adapter");
  assert.equal(getCodexRoutingError(routed), "codex_quota_blocked");

  const authWarned = withCodexAuthWarning(new Response("body", { status: 502 }), CODEX_AUTH_REAUTH_WARNING);
  const bothWarnings = withCodexWarnings(authWarned, ["codex_upstream_degraded"]);
  assert.equal(bothWarnings.headers.get("x-uos-warning"), `${CODEX_AUTH_REAUTH_WARNING}, codex_upstream_degraded`);
  assert.equal(getCodexRoutingError(bothWarnings), null, "a response without a routing error never invents one");
  const cohortless = new Response("body", { status: 502 });
  assert.equal(await getCodexResponseAccountCohortId(cohortless), null);
});

test("a registered recovery probe is transitioned on both a completed and a degraded response", async () => {
  await ScriptedKv.run(async () => {
    const completed = new Response("body", { status: 200 });
    setCodexResponseAccountTelemetry(completed, 0, "account-one");
    codexProbeByResponse.set(completed, routingAccount(accountAuth("account-one", "access-one")));
    await markCodexResponseCompleted(completed);
    assert.equal(getCodexRoutingProbe(completed), null, "a completed response consumes its recovery probe");
    assert.equal(codexProbeTransitionsInFlight.size, 0);

    const degraded = new Response("body", { status: 200 });
    setCodexResponseAccountTelemetry(degraded, 1, "account-two");
    codexProbeByResponse.set(degraded, routingAccount(accountAuth("account-two", "access-two"), { slot: 1 }));
    await markCodexResponseUpstreamError(degraded);
    assert.equal(getCodexRoutingProbe(degraded), null, "a degraded response also consumes its recovery probe");
    assert.equal(codexProbeTransitionsInFlight.size, 0);
  });
});

test("an auth-pool read that loses its generation race serves the concurrent cache instead of the stale row", async () => {
  await ScriptedKv.run(async (kv) => {
    const stored = poolOf(accountAuth("one", accessTokenExpiringIn(10 * 60_000)));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, stored);
    const winner = poolOf(accountAuth("one", "winner-access"));
    let rotated = false;
    kv.onGet = (key) => {
      if (!rotated && keyOf(key) === keyOf(CODEX_AUTH_POOL_KV_KEY)) {
        rotated = true;
        cacheCodexAuthPool(winner);
      }
    };

    const entry = await getAuthPoolEntry(true);
    assert.deepEqual(entry.pool, winner, "the concurrent writer's pool wins over the row this read started from");
    assert.equal(entry.kv, null);
    assert.equal(entry.entry, null);

    // A banked-reset retry bypasses the warm cache and performs its own strong read.
    resetCodexAuthCacheForTest();
    setKvForTest(kv.binding);
    const bypassed = await getAuthPoolEntry(false, true);
    assert.deepEqual(bypassed.pool, stored, "a banked-reset retry reads the durable row instead of inheriting the cache");
    assert.equal(bypassed.kv, kv);
  });
});

test("a coordinated refresh reports an unreachable auth server and a rejected refresh token", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);

    const unreachable = await withStubbedFetch(
      () => new Error("auth server unreachable"),
      async () => await failureOf(() => refreshAuthCoordinated(entry))
    );
    assert.equal(unreachable.code, "codex_auth_refresh_unreachable");
    assert.equal(unreachable.status, 502);
  });

  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);

    const rejected = await withStubbedFetch(
      () => jsonResponse(401, { error: { code: "invalid_grant" } }),
      async () => await failureOf(() => refreshAuthCoordinated(entry))
    );
    assert.equal(rejected.code, "codex_auth_refresh_failed");
    assert.equal(rejected.status, 401);
  });

  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);

    const empty = await withStubbedFetch(
      () => jsonResponse(200, { refresh_token: "only-refresh" }),
      async () => await failureOf(() => refreshAuthCoordinated(entry))
    );
    assert.equal(empty.code, "codex_auth_refresh_failed");
    assert.match(empty.message, /missing access_token/);
  });
});

test("a lease stolen while the refresh ran keeps its new owner and the local release stays silent", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);
    const leaseKey = [...CODEX_AUTH_REFRESH_LEASE_PREFIX, await sha256Hex("one")];
    let leaseReads = 0;
    kv.onGet = (key) => {
      if (keyOf(key) !== keyOf(leaseKey)) return;
      leaseReads += 1;
      // Another isolate replaces the lease between the claim and the release.
      if (leaseReads === 2) kv.values.set(keyOf(leaseKey), { owner: "other-isolate", lease_until_ms: Date.now() + 30_000 });
    };

    const refreshed = await withStubbedFetch(
      () => jsonResponse(200, { access_token: "released-access", refresh_token: "released-refresh" }),
      async () => await refreshAuthCoordinated(entry)
    );
    assert.equal(refreshed.access_token, "released-access");
    const lease = kv.values.get(keyOf(leaseKey)) as { owner: string };
    assert.equal(lease.owner, "other-isolate", "a lease this isolate no longer owns is never deleted");
    assert.equal(kv.commitAttempts.filter((write) => write.type === "delete").length, 0);
  });
});

test("a waiter survives an unavailable coordination read and adopts the credentials published at the handoff", async () => {
  await ScriptedKv.run(async (kv) => {
    const stale = accountAuth("one", accessTokenExpiringIn(-60_000));
    const rotated = accountAuth("one", "handoff-access", "handoff-refresh");
    await kv.set(CODEX_AUTH_POOL_KV_KEY, poolOf(stale));
    const entry = await getCurrentAccountEntry("one", true);
    const leaseKey = [...CODEX_AUTH_REFRESH_LEASE_PREFIX, await sha256Hex("one")];
    await kv.set(leaseKey, { owner: "other-isolate", lease_until_ms: Date.now() + 30 });

    let leaseReads = 0;
    let authReads = 0;
    kv.onGet = (key) => {
      if (keyOf(key) === keyOf(leaseKey)) {
        leaseReads += 1;
        // The observation window itself is unavailable once.
        if (leaseReads === 1) kv.rejectNextAuthGet = true;
        return;
      }
      if (keyOf(key) === keyOf(CODEX_AUTH_POOL_KV_KEY)) {
        authReads += 1;
        // The owner publishes its rotation exactly at the lease handoff.
        if (authReads === 2) kv.values.set(keyOf(CODEX_AUTH_POOL_KV_KEY), poolOf(rotated));
      }
    };

    const refreshed = await withStubbedFetch(
      () => new Error("a waiter must not reach the auth server"),
      async (calls) => {
        const result = await refreshAuthCoordinated(entry);
        assert.equal(calls.length, 0, "the handed-off credentials are adopted without a second OAuth call");
        return result;
      }
    );
    assert.equal(refreshed.access_token, "handoff-access");
    assert.equal(refreshed.refresh_token, "handoff-refresh");
  });
});

test("abort reasons are preserved as Errors for both promise rejections and thrown values", async () => {
  const original = new Error("client went away");
  assert.equal(abortReasonAsError(original), original);
  const undefinedReason = abortReasonAsError(undefined);
  assert.equal(undefinedReason.name, "AbortError");
  assert.equal(undefinedReason.message, "The request was aborted.");
  const cause = { code: "transport" };
  const wrapped = abortReasonAsError(cause);
  assert.equal(wrapped.message, "The request was aborted.");
  assert.equal(wrapped.cause, cause);
  assert.ok(!(wrapped instanceof DOMException), "a non-Error reason becomes a plain Error carrying its cause");

  const completed = await awaitWithoutCancellingSharedWork(Promise.resolve("done"));
  assert.equal(completed, "done", "a wait without a client signal never rewrites the result");

  const reason = new Error("stopped");
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(awaitWithoutCancellingSharedWork(Promise.resolve("late"), controller.signal), /stopped/);

  const pending = new AbortController();
  const sharedWork = new Promise<string>((resolve) => {
    setTimeout(() => {
      resolve("shared result");
    }, 20);
  });
  const waiting = awaitWithoutCancellingSharedWork(sharedWork, pending.signal);
  pending.abort(new Error("client closed"));
  await assert.rejects(waiting, /client closed/);
  assert.equal(await sharedWork, "shared result", "the aborted waiter never cancels the shared work it was observing");
});
