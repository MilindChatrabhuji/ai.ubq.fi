import { loadWebSocketModule } from "#http";
import type WebSocket from "ws";

/**
 * Read-only JSON-RPC transport for a Codex app-server control socket.
 *
 * The method allowlist is enforced here, in code, so a caller cannot reach a
 * mutating method even by mistake. `initialize` plus the `initialized`
 * notification is the only handshake; nothing else is ever sent.
 */
const READ_ONLY_METHODS = ["initialize", "thread/list", "thread/loaded/list", "thread/read", "thread/turns/list", "account/rateLimits/read"] as const;

type SupervisorMethod = (typeof READ_ONLY_METHODS)[number];

const READ_ONLY_METHOD_SET: ReadonlySet<string> = new Set<string>(READ_ONLY_METHODS);

/** Bounded frame size; a larger frame closes the socket instead of growing memory. */
const SUPERVISOR_MAX_PAYLOAD_BYTES = 1_048_576;

const HANDSHAKE_TIMEOUT_MS = 3_000;
const DEFAULT_CALL_TIMEOUT_MS = 4_000;
const CLOSE_GRACE_MS = 250;

/** One established control-socket connection. Never reused across sampling rounds. */
export type SupervisorConnection = {
  call: (method: SupervisorMethod, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  close: () => Promise<void>;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

type SupervisorSocketOptions = {
  headers: Record<string, string>;
  perMessageDeflate: boolean;
  maxPayload: number;
  handshakeTimeout: number;
};

/** `ws` readyState values (CONNECTING 0, OPEN 1, CLOSING 2, CLOSED 3). */
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSED = 3;

type SupervisorWebSocketConstructor = new (url: string, options: SupervisorSocketOptions) => WebSocket;

const isSupervisorWebSocketConstructor = (value: unknown): value is SupervisorWebSocketConstructor => typeof value === "function";

let webSocketConstructor: SupervisorWebSocketConstructor | null = null;

/**
 * Loads `ws` on first use.
 *
 * Importing it at module scope evaluates `ws/lib/buffer-util.js`, which reads
 * `WS_NO_BUFFER_UTIL` from the environment while the module is being evaluated;
 * repository tests import the handler under a strict env allowlist, so the
 * runtime load belongs inside the connection path that actually needs it. The
 * shared runtime loader resolves the installed pinned package without Bun replacement.
 */
const loadWebSocketConstructor = async (): Promise<SupervisorWebSocketConstructor> => {
  if (webSocketConstructor) return webSocketConstructor;
  const module: unknown = await loadWebSocketModule();
  const candidate = isRecord(module) ? module.default : undefined;
  if (!isSupervisorWebSocketConstructor(candidate)) throw new Error("ws module did not expose a WebSocket constructor");
  webSocketConstructor = candidate;
  return candidate;
};

/**
 * Test-only seam: replaces the lazily loaded constructor so transport cleanup
 * can be exercised without a live socket. Passing null restores lazy loading.
 */
export const setSupervisorWebSocketConstructorForTest = (candidate: unknown): void => {
  webSocketConstructor = isSupervisorWebSocketConstructor(candidate) ? candidate : null;
};

/** Message payloads arrive as Buffer, string, or Buffer[]; only decoded text carries JSON. */
const textOf = (raw: unknown): string => {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (isUnknownArray(raw)) {
    let text = "";
    for (const part of raw) text += textOf(part);
    return text;
  }
  return "";
};

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });

/**
 * Opens one connection to a Codex app-server control socket.
 *
 * Every call carries its own deadline, and `close` performs a clean websocket
 * close before falling back to termination so the daemon never keeps a subscriber.
 */
export const openSupervisorConnection = async (socketPath: string, signal?: AbortSignal): Promise<SupervisorConnection> => {
  if (signal?.aborted) throw new Error("app-server connection aborted");
  const socket = new (await loadWebSocketConstructor())(`ws+unix://${socketPath}:/`, {
    headers: { Host: "localhost" },
    perMessageDeflate: false,
    maxPayload: SUPERVISOR_MAX_PAYLOAD_BYTES,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
  });
  const pending = new Map<number, PendingCall>();
  let serial = 0;
  let closed = false;

  const settle = (id: number, error: Error | null, value?: unknown): void => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    call.cleanup();
    if (error) call.reject(error);
    else call.resolve(value);
  };

  const failPending = (message: string): void => {
    for (const id of [...pending.keys()]) settle(id, new Error(message));
  };

  const handleMessage = (raw: unknown): void => {
    const text = textOf(raw);
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const id = parsed.id;
    if (typeof id !== "number" || !pending.has(id)) return;
    const error = parsed.error;
    if (isRecord(error)) {
      const message = typeof error.message === "string" ? error.message : "app-server returned an error";
      settle(id, new Error(message.slice(0, 400)));
      return;
    }
    settle(id, null, parsed.result);
  };

  socket.on("message", (raw: unknown) => {
    handleMessage(raw);
  });
  socket.on("close", () => {
    failPending("app-server connection closed");
  });
  socket.on("error", () => {
    failPending("app-server connection failed");
  });

  await new Promise<void>((resolve, reject) => {
    let opened = false;
    socket.once("open", () => {
      if (opened) return;
      opened = true;
      resolve();
    });
    socket.once("error", () => {
      if (opened) return;
      opened = true;
      reject(new Error("app-server socket unavailable"));
    });
  });

  const send = (method: string, params: Record<string, unknown>, callSignal?: AbortSignal): Promise<unknown> => {
    if (socket.readyState !== WS_READY_STATE_OPEN) return Promise.reject(new Error("app-server connection unavailable"));
    if (callSignal?.aborted) return Promise.reject(new Error("app-server call aborted"));
    serial += 1;
    const id = serial;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        settle(id, new Error("app-server call aborted"));
      };
      const timer = setTimeout(() => {
        settle(id, new Error("app-server call timed out"));
      }, DEFAULT_CALL_TIMEOUT_MS);
      const cleanup = (): void => callSignal?.removeEventListener("abort", onAbort);
      pending.set(id, { resolve, reject, timer, cleanup });
      callSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        settle(id, new Error("app-server send failed"));
      }
    });
  };

  try {
    await send("initialize", {
      clientInfo: { name: "uos_supervisor", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
  } catch (error) {
    // The caller never receives a connection when the handshake fails, so this
    // exact socket is cleaned up here: pending callbacks and their timers
    // settle, the socket is terminated, and the original failure is rethrown so
    // the caller can report it and attempt a fresh connection later.
    closed = true;
    failPending("app-server connection closed");
    try {
      socket.terminate();
    } catch {
      // A socket that cannot be terminated is already unusable.
    }
    throw error;
  }

  return {
    call: async (method, params = {}, callSignal) => {
      if (!READ_ONLY_METHOD_SET.has(method)) throw new Error("supervisor transport refused a non-read-only method");
      return await send(method, params, callSignal);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      failPending("app-server connection closed");
      if (socket.readyState === WS_READY_STATE_CLOSED) return;
      try {
        socket.close(1000, "supervisor sample complete");
      } catch {
        // The close frame is best effort; the grace period below is the guarantee.
      }
      await sleep(CLOSE_GRACE_MS);
      try {
        // `terminate()` is a no-op on an already closed socket, so no second
        // readyState read is needed after the grace period.
        socket.terminate();
      } catch {
        // A socket that cannot be terminated is already unusable.
      }
    },
  };
};
