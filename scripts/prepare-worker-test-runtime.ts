import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import inputs from "../tools/worker-test-runtime/inputs.json";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATHS = ["package.json", "bun.lock", "tools/worker-test-runtime/inputs.json", "scripts/prepare-worker-test-runtime.ts"];
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const workerTestRuntimeInputs = inputs;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path: string): string => digest(readFileSync(path));
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Worker runtime metadata must be an object");
  return value as Record<string, unknown>;
};
const inside = (base: string, path: string): string => {
  const delta = relative(base, path);
  if (isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`)) throw new Error("Worker runtime path escaped its fixed directory");
  return path;
};
const regularFile = (path: string): string => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Worker runtime requires a regular file: " + path);
  return path;
};
const privateDirectory = (path: string): void => {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Worker runtime requires an owned physical directory: " + path);
};
const pathsFor = (root: string) => {
  const repository = realpathSync(root);
  const temporary = join(repository, ".tmp");
  const parent = join(temporary, "worker-test-runtime");
  const directory = join(parent, "linux-arm64");
  return { repository, temporary, parent, directory, receipt: join(directory, "receipt.json") };
};
export const assertWorkerTestPlatform = (platform = process.platform, arch = process.arch): void => {
  if (platform !== inputs.platform || arch !== inputs.arch) throw new Error("Worker test runtime preparation requires Linux ARM64");
};
/** Pins are SHA256 hex for Node and npm SHA512 SRI for the two platform archives. */
export const verifyWorkerTestArchive = (bytes: Uint8Array, integrity: string): void => {
  const valid = integrity.startsWith("sha512-")
    ? "sha512-" + createHash("sha512").update(bytes).digest("base64") === integrity
    : /^[0-9a-f]{64}$/.test(integrity) && digest(bytes) === integrity;
  if (!valid) throw new Error("Worker runtime archive checksum mismatch");
};
const elfIdentity = (path: string): string => {
  const bytes = readFileSync(regularFile(path));
  if (bytes.length < 20 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183)
    throw new Error("Worker runtime binary is not Linux ARM64 ELF: " + path);
  if ((lstatSync(path).mode & 0o111) === 0) throw new Error("Worker runtime binary is not executable: " + path);
  return digest(bytes);
};
const sourceIdentity = (root: string): Record<string, string> =>
  Object.fromEntries(SOURCE_PATHS.map((path) => [path, fileHash(regularFile(join(root, path)))]));

/** Inspect frozen root dependencies without importing/executing Miniflare or its native binaries. */
export const workerTestDependencyIdentity = (root: string) => {
  const manifest = object(JSON.parse(readFileSync(regularFile(join(root, "package.json")), "utf8")));
  const lock = object(Bun.JSONC.parse(readFileSync(regularFile(join(root, "bun.lock")), "utf8")));
  const rootWorkspace = object(object(lock.workspaces)[""]);
  for (const name of ["miniflare", "esbuild"]) {
    const pin = inputs.packages.find((item) => item.name === name);
    if (!pin || object(manifest.devDependencies)[name] !== pin.version || object(rootWorkspace.devDependencies)[name] !== pin.version)
      throw new Error("Worker runtime requires exact frozen root devDependency " + name);
  }
  const entries = Object.values(object(lock.packages));
  const modules = realpathSync(join(root, "node_modules"));
  const require = createRequire(join(realpathSync(root), "package.json"));
  const packages = inputs.packages.map((pin) => {
    if (!entries.some((entry) => Array.isArray(entry) && entry[0] === `${pin.name}@${pin.version}` && entry.at(-1) === pin.integrity))
      throw new Error("Worker runtime lock version/integrity mismatch: " + pin.name);
    const metadataPath = inside(modules, realpathSync(require.resolve(pin.name + "/package.json")));
    const metadata = object(JSON.parse(readFileSync(regularFile(metadataPath), "utf8")));
    if (metadata.name !== pin.name || metadata.version !== pin.version) throw new Error("Worker runtime installed package mismatch: " + pin.name);
    if (
      pin.name.startsWith("@") &&
      (!Array.isArray(metadata.os) || !metadata.os.includes("linux") || !Array.isArray(metadata.cpu) || !metadata.cpu.includes("arm64"))
    )
      throw new Error("Worker runtime installed platform package mismatch: " + pin.name);
    const entryPath = inside(modules, realpathSync(join(dirname(metadataPath), pin.entry)));
    return {
      name: pin.name,
      version: pin.version,
      integrity: pin.integrity,
      metadataPath,
      metadataSha256: fileHash(metadataPath),
      entryPath,
      entrySha256: pin.name.startsWith("@") ? elfIdentity(entryPath) : fileHash(regularFile(entryPath)),
    };
  });
  const miniflare = packages.find((item) => item.name === "miniflare");
  const workerd = packages.find((item) => item.name === "workerd");
  const esbuild = packages.find((item) => item.name === "esbuild");
  if (!miniflare || !workerd || !esbuild) throw new Error("Worker runtime package graph is incomplete");
  if (object(object(JSON.parse(readFileSync(miniflare.metadataPath, "utf8"))).dependencies).workerd !== workerd.version)
    throw new Error("Miniflare does not bind the pinned workerd version");
  for (const item of [workerd, esbuild]) {
    const optional = object(object(JSON.parse(readFileSync(item.metadataPath, "utf8"))).optionalDependencies);
    const platformName = item.name === "workerd" ? "@cloudflare/workerd-linux-arm64" : "@esbuild/linux-arm64";
    if (optional[platformName] !== item.version) throw new Error("Worker runtime optional binary version mismatch");
  }
  return { modules, packages };
};

/** Read-only consumer: changing any bound source, package, archive or binary invalidates the receipt. */
export const readWorkerTestRuntime = (root = ROOT) => {
  const paths = pathsFor(root);
  for (const directory of [paths.temporary, paths.parent, paths.directory]) privateDirectory(directory);
  const receipt = object(JSON.parse(readFileSync(regularFile(paths.receipt), "utf8")));
  if (receipt.schemaVersion !== 1 || receipt.repository !== paths.repository || receipt.platform !== "linux-arm64")
    throw new Error("Worker runtime receipt identity mismatch");
  if (JSON.stringify(receipt.sources) !== JSON.stringify(sourceIdentity(paths.repository))) throw new Error("Worker runtime source provenance changed");
  const dependencies = workerTestDependencyIdentity(paths.repository);
  if (JSON.stringify(receipt.dependencies) !== JSON.stringify(dependencies)) throw new Error("Worker runtime dependency provenance changed");
  if (
    typeof receipt.preparationDirectory !== "string" ||
    dirname(receipt.preparationDirectory) !== paths.directory ||
    !/^prepare-[\w-]+$/.test(relative(paths.directory, receipt.preparationDirectory))
  )
    throw new Error("Worker runtime receipt preparation path mismatch");
  privateDirectory(receipt.preparationDirectory);
  const nodePath = join(receipt.preparationDirectory, inputs.node.directory, "bin/node");
  const archive = join(receipt.preparationDirectory, "node.tar.xz");
  verifyWorkerTestArchive(readFileSync(regularFile(archive)), inputs.node.sha256);
  if (receipt.nodePath !== nodePath || receipt.nodeVersion !== inputs.node.version || receipt.nodeSha256 !== elfIdentity(nodePath))
    throw new Error("Worker runtime Node identity mismatch");
  return { nodePath, directory: receipt.preparationDirectory, dependencies };
};
const fetchArchive = async (url: string, integrity: string, destination: string): Promise<void> => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Pinned Worker runtime archive returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Worker runtime archive exceeds preparation bound");
  verifyWorkerTestArchive(bytes, integrity);
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
};
const checkedRun = (argv: readonly string[], temporary: string): string => {
  const result = spawnSync(argv[0], argv.slice(1), {
    env: { PATH: "/usr/bin:/bin", TMPDIR: temporary },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("Worker runtime preparation command failed: " + (result.error?.message ?? result.stderr));
  return result.stdout.trim();
};
/** CI preparation only: no arguments, installs, HOME writes or test-time fallback. */
export const prepareWorkerTestRuntime = async (root = ROOT) => {
  assertWorkerTestPlatform();
  if (Bun.version !== "1.4.0") throw new Error("Worker runtime preparation requires Bun 1.4.0");
  const paths = pathsFor(root);
  for (const directory of [paths.temporary, paths.parent, paths.directory]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    privateDirectory(directory);
  }
  const lock = join(paths.directory, ".prepare.lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    // Remove the published binding before any fallible work; a failed refresh cannot leave it valid.
    rmSync(paths.receipt, { force: true });
    const sources = sourceIdentity(paths.repository);
    const dependencies = workerTestDependencyIdentity(paths.repository);
    if (!existsSync("/usr/bin/tar")) throw new Error("Worker runtime preparation requires system tar");
    const preparationDirectory = mkdtempSync(join(paths.directory, "prepare-"));
    const archive = join(preparationDirectory, "node.tar.xz");
    await fetchArchive(inputs.node.url, inputs.node.sha256, archive);
    checkedRun(
      ["/usr/bin/tar", "-xJf", archive, "-C", preparationDirectory, "--no-same-owner", "--no-same-permissions", inputs.node.directory + "/bin/node"],
      preparationDirectory
    );
    for (const pin of inputs.packages) {
      if (!("url" in pin) || typeof pin.url !== "string") continue;
      const binary = dependencies.packages.find((item) => item.name === pin.name);
      if (!binary) throw new Error("Worker runtime platform binary is missing");
      const destination = join(preparationDirectory, pin.name.replaceAll("/", "-").replace("@", ""));
      mkdirSync(destination, { mode: 0o700 });
      const tarball = join(destination, "package.tgz");
      await fetchArchive(pin.url, pin.integrity, tarball);
      checkedRun(
        ["/usr/bin/tar", "-xzf", tarball, "-C", destination, "--no-same-owner", "--no-same-permissions", "package/" + pin.entry],
        preparationDirectory
      );
      if (elfIdentity(join(destination, "package", pin.entry)) !== binary.entrySha256)
        throw new Error("Installed Worker binary differs from its pinned archive");
    }
    const nodePath = join(preparationDirectory, inputs.node.directory, "bin/node");
    const nodeSha256 = elfIdentity(nodePath);
    if (checkedRun([nodePath, "--version"], preparationDirectory) !== "v" + inputs.node.version) throw new Error("Worker runtime Node version mismatch");
    if (
      JSON.stringify(sources) !== JSON.stringify(sourceIdentity(paths.repository)) ||
      JSON.stringify(dependencies) !== JSON.stringify(workerTestDependencyIdentity(paths.repository))
    )
      throw new Error("Worker runtime preparation inputs changed");
    const receipt = {
      schemaVersion: 1,
      repository: paths.repository,
      platform: "linux-arm64",
      preparationDirectory,
      sources,
      dependencies,
      nodePath,
      nodeVersion: inputs.node.version,
      nodeSha256,
    };
    const staged = join(paths.directory, ".receipt-" + randomUUID());
    const fd = openSync(staged, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(receipt, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, paths.receipt);
    return readWorkerTestRuntime(paths.repository);
  } catch (error) {
    rmSync(paths.receipt, { force: true });
    throw error;
  } finally {
    rmdirSync(lock);
  }
};

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Worker runtime preparation accepts no arguments");
  console.log(JSON.stringify(await prepareWorkerTestRuntime()));
}
