import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { openLegacyCodec } from "../src/kv-conversion/legacy-codec.ts";
import { ensureCaddyIngressReady, healthServesRelease, reloadCaddyIngress } from "./vps-ingress.ts";
import { runtimePath, selectedRuntime, verifyRuntimeBinary } from "./bun-runtime.ts";
import { command, digest, exists, fileDigest } from "./io.ts";
import type { CapturedCutoverArtifact } from "./cutover-artifact.ts";
import type { StoredVpsPrior, VpsCommand } from "./vps-release-store.ts";
import { assertCutoverExecStart, cutoverDropinDigest, cutoverSupervisorUnit, readCutoverExecStart } from "./cutover-unit.ts";

export type CutoverSystem = Readonly<{ run: VpsCommand; fetch: typeof fetch }>;
export const nativeCutoverSystem: CutoverSystem = {
  run: (program, args, cwd) => command(program, args, { cwd }),
  fetch,
};
const service = "ai-ubq-fi.service";
export function assertCutoverMemoryLimit(expectedBytes: number, observed: string): void {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 512 * 1024 * 1024 || expectedBytes > 4 * 1024 * 1024 * 1024 || observed !== String(expectedBytes))
    throw new Error("The kernel did not enforce the explicit finite supervisor memory budget");
}
type HolderChild = { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill: (signal: "SIGKILL") => unknown };
export async function boundedCutoverHolderCheck(child: HolderChild, timeoutMs = 30_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error("Invalid holder-check deadline");
  }
  const timeout = { triggered: false };
  let settled = false;
  const timer = setTimeout(() => {
    timeout.triggered = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    settled = true;
    if (timeout.triggered) throw new Error("Database-holder check exceeded its deadline");
    return { output, errors, code };
  } finally {
    clearTimeout(timer);
    if (!settled) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}
export class CutoverHost {
  constructor(
    readonly root: string,
    readonly system: CutoverSystem = nativeCutoverSystem
  ) {}
  run = (program: string, args: string[]) => this.system.run(program, args, this.root);
  async serviceState(): Promise<{ state: string; pid: number }> {
    const output = await this.run("sudo", ["-n", "systemctl", "show", service, "-p", "ActiveState", "-p", "MainPID"]);
    const fields = Object.fromEntries(output.split("\n").map((line) => line.split("=")));
    if (!fields.ActiveState || !/^\d+$/.test(fields.MainPID ?? "")) throw new Error("Unavailable service identity");
    return { state: fields.ActiveState, pid: Number(fields.MainPID) };
  }
  async loadedUnit(): Promise<{ sha256: string; needsReload: boolean; pid: number; startedMonotonic: string }> {
    const observed = await this.run("sudo", [
      "-n",
      "systemctl",
      "show",
      service,
      "-p",
      "ExecStart",
      "-p",
      "TimeoutStopUSec",
      "-p",
      "DropInPaths",
      "-p",
      "NeedDaemonReload",
      "-p",
      "MainPID",
      "-p",
      "ExecMainStartTimestampMonotonic",
    ]);
    const fields = Object.fromEntries(observed.split("\n").map((line) => line.split("=")));
    if (!/^\d+$/.test(fields.MainPID ?? "") || !/^\d+$/.test(fields.ExecMainStartTimestampMonotonic ?? ""))
      throw new Error("Loaded prior process identity is unavailable");
    return {
      sha256: digest(observed),
      needsReload: fields.NeedDaemonReload === "yes",
      pid: Number(fields.MainPID),
      startedMonotonic: fields.ExecMainStartTimestampMonotonic,
    };
  }
  async supervisorMemory(expectedBytes: number): Promise<void> {
    const group = /^0::(.+)$/m.exec(await readFile("/proc/self/cgroup", "utf8"))?.[1];
    if (!group || !Number.isSafeInteger(expectedBytes) || expectedBytes < 512 * 1024 * 1024 || expectedBytes > 4 * 1024 * 1024 * 1024)
      throw new Error("An explicit finite supervisor memory budget is required");
    const actual = (await readFile(join("/sys/fs/cgroup", group, "memory.max"), "utf8")).trim();
    assertCutoverMemoryLimit(expectedBytes, actual);
    if ((await readFile(join("/sys/fs/cgroup", group, "memory.swap.max"), "utf8")).trim() !== "0") throw new Error("Supervisor swap is not disabled");
  }
  async reassertSupervisorMemory(expectedBytes: number): Promise<void> {
    assertCutoverMemoryLimit(expectedBytes, String(expectedBytes));
    const group = /^0::(.+)$/m.exec(await readFile("/proc/self/cgroup", "utf8"))?.[1];
    if (!group) throw new Error("Supervisor cgroup is unavailable");
    const unit = cutoverSupervisorUnit(group);
    if ((await this.run("sudo", ["-n", "systemctl", "show", unit, "-p", "ControlGroup", "--value"])) !== group)
      throw new Error("Runtime resource update does not belong to this exact supervisor");
    await this.run("sudo", ["-n", "systemctl", "set-property", "--runtime", unit, `MemoryMax=${expectedBytes}`, "MemorySwapMax=0"]);
    await this.supervisorMemory(expectedBytes);
  }
  async verifyBootstrap(artifact: CapturedCutoverArtifact): Promise<string> {
    for (const name of [
      "ops/ai-ubq-fi.service",
      "ops/launch-vps.sh",
      "ops/runtime-bunfig.toml",
      "ops/verify-legacy-rollback.ts",
      "ops/io.ts",
      "src/kv-conversion/legacy-codec.ts",
      "ops/Caddyfile",
    ]) {
      const path = join(this.root, name),
        info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (await fileDigest(path)) !== (await fileDigest(join(artifact.directory, name))))
        throw new Error("Mutable service bootstrap differs from the accepted artifact");
    }
    const fragment = await this.run("sudo", ["-n", "systemctl", "show", service, "-p", "FragmentPath", "--value"]);
    if ((await realpath(fragment)) !== join(this.root, "ops/ai-ubq-fi.service")) throw new Error("Unexpected service unit source");
    await verifyRuntimeBinary(runtimePath(this.root, selectedRuntime()), selectedRuntime());
    await ensureCaddyIngressReady(this.run, this.root);
    return await cutoverDropinDigest(this.root, this.system.run);
  }
  async verifyLegacyProcess(deno: string, denoSha256: string, workspace: string, priorRevision: string): Promise<void> {
    const state = await this.serviceState();
    if (state.state !== "active" || state.pid === 0 || (await realpath(`/proc/${state.pid}/exe`)) !== (await realpath(deno)))
      throw new Error("The captured prior is not the pinned live Deno process");
    const unit = await readFile(join(this.root, ".data/releases", priorRevision, "ops/ai-ubq-fi.service"), "utf8");
    const shell = /^ExecStart=\/bin\/sh -c '(.+)'$/m.exec(unit)?.[1];
    if (!shell) throw new Error("Unsupported captured legacy command");
    // D-Bus exposes configured arguments before systemd's runtime $$ expansion.
    assertCutoverExecStart(await readCutoverExecStart(this.root, this.system.run), ["/bin/sh", "-c", shell]);
    const codec = await openLegacyCodec(deno, denoSha256, workspace);
    await codec.close();
  }
  async health(sha: string, port = 7999, ready = false): Promise<void> {
    const attempts = ready ? 30 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.system.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
        if (!healthServesRelease(response, await response.json(), sha)) throw new Error("Loopback cutover identity mismatch");
        return;
      } catch {
        if (attempt + 1 === attempts) throw new Error("Expected loopback cutover identity unavailable");
        await Bun.sleep(1000);
      }
    }
  }
  async publicHealth(sha: string): Promise<void> {
    const response = await this.system.fetch("https://ai.ubq.fi/health", { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!healthServesRelease(response, await response.json(), sha)) throw new Error("Public cutover identity mismatch");
  }
  async stop(): Promise<void> {
    await this.run("sudo", ["-n", "systemctl", "stop", service]);
  }
  async assertStopped(paths: string[]): Promise<void> {
    const state = await this.serviceState();
    if (!["inactive", "failed"].includes(state.state) || state.pid !== 0) throw new Error("Gateway has not stopped");
    const files: string[] = [];
    for (const path of paths) for (const suffix of ["", "-wal", "-shm"]) if (await exists(path + suffix)) files.push(path + suffix);
    if (!files.length) throw new Error("Stopped source is missing");
    const child = Bun.spawn(["/usr/bin/lsof", "-t", "--", ...files], { env: {}, stdout: "pipe", stderr: "pipe" });
    const { output, errors, code } = await boundedCutoverHolderCheck(child);
    if (code !== 1 || output.trim() || errors.trim()) throw new Error("A database holder remains or the holder check is unavailable");
  }
  async start(artifact: CapturedCutoverArtifact, memoryBytes: number, dropinsSha256: string): Promise<void> {
    if ((await this.verifyBootstrap(artifact)) !== dropinsSha256) throw new Error("Effective service drop-ins changed at startup");
    await this.run("sudo", ["-n", "systemctl", "daemon-reload"]);
    // A global drop-in can undo an earlier runtime SetUnitProperties during daemon-reload.
    await this.reassertSupervisorMemory(memoryBytes);
    const metadata = await this.run("sudo", [
      "-n",
      "systemctl",
      "show",
      service,
      "-p",
      "LoadState",
      "-p",
      "NeedDaemonReload",
      "-p",
      "WorkingDirectory",
      "-p",
      "User",
      "-p",
      "Group",
    ]);
    const fields = Object.fromEntries(metadata.split("\n").map((line) => line.split("=")));
    if (
      fields.LoadState !== "loaded" ||
      fields.NeedDaemonReload !== "no" ||
      fields.WorkingDirectory !== this.root ||
      fields.User !== "codex" ||
      fields.Group !== "codex"
    )
      throw new Error("Effective service identity differs from the accepted unit");
    assertCutoverExecStart(await readCutoverExecStart(this.root, this.system.run), ["/bin/sh", join(this.root, "ops/launch-vps.sh")]);
    if ((await this.verifyBootstrap(artifact)) !== dropinsSha256) throw new Error("Bootstrap changed after daemon-reload");
    await this.supervisorMemory(memoryBytes);
    await this.run("sudo", ["-n", "systemctl", "start", service]);
  }
  reloadIngress(): Promise<void> {
    return reloadCaddyIngress(this.run);
  }
  async assertPriorUnchanged(prior: StoredVpsPrior): Promise<void> {
    const selected = await realpath(join(this.root, ".data/current"));
    if (selected !== join(this.root, ".data/releases", prior.sha)) throw new Error("Prior selector changed during cutover");
    const unit = await readFile(join(this.root, ".data/releases", prior.sha, "ops/ai-ubq-fi.service"));
    if (!unit.length) throw new Error("Prior unit disappeared");
  }
}
