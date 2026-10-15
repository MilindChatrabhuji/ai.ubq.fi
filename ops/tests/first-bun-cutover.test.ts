import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  assertHostedCutoverProof,
  recheckCutoverArtifact,
  reuseCutoverPayload,
  type CapturedCutoverArtifact,
  type CutoverArtifactInput,
} from "../cutover-artifact.ts";
import { assertCutoverReaderAcceptance, verifyCutoverReaderAcceptance } from "../cutover-reader-gate.ts";
import { assertCutoverMemoryLimit } from "../cutover-host.ts";
import { executeCutoverTransition, type CutoverPhase, type CutoverTransition } from "../cutover-transition.ts";
import { checkpointCutoverStore, retainedCutoverCopy } from "../cutover-storage.ts";
import { NATIVE_DDL } from "../../src/kv-conversion/native-schema.ts";
import { packStringKey } from "../../src/kv-conversion/cursors.ts";
import { BUN_RUNTIMES } from "../bun-runtime.ts";
import { fileDigest } from "../io.ts";

const parent = fileURLToPath(new URL("../../.cleanup-evidence/first-bun-cutover/", import.meta.url));
async function fixture(work: (root: string) => Promise<void>) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "case-"));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const h = (digit: string) => digit.repeat(64);
const revision = "1".repeat(40);
const artifact: CapturedCutoverArtifact = {
  revision,
  runId: 7,
  artifactId: 8,
  archiveSha256: h("2"),
  archive: "/fixture/archive.zip",
  directory: "/fixture/release",
  manifestSha256: h("3"),
  manifest: {
    schema: 3,
    git_sha: revision,
    source_archive_sha256: h("4"),
    source_tree_sha256: h("5"),
    dependency_lock_sha256: h("6"),
    dependency_tree_sha256: h("7"),
    permissions_tree_sha256: h("8"),
    platform: "linux",
    architecture: "arm64",
    runtime: BUN_RUNTIMES.linux,
    native_kv: {
      tree_sha256: h("9"),
      artifact_sha256: h("a"),
      provenance_sha256: h("b"),
      inputs_sha256: h("c"),
      inputs_manifest: "tools/native-kv/inputs.json",
    },
  },
};

test("cutover protocol captures the live boundary before stop and requires preservation before conversion/start", async () => {
  const events: string[] = [];
  let writer: "deno" | "bun" | null = "deno";
  const effects: CutoverTransition = {
    record: (phase) => {
      events.push(phase);
      return Promise.resolve();
    },
    preflight: () => {
      assert.equal(writer, "deno");
      events.push("live-health");
      return Promise.resolve();
    },
    stop: () => {
      writer = null;
      events.push("actual-stop");
      return Promise.resolve();
    },
    preserve: () => {
      assert.equal(writer, null);
      events.push("checkpoint+backup");
      return Promise.resolve();
    },
    convert: () => {
      assert.equal(writer, null);
      events.push("forward+reverse-proof");
      return Promise.resolve();
    },
    start: () => {
      writer = "bun";
      events.push("actual-start");
      return Promise.resolve();
    },
    verify: () => {
      assert.equal(writer, "bun");
      events.push("new-health");
      return Promise.resolve();
    },
    recover: () => {
      throw new Error("Successful protocol must not recover");
    },
  };
  assert.equal(await executeCutoverTransition(effects), "accepted");
  assert.deepEqual(events, [
    "prepared",
    "live-health",
    "stopping",
    "actual-stop",
    "checkpoint+backup",
    "stopped",
    "forward+reverse-proof",
    "converted",
    "starting",
    "actual-start",
    "candidate_ready",
    "new-health",
    "accepted",
  ]);
});

