import { openKv, type Kv } from "#kv";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { claudeCapacitySource, handleProviderCapacity } from "../src/provider/capacity.ts";
import { setKvForTest } from "../src/kv.ts";
import {
  resetClaudeCodeCredentialCacheForTest,
  storeClaudeCodeStoredCredential,
  storeClaudeCodeWorkspaceState,
} from "../src/provider/claude-code-credentials.ts";
import { recordClaudeCodeQuotaOutcome as recordBoundQuotaOutcome, type ClaudeCodeAcceptedObservation } from "../src/provider/claude-code-quota.ts";
import { resolveClaudeCodeAccount, updateClaudeCodeAccount, selectClaudeCodeAccount } from "../src/provider/claude-code-accounts.ts";
import type { ProviderCapacityView } from "../src/provider/capacity-contract.ts";
import {
  recordClaudeCapacityObservation,
  readClaudeCapacityHistory,
  claudeCapacityUsedPercent,
  CLAUDE_CAPACITY_HISTORY_PREFIX,
  readClaudeCapacityHistoryPoint,
} from "../src/provider/claude-capacity-history.ts";
import { listClaudeCapacityRollups, CLAUDE_CAPACITY_READ_LIMIT, CLAUDE_CAPACITY_ROLLUP_PREFIX } from "../src/provider/claude-capacity-rollups.ts";
import { CountingKv as AnalyticsKv } from "./helpers/counting-kv.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";

const recordClaudeCodeQuotaOutcome = async (kv: Kv, input: Omit<Parameters<typeof recordBoundQuotaOutcome>[1], "binding">) => {
  const binding = await resolveClaudeCodeAccount(kv, () => null);
  assert(binding);
  return await recordBoundQuotaOutcome(kv, { ...input, binding });
};

const NOW_MS = 1_800_000_000_000;
const nullEnv = () => null;

const withKv = async (run: (kv: AnalyticsKv) => Promise<void>): Promise<void> => {
  const kv = new AnalyticsKv();
  resetClaudeCodeCredentialCacheForTest();
  resetProviderHealthThrottleForTest();
  resetProviderSelectionCacheForTest();
  setKvForTest(kv as unknown as Kv);
  try {
    await run(kv);
  } finally {
    setKvForTest(null);
  }
};

