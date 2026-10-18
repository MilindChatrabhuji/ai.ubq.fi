import { chmod, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute, dirname, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BUN_RUNTIMES, selectedRuntime, type RuntimeArtifact } from "./bun-runtime.ts";
import { command, digest, treeDigest, exists } from "./io.ts";
import type { NativeKvArtifactBinding } from "../src/storage/native-addon.ts";
import { readNativeKvReleaseManifest, stageNativeKvReleasePayload, verifyNativeKvReleasePayload, type NativeKvReleaseManifest } from "./native-kv-release.ts";

type BunReleaseBase = Readonly<{
  git_sha: string;
  source_archive_sha256: string;
  source_tree_sha256: string;
  dependency_lock_sha256: string;
  dependency_tree_sha256: string;
  permissions_tree_sha256: string;
  platform: string;
  architecture: string;
  runtime: RuntimeArtifact;
}>;
export type BunReleaseManifest = BunReleaseBase & (Readonly<{ schema: 2 }> | Readonly<{ schema: 3; native_kv: NativeKvReleaseManifest }>);
const historicalExcluded = new Set(["node_modules", ".uos-permissions", ".uos-release.json"]);
const excluded = new Set([...historicalExcluded, ".native"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const readManifest = async (root: string): Promise<BunReleaseManifest> => {
  const file = join(root, ".uos-release.json");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Immutable Bun release manifest is unsafe");
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(value)) throw new Error("Immutable Bun release manifest is malformed");
  if (
    (value.schema !== 2 && value.schema !== 3) ||
    typeof value.git_sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.git_sha) ||
    ![value.source_archive_sha256, value.source_tree_sha256, value.dependency_lock_sha256, value.dependency_tree_sha256, value.permissions_tree_sha256].every(
      (item) => typeof item === "string" && /^[0-9a-f]{64}$/.test(item)
    )
  )
    throw new Error("Immutable Bun release manifest is malformed");
  if (value.platform !== "linux" && value.platform !== "darwin") throw new Error("Unsupported immutable Bun release platform");
  if (value.architecture !== "arm64" || JSON.stringify(value.runtime) !== JSON.stringify(BUN_RUNTIMES[value.platform]))
    throw new Error("Immutable Bun release runtime does not match the approved pin");
  if (value.schema === 3) readNativeKvReleaseManifest(value.native_kv, value.platform);
  return value as unknown as BunReleaseManifest;
};
type DependencyLink = { path: string; target: string; resolved: string; device: number; inode: number };
const dependencyLinks = async (directory: string): Promise<DependencyLink[]> => {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Dependency payload root must be a regular directory");
  const root = await realpath(directory);
  const links: DependencyLink[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const name of await readdir(current)) {
      const path = join(current, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        // realpath rejects dangling links and resolution cycles before any write.
        const resolved = await realpath(path);
        if (!resolved.startsWith(root + sep)) throw new Error("Dependency symlink escapes the immutable release");
        if (dirname(path) === resolved || dirname(path).startsWith(resolved + sep)) throw new Error("Dependency symlink targets an ancestor cycle");
        const targetInfo = await lstat(resolved);
        if (!targetInfo.isFile() && !targetInfo.isDirectory()) throw new Error("Unsupported dependency symlink target");
        links.push({ path, target, resolved, device: stat.dev, inode: stat.ino });
      } else if (stat.isDirectory()) await walk(path);
      else if (!stat.isFile()) throw new Error("Unsupported dependency payload entry");
    }
  };
  await walk(root);
  return links;
};
/** Bun cache aliases must remain valid after staging rename and artifact relocation. */
export const normalizeDependencyLinks = async (directory: string): Promise<void> => {
  const links = await dependencyLinks(directory);
  for (const link of links) {
    if (!isAbsolute(link.target)) continue;
    const info = await lstat(link.path);
    if (!info.isSymbolicLink() || info.dev !== link.device || info.ino !== link.inode || (await readlink(link.path)) !== link.target)
      throw new Error("Dependency symlink changed during immutable preparation");
    const temporary = link.path + ".uos-link-" + crypto.randomUUID();
    try {
      await symlink(relative(dirname(link.path), link.resolved), temporary);
      await rename(temporary, link.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
};
const validateLinks = async (directory: string): Promise<void> => {
  const root = await realpath(directory);
  for (const link of await dependencyLinks(directory)) {
    const local = relative(root, link.resolved);
    if (isAbsolute(link.target) || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw new Error("Dependency symlink escapes the approved dependency graph");
    }
  }
};
export const prepareReleasePayload = async (
  root: string,
  sha: string,
  archiveDigest: string,
  headerDirectory?: string,
  nativeArtifact?: NativeKvArtifactBinding,
  preparedDependencies?: string
): Promise<BunReleaseManifest> => {
  if (process.versions.bun !== "1.4.0" || !/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{64}$/.test(archiveDigest))
    throw new Error("Release preparation requires pinned Bun and exact source identity");
  const runtime = selectedRuntime();
  for (const name of ["node_modules", ".uos-permissions", ".native", ".bun-cache"]) {
    try {
      await lstat(join(root, name));
      throw new Error("Source archive contains a generated dependency/native/cache path");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  // An empty, exclusive dotenv fence plus a sparse child environment prevents an
  // install in nested .data/releases from discovering production credentials.
  if (preparedDependencies) {
    await validateLinks(preparedDependencies);
    await cp(preparedDependencies, join(root, "node_modules"), { recursive: true, dereference: true });
  } else {
    await writeFile(join(root, ".env"), "", { flag: "wx", mode: 0o600 });
    try {
      await command(process.execPath, ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"], { cwd: root, sparse: true });
    } finally {
      await rm(join(root, ".env"));
    }
  }
  await rm(join(root, ".bun-cache"), { recursive: true, force: true });
  await normalizeDependencyLinks(join(root, "node_modules"));
  await validateLinks(join(root, "node_modules"));
  await mkdir(join(root, ".uos-permissions"), { mode: 0o700 });
  if (process.platform === "linux") {
    const builder = (await import(pathToFileURL(join(root, "scripts/build-permissions.ts")).href)) as {
      buildPermissionsNative: (output: string, headers?: string) => Promise<unknown>;
    };
    await builder.buildPermissionsNative(join(root, ".uos-permissions"), headerDirectory);
  }
  const native = await stageNativeKvReleasePayload(root, nativeArtifact);
  const manifest: BunReleaseManifest = {
    schema: 3,
    native_kv: native,
    git_sha: sha,
    source_archive_sha256: archiveDigest,
    source_tree_sha256: await treeDigest(root, excluded),
    dependency_lock_sha256: digest(await readFile(join(root, "bun.lock"))),
    dependency_tree_sha256: await treeDigest(join(root, "node_modules")),
    permissions_tree_sha256: await treeDigest(join(root, ".uos-permissions")),
    platform: process.platform,
    architecture: process.arch,
    runtime,
  };
  await writeFile(join(root, ".uos-release.json"), JSON.stringify(manifest) + "\n", { mode: 0o600 });
  await chmod(join(root, ".uos-release.json"), 0o600);
  return manifest;
};
export const verifyReleasePayload = async (root: string, sha?: string, expectedSourceTree?: string): Promise<BunReleaseManifest> => {
  const manifest = await readManifest(root);
  if ((sha && manifest.git_sha !== sha) || (expectedSourceTree && manifest.source_tree_sha256 !== expectedSourceTree))
    throw new Error("Immutable Bun release source identity changed");
  await validateLinks(join(root, "node_modules"));
  if (
    manifest.dependency_lock_sha256 !== digest(await readFile(join(root, "bun.lock"))) ||
    manifest.source_tree_sha256 !== (await treeDigest(root, manifest.schema === 3 ? excluded : historicalExcluded)) ||
    manifest.dependency_tree_sha256 !== (await treeDigest(join(root, "node_modules"))) ||
    manifest.permissions_tree_sha256 !== (await treeDigest(join(root, ".uos-permissions")))
  )
    throw new Error("Immutable Bun release source, dependency or native payload integrity check failed");
  if (manifest.schema === 3) await verifyNativeKvReleasePayload(root, manifest.platform, manifest.native_kv);
  else {
    if ((await exists(join(root, ".native"))) || (await exists(join(root, "src/storage/native-addon.ts"))))
      throw new Error("Historical Bun schema 2 cannot carry the custom native SDK");
    const entry = manifest.platform === "linux" ? "serve-vps.ts" : "serve-mac.ts";
    const profile = digest((await readFile(join(root, "scripts", entry), "utf8")).replace(/port: \d+/, "port: 0"));
    const expected =
      manifest.platform === "linux"
        ? "8a74f51324e59bc00612bd22ae68bc3dc60a55dcb113a66bef0a5c3fc719c1e4"
        : "e2fb9b164fdce739cfde27ca227188961c256f2111e67a7bffa64ec091fc70c3";
    if (profile !== expected) throw new Error("Unsupported historical Bun launcher profile");
  }
  return manifest;
};
export const releaseSourceTree = (root: string): Promise<string> => treeDigest(root, excluded);
if (import.meta.main) {
  const args = process.argv.slice(2);
  const operation = args.at(0);
  const input = args.at(1);
  const sha = args.at(2);
  const archive = args.at(3);
  if (!input || !["prepare", "verify"].includes(operation ?? ""))
    throw new Error("Usage: bun --no-env-file ops/release-artifact.ts prepare|verify <release> [sha archive-sha256]");
  const root = resolve(input);
  console.log(JSON.stringify(operation === "prepare" ? await prepareReleasePayload(root, sha ?? "", archive ?? "") : await verifyReleasePayload(root, sha)));
}
