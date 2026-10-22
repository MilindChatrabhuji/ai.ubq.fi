import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativePort,
  assertFixtureBudget,
  PRIVATE_WIRE_MAX_BYTES,
  compareLatest,
  decodeStoreMessage,
  fixtureTime,
  fixtureEnvelope,
  manifest,
  privateLines,
  rawMember,
  settle,
  storeResponse,
  stateFixtureArgv,
  throwCleanupFailures,
  verifyArtifactIdentity,
} from "../tools/cloudflare/state-migration-conformance.ts";

// These are controller/protocol tests, NOT real migration/common-DO/Bun acceptance.
const sha = "a".repeat(40);
const tree = "b".repeat(40);
const file = (path: string) => ({ path, sha256: "c".repeat(64) });
function prepared() {
  return {
    v: 1,
    source_sha: sha,
    source_tree: tree,
    run_directory: "/tmp/ai-rust-wasm-20261018/state-controller-2101/unit-unused",
    worker_js: file("/tmp/unit/index.js"),
    worker_wasm: file("/tmp/unit/index_bg.wasm"),
    native_fixture: file("/tmp/unit/worker-custody-fixture"),
    workerd_binary: file("/tmp/unit/workerd"),
    artifact_receipts: [file("/tmp/unit/receipt.json")],
    confinement_receipt: file("/tmp/unit/network.json"),
    oracle: {
      runner: file("/tmp/unit/oracle.mjs"),
      profile: file("/tmp/unit/profile-json.ts"),
      graph: file("/tmp/unit/typed-value.ts"),
      key: file("/tmp/unit/kv_key.js"),
      schema: file("/tmp/unit/native-schema.ts"),
      files: [],
    },
  };
}
const row = { schema_version: 1, value_encoding: "json", revision: "r1", value: { control: "\ud800" }, expires_at_ms: null };

