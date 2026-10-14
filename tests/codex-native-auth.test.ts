import assert from "node:assert/strict";
import { AuthKv, resetCodexAuthCacheForTest, setKvForTest } from "./helpers/codex-auth-cache-harness.ts";
import { CODEX_AUTH_POOL_MAX_ACCOUNTS, CodexError, getAuthPoolEntry, parseCodexAuthPool, upsertCodexAuthAccount } from "../src/codex/auth.ts";
import { refreshAuthCoordinated, refreshAuthStateless } from "../src/codex/auth-refresh.ts";
import { nativeCodexCredentialGeneration, setNativeCodexAuthHooksForTest } from "../src/codex/native-auth.ts";
import { selectCodexRoutingAccountsStrong } from "../src/codex/account-routing.ts";
import { parseCodexAuthPoolSnapshot } from "../src/codex/routing-evaluation.ts";
import type { CodexAuthState } from "../src/types.ts";
import { config } from "../src/config.ts";

const HOME = "/synthetic/uos268";
const DEFAULT_HOME = "/synthetic/uos792";
const nativeEnvironment = { os: "darwin" as const, getEnv: (name: string): string | undefined => (name === "CODEX_HOME" ? HOME : undefined) };
const jwt = (claims: Record<string, unknown>): string =>
  `header.${btoa(JSON.stringify(claims)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.signature`;
const auth = (accountId: string, generation: number): CodexAuthState => ({
  account_id: accountId,
  access_token: jwt({ exp: Math.floor(Date.now() / 1000) + generation * 3600, generation }),
  refresh_token: `synthetic-refresh-${accountId}-${generation}`,
  updated_at_ms: Date.now(),
});
const document = (value: CodexAuthState): Record<string, unknown> => ({
  auth_mode: "chatgpt",
  tokens: { ...value, id_token: jwt({ email: "synthetic@example.test" }) },
});

