import { test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
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
  bin: string;
  base: string;
  tmp: string;
  seed: string;
  gpgconfLog: string;
  digestLog: string;
  run: (
    mode: "sandboxed" | "writable",
    options?: { args?: string[]; env?: Record<string, string>; shell?: string[] }
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
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

const hostCommand = (name: string): string => {
  const path = Bun.which(name, { PATH: HOST_PATH });
  assert.ok(path, `the fixture needs the host ${name}`);
  return shellQuote(path);
};

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
  const digestLog = join(root, "digest.log");
  const base = join(tmp, `dsh-gnupg-${UID}`);
  for (const directory of [home, gnupg, join(gnupg, "private-keys-v1.d"), tmp, bin, deny]) await mkdir(directory, { mode: 0o700 });
  await writeFile(join(gnupg, "pubring.kbx"), "public-1", { mode: 0o600 });
  await writeFile(join(gnupg, "trustdb.gpg"), "trust-1", { mode: 0o600 });
  await writeFile(join(gnupg, "private-keys-v1.d", "AAAA.key"), "secret-a-old-passphrase", { mode: 0o600 });
  await writeFile(join(gnupg, "private-keys-v1.d", "BBBB.key"), "secret-b", { mode: 0o600 });
  await executable(join(bin, "gpg"), FAKE_GPG);
  await executable(join(bin, "gpgconf"), fakeGpgconf(gpgconfLog));
  await executable(join(deny, "mktemp"), denyingMktemp(gnupg, REAL_MKTEMP));
  const digest = Bun.which("sha256sum", { PATH: HOST_PATH });
  await executable(
    join(bin, "sha256sum"),
    `#!/bin/sh
printf 'digest\\n' >>${shellQuote(digestLog)}
exec ${digest ? shellQuote(digest) : `${hostCommand("shasum")} -a 256`} "$@"
`
  );
  const run: Fixture["run"] = async (mode, options = {}) => {
    const path = mode === "sandboxed" ? `${deny}:${bin}:${HOST_PATH}` : `${bin}:${HOST_PATH}`;
    const [program, ...shellArgs] = options.shell ?? ["/bin/sh"];
    assert.ok(program);
    const args = options.args ?? ["--status-fd=2", "-bsau", "KEY ID"];
    const output = await runFixture(program, { args: [...shellArgs, HELPER, ...args], env: { PATH: path, HOME: home, TMPDIR: tmp, ...options.env } });
    return { code: output.code, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
  };
  return { gnupg, bin, base, tmp, seed: join(base, "seed"), gpgconfLog, digestLog, run, dispose: () => rm(root, { recursive: true, force: true }) };
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
    await assert.rejects(stat(fixture.base), "no seed is created on the passthrough branch");
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
    assert.equal((await stat(fixture.base)).mode & 0o777, 0o700);
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
    await mkdir(fixture.base, { mode: 0o700 });
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
  (await readdir(fixture.base)).filter((name) => name !== "seed").sort((left, right) => left.localeCompare(right));

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

// Delay removals to force contenders to overlap their stale-owner observations and deletions.
const slowLockRemoval = (fixture: Fixture, failOnce = false): string => `#!/bin/sh
if [ "$*" = ${shellQuote(`-rf ${fixture.seed}.lock`)} ]; then
  ${failOnce ? `if mkdir ${shellQuote(join(fixture.tmp, "rm-failed"))} 2>/dev/null; then exit 1; fi` : "sleep 0.05"}
fi
exec ${hostCommand("rm")} "$@"
`;

for (const shell of [["/bin/sh"], ["/bin/bash", "--posix"]])
  test(`concurrent stale-lock recovery rebuilds exactly once (${shell.join(" ")})`, async () => {
    await withFixture(async (fixture) => {
      await signed(fixture);
      await executable(join(fixture.bin, "rm"), slowLockRemoval(fixture));
      const rounds = 4;
      for (let round = 1; round <= rounds; round += 1) {
        await writeFile(join(fixture.gnupg, "private-keys-v1.d", "AAAA.key"), `secret-a-round-${round}`);
        if (round === 1) await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
        const lock = `${fixture.seed}.lock`;
        await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, "owner"), `999999 ${Math.floor(Date.now() / 1000) - 3600}\n`);
        const leftover = `${fixture.seed}.new.AbC123`;
        await mkdir(join(leftover, "private-keys-v1.d"), { recursive: true, mode: 0o700 });
        await writeFile(join(leftover, "private-keys-v1.d", "BBBB.key"), "secret-b");
        const results = await Promise.all(Array.from({ length: 16 }, () => fixture.run("sandboxed", { shell })));
        for (const result of results) {
          assert.equal(result.code, 0, `round ${round}: ${result.stderr}`);
          assert.deepEqual(lines(result.stdout, "GNUPGHOME="), [fixture.seed]);
          assert.deepEqual(lines(result.stdout, "key="), [`AAAA.key:secret-a-round-${round}`], `round ${round}: no missing or deleted key`);
        }
        assert.equal((await gpgconfCalls(fixture)).length, round, "one agent stop per recovery");
        assert.deepEqual(await siblings(fixture), [], "no locks or leftover private keys");
        assert.deepEqual(
          (await readdir(fixture.seed)).filter((name) => /\.(new|old)\./.test(name)),
          []
        );
      }
      await signed(fixture);
      assert.equal((await gpgconfCalls(fixture)).length, rounds, "the published manifest is current");
    });
  }, 60_000);

test("a failed stale-lock removal is retried, not fatal", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    const lock = `${fixture.seed}.lock`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), "999999 1\n");
    await executable(join(fixture.bin, "rm"), slowLockRemoval(fixture, true));
    assert.deepEqual(lines(await signed(fixture), "key="), ["AAAA.key:secret-a-old-passphrase"]);
    assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${fixture.seed} --kill gpg-agent`]);
    assert.deepEqual(await siblings(fixture), []);
  });
});

for (const shell of [["/bin/sh"], ["/bin/bash", "--posix"]])
  test(`interrupted gate release preserves a competing caller's new gate (${shell.join(" ")})`, async () => {
    await withFixture(async (fixture) => {
      await signed(fixture);
      await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
      const gate = `${fixture.seed}.lock.break`;
      const firstRelease = join(fixture.tmp, "first-release");
      const interruptedRelease = join(fixture.tmp, "interrupted-release");
      await executable(
        join(fixture.bin, "rm"),
        `#!/bin/sh
if [ "$1" = ${shellQuote(gate)} ] && [ ! -d ${shellQuote(interruptedRelease)} ]; then
  if ${hostCommand("mkdir")} ${shellQuote(firstRelease)} 2>/dev/null; then
    exec ${hostCommand("rm")} "$@"
  fi
  ${hostCommand("rm")} "$@" || exit 1
  printf 'competing gate\\n' >${shellQuote(gate)} || exit 1
  ${hostCommand("mkdir")} ${shellQuote(interruptedRelease)} || exit 1
  kill -TERM "$PPID" || exit 1
  exit 0
fi
exec ${hostCommand("rm")} "$@"
`
      );
      const result = await fixture.run("sandboxed", { shell });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, "", "an interrupted signing never invokes gpg");
      assert.match(result.stderr, /gpg-dsh: interrupted/);
      assert.equal(await readFile(gate, "utf8"), "competing gate\n", "cleanup must preserve the competing caller's gate");
      await assert.rejects(stat(`${fixture.seed}.lock`), "the completed rebuild released its own lock");
      assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${fixture.seed} --kill gpg-agent`]);
    });
  });

test("a failed gate release remains fatal and leaves the gate closed", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    const gate = `${fixture.seed}.lock.break`;
    const firstRelease = join(fixture.tmp, "first-release");
    await executable(
      join(fixture.bin, "rm"),
      `#!/bin/sh
if [ "$1" = ${shellQuote(gate)} ]; then
  if ! ${hostCommand("mkdir")} ${shellQuote(firstRelease)} 2>/dev/null; then exit 1; fi
fi
exec ${hostCommand("rm")} "$@"
`
    );
    const result = await fixture.run("sandboxed");
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "", "gpg must not run after an unsuccessful gate release");
    assert.match(result.stderr, /cannot release the rebuild lock/);
    assert.equal(await readFile(gate, "utf8"), "", "failed removal must remain fail-closed");
    await assert.rejects(stat(`${fixture.seed}.lock`));
  });
});

const advancingClock = async (fixture: Fixture): Promise<void> => {
  const clock = join(fixture.tmp, "clock");
  await writeFile(clock, "100\n");
  await executable(
    join(fixture.bin, "date"),
    `#!/bin/sh
now=$(${hostCommand("cat")} ${shellQuote(clock)})
printf '%s\\n' "$((now + 20))" >${shellQuote(clock)}
printf '%s\\n' "$now"
`
  );
};

for (const shell of [["/bin/sh"], ["/bin/bash", "--posix"]]) {
  test(`an EEXIST success from mkdir cannot grant ownership of another caller's gate (${shell.join(" ")})`, async () => {
    await withFixture(async (fixture) => {
      await signed(fixture);
      await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
      const gate = `${fixture.seed}.lock.break`;
      await mkdir(gate, { mode: 0o700 });
      await advancingClock(fixture);
      // uutils mkdir 0.10.0 can return success after its initial absent-path check races with another
      // creator: create_dir returns EEXIST, then path.is_dir() converts that failure into success.
      // Start at that failed syscall with the competing caller's gate already present.
      await executable(
        join(fixture.bin, "mkdir"),
        `#!/bin/sh
if [ "$1" = ${shellQuote(gate)} ]; then
  ${hostCommand("mkdir")} "$@" 2>/dev/null || [ -d "$1" ]
  exit "$?"
fi
exec ${hostCommand("mkdir")} "$@"
`
      );
      const result = await fixture.run("sandboxed", { shell });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, "", "a contender cannot sign through another caller's gate");
      assert.match(result.stderr, /timed out waiting for the rebuild lock/);
      assert.deepEqual(await readdir(gate), [], "the competing gate remains untouched");
      assert.deepEqual(await gpgconfCalls(fixture), [], "the contender never rebuilt the seed");
    });
  });

  for (const kind of ["directory", "file", "FIFO", "dangling symlink", "device symlink"])
    test(`an existing ${kind} blocks gate acquisition without being opened (${shell.join(" ")})`, async () => {
      await withFixture(async (fixture) => {
        await signed(fixture);
        await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
        const gate = `${fixture.seed}.lock.break`;
        if (kind === "directory") await mkdir(gate, { mode: 0o700 });
        else if (kind === "file") await writeFile(gate, "another caller's gate", { mode: 0o600 });
        else if (kind === "FIFO") {
          const result = await runFixture("/bin/sh", { args: ["-c", `${hostCommand("mkfifo")} ${shellQuote(gate)}`] });
          assert.equal(result.code, 0, decoder.decode(result.stderr));
        } else await symlink(kind === "device symlink" ? "/dev/null" : join(fixture.tmp, "missing"), gate);
        const before = await lstat(gate);
        await advancingClock(fixture);
        const result = await fixture.run("sandboxed", { shell });
        assert.equal(result.code, 2, result.stderr);
        assert.equal(result.stdout, "", "gpg cannot run while a foreign gate exists");
        assert.match(result.stderr, /timed out waiting for the rebuild lock/);
        assert.equal((await lstat(gate)).ino, before.ino, "the foreign gate is preserved");
        if (kind === "file") assert.equal(await readFile(gate, "utf8"), "another caller's gate");
        assert.deepEqual(await gpgconfCalls(fixture), []);
      });
    });
}

