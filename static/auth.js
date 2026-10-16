export const STORAGE_KEYS = {
  rememberToken: "uos_ai.auth.remember_token",
  token: "uos_ai.auth.token",
  passkeyHandle: "uos_ai.auth.passkey_handle",
  passkeyCredentialIds: "uos_ai.auth.passkey_credential_ids",
  base: "uos_ai.admin.base",
};

const LOCAL_BACKEND_BASE = () => globalThis.location?.origin ?? "http://localhost";
const REMOTE_BACKEND_BASE = "https://ai.ubq.fi";

// The dev task injects this token only for its loopback-bound server. Keep the
// browser convenience scoped to HTTP loopback origins so it can never be sent
// automatically to the hosted gateway.
export const LOCAL_DEVELOPMENT_ADMIN_TOKEN = "local-dev-admin";

const isIpv4Loopback = (hostname) => {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const parsed = octets.map((octet) => Number(octet));
  return (
    parsed.every(
      (octet, index) =>
        Number.isInteger(octet) && octet >= 0 && octet <= 255 && String(octet) === octets[index]
    ) && parsed[0] === 127
  );
};

const isIpv6Loopback = (hostname) => hostname === "::1" || hostname === "0:0:0:0:0:0:0:1";

export const isLocalDevelopmentOrigin = () => {
  const location = globalThis.location;
  if (!location || String(location.protocol ?? "").toLowerCase() !== "http:") return false;
  const hostname = String(location.hostname ?? "").toLowerCase();
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return (
    unbracketedHostname === "localhost" ||
    isIpv6Loopback(unbracketedHostname) ||
    isIpv4Loopback(unbracketedHostname)
  );
};

const normalizeBaseChoice = (value) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "local";
  if (normalized === "ai") return "ai";
  if (normalized === "local") return "local";
  if (/^https?:\/\//i.test(normalized)) return normalized.replace(/\/+$/, "");
  return "local";
};

export const resolveBackendBase = (baseUrl = "") => {
  const normalized = normalizeBaseChoice(baseUrl || storage.get(STORAGE_KEYS.base) || "local");
  if (normalized === "ai") return REMOTE_BACKEND_BASE;
  if (normalized === "local") return LOCAL_BACKEND_BASE();
  if (/^https?:\/\//i.test(normalized)) return normalized.replace(/\/+$/, "");
  return LOCAL_BACKEND_BASE();
};

export const buildBackendUrl = (path, baseUrl = "") => {
  return new URL(path, resolveBackendBase(baseUrl)).toString();
};

export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

export const normalizePasskeyHandle = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 96);

const sha256Hex = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const buildPasskeyHandle = async (seed) => {
  const trimmed = seed.trim();
  if (!trimmed) return "";
  return `uos-passkey-${(await sha256Hex(trimmed)).slice(0, 16)}`;
};

export const canUsePasskeyGet = () =>
  Boolean(globalThis.PublicKeyCredential) &&
  Boolean(globalThis.navigator?.credentials) &&
  typeof globalThis.navigator.credentials.get === "function";

export const canUsePasskeyCreate = () =>
  Boolean(globalThis.PublicKeyCredential) &&
  Boolean(globalThis.navigator?.credentials) &&
  typeof globalThis.navigator.credentials.create === "function";

export const getPasskeyUnavailableMessage = (action = "login") => {
  if (!globalThis.isSecureContext) return "Passkeys require HTTPS or localhost.";
  const supported = action === "register" ? canUsePasskeyCreate() : canUsePasskeyGet();
  return supported ? "" : "Passkeys are not available in this browser.";
};

const b64urlToBuf = (b64url) => {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
};

const bufToB64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const loadStoredCredentialIds = () => {
  try {
    const raw = storage.get(STORAGE_KEYS.passkeyCredentialIds);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string" && value) : [];
  } catch {
    return [];
  }
};

export const hasStoredPasskeyCredentials = () => loadStoredCredentialIds().length > 0;

export const hasAuthPasskeyCredential = (auth) => {
  const method = auth?.method;
  if (method?.kind === "passkey_session") return true;
  const count = Number(method?.user?.credential_count ?? auth?.user?.credential_count ?? 0);
  return Number.isFinite(count) && count > 0;
};

export const formatAuthSessionLabel = (auth) => {
  switch (auth?.method?.kind) {
    case "passkey_session":
      return "Passkey signed in";
    case "admin_allowlist":
      return "Fallback token active";
    case "auth_tokens_allowlist":
      return "Allowlist token active";
    case "disabled":
      return "Auth disabled";
    case "deno_deploy_token":
      return "Deno token active";
    case "kv_api_key":
      return "API key active";
    case "github_token":
      return "GitHub token active";
    default:
      return "Token active";
  }
};

export const clearStoredPasskeyMetadata = () => {
  storage.remove(STORAGE_KEYS.passkeyHandle);
  storage.remove(STORAGE_KEYS.passkeyCredentialIds);
};

const storeCredentialId = (credentialId) => {
  if (!credentialId) return;
  const next = new Set(loadStoredCredentialIds());
  next.add(credentialId);
  storage.set(STORAGE_KEYS.passkeyCredentialIds, JSON.stringify([...next]));
};

const apiErrorMessage = (body, fallback) => body?.error?.message ?? body?.error ?? fallback;

const isUnknownPasskeyError = (body) => /unknown passkey/i.test(String(apiErrorMessage(body, "")));

const requestJson = async (baseUrl, path, init) => {
  const endpoint = buildBackendUrl(path, baseUrl);
  const res = await fetch(endpoint, { ...init, credentials: init?.credentials ?? "include" });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
};

const getClientOriginPayload = () => ({ client_origin: globalThis.location.origin });

