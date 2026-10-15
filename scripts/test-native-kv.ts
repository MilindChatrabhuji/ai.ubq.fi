import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNativeKvBackend, preparedNativeKvArtifactBinding, verifyNativeKvArtifact } from "../src/storage/native-addon.ts";
import type { NativeKvArtifact } from "./build-native-kv.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INPUTS = fileURLToPath(
  new URL(process.platform === "darwin" ? "../tools/native-kv/inputs-darwin-arm64.json" : "../tools/native-kv/inputs.json", import.meta.url)
);
export type TestNativeKvBinding = Readonly<{ artifactDirectory: string; expectedProvenanceSha256: string; inputsManifest: string }>;
export type TestNativeKvPreparation = TestNativeKvBinding & Readonly<{ buildReceipt: NativeKvArtifact; runDirectory: string }>;

export const parseTestNativeKvBinding = (value: unknown): TestNativeKvBinding => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("A parent native KV binding object is required");
  const object = value as Record<string, unknown>;
  if (typeof object.artifactDirectory !== "string" || !isAbsolute(object.artifactDirectory)) throw new Error("Native KV artifact path must be absolute");
  if (typeof object.expectedProvenanceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(object.expectedProvenanceSha256)) {
    throw new Error("Native KV requires the independent parent provenance hash");
  }
  const inputsManifest = object.inputsManifest ?? INPUTS;
  if (typeof inputsManifest !== "string" || !isAbsolute(inputsManifest)) throw new Error("Native KV inputs path must be absolute");
  return Object.freeze({ artifactDirectory: object.artifactDirectory, expectedProvenanceSha256: object.expectedProvenanceSha256, inputsManifest });
};

export const verifiedTestNativeKvBinding = (text: string): TestNativeKvBinding => {
  const binding = parseTestNativeKvBinding(JSON.parse(text));
  verifyNativeKvArtifact(binding);
  return binding;
};

export const initializeTestNativeKv = (value: unknown): void => {
  prepareNativeKvBackend(parseTestNativeKvBinding(value));
};

/** Relay only the binding already prepared by the parent preload, never a nearby self-hash. */
export const currentTestNativeKvBinding = (): TestNativeKvBinding => parseTestNativeKvBinding(preparedNativeKvArtifactBinding());

export const createTestNativeKvPreload = (root: string): string => {
  const directory = join(root, ".cleanup-evidence", "native-kv-preloads");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run = mkdtempSync(join(directory, "run-"));
  const path = join(run, "preload.ts");
  const module = new URL("./test-native-kv.ts", import.meta.url).href;
  const source = `import { initializeTestNativeKv } from ${JSON.stringify(module)};\ndeclare const UOS_TEST_NATIVE_KV_BINDING: unknown;\ninitializeTestNativeKv(UOS_TEST_NATIVE_KV_BINDING);\n`;
  writeFileSync(path, source, { mode: 0o400, flag: "wx" });
  return path;
};

/** Explicit parent preparation; no native build runs in a test preload or application startup. */
export const prepareTestNativeKv = async (root = ROOT): Promise<TestNativeKvPreparation> => {
  const directory = join(root, ".cleanup-evidence", "native-kv-builds");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runDirectory = mkdtempSync(join(directory, "run-"));
  const buildReceipt =
    process.platform === "darwin"
      ? await (await import("./build-native-kv-darwin.ts")).buildNativeKvDarwin(join(runDirectory, "artifact"))
      : await (await import("./build-native-kv.ts")).buildNativeKv(join(runDirectory, "artifact"), { workspaceDirectory: join(runDirectory, "workspace") });
  const binding = parseTestNativeKvBinding({
    artifactDirectory: dirname(buildReceipt.path),
    expectedProvenanceSha256: buildReceipt.provenanceSha256,
    inputsManifest: INPUTS,
  });
  const verified = verifyNativeKvArtifact(binding);
  if (verified.artifactSha256 !== buildReceipt.sha256 || verified.inputsSha256 !== buildReceipt.inputsSha256) {
    throw new Error("Native KV parent build receipt differs from its verified artifact");
  }
  const preparation = { ...binding, buildReceipt, runDirectory };
  writeFileSync(join(runDirectory, "parent-build-receipt.json"), JSON.stringify(preparation, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return preparation;
};

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command !== "prepare") throw new Error("usage: test-native-kv.ts prepare");
  console.log(JSON.stringify(await prepareTestNativeKv(resolve(ROOT))));
}
