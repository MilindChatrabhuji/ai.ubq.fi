import type WebSocket from "ws";
import { getString, isRecord } from "../utils.ts";

const WS_PACKAGE = "ws";
const CALL_TIMEOUT_MS = 12_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type SocketConstructor = new (url: string, options: Record<string, unknown>) => WebSocket;

/**
 * Verdict for the daemon's account reply. Managed-auth daemons whose active provider does
 * not require OpenAI auth (a gateway-routed custom provider reports `requiresOpenaiAuth:
 * false`) return no account even though they refresh the home's ChatGPT credentials. That
 * exact shape falls back to the credential-file identity the caller already bound; every
 * other shape must report a matching ChatGPT account.
 */
export const verifyNativeCodexAccount = (
  account: unknown,
  expected: Readonly<{ email: string; accountId: string }>,
  fileAccountId: string | null,
): { ok: true } | { ok: false; detail: string } => {
  const identity = isRecord(account) && isRecord(account.account) ? account.account : null;
  if (identity === null) {
    if (!isRecord(account) || account.requiresOpenaiAuth !== false) {
      return { ok: false, detail: "Native Codex daemon did not report its ChatGPT account" };
    }
    if (fileAccountId === null || fileAccountId !== expected.accountId) {
      return { ok: false, detail: "Native Codex daemon uses a different ChatGPT account" };
    }
    return { ok: true };
  }
  const routing = isRecord(account) && isRecord(account.workspaceRouting) ? account.workspaceRouting : null;
  if (identity.type !== "chatgpt" || getString(identity.email) !== expected.email || getString(routing?.chatgptAccountId) !== expected.accountId) {
    return { ok: false, detail: "Native Codex daemon uses a different ChatGPT account" };
  }
  return { ok: true };
};

const readNativeAccountId = async (codexHome: string): Promise<string | null> => {
  try {
    const raw: unknown = JSON.parse(await Deno.readTextFile(`${codexHome}/auth.json`));
    if (!isRecord(raw) || raw.auth_mode !== "chatgpt" || !isRecord(raw.tokens)) return null;
    return getString(raw.tokens.account_id);
  } catch {
    return null;
  }
};

/** Fixed auth capability; the supervisor's read-only transport stays unchanged. */
export const requestNativeCodexRefresh = async (codexHome: string, expectedEmail: string, expectedAccountId: string): Promise<void> => {
  const module: unknown = await import(WS_PACKAGE);
  const constructor = isRecord(module) ? module.default : null;
  if (typeof constructor !== "function") throw new Error("Native Codex socket transport unavailable");
  const NATIVE_SOCKET = constructor as SocketConstructor;
  const socket = new NATIVE_SOCKET(`ws+unix://${codexHome}/app-server-control/app-server-control.sock:/`, {
    headers: { Host: "localhost" },
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
    handshakeTimeout: 3_000,
  });
  const pending = new Map<number, Pending>();
  let serial = 0;
  const failPending = (): void => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Native Codex socket closed"));
    }
    pending.clear();
  };
  socket.on("message", (raw: unknown) => {
    let value: unknown;
    try {
      const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(value) || typeof value.id !== "number") return;
    const call = pending.get(value.id);
    if (!call) return;
    pending.delete(value.id);
    clearTimeout(call.timer);
    if (value.error !== undefined) call.reject(new Error("Native Codex auth request refused"));
    else call.resolve(value.result);
  });
  socket.on("error", failPending);
  socket.on("close", failPending);
  const call = (method: "initialize" | "account/read", params: Record<string, unknown>): Promise<unknown> => {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Native Codex auth request timed out"));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Native Codex auth request could not be sent"));
      }
    });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => {
        reject(new Error("Native Codex daemon unavailable"));
      });
    });
    const initialized = await call("initialize", { clientInfo: { name: "uos_native_auth", version: "1" }, capabilities: { experimentalApi: true } });
    const serverHome = isRecord(initialized) ? getString(initialized.codexHome) : null;
    if (!serverHome || (await Deno.realPath(serverHome)) !== (await Deno.realPath(codexHome))) {
      throw new Error("Native Codex daemon uses a different credential home");
    }
    socket.send(JSON.stringify({ method: "initialized" }));
    const account = await call("account/read", { refreshToken: false });
    const reportedIdentity = isRecord(account) && isRecord(account.account) ? account.account : null;
    const verification = verifyNativeCodexAccount(
      account,
      { email: expectedEmail, accountId: expectedAccountId },
      reportedIdentity === null ? await readNativeAccountId(codexHome) : null,
    );
    if (!verification.ok) throw new Error(verification.detail);
    // Native Codex ignores the refresh outcome in this reply. The caller must
    // reread and validate the persisted generation before claiming success.
    await call("account/read", { refreshToken: true });
  } finally {
    failPending();
    socket.terminate();
  }
};
