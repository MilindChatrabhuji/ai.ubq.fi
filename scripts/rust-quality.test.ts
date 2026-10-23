import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const fixturesRoot = resolve(".cleanup-evidence/rust-quality-fixtures");
const scriptText = readFileSync("scripts/rust-quality.ts", "utf8");

const fixture = (): string => {
  mkdirSync(fixturesRoot, { recursive: true });
  return mkdtempSync(join(fixturesRoot, "run-"));
};

const prepare = (directory: string): void => {
  mkdirSync(join(directory, "scripts"), { recursive: true });
  writeFileSync(join(directory, "scripts/rust-quality.ts"), scriptText);
};

const writeRust = (directory: string, crate: string, path: string, text: string): void => {
  const location = join(directory, "rust", "crates", crate, path);
  mkdirSync(dirname(location), { recursive: true });
  writeFileSync(location, text);
};

const lines = (count: number): string => "// fixture\n".repeat(count);

const run = async (directory: string, ...args: string[]): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(directory, "scripts/rust-quality.ts"), ...args], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
};

const baselineText = (directory: string): string => readFileSync(join(directory, "rust/quality-baseline.json"), "utf8");
const baselineValue = (directory: string): { crates: Record<string, number>; violations: Record<string, Record<string, number>> } =>
  JSON.parse(baselineText(directory));
const expectCode = (result: { code: number; output: string }, code: number): void => assert.equal(result.code, code, result.output);
const expectText = (result: { output: string }, text: string): void => assert.ok(result.output.includes(text), result.output);