const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, "fixture did not reach the expected synchronization point");
    await Bun.sleep(20);
  }
};

test("owner reads precede clock samples and a future-dated live lock is not broken", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    const lock = `${fixture.seed}.lock`;
    const log = join(fixture.tmp, "order.log");
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), "222 101\n");
    await executable(
      join(fixture.bin, "date"),
      `#!/bin/sh
printf 'clock\\n' >>${shellQuote(log)}
printf '100\\n'
`
    );
    await executable(
      join(fixture.bin, "cat"),
      `#!/bin/sh
if [ "$1" = ${shellQuote(join(lock, "owner"))} ]; then printf 'owner\\n' >>${shellQuote(log)}; fi
exec ${hostCommand("cat")} "$@"
`
    );
    let settled = false;
    const pending = fixture.run("sandboxed").finally(() => {
      settled = true;
    });
    try {
      await waitFor(async () => (await readFile(log, "utf8").catch(() => "")).includes("owner\nclock\n"));
      await Bun.sleep(150);
      assert.equal(settled, false, "negative held is live, not stale");
      assert.equal(await readFile(join(lock, "owner"), "utf8"), "222 101\n");
      assert.deepEqual(await gpgconfCalls(fixture), []);
      assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").slice(0, 3), ["clock", "owner", "clock"]);
    } finally {
      await rm(lock, { recursive: true, force: true });
      const result = await pending;
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /breaking the stale/);
    }
  });
});

