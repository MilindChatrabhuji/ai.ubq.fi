import { test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runFixture } from "../ops/tests/fixture-process.ts";

// `ops/gpg-dsh.sh` is the gpg.program recorded in docs/DECISIONS.md ("Sandboxed commits sign through a
// GNUPGHOME inside writable roots"). Fake `gpg` and `gpgconf` record what a signing call would see; a fake
// `mktemp` refuses the real homedir the way the DSH workspace-write sandbox does, so the seeded branch runs
// identically for root and unprivileged users.
const HELPER = fileURLToPath(new URL("../ops/gpg-dsh.sh", import.meta.url));
const DECISIONS = fileURLToPath(new URL("../docs/DECISIONS.md", import.meta.url));
const HOST_PATH = process.env.PATH ?? "/usr/bin:/bin";
const REAL_MKTEMP = Bun.which("mktemp", { PATH: HOST_PATH });
const UID = process.getuid?.() ?? 0;
const decoder = new TextDecoder();

type Fixture = {
  gnupg: string;
  tmp: string;
  seed: string;
  gpgconfLog: string;
  run: (mode: "sandboxed" | "writable", args?: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  dispose: () => Promise<void>;
};

const FAKE_GPG = `#!/bin/sh
printf 'GNUPGHOME=%s\\n' "\${GNUPGHOME-<unset>}"
for argument in "$@"; do printf 'arg=%s\\n' "$argument"; done
if [ -n "\${GNUPGHOME-}" ]; then
  for key in "$GNUPGHOME"/private-keys-v1.d/*; do
    [ -f "$key" ] && printf 'key=%s:%s\\n' "\${key##*/}" "$(cat "$key")"
  done
  [ -f "$GNUPGHOME/pubring.kbx" ] && printf 'pubring=%s\\n' "$(cat "$GNUPGHOME/pubring.kbx")"
  printf 'x' >>"$GNUPGHOME/random_seed"
fi
exit 0
`;

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const fakeGpgconf = (log: string): string => `#!/bin/sh
printf '%s\\n' "$*" >>${shellQuote(log)}
`;

const denyingMktemp = (denied: string, real: string): string => `#!/bin/sh
case "$1" in
  ${shellQuote(denied)}/*) printf 'mktemp: %s: Operation not permitted\\n' "$1" >&2; exit 1 ;;
esac
exec ${shellQuote(real)} "$@"
`;

const executable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source);
  await chmod(path, 0o700);
};

const createFixture = async (): Promise<Fixture> => {
  assert.ok(REAL_MKTEMP, "the fixture needs the host mktemp");
  const root = await mkdtemp(join(tmpdir(), "gpg-dsh-"));
  const home = join(root, "home");
  const gnupg = join(home, ".gnupg");
  const tmp = join(root, "tmp");
  const bin = join(root, "bin");
  const deny = join(root, "deny");
  const gpgconfLog = join(root, "gpgconf.log");
  for (const directory of [home, gnupg, join(gnupg, "private-keys-v1.d"), tmp, bin, deny]) await mkdir(directory, { mode: 0o700 });
  await writeFile(join(gnupg, "pubring.kbx"), "public-1", { mode: 0o600 });
  await writeFile(join(gnupg, "trustdb.gpg"), "trust-1", { mode: 0o600 });
  await writeFile(join(gnupg, "private-keys-v1.d", "AAAA.key"), "secret-a-old-passphrase", { mode: 0o600 });
  await writeFile(join(gnupg, "private-keys-v1.d", "BBBB.key"), "secret-b", { mode: 0o600 });
  await executable(join(bin, "gpg"), FAKE_GPG);
  await executable(join(bin, "gpgconf"), fakeGpgconf(gpgconfLog));
  await executable(join(deny, "mktemp"), denyingMktemp(gnupg, REAL_MKTEMP));
  const run: Fixture["run"] = async (mode, args = ["--status-fd=2", "-bsau", "KEY ID"]) => {
    const path = mode === "sandboxed" ? `${deny}:${bin}:${HOST_PATH}` : `${bin}:${HOST_PATH}`;
    const output = await runFixture("/bin/sh", { args: [HELPER, ...args], env: { PATH: path, HOME: home, TMPDIR: tmp } });
    return { code: output.code, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
  };
  return { gnupg, tmp, seed: join(tmp, "dsh-gnupg", String(UID)), gpgconfLog, run, dispose: () => rm(root, { recursive: true, force: true }) };
};

const withFixture = async (body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const fixture = await createFixture();
  try {
    await body(fixture);
  } finally {
    await fixture.dispose();
  }
};

const lines = (stdout: string, prefix: string): string[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));

