import { test } from "bun:test";
import type { Kv } from "#kv";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { parseCodexAuthFromAuthJson, parseCodexAuthPool, resetCodexAuthCacheForTest } from "../src/codex/auth.ts";
import { codexAuthCandidateFromAuthJson, codexAuthCandidatesFromPool } from "../src/codex/auth-repair.ts";
import { refreshAuthCoordinated, refreshAuthStateless } from "../src/codex/auth-refresh.ts";
import { parseExternalNativeCodexDocument } from "../src/codex/external-auth.ts";
import { nativeCodexConsumerHomes, planExternalNativeCodexAdoption, setNativeCodexAuthHooksForTest } from "../src/codex/native-auth.ts";
import { parseCodexAuthPoolSnapshot } from "../src/codex/routing-evaluation.ts";
import { repairExternalNativePool } from "../scripts/codex-auth-repair.ts";
import { runExternalNativeRepair } from "../scripts/codex-external-auth-repair.ts";
import { AuthKv, setKvForTest } from "./helpers/codex-auth-cache-harness.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";

const HOME = "/synthetic/uos-external";
const PRIMARY = `${HOME}/.codex`;
const NAMED = `${HOME}/.codex-ubiquity`;
const token = (seconds: number, userId = "user-one", accountId = "workspace-one", generation = 1): string =>
  `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, generation, "https://api.openai.com/auth": { chatgpt_user_id: userId, chatgpt_account_id: accountId } }))}.signature`;
const managed = (accessToken = token(-60), accountId = "workspace-one"): CodexAuthState => ({
  access_token: accessToken,
  refresh_token: "synthetic-managed-refresh",
  account_id: accountId,
  updated_at_ms: 1,
});
const leaf = (accessToken = token(3600), refreshedAt?: string): Record<string, unknown> => ({
  OPENAI_API_KEY: null,
  auth_mode: "chatgptAuthTokens",
  tokens: { access_token: accessToken, id_token: accessToken, refresh_token: "", account_id: "workspace-one" },
  ...(refreshedAt ? { last_refresh: refreshedAt } : {}),
});
const initialPool = (): CodexAuthPoolState => ({
  accounts: [managed(), managed(token(7200, "sibling-user", "sibling-workspace"), "sibling-workspace")],
  updated_at_ms: 1,
});

const fixture = async (run: () => Promise<void>): Promise<void> => {
  const previousDeploy = config.isDeploy;
  (config as { isDeploy: boolean }).isDeploy = false;
  setNativeCodexAuthHooksForTest({ os: "darwin", getEnv: (name) => (name === "HOME" ? HOME : undefined) });
  try {
    await run();
  } finally {
    setNativeCodexAuthHooksForTest(null);
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    (config as { isDeploy: boolean }).isDeploy = previousDeploy;
  }
};

test("official access-only leaf stays out of managed uploads and donor candidates", async () => {
  await fixture(async () => {
    const document = leaf();
    const parsed = parseExternalNativeCodexDocument(document);
    assert(parsed);
    assert.equal(parsed.auth.refresh_token, "");
    assert.equal(parseCodexAuthFromAuthJson(document), null);
    assert.equal(codexAuthCandidateFromAuthJson(document, "local-auth-json", 1), null);
    const adopted = await planExternalNativeCodexAdoption(initialPool(), document, PRIMARY, Date.now(), false);
    assert.deepEqual(parseCodexAuthPool(adopted), adopted);
    assert.deepEqual(parseCodexAuthPoolSnapshot(adopted), adopted);
    assert.deepEqual(
      codexAuthCandidatesFromPool(adopted, "vps-pool").map((candidate) => candidate.account_id),
      ["sibling-workspace"]
    );
    assert.equal(parseCodexAuthPool({ ...adopted, accounts: [{ ...adopted.accounts[0], native_owner: undefined }] }), null);
    assert.equal(parseCodexAuthPool({ ...adopted, accounts: [{ ...adopted.accounts[0], refresh_token: "sentinel" }] }), null);
  });
});

