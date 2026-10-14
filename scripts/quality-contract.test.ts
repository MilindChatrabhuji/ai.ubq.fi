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

const runnerFixture = (directory: string): void => {
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "tests"));
  writeFileSync(join(directory, "scripts/test-runner.ts"), readFileSync("scripts/test-runner.ts", "utf8"));
  writeFileSync(join(directory, "bun.lock"), "{}\n");
};
const runFixture = async (directory: string, args: readonly string[]): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(directory, "scripts/test-runner.ts"), ...args], {
    cwd: directory,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(directory, "home"),
      DENO_DIR: join(directory, "cache"),
      DENO_NO_UPDATE_CHECK: "1",
      DEEPSEEK_API_KEY: "fixture-provider",
      METERED_API_KEY: "fixture-metered",
      SURPLUS_API_KEY: "fixture-surplus",
      UOS_AI_TOKEN: "fixture-client",
      DENO_DEPLOY_TOKEN: "fixture-admin",
      UNLISTED_CREDENTIAL_PROBE: "fixture-only",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
};
test("focused main runs exactly the requested files with their original environment profiles", async () => {
  const directory = fixture();
  try {
    runnerFixture(directory);
    const receipt = join(directory, "executed.jsonl");
    const cases = [
      { file: "selected.test.ts", profile: "main", provider: "fixture-provider", metered: "fixture-metered", client: undefined },
      { file: "oss-gateway-http.test.ts", profile: "oss", provider: "fixture-provider", metered: undefined, client: undefined },
      { file: "usage-optimization-measurement.test.ts", profile: "measurement", provider: undefined, metered: undefined, client: "fixture-client" },
    ];
    for (const item of cases) {
      writeFileSync(
        join(directory, "tests", item.file),
        `import { test, expect } from "bun:test";\nimport { appendFileSync } from "node:fs";\ntest("selected fixture", () => { expect(process.env.UOS_TEST_PROFILE).toBe(${JSON.stringify(item.profile)}); expect(process.env.DEEPSEEK_API_KEY).toBe(${JSON.stringify(item.provider)}); expect(process.env.METERED_API_KEY).toBe(${JSON.stringify(item.metered)}); expect(process.env.UOS_AI_TOKEN).toBe(${JSON.stringify(item.client)}); expect(process.env.UNLISTED_CREDENTIAL_PROBE).toBeUndefined(); appendFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(item.profile + "\n")}); });\n`
      );
    }
    writeFileSync(join(directory, "tests/omitted.test.ts"), 'throw new Error("An unselected file executed");\n');
    const result = await runFixture(directory, ["main", ...cases.map((item) => `tests/${item.file}`)]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /3 files, 0 failures/);
    assert.deepEqual(readFileSync(receipt, "utf8").trim().split("\n"), ["main", "oss", "measurement"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("focused selection refuses excluded and unknown files; sentinel consumer keeps its own profile", async () => {
  const directory = fixture();
  try {
    runnerFixture(directory);
    const consumer = "tests/sentinel-replay-consumer.test.ts";
    writeFileSync(
      join(directory, consumer),
      `import { test, expect } from "bun:test";\ntest("consumer fixture", () => { expect(process.env.UOS_TEST_PROFILE).toBe("sentinel-consumer"); expect(process.env.HOME).toBe(${JSON.stringify(join(directory, "home"))}); expect(process.env.DENO_NO_UPDATE_CHECK).toBe("1"); expect(process.env.DEEPSEEK_API_KEY).toBeUndefined(); expect(process.env.UOS_AI_TOKEN).toBeUndefined(); });\n`
    );
    const excluded = await runFixture(directory, ["main", consumer]);
    assert.equal(excluded.code, 1, excluded.output);
    assert.match(excluded.output, /use segment sentinel/);
    const unknown = await runFixture(directory, ["main", "tests/unknown.test.ts"]);
    assert.equal(unknown.code, 1, unknown.output);
    assert.match(unknown.output, /excluded or unknown/);
    const accepted = await runFixture(directory, ["sentinel", consumer]);
    assert.equal(accepted.code, 0, accepted.output);
    assert.match(accepted.output, /1 files, 0 failures/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("first-party library sources stay capped and the exact Jev acceptance harness uses the test ceiling", async () => {
  const directory = fixture();
  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "lib/jev_compaction"), { recursive: true });
    mkdirSync(join(directory, "lib/codex"), { recursive: true });
    writeFileSync(join(directory, "scripts/file-size-ratchet.ts"), readFileSync("scripts/file-size-ratchet.ts", "utf8"));
    writeFileSync(join(directory, "file-size-baseline.json"), "{}\n");
    writeFileSync(join(directory, "lib/codex/upstream.ts"), "// upstream\n".repeat(2000));
    const source = join(directory, "lib/jev_compaction/source.ts");
    const acceptance = join(directory, "lib/jev_compaction/jev-codex-smoke.ts");
    const check = async (): Promise<number> => {
      const child = Bun.spawn([process.execPath, "--no-env-file", join(directory, "scripts/file-size-ratchet.ts")], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "ignore",
        stderr: "ignore",
      });
      return await child.exited;
    };
    writeFileSync(source, "// source\n".repeat(1000));
    writeFileSync(acceptance, "// acceptance\n".repeat(1500));
    assert.equal(await check(), 0);
    writeFileSync(source, "// source\n".repeat(1001));
    assert.equal(await check(), 1);
    writeFileSync(source, "// source\n".repeat(1000));
    writeFileSync(acceptance, "// acceptance\n".repeat(1501));
    assert.equal(await check(), 1);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "file-size-baseline.json"), "utf8")), {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
