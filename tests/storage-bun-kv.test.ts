import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { BUN_KV_CODEC, KvU64, openKv, type Kv } from "#kv";
import { getKv, initializeKv, setKvForTest } from "../src/kv.ts";

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
