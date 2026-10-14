import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import inputs from "../tools/native-kv/inputs.json";

export type NativeKvArtifact = {
  path: string;
  sha256: string;
  provenancePath: string;
  provenanceSha256: string;
  inputsSha256: string;
  sourceSha256: string;
  patchSha256: string;
  workspacePatchSha256: string;
  lockSha256: string;
  registryChecksumsSha256: string;
  target: string;
  platform: string;
  architecture: string;
  napiVersion: number;
  buildLogPath: string;
};

type LockedPackage = { name: string; version: string; source?: string; checksum?: string };
const inputDirectory = fileURLToPath(new URL("../tools/native-kv/", import.meta.url));
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const verifiedBytes = async (path: string, expected: string): Promise<Buffer> => {
  const bytes = await readFile(path);
  if (hash(bytes) !== expected) throw new Error(`Native KV input checksum mismatch: ${path}`);
  return bytes;
};

const lockedPackages = (text: string): LockedPackage[] =>
  text
    .split("[[package]]")
    .slice(1)
    .map((block) => {
      const fields = Object.fromEntries(Array.from(block.matchAll(/^(name|version|source|checksum) = "([^"]+)"$/gm), (match) => [match[1], match[2]]));
      if (!fields.name || !fields.version) throw new Error("Invalid native KV Cargo lock");
      return {
        name: fields.name,
        version: fields.version,
        ...(fields.source ? { source: fields.source } : {}),
        ...(fields.checksum ? { checksum: fields.checksum } : {}),
      };
    });

const verifyLock = (upstream: string, derived: string): void => {
  const original = lockedPackages(upstream);
  const resolved = lockedPackages(derived);
  const key = (entry: LockedPackage): string => JSON.stringify([entry.name, entry.version, entry.source]);
  const byKey = new Map(resolved.map((entry) => [key(entry), entry]));
  if (original.length !== inputs.lock.preservedPackages) throw new Error("Native KV upstream lock package count mismatch");
  for (const entry of original) {
    const frozen = byKey.get(key(entry));
    if (!frozen || frozen.checksum !== entry.checksum) throw new Error(`Native KV lock changed upstream package: ${entry.name}@${entry.version}`);
  }
  const registry = resolved.filter((entry) => entry.checksum);
  if (registry.length !== inputs.lock.registryPackages || hash(Buffer.from(JSON.stringify(registry))) !== inputs.lock.registryChecksumsSha256) {
    throw new Error("Native KV registry checksum inventory mismatch");
  }
};

const run = async (command: string[], cwd: string, logPath: string, environment: Record<string, string>, durationMs = 30_000): Promise<void> => {
  const log = await open(logPath, "a", 0o600);
  try {
    await log.write(JSON.stringify({ command, cwd }) + "\n");
    // GNU timeout owns the child process group and settles compiler descendants.
    const child = Bun.spawn(["timeout", "--kill-after=10s", `${durationMs / 1000}s`, ...command], {
      cwd,
      env: environment,
      stdout: log.fd,
      stderr: log.fd,
    });
    const code = await child.exited;
    await log.write(JSON.stringify({ exitCode: code }) + "\n");
    if (code !== 0) throw new Error(`Native KV command failed (${code}); retained log: ${logPath}`);
  } finally {
    await log.close();
  }
};

const prepareSource = async (workspace: string, logPath: string, environment: Record<string, string>): Promise<string> => {
  const response = await fetch(inputs.source.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Native KV source download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (hash(archive) !== inputs.source.archiveSha256) throw new Error("Native KV source archive checksum mismatch");
  await writeFile(join(workspace, "source.tar.gz"), archive, { mode: 0o600, flag: "wx" });
  const source = join(workspace, "source");
  await mkdir(source, { mode: 0o700 });
  await run(["tar", "-xzf", "source.tar.gz", "--strip-components=1", "-C", "source"], workspace, logPath, environment);
  const originalLock = await verifiedBytes(join(source, "Cargo.lock"), inputs.source.upstreamLockSha256);
  await verifiedBytes(join(source, "LICENSE"), inputs.source.licenseSha256);
  await verifiedBytes(join(inputDirectory, "LICENSE"), inputs.source.licenseSha256);
  const frozenLock = await verifiedBytes(join(inputDirectory, inputs.lock.file), inputs.lock.sha256);
  await verifiedBytes(join(inputDirectory, inputs.lock.auditFile), inputs.lock.auditSha256);
  verifyLock(originalLock.toString(), frozenLock.toString());
  for (const patch of inputs.patches) {
    await verifiedBytes(join(inputDirectory, patch.file), patch.sha256);
    await run(["patch", "--batch", "--fuzz=0", "-p1", "-i", join(inputDirectory, patch.file)], source, logPath, environment);
  }
  await writeFile(join(source, "Cargo.lock"), frozenLock, { mode: 0o600 });
  return source;
};

/** CI/packaging preparation only; application startup verifies and loads prepared immutable bytes. */
export const buildNativeKv = async (outputDirectory: string, options: { toolchainDirectory?: string } = {}): Promise<NativeKvArtifact> => {
  if (process.platform !== inputs.artifact.platform || process.arch !== inputs.artifact.architecture || Bun.version !== "1.4.0") {
    throw new Error("Native KV build requires pinned Bun 1.4.0 on Linux ARM64");
  }
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await lstat(output)).isSymbolicLink()) throw new Error("Native KV output directory must not be a symlink");
  const path = join(output, inputs.artifact.file);
  const provenancePath = join(output, "native-kv.provenance.json");
  for (const destination of [path, provenancePath]) {
    if (
      await lstat(destination).then(
        () => true,
        (error: unknown) => {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
          return false;
        }
      )
    ) {
      throw new Error(`Native KV output already exists: ${destination}`);
    }
  }
  const workspace = await mkdtemp(join(tmpdir(), "uos-native-kv-"));
  const buildLogPath = join(workspace, "build.log");
  const toolchain = options.toolchainDirectory ?? join(homedir(), ".rustup", "toolchains", `stable-${inputs.artifact.target}`, "bin");
  const rustc = join(toolchain, "rustc");
  const cargo = join(toolchain, "cargo");
  await verifiedBytes(rustc, inputs.toolchain.rustcSha256);
  await verifiedBytes(cargo, inputs.toolchain.cargoSha256);
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    CARGO_HOME: join(workspace, "cargo-home"),
    CARGO_TARGET_DIR: join(workspace, "target"),
    RUSTC: rustc,
  };
  await run([rustc, "--version"], workspace, buildLogPath, environment);
  await run([cargo, "--version"], workspace, buildLogPath, environment);
  const source = await prepareSource(workspace, buildLogPath, environment);
  const argv = [cargo, ...inputs.recipe.argv.slice(1)];
  await run(argv, workspace, buildLogPath, environment, inputs.recipe.maximumDurationMs);
  await verifiedBytes(join(source, "Cargo.lock"), inputs.lock.sha256);
  const binary = await readFile(join(workspace, "target", inputs.artifact.target, "release", "libdeno_kv_napi.so"));
  const sha256 = hash(binary);
  const inputsSha256 = hash(await readFile(join(inputDirectory, "inputs.json")));
  const provenance = {
    schema: 1,
    inputsSha256,
    artifact: { ...inputs.artifact, sha256 },
    sdk: inputs.sdk,
    source: inputs.source,
    patches: inputs.patches,
    lock: inputs.lock,
    toolchain: inputs.toolchain,
    recipe: inputs.recipe,
    build: { exitCode: 0, logSha256: hash(await readFile(buildLogPath)) },
  };
  const provenanceBytes = Buffer.from(JSON.stringify(provenance, null, 2) + "\n");
  await writeFile(path, binary, { mode: 0o600, flag: "wx" });
  await writeFile(provenancePath, provenanceBytes, { mode: 0o600, flag: "wx" });
  await copyFile(join(inputDirectory, "LICENSE"), join(output, "LICENSE"));
  return {
    path,
    sha256,
    provenancePath,
    provenanceSha256: hash(provenanceBytes),
    inputsSha256,
    sourceSha256: inputs.source.archiveSha256,
    patchSha256: inputs.patches[0].sha256,
    workspacePatchSha256: inputs.patches[1].sha256,
    lockSha256: inputs.lock.sha256,
    registryChecksumsSha256: inputs.lock.registryChecksumsSha256,
    ...inputs.artifact,
    buildLogPath,
  };
};

if (import.meta.main) {
  console.log(JSON.stringify(await buildNativeKv(fileURLToPath(new URL("../.tmp/native-kv", import.meta.url)))));
}
