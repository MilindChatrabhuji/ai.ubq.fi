import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "rust-linux-guest");
const ROOT = resolve(DATA, "../..");
const HOSTS = new Set(["kernel.ubuntu.com", "cloud-images.ubuntu.com"]);
const MAX_LOG = 8 * 1024 * 1024;
const OVERLAY_BYTES = 8 * 1024 ** 3;
export const ROOT_GROWTH_CONFIG = "growpart:\n  mode: auto\n  devices: [/]\n  ignore_growroot_disabled: false\nresize_rootfs: true\n";
export function overlayResizeArgv(work: string, target: string, base: string, virtualBytes: unknown, freeBytes: number): string[] {
  assert(isAbsolute(work) && resolve(work) === work && basename(work).startsWith("uos-linux-guest-"), "Expected private task directory");
  assert(target === join(work, "overlay.qcow2") && target !== base, "Only the task overlay may be resized");
  assert(typeof virtualBytes === "number" && virtualBytes > 0 && virtualBytes <= OVERLAY_BYTES, "Refuse shrinking the source disk");
  assert(Number.isSafeInteger(freeBytes) && freeBytes >= OVERLAY_BYTES, "Overlay requires eight GiB of remaining ephemeral disk headroom");
  return ["/usr/bin/qemu-img", "resize", "-f", "qcow2", target, String(OVERLAY_BYTES)];
}
const START = Date.now();
const budget = (limit: number): number => {
  const remaining = 1_200_000 - (Date.now() - START);
  assert(remaining > 0, "Controller deadline exceeded");
  return Math.min(limit, remaining);
};
export type Artifact = { name: string; url: string; sha256: string; maxBytes: number };
type Signature = { keyring: string; keyringSha256: string; fingerprint: string; checksums: Artifact; signature: Artifact; members: string[] };
export type Inputs = { kernelRelease: string; configSha256: string; kernel: Artifact; modules: Artifact; disk: Artifact; signatures: Signature[] };
export type Expected = {
  nonce: string;
  sourceSha: string;
  kernelRelease: string;
  configSha256: string;
  hashes: { kernel: string; modules: string; probe: string };
};
export type Result = {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  pid?: number;
  cleanup?: { childExited: boolean; streamsSettled: boolean; groupAbsent: boolean };
};
type Observer = (stream: "serial" | "stderr", chunk: Uint8Array) => void;
export type Runner = (argv: string[], cwd: string, timeout?: number, observe?: Observer) => Promise<Result>;
// Internal capture error: preserve partial output and the original cause after settlement.
export class CommandFailure extends Error {
  #result: Result;
  constructor(result: Result, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.#result = result;
    this.name = "CommandFailure";
  }
  get result(): Result {
    return this.#result;
  }
}
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const table = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected data object");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  assert(typeof value === "string" && value.length > 0);
  return value;
};
const hash = (value: unknown): string => {
  const valueText = text(value);
  assert(/^[a-f0-9]{64}$/.test(valueText), "Invalid SHA256");
  return valueText;
};
export function probeRequest(event: string | undefined, value: unknown): boolean {
  return event === "workflow_dispatch" && (value === true || value === "true");
}
export function parseArtifact(value: unknown): Artifact {
  const item = table(value),
    name = text(item.name),
    url = text(item.url);
  const parsed = new URL(url);
  assert(
    /^[a-z0-9.-]+$/.test(name) && !name.startsWith(".") && parsed.protocol === "https:" && HOSTS.has(parsed.hostname) && !parsed.username && !parsed.password
  );
  assert(Number.isSafeInteger(item.maxBytes) && typeof item.maxBytes === "number" && item.maxBytes > 0 && item.maxBytes <= 3 * 1024 ** 3);
  return { name, url, sha256: hash(item.sha256), maxBytes: item.maxBytes };
}
export function loadInputs(value: unknown): Inputs {
  const input = table(value);
  assert(input.v === 1 && Array.isArray(input.signatures));
  const signatures = input.signatures.map((raw): Signature => {
    const item = table(raw),
      keyring = text(item.keyring),
      fingerprint = text(item.fingerprint);
    assert(/^[a-z-]+\.gpg$/.test(keyring) && /^[A-F0-9]{40}$/.test(fingerprint));
    assert(Array.isArray(item.members) && item.members.every((member) => ["kernel", "modules", "disk"].includes(String(member))));
    return {
      keyring,
      keyringSha256: hash(item.keyringSha256),
      fingerprint,
      checksums: parseArtifact(item.checksums),
      signature: parseArtifact(item.signature),
      members: item.members.map(text),
    };
  });
  assert(
    signatures.length === 2 &&
      signatures
        .flatMap((item) => item.members)
        .sort((left, right) => left.localeCompare(right))
        .join() === "disk,kernel,modules"
  );
  const kernelRelease = text(input.kernelRelease);
  assert(/^7\.2\.6-070206-generic$/.test(kernelRelease));
  return {
    kernelRelease,
    configSha256: hash(input.configSha256),
    kernel: parseArtifact(input.kernel),
    modules: parseArtifact(input.modules),
    disk: parseArtifact(input.disk),
    signatures,
  };
}
export function verifyBytes(bytes: Uint8Array, artifact: Artifact): void {
  assert(bytes.byteLength <= artifact.maxBytes && digest(bytes) === artifact.sha256, "Pinned input hash/size mismatch");
}
export function verifyChecksum(textValue: string, artifact: Artifact): void {
  const name = basename(new URL(artifact.url).pathname);
  assert(
    textValue.split("\n").some((line) => line.includes(artifact.sha256) && line.trim().endsWith(name)),
    "Signed checksum member mismatch"
  );
}
export function qemuArgv(work: string, firmware: string): string[] {
  assert(
    isAbsolute(work) &&
      !Array.from(work).some((character) => character === "," || character.charCodeAt(0) < 32) &&
      firmware === "/usr/share/AAVMF/AAVMF_CODE.fd"
  );
  return [
    "/usr/bin/qemu-system-aarch64",
    "-machine",
    "virt",
    "-cpu",
    "cortex-a57",
    "-accel",
    "tcg,thread=multi",
    "-smp",
    "2",
    "-m",
    "4096",
    "-drive",
    `if=pflash,format=raw,unit=0,file=${firmware},readonly=on`,
    "-drive",
    `if=pflash,format=raw,unit=1,file=${join(work, "vars.fd")}`,
    "-drive",
    `if=virtio,format=qcow2,file=${join(work, "overlay.qcow2")}`,
    "-drive",
    `if=virtio,format=raw,file=${join(work, "seed.iso")},readonly=on`,
    "-nic",
    "none",
    "-nographic",
    "-monitor",
    "none",
    "-rtc",
    "base=utc,clock=host",
  ];
}
function validateBody(value: unknown, expected: Expected): Record<string, unknown> {
  const body = table(value),
    calls = table(body.syscalls),
    hashes = table(body.hashes);
  const keys = [
    "v",
    "nonce",
    "sourceSha",
    "phase",
    "initialBootId",
    "bootId",
    "kernelRelease",
    "arch",
    "configSha256",
    "lsm",
    "hashes",
    "probeExit",
    "syscalls",
  ].sort((left, right) => left.localeCompare(right));
  assert.deepEqual(
    Object.keys(body).sort((left, right) => left.localeCompare(right)),
    keys
  );
  assert(body.v === 1 && body.nonce === expected.nonce && body.sourceSha === expected.sourceSha && body.phase === "post-kernel-reboot");
  assert(body.kernelRelease === expected.kernelRelease && body.arch === "aarch64" && body.configSha256 === expected.configSha256);
  assert(
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(text(body.bootId)) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(text(body.initialBootId)) &&
      body.bootId !== body.initialBootId,
    "Actual reboot required"
  );
  assert(text(body.lsm).split(",").includes("landlock") && body.probeExit === 0);
  assert.deepEqual(hashes, expected.hashes);
  assert.deepEqual(
    Object.keys(calls).sort((left, right) => left.localeCompare(right)),
    ["abi", "abiErrno", "createResult", "createErrno", "closeResult", "closeErrno", "attrBytes", "fsMask", "netMask", "scopedMask"].sort((left, right) =>
      left.localeCompare(right)
    )
  );
  assert(typeof calls.abi === "number" && Number.isInteger(calls.abi) && calls.abi >= 9 && calls.abiErrno === 0);
  assert(
    typeof calls.createResult === "number" &&
      Number.isInteger(calls.createResult) &&
      calls.createResult >= 0 &&
      calls.createErrno === 0 &&
      calls.closeResult === 0 &&
      calls.closeErrno === 0
  );
  assert(calls.attrBytes === 24 && calls.fsMask === 0x1ffff && calls.netMask === 3 && calls.scopedMask === 3);
  return body;
}
export function validateReceipt(serial: string, expected: Expected, exitCode: number): Record<string, unknown> {
  assert(exitCode === 0 && serial.length <= MAX_LOG && !serial.includes("UOS_LINUX_GUEST_ERROR"), "QEMU/provisioning failure");
  const lines = serial.replaceAll("\r\n", "\n").split("\n"),
    starts = lines.filter((line) => line.startsWith("UOS_LINUX_GUEST_RECEIPT ")),
    ends = lines.filter((line) => line.startsWith("UOS_LINUX_GUEST_DONE "));
  assert(starts.length === 1 && ends.length === 1 && lines.indexOf(starts[0]) < lines.indexOf(ends[0]), "Exactly one complete receipt required");
  const raw = starts[0].slice("UOS_LINUX_GUEST_RECEIPT ".length);
  assert(ends[0] === `UOS_LINUX_GUEST_DONE ${expected.nonce} ${digest(raw)}`, "Receipt terminal digest mismatch");
  return validateBody(JSON.parse(raw) as unknown, expected);
}
type Capture = { chunks: Uint8Array[]; size: number };
function groupAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
}
async function bounded(stream: ReadableStream<Uint8Array>, stop: () => void, capture: Capture, observe?: (chunk: Uint8Array) => void): Promise<void> {
  for await (const chunk of stream) {
    const available = MAX_LOG - capture.size,
      admitted = chunk.subarray(0, available);
    capture.chunks.push(admitted);
    capture.size += admitted.length;
    if (admitted.length) observe?.(admitted);
    if (chunk.length > available) {
      stop();
      throw new Error("Command log limit exceeded");
    }
  }
}
// No output is published here; only executeProbe's fixed QEMU path supplies an observer.
export async function captureCommand(argv: string[], cwd: string, timeout = 60_000, observe?: Observer): Promise<Result> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(cwd, "home"), GNUPGHOME: join(cwd, "gnupg"), LC_ALL: "C" };
  if (process.env.RUNNER_TRACKING_ID) env.RUNNER_TRACKING_ID = process.env.RUNNER_TRACKING_ID;
  const timeoutMs = budget(timeout);
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let stopSent = false;
  const stop = (): void => {
    if (stopSent) return;
    try {
      process.kill(-child.pid, "SIGKILL");
      stopSent = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH") && !groupAbsent(child.pid)) throw error;
    }
  };
  let expired = false,
    failure: unknown;
  const timer = setTimeout(() => {
    expired = true;
    stop();
  }, timeoutMs);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const out: Capture = { chunks: [], size: 0 },
    err: Capture = { chunks: [], size: 0 };
  const stdout = bounded(child.stdout, stop, out, (chunk) => {
      observe?.("serial", chunk);
    }),
    stderr = bounded(child.stderr, stop, err, (chunk) => {
      observe?.("stderr", chunk);
    });
  try {
    await Promise.all([child.exited, stdout, stderr]);
    assert(!expired, "Command deadline exceeded");
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    stop();
    await child.exited;
    await Promise.allSettled([stdout, stderr]);
  }
  const result: Result = {
    code: await child.exited,
    signal: child.signalCode,
    timedOut: expired,
    pid: child.pid,
    stdout: Buffer.concat(out.chunks).toString("utf8"),
    stderr: Buffer.concat(err.chunks).toString("utf8"),
    cleanup: { childExited: true, streamsSettled: true, groupAbsent: groupAbsent(child.pid) },
  };
  if (failure !== undefined) throw new CommandFailure(result, failure);
  return result;
}
async function checked(argv: string[], cwd: string): Promise<Result> {
  const result = await captureCommand(argv, cwd);
  assert.equal(result.code, 0, `${argv[0]} failed: ${result.stderr.slice(-2000)}`);
  return result;
}
async function download(artifact: Artifact, work: string): Promise<string> {
  let url = artifact.url;
  for (let redirect = 0; redirect < 4; redirect++) {
    const parsed = new URL(url);
    assert(parsed.protocol === "https:" && HOSTS.has(parsed.hostname) && !parsed.username && !parsed.password);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(budget(300_000)), credentials: "omit" });
    if (response.status >= 300 && response.status < 400) {
      url = new URL(text(response.headers.get("location")), url).href;
      continue;
    }
    assert(response.status === 200 && response.body, `Input HTTP ${response.status}`);
    const path = join(work, artifact.name),
      file = Bun.file(path).writer(),
      sha = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        assert(size <= artifact.maxBytes, "Input size cap exceeded");
        sha.update(chunk);
        await file.write(chunk);
        await file.flush();
      }
    } finally {
      await file.end();
    }
    assert.equal(sha.digest("hex"), artifact.sha256, "Pinned input SHA256 mismatch");
    return path;
  }
  throw new Error("Input redirect cap exceeded");
}
async function authenticatedInputs(input: Inputs, work: string): Promise<void> {
  for (const group of input.signatures) {
    const keyring = join(DATA, group.keyring);
    assert.equal(digest(await readFile(keyring)), group.keyringSha256);
    const sums = join(DATA, group.checksums.name),
      signature = join(DATA, group.signature.name);
    verifyBytes(await readFile(sums), group.checksums);
    verifyBytes(await readFile(signature), group.signature);
    const result = await checked(["/usr/bin/gpgv", "--status-fd", "1", "--keyring", keyring, signature, sums], work);
    const valid = result.stdout.split("\n").filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
    assert(valid.length === 1 && valid[0].split(" ").includes(group.fingerprint), "Unexpected checksum signer");
    for (const name of group.members) verifyChecksum(await readFile(sums, "utf8"), input[name as "kernel" | "modules" | "disk"]);
  }
}
async function preparePayload(input: Inputs, work: string, sourceSha: string): Promise<Expected> {
  await authenticatedInputs(input, work);
  for (const item of [input.kernel, input.modules, input.disk]) await download(item, work);
  await checked(["/usr/bin/dpkg-deb", "-x", join(work, input.modules.name), join(work, "module-config")], work);
  const config = await readFile(join(work, "module-config/boot", `config-${input.kernelRelease}`), "utf8");
  assert.equal(digest(config), input.configSha256);
  assert(config.includes("CONFIG_SECURITY_LANDLOCK=y") && /^CONFIG_LSM=.*landlock/m.test(config));
  await rm(join(work, "module-config"), { recursive: true });
  const payload = join(work, "payload");
  await mkdir(payload);
  for (const [from, to] of [
    [input.kernel.name, "kernel.deb"],
    [input.modules.name, "modules.deb"],
  ])
    await copyFile(join(work, from), join(payload, to));
  for (const name of ["provision.sh", "receipt.py"]) await copyFile(join(DATA, name), join(payload, name));
  await checked(["/usr/bin/gcc", "-O2", "-static", "-o", join(payload, "probe"), join(DATA, "probe.c")], work);
  const expected: Expected = {
    nonce: randomBytes(16).toString("hex"),
    sourceSha,
    kernelRelease: input.kernelRelease,
    configSha256: input.configSha256,
    hashes: { kernel: input.kernel.sha256, modules: input.modules.sha256, probe: digest(await readFile(join(payload, "probe"))) },
  };
  await writeFile(join(payload, "expected.json"), JSON.stringify(expected));
  const names = ["kernel.deb", "modules.deb", "probe", "expected.json", "provision.sh", "receipt.py"];
  await writeFile(
    join(payload, "payload.sha256"),
    (await Promise.all(names.map(async (name) => `${digest(await readFile(join(payload, name)))}  ${name}`))).join("\n") + "\n"
  );
  await writeFile(join(payload, "meta-data"), `instance-id: uos-${expected.nonce}\nlocal-hostname: uos-capability-probe\n`);
  await writeFile(
    join(payload, "user-data"),
    "#cloud-config\nusers: []\nssh_pwauth: false\n" +
      ROOT_GROWTH_CONFIG +
      "runcmd:\n  - [mkdir, -p, /mnt/uos-seed]\n  - [mount, -o, ro, /dev/disk/by-label/CIDATA, /mnt/uos-seed]\n  - [sh, /mnt/uos-seed/provision.sh]\n"
  );
  await checked(
    ["/usr/bin/genisoimage", "-output", join(work, "seed.iso"), "-volid", "CIDATA", "-joliet", "-rock", ...names, "payload.sha256", "meta-data", "user-data"],
    payload
  );
  return expected;
}
export async function executeProbe(
  argv: string[],
  expected: Expected,
  work: string,
  run: Runner,
  emit: (line: string) => void = console.log
): Promise<Record<string, unknown>> {
  assert(argv[0] === "/usr/bin/qemu-system-aarch64", "Public diagnostics are restricted to the fixed QEMU executable");
  let result: Result | undefined;
  try {
    result = await run(argv, work, 900_000, (stream, chunk) => {
      emit(`UOS_LINUX_GUEST_QEMU_${stream.toUpperCase()} ${JSON.stringify(Buffer.from(chunk).toString("utf8"))}`);
    });
    assert(result.cleanup?.groupAbsent !== false, "QEMU process group still present after cleanup");
    return validateReceipt(result.stdout, expected, result.code);
  } catch (error) {
    const captured = error instanceof CommandFailure ? error.result : result;
    emit(
      "UOS_LINUX_GUEST_QEMU_FAILURE " +
        JSON.stringify({
          exit: captured?.code ?? null,
          signal: captured?.signal ?? null,
          timedOut: captured?.timedOut ?? null,
          pid: captured?.pid ?? null,
          cleanup: captured?.cleanup ?? null,
          originalException: String(error instanceof CommandFailure ? error.cause : error).slice(-4096),
          originalStack: error instanceof Error ? (error.stack?.slice(-4096) ?? "") : "",
          serialBytes: Buffer.byteLength(captured?.stdout ?? ""),
          stderrBytes: Buffer.byteLength(captured?.stderr ?? ""),
          serialTail: captured?.stdout.slice(-4096) ?? "",
          stderrTail: captured?.stderr.slice(-4096) ?? "",
        })
    );
    throw error;
  }
}
async function main(): Promise<void> {
  assert(process.platform === "linux" && process.arch === "arm64" && Bun.version === "1.4.0", "Probe requires the pinned Linux ARM64 CI host");
  const event = table(JSON.parse(readFileSync(text(process.env.GITHUB_EVENT_PATH), "utf8")) as unknown);
  assert(
    process.env.GITHUB_ACTIONS === "true" && probeRequest(process.env.GITHUB_EVENT_NAME, table(event.inputs).linux_capability_probe),
    "Only explicit manual probe dispatch is authorized"
  );
  const sourceSha = text(process.env.GITHUB_SHA);
  assert(/^[a-f0-9]{40}$/.test(sourceSha));
  const temp = text(process.env.RUNNER_TEMP);
  assert(isAbsolute(temp));
  const space = await statfs(temp);
  assert(space.bavail * space.bsize >= 8 * 1024 ** 3, "Probe requires eight GiB of ephemeral disk headroom");
  const work = await mkdtemp(join(temp, "uos-linux-guest-"));
  await chmod(work, 0o700);
  try {
    for (const name of ["home", "gnupg"]) await mkdir(join(work, name), { mode: 0o700 });
    assert.equal((await checked(["/usr/bin/git", "-C", ROOT, "rev-parse", "HEAD"], work)).stdout.trim(), sourceSha);
    assert.equal(
      (await checked(["/usr/bin/git", "-C", ROOT, "status", "--porcelain", "--untracked-files=no"], work)).stdout.trim(),
      "",
      "Committed probe source must be clean"
    );
    const input = loadInputs(JSON.parse(await readFile(join(DATA, "inputs.json"), "utf8")) as unknown);
    console.log("UOS_LINUX_GUEST_STAGE prepare-inputs:start");
    const expected = await preparePayload(input, work, sourceSha);
    console.log("UOS_LINUX_GUEST_STAGE prepare-inputs:complete");
    const info = table(JSON.parse((await checked(["/usr/bin/qemu-img", "info", "--output=json", join(work, input.disk.name)], work)).stdout) as unknown);
    assert(info.format === "qcow2" && !info["backing-filename"], "Unexpected root disk backing chain");
    await checked(["/usr/bin/qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", join(work, input.disk.name), join(work, "overlay.qcow2")], work);
    await copyFile("/usr/share/AAVMF/AAVMF_VARS.fd", join(work, "vars.fd"));
    const overlay = join(work, "overlay.qcow2"),
      metadata = await lstat(overlay),
      remainingSpace = await statfs(work);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.uid === process.geteuid?.(), "Expected owned regular overlay");
    await checked(overlayResizeArgv(work, overlay, join(work, input.disk.name), info["virtual-size"], remainingSpace.bavail * remainingSpace.bsize), work);
    console.log("UOS_LINUX_GUEST_STAGE overlay-capacity:8589934592");
    console.log("UOS_LINUX_GUEST_STAGE qemu:start");
    const result = await executeProbe(qemuArgv(work, "/usr/share/AAVMF/AAVMF_CODE.fd"), expected, work, captureCommand);
    console.log("UOS_LINUX_GUEST_STAGE qemu:complete");
    console.log(
      JSON.stringify({
        sourceSha,
        selectedInputs: input,
        hostKernel: (await checked(["/usr/bin/uname", "-r"], work)).stdout.trim(),
        guest: result,
        qemuVersion: (await checked(["/usr/bin/qemu-system-aarch64", "--version"], work)).stdout.trim(),
        imagesOrCachesUploaded: false,
      })
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
if (import.meta.main) await main();
