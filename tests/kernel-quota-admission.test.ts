import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import type { AtomicOperation, Kv, KvCommitError, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
import assert from "node:assert/strict";
import { apiKeyHashKey, apiKeyIdKey, PAID_FALLBACK_NO_LIMIT } from "../src/api-keys.ts";
import {
  type ApiKeyPolicy,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  resetApiKeyPolicyCacheForTest,
} from "../src/api-key-policy.ts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "../src/deepseek/index.ts";
import { KERNEL_ORG_RESERVATION_V2_PREFIX, type KernelQuotaReservationRowV2, type KernelQuotaWindowV2, kernelOrgWindowKey } from "../src/kernel/quota-v2.ts";
import { setKvForTest } from "../src/kv.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../src/types.ts";
import { sha256Base64Url } from "../src/utils.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

/**
 * Handler settlement for a caller that leaves during the awaited quota/setup
 * steps, before any provider dispatch.
 *
 * The reviewed defect: that path returned 499 through the rejection terminal log
 * while releasing only the process permit, so an acquired API-key reservation
 * stayed reserved until its lease expired and an acquired kernel reservation
 * kept renewing. These fixtures park a real reservation commit, abort the
 * caller, and then assert the exact resource state: both reservations terminal
 * and uncharged, the permit returned, no provider dispatch, and a later request
 * served normally.
 */

const KERNEL_OWNER = "acme";
const KERNEL_REPO = "demo";
const API_KEY_ID = "kernel-quota-admission-key";
const ABORT_REASON = "caller_aborted_before_dispatch";

const TEXT_ENCODER = new TextEncoder();

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  const base64 = encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
  let end = base64.length;
  while (end > 0 && base64[end - 1] === "=") end -= 1;
  return base64.slice(0, end);
};

const encodeJsonBase64Url = (value: unknown): string => encodeBase64Url(TEXT_ENCODER.encode(JSON.stringify(value)));

const toPublicKeyPem = (spki: Uint8Array): string => {
  const lines = encodeBase64(spki).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
};

const keyHasPrefix = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => Object.is(part, key[index]));

/** A promise plus its resolver, without the executor's definite-assignment dance. */
const resolveAfter = (): Readonly<{ promise: Promise<void>; resolve: () => void }> => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

type AtomicCommitGate = Readonly<{ prefix: KvKey; started: () => void; wait: Promise<void> }>;

/** The fluent chain this fixture uses; `Deno.AtomicOperation` in Deno 2.9 carries extra mutations. */
type GatedAtomicChain = Readonly<{
  check: (entry: KvEntryMaybe<unknown>) => GatedAtomicChain;
  set: (key: KvKey, value: unknown, options?: { expireIn?: number }) => GatedAtomicChain;
  delete: (key: KvKey) => GatedAtomicChain;
  sum: (key: KvKey, value: bigint) => GatedAtomicChain;
  commit: () => Promise<KvCommitResult | KvCommitError>;
}>;

/**
 * A CountingKv whose next matching atomic commit parks until the test releases
 * it. The wrapper returns itself from every chained mutation so `set` can still
 * see the keys of the operation that is about to commit.
 */
class GatedAtomicKv extends CountingKv {
  gate: AtomicCommitGate | null = null;

  override atomic(): AtomicOperation {
    const operation = super.atomic();
    const gate = this.gate;
    if (!gate) return operation;
    let matched = false;
    const wrapper: GatedAtomicChain = {
      check: (entry) => {
        operation.check(entry);
        return wrapper;
      },
      set: (key, value, options) => {
        if (keyHasPrefix(key, gate.prefix)) matched = true;
        operation.set(key, value, options);
        return wrapper;
      },
      delete: (key) => {
        operation.delete(key);
        return wrapper;
      },
      sum: (key, value) => {
        operation.sum(key, value);
        return wrapper;
      },
      commit: async () => {
        if (matched) {
          gate.started();
          await gate.wait;
        }
        return await operation.commit();
      },
    };
    return wrapper as unknown as AtomicOperation;
  }
}

