import { strict as assert } from "node:assert";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macSandboxProfile } from "./macos-sandbox.ts";
import { digest } from "./io.ts";

if (process.platform !== "darwin") throw new Error("Mac containment acceptance requires an actual macOS kernel");
const root = await realpath(await mkdtemp(join(tmpdir(), "uos-bun-seatbelt-")));
try {
  const release = join(root, ".data/releases", "1".repeat(40));
  const runtime = join(root, ".data/runtimes/bun/bun");
  const nativeHome = join(root, "selected-native-home");
  const control = join(root, "physical-control");
  const sibling = join(root, "other-native-home");
  for (const directory of [release, join(root, ".data/runtimes/bun"), nativeHome, control, sibling]) await mkdir(directory, { recursive: true });
  await copyFile(await realpath(process.execPath), runtime);
  await chmod(runtime, 0o700);
  await writeFile(join(nativeHome, "auth.json"), "synthetic-selected-auth");
  await writeFile(join(sibling, "auth.json"), "synthetic-unrelated-auth");
  await writeFile(join(release, "immutable.txt"), "immutable-source");
  const before = digest(await readFile(runtime));
  const probe = join(release, "probe.ts");
  await writeFile(
    probe,
    [
      'import { strict as assert } from "node:assert";',
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const paths = JSON.parse(process.argv[2]);",
      'assert.equal(readFileSync(paths.nativeHome + "/auth.json", "utf8"), "synthetic-selected-auth");',
      'writeFileSync(paths.root + "/.data/mutable.txt", "accepted");',
      'writeFileSync(paths.control + "/state", "accepted");',
      'for (const path of [paths.nativeHome + "/auth.json", paths.sibling + "/auth.json", paths.release + "/immutable.txt", paths.runtime]) assert.throws(() => writeFileSync(path, "must-be-denied"));',
      'assert.throws(() => readFileSync(paths.sibling + "/auth.json"));',
      'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("seatbelt-network") });',
      'assert.equal(await (await fetch(server.url)).text(), "seatbelt-network"); await server.stop();',
      "console.log(JSON.stringify({ selected_auth_read: true, data_write: true, control_write: true, sibling_read_denied: true, native_write_denied: true, release_runtime_write_denied: true, process_spawn_denied: true, real_http: true }));",
    ].join("\n")
  );
  const profile = macSandboxProfile({ root, release, runtime, nativeHome, control });
  const deniedSpawn = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", "exit 0"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.notEqual(deniedSpawn.exitCode, 0);
  const child = Bun.spawn(
    [
      "/usr/bin/sandbox-exec",
      "-p",
      profile,
      runtime,
      "--no-env-file",
      "--no-install",
      probe,
      JSON.stringify({ root, release, runtime, nativeHome, control, sibling }),
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, stderr);
    assert.equal(digest(await readFile(runtime)), before);
    assert.equal(await readFile(join(nativeHome, "auth.json"), "utf8"), "synthetic-selected-auth");
    assert.equal(await readFile(join(release, "immutable.txt"), "utf8"), "immutable-source");
    console.log(stdout.trim());
  } finally {
    clearTimeout(timer);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
