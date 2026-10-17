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
  base: string;
  seed: string;
  gpgconfLog: string;
  digestLog: string;
  run: (
    mode: "sandboxed" | "writable",
    options?: { args?: string[]; env?: Record<string, string> }
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

const HOST_SHA256SUM = Bun.which("sha256sum", { PATH: HOST_PATH });
const HOST_SHASUM = Bun.which("shasum", { PATH: HOST_PATH });

// Records one line per digest process and delegates to the host's own tool, so the helper keeps its real
// output format whichever of the two tools it would have found.
const countingSha256sum = (log: string): string => {
  assert.ok(HOST_SHA256SUM ?? HOST_SHASUM, "the fixture needs sha256sum or shasum");
  const delegate = HOST_SHA256SUM ? shellQuote(HOST_SHA256SUM) : `${shellQuote(HOST_SHASUM ?? "")} -a 256`;
  return `#!/bin/sh
printf 'digest\\n' >>${shellQuote(log)}
exec ${delegate} "$@"
`;
};

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
  const digestLog = join(root, "digest.log");
  for (const directory of [home, gnupg, join(gnupg, "private-keys-v1.d"), tmp, bin, deny]) await mkdir(directory, { mode: 0o700 });
  await writeFile(join(gnupg, "pubring.kbx"), "public-1", { mode: 0o600 });
  await writeFile(join(gnupg, "trustdb.gpg"), "trust-1", { mode: 0o600 });
  await writeFile(join(gnupg, "private-keys-v1.d", "AAAA.key"), "secret-a-old-passphrase", { mode: 0o600 });
  await writeFile(join(gnupg, "private-keys-v1.d", "BBBB.key"), "secret-b", { mode: 0o600 });
  await executable(join(bin, "gpg"), FAKE_GPG);
  await executable(join(bin, "gpgconf"), fakeGpgconf(gpgconfLog));
  await executable(join(bin, "sha256sum"), countingSha256sum(digestLog));
  await executable(join(deny, "mktemp"), denyingMktemp(gnupg, REAL_MKTEMP));
  const run: Fixture["run"] = async (mode, { args = ["--status-fd=2", "-bsau", "KEY ID"], env = {} } = {}) => {
    const path = mode === "sandboxed" ? `${deny}:${bin}:${HOST_PATH}` : `${bin}:${HOST_PATH}`;
    const output = await runFixture("/bin/sh", { args: [HELPER, ...args], env: { PATH: path, HOME: home, TMPDIR: tmp, ...env } });
    return { code: output.code, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
  };
  const base = join(tmp, `dsh-gnupg-${UID}`);
  return {
    gnupg,
    tmp,
    base,
    seed: join(base, "seed"),
    gpgconfLog,
    digestLog,
    run,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
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
    await assert.rejects(stat(join(fixture.tmp, "dsh-gnupg")), "no parent directory is shared between users");
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
    const stdout = await signed(fixture);
    assert.deepEqual(lines(stdout, "key="), ["AAAA.key:secret-a-old-passphrase", "BBBB.key:secret-b"]);
    await assert.rejects(stat(legacyParent), "the old per-user seed and its emptied parent are removed");
    assert.deepEqual(await gpgconfCalls(fixture), [`--homedir ${legacySeed} --kill gpg-agent`]);
  });
});

test("the sandboxed-signing decision records the helper, its per-user seed and its invalidation rules", async () => {
  const decisions = await readFile(DECISIONS, "utf8");
  const entry = decisions.split(/^## /m).find((section) => section.startsWith("Sandboxed commits sign through a GNUPGHOME inside writable roots"));
  assert.ok(entry, "the sandboxed-signing decision entry exists");
  assert.match(entry, /`ops\/gpg-dsh\.sh`/);
  assert.match(entry, /deleted,\s+added,\s+or\s+re-protected\s+private\s+key/);
  assert.doesNotMatch(entry, /re-seeding\s+when\s+`pubring\.kbx`\s+changes/);
  assert.match(entry, /`\$TMPDIR\/dsh-gnupg-<uid>\/seed`/);
  assert.match(entry, /GnuPG\s+configuration\s+file\s+in\s+the\s+seed/);
});
