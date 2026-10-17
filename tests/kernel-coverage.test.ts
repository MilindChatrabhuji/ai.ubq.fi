import { test } from "bun:test";
import type { Kv, KvKey } from "#kv";
// Coverage tests for the kernel attestation verifier, the V2 kernel quota
// projection and the API key V3 policy ledger. Every case drives the exported
// production entry points and asserts the observable decision (HTTP status and
// error code, returned policy, or KV state).

import assert from "node:assert/strict";
import { getGitHubRepoHeaders, getKernelAttestationContext, reloadKernelPublicKeys, verifyKernelAttestation } from "../src/kernel/attestation.ts";
import {
  getKernelOrgUsageLimitSnapshot,
  getKernelUsageLimitSnapshot,
  kernelOrgReservationKey,
  kernelRepoPart,
  kernelRepoReservationKey,
  listKernelOrgUsageLimits,
  listKernelUsageLimits,
  normalizeExpiration,
  normalizeKernelQuotaPolicyV2,
  normalizeKernelQuotaWindowV2,
  normalizeUsageLimit,
  normalizeWindow,
} from "../src/kernel/quota-v2.ts";
import { setKvForTest } from "../src/kv.ts";
import { sha256Base64Url } from "../src/utils.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const KERNEL_PUBKEYS_KEY: KvKey = ["uos_ai", "kernel_pubkeys"];
const REPO_POLICY_PREFIX: KvKey = ["uos_ai", "kernel_quota", "v2", "repo_policy"];
const ORG_POLICY_PREFIX: KvKey = ["uos_ai", "kernel_quota", "v2", "org_policy"];
const TEXT_ENCODER = new TextEncoder();

const kv = new CountingKv();
setKvForTest(kv as unknown as Kv);

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
  // Strip the trailing `=` padding without a `=+$` regex: an unbounded
  // quantifier before `$` is a super-linear backtracking pattern.
  let end = encoded.length;
  while (end > 0 && encoded[end - 1] === "=") end -= 1;
  return encoded.slice(0, end);
};

const base64UrlJson = (value: unknown): string => base64Url(TEXT_ENCODER.encode(JSON.stringify(value)));

const pemFromSpki = (spki: Uint8Array): string => {
  let binary = "";
  for (const byte of spki) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
};

type AttestationKeys = Readonly<{ privateKey: CryptoKey; pem: string }>;

const createAttestationKeys = async (): Promise<AttestationKeys> => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pem = pemFromSpki(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return { privateKey: pair.privateKey, pem };
};

const signAttestation = async (
  keys: AttestationKeys,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT" }
): Promise<string> => {
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, TEXT_ENCODER.encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
};

const attestationPayload = async (token: string, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return {
    iss: "ubiquity-os-kernel",
    aud: "ai.ubq.fi",
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: crypto.randomUUID(),
    owner: "acme",
    repo: "demo",
    installation_id: null,
    auth_token_sha256: await sha256Base64Url(token),
    state_id: "state-1",
    ...overrides,
  };
};

const tokenRequest = (kernelToken: string | null, headers: Record<string, string> = {}): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { ...(kernelToken === null ? {} : { "X-Ubiquity-Kernel-Token": kernelToken }), ...headers },
  });

const policyRecord = (scope: "repo" | "org", owner: string, repo: string | undefined, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 2,
  scope,
  owner,
  ...(repo === undefined ? {} : { repo }),
  usage_limit_requests: 10,
  window_ms: 60_000,
  expires_at_ms: -1,
  created_at_ms: 1_000,
  updated_at_ms: 2_000,
  ...overrides,
});

const windowRecord = (scope: "repo" | "org", owner: string, repo: string | undefined, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 2,
  scope,
  owner,
  ...(repo === undefined ? {} : { repo }),
  usage_requests: 1,
  reserved_requests: 0,
  usage_reset_at_ms: Date.now() + 60_000,
  applied_window_ms: 60_000,
  created_at_ms: 1_000,
  updated_at_ms: 2_000,
  ...overrides,
});

