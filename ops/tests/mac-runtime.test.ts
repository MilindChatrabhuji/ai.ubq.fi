import { copyOps, seedStore } from "./fixture-release.ts";
import { test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnFixture, runFixture, outputFixture, fsError, type FixtureChild } from "./fixture-process.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MAC_RUNTIME, prepareMacRuntime } from "../mac-runtime.ts";

const FIXTURES = fileURLToPath(new URL("../../.cleanup-evidence/mac-runtime-fixtures", import.meta.url));
const decoder = new TextDecoder();
const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const sha256 = async (value: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
type Failure = "archive" | "length" | "binary" | "unzip" | "member" | "redirect";
const dependencies = async (failure?: Failure) => {
  const archive = bytes("synthetic-archive");
  const binary = bytes("synthetic-binary");
  const artifact = {
    ...MAC_RUNTIME,
    archiveBytes: archive.length,
    archiveSha256: await sha256(archive),
    binaryBytes: binary.length,
    binarySha256: await sha256(binary),
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = Object.assign(
    () => {
      calls.push("download");
      if (failure === "redirect")
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://unapproved.example.invalid/archive" } }));
      const content = failure === "archive" ? bytes("incorrect-archive") : archive;
      return Promise.resolve(
        new Response(new Uint8Array(content), { headers: { "content-length": String(failure === "length" ? archive.length + 1 : archive.length) } })
      );
    },
    { preconnect: fetch.preconnect }
  );
  const unzip = (args: string[]): Promise<Uint8Array> => {
    calls.push(args.slice(0, 2).join(" "));
    let stdout = binary;
    if (args[1] === "-1") stdout = bytes(failure === "member" ? "bun-darwin-aarch64/bun\nunexpected\n" : "bun-darwin-aarch64/bun\n");
    if (args[1] === "-l") stdout = bytes("-rwxr-xr-x 3.0 unx 16 bx 10 defN bun-darwin-aarch64/bun\n");
    if (args[0] === "-p" && failure === "binary") stdout = bytes("incorrect-binary");
    return failure === "unzip" ? Promise.reject(new Error("synthetic unzip refusal")) : Promise.resolve(stdout);
  };
  return { artifact, os: "darwin" as const, arch: "aarch64" as const, fetch: fetcher, unzip, calls };
};
const root = async (): Promise<string> => {
  await mkdir(FIXTURES, { recursive: true });
  return await realpath(await mkdtemp(FIXTURES + "/" + "case-"));
};
const clean = async (path: string): Promise<void> => {
  const runtimeStore = path + "/.data/runtimes/bun/darwin-arm64";
  try {
    for (const item of await readdir(runtimeStore, { withFileTypes: true })) {
      const entry = runtimeStore + "/" + item.name;
      const info = await lstat(entry);
      if (info.isDirectory() && !info.isSymbolicLink()) await chmod(entry, 0o700);
    }
  } catch (error) {
    if (!fsError("ENOENT")(error)) throw error;
  }
  await rm(path, { recursive: true });
};
const entries = async (path: string): Promise<string[]> => {
  const names: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) names.push(entry.name);
  return names.sort((left, right) => left.localeCompare(right));
};

test("Mac runtime uses the exact official immutable artifact pin", () => {
  assert.equal(MAC_RUNTIME.version, "1.4.0");
  assert.equal(MAC_RUNTIME.archiveBytes, 25568657);
  assert.equal(MAC_RUNTIME.binaryBytes, 63558256);
  assert.equal(MAC_RUNTIME.archiveSha256, "c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381");
  assert.equal(MAC_RUNTIME.binarySha256, "539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf");
  assert.equal(MAC_RUNTIME.url, "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip");
});
test("Mac runtime verifies, publishes readonly bytes and reuses without downloading", async () => {
  const path = await root();
  try {
    const test = await dependencies();
    const binary = await prepareMacRuntime(path, test);
    assert.equal(await readFile(binary, "utf8"), "synthetic-binary");
    const binaryMode = (await stat(binary)).mode;
    const directoryMode = (await stat(binary.slice(0, binary.lastIndexOf("/")))).mode;
    const storeMode = (await stat(path + "/.data/runtimes/bun/darwin-arm64")).mode;
    assert(Number.isInteger(binaryMode) && Number.isInteger(directoryMode) && Number.isInteger(storeMode));
    assert.equal(binaryMode & 0o777, 0o500);
    assert.equal(directoryMode & 0o777, 0o500);
    assert.equal(storeMode & 0o777, 0o700);
    const calls = test.calls.slice();
    assert.equal(await prepareMacRuntime(path, test), binary);
    assert.deepEqual(test.calls, calls);
    assert.deepEqual(await entries(path + "/.data/runtimes/bun/darwin-arm64"), ["1.4.0-" + test.artifact.binarySha256]);
  } finally {
    await clean(path);
  }
});
for (const failure of ["archive", "length", "binary", "unzip", "member", "redirect"] as const) {
  test("Mac runtime preparation preserves live state on " + failure + " failure", async () => {
    const path = await root();
    try {
      await mkdir(path + "/.data", { recursive: true });
      await writeFile(path + "/.data/current", "prior-selector");
      await writeFile(path + "/service-state", "prior-service");
      await assert.rejects(prepareMacRuntime(path, await dependencies(failure)));
      assert.equal(await readFile(path + "/.data/current", "utf8"), "prior-selector");
      assert.equal(await readFile(path + "/service-state", "utf8"), "prior-service");
      assert.deepEqual(await entries(path + "/.data/runtimes/bun/darwin-arm64"), []);
    } finally {
      await clean(path);
    }
  });
}
for (const kind of ["corrupt", "symlink", "binary-symlink", "platform"] as const) {
  test("Mac runtime refuses " + kind + " without fallback or overwrite", async () => {
    const path = await root();
    try {
      const test = await dependencies();
      const destination = path + "/.data/runtimes/bun/darwin-arm64/1.4.0-" + test.artifact.binarySha256;
      if (kind === "platform") {
        await assert.rejects(prepareMacRuntime(path, { ...test, arch: "x86_64" }));
      } else {
        await mkdir(destination, { recursive: true });
        const content = kind === "corrupt" ? "foreign-corrupt-bytes" : "synthetic-binary";
        if (kind === "binary-symlink") {
          await writeFile(path + "/correct-binary", content);
          const linked = await runFixture("/bin/ln", { args: ["-s", path + "/correct-binary", destination + "/bun"] });
          assert.equal(linked.code, 0, decoder.decode(linked.stderr));
        } else await writeFile(destination + "/bun", content);
        if (kind === "symlink") {
          await rename(destination, destination + "-target");
          const link = await runFixture("/bin/ln", { args: ["-s", destination + "-target", destination] });
          assert.equal(link.code, 0, decoder.decode(link.stderr));
        }
        await assert.rejects(prepareMacRuntime(path, test));
        assert.equal(await readFile(destination + "/bun", "utf8"), content);
      }
      assert.deepEqual(test.calls, []);
    } finally {
      await clean(path);
    }
  });
}

const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Disposable Mac deploy exceeded10s"));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const stub = async (path: string, name: string, body: string): Promise<void> => {
  await writeFile(path + "/bin/" + name, "#!/bin/sh\nset -eu\n" + body + "\n");
  await chmod(path + "/bin/" + name, 0o700);
};
const deployFixture = async (path: string, failure: boolean): Promise<{ source: string; sha: string }> => {
  const sha = "a".repeat(40);
  const journal = path + "/journal";
  await mkdir(path + "/bin", { recursive: true });
  await mkdir(path + "/ops", { recursive: true });
  await mkdir(path + "/library", { recursive: true });
  await mkdir(path + "/.data/releases", { recursive: true });
  await writeFile(path + "/.data/current", "prior-selector");
  await writeFile(path + "/service-state", "prior-service");
  await seedStore(path);
  const log = (event: string): string => "printf '%s\\n' " + quote(event) + " >> " + quote(journal);
  await stub(
    path,
    "git",
    'case "$1" in status) exit 0 ;; rev-parse) printf "%s\\n" ' + quote(sha) + " ;; archive) " + log("archive") + '; : > "$' + '{3#--output=}" ;; esac'
  );
  await stub(path, "tar", log("tar") + '; mkdir -p "$4/src"');
  await stub(path, "id", 'printf "501\\n"');
  await stub(path, "ps", log("old-process-settled") + "; exit 1");
  await stub(
    path,
    "launchctl",
    'case "$1" in print) printf "fixture = {\\n pid = 999999\\n}\\n" ;; bootout) ' + log("bootout") + " ;; bootstrap) " + log("bootstrap") + " ;; esac"
  );
  const test = await dependencies(failure ? "archive" : undefined);
  const helperUrl = new URL("../mac-runtime.ts", import.meta.url).href;
  const helper = `import { writeFile } from "node:fs/promises";
    import { prepareMacRuntime as prepare } from ${JSON.stringify(helperUrl)};
    const journal = ${JSON.stringify(journal)};
    export const prepareMacRuntime = async root => {
      await writeFile(journal, "prepare-start\\n", { flag: "a" });
      const artifact = ${JSON.stringify(test.artifact)};
      const fetcher = () => Promise.resolve(new Response(new TextEncoder().encode(${JSON.stringify(failure ? "incorrect-archive" : "synthetic-archive")}),
        { headers: { "content-length": String(artifact.archiveBytes) } }));
      const unzip = args => Promise.resolve(new TextEncoder().encode(args[1] === "-1" ? artifact.member + "\\n" :
        args[1] === "-l" ? "-rwxr-xr-x 3.0 unx 16 bx 10 defN " + artifact.member + "\\n" : "synthetic-binary"));
      const binary = await prepare(root, { artifact, fetch: fetcher, unzip, os: "darwin", arch: "arm64" });
      await writeFile(journal, "prepare-ready\\n", { flag: "a" }); return binary;
    };`;
  await copyOps(path + "/ops");
  await writeFile(
    path + "/ops/release-artifact.ts",
    `import { writeFile } from "node:fs/promises";
    export const prepareReleasePayload = async () => { await writeFile(${JSON.stringify(journal)}, "payload-ready\\n", { flag: "a" }); };`
  );
  await writeFile(path + "/ops/mac-runtime.ts", helper);
  await writeFile(path + "/ops/release-retention.ts", "export const pruneReleases = () => Promise.resolve({removed:[]});\n");
  let source = await readFile(new URL("../deploy-mac.ts", import.meta.url), "utf8");
  source = source
    .replaceAll("/Users/nv/repos/ubiquity/ai.ubq.fi", path)
    .replace("/Users/nv/Library/LaunchAgents/com.ubiquity.ai.local.plist", path + "/library/agent.plist");
  source = source.replace('process.platform !== "darwin"', "process.platform !== " + JSON.stringify(process.platform));
  const prelude =
    "globalThis.fetch = () => Promise.resolve(Response.json({release:{git_sha:" +
    JSON.stringify(sha) +
    ",deployment_id:" +
    JSON.stringify("mac-" + sha) +
    "}},{headers:{'x-uos-git-sha':" +
    JSON.stringify(sha) +
    ",'x-uos-deployment-id':" +
    JSON.stringify("mac-" + sha) +
    "}}));\n";
  return { source: prelude + source, sha };
};
for (const failure of [false, true]) {
  test("Mac deploy actual entry prepares runtime before selection/service effects: " + String(failure), async () => {
    const path = await root();
    let child: FixtureChild | undefined;
    try {
      const fixture = await deployFixture(path, failure);
      await writeFile(path + "/ops/deploy-mac.ts", fixture.source);
      const args = ["--no-env-file", "--no-install", path + "/ops/deploy-mac.ts"];
      child = spawnFixture(process.execPath, {
        args,
        cwd: path,
        clearEnv: true,
        env: { PATH: path + "/bin:/usr/bin:/bin", HOME: path, TMPDIR: path, DENO_DIR: path + "/cache" },
        stdout: "piped",
        stderr: "piped",
      });
      const output = await bounded(outputFixture(child));
      const journal = (await readFile(path + "/journal", "utf8")).trim().split("\n");
      if (failure) {
        assert.notEqual(output.code, 0);
        assert.deepEqual(journal, ["prepare-start"]);
        assert.equal(await readFile(path + "/.data/current", "utf8"), "prior-selector");
        assert.equal(await readFile(path + "/service-state", "utf8"), "prior-service");
      } else {
        assert.equal(output.code, 0, decoder.decode(output.stderr));
        assert.deepEqual(journal, ["prepare-start", "prepare-ready", "archive", "tar", "payload-ready", "bootout", "old-process-settled", "bootstrap"]);
        assert.equal(await readlink(path + "/.data/current"), "releases/" + fixture.sha);
      }
    } finally {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already reaped */
        }
        await bounded(child.exited);
      }
      await clean(path);
    }
  });
}