const fixture = async (
  body: (state: {
    kv: AuthKv;
    first: CodexAuthState;
    sibling: CodexAuthState;
    setDocument: (value: unknown) => void;
    refreshes: () => number;
    directOauthCalls: () => number;
    refreshHomes: () => string[];
    setEnvironment: (value: Record<string, string | undefined>) => void;
    setOs: (value: typeof Deno.build.os) => void;
  }) => Promise<void>,
  environment: Record<string, string | undefined> = { CODEX_HOME: HOME, HOME: DEFAULT_HOME }
): Promise<void> => {
  const first = auth("shared", 1);
  const sibling = auth("uploaded", 2);
  const kv = new AuthKv({ accounts: [first, sibling], updated_at_ms: Date.now() });
  let source: unknown = document(first);
  let refreshes = 0;
  let directOauthCalls = 0;
  const refreshHomes: string[] = [];
  let os: typeof Deno.build.os = "darwin";
  const priorDeploy = config.isDeploy;
  (config as { isDeploy: boolean }).isDeploy = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    directOauthCalls += 1;
    return Promise.reject(new Error("Direct OAuth was forbidden by this fixture"));
  };
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAuthCacheForTest();
  setNativeCodexAuthHooksForTest({
    get os() {
      return os;
    },
    getEnv: (name) => environment[name],
    readAuth: () => {
      if (source instanceof Error) return Promise.reject(source);
      return Promise.resolve(source);
    },
    refresh: (home) => {
      refreshes += 1;
      refreshHomes.push(home);
      source = document(auth("shared", 3));
      return Promise.resolve();
    },
  });
  try {
    await body({
      kv,
      first,
      sibling,
      setDocument: (value) => {
        source = value;
      },
      refreshes: () => refreshes,
      directOauthCalls: () => directOauthCalls,
      refreshHomes: () => refreshHomes,
      setEnvironment: (value) => {
        environment = value;
      },
      setOs: (value) => {
        os = value;
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    setNativeCodexAuthHooksForTest(null);
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    (config as { isDeploy: boolean }).isDeploy = priorDeploy;
  }
};

Deno.test("native ownership binds only the equal CLI account and survives cache restart", async () => {
  await fixture(async ({ kv, first, sibling }) => {
    await getAuthPoolEntry(true);
    const stored = kv.auth.accounts[0];
    assert.equal(stored.native_owner?.generation_hash, await nativeCodexCredentialGeneration(first));
    assert.deepEqual(kv.auth.accounts[1], sibling);
    resetCodexAuthCacheForTest();
    assert.deepEqual((await getAuthPoolEntry(true)).pool, parseCodexAuthPool(kv.auth));
  });
});

for (const [name, environment, expectedHome] of [
  ["CODEX_HOME override", { CODEX_HOME: HOME, HOME: DEFAULT_HOME }, HOME],
  ["CODEX_HOME without HOME", { CODEX_HOME: HOME }, HOME],
  ["HOME default", { HOME: DEFAULT_HOME }, `${DEFAULT_HOME}/.codex`],
  ["empty CODEX_HOME", { CODEX_HOME: "", HOME: DEFAULT_HOME }, `${DEFAULT_HOME}/.codex`],
] as const) {
  Deno.test(`native resolver ${name} binds and refreshes the same credential owner`, async () => {
    await fixture(async ({ kv, first, sibling, refreshHomes, directOauthCalls }) => {
      const entry = await getAuthPoolEntry(true);
      const owner = entry.pool.accounts[0].native_owner;
      assert.equal(owner?.codex_home, expectedHome);
      assert.equal(owner.generation_hash, await nativeCodexCredentialGeneration(first));
      const next = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
      assert.equal(next.native_owner?.codex_home, expectedHome);
      assert.equal(next.native_owner.generation_hash, await nativeCodexCredentialGeneration(next));
      assert.notEqual(next.refresh_token, first.refresh_token);
      assert.deepEqual(refreshHomes(), [expectedHome]);
      assert.deepEqual(kv.auth.accounts[1], sibling);
      assert.equal(directOauthCalls(), 0);
    }, environment);
  });
}

for (const [name, environment, expectedHome] of [
  ["CODEX_HOME override", { CODEX_HOME: HOME, HOME: DEFAULT_HOME }, HOME],
  ["HOME default", { HOME: DEFAULT_HOME }, `${DEFAULT_HOME}/.codex`],
] as const) {
  Deno.test(`native resolver on Linux ${name} binds and refreshes the same credential owner`, async () => {
    await fixture(async ({ kv, first, sibling, refreshHomes, directOauthCalls, setOs }) => {
      setOs("linux");
      const entry = await getAuthPoolEntry(true);
      const owner = entry.pool.accounts[0].native_owner;
      assert.equal(owner?.codex_home, expectedHome);
      assert.equal(owner.generation_hash, await nativeCodexCredentialGeneration(first));
      const next = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
      assert.equal(next.native_owner?.codex_home, expectedHome);
      assert.notEqual(next.refresh_token, first.refresh_token);
      assert.deepEqual(refreshHomes(), [expectedHome]);
      assert.deepEqual(kv.auth.accounts[1], sibling);
      assert.equal(directOauthCalls(), 0);
    }, environment);
  });
}

for (const guard of ["platform", "deployment"] as const) {
  Deno.test(`native resolver preserves its ${guard} guard despite CODEX_HOME`, async () => {
    await fixture(async ({ first, kv, refreshes, directOauthCalls, setOs }) => {
      if (guard === "platform") setOs("windows");
      else (config as { isDeploy: boolean }).isDeploy = true;
      const entry = await getAuthPoolEntry(true);
      assert.equal(entry.pool.accounts[0].native_owner, undefined);
      const owner = { ...first, native_owner: { codex_home: HOME, generation_hash: await nativeCodexCredentialGeneration(first) } };
      const snapshot = structuredClone(kv.auth);
      await assert.rejects(refreshAuthStateless(owner), { code: "codex_auth_owner_unavailable", status: 503 });
      assert.equal(refreshes(), 0);
      assert.equal(directOauthCalls(), 0);
      assert.deepEqual(kv.auth, snapshot);
    });
  });
}

for (const [name, environment] of [
  ["changed custom home", { CODEX_HOME: "/synthetic/foreign", HOME: DEFAULT_HOME }],
  ["removed custom home", { HOME: DEFAULT_HOME }],
  ["missing environment", {}],
] as const) {
  Deno.test(`an established custom native owner refuses ${name} without direct OAuth`, async () => {
    await fixture(async ({ kv, setEnvironment, refreshes, directOauthCalls }) => {
      const entry = await getAuthPoolEntry(true);
      const snapshot = structuredClone(kv.auth);
      setEnvironment(environment);
      await assert.rejects(refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] }), { code: "codex_auth_owner_unavailable", status: 503 });
      assert.equal(refreshes(), 0);
      assert.equal(directOauthCalls(), 0);
      assert.deepEqual(kv.auth, snapshot);
    });
  });
}

