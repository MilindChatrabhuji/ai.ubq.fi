import { test } from "bun:test";
import {
  type AtomicCheck,
  type AtomicOperation,
  type Kv,
  type KvCommitError,
  type KvCommitResult,
  type KvConsistencyLevel,
  type KvEntry,
  type KvKey,
} from "#kv";
import assert from "node:assert/strict";
import { CODEX_AUTH_POOL_KV_KEY, parseCodexAuthPool } from "../src/codex/auth.ts";
import { classifyKvMigrationKey, validateKvMigrationTarget } from "../src/cache/kv-migration.ts";
import {
  CODEX_BANKED_RESET_USAGE_LEGACY_KEY,
  CODEX_RESET_USAGE_MIGRATION_KEY,
  codexResetUsageKey,
  migrateLegacyCodexResetOptOut,
  readCodexResetUsage,
} from "../src/codex/reset-settings.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";
import { sha256Hex } from "../src/utils.ts";
import { openSentinelTestKv } from "./helpers/sentinel-kv-stub.ts";

type MigrationMarker = Readonly<{ completed_at_ms: number; preserved_opt_out: boolean }>;

const ACCOUNT_ID_PREFIX = "issue-286-account";
const ACCOUNT_UPDATED_AT_MS = 1_700_000_000_000;

const accountId = (suffix: string): string => `${ACCOUNT_ID_PREFIX}:${suffix}`;

const accountHash = (suffix: string): Promise<string> => sha256Hex(accountId(suffix));

const authAccount = (suffix: string): CodexAuthState => ({
  access_token: `access-token-${suffix}`,
  refresh_token: `refresh-token-${suffix}`,
  account_id: accountId(suffix),
  updated_at_ms: ACCOUNT_UPDATED_AT_MS,
});

/** Persists the exact strong auth-pool snapshot the completion enumerates. */
const setAuthPool = async (kv: Kv, ...suffixes: readonly string[]): Promise<void> => {
  const pool: CodexAuthPoolState = { accounts: suffixes.map((suffix) => authAccount(suffix)), updated_at_ms: ACCOUNT_UPDATED_AT_MS + 1 };
  await kv.set(CODEX_AUTH_POOL_KV_KEY, pool);
};

const valueAt = async (kv: Kv, key: KvKey): Promise<unknown> => (await kv.get(key)).value;

const migrationMarker = async (kv: Kv): Promise<MigrationMarker | null> => (await valueAt(kv, CODEX_RESET_USAGE_MIGRATION_KEY)) as MigrationMarker | null;

const migrationMarkers = async (kv: Kv): Promise<KvEntry<unknown>[]> => {
  const markers: KvEntry<unknown>[] = [];
  for await (const entry of kv.list({ prefix: ["uos_ai", "migrations"] })) markers.push(entry);
  return markers;
};

type AtomicChain = {
  check: (...checks: AtomicCheck[]) => AtomicChain;
  set: (key: KvKey, value: unknown, options?: { expireIn?: number }) => AtomicChain;
  commit: () => Promise<KvCommitResult | KvCommitError>;
};

/**
 * A KV whose first atomic commit appends a configured account to the persisted
 * auth pool before committing, so the account lands exactly between the
 * completion's enumeration read and its conditional commit attempt.
 */
const addAccountBeforeFirstCommit = (kv: Kv, suffix: string): Kv => {
  let injected = false;
  const wrapper = {
    get: (key: KvKey, options?: { consistency?: KvConsistencyLevel }) => kv.get(key, options),
    atomic: () => {
      const operation = kv.atomic();
      const chain: AtomicChain = {
        check: (...checks) => {
          operation.check(...checks);
          return chain;
        },
        set: (key, value, options) => {
          operation.set(key, value, options);
          return chain;
        },
        commit: async () => {
          if (!injected) {
            injected = true;
            const entry = await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" });
            const pool = parseCodexAuthPool(entry.value);
            if (pool) await kv.set(CODEX_AUTH_POOL_KV_KEY, { accounts: [...pool.accounts, authAccount(suffix)], updated_at_ms: Date.now() });
          }
          return await operation.commit();
        },
      };
      return chain as unknown as AtomicOperation;
    },
  };
  return wrapper as unknown as Kv;
};