const gpgconfCalls = async (fixture: Fixture): Promise<string[]> =>
  (await readFile(fixture.gpgconfLog, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

const signed = async (fixture: Fixture): Promise<string> => {
  const result = await fixture.run("sandboxed");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(lines(result.stdout, "GNUPGHOME="), [fixture.seed]);
  return result.stdout;
};

test("a genuinely writable homedir passes gpg through unchanged", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run("writable");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(lines(result.stdout, "GNUPGHOME="), ["<unset>"]);
    assert.deepEqual(lines(result.stdout, "arg="), ["--status-fd=2", "-bsau", "KEY ID"]);
    assert.deepEqual(
      (await readdir(fixture.gnupg)).sort((left, right) => left.localeCompare(right)),
      ["private-keys-v1.d", "pubring.kbx", "trustdb.gpg"],
      "the write probe is removed"
    );
    await assert.rejects(stat(join(fixture.tmp, "dsh-gnupg")), "no seed is created on the passthrough branch");
  });
});

test("a sandboxed call signs from a private seed of the keyrings and every private key", async () => {
  await withFixture(async (fixture) => {
    const stdout = await signed(fixture);
    assert.deepEqual(lines(stdout, "arg="), ["--status-fd=2", "-bsau", "KEY ID"]);
    assert.deepEqual(lines(stdout, "key="), ["AAAA.key:secret-a-old-passphrase", "BBBB.key:secret-b"]);
    assert.deepEqual(lines(stdout, "pubring="), ["public-1"]);
    assert.equal(await readFile(join(fixture.seed, "trustdb.gpg"), "utf8"), "trust-1");
    assert.equal((await stat(fixture.seed)).mode & 0o777, 0o700);
    assert.equal((await stat(join(fixture.tmp, "dsh-gnupg"))).mode & 0o777, 0o700);
  });
});

test("an unchanged homedir reuses the seed and leaves its agent running", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await signed(fixture);
    assert.equal(await readFile(join(fixture.seed, "random_seed"), "utf8"), "xx", "gpg state written in the seed survives");
    assert.deepEqual(await gpgconfCalls(fixture), []);
  });
});

test("deleting a private key without touching the public keyring removes it from the seed and stops the seed agent", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    const stdout = await signed(fixture);
    assert.deepEqual(lines(stdout, "key="), ["AAAA.key:secret-a-old-passphrase"]);
    assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${fixture.seed} --kill gpg-agent`]);
    assert.equal(await readFile(join(fixture.seed, "random_seed"), "utf8"), "x", "the stale seed was discarded, not patched");
  });
});

test("a passphrase change that keeps the key file's size and mtime still replaces the seeded copy", async () => {
  await withFixture(async (fixture) => {
    const key = join(fixture.gnupg, "private-keys-v1.d", "AAAA.key");
    await signed(fixture);
    const before = await stat(key);
    await writeFile(key, "secret-a-new-passphrase");
    await utimes(key, before.atime, before.mtime);
    const after = await stat(key);
    assert.equal(after.size, before.size);
    // `stat -f '%m'` (the installed helper's stamp) reports whole seconds.
    assert.equal(Math.trunc(after.mtimeMs / 1000), Math.trunc(before.mtimeMs / 1000));
    const stdout = await signed(fixture);
    assert.deepEqual(lines(stdout, "key="), ["AAAA.key:secret-a-new-passphrase", "BBBB.key:secret-b"]);
    assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${fixture.seed} --kill gpg-agent`]);
  });
});