export const clearCachedAuth = () => {
  storage.remove(STORAGE_KEYS.rememberToken);
  storage.remove(STORAGE_KEYS.token);
};

export const signOut = async ({ baseUrl = "", token = "", corsOrigin = "" } = {}) => {
  const bearer = token.trim();
  const endpoint = new URL(buildBackendUrl("/api/auth/logout", baseUrl));
  if (corsOrigin.trim()) endpoint.searchParams.set("cors_origin", corsOrigin.trim());
  try {
    await fetch(endpoint, {
      method: "POST",
      ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    // Local sign-out still clears cached auth when the network is unavailable.
  }
  clearCachedAuth();
};

const toCreationOptions = (publicKey) => {
  const options = { ...publicKey };
  options.challenge = b64urlToBuf(publicKey.challenge);
  options.user = { ...publicKey.user, id: b64urlToBuf(publicKey.user.id) };
  if (Array.isArray(publicKey.excludeCredentials)) {
    options.excludeCredentials = publicKey.excludeCredentials.map((entry) => ({
      ...entry,
      id: b64urlToBuf(entry.id),
    }));
  }
  return options;
};

const toRequestOptions = (publicKey) => {
  const options = { ...publicKey };
  options.challenge = b64urlToBuf(publicKey.challenge);
  if (Array.isArray(publicKey.allowCredentials) && publicKey.allowCredentials.length > 0) {
    options.allowCredentials = publicKey.allowCredentials.map((entry) => ({
      ...entry,
      id: b64urlToBuf(entry.id),
    }));
  } else {
    delete options.allowCredentials;
  }
  return options;
};

const finishLogin = async (baseUrl, credential) => {
  const res = credential.response;
  const payload = {
    response: {
      id: credential.id,
      rawId: bufToB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufToB64url(res.clientDataJSON),
        authenticatorData: bufToB64url(res.authenticatorData),
        signature: bufToB64url(res.signature),
        userHandle: res.userHandle ? bufToB64url(res.userHandle) : undefined,
      },
    },
  };

  return await requestJson(baseUrl, "/api/auth/login/finish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
};

const finishRegister = async (baseUrl, credential, handle) => {
  const res = credential.response;
  const payload = {
    handle,
    response: {
      id: credential.id,
      rawId: bufToB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufToB64url(res.clientDataJSON),
        attestationObject: bufToB64url(res.attestationObject),
        transports: typeof res.getTransports === "function" ? res.getTransports() : [],
      },
    },
  };

  return await requestJson(baseUrl, "/api/auth/register/finish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
};

export const signInWithPasskey = async ({ handle = "", baseUrl = "", useHandle = false, audienceOrigin = "" } = {}) => {
  const normalizedHandle = normalizePasskeyHandle(handle);
  const unavailable = getPasskeyUnavailableMessage("login");
  if (unavailable) throw new Error(unavailable);

  const clientOriginPayload = getClientOriginPayload();
  const normalizedAudienceOrigin = String(audienceOrigin ?? "").trim();
  const body = {
    ...clientOriginPayload,
    ...(useHandle && normalizedHandle ? { handle: normalizedHandle } : {}),
    ...(normalizedAudienceOrigin ? { relay_origin: normalizedAudienceOrigin } : {}),
  };
  const start = await requestJson(baseUrl, "/api/auth/login/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!start.res.ok || !start.body?.publicKey) {
    throw new Error(start.body?.error?.message ?? start.body?.error ?? "Passkey sign-in failed.");
  }

  const options = toRequestOptions(start.body.publicKey);

  const credential = await globalThis.navigator.credentials.get({ publicKey: options });
  if (!credential) throw new Error("No passkey was returned.");

  const finish = await finishLogin(baseUrl, credential);
  if (!finish.res.ok || (!finish.body?.token && finish.body?.relay_session !== true)) {
    if (isUnknownPasskeyError(finish.body)) clearStoredPasskeyMetadata();
    throw new Error(apiErrorMessage(finish.body, "Passkey sign-in failed."));
  }

  storeCredentialId(credential.id);
  if (finish.body.handle) storage.set(STORAGE_KEYS.passkeyHandle, finish.body.handle);
  return finish.body;
};

export const registerPasskey = async ({ handle = "", token = "", baseUrl = "" }) => {
  const adminToken = token.trim();
  const normalizedHandle = normalizePasskeyHandle(handle);
  const unavailable = getPasskeyUnavailableMessage("register");
  if (unavailable) throw new Error(unavailable);

  const headers = { "content-type": "application/json" };
  if (adminToken) headers.authorization = `Bearer ${adminToken}`;
  const body = normalizedHandle ? { ...getClientOriginPayload(), handle: normalizedHandle } : getClientOriginPayload();
  const start = await requestJson(baseUrl, "/api/auth/register/start", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (start.res.status === 401 && !adminToken) {
    throw new Error("Sign in first, or use the fallback admin token to register this device.");
  }
  if (!start.res.ok || !start.body?.publicKey) {
    throw new Error(start.body?.error?.message ?? start.body?.error ?? "Passkey registration failed.");
  }

  const resolvedHandle = normalizePasskeyHandle(start.body.handle) || normalizedHandle;
  if (!resolvedHandle) throw new Error("Username is required.");

  const options = toCreationOptions(start.body.publicKey);
  const credential = await globalThis.navigator.credentials.create({ publicKey: options });
  if (!credential) throw new Error("No passkey was returned.");

  const finish = await finishRegister(baseUrl, credential, resolvedHandle);
  if (!finish.res.ok || !finish.body?.token) {
    throw new Error(finish.body?.error?.message ?? finish.body?.error ?? "Passkey registration failed.");
  }

  storeCredentialId(credential.id);
  storage.set(STORAGE_KEYS.passkeyHandle, finish.body.handle ?? resolvedHandle);
  return finish.body;
};
