import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  protocol: string;
  privateRuntimeRevision: number;
  storageSchemaVersion: number;
  v3Assertions: string[];
  state: string;
  mode: string;
  mixedAcceptance: string;
  versions: Record<string, string>;
  actualSQLiteDurableObject: boolean;
  actualBunHttpClients: number;
  originalActualBunHttpClients: number;
  nativeBindingVerificationClients: number;
  actualWorkerClients: boolean;
  providerCalls: number;
  originalProviderCalls: number;
  reviews: { id: string; clients: { bun: number; worker: number } }[];
  children: number;
  assertions: string[];
  phases: { name: string }[];
  sourceHashes: Record<string, string>;
  fixtureHashes: Record<string, string>;
  fixtureImports: string[];
  bundleSha256: string;
  persistedFiles: string[];
  final: { paidRequestCount: number; paidRequestBytes: number; permanentRollups: number; permanentGuards: number };
  control: {
    state: string;
    orderedCaseIds: string[];
    cases: {
      id: string;
      clients: { bun: number; worker: number };
      before: { doId: string };
      after: { doId: string; active: number; clients: { bun: number; worker: number }; rows: Record<string, unknown[]>; verifications: unknown[] };
    }[];
    clients: { bun: number; worker: number };
    cleanupCalls: number;
    sqliteObjects: string[];
  };
};

