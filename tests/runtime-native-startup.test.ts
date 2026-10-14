import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testNetworkArgv } from "../scripts/test-network.ts";
import { prepareNativeKvDevelopmentArtifact } from "../scripts/prepare-native-runtime.ts";
import { nativeKvDevelopmentPaths } from "../src/runtime/native-kv-bootstrap.ts";
import { preparedNativeKvArtifactBinding } from "../src/storage/native-addon.ts";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = join(workspace, ".cleanup-evidence", "m21-native-startup");
mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
const directories: string[] = [];
const bootstrap = new URL("../src/runtime/native-kv-bootstrap.ts", import.meta.url).href;
const pathOf = (path: string | URL): string => (path instanceof URL ? fileURLToPath(path) : path);

const fixture = (): Readonly<{ root: string; data: string; receipt: string; artifact: string; inputs: string }> => {
  const source = preparedNativeKvArtifactBinding();
  const root = mkdtempSync(join(fixtureRoot, "development-"));
  directories.push(root);
  const paths = nativeKvDevelopmentPaths(root);
  mkdirSync(paths.data, { mode: 0o700 });
  const artifact = mkdtempSync(join(paths.data, "native-kv-"));
  chmodSync(artifact, 0o700);
  for (const name of ["native-kv.node", "native-kv.provenance.json"]) {
    copyFileSync(join(pathOf(source.artifactDirectory), name), join(artifact, name));
    chmodSync(join(artifact, name), 0o600);
  }
  mkdirSync(join(root, "tools", "native-kv"), { recursive: true });
  copyFileSync(pathOf(source.inputsManifest ?? new URL("../tools/native-kv/inputs.json", import.meta.url)), paths.inputs);
  writeFileSync(
    paths.receipt,
    JSON.stringify({ artifactDirectory: artifact, expectedProvenanceSha256: source.expectedProvenanceSha256, inputsManifest: paths.inputs }),
    { mode: 0o600 }
  );
  return { ...paths, artifact };
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const startup = async (root: string): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> => {
  const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const root = ${JSON.stringify(root)};
globalThis.fetch = async () => { throw new Error("Unexpected startup download"); };
Bun.spawn = () => { throw new Error("Unexpected startup process"); };
Bun.spawnSync = () => { throw new Error("Unexpected startup process"); };
try {
  const { prepareNativeKvForDevelopment, nativeKvDevelopmentPaths } = await import(${JSON.stringify(bootstrap)});
  assert.equal(nativeKvDevelopmentPaths().root, ${JSON.stringify(resolve(workspace))});
  await prepareNativeKvForDevelopment(root);
  const { openKv } = await import("#kv");
  const kv = await openKv(root + "/.data/kv-bun.sqlite3");
  try {
    await kv.set(["startup"], { value: 7n, bytes: new Uint8Array([1, 2]) });
    assert.deepEqual((await kv.get(["startup"])).value, { value: 7n, bytes: new Uint8Array([1, 2]) });
  } finally { kv.close(); }
  const names = ["CODEX_AUTH_JSON_B64", "DENO_DEPLOY_TOKEN", "UOS_AI_TOKEN", "SURPLUS_API_KEY", "METERED_API_KEY", "OPENROUTER_API_KEY"];
  assert(names.every((name) => !process.env[name]));
  console.log(JSON.stringify({ nativeOpened: true, credentialsAbsent: true, receipt: readFileSync(root + "/.data/native-kv.binding.json", "utf8") }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 78;
}
`;
  const child = Bun.spawn(testNetworkArgv([process.execPath, "--no-env-file", "--no-install", "-e", source]), {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
};

test("development startup uses the explicit independent receipt before opening real native KV", async () => {
  const paths = fixture();
  const receipt = readFileSync(paths.receipt, "utf8");
  const result = await startup(paths.root);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ nativeOpened: true, credentialsAbsent: true, receipt });
  expect(existsSync(join(paths.data, "kv-bun.sqlite3"))).toBe(true);
  expect(readFileSync(paths.receipt, "utf8")).toBe(receipt);
  expect(resolve(nativeKvDevelopmentPaths().root)).toBe(resolve(workspace));
});

type Fixture = ReturnType<typeof fixture>;
const refusals: readonly Readonly<{ name: string; change: (paths: Fixture) => void; error: string }>[] = [
  {
    name: "absent receipt",
    change: ({ receipt }) => {
      rmSync(receipt);
    },
    error: "ENOENT",
  },
  {
    name: "corrupt receipt",
    change: ({ receipt }) => {
      writeFileSync(receipt, "{broken");
    },
    error: "JSON",
  },
  {
    name: "absent independent hash",
    change: ({ receipt, artifact }) => {
      writeFileSync(receipt, JSON.stringify({ artifactDirectory: artifact }));
    },
    error: "independently supplied",
  },
  {
    name: "wrong independent hash",
    change: ({ receipt }) => {
      const binding = JSON.parse(readFileSync(receipt, "utf8")) as Record<string, unknown>;
      writeFileSync(receipt, JSON.stringify({ ...binding, expectedProvenanceSha256: "0".repeat(64) }));
    },
    error: "release binding",
  },
  {
    name: "tampered provenance",
    change: ({ artifact }) => {
      appendFileSync(join(artifact, "native-kv.provenance.json"), " ");
    },
    error: "release binding",
  },
  {
    name: "tampered native bytes",
    change: ({ artifact }) => {
      appendFileSync(join(artifact, "native-kv.node"), "tampered");
    },
    error: "artifact hash",
  },
  {
    name: "tampered tracked inputs",
    change: ({ inputs }) => {
      appendFileSync(inputs, " ");
    },
    error: "frozen inputs",
  },
  {
    name: "symlink receipt",
    change: ({ receipt }) => {
      renameSync(receipt, receipt + ".saved");
      symlinkSync(receipt + ".saved", receipt);
    },
    error: "regular file",
  },
  {
    name: "symlink artifact directory",
    change: ({ artifact }) => {
      renameSync(artifact, artifact + ".saved");
      symlinkSync(artifact + ".saved", artifact);
    },
    error: "symlinks",
  },
  {
    name: "symlink tracked inputs",
    change: ({ inputs }) => {
      renameSync(inputs, inputs + ".saved");
      symlinkSync(inputs + ".saved", inputs);
    },
    error: "symlinks",
  },
  {
    name: "unsafe receipt permissions",
    change: ({ receipt }) => {
      chmodSync(receipt, 0o644);
    },
    error: "owner-private",
  },
  {
    name: "unsafe storage permissions",
    change: ({ data }) => {
      chmodSync(data, 0o755);
    },
    error: "owner-private",
  },
  {
    name: "unsafe native permissions",
    change: ({ artifact }) => {
      chmodSync(join(artifact, "native-kv.node"), 0o644);
    },
    error: "owner-private",
  },
  {
    name: "unsafe provenance permissions",
    change: ({ artifact }) => {
      chmodSync(join(artifact, "native-kv.provenance.json"), 0o644);
    },
    error: "owner-private",
  },
  {
    name: "unsafe tracked input permissions",
    change: ({ inputs }) => {
      chmodSync(inputs, 0o666);
    },
    error: "safe regular",
  },
  {
    name: "symlink native bytes",
    change: ({ artifact }) => {
      const path = join(artifact, "native-kv.node");
      renameSync(path, path + ".saved");
      symlinkSync(path + ".saved", path);
    },
    error: "symlinks",
  },
  {
    name: "symlink provenance",
    change: ({ artifact }) => {
      const path = join(artifact, "native-kv.provenance.json");
      renameSync(path, path + ".saved");
      symlinkSync(path + ".saved", path);
    },
    error: "symlinks",
  },
];

for (const refusal of refusals) {
  test(`development startup refuses ${refusal.name} without database or marker writes`, async () => {
    const paths = fixture();
    refusal.change(paths);
    const before = readdirSync(paths.data).sort((left, right) => left.localeCompare(right));
    const result = await startup(paths.root);
    expect(result.code).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(refusal.error);
    expect(result.stderr).not.toContain("Unexpected startup");
    expect(readdirSync(paths.data).sort((left, right) => left.localeCompare(right))).toEqual(before);
    expect(existsSync(join(paths.data, "kv-bun.sqlite3"))).toBe(false);
  });
}

test("explicit preparation preserves an invalid pre-existing receipt without starting a build", async () => {
  const paths = fixture();
  writeFileSync(paths.receipt, "invalid operator input");
  const before = readdirSync(paths.data).sort((left, right) => left.localeCompare(right));
  let failure: unknown;
  try {
    await prepareNativeKvDevelopmentArtifact(paths.root);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Explicit preparation unexpectedly accepted the invalid receipt");
  expect(failure.message).toContain("JSON");
  expect(readFileSync(paths.receipt, "utf8")).toBe("invalid operator input");
  expect(readdirSync(paths.data).sort((left, right) => left.localeCompare(right))).toEqual(before);
});

test("explicit preparation refuses a FIFO receipt before opening or building", async () => {
  const paths = fixture();
  rmSync(paths.receipt);
  const fifo = Bun.spawnSync(["/usr/bin/mkfifo", "--mode=600", paths.receipt], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  expect(fifo.exitCode).toBe(0);
  const before = readdirSync(paths.data).sort((left, right) => left.localeCompare(right));
  let failure: unknown;
  try {
    await prepareNativeKvDevelopmentArtifact(paths.root);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Explicit preparation unexpectedly accepted the FIFO receipt");
  expect(failure.message).toContain("regular file");
  expect(readdirSync(paths.data).sort((left, right) => left.localeCompare(right))).toEqual(before);
});