test("kernel attestation requires the token header and a loaded public key", async () => {
  kv.clearData();
  const keys = await createAttestationKeys();
  const apiToken = `u_${"a".repeat(64)}`;
  const token = await signAttestation(keys, await attestationPayload(apiToken));

  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 1, pem: keys.pem, owner: "acme", added_at_ms: 1 }]);
  await reloadKernelPublicKeys();

  const missingHeader = await verifyKernelAttestation(tokenRequest(null), { token: apiToken });
  assert.equal(missingHeader.ok, false);
  assert.equal(missingHeader.response.status, 401);
  assert.equal((await missingHeader.response.json()).error.code, "missing_kernel_token");

  // A stored PEM that cannot be imported leaves the verifier with no keys at all.
  kv.clearData();
  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 1, pem: "-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----", owner: "acme", added_at_ms: 1 }]);
  await reloadKernelPublicKeys();
  const malformedKey = await verifyKernelAttestation(tokenRequest(token), { token: apiToken });
  assert.equal(malformedKey.ok, false);
  assert.equal(malformedKey.response.status, 500);
  const body = await malformedKey.response.json();
  assert.equal(body.error.code, "server_error");
  assert.match(body.error.message, /No kernel public keys loaded/);

  kv.clearData();
  await reloadKernelPublicKeys();
  const noKeys = await verifyKernelAttestation(tokenRequest(token), { token: apiToken });
  assert.equal(noKeys.ok, false);
  assert.equal(noKeys.response.status, 500);

  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 1, pem: keys.pem, owner: "acme", added_at_ms: 1 }]);
  await reloadKernelPublicKeys();
});

test("kernel attestation rejects malformed JWT parts and unsigned headers", async () => {
  kv.clearData();
  const keys = await createAttestationKeys();
  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 1, pem: keys.pem, owner: "acme", added_at_ms: 1 }]);
  await reloadKernelPublicKeys();
  const apiToken = `u_${"b".repeat(64)}`;
  const payload = await attestationPayload(apiToken);

  const readerOf = async (result: Awaited<ReturnType<typeof verifyKernelAttestation>>): Promise<{ status: number; code: string; message: string }> => {
    assert.equal(result.ok, false);
    const body = await result.response.json();
    return { status: result.response.status, code: body.error.code, message: body.error.message };
  };

  const twoParts = await readerOf(await verifyKernelAttestation(tokenRequest("header.payload"), { token: apiToken }));
  assert.equal(twoParts.status, 401);
  assert.equal(twoParts.code, "invalid_kernel_token");
  assert.match(twoParts.message, /MUST have 3 parts/);

  const undecodableHeader = await readerOf(await verifyKernelAttestation(tokenRequest("!!!.payload.signature"), { token: apiToken }));
  assert.match(undecodableHeader.message, /failed to parse kernel attestation JWT parts/);

  const nonJsonHeader = await readerOf(
    await verifyKernelAttestation(tokenRequest(`${base64Url(TEXT_ENCODER.encode("not json"))}.e30.sig`), { token: apiToken })
  );
  assert.match(nonJsonHeader.message, /failed to parse kernel attestation JWT parts/);

  const wrongAlgorithm = await readerOf(
    await verifyKernelAttestation(tokenRequest(await signAttestation(keys, payload, { alg: "HS256" })), { token: apiToken })
  );
  assert.match(wrongAlgorithm.message, /'alg' MUST be 'RS256', got 'HS256'/);

  // A JSON scalar header keeps the diagnostic shape the production code documents.
  const scalarHeader = await readerOf(
    await verifyKernelAttestation(tokenRequest(`${base64Url(TEXT_ENCODER.encode("7"))}.${base64UrlJson(payload)}.sig`), { token: apiToken })
  );
  assert.match(scalarHeader.message, /'alg' MUST be 'RS256', got 'undefined'/);

  const invalidPayloadShapes: unknown[] = [
    { any: "record" },
    { ...payload, iat: "soon" },
    { ...payload, exp: Number.NaN },
    { ...payload, installation_id: "7" },
    { ...payload, iss: "someone-else" },
    { ...payload, aud: "other.example" },
    { ...payload, jti: "" },
    { ...payload, owner: "" },
    { ...payload, repo: "" },
    { ...payload, auth_token_sha256: "" },
    { ...payload, state_id: "" },
    7,
  ];
  for (const shape of invalidPayloadShapes) {
    const invalid = await readerOf(
      await verifyKernelAttestation(tokenRequest(`${base64UrlJson({ alg: "RS256" })}.${base64UrlJson(shape)}.sig`), { token: apiToken })
    );
    assert.equal(invalid.status, 401);
    assert.match(invalid.message, /payload is invalid or fields are missing/);
  }

  const badSignatureBase64 = await readerOf(
    await verifyKernelAttestation(tokenRequest(`${base64UrlJson({ alg: "RS256" })}.${base64UrlJson(payload)}.!!!`), { token: apiToken })
  );
  assert.match(badSignatureBase64.message, /failed to decode kernel attestation signature/);
});