test("a persisted false opt-out is preserved while explicit current settings win", async () => {
  const kv = await openSentinelTestKv();
  try {
    const [hashA, hashB, hashC] = await Promise.all([accountHash("a"), accountHash("b"), accountHash("c")]);
    await kv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, false);
    await kv.set(codexResetUsageKey(hashB), { enabled: true });
    await setAuthPool(kv, "a", "b");

    assert.equal(await migrateLegacyCodexResetOptOut(kv), "done");

    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashA)), { enabled: false });
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashB)), { enabled: true });
    assert.equal((await migrationMarker(kv))?.preserved_opt_out, true);
    assert.equal(typeof (await migrationMarker(kv))?.completed_at_ms, "number");
    assert.equal(await valueAt(kv, CODEX_BANKED_RESET_USAGE_LEGACY_KEY), false);

    assert.equal((await readCodexResetUsage(kv, hashA)).allowed, false);
    assert.equal((await readCodexResetUsage(kv, hashB)).allowed, true);
    // A subscription that appears only after the completed migration follows current defaults.
    assert.equal((await readCodexResetUsage(kv, hashC)).allowed, true);
  } finally {
    kv.close();
  }
});

test("a repeated migration never overwrites an operator decision", async () => {
  const kv = await openSentinelTestKv();
  try {
    const hashA = await accountHash("a");
    await kv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, false);
    await setAuthPool(kv, "a");
    assert.equal(await migrateLegacyCodexResetOptOut(kv), "done");
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashA)), { enabled: false });

    await kv.set(codexResetUsageKey(hashA), { enabled: true });
    assert.equal(await migrateLegacyCodexResetOptOut(kv), "done");
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashA)), { enabled: true });
    assert.equal((await readCodexResetUsage(kv, hashA)).allowed, true);
  } finally {
    kv.close();
  }
});

test("a normal no-legacy startup materializes no settings and stays enabled", async () => {
  const absentKv = await openSentinelTestKv();
  try {
    const hashA = await accountHash("a");
    await setAuthPool(absentKv, "a");
    assert.equal(await migrateLegacyCodexResetOptOut(absentKv), "done");
    assert.equal(await valueAt(absentKv, codexResetUsageKey(hashA)), null);
    assert.equal((await migrationMarker(absentKv))?.preserved_opt_out, false);
    assert.equal((await readCodexResetUsage(absentKv, hashA)).allowed, true);
  } finally {
    absentKv.close();
  }

  const enabledLegacyKv = await openSentinelTestKv();
  try {
    const hashA = await accountHash("a");
    await enabledLegacyKv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, true);
    await setAuthPool(enabledLegacyKv, "a");
    assert.equal(await migrateLegacyCodexResetOptOut(enabledLegacyKv), "done");
    assert.equal(await valueAt(enabledLegacyKv, codexResetUsageKey(hashA)), null);
    assert.equal((await readCodexResetUsage(enabledLegacyKv, hashA)).allowed, true);
  } finally {
    enabledLegacyKv.close();
  }
});

test("an empty account pool stays pending and guarded reads seed configured accounts", async () => {
  const kv = await openSentinelTestKv();
  try {
    const [hashA, hashB, hashC] = await Promise.all([accountHash("a"), accountHash("b"), accountHash("c")]);
    await kv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, false);

    assert.equal(await migrateLegacyCodexResetOptOut(kv), "pending");
    assert.equal(await migrationMarker(kv), null);
    assert.equal(await valueAt(kv, codexResetUsageKey(hashA)), null);

    // Accounts configured while the marker is still pending are seeded on read.
    assert.equal((await readCodexResetUsage(kv, hashA)).allowed, false);
    assert.equal((await readCodexResetUsage(kv, hashB)).allowed, false);
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashA)), { enabled: false });
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashB)), { enabled: false });

    await setAuthPool(kv, "a", "b");
    assert.equal(await migrateLegacyCodexResetOptOut(kv), "done");
    assert.equal((await migrationMarker(kv))?.preserved_opt_out, true);
    // A subscription that first appears after the marker follows current defaults.
    assert.equal((await readCodexResetUsage(kv, hashC)).allowed, true);
  } finally {
    kv.close();
  }
});

test("concurrent migrations and an interleaved explicit write converge on one marker", async () => {
  const kv = await openSentinelTestKv();
  try {
    const [hashA, hashB] = await Promise.all([accountHash("a"), accountHash("b")]);
    await kv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, false);
    await setAuthPool(kv, "a", "b");

    const [first, second] = await Promise.all([
      migrateLegacyCodexResetOptOut(kv),
      (async () => {
        // An operator decision that races the seed always wins and can only
        // reject a transaction that read the row before it.
        await kv.set(codexResetUsageKey(hashB), { enabled: true });
        return await migrateLegacyCodexResetOptOut(kv);
      })(),
    ]);

    assert.ok(first === "done" || second === "done");
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashA)), { enabled: false });
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashB)), { enabled: true });
    assert.equal((await migrationMarkers(kv)).length, 1);
  } finally {
    kv.close();
  }
});