test("external leaf requires one access JWT with exact user and workspace claims", () => {
  const valid = leaf();
  const tokens = valid.tokens as Record<string, unknown>;
  for (const changed of [
    { ...valid, OPENAI_API_KEY: "key" },
    { ...valid, tokens: { ...tokens, id_token: token(7200) } },
    { ...valid, tokens: { ...tokens, refresh_token: "donor-secret" } },
    { ...valid, tokens: { ...tokens, account_id: "other-workspace" } },
    leaf(token(3600, "")),
  ])
    assert.equal(parseExternalNativeCodexDocument(changed), null);
});

for (const home of [PRIMARY, NAMED]) {
  test(`external adoption preserves the sibling at fixed home ${home}`, async () => {
    await fixture(async () => {
      assert.deepEqual(nativeCodexConsumerHomes(), [PRIMARY, NAMED]);
      const pool = initialPool();
      const next = await planExternalNativeCodexAdoption(pool, leaf(), home, Date.now(), false);
      assert.equal(next.accounts[0].native_owner?.codex_home, home);
      assert.equal(next.accounts[0].native_owner.chatgpt_user_id, "user-one");
      assert.deepEqual(next.accounts[1], pool.accounts[1]);
      await assert.rejects(planExternalNativeCodexAdoption(pool, leaf(), `${HOME}/other`, Date.now(), false), /fixed-home/);
    });
  });
}

test("external adoption refuses valid managed accounts, user switches and generation rollback", async () => {
  await fixture(async () => {
    const pool = initialPool();
    const valid = { ...pool, accounts: [managed(token(1800)), pool.accounts[1]] };
    await assert.rejects(planExternalNativeCodexAdoption(valid, leaf(), PRIMARY, Date.now(), false), /valid managed/);
    await assert.rejects(planExternalNativeCodexAdoption(pool, leaf(token(3600, "different-user")), PRIMARY, Date.now(), false), /user or workspace/);
    const newer = await planExternalNativeCodexAdoption(pool, leaf(token(7200)), PRIMARY, Date.now(), false);
    await assert.rejects(planExternalNativeCodexAdoption(newer, leaf(token(3600)), PRIMARY, Date.now(), true), /did not advance/);
    const owner = newer.accounts[0].native_owner;
    assert(owner);
    const corrupted = {
      ...newer,
      accounts: [{ ...newer.accounts[0], native_owner: { ...owner, generation_hash: "a".repeat(64) } }, newer.accounts[1]],
    };
    await assert.rejects(planExternalNativeCodexAdoption(corrupted, leaf(token(10800)), PRIMARY, Date.now(), false), /ownership changed/);
  });
});

