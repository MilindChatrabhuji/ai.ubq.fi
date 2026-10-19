// Fixed synthetic state acceptance controller. No credentials, store mirror or arbitrary actions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Database } from "bun:sqlite";
import { testNetworkArgv } from "../../scripts/test-network.ts";

export const PRIVATE_WIRE_MAX_BYTES = 32 * 1024 * 1024;
const TASK_ROOT = "/tmp/ai-rust-wasm-20261018/state-controller-2101";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
function closed(value: unknown, fields: readonly string[]): asserts value is ObjectValue {
  assert(object(value) && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)), "Closed fixture fields differ.");
}
function text(value: unknown): asserts value is string {
  assert(typeof value === "string");
}
function integer(value: unknown): asserts value is number {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
function record(value: unknown): void {
  if (value === null) return;
  closed(value, ["schema_version", "value_encoding", "revision", "value", "expires_at_ms"]);
  integer(value.schema_version);
  text(value.revision);
  text(value.value_encoding);
  assert(value.expires_at_ms === null || Number.isSafeInteger(value.expires_at_ms));
}
function request(value: unknown): string {
  assert(object(value));
  if (value.operation === "read") {
    closed(value, ["operation", "key"]);
    text(value.key);
  } else if (value.operation === "commit") {
    closed(value, ["operation", "checks", "mutations"]);
    assert(Array.isArray(value.checks) && Array.isArray(value.mutations));
    for (const check of value.checks) {
      closed(check, ["key", "expected_revision"]);
      text(check.key);
      assert(check.expected_revision === null || typeof check.expected_revision === "string");
    }
    for (const mutation of value.mutations) {
      assert(object(mutation));
      if (mutation.operation === "put") {
        closed(mutation, ["operation", "key", "record"]);
        text(mutation.key);
        assert(mutation.record !== null);
        record(mutation.record);
      } else {
        closed(mutation, ["operation", "key"]);
        assert.equal(mutation.operation, "delete");
        text(mutation.key);
      }
    }
  } else {
    closed(value, ["operation", "selector", "reverse", "limit", "cursor", "now_ms"]);
    assert.equal(value.operation, "query");
    assert(object(value.selector));
    if (value.selector.kind === "prefix") {
      closed(value.selector, ["kind", "prefix", "start", "end"]);
      text(value.selector.prefix);
      for (const key of ["start", "end"]) assert(value.selector[key] === null || typeof value.selector[key] === "string");
    } else {
      closed(value.selector, ["kind", "start", "end"]);
      assert.equal(value.selector.kind, "range");
      text(value.selector.start);
      text(value.selector.end);
    }
    assert(typeof value.reverse === "boolean");
    integer(value.limit);
    integer(value.now_ms);
    assert(value.cursor === null || typeof value.cursor === "string");
  }
  return String(value.operation);
}
// Preserve the ORIGINAL request token, including escaped UTF16 and number spelling.
// JSON.parse is validation only; it is never used to re-encode a Store request.
export function rawMember(raw: string, name: string): string {
  const members = new Map<string, string>();
  let at = 1;
  const space = (): void => {
    while (/\s/.test(raw[at] ?? "") && at < raw.length) at++;
  };
  const stringEnd = (start: number): number => {
    let cursor = start + 1;
    while (cursor < raw.length) {
      if (raw[cursor] === "\\") cursor += 2;
      else if (raw[cursor++] === '"') return cursor;
    }
    throw new Error("Incomplete private JSON string.");
  };
  assert.equal(raw[0], "{");
  while (at < raw.length) {
    space();
    if (raw[at] === "}") break;
    assert.equal(raw[at], '"');
    const end = stringEnd(at);
    const key: unknown = JSON.parse(raw.slice(at, end));
    text(key);
    at = end;
    space();
    assert.equal(raw[at++], ":");
    space();
    const start = at;
    let depth = 0;
    while (at < raw.length) {
      const char = raw[at];
      if (char === '"') {
        at = stringEnd(at);
        continue;
      }
      if ((char === "," || char === "}") && depth === 0) break;
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      at++;
    }
    assert(!members.has(key), "Duplicate private field.");
    members.set(key, raw.slice(start, at).trim());
    if (raw[at] === ",") at++;
    else break;
  }
  const value = members.get(name);
  assert(value !== undefined, "Required original private token is absent.");
  return value;
}
export type StoreMessage = { operation: "store_request"; id: number; request: ObjectValue; rawRequest: string };
export function decodeStoreMessage(raw: string, previousId: number): StoreMessage {
  assert(Buffer.byteLength(raw) < PRIVATE_WIRE_MAX_BYTES);
  const value: unknown = JSON.parse(raw);
  closed(value, ["operation", "id", "request"]);
  assert.equal(value.operation, "store_request");
  integer(value.id);
  assert.equal(value.id, previousId + 1);
  request(value.request);
  assert(object(value.request));
  rawMember(raw, "operation");
  rawMember(raw, "id");
  return { operation: "store_request", id: value.id, request: value.request, rawRequest: rawMember(raw, "request") };
}
export function storeResponse(message: StoreMessage, raw: string): string {
  assert(Buffer.byteLength(raw) < PRIVATE_WIRE_MAX_BYTES);
  const value: unknown = JSON.parse(raw);
  assert(object(value));
  assert.equal(value.operation, message.request.operation);
  if (value.operation === "read") {
    closed(value, ["operation", "record"]);
    record(value.record);
  } else if (value.operation === "commit") {
    closed(value, ["operation", "committed"]);
    assert(typeof value.committed === "boolean");
  } else {
    closed(value, ["operation", "entries", "next_cursor"]);
    assert(Array.isArray(value.entries));
    for (const entry of value.entries) {
      closed(entry, ["key", "record"]);
      text(entry.key);
      assert(entry.record !== null);
      record(entry.record);
    }
    assert(value.next_cursor === null || typeof value.next_cursor === "string");
  }
  const result = `{"operation":"store_response","id":${message.id},"response":${raw}}`;
  assert(Buffer.byteLength(result) < PRIVATE_WIRE_MAX_BYTES);
  return result;
}
export async function* privateLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        assert.equal(pending.length, 0, "Private fixture ended in a partial message.");
        return;
      }
      pending = Buffer.concat([pending, chunk.value]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        assert(end + 1 <= PRIVATE_WIRE_MAX_BYTES, "Private fixture line exceeded its bound.");
        yield new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
      }
      assert(pending.length < PRIVATE_WIRE_MAX_BYTES, "Private fixture line exceeded its bound.");
    }
  } finally {
    reader.releaseLock();
  }
}
export type FileFact = Readonly<{ path: string; sha256: string }>;
type Oracle = Readonly<{ runner: FileFact; profile: FileFact; graph: FileFact; key: FileFact; schema: FileFact; files: readonly FileFact[] }>;
export type Manifest = Readonly<{
  v: 1;
  source_sha: string;
  source_tree: string;
  run_directory: string;
  worker_js: FileFact;
  worker_wasm: FileFact;
  native_fixture: FileFact;
  workerd_binary: FileFact;
  artifact_receipts: readonly FileFact[];
  confinement_receipt: FileFact;
  oracle: Oracle;
}>;
function fact(value: unknown): asserts value is FileFact {
  closed(value, ["path", "sha256"]);
  text(value.path);
  assert(value.path.startsWith("/"));
  text(value.sha256);
  assert(/^[a-f0-9]{64}$/.test(value.sha256));
}
export function manifest(value: unknown, expected: string): Manifest {
  closed(value, [
    "v",
    "source_sha",
    "source_tree",
    "run_directory",
    "worker_js",
    "worker_wasm",
    "native_fixture",
    "workerd_binary",
    "artifact_receipts",
    "confinement_receipt",
    "oracle",
  ]);
  assert.equal(value.v, 1);
  assert(/^[a-f0-9]{40}$/.test(expected));
  assert.equal(value.source_sha, expected);
  text(value.source_tree);
  assert(/^[a-f0-9]{40}$/.test(value.source_tree));
  text(value.run_directory);
  assert(resolve(value.run_directory).startsWith(TASK_ROOT + "/"));
  for (const key of ["worker_js", "worker_wasm", "native_fixture", "workerd_binary", "confinement_receipt"]) fact(value[key]);
  assert(Array.isArray(value.artifact_receipts) && value.artifact_receipts.length > 0);
  for (const entry of value.artifact_receipts) fact(entry);
  closed(value.oracle, ["runner", "profile", "graph", "key", "schema", "files"]);
  for (const key of ["runner", "profile", "graph", "key", "schema"]) fact(value.oracle[key]);
  assert(Array.isArray(value.oracle.files));
  for (const entry of value.oracle.files) fact(entry);
  assert.equal(basename(value.native_fixture.path), "worker-custody-fixture");
  assert.equal(basename(value.workerd_binary.path), "workerd");
  return value as Manifest;
}
async function verifyFile(value: FileFact): Promise<void> {
  assert.equal(sha256(await readFile(value.path)), value.sha256, "Prepared file hash differs.");
}
export function verifyArtifactIdentity(value: unknown, input: Manifest): Set<string> {
  assert(object(value));
  assert.equal(value.source_sha, input.source_sha);
  assert.equal(value.source_tree, input.source_tree);
  assert(Array.isArray(value.artifacts));
  const found = new Set<string>();
  for (const artifact of value.artifacts) {
    assert(object(artifact));
    for (const required of [input.worker_js, input.worker_wasm, input.native_fixture])
      if (artifact.path === required.path) {
        assert.equal(artifact.sha256, required.sha256);
        found.add(required.path);
      }
  }
  return found;
}
export async function settle(child: { exitCode: number | null; kill: (signal: NodeJS.Signals) => unknown; exited: Promise<number> }): Promise<void> {
  if (child.exitCode !== null) {
    await child.exited;
    return;
  }
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
class NativePort {
  private child;
  private lines;
  private id = 0;
  readonly stderr: Promise<string>;
  constructor(binary: string, workspace: string) {
    this.child = Bun.spawn([binary], { cwd: workspace, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.lines = privateLines(this.child.stdout)[Symbol.asyncIterator]();
    this.stderr = new Response(this.child.stderr).text();
  }
  async call(command: unknown, expected: string, origin?: string): Promise<ObjectValue> {
    const raw = JSON.stringify(command);
    assert(Buffer.byteLength(raw) < PRIVATE_WIRE_MAX_BYTES);
    this.child.stdin.write(raw + "\n");
    await this.child.stdin.flush();
    const timeout = new Promise<never>((_resolve, reject) => {
      this.timer = setTimeout(() => reject(new Error("Native fixture phase exceeded twenty seconds.")), 20_000);
    });
    try {
      while (true) {
        const next = await Promise.race([this.lines.next(), timeout]);
        assert(!next.done, "Native fixture closed before its phase receipt.");
        const value: unknown = JSON.parse(next.value);
        assert(object(value));
        if (value.operation === "store_request") {
          assert(origin, "Preparation unexpectedly requested common storage.");
          const message = decodeStoreMessage(next.value, this.id);
          this.id = message.id;
          const response = await fetch(`${origin}/store`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-fixture-wire-version": "1" },
            body: message.rawRequest,
          });
          assert.equal(response.status, 200, "The actual common DO refused the fixture Store RPC.");
          this.child.stdin.write(storeResponse(message, await response.text()) + "\n");
          await this.child.stdin.flush();
        } else {
          assert.equal(value.operation, expected, "Native fixture phase differs.");
          return value;
        }
      }
    } finally {
      clearTimeout(this.timer);
    }
  }
  private timer: ReturnType<typeof setTimeout> | undefined;
  async close(expectSuccess = false): Promise<void> {
    this.child.stdin.end();
    if (expectSuccess) {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGTERM");
      }, 3000);
      try {
        assert.equal(await this.child.exited, 0, "Native fixture exited unsuccessfully.");
      } finally {
        clearTimeout(timer);
      }
    }
    await settle(this.child);
    await this.stderr;
  }
}
type Running = { origin: string; stop: () => Promise<void> };
async function configuration(input: Manifest): Promise<string> {
  const workspace = input.run_directory;
  const quote = JSON.stringify;
  await mkdir(join(workspace, "state"));
  const config = `using Workerd = import ${quote(join(ROOT, "node_modules/workerd/workerd.capnp"))};
const config :Workerd.Config = ( services = [
(name = "internet", network = (allow = [])), (name = "state", disk = (path = ${quote(join(workspace, "state"))}, writable = true)),
(name = "gateway", worker = (modules = [(name = "index.js", esModule = embed ${quote(input.worker_js.path)}),(name = "index_bg.wasm", wasm = embed ${quote(input.worker_wasm.path)})], compatibilityDate = "2026-10-18", compatibilityFlags = ["enable_request_signal","request_signal_passthrough"], durableObjectNamespaces = [(className = "GatewayAuthority", uniqueKey = "uos-rust-state-migration-conformance-v1", enableSql = true)], durableObjectStorage = (localDisk = "state"))),
(name = "driver", worker = (modules = [(name = "driver.mjs", esModule = embed ${quote(join(ROOT, "tools/cloudflare/fixtures/storage-driver.mjs"))})], compatibilityDate = "2026-10-18", bindings = [(name = "GATEWAY", service = "gateway"),(name = "AUTHORITY", durableObjectNamespace = (className = "GatewayAuthority", serviceName = "gateway"))]))], sockets = [(name = "main", http = (), service = "driver")]);`;
  const path = join(workspace, "state.capnp");
  await writeFile(path, config);
  return path;
}
async function start(input: Manifest, config: string, serial: number): Promise<Running> {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = listener.port;
  await listener.stop(true);
  const child = Bun.spawn([input.workerd_binary.path, "serve", config, "--experimental", "--import-path", "/", "--socket-addr", `main=127.0.0.1:${port}`], {
    cwd: input.run_directory,
    stdout: Bun.file(join(input.run_directory, `workerd-${serial}.stdout.log`)),
    stderr: Bun.file(join(input.run_directory, `workerd-${serial}.stderr.log`)),
  });
  const stop = (): Promise<void> => settle(child);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, "workerd exited during startup.");
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
    throw new Error("workerd did not become ready.");
  } catch (error) {
    await stop();
    throw error;
  }
}
async function privateFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
async function oracle(input: Manifest, directory: string, source: string, success: boolean): Promise<void> {
  const o = input.oracle;
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--no-install", o.runner.path, "restore", directory, o.profile.path, o.graph.path, o.key.path, o.schema.path, source],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: input.run_directory }
  );
  try {
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (success) {
      assert.equal(code, 0, "Frozen Bun native-schema oracle failed.");
      const result: unknown = JSON.parse(output);
      assert(object(result));
      assert.equal(result.runtime, "1.4.0");
      assert.equal(result.native_schema_restart, "passed");
      assert.equal(result.exact_graph_roundtrip, "passed");
    } else {
      assert.notEqual(code, 0, "Existing target was accepted.");
      assert(errors.includes("The synthetic destination must be new"), "Refusal did not occur at the existing-target pre-open guard.");
    }
  } finally {
    await settle(child);
  }
}
function capture(value: unknown): asserts value is ObjectValue & { entries: ObjectValue[] } {
  assert(object(value) && value.v === 2 && value.source_codec === "bun-jsc-v1" && value.native_schema_version === 3 && Array.isArray(value.entries));
  assert(value.entries.every(object));
}
function entryKey(entry: ObjectValue): string {
  assert(Array.isArray(entry.raw_key) && entry.raw_key.every((v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255));
  return Buffer.from(entry.raw_key).toString("hex");
}
export function compareLatest(original: unknown, latest: unknown, receipts: readonly ObjectValue[]): void {
  capture(original);
  capture(latest);
  assert.equal(latest.source_git_sha, original.source_git_sha);
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const receipt of receipts) {
    assert(Array.isArray(receipt.changed_keys) && Array.isArray(receipt.deleted_keys));
    for (const [items, target] of [
      [receipt.changed_keys, changed],
      [receipt.deleted_keys, deleted],
    ] as const)
      for (const key of items) {
        text(key);
        assert(key.startsWith("tuple-v1:"));
        target.add(key.slice(9));
      }
  }
  const latestEntries = new Map(latest.entries.map((entry) => [entryKey(entry), entry]));
  assert.equal(latestEntries.size, latest.entries.length);
  for (const entry of original.entries) {
    const key = entryKey(entry);
    if (deleted.has(key)) assert(!latestEntries.has(key), "Deleted source row reappeared.");
    else if (!changed.has(key)) assert(isDeepStrictEqual(latestEntries.get(key), entry), "Unchanged raw key/revision/expiry/typed value differs.");
  }
  for (const key of changed) assert(latestEntries.has(key), "A genuine latest producer row is missing.");
  for (const key of deleted) assert(!latestEntries.has(key));
  assert.notDeepEqual(latest.data_revision, original.data_revision, "Latest inverse kept the stale source data revision.");
}
function verifyNativeRevision(path: string, source: ObjectValue): void {
  assert(object(source.data_revision));
  const db = new Database(path, { readonly: true, strict: true, safeIntegers: true });
  try {
    const row = db.query("SELECT version,seq FROM data_version WHERE k=0").get();
    assert(object(row));
    assert.equal(String(row.version), source.data_revision.version);
    assert.equal(String(row.seq), source.data_revision.sequence);
    assert.equal(db.query("SELECT * FROM queue").all().length, 0);
    assert.equal(db.query("SELECT * FROM queue_running").all().length, 0);
  } finally {
    db.close(true);
  }
}
function producer(value: ObjectValue, expected: string, cases: readonly string[]): void {
  closed(value, ["operation", "cases", "changed_keys", "deleted_keys"]);
  assert.equal(value.operation, expected);
  assert.deepEqual(value.cases, cases);
  assert(Array.isArray(value.changed_keys) && Array.isArray(value.deleted_keys));
}
async function actualCase(input: Manifest): Promise<ObjectValue> {
  const workspace = input.run_directory;
  const cases: string[] = [];
  let running: Running | undefined;
  let native: NativePort | undefined;
  try {
    const preparation = new NativePort(input.native_fixture.path, workspace);
    let prepared: ObjectValue;
    try {
      prepared = await preparation.call({ v: 1, operation: "prepare_inputs", directory: join(workspace, "owners"), now_ms: 2200 }, "inputs_prepared");
      await preparation.close(true);
    } finally {
      await preparation.close();
    }
    closed(prepared, ["operation", "directory", "capture"]);
    capture(prepared.capture);
    const source = prepared.capture;
    const sourceFile = join(workspace, "stopped-source.json");
    await privateFile(sourceFile, source);
    const sourceDirectory = join(workspace, "stopped-source");
    await mkdir(sourceDirectory);
    await oracle(input, sourceDirectory, sourceFile, true);
    const sourceDb = join(sourceDirectory, "restore-new.sqlite3");
    const stoppedHash = sha256(await readFile(sourceDb));
    verifyNativeRevision(sourceDb, source);
    cases.push("stopped_synthetic_native_schema_source_verified");
    const sibling = join(workspace, "owners/managed-b/auth.json");
    const siblingHash = sha256(await readFile(sibling));
    const config = await configuration(input);
    running = await start(input, config, 1);
    native = new NativePort(input.native_fixture.path, workspace);
    const candidate = await native.call({ v: 1, directory: prepared.directory, now_ms: 2300, capture: source }, "candidate", running.origin);
    closed(candidate, ["operation", "capture", "adoption_receipt"]);
    capture(candidate.capture);
    assert(!JSON.stringify(candidate.capture).includes("synthetic-native-"), "Refresh-bearing source reached the common candidate.");
    closed(candidate.adoption_receipt, ["capture_id", "source_git_sha", "source_rows", "derived_rows", "atomic_committed"]);
    assert.equal(candidate.adoption_receipt.atomic_committed, true);
    assert.equal(candidate.adoption_receipt.source_rows, source.entries.length);
    assert.equal(candidate.adoption_receipt.source_git_sha, source.source_git_sha);
    text(candidate.adoption_receipt.capture_id);
    assert(/^[a-f0-9]{64}$/.test(candidate.adoption_receipt.capture_id));
    await privateFile(join(workspace, "adoption-receipt.json"), candidate.adoption_receipt);
    cases.push("actual_common_do_atomic_adoption_receipt");
    await running.stop();
    running = await start(input, config, 2);
    cases.push("actual_same_common_do_disk_restarted");
    const runtime = await native.call({ v: 1, operation: "exercise_runtime" }, "runtime_exercised", running.origin);
    producer(runtime, "runtime_exercised", [
      "actual_adopted_api_authentication",
      "actual_post_restart_admission",
      "actual_admin_read_write",
      "actual_adopted_row_delete",
      "actual_latest_shared_graph_write",
    ]);
    cases.push(...(runtime.cases as string[]));
    const custody = await native.call({ v: 1, operation: "advance_managed_a" }, "managed_a_advanced", running.origin);
    producer(custody, "managed_a_advanced", [
      "stale_owner_generation_refused",
      "actual_managed_a_current_projection",
      "unchanged_managed_b_physical_and_projection",
      "current_owner_inverse_accepted",
    ]);
    cases.push(...(custody.cases as string[]));
    const artifacts = {
      rust_git_sha: input.source_sha,
      rust_git_tree: input.source_tree,
      wasm_sha256: input.worker_wasm.sha256,
      native_sha256: input.native_fixture.sha256,
      native_nonce_capture_sha256: null,
    };
    const inverse = await native.call({ v: 1, now_ms: 2400, artifacts }, "inverse", running.origin);
    closed(inverse, ["operation", "source", "rust_controls", "artifacts"]);
    assert.deepEqual(inverse.artifacts, artifacts);
    assert(Array.isArray(inverse.rust_controls));
    compareLatest(source, inverse.source, [runtime, custody]);
    capture(inverse.source);
    const latest = join(workspace, "latest-private-native.json");
    await privateFile(latest, inverse.source);
    await privateFile(join(workspace, "rust-private-controls.json"), inverse.rust_controls);
    await native.close(true);
    native = undefined;
    await running.stop();
    running = undefined;
    cases.push("quiescent_latest_current_owner_inverse");
    const target = join(workspace, "latest-new-target");
    await mkdir(target);
    await oracle(input, target, latest, true);
    const targetDb = join(target, "restore-new.sqlite3");
    verifyNativeRevision(targetDb, inverse.source);
    const targetHash = sha256(await readFile(targetDb));
    cases.push("latest_new_bun_raw_revision_expiry_graph_counter_bytes_roundtrip");
    await oracle(input, target, latest, false);
    assert.equal(sha256(await readFile(targetDb)), targetHash);
    cases.push("occupied_target_refused_before_open_unchanged");
    const corrupt = join(workspace, "corrupt-existing-target");
    await mkdir(corrupt);
    const corruptPath = join(corrupt, "restore-new.sqlite3");
    await writeFile(corruptPath, "existing corrupt synthetic destination\n", { flag: "wx" });
    const corruptHash = sha256(await readFile(corruptPath));
    await oracle(input, corrupt, latest, false);
    assert.equal(sha256(await readFile(corruptPath)), corruptHash);
    cases.push("corrupt_existing_target_refused_before_open_not_parser_detection");
    assert.equal(sha256(await readFile(sourceDb)), stoppedHash);
    assert.equal(sha256(await readFile(sibling)), siblingHash);
    assert.equal(sha256(await readFile(sourceFile)), sha256(JSON.stringify(source, null, 2) + "\n"));
    return {
      source_sha: input.source_sha,
      source_tree: input.source_tree,
      artifacts,
      cases,
      source_database_sha256: stoppedHash,
      latest_target_sha256: targetHash,
      latest_capture_sha256: sha256(await readFile(latest)),
      native_private_partition: "current_custody_only",
      processes_settled: true,
    };
  } finally {
    if (native) await native.close();
    if (running) await running.stop();
  }
}
async function load(path: string, expected: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const input = manifest(value, expected);
  const files = [
    input.worker_js,
    input.worker_wasm,
    input.native_fixture,
    input.workerd_binary,
    input.confinement_receipt,
    ...input.artifact_receipts,
    input.oracle.runner,
    input.oracle.profile,
    input.oracle.graph,
    input.oracle.key,
    input.oracle.schema,
    ...input.oracle.files,
  ];
  for (const file of files) await verifyFile(file);
  const found = new Set<string>();
  for (const receipt of input.artifact_receipts) {
    const value: unknown = JSON.parse(await readFile(receipt.path, "utf8"));
    for (const path of verifyArtifactIdentity(value, input)) found.add(path);
  }
  for (const artifact of [input.worker_js, input.worker_wasm, input.native_fixture])
    assert(found.has(artifact.path), "No matching same-source artifact receipt.");
  const metadata: unknown = JSON.parse(await readFile(join(ROOT, "node_modules/workerd/package.json"), "utf8"));
  assert(object(metadata) && metadata.version === "1.20261012.1");
  const boundary: unknown = JSON.parse(await readFile(input.confinement_receipt.path, "utf8"));
  assert(object(boundary) && boundary.platform === process.platform && Array.isArray(boundary.cases) && boundary.cases.includes("os_external_tcp_denied"));
  assert.equal(boundary.boundarySha256, sha256(await readFile(join(ROOT, "scripts/test-network.ts"))));
  assert.equal(boundary.workerdSha256, input.workerd_binary.sha256);
  const parent = await realpath(dirname(input.run_directory));
  const task = await realpath(TASK_ROOT);
  assert(parent === task || parent.startsWith(task + "/"));
  assert.equal(parent, resolve(dirname(input.run_directory)).replace(/^\/tmp\//, "/private/tmp/"));
  return input;
}
async function main(): Promise<void> {
  assert.equal(Bun.version, "1.4.0");
  const child = process.argv[2] === "--fixture-child";
  const expected = process.argv[child ? 3 : 2];
  const path = process.argv[child ? 4 : 3];
  assert(expected && path, "Pass the exact full source SHA and explicit prepared task manifest.");
  const input = await load(path, expected);
  if (child) {
    const result = await actualCase(input);
    await privateFile(join(input.run_directory, "receipt.json"), result);
    console.log(JSON.stringify(result));
    return;
  }
  await assert.rejects(stat(input.run_directory), { code: "ENOENT" });
  await mkdir(input.run_directory);
  const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(await realpath(input.run_directory))}))`;
  const argv = [
    "/usr/bin/sandbox-exec",
    "-p",
    profile,
    ...testNetworkArgv([process.execPath, "--no-env-file", "--no-install", fileURLToPath(import.meta.url), "--fixture-child", expected, path]),
  ];
  const processChild = Bun.spawn(argv, {
    cwd: ROOT,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: input.run_directory, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = (): void => {
    if (processChild.exitCode === null) processChild.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = setTimeout(stop, 120_000);
  try {
    const [code, output, errors] = await Promise.all([processChild.exited, new Response(processChild.stdout).text(), new Response(processChild.stderr).text()]);
    await writeFile(join(input.run_directory, "controller.stderr.log"), errors);
    assert.equal(code, 0, "Actual common-DO/latest-Bun acceptance failed; task state retained.");
    console.log(output.trim());
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await settle(processChild);
  }
}
if (import.meta.main) await main();