test("an unconfigured tier reports not_configured without inventing a credential", async () => {
  await withKv(async (kv) => {
    const source = await claudeCapacitySource(kv as unknown as Kv, NOW_MS, nullEnv);
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

test("a configured tier reports its credential, workspace, and observed subscription windows", async () => {
  await withKv(async (kv) => {
    const store = kv as unknown as Kv;
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

test("a recorded configuration rejection keeps the tier unavailable with its exact reason", async () => {
  await withKv(async (kv) => {
    const store = kv as unknown as Kv;
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

test("the capacity endpoint carries the Claude analytics row next to the Codex sources", async () => {
  await withKv(async (kv) => {
    const store = kv as unknown as Kv;
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

test("current Claude roster rows and retained history stay account/cohort-bound while the legacy projection follows active", async () => {
  await withKv(async (kv) => {
    const store = kv as unknown as Kv;
    await storeClaudeCodeStoredCredential(store, { secret: "sk-ant-api-account-one-fixture" });
    const first = await resolveClaudeCodeAccount(store, nullEnv);
    assert(first);
    const second = await updateClaudeCodeAccount(
      store,
      { createNew: true, credential: { ...first.credential, secret: "sk-ant-api-account-two-fixture" } },
      nullEnv
    );
    for (const [binding, utilization, observedAt] of [
      [first, 0.07, NOW_MS - 1_000],
      [second, 0.4, NOW_MS - 1_900_000],
    ] as const) {
      await recordBoundQuotaOutcome(store, {
        binding,
        response_status: 200,
        nowMs: NOW_MS,
        observation: {
          windows: { "5h": { status: "allowed", utilization, reset_at_ms: NOW_MS + 18_000_000, observed_at_ms: observedAt } },
          standard: {},
          representative_claim: "five_hour",
          observed_at_ms: observedAt,
        },
      });
    }
    const read = async () =>
      (await (
        await handleProviderCapacity(new Request("https://fixture.invalid/admin/providers/capacity"), {
          kv: store,
          now: () => NOW_MS,
          fetcher: () => Promise.reject(new Error("no account probes on capacity read")),
        })
      ).json()) as ProviderCapacityView;
    const payload = await read();
    const accounts = payload.claude_accounts;
    assert(accounts);
    assert.equal(accounts.length, 2);
    assert.deepEqual(
      payload.claude,
      accounts.find((account) => account.account_id === first.account_id),
      "old clients receive exactly the active row, not a combined pool"
    );
    assert.equal(accounts[0]?.windows.five_hour?.used_percent, 0.07 * 100);
    assert.equal(accounts[1]?.windows.five_hour?.used_percent, 40);
    assert.equal(accounts[1]?.state, "stale");
    assert.deepEqual(new Set(payload.claude_history?.points.map((point) => point.account_id)), new Set([first.account_id, second.account_id]));
    assert.equal(payload.sources.length, 3, "existing persisted Codex/metered contract is unchanged");
    assert.doesNotMatch(JSON.stringify(payload), /sk-ant-|credential_fingerprint|evidence_generation/);
    await selectClaudeCodeAccount(store, second.account_id);
    const switched = await read();
    assert.equal(switched.claude?.account_id, second.account_id);
    assert.equal(switched.claude.state, "stale");
    assert.deepEqual(switched.claude_history, payload.claude_history, "selecting active cannot relabel or generate historical evidence");
    const replacement = await updateClaudeCodeAccount(
      store,
      { accountId: second.account_id, credential: { ...second.credential, secret: "sk-ant-api-account-two-replacement-fixture" } },
      nullEnv
    );
    assert.notEqual(replacement.account_cohort_id, second.account_cohort_id);
    const replaced = await read();
    assert.equal(replaced.claude?.account_cohort_id, replacement.account_cohort_id);
    assert.equal(replaced.claude.windows.five_hour, null, "a replacement cannot inherit its old cohort's current quota");
    assert.equal(replaced.claude.source_observed_at_ms, null);
    assert(
      replaced.claude_history?.points.some((point) => point.account_cohort_id === second.account_cohort_id),
      "old cohort history remains explicitly old"
    );
  });
});

const observedEvent = (offset = 0, patch: Partial<ClaudeCodeAcceptedObservation> = {}): ClaudeCodeAcceptedObservation => ({
  v: 1,
  observation_id: `observation-${offset}`,
  account_id: "00000000-0000-4000-8000-000000000001",
  account_cohort_id: "00000000-0000-4000-8000-000000000002",
  credential_kind: "oauth",
  workspace_id: null,
  source_observed_at_ms: NOW_MS + offset,
  sampled_at_ms: NOW_MS + offset,
  state: "available",
  response_status: 200,
  observation: {
    windows: { "5h": { status: "allowed", utilization: 0.07, reset_at_ms: NOW_MS + 18_000_000, observed_at_ms: NOW_MS + offset } },
    standard: {},
    representative_claim: "five_hour",
    observed_at_ms: NOW_MS + offset,
  },
  ...patch,
});

test("Claude history retains actual partial observations once, without backfilling missing windows or read samples", async () => {
  const kv = new AnalyticsKv();
  const store = kv as unknown as Kv;
  const event = observedEvent();
  await recordClaudeCapacityObservation(store, event);
  await recordClaudeCapacityObservation(store, { ...event, observation_id: "retry-with-new-notification-id", sampled_at_ms: event.sampled_at_ms + 1 });
  const before = kv.commands.filter((command) => command.command === "atomic.commit").length;
  for (let n = 0; n < 3; n++) {
    const view = await readClaudeCapacityHistory(store, NOW_MS + 1_000);
    assert.equal(view.scan, "ok");
    assert.equal(view.points.length, 1);
    assert(Math.abs((view.points[0]?.windows.five_hour?.used_percent ?? -1) - 7) < 1e-10);
    assert.equal(view.points[0]?.windows.seven_day, null);
    assert.equal(view.points[0]?.source_observed_at_ms, NOW_MS);
  }
  assert.equal(kv.commands.filter((command) => command.command === "atomic.commit").length, before);
  const rollups = await listClaudeCapacityRollups(store, NOW_MS - 3_600_000, NOW_MS + 1_000);
  assert.equal(rollups.points.length, 1);
  assert.equal(rollups.points[0]?.samples, 1);
  assert.equal(claudeCapacityUsedPercent(1.2), 100, "fraction above one cannot become near-full capacity");
  assert.equal(claudeCapacityUsedPercent(0), 0);
  assert.equal(claudeCapacityUsedPercent(null), null);
});

test("Claude normal sampling is bounded, retains two real events and isolates a replacement cohort", async () => {
  const kv = new AnalyticsKv();
  const store = kv as unknown as Kv;
  for (let n = 0; n < 20; n++) await recordClaudeCapacityObservation(store, observedEvent(n));
  const view = await readClaudeCapacityHistory(store, NOW_MS + 1_000);
  assert.equal(view.points.length, 2);
  assert.equal(kv.commands.filter((command) => command.command === "atomic.commit").length, 2);
  await recordClaudeCapacityObservation(store, observedEvent(100, { account_cohort_id: "00000000-0000-4000-8000-000000000003" }));
  const replacement = await readClaudeCapacityHistory(store, NOW_MS + 1_000);
  assert.equal(replacement.points.length, 3);
  assert.equal(new Set(replacement.points.map((point) => point.account_cohort_id)).size, 2);
  const rollups = await listClaudeCapacityRollups(store, NOW_MS - 3_600_000, NOW_MS + 1_000);
  assert.equal(rollups.points.length, 2);
});

test("Claude unknown time and standard-only observations never manufacture subscription windows", async () => {
  const kv = new AnalyticsKv();
  const store = kv as unknown as Kv;
  await recordClaudeCapacityObservation(
    store,
    observedEvent(0, {
      credential_kind: "api_key",
      source_observed_at_ms: null,
      observation: {
        windows: {},
        standard: { requests: { limit: 10, remaining: 0, reset_at_ms: null, observed_at_ms: NOW_MS } },
        representative_claim: null,
        observed_at_ms: NOW_MS,
      },
    })
  );
  const view = await readClaudeCapacityHistory(store, NOW_MS + 1);
  assert.equal(view.points[0]?.source_observed_at_ms, null);
  assert.equal(view.points[0]?.windows.five_hour, null);
  assert.equal(view.points[0]?.standard[0]?.remaining, 0);
  assert.deepEqual((await listClaudeCapacityRollups(store, NOW_MS - 3_600_000, NOW_MS + 1)).points, []);
  const count = view.points.length;
  await recordClaudeCapacityObservation(
    store,
    observedEvent(1, { observation: { windows: {}, standard: {}, representative_claim: null, observed_at_ms: NOW_MS + 1 } })
  );
  assert.equal((await readClaudeCapacityHistory(store, NOW_MS + 2)).points.length, count);
});

test("Claude history fails closed on unavailable scans and bounded CAS contention without quota writes", async () => {
  class ContendedKv extends AnalyticsKv {
    attempts = 0;
    override atomic() {
      const operation = super.atomic();
      operation.commit = () => {
        this.attempts++;
        return Promise.resolve({ ok: false as const });
      };
      return operation;
    }
  }
  const kv = new ContendedKv();
  await assert.rejects(recordClaudeCapacityObservation(kv as unknown as Kv, observedEvent()), /four attempts/);
  assert.equal(kv.attempts, 4);
  assert.equal(kv.entries.size, 0);
  assert(kv.commands.every((command) => command.keys.every((key) => key.slice(0, 3).join("/") === "uos_ai/provider_capacity/claude")));
  const broken = new Proxy(kv, {
    get(target, key) {
      if (key === "list") {
        return () => {
          throw new Error("fixture scan failure");
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.equal((await readClaudeCapacityHistory(broken as unknown as Kv, NOW_MS)).scan, "unavailable");
});

test("Claude history and cohort/reset rollups survive a real native close and reopen", async () => {
  const root = resolve(".cleanup-evidence/claude-history-native");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(`${root}/case-`);
  const path = `${directory}/kv.sqlite3`;
  let kv: Kv | null = await openKv(path);
  try {
    const now = Date.now();
    const event = observedEvent(0, {
      source_observed_at_ms: now,
      sampled_at_ms: now,
      observation: {
        windows: { "5h": { status: "allowed", utilization: 0, reset_at_ms: now + 18_000_000, observed_at_ms: now } },
        standard: {},
        representative_claim: null,
        observed_at_ms: now,
      },
    });
    await recordClaudeCapacityObservation(kv, event);
    kv.close();
    kv = await openKv(path);
    const history = await readClaudeCapacityHistory(kv, now + 1_000);
    assert.equal(history.scan, "ok");
    assert.equal(history.points.length, 1);
    assert.equal(history.points[0]?.windows.five_hour?.used_percent, 0);
    await recordClaudeCapacityObservation(kv, event);
    const rollups = await listClaudeCapacityRollups(kv, now - 3_600_000, now + 1_000);
    assert.equal(rollups.points.length, 1);
    assert.equal(rollups.points[0]?.samples, 1);
  } finally {
    kv.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude range scans report bounded truncation and corrupt evidence instead of an empty successful history", async () => {
  const kv = new AnalyticsKv();
  const store = kv as unknown as Kv;
  await recordClaudeCapacityObservation(store, observedEvent());
  let yielded = 0;
  let corrupt = false;
  const bounded = new Proxy(kv, {
    get(target, name) {
      if (name !== "list") {
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (selector: { start: unknown[]; end: unknown[] }, options: { limit: number; reverse: boolean }) => {
        assert.equal(options.limit, CLAUDE_CAPACITY_READ_LIMIT + 1);
        assert.equal(options.reverse, true);
        assert(selector.end.length === selector.start.length && Number(selector.end.at(-1)) > Number(selector.start.at(-1)));
        const isHistory = selector.start.includes("history");
        const prefix = isHistory ? CLAUDE_CAPACITY_HISTORY_PREFIX : CLAUDE_CAPACITY_ROLLUP_PREFIX;
        const template = [...target.entries.values()].find((entry) => prefix.every((part, index) => entry.key[index] === part));
        assert(template);
        return (function* () {
          for (let n = 0; n < CLAUDE_CAPACITY_READ_LIMIT + 10; n++) {
            yielded++;
            const value = structuredClone(template.value) as Record<string, unknown>;
            const id = `bounded-account-${n}`;
            value.account_id = id;
            if (isHistory) value.points = (value.points as Record<string, unknown>[]).map((point) => ({ ...point, account_id: id }));
            if (corrupt) value.v = 999;
            const key = [...template.key];
            key[prefix.length + 1] = id;
            yield { key, value, versionstamp: template.versionstamp };
          }
        })();
      };
    },
  }) as unknown as Kv;
  const history = await readClaudeCapacityHistory(bounded, NOW_MS + 1_000);
  assert.equal(history.scan, "ok");
  assert.equal(history.truncated, true);
  assert.equal(history.points.length, CLAUDE_CAPACITY_READ_LIMIT);
  assert.equal(yielded, CLAUDE_CAPACITY_READ_LIMIT + 1);
  yielded = 0;
  const rollups = await listClaudeCapacityRollups(bounded, NOW_MS - 3_600_000, NOW_MS + 1_000);
  assert.equal(rollups.scan, "ok");
  assert.equal(rollups.truncated, true);
  assert.equal(rollups.points.length, CLAUDE_CAPACITY_READ_LIMIT);
  assert.equal(yielded, CLAUDE_CAPACITY_READ_LIMIT + 1);
  corrupt = true;
  assert.equal((await readClaudeCapacityHistory(bounded, NOW_MS + 1_000)).scan, "unavailable");
  assert.equal((await listClaudeCapacityRollups(bounded, NOW_MS - 3_600_000, NOW_MS + 1_000)).scan, "unavailable");
});

test("first full inference records Claude headers before any admin read and admin polling adds no samples", async () => {
  const harness = await import("./helpers/openai-compat-harness.ts");
  const { PROVIDER_SELECTION_KV_KEY } = await import("../src/provider/selection.ts");
  const { CODEX_MODELS_WHITELIST_KV_KEY } = await import("../src/models/codex-models-whitelist.ts");
  const names = ["CLAUDE_CODE_ALLOWED_KEY_IDS", "CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "METERED_API_KEY", "SURPLUS_API_KEY"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const baseline = new Map(harness.kvStore);
  const store = harness.kvStub as unknown as Kv;
  const model = "claude-history-fixture";
  const principal = { keyId: "history-owner", kernelRepo: null, kernelOrg: null } as const;
  let native = 0;
  harness.installHarness();
  try {
    for (const name of names) Reflect.deleteProperty(process.env, name);
    process.env.CLAUDE_CODE_ALLOWED_KEY_IDS = principal.keyId;
    harness.kvStore.set(harness.keyToString(harness.DEFAULT_REASONING_EFFORT_KEY), "none");
    await storeClaudeCodeStoredCredential(store, { secret: "sk-ant-oat-history-fixture" });
    await store.set(PROVIDER_SELECTION_KV_KEY, { provider_ids: ["claude_code"], updated_at_ms: 1 });
    await store.set(CODEX_MODELS_WHITELIST_KV_KEY, { model_ids: [model], updated_at_ms: 1 });
    resetProviderSelectionCacheForTest();
    await harness.withFetchMock(
      (url) => {
        if (url.startsWith("https://api.anthropic.com/v1/models"))
          return Response.json({ data: [{ id: model, capabilities: { thinking: { types: { disabled: { supported: true } } } } }], has_more: false });
        if (url === "https://api.anthropic.com/v1/messages") {
          native++;
          const events = [
            {
              type: "message_start",
              message: { id: "msg_history", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 1, output_tokens: 0 } },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ];
          return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: {
              "content-type": "text/event-stream",
              "request-id": "req_history",
              "anthropic-ratelimit-unified-5h-utilization": "0.07",
              "anthropic-ratelimit-unified-5h-status": "allowed",
              "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 18_000),
            },
          });
        }
        if (/\/v1\/(?:responses|chat\/completions)/.test(url)) throw new Error("paid dispatch must not run");
        return Response.json({ error: { message: "No optional fixture capacity" } }, { status: 503 });
      },
      async () => {
        const response = await harness.handleResponses(
          harness.responsesRequest({ model, input: "fixture", stream: true, store: false, max_output_tokens: 32 }),
          principal
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "claude_code");
        assert.match(await response.text(), /response\.completed/);
        assert.equal(native, 1);
      }
    );
    // The shared handler harness intentionally exposes prefix-only lists. Inspect
    // the actual written keys here; the native restart test exercises real range reads.
    const historyEntries = () =>
      [...harness.kvStore].filter(([encoded]) => {
        const key = JSON.parse(encoded) as unknown[];
        return CLAUDE_CAPACITY_HISTORY_PREFIX.every((part, index) => key[index] === part);
      });
    const before = structuredClone(historyEntries());
    assert.equal(before.length, 1, "module-init recorder writes before first admin request");
    const bucket = before[0]?.[1] as { points: unknown[] };
    const point = readClaudeCapacityHistoryPoint(bucket.points[0]);
    assert(point);
    assert.notEqual(point.source_observed_at_ms, null);
    for (let n = 0; n < 2; n++)
      await handleProviderCapacity(new Request("http://localhost/admin/providers/capacity"), {
        kv: store,
        fetcher: () => Promise.reject(new Error("fixture only")),
      });
    assert.deepEqual(historyEntries(), before, "admin reads cannot synthesize a new Claude measurement");
  } finally {
    harness.cleanupHarness();
    harness.kvStore.clear();
    for (const [key, value] of baseline) harness.kvStore.set(key, value);
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    resetClaudeCodeCredentialCacheForTest();
    resetProviderSelectionCacheForTest();
  }
});

test("Claude sampling retains bounded state/reset/new-window transitions and dedupes concurrent notifications", async () => {
  const kv = new AnalyticsKv();
  const store = kv as unknown as Kv;
  await Promise.all([
    recordClaudeCapacityObservation(store, observedEvent()),
    recordClaudeCapacityObservation(store, observedEvent(0, { observation_id: "same-upstream-notification-retried" })),
  ]);
  await recordClaudeCapacityObservation(store, observedEvent(1));
  await recordClaudeCapacityObservation(store, observedEvent(2, { state: "unavailable", response_status: 429 }));
  await recordClaudeCapacityObservation(store, observedEvent(3));
  const changed = observedEvent(4);
  await recordClaudeCapacityObservation(store, {
    ...changed,
    observation: {
      ...changed.observation,
      windows: { "5h": { status: "allowed", utilization: 0, reset_at_ms: NOW_MS + 36_000_000, observed_at_ms: NOW_MS + 4 } },
    },
  });
  const weekly = observedEvent(5);
  await recordClaudeCapacityObservation(store, {
    ...weekly,
    observation: {
      ...weekly.observation,
      windows: { "7d": { status: "allowed", utilization: 0.2, reset_at_ms: NOW_MS + 604_800_000, observed_at_ms: NOW_MS + 5 } },
    },
  });
  for (let n = 6; n < 20; n++) await recordClaudeCapacityObservation(store, observedEvent(n));
  const view = await readClaudeCapacityHistory(store, NOW_MS + 100);
  assert.equal(view.points.length, 6);
  assert.equal(view.points.filter((point) => point.state === "unavailable").length, 1);
  assert.equal(
    view.points.filter((point) => point.windows.seven_day !== null).length,
    1,
    "first late-arriving window is retained without copying prior windows"
  );
  const rollups = await listClaudeCapacityRollups(store, NOW_MS - 3_600_000, NOW_MS + 100);
  assert.equal(rollups.points.length, 3, "two 5h reset anchors and the newly observed weekly window stay separate");
  assert.equal(
    rollups.points.reduce((sum, point) => sum + point.samples, 0),
    6
  );
});
