import { copyFile, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runtimePath, selectedRuntime } from "../bun-runtime.ts";
import { digest } from "../io.ts";
import { prepareReleasePayload } from "../release-artifact.ts";
import { currentTestNativeKvBinding } from "../../scripts/test-native-kv.ts";

export const repository = fileURLToPath(new URL("../../", import.meta.url));
export const copyOps = async (destination: string): Promise<void> => {
  for (const name of [
    "io.ts",
    "deploy-lock.ts",
    "deploy-lock-bun.ts",
    "assert-bun-store.ts",
    "bun-runtime.ts",
    "release-artifact.ts",
    "native-kv-release.ts",
    "release-retention.ts",
    "verify-legacy-rollback.ts",
    "runtime-bunfig.toml",
    "macos-sandbox.ts",
    "mac-sqlite-temp.ts",
  ]) {
    if (["native-kv-release.ts", "assert-bun-store.ts"].includes(name) && !destination.endsWith("/ops")) {
      const source = (await readFile(join(repository, "ops", name), "utf8"))
        .replaceAll('from "../src/', 'from "./src/')
        .replaceAll('from "../scripts/', 'from "./scripts/');
      await writeFile(join(destination, name), source);
    } else {
      await copyFile(join(repository, "ops", name), join(destination, name));
    }
  }
  if (!destination.endsWith("/ops")) {
    await copyRuntimeModules(destination);
    await mkdir(join(destination, "scripts"), { recursive: true });
    await copyFile(join(repository, "scripts/build-native-kv.ts"), join(destination, "scripts/build-native-kv.ts"));
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
  await mkdir(join(release, "tools"), { recursive: true });
  await cp(join(repository, "tools/native-kv"), join(release, "tools/native-kv"), { recursive: true });
  await prepareReleasePayload(
    release,
    sha,
    archive,
    join(repository, "node_modules/node-api-headers/include"),
    currentTestNativeKvBinding(),
    join(repository, "node_modules")
  );
};
export const writePackage = async (root: string, imports: Record<string, string>): Promise<void> => {
  const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as {
    name: string;
    imports: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    patchedDependencies?: Record<string, string>;
  };
  manifest.imports = imports;
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await copyFile(join(repository, "bun.lock"), join(root, "bun.lock"));
};
export const copyRuntimeModules = async (root: string): Promise<void> => {
  await mkdir(join(root, "src"), { recursive: true });
  await cp(join(repository, "src/runtime"), join(root, "src/runtime"), { recursive: true });
  await cp(join(repository, "src/storage"), join(root, "src/storage"), { recursive: true });
};