const seedApiKey = async (kv: CountingKv, token: string, nowMs: number): Promise<Readonly<{ policy: ApiKeyPolicy }>> => {
  const tokenHash = await sha256Base64Url(token);
  const windowMs = 60 * 60_000;
  const commonPolicy = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 500,
    usage_requests: 0,
    usage_reset_at_ms: nowMs + windowMs,
    window_ms: windowMs,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: PAID_FALLBACK_NO_LIMIT,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  } satisfies Omit<ApiKeyHashRecord, "id">;
  const hashRecord: ApiKeyHashRecord = { id: API_KEY_ID, ...commonPolicy };
  const keyRecord: ApiKeyRecord = {
    id: API_KEY_ID,
    name: "kernel quota admission fixture",
    prefix: token.slice(0, 10),
    hash: tokenHash,
    created_at_ms: nowMs,
    ...commonPolicy,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: nowMs,
  };
  kv.seed(apiKeyHashKey(tokenHash), hashRecord);
  kv.seed(apiKeyIdKey(API_KEY_ID), keyRecord);
  const policy = apiKeyPolicyFromHashRecord(tokenHash, hashRecord, nowMs);
  if (!policy) throw new Error("the fixture API key record must produce a live policy");
  return { policy };
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

const bufferedChatResponse = (): Response =>
  Response.json({
    id: "chatcmpl-kernel-quota-admission",
    object: "chat.completion",
    created: 1_780_000_002,
    model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: "recovered answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_cache_hit_tokens: 1 },
  });

const kernelReservationRows = (kv: CountingKv): readonly KernelQuotaReservationRowV2[] =>
  [...kv.entries.values()]
    .filter((entry) => keyHasPrefix(entry.key, [...KERNEL_ORG_RESERVATION_V2_PREFIX, KERNEL_OWNER]))
    .map((entry) => entry.value as KernelQuotaReservationRowV2);

/**
 * Runs one request whose caller aborts while the commit that writes `gatePrefix`
 * awaits: `started` proves the request reached that setup step, the abort lands
 * before the gate opens, and the commit completes after the caller is gone.
 */
const abortDuringGatedCommit = async (
  kv: GatedAtomicKv,
  gatePrefix: KvKey,
  request: Request,
  abort: AbortController,
  handler: (request: Request) => Promise<Response>
): Promise<Response> => {
  const started = resolveAfter();
  const gate = resolveAfter();
  kv.gate = { prefix: gatePrefix, started: started.resolve, wait: gate.promise };
  try {
    const pending = handler(request);
    await withTimeout(started.promise, 5_000, "the gated reservation commit to start");
    abort.abort(new DOMException("client disconnected during quota setup", "AbortError"));
    gate.resolve();
    return await pending;
  } finally {
    kv.gate = null;
  }
};