test("every interrupted protocol phase preserves startup authority and never chooses stale recovery after possible Bun writes", async () => {
  for (const failure of ["preflight", "stop", "preserve", "convert", "start", "verify"] as const) {
    const calls: string[] = [];
    const effect = (name: string) => () => {
      calls.push(name);
      if (name === failure) throw new Error("Interrupted fixture phase");
      return Promise.resolve();
    };
    const effects: CutoverTransition = {
      record: (phase) => {
        calls.push(phase);
        return Promise.resolve();
      },
      preflight: effect("preflight"),
      stop: effect("stop"),
      preserve: effect("preserve"),
      convert: effect("convert"),
      start: effect("start"),
      verify: effect("verify"),
      recover: (started) => {
        calls.push(started ? "reverse-latest" : "original-stopped-source");
        return Promise.resolve();
      },
    };
    if (failure === "preflight") {
      await assert.rejects(executeCutoverTransition(effects), /before service interruption/);
      assert.deepEqual(calls, ["prepared", "preflight"]);
    } else {
      assert.equal(await executeCutoverTransition(effects), "rolled_back");
      assert.ok(calls.includes(["start", "verify"].includes(failure) ? "reverse-latest" : "original-stopped-source"));
      if (["start", "verify"].includes(failure)) assert.equal(calls.includes("original-stopped-source"), false);
    }
  }
});

test("cancellation completes recovery and unproved recovery never records accepted or restored", async () => {
  const controller = new AbortController(),
    phases: CutoverPhase[] = [];
  const noop = () => Promise.resolve();
  const effects: CutoverTransition = {
    record: (phase) => {
      phases.push(phase);
      return Promise.resolve();
    },
    preflight: noop,
    stop: noop,
    preserve: noop,
    convert: () => {
      controller.abort();
      return Promise.resolve();
    },
    start: noop,
    verify: noop,
    recover: (started) => {
      assert.equal(started, false);
      return Promise.resolve();
    },
  };
  assert.equal(await executeCutoverTransition(effects, controller.signal), "rolled_back");
  assert.equal(phases.at(-1), "rolled_back");
  phases.length = 0;
  effects.convert = () => Promise.reject(new Error("Interrupted"));
  effects.recover = () => Promise.reject(new Error("Latest-state proof unavailable"));
  await assert.rejects(executeCutoverTransition(effects), /could not prove latest state/);
  assert.equal(phases.at(-1), "recovery_unproved");
  assert.equal(phases.includes("accepted"), false);
  assert.equal(phases.includes("rolled_back"), false);
});

test("hosted proof requires shipping push identity, every real CI gate and an independently published archive digest", () => {
  const input: CutoverArtifactInput = {
    revision,
    runId: 7,
    artifactId: 8,
    archive: "/fixture/zip",
    directory: "/fixture/release",
    sourceRepository: "/fixture/git",
    workspace: "/fixture/work",
  };
  const run = {
    id: 7,
    head_sha: revision,
    head_branch: "development",
    event: "push",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/deno-deploy.yml",
  };
  const receiver = { id: 8, name: `ai-ubq-fi-source-${revision}`, expired: false, digest: "sha256:" + h("2"), workflow_run: { id: 7, head_sha: revision } };
  const jobs = {
    jobs: ["validate", "mac-containment", "darwin-native", "verify-artifact"].map((name) => ({ name, status: "completed", conclusion: "success" })),
  };
  const ref = { object: { sha: revision } };
  assert.equal(assertHostedCutoverProof(input, run, receiver, jobs, ref), h("2"));
  for (const changed of [
    { ...run, event: "pull_request" },
    { ...run, head_sha: "f".repeat(40) },
    { ...run, conclusion: "failure" },
  ])
    assert.throws(() => assertHostedCutoverProof(input, changed, receiver, jobs, ref));
  assert.throws(() => assertHostedCutoverProof(input, run, { ...receiver, digest: null }, jobs, ref));
  assert.throws(() => assertHostedCutoverProof(input, run, receiver, { jobs: jobs.jobs.slice(1) }, ref));
  assert.throws(() => assertHostedCutoverProof(input, run, receiver, jobs, { object: { sha: "f".repeat(40) } }));
});

