import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import inputs from "../tools/native-kv/inputs-darwin-arm64.json";
import type { NativeKvArtifact } from "./build-native-kv.ts";

const inputDirectory = fileURLToPath(new URL("../tools/native-kv/", import.meta.url));
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const pause = (milliseconds: number): Promise<void> => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

const verifiedBytes = async (path: string, expected: string): Promise<Buffer> => {
  const bytes = await readFile(path);
  if (hash(bytes) !== expected) throw new Error(`Darwin native KV checksum mismatch: ${path}`);
  return bytes;
};

const capture = async (command: string[], cwd: string): Promise<string> => {
  const child = Bun.spawn(command, { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Darwin native KV metadata command failed: ${stderr}`);
  return stdout.trim();
};

const signalGroup = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

const settleGroup = async (pid: number): Promise<void> => {
  if (!signalGroup(pid, 0)) return;
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + inputs.recipe.killGraceMs;
  while (Date.now() < deadline && signalGroup(pid, 0)) await pause(50);
  if (signalGroup(pid, 0)) signalGroup(pid, "SIGKILL");
  for (let attempt = 0; attempt < 60 && signalGroup(pid, 0); attempt++) await pause(50);
  if (signalGroup(pid, 0)) throw new Error(`Darwin native KV process group ${pid} did not settle`);
};

const waitForStoppedGroup = async (pid: number, cwd: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await capture(["/bin/ps", "-o", "pgid=,stat=", "-p", String(pid)], cwd);
    const [group, state] = status.split(/\s+/);
    if (Number(group) !== pid) throw new Error("Darwin native KV requires an isolated process group");
    if (state.startsWith("T")) return;
    await pause(10);
  }
  throw new Error("Darwin native KV process did not stop before admission");
};

const run = async (command: string[], cwd: string, logPath: string, environment: Record<string, string>, durationMs = 30_000): Promise<void> => {
  const log = await open(logPath, "a", 0o600);
  const child = spawn("/bin/sh", ["-c", 'kill -STOP "$$"; exec "$@"', "uos-native-kv", ...command], {
    cwd,
    env: environment,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("error", () => {
      resolveExit({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  let admitted = false;
  const state = { timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!child.pid) throw new Error("Darwin native KV could not start its process supervisor");
    const pid = child.pid;
    await log.write(JSON.stringify({ command, cwd, processGroup: pid }) + "\n");
    await waitForStoppedGroup(pid, cwd);
    admitted = true;
    timer = setTimeout(() => {
      state.timedOut = true;
      signalGroup(pid, "SIGTERM");
      escalation = setTimeout(() => signalGroup(pid, "SIGKILL"), inputs.recipe.killGraceMs);
    }, durationMs);
    process.kill(pid, "SIGCONT");
    const result = await exited;
    await settleGroup(pid);
    await log.write(JSON.stringify({ ...result, timedOut: state.timedOut, processGroupSettled: true }) + "\n");
    if (state.timedOut || result.code !== 0) throw new Error(`Darwin native KV command failed; retained log: ${logPath}`);
  } finally {
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    if (child.pid) {
      if (admitted) await settleGroup(child.pid);
      else child.kill("SIGKILL");
    }
    await exited;
    await log.close();
  }
};

const treeHash = async (directory: string): Promise<{ sha256: string; files: number }> => {
  const paths: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const name of await readdir(path)) {
      const child = join(path, name);
      const info = await stat(child);
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) paths.push(relative(directory, child));
      else throw new Error("Unsupported Darwin toolchain file type");
    }
  };
  await visit(directory);
  const entries = [];
  const sorted = paths.toSorted((left, right) => Buffer.from(left).toString("hex").localeCompare(Buffer.from(right).toString("hex"), "en"));
  for (const path of sorted) entries.push({ path, sha256: hash(await readFile(join(directory, path))) });
  return { sha256: hash(Buffer.from(JSON.stringify(entries))), files: entries.length };
};

const download = async (url: string, expected: string, path: string): Promise<void> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Darwin native KV download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== expected) throw new Error("Darwin native KV archive checksum mismatch");
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
};

const prepareToolchain = async (workspace: string, logPath: string, environment: Record<string, string>): Promise<string> => {
  const prefix = join(workspace, "toolchain");
  await mkdir(prefix, { mode: 0o700 });
  for (const component of inputs.toolchain.components) {
    const directory = join(workspace, component.name);
    await mkdir(directory, { mode: 0o700 });
    await download(component.archiveUrl, component.archiveSha256, join(directory, "archive.tar.xz"));
    await run(["/usr/bin/tar", "-xf", "archive.tar.xz"], directory, logPath, environment);
    const source = join(directory, component.directory);
    const tree = await treeHash(source);
    if (tree.sha256 !== component.treeSha256 || tree.files !== component.files) throw new Error(`Darwin ${component.name} tree checksum mismatch`);
    await cp(source, prefix, { recursive: true, force: false });
  }
  await verifiedBytes(join(prefix, "bin", "rustc"), inputs.toolchain.rustcSha256);
  await verifiedBytes(join(prefix, "bin", "cargo"), inputs.toolchain.cargoSha256);
  return prefix;
};

const prepareSource = async (workspace: string, logPath: string, environment: Record<string, string>): Promise<void> => {
  await download(inputs.source.url, inputs.source.archiveSha256, join(workspace, "source.tar.gz"));
  const source = join(workspace, "source");
  await mkdir(source, { mode: 0o700 });
  await run(["/usr/bin/tar", "-xzf", "source.tar.gz", "--strip-components=1", "-C", "source"], workspace, logPath, environment);
  await verifiedBytes(join(source, "Cargo.lock"), inputs.source.upstreamLockSha256);
  await verifiedBytes(join(source, "LICENSE"), inputs.source.licenseSha256);
  for (const patch of inputs.patches) {
    await verifiedBytes(join(inputDirectory, patch.file), patch.sha256);
    await run(["/usr/bin/patch", "-t", "-F", "0", "-p1", "-i", join(inputDirectory, patch.file)], source, logPath, environment);
  }
  const lock = await verifiedBytes(join(inputDirectory, inputs.lock.file), inputs.lock.sha256);
  await verifiedBytes(join(inputDirectory, inputs.lock.auditFile), inputs.lock.auditSha256);
  await verifiedBytes(join(inputDirectory, "LICENSE"), inputs.source.licenseSha256);
  await writeFile(join(source, "Cargo.lock"), lock, { mode: 0o600 });
};

const ensureOutput = async (output: string): Promise<void> => {
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await lstat(output)).isSymbolicLink()) throw new Error("Darwin native KV output must not be a symlink");
  for (const file of [inputs.artifact.file, "native-kv.provenance.json"]) {
    const exists = await lstat(join(output, file)).then(
      () => true,
      (error: unknown) => {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        return false;
      }
    );
    if (exists) throw new Error(`Darwin native KV output already exists: ${file}`);
  }
};

/** Explicit Darwin packaging preparation only; Linux never builds or claims Darwin acceptance. */
export const buildNativeKvDarwin = async (outputDirectory: string): Promise<NativeKvArtifact> => {
  if (process.platform !== "darwin" || process.arch !== "arm64" || Bun.version !== "1.4.0")
    throw new Error("Native KV Darwin build requires Bun 1.4.0 on Darwin ARM64");
  const output = resolve(outputDirectory);
  await ensureOutput(output);
  const temporaryRoot = resolve(process.env.RUNNER_TEMP ?? tmpdir());
  const workspace = await mkdtemp(join(temporaryRoot, "uos-native-kv-darwin-"));
  const buildLogPath = join(workspace, "build.log");
  const baseEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const prefix = await prepareToolchain(workspace, buildLogPath, baseEnvironment);
  const rustc = join(prefix, "bin", "rustc");
  const cargo = join(prefix, "bin", "cargo");
  if ((await capture([rustc, "--version"], workspace)) !== inputs.toolchain.rustcVersion) throw new Error("Pinned Darwin rustc version mismatch");
  if ((await capture([cargo, "--version"], workspace)) !== inputs.toolchain.cargoVersion) throw new Error("Pinned Darwin Cargo version mismatch");
  const clang = await capture(["/usr/bin/xcrun", "--find", "clang"], workspace);
  const sdk = await capture(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"], workspace);
  const environment = {
    ...baseEnvironment,
    CARGO_HOME: join(workspace, "cargo-home"),
    CARGO_TARGET_DIR: join(workspace, "target"),
    RUSTUP_HOME: join(workspace, "rustup-home"),
    RUSTC: rustc,
    CC: clang,
    SDKROOT: sdk,
    MACOSX_DEPLOYMENT_TARGET: inputs.recipe.deploymentTarget,
  };
  await prepareSource(workspace, buildLogPath, environment);
  await run([cargo, ...inputs.recipe.argv.slice(1)], workspace, buildLogPath, environment, inputs.recipe.maximumDurationMs);
  await verifiedBytes(join(workspace, "source", "Cargo.lock"), inputs.lock.sha256);
  const binary = await readFile(join(workspace, "target", inputs.artifact.target, "release", inputs.recipe.library));
  const sha256 = hash(binary);
  const inputsSha256 = hash(await readFile(join(inputDirectory, "inputs-darwin-arm64.json")));
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
    build: {
      exitCode: 0,
      logSha256: hash(await readFile(buildLogPath)),
      apple: {
        clang,
        clangSha256: hash(await readFile(clang)),
        clangVersion: await capture([clang, "--version"], workspace),
        sdk,
        sdkVersion: await capture(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version"], workspace),
      },
    },
  };
  const provenanceBytes = Buffer.from(JSON.stringify(provenance, null, 2) + "\n");
  const path = join(output, inputs.artifact.file);
  const provenancePath = join(output, "native-kv.provenance.json");
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

if (import.meta.main) console.log(JSON.stringify(await buildNativeKvDarwin(fileURLToPath(new URL("../.tmp/native-kv-darwin", import.meta.url)))));
