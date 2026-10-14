import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { verifyNativeKvArtifact } from "../src/storage/native-addon.ts";
import { assertPortableKvKeyBytes, BUN_KV_CODEC, KvU64, openKv, type Kv, type KvListOptions, type KvListSelector } from "#kv";
import { getKv, initializeKv, setKvForTest } from "../src/kv.ts";
import { guardNativeKv } from "../src/storage/native-kv.ts";

const fixtureRoot = resolve(".cleanup-evidence/m01-storage");
mkdirSync(fixtureRoot, { recursive: true });
const directories: string[] = [];
const handles: Kv[] = [];

const temporaryPath = (): string => {
  const directory = mkdtempSync(`${fixtureRoot}/native-`);
  directories.push(directory);
  return `${directory}/kv.sqlite3`;
};

const openFixture = async (path = ":memory:"): Promise<Kv> => {
  const kv = await openKv(path);
  handles.push(kv);
  return kv;
};

afterEach(() => {
  setKvForTest(null);
  for (const handle of handles.splice(0)) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("storage checks execute without provider credentials", () => {
  const names = ["CODEX_AUTH_JSON_B64", "DENO_DEPLOY_TOKEN", "UOS_AI_TOKEN", "SURPLUS_API_KEY", "METERED_API_KEY", "OPENROUTER_API_KEY"];
  expect(names.every((name) => !process.env[name])).toBe(true);
});

test("native artifact verification requires independent provenance and matching frozen inputs", () => {
  const path = temporaryPath();
  const directory = `${path}.artifact`;
  mkdirSync(directory);
  const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
  const bytes = new Uint8Array([1, 2, 3]);
  const inputs = {
    schema: 1,
    sdk: { name: "@deno/kv", version: "0.14.0" },
    source: { commit: "9fe65cc138ff56ca5bfe7a1bf8c53e832246f9d5" },
    patches: [{ file: "fixture.patch", sha256: "a".repeat(64) }],
    lock: { sha256: "b".repeat(64) },
    toolchain: { version: "fixture" },
    recipe: { locked: true },
    artifact: { file: "native-kv.node", platform: process.platform, architecture: process.arch, target: "fixture-target", napiVersion: 4 },
  };
  const inputsText = JSON.stringify(inputs);
  const provenance = {
    ...inputs,
    inputsSha256: hash(inputsText),
    artifact: { ...inputs.artifact, sha256: hash(bytes) },
    build: { exitCode: 0, logSha256: "c".repeat(64) },
  };
  const provenanceText = JSON.stringify(provenance);
  writeFileSync(`${directory}/inputs.json`, inputsText);
  writeFileSync(`${directory}/native-kv.provenance.json`, provenanceText);
  writeFileSync(`${directory}/native-kv.node`, bytes);
  const binding = { artifactDirectory: directory, expectedProvenanceSha256: hash(provenanceText), inputsManifest: `${directory}/inputs.json` };
  expect(verifyNativeKvArtifact(binding).artifactSha256).toBe(hash(bytes));
  expect(() => verifyNativeKvArtifact({ ...binding, expectedProvenanceSha256: "0".repeat(64) })).toThrow("release binding");
  writeFileSync(`${directory}/native-kv.node`, new Uint8Array([4]));
  expect(() => verifyNativeKvArtifact(binding)).toThrow("artifact hash");
  writeFileSync(`${directory}/native-kv.node`, bytes);
  const failedBuild = JSON.stringify({ ...provenance, build: { ...provenance.build, exitCode: 1 } });
  writeFileSync(`${directory}/native-kv.provenance.json`, failedBuild);
  expect(() => verifyNativeKvArtifact({ ...binding, expectedProvenanceSha256: hash(failedBuild) })).toThrow("build did not complete");
  writeFileSync(`${directory}/native-kv.provenance.json`, provenanceText);
  writeFileSync(`${directory}/inputs.json`, JSON.stringify({ ...inputs, recipe: { locked: false } }));
  expect(() => verifyNativeKvArtifact(binding)).toThrow("frozen inputs");
});

test("native Bun SQLite retains typed values and KvU64 identity", async () => {
  const kv = await openFixture();
  const value = { bytes: new Uint8Array([0, 128, 255]), amount: 2n ** 80n, empty: undefined, nested: [null, true, "λ"] };
  const committed = await kv.set(["typed"], value);
  expect(committed.ok).toBe(true);
  expect((await kv.get(["typed"])).value).toEqual(value);
  await kv.set(["counter"], new KvU64(12n));
  const counter = (await kv.get<KvU64>(["counter"])).value;
  expect(counter).toBeInstanceOf(KvU64);
  expect(counter?.value).toBe(12n);
  await kv.set(["undefined"], undefined);
  expect((await kv.get(["undefined"])).value).toBeUndefined();
  expect((await kv.get(["undefined"])).versionstamp).not.toBeNull();
});

test("atomic compare-and-set refuses stale checks without partial writes", async () => {
  const kv = await openFixture();
  const absent = await kv.get(["quota"]);
  const committed = await kv.atomic().check(absent).set(["quota"], { reserved: 1 }).set(["audit"], "created").commit();
  expect(committed.ok).toBe(true);
  const [quota, audit] = await kv.getMany<[{ reserved: number }, string]>([["quota"], ["audit"]]);
  expect(quota.versionstamp).toBe(audit.versionstamp);
  expect(await kv.atomic().check(absent).set(["quota"], { reserved: 2 }).set(["partial"], true).commit()).toEqual({ ok: false });
  expect((await kv.get(["partial"])).versionstamp).toBeNull();
  expect(quota.value).toEqual({ reserved: 1 });
});

test("native facade permits captured list and atomic instance overrides without recursion", async () => {
  const kv = await openFixture();
  await kv.set(["facade"], "root");
  await kv.set(["facade", 1], "child");
  const originalList = kv.list;
  const originalAtomic = kv.atomic;
  let lists = 0;
  let atomics = 0;
  const listOverride: Kv["list"] = <T>(selector: KvListSelector, options?: KvListOptions) => {
    lists += 1;
    return originalList<T>(selector, options);
  };
  const atomicOverride: Kv["atomic"] = () => {
    atomics += 1;
    return originalAtomic();
  };
  kv.list = listOverride;
  kv.atomic = atomicOverride;
  expect(kv.list).toBe(listOverride);
  expect(kv.atomic).toBe(atomicOverride);
  expect((await Array.fromAsync(kv.list({ prefix: ["facade"] }, { limit: 1 }))).map((row) => row.value)).toEqual(["child"]);
  expect(lists).toBe(1);
  const absent = await kv.get(["facade-claim"]);
  expect((await kv.atomic().check(absent).set(["facade-claim"], "owned").commit()).ok).toBe(true);
  expect(await kv.atomic().check(absent).set(["facade-stale"], true).commit()).toEqual({ ok: false });
  expect((await kv.get(["facade-stale"])).versionstamp).toBeNull();
  await kv.set(["facade-wrong-sum"], 3n);
  await expect(kv.atomic().set(["facade-partial"], true).sum(["facade-wrong-sum"], 1n).commit()).rejects.toThrow("KvU64");
  expect((await kv.get(["facade-partial"])).versionstamp).toBeNull();
  const error = new Error("fixture", { cause: "unsupported" });
  await expect(kv.atomic().set(["facade-value-partial"], true).set(["facade-value"], error).commit()).rejects.toThrow("Error.cause");
  expect((await kv.get(["facade-value-partial"])).versionstamp).toBeNull();
  expect(atomics).toBe(4);
});

test("native TTL retains its absolute deadline and expires across restart", async () => {
  const path = temporaryPath();
  const kv = await openKv(path);
  const before = Date.now();
  await kv.set(["expiring"], "challenge", { expireIn: 20 });
  const after = Date.now();
  await kv.set(["durable"], "ledger");
  const raw = new Database(path, { readonly: true });
  const expiry = raw.query<{ expiration_ms: number }, []>("SELECT expiration_ms FROM kv WHERE expiration_ms >= 0").get()?.expiration_ms;
  raw.close(true);
  expect(expiry).toBeGreaterThanOrEqual(before + 20);
  expect(expiry).toBeLessThanOrEqual(after + 20);
  // Native TTL permits delayed visibility; startup sweeps expired rows directly.
  kv.close();
  await Bun.sleep(Math.max(0, after + 25 - Date.now()));
  const reopened = await openFixture(path);
  expect((await reopened.get(["expiring"])).versionstamp).toBeNull();
  expect((await reopened.get(["durable"])).value).toBe("ledger");
});

test("a persisted Bun database reopens with its codec marker and typed values", async () => {
  const path = temporaryPath();
  const first = await openKv(path);
  await first.set(["persisted"], { amount: 9n, bytes: new Uint8Array([7]) });
  const before = await first.get(["persisted"]);
  first.close();
  const marker = new Database(path, { readonly: true });
  expect(marker.query<{ value: string }, []>("SELECT value FROM uos_kv_metadata WHERE key = 'codec'").get()?.value).toBe(BUN_KV_CODEC);
  marker.close(true);
  const second = await openFixture(path);
  expect(await second.get(["persisted"])).toEqual(before);
});

test("an unmarked legacy SQLite file is rejected without changing its bytes", async () => {
  const path = temporaryPath();
  const legacy = new Database(path, { create: true });
  legacy.run("CREATE TABLE kv (k BLOB PRIMARY KEY, v BLOB NOT NULL)");
  legacy.run("INSERT INTO kv VALUES (?, ?)", [new Uint8Array([1]), new Uint8Array([255, 15])]);
  legacy.close(true);
  const before = readFileSync(path);
  await expect(openKv(path)).rejects.toThrow("convert the legacy database offline");
  expect(readFileSync(path)).toEqual(before);
});

test("the injection seam disables disk fallback and accepts initialization", async () => {
  setKvForTest(null);
  expect(await getKv()).toBeNull();
  const kv = await openFixture();
  initializeKv(kv);
  expect(await getKv()).toBe(kv);
  expect(() => initializeKv(kv)).toThrow("already been initialized");
});

test("native list preserves heterogeneous key order and resumable ranges", async () => {
  const kv = await openFixture();
  const parts = [new Uint8Array([0]), new Uint8Array([2]), new Uint8Array([10]), "a", "é", -2n, 0n, 2n, -2, 0, 2, false, true];
  for (let index = 0; index < parts.length; index += 1) await kv.set(["ordered", parts[index]], index);
  const entries = await Array.fromAsync(kv.list<number>({ prefix: ["ordered"] }));
  expect(entries.map((entry) => entry.value)).toEqual(parts.map((_, index) => index));
  const first = kv.list<number>({ prefix: ["ordered"] }, { limit: 3, batchSize: 2 });
  expect((await Array.fromAsync(first)).map((entry) => entry.value)).toEqual([0, 1, 2]);
  const resumed = await Array.fromAsync(kv.list<number>({ prefix: ["ordered"] }, { cursor: first.cursor }));
  expect(resumed.map((entry) => entry.value)).toEqual(parts.map((_, index) => index).slice(3));
  const range = await Array.fromAsync(kv.list<number>({ start: ["ordered", -2], end: ["ordered", 2] }));
  expect(range.map((entry) => entry.value)).toEqual([8, 9]);
  const reverse = await Array.fromAsync(kv.list<number>({ prefix: ["ordered"] }, { reverse: true, limit: 2 }));
  expect(reverse.map((entry) => entry.value)).toEqual([12, 11]);
});

test("prefix selectors exclude the exact prefix and native cursors retain cross-range behavior", async () => {
  const kv = await openFixture();
  await kv.set(["prefix"], "root");
  await kv.set(["prefix", 1], "child");
  await kv.set(["prefix", 2], "next");
  const first = kv.list({ prefix: ["prefix"] }, { limit: 1 });
  expect((await Array.fromAsync(first)).map((entry) => entry.value)).toEqual(["child"]);
  expect(await Array.fromAsync(kv.list({ prefix: ["other"] }, { cursor: first.cursor }))).toEqual([]);
  expect(() => kv.list({ prefix: ["prefix"], end: ["outside", 1] })).toThrow("keyspace");
  expect((await Array.fromAsync(kv.list({ prefix: ["prefix"], end: ["prefix", 2] }))).map((row) => row.value)).toEqual(["child"]);
});

test("native cursor lifecycle clears empty and exhausted scans but preserves limited continuations", async () => {
  const kv = await openFixture();
  const empty = kv.list({ prefix: ["empty-cursor"] });
  expect(() => empty.cursor).toThrow("before first iteration");
  expect(await Array.fromAsync(empty)).toEqual([]);
  expect(empty.cursor).toBe("");
  await kv.set(["cursor", 1], "first");
  const single = kv.list({ prefix: ["cursor"] });
  expect((await Array.fromAsync(single)).map((row) => row.value)).toEqual(["first"]);
  expect(single.cursor).toBe("");
  await kv.set(["cursor", 2], "second");
  const limited = kv.list({ prefix: ["cursor"] }, { limit: 1 });
  expect((await Array.fromAsync(limited)).map((row) => row.value)).toEqual(["first"]);
  const continuation = limited.cursor;
  expect(continuation).not.toBe("");
  const resumed = kv.list({ prefix: ["cursor"] }, { cursor: continuation });
  expect(resumed.cursor).toBe(continuation);
  expect((await Array.fromAsync(resumed)).map((row) => row.value)).toEqual(["second"]);
  expect(resumed.cursor).toBe("");
});

test("unsigned sums wrap, retain real U64 values, and roll back wrong-type mutations", async () => {
  const kv = await openFixture();
  await kv.set(["sum"], new KvU64(2n ** 64n - 1n));
  expect((await kv.atomic().sum(["sum"], 1n).commit()).ok).toBe(true);
  expect((await kv.get<KvU64>(["sum"])).value?.value).toBe(0n);
  await kv.atomic().sum(["missing-sum"], 5n).commit();
  expect((await kv.get<KvU64>(["missing-sum"])).value).toBeInstanceOf(KvU64);
  await kv.set(["wrong-type"], 5n);
  await expect(kv.atomic().set(["must-roll-back"], "partial").sum(["wrong-type"], 1n).commit()).rejects.toThrow();
  expect((await kv.get(["must-roll-back"])).versionstamp).toBeNull();
  expect((await kv.get(["wrong-type"])).value).toBe(5n);
});

test("snapshot reads preserve absent values and clone caller-owned buffers", async () => {
  const kv = await openFixture();
  const bytes = new Uint8Array([1, 2, 3]);
  await kv.set(["bytes"], bytes);
  bytes[0] = 99;
  const [found, missing] = await kv.getMany<[Uint8Array, string]>([["bytes"], ["missing"]]);
  expect(found.value).toEqual(new Uint8Array([1, 2, 3]));
  expect(missing).toEqual({ key: ["missing"], value: null, versionstamp: null });
  if (found.value) found.value[1] = 99;
  expect((await kv.get(["bytes"])).value).toEqual(new Uint8Array([1, 2, 3]));
});

test("arithmetic guard retries its own fence while a caller CAS failure remains final", async () => {
  const kv = await openFixture();
  await kv.set(["guard-counter"], new KvU64(0n));
  let mutateOnRead = true;
  const injected = new Proxy(kv, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<Kv["get"]>) => {
          const row = await target.get(...args);
          if (mutateOnRead && args[0][0] === "guard-counter") {
            mutateOnRead = false;
            await target.atomic().sum(["guard-counter"], 1n).commit();
          }
          return row;
        };
      const member: unknown = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const guarded = guardNativeKv(injected);
  expect((await guarded.atomic().sum(["guard-counter"], 1n).commit()).ok).toBe(true);
  expect((await kv.get<KvU64>(["guard-counter"])).value?.value).toBe(2n);
  const stale = await kv.get(["caller-fence"]);
  await kv.set(["caller-fence"], true);
  expect(await guarded.atomic().check(stale).sum(["guard-counter"], 1n).commit()).toEqual({ ok: false });
  expect((await kv.get<KvU64>(["guard-counter"])).value?.value).toBe(2n);
});

test("numeric key order distinguishes signed zeros and retains infinity and canonical NaN", async () => {
  const kv = await openFixture();
  const numbers = [-Infinity, -2, -0, 0, 2, Infinity, NaN];
  for (let index = 0; index < numbers.length; index += 1) await kv.set(["numeric", numbers[index]], index);
  const rows = await Array.fromAsync(kv.list<number>({ prefix: ["numeric"] }));
  expect(rows.map((row) => row.value)).toEqual(numbers.map((_, index) => index));
  expect(Object.is(rows[2].key[1], -0)).toBe(true);
  expect(Object.is(rows[3].key[1], 0)).toBe(true);
});

test("legacy raw-key validation rejects negative NaN without confusing byte payloads", () => {
  const raw = (hex: string): Uint8Array => Buffer.from(hex, "hex");
  expect(() => assertPortableKvKeyBytes(raw("026e616e00210007ffffffffffff"))).toThrow("Negative NaN");
  for (const hex of ["026e616e0021fff8000000000000", "217fffffffffffffff", "218000000000000000", "21000fffffffffffff", "21fff0000000000000"]) {
    expect(() => assertPortableKvKeyBytes(raw(hex))).not.toThrow();
  }
  // The float-like bytes occur inside an escaped byte-string part, not a number.
  expect(() => assertPortableKvKeyBytes(new Uint8Array([1, 0x21, 0, 0xff, 7, 255, 255, 255, 255, 255, 255, 0]))).not.toThrow();
  expect(() => assertPortableKvKeyBytes(raw("21"))).toThrow("Truncated");
  expect(() => assertPortableKvKeyBytes(raw("01ff"))).toThrow("Truncated");
  expect(() => assertPortableKvKeyBytes(raw("1d0201"))).toThrow("Truncated");
});

test("Error cause graphs fail before any atomic mutation can lose persisted fields", async () => {
  const kv = await openFixture();
  const error = new Error("outer", { cause: new Error("inner") });
  const graph = { records: new Map<unknown, unknown>([["failure", error]]) };
  await expect(kv.atomic().set(["cause-partial"], "must not publish").set(["cause"], graph).commit()).rejects.toThrow("Error.cause");
  expect((await kv.get(["cause-partial"])).versionstamp).toBeNull();
  expect((await kv.get(["cause"])).versionstamp).toBeNull();
});

test("portable graph validation handles cycles and refuses getters without invoking them", async () => {
  const kv = await openFixture();
  const graph: { self?: unknown; values: Set<unknown> } = { values: new Set() };
  graph.self = graph;
  graph.values.add(graph);
  await kv.set(["cycle"], graph);
  const stored = (await kv.get<typeof graph>(["cycle"])).value;
  expect(stored?.self).toBe(stored);
  expect(stored?.values.has(stored)).toBe(true);
  let getterCalls = 0;
  const accessor = {
    get secret() {
      getterCalls += 1;
      return new Error("outer", { cause: "inner" });
    },
  };
  await expect(kv.set(["accessor"], accessor)).rejects.toThrow("materialized");
  expect(getterCalls).toBe(0);
  expect((await kv.get(["accessor"])).versionstamp).toBeNull();
});

test("two native handles share CAS fencing and monotonic persisted revisions", async () => {
  const path = temporaryPath();
  const first = await openFixture(path);
  const second = await openFixture(path);
  const absent = await first.get(["claim"]);
  const results = await Promise.all([
    first.atomic().check(absent).set(["claim"], "first").commit(),
    second.atomic().check(absent).set(["claim"], "second").commit(),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  const before = await first.get(["claim"]);
  await second.delete(["claim"]);
  await second.set(["claim"], "replacement");
  const after = await first.get(["claim"]);
  expect(after.versionstamp).not.toBe(before.versionstamp);
  expect((after.versionstamp ?? "") > (before.versionstamp ?? "")).toBe(true);
  expect(await first.atomic().check(before).set(["stale-owner"], true).commit()).toEqual({ ok: false });
});

test("codec mismatch and symlink paths reject before native opening", async () => {
  const path = temporaryPath();
  const first = await openKv(path);
  first.close();
  const marker = new Database(path);
  marker.run("UPDATE uos_kv_metadata SET value = 'v8-legacy' WHERE key = 'codec'");
  marker.close(true);
  const before = readFileSync(path);
  await expect(openKv(path)).rejects.toThrow("codec is missing or incompatible");
  expect(readFileSync(path)).toEqual(before);
  const alias = `${path}.alias`;
  symlinkSync(path, alias);
  await expect(openKv(alias)).rejects.toThrow("regular file");
});

test("concurrent opener calls coalesce and scoped failures retry after backoff", async () => {
  const kv = await openFixture();
  let attempts = 0;
  setKvForTest(null, async () => {
    attempts += 1;
    await Bun.sleep(5);
    return kv;
  });
  expect((await Promise.all([getKv(), getKv(), getKv()])).every((result) => result === kv)).toBe(true);
  expect(attempts).toBe(1);
  const originalError = console.error;
  console.error = () => {};
  try {
    attempts = 0;
    setKvForTest(null, () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("fixture unavailable")) : Promise.resolve(kv);
    });
    expect(await getKv()).toBeNull();
    expect(await getKv()).toBeNull();
    expect(attempts).toBe(1);
    await Bun.sleep(320);
    expect(await getKv()).toBe(kv);
    expect(attempts).toBe(2);
  } finally {
    console.error = originalError;
  }
});

test("separate Bun processes preserve each quota increment under contention", async () => {
  const path = temporaryPath();
  const kv = await openFixture(path);
  await kv.set(["count"], 0);
  const worker = `${path}.worker.ts`;
  const storageUrl = new URL("../src/storage/kv.ts", import.meta.url).href;
  writeFileSync(
    worker,
    `import { openKv } from ${JSON.stringify(storageUrl)};
const kv = await openKv(process.argv[2]);
try {
  for (let n = 0; n < 20; n += 1) {
    let committed = false;
    for (let retry = 0; retry < 200; retry += 1) {
      const entry = await kv.get<number>(["count"]);
      if ((await kv.atomic().check(entry).set(["count"], (entry.value ?? 0) + 1).commit()).ok) {
        committed = true;
        break;
      }
    }
    if (!committed) throw new Error("quota contention did not settle");
  }
} finally { kv.close(); }
`
  );
  const children = [0, 1].map(() => Bun.spawn([process.execPath, "--no-env-file", worker, path], { stdout: "pipe", stderr: "pipe" }));
  try {
    const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ]);
    expect((await kv.get<number>(["count"])).value).toBe(40);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}, 10_000);

test("an acknowledged transaction survives abrupt writer process termination", async () => {
  const path = temporaryPath();
  const initialized = await openKv(path);
  initialized.close();
  const worker = `${path}.crash-worker.ts`;
  const storageUrl = new URL("../src/storage/kv.ts", import.meta.url).href;
  writeFileSync(
    worker,
    `import { openKv } from ${JSON.stringify(storageUrl)};
const kv = await openKv(process.argv[2]);
await kv.atomic().set(["reservation"], { request: "fixture", amount: 3n }).set(["billing"], { pending: true }).commit();
console.log("committed");
await Bun.sleep(60_000);
`
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", worker, path], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("committed");
    await reader.cancel();
    child.kill("SIGKILL");
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const recovered = await openFixture(path);
    const [reservation, billing] = await recovered.getMany<[{ request: string; amount: bigint }, { pending: boolean }]>([["reservation"], ["billing"]]);
    expect(reservation.value).toEqual({ request: "fixture", amount: 3n });
    expect(billing.value).toEqual({ pending: true });
    expect(reservation.versionstamp).toBe(billing.versionstamp);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10_000);
