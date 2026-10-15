import { constants } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileDigest } from "../src/kv-conversion/legacy-codec.ts";
import { command, digest, runOutput } from "./io.ts";
import { releaseSourceTree, verifyReleasePayload, type BunReleaseManifest } from "./release-artifact.ts";
import type { VpsPayloadPreparation } from "./vps-release-store.ts";

export type CutoverArtifactInput = Readonly<{
  revision: string;
  runId: number;
  artifactId: number;
  archive: string;
  directory: string;
  sourceRepository: string;
  workspace: string;
}>;
type GithubRead = (route: string) => Promise<unknown>;
const repository = "repos/ubiquity/ai.ubq.fi";
const githubRead: GithubRead = async (route) => JSON.parse(await command("gh", ["api", `${repository}/${route}`]));
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hosted artifact proof");
  return value as Record<string, unknown>;
};
const approved = new WeakSet<object>();
export type CapturedCutoverArtifact = Readonly<{
  revision: string;
  runId: number;
  artifactId: number;
  archiveSha256: string;
  archive: string;
  directory: string;
  manifestSha256: string;
  manifest: BunReleaseManifest;
}>;

/** API data is checked, never interpreted as a caller-supplied source-success boolean. */
export function assertHostedCutoverProof(
  input: CutoverArtifactInput,
  runValue: unknown,
  artifactValue: unknown,
  jobsValue: unknown,
  refValue: unknown
): string {
  const run = record(runValue),
    artifact = record(artifactValue),
    jobs = record(jobsValue),
    ref = record(refValue);
  const workflow = record(artifact.workflow_run);
  if (
    !/^[a-f0-9]{40}$/.test(input.revision) ||
    !Number.isSafeInteger(input.runId) ||
    input.runId < 1 ||
    !Number.isSafeInteger(input.artifactId) ||
    input.artifactId < 1 ||
    run.id !== input.runId ||
    run.head_sha !== input.revision ||
    run.event !== "push" ||
    run.head_branch !== "development" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.path !== ".github/workflows/deno-deploy.yml" ||
    artifact.id !== input.artifactId ||
    artifact.expired !== false ||
    artifact.name !== `ai-ubq-fi-source-${input.revision}` ||
    workflow.id !== input.runId ||
    workflow.head_sha !== input.revision ||
    record(ref.object).sha !== input.revision ||
    !Array.isArray(jobs.jobs)
  )
    throw new Error("Hosted artifact is not the accepted shipping revision");
  for (const name of ["validate", "mac-containment", "darwin-native", "verify-artifact"]) {
    const matches = jobs.jobs.map(record).filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success")
      throw new Error("A required artifact gate is unavailable");
  }
  if (typeof artifact.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) throw new Error("Hosted artifact digest is unavailable");
  return artifact.digest.slice(7);
}

/** @public Private preflight: capture actual hosted proof before downtime. */
export async function captureCutoverArtifact(input: CutoverArtifactInput, read: GithubRead = githubRead): Promise<CapturedCutoverArtifact> {
  const [run, artifact, jobs, ref] = await Promise.all([
    read(`actions/runs/${input.runId}`),
    read(`actions/artifacts/${input.artifactId}`),
    read(`actions/runs/${input.runId}/jobs?per_page=100`),
    read("git/ref/heads/development"),
  ]);
  const archiveSha256 = assertHostedCutoverProof(input, run, artifact, jobs, ref);
  const archive = resolve(input.archive),
    directory = await realpath(input.directory);
  for (const path of [archive, directory]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (path === archive ? !info.isFile() : !info.isDirectory())) throw new Error("Unsafe artifact receiver path");
  }
  if ((await fileDigest(archive)) !== archiveSha256) throw new Error("CI artifact archive digest changed");
  const bytes = await runOutput("/usr/bin/unzip", ["-p", archive, "manifest.json"], { sparse: true, cwd: input.workspace });
  if (bytes.length > 65_536 || !Buffer.from(bytes).equals(await readFile(join(directory, ".uos-release.json"))))
    throw new Error("Materialized manifest differs from the hosted artifact");
  const manifest = await verifyReleasePayload(directory, input.revision);
  if (manifest.schema !== 3) throw new Error("First Bun cutover requires a complete schema-3 artifact");
  const scratch = await mkdtemp(join(resolve(input.workspace), "source-proof-"));
  try {
    const source = join(scratch, "source.tar");
    await command("git", ["archive", "--format=tar", `--output=${source}`, input.revision], { cwd: input.sourceRepository, sparse: true });
    if ((await fileDigest(source)) !== manifest.source_archive_sha256) throw new Error("CI source archive does not match the exact Git object");
    const expected = join(scratch, "expected");
    await mkdir(expected, { mode: 0o700 });
    await command("/bin/sh", ["-c", 'umask 022; exec /usr/bin/tar -xf "$1" -C "$2"', "uos-source-proof", source, expected], { cwd: scratch, sparse: true });
    const sourceDirectory = await lstat(join(expected, "src"));
    if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink()) throw new Error("Unsafe source archive layout");
    const generated = join(expected, "src/release.ts");
    try {
      const info = await lstat(generated);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe generated source entry");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await writeFile(generated, `// Generated for this immutable VPS release.\nexport const RELEASE_GIT_SHA = "${input.revision}";\n`, { mode: 0o600 });
    await chmod(generated, 0o600);
    if ((await releaseSourceTree(expected)) !== manifest.source_tree_sha256) throw new Error("CI materialized source differs from the exact Git archive");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const captured = Object.freeze({
    revision: input.revision,
    runId: input.runId,
    artifactId: input.artifactId,
    archiveSha256,
    archive,
    directory,
    manifestSha256: digest(bytes),
    manifest: Object.freeze(manifest),
  });
  approved.add(captured);
  return captured;
}