test("an old lock with a live owner is retained until its holder releases it", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    const lock = `${fixture.seed}.lock`;
    const owner = `${process.pid} 1\n`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), owner);
    await executable(join(fixture.bin, "date"), "#!/bin/sh\nprintf '1000\\n'\n");
    let settled = false;
    const pending = fixture.run("sandboxed").finally(() => {
      settled = true;
    });
    try {
      await Bun.sleep(300);
      assert.equal(settled, false, "age alone does not retire a live holder");
      assert.equal(await readFile(join(lock, "owner"), "utf8"), owner);
      assert.deepEqual(await gpgconfCalls(fixture), []);
    } finally {
      await rm(lock, { recursive: true, force: true });
      const result = await pending;
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /breaking the stale/);
    }
    assert.deepEqual(await siblings(fixture), []);
    assert.equal((await gpgconfCalls(fixture)).length, 1);
  });
});

test("a competing breaker holds up recovery until it releases the gate", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    const lock = `${fixture.seed}.lock`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), "999999 1\n");
    await mkdir(`${lock}.break`, { mode: 0o700 });
    let settled = false;
    const pending = fixture.run("sandboxed").finally(() => {
      settled = true;
    });
    try {
      await Bun.sleep(200);
      assert.equal(settled, false);
      assert.equal(await readFile(join(lock, "owner"), "utf8"), "999999 1\n");
      assert.deepEqual(await gpgconfCalls(fixture), []);
    } finally {
      await rm(`${lock}.break`, { recursive: true, force: true });
      const result = await pending;
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(await siblings(fixture), []);
    assert.equal((await gpgconfCalls(fixture)).length, 1);
  });
});

