import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { openLegacyCodec } from "../src/kv-conversion/legacy-codec.ts";
import { ensureCaddyIngressReady, healthServesRelease, reloadCaddyIngress } from "./deploy.ts";
import { runtimePath, selectedRuntime, verifyRuntimeBinary } from "./bun-runtime.ts";
import { command, digest, exists, fileDigest } from "./io.ts";
import type { CapturedCutoverArtifact } from "./cutover-artifact.ts";
import type { StoredVpsPrior, VpsCommand } from "./vps-release-store.ts";

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
  async loadedUnit(): Promise<{ sha256: string; needsReload: boolean }> {
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
    ]);
    return { sha256: digest(observed), needsReload: observed.split("\n").includes("NeedDaemonReload=yes") };
  }
  async supervisorMemory(expectedBytes: number): Promise<void> {
    const group = /^0::(.+)$/m.exec(await readFile("/proc/self/cgroup", "utf8"))?.[1];
    if (!group || !Number.isSafeInteger(expectedBytes) || expectedBytes < 512 * 1024 * 1024 || expectedBytes > 4 * 1024 * 1024 * 1024)
      throw new Error("An explicit finite supervisor memory budget is required");
    const actual = (await readFile(join("/sys/fs/cgroup", group, "memory.max"), "utf8")).trim();
    assertCutoverMemoryLimit(expectedBytes, actual);
  }
  async verifyBootstrap(artifact: CapturedCutoverArtifact): Promise<void> {
    for (const name of [
      "ops/ai-ubq-fi.service",
      "ops/launch-vps.sh",
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
  }
  async verifyLegacyProcess(deno: string, denoSha256: string, workspace: string): Promise<void> {
    const state = await this.serviceState();
    if (state.state !== "active" || state.pid === 0 || (await realpath(`/proc/${state.pid}/exe`)) !== (await realpath(deno)))
      throw new Error("The captured prior is not the pinned live Deno process");
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
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 1 || output.trim() || errors.trim()) throw new Error("A database holder remains or the holder check is unavailable");
  }
  async start(): Promise<void> {
    await this.run("sudo", ["-n", "systemctl", "daemon-reload"]);
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
