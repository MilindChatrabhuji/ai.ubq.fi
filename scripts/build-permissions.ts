import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PermissionsNativeArtifact = { path: string; sha256: string; sourceSha256: string; architecture: "arm64"; landlockAbi: { minimum: 8; maximum: 10 } };

/** Build during CI/packaging only. Application startup must only verify and load immutable bytes. */
export const buildPermissionsNative = async (outputDirectory: string, headerDirectory?: string): Promise<PermissionsNativeArtifact> => {
  if (process.platform !== "linux" || process.arch !== "arm64") throw new Error("Native confinement build requires Linux ARM64");
  const source = fileURLToPath(new URL("../src/runtime/permissions-native.c", import.meta.url));
  const headers = headerDirectory ?? join(dirname(createRequire(import.meta.url).resolve("node-api-headers")), "include");
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const path = join(output, "linux-arm64.node");
  const child = Bun.spawn(["cc", "-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror", "-DNAPI_VERSION=8", "-I", headers, "-o", path, source], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error("Native confinement build failed: " + stderr + stdout);
  const sha256 = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const sourceSha256 = createHash("sha256")
    .update(await readFile(source))
    .digest("hex");
  const artifact: PermissionsNativeArtifact = { path, sha256, sourceSha256, architecture: "arm64", landlockAbi: { minimum: 8, maximum: 10 } };
  await writeFile(join(output, "manifest.json"), JSON.stringify({ ...artifact, path: "linux-arm64.node" }, null, 2) + "\n", { mode: 0o600 });
  return artifact;
};

if (import.meta.main) {
  const artifact = await buildPermissionsNative(fileURLToPath(new URL("../.tmp/permissions-native", import.meta.url)));
  console.log(JSON.stringify(artifact));
}
