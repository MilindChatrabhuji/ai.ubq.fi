import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { digest, missing } from "./io.ts";
import type { VpsCommand } from "./vps-release-store.ts";

const resourceKeys = new Set([
  "CPUAccounting",
  "CPUQuota",
  "CPUQuotaPeriodSec",
  "CPUWeight",
  "StartupCPUWeight",
  "AllowedCPUs",
  "AllowedMemoryNodes",
  "MemoryAccounting",
  "MemoryMin",
  "MemoryLow",
  "MemoryHigh",
  "MemoryMax",
  "MemorySwapMax",
  "MemoryZSwapMax",
  "StartupMemoryLow",
  "StartupMemoryHigh",
  "StartupMemoryMax",
  "TasksAccounting",
  "TasksMax",
  "IOAccounting",
  "IOWeight",
  "StartupIOWeight",
  "IODeviceWeight",
  "IOReadBandwidthMax",
  "IOWriteBandwidthMax",
  "IOReadIOPSMax",
  "IOWriteIOPSMax",
  "Slice",
  "OOMPolicy",
  "OOMScoreAdjust",
  "LimitCPU",
  "LimitFSIZE",
  "LimitDATA",
  "LimitSTACK",
  "LimitCORE",
  "LimitRSS",
  "LimitNOFILE",
  "LimitAS",
  "LimitNPROC",
  "LimitMEMLOCK",
  "LimitLOCKS",
  "LimitSIGPENDING",
  "LimitMSGQUEUE",
  "LimitNICE",
  "LimitRTPRIO",
  "LimitRTTIME",
]);

/** Resource-only overrides cannot replace the pinned command, environment, identity or filesystem policy. */
export function assertCutoverDropin(text: string): void {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }
    const separator = line.indexOf("="),
      key = line.slice(0, separator).trim(),
      value = line.slice(separator + 1);
    if (separator < 1 || section !== "Service" || !resourceKeys.has(key) || value.length > 512 || /[\\\p{Cc}]/u.test(value))
      throw new Error("An unsupported service drop-in changes the pinned execution contract");
  }
}

export async function cutoverDropinDigest(root: string, run: VpsCommand): Promise<string> {
  const value = JSON.parse(
    await run(
      "/usr/bin/busctl",
      ["--system", "--json=short", "get-property", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "UnitPath"],
      root
    )
  ) as { type: string; data: unknown };
  if (value.type !== "as" || !Array.isArray(value.data)) throw new Error("Manager unit paths are unavailable");
  const paths = value.data.map((entry: unknown) => {
    if (typeof entry !== "string") throw new Error("Invalid manager unit path");
    return entry;
  });
  if (!paths.length || paths.length > 64 || paths.some((path) => !isAbsolute(path) || /\p{Cc}/u.test(path)))
    throw new Error("Systemd unit search paths are unavailable");
  const directories = ["service.d", "ai-.service.d", "ai-ubq-.service.d", "ai-ubq-fi.service.d"];
  const inputs = new Map<string, string>();
  for (const path of paths)
    for (const directory of directories) {
      for (const [file, sha256] of await readCutoverDropins(join(path, directory))) inputs.set(file, sha256);
    }
  return digest(JSON.stringify([...inputs].toSorted(([left], [right]) => left.localeCompare(right))));
}

async function readCutoverDropins(folder: string): Promise<[string, string][]> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const files: [string, string][] = [];
  for (const name of names.filter((entry) => entry.endsWith(".conf"))) {
    const file = join(folder, name),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536 || info.mode & 0o022) throw new Error("Unsafe effective service drop-in");
    const bytes = await readFile(file);
    assertCutoverDropin(bytes.toString());
    files.push([file, digest(bytes)]);
  }
  return files;
}

/** busctl returns typed D-Bus data; no shell or heuristic command-string splitting is involved. */
export function assertCutoverExecStart(value: unknown, expected: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Effective ExecStart is unavailable");
  const observed = value as Record<string, unknown>;
  if (observed.type !== "a(sasbttttuii)" || !Array.isArray(observed.data) || observed.data.length !== 1 || !Array.isArray(observed.data[0]))
    throw new Error("Effective ExecStart is ambiguous");
  const row: unknown[] = observed.data[0];
  if (row.length !== 10 || row[0] !== expected[0] || JSON.stringify(row[1]) !== JSON.stringify(expected) || row[2] !== false)
    throw new Error("Effective ExecStart differs from the pinned launcher");
}

export async function readCutoverExecStart(root: string, run: VpsCommand): Promise<unknown> {
  return JSON.parse(
    await run(
      "/usr/bin/busctl",
      [
        "--system",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1/unit/ai_2dubq_2dfi_2eservice",
        "org.freedesktop.systemd1.Service",
        "ExecStart",
      ],
      root
    )
  );
}

export function cutoverSupervisorUnit(group: string): string {
  const unit = group.split("/").filter(Boolean).at(-1);
  if (!unit || !/^uos-first-bun-cutover-[a-z0-9-]+\.service$/.test(unit)) throw new Error("Cutover is not running in its reviewed task-owned supervisor unit");
  return unit;
}
