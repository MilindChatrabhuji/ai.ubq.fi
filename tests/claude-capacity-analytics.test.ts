import assert from "node:assert/strict";
import { claudeCapacitySource, handleProviderCapacity } from "../src/provider/capacity.ts";
import { setKvForTest } from "../src/kv.ts";
import {
  resetClaudeCodeCredentialCacheForTest,
  storeClaudeCodeStoredCredential,
  storeClaudeCodeWorkspaceState,
} from "../src/provider/claude-code-credentials.ts";
import { recordClaudeCodeQuotaOutcome } from "../src/provider/claude-code-quota.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";

const keyOf = (key: Deno.KvKey): string => JSON.stringify(key);

class AnalyticsKv {
  readonly values = new Map<string, unknown>();

  get<T>(key: Deno.KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<Deno.KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: stored === undefined ? null : "00000000000000000001",
    } as Deno.KvEntryMaybe<T>);
  }

  set(key: Deno.KvKey, value: unknown): Promise<Deno.KvCommitResult> {
    this.values.set(keyOf(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" } as Deno.KvCommitResult);
  }

  delete(key: Deno.KvKey): Promise<void> {
    this.values.delete(keyOf(key));
    return Promise.resolve();
  }
}

const NOW_MS = 1_800_000_000_000;
const nullEnv = () => null;

const withKv = async (run: (kv: AnalyticsKv) => Promise<void>): Promise<void> => {
  const kv = new AnalyticsKv();
  resetClaudeCodeCredentialCacheForTest();
  resetProviderHealthThrottleForTest();
  resetProviderSelectionCacheForTest();
  setKvForTest(kv as unknown as Deno.Kv);
  try {
    await run(kv);
  } finally {
    setKvForTest(null);
  }
};

Deno.test("an unconfigured tier reports not_configured without inventing a credential", async () => {
  await withKv(async (kv) => {
    const source = await claudeCapacitySource(kv as unknown as Deno.Kv, NOW_MS, nullEnv);
    assert.equal(source.source, "claude_code");
    assert.equal(source.state, "unavailable");
    assert.equal(source.failure_kind, "not_configured");
    assert.equal(source.credential_kind, null);
    assert.equal(source.workspace_id, null);
    assert.equal(source.windows.five_hour, null);
    assert.deepEqual(source.standard, []);
    assert.equal(source.last_error, null);
  });
});

Deno.test("a configured tier reports its credential, workspace, and observed subscription windows", async () => {
  await withKv(async (kv) => {
    const store = kv as unknown as Deno.Kv;
    await storeClaudeCodeStoredCredential(store, { secret: "sk-ant-usr-1A6exampleBwAA" });
    await storeClaudeCodeWorkspaceState(store, {
      id: "wrkspc_01ErorW3iFLRvQy55cpNWtEt",
      name: "Default",
      source: "kv",
      discovered_at_ms: null,
      verified_at_ms: NOW_MS - 1_000,
      last_error: null,
    });
    await recordClaudeCodeQuotaOutcome(store, {
      observation: {
        windows: {
          "5h": { status: "allowed", utilization: 0.4, reset_at_ms: NOW_MS + 3_600_000, observed_at_ms: NOW_MS - 5_000 },
          "7d": { status: "allowed", utilization: 0.1, reset_at_ms: NOW_MS + 86_400_000, observed_at_ms: NOW_MS - 5_000 },
        },
        standard: {
          requests: { limit: 50, remaining: 49, reset_at_ms: NOW_MS + 60_000, observed_at_ms: NOW_MS - 5_000 },
        },
        representative_claim: "five_hour",
        observed_at_ms: NOW_MS - 5_000,
      },
      nowMs: NOW_MS,
    });
    const source = await claudeCapacitySource(store, NOW_MS, nullEnv);
    assert.equal(source.state, "available");
    assert.equal(source.credential_kind, "api_key");
    assert.equal(source.workspace_id, "wrkspc_01ErorW3iFLRvQy55cpNWtEt");
    assert.equal(source.failure_kind, null);
    assert.equal(source.source_observed_at_ms, NOW_MS - 5_000);
    const fiveHour = source.windows.five_hour;
    const sevenDay = source.windows.seven_day;
    assert(fiveHour, "the 5h window is observed");
    assert(sevenDay, "the 7d window is observed");
    assert.equal(fiveHour.used_percent, 40, "the upstream fraction is normalized to a percentage");
    assert.equal(fiveHour.status, "allowed");
    assert.equal(sevenDay.used_percent, 10);
    assert.deepEqual(source.standard, [{ family: "requests", limit: 50, remaining: 49, reset_at_ms: NOW_MS + 60_000 }]);
  });
});

Deno.test("a recorded configuration rejection keeps the tier unavailable with its exact reason", async () => {
  await withKv(async (kv) => {
    const store = kv as unknown as Deno.Kv;
    await storeClaudeCodeStoredCredential(store, { secret: "sk-ant-usr-1A6exampleBwAA" });
    await recordClaudeCodeQuotaOutcome(store, {
      observation: null,
      config_error: {
        kind: "billing_blocked",
        status: 400,
        message: "Your credit balance is too low to access the Anthropic API.",
        retry_after_ms: null,
      },
      nowMs: NOW_MS,
    });
    const source = await claudeCapacitySource(store, NOW_MS + 1_000, nullEnv);
    assert.equal(source.state, "unavailable");
    assert.equal(source.failure_kind, "upstream_error");
    assert.equal(source.failure_status, 400);
    assert.equal(source.last_error?.kind, "billing_blocked");
    assert.equal(source.last_error.message, "Your credit balance is too low to access the Anthropic API.");
    assert(source.cooldown_until_ms !== null && source.cooldown_until_ms > NOW_MS);

    // Once the guard expires and a request serves, the row returns to available.
    await recordClaudeCodeQuotaOutcome(store, { observation: null, served: true, nowMs: NOW_MS + 3_600_000 });
    const served = await claudeCapacitySource(store, NOW_MS + 3_600_001, nullEnv);
    assert.equal(served.state, "available");
    assert.equal(served.last_error, null);
  });
});

Deno.test("the capacity endpoint carries the Claude analytics row next to the Codex sources", async () => {
  await withKv(async (kv) => {
    const store = kv as unknown as Deno.Kv;
    await storeClaudeCodeStoredCredential(store, { secret: "sk-ant-usr-1A6exampleBwAA" });
    const response = await handleProviderCapacity(new Request("https://ai.ubq.fi/admin/providers/capacity?refresh=live"), {
      kv: store,
      fetcher: () => Promise.reject(new Error("no upstream probe in this fixture")),
      now: () => NOW_MS,
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      sources?: { source?: string }[];
      claude?: { source?: string; state?: string; credential_kind?: string | null; label?: string };
    };
    const storedSources = payload.sources ?? [];
    assert.equal(Array.isArray(payload.sources), true);
    assert.equal(
      storedSources.some((source) => source.source === "claude_code"),
      false,
      "the stored Codex/metered snapshot record keeps its own three sources"
    );
    const claude = payload.claude;
    assert(claude, "the admin payload carries the Claude analytics row");
    assert.equal(claude.source, "claude_code");
    assert.equal(claude.label, "Claude subscription");
    assert.equal(claude.credential_kind, "api_key");
    assert.equal(claude.state, "available");
  });
});