Deno.test("native refresh adopts its persisted generation while preserving an uploaded sibling", async () => {
  await fixture(async ({ kv, first, sibling, refreshes }) => {
    const entry = await getAuthPoolEntry(true);
    const next = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    assert.notEqual(next.refresh_token, first.refresh_token);
    assert.equal(refreshes(), 1);
    assert.deepEqual(kv.auth.accounts[1], sibling);
    assert.equal(next.native_owner?.generation_hash, await nativeCodexCredentialGeneration(next));
  });
});

Deno.test("routed native auth adopts an intervening persisted rotation without another refresh", async () => {
  await fixture(async ({ kv, first, sibling, setDocument, refreshes, directOauthCalls }) => {
    const nativeRefreshedAt = new Date().toISOString();
    setDocument({ ...document(first), last_refresh: nativeRefreshedAt });
    const entry = await getAuthPoolEntry(true);
    const selection = await selectCodexRoutingAccountsStrong(entry.pool, entry.pool.accounts);
    assert.equal(selection.kind, "eligible");
    const routed = selection.accounts[0];
    assert.equal(routed.auth.account_id, first.account_id);
    assert.deepEqual(routed.auth.native_owner, entry.pool.accounts[0].native_owner);
    assert.equal(routed.auth.native_owner?.native_refreshed_at, nativeRefreshedAt);

    const rotated = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    assert.notEqual(rotated.access_token, routed.auth.access_token);
    assert.notEqual(rotated.refresh_token, routed.auth.refresh_token);
    const persisted = structuredClone(kv.auth);
    const adopted = await refreshAuthCoordinated({ ...entry, auth: routed.auth });
    assert.deepEqual(adopted, rotated);
    assert.equal(adopted.native_owner?.generation_hash, await nativeCodexCredentialGeneration(rotated));
    assert.equal(refreshes(), 1);
    assert.equal(directOauthCalls(), 0);
    assert.deepEqual(kv.auth, persisted);
    assert.deepEqual(kv.auth.accounts[1], sibling);
  });
});

Deno.test("routed snapshots preserve unbound accounts and refuse malformed native ownership", () => {
  const unbound = auth("uploaded", 1);
  const pool = { accounts: [unbound], updated_at_ms: unbound.updated_at_ms };
  assert.deepEqual(parseCodexAuthPoolSnapshot(pool), pool);
  const maximumPool = { ...pool, accounts: Array.from({ length: CODEX_AUTH_POOL_MAX_ACCOUNTS }, (_, index) => auth(`uploaded-${index}`, 1)) };
  assert.deepEqual(parseCodexAuthPoolSnapshot(maximumPool), maximumPool);
  assert.equal(parseCodexAuthPoolSnapshot({ ...maximumPool, accounts: [...maximumPool.accounts, auth("overflow", 1)] }), null);
  const malformed = { ...unbound, native_owner: { codex_home: HOME, generation_hash: "invalid" } };
  assert.throws(() => parseCodexAuthPoolSnapshot({ ...pool, accounts: [malformed] }), /ownership is malformed/);
  assert.equal(parseCodexAuthPoolSnapshot({ ...pool, updated_at_ms: -1 }), null);
  assert.equal(parseCodexAuthPoolSnapshot({ ...pool, accounts: [{ ...unbound, updated_at_ms: 1.5 }] }), null);
  assert.equal(parseCodexAuthPoolSnapshot({ ...pool, accounts: [unbound, unbound] }), null);
});

Deno.test("an established native owner adopts a newer synced generation without another rotation", async () => {
  await fixture(async ({ setDocument, refreshes }) => {
    const entry = await getAuthPoolEntry(true);
    const updated = auth("shared", 4);
    setDocument(document(updated));
    const next = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    assert.equal(next.refresh_token, updated.refresh_token);
    assert.equal(refreshes(), 0);
  });
});

Deno.test("an expired newer native generation is refreshed by its owner before adoption", async () => {
  await fixture(async ({ kv, first, sibling, setDocument, refreshes, directOauthCalls }) => {
    const now = Math.floor(Date.now() / 1000);
    const previous = { ...first, access_token: jwt({ exp: now - 60, generation: 1 }) };
    kv.auth = { ...kv.auth, accounts: [previous, sibling] };
    setDocument({ ...document(previous), last_refresh: new Date(Date.now() - 7200_000).toISOString() });
    const entry = await getAuthPoolEntry(true);
    const expired = { ...previous, access_token: jwt({ exp: now - 60, generation: 2 }), refresh_token: "synthetic-expired-newer-generation" };
    setDocument({ ...document(expired), last_refresh: new Date(Date.now() - 3600_000).toISOString() });
    const next = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    assert.equal(next.refresh_token, auth("shared", 3).refresh_token);
    assert.equal(refreshes(), 1);
    assert.equal(directOauthCalls(), 0);
    assert.deepEqual(kv.auth.accounts[1], sibling);
    assert.equal(kv.auth.accounts[0].refresh_token, next.refresh_token);
  });
});

