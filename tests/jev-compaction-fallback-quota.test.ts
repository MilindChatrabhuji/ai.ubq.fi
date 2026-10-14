import assert from "node:assert/strict";

import type { JevAsker, JevQuestions, JevResponse } from "../lib/jev_compaction/types.ts";
import {
  type ApiKeyPolicy,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  resetApiKeyPolicyCacheForTest,
} from "../src/api-key-policy.ts";
import { PAID_FALLBACK_NO_LIMIT } from "../src/api-keys.ts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "../src/deepseek/index.ts";
import { DEEPSEEK_WATERFALL_MODEL_ID } from "../src/deepseek/waterfall.ts";
import { setInferenceAdmissionControllerForTest } from "../src/handler/admission.ts";
import handler from "../src/handler/index.ts";
import { createServeHandler } from "../src/handler/serve-handler.ts";
import { createInferenceAdmissionController } from "../src/inference-admission.ts";
import { setJevCompactionAskerForTest } from "../src/jev_compaction/compaction.ts";
import { reloadKernelPublicKeys } from "../src/kernel/attestation.ts";
import { KERNEL_QUOTA_RESERVATION_LEASE_MS, kernelRepoPolicyKey } from "../src/kernel/quota-v2.ts";
import { setKvForTest } from "../src/kv.ts";
import { LITHOS_CHAT_COMPLETIONS_URL } from "../src/provider/lithos.ts";
import { resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../src/types.ts";
import { sha256Base64Url } from "../src/utils.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const METADATA = JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses" } });
const KEEP_MARKER = "retain_compaction_fallback_artifact";
const OLD_RESULT = "Obsolete tool result with its original evidence. ".repeat(100);
const ENV_KEYS = ["LITHOSAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "SURPLUS_API_KEY", "METERED_API_KEY"] as const;
const KERNEL_OWNER = "compaction-owner";
const KERNEL_REPO = "compaction-repo";
const loopbackPermission = await Deno.permissions.query({ name: "net", host: "127.0.0.1" });

const TEXT_ENCODER = new TextEncoder();

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const encodeBase64Url = (bytes: Uint8Array): string =>
  encodeBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/={1,2}$/u, "");

const encodeJsonBase64Url = (value: unknown): string => encodeBase64Url(TEXT_ENCODER.encode(JSON.stringify(value)));

const toPublicKeyPem = (spki: Uint8Array): string => {
  const lines = encodeBase64(spki).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
};

const installKernelPublicKey = async (kv: CountingKv, token: string): Promise<string> => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([0x01, 0x00, 0x01]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  kv.seed(["uos_ai", "kernel_pubkeys"], [{ pem: toPublicKeyPem(spki) }]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = encodeJsonBase64Url({ alg: "RS256", typ: "JWT" });
  const payload = encodeJsonBase64Url({
    iss: "ubiquity-os-kernel",
    aud: "ai.ubq.fi",
    iat: nowSeconds,
    exp: nowSeconds + 600,
    jti: `jti_${crypto.randomUUID()}`,
    owner: KERNEL_OWNER,
    repo: KERNEL_REPO,
    installation_id: null,
    auth_token_sha256: await sha256Base64Url(token),
    state_id: `state_${crypto.randomUUID()}`,
  });
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, TEXT_ENCODER.encode(signingInput)));
  return `${signingInput}.${encodeBase64Url(signature)}`;
};

const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });

/** Old calls are outside the pinned recent messages, so the injected asker is actually exercised. */
const input = (): unknown[] => [
  message("user", `Keep ${KEEP_MARKER} verbatim while completing the release.`),
  message("assistant", "Inspecting old evidence."),
  { type: "function_call", call_id: "old_a", name: "shell", arguments: '{"command":"read old evidence"}' },
  { type: "function_call_output", call_id: "old_a", output: OLD_RESULT },
  { type: "function_call", call_id: "old_b", name: "shell", arguments: '{"command":"read more old evidence"}' },
  { type: "function_call_output", call_id: "old_b", output: OLD_RESULT },
  message("assistant", "The old investigation is finished."),
  message("user", "First recent follow-up: draft the release outline."),
  message("assistant", "Drafted."),
  message("user", "Second recent follow-up: check the artifact."),
  message("assistant", "Checked."),
  message("user", `Final goal: retain ${KEEP_MARKER}.`),
  message("user", "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary."),
];

