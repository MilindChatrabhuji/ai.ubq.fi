import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkerTestRuntime } from "../scripts/prepare-worker-test-runtime.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSERTIONS = [
  "20 independent Worker protocol clients share native API quota2",
  "20 kernel contenders share limit2;18 refusals retain explicit native API release histories",
  "actual SQLite retains402paid rows above262144bytes, permanent rollup/deletion guard, paged backfill resumes after full runtime disposal",
  "20 actual mixed Bun HTTP/Worker contenders share APIlimit2 and concurrent kernel limit2 across principals and keys",
  "simultaneous real Bun HTTP and Worker clients shareDO; actual synthetic JSON/SSE plus abort preserve observed/pending delivery truth",
];
const PHASES = [
  "API reserve",
  "paid dispatch intent",
  "provider dispatch observation",
  "semantic/kernel terminal independent of billing",
  "billing settlement",
];
type MixedReport = {
  state: string;
  mode: string;
  mixedAcceptance: string;
  versions: Record<string, string>;
  actualSQLiteDurableObject: boolean;
  actualBunHttpClients: number;
  actualWorkerClients: boolean;
  providerCalls: number;
  children: number;
  assertions: string[];
  phases: { name: string }[];
  sourceHashes: Record<string, string>;
  fixtureHashes: Record<string, string>;
  fixtureImports: string[];
  bundleSha256: string;
  persistedFiles: string[];
  final: { paidRequestCount: number; paidRequestBytes: number; permanentRollups: number; permanentGuards: number };
};

test("real mixed Bun HTTP and Worker clients preserve native authority contention, histories, persistence and transport", async () => {
  if (process.platform !== "linux" || process.arch !== "arm64" || process.env.TEST_SCOPE_ACTIVE !== "1")
    throw new Error("Mixed authority acceptance requires the existing isolated Linux ARM64 test runner");
  expect(Bun.version).toBe("1.4.0");
  const runtime = readWorkerTestRuntime(ROOT);
  const child = Bun.spawn(
    [runtime.nodePath, fileURLToPath(new URL("./fixtures/native-authority/mixed-client-workerd.mjs", import.meta.url)), ROOT, process.execPath, "mixed"],
    {
      cwd: ROOT,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: runtime.directory, TEST_SCOPE_ACTIVE: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, 240_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr + stdout).toBe(0);
    const lines = stdout.split("\n").filter((line) => line.startsWith("UOS_NATIVE_AUTHORITY_MIXED="));
    expect(lines).toHaveLength(1);
    const summary = JSON.parse(lines[0].slice("UOS_NATIVE_AUTHORITY_MIXED=".length)) as { reportPath: string };
    const reportPath = realpathSync(summary.reportPath);
    const local = relative(resolve(ROOT, ".tmp"), reportPath);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Mixed authority report escaped task-local scratch");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as MixedReport;
    expect(report.state).toBe("local-native-authority-runtime-pass");
    expect(report.mode).toBe("mixed");
    expect(report.mixedAcceptance).toBe("passed");
    expect(report.versions).toEqual({ node: "v24.21.0", miniflare: "5.20261012.1-beta", workerd: "1.20261012.1", esbuild: "0.28.2" });
    expect(report.fixtureImports).toEqual([
      "../../../src/authority/native-authority-rpc.ts",
      "../../../src/authority/native-authority.ts",
      "cloudflare:workers",
    ]);
    expect(report.actualSQLiteDurableObject).toBe(true);
    expect(report.actualWorkerClients).toBe(true);
    expect(report.actualBunHttpClients).toBeGreaterThanOrEqual(12);
    expect(report.providerCalls).toBe(3);
    expect(report.children).toBe(0);
    expect(report.assertions).toEqual(ASSERTIONS);
    expect(report.phases.map((phase) => phase.name)).toEqual(PHASES);
    expect(report.final.paidRequestCount).toBe(402);
    expect(report.final.paidRequestBytes).toBeGreaterThan(262_144);
    expect(report.final.permanentRollups).toBe(1);
    expect(report.final.permanentGuards).toBe(1);
    expect(report.persistedFiles.some((path) => path.endsWith(".sqlite"))).toBe(true);
    for (const [name, url] of [
      ["fixture-worker.mjs", new URL("./fixtures/native-authority/fixture-worker.mjs", import.meta.url)],
      ["bun-client.ts", new URL("./fixtures/native-authority/bun-client.ts", import.meta.url)],
      ["mixed-client-workerd.mjs", new URL("./fixtures/native-authority/mixed-client-workerd.mjs", import.meta.url)],
    ] as const) {
      expect(createHash("sha256").update(readFileSync(url)).digest("hex"), name).toBe(report.fixtureHashes[name]);
    }
    for (const [path, expected] of Object.entries(report.sourceHashes)) {
      const actual = createHash("sha256")
        .update(readFileSync(resolve(ROOT, path)))
        .digest("hex");
      expect(actual, path).toBe(expected);
    }
    for (const module of ["contracts", "sql", "api", "kernel", "codex", "paid", "rpc", ""]) {
      const suffix = module === "" ? "native-authority.ts" : `native-authority-${module}.ts`;
      expect(
        Object.keys(report.sourceHashes).some((path) => path.endsWith(`src/authority/${suffix}`)),
        suffix
      ).toBe(true);
    }
    const bundlePath = resolve(dirname(reportPath), "workerd-bundle.mjs");
    expect(createHash("sha256").update(readFileSync(bundlePath)).digest("hex")).toBe(report.bundleSha256);
    console.log(
      JSON.stringify({
        mixedAcceptance: report.mixedAcceptance,
        assertions: report.assertions,
        phases: PHASES,
        paidRows: report.final.paidRequestCount,
        reportPath,
      })
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}, 300_000);
