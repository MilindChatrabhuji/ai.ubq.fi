import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { currentTestNativeKvBinding } from "./test-native-kv.ts";

const bindingArgument = (): string => "--native-kv-binding=" + JSON.stringify(currentTestNativeKvBinding());

const fixturesRoot = resolve(".cleanup-evidence/quality-fixtures");
const fixture = (): string => {
  mkdirSync(fixturesRoot, { recursive: true });
  return mkdtempSync(join(fixturesRoot, "run-"));
};
const run = async (files: readonly string[]): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "scripts/test-runner.ts", "files", ...files, bindingArgument()], {
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
  symlinkSync(resolve("scripts/test-network.ts"), join(directory, "scripts/test-network.ts"));
  symlinkSync(resolve("scripts/test-native-kv.ts"), join(directory, "scripts/test-native-kv.ts"));
  writeFileSync(join(directory, "bun.lock"), "{}\n");
};
const runFixture = async (directory: string, args: readonly string[]): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", join(directory, "scripts/test-runner.ts"), ...args, bindingArgument()], {
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
    if (process.platform === "linux") {
      assert.equal(accepted.code, 0, accepted.output);
      assert.match(accepted.output, /1 files, 0 failures/);
    } else {
      assert.equal(accepted.code, 1, accepted.output);
      assert.match(accepted.output, /excluded or unknown/);
    }
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

