import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testNetworkArgv } from "../../scripts/test-network.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const childMode = process.argv[2] === "--fixture-child";
const expected = process.argv[childMode ? 3 : 2];
assert(expected && /^[a-f0-9]{40}$/.test(expected), "An exact committed source SHA is required.");
assert.equal(Bun.version, "1.4.0");
const require = createRequire(import.meta.url);
const native: unknown = require("workerd");
assert(typeof native === "object" && native !== null && "default" in native && typeof native.default === "string");
const binary = native.default;
const metadata: unknown = JSON.parse(await readFile(join(root, "node_modules/workerd/package.json"), "utf8"));
assert(typeof metadata === "object" && metadata !== null && "version" in metadata && metadata.version === "1.20261012.1");

async function outer(): Promise<void> {
  const parent = join(root, ".data/rust-worker-build/identity");
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, "probe-"));
  const argv = testNetworkArgv([process.execPath, "--no-env-file", "--no-install", fileURLToPath(import.meta.url), "--fixture-child", expected, workspace]);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: workspace, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  const child = Bun.spawn(argv, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  }, 20_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await Promise.all([writeFile(join(workspace, "stdout.log"), stdout), writeFile(join(workspace, "stderr.log"), stderr)]);
    assert.equal(exit, 0, `Actual Worker release identity was refused; evidence: ${workspace}`);
    const receipt: unknown = JSON.parse(stdout.trim());
    assert(typeof receipt === "object" && receipt !== null && "gitSha" in receipt && receipt.gitSha === expected);
    await writeFile(join(workspace, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify({ evidence: workspace, ...receipt }));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
}

async function inner(): Promise<void> {
  const workspace = process.argv[4];
  assert(workspace && resolve(workspace).startsWith(join(root, ".data/rust-worker-build/identity/")));
  const quote = (value: string): string => JSON.stringify(value);
  const config = join(workspace, "identity.capnp");
  await writeFile(
    config,
    `using Workerd = import ${quote(join(root, "node_modules/workerd/workerd.capnp"))};
const config :Workerd.Config = (
  services = [(name = "internet", network = (allow = [])), (name = "gateway", worker = (
    modules = [(name = "entrypoint.mjs", esModule = embed ${quote(join(root, "rust/crates/gateway-worker/entrypoint.mjs"))}), (name = "build/index.js", esModule = embed ${quote(join(root, "rust/crates/gateway-worker/build/index.js"))}), (name = "build/index_bg.wasm", wasm = embed ${quote(join(root, "rust/crates/gateway-worker/build/index_bg.wasm"))})],
    compatibilityDate = "2026-10-18", compatibilityFlags = ["enable_request_signal", "request_signal_passthrough"]
  ))], sockets = [(name = "main", http = (), service = "gateway")]
);`
  );
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = listener.port;
  await listener.stop(true);
  const child = Bun.spawn([binary, "serve", config, "--experimental", "--import-path", "/", "--socket-addr", `main=127.0.0.1:${port}`], {
    cwd: workspace,
    stdout: Bun.file(join(workspace, "workerd.stdout.log")),
    stderr: Bun.file(join(workspace, "workerd.stderr.log")),
  });
  try {
    const deadline = Date.now() + 10_000;
    let response: Response | undefined;
    do {
      assert.equal(child.exitCode, null, "workerd exited before health verification.");
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`);
      } catch {
        await Bun.sleep(20);
      }
    } while (!response && Date.now() < deadline);
    assert(response?.status === 200, "Actual Worker health is unavailable.");
    const body: unknown = await response.json();
    assert(typeof body === "object" && body !== null && "release" in body && typeof body.release === "object" && body.release !== null);
    const release = body.release;
    assert("git_sha" in release && release.git_sha === expected, "The WASM embeds a different source SHA.");
    assert("deployment_id" in release && release.deployment_id === `cloudflare-${expected}`);
    assert.equal(response.headers.get("x-uos-git-sha"), expected);
    assert.equal(response.headers.get("x-uos-deployment-id"), `cloudflare-${expected}`);
    console.log(
      JSON.stringify({
        gitSha: expected,
        deploymentId: `cloudflare-${expected}`,
        wasmSha256: createHash("sha256")
          .update(await readFile(join(root, "rust/crates/gateway-worker/build/index_bg.wasm")))
          .digest("hex"),
        workerdSha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        workerd: "1.20261012.1",
      })
    );
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000);
      try {
        await child.exited;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

if (childMode) await inner();
else await outer();
