import type { NapiInterface } from "@deno/kv";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SOURCE_COMMIT = "9fe65cc138ff56ca5bfe7a1bf8c53e832246f9d5";
const INPUTS_MANIFEST = new URL("../../tools/native-kv/inputs.json", import.meta.url);
const PROVENANCE_FILE = "native-kv.provenance.json";
const ARTIFACT_FILE = "native-kv.node";
const NATIVE_EXPORTS = [
  "open",
  "close",
  "snapshotRead",
  "atomicWrite",
  "dequeueNextMessage",
  "finishMessage",
  "startWatch",
  "dequeueNextWatchMessage",
  "endWatch",
] as const;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type NativeKvArtifactBinding = Readonly<{
  artifactDirectory: string | URL;
  expectedProvenanceSha256: string;
  inputsManifest?: string | URL;
}>;

export type VerifiedNativeKvArtifact = Readonly<{
  path: string;
  artifactSha256: string;
  provenanceSha256: string;
  inputsSha256: string;
}>;

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid native KV provenance object");
  return value as Record<string, unknown>;
};

const pathOf = (value: string | URL): string => (value instanceof URL ? fileURLToPath(value) : value);

const readRegularFile = (path: string): Buffer => {
  if (!lstatSync(path).isFile()) throw new Error("Native KV artifacts must be regular files, not symlinks");
  return readFileSync(path);
};

/** Verify independent release binding and frozen build inputs before any native code loads. */
export const verifyNativeKvArtifact = (binding: NativeKvArtifactBinding): VerifiedNativeKvArtifact => {
  if (!/^[0-9a-f]{64}$/.test(binding.expectedProvenanceSha256)) throw new Error("Native KV requires an independently bound provenance hash");
  const directory = pathOf(binding.artifactDirectory);
  if (!lstatSync(directory).isDirectory()) throw new Error("Native KV artifact directory must not be a symlink");
  const provenanceBytes = readRegularFile(join(directory, PROVENANCE_FILE));
  const provenanceSha256 = sha256(provenanceBytes);
  if (provenanceSha256 !== binding.expectedProvenanceSha256) throw new Error("Native KV provenance hash does not match its release binding");
  const inputsBytes = readRegularFile(pathOf(binding.inputsManifest ?? INPUTS_MANIFEST));
  const inputs = object(JSON.parse(inputsBytes.toString()));
  const provenance = object(JSON.parse(provenanceBytes.toString()));
  const inputsSha256 = sha256(inputsBytes);
  if (inputs.schema !== 1 || provenance.schema !== 1 || provenance.inputsSha256 !== inputsSha256)
    throw new Error("Native KV frozen inputs do not match provenance");
  const build = object(provenance.build);
  if (build.exitCode !== 0 || typeof build.logSha256 !== "string" || !/^[0-9a-f]{64}$/.test(build.logSha256))
    throw new Error("Native KV build did not complete successfully");
  const sdk = object(inputs.sdk);
  if (sdk.name !== "@deno/kv" || sdk.version !== "0.14.0" || object(inputs.source).commit !== SOURCE_COMMIT)
    throw new Error("Native KV source identity is unsupported");
  for (const field of ["source", "patches", "lock", "toolchain", "recipe"]) {
    if (!isDeepStrictEqual(provenance[field], inputs[field])) throw new Error(`Native KV provenance ${field} differs from frozen inputs`);
  }
  const expectedArtifact = object(inputs.artifact);
  const artifact = object(provenance.artifact);
  for (const field of ["file", "platform", "architecture", "target", "napiVersion"]) {
    if (artifact[field] !== expectedArtifact[field]) throw new Error(`Native KV artifact ${field} differs from frozen inputs`);
  }
  if (artifact.file !== ARTIFACT_FILE || artifact.platform !== process.platform || artifact.architecture !== process.arch || artifact.napiVersion !== 4) {
    throw new Error("Native KV artifact does not support this runtime platform or ABI");
  }
  if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("Native KV artifact hash is invalid");
  const path = join(directory, ARTIFACT_FILE);
  const artifactSha256 = sha256(readRegularFile(path));
  if (artifactSha256 !== artifact.sha256) throw new Error("Native KV artifact hash does not match provenance");
  return { path: realpathSync(path), artifactSha256, provenanceSha256, inputsSha256 };
};

let prepared: Readonly<{ binding: string; artifact: NativeKvArtifactBinding; napi: NapiInterface }> | null = null;

/** The launcher supplies the provenance hash from its independently verified release manifest. */
export const prepareNativeKvBackend = (binding: NativeKvArtifactBinding): void => {
  const verified = verifyNativeKvArtifact(binding);
  const identity = `${verified.path}:${verified.provenanceSha256}`;
  if (prepared) {
    if (prepared.binding !== identity) throw new Error("Native KV backend was already prepared for another artifact");
    return;
  }
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(verified.path);
  const exports = object(loaded);
  if (!NATIVE_EXPORTS.every((name) => typeof exports[name] === "function"))
    throw new Error("Native KV artifact exports do not satisfy its pinned NAPI interface");
  prepared = {
    binding: identity,
    artifact: {
      artifactDirectory: dirname(verified.path),
      expectedProvenanceSha256: verified.provenanceSha256,
      inputsManifest: realpathSync(pathOf(binding.inputsManifest ?? INPUTS_MANIFEST)),
    },
    napi: loaded as NapiInterface,
  };
};

export const nativeKvBackendIsPrepared = (): boolean => prepared !== null;

/** Pass the same independently verified binding to task-owned child processes. */
export const preparedNativeKvArtifactBinding = (): NativeKvArtifactBinding => {
  if (!prepared) throw new Error("Prepare the verified native KV artifact before starting a child");
  return { ...prepared.artifact };
};

export const preparedNativeKvBackend = (): NapiInterface => {
  if (!prepared) throw new Error("Prepare the verified native KV artifact before opening a database");
  return prepared.napi;
};
