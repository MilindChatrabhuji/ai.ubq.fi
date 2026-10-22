// Private bounded staging driver. It applies producer frames to one NEW isolated
// workerd Durable Object state directory. It is not a public route, activation,
// deployment, owner grant, or a worker-custody-fixture acceptance claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeStoreMessage, PRIVATE_WIRE_MAX_BYTES, privateLines, settle, storeResponse } from "./state-migration-conformance.ts";

const TASK_ROOT = "/private/tmp/ai-rust-wasm-20261018";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
function text(value: unknown): asserts value is string {
  assert(typeof value === "string");
}
function integer(value: unknown): asserts value is number {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type Fact = Readonly<{ path: string; sha256: string }>;
type StageFileFact = Fact & { frames: number };
type Input = Readonly<{
  v: 1;
  source_sha: string;
  source_tree: string;
  run_directory: string;
  worker_js: Fact;
  worker_wasm: Fact;
  workerd_binary: Fact;
  stage_apply: Fact;
  frames: StageFileFact;
  receipt: string;
}>;
function fact(value: unknown): asserts value is Fact {
  assert(
    object(value) &&
      Object.keys(value).length === 2 &&
      typeof value.path === "string" &&
      value.path.startsWith("/") &&
      typeof value.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.sha256)
  );
}
function stageFileFact(value: unknown): asserts value is StageFileFact {
  assert(
    object(value) &&
      Object.keys(value).length === 3 &&
      typeof value.path === "string" &&
      value.path.startsWith("/") &&
      typeof value.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.sha256) &&
      typeof value.frames === "number"
  );
  integer(value.frames);
  assert(value.frames > 2 && value.frames <= 200_000);
}
// The caller creates the task-root parent before invoking the driver. The run
// directory and receipt themselves must not exist, so this is a new state tree.
function insideTask(path: string): boolean {
  const parent = realpathSync(dirname(resolve(path)));
  return parent === TASK_ROOT || parent.startsWith(TASK_ROOT + "/");
}
function input(value: unknown): Input {
  assert(object(value) && value.v === 1);
  const keys = ["v", "source_sha", "source_tree", "run_directory", "worker_js", "worker_wasm", "workerd_binary", "stage_apply", "frames", "receipt"];
  assert(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
  text(value.source_sha);
  text(value.source_tree);
  assert(/^[a-f0-9]{40}$/.test(value.source_sha) && /^[a-f0-9]{40}$/.test(value.source_tree));
  text(value.run_directory);
  text(value.receipt);
  for (const key of ["worker_js", "worker_wasm", "workerd_binary", "stage_apply"]) fact(value[key]);
  stageFileFact(value.frames);
  assert(insideTask(value.run_directory), "Stage run directory is outside the private task root.");
  assert(insideTask(value.receipt), "Stage receipt is outside the private task root.");
  return value as Input;
}
async function verify(value: Fact): Promise<void> {
  assert.equal(sha256(await readFile(value.path)), value.sha256, "Stage input hash differs.");
}
async function configuration(input: Input, state: string): Promise<string> {
  const quote = JSON.stringify;
  const config = `using Workerd = import ${quote(join(ROOT, "node_modules/workerd/workerd.capnp"))};
const config :Workerd.Config = ( services = [
(name = "internet", network = (allow = [])), (name = "state", disk = (path = ${quote(state)}, writable = true)),
(name = "gateway", worker = (modules = [(name = "index.js", esModule = embed ${quote(input.worker_js.path)}),(name = "index_bg.wasm", wasm = embed ${quote(input.worker_wasm.path)})], compatibilityDate = "2026-10-18", compatibilityFlags = ["enable_request_signal","request_signal_passthrough"], durableObjectNamespaces = [(className = "GatewayAuthority", uniqueKey = "uos-rust-state-migration-stage-driver-v1", enableSql = true)], durableObjectStorage = (localDisk = "state"))),
(name = "driver", worker = (modules = [(name = "driver.mjs", esModule = embed ${quote(join(ROOT, "tools/cloudflare/fixtures/storage-driver.mjs"))})], compatibilityDate = "2026-10-18", bindings = [(name = "GATEWAY", service = "gateway"),(name = "AUTHORITY", durableObjectNamespace = (className = "GatewayAuthority", serviceName = "gateway"))]))], sockets = [(name = "main", http = (), service = "driver")]);`;
  const path = join(input.run_directory, "state.capnp");
  await writeFile(path, config, { mode: 0o600, flag: "wx" });
  return path;
}
async function start(input: Input, config: string): Promise<Readonly<{ origin: string; stop: () => Promise<void> }>> {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = listener.port;
  await listener.stop(true);
  const child = Bun.spawn([input.workerd_binary.path, "serve", config, "--experimental", "--import-path", "/", "--socket-addr", `main=127.0.0.1:${port}`], {
    cwd: input.run_directory,
    stdout: Bun.file(join(input.run_directory, "workerd.stdout.log")),
    stderr: Bun.file(join(input.run_directory, "workerd.stderr.log")),
  });
  const stop = (): Promise<void> => settle(child);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, "workerd exited during staging startup.");
      try {
        const response = await fetch(`${origin}/public/health`);
        if (response.status === 200) {
          const body: unknown = await response.json();
          assert(object(body) && object(body.release));
          assert.equal(body.release.git_sha, input.source_sha);
          assert.equal(response.headers.get("x-uos-git-sha"), input.source_sha);
          return { origin, stop };
        }
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
      }
      await Bun.sleep(20);
    }
    throw new Error("workerd did not become ready for isolated staging.");
  } catch (error) {
    await stop();
    throw error;
  }
}
function receipt(value: unknown, stage: string): ObjectValue {
  assert(object(value));
  assert.equal(value.stage, stage);
  assert(object(value.receipt));
  const result = value.receipt;
  assert(typeof result.capture_id === "string" && /^[a-f0-9]{64}$/.test(result.capture_id));
  assert(typeof result.sealed === "boolean" && result.activation_authorized === false);
  assert(typeof result.owner_bound === "boolean");
  integer(result.accepted_records);
  integer(result.atomic_batches);
  return result;
}
type Apply = NonNullable<ReturnType<typeof Bun.spawn>>;
async function drive(config: Input, origin: string, apply: Apply, staged: ObjectValue[]): Promise<Readonly<{ appendFrames: number; summary: ObjectValue }>> {
  const stdin = apply.stdin;
  assert(stdin !== undefined && typeof stdin !== "number", "Private stage applier stdin is unavailable.");
  const lines = privateLines(apply.stdout as ReadableStream<Uint8Array>);
  let id = 0;
  let appendFrames = 0;
  let summary: ObjectValue | undefined;
  for (;;) {
    const next = await lines.next();
    if (next.done) break;
    assert(Buffer.byteLength(next.value) < PRIVATE_WIRE_MAX_BYTES);
    const value: unknown = JSON.parse(next.value);
    assert(object(value));
    if (value.operation === "store_request") {
      const message = decodeStoreMessage(next.value, id);
      id = message.id;
      const response = await fetch(`${origin}/store`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fixture-wire-version": "1" },
        body: message.rawRequest,
        signal: AbortSignal.timeout(120_000),
      });
      assert.equal(response.status, 200, "The isolated actual DO refused a staged Store RPC.");
      await stdin.write(storeResponse(message, await response.text()) + "\n");
      await stdin.flush();
    } else if (value.operation === "stage_receipt") {
      text(value.stage);
      assert(["begin", "append", "seal", "bind_owner"].includes(value.stage));
      if (value.stage === "append") appendFrames++;
      staged.push(receipt(value, value.stage));
    } else if (value.operation === "stage_applied") {
      summary = value;
    } else {
      throw new Error("Private stage driver received an unknown line.");
    }
  }
  assert.equal(await apply.exited, 0, "Private stage applier exited unsuccessfully.");
  assert(object(summary), "Private stage applier emitted no summary.");
  assert.equal(summary.operation, "stage_applied");
  assert.equal(summary.sealed, true);
  assert.equal(summary.activation_authorized, false);
  assert.equal(summary.frames, config.frames.frames, "Applied frame count differs from the producer inventory.");
  assert(typeof summary.max_stage_frame_bytes === "number" && summary.max_stage_frame_bytes <= PRIVATE_WIRE_MAX_BYTES);
  assert.equal(staged.length, config.frames.frames);
  assert.equal(summary.append_frames, appendFrames);
  return { appendFrames, summary };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, "Usage: bun state-migration-stage-driver.ts --input <private-json>");
  assert.equal(args[0], "--input");
  const raw = await readFile(args[1], "utf8");
  assert(Buffer.byteLength(raw) < 64 * 1024);
  const config = input(JSON.parse(raw));
  await Promise.all([config.worker_js, config.worker_wasm, config.workerd_binary, config.stage_apply, config.frames].map(verify));
  await assert.rejects(stat(config.run_directory), (error: unknown) => object(error) && error.code === "ENOENT");
  await assert.rejects(stat(config.receipt), (error: unknown) => object(error) && error.code === "ENOENT");
  await mkdir(config.run_directory, { mode: 0o700 });
  await mkdir(join(config.run_directory, "state"), { mode: 0o700 });
  const capnp = await configuration(config, join(config.run_directory, "state"));
  const running = await start(config, capnp);
  const staged: ObjectValue[] = [];
  let apply: Apply | undefined;
  let result: ObjectValue | undefined;
  let failure: Readonly<{ error: unknown }> | undefined;
  try {
    apply = Bun.spawn([config.stage_apply.path, config.frames.path], {
      cwd: config.run_directory,
      stdin: "pipe",
      stdout: "pipe",
      stderr: Bun.file(join(config.run_directory, "apply.stderr.log")),
    });
    const driven = await drive(config, running.origin, apply, staged);
    const health = await fetch(`${running.origin}/public/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-uos-git-sha"), config.source_sha);
    result = {
      v: 1,
      kind: "m20_stage_driver",
      source_sha: config.source_sha,
      source_tree: config.source_tree,
      frames: config.frames.frames,
      frames_sha256: config.frames.sha256,
      append_frames: driven.summary.append_frames,
      max_stage_frame_bytes: driven.summary.max_stage_frame_bytes,
      staged_receipts: staged,
      sealed: driven.summary.sealed,
      owner_bound: driven.summary.owner_bound,
      activation_authorized: false,
      isolated_new_state_directory: true,
      target_touched: true,
      run_directory: config.run_directory,
      finished_at: new Date().toISOString(),
    };
  } catch (error) {
    failure = { error };
  }
  const cleanup = await Promise.allSettled([apply?.exited, running.stop()]);
  const rejected = cleanup.flatMap((item) => (item.status === "rejected" ? [item.reason] : []));
  if (failure) {
    if (rejected.length > 0) throw new AggregateError([failure.error, ...rejected], "Private stage driver failed.", { cause: failure.error });
    throw failure.error;
  }
  if (rejected.length === 1) throw rejected[0];
  if (rejected.length > 1) throw new AggregateError(rejected, "Private stage driver cleanup failed.");
  assert(object(result));
  await writeFile(config.receipt, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ operation: "stage_driver_complete", ...result, staged_receipts: staged.length }));
}
if (import.meta.main) await main();
