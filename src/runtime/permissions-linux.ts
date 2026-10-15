import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { release } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type LinuxPermissionsArtifact = { path: string; sha256: string };
export type LinuxPermissionsSupport = { architecture: string; kernel: string; landlockAbi: number; landlockThreadSync: boolean; seccomp: boolean };
export type LinuxPermissions = {
  read: readonly string[];
  write: readonly string[];
  /** An overlapping writable parent requires an actual read-only mount, not chmod or unit text. */
  immutable?: readonly string[];
};
export type LinuxPermissionsReceipt = LinuxPermissionsSupport & { filesystemThreadSync: true; processThreadSync: true; immutableMounts: readonly string[] };
type NativePermissions = {
  support: () => { landlockAbi: number; seccomp: boolean };
  readonlyMount: (path: string) => boolean;
  enforce: (grants: { path: string; access: number }[]) => boolean;
};
const loaded = new Map<string, NativePermissions>();

const defaultArtifact = (): LinuxPermissionsArtifact => {
  const manifest = fileURLToPath(new URL("../../.uos-permissions/manifest.json", import.meta.url));
  const info = lstatSync(manifest);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Native confinement manifest is not a regular file");
  const document: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (
    document === null ||
    typeof document !== "object" ||
    !("path" in document) ||
    document.path !== "linux-arm64.node" ||
    !("architecture" in document) ||
    document.architecture !== "arm64" ||
    !("sha256" in document) ||
    typeof document.sha256 !== "string"
  )
    throw new Error("Native confinement manifest is invalid");
  return { path: join(dirname(manifest), document.path), sha256: document.sha256 };
};

const nativeLibrary = (artifact?: LinuxPermissionsArtifact): NativePermissions => {
  if (process.platform !== "linux" || process.arch !== "arm64") throw new Error("Linux confinement requires Linux ARM64");
  const selected = artifact ?? defaultArtifact();
  const info = lstatSync(selected.path);
  if (!info.isFile() || info.isSymbolicLink() || !/^[0-9a-f]{64}$/.test(selected.sha256)) throw new Error("Native confinement artifact is invalid");
  if (createHash("sha256").update(readFileSync(selected.path)).digest("hex") !== selected.sha256)
    throw new Error("Native confinement artifact integrity check failed");
  const key = realpathSync(selected.path) + ":" + selected.sha256;
  const cached = loaded.get(key);
  if (cached) return cached;
  const module = { exports: {} };
  process.dlopen(module, selected.path);
  const api = module.exports as Partial<NativePermissions>;
  if (typeof api.support !== "function" || typeof api.readonlyMount !== "function" || typeof api.enforce !== "function")
    throw new Error("Native confinement interface is invalid");
  const native = api as NativePermissions;
  loaded.set(key, native);
  return native;
};

/** Query only: this does not restrict the caller or change host configuration. */
export const getLinuxPermissionsSupport = (artifact?: LinuxPermissionsArtifact): LinuxPermissionsSupport => {
  const support = nativeLibrary(artifact).support();
  return { architecture: process.arch, kernel: release(), ...support, landlockThreadSync: support.landlockAbi >= 8 };
};

const beneath = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
};

const requireConfinementSupport = (support: LinuxPermissionsSupport): void => {
  if (!support.landlockThreadSync || !support.seccomp) {
    throw new Error("Linux confinement requires Landlock ABI8+ and seccomp thread synchronization");
  }
};

/**
 * Irreversible, Linux ARM64 application-child boundary. Invoke before product imports or
 * unrelated file opens; Landlock cannot revoke descriptors opened before enforcement or
 * hide file metadata. ABI8 and newer are accepted; actual ARM64/JSC/native-KV proof records the runner ABI.
 * The native artifact must already be built, hashed and packaged in the immutable release.
 * No compiler, dependency installation, FFI fallback, host configuration, or service change
 * runs here. Enforcement failure after an irreversible transition terminates this child.
 */
export const applyLinuxPermissions = (permissions: LinuxPermissions, artifact?: LinuxPermissionsArtifact): LinuxPermissionsReceipt => {
  const native = nativeLibrary(artifact);
  const support = getLinuxPermissionsSupport(artifact);
  requireConfinementSupport(support);
  const canonicalize = (path: string): string => {
    if (!isAbsolute(path)) throw new Error("Linux confinement paths must be absolute");
    return realpathSync(path);
  };
  const readPaths = permissions.read.map(canonicalize);
  const writePaths = permissions.write.map(canonicalize);
  const immutablePaths = (permissions.immutable ?? []).map(canonicalize);
  const immutableMounts: string[] = [];
  for (const path of immutablePaths) {
    if (!writePaths.some((parent) => beneath(parent, path) || beneath(path, parent))) continue;
    if (!native.readonlyMount(path)) throw new Error("Immutable path below writable parent requires a read-only mount");
    immutableMounts.push(path);
  }
  const grants = new Map<string, number>();
  for (const path of readPaths) {
    let directoryAccess = 0;
    if (statSync(path).isDirectory()) directoryAccess = 8 | (support.landlockAbi >= 9 ? 0x10000 : 0);
    const readable = 4 | directoryAccess;
    grants.set(path, (grants.get(path) ?? 0) | readable);
  }
  for (const path of writePaths) {
    const writable = statSync(path).isDirectory() ? 0x7fff & ~(1 | 4 | 8 | 64 | 2048) : 2 | 0x4000;
    grants.set(path, (grants.get(path) ?? 0) | writable);
  }
  if (!native.enforce([...grants].map(([path, access]) => ({ path, access })))) throw new Error("Native confinement did not produce an enforcement receipt");
  return { ...support, filesystemThreadSync: true, processThreadSync: true, immutableMounts };
};
