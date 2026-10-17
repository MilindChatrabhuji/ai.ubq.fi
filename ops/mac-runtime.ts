import { BUN_RUNTIMES, prepareBunRuntime, type RuntimeArtifact } from "./bun-runtime.ts";
export const MAC_RUNTIME = BUN_RUNTIMES.darwin;
/** The former Deno store is retained untouched for explicit legacy rollback. */
export const prepareMacRuntime = async (root: string, test: Parameters<typeof prepareBunRuntime>[1] & { os?: string; arch?: string } = {}): Promise<string> => {
  if ((test.os ?? process.platform) !== "darwin" || !["arm64", "aarch64"].includes(test.arch ?? process.arch))
    throw new Error("Managed Mac runtime requires macOS ARM64");
  return prepareBunRuntime(root, { ...test, artifact: (test.artifact ?? MAC_RUNTIME) as RuntimeArtifact });
};