test("state controller preserves exact private request bytes, identifiers, UTF16 escapes and exponent syntax", () => {
  const raw = String.raw`{"operation":"store_request","id":1,"request":{ "operation" : "commit", "checks":[],"mutations":[{"operation":"put","key":"tuple-v1:00","record":{"schema_version":1,"value_encoding":"json","revision":"r","value":{"model":"\ud800","number":1e3},"expires_at_ms":null}}] }}`;
  const message = decodeStoreMessage(raw, 0);
  assert.equal(message.rawRequest, raw.slice(raw.indexOf('{ "operation"'), -1));
  const reply = storeResponse(message, ' {"operation":"commit", "committed":true} ');
  assert.equal(reply, '{"operation":"store_response","id":1,"response": {"operation":"commit", "committed":true} }');
});
test("state controller rejects mismatched/replayed ids, unknown operations and extra privileged fields", () => {
  for (const value of [
    { operation: "store_request", id: 2, request: { operation: "read", key: "tuple-v1:00" } },
    { operation: "store_request", id: 1, request: { operation: "sql", statement: "SELECT 1" } },
    { operation: "store_request", id: 1, request: { operation: "read", key: "tuple-v1:00", callback: "forbidden" } },
    { operation: "store_request", id: 1, request: { operation: "read", key: "tuple-v1:00" }, token: "not-a-wire-field" },
  ])
    assert.throws(() => decodeStoreMessage(JSON.stringify(value), 0));
  assert.throws(() => decodeStoreMessage('{"operation":"store_request","id":1,"id":1,"request":{"operation":"read","key":"tuple-v1:00"}}', 0));
});
test("private raw-member scanning retains nested strings and refuses duplicate keys", () => {
  const nested = JSON.stringify({ text: '"},[', nested: [{}, 2] });
  const raw = `{"request":${nested},"operation":"store_request","id":1}`;
  assert.equal(rawMember(raw, "request"), nested);
  assert.throws(() => rawMember('{"x":1,"x":2}', "x"));
  assert.throws(() => rawMember('{"x":1}', "request"));
});
test("actual finite response type and closed record envelope must match the originating Store request", () => {
  const read = decodeStoreMessage('{"operation":"store_request","id":1,"request":{"operation":"read","key":"tuple-v1:00"}}', 0);
  assert(storeResponse(read, JSON.stringify({ operation: "read", record: row })).includes('"id":1'));
  assert.throws(() => storeResponse(read, '{"operation":"commit","committed":true}'));
  assert.throws(() => storeResponse(read, '{"operation":"read","record":null,"unexpected":true}'));
  assert.throws(() => storeResponse(read, JSON.stringify({ operation: "read", record: { ...row, raw_auth: "forbidden" } })));
});
test("query selector and query response retain only the existing finite port schema", () => {
  const query = decodeStoreMessage(
    JSON.stringify({
      operation: "store_request",
      id: 3,
      request: {
        operation: "query",
        selector: { kind: "prefix", prefix: "tuple-v1:", start: null, end: null },
        reverse: false,
        limit: 1,
        cursor: null,
        now_ms: 2300,
      },
    }),
    2
  );
  assert(storeResponse(query, JSON.stringify({ operation: "query", entries: [{ key: "tuple-v1:00", record: row }], next_cursor: null })).includes('"id":3'));
  assert.throws(() => storeResponse(query, '{"operation":"query","entries":[{"key":"a","record":null}],"next_cursor":null}'));
});
test("private stream handles split UTF8/chunk boundaries and refuses partial EOF or invalid UTF8", async () => {
  const bytes = new TextEncoder().encode('{"operation":"example","text":"α"}\n{}\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
      controller.close();
    },
  });
  const lines: string[] = [];
  for await (const line of privateLines(stream)) lines.push(line);
  assert.deepEqual(lines, ['{"operation":"example","text":"α"}', "{}"]);
  for (const content of [new Uint8Array([123]), new Uint8Array([255, 10])]) {
    await assert.rejects(async () => {
      for await (const line of privateLines(
        new ReadableStream({
          start(controller) {
            controller.enqueue(content);
            controller.close();
          },
        })
      ))
        assert(line);
    });
  }
});
test("state artifact manifest requires exact source and task-owned run directory, no arbitrary additional config", () => {
  const valid = prepared();
  assert.equal(manifest(valid, sha).source_tree, tree);
  assert.throws(() => manifest(valid, "d".repeat(40)));
  assert.throws(() => manifest({ ...valid, run_directory: "/tmp/not-task-owned" }, sha));
  assert.throws(() => manifest({ ...valid, provider_key: "forbidden" }, sha));
  assert.throws(() => manifest({ ...valid, native_fixture: file("/tmp/not-the-fixed-binary") }, sha));
});
test("artifact sidecar cannot relabel an older release or native binary as the new tested tree", () => {
  const input = manifest(prepared(), sha);
  const identity = { source_sha: sha, source_tree: tree, artifacts: [input.worker_js, input.worker_wasm, input.native_fixture] };
  assert.equal(verifyArtifactIdentity(identity, input).size, 3);
  assert.throws(() => verifyArtifactIdentity({ ...identity, source_sha: "f".repeat(40) }, input));
  assert.throws(() => verifyArtifactIdentity({ ...identity, source_tree: "e".repeat(40) }, input));
  assert.throws(() => verifyArtifactIdentity({ ...identity, artifacts: [{ ...input.native_fixture, sha256: "d".repeat(64) }] }, input));
});
function capture(entries: unknown[], revision = "50") {
  return { v: 2, source_git_sha: sha, source_codec: "bun-jsc-v1", native_schema_version: 3, data_revision: { version: revision, sequence: "0" }, entries };
}
const native = (key: number, value: unknown) => ({ raw_key: [key], value, revision: { version: "10", sequence: "1" }, expiration_ms: 9500 });
test("latest comparison requires genuine changed rows/deletes and exact unchanged native metadata/graphs", () => {
  const original = capture([native(1, { graph: "original" }), native(2, "deleted"), native(3, "unchanged")]);
  const latest = capture([native(1, { graph: "actual latest" }), native(3, "unchanged")], "51");
  const receipt = { changed_keys: ["tuple-v1:01"], deleted_keys: ["tuple-v1:02"] };
  compareLatest(original, latest, [receipt]);
  assert.throws(() => {
    compareLatest(original, capture(original.entries, "51"), [receipt]);
  });
  assert.throws(() => {
    compareLatest(original, { ...latest, data_revision: original.data_revision }, [receipt]);
  });
  assert.throws(() => {
    compareLatest(original, capture([native(1, { graph: "latest" }), { ...native(3, "unchanged"), expiration_ms: 1 }], "51"), [receipt]);
  });
  assert.throws(() => {
    compareLatest(original, capture([native(3, "unchanged")], "51"), [receipt]);
  });
});
test("settlement awaits an already terminated child and signals/reaps only the supplied process", async () => {
  const signals: string[] = [];
  let finish: (code: number) => void = (code: number) => {
    throw new Error(`No pending process: ${code}`);
  };
  const exited = new Promise<number>((resolveExit) => {
    finish = resolveExit;
  });
  const child = {
    exitCode: null as number | null,
    exited,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      this.exitCode = 143;
      finish(143);
    },
  };
  await settle(child);
  assert.deepEqual(signals, ["SIGTERM"]);
  await settle(child);
  assert.deepEqual(signals, ["SIGTERM"]);
});

