// Kernel attestation verification, split out of src/auth.ts.

import { openaiError } from "../http.ts";
import { getKv } from "../kv.ts";
import { getString, isRecord, sha256Base64Url } from "../utils.ts";

const getEnv = (key: string): string | undefined => {
  try {
    return process.env[key];
  } catch {
    return undefined;
  }
};

const normalizePemValue = (raw: string): string => raw.trim().replace(/\\n/g, "\n");

const extractPemBlocks = (raw: string, begin: string, end: string): string[] => {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(begin, cursor);
    if (start === -1) break;
    const finish = raw.indexOf(end, start);
    if (finish === -1) break;
    blocks.push(raw.slice(start, finish + end.length).trim());
    cursor = finish + end.length;
  }
  return blocks;
};

const UOS_KERNEL_PUBKEYS_KEY = ["uos_ai", "kernel_pubkeys"];

const getKernelPublicKeyPems = async (): Promise<string[]> => {
  const envRaw = (getEnv("UOS_AI_KERNEL_PUBLIC_KEY") ?? "").trim();
  const tokens: string[] = [];

  if (envRaw) {
    const normalized = normalizePemValue(envRaw);
    const blocks = extractPemBlocks(normalized, "-----BEGIN PUBLIC KEY-----", "-----END PUBLIC KEY-----");
    if (blocks.length > 0) {
      tokens.push(...blocks);
    } else {
      tokens.push(normalized);
    }
  }

  const kv = await getKv();
  if (kv) {
    const kvEntry = await kv.get<{ pem: string }[]>(UOS_KERNEL_PUBKEYS_KEY);
    if (kvEntry.value) {
      tokens.push(...kvEntry.value.map((p) => p.pem));
    }
  }

  return tokens;
};

const importRsaPublicKey = async (publicKeyPem: string): Promise<CryptoKey> => {
  const pemContents = publicKeyPem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").trim().replace(/\s+/g, "");

  const binary = atob(pemContents);
  const binaryDer: Uint8Array<ArrayBuffer> = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) binaryDer[i] = binary.charCodeAt(i);
  return await crypto.subtle.importKey("spki", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
};

const KERNEL_PUBLIC_KEYS_REFRESH_MS = 60_000;

let kernelPublicKeysPromise: Promise<readonly CryptoKey[]> | null = null;
let kernelPublicKeysLoadedAtMs = 0;

const loadKernelPublicKeys = async (): Promise<readonly CryptoKey[]> => {
  const pems = await getKernelPublicKeyPems();
  const keys: CryptoKey[] = [];
  for (const pem of pems) {
    try {
      keys.push(await importRsaPublicKey(pem));
    } catch (error) {
      console.error("[ai.ubq.fi] Failed to import kernel public key:", error);
    }
  }
  return keys;
};

const getKernelPublicKeys = (forceReload = false): Promise<readonly CryptoKey[]> => {
  const now = Date.now();
  if (!forceReload && kernelPublicKeysPromise && now - kernelPublicKeysLoadedAtMs < KERNEL_PUBLIC_KEYS_REFRESH_MS) {
    return kernelPublicKeysPromise;
  }
  kernelPublicKeysPromise = (async () => {
    const keys = await loadKernelPublicKeys();
    kernelPublicKeysLoadedAtMs = Date.now();
    return keys;
  })();
  return kernelPublicKeysPromise;
};

export const reloadKernelPublicKeys = async (): Promise<void> => {
  await getKernelPublicKeys(true);
};

