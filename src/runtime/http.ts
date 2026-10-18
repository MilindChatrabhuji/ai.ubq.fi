import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createIncomingBody, type IncomingBody } from "./http-body.ts";
import { createRequestTaskDrain } from "./http-tasks.ts";
import { createWebSocketUpgrades, type ServeUpgradeHandler } from "./http-upgrade.ts";

export { trackRequestTask } from "./http-tasks.ts";
export { loadWebSocketModule } from "./websocket.ts";
export type { ServeUpgradeHandler, WebSocketUpgrade } from "./http-upgrade.ts";

export type NetAddr = Readonly<{ transport: "tcp" | "udp"; hostname: string; port: number }>;
export type Addr = NetAddr | Readonly<{ transport: "unix"; path: string }>;
export type ServeHandlerInfo<TAddress extends Addr = Addr> = Readonly<{ remoteAddr: TAddress; completed: Promise<void> }>;
export type ServeHandler<TAddress extends Addr = Addr> = (request: Request, info: ServeHandlerInfo<TAddress>) => Response | Promise<Response>;
export type ServeDefaultExport = Readonly<{ fetch: ServeHandler; onListen?: (address: NetAddr) => void; upgrade?: ServeUpgradeHandler }>;
export type ServeHttpOptions = Readonly<{
  hostname?: string;
  port?: number;
  onListen?: (address: NetAddr) => void;
  signal?: AbortSignal;
  upgrade?: ServeUpgradeHandler;
}>;
export type HttpServer = Readonly<{
  addr: NetAddr;
  ready: Promise<NetAddr>;
  finished: Promise<void>;
  shutdown: () => Promise<void>;
  ref: () => void;
  unref: () => void;
}>;

const interrupted = (): Error => new Error("The client disconnected before its response was sent");
// These external states can change during an awaited stream read.
const responseInterrupted = (outgoing: ServerResponse, signal: AbortSignal): boolean => signal.aborted || outgoing.destroyed;
const requestBodies = new WeakMap<Request, IncomingBody>();

const isAdminRequest = (request: Request | null): boolean => {
  if (!request) return false;
  try {
    const path = new URL(request.url).pathname;
    return path === "/admin" || path === "/admin.html" || path.startsWith("/admin/");
  } catch {
    return false;
  }
};

const incomingHeaders = (incoming: IncomingMessage): Headers => {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name.toLowerCase() === "cookie" && headers.has(name)) headers.set(name, `${headers.get(name)}; ${value}`);
    else headers.append(name, value);
  }
  return headers;
};

const incomingRequest = (incoming: IncomingMessage, signal: AbortSignal): Request => {
  const host = incoming.headers.host ?? "localhost";
  const method = incoming.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers: incomingHeaders(incoming), signal };
  let body: IncomingBody | null = null;
  if (method !== "GET" && method !== "HEAD") {
    body = createIncomingBody(incoming, signal);
    init.body = body.stream;
    init.duplex = "half";
  }
  try {
    const request = new Request(new URL(incoming.url ?? "/", `http://${host}`), init);
    if (body) requestBodies.set(request, body);
    return request;
  } catch (error) {
    body?.dispose();
    throw error;
  }
};

const responseHeaders = (response: Response, outgoing: ServerResponse): void => {
  outgoing.statusCode = response.status;
  if (response.statusText) outgoing.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
};

const waitForDrain = (outgoing: ServerResponse, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      outgoing.removeListener("drain", drain);
      outgoing.removeListener("error", failed);
      outgoing.removeListener("close", closed);
      signal.removeEventListener("abort", closed);
    };
    const drain = (): void => {
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const closed = (): void => {
      failed(interrupted());
    };
    outgoing.once("drain", drain);
    outgoing.once("error", failed);
    outgoing.once("close", closed);
    signal.addEventListener("abort", closed, { once: true });
    if (signal.aborted || outgoing.destroyed) closed();
  });