function lifecycleFixture(fails = false) {
  const directory = mkdtempSync(join(tmpdir(), "uos-native-port-"));
  const binary = join(directory, "fixture");
  const script = fails
    ? "printf '%s\\n' '{\"operation\":\"ready\"}'\nexit 7\n"
    : "IFS= read -r line\nprintf '%s\\n' '{\"operation\":\"ready\"}'\nprintf '%131072d' 0 >&2\nwhile IFS= read -r line; do :; done\nexit 0\n";
  writeFileSync(binary, "#!/bin/sh\necho $$ > fixture.pid\n" + script, { mode: 0o700 });
  const port = new NativePort(binary, directory);
  return { directory, port, pid: () => Number(readFileSync(join(directory, "fixture.pid"), "utf8").trim()) };
}
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    assert(error instanceof Error && "code" in error && error.code === "ESRCH");
    return true;
  }
}
test("native close drains stderr once across concurrent/repeated calls and retains successful child exit", async () => {
  const fixture = lifecycleFixture();
  try {
    await fixture.port.call({ v: 1 }, "ready");
    const pid = fixture.pid();
    await Promise.all([fixture.port.close(true), fixture.port.close(), fixture.port.close(true)]);
    await fixture.port.close(true);
    assert(processGone(pid), "The actual fixture child must be reaped.");
  } finally {
    await fixture.port.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("every asserting close rejects the actual nonzero exit even after a nonasserting close", async () => {
  const fixture = lifecycleFixture(true);
  try {
    await fixture.port.call({ v: 1 }, "ready");
    const pid = fixture.pid();
    const deadline = Date.now() + 3000;
    while (!processGone(pid)) {
      assert(Date.now() < deadline, "The fixed nonzero fixture did not exit.");
      await Bun.sleep(10);
    }
    await fixture.port.close();
    for (let i = 0; i < 2; i++)
      await assert.rejects(fixture.port.close(true), (error: unknown) => error instanceof assert.AssertionError && error.actual === 7);
    assert(processGone(pid));
  } finally {
    await fixture.port.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("native cleanup settles a pending stdout reader and its actual owned process", async () => {
  const fixture = lifecycleFixture();
  try {
    await fixture.port.call({ v: 1 }, "ready");
    const pid = fixture.pid();
    const pending = assert.rejects(fixture.port.call({ v: 1 }, "pending"), /closed before its phase receipt/);
    await Bun.sleep(10);
    await fixture.port.close();
    await pending;
    await fixture.port.close();
    assert(processGone(pid), "Cleanup must settle the child before returning.");
  } finally {
    await fixture.port.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("cleanup reporting retains the primary error identity and every cleanup failure", () => {
  const primary = new Error("original operation failure");
  const native = new Error("native cleanup failure");
  const worker = new Error("workerd cleanup failure");
  const results: PromiseSettledResult<unknown>[] = [
    { status: "rejected", reason: native },
    { status: "fulfilled", value: undefined },
    { status: "rejected", reason: worker },
  ];
  assert.throws(
    () => {
      throwCleanupFailures(results, { error: primary });
    },
    (error: unknown) =>
      error instanceof AggregateError && error.cause === primary && error.errors[0] === primary && error.errors[1] === native && error.errors[2] === worker
  );
  assert.throws(
    () => {
      throwCleanupFailures(results.slice(0, 1));
    },
    (error: unknown) => error === native
  );
  assert.throws(
    () => {
      throwCleanupFailures(results);
    },
    (error: unknown) => error instanceof AggregateError && error.errors[0] === native && error.errors[1] === worker
  );
  assert.doesNotThrow(() => {
    throwCleanupFailures([{ status: "fulfilled", value: undefined }], { error: primary });
  });
});

test.if(process.platform === "darwin")(
  "single-profile composition retains the original network boundary/child and adds only a task write restriction",
  async () => {
    const { testNetworkArgv } = await import("../scripts/test-network.ts");
    const child = [process.execPath, "--no-env-file", "--no-install", "-e", "0"];
    const original = testNetworkArgv(child);
    const directory = "/private/tmp/ai-rust-wasm-20261018/state-controller-2101/unused-unit";
    const combined = stateFixtureArgv(child, directory);
    assert.deepEqual(combined.slice(0, 5), original.slice(0, 5));
    const before: unknown = JSON.parse(original[5]);
    const after: unknown = JSON.parse(combined[5]);
    assert(Array.isArray(before) && Array.isArray(after));
    assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
    assert.deepEqual(after.slice(3), before.slice(3));
    assert.equal(after[2], String(before[2]) + `\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(directory)}))`);
    assert.throws(() => stateFixtureArgv(child, "/tmp/foreign"));
  }
);

test.if(process.platform !== "darwin")("single-profile composition rejects unsupported fixture hosts", () => {
  const child = [process.execPath, "--no-env-file", "--no-install", "-e", "0"];
  const directory = "/private/tmp/ai-rust-wasm-20261018/state-controller-2101/unused-unit";
  assert.throws(() => stateFixtureArgv(child, directory), /This scoped controller requires its verified Mac fixture boundary\./);
});

test("private stream refuses a line beyond the original native32MiB wire bound", async () => {
  const bytes = new Uint8Array(PRIVATE_WIRE_MAX_BYTES + 1);
  await assert.rejects(async () => {
    for await (const line of privateLines(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      })
    ))
      assert(line);
  });
});

async function framed(bytes: Uint8Array, chunkSize: number): Promise<string[]> {
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, at + chunkSize);
      controller.enqueue(bytes.slice(at, end));
      at = end;
    },
  });
  const result: string[] = [];
  for await (const frame of privateLines(stream)) result.push(frame);
  return result;
}
test("actual multiline native-source capture is one lossless frame, including original structural LF", async () => {
  const source = readFileSync(new URL("../rust/crates/gateway-migration/tests/fixtures/native-source.json", import.meta.url), "utf8");
  const raw = `{"operation":"candidate","capture":${source}}`;
  const bytes = new TextEncoder().encode(raw + "\n");
  for (const size of [1, 7, bytes.length]) {
    const frames = await framed(bytes, size);
    assert.equal(frames.length, 1);
    assert(frames[0] === raw, "Every original multiline capture byte must survive framing.");
    const value: unknown = JSON.parse(frames[0]);
    assert(typeof value === "object" && value !== null);
  }
});
test("byte framing retains exact UTF16 escapes, numbers, quotes, backslashes and braces inside strings", async () => {
  const raw =
    String.raw` { "tokens": [1e3,-0,9007199254740993],
    "strings": ["\ud800", "\" \\ {} []", "escaped\nnot-a-frame"], "nested": {"α":[{},[]]} } ` + "\r";
  const bytes = new TextEncoder().encode(raw + "\n");
  for (const size of [1, 2, 3, bytes.length]) {
    const frames = await framed(bytes, size);
    assert(frames.length === 1 && frames[0] === raw, "Framer cannot normalize native source JSON.");
    JSON.parse(frames[0]);
  }
});
test("coalesced and byte-split multiline request/response frames retain original fixed ids and raw request token", async () => {
  const request = `{\n"operation":"store_request","id":7,"request":{"operation":"read",\n"key":"tuple-v1:00"}}`;
  const response = `{\n"operation":"read","record":null\n}`;
  const wire = new TextEncoder().encode(request + "\n" + response + "\n");
  for (const size of [1, 5, wire.length]) {
    const frames = await framed(wire, size);
    assert.deepEqual(frames, [request, response]);
    const message = decodeStoreMessage(frames[0], 6);
    assert.equal(message.id, 7);
    assert.equal(message.rawRequest, '{"operation":"read",\n"key":"tuple-v1:00"}');
    assert.equal(storeResponse(message, frames[1]), `{"operation":"store_response","id":7,"response":${response}}`);
    assert.throws(() => decodeStoreMessage(frames[0], 7));
  }
});
test("incomplete/mismatched/trailing roots and non-UTF8 framing are refused without yielding a false complete document", async () => {
  for (const raw of ["{", "{}", '{"x":"unfinished', '{"x":[}]}\n', "{}{}\n", "{}x\n", "\n", "[]\n"])
    await assert.rejects(framed(new TextEncoder().encode(raw), 1));
  await assert.rejects(framed(new Uint8Array([123, 34, 115, 34, 58, 34, 255, 34, 125, 10]), 1));
  for (const raw of ['{"x":}\n', '{"x":"\\q"}\n'])
    await assert.rejects(async () => {
      for (const frame of await framed(new TextEncoder().encode(raw), 2)) JSON.parse(frame);
    });
});
test("the32MiB bound is cumulative across structuralLF, not a fresh allowance per physical line", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  chunk[chunk.length - 1] = 10;
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted++ === 0) controller.enqueue(new TextEncoder().encode("{\n"));
      else if (emitted <= 33) controller.enqueue(chunk);
      else controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const frame of privateLines(stream)) assert(frame);
  }, /frame exceeded its bound/);
}, 10_000);
test("the original whole-frame limit includes and permits its final requiredLF at exactly32MiB", async () => {
  const bytes = new Uint8Array(PRIVATE_WIRE_MAX_BYTES).fill(32);
  bytes[bytes.length - 3] = 123;
  bytes[bytes.length - 2] = 125;
  bytes[bytes.length - 1] = 10;
  const frames = await framed(bytes, 1024 * 1024);
  assert.equal(frames.length, 1);
  assert.equal(new TextEncoder().encode(frames[0]).length, PRIVATE_WIRE_MAX_BYTES - 1);
  assert(frames[0].endsWith("{}"));
}, 10_000);