const decodeBase64UrlToBytes = (raw: string): Uint8Array<ArrayBuffer> => {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const decodeBase64UrlToJson = (raw: string): unknown => {
  const bytes = decodeBase64UrlToBytes(raw);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
};

type KernelAttestationPayload = Readonly<{
  iss: "ubiquity-os-kernel";
  aud: "ai.ubq.fi";
  iat: number;
  exp: number;
  jti: string;
  owner: string;
  repo: string;
  installation_id: number | null;
  auth_token_sha256: string;
  state_id: string;
}>;

const parseKernelAttestationPayload = (value: unknown): KernelAttestationPayload | null => {
  if (!isRecord(value)) return null;

  const iss = getString(value.iss);
  const aud = getString(value.aud);
  const jti = getString(value.jti);
  const owner = getString(value.owner);
  const repo = getString(value.repo);
  const authTokenSha = getString(value.auth_token_sha256);
  const stateId = getString(value.state_id);

  const iat = typeof value.iat === "number" && Number.isFinite(value.iat) ? Math.trunc(value.iat) : null;
  const exp = typeof value.exp === "number" && Number.isFinite(value.exp) ? Math.trunc(value.exp) : null;
  if (iat === null || exp === null) return null;

  const installationIdValue = value.installation_id;
  let installationId: number | null = null;
  if (installationIdValue !== null && typeof installationIdValue === "number" && Number.isFinite(installationIdValue)) {
    installationId = Math.trunc(installationIdValue);
  }
  if (installationIdValue !== null && installationId === null) return null;

  if (iss !== "ubiquity-os-kernel") return null;
  if (aud !== "ai.ubq.fi") return null;
  if (!jti || !owner || !repo || !authTokenSha || !stateId) return null;

  return {
    iss: "ubiquity-os-kernel",
    aud: "ai.ubq.fi",
    iat,
    exp,
    jti,
    owner,
    repo,
    installation_id: installationId,
    auth_token_sha256: authTokenSha,
    state_id: stateId,
  };
};

const KERNEL_ATTESTATION_CLOCK_SKEW_SECONDS = 60;
const KERNEL_ATTESTATION_MAX_TTL_SECONDS = 60 * 60;

type KernelAttestationFailure = { ok: false; response: Response };

const kernelAttestationClockFailure = (payload: KernelAttestationPayload, now: number): KernelAttestationFailure | null => {
  if (payload.exp < payload.iat) {
    return {
      ok: false,
      response: openaiError(401, `Unauthorized: kernel attestation 'exp' (${payload.exp}) is before 'iat' (${payload.iat})`, "invalid_kernel_token"),
    };
  }
  if (payload.exp - payload.iat > KERNEL_ATTESTATION_MAX_TTL_SECONDS) {
    return {
      ok: false,
      response: openaiError(
        401,
        `Unauthorized: kernel attestation TTL is too long (${payload.exp - payload.iat}s > ${KERNEL_ATTESTATION_MAX_TTL_SECONDS}s)`,
        "invalid_kernel_token"
      ),
    };
  }
  if (payload.iat > now + KERNEL_ATTESTATION_CLOCK_SKEW_SECONDS) {
    return {
      ok: false,
      response: openaiError(401, `Unauthorized: kernel attestation 'iat' (${payload.iat}) is in the future (server now: ${now})`, "invalid_kernel_token"),
    };
  }
  if (payload.exp < now - KERNEL_ATTESTATION_CLOCK_SKEW_SECONDS) {
    return {
      ok: false,
      response: openaiError(401, `Unauthorized: kernel attestation 'exp' (${payload.exp}) is in the past (server now: ${now})`, "invalid_kernel_token"),
    };
  }
  return null;
};

const kernelAttestationRepoFailure = (
  payload: KernelAttestationPayload,
  owner: string | null | undefined,
  repo: string | null | undefined
): KernelAttestationFailure | null => {
  const expectedOwner = typeof owner === "string" ? owner.trim() : "";
  const expectedRepo = typeof repo === "string" ? repo.trim() : "";
  if (expectedOwner && expectedRepo && (payload.owner !== expectedOwner || payload.repo !== expectedRepo)) {
    return {
      ok: false,
      response: openaiError(
        401,
        `Unauthorized: kernel attestation repo mismatch. Expected '${expectedOwner}/${expectedRepo}', got '${payload.owner}/${payload.repo}'`,
        "invalid_kernel_token"
      ),
    };
  }
  return null;
};

const kernelAttestationInstallationFailure = (req: Request, payload: KernelAttestationPayload): KernelAttestationFailure | null => {
  if (payload.installation_id === null) return null;
  const installationId = parseInstallationIdHeader(req);
  if (installationId === null) {
    return {
      ok: false,
      response: openaiError(
        401,
        "Unauthorized: missing 'X-GitHub-Installation-Id' header, required for kernel attestation verification",
        "missing_installation_id"
      ),
    };
  }
  if (payload.installation_id !== installationId) {
    return {
      ok: false,
      response: openaiError(
        401,
        `Unauthorized: kernel attestation installation_id mismatch. Expected '${installationId}', got '${payload.installation_id}'`,
        "invalid_kernel_token"
      ),
    };
  }
  return null;
};

const parseKernelAttestationParts = (
  parts: readonly string[]
): { ok: true; header: unknown; payload: KernelAttestationPayload | null } | KernelAttestationFailure => {
  try {
    return {
      ok: true,
      header: decodeBase64UrlToJson(parts[0]),
      payload: parseKernelAttestationPayload(decodeBase64UrlToJson(parts[1])),
    };
  } catch (err) {
    return {
      ok: false,
      response: openaiError(
        401,
        `Unauthorized: failed to parse kernel attestation JWT parts: ${err instanceof Error ? err.message : String(err)}`,
        "invalid_kernel_token"
      ),
    };
  }
};

const kernelAttestationSignatureFailure = async (parts: readonly string[], keys: readonly CryptoKey[]): Promise<KernelAttestationFailure | null> => {
  const signingInput = `${parts[0]}.${parts[1]}`;
  const dataArray = new TextEncoder().encode(signingInput) as Uint8Array<ArrayBuffer>;
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = decodeBase64UrlToBytes(parts[2]);
  } catch (err) {
    return {
      ok: false,
      response: openaiError(
        401,
        `Unauthorized: failed to decode kernel attestation signature: ${err instanceof Error ? err.message : String(err)}`,
        "invalid_kernel_token"
      ),
    };
  }

  const verifySignature = async (candidateKeys: readonly CryptoKey[]): Promise<boolean> => {
    for (const key of candidateKeys) {
      try {
        const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes, dataArray);
        if (ok) return true;
      } catch {
        // ignore and try next key
      }
    }
    return false;
  };

  let signatureValid = await verifySignature(keys);
  if (!signatureValid) {
    const refreshedKeys = await getKernelPublicKeys(true);
    if (refreshedKeys.length === 0) {
      return {
        ok: false,
        response: openaiError(
          500,
          "Server misconfigured: No kernel public keys loaded. Set 'UOS_AI_KERNEL_PUBLIC_KEY' or use admin endpoints to add pubkeys.",
          "server_error"
        ),
      };
    }
    signatureValid = await verifySignature(refreshedKeys);
  }
  if (!signatureValid) {
    return {
      ok: false,
      response: openaiError(401, "Unauthorized (invalid kernel attestation)", "invalid_kernel_token"),
    };
  }
  return null;
};

