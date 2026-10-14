import { setKvForTest } from "../../src/kv.ts";
import type { Kv, KvEntry, KvEntryMaybe, KvKey, KvListOptions, KvListSelector } from "#kv";
// Shared harness for this suite, moved out of the original test file.

// Removes every trailing `=`, equivalent to `value.replace(/=+$/g, "")` with an
// explicit linear scan (same idiom as tests/codex-account-email.test.ts and
// `normalizePath` in src/handler.ts:169).
const stripBase64Padding = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "=") end -= 1;
  return value.slice(0, end);
};

// Base64url encoding of `value`.
const encodeBase64Url = (value: string): string => stripBase64Padding(btoa(value)).replace(/\+/g, "-").replace(/\//g, "_");

const keyToString = (key: KvKey): string => JSON.stringify(key);
// `String(input)` cannot render every accepted `RequestInfo` shape as a request URL:
// a `Request` stringifies to "[object Request]". The fetch stubs below assert on
// exact request URLs, so each accepted form is normalised to its URL string.
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};
// `AbortSignal.reason` is untyped, so a caller can abort with an arbitrary value. A
// promise rejection must carry an `Error`: when the reason already is one it is
// passed through unchanged, otherwise it is preserved as the abort error's `cause`
// instead of being rejected verbatim.
const abortError = (reason: unknown): Error => {
  if (reason instanceof Error) return reason;
  const error = new Error("Aborted", { cause: reason });
  error.name = "AbortError";
  return error;
};
const kvVersions = new Map<string, number>();
let beforeAtomicCommit: (() => void) | null = null;

export const setBeforeAtomicCommit = (value: typeof beforeAtomicCommit): void => {
  beforeAtomicCommit = value;
};
let kvGetDelayMs = 0;

export const setKvGetDelayMs = (value: typeof kvGetDelayMs): void => {
  kvGetDelayMs = value;
};

class KvTestStore extends Map<string, unknown> {
  override set(key: string, value: unknown): this {
    kvVersions.set(key, (kvVersions.get(key) ?? 0) + 1);
    return super.set(key, value);
  }

  override clear(): void {
    beforeAtomicCommit = null;
    kvGetDelayMs = 0;
    kvVersions.clear();
    super.clear();
  }
}

const kvStore = new KvTestStore();
const versionstampFor = (rawKey: string): string | null => (kvStore.has(rawKey) ? String(kvVersions.get(rawKey) ?? 0).padStart(20, "0") : null);

