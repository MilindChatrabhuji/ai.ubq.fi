import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

type WebSocketModule = Readonly<{ default: typeof WebSocket; WebSocketServer: typeof WebSocketServer }>;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
let modulePromise: Promise<WebSocketModule> | null = null;

/** Bun replaces bare ws imports, including when the exact npm package is installed.
 * Resolve its supported package.json export and load the package's declared ESM
 * target so Unix sockets, handshake limits and receiver limits use pinned ws.
 */
const loadInstalledWebSocketModule = async (): Promise<WebSocketModule> => {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("ws/package.json");
  const metadata: unknown = require("ws/package.json");
  const exports = isRecord(metadata) && isRecord(metadata.exports) ? metadata.exports : null;
  const rootExport = exports && isRecord(exports["."]) ? exports["."] : null;
  const entry = rootExport && typeof rootExport.import === "string" ? rootExport.import : null;
  if (!entry?.startsWith("./")) throw new Error("The installed ws package has no supported ESM entry");
  const module: unknown = await import(pathToFileURL(resolve(dirname(packagePath), entry)).href);
  if (!isRecord(module) || typeof module.default !== "function" || typeof module.WebSocketServer !== "function") {
    throw new Error("The installed ws package does not expose its socket constructors");
  }
  return { default: module.default as typeof WebSocket, WebSocketServer: module.WebSocketServer as typeof WebSocketServer };
};

export const loadWebSocketModule = (): Promise<WebSocketModule> => (modulePromise ??= loadInstalledWebSocketModule());