test("external native renewal adopts a new leaf with CAS and never calls refresh or OAuth", async () => {
  await fixture(async () => {
    const first = await planExternalNativeCodexAdoption(initialPool(), leaf(token(3600)), NAMED, Date.now(), false);
    const kv = new AuthKv(first);
    setKvForTest(kv as unknown as Kv);
    let document = leaf(token(7200));
    let forbidden = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      () => {
        forbidden += 1;
        return Promise.reject(new Error("OAuth forbidden"));
      },
      { preconnect: fetch.preconnect }
    );
    setNativeCodexAuthHooksForTest({
      os: "darwin",
      getEnv: (name) => (name === "HOME" ? HOME : undefined),
      readAuth: () => Promise.resolve(document),
      refresh: () => {
        forbidden += 1;
        return Promise.reject(new Error("Native refresh forbidden"));
      },
    });
    try {
      const next = await refreshAuthCoordinated({ kv: kv as unknown as Kv, entry: null, pool: first, auth: first.accounts[0] });
      assert.equal(next.access_token, (document.tokens as Record<string, unknown>).access_token);
      assert.equal(next.refresh_token, "");
      assert.deepEqual(kv.auth.accounts[1], first.accounts[1]);
      await assert.rejects(refreshAuthStateless(next), /local refresh was refused/);
      document = leaf(token(10800));
      const renewed = await refreshAuthStateless(next);
      assert.notEqual(renewed.access_token, next.access_token);
      assert.equal(forbidden, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

for (const source of ["missing", "managed"] as const) {
  test(`fixed external-only entrypoint refuses initial unregistered ${source} file without provider calls or writes`, async () => {
    await fixture(async () => {
      const pool = initialPool();
      const before = structuredClone(pool);
      let forbidden = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        () => {
          forbidden += 1;
          return Promise.reject(new Error("Provider calls and OAuth forbidden"));
        },
        { preconnect: fetch.preconnect }
      );
      try {
        await assert.rejects(
          runExternalNativeRepair(["--apply", "--json", "--auth-json", `${PRIMARY}/auth.json`, "--kv=/synthetic/explicit-kv"], {
            readPool: (path) => {
              assert.equal(path, "/synthetic/explicit-kv");
              return Promise.resolve({ pool, versionstamp: "initial-version" });
            },
            output: () => {
              forbidden += 1;
            },
            external: {
              readText: () =>
                source === "missing"
                  ? Promise.reject(new Error("Synthetic missing leaf"))
                  : Promise.resolve(JSON.stringify({ auth_mode: "chatgpt", tokens: managed() })),
              probe: () => {
                forbidden += 1;
                return Promise.reject(new Error("Provider probe forbidden"));
              },
              write: () => {
                forbidden += 1;
                return Promise.reject(new Error("Pool write forbidden"));
              },
            },
          }),
          /managed repair and peer collection are forbidden/
        );
        assert.equal(forbidden, 0);
        assert.deepEqual(pool, before);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
}

test("registered external repair refuses missing or managed files before peer collection", async () => {
  await fixture(async () => {
    const pool = await planExternalNativeCodexAdoption(initialPool(), leaf(), PRIMARY, Date.now(), false);
    const flags = { apply: true, authJson: `${PRIMARY}/auth.json`, kv: "/synthetic/kv", codexBaseUrl: "https://synthetic.invalid" };
    const local = { pool, versionstamp: "external-version" };
    await assert.rejects(
      repairExternalNativePool(flags, local, {
        readText: () => Promise.reject(new Error("Synthetic missing file")),
      }),
      /peer collection was refused/
    );
    await assert.rejects(
      repairExternalNativePool(flags, local, {
        readText: () => Promise.resolve(JSON.stringify({ auth_mode: "chatgpt", tokens: managed() })),
      }),
      /peer collection was refused/
    );
  });
});

test("external repair rechecks leaf bytes and honors pool CAS without peers", async () => {
  await fixture(async () => {
    const text = JSON.stringify(leaf());
    const local = { pool: initialPool(), versionstamp: "expected-version" };
    const flags = { apply: true, authJson: `${PRIMARY}/auth.json`, kv: "/synthetic/kv", codexBaseUrl: "https://synthetic.invalid" };
    let reads = 0;
    let writes = 0;
    await assert.rejects(
      repairExternalNativePool(flags, local, {
        readText: () => Promise.resolve(++reads === 1 ? text : JSON.stringify(leaf(token(7200)))),
        isRegularFile: () => Promise.resolve(true),
        probe: () => Promise.resolve({ outcome: "valid", status: 200 }),
        write: () => {
          writes += 1;
          return Promise.resolve({ ok: true });
        },
      }),
      /leaf changed/
    );
    assert.equal(writes, 0);
    await assert.rejects(
      repairExternalNativePool(flags, local, {
        readText: () => Promise.resolve(text),
        isRegularFile: () => Promise.resolve(true),
        probe: () => Promise.resolve({ outcome: "valid", status: 200 }),
        write: (_path, version) => {
          assert.equal(version, local.versionstamp);
          return Promise.resolve({ ok: false, error: "CAS refused" });
        },
      }),
      /CAS refused/
    );
    const outcome = await repairExternalNativePool(flags, local, {
      readText: () => Promise.resolve(text),
      isRegularFile: () => Promise.resolve(true),
      probe: () => Promise.resolve({ outcome: "valid", status: 200 }),
      write: (_path, version, next) => {
        assert.equal(version, local.versionstamp);
        assert.deepEqual(next.accounts[1], local.pool.accounts[1]);
        return Promise.resolve({ ok: true });
      },
    });
    assert.deepEqual(outcome, { status: "repaired", applied: true });
  });
});
