import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { Kv, KvEntryMaybe, KvKey } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";
import handler from "../src/handler/index.ts";
import { config } from "../src/config.ts";
import { CODEX_CATALOG_AUTH_GENERATION_KEY } from "../src/catalog/store.ts";
import { cacheCodexAuthPool, CODEX_AUTH_POOL_KV_KEY, CODEX_MODELS_KV_KEY, getAuthPoolEntry, resetCodexAuthCacheForTest } from "../src/codex/auth.ts";
import { nativeCodexCredentialGeneration, setNativeCodexAuthHooksForTest } from "../src/codex/native-auth.ts";
import { setKvForTest } from "../src/kv.ts";
import { buildRuntimeConfig, cacheRuntimeConfig, loadRuntimeConfig, resetRuntimeConfigCacheForTest, RUNTIME_CONFIG_V2_KEY } from "../src/runtime-config.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const ADMIN_TOKEN = "synthetic-uos791-admin";
const jwt = (generation: number): string => `header.${btoa(JSON.stringify({ exp: 4_000_000_000 + generation, generation }))}.signature`;
const auth = (accountId: string, generation: number): CodexAuthState => ({
  account_id: accountId,
  access_token: jwt(generation),
  refresh_token: `synthetic-refresh-${accountId}-${generation}`,
  updated_at_ms: 1,
});

const fixture = async (
  malformedOwner: boolean,
  run: (state: {
    kv: CountingKv;
    pool: CodexAuthPoolState;
    upload: (replacement: CodexAuthState, authenticated?: boolean) => Promise<Response>;
  }) => Promise<void>
): Promise<void> => {
  const seed = auth("native-account", 1);
  const first: CodexAuthState = {
    ...seed,
    native_owner: {
      codex_home: "/synthetic/uos791",
      generation_hash: malformedOwner ? "malformed" : await nativeCodexCredentialGeneration(seed),
    },
  };
  const pool: CodexAuthPoolState = { accounts: [first, auth("sibling-account", 2)], updated_at_ms: 1 };
  const kv = new CountingKv();
  const snapshot = { source: "chatgpt_codex", updated_at_ms: 1, client_version: "0.126.0", models: [{ slug: "gpt-5.6-sol", display_name: "Stored model" }] };
  const runtime = buildRuntimeConfig(snapshot);
  kv.seed(CODEX_AUTH_POOL_KV_KEY, pool);
  kv.seed(CODEX_MODELS_KV_KEY, snapshot);
  kv.seed(RUNTIME_CONFIG_V2_KEY, runtime);
  kv.seed(CODEX_CATALOG_AUTH_GENERATION_KEY, "synthetic-existing-generation");
  const before = structuredClone(kv.entries);
  const originalFetch = globalThis.fetch;
  const adminTokens = config.adminTokens as Set<string>;
  let modelReads = 0;
  let forbiddenCalls = 0;
  let nativeReads = 0;
  let nativeRefreshes = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!url.pathname.endsWith("/models")) {
      forbiddenCalls += 1;
      return Promise.reject(new Error("OAuth and other provider calls are forbidden"));
    }
    modelReads += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "Validated model" }] }), { headers: { "Content-Type": "application/json" } })
    );
  });
  setNativeCodexAuthHooksForTest({
    codexHome: "/synthetic/uos791",
    readAuth: () => {
      nativeReads += 1;
      return Promise.reject(new Error("Native credential reads are forbidden"));
    },
    refresh: () => {
      nativeRefreshes += 1;
      return Promise.reject(new Error("Native refreshes are forbidden"));
    },
  });
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  resetRuntimeConfigCacheForTest();
  cacheCodexAuthPool(pool);
  cacheRuntimeConfig(runtime);
  adminTokens.add(ADMIN_TOKEN);
  const upload = (replacement: CodexAuthState, authenticated = true): Promise<Response> =>
    handler(
      new Request("https://gateway.example.test/admin/codex/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}) },
        body: JSON.stringify({ auth: { tokens: replacement }, models: { client_version: "0.126.0" } }),
      })
    );
  try {
    await run({ kv, pool, upload });
    assert.equal(forbiddenCalls, 0);
    assert.equal(nativeReads, 0);
    assert.equal(nativeRefreshes, 0);
    if (kv.commands.every((command) => command.command === "get" || command.command === "getMany" || command.command === "list")) {
      assert.deepEqual(kv.entries, before, "pool, siblings, catalog, runtime and their versionstamps stay unchanged");
      assert.deepEqual((await getAuthPoolEntry()).pool, pool, "the warm account cache stays unchanged");
      assert.deepEqual(await loadRuntimeConfig(), runtime, "the warm runtime cache stays unchanged");
    }
    assert.equal(modelReads, 1, "the authenticated upload reached validation exactly once");
  } finally {
    adminTokens.delete(ADMIN_TOKEN);
    globalThis.fetch = originalFetch;
    setNativeCodexAuthHooksForTest(null);
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
};

for (const malformedOwner of [false, true]) {
  test(`authenticated native-owner upload returns ${malformedOwner ? 503 : 409} without replacing state`, async () => {
    await fixture(malformedOwner, async ({ kv, pool, upload }) => {
      const unauthorized = await upload(auth("native-account", 3), false);
      assert.equal(unauthorized.status, 401);
      await unauthorized.body?.cancel();
      const response = await upload(auth("native-account", 3));
      assert.equal(response.status, malformedOwner ? 503 : 409);
      assert.deepEqual(await response.json(), {
        error: {
          message: malformedOwner
            ? "Codex native credential ownership is malformed; nothing was replaced."
            : "The native Codex owner must advance this account's credentials before replacement.",
          type: "invalid_request_error",
          code: malformedOwner ? "codex_auth_owner_unavailable" : "codex_auth_owner_conflict",
        },
      });
      assert.equal(
        kv.commands.some((command) => command.command === "set" || command.command === "delete" || command.command === "atomic.commit"),
        false
      );
      assert.deepEqual((await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY)).value, pool);
    });
  });
}

test("authenticated equal-token upload retains native ownership and the sibling", async () => {
  await fixture(false, async ({ kv, pool, upload }) => {
    const response = await upload(pool.accounts[0]);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.stored, true);
    const stored = (await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY)).value;
    assert.deepEqual(stored?.accounts[0].native_owner, pool.accounts[0].native_owner);
    assert.deepEqual(stored?.accounts[1], pool.accounts[1]);
  });
});

test("authenticated upload still propagates unknown persistence errors", async () => {
  await fixture(false, async ({ kv, upload }) => {
    const failure = new Error("synthetic storage failure");
    const originalGet = kv.get.bind(kv);
    kv.get = <T>(key: KvKey): Promise<KvEntryMaybe<T>> => (key === CODEX_AUTH_POOL_KV_KEY ? Promise.reject(failure) : originalGet<T>(key));
    await assert.rejects(upload(auth("native-account", 3)), (error: unknown) => error === failure);
  });
});