const requestBody = (): Record<string, unknown> => ({
  model: DEEPSEEK_WATERFALL_MODEL_ID,
  input: input(),
  stream: true,
  reasoning: { effort: "low" },
  max_output_tokens: 128,
});

const chatChunk = (content: string | null, finishReason: string | null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-compaction-fallback",
    object: "chat.completion.chunk",
    created: 1_780_000_001,
    model: "deepseek-flash",
    choices: [{ index: 0, delta: content === null ? {} : { role: "assistant", content }, finish_reason: finishReason }],
    ...(finishReason ? { usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } } : {}),
  })}\n\n`;

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = performance.now() + 3_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const armKernelLeaseExpiry = (): Readonly<{ expire: () => void; restore: () => void }> => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let expired = false;
  let leaseExpiry: (() => void) | null = null;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  Date.now = () => originalNow() + (expired ? KERNEL_QUOTA_RESERVATION_LEASE_MS + 1 : 0);
  globalThis.setTimeout = ((handler: () => void, timeout?: number): ReturnType<typeof setTimeout> => {
    if (timeout !== undefined && timeout >= KERNEL_QUOTA_RESERVATION_LEASE_MS - 1_000) {
      leaseExpiry = handler;
      leaseTimer = originalSetTimeout(() => {}, timeout);
      return leaseTimer;
    }
    return originalSetTimeout(handler, timeout);
  }) as typeof globalThis.setTimeout;
  return {
    expire(): void {
      expired = true;
      leaseExpiry?.();
    },
    restore(): void {
      if (leaseTimer !== undefined) originalClearTimeout(leaseTimer);
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
    },
  };
};

type ProviderCall = Readonly<{ provider: string; body: Record<string, unknown> }>;
type HarnessOptions = Readonly<{ kernel?: boolean }>;

/** Real HTTP ingress, real authentication/admission/quota, memory-only KV and blocked external fetches. */
const startHarness = async (asker: JevAsker, options: HarnessOptions = {}) => {
  const kv = new CountingKv();
  const token = `u_${"a".repeat(64)}`;
  const hash = await sha256Base64Url(token);
  const now = Date.now();
  const keyId = "jev-compaction-fallback-key";
  const fields = {
    expires_at_ms: now + 60_000,
    revoked_at_ms: null,
    usage_limit_requests: 1,
    usage_requests: 0,
    usage_reset_at_ms: now + 60 * 60_000,
    window_ms: 60 * 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: PAID_FALLBACK_NO_LIMIT,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  } satisfies Omit<ApiKeyHashRecord, "id">;
  const hashRecord: ApiKeyHashRecord = { id: keyId, ...fields };
  const keyRecord: ApiKeyRecord = {
    id: keyId,
    name: "Compaction fallback regression key",
    prefix: token.slice(0, 10),
    hash,
    created_at_ms: now,
    ...fields,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: now,
  };
  kv.seed(["ubq_ai", "api_keys", "id", keyId], keyRecord);
  kv.seed(["ubq_ai", "api_keys", "hash", hash], hashRecord);
  const policy = apiKeyPolicyFromHashRecord(hash, hashRecord, now);
  assert.ok(policy, "the one-request API key must authenticate with a bounded policy");

  const savedEnv = new Map(ENV_KEYS.map((key) => [key, Deno.env.get(key)]));
  for (const key of ENV_KEYS) Deno.env.delete(key);
  Deno.env.set("LITHOSAI_API_KEY", "compaction-test-lithos-key");
  Deno.env.set("DEEPSEEK_API_KEY", "compaction-test-deepseek-key");
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 1, maxQueueWaitMs: 50 });
  setInferenceAdmissionControllerForTest(controller);
  setKvForTest(kv as unknown as Deno.Kv);
  resetApiKeyPolicyCacheForTest();
  resetProviderSelectionCacheForTest();
  if (options.kernel) {
    const policyNow = Date.now();
    kv.seed(kernelRepoPolicyKey(KERNEL_OWNER, KERNEL_REPO), {
      v: 2,
      scope: "repo",
      owner: KERNEL_OWNER,
      repo: KERNEL_REPO,
      usage_limit_requests: 1,
      window_ms: 60 * 60_000,
      expires_at_ms: -1,
      created_at_ms: policyNow,
      updated_at_ms: policyNow,
    });
  }
  setJevCompactionAskerForTest(asker);
  const kernelToken = options.kernel ? await installKernelPublicKey(kv, token) : null;
  if (kernelToken) await reloadKernelPublicKeys();

  const calls: ProviderCall[] = [];
  const terminals: Record<string, unknown>[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]): void => {
    if (args[0] === "[ai.ubq.fi] request_terminal" && typeof args[1] === "string") {
      terminals.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
    originalInfo(...args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    if (typeof target === "string") url = target;
    else if (target instanceof URL) url = target.href;
    else url = target.url;
    if (new URL(url).hostname === "127.0.0.1") return originalFetch(target, init);
    assert.ok(url === LITHOS_CHAT_COMPLETIONS_URL || url === DEEPSEEK_CHAT_COMPLETIONS_URL, `Unexpected external fetch: ${url}`);
    assert.equal(typeof init?.body, "string", "the provider must receive the translated original JSON body");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    if (url === LITHOS_CHAT_COMPLETIONS_URL) {
      calls.push({ provider: "lithos", body });
      return Promise.resolve(Response.json({ error: { message: "controlled quota refusal" } }, { status: 429 }));
    }
    calls.push({ provider: "deepseek", body });
    return Promise.resolve(
      new Response(`${chatChunk("pong", null)}${chatChunk(null, "stop")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream", "x-request-id": "compaction-deepseek" },
      })
    );
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    createServeHandler((request, delivery) => {
      // Deno's incoming URL retains the listener authority even with Host
      // overridden. Route the real HTTP body through a non-loopback origin so
      // authentication exercises the seeded key, never the development bypass.
      const routedUrl = new URL(request.url);
      routedUrl.hostname = "compaction-fixture.example.invalid";
      return handler(new Request(routedUrl, request), delivery);
    })
  );
  const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/v1/responses`;
  const post = (body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-codex-turn-metadata": METADATA,
        ...(kernelToken ? { "X-Ubiquity-Kernel-Token": kernelToken } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  return {
    kv,
    policy,
    controller,
    calls,
    terminals,
    token,
    post,
    stop: async (): Promise<void> => {
      await server.shutdown();
      globalThis.fetch = originalFetch;
      console.info = originalInfo;
      setJevCompactionAskerForTest(null);
      setInferenceAdmissionControllerForTest(null);
      setKvForTest(null);
      resetApiKeyPolicyCacheForTest();
      resetProviderSelectionCacheForTest();
      for (const [key, value] of savedEnv) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    },
  };
};

type Harness = Awaited<ReturnType<typeof startHarness>>;

const quota = async (harness: Harness, requestId: string) => {
  const window = await harness.kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(harness.policy));
  const request = await harness.kv.get<ApiKeyUsageRequestV3>(apiKeyUsageV3RequestKey(harness.policy, requestId));
  assert.ok(window.value);
  assert.ok(request.value);
  return { window: window.value, request: request.value };
};

const quotaCommits = (kv: CountingKv, policy: ApiKeyPolicy, requestId: string): number => {
  const rowKey = JSON.stringify(apiKeyUsageV3RequestKey(policy, requestId));
  return kv.commands.filter(
    (command) => command.command === "atomic.commit" && command.atomicResult === "committed" && command.keys.some((key) => JSON.stringify(key) === rowKey)
  ).length;
};

const settledTerminal = async (harness: Harness, requestId: string): Promise<Record<string, unknown>> => {
  await waitFor(() => harness.terminals.some((entry) => entry.request_id === requestId) && harness.controller.snapshot().active === 0, "terminal settlement");
  const terminals = harness.terminals.filter((entry) => entry.request_id === requestId);
  assert.equal(terminals.length, 1, "the HTTP request must have exactly one terminal record");
  assert.equal(harness.controller.snapshot().waiting, 0, "no admission waiter may remain");
  return terminals[0];
};

Deno.test({
  name: "marked compaction: failed Jev retains one quota reservation across Lithos 429 and DeepSeek success",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    let jevCalls = 0;
    const harness = await startHarness({
      ask(): Promise<JevResponse> {
        jevCalls += 1;
        return Promise.reject(new Error("controlled Jev decision outage"));
      },
    });
    try {
      const response = await harness.post(requestBody());
      const text = await response.text();
      assert.equal(jevCalls, 1, "the failure must come from the injected Jev asker");
      assert.equal(response.status, 200, `the intact fallback must complete instead of quota-dispatch 503: ${text}`);
      assert.deepEqual(
        harness.calls.map((call) => call.provider),
        ["lithos", "deepseek"]
      );
      assert.equal(response.headers.get("x-uos-attempted-providers"), "lithos,deepseek");
      assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
      assert.equal(response.headers.get("x-jev-compaction"), null, "a failed Jev answer must not replace the provider response");
      assert.equal((text.match(/event: response.completed\n/g) ?? []).length, 1);
      assert.ok(text.includes("pong"));
      assert.ok(!text.includes("api_key_quota_reservation_unavailable"));
      for (const call of harness.calls) {
        const serialized = JSON.stringify(call.body);
        assert.ok(serialized.includes(KEEP_MARKER), "the original pinned input must survive the local body read");
        assert.ok(serialized.includes(OLD_RESULT), "the fallback must receive the complete original tool output");
        assert.ok(!serialized.includes("# fast-jev-compaction memory summary"), "a failed summary must never be adopted");
        assert.equal(call.body.stream, true);
        assert.equal(call.body.max_tokens, 128);
      }
      const requestId = response.headers.get("x-uos-request-id");
      assert.ok(requestId);
      const terminal = await settledTerminal(harness, requestId);
      assert.equal(terminal.stream_terminal_type, "response.completed");
      const ledger = await quota(harness, requestId);
      assert.equal(ledger.window.committed_requests, 1, "two provider attempts must consume exactly one request");
      assert.equal(ledger.window.reserved_requests, 0, "the reservation must not leak after delivery");
      assert.equal(ledger.request.state, "dispatched");
      assert.equal(quotaCommits(harness.kv, harness.policy, requestId), 2, "one reserve plus one dispatch commit; no intermediate release or second charge");
    } finally {
      await harness.stop();
    }
  },
});

Deno.test({
  name: "marked compaction: handler caller cancellation during Jev releases quota without provider fallback",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    let jevCalls = 0;
    let rejectAsker: (reason: Error) => void = () => {};
    const decision = new Promise<JevResponse>((_resolve, reject) => {
      rejectAsker = reject;
    });
    const harness = await startHarness({
      ask(): Promise<JevResponse> {
        jevCalls += 1;
        return decision;
      },
    });
    const abort = new AbortController();
    try {
      // Deno HTTP does not signal a disconnect before response headers here.
      // Exercise the real handler's explicit caller signal at its boundary.
      const pending = handler(
        new Request("https://compaction-fixture.example.invalid/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/json", "x-codex-turn-metadata": METADATA },
          body: JSON.stringify(requestBody()),
          signal: abort.signal,
        })
      );
      await waitFor(() => jevCalls === 1, "the injected Jev decision");
      abort.abort();
      rejectAsker(new Error("controlled Jev cancellation"));
      const response = await pending;
      assert.equal(response.status, 499);
      await response.text();
      assert.equal(harness.calls.length, 0, "a cancelled Jev request must never dispatch a fallback provider");
      const requestId = response.headers.get("x-uos-request-id");
      assert.ok(requestId);
      const terminal = await settledTerminal(harness, requestId);
      assert.equal(terminal.status, 499);
      const ledger = await quota(harness, requestId);
      assert.equal(ledger.window.committed_requests, 0);
      assert.equal(ledger.window.reserved_requests, 0);
      assert.equal(ledger.request.state, "released");
      assert.equal(quotaCommits(harness.kv, harness.policy, requestId), 2);
    } finally {
      abort.abort();
      rejectAsker(new Error("settle controlled Jev cancellation"));
      await harness.stop();
    }
  },
});

Deno.test({
  name: "marked repository compaction: kernel reservation cancellation stops Jev before completion",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    let jevCalls = 0;
    let questions: JevQuestions = {};
    let resolveDecision: (response: JevResponse) => void = () => {};
    const decision = new Promise<JevResponse>((resolve) => {
      resolveDecision = resolve;
    });
    const harness = await startHarness(
      {
        ask(_state, askedQuestions: JevQuestions): Promise<JevResponse> {
          jevCalls += 1;
          questions = askedQuestions;
          return decision;
        },
      },
      { kernel: true }
    );
    const lease = armKernelLeaseExpiry();
    try {
      const pending = harness.post(requestBody());
      await waitFor(() => jevCalls === 1, "the injected Jev decision");
      lease.expire();
      resolveDecision({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.1 }])) });
      const response = await pending;
      assert.equal(response.status, 499, "an expired kernel reservation must cancel local compaction");
      await response.text();
      assert.equal(harness.calls.length, 0, "an expired kernel reservation must not dispatch a fallback provider");
      const requestId = response.headers.get("x-uos-request-id");
      assert.ok(requestId);
      const terminal = await settledTerminal(harness, requestId);
      assert.equal(terminal.status, 499);
      const ledger = await quota(harness, requestId);
      assert.equal(ledger.window.committed_requests, 0);
      assert.equal(ledger.window.reserved_requests, 0);
      assert.equal(ledger.request.state, "released");
    } finally {
      lease.restore();
      resolveDecision({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.1 }])) });
      await harness.stop();
    }
  },
});

Deno.test({
  name: "marked compaction: successful local Jev releases the request once without provider dispatch",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    let jevCalls = 0;
    const harness = await startHarness({
      ask(_state, questions: JevQuestions): Promise<JevResponse> {
        jevCalls += 1;
        return Promise.resolve({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.1 }])) });
      },
    });
    try {
      const response = await harness.post(requestBody());
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.equal(jevCalls, 1);
      assert.equal(harness.calls.length, 0);
      assert.ok(response.headers.get("x-jev-compaction"));
      assert.ok(text.includes("# fast-jev-compaction memory summary"));
      assert.equal((text.match(/event: response.completed\n/g) ?? []).length, 1);
      const requestId = response.headers.get("x-uos-request-id");
      assert.ok(requestId);
      const terminal = await settledTerminal(harness, requestId);
      assert.equal(terminal.provider, "gateway");
      assert.equal(terminal.usage_observed, false, "local compaction must not invent upstream token usage");
      const ledger = await quota(harness, requestId);
      assert.equal(ledger.window.committed_requests, 0);
      assert.equal(ledger.window.reserved_requests, 0);
      assert.equal(ledger.request.state, "released");
      assert.equal(quotaCommits(harness.kv, harness.policy, requestId), 2, "one reserve plus one release commit");
    } finally {
      await harness.stop();
    }
  },
});
