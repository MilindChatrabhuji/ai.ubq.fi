import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { runFixture, fsError } from "../ops/tests/fixture-process.ts";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const fixtureRoot = resolve(".cleanup-evidence/precommit-fixtures");
const stagedSource = "export const selected=1\n";
const formattedSource = "export const selected = 1;\n";
const foreignStaged = "foreign staged content\n";
const foreignWorking = "foreign unstaged content\n";
const nonstagedSource = "export const nonstaged=2\n";
const decoder = new TextDecoder();

type Fixture = { path: string; environment: Record<string, string> };

function command(fixture: Fixture, executable: string, args: string[]) {
  return runFixture(executable, {
    args,
    cwd: fixture.path,
    clearEnv: true,
    env: fixture.environment,
    stdout: "piped",
    stderr: "piped",
  });
}

async function git(fixture: Fixture, ...args: string[]) {
  const result = await command(fixture, "git", args);
  assert.equal(result.code, 0, decoder.decode(result.stderr));
  return decoder.decode(result.stdout);
}

async function createFixture(): Promise<Fixture> {
  await mkdir(fixtureRoot, { recursive: true });
  const path = await mkdtemp(fixtureRoot + "/" + "hook-");
  const fixture = {
    path,
    environment: {
      PATH: `${path}/bin:/usr/bin:/bin`,
      HOME: path,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: `${path}/empty-git-config`,
    },
  };
  await mkdir(`${path}/bin`);
  await mkdir(`${path}/.githooks`);
  await writeFile(`${path}/empty-git-config`, "");
  await writeFile(`${path}/.githooks/pre-commit`, await readFile(".githooks/pre-commit", "utf8"));
  await writeFile(
    `${path}/bin/bun`,
    '#!/bin/sh\nset -eu\nprintf "%s\\n" "$*" >> .bun-calls\n[ "$1" = "--no-env-file" ] && shift\nif [ "$1" = "tools/lint/node_modules/.bin/prettier" ]; then exec "$@"; fi\n[ "$*" = "run check" ]\n',
    { mode: 0o755 }
  );
  await mkdir(`${path}/scripts`);
  await writeFile(`${path}/scripts/lint.sh`, '#!/bin/sh\nprintf "lint %s\\n" "$*" >> .gate-calls\n');
  await writeFile(`${path}/scripts/format.sh`, '#!/bin/sh\nprintf "format %s\\n" "$*" >> .gate-calls\n');
  await git(fixture, "-c", "init.templateDir=", "init", "--quiet", "--initial-branch=fixture");
  await writeFile(`${path}/selected.ts`, stagedSource);
  await writeFile(`${path}/foreign.txt`, foreignStaged);
  await git(fixture, "add", "--", "selected.ts", "foreign.txt");
  await writeFile(`${path}/foreign.txt`, foreignWorking);
  await writeFile(`${path}/nonstaged.ts`, nonstagedSource);
  return fixture;
}

async function assertForeignState(fixture: Fixture) {
  assert.equal(await git(fixture, "show", ":foreign.txt"), foreignStaged);
  assert.equal(await readFile(`${fixture.path}/foreign.txt`, "utf8"), foreignWorking);
  assert.equal(await readFile(`${fixture.path}/nonstaged.ts`, "utf8"), nonstagedSource);
  assert.equal(await git(fixture, "diff", "--cached", "--name-only"), "foreign.txt\nselected.ts\n");
  assert.equal(await git(fixture, "ls-files", "--", "nonstaged.ts"), "");
}

test("pre-commit fails with install guidance when staged TypeScript has no Prettier", async () => {
  const fixture = await createFixture();
  try {
    const indexBefore = await readFile(`${fixture.path}/.git/index`);
    const result = await command(fixture, "/bin/sh", [".githooks/pre-commit"]);
    const stderr = decoder.decode(result.stderr);
    assert.equal(result.code, 1, stderr);
    assert.match(stderr, /Prettier is not installed/);
    assert.match(stderr, /tools\/lint/);
    assert.match(stderr, /bun install/);
    assert.match(stderr, /sh scripts\/format\.sh/);
    assert.deepEqual(await readFile(`${fixture.path}/.git/index`), indexBefore);
    assert.equal(await git(fixture, "show", ":selected.ts"), stagedSource);
    assert.equal(await readFile(`${fixture.path}/selected.ts`, "utf8"), stagedSource);
    await assert.rejects(stat(`${fixture.path}/.bun-calls`), fsError("ENOENT"));
    await assertForeignState(fixture);
    console.log(JSON.stringify({ case: "absent-formatter", hookExit: result.code, guidance: stderr.trim(), indexPreserved: true }));
  } finally {
    await rm(fixture.path, { recursive: true });
  }
});

test("pre-commit invokes the owning formatter and restages its repaired TypeScript", async () => {
  const fixture = await createFixture();
  try {
    const formatter = `${fixture.path}/tools/lint/node_modules/.bin`;
    await mkdir(formatter, { recursive: true });
    await writeFile(
      `${formatter}/prettier`,
      `#!/bin/sh\nset -eu\n[ "$#" -eq 2 ] && [ "$1" = "--write" ] && [ "$2" = "selected.ts" ] || exit 70\nprintf '%s\\n' "$*" > .prettier-calls\nprintf 'export const selected = 1;\\n' > "$2"\n`,
      { mode: 0o755 }
    );
    const result = await command(fixture, "/bin/sh", [".githooks/pre-commit"]);
    assert.equal(result.code, 0, decoder.decode(result.stderr));
    assert.equal(await readFile(`${fixture.path}/.prettier-calls`, "utf8"), "--write selected.ts\n");
    assert.equal(await readFile(`${fixture.path}/selected.ts`, "utf8"), formattedSource);
    assert.equal(await git(fixture, "show", ":selected.ts"), formattedSource);
    assert.deepEqual((await readFile(`${fixture.path}/.bun-calls`, "utf8")).trim().split("\n"), [
      "--no-env-file tools/lint/node_modules/.bin/prettier --write selected.ts",
      "--no-env-file run check",
    ]);
    assert.deepEqual((await readFile(`${fixture.path}/.gate-calls`, "utf8")).trim().split("\n"), [
      "lint selected.ts",
      "format --check serve.ts src tests scripts docs",
    ]);
    await assertForeignState(fixture);
    console.log(JSON.stringify({ case: "owning-formatter", hookExit: result.code, repairedSourceRestaged: true, foreignStatePreserved: true }));
  } finally {
    await rm(fixture.path, { recursive: true });
  }
});