Deno.test("an unusable native owner result is not adopted or retried", async () => {
  await fixture(async ({ kv, first, sibling, setDocument, directOauthCalls }) => {
    const now = Math.floor(Date.now() / 1000);
    const previous = { ...first, access_token: jwt({ exp: now - 60, generation: 1 }) };
    kv.auth = { ...kv.auth, accounts: [previous, sibling] };
    setDocument({ ...document(previous), last_refresh: new Date(Date.now() - 7200_000).toISOString() });
    const entry = await getAuthPoolEntry(true);
    const snapshot = structuredClone(kv.auth);
    const expired = { ...previous, access_token: jwt({ exp: now - 60, generation: 2 }), refresh_token: "synthetic-expired-newer-generation" };
    const expiredDocument = { ...document(expired), last_refresh: new Date(Date.now() - 3600_000).toISOString() };
    let ownerRequests = 0;
    setNativeCodexAuthHooksForTest({
      ...nativeEnvironment,
      readAuth: () => Promise.resolve(expiredDocument),
      refresh: () => {
        ownerRequests += 1;
        assert.deepEqual(kv.auth, snapshot, "the unusable intermediate generation must not be persisted");
        return Promise.resolve();
      },
    });
    await assert.rejects(refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] }), /did not advance/);
    assert.equal(ownerRequests, 1);
    assert.equal(directOauthCalls(), 0);
    assert.deepEqual(kv.auth, snapshot);
  });
});

for (const order of ["older", "missing"] as const) {
  Deno.test(`native repair requires order proof when stored access expiry is unknown: ${order}`, async () => {
    await fixture(async ({ kv, first, sibling, setDocument, refreshes, directOauthCalls }) => {
      const previous = { ...first, access_token: "synthetic-opaque-access-token" };
      kv.auth = { ...kv.auth, accounts: [previous, sibling] };
      setDocument({ ...document(previous), last_refresh: new Date(Date.now() - 3600_000).toISOString() });
      const entry = await getAuthPoolEntry(true);
      const snapshot = structuredClone(kv.auth);
      const expired = {
        ...previous,
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60, generation: 2 }),
        refresh_token: "synthetic-older-native-refresh",
      };
      setDocument({ ...document(expired), ...(order === "older" ? { last_refresh: new Date(Date.now() - 7200_000).toISOString() } : {}) });
      await assert.rejects(refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] }), /did not advance/);
      assert.equal(refreshes(), 0);
      assert.equal(directOauthCalls(), 0);
      assert.deepEqual(kv.auth, snapshot);
    });
  });
}

Deno.test("native repair can use a newer owner timestamp when stored access expiry is unknown", async () => {
  await fixture(async ({ kv, first, sibling, setDocument, refreshes }) => {
    const previous = { ...first, access_token: "synthetic-opaque-access-token" };
    kv.auth = { ...kv.auth, accounts: [previous, sibling] };
    setDocument({ ...document(previous), last_refresh: new Date(Date.now() - 7200_000).toISOString() });
    const entry = await getAuthPoolEntry(true);
    const expired = {
      ...previous,
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60, generation: 2 }),
      refresh_token: "synthetic-newer-native-refresh",
    };
    setDocument({ ...document(expired), last_refresh: new Date(Date.now() - 3600_000).toISOString() });
    const next = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    assert.equal(next.refresh_token, auth("shared", 3).refresh_token);
    assert.equal(refreshes(), 1);
    assert.deepEqual(kv.auth.accounts[1], sibling);
  });
});

Deno.test("a usable native generation retains adoption when stored access expiry is unknown", async () => {
  await fixture(async ({ kv, first, sibling, setDocument, refreshes }) => {
    const previous = { ...first, access_token: "synthetic-opaque-access-token" };
    kv.auth = { ...kv.auth, accounts: [previous, sibling] };
    setDocument(document(previous));
    const entry = await getAuthPoolEntry(true);
    const usable = auth("shared", 4);
    setDocument(document(usable));
    const next = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    assert.equal(next.refresh_token, usable.refresh_token);
    assert.equal(refreshes(), 0);
    assert.deepEqual(kv.auth.accounts[1], sibling);
  });
});

