import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";
import { runtimePath, selectedRuntime, verifyRuntimeBinary } from "./bun-runtime.ts";
import { verifyReleasePayload } from "./release-artifact.ts";
import { macSandboxProfile } from "./macos-sandbox.ts";
import { withMacSqliteTemp } from "./mac-sqlite-temp.ts";
import { exists } from "./io.ts";
import { rm } from "node:fs/promises";

const release = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const root = await realpath(join(release, "../../.."));
const mode = process.argv.at(2);
if (!/^.*\/\.data\/releases\/[0-9a-f]{40}$/.test(release) || !["vps", "mac"].includes(mode ?? "")) throw new Error("Invalid immutable service launch layout");
if ((mode === "vps" && process.platform !== "linux") || (mode === "mac" && process.platform !== "darwin"))
  throw new Error("Service launcher platform mismatch");
const manifest = await verifyReleasePayload(release, release.slice(-40));
const artifact = selectedRuntime();
if (manifest.platform !== process.platform || manifest.architecture !== process.arch) throw new Error("Release dependency payload belongs to another platform");
const runtime = runtimePath(root, artifact);
await verifyRuntimeBinary(runtime, artifact);
if ((await realpath(process.execPath)) !== (await realpath(runtime))) throw new Error("The service must run the checksum-pinned Bun binary");
loadEnvFile(join(root, ".env"));
const configuredHome = process.env.CODEX_HOME;
let logicalHome: string;
if (configuredHome !== undefined && configuredHome !== "") logicalHome = configuredHome;
else {
  const suppliedHome = process.env.HOME;
  if (suppliedHome === undefined || suppliedHome === "") throw new Error("HOME or CODEX_HOME is required");
  logicalHome = join(suppliedHome, ".codex");
}
const selectedHome = resolve(logicalHome);
const nativeHome = (await exists(selectedHome)) ? await realpath(selectedHome) : selectedHome;
const logicalControl = join(nativeHome, "app-server-control");
const control = (await exists(logicalControl)) ? await realpath(logicalControl) : logicalControl;
const externalNativeAuth = process.env.HOME ? join(resolve(process.env.HOME), ".codex-ubiquity", "auth.json") : undefined;
await rm(join(root, ".data/legacy-rollback-active.json"), { force: true });
if (mode === "mac") {
  const profile = macSandboxProfile({
    root,
    release,
    runtime,
    nativeHome,
    control,
    ...(externalNativeAuth && (await exists(externalNativeAuth)) ? { externalNativeAuth: await realpath(externalNativeAuth) } : {}),
  });
  await withMacSqliteTemp(root, async (sqliteTemp) => {
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, runtime, "--no-env-file", "--no-install", join(release, "scripts/serve-mac.ts")], {
      cwd: root,
      env: { ...process.env, SQLITE_TMPDIR: sqliteTemp },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const terminate = (): void => {
      child.kill("SIGTERM");
    };
    const interrupt = (): void => {
      child.kill("SIGINT");
    };
    process.once("SIGTERM", terminate);
    process.once("SIGINT", interrupt);
    try {
      process.exitCode = await child.exited;
    } finally {
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
    }
  });
} else {
  const { applyLinuxPermissions } = (await import(pathToFileURL(join(release, "src/runtime/permissions-linux.ts")).href)) as {
    applyLinuxPermissions: (paths: { read: string[]; write: string[]; immutable: string[] }) => unknown;
  };
  const optionalSystem = [
    "/usr/lib",
    "/lib",
    "/lib64",
    "/etc/ssl",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/localtime",
    "/dev/null",
    "/dev/urandom",
    "/dev/random",
    "/proc/self",
  ];
  const system: string[] = [];
  for (const path of optionalSystem) if (await exists(path)) system.push(await realpath(path));
  const nativeRead: string[] = [];
  const nativeWrite: string[] = [];
  if (await exists(nativeHome)) nativeRead.push(nativeHome);
  if (await exists(control)) {
    nativeRead.push(control);
    nativeWrite.push(control);
  }
  applyLinuxPermissions({
    read: [root, release, dirname(runtime), ...nativeRead, ...system],
    write: [join(root, ".data"), ...nativeWrite],
    immutable: [join(root, ".data/releases"), join(root, ".data/runtimes")],
  });
  await import(pathToFileURL(join(release, "scripts/serve-vps.ts")).href);
}