test("a malformed legacy value stays fail-closed through the migration", async () => {
  const kv = await openSentinelTestKv();
  try {
    const [hashA, hashB] = await Promise.all([accountHash("a"), accountHash("b")]);
    await setAuthPool(kv, "a", "b");
    await kv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, "yes");

    assert.equal((await readCodexResetUsage(kv, hashA)).allowed, false);
    assert.equal(await migrateLegacyCodexResetOptOut(kv), "done");
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashA)), { enabled: false });
    assert.equal((await migrationMarker(kv))?.preserved_opt_out, true);
    assert.equal(await valueAt(kv, CODEX_BANKED_RESET_USAGE_LEGACY_KEY), "yes");
    assert.equal((await readCodexResetUsage(kv, hashA)).allowed, false);

    // A malformed current row stays fail-closed as well.
    await kv.set(codexResetUsageKey(hashB), { enabled: "yes" });
    assert.equal((await readCodexResetUsage(kv, hashB)).allowed, false);
  } finally {
    kv.close();
  }
});

test("a pre-existing row survives the completion commit and only absent rows are seeded", async () => {
  const kv = await openSentinelTestKv();
  try {
    const [hashA, hashB] = await Promise.all([accountHash("a"), accountHash("b")]);
    await kv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, false);
    await setAuthPool(kv, "a", "b");
    // As if a guarded read had already seeded A while the marker was absent.
    await kv.set(codexResetUsageKey(hashA), { enabled: false });

    assert.equal(await migrationMarker(kv), null);
    assert.equal(await migrateLegacyCodexResetOptOut(kv), "done");
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashA)), { enabled: false });
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashB)), { enabled: false });
    assert.equal((await migrationMarker(kv))?.preserved_opt_out, true);
  } finally {
    kv.close();
  }
});

test("an account configured between enumeration and the completion commit cannot escape the opt-out", async () => {
  const kv = await openSentinelTestKv();
  try {
    const [hashA, hashB, hashC] = await Promise.all([accountHash("a"), accountHash("b"), accountHash("c")]);
    await kv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, false);
    await setAuthPool(kv, "a");
    const racing = addAccountBeforeFirstCommit(kv, "b");

    assert.equal(await migrateLegacyCodexResetOptOut(racing), "pending");
    // The rejected transaction wrote nothing, so the marker is still absent and
    // neither account has escaped the persisted global opt-out yet.
    assert.equal(await migrationMarker(kv), null);
    assert.equal(await valueAt(kv, codexResetUsageKey(hashA)), null);
    assert.equal(await valueAt(kv, codexResetUsageKey(hashB)), null);

    // The next guarded read retries the completion from a fresh snapshot and
    // seeds the account configured during the previous attempt.
    assert.equal((await readCodexResetUsage(racing, hashB)).allowed, false);
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashA)), { enabled: false });
    assert.deepEqual(await valueAt(kv, codexResetUsageKey(hashB)), { enabled: false });
    assert.equal((await migrationMarker(kv))?.preserved_opt_out, true);
    // A subscription that appears after the completed migration follows current defaults.
    assert.equal((await readCodexResetUsage(kv, hashC)).allowed, true);
  } finally {
    kv.close();
  }
});

test("the completion marker stays inside the migration validator's accepted namespace", async () => {
  const kv = await openSentinelTestKv();
  try {
    await kv.set(CODEX_BANKED_RESET_USAGE_LEGACY_KEY, false);
    await setAuthPool(kv, "a");
    assert.equal(await migrateLegacyCodexResetOptOut(kv), "done");

    const options = { profile: "local", includeCache: false, includeLegacy: true } as const;
    assert.equal(classifyKvMigrationKey(CODEX_RESET_USAGE_MIGRATION_KEY, options).action, "import");
    assert.equal(classifyKvMigrationKey(CODEX_RESET_USAGE_MIGRATION_KEY, options).group, "migrations");

    const validation = await validateKvMigrationTarget(kv);
    assert.equal(validation.errors.filter((error) => error.startsWith("codex reset usage")).length, 0);
    assert.equal(validation.counts.codex_reset_usage, 1);
  } finally {
    kv.close();
  }
});
