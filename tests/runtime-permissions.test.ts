import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPermissionsNative } from "../scripts/build-permissions.ts";

const linuxArm64Test = process.platform === "linux" && process.arch === "arm64" ? test : test.skip;

linuxArm64Test(
  "Linux kernel confinement denies real IO and processes across existing and new Bun threads",
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "m13-kernel-permissions-"));
    try {
      for (const path of ["read", "write", "denied", "home", "tmp"]) await mkdir(join(fixture, path));
      await writeFile(join(fixture, "read", "value.txt"), "permitted-read");
      await writeFile(join(fixture, "denied", "auth.json"), "fake-private-sentinel");
      await symlink(join(fixture, "denied", "auth.json"), join(fixture, "write", "escape.json"));
      const artifact = await buildPermissionsNative(join(fixture, "native"));
      const workerPath = join(fixture, "read", "worker.ts");
      await writeFile(
        workerPath,
        `
      self.postMessage("ready");
      self.onmessage = async (event) => {
        let readDenied = false;
        let processDenied = false;
        try { await Bun.file(event.data).text(); }
        catch (error) { readDenied = ["EACCES", "EPERM"].includes(error.code); }
        try { const child = Bun.spawn(["/bin/sh", "-c", "exit 0"]); await child.exited; }
        catch (error) { processDenied = ["EACCES", "EPERM"].includes(error.code); }
        self.postMessage({ denied: readDenied && processDenied });
      };
    `
      );
      const module = new URL("../src/runtime/permissions-linux.ts", import.meta.url).href;
      const workspace = new URL("../", import.meta.url).pathname.slice(0, -1);
      const source = `
      import assert from "node:assert/strict";
      import { readFile, writeFile, chmod, rename, link } from "node:fs/promises";
      import { spawnSync } from "node:child_process";
      import { applyLinuxPermissions, getLinuxPermissionsSupport } from ${JSON.stringify(module)};
      const root = ${JSON.stringify(fixture)};
      const workerPath = ${JSON.stringify(workerPath)};
      const artifact = ${JSON.stringify(artifact)};
      assert.throws(() => getLinuxPermissionsSupport({ ...artifact, sha256: "0".repeat(64) }), /integrity/);
      assert.throws(() => applyLinuxPermissions({ read: [root], write: [root], immutable: [root + "/denied"] }, artifact), /read-only mount/);
      const existingWorker = new Worker(workerPath);
      await new Promise((resolve, reject) => { existingWorker.onmessage = resolve; existingWorker.onerror = reject; });
      const receipt = applyLinuxPermissions({ read: [${JSON.stringify(workspace)}, root + "/read", root + "/write", root + "/native", "/usr/lib"], write: [root + "/write"] }, artifact);
      const denied = (error) => ["EACCES", "EPERM", "EXDEV"].includes(error.code);
      assert.equal(await Bun.file(root + "/read/value.txt").text(), "permitted-read");
      await Bun.write(root + "/write/bun.txt", "allowed-bun-write");
      await writeFile(root + "/write/node.txt", "allowed-node-write");
      assert.equal(await readFile(root + "/write/node.txt", "utf8"), "allowed-node-write");
      await assert.rejects(Bun.file(root + "/denied/auth.json").text(), denied);
      await assert.rejects(readFile(root + "/denied/auth.json"), denied);
      await assert.rejects(Bun.file(root + "/write/escape.json").text(), denied);
      await assert.rejects(Bun.write(root + "/denied/new.txt", "forbidden"), denied);
      await assert.rejects(writeFile(root + "/read/value.txt", "forbidden"), denied);
      await assert.rejects(chmod(root + "/denied/auth.json", 0o600), denied);
      await assert.rejects(rename(root + "/denied/auth.json", root + "/write/moved.txt"), denied);
      await assert.rejects(link(root + "/read/value.txt", root + "/write/linked.txt"), denied);
      assert.throws(() => Bun.spawn(["/bin/sh", "-c", "exit 0"]), denied);
      const spawned = spawnSync("/bin/sh", ["-c", "exit 0"]);
      assert(spawned.error && denied(spawned.error));
      const existingDenied = new Promise((resolve, reject) => { existingWorker.onmessage = (event) => resolve(event.data.denied); existingWorker.onerror = reject; });
      existingWorker.postMessage(root + "/denied/auth.json");
      assert.equal(await existingDenied, true);
      existingWorker.terminate();
      const newWorker = new Worker(workerPath);
      await new Promise((resolve, reject) => { newWorker.onmessage = resolve; newWorker.onerror = reject; });
      const newDenied = new Promise((resolve, reject) => { newWorker.onmessage = (event) => resolve(event.data.denied); newWorker.onerror = reject; });
      newWorker.postMessage(root + "/denied/auth.json");
      assert.equal(await newDenied, true);
      newWorker.terminate();
      const { openKv } = await import(${JSON.stringify(new URL("../node_modules/@deno/kv/esm/npm.js", import.meta.url).href)});
      const { serialize, deserialize } = await import("bun:jsc");
      const kv = await openKv(root + "/write/kv.sqlite3", { encodeV8: (value) => new Uint8Array(serialize(value)), decodeV8: deserialize });
      await kv.set(["kernel-proof"], { value: "native-thread-write" });
      assert.deepEqual((await kv.get(["kernel-proof"])).value, { value: "native-thread-write" });
      kv.close();
      console.log(JSON.stringify({ receipt, existingThreadDenied: true, newThreadDenied: true, nativeKvOpened: true, childrenSettled: true }));
    `;
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
        cwd: fixture,
        env: { PATH: "/usr/bin:/bin", HOME: join(fixture, "home"), TMPDIR: join(fixture, "tmp"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const proof = JSON.parse(stdout.trim()) as { existingThreadDenied: boolean; newThreadDenied: boolean; nativeKvOpened: boolean; childrenSettled: boolean };
      expect(proof.existingThreadDenied).toBe(true);
      expect(proof.newThreadDenied).toBe(true);
      expect(proof.nativeKvOpened).toBe(true);
      expect(proof.childrenSettled).toBe(true);
      console.log(stdout.trim());
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
  15_000
);