const parseInstallationIdHeader = (req: Request): number | null => {
  const raw = (req.headers.get("X-GitHub-Installation-Id") ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
};

const kernelTokenJtiCache = new Map<string, number>();

const pruneKernelTokenJtiCache = () => {
  const now = Date.now();
  for (const [jti, expiresAtMs] of kernelTokenJtiCache.entries()) {
    if (expiresAtMs <= now) kernelTokenJtiCache.delete(jti);
  }
};

const verifyKernelAttestation = async (
  req: Request,
  { token, owner, repo }: { token: string; owner?: string | null; repo?: string | null }
): Promise<{ ok: true; payload: KernelAttestationPayload } | { ok: false; response: Response }> => {
  const kernelToken = (req.headers.get("X-Ubiquity-Kernel-Token") ?? "").trim();
  if (!kernelToken) {
    return {
      ok: false,
      response: openaiError(401, "Unauthorized: missing 'X-Ubiquity-Kernel-Token' header for kernel attestation", "missing_kernel_token"),
    };
  }

  const keys = await getKernelPublicKeys();
  if (keys.length === 0) {
    return {
      ok: false,
      response: openaiError(
        500,
        "Server misconfigured: No kernel public keys loaded. Set 'UOS_AI_KERNEL_PUBLIC_KEY' or use admin endpoints to add pubkeys.",
        "server_error"
      ),
    };
  }

  const parts = kernelToken.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      response: openaiError(401, "Unauthorized: kernel attestation JWT MUST have 3 parts (header, payload, signature)", "invalid_kernel_token"),
    };
  }

  const parsed = parseKernelAttestationParts(parts);
  if (!parsed.ok) return parsed;
  const { header, payload } = parsed;

  // The diagnostic keeps the original shape: a JSON scalar renders the way plain
  // interpolation would, and a non-record header renders 'undefined'.
  const headerAlgorithm: unknown = isRecord(header) ? header.alg : "undefined";
  if (getString(headerAlgorithm) !== "RS256") {
    return {
      ok: false,
      response: openaiError(
        401,
        `Unauthorized: kernel attestation JWT 'alg' MUST be 'RS256', got '${typeof headerAlgorithm === "string" ? headerAlgorithm : JSON.stringify(headerAlgorithm)}'`,
        "invalid_kernel_token"
      ),
    };
  }

  if (!payload) {
    return {
      ok: false,
      response: openaiError(401, "Unauthorized: kernel attestation JWT payload is invalid or fields are missing/type-mismatched", "invalid_kernel_token"),
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const clockFailure = kernelAttestationClockFailure(payload, now);
  if (clockFailure) return clockFailure;

  const repoFailure = kernelAttestationRepoFailure(payload, owner, repo);
  if (repoFailure) return repoFailure;

  const installationFailure = kernelAttestationInstallationFailure(req, payload);
  if (installationFailure) return installationFailure;

  const expectedTokenSha = await sha256Base64Url(token);
  if (payload.auth_token_sha256 !== expectedTokenSha) {
    return {
      ok: false,
      response: openaiError(
        401,
        "Unauthorized: kernel attestation 'auth_token_sha256' mismatch. Verify kernel is hashing the current 'authToken'.",
        "invalid_kernel_token"
      ),
    };
  }

  const signatureFailure = await kernelAttestationSignatureFailure(parts, keys);
  if (signatureFailure) return signatureFailure;

  pruneKernelTokenJtiCache();
  // This token is expected to be re-used within its TTL (e.g. Codex tool-calling
  // results in multiple /v1/responses requests). Enforcing single-use "jti"
  // semantics breaks legitimate traffic and is unreliable in serverless anyway.
  kernelTokenJtiCache.set(payload.jti, payload.exp * 1000);

  return { ok: true, payload };
};

const getGitHubRepoHeaders = (req: Request): { owner: string; repo: string } | null => {
  const owner = (req.headers.get("X-GitHub-Owner") ?? "").trim();
  const repo = (req.headers.get("X-GitHub-Repo") ?? "").trim();
  if (!owner || !repo) return null;
  return { owner, repo };
};

export const getKernelAttestationContext = async (req: Request, token: string | null): Promise<{ owner: string; repo: string } | null> => {
  if (!token) return null;
  const kernelToken = (req.headers.get("X-Ubiquity-Kernel-Token") ?? "").trim();
  if (!kernelToken) return null;
  const repoHeaders = getGitHubRepoHeaders(req);
  const attestation = await verifyKernelAttestation(req, {
    token,
    owner: repoHeaders?.owner,
    repo: repoHeaders?.repo,
  });
  if (!attestation.ok) return null;
  return { owner: attestation.payload.owner, repo: attestation.payload.repo };
};

export { getEnv, getGitHubRepoHeaders, verifyKernelAttestation };
