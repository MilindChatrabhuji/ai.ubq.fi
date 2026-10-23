import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const fixturesRoot = resolve(".cleanup-evidence/rust-quality-fixtures");
const scriptText = readFileSync("scripts/rust-quality.ts", "utf8");
const inheritedManifest = "[lints]\nworkspace = true\n";

const fixture = (): string => {
  mkdirSync(fixturesRoot, { recursive: true });
  return mkdtempSync(join(fixturesRoot, "run-"));
};

const prepare = (directory: string): void => {
  mkdirSync(join(directory, "scripts"), { recursive: true });
  writeFileSync(join(directory, "scripts/rust-quality.ts"), scriptText);
};

const writeManifest = (directory: string, crate: string, text: string): void => {
  const location = join(directory, "rust", "crates", crate, "Cargo.toml");
  mkdirSync(dirname(location), { recursive: true });
  writeFileSync(location, text);
};

const ensureManifest = (directory: string, crate: string): void => {
  if (!existsSync(join(directory, "rust", "crates", crate, "Cargo.toml"))) writeManifest(directory, crate, inheritedManifest);
};

const writeRust = (directory: string, crate: string, path: string, text: string): void => {
  ensureManifest(directory, crate);
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
const baselineValue = (
  directory: string
): {
  crates: Record<string, number>;
  violations: Record<"pubUse" | "path" | "include" | "suppression", Record<string, number>>;
} => JSON.parse(baselineText(directory));
const expectCode = (result: { code: number; output: string }, code: number): void => {
  assert.equal(result.code, code, result.output);
};
const expectText = (result: { output: string }, text: string): void => {
  assert.ok(result.output.includes(text), result.output);
};

test("rust quality refuses new oversized crates and growth, then tightens ceilings only through --update", async () => {
  const directory = fixture();
  try {
    prepare(directory);
    writeRust(directory, "big", "src/lib.rs", lines(1001));
    writeRust(directory, "big", "tests/unbounded.rs", lines(2000));
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

test("rust quality catches visible re-exports, path attributes, plain include, and suppressions without flagging private or literal forms", async () => {
  const directory = fixture();
  try {
    prepare(directory);
    const visibility = `pub use crate::A;
pub(crate) use crate::B;
pub(super) use crate::C;
pub(in crate::scope) use crate::D;
pub
use crate::E;
pub extern crate legacy_f;
pub(in crate::scope) extern crate legacy_g;
pub(self) use crate::PrivateOne;
use crate::PrivateTwo;
pub mod allowed;
pub(crate) mod also_allowed;
const STRING: &str = "pub use crate::Fake;";
const RAW_STRING: &str = r#"pub use crate::Fake;"#;
// pub use crate::Fake;
/* pub use crate::Fake; */
`;
    const rules = `#![allow(dead_code)]
#[path = "direct.rs"]
mod direct;
#[cfg_attr(feature = "x", path = "conditional.rs")]
mod conditional;
#[cfg_attr(
  not(feature = "x"),
  cfg_attr(any(), path = "nested.rs")
)]
mod nested;
#[expect(clippy::unwrap_used)]
fn expected() {}
#[cfg_attr(feature = "y", allow(clippy::too_many_arguments))]
fn allowed() {}
#[cfg_attr(test, cfg_attr(not(test), expect(dead_code)))]
fn nested_expect() {}
include!("one.rs");
std::include!("two.rs");
r#include!("raw.rs");
const TEXT: &str = include_str!("data.txt");
const BYTES: &[u8] = include_bytes!("data.bin");
const FAKE: &str = "include!(\\"fake.rs\\")";
// include!("fake.rs");
/* #[path = "fake.rs"] */
`;
    writeRust(directory, "rules", "src/visibility.rs", visibility);
    writeRust(directory, "rules", "tests/rules.rs", rules);

    const init = await run(directory, "--init");
    expectCode(init, 0);
    const initial = baselineValue(directory);
    assert.deepEqual(initial.violations, {
      pubUse: { "rust/crates/rules/src/visibility.rs": 7 },
      path: { "rust/crates/rules/tests/rules.rs": 3 },
      include: { "rust/crates/rules/tests/rules.rs": 3 },
      suppression: { "rust/crates/rules/tests/rules.rs": 4 },
    });
    assert.deepEqual(initial.crates, {});
    const cleanCheck = await run(directory, "--check");
    expectCode(cleanCheck, 0);
    expectText(cleanCheck, "7 visible re-exports + 3 #[path] + 3 include! + 4 allow/expect violations");

    writeRust(directory, "rules", "tests/rules.rs", `${rules}#[allow(unused)]\n`);
    const growth = await run(directory);
    expectCode(growth, 1);
    expectText(growth, "rust/crates/rules/tests/rules.rs: allow/expect count grew to 5 from 4; revert the growth");
    const refusedGrowth = await run(directory, "--update");
    expectCode(refusedGrowth, 1);
    assert.equal(baselineText(directory), JSON.stringify(initial, null, 2) + "\n");

    const tightenedRules = rules.replace("#![allow(dead_code)]\n", "");
    writeRust(directory, "rules", "tests/rules.rs", tightenedRules);
    const shrink = await run(directory);
    expectCode(shrink, 1);
    expectText(shrink, "rust/crates/rules/tests/rules.rs: allow/expect count shrank to 3 from 4; run `bun run rust:quality:update` to tighten it");
    const tighten = await run(directory, "--update");
    expectCode(tighten, 0);
    expectText(tighten, "tightened rust/crates/rules/tests/rules.rs [allow/expect]: 4 -> 3");
    assert.equal(baselineValue(directory).violations.suppression["rust/crates/rules/tests/rules.rs"], 3);

    writeRust(directory, "rules", "src/visibility.rs", `${visibility}pub(crate) use crate::FakeAgain;\n`);
    const newPubUse = await run(directory);
    expectCode(newPubUse, 1);
    expectText(newPubUse, "rust/crates/rules/src/visibility.rs: visible re-export count grew to 8 from 7; revert the growth");
    expectCode(await run(directory, "--update"), 1);
    writeRust(directory, "rules", "src/visibility.rs", visibility);

    writeRust(directory, "rules", "tests/rules.rs", `${tightenedRules}#[cfg_attr(feature = "z", path = "elsewhere.rs")]\nmod elsewhere {}\n`);
    const newPath = await run(directory);
    expectCode(newPath, 1);
    expectText(newPath, "rust/crates/rules/tests/rules.rs: #[path] count grew to 4 from 3; revert the growth");
    expectCode(await run(directory, "--update"), 1);
    writeRust(directory, "rules", "tests/rules.rs", tightenedRules);

    writeRust(directory, "rules", "tests/rules.rs", `${tightenedRules}include!("three.rs");\n`);
    const newInclude = await run(directory);
    expectCode(newInclude, 1);
    expectText(newInclude, "rust/crates/rules/tests/rules.rs: include! count grew to 4 from 3; revert the growth");
    expectCode(await run(directory, "--update"), 1);
    writeRust(directory, "rules", "tests/rules.rs", tightenedRules);

    rmSync(join(directory, "rust/crates/rules/tests/rules.rs"));
    const missingFile = await run(directory);
    expectCode(missingFile, 1);
    expectText(missingFile, "rust/crates/rules/tests/rules.rs: recorded violation path has no Rust source file");
    const dropMissingFile = await run(directory, "--update");
    expectCode(dropMissingFile, 0);
    assert.deepEqual(baselineValue(directory).violations, {
      pubUse: { "rust/crates/rules/src/visibility.rs": 7 },
      path: {},
      include: {},
      suppression: {},
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rust quality requires every first-party manifest to inherit workspace lints", async () => {
  const directory = fixture();
  try {
    prepare(directory);
    writeRust(directory, "rules", "src/lib.rs", "pub fn okay() {}\n");
    const init = await run(directory, "--init");
    expectCode(init, 0);

    writeManifest(directory, "rules", '[package]\nname = "rules"\nversion = "0.0.0"\n');
    const missing = await run(directory, "--check");
    expectCode(missing, 1);
    expectText(missing, "rust/crates/rules/Cargo.toml: missing [lints] with workspace = true");
    const refused = await run(directory, "--update");
    expectCode(refused, 1);
    expectText(refused, "missing [lints] with workspace = true");
    assert.deepEqual(baselineValue(directory).violations.pubUse, {});

    writeManifest(directory, "rules", '[package]\nname = "rules"\nversion = "0.0.0"\n\n[workspace.lints]\nunsafe_code = "forbid"\n');
    const nestedOnly = await run(directory, "--check");
    expectCode(nestedOnly, 1);
    expectText(nestedOnly, "rust/crates/rules/Cargo.toml: missing [lints] with workspace = true");

    writeManifest(directory, "rules", '[package]\nname = "rules"\nversion = "0.0.0"\n\n[lints]\nworkspace = false\n');
    const falseInheritance = await run(directory, "--check");
    expectCode(falseInheritance, 1);
    expectText(falseInheritance, "rust/crates/rules/Cargo.toml: missing [lints] with workspace = true");

    writeManifest(directory, "rules", "- not toml\n");
    const malformed = await run(directory, "--check");
    expectCode(malformed, 1);
    expectText(malformed, "rust/crates/rules/Cargo.toml: missing [lints] with workspace = true");

    writeManifest(directory, "rules", "# inherited below\n[lints] # policy\nworkspace = true # required\n");
    const inherited = await run(directory, "--check");
    expectCode(inherited, 0);

    rmSync(join(directory, "rust/crates/rules/Cargo.toml"));
    const absent = await run(directory, "--check");
    expectCode(absent, 1);
    expectText(absent, "rust/crates/rules/Cargo.toml: first-party crate has no Cargo.toml with [lints] workspace = true");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rust quality refuses to initialize while manifest inheritance is missing", async () => {
  const directory = fixture();
  try {
    prepare(directory);
    writeManifest(directory, "rules", '[package]\nname = "rules"\nversion = "0.0.0"\n');
    writeRust(directory, "rules", "src/lib.rs", "pub fn okay() {}\n");
    const init = await run(directory, "--init");
    expectCode(init, 1);
    expectText(init, "manifest policy problems");
    assert.equal(existsSync(join(directory, "rust/quality-baseline.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
