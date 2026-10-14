import type { Kv, KvEntry, KvEntryMaybe, KvKey } from "#kv";
import { resetCodexAccountRoutingForTest } from "../../src/codex/account-routing.ts";
import { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } from "../../src/codex/index.ts";
import { setKvForTest } from "../../src/kv.ts";
import { METERED_QUOTA_STATE_KEY } from "../../src/metered-quota.ts";

type StoredValue = {
  value: unknown;
  versionstamp: string;
};

export const keyToString = (key: KvKey): string => JSON.stringify(key);

// `String(input)` would render a `Request` as "[object Request]" instead of its URL.
export const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

class CapacityKvStore extends Map<string, StoredValue> {
  private _nextVersion = 0;

  clearStore(): void {
    super.clear();
    this._nextVersion = 0;
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
  }

  put(key: KvKey, value: unknown): void {
    this._nextVersion += 1;
    this.set(keyToString(key), { value, versionstamp: `v${this._nextVersion}` });
  }

  remove(key: KvKey): void {
    this.delete(keyToString(key));
  }

  version(key: KvKey): string | null {
    return this.get(keyToString(key))?.versionstamp ?? null;
  }
}

export const kvStore = new CapacityKvStore();
export const kvStub = {
  get: (key: KvKey) => {
    const stored = kvStore.get(keyToString(key));
    return Promise.resolve({
      key,
      value: stored?.value ?? null,
      versionstamp: stored?.versionstamp ?? null,
    } as KvEntryMaybe<unknown>);
  },
  set: (key: KvKey, value: unknown) => {
    kvStore.put(key, value);
    return { ok: true } as const;
  },
  delete: (key: KvKey) => {
    kvStore.remove(key);
  },
  list: function* (selector?: { prefix?: KvKey }) {
    const prefix = selector?.prefix;
    for (const [encodedKey, stored] of kvStore.entries()) {
      const key = JSON.parse(encodedKey) as KvKey;
      if (prefix && !prefix.every((part, index) => key[index] === part)) continue;
      yield { key, value: stored.value, versionstamp: stored.versionstamp } as KvEntry<unknown>;
    }
  },
  atomic: () => {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const operations: ({ type: "set"; key: KvKey; value: unknown } | { type: "delete"; key: KvKey })[] = [];
    const chain = {
      check: (entry: KvEntryMaybe<unknown>) => {
        checks.push({ key: entry.key, versionstamp: entry.versionstamp });
        return chain;
      },
      set: (key: KvKey, value: unknown) => {
        operations.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        operations.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        for (const check of checks) {
          if (kvStore.version(check.key) !== check.versionstamp) return { ok: false, versionstamp: null } as const;
        }
        for (const operation of operations) {
          if (operation.type === "set") kvStore.put(operation.key, operation.value);
          else kvStore.remove(operation.key);
        }
        return { ok: true, versionstamp: `v${kvStore.size}` } as const;
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

export const nowMs = 1_800_000_000_000;

export const seed = (): void => {
  kvStore.clearStore();
  kvStore.put(CODEX_AUTH_POOL_KV_KEY, {
    accounts: [
      { access_token: "token-one", refresh_token: "refresh-one", account_id: "account-one", updated_at_ms: nowMs },
      { access_token: "token-two", refresh_token: "refresh-two", account_id: "account-two", updated_at_ms: nowMs },
    ],
    updated_at_ms: nowMs,
  });
  kvStore.put(METERED_QUOTA_STATE_KEY, {
    current_balance_quota: 750,
    post_refill_baseline_quota: 1_000,
    last_observed_used_quota: 250,
    quota_per_credit: 100,
    observed_at_ms: nowMs - 1_000,
    cycle_started_at_ms: nowMs - 5_000,
    confidence: "refill_observed",
    last_known_debits_quota: 0,
    last_inferred_credit_quota: 1_000,
    last_credit_at_ms: nowMs - 5_000,
    latest_refill_id: "refill-one",
    latest_refill_amount_credits: 10,
    latest_refill_completed_at_ms: nowMs - 5_000,
  });
  process.env["METERED_API_KEY"] = "metered-api-key";
};

const codexUsageBody = (primaryUsed: number, secondaryUsed: number, primaryResetAt = 1_800_010_000, secondaryResetAt = 1_800_020_000) => ({
  rate_limit: {
    primary_window: {
      limit_window_seconds: 10_800,
      used_percent: primaryUsed,
      reset_at: primaryResetAt,
    },
    secondary_window: {
      limit_window_seconds: 86_400,
      used_percent: secondaryUsed,
      reset_at: secondaryResetAt,
    },
  },
  private_account_field: "must-not-escape",
});

const codexSparkUsageBody = (primaryUsed: number, sparkUsed: number, sparkResetAt = 1_800_011_000) => ({
  rate_limit: {
    primary_window: {
      limit_window_seconds: 604_800,
      used_percent: primaryUsed,
      reset_at: 1_800_010_000,
    },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        primary_window: {
          limit_window_seconds: 18_000,
          used_percent: sparkUsed,
          reset_at: sparkResetAt,
        },
        secondary_window: null,
      },
    },
  ],
  private_account_field: "must-not-escape",
});

export const createFetcher =
  (
    calls: { account: string | null; authorization: string | null; url: string }[],
    failureAccount: string | null = null,
    metered: Readonly<{
      total_available?: number;
      total_granted?: number;
      total_used?: number;
      unlimited_quota?: boolean;
    }> = {},
    codexUsage: ((account: string | null) => readonly [number, number]) | null = null,
    codexSpark = false,
    codexSparkResetAt = 1_800_011_000,
    failureStatus = 503,
    codexSparkForAccount: ((account: string | null) => boolean) | null = null,
    codexResetAt: ((account: string | null) => readonly [number, number]) | null = null
  ) =>
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const url = requestUrl(input);
    const account = headers.get("ChatGPT-Account-ID");
    calls.push({ account, authorization: headers.get("Authorization"), url });
    if (url === "https://api.openlux.ai/api/usage/token/") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              total_available: metered.total_available ?? 750,
              total_granted: metered.total_granted ?? 1_000,
              total_used: metered.total_used ?? 250,
              unlimited_quota: metered.unlimited_quota ?? false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (account === failureAccount) {
      return Promise.resolve(new Response("upstream-secret-body", { status: failureStatus }));
    }
    const used = codexUsage?.(account) ?? (account === "account-one" ? [12.5, 38] : [67, 81.25]);
    const resetAt = codexResetAt?.(account);
    const includeCodexSpark = codexSparkForAccount ? codexSparkForAccount(account) : codexSpark;
    return Promise.resolve(
      new Response(
        JSON.stringify(
          includeCodexSpark ? codexSparkUsageBody(used[0], used[1], codexSparkResetAt) : codexUsageBody(used[0], used[1], resetAt?.[0], resetAt?.[1])
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
  };

let harnessEnvironment: Map<string, string | undefined> | null = null;

/** Reinstall this fixture explicitly when a Bun test file uses the cached harness. */
export const installHarness = (): void => {
  harnessEnvironment ??= new Map(["METERED_API_KEY"].map((name) => [name, process.env[name]]));
  setKvForTest(kvStub);
};
export const resetHarness = (): void => {
  kvStore.clearStore();
  installHarness();
};
export const cleanupHarness = (): void => {
  for (const [name, value] of harnessEnvironment ?? []) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  harnessEnvironment = null;
  setKvForTest(null);
};