test("an unbound artifact cannot copy payloads or bypass mutable-root provenance", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "unrelated-dirty-source"), "preserve this user state");
    await assert.rejects(recheckCutoverArtifact(artifact), /Unbound/);
    await assert.rejects(reuseCutoverPayload(artifact)(root, revision, artifact.manifest.source_archive_sha256), /Unbound/);
    assert.deepEqual(await readdir(root), ["unrelated-dirty-source"]);
    assert.equal(await readFile(join(root, "unrelated-dirty-source"), "utf8"), "preserve this user state");
  }));

function readerContract(proofPath: string, proofSha256: string) {
  const manifest = artifact.manifest;
  const runtime: { archiveSha256: string; binarySha256: string } = BUN_RUNTIMES.linux;
  assert.equal(manifest.schema, 3);
  return {
    schemaVersion: "sentinel-bun-reader-acceptance-v1",
    scope: "frozen-reader-compatibility",
    status: "accepted",
    owner: { threadId: "01a13c8f-3411-7b82-ba62-d048bc6f87c7", role: "sentinel-integration-owner" },
    gateway: {
      repository: "ubiquity/ai.ubq.fi",
      gitSha: revision,
      artifactId: 8,
      artifactZipSha256: artifact.archiveSha256,
      releaseManifestSha256: artifact.manifestSha256,
      sourceTreeSha256: manifest.source_tree_sha256,
      dependencyLockSha256: manifest.dependency_lock_sha256,
      dependencyTreeSha256: manifest.dependency_tree_sha256,
      permissionsTreeSha256: manifest.permissions_tree_sha256,
      nativeKv: {
        treeSha256: manifest.native_kv.tree_sha256,
        artifactSha256: manifest.native_kv.artifact_sha256,
        provenanceSha256: manifest.native_kv.provenance_sha256,
        inputsSha256: manifest.native_kv.inputs_sha256,
      },
    },
    sentinel: {
      repository: "ubiquity/sentinel",
      canonicalGitSha: "e".repeat(40),
      readerGitSha: "d".repeat(40),
      readerInputsSha256: h("1"),
      bootstrapSha256: h("2"),
      permissionsNativeSha256: h("3"),
    },
    runtime: {
      name: "bun",
      version: "1.4.0",
      platform: "linux",
      architecture: "arm64",
      archiveSha256: runtime.archiveSha256,
      binarySha256: runtime.binarySha256,
    },
    execution: {
      platform: "linux",
      architecture: "arm64",
      kernel: "contract-fixture-kernel",
      landlockAbi: 8,
      isolation: "bwrap+landlock-tsync+seccomp-tsync",
      environmentMode: "allowlisted-no-dotenv",
      dependencyMode: "verified-offline-no-install",
    },
    evidence: [
      "positive-baseline",
      "original-composed-causal-pair",
      "consuming-replay-proof",
      "source-runtime-graph-tamper",
      "outside-read-denied",
      "source-write-denied",
      "temporary-write-denied",
      "external-network-denied",
      "shell-exec-denied",
      "bun-self-spawn-denied",
      "execve-denied",
      "execveat-denied",
      "immutable-inputs",
      "cleanup-settled",
    ].map((name) => ({ name, outcome: "passed", receiptPath: proofPath, receiptSha256: proofSha256, commandExitCode: 0 })),
    completedAt: new Date(0).toISOString(),
  };
}

test("Sentinel contract rejects draft, mismatched inputs, absent denials, unsupported isolation and duplicate evidence", () => {
  const receipt = readerContract("/fixture/proof", h("4"));
  assert.equal(assertCutoverReaderAcceptance(receipt, artifact).length, 14);
  for (const change of [
    (r: typeof receipt) => {
      r.status = "draft-unaccepted";
    },
    (r: typeof receipt) => {
      r.gateway.gitSha = "f".repeat(40);
    },
    (r: typeof receipt) => {
      r.runtime.binarySha256 = h("e");
    },
    (r: typeof receipt) => {
      r.execution.landlockAbi = 7;
    },
    (r: typeof receipt) => {
      r.evidence[0].outcome = "denied";
    },
    (r: typeof receipt) => {
      r.evidence[0].commandExitCode = 1;
    },
    (r: typeof receipt) => {
      r.evidence[0].name = r.evidence[1].name;
    },
    (r: typeof receipt) => {
      r.evidence.pop();
    },
  ]) {
    const changed = structuredClone(receipt);
    change(changed);
    assert.throws(() => assertCutoverReaderAcceptance(changed, artifact), /acceptance is unavailable/);
  }
});

