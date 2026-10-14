import { realpath, lstat } from "node:fs/promises";
import { verifyReleasePayload } from "../ops/release-artifact.ts";
import { nativeKvReleaseBinding } from "../ops/native-kv-release.ts";
import { prepareNativeKvBackend } from "../src/storage/native-addon.ts";
const release = new URL("../", import.meta.url);
const releasePath = await realpath(release);
const manifest = await verifyReleasePayload(releasePath, releasePath.slice(-40));
if (manifest.schema !== 3) throw new Error("The custom native SDK requires immutable release schema 3");
prepareNativeKvBackend(nativeKvReleaseBinding(releasePath, manifest.native_kv));
const { openKv } = await import("#kv");
const { serveHttp } = await import("#http");
const root = new URL("../../../", release);
process.chdir(root.pathname);
const { config, runtimeGitSha } = await import(new URL("src/config.ts", release).href);
const { initializeKv } = await import(new URL("src/kv.ts", release).href);
if (config.isDeploy) throw new Error("The VPS entrypoint cannot run in Deno Deploy");
if (!config.adminTokens.size) throw new Error("DENO_DEPLOY_TOKEN must configure administrator authentication");
if (process.env.DENO_TIMELINE !== "production") throw new Error("The VPS service requires the production timeline");
const gitSha = runtimeGitSha();
if (!/^[0-9a-f]{40}$/.test(gitSha) || !releasePath.endsWith("/releases/" + gitSha)) throw new Error("The immutable release does not match its Git identity");
const database = new URL(".data/kv-bun.sqlite3", root);
const info = await lstat(database);
if (!info.isFile() || info.isSymbolicLink()) throw new Error("Convert the production KV offline into a marked Bun database before service startup");
const kv = await openKv(database.pathname);
initializeKv(kv);
const { application, shutdownOptionalTelemetry } = (await import(new URL("serve.ts", release).href)) as typeof import("../serve.ts");
const server = serveHttp({ hostname: "127.0.0.1", port: 7999, onListen: application.onListen, upgrade: application.upgrade }, application.fetch);
let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  console.log("[ai.ubq.fi] Draining requests before shutdown");
  void server.shutdown();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
console.log("[ai.ubq.fi] VPS serving Git revision " + gitSha);
try {
  await server.finished;
} finally {
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
  try {
    await shutdownOptionalTelemetry();
  } finally {
    kv.close();
  }
}
