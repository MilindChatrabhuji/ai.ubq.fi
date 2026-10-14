import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNativeKvBackend, verifyNativeKvArtifact, type NativeKvArtifactBinding } from "../storage/native-addon.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINDING_FILE = "native-kv.binding.json";

/** Resolve from this source module, including when a caller starts in another cwd. */
export const nativeKvDevelopmentPaths = (repositoryRoot = REPOSITORY_ROOT): Readonly<{ root: string; data: string; receipt: string; inputs: string }> => {
  const root = resolve(repositoryRoot);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error("Native KV repository root must be a real directory");
  if (process.arch !== "arm64" || !["linux", "darwin"].includes(process.platform)) throw new Error("Native KV development platform is unsupported");
  const data = join(root, ".data");
  const inputs = join(root, "tools", "native-kv", process.platform === "darwin" ? "inputs-darwin-arm64.json" : "inputs.json");
  return { root, data, receipt: join(data, BINDING_FILE), inputs };
};

const checkOwner = (info: Stats): void => {
  const uid = process.getuid?.();
  if (uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) throw new Error("Native KV development storage must be owner-private");
};

/** Permissions protect local operator custody, not hostile changes by the same uid. */
export const verifyNativeKvDevelopmentDirectory = (path: string): void => {
  const info = lstatSync(path);
  if (!info.isDirectory() || realpathSync(path) !== path) throw new Error("Native KV development directory must not contain symlinks");
  checkOwner(info);
};

const privateReceipt = (path: string): unknown => {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || realpathSync(path) !== path)
    throw new Error("Native KV development binding must be a regular file, not a symlink");
  checkOwner(before);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (info.dev !== before.dev || info.ino !== before.ino || info.size > 16_384) throw new Error("Native KV development binding changed or is oversized");
    checkOwner(info);
    return JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
  } finally {
    closeSync(descriptor);
  }
};

const bindingDocument = (value: unknown): Readonly<{ artifactDirectory: string; expectedProvenanceSha256: string; inputsManifest?: string }> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native KV development binding");
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).some((key) => !["artifactDirectory", "expectedProvenanceSha256", "inputsManifest"].includes(key)) ||
    typeof fields.artifactDirectory !== "string" ||
    !isAbsolute(fields.artifactDirectory) ||
    typeof fields.expectedProvenanceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(fields.expectedProvenanceSha256) ||
    (fields.inputsManifest !== undefined && typeof fields.inputsManifest !== "string")
  ) {
    throw new Error("Native KV development binding requires an independently supplied provenance hash and absolute paths");
  }
  return {
    artifactDirectory: fields.artifactDirectory,
    expectedProvenanceSha256: fields.expectedProvenanceSha256,
    ...(fields.inputsManifest === undefined ? {} : { inputsManifest: fields.inputsManifest }),
  };
};

/** Read a trusted local operator receipt; never infer trust from adjacent provenance. */
export const readNativeKvDevelopmentBinding = (repositoryRoot?: string): NativeKvArtifactBinding => {
  const paths = nativeKvDevelopmentPaths(repositoryRoot);
  verifyNativeKvDevelopmentDirectory(paths.data);
  const binding = bindingDocument(privateReceipt(paths.receipt));
  const artifact = resolve(binding.artifactDirectory);
  const beneath = relative(paths.data, artifact);
  if (!beneath || beneath === ".." || beneath.startsWith(`..${sep}`) || isAbsolute(beneath)) {
    throw new Error("Native KV development artifact must stay beneath repository .data");
  }
  let directory = paths.data;
  for (const part of beneath.split(sep)) {
    directory = join(directory, part);
    verifyNativeKvDevelopmentDirectory(directory);
  }
  if (binding.inputsManifest !== undefined && binding.inputsManifest !== paths.inputs) {
    throw new Error("Native KV development binding must use the current tracked platform inputs");
  }
  const inputs = lstatSync(paths.inputs);
  if (!inputs.isFile() || realpathSync(paths.inputs) !== paths.inputs || (inputs.mode & 0o022) !== 0) {
    throw new Error("Native KV tracked inputs must be safe regular files without symlinks");
  }
  for (const path of [join(artifact, "native-kv.node"), join(artifact, "native-kv.provenance.json")]) {
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || realpathSync(path) !== path) throw new Error("Native KV development artifacts must not contain symlinks");
    checkOwner(info);
  }
  const checked = { ...binding, artifactDirectory: artifact, inputsManifest: paths.inputs };
  verifyNativeKvArtifact(checked);
  return checked;
};

/** Development startup only verifies and loads; explicit preparation happens separately. */
export const prepareNativeKvForDevelopment = (repositoryRoot?: string): Promise<void> =>
  Promise.resolve().then(() => {
    prepareNativeKvBackend(readNativeKvDevelopmentBinding(repositoryRoot));
  });
