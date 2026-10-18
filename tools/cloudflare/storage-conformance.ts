import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { testNetworkArgv } from "../../scripts/test-network.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedSha = process.argv[2] === "--fixture-child" ? process.argv[3] : process.argv[2];
assert(expectedSha && /^[a-f0-9]{40}$/.test(expectedSha), "Pass the exact compiled application's full source SHA.");
assert.equal(Bun.version, "1.4.0");
const require = createRequire(import.meta.url);
const workerd: unknown = require("workerd");
assert(isObject(workerd) && typeof workerd.default === "string", "The prepared native workerd binary is required.");
const workerdBinary = workerd.default;
const workerdPackage: unknown = JSON.parse(await readFile(join(root, "node_modules/workerd/package.json"), "utf8"));
assert(isObject(workerdPackage) && workerdPackage.version === "1.20261012.1", "The locked workerd version is required.");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function outer(): Promise<void> {
  const parent = join(root, ".data/rust-storage-conformance");
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, "run-"));
  const control = await lookup(new URL("https://developers.cloudflare.com").hostname, { family: 4 });
  await reachableControl(control.address, 443);
  const command = testNetworkArgv([
    process.execPath,
    "--no-env-file",
    "--no-install",
    fileURLToPath(import.meta.url),
    "--fixture-child",
    expectedSha,
    workspace,
    control.address,
    "443",
  ]);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: workspace, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const stop = (): void => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timeout = setTimeout(stop, 90_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await Promise.all([writeFile(join(workspace, "stdout.log"), stdout), writeFile(join(workspace, "stderr.log"), stderr)]);
    assert.equal(code, 0, `Actual workerd conformance failed; evidence: ${workspace}`);
    await reachableControl(control.address, 443);
    const receipt: unknown = JSON.parse(stdout.trim());
    assert(isObject(receipt) && Array.isArray(receipt.cases) && receipt.cases.length >= 22, "A nonzero complete case floor is required.");
    await writeFile(join(workspace, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify({ evidence: workspace, ...receipt }));
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    stop();
  }
}

async function reachableControl(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const socket = connect({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectProbe(new Error("The outside-boundary TCP control is unavailable."));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe();
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timeout);
      rejectProbe(error);
    });
  });
}

async function deniedEgress(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const socket = connect({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectProbe(new Error("An egress timeout does not prove OS denial."));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      rejectProbe(new Error("The fixture OS boundary allowed external TCP."));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      const denied = ["EPERM", "EACCES", "ENETUNREACH", "EHOSTUNREACH"];
      // Seatbelt reports a refused connect on this Bun/Darwin build. The same
      // endpoint must accept native TCP both before and after the isolated run.
      if (process.platform === "darwin") denied.push("ECONNREFUSED");
      if (denied.includes(error.code ?? "")) resolveProbe();
      else rejectProbe(error);
    });
  });
}

async function fixtureConfig(workspace: string): Promise<string> {
  const path = join(workspace, "storage.capnp");
  const quoted = (value: string): string => JSON.stringify(value);
  await mkdir(join(workspace, "state"), { recursive: true });
  const config = `using Workerd = import ${quoted(join(root, "node_modules/workerd/workerd.capnp"))};
const config :Workerd.Config = (
  services = [
    (name = "internet", network = (allow = [])),
    (name = "state", disk = (path = ${quoted(join(workspace, "state"))}, writable = true)),
    (name = "gateway", worker = (
      modules = [(name = "index.js", esModule = embed ${quoted(join(root, "rust/crates/gateway-worker/build/index.js"))}), (name = "index_bg.wasm", wasm = embed ${quoted(join(root, "rust/crates/gateway-worker/build/index_bg.wasm"))})],
      compatibilityDate = "2026-10-18", compatibilityFlags = ["enable_request_signal", "request_signal_passthrough"],
      durableObjectNamespaces = [(className = "GatewayAuthority", uniqueKey = "uos-rust-storage-conformance-v1", enableSql = true)],
      durableObjectStorage = (localDisk = "state")
    )),
    (name = "driver", worker = (
      modules = [(name = "driver.mjs", esModule = embed ${quoted(join(root, "tools/cloudflare/fixtures/storage-driver.mjs"))})],
      compatibilityDate = "2026-10-18",
      bindings = [(name = "GATEWAY", service = "gateway"), (name = "AUTHORITY", durableObjectNamespace = (className = "GatewayAuthority", serviceName = "gateway"))]
    ))
  ],
  sockets = [(name = "main", http = (), service = "driver")]
);`;
  await writeFile(path, config);
  return path;
}

