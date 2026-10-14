import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type WebSocket from "ws";
import type { NetAddr } from "./http.ts";
import { loadWebSocketModule } from "./websocket.ts";

export type WebSocketUpgrade = Readonly<{
  accept: (socket: WebSocket) => void;
  maxPayloadBytes: number;
  headers?: HeadersInit;
  payloadLimitClose?: Readonly<{ code: number; reason: string }>;
}>;
export type ServeUpgradeHandler = (
  request: Request,
  info: Readonly<{ remoteAddr: NetAddr }>
) => Response | WebSocketUpgrade | Promise<Response | WebSocketUpgrade>;

type UpgradeSocket = Duplex & { remoteAddress?: string; remotePort?: number };
type RequestAdapter = (incoming: IncomingMessage, signal: AbortSignal) => Request;

const refuseUpgrade = async (socket: UpgradeSocket, response: Response): Promise<void> => {
  const body = Buffer.from(await response.arrayBuffer());
  if (socket.destroyed) return;
  const headers = new Headers(response.headers);
  headers.set("content-length", String(body.byteLength));
  headers.set("connection", "close");
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText || "Request Rejected"}`];
  for (const [name, value] of headers) {
    if (name !== "set-cookie") lines.push(`${name}: ${value}`);
  }
  for (const cookie of headers.getSetCookie()) lines.push(`set-cookie: ${cookie}`);
  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.end(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), body]));
  });
};

/** Upgrade authorization finishes before ws writes the switching-protocols reply. */
export const createWebSocketUpgrades = (handler: ServeUpgradeHandler | undefined, requestAdapter: RequestAdapter) => {
  const sockets = new Set<WebSocket>();
  let stopping = false;
  return {
    async upgrade(incoming: IncomingMessage, socket: UpgradeSocket, head: Buffer): Promise<void> {
      const controller = new AbortController();
      const closed = (): void => controller.abort(new Error("WebSocket upgrade disconnected"));
      socket.once("close", closed);
      socket.once("error", closed);
      try {
        const request = requestAdapter(incoming, controller.signal);
        const result =
          !handler || stopping
            ? new Response("WebSocket upgrade unavailable", { status: 426 })
            : await handler(request, {
                remoteAddr: { transport: "tcp", hostname: incoming.socket.remoteAddress ?? "", port: incoming.socket.remotePort ?? 0 },
              });
        if (controller.signal.aborted || socket.destroyed) return;
        if (result instanceof Response) {
          await refuseUpgrade(socket, result);
          return;
        }
        if (stopping) {
          await refuseUpgrade(socket, new Response("Server shutting down", { status: 503 }));
          return;
        }
        const { default: Socket, WebSocketServer } = await loadWebSocketModule();
        const payloadLimitClose = result.payloadLimitClose;
        class PayloadLimitedSocket extends Socket {
          override close(code?: number, reason?: string | Buffer): void {
            // ws invokes a bare 1009 close for its receiver's maxPayload failure.
            // An explicit peer-propagated close retains its original code/reason.
            if (code === 1009 && reason === undefined && payloadLimitClose) {
              super.close(payloadLimitClose.code, payloadLimitClose.reason);
            } else {
              super.close(code, reason);
            }
          }
        }
        const upgradeServer = new WebSocketServer({
          noServer: true,
          clientTracking: false,
          perMessageDeflate: false,
          maxPayload: result.maxPayloadBytes,
          WebSocket: PayloadLimitedSocket,
        });
        if (result.headers) {
          upgradeServer.once("headers", (headers) => {
            const additional = new Headers(result.headers);
            for (const [name, value] of additional) {
              if (name !== "set-cookie") headers.push(`${name}: ${value}`);
            }
            for (const cookie of additional.getSetCookie()) headers.push(`set-cookie: ${cookie}`);
          });
        }
        upgradeServer.handleUpgrade(incoming, socket, head, (webSocket) => {
          sockets.add(webSocket);
          webSocket.on("error", () => {});
          webSocket.once("close", () => sockets.delete(webSocket));
          try {
            result.accept(webSocket);
          } catch {
            webSocket.terminate();
          }
        });
        upgradeServer.close();
      } catch {
        if (!socket.destroyed) await refuseUpgrade(socket, new Response("WebSocket upgrade failed", { status: 500 }));
      } finally {
        socket.removeListener("close", closed);
        socket.removeListener("error", closed);
      }
    },
    async shutdown(): Promise<void> {
      stopping = true;
      await Promise.all(
        [...sockets].map(
          (socket) =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(() => socket.terminate(), 10_000);
              socket.once("close", () => {
                clearTimeout(timer);
                resolve();
              });
              socket.close(1001, "Server shutting down");
            })
        )
      );
    },
  };
};