function diagnosticFixture(kind: "flood" | "signal" | "runtime-eof" | "unsafe") {
  const directory = mkdtempSync(join(tmpdir(), "uos-native-diagnostic-"));
  const binary = join(directory, "fixture");
  const scripts = {
    flood:
      "IFS= read -r line\nprintf '%s\\n' '{\"operation\":\"ready\"}'\nprintf 'native-begin\\n' >&2\nprintf '%200000s' P >&2\nprintf '%200000s' T >&2\nprintf 'native-end\\n' >&2\nexit 7\n",
    signal: "IFS= read -r line\nprintf '%s\\n' '{\"operation\":\"ready\"}'\nkill -TERM $$\n",
    "runtime-eof": "IFS= read -r line\nprintf '%s\\n' '{\"operation\":\"candidate\"}'\nIFS= read -r line\nprintf 'fixed native failure\\n' >&2\nexit 7\n",
    unsafe: "IFS= read -r line\nprintf '%s\\n' '{\"operation\":\"../../outside\"}'\nwhile IFS= read -r line; do :; done\nexit 0\n",
  };
  writeFileSync(binary, "#!/bin/sh\necho $$ > fixture.pid\n" + scripts[kind], { mode: 0o700 });
  const port = new NativePort(binary, directory);
  return { directory, port, pid: () => Number(readFileSync(join(directory, "fixture.pid"), "utf8").trim()) };
}
function diagnosticObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nativeDiagnostic(directory: string, phase: "unknown" | "exercise-runtime" = "unknown") {
  const path = join(directory, `native-${phase}.json`);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert(diagnosticObject(value) && diagnosticObject(value.stderr));
  const stderr = value.stderr;
  assert(typeof stderr.prefix_base64 === "string" && typeof stderr.tail_base64 === "string");
  assert(stderr.scope === "process_lifetime" && value.phase_causality === "not_established");
  assert(value.purpose === "private_native_process_failure_evidence_only");
  return { path, value, stderr, prefix: Buffer.from(stderr.prefix_base64, "base64"), tail: Buffer.from(stderr.tail_base64, "base64") };
}
test("private native diagnostics capture zero exit once across repeated closes without claiming effects", async () => {
  const fixture = lifecycleFixture();
  try {
    await fixture.port.call({ v: 1 }, "ready");
    assert(!processGone(fixture.pid()));
    await Promise.all([fixture.port.close(true), fixture.port.close(), fixture.port.close(true)]);
    const evidence = nativeDiagnostic(fixture.directory);
    assert(evidence.value.exit_code === 0 && evidence.value.signal_code === null && evidence.value.observed_exit_before_cleanup === false);
    assert(evidence.stderr.complete === true && evidence.stderr.total_bytes === 131072 && evidence.stderr.retained_bytes === 65536);
    const before = readFileSync(evidence.path);
    await fixture.port.close(true);
    assert(readFileSync(evidence.path).equals(before), "Repeated cleanup must not change captured evidence.");
    assert(readdirSync(fixture.directory).filter((name) => name.startsWith("native-")).length === 1);
    assert((statSync(evidence.path).mode & 0o777) === 0o600);
    assert(processGone(fixture.pid()));
  } finally {
    await Promise.allSettled([fixture.port.close()]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("private native diagnostics retain exact bounded prefix/tail while draining a larger failing-child stderr", async () => {
  const fixture = diagnosticFixture("flood");
  try {
    await fixture.port.call({ v: 1 }, "ready");
    await assert.rejects(fixture.port.close(true), (error: unknown) => error instanceof assert.AssertionError && error.actual === 7);
    const evidence = nativeDiagnostic(fixture.directory);
    const expected = Buffer.from("native-begin\n" + " ".repeat(199999) + "P" + " ".repeat(199999) + "Tnative-end\n");
    assert(evidence.value.exit_code === 7 && evidence.value.signal_code === null);
    assert(evidence.stderr.complete === true && evidence.stderr.truncated === true);
    assert(evidence.stderr.total_bytes === expected.length && evidence.stderr.retained_bytes === 65536);
    assert(evidence.prefix.length === 32768 && evidence.prefix.equals(expected.subarray(0, 32768)), "Retained prefix bytes differ.");
    assert(evidence.tail.length === 32768 && evidence.tail.equals(expected.subarray(-32768)), "Retained tail bytes differ.");
    assert(processGone(fixture.pid()), "Truncation must not stop the drain or child settlement.");
  } finally {
    await Promise.allSettled([fixture.port.close()]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("private native diagnostics record the actual signal of a signalled child", async () => {
  const fixture = diagnosticFixture("signal");
  try {
    await fixture.port.call({ v: 1 }, "ready");
    await assert.rejects(fixture.port.close(true));
    const evidence = nativeDiagnostic(fixture.directory);
    assert(evidence.value.signal_code === "SIGTERM" && evidence.value.exit_code === 143);
    assert(evidence.stderr.complete === true && evidence.stderr.total_bytes === 0 && evidence.stderr.retained_bytes === 0);
    assert(processGone(fixture.pid()));
  } finally {
    await Promise.allSettled([fixture.port.close()]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("private native evidence labels the last fixed phase without attributing lifetime stderr to its cause", async () => {
  const fixture = diagnosticFixture("runtime-eof");
  try {
    await fixture.port.call({ v: 1 }, "candidate");
    await assert.rejects(fixture.port.call({ v: 1, operation: "exercise_runtime" }, "runtime_exercised"), /closed before its phase receipt/);
    await fixture.port.close();
    const evidence = nativeDiagnostic(fixture.directory, "exercise-runtime");
    assert(evidence.value.last_phase_at_cleanup === "exercise-runtime" && evidence.value.exit_code === 7);
    assert(evidence.stderr.complete === true && evidence.stderr.truncated === false);
    assert(Buffer.concat([evidence.prefix, evidence.tail]).equals(Buffer.from("fixed native failure\n")), "Exact retained stderr bytes differ.");
    assert(processGone(fixture.pid()));
  } finally {
    await Promise.allSettled([fixture.port.close()]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("unknown native phase values use a fixed private filename under the existing task workspace", async () => {
  const fixture = diagnosticFixture("unsafe");
  try {
    await fixture.port.call({ v: 1 }, "../../outside");
    await fixture.port.close(true);
    const evidence = nativeDiagnostic(fixture.directory);
    assert(evidence.value.last_phase_at_cleanup === "unknown");
    assert(
      readdirSync(fixture.directory)
        .filter((name) => name.startsWith("native-"))
        .join() === "native-unknown.json"
    );
    assert((statSync(evidence.path).mode & 0o777) === 0o600);
    assert(processGone(fixture.pid()));
  } finally {
    await Promise.allSettled([fixture.port.close()]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("private native capture collision preserves existing bytes while settling the actual child", async () => {
  const fixture = lifecycleFixture();
  const path = join(fixture.directory, "native-unknown.json");
  const before = Buffer.from("existing private diagnostic evidence\n");
  writeFileSync(path, before, { mode: 0o600, flag: "wx" });
  try {
    await fixture.port.call({ v: 1 }, "ready");
    await assert.rejects(fixture.port.close(true), (error: unknown) => diagnosticObject(error) && error.code === "EEXIST");
    assert(readFileSync(path).equals(before), "Existing diagnostic evidence must not be overwritten.");
    assert(processGone(fixture.pid()), "Capture failure must not prevent process settlement.");
  } finally {
    await Promise.allSettled([fixture.port.close()]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
test("a real native phase error stays first and causal when private capture also fails", async () => {
  const fixture = diagnosticFixture("runtime-eof");
  const path = join(fixture.directory, "native-exercise-runtime.json");
  const before = Buffer.from("existing private diagnostic evidence\n");
  writeFileSync(path, before, { mode: 0o600, flag: "wx" });
  try {
    await fixture.port.call({ v: 1 }, "candidate");
    let primary: unknown;
    try {
      await fixture.port.call({ v: 1, operation: "exercise_runtime" }, "runtime_exercised");
      assert.fail("The fixed native failure must not return a phase receipt.");
    } catch (error) {
      primary = error;
    }
    assert(primary instanceof assert.AssertionError && primary.message.includes("closed before its phase receipt"));
    const cleanup = await Promise.allSettled([fixture.port.close()]);
    assert.throws(
      () => {
        throwCleanupFailures(cleanup, { error: primary });
      },
      (error: unknown) =>
        error instanceof AggregateError &&
        error.cause === primary &&
        error.errors[0] === primary &&
        diagnosticObject(error.errors[1]) &&
        error.errors[1].code === "EEXIST"
    );
    assert(readFileSync(path).equals(before));
    assert(processGone(fixture.pid()));
  } finally {
    await Promise.allSettled([fixture.port.close()]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("fixture time derives one immutable five-minute budget and ordered phase times", () => {
  const origin = 1_800_000_000_000;
  const time = fixtureTime(origin);
  assert.deepEqual(time, { origin, deadline: origin + 300_000, runtime: origin + 100, inverse: origin + 200 });
  assert(Object.isFrozen(time));
  assert.throws(() => fixtureTime(1199));
  assert.throws(() => fixtureTime(Number.MAX_SAFE_INTEGER));
});
test("fixture budget refuses expiry or clock reversal without refreshing its origin", () => {
  const time = fixtureTime(1_800_000_000_000);
  assertFixtureBudget(time, time.origin);
  assertFixtureBudget(time, time.deadline - 1);
  assert.throws(() => {
    assertFixtureBudget(time, time.deadline);
  }, /fixture_time_budget_expired/);
  assert.throws(() => {
    assertFixtureBudget(time, time.origin - 1);
  }, /fixture_time_budget_expired/);
  assert.equal(time.deadline - time.origin, 300_000);
});

test("only the finite staged-history fixture receives the assigned six-minute outer envelope", () => {
  const normal = manifest(prepared(), sha);
  assert.equal(fixtureEnvelope(normal.fixture_scenario), 120_000);
  const staged = manifest({ ...prepared(), fixture_scenario: "history-staged-v1" }, sha);
  assert.equal(fixtureEnvelope(staged.fixture_scenario), 360_000);
  for (const fixtureScenario of [null, "arbitrary", 360_001]) {
    assert.throws(() => manifest({ ...prepared(), fixture_scenario: fixtureScenario }, sha));
    assert.throws(() => fixtureEnvelope(fixtureScenario));
  }
});
