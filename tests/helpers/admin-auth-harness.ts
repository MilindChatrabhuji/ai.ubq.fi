import { setKvForTest } from "../../src/kv.ts";
import type { Kv, KvEntryMaybe, KvKey, KvKeyPart, KvListOptions, KvListSelector } from "#kv";
// Shared harness for this suite, moved out of the original test file.

import { keyToJson as keyToJSON } from "../../src/kv-conversion/profile-json.ts";

const keyToString = (key: KvKey): string => JSON.stringify(key);
const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};
const stringEntryLine = (key: KvKey, value: string): string =>
  JSON.stringify({
    key: keyToJSON(key),
    value: { type: "string", value },
    versionstamp: "00000000000000000000",
  });

let resetRuntimeCache = (): void => {};
let atomicCommitsToFail = 0;
let atomicCommitsBeforeFailure: number | null = null;
let resetAuthCache = (): void => {};
class TestKvStore extends Map<string, unknown> {
  override clear(): void {
    super.clear();
    atomicCommitsToFail = 0;
    atomicCommitsBeforeFailure = null;
    atomicSetCalls.length = 0;
    resetRuntimeCache();
    resetAuthCache();
  }
}
const kvStore = new TestKvStore();

/** Records the `expireIn` option every `kv.atomic().set()` call receives. */
const atomicSetCalls: { key: KvKey; expireIn?: number }[] = [];

const compareKvKeyPart = (left: KvKeyPart, right: KvKeyPart): number => {
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : 1;
};

const compareKvKeys = (left: KvKey, right: KvKey): number => {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const comparison = compareKvKeyPart(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
};

const matchesPrefix = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => key[index] === part);
const kvStoreHasPrefix = (prefix: KvKey): boolean => [...kvStore.keys()].some((encodedKey) => matchesPrefix(JSON.parse(encodedKey) as KvKey, prefix));

