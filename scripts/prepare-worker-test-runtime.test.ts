import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertWorkerTestPlatform,
  readWorkerTestRuntime,
  verifyWorkerTestArchive,
  workerTestDependencyIdentity,
  workerTestRuntimeInputs,
} from "./prepare-worker-test-runtime.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "uos-worker-runtime-test-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const put = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
};
const binary = (): Uint8Array => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(183, 18);
  return bytes;
};
const fixture = () => {
  const root = mkdtempSync(join(scratch, "repository-"));
  const devDependencies = { miniflare: "5.20261012.1-beta", esbuild: "0.28.2" };
  const packages = Object.fromEntries(workerTestRuntimeInputs.packages.map((pin) => [pin.name, [`${pin.name}@${pin.version}`, "", {}, pin.integrity]]));
  put(join(root, "package.json"), { name: "synthetic-worker-tooling", devDependencies });
  put(join(root, "bun.lock"), { workspaces: { "": { devDependencies } }, packages });
  put(join(root, "tools/worker-test-runtime/inputs.json"), workerTestRuntimeInputs);
  put(join(root, "scripts/prepare-worker-test-runtime.ts"), "synthetic source identity only; never executed");
  for (const pin of workerTestRuntimeInputs.packages) {
    const base = join(root, "node_modules", pin.name);
    const extra = pin.name.startsWith("@") ? { os: ["linux"], cpu: ["arm64"] } : {};
    const dependencies = pin.name === "miniflare" ? { workerd: "1.20261012.1" } : undefined;
    let optionalDependencies: Record<string, string> | undefined;
    if (pin.name === "workerd") optionalDependencies = { "@cloudflare/workerd-linux-arm64": "1.20261012.1" };
    if (pin.name === "esbuild") optionalDependencies = { "@esbuild/linux-arm64": "0.28.2" };
    put(join(base, "package.json"), { name: pin.name, version: pin.version, dependencies, optionalDependencies, ...extra });
    const entry = join(base, pin.entry);
    mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
    writeFileSync(entry, pin.name.startsWith("@") ? binary() : "// synthetic package; never imported\n", { mode: 0o700 });
  }
  return root;
};
const receiptFor = (root: string) => {
  const sources = Object.fromEntries(
    ["package.json", "bun.lock", "tools/worker-test-runtime/inputs.json", "scripts/prepare-worker-test-runtime.ts"].map((path) => [
      path,
      hash(readFileSync(join(root, path))),
    ])
  );
  const directory = join(root, ".tmp/worker-test-runtime/linux-arm64");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    schemaVersion: 1,
    repository: root,
    platform: "linux-arm64",
    sources,
    dependencies: workerTestDependencyIdentity(root),
    preparationDirectory: join(directory, "prepare-synthetic"),
  };
};
const saveReceipt = (root: string, receipt: unknown): void => {
  put(join(root, ".tmp/worker-test-runtime/linux-arm64/receipt.json"), receipt);
};

