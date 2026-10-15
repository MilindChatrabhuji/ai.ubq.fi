import type { Kv } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  cleanupHarness,
  DEFAULT_TEST_MODEL,
  DEFAULT_REASONING_EFFORT_KEY,
  fetchMeteredModels,
  handleChatCompletions,
  handleResponses,
  installHarness,
  keyToString,
  kvStore,
  kvStub,
  resetMeteredModelsCacheForTest,
  resetSurplusModelsCacheForTest,
  responsesRequest,
  TEST_CODEX_MODELS_KEY,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";
import { getCodexModelMetadata, validateCodexModelAvailable } from "../src/request-policy.ts";
import {
  clearClaudeCodeStoredCredential,
  resetClaudeCodeCredentialCacheForTest,
  resolveClaudeCodeCredential,
  storeClaudeCodeStoredCredential,
  storeClaudeCodeWorkspaceState,
} from "../src/provider/claude-code-credentials.ts";
import { discoverClaudeCodeModels, fetchClaudeCodeModels, resetClaudeCodeModelsCacheForTest } from "../src/provider/claude-code-models.ts";
import { fetchClaudeCodeResponses } from "../src/provider/claude-code.ts";
import { claudeCodeCodexModels } from "../src/catalog/models.ts";
import { handleModelCapabilities } from "../src/models/catalog.ts";
import { observeClaudeCodeQuota, recordClaudeCodeQuotaOutcome } from "../src/provider/claude-code-quota.ts";
import { resolveClaudeCodeAccount } from "../src/provider/claude-code-accounts.ts";
import { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { CODEX_MODELS_WHITELIST_KV_KEY } from "../src/models/codex-models-whitelist.ts";

type JsonRecord = Record<string, unknown>;
type Calls = { discovery: number; native: { body: JsonRecord; headers: Headers }[]; other: string[] };
type Catalog = { ids: string[]; disabled?: unknown; response?: () => Response | Promise<Response> };
const model = "claude-haiku-5-5";
const secret = "sk-ant-oat-fixture-request-metadata";
const owner = { keyId: "metadata-owner", kernelRepo: null, kernelOrg: null } as const;
const kv = kvStub as unknown as Kv;
const baseline = new Map(kvStore);
const environmentNames = [
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_WORKSPACE_ID",
  "CLAUDE_CODE_ALLOWED_KEY_IDS",
  "METERED_API_KEY",
  "SURPLUS_API_KEY",
];
let environment = new Map<string, string | undefined>();

const page = (ids: readonly string[], disabled?: unknown): Response =>
  Response.json({
    data: ids.map((id) => ({ id, ...(disabled === undefined ? {} : { capabilities: { thinking: { types: { disabled: { supported: disabled } } } } }) })),
    has_more: false,
    last_id: ids.at(-1) ?? null,
  });
const success = (id: string): Response => {
  const events = [
    {
      type: "message_start",
      message: { id: "msg_metadata", type: "message", role: "assistant", model: id, content: [], usage: { input_tokens: 2, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "request-id": "req_metadata" },
  });
};

const withCatalog = async <T>(run: (calls: Calls) => Promise<T>, catalog: Catalog = { ids: [model], disabled: true }): Promise<T> => {
  const calls: Calls = { discovery: 0, native: [], other: [] };
  return await withFetchMock(
    (url, body, init) => {
      if (url.startsWith("https://api.anthropic.com/v1/models")) {
        calls.discovery++;
        return catalog.response ? catalog.response() : page(catalog.ids, catalog.disabled);
      }
      if (url === "https://api.anthropic.com/v1/messages") {
        const parsed = JSON.parse(body ?? "{}") as JsonRecord;
        calls.native.push({ body: parsed, headers: new Headers(init?.headers) });
        return success(String(parsed.model));
      }
      calls.other.push(url);
      return Response.json({ error: { message: "Unexpected fixture transport" } }, { status: 500 });
    },
    () => run(calls)
  );
};

const seedPaidChatModel = async (ids: readonly string[] = [model]): Promise<void> => {
  await fetchMeteredModels({
    force: true,
    fetcher: () => Promise.resolve(Response.json({ data: ids.map((id) => ({ id, supported_endpoint_types: ["openai"] })) })),
  });
};
const resolveAvailability = async (id = model): Promise<Response | null> =>
  validateCodexModelAvailable(id, "responses", await getCodexModelMetadata(id, "responses"));
const assertNoInference = (calls: Calls): void => {
  assert.equal(calls.native.length, 0);
  assert.deepEqual(calls.other, []);
};
const rotateBinding = async (change: "credential" | "workspace"): Promise<unknown> => {
  if (change === "credential") return await storeClaudeCodeStoredCredential(kv, { secret: "sk-ant-oat-fixture-replacement" });
  return await storeClaudeCodeWorkspaceState(kv, {
    id: "wrkspc_replacement",
    name: null,
    source: "kv",
    discovered_at_ms: null,
    verified_at_ms: null,
    last_error: null,
  });
};

beforeEach(async () => {
  environment = new Map(environmentNames.map((name) => [name, process.env[name]]));
  for (const name of environmentNames) Reflect.deleteProperty(process.env, name);
  installHarness();
  kvStore.clear();
  for (const [key, value] of baseline) kvStore.set(key, structuredClone(value));
  // The exact-M live defaults receipt recorded none; never change the host to make this fixture pass.
  kvStore.set(keyToString(DEFAULT_REASONING_EFFORT_KEY), "none");
  resetClaudeCodeCredentialCacheForTest();
  resetClaudeCodeModelsCacheForTest();
  resetProviderSelectionCacheForTest();
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  process.env.CLAUDE_CODE_ALLOWED_KEY_IDS = owner.keyId;
  process.env.METERED_API_KEY = "fixture-metered-key";
  await storeClaudeCodeStoredCredential(kv, { secret });
  await kv.set(PROVIDER_SELECTION_KV_KEY, { provider_ids: ["claude_code", "openlux"], updated_at_ms: 1 });
  await kv.set(CODEX_MODELS_WHITELIST_KV_KEY, { model_ids: [DEFAULT_TEST_MODEL], updated_at_ms: 1 });
  await seedPaidChatModel();
});
afterEach(() => {
  cleanupHarness();
  for (const [name, value] of environment) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

test("full Responses handler serves a discovered Claude model despite same-ID chat-only paid metadata", async () => {
  const whitelist = structuredClone(kvStore.get(keyToString(CODEX_MODELS_WHITELIST_KV_KEY)));
  const codex = kvStore.get(keyToString(TEST_CODEX_MODELS_KEY)) as { models: { slug: string }[] };
  assert(codex.models.length > 0 && codex.models.every((entry) => entry.slug !== model));
  await withCatalog(async (calls) => {
    const response = await handleResponses(
      responsesRequest({ model, input: "Reply only with MAC_CLAUDE_SUBSCRIPTION_OK.", stream: true, store: false, max_output_tokens: 64 }),
      owner
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "claude_code");
    assert.match(await response.text(), /response\.completed/);
    assert.equal(calls.discovery, 1);
    assert.equal(calls.native.length, 1);
    assert.equal(calls.native[0]?.body.model, model);
    assert.deepEqual(calls.native[0]?.body.thinking, { type: "disabled" });
    assert.equal(calls.native[0]?.body.output_config, undefined);
    assert.equal(calls.native[0]?.body.max_tokens, 64);
    assert.match(JSON.stringify(calls.native[0]?.body.messages), /Reply only with MAC_CLAUDE_SUBSCRIPTION_OK\./);
    assert.equal(calls.native[0]?.headers.get("authorization"), `Bearer ${secret}`);
    assert.equal(calls.native[0]?.headers.get("x-api-key"), null);
    assert.deepEqual(calls.other, [], "neither Codex nor paid inference runs");
  });
  assert.deepEqual(kvStore.get(keyToString(CODEX_MODELS_WHITELIST_KV_KEY)), whitelist, "discovery does not change operator selection");
});

test("observed Claude-only IDs resolve with conservative metadata without a paid catalog row", async () => {
  await seedPaidChatModel([]);
  await withCatalog(async () => {
    const metadata = await getCodexModelMetadata(model, "responses");
    assert.equal(validateCodexModelAvailable(model, "responses", metadata), null);
    assert.deepEqual(metadata.supportedEndpoints, ["openai", "openai-response"]);
    assert.deepEqual(metadata.reasoning.levels, ["none"]);
    assert.equal(metadata.reasoning.defaultLevel, "none");
    assert.equal(metadata.record?.slug, model);
    assert.equal(metadata.record.context_window, undefined);
  });
});

test("a guessed Claude-prefixed ID is not authorized by discovery", async () => {
  await withCatalog(async (calls) => {
    const response = await handleResponses(responsesRequest({ model: "claude-not-discovered" }), owner);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /model_not_found/);
    assertNoInference(calls);
  });
});

test("an existing Codex record retains precedence and its exact reasoning metadata", async () => {
  const snapshot = kvStore.get(keyToString(TEST_CODEX_MODELS_KEY)) as { models: JsonRecord[] };
  kvStore.set(keyToString(TEST_CODEX_MODELS_KEY), {
    ...snapshot,
    models: [...snapshot.models, { slug: model, supported_reasoning_levels: ["max"], default_reasoning_level: "max" }],
  });
  await withCatalog(async (calls) => {
    const metadata = await getCodexModelMetadata(model, "responses");
    assert.equal(metadata.supportedEndpoints, null);
    assert.deepEqual(metadata.reasoning.levels, ["max"]);
    assert.equal(calls.discovery, 0);
  });
});

test("unrelated non-Codex paid metadata does not invoke Claude discovery", async () => {
  const ids = ["deepseek-fixture", "unrelated-paid-fixture"];
  await seedPaidChatModel(ids);
  await withCatalog(async (calls) => {
    for (const id of ids) {
      for (const route of ["chat.completions", "responses"] as const) {
        const metadata = await getCodexModelMetadata(id, route);
        assert.equal(metadata.record?.slug, id);
        assert.deepEqual(metadata.supportedEndpoints, ["openai"]);
        assert.deepEqual(metadata.reasoning.levels, ["none"]);
        assert.equal(validateCodexModelAvailable(id, route, metadata)?.status ?? 200, route === "responses" ? 404 : 200);
      }
    }
    assert.equal(calls.discovery, 0);
    assertNoInference(calls);
  });
});

test("a disabled Claude provider cannot add Responses support to a chat-only paid row", async () => {
  await kv.set(PROVIDER_SELECTION_KV_KEY, { provider_ids: ["openlux"], updated_at_ms: 2 });
  resetProviderSelectionCacheForTest();
  await withCatalog(async (calls) => {
    assert.equal((await resolveAvailability())?.status, 404);
    assert.equal(calls.discovery, 0);
    assertNoInference(calls);
  });
});

test("a missing credential cannot add Responses support or cause discovery", async () => {
  await clearClaudeCodeStoredCredential(kv);
  await withCatalog(async (calls) => {
    assert.equal((await resolveAvailability())?.status, 404);
    assert.equal(calls.discovery, 0);
    assertNoInference(calls);
  });
});

test("failed discovery does not fabricate support for a Claude-prefixed paid row", async () => {
  await withCatalog(
    async (calls) => {
      assert.equal((await resolveAvailability())?.status, 404);
      assert.equal(calls.discovery, 1);
      assertNoInference(calls);
    },
    { ids: [], response: () => new Response(null, { status: 503 }) }
  );
});

test("discovered support does not bypass the principal allowlist", async () => {
  await withCatalog(async (calls) => {
    assert.equal(await resolveAvailability(), null);
    const response = await handleResponses(responsesRequest({ model, reasoning: { effort: "none" } }), { ...owner, keyId: "not-allowed" });
    assert(response.status >= 400);
    await response.text();
    assert.equal(calls.discovery, 1);
    assertNoInference(calls);
  });
});

test("discovered support does not bypass a durable quota block", async () => {
  const account = await resolveClaudeCodeAccount(kv);
  assert(account);
  const reset = Date.now() + 60_000;
  await recordClaudeCodeQuotaOutcome(kv, {
    binding: account,
    model_id: model,
    response_status: 429,
    observation: observeClaudeCodeQuota(
      new Headers({ "anthropic-ratelimit-unified-5h-status": "limited", "anthropic-ratelimit-unified-5h-reset": String(Math.floor(reset / 1000)) })
    ),
    exhaustion: { window: "5h", reset_at_ms: reset },
  });
  await withCatalog(async (calls) => {
    assert.equal(await resolveAvailability(), null);
    const response = await handleResponses(responsesRequest({ model, reasoning: { effort: "none" } }), owner);
    assert(response.status >= 400);
    await response.text();
    assertNoInference(calls);
  });
});

test("explicit none uses the same independently observed disabled-thinking proof", async () => {
  await withCatalog(async (calls) => {
    const response = await handleResponses(responsesRequest({ model, reasoning: { effort: "none" } }), owner);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);
    assert.equal(calls.native.length, 1);
    assert.deepEqual(calls.native[0]?.body.thinking, { type: "disabled" });
    assert.equal(calls.native[0]?.body.output_config, undefined);
    assert.deepEqual(calls.other, []);
  });
});

for (const change of ["credential", "workspace"] as const) {
  test(`request metadata cannot reuse IDs after ${change} rotation`, async () => {
    const catalog: Catalog = { ids: [model] };
    await withCatalog(async (calls) => {
      assert.equal(await resolveAvailability(), null);
      await rotateBinding(change);
      catalog.ids = ["claude-new-generation"];
      assert.equal((await resolveAvailability())?.status, 404);
      assert.equal(calls.discovery, 2);
      assertNoInference(calls);
    }, catalog);
  });
}

for (const proof of [false, undefined, "true"]) {
  test(`disabled support ${String(proof)} neither advertises none nor permits its native dispatch`, async () => {
    await kv.set(CODEX_MODELS_WHITELIST_KV_KEY, { model_ids: [], updated_at_ms: 2 });
    await withCatalog(
      async (calls) => {
        const metadata = await getCodexModelMetadata(model, "responses");
        assert.deepEqual(metadata.reasoning.levels, []);
        assert.equal(metadata.reasoning.defaultLevel, null);
        const models = await fetchClaudeCodeModels({ kv });
        const native = claudeCodeCodexModels(models?.models ?? [])[0];
        assert.deepEqual(native.supported_reasoning_levels, []);
        assert.equal(Object.hasOwn(native, "default_reasoning_level"), false);
        const capabilities = (await (await handleModelCapabilities()).json()) as { data: JsonRecord[] };
        const row = capabilities.data.find((candidate) => candidate.id === model);
        assert.deepEqual(row?.supported_reasoning_levels, []);
        assert.equal(Object.hasOwn(row, "default_reasoning_effort"), false);
        const response = await handleResponses(responsesRequest({ model }), owner);
        assert(response.status >= 400);
        await response.text();
        assertNoInference(calls);
      },
      { ids: [model], disabled: proof }
    );
  });
}

test("discovery retains independent disabled booleans, never truthy values or adaptive-effort inference", async () => {
  const records = [true, false, undefined, "true"].map((supported, index) => ({
    id: `claude-observed-capability-${index}`,
    capabilities: { effort: { supported: false }, thinking: { types: { disabled: { supported } } } },
  }));
  const discovered = await discoverClaudeCodeModels({ kind: "oauth", secret }, null, {
    fetcher: () => Promise.resolve(Response.json({ data: records, has_more: false })),
  });
  assert.deepEqual(
    discovered.models.map((entry) => entry.supports_disabled_thinking),
    [true, false, undefined, undefined]
  );
  assert.deepEqual(claudeCodeCodexModels(discovered.models)[0]?.supported_reasoning_levels, [{ effort: "none", description: "No reasoning" }]);
});

test("a failed discovery refresh keeps stale IDs but withdraws disabled-thinking permission", async () => {
  const catalog: Catalog = { ids: [model], disabled: true };
  await withCatalog(async (calls) => {
    assert.equal((await fetchClaudeCodeModels({ kv }))?.models[0]?.supports_disabled_thinking, true);
    catalog.response = () => new Response(null, { status: 503 });
    const stale = await fetchClaudeCodeModels({ kv, force: true });
    assert.equal(stale?.stale, true);
    assert.equal(stale.models[0]?.id, model);
    assert.equal(stale.models[0]?.supports_disabled_thinking, undefined);
    const response = await handleResponses(responsesRequest({ model }), owner);
    assert(response.status >= 400);
    await response.text();
    assertNoInference(calls);
  }, catalog);
});

for (const change of ["credential", "workspace"] as const) {
  test(`disabled proof cannot cross a mismatched expected ${change} binding`, async () => {
    await withCatalog(async (calls) => {
      const expectedBinding = { credential: { kind: "oauth" as const, secret }, workspaceId: null };
      assert.equal((await fetchClaudeCodeModels({ kv, expectedBinding }))?.models[0]?.supports_disabled_thinking, true);
      await rotateBinding(change);
      assert.equal(await fetchClaudeCodeModels({ kv, expectedBinding }), null);
      assert.equal(calls.discovery, 1, "a retired binding cannot query or borrow the current identity");
      assertNoInference(calls);
    });
  });
  test(`a ${change} rotation during admission cancels before native transport`, async () => {
    await withCatalog(async (calls) => {
      const counts = { claimed: 0, started: 0, cancelled: 0 };
      const response = await handleResponses(responsesRequest({ model }), {
        ...owner,
        beforeProviderDispatch: async () => {
          counts.claimed++;
          await rotateBinding(change);
          return {
            markTransportStarted: () => {
              counts.started++;
            },
            cancelBeforeTransport: () => {
              counts.cancelled++;
              return Promise.resolve();
            },
          };
        },
      });
      assert(response.status >= 400);
      await response.text();
      assert.deepEqual(counts, { claimed: 1, started: 0, cancelled: 1 });
      assertNoInference(calls);
    });
  });
}

test("disabled thinking preserves the first workspace-required response without a new-binding retry", async () => {
  const credential = await resolveClaudeCodeCredential(kv);
  assert.ok(credential);
  const urls: string[] = [];
  const result = await fetchClaudeCodeResponses(
    { model, input: "ping", reasoning: { effort: "none" } },
    {
      kv,
      credential,
      workspace: null,
      supportsNativeDisabledThinking: true,
      fetcher: (input) => {
        if (typeof input === "string") urls.push(input);
        else if (input instanceof URL) urls.push(input.href);
        else urls.push(input.url);
        return Promise.resolve(
          Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.",
              },
            },
            { status: 400, headers: { "request-id": "first-workspace-failure" } }
          )
        );
      },
    }
  );
  assert.equal(result.response.status, 400);
  assert.equal(result.request_id, "first-workspace-failure");
  assert.equal(result.classification.kind, "workspace_required");
  assert.equal(result.classification.exhaustion, null);
  assert.equal(result.workspace, null);
  assert.deepEqual(urls, ["https://api.anthropic.com/v1/messages"]);
  await result.response.text();
});

