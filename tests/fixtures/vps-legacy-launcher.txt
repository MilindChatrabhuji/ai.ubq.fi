// The unit wrapper resolves .data/current once and starts this release's
// launcher, config, import map, and lockfile together; the layout fixes the root.
const release = new URL("../", import.meta.url);
const releasePath = await Deno.realPath(release);
// Keep the database and secrets in the repository root across code updates.
const root = new URL("../../../", release);
Deno.chdir(root);
const { config, runtimeGitSha } = await import(new URL("src/config.ts", release).href);
const { initializeKv } = await import(new URL("src/kv.ts", release).href);
if (config.isDeploy) throw new Error("The VPS entrypoint cannot run in Deno Deploy");
if (!config.adminTokens.size) throw new Error("DENO_DEPLOY_TOKEN must configure administrator authentication");
if (Deno.env.get("DENO_TIMELINE") !== "production") throw new Error("The VPS service requires the production timeline");

const gitSha = runtimeGitSha();
if (!/^[0-9a-f]{40}$/.test(gitSha) || !releasePath.endsWith(`/releases/${gitSha}`)) {
  throw new Error("The immutable release does not match its Git identity");
}

const database = new URL(".data/kv.sqlite3", root);
if (!(await Deno.stat(database)).isFile) {
  throw new Error("Migrate the production KV database before starting the service");
}
const kv = await Deno.openKv(database.pathname);
initializeKv(kv);

const { default: handler, shutdownOptionalTelemetry } = (await import(new URL("serve.ts", release).href)) as typeof import("../serve.ts");
const server = Deno.serve({ hostname: "127.0.0.1", port: 7999, onListen: handler.onListen }, handler.fetch);
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  console.log("[ai.ubq.fi] Draining requests before shutdown");
  void server.shutdown();
};
Deno.addSignalListener("SIGTERM", shutdown);
Deno.addSignalListener("SIGINT", shutdown);
console.log(`[ai.ubq.fi] VPS serving Git revision ${gitSha}`);
await server.finished;
// The bounded optional-analytics drain runs after in-flight work settles and
// before the KV handle closes, so a stalled optional write cannot outlive it.
await shutdownOptionalTelemetry();
kv.close();
Deno.exit(0);