describe("pinned Worker runtime preparation failures", () => {
  test("checksum corruption is rejected for Node hex pins and npm SRI before archive publication", () => {
    const original = Buffer.from("bounded synthetic archive bytes");
    const corrupted = Buffer.from("bounded synthetic archive byteS");
    const sha256 = hash(original);
    const sri = "sha512-" + createHash("sha512").update(original).digest("base64");
    expect(() => {
      verifyWorkerTestArchive(original, sha256);
    }).not.toThrow();
    expect(() => {
      verifyWorkerTestArchive(original, sri);
    }).not.toThrow();
    for (const pin of [sha256, sri, "invalid checksum"])
      expect(() => {
        verifyWorkerTestArchive(corrupted, pin);
      }).toThrow("checksum mismatch");
  });

  test("unsupported platforms fail without a runtime destination or a platform fallback", () => {
    const root = fixture();
    expect(() => {
      assertWorkerTestPlatform("darwin", "arm64");
    }).toThrow("Linux ARM64");
    expect(() => {
      assertWorkerTestPlatform("linux", "x64");
    }).toThrow("Linux ARM64");
    expect(() => {
      assertWorkerTestPlatform("linux", "arm64");
    }).not.toThrow();
    expect(existsSync(join(root, ".tmp"))).toBe(false);
  });

  test("missing dependencies and stale frozen lock integrity fail without executing a tool", () => {
    const missing = fixture();
    rmSync(join(missing, "node_modules/miniflare"), { recursive: true });
    expect(() => workerTestDependencyIdentity(missing)).toThrow();
    const mismatched = fixture();
    const lock = JSON.parse(readFileSync(join(mismatched, "bun.lock"), "utf8"));
    lock.packages.miniflare[3] = "sha512-corrupted";
    put(join(mismatched, "bun.lock"), lock);
    expect(() => workerTestDependencyIdentity(mismatched)).toThrow("lock version/integrity mismatch");
    const undeclared = fixture();
    put(join(undeclared, "package.json"), { devDependencies: { esbuild: "0.28.2" } });
    expect(() => workerTestDependencyIdentity(undeclared)).toThrow("exact frozen root devDependency");
  });

  test("installed package versions, graph edges and executable architecture remain independently checked", () => {
    const root = fixture();
    expect(workerTestDependencyIdentity(root).packages).toHaveLength(5);
    const workerdMetadata = join(root, "node_modules/workerd/package.json");
    const original = JSON.parse(readFileSync(workerdMetadata, "utf8"));
    put(workerdMetadata, { ...original, version: "1.20261012.2" });
    expect(() => workerTestDependencyIdentity(root)).toThrow("installed package mismatch");
    put(workerdMetadata, { ...original, optionalDependencies: { "@cloudflare/workerd-linux-arm64": "1.0.0" } });
    expect(() => workerTestDependencyIdentity(root)).toThrow("optional binary version mismatch");
    put(workerdMetadata, original);
    const entry = join(root, "node_modules/@cloudflare/workerd-linux-arm64/bin/workerd");
    const wrongArchitecture = Buffer.from(binary());
    wrongArchitecture.writeUInt16LE(62, 18);
    writeFileSync(entry, wrongArchitecture);
    expect(() => workerTestDependencyIdentity(root)).toThrow("not Linux ARM64 ELF");
    writeFileSync(entry, binary());
    chmodSync(entry, 0o600);
    expect(() => workerTestDependencyIdentity(root)).toThrow("not executable");
  });

  test("missing/offline receipts never cause preparation and modified source invalidates existing provenance", () => {
    const root = fixture();
    const receipt = receiptFor(root);
    expect(() => readWorkerTestRuntime(root)).toThrow();
    saveReceipt(root, receipt);
    writeFileSync(join(root, "scripts/prepare-worker-test-runtime.ts"), "changed source");
    expect(() => readWorkerTestRuntime(root)).toThrow("source provenance changed");
    expect(existsSync(receipt.preparationDirectory)).toBe(false);
  });

  test("modified installed code and cross-repository receipts cannot reuse a runtime binding", () => {
    const root = fixture();
    const receipt = receiptFor(root);
    saveReceipt(root, { ...receipt, repository: scratch });
    expect(() => readWorkerTestRuntime(root)).toThrow("receipt identity mismatch");
    saveReceipt(root, receipt);
    writeFileSync(join(root, "node_modules/miniflare/dist/src/index.js"), "// modified after preparation");
    expect(() => readWorkerTestRuntime(root)).toThrow("dependency provenance changed");
  });

  test("receipt destinations and symlinked scratch roots are refused before any executable is reached", () => {
    const root = fixture();
    const receipt = receiptFor(root);
    saveReceipt(root, { ...receipt, preparationDirectory: join(scratch, "prepare-outside") });
    expect(() => readWorkerTestRuntime(root)).toThrow("preparation path mismatch");
    const linked = fixture();
    symlinkSync(scratch, join(linked, ".tmp"), "dir");
    expect(() => readWorkerTestRuntime(linked)).toThrow("owned physical directory");
  });
});