/** @public Private operator pins these exact capture bytes before supervisor authorization. */
export async function persistCutoverArtifact(artifact: CapturedCutoverArtifact, path: string): Promise<string> {
  await recheckCutoverArtifact(artifact);
  await writeFile(path, JSON.stringify(artifact) + "\n", { flag: "wx", mode: 0o600 });
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  return await fileDigest(path);
}

export async function restoreCutoverArtifact(path: string, expectedSha256: string): Promise<CapturedCutoverArtifact> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > 65_536 ||
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    (await fileDigest(path)) !== expectedSha256
  )
    throw new Error("Unpinned offline cutover capture");
  const value = JSON.parse(await readFile(path, "utf8")) as CapturedCutoverArtifact;
  if (
    !/^[a-f0-9]{40}$/.test(value.revision) ||
    !Number.isSafeInteger(value.runId) ||
    !Number.isSafeInteger(value.artifactId) ||
    value.runId < 1 ||
    value.artifactId < 1 ||
    !/^[a-f0-9]{64}$/.test(value.archiveSha256) ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    (await fileDigest(value.archive)) !== value.archiveSha256 ||
    digest(await readFile(join(value.directory, ".uos-release.json"))) !== value.manifestSha256
  )
    throw new Error("Offline cutover capture changed");
  const manifest = await verifyReleasePayload(value.directory, value.revision);
  if (JSON.stringify(manifest) !== JSON.stringify(value.manifest)) throw new Error("Offline cutover manifest changed");
  const artifact = Object.freeze({ ...value, manifest: Object.freeze(manifest) });
  approved.add(artifact);
  return artifact;
}

export async function recheckCutoverArtifact(artifact: CapturedCutoverArtifact): Promise<void> {
  if (!approved.has(artifact) || digest(await readFile(join(artifact.directory, ".uos-release.json"))) !== artifact.manifestSha256)
    throw new Error("Unbound or changed cutover artifact");
  await verifyReleasePayload(artifact.directory, artifact.revision, artifact.manifest.source_tree_sha256);
}

export async function verifyCutoverCandidate(artifact: CapturedCutoverArtifact, directory: string): Promise<void> {
  await recheckCutoverArtifact(artifact);
  if (digest(await readFile(join(directory, ".uos-release.json"))) !== artifact.manifestSha256)
    throw new Error("Published candidate differs from the accepted CI manifest");
  await verifyReleasePayload(directory, artifact.revision, artifact.manifest.source_tree_sha256);
}

/** Reuses permissions AND KV artifacts; unlike normal preparation this never invokes a compiler. */
export function reuseCutoverPayload(artifact: CapturedCutoverArtifact): VpsPayloadPreparation {
  return async (root, revision, archive) => {
    await recheckCutoverArtifact(artifact);
    if (
      revision !== artifact.revision ||
      archive !== artifact.manifest.source_archive_sha256 ||
      (await releaseSourceTree(root)) !== artifact.manifest.source_tree_sha256
    )
      throw new Error("Cutover payload source identity changed");
    for (const name of ["node_modules", ".uos-permissions", ".native"]) {
      try {
        await lstat(join(root, name));
        throw new Error("Candidate contains a generated payload path");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      await cp(join(artifact.directory, name), join(root, name), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
    }
    await copyFile(join(artifact.directory, ".uos-release.json"), join(root, ".uos-release.json"), constants.COPYFILE_FICLONE);
    await chmod(join(root, ".uos-release.json"), 0o600);
    return await verifyReleasePayload(root, revision, artifact.manifest.source_tree_sha256);
  };
}
