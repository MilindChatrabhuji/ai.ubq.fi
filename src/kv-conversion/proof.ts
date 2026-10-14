/** Explicit offline acceptance tool. Ordinary Bun tests/CI never invoke or require Deno. */
import { Database } from "bun:sqlite";
import { KvU64, openKv } from "#kv";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { convertKvDatabase } from "./convert.ts";
import { fileDigest } from "./legacy-codec.ts";
import { encodeTypedValue } from "./typed-value.ts";

const run = async (args: string[], directory: string): Promise<string> => {
  const child = Bun.spawn(args, { cwd: directory, env: {}, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(exit, 0, stderr);
  return stdout;
};
const rawState = (path: string) => {
  const db = new Database(path, { readonly: true, safeIntegers: true });
  try {
    return db
      .query<{ k: Uint8Array; v_encoding: bigint; version: bigint; seq: bigint; expiration_ms: bigint }, []>(
        "SELECT k,v_encoding,version,seq,expiration_ms FROM kv ORDER BY k"
      )
      .all()
      .map((row) => ({ ...row, k: Buffer.from(row.k).toString("hex") }));
  } finally {
    db.close(true);
  }
};

export const proveLegacyRoundtrip = async (directory: string, deno: string, denoSha256: string) => {
  const expectedPin = Buffer.from(denoSha256, "hex");
  assert.equal(expectedPin.length, 32, "The explicit legacy codec pin must be SHA-256");
  const root = resolve(directory);
  if (existsSync(root)) throw new Error("Proof directory must be NEW and disposable");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const legacy = join(root, "legacy.sqlite3");
  const candidate = join(root, "candidate.sqlite3");
  const rollback = join(root, "rollback.sqlite3");
  const fixture = join(root, "fixture.mjs");
  const sourceText = `const kv = await Deno.openKv(${JSON.stringify(legacy)});
const shared = new Uint8Array([0,1,2,255]).buffer;
const cyclic = { missing: undefined, big: -(2n ** 120n), bytes: new Uint8Array(shared,1,2), view: new DataView(shared,2,1), shared, when: new Date(1700000000000), map: new Map([[2n,new Set([undefined,7n])]]), regexp: /a\\/b/giu, error: new TypeError('synthetic') }; cyclic.self=cyclic;
await kv.set(['typed',new Uint8Array([0,255]),-2n,-0,false],cyclic,{expireIn:3600000});
await kv.set(['typed',new Uint8Array([0,255]),-2n,0,false],{separate_zero:true});
await kv.set(['counter'],new Deno.KvU64(42n));
await kv.set(['raw'],new Uint8Array([8,0,255]));
const prefix=['uos_ai','sentinel_replay','v1','accounting'];
for(let i=1;i<=3;i++) await kv.set([...prefix,i,'capture-'+i],{state:'reserved',bytes:i});
const iterator=kv.list({prefix},{limit:1}); await iterator.next();
await kv.set(['uos_ai','sentinel_replay','v1','reap_cursor'],iterator.cursor);
await kv.set(['uos_ai','sentinel_replay','v1','budget'],{bootstrap_cursor:'0|'+iterator.cursor,stored_bytes:123,records:7});
await kv.set(['uos_ai','paid_fallback','v3','rollup_backfill_cursor'],{request_key:['paid',9n,new Uint8Array([4])]});
kv.close();
const unsupported = await Deno.openKv(${JSON.stringify(join(root, "unsupported.sqlite3"))}); await unsupported.set(['synthetic-error'],new Error('unsupported',{cause:7n})); unsupported.close();
const negative = await Deno.openKv(${JSON.stringify(join(root, "negative-nan.sqlite3"))}); const bits=new DataView(new ArrayBuffer(8)); bits.setBigUint64(0,0xfff8000000000000n,false); await negative.set(['nan',bits.getFloat64(0,false)],'blocked'); negative.close();`;
  writeFileSync(fixture, sourceText, { mode: 0o600 });
  const permissions = [`--allow-read=${root}`, `--allow-write=${root}`];
  await run([deno, "run", "--no-config", "--no-lock", "--no-prompt", "--unstable-kv", ...permissions, fixture], root);
  const originalHash = await fileDigest(legacy);
  const originalRows = rawState(legacy);
  const base = { deno, denoSha256: expectedPin.toString("hex") };
  const forward = await convertKvDatabase({ ...base, direction: "deno-to-bun", source: legacy, destination: candidate, receipt: join(root, "forward.json") });
  assert.equal(await fileDigest(legacy), originalHash);
  assert.deepEqual(rawState(candidate), originalRows);
  assert.equal(forward.transcoded_cursors, 2);
  const kv = await openKv(candidate);
  let latestTyped: unknown;
  let latestVersion: string;
  try {
    const entry = await kv.get<Record<string, unknown>>(["typed", new Uint8Array([0, 255]), -2n, -0, false]);
    const typed = entry.value;
    assert(typed, "Patched native codec must reach the imported signed-zero key");
    assert.equal(typed.big, -(2n ** 120n));
    assert.equal(typed.self, typed);
    assert.equal((await kv.get<{ separate_zero: boolean }>(["typed", new Uint8Array([0, 255]), -2n, 0, false])).value?.separate_zero, true);
    assert.equal((await kv.get<KvU64>(["counter"])).value?.value, 42n);
    assert.equal((await kv.atomic().sum(["counter"], 7n).commit()).ok, true);
    assert.equal(
      (
        await kv
          .atomic()
          .check({ key: ["counter"], versionstamp: "00000000000000000000" })
          .set(["counter"], new KvU64(0n))
          .commit()
      ).ok,
      false
    );
    await kv.set(["bun-latest"], { after_cutover: true, big: 77n, bytes: new Uint8Array([3, 2, 1]), missing: undefined });
    const iterator = kv.list({ prefix: ["uos_ai", "sentinel_replay", "v1", "accounting"] }, { limit: 2 });
    await iterator.next();
    await iterator.next();
    await kv.set(["uos_ai", "sentinel_replay", "v1", "reap_cursor"], iterator.cursor);
    await kv.set(["uos_ai", "sentinel_replay", "v1", "budget"], { bootstrap_cursor: "0|" + iterator.cursor, stored_bytes: 456, records: 9 });
    const latest = await kv.get(["bun-latest"]);
    latestTyped = latest.value;
    assert(latest.versionstamp !== null);
    latestVersion = latest.versionstamp;
  } finally {
    kv.close();
  }
  const latestRows = rawState(candidate);
  const candidateHash = await fileDigest(candidate);
  const reverse = await convertKvDatabase({ ...base, direction: "bun-to-deno", source: candidate, destination: rollback, receipt: join(root, "reverse.json") });
  assert.equal(await fileDigest(candidate), candidateHash);
  assert.deepEqual(rawState(rollback), latestRows);
  const verify = join(root, "verify.mjs");
  writeFileSync(
    verify,
    `const kv=await Deno.openKv(${JSON.stringify(rollback)});
const latest=await kv.get(['bun-latest']); if(latest.versionstamp!==${JSON.stringify(latestVersion)} || latest.value.big!==77n || latest.value.missing!==undefined || latest.value.bytes.join(',')!=='3,2,1') throw new Error('latest state lost');
const count=await kv.get(['counter']); if(!(count.value instanceof Deno.KvU64)||count.value.value!==49n) throw new Error('counter lost');
const ledger=await kv.get(['uos_ai','sentinel_replay','v1','budget']); if(ledger.value.stored_bytes!==456 || ledger.value.records!==9) throw new Error('ledger changed');
const cursor=await kv.get(['uos_ai','sentinel_replay','v1','reap_cursor']); const iterator=kv.list({prefix:['uos_ai','sentinel_replay','v1','accounting']},{cursor:cursor.value}); const remaining=[]; for await(const entry of iterator) remaining.push(entry.key[4]); if(remaining.length!==1 || remaining[0]!==3) throw new Error('cursor continuation changed');
const boot=kv.list({prefix:['uos_ai','sentinel_replay','v1','accounting']},{cursor:ledger.value.bootstrap_cursor.split('|')[1]}); if((await boot.next()).value.key[4]!==3) throw new Error('bootstrap continuation changed');
const typed=await kv.get(['typed',new Uint8Array([0,255]),-2n,-0,false]); if(typed.value.self!==typed.value || typed.value.big!==-(2n**120n)) throw new Error('typed state lost');
const paid=await kv.get(['uos_ai','paid_fallback','v3','rollup_backfill_cursor']); if(paid.value.request_key[1]!==9n) throw new Error('paid key cursor changed'); kv.close(); console.log('Deno latest-state runtime acceptance passed');`,
    { mode: 0o600 }
  );
  const denoAcceptance = await run([deno, "run", "--no-config", "--no-lock", "--no-prompt", "--unstable-kv", ...permissions, verify], root);
  const interruptedDestination = join(root, "interrupted.sqlite3");
  const abort = new AbortController();
  setTimeout(() => {
    abort.abort(new Error("synthetic interruption"));
  }, 1);
  await assert.rejects(
    convertKvDatabase({
      ...base,
      direction: "bun-to-deno",
      source: candidate,
      destination: interruptedDestination,
      receipt: join(root, "interrupted.json"),
      signal: abort.signal,
    })
  );
  assert.equal(existsSync(interruptedDestination), false);
  assert.equal(existsSync(join(root, "interrupted.json")), false);
  assert.equal(await fileDigest(candidate), candidateHash);
  for (const [name, reason] of [
    ["unsupported", /Error.cause/],
    ["negative-nan", /Negative NaN/],
  ] as const) {
    const source = join(root, name + ".sqlite3");
    const hash = await fileDigest(source);
    const destination = join(root, name + "-rejected.sqlite3");
    const receipt = join(root, name + "-rejected.json");
    await assert.rejects(convertKvDatabase({ ...base, direction: "deno-to-bun", source, destination, receipt }), reason);
    assert.equal(await fileDigest(source), hash);
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(receipt), false);
  }
  const result = {
    forward,
    reverse,
    deno_acceptance: denoAcceptance.trim(),
    latest_typed: encodeTypedValue(latestTyped),
    interruption: "no publication; source unchanged",
    retained_fixture: root,
  };
  writeFileSync(join(root, "proof.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
};
if (import.meta.main) {
  const [directory, deno, sha] = Bun.argv.slice(2);
  if (!directory || !deno || !sha) throw new Error("Usage: bun --no-env-file src/kv-conversion/proof.ts <NEW-disposable-directory> <pinned-deno> <sha256>");
  const result = await proveLegacyRoundtrip(directory, deno, sha);
  console.log(
    JSON.stringify({
      retained_fixture: result.retained_fixture,
      deno_acceptance: result.deno_acceptance,
      rows: result.reverse.destination.row_count,
      interruption: result.interruption,
    })
  );
}
