import { copyFile, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runtimePath, selectedRuntime } from "../bun-runtime.ts";
import { digest } from "../io.ts";
import { prepareReleasePayload } from "../release-artifact.ts";

export const repository = fileURLToPath(new URL("../../", import.meta.url));
export const copyOps = async (destination: string): Promise<void> => {
  for (const name of [
    "io.ts",
    "deploy-lock.ts",
    "assert-bun-store.ts",
    "bun-runtime.ts",
    "release-artifact.ts",
    "release-retention.ts",
    "verify-legacy-rollback.ts",
    "macos-sandbox.ts",
  ]) {
    await copyFile(join(repository, "ops", name), join(destination, name));
  }
};
export const seedStore = async (root: string): Promise<void> => {
  await mkdir(join(root, ".data"), { recursive: true });
  const database = new Database(join(root, ".data/kv-bun.sqlite3"));
  try {
    database.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.query("INSERT INTO uos_kv_metadata VALUES (?, ?)").run("codec", "bun-jsc-v1");
  } finally {
    database.close(true);
  }
};
export const copyRuntime = async (root: string): Promise<{ path: string; sha256: string }> => {
  const path = runtimePath(root, selectedRuntime());
  await mkdir(dirname(path), { recursive: true });
  await copyFile(await realpath(process.execPath), path);
  return { path, sha256: digest(await readFile(path)) };
};
/** A minimal local graph, sealed by the production payload builder. */
export const packageFixture = async (release: string, sha: string, archive: string): Promise<void> => {
  await mkdir(join(release, "scripts"), { recursive: true });
  await mkdir(join(release, "src/runtime"), { recursive: true });
  for (const file of ["scripts/build-permissions.ts", "src/runtime/permissions-linux.ts", "src/runtime/permissions-native.c"]) {
    await copyFile(join(repository, file), join(release, file));
  }
  await prepareReleasePayload(release, sha, archive, join(repository, "node_modules/node-api-headers/include"));
};
export const writePackage = async (root: string, imports: Record<string, string>): Promise<void> => {
  const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as { imports: Record<string, string> };
  manifest.imports = imports;
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await copyFile(join(repository, "bun.lock"), join(root, "bun.lock"));
};
export const copyRuntimeModules = async (root: string): Promise<void> => {
  await mkdir(join(root, "src"), { recursive: true });
  await cp(join(repository, "src/runtime"), join(root, "src/runtime"), { recursive: true });
  await cp(join(repository, "src/storage"), join(root, "src/storage"), { recursive: true });
};