test("kernel attestation enforces clock, repo, installation and token-hash bindings", async () => {
  kv.clearData();
  const keys = await createAttestationKeys();
  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 1, pem: keys.pem, owner: "acme", added_at_ms: 1 }]);
  await reloadKernelPublicKeys();
  const apiToken = `u_${"c".repeat(64)}`;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const base = await attestationPayload(apiToken);

  const failureMessage = async (
    overrides: Record<string, unknown>,
    headers: Record<string, string> = {},
    token = apiToken,
    // A missing or unparsable installation header is its own wire code; every
    // other rejection stays `invalid_kernel_token`.
    expectedCode = "invalid_kernel_token"
  ): Promise<string> => {
    const signed = await signAttestation(keys, { ...base, ...overrides });
    const result = await verifyKernelAttestation(tokenRequest(signed, headers), { token, owner: headers["X-GitHub-Owner"], repo: headers["X-GitHub-Repo"] });
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 401);
    const body = await result.response.json();
    assert.equal(body.error.code, expectedCode);
    return body.error.message as string;
  };

  assert.match(await failureMessage({ iat: nowSeconds, exp: nowSeconds - 1 }), /'exp' \(\d+\) is before 'iat' \(\d+\)/);
  assert.match(await failureMessage({ iat: nowSeconds, exp: nowSeconds + 4_000 }), /kernel attestation TTL is too long \(4000s > 3600s\)/);
  assert.match(await failureMessage({ iat: nowSeconds + 3_600, exp: nowSeconds + 7_200 }), /'iat' \(\d+\) is in the future/);
  assert.match(await failureMessage({ iat: nowSeconds - 7_200, exp: nowSeconds - 3_600 }), /'exp' \(\d+\) is in the past/);

  assert.match(await failureMessage({}, { "X-GitHub-Owner": "other", "X-GitHub-Repo": "demo" }), /repo mismatch. Expected 'other\/demo', got 'acme\/demo'/);
  assert.match(
    await failureMessage({}, { "X-GitHub-Owner": "acme", "X-GitHub-Repo": "other" }, apiToken),
    /repo mismatch. Expected 'acme\/other', got 'acme\/demo'/
  );

  assert.match(await failureMessage({ installation_id: 42 }, {}, apiToken, "missing_installation_id"), /missing 'X-GitHub-Installation-Id' header/);
  assert.match(await failureMessage({ installation_id: 42 }, { "X-GitHub-Installation-Id": "43" }), /installation_id mismatch. Expected '43', got '42'/);
  assert.match(
    await failureMessage({ installation_id: 42 }, { "X-GitHub-Installation-Id": "abc" }, apiToken, "missing_installation_id"),
    /missing 'X-GitHub-Installation-Id' header/
  );
  assert.match(await failureMessage({}, {}, `u_${"d".repeat(64)}`), /'auth_token_sha256' mismatch/);

  const installationMatch = await verifyKernelAttestation(
    tokenRequest(await signAttestation(keys, { ...base, installation_id: 42 }), { "X-GitHub-Installation-Id": " 42 " }),
    { token: apiToken }
  );
  assert.equal(installationMatch.ok, true);
  assert.equal(installationMatch.payload.installation_id, 42);
});

