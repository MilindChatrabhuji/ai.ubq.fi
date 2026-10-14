import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, exists, runOutput } from "./io.ts";

export type RuntimeArtifact = Readonly<{
  version: string;
  platform: "linux" | "darwin";
  arch: "arm64";
  url: string;
  member: string;
  archiveBytes: number;
  archiveSha256: string;
  binaryBytes: number;
  binarySha256: string;
}>;
export const BUN_RUNTIMES = Object.freeze({
  darwin: Object.freeze({
    version: "1.4.0",
    platform: "darwin",
    arch: "arm64",
    url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip",
    member: "bun-darwin-aarch64/bun",
    archiveBytes: 25568657,
    archiveSha256: "c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381",
    binaryBytes: 63558256,
    binarySha256: "539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf",
  }),
  linux: Object.freeze({
    version: "1.4.0",
    platform: "linux",
    arch: "arm64",
    url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-aarch64.zip",
    member: "bun-linux-aarch64/bun",
    archiveBytes: 36641863,
    archiveSha256: "4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e",
    binaryBytes: 80600240,
    binarySha256: "086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9",
  }),
} satisfies Record<string, RuntimeArtifact>);
export const selectedRuntime = (): RuntimeArtifact => {
  if (process.arch !== "arm64" || (process.platform !== "linux" && process.platform !== "darwin"))
    throw new Error("Managed Bun runtime requires Linux glibc ARM64 or macOS ARM64");
  return BUN_RUNTIMES[process.platform];
};
export const runtimePath = (root: string, artifact: RuntimeArtifact): string =>
  join(root, ".data/runtimes/bun", `${artifact.platform}-${artifact.arch}`, `${artifact.version}-${artifact.binarySha256}`, "bun");
export const verifyRuntimeBinary = async (path: string, artifact: RuntimeArtifact): Promise<void> => {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.binaryBytes || digest(await readFile(path)) !== artifact.binarySha256)
    throw new Error("Managed Bun runtime binary integrity check failed");
};
const directory = async (path: string): Promise<void> => {
  if (await exists(path)) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed Bun runtime directory is unsafe");
  } else await mkdir(path, { mode: 0o700 });
};
const archiveResponse = async (artifact: RuntimeArtifact, fetcher: typeof fetch): Promise<Response> => {
  let url = new URL(artifact.url);
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (url.protocol !== "https:" || url.port || !["github.com", "release-assets.githubusercontent.com"].includes(url.hostname))
      throw new Error("Bun runtime download redirected outside approved hosts");
    const response = await fetcher(url, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Bun runtime download redirect has no location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Bun runtime download failed");
    }
    return response;
  }
  throw new Error("Bun runtime download exceeded redirect bound");
};
export const prepareBunRuntime = async (
  root: string,
  test: Readonly<{ artifact?: RuntimeArtifact; fetch?: typeof fetch; unzip?: (args: string[]) => Promise<Uint8Array> }> = {}
): Promise<string> => {
  const artifact = test.artifact ?? selectedRuntime();
  const store = join(root, ".data/runtimes/bun", `${artifact.platform}-${artifact.arch}`);
  for (const path of [join(root, ".data"), join(root, ".data/runtimes"), join(root, ".data/runtimes/bun"), store]) await directory(path);
  const binary = runtimePath(root, artifact);
  const destination = join(binary, "..");
  if (await exists(destination)) {
    const stat = await lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed Bun runtime destination is unsafe");
    await verifyRuntimeBinary(binary, artifact);
    return binary;
  }
  const staging = await mkdtemp(join(store, ".staging-"));
  let published = false;
  try {
    const response = await archiveResponse(artifact, test.fetch ?? fetch);
    const declared = response.headers.get("content-length");
    if (!response.body || (declared && Number(declared) !== artifact.archiveBytes)) {
      await response.body?.cancel();
      throw new Error("Bun runtime archive size is invalid");
    }
    const bytes = new Uint8Array(artifact.archiveBytes);
    const reader = response.body.getReader();
    let offset = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (offset + chunk.value.length > bytes.length) throw new Error("Bun runtime archive exceeded pinned size");
        bytes.set(chunk.value, offset);
        offset += chunk.value.length;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (offset !== bytes.length || digest(bytes) !== artifact.archiveSha256) throw new Error("Bun runtime archive integrity check failed");
    const archive = join(staging, "archive.zip");
    await writeFile(archive, bytes, { mode: 0o600 });
    const unzip = test.unzip ?? ((args: string[]) => runOutput("/usr/bin/unzip", args));
    const names = new TextDecoder()
      .decode(await unzip(["-Z", "-1", archive]))
      .trim()
      .split(/\r?\n/);
    const details = new TextDecoder().decode(await unzip(["-Z", "-l", archive]));
    const directories = new Set([artifact.member.slice(0, artifact.member.lastIndexOf("/") + 1)]);
    if (
      names.filter((name) => !directories.has(name)).join("\n") !== artifact.member ||
      !details.split(/\r?\n/).some((line) => /^-[rwxstST-]{9}\s/.test(line) && line.endsWith(" " + artifact.member))
    )
      throw new Error("Bun runtime archive has unexpected members");
    await writeFile(join(staging, "bun"), await unzip(["-p", archive, artifact.member]), { mode: 0o500 });
    await verifyRuntimeBinary(join(staging, "bun"), artifact);
    await rm(archive);
    await chmod(join(staging, "bun"), 0o500);
    await chmod(staging, 0o500);
    if (await exists(destination)) throw new Error("Managed Bun runtime destination appeared during preparation");
    await rename(staging, destination);
    published = true;
    return binary;
  } finally {
    if (!published) {
      await chmod(staging, 0o700);
      await rm(staging, { recursive: true });
    }
  }
};
