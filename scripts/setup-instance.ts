type SetupEnvironment = Readonly<{
  get(name: string): string | undefined;
}>;

type SetupLogger = Readonly<{
  log(...data: unknown[]): void;
  error(...data: unknown[]): void;
}>;

export type SetupInstanceDependencies = Readonly<{
  env?: SetupEnvironment;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  log?: SetupLogger;
}>;

type PrivateKeyFormat = "pkcs1" | "pkcs8";

const RSA_ENCRYPTION_ALGORITHM_IDENTIFIER = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/** Turns secrets pasted with literal `\\n` sequences into ordinary PEM lines. */
export const normalizeMultilineSecret = (value: string): string =>
  value
    .trim()
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .trim();

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
};

const derLength = (length: number): Uint8Array => {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid DER length.");
  if (length < 0x80) return Uint8Array.of(length);
  const octets: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) octets.unshift(remaining & 0xff);
  return Uint8Array.of(0x80 | octets.length, ...octets);
};

const derValue = (tag: number, value: Uint8Array): Uint8Array => concatBytes(Uint8Array.of(tag), derLength(value.byteLength), value);

const copyToArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
};

const wrapPkcs1AsPkcs8 = (pkcs1: Uint8Array): Uint8Array =>
  derValue(0x30, concatBytes(Uint8Array.of(0x02, 0x01, 0x00), RSA_ENCRYPTION_ALGORITHM_IDENTIFIER, derValue(0x04, pkcs1)));

const base64ToBytes = (value: string): Uint8Array => {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
};

const bytesToBase64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * Removes every trailing `/`, equivalent to `value.replace(/\/+$/, "")` without
 * the quadratic backtracking that pattern needs on a run of slashes.
 */
const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
};

/**
 * `||` fallback for a trimmed environment value, stated explicitly: an UNSET or
 * EMPTY variable falls back, which a lone `??` would not do for the empty
 * string (the original `value || fallback` semantics are preserved exactly).
 */
const trimmedEnvOr = (value: string | undefined, fallback: string): string => (value === undefined || value === "" ? fallback : value);

/** Default gateway URL used when `UOS_AI_URL` is unset or empty. */
const DEFAULT_AI_URL = "https://ai.ubq.fi";

/** PEM header of each supported private-key encoding, in match order. */
const PRIVATE_KEY_FORMATS: readonly (readonly [string, PrivateKeyFormat])[] = [
  ["-----BEGIN PRIVATE KEY-----", "pkcs8"],
  ["-----BEGIN RSA PRIVATE KEY-----", "pkcs1"],
];

const privateKeyFormatOf = (begin: string | undefined): PrivateKeyFormat | null => {
  for (const [header, format] of PRIVATE_KEY_FORMATS) {
    if (begin === header) return format;
  }
  return null;
};

const decodePrivateKeyPem = (value: string): Readonly<{ format: PrivateKeyFormat; der: Uint8Array }> => {
  const lines = normalizeMultilineSecret(value).split("\n").filter(Boolean);
  const begin = lines.shift();
  const end = lines.pop();
  const format = privateKeyFormatOf(begin);
  const expectedEnd = format === "pkcs8" ? "-----END PRIVATE KEY-----" : "-----END RSA PRIVATE KEY-----";
  if (!format || end !== expectedEnd || lines.length === 0) {
    throw new Error("APP_PRIVATE_KEY must be an unencrypted PKCS#8 or PKCS#1 RSA PEM private key.");
  }
  const encoded = lines.join("").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("APP_PRIVATE_KEY PEM contains invalid base64.");
  }
  try {
    return { format, der: base64ToBytes(encoded) };
  } catch (error) {
    throw new Error("APP_PRIVATE_KEY PEM contains invalid base64.", { cause: error });
  }
};

const pem = (label: string, bytes: Uint8Array): string => {
  const encoded = bytesToBase64(bytes);
  const lines = encoded.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

/** Derives an SPKI `PUBLIC KEY` PEM from PKCS#8 or GitHub PKCS#1 RSA PEM. */
export const deriveRsaPublicKeyPemFromPrivateKey = async (privateKeyPem: string): Promise<string> => {
  const decoded = decodePrivateKeyPem(privateKeyPem);
  const pkcs8 = decoded.format === "pkcs1" ? wrapPkcs1AsPkcs8(decoded.der) : decoded.der;
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", copyToArrayBuffer(pkcs8), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
    const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
    if (!privateJwk.n || !privateJwk.e) throw new Error("Imported RSA private key is missing public components.");
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: privateJwk.n, e: privateJwk.e, ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["verify"]
    );
    return pem("PUBLIC KEY", new Uint8Array(await crypto.subtle.exportKey("spki", publicKey)));
  } catch (error) {
    throw new Error("APP_PRIVATE_KEY must be a valid unencrypted PKCS#8 or PKCS#1 RSA private key.", { cause: error });
  }
};

const parseAppId = (value: string | undefined): number | null => {
  const parsed = !value?.trim() ? Number.NaN : Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Derive and register a GitHub App public key. Returning a process-style exit
 * code keeps the operational entrypoint testable without stubbing process.exit.
 */
export const runSetupInstance = async (dependencies: SetupInstanceDependencies = {}): Promise<number> => {
  const env = dependencies.env ?? { get: (key: string) => process.env[key] };
  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  const log = dependencies.log ?? console;
  const appId = parseAppId(env.get("APP_ID"));
  const privateKeyRaw = env.get("APP_PRIVATE_KEY");
  const deployToken = env.get("DENO_DEPLOY_TOKEN")?.trim();
  const configuredAiUrl = env.get("UOS_AI_URL")?.trim();
  const aiUrl = stripTrailingSlashes(trimmedEnvOr(configuredAiUrl, DEFAULT_AI_URL));
  const owner = trimmedEnvOr(env.get("UOS_OWNER")?.trim(), "unknown");

  if (appId === null || !privateKeyRaw || !deployToken) {
    log.error("APP_ID, APP_PRIVATE_KEY, and DENO_DEPLOY_TOKEN are required.");
    return 1;
  }

  let publicKeyPem: string;
  try {
    publicKeyPem = await deriveRsaPublicKeyPemFromPrivateKey(privateKeyRaw);
  } catch (error) {
    log.error("Failed to derive public key:", error);
    return 1;
  }

  log.log(`Deriving public key for App ID: ${appId}...`);
  log.log(`Uploading public key to ${aiUrl}...`);

  let response: Response;
  try {
    response = await fetchFn(`${aiUrl}/admin/kernel-pubkeys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deployToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ app_id: appId, pem: publicKeyPem, owner }),
    });
  } catch (error) {
    log.error("Failed to register public key: network request failed.", error);
    return 1;
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    log.error("Failed to register public key: could not read response body.", error);
    return 1;
  }
  if (!response.ok) {
    log.error(`Failed to register public key (status ${response.status}):`);
    log.error(body);
    return 1;
  }

  log.log("Success! Public key registered.");
  if (body) log.log(body);
  return 0;
};

if (import.meta.main) {
  const exitCode = await runSetupInstance();
  process.exitCode = exitCode;
}