test("kernel attestation accepts a signed token, prunes expired jti entries and rejects tampering", async () => {
  kv.clearData();
  const keys = await createAttestationKeys();
  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 1, pem: keys.pem, owner: "acme", added_at_ms: 1 }]);
  await reloadKernelPublicKeys();
  const apiToken = `u_${"e".repeat(64)}`;
  const nowSeconds = Math.floor(Date.now() / 1_000);

  // A token that expires immediately is still valid (clock skew) and leaves a
  // cache entry the next accepted token prunes.
  const expiring = await signAttestation(keys, await attestationPayload(apiToken, { exp: nowSeconds }));
  const accepted = await verifyKernelAttestation(tokenRequest(expiring), { token: apiToken });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.payload.owner, "acme");
  assert.equal(accepted.payload.repo, "demo");
  assert.equal(accepted.payload.iss, "ubiquity-os-kernel");
  assert.equal(accepted.payload.aud, "ai.ubq.fi");
  assert.equal(accepted.payload.exp, nowSeconds);

  const fresh = await signAttestation(keys, await attestationPayload(apiToken, { jti: "jti-prune-me" }));
  const afterPrune = await verifyKernelAttestation(tokenRequest(fresh), { token: apiToken });
  assert.equal(afterPrune.ok, true);

  const tampered = `${fresh.slice(0, -4)}AAAA`;
  const rejected = await verifyKernelAttestation(tokenRequest(tampered), { token: apiToken });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.response.status, 401);
  assert.match((await rejected.response.json()).error.message, /invalid kernel attestation/);
});

test("kernel attestation context resolves repository identity from request headers", async () => {
  kv.clearData();
  const keys = await createAttestationKeys();
  kv.seed(KERNEL_PUBKEYS_KEY, [{ app_id: 1, pem: keys.pem, owner: "acme", added_at_ms: 1 }]);
  await reloadKernelPublicKeys();
  const apiToken = `u_${"f".repeat(64)}`;
  const token = await signAttestation(keys, await attestationPayload(apiToken));

  assert.equal(await getKernelAttestationContext(tokenRequest(token), null), null);
  assert.equal(await getKernelAttestationContext(tokenRequest(null), apiToken), null);
  // Only the owner header: the repo still resolves from the signed payload.
  assert.deepEqual(await getKernelAttestationContext(tokenRequest(token, { "X-GitHub-Owner": "acme" }), apiToken), { owner: "acme", repo: "demo" });

  const resolved = await getKernelAttestationContext(tokenRequest(token, { "X-GitHub-Owner": "acme", "X-GitHub-Repo": "demo" }), apiToken);
  assert.deepEqual(resolved, { owner: "acme", repo: "demo" });

  const mismatched = await getKernelAttestationContext(tokenRequest(token, { "X-GitHub-Owner": "acme", "X-GitHub-Repo": "other" }), apiToken);
  assert.equal(mismatched, null);

  assert.deepEqual(getGitHubRepoHeaders(tokenRequest(token, { "X-GitHub-Owner": " acme ", "X-GitHub-Repo": " demo " })), {
    owner: "acme",
    repo: "demo",
  });
  assert.equal(getGitHubRepoHeaders(tokenRequest(token)), null);
});

