import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { BUN_RUNTIMES, selectedRuntime, type RuntimeArtifact } from "./bun-runtime.ts";
import { command, digest, treeDigest } from "./io.ts";

export type BunReleaseManifest = Readonly<{
  schema: 2;
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
const excluded = new Set(["node_modules", ".uos-permissions", ".uos-release.json"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const readManifest = async (root: string): Promise<BunReleaseManifest> => {
  const file = join(root, ".uos-release.json");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Immutable Bun release manifest is unsafe");
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(value)) throw new Error("Immutable Bun release manifest is malformed");
  if (
    value.schema !== 2 ||
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
  return value as unknown as BunReleaseManifest;
};
const validateLinks = async (root: string, directory: string): Promise<void> => {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !(await realpath(path)).startsWith(root + "/")) throw new Error("Dependency symlink escapes the immutable release");
    } else if (stat.isDirectory()) await validateLinks(root, path);
    else if (!stat.isFile()) throw new Error("Unsupported dependency payload entry");
  }
};
export const prepareReleasePayload = async (root: string, sha: string, archiveDigest: string, headerDirectory?: string): Promise<BunReleaseManifest> => {
  if (Bun.version !== "1.4.0" || !/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{64}$/.test(archiveDigest))
    throw new Error("Release preparation requires pinned Bun and exact source identity");
  const runtime = selectedRuntime();
  for (const name of ["node_modules", ".uos-permissions", ".bun-cache"]) {
    try {
      await lstat(join(root, name));
      throw new Error("Source archive contains a generated dependency/native/cache path");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  // An empty, exclusive dotenv fence plus a sparse child environment prevents an
  // install in nested .data/releases from discovering production credentials.
  await writeFile(join(root, ".env"), "", { flag: "wx", mode: 0o600 });
  try {
    await command(process.execPath, ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: root, sparse: true });
  } finally {
    await rm(join(root, ".env"));
  }
  await rm(join(root, ".bun-cache"), { recursive: true, force: true });
  await validateLinks(await realpath(root), join(root, "node_modules"));
  await mkdir(join(root, ".uos-permissions"), { mode: 0o700 });
  if (process.platform === "linux") {
    const builder = (await import(pathToFileURL(join(root, "scripts/build-permissions.ts")).href)) as {
      buildPermissionsNative: (output: string, headers?: string) => Promise<unknown>;
    };
    await builder.buildPermissionsNative(join(root, ".uos-permissions"), headerDirectory);
  }
  const manifest: BunReleaseManifest = {
    schema: 2,
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
  await validateLinks(await realpath(root), join(root, "node_modules"));
  if (
    manifest.dependency_lock_sha256 !== digest(await readFile(join(root, "bun.lock"))) ||
    manifest.source_tree_sha256 !== (await treeDigest(root, excluded)) ||
    manifest.dependency_tree_sha256 !== (await treeDigest(join(root, "node_modules"))) ||
    manifest.permissions_tree_sha256 !== (await treeDigest(join(root, ".uos-permissions")))
  )
    throw new Error("Immutable Bun release source, dependency or native payload integrity check failed");
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