test("an added private key and a changed public keyring each reseed", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await writeFile(join(fixture.gnupg, "private-keys-v1.d", "CCCC.key"), "secret-c", { mode: 0o600 });
    assert.deepEqual(lines(await signed(fixture), "key="), ["AAAA.key:secret-a-old-passphrase", "BBBB.key:secret-b", "CCCC.key:secret-c"]);
    await writeFile(join(fixture.gnupg, "pubring.kbx"), "public-2");
    assert.deepEqual(lines(await signed(fixture), "pubring="), ["public-2"]);
    assert.equal((await gpgconfCalls(fixture)).length, 2);
  });
});

test("a seed path that is a symbolic link fails closed before gpg runs", async () => {
  await withFixture(async (fixture) => {
    const decoy = join(fixture.tmp, "decoy");
    await mkdir(decoy, { mode: 0o700 });
    await mkdir(join(fixture.tmp, "dsh-gnupg"), { mode: 0o700 });
    await symlink(decoy, fixture.seed);
    const result = await fixture.run("sandboxed");
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "", "gpg must not run");
    assert.match(result.stderr, /gpg-dsh: .*symbolic link/);
    assert.deepEqual(await readdir(decoy), [], "no key material is copied through the link");
  });
});

// The seed's siblings in its parent: the rebuild lock and any staging or set-aside copies.
const siblings = async (fixture: Fixture): Promise<string[]> =>
  (await readdir(join(fixture.tmp, "dsh-gnupg"))).filter((name) => name !== String(UID)).sort((left, right) => left.localeCompare(right));

test("concurrent calls right after an input change all sign from one complete rebuild", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    const rounds = 4;
    for (let round = 1; round <= rounds; round += 1) {
      await writeFile(join(fixture.gnupg, "private-keys-v1.d", "AAAA.key"), `secret-a-round-${round}`);
      await writeFile(join(fixture.gnupg, `extra-${round}.gpg`), `extra-${round}`, { mode: 0o600 });
      const results = await Promise.all(Array.from({ length: 12 }, () => fixture.run("sandboxed")));
      for (const result of results) {
        assert.equal(result.code, 0, `round ${round}: ${result.stderr}`);
        assert.deepEqual(lines(result.stdout, "GNUPGHOME="), [fixture.seed]);
        assert.deepEqual(lines(result.stdout, "key="), [`AAAA.key:secret-a-round-${round}`, "BBBB.key:secret-b"], `round ${round}`);
      }
      assert.equal(await readFile(join(fixture.seed, `extra-${round}.gpg`), "utf8"), `extra-${round}`);
      assert.deepEqual(await siblings(fixture), [], `round ${round}: no lock, staging, or set-aside seed is left behind`);
    }
    assert.equal((await gpgconfCalls(fixture)).length, rounds, "each input change rebuilds the seed, and stops its agent, exactly once");
    const stdout = await signed(fixture);
    assert.deepEqual(lines(stdout, "key="), [`AAAA.key:secret-a-round-${rounds}`, "BBBB.key:secret-b"]);
    assert.equal((await gpgconfCalls(fixture)).length, rounds, "the final seed's recorded manifest matches the inputs");
  });
}, 60_000);