const kvStub = {
  get: async (key: KvKey) => {
    if (kvGetDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, kvGetDelayMs));
    const rawKey = keyToString(key);
    return {
      key,
      value: kvStore.has(rawKey) ? kvStore.get(rawKey) : null,
      versionstamp: versionstampFor(rawKey),
    } as KvEntryMaybe<unknown>;
  },
  set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
    kvStore.set(keyToString(key), value);
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: function* (selector: KvListSelector, options?: KvListOptions) {
    const prefix = "prefix" in selector ? selector.prefix : [];
    let yielded = 0;
    const limit = typeof options?.limit === "number" ? options.limit : Infinity;
    for (const [rawKey, value] of kvStore.entries()) {
      const key = JSON.parse(rawKey) as KvKey;
      const matchesPrefix = prefix.every((part, index) => key[index] === part);
      if (!matchesPrefix) continue;
      yield { key, value, versionstamp: "00000000000000010000" } as KvEntry<unknown>;
      yielded += 1;
      if (yielded >= limit) break;
    }
  },
  atomic: () => {
    const ops: { type: "set" | "delete"; key: KvKey; value?: unknown }[] = [];
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const chain = {
      check: (check: { key: KvKey; versionstamp: string | null }) => {
        checks.push(check);
        return chain;
      },
      set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
        ops.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        beforeAtomicCommit?.();
        beforeAtomicCommit = null;
        for (const check of checks) {
          if (versionstampFor(keyToString(check.key)) !== check.versionstamp) {
            return Promise.resolve({ ok: false } as const);
          }
        }
        for (const op of ops) {
          if (op.type === "set") kvStore.set(keyToString(op.key), op.value);
          else kvStore.delete(keyToString(op.key));
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

const {
  PASSKEY_MAX_REQUEST_BODY_BYTES,
  PASSKEY_RELAY_COOKIE_NAME,
  PASSKEY_SESSION_TTL_MS,
  buildPasskeyHandle,
  getPasskeyRequestMeta,
  getPasskeySessionForRequest,
  handlePasskeyLoginFinish,
  handlePasskeyLoginStart,
  handlePasskeyLogout,
  handlePasskeyRegisterFinish,
  handlePasskeyRegisterStart,
  handlePasskeySession,
  handlePasskeyUsersList,
  handlePasskeyUsersUpdate,
  hasPasskeyUsers,
  normalizePasskeyHandle,
  passkeyChallengeKey,
  passkeyCredentialKey,
  passkeyHandleKey,
  passkeySessionKey,
  passkeyUserKey,
  saveVerifiedPasskeyRegistration,
  updatePasskeyCredentialSignCount,
} = await import("../../src/auth/passkeys.ts");
const { authenticateAdmin, authenticateClient, handleV1Auth, requireAdminAuth } = await import("../../src/auth/index.ts");
const { config } = await import("../../src/config.ts");
const { METERED_QUOTA_FRESH_MS, METERED_QUOTA_STATE_KEY } = await import("../../src/metered-quota.ts");

const withEnv = async (updates: Record<string, string | null>, fn: () => Promise<void>): Promise<void> => {
  const previous = new Map(Object.keys(updates).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const seedPasskeySession = (token = "uos_ai_session_test", { isAdmin = true, audienceOrigin = "" }: { isAdmin?: boolean; audienceOrigin?: string } = {}) => {
  const now = Date.now();
  const user = {
    id: "user-test",
    handle: "uos-passkey-test",
    is_admin: isAdmin,
    credential_ids: ["credential-test"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(user.id)), user);
  kvStore.set(keyToString(passkeyHandleKey(user.handle)), user.id);
  kvStore.set(keyToString(passkeySessionKey(token)), {
    token,
    user_id: user.id,
    created_at_ms: now,
    expires_at_ms: now + PASSKEY_SESSION_TTL_MS,
    ...(audienceOrigin ? { audience_origin: audienceOrigin } : {}),
  });
  return { token, user };
};

export {
  KvTestStore,
  METERED_QUOTA_FRESH_MS,
  METERED_QUOTA_STATE_KEY,
  PASSKEY_MAX_REQUEST_BODY_BYTES,
  PASSKEY_RELAY_COOKIE_NAME,
  PASSKEY_SESSION_TTL_MS,
  abortError,
  authenticateAdmin,
  authenticateClient,
  beforeAtomicCommit,
  buildPasskeyHandle,
  config,
  encodeBase64Url,
  getPasskeyRequestMeta,
  getPasskeySessionForRequest,
  handlePasskeyLoginFinish,
  handlePasskeyLoginStart,
  handlePasskeyLogout,
  handlePasskeyRegisterFinish,
  handlePasskeyRegisterStart,
  handlePasskeySession,
  handlePasskeyUsersList,
  handlePasskeyUsersUpdate,
  handleV1Auth,
  hasPasskeyUsers,
  keyToString,
  kvGetDelayMs,
  kvStore,
  kvStub,
  kvVersions,
  normalizePasskeyHandle,
  passkeyChallengeKey,
  passkeyCredentialKey,
  passkeyHandleKey,
  passkeySessionKey,
  passkeyUserKey,
  requestUrl,
  requireAdminAuth,
  saveVerifiedPasskeyRegistration,
  seedPasskeySession,
  stripBase64Padding,
  updatePasskeyCredentialSignCount,
  versionstampFor,
  withEnv,
};

/** Reinstall this fixture explicitly when a Bun test file uses the cached harness. */
export const installHarness = (): void => {
  setKvForTest(kvStub);
};
export const resetHarness = (): void => {
  kvStore.clear();
  installHarness();
};
export const cleanupHarness = (): void => {
  setKvForTest(null);
};
