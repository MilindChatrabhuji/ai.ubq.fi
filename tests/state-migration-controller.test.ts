import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  PRIVATE_WIRE_MAX_BYTES,
  compareLatest,
  decodeStoreMessage,
  manifest,
  privateLines,
  rawMember,
  settle,
  storeResponse,
  stateFixtureArgv,
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

test("single-profile composition retains the original network boundary/child and adds only a task write restriction", async () => {
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