test("real mixed Bun HTTP and Worker clients preserve native authority contention, histories, persistence and transport", async () => {
  if (process.platform !== "linux" || process.arch !== "arm64" || process.env.TEST_SCOPE_ACTIVE !== "1")
    throw new Error("Mixed authority acceptance requires the existing isolated Linux ARM64 test runner");
  expect(Bun.version).toBe("1.4.0");
  const runtime = readWorkerTestRuntime(ROOT);
  const runtimeReceiptBytes = readFileSync(resolve(ROOT, ".tmp/worker-test-runtime/linux-arm64/receipt.json"));
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
    const reportBytes = readFileSync(reportPath);
    const report = JSON.parse(reportBytes.toString("utf8")) as MixedReport;
    expect(report.state).toBe("local-native-authority-runtime-pass");
    expect(report.protocol).toBe("native-gateway-runtime-v3");
    expect(report.privateRuntimeRevision).toBe(3);
    expect(report.storageSchemaVersion).toBe(3);
    expect(report.v3Assertions).toContain("retired v2 admission DTO refuses with unchanged actual SQLite projection");
    expect(report.v3Assertions).toContain("actual SQLite meta and private binding grants report revision3");
    expect(report.mode).toBe("mixed");
    expect(report.mixedAcceptance).toBe("passed");
    expect(report.versions).toEqual({ node: "v24.21.0", miniflare: "5.20261012.1-beta", workerd: "1.20261012.1", esbuild: "0.28.2" });
    expect(report.fixtureImports).toEqual([
      "../../../src/authority/native-authority-contracts.ts",
      "../../../src/authority/native-authority-rpc.ts",
      "../../../src/authority/native-authority-sql.ts",
      "../../../src/authority/native-authority.ts",
      "../../../src/authority/native-codex-contracts.ts",
      "../../../src/authority/native-paid.ts",
      "./principal-control-sources.mjs",
      "cloudflare:workers",
    ]);
    expect(report.actualSQLiteDurableObject).toBe(true);
    expect(report.actualWorkerClients).toBe(true);
    expect(report.actualBunHttpClients).toBeGreaterThanOrEqual(12);
    expect(report.originalProviderCalls).toBe(3);
    expect(report.providerCalls).toBe(5);
    expect(report.reviews.map((item) => item.id)).toEqual([
      "F01",
      "F02-terminal",
      "F02-delivery",
      "F02-start",
      "F02-provider",
      "F03",
      "F04",
      "F05",
      "F06",
      "F07",
      "F08",
      "F09",
      "F10",
      "F11",
      "F12",
      "F13",
      "transport-tuple",
      "R2-paid-start",
      "R2-shared-pagination",
      "R2-provider-usage",
      "R2-prefetch-release",
      "R2-refresh-revision",
    ]);
    expect(report.reviews.every((item) => item.clients.bun > 0 && item.clients.worker > 0)).toBe(true);
    expect(report.control.state).toBe("passed");
    expect(report.control.orderedCaseIds).toEqual(Array.from({ length: 28 }, (_, index) => "P" + String(index + 1).padStart(2, "0")));
    expect(report.control.cases.map((item) => item.id)).toEqual(report.control.orderedCaseIds);
    expect(new Set(report.control.sqliteObjects).size).toBe(28);
    expect(report.control.clients.bun).toBeGreaterThanOrEqual(28);
    expect(report.control.clients.worker).toBeGreaterThanOrEqual(28);
    expect(report.control.cleanupCalls).toBeGreaterThanOrEqual(7);
    expect(report.originalActualBunHttpClients).toBeGreaterThanOrEqual(12);
    expect(report.nativeBindingVerificationClients).toBe(1);
    expect(report.actualBunHttpClients).toBe(report.originalActualBunHttpClients + report.control.clients.bun);
    for (const item of report.control.cases) {
      expect(item.clients.bun).toBeGreaterThan(0);
      expect(item.clients.worker).toBeGreaterThan(0);
      expect(item.after.clients.bun).toBeGreaterThan(0);
      expect(item.after.clients.worker).toBeGreaterThan(0);
      expect(item.after.active).toBe(0);
      expect(item.after.doId).toBe(item.before.doId);
      expect(item.after.verifications.length).toBeGreaterThan(0);
      for (const table of ["api_key_id", "api_key_hash", "key_control_grant", "key_control_receipt", "api_key_audit", "paid_deletion_guard"])
        expect(Array.isArray(item.after.rows[table]), table).toBe(true);
    }
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
      ["principal-control-cases.mjs", new URL("./fixtures/native-authority/principal-control-cases.mjs", import.meta.url)],
      ["principal-control-sources.mjs", new URL("./fixtures/native-authority/principal-control-sources.mjs", import.meta.url)],
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
    for (const path of [
      "src/authority/native-runtime-contracts.ts",
      "src/authority/native-authority-runtime.ts",
      "src/authority/native-principal-contracts.ts",
      "src/authority/native-authority-principals.ts",
      "src/paid-fallback/index.ts",
      "src/auth/local-development-key.ts",
      "src/provider/metered.ts",
    ])
      expect(typeof report.sourceHashes[path], path).toBe("string");
    const bundlePath = resolve(dirname(reportPath), "workerd-bundle.mjs");
    expect(createHash("sha256").update(readFileSync(bundlePath)).digest("hex")).toBe(report.bundleSha256);
    const evidenceDirectory = resolve(ROOT, ".tmp/native-authority-evidence");
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    expect(realpathSync(evidenceDirectory)).toBe(evidenceDirectory);
    const retainedReportPath = resolve(evidenceDirectory, "mixed-runtime-result.json");
    const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
    const runtimeReceiptSha256 = createHash("sha256").update(runtimeReceiptBytes).digest("hex");
    writeFileSync(retainedReportPath, reportBytes, { mode: 0o600 });
    writeFileSync(resolve(evidenceDirectory, "worker-runtime-receipt.json"), runtimeReceiptBytes, { mode: 0o600 });
    writeFileSync(
      resolve(evidenceDirectory, "SHA256SUMS"),
      `${reportSha256}  mixed-runtime-result.json\n${runtimeReceiptSha256}  worker-runtime-receipt.json\n`,
      { mode: 0o600 }
    );
    console.log(
      JSON.stringify({
        mixedAcceptance: report.mixedAcceptance,
        assertions: report.assertions,
        phases: PHASES,
        paidRows: report.final.paidRequestCount,
        reportPath,
        retainedReportPath,
        reportSha256,
        runtimeReceiptSha256,
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
