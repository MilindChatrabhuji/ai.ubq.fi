import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const fixturesRoot = resolve(".cleanup-evidence/quality-fixtures");
const fixture = (): string => {
  mkdirSync(fixturesRoot, { recursive: true });
  return mkdtempSync(join(fixturesRoot, "run-"));
};
const run = async (files: readonly string[]): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/test-runner.ts", "files", ...files], {
    env: { PATH: process.env.PATH ?? "", UNLISTED_CREDENTIAL_PROBE: "fixture-only" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
};
test("test runner isolates globals, module state and inherited credentials per file", async () => {
  const directory = fixture();
  try {
    writeFileSync(join(directory, ".env"), "DOTENV_CREDENTIAL_PROBE=fixture-only\n");
    writeFileSync(join(directory, "shared.ts"), "export const state = { touched: false };\n");
    writeFileSync(
      join(directory, "first.test.ts"),
      `import { test, expect } from "bun:test";\nimport { state } from "./shared.ts";\ntest("first process", () => { expect(state.touched).toBe(false); state.touched = true; Reflect.set(globalThis, "fixtureProcessMarker", true); });\n`
    );
    writeFileSync(
      join(directory, "second.test.ts"),
      `import { test, expect } from "bun:test";\nimport { state } from "./shared.ts";\ntest("second process", () => { expect(state.touched).toBe(false); expect(Reflect.has(globalThis, "fixtureProcessMarker")).toBe(false); expect(process.env.UNLISTED_CREDENTIAL_PROBE).toBeUndefined(); expect(process.env.DOTENV_CREDENTIAL_PROBE).toBeUndefined(); expect(process.env.UOS_TEST_PROFILE).toBe("focused"); });\n`
    );
    const result = await run([join(directory, "first.test.ts"), join(directory, "second.test.ts")]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /2 files, 0 failures/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("test runner continues after a failed file and returns failure", async () => {
  const directory = fixture();
  try {
    const receipt = join(directory, "completed.txt");
    writeFileSync(join(directory, "failure.test.ts"), `import { test, expect } from "bun:test";\ntest("failure", () => { expect(1).toBe(2); });\n`);
    writeFileSync(
      join(directory, "continuation.test.ts"),
      `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("continuation", () => { writeFileSync(${JSON.stringify(receipt)}, "completed"); });\n`
    );
    const result = await run([join(directory, "failure.test.ts"), join(directory, "continuation.test.ts")]);
    assert.equal(result.code, 1, result.output);
    assert.equal(readFileSync(receipt, "utf8"), "completed");
    assert.match(result.output, /2 files, 1 failures/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bun dotenv discovery is disabled for disposable fixture processes", async () => {
  const directory = fixture();
  try {
    writeFileSync(join(directory, ".env"), "DOTENV_CREDENTIAL_PROBE=fixture-only\n");
    const check = async (disable: boolean): Promise<string> => {
      const child = Bun.spawn([process.execPath, ...(disable ? ["--no-env-file"] : []), "-e", "console.log(Boolean(process.env.DOTENV_CREDENTIAL_PROBE))"], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      assert.equal(code, 0, error);
      return output.trim();
    };
    assert.equal(await check(false), "true", "The negative control must discover the fixture dotenv");
    assert.equal(await check(true), "false", "The no-env-file process must not load the fixture dotenv");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Bun file-size ratchet refuses growth and new debt, then only tightens ceilings", async () => {
  const directory = fixture();
  try {
    mkdirSync(join(directory, "scripts"));
    writeFileSync(join(directory, "scripts/file-size-ratchet.ts"), readFileSync("scripts/file-size-ratchet.ts", "utf8"));
    const source = join(directory, "oversized.ts");
    const baseline = join(directory, "file-size-baseline.json");
    const initial = '{"oversized.ts":1005}\n';
    writeFileSync(baseline, initial);
    const size = (lines: number): void => {
      writeFileSync(source, "// fixture\n".repeat(lines));
    };
    const check = async (mode: string): Promise<number> => {
      const child = Bun.spawn([process.execPath, "--no-env-file", join(directory, "scripts/file-size-ratchet.ts"), mode], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "ignore",
        stderr: "ignore",
      });
      return await child.exited;
    };
    size(1005);
    assert.equal(await check("--check"), 0);
    size(1006);
    assert.equal(await check("--update"), 1);
    assert.equal(readFileSync(baseline, "utf8"), initial);
    size(1002);
    assert.equal(await check("--check"), 1);
    assert.equal(await check("--update"), 0);
    assert.deepEqual(JSON.parse(readFileSync(baseline, "utf8")), { "oversized.ts": 1002 });
    size(1000);
    assert.equal(await check("--update"), 0);
    assert.deepEqual(JSON.parse(readFileSync(baseline, "utf8")), {});
    writeFileSync(join(directory, "new-debt.ts"), "// fixture\n".repeat(1001));
    assert.equal(await check("--update"), 1);
    assert.deepEqual(JSON.parse(readFileSync(baseline, "utf8")), {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