test("reader acceptance requires pinned private bytes and unchanged retained evidence, not the receipt's own claim", async () =>
  fixture(async (root) => {
    const proof = join(root, "proof.json"),
      path = join(root, "owner-acceptance.json");
    await writeFile(proof, '{"contract_fixture":true}\n', { mode: 0o600 });
    const receipt = readerContract(proof, await fileDigest(proof));
    await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
    const pin = { path, sha256: await fileDigest(path) };
    await verifyCutoverReaderAcceptance(pin, artifact);
    await writeFile(proof, "changed synthetic evidence\n");
    await assert.rejects(verifyCutoverReaderAcceptance(pin, artifact));
    await writeFile(path, JSON.stringify({ ...receipt, status: "draft-unaccepted" }));
    await assert.rejects(verifyCutoverReaderAcceptance(pin, artifact));
  }));

test("a global unlimited cgroup override cannot satisfy the cutover budget", () => {
  assertCutoverMemoryLimit(2_147_483_648, "2147483648");
  for (const observed of ["max", "4294967296", "0", "2147483648\n"])
    assert.throws(() => {
      assertCutoverMemoryLimit(2_147_483_648, observed);
    });
});

test("stopped SQLite checkpoint retains all rows and rejects oversized values before conversion", async () =>
  fixture(async (root) => {
    const path = join(root, "legacy.sqlite3"),
      backup = join(root, "backup.sqlite3");
    const db = new Database(path);
    for (const sql of NATIVE_DDL) db.run(sql);
    db.run("INSERT INTO migration_state VALUES(0,3)");
    db.run("INSERT INTO data_version VALUES(0,1,0)");
    const insert = db.query("INSERT INTO kv VALUES(?,?,?,?,?,?)");
    insert.run(packStringKey(["synthetic", "retained"]), new Uint8Array([0, 255]), 3, 1, 0, 1_900_000_000_000);
    db.close(true);
    const stopped = await checkpointCutoverStore(path, "deno-v8");
    assert.equal(stopped.sha256, await retainedCutoverCopy(path, backup));
    assert.equal((await lstat(backup)).mode & 0o777, 0o600);
    const preserved = new Database(backup, { readonly: true });
    assert.equal(preserved.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM kv").get()?.count, 1);
    preserved.close(true);
    const malformed = new Database(path);
    malformed.query("UPDATE kv SET v=?").run(new Uint8Array(65_537));
    malformed.close(true);
    await assert.rejects(checkpointCutoverStore(path, "deno-v8"), /per-value memory bound/);
  }));

test("database-scale hashing streams under a small measured RSS increase", async () =>
  fixture(async (root) => {
    const path = join(root, "sparse-database-fixture"),
      bytes = 192 * 1024 * 1024;
    await writeFile(path, "", { mode: 0o600 });
    await truncate(path, bytes);
    const hash = createHash("sha256"),
      block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 192; i++) hash.update(block);
    const source = fileURLToPath(new URL("../io.ts", import.meta.url));
    const script = `import {fileDigest} from ${JSON.stringify(source)}; const before=process.resourceUsage().maxRSS;
    const sha256=await fileDigest(${JSON.stringify(path)}); const growth=process.resourceUsage().maxRSS-before;
    if(growth>65536) throw new Error("Whole-database allocation detected"); console.log(JSON.stringify({sha256,growth}));`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", script], { env: {}, stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, errors);
    assert.equal((JSON.parse(output) as { sha256: string }).sha256, hash.digest("hex"));
  }));