Deno.test("same-expiry native rotations use owner generation metadata and reject a rollback", async () => {
  await fixture(async ({ first, setDocument, refreshes }) => {
    const observed = new Date().toISOString();
    const prior = observed.replace("Z", "001Z");
    const later = observed.replace("Z", "002Z");
    setDocument({ ...document(first), last_refresh: prior });
    const entry = await getAuthPoolEntry(true);
    const next = { ...first, refresh_token: "synthetic-same-expiry-rotation" };
    setDocument({ ...document(next), last_refresh: later });
    const advanced = await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    assert.equal(advanced.refresh_token, next.refresh_token);
    assert.equal(refreshes(), 0);
    const current = await getAuthPoolEntry(true);
    setDocument({ ...document(first), last_refresh: prior });
    await assert.rejects(refreshAuthCoordinated({ ...current, auth: current.pool.accounts[0] }), /did not advance/);
  });
});

for (const failure of ["missing", "account-mismatch", "rollback"] as const) {
  Deno.test(`bound native ${failure} refuses direct OAuth and credential replacement`, async () => {
    await fixture(async ({ kv, setDocument, refreshes }) => {
      const entry = await getAuthPoolEntry(true);
      const snapshot = structuredClone(kv.auth);
      if (failure === "missing") setDocument(new Error("synthetic missing file"));
      if (failure === "account-mismatch") setDocument(document(auth("foreign", 4)));
      if (failure === "rollback") setDocument(document(auth("shared", 0)));
      await assert.rejects(refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] }), CodexError);
      assert.equal(refreshes(), 0);
      assert.deepEqual(kv.auth, snapshot);
    });
  });
}

Deno.test("successful native RPC without persisted progress remains a failed refresh", async () => {
  await fixture(async ({ first }) => {
    const entry = await getAuthPoolEntry(true);
    setNativeCodexAuthHooksForTest({ ...nativeEnvironment, readAuth: () => Promise.resolve(document(first)), refresh: () => Promise.resolve() });
    await assert.rejects(refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] }), /did not persist/);
  });
});

Deno.test("native daemon failure never activates a direct refresh fallback", async () => {
  await fixture(async ({ first }) => {
    const entry = await getAuthPoolEntry(true);
    setNativeCodexAuthHooksForTest({
      ...nativeEnvironment,
      readAuth: () => Promise.resolve(document(first)),
      refresh: () => Promise.reject(new Error("synthetic absent daemon")),
    });
    await assert.rejects(refreshAuthStateless(entry.pool.accounts[0]), /direct refresh was refused/);
  });
});

Deno.test("stateless upload refresh rejects an obsolete bound credential before dispatch", async () => {
  await fixture(async ({ first, setDocument, refreshes }) => {
    const entry = await getAuthPoolEntry(true);
    setDocument(document(auth("shared", 4)));
    await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    await assert.rejects(refreshAuthStateless(first), /stale native/);
    assert.equal(refreshes(), 0);
  });
});

Deno.test("same-account upload and repair preserve native binding and reject a stale replacement", async () => {
  await fixture(async ({ first }) => {
    const entry = await getAuthPoolEntry(true);
    const unchanged = upsertCodexAuthAccount(entry.pool, first);
    assert.deepEqual(unchanged?.accounts[0].native_owner, entry.pool.accounts[0].native_owner);
    assert.throws(() => upsertCodexAuthAccount(entry.pool, auth("shared", 4)), /native Codex owner/);
  });
});

Deno.test("native generation CAS retries preserve a concurrent unrelated-account upload", async () => {
  await fixture(async ({ kv, first }) => {
    const entry = await getAuthPoolEntry(true);
    const replacement = auth("uploaded", 5);
    setNativeCodexAuthHooksForTest({
      ...nativeEnvironment,
      readAuth: () => Promise.resolve(document(first)),
      refresh: () => {
        kv.auth = { accounts: [kv.auth.accounts[0], replacement], updated_at_ms: Date.now() };
        kv.authVersion += 1;
        setNativeCodexAuthHooksForTest({ ...nativeEnvironment, readAuth: () => Promise.resolve(document(auth("shared", 3))) });
        return Promise.resolve();
      },
    });
    await refreshAuthCoordinated({ ...entry, auth: entry.pool.accounts[0] });
    assert.deepEqual(kv.auth.accounts[1], replacement);
  });
});