test("handler: an abort during awaited quota setup settles every acquired pre-dispatch resource", async () => {
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const originalFetch = globalThis.fetch;
  const kv = new GatedAtomicKv();
  const token = `u_${crypto.randomUUID().replace(/-/g, "").padEnd(64, "a")}`;
  const nowMs = Date.now();
  const { policy } = await seedApiKey(kv, token, nowMs);
  const kernelToken = await installKernelPublicKey(kv, token);
  process.env.DEEPSEEK_API_KEY = "kernel-quota-admission-dummy-key";
  const { default: handler } = await import("../src/handler/index.ts");
  const { setInferenceAdmissionControllerForTest } = await import("../src/handler/admission.ts");
  const { createInferenceAdmissionController } = await import("../src/inference-admission.ts");
  const controller = createInferenceAdmissionController({ maxActive: 4, maxWaiting: 2, maxQueueWaitMs: 500 });
  setInferenceAdmissionControllerForTest(controller);
  setKvForTest(kv as unknown as Kv);
  resetApiKeyPolicyCacheForTest();
  const dispatches: string[] = [];
  globalThis.fetch = createFetchMock((input: RequestInfo | URL): Promise<Response> => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    dispatches.push(url);
    if (url === DEEPSEEK_CHAT_COMPLETIONS_URL) return Promise.resolve(bufferedChatResponse());
    return Promise.resolve(new Response(JSON.stringify({ error: { message: "unexpected upstream" } }), { status: 502 }));
  });
  try {
    // The caller leaves while the API-key reservation commit is parked: no
    // kernel reservation exists yet, and the acquired API-key reservation must
    // be released rather than left to its lease.
    const apiKeyAbort = new AbortController();
    const apiKeyRefusal = await abortDuringGatedCommit(
      kv,
      apiKeyUsageV3WindowKey(policy),
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-flash", input: "abort during the api key reservation" }),
        signal: apiKeyAbort.signal,
      }),
      apiKeyAbort,
      handler
    );
    const apiKeyPayload = (await apiKeyRefusal.json()) as { error?: { code?: string } };
    assert.equal(apiKeyRefusal.status, 499, "an aborted pre-dispatch request is a cancellation");
    assert.equal(apiKeyPayload.error?.code, "request_cancelled");
    const apiKeyRequestId = apiKeyRefusal.headers.get("x-uos-request-id");
    assert.ok(apiKeyRequestId, "the 499 must carry the gateway request id");
    const apiKeyRow = (await kv.get<ApiKeyUsageRequestV3>(apiKeyUsageV3RequestKey(policy, apiKeyRequestId))).value;
    assert.equal(apiKeyRow?.state, "released", "a pre-dispatch abort must release the API-key reservation");
    assert.equal(apiKeyRow.release_reason, ABORT_REASON);
    const apiKeyWindow = (await kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(policy))).value;
    assert.equal(apiKeyWindow?.reserved_requests, 0, "the released reservation must return its window slot");
    assert.equal(apiKeyWindow.committed_requests, 0, "work that never started must not be charged");
    assert.equal(kernelReservationRows(kv).length, 0, "an abort before kernel admission must not create a kernel reservation");
    assert.equal(dispatches.length, 0, "no provider dispatch for a request that never started");
    assert.equal(controller.snapshot().active, 0, "the process permit returns through the rejection terminal log");
    assert.equal(controller.snapshot().waiting, 0);

    // The caller leaves while the kernel reservation commit is parked: the
    // API-key reservation is already acquired, and both must settle uncharged.
    const kernelAbort = new AbortController();
    const kernelRefusal = await abortDuringGatedCommit(
      kv,
      [...KERNEL_ORG_RESERVATION_V2_PREFIX, KERNEL_OWNER],
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Ubiquity-Kernel-Token": kernelToken,
        },
        body: JSON.stringify({ model: "deepseek-flash", input: "abort during the kernel reservation" }),
        signal: kernelAbort.signal,
      }),
      kernelAbort,
      handler
    );
    const kernelPayload = (await kernelRefusal.json()) as { error?: { code?: string } };
    assert.equal(kernelRefusal.status, 499, "an aborted pre-dispatch request is a cancellation");
    assert.equal(kernelPayload.error?.code, "request_cancelled");
    const kernelRequestId = kernelRefusal.headers.get("x-uos-request-id");
    assert.ok(kernelRequestId, "the kernel-scoped 499 must carry the gateway request id");
    const kernelKeyRow = (await kv.get<ApiKeyUsageRequestV3>(apiKeyUsageV3RequestKey(policy, kernelRequestId))).value;
    assert.equal(kernelKeyRow?.state, "released", "the API-key reservation acquired before the kernel step must be released");
    assert.equal(kernelKeyRow.release_reason, ABORT_REASON);
    const kernelReservations = kernelReservationRows(kv);
    assert.equal(kernelReservations.length, 1, "the fixture must have acquired exactly one kernel reservation");
    assert.equal(kernelReservations[0]?.state, "released", "an acquired kernel reservation must settle as released, not keep renewing");
    assert.equal(kernelReservations[0]?.release_reason, ABORT_REASON);
    const kernelWindow = (await kv.get<KernelQuotaWindowV2>(kernelOrgWindowKey(KERNEL_OWNER))).value;
    assert.equal(kernelWindow?.reserved_requests, 0, "the released kernel reservation must return its slot");
    assert.equal(kernelWindow.usage_requests, 0, "work that never started must not consume kernel usage");
    assert.equal(dispatches.length, 0, "neither aborted request may reach a provider");
    assert.equal(controller.snapshot().active, 0, "every aborted request returns its permit exactly once");

    // The key, the ledger and the guard still serve ordinary work afterwards.
    const recovered = await handler(
      new Request("https://ai.ubq.fi/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "recover" }] }),
      })
    );
    assert.equal(recovered.status, 200, "a later request must be served after the aborted setup");
    const recoveredPayload = (await recovered.json()) as { choices?: { message?: { content?: string } }[] };
    assert.equal(recoveredPayload.choices?.[0]?.message?.content, "recovered answer");
    assert.equal(dispatches.length, 1, "the recovered request is the only provider dispatch");
    const recoveredWindow = (await kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(policy))).value;
    assert.equal(recoveredWindow?.committed_requests, 1, "only the dispatched work is charged");
    assert.equal(controller.snapshot().active, 0, "the recovered request releases its permit");
    assert.equal(controller.snapshot().waiting, 0);
  } finally {
    setInferenceAdmissionControllerForTest(null);
    setKvForTest(null);
    globalThis.fetch = originalFetch;
    if (originalDeepSeekKey === undefined) Reflect.deleteProperty(process.env, "DEEPSEEK_API_KEY");
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
  }
});
