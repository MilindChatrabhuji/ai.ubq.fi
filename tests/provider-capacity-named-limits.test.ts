import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/provider-capacity-harness.ts";
// Named additional-rate-limit coverage moved beside tests/provider-capacity.test.ts:
// that file sits at the 1500-line test cap enforced by scripts/file-size-ratchet.ts,
// and the PR899 head pushed it to 1515 lines, which failed `size:check`.
import assert from "node:assert/strict";

import { CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY } from "../src/codex/account-routing.ts";
import {
  getPersistedProviderCapacityView,
  PROVIDER_CAPACITY_SNAPSHOT_KEY,
  type ProviderCapacityCodexSource,
  refreshProviderCapacity,
} from "../src/provider/capacity.ts";
import { createFetcher, keyToString, kvStore, kvStub, nowMs, seed } from "./helpers/provider-capacity-harness.ts";

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("sampler carries named Codex model limits alongside null secondary windows", async () => {
  seed();
  const live = await refreshProviderCapacity({
    kv: kvStub,
    fetcher: createFetcher([], null, {}, null, true),
    now: () => nowMs,
  });
  const accountOne = live.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 1);
  const accountTwo = live.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 2);
  assert.equal(accountOne?.windows.secondary, null);
  assert.deepEqual(accountOne.additional_rate_limits, [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      windows: {
        primary: {
          limit_window_seconds: 18_000,
          used_percent: 38,
          reset_at_ms: 1_800_011_000_000,
        },
        secondary: null,
      },
    },
  ]);
  assert.deepEqual(accountTwo?.additional_rate_limits, [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      windows: {
        primary: {
          limit_window_seconds: 18_000,
          used_percent: 81.25,
          reset_at_ms: 1_800_011_000_000,
        },
        secondary: null,
      },
    },
  ]);

  const persisted = await getPersistedProviderCapacityView({ kv: kvStub, now: () => nowMs });
  const persistedAccount = persisted.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 1);
  const persistedAccountTwo = persisted.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 2);
  assert.deepEqual(persistedAccount?.additional_rate_limits, accountOne.additional_rate_limits);
  assert.deepEqual(persistedAccountTwo?.additional_rate_limits, accountTwo.additional_rate_limits);
  assert.equal(JSON.stringify(live).includes("must-not-escape"), false);
  const routingObservation = JSON.stringify(kvStore.get(keyToString(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY)));
  assert.equal(routingObservation.includes("account-one"), false);
  assert.equal(routingObservation.includes("account-two"), false);
  assert.equal(routingObservation.includes("GPT-5.3-Codex-Spark"), true);
});

test("sampler keeps unused additional limits visible while deferring them from routing", async () => {
  seed();
  const live = await refreshProviderCapacity({
    kv: kvStub,
    fetcher: createFetcher([], null, {}, () => [12.5, 0], true, nowMs / 1_000 + 18_000),
    now: () => nowMs,
  });
  const accountOne = live.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 1);
  assert.deepEqual(accountOne?.additional_rate_limits, [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      windows: {
        primary: {
          limit_window_seconds: 18_000,
          used_percent: 0,
          reset_at_ms: nowMs + 18_000_000,
        },
        secondary: null,
      },
    },
  ]);
  const routingObservation = JSON.stringify(kvStore.get(keyToString(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY)));
  assert.equal(routingObservation.includes("GPT-5.3-Codex-Spark"), false);
});

test("sampler keeps named limits on the reporting account only", async () => {
  seed();
  const live = await refreshProviderCapacity({
    kv: kvStub,
    fetcher: createFetcher([], null, {}, null, true, 1_800_011_000, 503, (account) => account === "account-one"),
    now: () => nowMs,
  });
  const accountOne = live.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 1);
  const accountTwo = live.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 2);
  assert.equal(accountOne?.additional_rate_limits.length, 1);
  assert.deepEqual(accountTwo?.additional_rate_limits, []);

  const storedSnapshot = kvStore.get(keyToString(PROVIDER_CAPACITY_SNAPSHOT_KEY))?.value as
    | {
        sources?: readonly { source: string; slot?: number; additional_rate_limits?: readonly unknown[] }[];
      }
    | undefined;
  assert.deepEqual(storedSnapshot?.sources?.find((source) => source.source === "codex" && source.slot === 2)?.additional_rate_limits, []);

  const persisted = await getPersistedProviderCapacityView({ kv: kvStub, now: () => nowMs });
  const persistedAccountTwo = persisted.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 2);
  assert.deepEqual(persistedAccountTwo?.additional_rate_limits, []);
  const routingStore = kvStore.get(keyToString(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY))?.value as
    | {
        observations?: readonly { slot: number; additional_rate_limits: readonly unknown[] }[];
      }
    | undefined;
  assert.deepEqual(
    routingStore?.observations?.map((observation) => [observation.slot, observation.additional_rate_limits.length]),
    [
      [0, 1],
      [1, 0],
    ]
  );
});