test("benchmark selection covers both original test directories and keeps focused files exact", async () => {
  const list = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "scripts/test-runner.ts", "benchmark", "--list"], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [listCode, listed, listError] = await Promise.all([list.exited, new Response(list.stdout).text(), new Response(list.stderr).text()]);
  assert.equal(listCode, 0, listError);
  const directory = fixture();
  try {
    runnerFixture(directory);
    mkdirSync(join(directory, "benchmarks/tests"), { recursive: true });
    mkdirSync(join(directory, "benchmarks/baselines/tests"), { recursive: true });
    const groups: unknown = JSON.parse(listed);
    assert.ok(Array.isArray(groups));
    const [benchmark] = groups as { files: string[] }[];
    assert.equal(benchmark.files.length, 14);
    assert.equal(benchmark.files.filter((path) => path.startsWith("benchmarks/baselines/tests/")).length, 4);
    const selected = ["benchmarks/tests/selected.test.ts", "benchmarks/baselines/tests/selected.test.ts"];
    for (const path of selected) {
      writeFileSync(
        join(directory, path),
        'import { test, expect } from "bun:test";\ntest("selected benchmark", () => { expect(process.env.UOS_TEST_PROFILE).toBe("benchmark"); expect(process.env.DEEPSEEK_API_KEY).toBeUndefined(); });\n'
      );
    }
    writeFileSync(join(directory, "benchmarks/tests/omitted.test.ts"), 'throw new Error("Unselected benchmark ran");\n');
    const result = await runFixture(directory, ["benchmark", ...selected]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /2 files, 0 failures/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parent watchdog stops a synchronous loop and its descendant before continuing", async () => {
  const directory = fixture();
  try {
    runnerFixture(directory);
    const heartbeat = join(directory, "heartbeat.txt");
    const completed = join(directory, "completed.txt");
    const beatProgram = `import { appendFileSync } from "node:fs"; setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, "beat\\n"), 25);`;
    writeFileSync(
      join(directory, "tests/00-loop.test.ts"),
      `import { test } from "bun:test";\ntest("synchronous loop", () => { Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", ${JSON.stringify(beatProgram)}], { stdout: "ignore", stderr: "ignore" }); while (true) {} });\n`
    );
    writeFileSync(
      join(directory, "tests/01-continuation.test.ts"),
      `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("continuation", () => writeFileSync(${JSON.stringify(completed)}, "completed"));\n`
    );
    const started = Date.now();
    const result = await runFixture(directory, ["main", "--file-timeout-ms=2000", "tests/00-loop.test.ts", "tests/01-continuation.test.ts"]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Wall-time limit exceeded/);
    assert.match(result.output, /exit 124/);
    assert.match(result.output, /2 files, 1 failures/);
    assert.ok(result.output.indexOf("main: tests/00-loop.test.ts") < result.output.indexOf("main: tests/01-continuation.test.ts"), result.output);
    assert.ok(Date.now() - started < 10_000, result.output);
    assert.equal(readFileSync(completed, "utf8"), "completed");
    assert.ok(existsSync(heartbeat), "The descendant negative control must have run");
    const stopped = readFileSync(heartbeat, "utf8");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    assert.equal(readFileSync(heartbeat, "utf8"), stopped, "The deadline must settle the descendant too");
    const invalid = await runFixture(directory, ["main", "--file-timeout-ms=0", "tests/01-continuation.test.ts"]);
    assert.equal(invalid.code, 1, invalid.output);
    assert.match(invalid.output, /must be an integer/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Markdown preserves authored paragraph lines while the negative control wraps them", async () => {
  const paragraph = "This authored paragraph stays on one line while the existing Markdown print width remains unchanged. ".repeat(4).trim() + "\n";
  const format = async (wrap?: string): Promise<string> => {
    const args = [
      process.execPath,
      "--no-env-file",
      "--no-install",
      "tools/lint/node_modules/.bin/prettier",
      "--config",
      ".prettierrc",
      "--parser",
      "markdown",
    ];
    if (wrap !== undefined) args.push("--prose-wrap=" + wrap);
    const child = Bun.spawn(args, {
      env: { PATH: process.env.PATH ?? "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.stdin.write(paragraph);
    await child.stdin.end();
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, error);
    return output;
  };
  assert.equal(await format(), paragraph);
  assert.ok((await format("always")).trim().includes("\n"), "The control must wrap the same paragraph");
});

test("runner children keep local TCP and Unix sockets but cannot reach the parent network namespace", async () => {
  const directory = fixture();
  const socketDirectory = mkdtempSync(join(tmpdir(), "uos-quality-net-"));
  const tcp = createServer((socket) => socket.end("parent-tcp"));
  const unix = createServer((socket) => socket.end("parent-unix"));
  try {
    runnerFixture(directory);
    const socketPath = join(socketDirectory, "parent.sock");
    await Promise.all([new Promise<void>((ready) => tcp.listen(0, "127.0.0.1", ready)), new Promise<void>((ready) => unix.listen(socketPath, ready))]);
    const address = tcp.address();
    assert.ok(address !== null && typeof address !== "string");
    writeFileSync(
      join(directory, "tests/transport.test.ts"),
      `import { test, expect } from "bun:test";\nimport { createConnection, createServer } from "node:net";\nconst read = (options) => new Promise((resolve, reject) => { const socket = createConnection(options); const parts = []; socket.on("data", chunk => parts.push(chunk)); socket.on("end", () => resolve(Buffer.concat(parts).toString())); socket.on("error", reject); socket.setTimeout(1000, () => socket.destroy(new Error("transport timeout"))); });\ntest("kernel network boundary", async () => { await expect(read({ host: ${JSON.stringify(process.platform === "darwin" ? "192.0.2.1" : "127.0.0.1")}, port: ${address.port} })).rejects.toThrow(); expect(await read({ path: ${JSON.stringify(socketPath)} })).toBe("parent-unix"); const local = createServer(socket => socket.end("child-local")); await new Promise(ready => local.listen(0, "127.0.0.1", ready)); try { expect(await read({ host: "127.0.0.1", port: local.address().port })).toBe("child-local"); } finally { await new Promise(ready => local.close(ready)); } });\n`
    );
    const result = await runFixture(directory, ["main", "tests/transport.test.ts"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /1 files, 0 failures/);
  } finally {
    await Promise.all([
      new Promise<void>((closed) =>
        tcp.close(() => {
          closed();
        })
      ),
      new Promise<void>((closed) =>
        unix.close(() => {
          closed();
        })
      ),
    ]);
    rmSync(directory, { recursive: true, force: true });
    rmSync(socketDirectory, { recursive: true, force: true });
  }
});

test("combined verify includes the benchmark stage after an earlier failed gate", async () => {
  const directory = fixture();
  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "tools/lint/node_modules/.bin"), { recursive: true });
    for (const path of ["node_modules/@types/bun", "node_modules/@types/node", "node_modules/typescript/bin"]) {
      mkdirSync(join(directory, path), { recursive: true });
    }
    for (const path of [
      "bun.lock",
      "tools/lint/bun.lock",
      "node_modules/@types/bun/index.d.ts",
      "node_modules/@types/node/index.d.ts",
      "node_modules/typescript/bin/tsc",
    ]) {
      writeFileSync(join(directory, path), "fixture\n");
    }
    for (const name of ["eslint", "prettier", "knip"]) {
      const path = join(directory, "tools/lint/node_modules/.bin", name);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o700);
    }
    const binaryDirectory = join(directory, "bin");
    mkdirSync(binaryDirectory);
    const fakeBun = join(binaryDirectory, "bun");
    writeFileSync(
      fakeBun,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.4.0\\n"; exit 0; fi\nprintf "%s\\n" "$*" >> "$UOS_GATE_RECEIPT"\ncase "$*" in *" run check"*) exit 1 ;; esac\nexit 0\n'
    );
    chmodSync(fakeBun, 0o700);
    for (const name of ["verify.sh", "_bootstrap.sh"]) {
      writeFileSync(join(directory, "scripts", name), readFileSync(join("scripts", name), "utf8"));
    }
    const receipt = join(directory, "gates.txt");
    const child = Bun.spawn(["/bin/sh", "scripts/verify.sh", bindingArgument()], {
      cwd: directory,
      env: { PATH: binaryDirectory + ":/usr/bin:/bin", UOS_GATE_RECEIPT: receipt },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 1, output + error);
    const invoked = readFileSync(receipt, "utf8").trim().split("\n");
    assert.equal(invoked.filter((line) => line.includes("scripts/test-runner.ts benchmark --native-kv-binding=")).length, 1);
    assert.equal(invoked.filter((line) => line.includes("scripts/test-runner.ts vps --native-kv-binding=")).length, 1);
    assert.ok(invoked.some((line) => line.includes("scripts/test-runner.ts main --native-kv-binding=")));
    assert.ok(invoked.some((line) => line.includes("scripts/test-runner.ts sentinel --native-kv-binding=")));
    assert.match(output, /benchmark harness and baselines/);
    assert.match(output, /verify: FAILED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
