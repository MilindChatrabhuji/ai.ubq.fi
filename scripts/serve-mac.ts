import { realpath, lstat } from "node:fs/promises";
import { verifyReleasePayload } from "../ops/release-artifact.ts";
import { nativeKvReleaseBinding } from "../ops/native-kv-release.ts";
import { prepareNativeKvBackend } from "../src/storage/native-addon.ts";
if (process.platform !== "darwin") throw new Error("The Mac service requires macOS");
const release = new URL("../", import.meta.url);
const root = new URL("../../../", release);
const releasePath = await realpath(release);
const manifest = await verifyReleasePayload(releasePath, releasePath.slice(-40));
if (manifest.schema !== 3) throw new Error("The custom native SDK requires immutable release schema 3");
prepareNativeKvBackend(nativeKvReleaseBinding(releasePath, manifest.native_kv));
const { openKv } = await import("#kv");
const { serveHttp } = await import("#http");
for (const name of ["DENO_DEPLOY", "DENO_DEPLOYMENT_ID", "DENO_DEPLOY_BUILD_ID", "DENO_REGION", "DENO_TIMELINE"]) delete process.env[name];
const { runtimeGitSha } = await import(new URL("src/config.ts", release).href);
const gitSha = runtimeGitSha();
if (!/^[0-9a-f]{40}$/.test(gitSha) || !releasePath.endsWith("/releases/" + gitSha))
  throw new Error("The immutable Mac release does not match its Git identity");
process.chdir(root.pathname);
const database = new URL(".data/kv-bun.sqlite3", root);
const info = await lstat(database);
if (!info.isFile() || info.isSymbolicLink()) throw new Error("Convert the Mac KV offline into a marked Bun database before service startup");
const kv = await openKv(database.pathname);
const { initializeKv } = await import(new URL("src/kv.ts", release).href);
initializeKv(kv);
const { application, shutdownOptionalTelemetry, startMacMaintenance } = (await import(new URL("serve.ts", release).href)) as typeof import("../serve.ts");
const { configureAdminAuthPeerForRequest, configureMacLocalAdminAuthBypassForListener } = await import(new URL("src/auth/local-admin.ts", release).href);
const { ensureLocalDevelopmentApiKey } = await import(new URL("src/auth/local-development-key.ts", release).href);
try {
  const status = await ensureLocalDevelopmentApiKey(kv);
  if (status === "created") console.log("[ai.ubq.fi] Provisioned the local development API key for loopback inference.");
  else if (status === "revoked") console.warn("[ai.ubq.fi] The local development API key is revoked; local paid-provider routing stays off.");
} catch (error) {
  console.warn("[ai.ubq.fi] Local development key provisioning failed:", error instanceof Error ? error.message : String(error));
}
const stopMacMaintenance = startMacMaintenance(kv);
const server = serveHttp(
  {
    hostname: "0.0.0.0",
    port: 7999,
    onListen: configureMacLocalAdminAuthBypassForListener,
    upgrade: (request, info) => {
      configureAdminAuthPeerForRequest(info.remoteAddr, request);
      return application.upgrade(request, info);
    },
  },
  (request, info) => {
    configureAdminAuthPeerForRequest(info.remoteAddr, request);
    return application.fetch(request, info);
  }
);
let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  console.log("[ai.ubq.fi] Draining local requests before shutdown");
  void stopMacMaintenance();
  void server.shutdown();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
console.log("[ai.ubq.fi] Mac serving Git revision " + gitSha);
try {
  await server.finished;
} finally {
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
  try {
    await stopMacMaintenance();
    await shutdownOptionalTelemetry();
  } finally {
    kv.close();
  }
}
