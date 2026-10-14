import { statSync, realpathSync, mkdirSync } from "node:fs";
import type { Kv } from "#kv";
import type { ServeDefaultExport } from "#http";
// Benchmark-only gateway instance.
//
// Runs the immutable release selected by the main checkout's `.data/current`
// symlink on loopback port 7998 with an isolated Bun KV
// (`.data/benchmark/kv-bun.sqlite3`). The benchmark runner narrows the provider selection on this instance
// only, so the production Mac gateway on port 7999 never sees benchmark
// routing changes. The instance reads the same root `.env` upstream
// credentials as production because the benchmark measures provider behavior,
// not credential isolation.
//
// Run from the goal lane (the trailing argument enables the loopback-only
// local development principal, exactly as a dev server does):
//   bun benchmarks/provider-waterfall/instance.ts --disable-admin-auth

const PORT = 7998;

const pathExists = (url: URL): boolean => {
  try {
    statSync(url);
    return true;
  } catch {
    return false;
  }
};

/** Walk up from this module until the checkout that owns `.data/current`. */
const findRepoRoot = (): URL => {
  let dir = new URL(".", import.meta.url);
  for (let depth = 0; depth < 8; depth += 1) {
    if (pathExists(new URL(".data/current", dir)) && pathExists(new URL("serve.ts", dir))) return dir;
    dir = new URL("../", dir);
  }
  throw new Error("Could not locate the ai.ubq.fi checkout root from the benchmark instance module");
};

const root = findRepoRoot();
const rootPath = realpathSync(root.pathname);
const releasePath = realpathSync(new URL(".data/current/", root).pathname);
console.log(`[benchmark] repo root ${rootPath}`);
console.log(`[benchmark] release ${releasePath}`);

delete process.env.DENO_DEPLOY;
delete process.env.DENO_DEPLOYMENT_ID;
delete process.env.DENO_DEPLOY_BUILD_ID;
delete process.env.DENO_REGION;
delete process.env.DENO_TIMELINE;

// Share the selected application's runtime graph, including durable-request
// tracking and native KV value identities, instead of the invoking checkout's.
const { openKv } = (await import(`file://${releasePath}/src/storage/kv.ts`)) as Readonly<{ openKv: typeof import("#kv").openKv }>;
const { serveHttp } = (await import(`file://${releasePath}/src/runtime/http.ts`)) as Readonly<{ serveHttp: typeof import("#http").serveHttp }>;

const kvDir = `${rootPath}/.data/benchmark`;
mkdirSync(kvDir, { recursive: true });
const kv = await openKv(`${kvDir}/kv-bun.sqlite3`);
const { initializeKv } = (await import(`file://${releasePath}/src/kv.ts`)) as Readonly<{ initializeKv: (kv: Kv) => void }>;
initializeKv(kv);

type ReleaseServe = Readonly<{
  application: ServeDefaultExport;
  shutdownOptionalTelemetry: () => Promise<void>;
  startMacMaintenance: (kv: Kv) => () => Promise<void>;
}>;

const serve = (await import(`file://${releasePath}/serve.ts`)) as ReleaseServe;
const stopMaintenance = serve.startMacMaintenance(kv);

const server = serveHttp(
  {
    hostname: "127.0.0.1",
    port: PORT,
    onListen(address) {
      serve.application.onListen?.(address);
      console.log(`[benchmark] listening on ${address.hostname}:${address.port} (loopback only)`);
    },
    upgrade: serve.application.upgrade,
  },
  serve.application.fetch
);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  console.log("[benchmark] draining before shutdown");
  void stopMaintenance();
  void server.shutdown();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
await server.finished;
await stopMaintenance();
await serve.shutdownOptionalTelemetry();
kv.close();
process.exit(0);
