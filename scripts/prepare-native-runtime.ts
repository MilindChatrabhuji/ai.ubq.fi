import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { nativeKvDevelopmentPaths, readNativeKvDevelopmentBinding, verifyNativeKvDevelopmentDirectory } from "../src/runtime/native-kv-bootstrap.ts";
import { verifyNativeKvArtifact, type NativeKvArtifactBinding } from "../src/storage/native-addon.ts";
import { buildNativeKv } from "./build-native-kv.ts";
import { buildNativeKvDarwin } from "./build-native-kv-darwin.ts";

const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

const previousBinding = async (root: string, path: string): Promise<string | null> => {
  try {
    // Only an absent receipt permits first preparation; malformed existing state is retained.
    await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  return JSON.stringify(readNativeKvDevelopmentBinding(root));
};

const syncFile = async (path: string): Promise<void> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};

/** Explicit operator preparation, never an application-startup operation. */
export const prepareNativeKvDevelopmentArtifact = async (repositoryRoot?: string): Promise<NativeKvArtifactBinding> => {
  const paths = nativeKvDevelopmentPaths(repositoryRoot);
  try {
    await mkdir(paths.data, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  verifyNativeKvDevelopmentDirectory(paths.data);
  const previous = await previousBinding(paths.root, paths.receipt);
  const lock = join(paths.data, ".native-kv.prepare.lock");
  await mkdir(lock, { mode: 0o700 });
  try {
    if ((await previousBinding(paths.root, paths.receipt)) !== previous) throw new Error("Native KV development binding changed before preparation");
    // Unique staging is not referenced by startup until the durable binding is published.
    const output = await mkdtemp(join(paths.data, "native-kv-"));
    const receipt = await (process.platform === "darwin"
      ? buildNativeKvDarwin(output)
      : buildNativeKv(output, { workspaceDirectory: join(paths.data, "native-kv-builds") }));
    if (dirname(receipt.path) !== output || dirname(receipt.provenancePath) !== output) throw new Error("Native KV builder returned an unexpected output path");
    const binding = {
      artifactDirectory: output,
      expectedProvenanceSha256: receipt.provenanceSha256,
      inputsManifest: paths.inputs,
    };
    const verified = verifyNativeKvArtifact(binding);
    if (verified.artifactSha256 !== receipt.sha256 || verified.inputsSha256 !== receipt.inputsSha256)
      throw new Error("Native KV build receipt differs from verified output");
    for (const path of [receipt.path, receipt.provenancePath, join(output, "LICENSE"), output]) await syncFile(path);
    const staged = join(paths.data, `.native-kv.binding-${randomUUID()}.json`);
    const file = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify(binding, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    if ((await previousBinding(paths.root, paths.receipt)) !== previous) throw new Error("Native KV development binding changed during preparation");
    await rename(staged, paths.receipt);
    await syncFile(paths.data);
    return readNativeKvDevelopmentBinding(paths.root);
  } finally {
    await rmdir(lock);
  }
};

if (import.meta.main) console.log(JSON.stringify(await prepareNativeKvDevelopmentArtifact()));