test("an abandoned breaker gate times out fail-closed without removing another caller's gate", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    const lock = `${fixture.seed}.lock`;
    const clock = join(fixture.tmp, "clock");
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), "999999 1\n");
    await mkdir(`${lock}.break`, { mode: 0o700 });
    await writeFile(clock, "100\n");
    await executable(
      join(fixture.bin, "date"),
      `#!/bin/sh
now=$(${hostCommand("cat")} ${shellQuote(clock)})
printf '%s\\n' "$((now + 20))" >${shellQuote(clock)}
printf '%s\\n' "$now"
`
    );
    const result = await fixture.run("sandboxed");
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /timed out waiting for the rebuild lock/);
    assert.equal(await readFile(join(lock, "owner"), "utf8"), "999999 1\n");
    assert.deepEqual(await readdir(`${lock}.break`), []);
    assert.deepEqual(await gpgconfCalls(fixture), []);
  });
});

test("a destination reappearing during portable mv removes nested key copies and fails closed", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.gnupg, "private-keys-v1.d", "BBBB.key"));
    await executable(
      join(fixture.bin, "mv"),
      `#!/bin/sh
case "$1" in
  ${shellQuote(fixture.seed)}.new.*) mkdir ${shellQuote(fixture.seed)} || exit 1 ;;
esac
exec ${hostCommand("mv")} "$@"
`
    );
    const result = await fixture.run("sandboxed");
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "", "gpg never runs from the collided seed");
    assert.match(result.stderr, /unexpected seed copy after publishing/);
    assert.deepEqual(await readdir(fixture.seed), [], "the nested stage and its private keys are removed");
    assert.deepEqual(await siblings(fixture), []);
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