test("rust quality refuses new oversized crates and growth, then tightens ceilings only through --update", async () => {
  const directory = fixture();
  try {
    prepare(directory);
    writeRust(directory, "big", "src/lib.rs", lines(1001));
    writeRust(directory, "gone", "src/lib.rs", lines(1002));
    writeRust(directory, "small", "src/lib.rs", lines(50));

    const missingBaseline = await run(directory);
    expectCode(missingBaseline, 1);
    expectText(missingBaseline, "rust/quality-baseline.json is missing");

    const init = await run(directory, "--init");
    expectCode(init, 0);
    expectText(init, "recorded 2 oversized crates");
    assert.deepEqual(baselineValue(directory).crates, { big: 1001, gone: 1002 });
    const check = await run(directory, "--check");
    expectCode(check, 0);
    expectText(check, "2 oversized crates");

    rmSync(join(directory, "rust/crates/gone"), { recursive: true });
    const missingCrate = await run(directory);
    expectCode(missingCrate, 1);
    expectText(missingCrate, "rust/crates/gone: recorded ceiling has no first-party crate");
    const dropMissingCrate = await run(directory, "--update");
    expectCode(dropMissingCrate, 0);
    expectText(dropMissingCrate, "dropped rust/crates/gone: no such first-party crate");
    assert.deepEqual(baselineValue(directory).crates, { big: 1001 });

    writeRust(directory, "new", "src/lib.rs", lines(1001));
    const newCrate = await run(directory, "--check");
    expectCode(newCrate, 1);
    expectText(newCrate, "rust/crates/new: 1001 production lines exceeds the 1000-line crate cap and has no recorded ceiling");
    const refusedNewCrate = await run(directory, "--update");
    expectCode(refusedNewCrate, 1);
    expectText(refusedNewCrate, "update never adds debt");
    assert.deepEqual(baselineValue(directory).crates, { big: 1001 });
    rmSync(join(directory, "rust/crates/new"), { recursive: true });

    writeRust(directory, "big", "src/lib.rs", lines(1002));
    const growth = await run(directory);
    expectCode(growth, 1);
    expectText(growth, "rust/crates/big: grew to 1002 production lines from its recorded ceiling of 1001");
    const refusedGrowth = await run(directory, "--update");
    expectCode(refusedGrowth, 1);
    expectText(refusedGrowth, "revert the growth before tightening");
    assert.deepEqual(baselineValue(directory).crates, { big: 1001 });

    writeRust(directory, "big", "src/lib.rs", lines(1000));
    const shrink = await run(directory);
    expectCode(shrink, 1);
    expectText(
      shrink,
      "rust/crates/big: now 1000 production lines, within the 1000-line crate cap; run `bun run rust:quality:update` to drop its 1001-line ceiling"
    );
    const tighten = await run(directory, "--update");
    expectCode(tighten, 0);
    expectText(tighten, "dropped rust/crates/big");
    assert.deepEqual(baselineValue(directory).crates, {});

    const reinit = await run(directory, "--init");
    expectCode(reinit, 1);
    expectText(reinit, "already exists; use --update to tighten it");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rust quality counts each violation category per file, ignores include_str and include_bytes, and only removes debt through --update", async () => {
  const directory = fixture();
  try {
    prepare(directory);
    const clean = 'const TEXT: &str = include_str!("fixture.txt");\nconst BYTES: &[u8] = include_bytes!("fixture.bin");\n';
    const violationFile = 'pub use crate::Thing;\n#[path = "other.rs"] mod other;\ninclude!("support.rs");\n';
    writeRust(directory, "rules", "src/clean.rs", clean);
    writeRust(directory, "rules", "tests/rules.rs", violationFile);

    const init = await run(directory, "--init");
    expectCode(init, 0);
    const initial = baselineValue(directory);
    assert.deepEqual(initial.violations, {
      pubUse: { "rust/crates/rules/tests/rules.rs": 1 },
      path: { "rust/crates/rules/tests/rules.rs": 1 },
      include: { "rust/crates/rules/tests/rules.rs": 1 },
    });
    assert.equal(initial.violations.include["rust/crates/rules/src/clean.rs"], undefined);
    assert.deepEqual(initial.crates, {});
    const cleanCheck = await run(directory, "--check");
    expectCode(cleanCheck, 0);
    expectText(cleanCheck, "1 pubUse + 1 #[path] + 1 include! violations");

    writeRust(directory, "rules", "tests/rules.rs", `${violationFile}pub use crate::Other;\n`);
    const growth = await run(directory);
    expectCode(growth, 1);
    expectText(growth, "rust/crates/rules/tests/rules.rs: pub use count grew to 2 from 1; revert the growth");
    const refusedGrowth = await run(directory, "--update");
    expectCode(refusedGrowth, 1);
    assert.equal(baselineText(directory), JSON.stringify(initial, null, 2) + "\n");

    writeRust(directory, "rules", "tests/rules.rs", 'pub use crate::Thing;\n#[path = "other.rs"] mod other;\n');
    const shrink = await run(directory);
    expectCode(shrink, 1);
    expectText(shrink, "rust/crates/rules/tests/rules.rs: include! count shrank to 0 from 1; run `bun run rust:quality:update` to tighten it");
    const tighten = await run(directory, "--update");
    expectCode(tighten, 0);
    expectText(tighten, "dropped rust/crates/rules/tests/rules.rs [include!]");
    assert.deepEqual(baselineValue(directory).violations.include, {});

    writeRust(directory, "rules", "src/clean.rs", `${clean}pub use crate::Forwarded;\n`);
    const newPubUse = await run(directory);
    expectCode(newPubUse, 1);
    expectText(newPubUse, "rust/crates/rules/src/clean.rs: pub use count is 1, but no baseline count is recorded");
    expectCode(await run(directory, "--update"), 1);

    writeRust(directory, "rules", "src/clean.rs", `${clean}#[path = "elsewhere.rs"] mod elsewhere;\n`);
    const newPath = await run(directory);
    expectCode(newPath, 1);
    expectText(newPath, "rust/crates/rules/src/clean.rs: #[path] count is 1, but no baseline count is recorded");
    expectCode(await run(directory, "--update"), 1);

    writeRust(directory, "rules", "src/clean.rs", `${clean}include!("generated.rs");\n`);
    const newInclude = await run(directory);
    expectCode(newInclude, 1);
    expectText(newInclude, "rust/crates/rules/src/clean.rs: include! count is 1, but no baseline count is recorded");
    expectCode(await run(directory, "--update"), 1);

    writeRust(directory, "rules", "src/clean.rs", clean);
    const cleanAgain = await run(directory);
    expectCode(cleanAgain, 0);

    rmSync(join(directory, "rust/crates/rules/tests/rules.rs"));
    const missingFile = await run(directory);
    expectCode(missingFile, 1);
    expectText(missingFile, "rust/crates/rules/tests/rules.rs: recorded violation path has no Rust source file");
    const dropMissingFile = await run(directory, "--update");
    expectCode(dropMissingFile, 0);
    assert.deepEqual(baselineValue(directory).violations, { pubUse: {}, path: {}, include: {} });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