test("late discovery from a retired credential cannot authorize request metadata", async () => {
  const started = Promise.withResolvers<undefined>();
  const delayed = Promise.withResolvers<Response>();
  const catalog: Catalog = {
    ids: [],
    response: () => {
      started.resolve(undefined);
      return delayed.promise;
    },
  };
  await withCatalog(async (calls) => {
    const pending = resolveAvailability();
    await started.promise;
    await storeClaudeCodeStoredCredential(kv, { secret: "sk-ant-oat-fixture-latest" });
    delayed.resolve(page([model]));
    assert.equal((await pending)?.status, 404);
    assertNoInference(calls);
  }, catalog);
});

test("shared Chat metadata and full handler retain the native Claude route", async () => {
  await withCatalog(async (calls) => {
    const request = new Request("https://ai.ubq.fi/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], stream: false, max_tokens: 16 }),
    });
    const response = await handleChatCompletions(request, owner);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "claude_code");
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0]?.message.content, "OK");
    assert.equal(calls.native.length, 1);
    assert.equal(calls.native[0]?.body.model, model);
    assert.deepEqual(calls.native[0]?.body.thinking, { type: "disabled" });
    assert.equal(calls.native[0]?.body.output_config, undefined);
    assert.deepEqual(calls.other, []);
  });
});