const digestProcesses = async (fixture: Fixture): Promise<number> =>
  (await readFile(fixture.digestLog, "utf8").catch(() => "")).split("\n").filter((line) => line !== "").length;

const assertRefusedBeforeGpg = (result: { code: number; stdout: string; stderr: string }, message: RegExp): void => {
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "", "gpg must not run");
  assert.match(result.stderr, message);
};

test("every sandboxed call hashes all seed inputs in one digest process", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    assert.equal(await digestProcesses(fixture), 1, "the build hashes four inputs with one process");
    await signed(fixture);
    assert.equal(await digestProcesses(fixture), 2, "a reused seed costs one more process, not one per input");
  });
});

test("the macOS shasum fallback also hashes the complete input list in one process", async () => {
  await withFixture(async (fixture) => {
    await unlink(join(fixture.bin, "sha256sum"));
    // No system PATH entry: sha256sum must genuinely be unavailable to command -v.
    for (const name of ["id", "chmod", "mkdir", "cat", "date", "sleep", "cp", "mv", "rm", "rmdir"]) {
      const path = Bun.which(name, { PATH: HOST_PATH });
      assert.ok(path);
      await symlink(path, join(fixture.bin, name));
    }
    await executable(
      join(fixture.bin, "shasum"),
      `#!/bin/sh
printf 'digest\\n' >>${shellQuote(fixture.digestLog)}
exec ${hostCommand("shasum")} "$@"
`
    );
    const result = await fixture.run("sandboxed", { env: { PATH: `${join(fixture.bin, "..", "deny")}:${fixture.bin}` } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(lines(result.stdout, "key="), ["AAAA.key:secret-a-old-passphrase", "BBBB.key:secret-b"]);
    assert.equal(await digestProcesses(fixture), 1);
  });
});

for (const name of ["gpg-agent.conf", "gpg.conf", "gpg.conf-2.4", "common.conf", "scdaemon.conf"])
  test(`a ${name} planted in the seed is discarded with the seed and its agent before gpg runs`, async () => {
    await withFixture(async (fixture) => {
      await signed(fixture);
      await writeFile(join(fixture.seed, name), "pinentry-program /workspace/evil-pinentry\n");
      const stdout = await signed(fixture);
      assert.deepEqual(lines(stdout, "key="), ["AAAA.key:secret-a-old-passphrase", "BBBB.key:secret-b"]);
      await assert.rejects(stat(join(fixture.seed, name)), "the planted configuration is gone");
      assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${fixture.seed} --kill gpg-agent`]);
      assert.equal(await readFile(join(fixture.seed, "random_seed"), "utf8"), "x", "the seed was rebuilt, not patched");
    });
  });

test("a dangling configuration symlink is discarded before signing", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    const config = join(fixture.seed, "gpg-agent.conf");
    await symlink(join(fixture.tmp, "missing-config"), config);
    await signed(fixture);
    await assert.rejects(lstat(config));
    assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${fixture.seed} --kill gpg-agent`]);
  });
});