/** EOF only ends the producer. The separate response finish event owns delivery. */
const sendResponse = async (request: Request, response: Response, outgoing: ServerResponse, signal: AbortSignal): Promise<void> => {
  if (responseInterrupted(outgoing, signal)) {
    void response.body?.cancel(signal.reason).catch(() => {});
    return;
  }
  responseHeaders(response, outgoing);
  const inputBody = requestBodies.get(request);
  if (inputBody && (inputBody.cancelled || !inputBody.consumed)) {
    // Refusals can return without reading input, including after asynchronous
    // authentication/admission. Discard it before handoff and close only after
    // the response is written; an unread paused input otherwise holds shutdown.
    inputBody.dispose();
    outgoing.shouldKeepAlive = false;
    outgoing.setHeader("connection", "close");
  }
  if (!response.body || request.method === "HEAD" || response.status === 204 || response.status === 205 || response.status === 304) {
    void response.body?.cancel().catch(() => {});
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = (): void => {
    // Never await a pending provider pull to handle a disconnected client.
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!responseInterrupted(outgoing, signal)) {
      const chunk = await reader.read();
      if (responseInterrupted(outgoing, signal)) break;
      if (chunk.done) {
        outgoing.end();
        return;
      }
      if (!outgoing.write(chunk.value)) await waitForDrain(outgoing, signal);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (responseInterrupted(outgoing, signal)) cancel();
    reader.releaseLock();
  }
};

export function serveHttp(handler: ServeHandler): HttpServer;
export function serveHttp(options: ServeHttpOptions, handler: ServeHandler): HttpServer;
export function serveHttp(optionsOrHandler: ServeHttpOptions | ServeHandler, suppliedHandler?: ServeHandler): HttpServer {
  const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : suppliedHandler;
  if (!handler) throw new TypeError("An HTTP request handler is required");
  const active = new Set<Promise<void>>();
  const upgrades = createWebSocketUpgrades(options.upgrade, incomingRequest);
  let stopPromise: Promise<void> | null = null;
  let resolveReady: (address: NetAddr) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  let resolveFinished: () => void = () => {};
  let rejectFinished: (error: Error) => void = () => {};
  const ready = new Promise<NetAddr>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // Consumers may wait for only ready or finished; neither rejection is unhandled.
  void ready.catch(() => {});
  void finished.catch(() => {});
  let address: NetAddr = { transport: "tcp", hostname: options.hostname ?? "0.0.0.0", port: options.port ?? 8000 };
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController();
    let resolveCompleted: () => void = () => {};
    let rejectCompleted: (error: Error) => void = () => {};
    let settled = false;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    void completed.catch(() => {});
    const drainTasks = createRequestTaskDrain(completed);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      controller.abort(error);
      rejectCompleted(error);
    };
    const aborted = (): void => {
      fail(interrupted());
    };
    incoming.once("aborted", aborted);
    incoming.once("error", fail);
    outgoing.once("error", fail);
    outgoing.once("close", () => {
      if (!outgoing.writableFinished) aborted();
    });
    outgoing.once("finish", () => {
      if (settled) return;
      settled = true;
      resolveCompleted();
    });
    const task = (async (): Promise<void> => {
      let request: Request | null = null;
      try {
        request = incomingRequest(incoming, controller.signal);
        const response = await handler(request, {
          remoteAddr: { transport: "tcp", hostname: incoming.socket.remoteAddress ?? "", port: incoming.socket.remotePort ?? 0 },
          completed,
        });
        await sendResponse(request, response, outgoing, controller.signal);
      } catch (error) {
        if (outgoing.headersSent || outgoing.destroyed || controller.signal.aborted) {
          fail(error instanceof Error ? error : new Error("HTTP response failed"));
          outgoing.destroy();
        } else {
          outgoing.statusCode = 500;
          if (isAdminRequest(request)) outgoing.setHeader("cache-control", "no-store");
          outgoing.setHeader("content-type", "text/plain; charset=utf-8");
          outgoing.end("Internal Server Error");
        }
      }
      await completed.catch(() => {});
      if (request) {
        requestBodies.get(request)?.dispose();
        requestBodies.delete(request);
      }
      await drainTasks();
      incoming.removeListener("aborted", aborted);
      incoming.removeListener("error", fail);
    })();
    active.add(task);
    void task.finally(() => active.delete(task));
  });
  // Inference has application-owned deadlines. A quiet SSE or pending handler
  // must not inherit Bun.serve's ten-second idle timeout through node:http.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.on("upgrade", (incoming, socket, head) => {
    const task = upgrades.upgrade(incoming, socket, head);
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => {});
  });
  server.once("error", (error: Error) => {
    rejectReady(error);
    rejectFinished(error);
  });
  server.once("close", () => {
    void Promise.allSettled([...active]).then(() => {
      resolveFinished();
    });
  });
  server.listen(address.port, address.hostname, () => {
    const actual = server.address();
    if (!actual || typeof actual === "string") {
      const error = new Error("The HTTP server did not create a TCP listener");
      rejectReady(error);
      rejectFinished(error);
      server.close();
      return;
    }
    address = { transport: "tcp", hostname: actual.address, port: actual.port };
    try {
      options.onListen?.(address);
      resolveReady(address);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("HTTP listener setup failed");
      rejectReady(failure);
      rejectFinished(failure);
      server.close();
    }
  });
  const shutdown = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      await ready;
      server.close();
      server.closeIdleConnections();
      await upgrades.shutdown();
      await finished;
    })();
    return stopPromise;
  };
  const abort = (): void => {
    void shutdown().catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  void finished.finally(() => options.signal?.removeEventListener("abort", abort)).catch(() => {});
  return {
    get addr(): NetAddr {
      const actual = server.address();
      return actual && typeof actual !== "string" ? { transport: "tcp", hostname: actual.address, port: actual.port } : address;
    },
    ready,
    finished,
    shutdown,
    ref: () => {
      server.ref();
    },
    unref: () => {
      server.unref();
    },
  };
}