const kvStub = {
  get: (key: KvKey) => Promise.resolve({ key, value: kvStore.get(keyToString(key)) ?? null } as KvEntryMaybe<unknown>),
  set: (key: KvKey, value: unknown) => {
    kvStore.set(keyToString(key), value);
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: (selector: KvListSelector, options: KvListOptions = {}) => {
    const prefix = "prefix" in selector ? selector.prefix : [];
    let entries = [...kvStore.entries()]
      .map(([encodedKey, value]) => ({
        key: JSON.parse(encodedKey) as KvKey,
        value,
        versionstamp: "00000000000000000000",
      }))
      .filter((entry) => matchesPrefix(entry.key, prefix))
      .sort((left, right) => compareKvKeys(left.key, right.key));
    if (options.reverse) entries = entries.reverse();
    // A numeric index cursor stands in for Deno's opaque cursor, so the
    // production pagination contract (limit + iterator.cursor) is exercisable
    // against this in-memory store. A malformed cursor throws the same
    // TypeError the real Deno KV raises.
    const startIndex = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isSafeInteger(startIndex) || startIndex < 0) throw new TypeError("Invalid cursor");
    const limited = typeof options.limit === "number" ? entries.slice(startIndex, startIndex + options.limit) : entries.slice(startIndex);
    const nextIndex = startIndex + limited.length;
    return {
      // Real Deno KV reports an exhausted iterator with an empty cursor.
      cursor: nextIndex >= entries.length ? "" : String(nextIndex),
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        const value = limited.shift();
        return Promise.resolve(value ? { done: false, value } : { done: true, value: undefined });
      },
    };
  },
  atomic: () => {
    const ops: { type: "set" | "delete"; key: KvKey; value?: unknown }[] = [];
    const chain = {
      check: () => chain,
      set: (key: KvKey, value: unknown, options?: { expireIn?: number }) => {
        ops.push({ type: "set", key, value });
        atomicSetCalls.push({ key, expireIn: options?.expireIn });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        if (atomicCommitsBeforeFailure !== null) {
          if (atomicCommitsBeforeFailure === 0) {
            atomicCommitsBeforeFailure = null;
            return Promise.resolve({ ok: false } as const);
          }
          atomicCommitsBeforeFailure -= 1;
        }
        if (atomicCommitsToFail > 0) {
          atomicCommitsToFail -= 1;
          return Promise.resolve({ ok: false } as const);
        }
        for (const op of ops) {
          if (op.type === "set") kvStore.set(keyToString(op.key), op.value);
          else kvStore.delete(keyToString(op.key));
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

const {
  handleAdminApiKeysCreate,
  handleAdminApiKeysDelete,
  handleAdminApiKeysList,
  handleAdminApiKeysPaidFallbacks,
  handleAdminApiKeysUnrevoke,
  handleAdminApiKeysUpdate,
  handleAdminCodexResetSettings,
  handleAdminCodexAuth,
  handleAdminCodexModelsGet,
  handleAdminCodexModelsSet,
  handleAdminDefaults,
  handleAdminKernelUsageDelete,
  handleAdminKernelUsageSet,
  handleAdminKvMigrationImport,
} = await import("../../src/admin/index.ts");

// Helpers that lived between tests in the original file.

const seedCodexSnapshot = (snapshot: Parameters<typeof buildRuntimeConfig>[0]): void => {
  kvStore.set(keyToString(["ubq_ai", "codex_models"]), snapshot);
  const runtime = buildRuntimeConfig(snapshot);
  kvStore.set(keyToString(["uos_ai", "runtime_config", "v2"]), runtime);
  cacheRuntimeConfig(runtime);
};

const authPayload = {
  tokens: {
    access_token: "access",
    refresh_token: "refresh",
    account_id: "acct",
  },
};

const DISABLED_FALLBACK_TOKEN = `u_${"a".repeat(64)}`;

const ENABLED_FALLBACK_TOKEN = `u_${"b".repeat(64)}`;

const FAILED_FALLBACK_TOKEN = `u_${"c".repeat(64)}`;

const makeRequest = (body: unknown): Request =>
  new Request("https://ai.ubq.fi/admin/codex/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const meteredMetadataResponse = (url: string): Response => {
  if (url === "https://api.openlux.ai/api/ratio_config") {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          model_ratio: {
            "gpt-5.6-sol": 1,
            "not-in-codex-catalog": 1,
          },
          model_price: {},
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url === "https://api.openlux.ai/api/status") {
    return new Response(
      JSON.stringify({
        success: true,
        data: { setup: true, quota_per_unit: 500_000 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  throw new Error(`Unexpected Metered metadata URL: ${url}`);
};

export {
  DISABLED_FALLBACK_TOKEN,
  ENABLED_FALLBACK_TOKEN,
  FAILED_FALLBACK_TOKEN,
  TestKvStore,
  atomicSetCalls,
  authPayload,
  compareKvKeyPart,
  compareKvKeys,
  handleAdminApiKeysCreate,
  handleAdminApiKeysDelete,
  handleAdminApiKeysList,
  handleAdminApiKeysPaidFallbacks,
  handleAdminApiKeysUnrevoke,
  handleAdminApiKeysUpdate,
  handleAdminCodexAuth,
  handleAdminCodexModelsGet,
  handleAdminCodexModelsSet,
  handleAdminCodexResetSettings,
  handleAdminDefaults,
  handleAdminKernelUsageDelete,
  handleAdminKernelUsageSet,
  handleAdminKvMigrationImport,
  keyToString,
  kvStore,
  kvStoreHasPrefix,
  kvStub,
  makeRequest,
  matchesPrefix,
  meteredMetadataResponse,
  seedCodexSnapshot,
  stringEntryLine,
  urlOf,
};
export { listApiKeyRequestLogs, recordApiKeyRequestLog, buildRuntimeConfig, cacheRuntimeConfig };

export const setAtomicCommitsToFail = (value: number): void => {
  atomicCommitsToFail = value;
};
export const setAtomicCommitsBeforeFailure = (value: number | null): void => {
  atomicCommitsBeforeFailure = value;
};
const { listApiKeyRequestLogs, recordApiKeyRequestLog } = await import("../../src/analytics.ts");
const { buildRuntimeConfig, cacheRuntimeConfig, resetRuntimeConfigCacheForTest } = await import("../../src/runtime-config.ts");
const { resetCodexAuthCacheForTest } = await import("../../src/codex/index.ts");
resetAuthCache = resetCodexAuthCacheForTest;
resetRuntimeCache = resetRuntimeConfigCacheForTest;
export { resetRuntimeConfigCacheForTest, resetCodexAuthCacheForTest };
const { getKernelUsageLimitSnapshot, kernelRepoPolicyKey, kernelRepoWindowKey } = await import("../../src/kernel/quota-v2.ts");
export { getKernelUsageLimitSnapshot, kernelRepoPolicyKey, kernelRepoWindowKey };

/** Reinstall this fixture explicitly when a Bun test file uses the cached harness. */
export const installHarness = (): void => {
  setKvForTest(kvStub);
};
export const resetHarness = (): void => {
  kvStore.clear();
  atomicSetCalls.length = 0;
  installHarness();
};
export const cleanupHarness = (): void => {
  setKvForTest(null);
};