test("a call that finds the rebuild lock held waits for it instead of rebuilding alongside", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await writeFile(join(fixture.gnupg, "private-keys-v1.d", "CCCC.key"), "secret-c", { mode: 0o600 });
    const lock = `${fixture.seed}.lock`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
    let settled = false;
    const pending = fixture.run("sandboxed").finally(() => {
      settled = true;
    });
    await Bun.sleep(1500);
    assert.equal(settled, false, "the call waits while a live holder has the lock");
    assert.deepEqual(await gpgconfCalls(fixture), [], "the waiting call has not touched the seed");
    await rm(lock, { recursive: true });
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(lines(result.stdout, "key="), ["AAAA.key:secret-a-old-passphrase", "BBBB.key:secret-b", "CCCC.key:secret-c"]);
    assert.deepEqual(await siblings(fixture), []);
  });
}, 60_000);

test("a lock left by a killed holder and its half-built seed are discarded, then the seed is rebuilt", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    const lock = `${fixture.seed}.lock`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), `999999 ${Math.floor(Date.now() / 1000) - 3600}\n`);
    const leftover = `${fixture.seed}.new.AbC123`;
    await mkdir(join(leftover, "private-keys-v1.d"), { recursive: true, mode: 0o700 });
    await writeFile(join(leftover, "private-keys-v1.d", "BBBB.key"), "secret-b");
    const stdout = await signed(fixture);
    assert.deepEqual(lines(stdout, "key="), ["AAAA.key:secret-a-old-passphrase"]);
    assert.deepEqual(await siblings(fixture), [], "the stale lock and the leftover copy of the deleted key are gone");
    assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${fixture.seed} --kill gpg-agent`]);
  });
});

test("a leftover staging copy is discarded even when the seed is current", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    const leftover = `${fixture.seed}.old.XyZ789`;
    await mkdir(join(leftover, "seed", "private-keys-v1.d"), { recursive: true, mode: 0o700 });
    await writeFile(join(leftover, "seed", "private-keys-v1.d", "DDDD.key"), "deleted-secret");
    await signed(fixture);
    assert.deepEqual(await siblings(fixture), []);
    assert.equal(await readFile(join(fixture.seed, "random_seed"), "utf8"), "xx", "a current seed is reused, not rebuilt");
    assert.deepEqual(await gpgconfCalls(fixture), []);
  });
});

test("the sandboxed-signing decision records the helper and its private-key invalidation", async () => {
  const decisions = await readFile(DECISIONS, "utf8");
  const entry = decisions.split(/^## /m).find((section) => section.startsWith("Sandboxed commits sign through a GNUPGHOME inside writable roots"));
  assert.ok(entry, "the sandboxed-signing decision entry exists");
  assert.match(entry, /`ops\/gpg-dsh\.sh`/);
  assert.match(entry, /deleted,\s+added,\s+or\s+re-protected\s+private\s+key/);
  assert.doesNotMatch(entry, /re-seeding\s+when\s+`pubring\.kbx`\s+changes/);
});

test("the sandboxed-signing decision records serialized rebuilds and a compare-first install", async () => {
  const decisions = await readFile(DECISIONS, "utf8");
  const entry = decisions.split(/^## /m).find((section) => section.startsWith("Sandboxed commits sign through a GNUPGHOME inside writable roots"));
  assert.ok(entry, "the sandboxed-signing decision entry exists");
  assert.match(entry, /Rebuilds\s+are\s+serialized/);
  assert.match(entry, /#1139/);
  assert.doesNotMatch(entry, /`~\/bin\/gpg-dsh`\s+is\s+installed\s+from/, "merging the helper installs nothing");
  assert.match(entry, /diff\s+ops\/gpg-dsh\.sh\s+~\/bin\/gpg-dsh/);
  for (const unseeded of ["gpg.conf", "gpg-agent.conf", "public-keys.d"]) assert.ok(entry.includes(`\`${unseeded}\``), `the entry names unseeded ${unseeded}`);
  const header = (await readFile(HELPER, "utf8")).split("\n").slice(0, 6).join("\n");
  assert.match(header, /diff ops\/gpg-dsh\.sh ~\/bin\/gpg-dsh/, "the helper's install note says to compare first");
});
