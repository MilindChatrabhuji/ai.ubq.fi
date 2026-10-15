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
  const denialProbe = join(release, "denial-probe.ts");
  await writeFile(
    denialProbe,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const paths = JSON.parse(process.argv[2]);",
      "const operation = Number(process.argv[3]);",
      'if (operation < 4) writeFileSync([paths.nativeHome + "/auth.json", paths.sibling + "/auth.json", paths.release + "/immutable.txt", paths.runtime][operation], "must-be-denied");',
      'else if (operation === 4) readFileSync(paths.sibling + "/auth.json");',
      'else Bun.spawnSync(["/bin/sh", "-c", "exit 0"]);',
    ].join("\n")
  );
  await writeFile(
    probe,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const paths = JSON.parse(process.argv[2]);",
      "const operation = Number(process.argv[3]);",
      'if (operation === 0 && readFileSync(paths.nativeHome + "/auth.json", "utf8") !== "synthetic-selected-auth") throw new Error("selected auth mismatch");',
      'else if (operation === 1) writeFileSync(paths.root + "/.data/mutable.txt", "accepted");',
      'else if (operation === 2) writeFileSync(paths.control + "/state", "accepted");',
      'else if (operation === 3) { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("seatbelt-network") }); if (await (await fetch(server.url)).text() !== "seatbelt-network") throw new Error("network mismatch"); await server.stop(); }',
    ].join("\n")
  );
  const profile = macSandboxProfile({ root, release, runtime, nativeHome, control });
  const paths = JSON.stringify({ root, release, runtime, nativeHome, control, sibling });
  for (let operation = 0; operation < 6; operation += 1) {
    const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, runtime, "--no-env-file", "--no-install", denialProbe, paths, String(operation)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.notEqual(denied.exitCode, 0, `denial probe ${operation} unexpectedly succeeded`);
  }
  for (let operation = 0; operation < 4; operation += 1) {
    const allowed = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, runtime, "--no-env-file", "--no-install", probe, paths, String(operation)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(allowed.exitCode, 0, `allowed probe ${operation} failed: ${allowed.stderr.toString()}`);
  }
  assert.equal(digest(await readFile(runtime)), before);
  assert.equal(await readFile(join(nativeHome, "auth.json"), "utf8"), "synthetic-selected-auth");
  assert.equal(await readFile(join(release, "immutable.txt"), "utf8"), "immutable-source");
  console.log(
    JSON.stringify({
      selected_auth_read: true,
      data_write: true,
      control_write: true,
      sibling_read_denied: true,
      native_write_denied: true,
      release_runtime_write_denied: true,
      process_spawn_denied: true,
      real_http: true,
    })
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