test("kernel quota normalizers reject malformed records and coerce loose values", () => {
  assert.equal(normalizeUsageLimit("30", 1), 30);
  assert.equal(normalizeUsageLimit("not-a-number", 7), 7);
  assert.equal(normalizeUsageLimit(-1, 7), -1);
  assert.equal(normalizeUsageLimit(-5, 7), 7);
  assert.equal(normalizeUsageLimit(12.9, 7), 12);
  assert.equal(normalizeUsageLimit(undefined, 7), 7);

  assert.equal(normalizeWindow("60000", 1), 60_000);
  assert.equal(normalizeWindow("0", 9), 9);
  assert.equal(normalizeWindow(0, 9), 9);
  assert.equal(normalizeWindow(Number.NaN, 9), 9);
  assert.equal(normalizeWindow(1_500.7, 9), 1_500);

  assert.equal(normalizeExpiration(-1), -1);
  assert.equal(normalizeExpiration("later"), -1);
  assert.equal(normalizeExpiration(1_700_000_000_123), 1_700_000_000_123);
  assert.equal(normalizeExpiration(-9), -1);
  assert.equal(normalizeExpiration(1_500.9), 1_500);

  assert.equal(normalizeKernelQuotaPolicyV2(null, "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaPolicyV2(policyRecord("repo", "acme", "demo"), "org", "acme", undefined), null);
  assert.equal(normalizeKernelQuotaPolicyV2(policyRecord("repo", "acme", "demo"), "repo", "other", "demo"), null);
  assert.equal(normalizeKernelQuotaPolicyV2(policyRecord("repo", "acme", "demo"), "repo", "acme", "other"), null);
  assert.equal(normalizeKernelQuotaPolicyV2(policyRecord("repo", "acme", "demo", { created_at_ms: -1 }), "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaPolicyV2(policyRecord("repo", "acme", "demo", { updated_at_ms: "now" }), "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaPolicyV2(policyRecord("repo", "acme", "demo", { window_ms: 0 }), "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaPolicyV2(policyRecord("repo", "acme", "demo", { usage_limit_requests: -9 }), "repo", "acme", "demo"), null);

  const accepted = normalizeKernelQuotaPolicyV2(
    policyRecord("repo", "acme", "demo", { usage_limit_requests: "25", expires_at_ms: "soon" }),
    "repo",
    "acme",
    "demo"
  );
  assert.deepEqual(accepted, {
    v: 2,
    scope: "repo",
    owner: "acme",
    repo: "demo",
    usage_limit_requests: 25,
    window_ms: 60_000,
    expires_at_ms: -1,
    created_at_ms: 1_000,
    updated_at_ms: 2_000,
  });
  const unlimited = normalizeKernelQuotaPolicyV2(policyRecord("org", "acme", undefined, { usage_limit_requests: -1 }), "org", "acme", undefined);
  assert.equal(unlimited?.usage_limit_requests, -1);
  assert.equal(Object.hasOwn(unlimited, "repo"), false);

  assert.equal(normalizeKernelQuotaWindowV2(7, "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaWindowV2(windowRecord("repo", "acme", "demo", { usage_requests: -1 }), "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaWindowV2(windowRecord("repo", "acme", "demo", { reserved_requests: 1.5 }), "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaWindowV2(windowRecord("repo", "acme", "demo", { usage_reset_at_ms: 0 }), "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaWindowV2(windowRecord("repo", "acme", "demo", { applied_window_ms: 0 }), "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaWindowV2(windowRecord("repo", "acme", "demo", { created_at_ms: -1 }), "repo", "acme", "demo"), null);
  assert.equal(normalizeKernelQuotaWindowV2(windowRecord("repo", "acme", "demo", { updated_at_ms: null }), "repo", "acme", "demo"), null);

  const legacyWindow = normalizeKernelQuotaWindowV2(
    { ...windowRecord("org", "acme", undefined), reserved_requests: undefined, repo: null },
    "org",
    "acme",
    undefined
  );
  assert.equal(legacyWindow?.reserved_requests, 0);
  assert.equal(Object.hasOwn(legacyWindow, "repo"), false);

  assert.throws(() => kernelRepoPart(undefined), /Kernel quota repo scope requires a repo/);
  assert.equal(kernelRepoPart("demo"), "demo");
  assert.deepEqual(kernelRepoReservationKey("acme", "demo", 5, "req-1"), ["uos_ai", "kernel_quota", "v2", "repo_reservation", "acme", "demo", 5, "req-1"]);
  assert.deepEqual(kernelOrgReservationKey("acme", 5, "req-1"), ["uos_ai", "kernel_quota", "v2", "org_reservation", "acme", 5, "req-1"]);
});

test("kernel quota snapshots and policy listings fail closed without KV", async () => {
  setKvForTest(null);
  try {
    assert.equal(await getKernelUsageLimitSnapshot("acme", "demo"), null);
    assert.equal(await getKernelOrgUsageLimitSnapshot("acme"), null);
    assert.equal(await listKernelUsageLimits(), null);
    assert.equal(await listKernelOrgUsageLimits(), null);
  } finally {
    setKvForTest(kv as unknown as Kv);
  }
});

test("kernel quota listings project stored policies and skip foreign rows", async () => {
  kv.clearData();
  kv.seed([...REPO_POLICY_PREFIX, "acme", "demo"], policyRecord("repo", "acme", "demo", { usage_limit_requests: 4 }));
  kv.seed([...REPO_POLICY_PREFIX, "acme", "demo", "extra"], policyRecord("repo", "acme", "demo"));
  kv.seed([...REPO_POLICY_PREFIX, "acme"], policyRecord("repo", "acme", undefined));
  kv.seed([...REPO_POLICY_PREFIX], policyRecord("repo", "acme", "demo"));
  kv.seed([...REPO_POLICY_PREFIX, "acme", "stale"], policyRecord("repo", "acme", "stale", { window_ms: 0 }));
  kv.seed(["uos_ai", "kernel_quota", "v2", "repo_window", "acme", "demo"], windowRecord("repo", "acme", "demo", { usage_requests: 3 }));
  kv.seed([...ORG_POLICY_PREFIX, "acme"], policyRecord("org", "acme", undefined));
  kv.seed([...ORG_POLICY_PREFIX, "beta"], policyRecord("org", "owner-mismatch", undefined));
  kv.seed([...ORG_POLICY_PREFIX, ""], policyRecord("org", "acme", undefined));

  const repoRows = await listKernelUsageLimits();
  // The malformed `acme/demo/extra` key is projected onto its first two key
  // segments rather than skipped: kernelPolicyRow (src/kernel/quota-v2.ts) reads
  // only prefix+0 and prefix+1, so that key surfaces as a second acme/demo row.
  assert.deepEqual(
    repoRows?.map((row) => `${row.owner}/${row.repo}`),
    ["acme/demo", "acme/demo"]
  );
  assert.equal(repoRows[0].usage_requests, 3);
  // The duplicate row carries the same owner/repo pair with its own limit.
  const limits = repoRows.map((row) => row.usage_limit_requests).sort((left, right) => left - right);
  assert.deepEqual(limits, [4, 10]);

  const repoSnapshot = await getKernelUsageLimitSnapshot("acme", "demo");
  assert.equal(repoSnapshot?.source, "kv");
  assert.equal(repoSnapshot.record.usage_limit_requests, 4);
  assert.equal(repoSnapshot.record.usage_requests, 3);

  const orgSnapshot = await getKernelOrgUsageLimitSnapshot("acme");
  assert.equal(orgSnapshot?.source, "kv");
  assert.equal(orgSnapshot.record.owner, "acme");
  assert.equal(orgSnapshot.record.window_ms, 60_000);

  const orgRows = await listKernelOrgUsageLimits();
  assert.deepEqual(
    orgRows?.map((row) => row.owner),
    ["acme"]
  );

  const defaulted = await getKernelUsageLimitSnapshot("nobody", "nothing");
  assert.equal(defaulted?.source, "default");
  assert.equal(defaulted.record.usage_limit_requests, -1);
});
