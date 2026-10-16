import { test } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import assert from "node:assert/strict";

import { deriveRsaPublicKeyPemFromPrivateKey, normalizeMultilineSecret, runSetupInstance } from "../scripts/setup-instance.ts";

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const combined = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
};

const derLength = (length: number): Uint8Array => {
  if (length < 0x80) return Uint8Array.of(length);
  const octets: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) octets.unshift(remaining & 0xff);
  return Uint8Array.of(0x80 | octets.length, ...octets);
};

const derValue = (tag: number, value: Uint8Array): Uint8Array => concatBytes(Uint8Array.of(tag), derLength(value.byteLength), value);

const base64ToBytes = (value: string): Uint8Array => {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const bytesToBase64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const pem = (label: string, value: Uint8Array): string => {
  const lines = bytesToBase64(value).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

const derInteger = (value: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < value.byteLength - 1 && value[start] === 0) start += 1;
  const unsigned = value.slice(start);
  const encoded = unsigned[0] & 0x80 ? concatBytes(Uint8Array.of(0), unsigned) : unsigned;
  return derValue(0x02, encoded);
};

const requireJwkPart = (jwk: JsonWebKey, key: "n" | "e" | "d" | "p" | "q" | "dp" | "dq" | "qi"): Uint8Array => {
  const value = jwk[key];
  if (typeof value !== "string") throw new Error(`missing RSA JWK ${key}`);
  return base64ToBytes(value);
};

const pkcs1FromPrivateKey = async (privateKey: CryptoKey): Promise<Uint8Array> => {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  return derValue(
    0x30,
    concatBytes(
      derInteger(Uint8Array.of(0)),
      derInteger(requireJwkPart(jwk, "n")),
      derInteger(requireJwkPart(jwk, "e")),
      derInteger(requireJwkPart(jwk, "d")),
      derInteger(requireJwkPart(jwk, "p")),
      derInteger(requireJwkPart(jwk, "q")),
      derInteger(requireJwkPart(jwk, "dp")),
      derInteger(requireJwkPart(jwk, "dq")),
      derInteger(requireJwkPart(jwk, "qi"))
    )
  );
};

const createRsaFixture = async (): Promise<Readonly<{ pkcs8Pem: string; pkcs1Pem: string; publicPem: string }>> => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  assert.equal(pair.privateKey.type, "private");
  assert.equal(pair.publicKey.type, "public");
  return {
    pkcs8Pem: pem("PRIVATE KEY", new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    pkcs1Pem: pem("RSA PRIVATE KEY", await pkcs1FromPrivateKey(pair.privateKey)),
    publicPem: pem("PUBLIC KEY", new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
  };
};

const fixture = await createRsaFixture();

const logger = (): Readonly<{ logs: unknown[][]; errors: unknown[][]; log(...data: unknown[]): void; error(...data: unknown[]): void }> => {
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];
  return {
    logs,
    errors,
    log: (...data: unknown[]) => logs.push(data),
    error: (...data: unknown[]) => errors.push(data),
  };
};

const environment = (entries: Record<string, string | undefined>): Readonly<{ get(name: string): string | undefined }> => ({
  get: (name) => entries[name],
});

test("setup-instance derives matching SPKI public PEM from PKCS#8 and escaped GitHub PKCS#1", async () => {
  assert.equal(await deriveRsaPublicKeyPemFromPrivateKey(fixture.pkcs8Pem), fixture.publicPem);
  assert.equal(await deriveRsaPublicKeyPemFromPrivateKey(fixture.pkcs1Pem.replace(/\n/g, "\\n")), fixture.publicPem);
  assert.equal(normalizeMultilineSecret(fixture.pkcs1Pem.replace(/\n/g, "\\n")), fixture.pkcs1Pem.trim());
});

test("setup-instance posts the derived key with the deploy token", async () => {
  const captured = { request: null as Request | null };
  const output = logger();
  const exitCode = await runSetupInstance({
    env: environment({
      APP_ID: "12345",
      APP_PRIVATE_KEY: fixture.pkcs1Pem.replace(/\n/g, "\\n"),
      DENO_DEPLOY_TOKEN: "deploy-token",
      UOS_AI_TOKEN: "must-not-be-used",
      UOS_AI_URL: "https://gateway.example/ai/",
      UOS_OWNER: "ubiquity",
    }),
    fetch: (input, init) => {
      captured.request = new Request(input, init);
      return Promise.resolve(new Response("registered", { status: 201 }));
    },
    log: output,
  });

  assert.equal(exitCode, 0);
  const request = captured.request;
  assert.ok(request);
  assert.equal(request.url, "https://gateway.example/ai/admin/kernel-pubkeys");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), "Bearer deploy-token");
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(await request.json(), {
    app_id: 12345,
    pem: fixture.publicPem,
    owner: "ubiquity",
  });
  assert.deepEqual(output.errors, []);
});

test("setup-instance fails without the deploy token and on network or HTTP failures", () =>
  runSequence(async (step) => {
    const base = {
      APP_ID: "9",
      APP_PRIVATE_KEY: fixture.pkcs8Pem,
      UOS_AI_TOKEN: "legacy-token-is-not-an-admin-token",
    };

    await step("missing DENO_DEPLOY_TOKEN", async () => {
      let calls = 0;
      const output = logger();
      const exitCode = await runSetupInstance({
        env: environment(base),
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response("unexpected"));
        },
        log: output,
      });
      assert.equal(exitCode, 1);
      assert.equal(calls, 0);
      assert.match(String(output.errors[0]?.[0]), /DENO_DEPLOY_TOKEN/);
    });

    await step("invalid APP_ID", async () => {
      let calls = 0;
      const exitCode = await runSetupInstance({
        env: environment({ ...base, APP_ID: "0", DENO_DEPLOY_TOKEN: "deploy-token" }),
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response("unexpected"));
        },
        log: logger(),
      });
      assert.equal(exitCode, 1);
      assert.equal(calls, 0);
    });

    await step("network failure", async () => {
      const exitCode = await runSetupInstance({
        env: environment({ ...base, DENO_DEPLOY_TOKEN: "deploy-token" }),
        fetch: () => Promise.reject(new TypeError("network offline")),
        log: logger(),
      });
      assert.equal(exitCode, 1);
    });

    await step("non-2xx response", async () => {
      const output = logger();
      const exitCode = await runSetupInstance({
        env: environment({ ...base, DENO_DEPLOY_TOKEN: "deploy-token" }),
        fetch: () => Promise.resolve(new Response("forbidden", { status: 403 })),
        log: output,
      });
      assert.equal(exitCode, 1);
      assert.match(String(output.errors[0]?.[0]), /status 403/);
    });
  }));
