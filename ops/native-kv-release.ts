import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyNativeKvArtifact, type NativeKvArtifactBinding } from "../src/storage/native-addon.ts";
import type { NativeKvArtifact } from "../scripts/build-native-kv.ts";
import { digest, treeDigest } from "./io.ts";

export type NativeKvReleaseManifest = Readonly<{
  tree_sha256: string;
  artifact_sha256: string;
  provenance_sha256: string;
  inputs_sha256: string;
  inputs_manifest: string;
}>;
const files = ["LICENSE", "native-kv.node", "native-kv.provenance.json"];
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed native KV release input");
  return value as Record<string, unknown>;
};
const regular = async (path: string, directory = false): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (await realpath(path)) !== resolve(path))
    throw new Error("Native KV release paths must be regular and physical");
};
export const nativeKvInputsPath = (platform: string): string => {
  if (platform === "linux") return "tools/native-kv/inputs.json";
  if (platform === "darwin") return "tools/native-kv/inputs-darwin-arm64.json";
  throw new Error("Unsupported native KV release platform");
};
const verifiedInputs = async (root: string, platform: string): Promise<Readonly<{ path: string; bytes: Buffer }>> => {
  const path = join(root, nativeKvInputsPath(platform));
  await regular(join(root, "tools"), true);
  await regular(join(root, "tools/native-kv"), true);
  await regular(path);
  const bytes = await readFile(path);
  const inputs = object(JSON.parse(bytes.toString()));
  const source = object(inputs.source);
  const lock = object(inputs.lock);
  const check = async (name: unknown, expected: unknown): Promise<void> => {
    if (typeof name !== "string" || !/^[a-zA-Z0-9.-]+$/.test(name) || typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))
      throw new Error("Malformed native KV tracked input binding");
    const input = join(root, "tools/native-kv", name);
    await regular(input);
    if (digest(await readFile(input)) !== expected) throw new Error("Native KV tracked input checksum mismatch: " + name);
  };
  await check("LICENSE", source.licenseSha256);
  await check(lock.file, lock.sha256);
  await check(lock.auditFile, lock.auditSha256);
  if (!Array.isArray(inputs.patches) || inputs.patches.length !== 2) throw new Error("Native KV requires both frozen source patches");
  for (const entry of inputs.patches) {
    const patch = object(entry);
    await check(patch.file, patch.sha256);
  }
  const cargo = await readFile(join(root, "tools/native-kv", String(lock.file)), "utf8");
  const registry = cargo
    .split("[[package]]")
    .slice(1)
    .map((block) => {
      const fields = Object.fromEntries(Array.from(block.matchAll(/^(name|version|source|checksum) = "([^"]+)"$/gm), (match) => [match[1], match[2]]));
      return {
        name: fields.name,
        version: fields.version,
        ...(fields.source ? { source: fields.source } : {}),
        ...(fields.checksum ? { checksum: fields.checksum } : {}),
      };
    })
    .filter((entry) => entry.checksum);
  if (registry.length !== lock.registryPackages || digest(JSON.stringify(registry)) !== lock.registryChecksumsSha256)
    throw new Error("Native KV frozen registry graph mismatch");
  return { path, bytes };
};
export const readNativeKvReleaseManifest = (value: unknown, platform: string): NativeKvReleaseManifest => {
  const manifest = object(value);
  if (
    Object.keys(manifest).sort().join(",") !== "artifact_sha256,inputs_manifest,inputs_sha256,provenance_sha256,tree_sha256" ||
    manifest.inputs_manifest !== nativeKvInputsPath(platform) ||
    ![manifest.tree_sha256, manifest.artifact_sha256, manifest.provenance_sha256, manifest.inputs_sha256].every(
      (entry) => typeof entry === "string" && /^[0-9a-f]{64}$/.test(entry)
    )
  )
    throw new Error("Malformed immutable native KV release binding");
  return manifest as NativeKvReleaseManifest;
};
export const nativeKvReleaseBinding = (root: string, manifest: NativeKvReleaseManifest): NativeKvArtifactBinding => ({
  artifactDirectory: join(root, ".native/kv"),
  expectedProvenanceSha256: manifest.provenance_sha256,
  inputsManifest: join(root, manifest.inputs_manifest),
});
export const verifyNativeKvReleasePayload = async (root: string, platform: string, manifest: NativeKvReleaseManifest): Promise<void> => {
  await regular(join(root, ".native"), true);
  await regular(join(root, ".native/kv"), true);
  if ((await readdir(join(root, ".native"))).join(",") !== "kv" || (await readdir(join(root, ".native/kv"))).sort().join(",") !== files.join(","))
    throw new Error("Unexpected native KV payload tree");
  for (const file of files) await regular(join(root, ".native/kv", file));
  const inputs = await verifiedInputs(root, platform);
  const verified = verifyNativeKvArtifact(nativeKvReleaseBinding(root, manifest));
  if (
    digest(inputs.bytes) !== manifest.inputs_sha256 ||
    verified.inputsSha256 !== manifest.inputs_sha256 ||
    verified.artifactSha256 !== manifest.artifact_sha256 ||
    (await treeDigest(join(root, ".native"))) !== manifest.tree_sha256 ||
    digest(await readFile(join(root, ".native/kv/LICENSE"))) !== object(object(JSON.parse(inputs.bytes.toString())).source).licenseSha256
  )
    throw new Error("Immutable native KV payload integrity check failed");
};
/** Preparation only. A reused producer receipt remains an independent expected hash. */
export const stageNativeKvReleasePayload = async (root: string, supplied?: NativeKvArtifactBinding): Promise<NativeKvReleaseManifest> => {
  const inputs = await verifiedInputs(root, process.platform);
  await mkdir(join(root, ".native"), { mode: 0o700 });
  const directory = join(root, ".native/kv");
  let binding: NativeKvArtifactBinding;
  if (supplied) {
    if (typeof supplied.artifactDirectory !== "string") throw new Error("Native KV producer must supply a physical artifact directory");
    await regular(supplied.artifactDirectory, true);
    verifyNativeKvArtifact({ ...supplied, inputsManifest: inputs.path });
    await mkdir(directory, { mode: 0o700 });
    for (const file of files) {
      await regular(join(supplied.artifactDirectory, file));
      await copyFile(join(supplied.artifactDirectory, file), join(directory, file), constants.COPYFILE_EXCL);
    }
    binding = { artifactDirectory: directory, expectedProvenanceSha256: supplied.expectedProvenanceSha256, inputsManifest: inputs.path };
  } else {
    const builderFile = process.platform === "linux" ? "scripts/build-native-kv.ts" : "scripts/build-native-kv-darwin.ts";
    const builder = (await import(pathToFileURL(join(root, builderFile)).href)) as {
      buildNativeKv?: (out: string) => Promise<NativeKvArtifact>;
      buildNativeKvDarwin?: (out: string) => Promise<NativeKvArtifact>;
    };
    const build = process.platform === "linux" ? builder.buildNativeKv : builder.buildNativeKvDarwin;
    if (!build) throw new Error("Native KV platform builder is unavailable");
    const receipt = await build(directory);
    binding = { artifactDirectory: directory, expectedProvenanceSha256: receipt.provenanceSha256, inputsManifest: inputs.path };
    const verified = verifyNativeKvArtifact(binding);
    if (verified.artifactSha256 !== receipt.sha256 || verified.inputsSha256 !== receipt.inputsSha256)
      throw new Error("Native KV builder receipt differs from staged bytes");
  }
  for (const file of files) await chmod(join(directory, file), 0o600);
  const verified = verifyNativeKvArtifact(binding);
  const manifest: NativeKvReleaseManifest = {
    tree_sha256: await treeDigest(join(root, ".native")),
    artifact_sha256: verified.artifactSha256,
    provenance_sha256: verified.provenanceSha256,
    inputs_sha256: verified.inputsSha256,
    inputs_manifest: nativeKvInputsPath(process.platform),
  };
  await verifyNativeKvReleasePayload(root, process.platform, manifest);
  return manifest;
};
