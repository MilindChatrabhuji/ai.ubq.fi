import type { Kv, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createFetchMock } from "./helpers/fetch-mock.ts";
import { setKvForTest } from "../src/kv.ts";
import {
  clearClaudeCodeStoredCredential,
  resetClaudeCodeCredentialCacheForTest,
  storeClaudeCodeStoredCredential,
  storeClaudeCodeWorkspaceState,
} from "../src/provider/claude-code-credentials.ts";
import {
  claudeCodeReasoningLevels,
  discoverClaudeCodeModels,
  fetchClaudeCodeModels,
  resetClaudeCodeModelsCacheForTest,
} from "../src/provider/claude-code-models.ts";
import { resolveClaudeCodeAccount, updateClaudeCodeAccount } from "../src/provider/claude-code-accounts.ts";
import { buildClaudeCodeRequest } from "../src/provider/claude-code.ts";
import { claudeCodeCodexModels } from "../src/catalog/models.ts";
import { buildModelCatalogSnapshot, handleModelCapabilities, handleModels } from "../src/models/catalog.ts";
import { handleAdminModelsCatalogGet, handleAdminProviderSelectionGet } from "../src/admin/codex.ts";
import { handleAdminClaudeCodeAuthSet } from "../src/admin/claude-code.ts";
import { handleCodexCatalogModels } from "../src/catalog/index.ts";
import { CODEX_CATALOG_AUTH_GENERATION_KEY } from "../src/catalog/types.ts";
import { CODEX_MODELS_WHITELIST_KV_KEY } from "../src/models/codex-models-whitelist.ts";
import { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { resetOpenRouterModelsCacheForTest } from "../src/models/openrouter-models.ts";

class CatalogKv {
  readonly values = new Map<string, unknown>();
  get<T>(key: KvKey): Promise<KvEntryMaybe<T>> {
    const value = this.values.get(JSON.stringify(key));
    return Promise.resolve({ key, value: value ?? null, versionstamp: value === undefined ? null : "00000000000000000001" } as KvEntryMaybe<T>);
  }
  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    this.values.set(JSON.stringify(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000002" });
  }
  delete(key: KvKey): Promise<void> {
    this.values.delete(JSON.stringify(key));
    return Promise.resolve();
  }
  atomic() {
    const writes: (() => void)[] = [];
    const operation = {
      check: (..._entries: unknown[]) => operation,
      set: (key: KvKey, value: unknown) => {
        writes.push(() => this.values.set(JSON.stringify(key), value));
        return operation;
      },
      delete: (key: KvKey) => {
        writes.push(() => this.values.delete(JSON.stringify(key)));
        return operation;
      },
      commit: () => {
        for (const write of writes) write();
        return Promise.resolve({ ok: true, versionstamp: "00000000000000000003" });
      },
    };
    return operation;
  }
}
const originalFetch = globalThis.fetch;
const credential = { kind: "oauth" as const, secret: "sk-ant-oat-test-catalog" };
const record = (id: string) => ({ id, type: "model", display_name: `Observed ${id}`, created_at: "2026-10-01T00:00:00Z" });
const page = (ids: string[]) => Response.json({ data: ids.map(record), has_more: false, last_id: ids.at(-1) ?? null });
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};
const kvFixture = () => new CatalogKv() as unknown as Kv;

beforeEach(() => {
  resetClaudeCodeModelsCacheForTest();
  resetClaudeCodeCredentialCacheForTest();
  resetProviderSelectionCacheForTest();
  resetOpenRouterModelsCacheForTest();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setKvForTest(null);
});

test("Claude discovery follows every cursor and preserves only observed model metadata", async () => {
  const calls: URL[] = [];
  const snapshot = await discoverClaudeCodeModels(credential, "wrkspc_catalog", {
    fetcher(input, init) {
      const url = new URL(requestUrl(input));
      calls.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${credential.secret}`);
      assert.equal(headers.get("anthropic-workspace-id"), "wrkspc_catalog");
      assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
      return Promise.resolve(
        calls.length === 1
          ? Response.json({ data: [{ ...record("claude-observed-a"), max_input_tokens: 123456 }], has_more: true, last_id: "cursor-a" })
          : page(["claude-observed-b"])
      );
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.searchParams.get("limit"), "100");
  assert.equal(calls[1]?.searchParams.get("after_id"), "cursor-a");
  assert.deepEqual(
    snapshot.models.map((model) => model.id),
    ["claude-observed-a", "claude-observed-b"]
  );
  assert.equal(snapshot.models[0]?.context_window_tokens, 123456);
  assert.equal(snapshot.models[1]?.context_window_tokens, undefined);
});

test("observed reasoning, context and output capabilities are preserved without model-name tier guesses", async () => {
  const source = {
    ...record("claude-capability-fixture"),
    max_input_tokens: 123456,
    max_tokens: 8192,
    capabilities: {
      effort: { supported: true, low: { supported: true }, high: { supported: false }, future_native: { supported: true }, none: { supported: true } },
      thinking: { types: { adaptive: { supported: true }, disabled: { supported: false } } },
      image_input: { supported: true },
      pdf_input: { supported: false },
    },
  };
  const snapshot = await discoverClaudeCodeModels(credential, null, { fetcher: () => Promise.resolve(Response.json({ data: [source], has_more: false })) });
  const model = snapshot.models[0];
  assert(model);
  assert.deepEqual(claudeCodeReasoningLevels(model), ["low", "future_native"]);
  assert.equal(model.max_output_tokens, 8192);
  assert.equal(model.supports_image_input, true);
  assert.equal(model.supports_pdf_input, false);
  const native = claudeCodeCodexModels([model])[0];
  assert.equal(Object.hasOwn(native, "default_reasoning_level"), false);
  assert.deepEqual(native.supported_reasoning_levels, [
    { effort: "low", description: "low" },
    { effort: "future_native", description: "future_native" },
  ]);
  const body = { model: model.id, input: "fixture", reasoning: { effort: "future_native" }, max_output_tokens: 321 };
  assert.equal(buildClaudeCodeRequest(body), null, "direct native effort needs exact current model proof");
  const built = buildClaudeCodeRequest(body, { nativeReasoningEfforts: model.supported_reasoning_levels });
  assert.deepEqual(built?.body.output_config, { effort: "future_native" });
  assert.equal(built.body.max_tokens, 321, "explicit output controls are never trimmed");
  assert.equal(buildClaudeCodeRequest({ ...body, reasoning: { effort: "high" } }, { nativeReasoningEfforts: model.supported_reasoning_levels }), null);
});

test("effort and adaptive capability flags are independent and false/unknown cannot create presets", async () => {
  for (const capabilities of [
    undefined,
    { effort: { supported: true, high: { supported: true } } },
    { thinking: { types: { adaptive: { supported: true } } } },
  ]) {
    const snapshot = await discoverClaudeCodeModels(credential, null, {
      fetcher: () => Promise.resolve(Response.json({ data: [{ ...record("claude-capability-unknown"), capabilities }], has_more: false })),
    });
    const model = snapshot.models[0];
    assert(model);
    assert.deepEqual(claudeCodeReasoningLevels(model), []);
  }
});

test("concurrent account model discovery stays bound to each exact credential/workspace cohort", async () => {
  const kv = kvFixture();
  await storeClaudeCodeStoredCredential(kv, { secret: credential.secret });
  const first = await resolveClaudeCodeAccount(kv);
  assert(first);
  const second = await updateClaudeCodeAccount(kv, { createNew: true, credential: { ...first.credential, secret: "sk-ant-oat-fixture-other-models" } });
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstRead = fetchClaudeCodeModels({
    kv,
    accountBinding: first,
    fetcher: async () => {
      await pending;
      return page(["claude-first-account"]);
    },
  });
  const secondRead = await fetchClaudeCodeModels({ kv, accountBinding: second, fetcher: () => Promise.resolve(page(["claude-second-account"])) });
  release?.();
  assert.equal((await firstRead)?.models[0]?.id, "claude-first-account");
  assert.equal(secondRead?.models[0]?.id, "claude-second-account");
  const rotated = await updateClaudeCodeAccount(kv, {
    accountId: second.account_id,
    credential: { ...second.credential, secret: "sk-ant-oat-fixture-replacement-models" },
  });
  assert.notEqual(rotated.account_cohort_id, second.account_cohort_id);
  assert.equal(await fetchClaudeCodeModels({ kv, accountBinding: second, fetcher: () => Promise.reject(new Error("must not call")) }), null);
  assert.equal(
    (await fetchClaudeCodeModels({ kv, accountBinding: first, fetcher: () => Promise.reject(new Error("cached first account")) }))?.models[0]?.id,
    "claude-first-account"
  );
});

test("Claude discovery refuses malformed, incomplete, looping and failed pages", async () => {
  for (const payload of [{}, { data: [] }, { data: [], has_more: true }, { data: [], has_more: true, last_id: "repeated" }]) {
    await assert.rejects(() => discoverClaudeCodeModels(credential, null, { fetcher: () => Promise.resolve(Response.json(payload)) }));
  }
  await assert.rejects(() => discoverClaudeCodeModels(credential, null, { fetcher: () => Promise.resolve(new Response(null, { status: 403 })) }));
});

test("Claude cached discovery expires, marks failed refresh stale, and isolates credential/workspace rotation", async () => {
  const kv = kvFixture();
  await storeClaudeCodeStoredCredential(kv, { secret: credential.secret });
  let calls = 0;
  let now = 1000;
  const fetcher = () => {
    calls++;
    return Promise.resolve(page(["claude-original"]));
  };
  const options = { kv, fetcher, now: () => now };
  assert.equal((await fetchClaudeCodeModels(options))?.models.length, 1);
  await fetchClaudeCodeModels(options);
  assert.equal(calls, 1);
  now += 10 * 60_000;
  const stale = await fetchClaudeCodeModels({ ...options, fetcher: () => Promise.reject(new Error("offline")) });
  assert.equal(stale?.stale, true);
  assert.equal(stale.models[0]?.id, "claude-original");
  await storeClaudeCodeWorkspaceState(kv, { id: "wrkspc_new", name: null, source: "kv", discovered_at_ms: null, verified_at_ms: null, last_error: null });
  assert.equal(await fetchClaudeCodeModels({ ...options, fetcher: () => Promise.reject(new Error("offline")) }), null);
  await storeClaudeCodeStoredCredential(kv, { secret: "sk-ant-api-replacement" });
  assert.equal((await fetchClaudeCodeModels(options))?.models[0]?.id, "claude-original");
  assert.equal(calls, 2);
  await clearClaudeCodeStoredCredential(kv);
  assert.equal(await fetchClaudeCodeModels({ ...options, env: () => null }), null);
});

test("Successful admin credential validation seeds the full discovered catalog without a second fetch", async () => {
  const kv = kvFixture();
  setKvForTest(kv);
  let calls = 0;
  globalThis.fetch = createFetchMock(() => {
    calls++;
    return Promise.resolve(page(["claude-upload-observed"]));
  });
  const response = await handleAdminClaudeCodeAuthSet(
    new Request("https://gateway.test/admin/providers/claude-code/auth", {
      method: "POST",
      body: JSON.stringify({ credential: credential.secret }),
    })
  );
  assert.equal(response.status, 200);
  assert.equal((await fetchClaudeCodeModels({ kv }))?.models[0]?.id, "claude-upload-observed");
  assert.equal(calls, 1);
});

test("Claude late discovery cannot publish or return an earlier credential generation", async () => {
  const kv = kvFixture();
  await storeClaudeCodeStoredCredential(kv, { secret: credential.secret });
  let release: (response: Response) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = fetchClaudeCodeModels({
    kv,
    fetcher: () => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
  });
  await ready;
  await storeClaudeCodeStoredCredential(kv, { secret: "sk-ant-api-new-generation" });
  const replacement = await fetchClaudeCodeModels({ kv, fetcher: () => Promise.resolve(page(["claude-current"])) });
  release(page(["claude-retired"]));
  assert.equal(await pending, null);
  assert.equal(replacement?.models[0]?.id, "claude-current");
  assert.equal((await fetchClaudeCodeModels({ kv }))?.models[0]?.id, "claude-current");
});

test("Observed Claude IDs feed admin counts, whitelist and both client model contracts", async () => {
  const kv = kvFixture();
  setKvForTest(kv);
  await storeClaudeCodeStoredCredential(kv, { secret: credential.secret });
  await kv.set(PROVIDER_SELECTION_KV_KEY, { provider_ids: ["claude_code"], updated_at_ms: 1 });
  await kv.set(CODEX_CATALOG_AUTH_GENERATION_KEY, "catalog-test-generation");
  globalThis.fetch = createFetchMock((input) =>
    Promise.resolve(
      requestUrl(input).startsWith("https://api.anthropic.com/v1/models")
        ? page(["claude-discovered-a", "claude-discovered-b"])
        : new Response(null, { status: 503 })
    )
  );
  const catalog = await buildModelCatalogSnapshot();
  assert.equal(catalog.sources.claude_code.count, 2);
  assert.equal(catalog.sources.claude_code.status, "available");
  const admin = await handleAdminModelsCatalogGet();
  const adminBody = (await admin.json()) as { data: { models: { id: string }[] } };
  assert.ok(adminBody.data.models.some((model) => model.id === "claude-discovered-a"));
  const providers = (await (await handleAdminProviderSelectionGet()).json()) as { data: { providers: { id: string; model_count: number }[] } };
  assert.equal(providers.data.providers.find((provider) => provider.id === "claude_code")?.model_count, 2);
  await kv.set(CODEX_MODELS_WHITELIST_KV_KEY, { model_ids: ["claude-discovered-b"], updated_at_ms: 1 });
  const standard = (await (await handleModels()).json()) as { object: string; data: Record<string, unknown>[] };
  assert.equal(standard.object, "list");
  assert.deepEqual(
    standard.data.map((model) => model.id),
    ["claude-discovered-b"]
  );
  assert.deepEqual(
    Object.keys(standard.data[0] ?? {}).sort((left, right) => left.localeCompare(right)),
    ["created", "id", "object", "owned_by"]
  );
  const native = await handleCodexCatalogModels(new Request("https://gateway.test/v1/models?client_version=0.130.0"), "0.130.0");
  assert.equal(native.status, 200);
  const nativeBody = (await native.json()) as { models: Record<string, unknown>[] };
  assert.deepEqual(
    nativeBody.models.map((model) => model.slug),
    ["claude-discovered-b"]
  );
  assert.equal(nativeBody.models[0]?.context_window, undefined);
  const capabilities = (await (await handleModelCapabilities()).json()) as { data: Record<string, unknown>[] };
  assert.equal(capabilities.data[0]?.context_source, "unknown");
  globalThis.fetch = createFetchMock(() => Promise.resolve(new Response(null, { status: 503 })));
  await fetchClaudeCodeModels({ force: true });
  const stale = await buildModelCatalogSnapshot();
  assert.equal(stale.sources.claude_code.status, "unavailable");
  assert.equal(stale.sources.claude_code.stale, true);
  assert.equal(stale.sources.claude_code.count, 2);
});
