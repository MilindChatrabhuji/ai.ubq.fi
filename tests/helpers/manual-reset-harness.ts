import type { Kv, KvKey } from "#kv";
import { createFetchMock } from "./fetch-mock.ts";
import { FakeCodexUsageResetProvider, MemoryKv, config, provenContract } from "./codex-banked-reset-harness.ts";
import { sha256Hex } from "../../src/utils.ts";
import { normalizeRoutingState, resetCodexAccountRoutingForTest, routingAccountIdentity } from "../../src/codex/capacity-routing.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
} from "../../src/codex/routing-state.ts";
import { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } from "../../src/provider/selection.ts";
import { codexResetUsageKey } from "../../src/codex/reset-settings.ts";
import { setKvForTest, resetKvForTest } from "../../src/kv.ts";
import type { CodexAuthPoolState } from "../../src/types.ts";
import type { ManualResetDependencies } from "../../src/codex/manual-reset.ts";

class ManualKv extends MemoryKv {
  getMany(keys: readonly KvKey[]) {
    return Promise.all(keys.map((key) => this.get(key)));
  }
}
export const manualFixture = async () => {
  const now = 1_700_000_000_000;
  const kv = new ManualKv();
  const pool: CodexAuthPoolState = {
    accounts: ["first", "target"].map((name) => ({ account_id: name, access_token: name + "-access", refresh_token: name + "-refresh", updated_at_ms: now })),
    updated_at_ms: now,
  };
  await kv.set(CODEX_AUTH_POOL_KV_KEY, pool);
  const targetHash = await sha256Hex("target");
  const identities = await Promise.all(pool.accounts.map(routingAccountIdentity));
  let routing = await normalizeRoutingState(null, pool, now);
  const block = {
    blocked_until_ms: now + 3_600_000,
    source: "body_resets_at" as const,
    legacy_fallback: false,
    quota_signal_observed_at_ms: now - 1000,
    observed_reset_at_ms: now + 3_600_000,
    observed_reset_at_is_stable: true,
    banked_reset_generation_ambiguous: false,
    banked_reset_recovery_probe_pending: false,
  };
  routing = {
    ...routing,
    slots: [
      routing.slots[0],
      {
        ...routing.slots[1],
        quota_blocked_until_ms: block.blocked_until_ms,
        quota_block_source: block.source,
        quota_blocked_classes: ["standard", "reserve"],
        quota_blocks_by_class: { standard: block, reserve: block },
        quota_signal_observed_at_ms: now - 1000,
      },
    ],
  };
  await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, routing);
  const active = {
    v: 1,
    account_id_hash: identities[0].accountIdHash,
    credential_version: identities[0].credentialVersion,
    pool_versionstamp: kv.versionstamp(CODEX_AUTH_POOL_KV_KEY),
    slot: 0,
    routing_generation: 0,
    generation: 7,
    transition_reason: null,
    updated_at_ms: now,
  };
  await kv.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, active);
  await kv.set(PROVIDER_SELECTION_KV_KEY, { provider_ids: ["codex"], updated_at_ms: now });
  await kv.set(codexResetUsageKey(targetHash), { enabled: false });
  const provider = new FakeCodexUsageResetProvider({
    ...provenContract(),
    lookup: { byIdempotencyKey: false, byProviderReceiptId: false },
    verification: { independentlyVerifiable: false },
    redeemOutcomeIsFinal: true,
  });
  let restored = true;
  let usageCalls = 0;
  const fetcher = createFetchMock(() => {
    usageCalls++;
    const used = provider.redeemInputs.length && restored ? 1 : 100;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: used, reset_at: (now + 60_000) / 1000, limit_window_seconds: 18000 },
            secondary_window: { used_percent: used, reset_at: (now + 3_600_000) / 1000, limit_window_seconds: 604800 },
          },
          additional_rate_limits: [
            {
              limit_name: "gpt-reserve",
              rate_limit: { primary_window: { used_percent: 100, reset_at: (now + 3_600_000) / 1000, limit_window_seconds: 18000 } },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
  });
  const stale = {
    slot: 1,
    account_id_hash: identities[1].accountIdHash,
    state: "available",
    source_observed_at_ms: now - 500,
    snapshot_at_ms: now - 500,
    windows: { primary: { used_percent: 100, reset_at_ms: now + 60_000 }, secondary: { used_percent: 100, reset_at_ms: now + 3_600_000 } },
    additional_rate_limits: [],
  };
  await kv.set(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, { v: 1, updated_at_ms: now - 500, observations: [stale] });
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  setKvForTest(kv as unknown as Kv);
  const dependencies: ManualResetDependencies = {
    kv: kv as unknown as Kv,
    reloadConfig: () => config({ mode: "shadow" }),
    provider: () => provider,
    fetcher,
    now: () => now,
  };
  return {
    kv,
    now,
    pool,
    targetHash,
    identities,
    active,
    provider,
    dependencies,
    usageCalls: () => usageCalls,
    restore: (value: boolean) => {
      restored = value;
    },
  };
};
export const cleanupManualFixture = () => {
  resetKvForTest();
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
};