test("a seed without a recorded manifest is an interrupted rebuild and is rebuilt", async () => {
  await withFixture(async (fixture) => {
    await signed(fixture);
    await unlink(join(fixture.seed, ".gpg-dsh-manifest"));
    await signed(fixture);
    assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${fixture.seed} --kill gpg-agent`]);
    assert.equal(await readFile(join(fixture.seed, "random_seed"), "utf8"), "x");
    await signed(fixture);
    assert.equal((await gpgconfCalls(fixture)).length, 1, "the rebuilt seed records its manifest again");
  });
});

test("an existing parent and seed readable by others are restricted to mode 0700", async () => {
  await withFixture(async (fixture) => {
    await mkdir(fixture.base, { mode: 0o700 });
    await chmod(fixture.base, 0o755);
    await signed(fixture);
    await chmod(fixture.seed, 0o755);
    await signed(fixture);
    assert.equal((await stat(fixture.base)).mode & 0o777, 0o700);
    assert.equal((await stat(fixture.seed)).mode & 0o777, 0o700);
  });
});

test("a parent that is not a directory fails closed before gpg runs", async () => {
  await withFixture(async (fixture) => {
    await writeFile(fixture.base, "not a directory\n");
    assertRefusedBeforeGpg(await fixture.run("sandboxed"), /gpg-dsh: .*is not a directory owned by uid/);
    assert.equal(await readFile(fixture.base, "utf8"), "not a directory\n");
  });
});

test("a relative TMPDIR fails closed before gpg runs", async () => {
  await withFixture(async (fixture) => {
    assertRefusedBeforeGpg(await fixture.run("sandboxed", { env: { TMPDIR: "relative/tmp" } }), /gpg-dsh: TMPDIR must be an absolute path/);
  });
});

test("a seed left in the shared dsh-gnupg layout is discarded with its agent", async () => {
  await withFixture(async (fixture) => {
    const legacyParent = join(fixture.tmp, "dsh-gnupg");
    const legacySeed = join(legacyParent, String(UID));
    await mkdir(join(legacySeed, "private-keys-v1.d"), { recursive: true, mode: 0o700 });
    await writeFile(join(legacySeed, "private-keys-v1.d", "OLD.key"), "secret-deleted-key", { mode: 0o600 });
    for (const suffix of [".lock", ".lock.break", ".new.AbC123", ".old.AbC123/seed"]) {
      await mkdir(join(`${legacySeed}${suffix}`, "private-keys-v1.d"), { recursive: true, mode: 0o700 });
      await writeFile(join(`${legacySeed}${suffix}`, "private-keys-v1.d", "OLD.key"), "secret-deleted-key");
    }
    const results = await Promise.all(Array.from({ length: 8 }, () => fixture.run("sandboxed")));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(lines(result.stdout, "key="), ["AAAA.key:secret-a-old-passphrase", "BBBB.key:secret-b"]);
    }
    await assert.rejects(stat(legacyParent), "the old per-user seed and its emptied parent are removed");
    assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${legacySeed} --kill gpg-agent`]);
  });
});

test("the sandboxed-signing decision records the helper and its private-key invalidation", async () => {
  const decisions = await readFile(DECISIONS, "utf8");
  const entry = decisions.split(/^## /m).find((section) => section.startsWith("Sandboxed commits sign through a GNUPGHOME inside writable roots"));
  assert.ok(entry, "the sandboxed-signing decision entry exists");
  assert.match(entry, /`ops\/gpg-dsh\.sh`/);
  assert.match(entry, /deleted,\s+added,\s+or\s+re-protected\s+private\s+key/);
  assert.doesNotMatch(entry, /re-seeding\s+when\s+`pubring\.kbx`\s+changes/);
  assert.match(entry, /`\$TMPDIR\/dsh-gnupg-<uid>\/seed`/);
  assert.match(entry, /GnuPG\s+configuration\s+file\s+in\s+the\s+seed/);
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