type Running = { origin: string; stop: () => Promise<void> };
async function start(config: string, workspace: string): Promise<Running> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = reservation.port;
  await reservation.stop(true);
  const runId = Date.now();
  const output = Bun.file(join(workspace, `workerd-${runId}.stdout.log`));
  const errors = Bun.file(join(workspace, `workerd-${runId}.stderr.log`));
  const child = Bun.spawn([workerdBinary, "serve", config, "--experimental", "--import-path", "/", "--socket-addr", `main=127.0.0.1:${port}`], {
    cwd: workspace,
    stdout: output,
    stderr: errors,
  });
  const origin = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("workerd exited during startup.");
      try {
        const ready = await fetch(`${origin}/public/health`);
        if (ready.status === 200) return { origin, stop };
      } catch {
        /* process startup */
      }
      await Bun.sleep(20);
    }
    throw new Error("workerd did not become ready within ten seconds.");
  } catch (error) {
    await stop();
    throw error;
  }
}

async function sqliteFiles(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await sqliteFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".sqlite")) files.push(child);
  }
  return files;
}

async function inner(): Promise<void> {
  const workspace = process.argv[4];
  assert(workspace && resolve(workspace).startsWith(join(root, ".data/rust-storage-conformance/")));
  const controlHost = process.argv[5];
  const controlPort = Number(process.argv[6]);
  assert(controlHost && Number.isInteger(controlPort) && controlPort > 0 && controlPort < 65536);
  await deniedEgress(controlHost, controlPort);
  const cases = ["os_external_tcp_denied"];
  const config = await fixtureConfig(workspace);
  let running = await start(config, workspace);
  const rpc = async (message: unknown, expected = 200, version = "1"): Promise<Record<string, unknown>> => {
    const response = await fetch(`${running.origin}/store`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fixture-wire-version": version },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, expected);
    const body: unknown = await response.json();
    assert(isObject(body));
    return body;
  };
  const read = async (key: string): Promise<unknown> => (await rpc({ operation: "read", key })).record;
  const put = async (
    key: string,
    revision: string,
    value: unknown,
    expectedRevision: string | null = null,
    expiresAtMs: number | null = null,
    schemaVersion = 1
  ): Promise<Record<string, unknown>> =>
    rpc({
      operation: "commit",
      checks: [{ key, expected_revision: expectedRevision }],
      mutations: [{ operation: "put", key, record: { schema_version: schemaVersion, revision, value, expires_at_ms: expiresAtMs } }],
    });
  const prefix = "tuple-v1:027000";
  const key = "tuple-v1:027000026100";
  const next = "tuple-v1:027000026200";
  const typedKey = "tuple-v1:027600026100";
  const jsonKey = "tuple-v1:027600026200";
  const typedValue = {
    type: "array",
    value: [{ type: "big_int", value: "9007199254740993" }, { type: "number_bits", value: "8000000000000000" }, { type: "undefined" }],
  };
  try {
    const health = await fetch(`${running.origin}/public/health`);
    const body: unknown = await health.json();
    assert(isObject(body) && isObject(body.release));
    assert.equal(body.release.git_sha, expectedSha);
    assert.equal(health.headers.get("x-uos-git-sha"), expectedSha);
    cases.push("exact_rust_source_identity");
    assert.equal((await fetch(`${running.origin}/public/v1/models`)).status, 503);
    cases.push("unfinished_public_route_refused");
    assert.equal(await read(key), null);
    cases.push("missing_record_absent");
    assert.equal((await put(key, "r1", { counter: 1 })).committed, true);
    cases.push("durable_put");
    assert.equal((await put(next, "b1", true)).committed, true);
    assert.equal(
      (
        await rpc({
          operation: "commit",
          checks: [
            { key, expected_revision: "r1" },
            { key: next, expected_revision: "stale" },
          ],
          mutations: [
            { operation: "delete", key },
            { operation: "delete", key: next },
          ],
        })
      ).committed,
      false
    );
    assert(isObject(await read(key)));
    assert(isObject(await read(next)));
    cases.push("multirow_conflict_no_partial_writes");
    const races = await Promise.all(Array.from({ length: 8 }, (_, index) => put(key, `race-${index}`, index, "r1")));
    assert.equal(races.filter((result) => result.committed === true).length, 1);
    cases.push("concurrent_compare_and_swap_one_winner");
    const winner = await read(key);
    assert(isObject(winner) && typeof winner.revision === "string");
    assert.equal((await put(key, "expired", false, winner.revision, 0)).committed, true);
    assert.equal(await read(key), null);
    assert.equal((await put(key, "retained", true)).committed, true);
    cases.push("absolute_expiry_and_absent_fence");
    await rpc({ operation: "read", key: '["p","a"]' }, 400);
    cases.push("legacy_json_key_rejected");
    const malformed = {
      operation: "commit",
      checks: [{ key: prefix, expected_revision: null }],
      mutations: [{ operation: "put", key: prefix, record: { schema_version: 99, revision: "x", value: null, expires_at_ms: null } }],
    };
    await rpc(malformed, 503);
    assert.equal(await read(prefix), null);
    cases.push("unsupported_record_version_rejected");
    await rpc(
      { ...malformed, mutations: [{ operation: "put", key: prefix, record: { schema_version: 1, revision: "", value: null, expires_at_ms: null } }] },
      503
    );
    cases.push("empty_revision_rejected");
    await rpc(
      {
        ...malformed,
        mutations: [{ operation: "put", key: prefix, record: { schema_version: 1, revision: "x", value: null, expires_at_ms: 9007199254740992 } }],
      },
      503
    );
    cases.push("unsafe_expiry_rejected");
    assert.equal((await put(jsonKey, "json-shape", typedValue)).committed, true);
    const jsonShape = await read(jsonKey);
    assert(isObject(jsonShape));
    assert.equal(jsonShape.value_encoding, "json");
    assert.deepEqual(jsonShape.value, typedValue);
    cases.push("json_shapes_are_not_guessed_as_typed");
    assert.equal(
      (
        await rpc({
          operation: "commit",
          checks: [{ key: typedKey, expected_revision: null }],
          mutations: [
            {
              operation: "put",
              key: typedKey,
              record: { schema_version: 1, value_encoding: "profile-v1", revision: "typed", value: typedValue, expires_at_ms: null },
            },
          ],
        })
      ).committed,
      true
    );
    const typed = await read(typedKey);
    assert(isObject(typed));
    assert.equal(typed.value_encoding, "profile-v1");
    assert.deepEqual(typed.value, typedValue);
    cases.push("profile_bigint_signed_zero_undefined_roundtrip");
    assert.equal((await put(prefix, "prefix-row", true)).committed, true);
    const query = {
      operation: "query",
      selector: { kind: "prefix", prefix, start: null, end: null },
      reverse: false,
      limit: 1,
      cursor: null,
      now_ms: Date.now(),
    };
    const page = await rpc(query);
    assert(Array.isArray(page.entries) && page.entries.length === 1 && typeof page.next_cursor === "string");
    cases.push("prefix_excludes_exact_row_and_pages");
    const resumed = await rpc({ ...query, limit: 10, cursor: page.next_cursor });
    assert(Array.isArray(resumed.entries) && resumed.entries.length === 1 && resumed.next_cursor === null);
    cases.push("cursor_resume_with_changed_limit");
    await rpc({ ...query, reverse: true, cursor: page.next_cursor }, 400);
    cases.push("cross_order_cursor_rejected");
    const range = await rpc({ ...query, selector: { kind: "range", start: key, end: next }, limit: 10 });
    assert(Array.isArray(range.entries) && range.entries.length === 1);
    cases.push("range_inclusive_start_exclusive_end");
    await rpc({ operation: "read", key }, 503, "99");
    cases.push("unsupported_wire_version_rejected");
    await running.stop();
    running = await start(config, workspace);
    const restored = await read(key);
    assert(isObject(restored) && restored.revision === "retained");
    cases.push("real_sqlite_restart_durability");
    const typedRestored = await read(typedKey);
    assert(isObject(typedRestored));
    assert.equal(typedRestored.value_encoding, "profile-v1");
    assert.deepEqual(typedRestored.value, typedValue);
    cases.push("typed_encoding_survives_sqlite_restart");
    await running.stop();
    let corrupted = false;
    for (const file of await sqliteFiles(join(workspace, "state"))) {
      const database = new Database(file);
      try {
        if (database.query("SELECT name FROM sqlite_master WHERE name = 'uos_authority_metadata'").get()) {
          database.query("UPDATE uos_authority_metadata SET schema_version = 99").run();
          corrupted = true;
        }
      } finally {
        database.close();
      }
    }
    assert(corrupted, "Actual DO SQLite storage was not found.");
    running = await start(config, workspace);
    await rpc({ operation: "read", key }, 503);
    cases.push("persisted_schema_corruption_refused");
    assert(cases.length >= 22);
    const wasm = await readFile(join(root, "rust/crates/gateway-worker/build/index_bg.wasm"));
    console.log(
      JSON.stringify({
        sourceSha: expectedSha,
        wasmSha256: createHash("sha256").update(wasm).digest("hex"),
        workerd: "1.20261012.1",
        platform: process.platform,
        harnessSha256: createHash("sha256")
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest("hex"),
        fixtureSha256: createHash("sha256")
          .update(await readFile(join(root, "tools/cloudflare/fixtures/storage-driver.mjs")))
          .digest("hex"),
        boundarySha256: createHash("sha256")
          .update(await readFile(join(root, "scripts/test-network.ts")))
          .digest("hex"),
        workerdSha256: createHash("sha256")
          .update(await readFile(workerdBinary))
          .digest("hex"),
        cases,
      })
    );
  } finally {
    await running.stop();
  }
}

if (process.argv[2] === "--fixture-child") await inner();
else await outer();
