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
function selector(value: unknown): void {
  assert(object(value));
  if (value.kind === "prefix") {
    closed(value, ["kind", "prefix", "start", "end"]);
    text(value.prefix);
    for (const key of ["start", "end"]) assert(value[key] === null || typeof value[key] === "string");
  } else {
    closed(value, ["kind", "start", "end"]);
    assert.equal(value.kind, "range");
    text(value.start);
    text(value.end);
  }
}
function commitRequest(value: ObjectValue): void {
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
}
function request(value: unknown): void {
  assert(object(value));
  if (value.operation === "read") {
    closed(value, ["operation", "key"]);
    text(value.key);
  } else if (value.operation === "commit") commitRequest(value);
  else {
    closed(value, ["operation", "selector", "reverse", "limit", "cursor", "now_ms"]);
    assert.equal(value.operation, "query");
    selector(value.selector);
    assert(typeof value.reverse === "boolean");
    integer(value.limit);
    integer(value.now_ms);
    assert(value.cursor === null || typeof value.cursor === "string");
  }
}
function stringEnd(raw: string, start: number): number {
  let cursor = start + 1;
  while (cursor < raw.length) {
    if (raw[cursor] === "\\") cursor += 2;
    else if (raw[cursor++] === '"') return cursor;
  }
  throw new Error("Incomplete private JSON string.");
}
function valueEnd(raw: string, start: number): number {
  let at = start;
  let depth = 0;
  while (at < raw.length) {
    const char = raw[at];
    if (char === '"') {
      at = stringEnd(raw, at);
      continue;
    }
    if ((char === "," || char === "}") && depth === 0) break;
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    at++;
  }
  return at;
}
// Preserve the ORIGINAL request token, including escaped UTF16 and number spelling.
// JSON.parse is validation only; it is never used to re-encode a Store request.
export function rawMember(raw: string, name: string): string {
  const members = new Map<string, string>();
  let at = 1;
  const space = (): void => {
    while (/\s/.test(raw[at] ?? "") && at < raw.length) at++;
  };
  assert.equal(raw[0], "{");
  while (at < raw.length) {
    space();
    if (raw[at] === "}") break;
    assert.equal(raw[at], '"');
    const end = stringEnd(raw, at);
    const key: unknown = JSON.parse(raw.slice(at, end));
    text(key);
    at = end;
    space();
    assert.equal(raw[at++], ":");
    space();
    const start = at;
    at = valueEnd(raw, at);
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
// SourceJson may retain structural LF. Only a complete root object followed by
// the existing LF separator is a frame; no payload byte is rewritten.
class PrivateFrameBoundary {
  private readonly _openings: number[] = [];
  private _started = false;
  private _quoted = false;
  private _escaped = false;
  private _complete = false;
  terminates(byte: number): boolean {
    return this._complete && byte === 10;
  }
  accept(byte: number): boolean {
    if (this._complete) {
      assert([32, 9, 13, 10].includes(byte), "Private frame has data after its root object.");
      return byte === 10;
    }
    if (!this._started) {
      if ([32, 9, 13].includes(byte)) return false;
      assert.equal(byte, 123, "Private frame must contain one root JSON object.");
      this._started = true;
      this._openings.push(byte);
      return false;
    }
    if (this._quoted) this._stringByte(byte);
    else this._structuralByte(byte);
    return false;
  }
  private _stringByte(byte: number): void {
    if (this._escaped) this._escaped = false;
    else if (byte === 92) this._escaped = true;
    else if (byte === 34) this._quoted = false;
  }
  private _structuralByte(byte: number): void {
    switch (byte) {
      case 34:
        this._quoted = true;
        break;
      case 123:
      case 91:
        this._openings.push(byte);
        break;
      case 125:
      case 93:
        assert.equal(this._openings.pop(), byte === 125 ? 123 : 91, "Private JSON delimiters differ.");
        this._complete = this._openings.length === 0;
        break;
      default:
        break;
    }
  }
}
export async function* privateLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  let segments: Uint8Array[] = [];
  let bytes = 0;
  let boundary = new PrivateFrameBoundary();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        assert.equal(bytes, 0, "Private fixture ended in a partial message.");
        return;
      }
      let start = 0;
      for (let at = 0; at < chunk.value.length; at++) {
        const byte = chunk.value[at];
        // Reserve the original separator byte, checking BEFORE any retained copy
        // or concatenation; the cap applies to the entire object, not each LF.
        assert(bytes < PRIVATE_WIRE_MAX_BYTES - 1 || boundary.terminates(byte), "Private fixture frame exceeded its bound.");
        bytes++;
        if (boundary.accept(byte)) {
          const raw = Buffer.concat([...segments, chunk.value.subarray(start, at)], bytes - 1);
          segments = [];
          bytes = 0;
          boundary = new PrivateFrameBoundary();
          start = at + 1;
          yield new TextDecoder("utf-8", { fatal: true }).decode(raw);
        }
      }
      if (start < chunk.value.length) segments.push(chunk.value.slice(start));
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
  fixture_scenario?: "history-staged-v1";
}>;
function fact(value: unknown): asserts value is FileFact {
  closed(value, ["path", "sha256"]);
  text(value.path);
  assert(value.path.startsWith("/"));
  text(value.sha256);
  assert(/^[a-f0-9]{64}$/.test(value.sha256));
}
export function fixtureEnvelope(scenario: unknown): number {
  assert(scenario === undefined || scenario === "history-staged-v1", "Unsupported finite state fixture scenario.");
  return scenario === undefined ? 120_000 : 360_000;
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
    ...(object(value) && Object.hasOwn(value, "fixture_scenario") ? ["fixture_scenario"] : []),
  ]);
  fixtureEnvelope(value.fixture_scenario);
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
  fact(value.native_fixture);
  fact(value.workerd_binary);
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
const NATIVE_PHASES: ReadonlyMap<string, string> = new Map([
  ["inputs_prepared", "prepare-inputs"],
  ["candidate", "candidate"],
  ["runtime_exercised", "exercise-runtime"],
  ["managed_a_advanced", "advance-managed-a"],
  ["inverse", "inverse"],
  ["staged_partial", "staged-partial"],
  ["staged_exercised", "staged-exercised"],
]);
class NativeStderr {
  private readonly _prefix = new Uint8Array(32 * 1024);
  private readonly _tail = new Uint8Array(32 * 1024);
  private _prefixBytes = 0;
  private _tailBytes = 0;
  private _next = 0;
  private _total = 0;
  private _complete = false;
  async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          this._complete = true;
          return;
        }
        this._append(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  private _append(bytes: Uint8Array): void {
    this._total += bytes.length;
    const take = Math.min(bytes.length, this._prefix.length - this._prefixBytes);
    this._prefix.set(bytes.subarray(0, take), this._prefixBytes);
    this._prefixBytes += take;
    const rest = bytes.subarray(take);
    if (rest.length >= this._tail.length) {
      this._tail.set(rest.subarray(rest.length - this._tail.length));
      this._tailBytes = this._tail.length;
      this._next = 0;
    } else if (rest.length > 0) {
      const first = Math.min(rest.length, this._tail.length - this._next);
      this._tail.set(rest.subarray(0, first), this._next);
      this._tail.set(rest.subarray(first), 0);
      this._next = (this._next + rest.length) % this._tail.length;
      this._tailBytes = Math.min(this._tail.length, this._tailBytes + rest.length);
    }
  }
  snapshot() {
    const tail =
      this._tailBytes < this._tail.length
        ? this._tail.subarray(0, this._tailBytes)
        : Buffer.concat([this._tail.subarray(this._next), this._tail.subarray(0, this._next)]);
    return {
      scope: "process_lifetime",
      complete: this._complete,
      total_bytes: this._total,
      retained_bytes: this._prefixBytes + this._tailBytes,
      truncated: this._total > this._prefixBytes + this._tailBytes,
      prefix_base64: Buffer.from(this._prefix.subarray(0, this._prefixBytes)).toString("base64"),
      tail_base64: Buffer.from(tail).toString("base64"),
    };
  }
}
export function throwCleanupFailures(results: readonly PromiseSettledResult<unknown>[], primary?: Readonly<{ error: unknown }>): void {
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length === 0) return;
  if (primary) throw new AggregateError([primary.error, ...failures], "State operation and cleanup failed.", { cause: primary.error });
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, "State cleanup failed.");
}
export class NativePort {
  private _child;
  private _lines;
  private readonly _capture = new NativeStderr();
  private readonly _workspace;
  private _phase = "unknown";
  private _stderr: Promise<PromiseSettledResult<void>[]> | undefined;
  private _closing: Promise<{ results: PromiseSettledResult<unknown>[]; exit: PromiseSettledResult<number> }> | undefined;
  private _id = 0;
  constructor(binary: string, workspace: string) {
    this._workspace = workspace;
    this._child = Bun.spawn([binary], { cwd: workspace, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this._lines = privateLines(this._child.stdout)[Symbol.asyncIterator]();
  }
  async call(command: unknown, expected: string, origin?: string): Promise<ObjectValue> {
    this._phase = NATIVE_PHASES.get(expected) ?? "unknown";
    void this._readStderr();
    const raw = JSON.stringify(command);
    assert(Buffer.byteLength(raw) < PRIVATE_WIRE_MAX_BYTES);
    await this._child.stdin.write(raw + "\n");
    await this._child.stdin.flush();
    const timeout = new Promise<never>((_resolve, reject) => {
      this._timer = setTimeout(
        () => {
          reject(new Error("Native fixture phase exceeded twenty seconds."));
        },
        expected.startsWith("staged_") ? 120_000 : 20_000
      );
    });
    try {
      for (;;) {
        const next = await Promise.race([this._lines.next(), timeout]);
        assert(!next.done, "Native fixture closed before its phase receipt.");
        const value: unknown = JSON.parse(next.value);
        assert(object(value));
        if (value.operation === "store_request") {
          assert(origin, "Preparation unexpectedly requested common storage.");
          const message = decodeStoreMessage(next.value, this._id);
          this._id = message.id;
          const response = await fetch(`${origin}/store`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-fixture-wire-version": "1" },
            body: message.rawRequest,
          });
          assert.equal(response.status, 200, "The actual common DO refused the fixture Store RPC.");
          await this._child.stdin.write(storeResponse(message, await response.text()) + "\n");
          await this._child.stdin.flush();
        } else {
          assert.equal(value.operation, expected, "Native fixture phase differs.");
          return value;
        }
      }
    } finally {
      clearTimeout(this._timer);
    }
  }
  private _timer: ReturnType<typeof setTimeout> | undefined;
  async close(expectSuccess = false): Promise<void> {
    this._closing ??= this._close(expectSuccess);
    const cleanup = await this._closing;
    const results = [...cleanup.results];
    if (expectSuccess && cleanup.exit.status === "fulfilled") {
      try {
        assert.equal(cleanup.exit.value, 0, "Native fixture exited unsuccessfully.");
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
    }
    throwCleanupFailures(results);
  }
  private _readStderr(): Promise<PromiseSettledResult<void>[]> {
    this._stderr ??= Promise.allSettled([this._capture.drain(this._child.stderr)]);
    return this._stderr;
  }
  private async _close(graceful: boolean): Promise<{ results: PromiseSettledResult<unknown>[]; exit: PromiseSettledResult<number> }> {
    const phase = this._phase;
    const observedExitBeforeCleanup = this._child.exitCode !== null;
    const stderr = this._readStderr();
    const input = await Promise.allSettled([Promise.resolve().then(() => this._child.stdin.end())]);
    const termination = await Promise.allSettled([this._settle(graceful)]);
    const streams = await Promise.allSettled([this._lines.return(undefined), stderr]);
    const [exit] = await Promise.allSettled([this._child.exited]);
    const artifact = await Promise.allSettled([
      privateFile(join(this._workspace, `native-${phase}.json`), {
        v: 1,
        purpose: "private_native_process_failure_evidence_only",
        last_phase_at_cleanup: phase,
        phase_causality: "not_established",
        exit_code: exit.status === "fulfilled" ? exit.value : null,
        signal_code: this._child.signalCode,
        observed_exit_before_cleanup: observedExitBeforeCleanup,
        stderr: this._capture.snapshot(),
      }),
    ]);
    return { results: [...input, ...termination, ...streams, ...(await stderr), exit, ...artifact], exit };
  }
  private async _settle(graceful: boolean): Promise<void> {
    if (graceful && this._child.exitCode === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this._child.exited,
          new Promise<void>((resolveExit) => {
            timer = setTimeout(resolveExit, 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await settle(this._child);
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
export type FixtureTime = Readonly<{ origin: number; deadline: number; runtime: number; inverse: number }>;
export function fixtureTime(origin: number): FixtureTime {
  assert(Number.isSafeInteger(origin) && origin >= 1200 && Number.isSafeInteger(origin + 300_000), "Fixture time is outside its safe range.");
  return Object.freeze({ origin, deadline: origin + 300_000, runtime: origin + 100, inverse: origin + 200 });
}
export function assertFixtureBudget(time: FixtureTime, now = Date.now()): void {
  assert(Number.isSafeInteger(now) && now >= time.origin && now < time.deadline, "fixture_time_budget_expired");
}
// Same native/common-DO path, a separate unpublished target, no new public route.
async function stagedCase(input: Manifest): Promise<ObjectValue> {
  const directory = join(input.run_directory, "large-staged");
  await mkdir(directory);
  const stagedInput = { ...input, run_directory: directory };
  const config = await configuration(stagedInput);
  let running: Running | undefined;
  let native: NativePort | undefined;
  let failure: Readonly<{ error: unknown }> | undefined;
  try {
    running = await start(stagedInput, config, 1);
    native = new NativePort(input.native_fixture.path, directory);
    const partial = await native.call(
      { v: 1, operation: "staged_case", directory: join(directory, "native"), now_ms: Date.now() },
      "staged_partial",
      running.origin
    );
    integer(partial.source_bytes);
    assert(typeof partial.source_bytes === "number" && partial.source_bytes > PRIVATE_WIRE_MAX_BYTES && partial.unsealed_refused === true);
    await running.stop();
    running = await start(stagedInput, config, 2);
    const artifacts = {
      rust_git_sha: input.source_sha,
      rust_git_tree: input.source_tree,
      wasm_sha256: input.worker_wasm.sha256,
      native_sha256: input.native_fixture.sha256,
      native_nonce_capture_sha256: null,
    };
    const result = await native.call({ v: 1, operation: "staged_resume", artifacts }, "staged_exercised", running.origin);
    assert(Array.isArray(result.cases) && result.cases.length === 8 && result.cases.every((value) => typeof value === "string"));
    assert(
      object(result.receipt) && result.receipt.sealed === true && result.receipt.activation_authorized === false && !("atomic_committed" in result.receipt)
    );
    integer(result.max_stage_frame_bytes);
    assert(
      typeof result.max_stage_frame_bytes === "number" && result.max_stage_frame_bytes <= PRIVATE_WIRE_MAX_BYTES && result.historical_roundtrip_exact === true
    );
    text(result.latest_file);
    const target = join(directory, "latest-bun-target");
    await mkdir(target);
    await oracle(stagedInput, target, result.latest_file, true);
    await privateFile(join(directory, "staged-receipt.json"), result);
    await native.close(true);
    native = undefined;
    await running.stop();
    running = undefined;
    return result;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    throwCleanupFailures(await Promise.allSettled([native?.close(), running?.stop()]), failure);
  }
}
async function actualCase(input: Manifest): Promise<ObjectValue> {
  const workspace = input.run_directory;
  const time = fixtureTime(Date.now());
  assertFixtureBudget(time);
  const cases: string[] = [];
  await writeFile(join(workspace, "allowed-task-path-probe"), "fixed harmless state-controller probe\n", { flag: "wx" });
  await assert.rejects(
    writeFile(workspace + "-outside-task-probe", "fixed harmless state-controller probe\n", { flag: "wx" }),
    (error: unknown) => object(error) && ["EPERM", "EACCES"].includes(String(error.code))
  );
  cases.push("actual_task_write_allowed_outside_task_write_denied");
  let running: Running | undefined;
  let native: NativePort | undefined;
  let failure: Readonly<{ error: unknown }> | undefined;
  try {
    const preparation = new NativePort(input.native_fixture.path, workspace);
    let prepared: ObjectValue;
    let preparationFailure: Readonly<{ error: unknown }> | undefined;
    try {
      assertFixtureBudget(time);
      prepared = await preparation.call({ v: 1, operation: "prepare_inputs", directory: join(workspace, "owners"), now_ms: time.origin }, "inputs_prepared");
      assertFixtureBudget(time);
      await preparation.close(true);
      assertFixtureBudget(time);
    } catch (error) {
      preparationFailure = { error };
      throw error;
    } finally {
      throwCleanupFailures(await Promise.allSettled([preparation.close()]), preparationFailure);
    }
    closed(prepared, ["operation", "directory", "capture"]);
    capture(prepared.capture);
    const source = prepared.capture;
    const sourceFile = join(workspace, "stopped-source.json");
    await privateFile(sourceFile, source);
    const sourceDirectory = join(workspace, "stopped-source");
    await mkdir(sourceDirectory);
    assertFixtureBudget(time);
    await oracle(input, sourceDirectory, sourceFile, true);
    assertFixtureBudget(time);
    const sourceDb = join(sourceDirectory, "restore-new.sqlite3");
    const stoppedHash = sha256(await readFile(sourceDb));
    verifyNativeRevision(sourceDb, source);
    cases.push("stopped_synthetic_native_schema_source_verified");
    const sibling = join(workspace, "owners/managed-b/auth.json");
    const siblingHash = sha256(await readFile(sibling));
    const config = await configuration(input);
    assertFixtureBudget(time);
    running = await start(input, config, 1);
    assertFixtureBudget(time);
    native = new NativePort(input.native_fixture.path, workspace);
    const candidate = await native.call({ v: 1, directory: prepared.directory, now_ms: time.runtime, capture: source }, "candidate", running.origin);
    assertFixtureBudget(time);
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
    assertFixtureBudget(time);
    running = await start(input, config, 2);
    assertFixtureBudget(time);
    cases.push("actual_same_common_do_disk_restarted");
    const runtime = await native.call({ v: 1, operation: "exercise_runtime" }, "runtime_exercised", running.origin);
    assertFixtureBudget(time);
    producer(runtime, "runtime_exercised", [
      "actual_adopted_api_authentication",
      "actual_post_restart_admission",
      "actual_admin_read_write",
      "actual_adopted_row_delete",
      "actual_latest_shared_graph_write",
    ]);
    cases.push(...(runtime.cases as string[]));
    assertFixtureBudget(time);
    const artifacts = {
      rust_git_sha: input.source_sha,
      rust_git_tree: input.source_tree,
      wasm_sha256: input.worker_wasm.sha256,
      native_sha256: input.native_fixture.sha256,
      native_nonce_capture_sha256: null,
    };
    const custody = await native.call({ v: 1, operation: "advance_managed_a", artifacts }, "managed_a_advanced", running.origin);
    assertFixtureBudget(time);
    producer(custody, "managed_a_advanced", [
      "stale_owner_generation_refused",
      "actual_managed_a_current_projection",
      "unchanged_managed_b_physical_and_projection",
      "current_owner_inverse_accepted",
    ]);
    cases.push(...(custody.cases as string[]));
    assertFixtureBudget(time);
    const inverse = await native.call({ v: 1, now_ms: time.inverse, artifacts }, "inverse", running.origin);
    assertFixtureBudget(time);
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
    assertFixtureBudget(time);
    await oracle(input, target, latest, true);
    assertFixtureBudget(time);
    const targetDb = join(target, "restore-new.sqlite3");
    verifyNativeRevision(targetDb, inverse.source);
    const targetHash = sha256(await readFile(targetDb));
    cases.push("latest_new_bun_raw_revision_expiry_graph_counter_bytes_roundtrip");
    assertFixtureBudget(time);
    await oracle(input, target, latest, false);
    assertFixtureBudget(time);
    assert.equal(sha256(await readFile(targetDb)), targetHash);
    cases.push("occupied_target_refused_before_open_unchanged");
    const corrupt = join(workspace, "corrupt-existing-target");
    await mkdir(corrupt);
    const corruptPath = join(corrupt, "restore-new.sqlite3");
    await writeFile(corruptPath, "existing corrupt synthetic destination\n", { flag: "wx" });
    const corruptHash = sha256(await readFile(corruptPath));
    assertFixtureBudget(time);
    await oracle(input, corrupt, latest, false);
    assertFixtureBudget(time);
    assert.equal(sha256(await readFile(corruptPath)), corruptHash);
    cases.push("corrupt_existing_target_refused_before_open_not_parser_detection");
    assert.equal(sha256(await readFile(sourceDb)), stoppedHash);
    assert.equal(sha256(await readFile(sibling)), siblingHash);
    assert.equal(sha256(await readFile(sourceFile)), sha256(JSON.stringify(source, null, 2) + "\n"));
    assertFixtureBudget(time);
    const staged = input.fixture_scenario === "history-staged-v1" ? await stagedCase(input) : undefined;
    return {
      source_sha: input.source_sha,
      source_tree: input.source_tree,
      artifacts,
      cases,
      staged,
      source_database_sha256: stoppedHash,
      latest_target_sha256: targetHash,
      latest_capture_sha256: sha256(await readFile(latest)),
      native_private_partition: "current_custody_only",
      processes_settled: true,
    };
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    throwCleanupFailures(await Promise.allSettled([native?.close(), running?.stop()]), failure);
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
// Compose only a stricter write policy into the ORIGINAL network profile.
// Its wrapper and detached-group lifetime remain byte-for-byte unchanged.
export function stateFixtureArgv(child: readonly string[], directory: string): string[] {
  assert.equal(process.platform, "darwin", "This scoped controller requires its verified Mac fixture boundary.");
  const argv = testNetworkArgv(child);
  assert.equal(argv.length, 6);
  assert.deepEqual(argv.slice(0, 4), [process.execPath, "--no-env-file", "--no-install", "-e"]);
  const encoded: unknown = JSON.parse(argv[5]);
  assert(Array.isArray(encoded) && encoded.length === child.length + 3);
  assert.equal(encoded[0], "/usr/bin/sandbox-exec");
  assert.equal(encoded[1], "-p");
  text(encoded[2]);
  assert(encoded[2].includes("(deny network*)") && encoded[2].includes('(remote ip "localhost:*")'));
  assert(isDeepStrictEqual(encoded.slice(3), child), "Existing fixture child argv differs.");
  assert(directory.startsWith("/private/tmp/ai-rust-wasm-20261018/state-controller-2101/"));
  encoded[2] += `\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(directory)}))`;
  return [...argv.slice(0, 5), JSON.stringify(encoded)];
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
  await assert.rejects(stat(input.run_directory + "-outside-task-probe"), { code: "ENOENT" });
  await mkdir(input.run_directory);
  const argv = stateFixtureArgv(
    [process.execPath, "--no-env-file", "--no-install", fileURLToPath(import.meta.url), "--fixture-child", expected, path],
    await realpath(input.run_directory)
  );
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
  const timer = setTimeout(stop, fixtureEnvelope(input.fixture_scenario));
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
