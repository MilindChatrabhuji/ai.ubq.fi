import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  assertHostedCutoverProof,
  captureCutoverArtifact,
  recheckCutoverArtifact,
  reuseCutoverPayload,
  verifyCutoverCandidate,
  type CapturedCutoverArtifact,
  type CutoverArtifactInput,
} from "../cutover-artifact.ts";
import { assertCutoverReaderAcceptance, cutoverReaderGateBinding, verifyCutoverReaderAcceptance, verifyCutoverReaderGate } from "../cutover-reader-gate.ts";
import { cutoverRequestDigest, type FirstBunCutoverInput } from "../first-bun-cutover.ts";
import { assertCutoverMemoryLimit, boundedCutoverHolderCheck } from "../cutover-host.ts";
import { assertCutoverDropin, assertCutoverExecStart, cutoverDropinDigest, cutoverSupervisorUnit } from "../cutover-unit.ts";
import { executeCutoverTransition, type CutoverPhase, type CutoverTransition } from "../cutover-transition.ts";
import { checkedCutoverBudgets, checkpointCutoverStore, cutoverSourceBytes, retainedCutoverCopy, withCutoverCodecProbe } from "../cutover-storage.ts";
import { preserveUnstartedCutover, verifyPreparedCutover } from "../cutover-recovery.ts";
import { NATIVE_DDL } from "../../src/kv-conversion/native-schema.ts";
import { packStringKey } from "../../src/kv-conversion/cursors.ts";
import { BUN_RUNTIMES } from "../bun-runtime.ts";
import { fileDigest, treeDigest } from "../io.ts";
import { prepareReleasePayload, verifyReleasePayload } from "../release-artifact.ts";
import { currentTestNativeKvBinding } from "../../scripts/test-native-kv.ts";
import { repository, writePackage } from "./fixture-release.ts";
import { fixtureCommand } from "./vps-release-driver-fixture.ts";
import type { StoredVpsPrior } from "../vps-release-store.ts";
import { writeVpsAtomic } from "../vps-release-journal.ts";

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

async function ownerWaiver(root: string) {
  const instruction = join(root, "user-instruction.json"),
    path = join(root, "owner-waiver.json");
  await writeFile(
    instruction,
    JSON.stringify({
      v: 1,
      status: "owner-instruction-record",
      scope: "external-Sentinel-reader-only",
      source: "user messages in this task",
      instructions: ["Ignore Sentinel for this first Bun cutover"],
      note: "Synthetic operator-recorded instruction fixture, not a signature or external acceptance.",
    }),
    { mode: 0o600 }
  );
  const { gateway, runtime } = readerContract("/unused-synthetic-evidence", h("4"));
  const body = {
    schemaVersion: "uos-first-bun-cutover-reader-waiver-v1",
    scope: "external-Sentinel-reader-only",
    status: "owner-waived",
    gateway,
    runtime,
    instruction: { path: instruction, sha256: await fileDigest(instruction) },
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const publish = async (value = body) => {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return { kind: "owner-waived" as const, receipt: { path, sha256: await fileDigest(path) } };
  };
  return { body, publish, gate: await publish(), instruction, path };
}

test("an explicit owner waiver verifies exact artifact and instruction bytes but never passes the accepted-reader parser", async () =>
  fixture(async (root) => {
    const value = await ownerWaiver(root);
    assert.equal(await verifyCutoverReaderGate(value.gate, artifact), "owner-waived");
    assert.equal(cutoverReaderGateBinding(value.gate).kind, "owner-waived");
    assert.throws(() => assertCutoverReaderAcceptance(value.body, artifact), /acceptance is unavailable/);
    await assert.rejects(verifyCutoverReaderGate({ ...value.gate, kind: "accepted" }, artifact));
    const proof = join(root, "accepted-proof");
    await writeFile(proof, "synthetic accepted-reader evidence", { mode: 0o600 });
    const accepted = join(root, "accepted.json");
    await writeFile(accepted, JSON.stringify(readerContract(proof, await fileDigest(proof))), { mode: 0o600 });
    const receipt = { path: accepted, sha256: await fileDigest(accepted) };
    assert.equal(await verifyCutoverReaderGate({ kind: "accepted", receipt }, artifact), "accepted");
    await assert.rejects(verifyCutoverReaderGate({ kind: "owner-waived", receipt }, artifact));
    await writeFile(value.instruction, "changed instruction, not an authorization");
    await assert.rejects(verifyCutoverReaderGate(value.gate, artifact));
  }));

test("missing, ambiguous, legacy and unknown gate inputs fail before any stopping intent", async () =>
  fixture(async (root) => {
    const value = await ownerWaiver(root);
    const inputs: unknown[] = [
      undefined,
      null,
      value.gate.receipt,
      { ...value.gate, kind: "skip" },
      { ...value.gate, acceptance: value.gate.receipt },
      { ...value.gate, waiver: value.gate.receipt },
      { ...value.gate, receipt: { ...value.gate.receipt, path: "relative.json" } },
      { ...value.gate, receipt: { ...value.gate.receipt, extra: true } },
    ];
    for (const input of inputs) {
      let stopped = false;
      const noop = () => Promise.resolve();
      await assert.rejects(
        executeCutoverTransition({
          record: noop,
          preflight: async () => {
            await verifyCutoverReaderGate(input, artifact);
          },
          stop: () => {
            stopped = true;
            return Promise.resolve();
          },
          preserve: noop,
          convert: noop,
          start: noop,
          verify: noop,
          recover: noop,
        }),
        /before service interruption/
      );
      assert.equal(stopped, false);
    }
  }));

test("owner waiver refuses expired, forged, cross-artifact, runtime and instruction bindings before stop", async () =>
  fixture(async (root) => {
    const value = await ownerWaiver(root);
    const changes: ((body: typeof value.body) => void)[] = [
      (body) => {
        body.status = "accepted";
      },
      (body) => {
        body.scope = "all-production-gates";
      },
      (body) => {
        body.expiresAt = new Date(0).toISOString();
      },
      (body) => {
        body.issuedAt = new Date(Date.now() + 60_000).toISOString();
      },
      (body) => {
        body.gateway.gitSha = "f".repeat(40);
      },
      (body) => {
        body.gateway.artifactId++;
      },
      (body) => {
        body.gateway.artifactZipSha256 = h("e");
      },
      (body) => {
        body.gateway.releaseManifestSha256 = h("e");
      },
      (body) => {
        body.gateway.sourceTreeSha256 = h("e");
      },
      (body) => {
        body.gateway.dependencyLockSha256 = h("e");
      },
      (body) => {
        body.gateway.dependencyTreeSha256 = h("e");
      },
      (body) => {
        body.gateway.permissionsTreeSha256 = h("e");
      },
      (body) => {
        body.gateway.nativeKv.artifactSha256 = h("e");
      },
      (body) => {
        body.gateway.nativeKv.provenanceSha256 = h("e");
      },
      (body) => {
        body.gateway.nativeKv.inputsSha256 = h("e");
      },
      (body) => {
        body.runtime.binarySha256 = h("e");
      },
      (body) => {
        body.runtime.platform = "darwin";
      },
      (body) => {
        body.instruction.sha256 = h("e");
      },
      (body) => {
        Object.assign(body, { accepted: true });
      },
    ];
    for (const change of changes) {
      const body = structuredClone(value.body);
      change(body);
      const gate = await value.publish(body);
      let stopped = false;
      const noop = () => Promise.resolve();
      await assert.rejects(
        executeCutoverTransition({
          record: noop,
          preflight: async () => {
            await verifyCutoverReaderGate(gate, artifact);
          },
          stop: () => {
            stopped = true;
            return Promise.resolve();
          },
          preserve: noop,
          convert: noop,
          start: noop,
          verify: noop,
          recover: noop,
        }),
        /before service interruption/
      );
      assert.equal(stopped, false);
    }
    await value.publish();
    await chmod(value.instruction, 0o644);
    await assert.rejects(verifyCutoverReaderGate(value.gate, artifact));
    await chmod(value.instruction, 0o600);
    const link = join(root, "instruction-link");
    await symlink(value.instruction, link);
    const body = structuredClone(value.body);
    body.instruction.path = link;
    await assert.rejects(verifyCutoverReaderGate(await value.publish(body), artifact));
    await value.publish();
    await chmod(value.path, 0o644);
    await assert.rejects(verifyCutoverReaderGate(value.gate, artifact));
  }));

test("owner-waived kind and hash survive journal serialization and latest-state recovery ownership", async () =>
  fixture(async (root) => {
    const value = await ownerWaiver(root);
    const input: FirstBunCutoverInput = {
      artifact,
      priorRevision: "f".repeat(40),
      denoBinary: "/fixture/deno",
      denoSha256: h("d"),
      supervisorMemoryBytes: 2_147_483_648,
      budgets: { conversionAndProofMs: 60_000, recoveryConversionMs: 60_000, recoveryProofMs: 60_000 },
      authorization: { path: "/fixture/authorization", sha256: h("a") },
      offlineArtifact: { path: "/fixture/offline", sha256: h("b") },
      reader: value.gate,
    };
    const requestDigest = cutoverRequestDigest(input);
    assert.notEqual(cutoverRequestDigest({ ...input, reader: { ...value.gate, kind: "accepted" } }), requestDigest);
    assert.notEqual(cutoverRequestDigest({ ...input, reader: { ...value.gate, receipt: { ...value.gate.receipt, sha256: h("e") } } }), requestDigest);
    const recovered = JSON.parse(JSON.stringify(input)) as FirstBunCutoverInput;
    assert.equal(cutoverRequestDigest(recovered), requestDigest);
    const binding = cutoverReaderGateBinding(recovered.reader),
      journal = join(root, "operation.json");
    let reverseLatest = false;
    const noop = () => Promise.resolve();
    const phase = await executeCutoverTransition({
      record: async (phase) => {
        await writeVpsAtomic(journal, { phase, readerGateKind: binding.kind, readerReceiptSha256: binding.sha256, requestDigest });
      },
      preflight: async () => {
        assert.equal(await verifyCutoverReaderGate(recovered.reader, artifact), "owner-waived");
      },
      stop: noop,
      preserve: noop,
      convert: noop,
      start: () => Promise.reject(new Error("Possible Bun startup requires latest-state recovery")),
      verify: noop,
      recover: async (started) => {
        assert.equal(started, true);
        const persisted = JSON.parse(await readFile(journal, "utf8")) as Record<string, unknown>;
        assert.equal(persisted.readerGateKind, "owner-waived");
        assert.equal(persisted.readerReceiptSha256, binding.sha256);
        assert.equal(persisted.requestDigest, cutoverRequestDigest(recovered));
        reverseLatest = true;
      },
    });
    assert.equal(phase, "rolled_back");
    assert.equal(reverseLatest, true);
    assert.equal((JSON.parse(await readFile(journal, "utf8")) as { readerGateKind: string }).readerGateKind, "owner-waived");
  }));

test("relocated immutable operator imports its complete existing module closure", async () =>
  fixture(async (root) => {
    await cp(join(repository, "ops"), join(root, "ops"), { recursive: true });
    await cp(join(repository, "src"), join(root, "src"), { recursive: true });
    await copyFile(join(repository, "package.json"), join(root, "package.json"));
    await symlink(join(repository, "node_modules"), join(root, "node_modules"));
    const script = `const operator=await import(${JSON.stringify(join(root, "ops/first-bun-cutover.ts"))});if(typeof operator.runFirstBunCutover!=="function"||typeof operator.recoverFirstBunCutover!=="function")throw new Error("Incomplete operator closure");console.log("relocated operator imports intact");`;
    assert.equal(await fixtureCommand(process.execPath, ["--no-env-file", "--no-install", "-e", script], root), "relocated operator imports intact");
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

test("effective typed unit command rejects a legacy override or extra startup command", () => {
  const expected = ["/bin/sh", "/fixture/ops/launch-vps.sh"];
  const row = [expected[0], expected, false, 0, 0, 0, 0, 0, 0, 0];
  assertCutoverExecStart({ type: "a(sasbttttuii)", data: [row] }, expected);
  const legacy = ["/bin/sh", "-c", "set -eu; release=$$(cd -P .data/current && pwd); exec deno $$release/serve.ts"];
  const legacyRow = [legacy[0], legacy, false, 0, 0, 0, 0, 0, 0, 0];
  assertCutoverExecStart({ type: "a(sasbttttuii)", data: [legacyRow] }, legacy);
  assert.throws(() => {
    assertCutoverExecStart(
      { type: "a(sasbttttuii)", data: [legacyRow] },
      legacy.map((part) => part.replaceAll("$$", "$"))
    );
  });
  for (const data of [
    [row, row],
    [["/usr/local/bin/deno", ["/usr/local/bin/deno", "run", "old.ts"], false, 0, 0, 0, 0, 0, 0, 0]],
    [[expected[0], [...expected, "unexpected"], false, 0, 0, 0, 0, 0, 0, 0]],
  ])
    assert.throws(() => {
      assertCutoverExecStart({ type: "a(sasbttttuii)", data }, expected);
    });
});

test("effective drop-in bytes are pinned and execution/environment changes fail before startup", async () =>
  fixture(async (root) => {
    const directory = join(root, "service.d");
    await mkdir(directory);
    const path = join(directory, "99-resources.conf");
    await writeFile(path, "[Service]\nMemoryMax=infinity\nCPUWeight=10\n", { mode: 0o644 });
    const run = () => Promise.resolve(JSON.stringify({ type: "as", data: [root] }));
    const before = await cutoverDropinDigest(root, run);
    await writeFile(path, "[Service]\nMemoryMax=infinity\nCPUWeight=20\n");
    assert.notEqual(await cutoverDropinDigest(root, run), before);
    for (const line of [
      "ExecStart=/usr/local/bin/deno run stale.ts",
      "Environment=FIXTURE=changed",
      "WorkingDirectory=/outside",
      "ExecStartPre=/bin/sh",
      "User=root",
    ])
      assert.throws(() => {
        assertCutoverDropin("[Service]\n" + line + "\n");
      });
    await writeFile(path, "[Service]\nExecStart=/usr/local/bin/deno run stale.ts\n");
    await assert.rejects(cutoverDropinDigest(root, run));
  }));

test("supervisor runtime resource updates can target only the exact reviewed task unit", () => {
  assert.equal(cutoverSupervisorUnit("/system.slice/uos-first-bun-cutover-20261015.service"), "uos-first-bun-cutover-20261015.service");
  for (const group of ["/hosting.slice/ai-ubq-fi.service", "/system.slice/caddy.service", "/user.slice/codex.service"])
    assert.throws(() => cutoverSupervisorUnit(group));
  assert.deepEqual(checkedCutoverBudgets({ conversionAndProofMs: 2_700_000, recoveryConversionMs: 2_700_000, recoveryProofMs: 2_700_000 }), {
    conversionAndProofMs: 2_700_000,
    recoveryConversionMs: 2_700_000,
    recoveryProofMs: 2_700_000,
  });
  assert.throws(() => checkedCutoverBudgets({ conversionAndProofMs: Infinity, recoveryConversionMs: 1000, recoveryProofMs: 0 }));
});

test("stalled holder inspection is killed and reaped within its own deadline", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", "await Bun.sleep(60000)"], { env: {}, stdout: "pipe", stderr: "pipe" });
  const start = Date.now();
  await assert.rejects(boundedCutoverHolderCheck(child, 50), /exceeded its deadline/);
  await child.exited;
  assert.ok(Date.now() - start < 3000);
  assert.throws(() => process.kill(child.pid, 0));
});

test("forward link-before-receipt interruption preserves both copies and only trusts the unchanged stopped legacy source", async () =>
  fixture(async (root) => {
    const legacy = join(root, "legacy.sqlite3"),
      bun = join(root, "kv-bun.sqlite3");
    await writeFile(legacy, "authoritative stopped legacy fixture", { mode: 0o600 });
    await writeFile(bun, "unreceipted completed conversion fixture", { mode: 0o600 });
    const source = await fileDigest(legacy),
      output = await fileDigest(bun);
    const retained = await preserveUnstartedCutover(legacy, bun, root, source);
    assert.equal(await fileDigest(legacy), source);
    assert.equal(await fileDigest(retained), output);
    await assert.rejects(lstat(bun));
    await writeFile(bun, "another partial fixture", { mode: 0o600 });
    await writeFile(legacy, "newer Deno state must not be overwritten");
    await assert.rejects(preserveUnstartedCutover(legacy, bun, root, source), /Authoritative stopped legacy source changed/);
    assert.equal(await readFile(bun, "utf8"), "another partial fixture");
  }));

test("capacity accounts for WAL bytes and checkpoint refuses a sidecar symlink before touching its target", async () =>
  fixture(async (root) => {
    const source = join(root, "source"),
      other = join(root, "unrelated");
    await writeFile(source, "1234");
    await writeFile(source + "-wal", "1234567890");
    assert.equal(await cutoverSourceBytes(source), 14);
    await rm(source + "-wal");
    await writeFile(other, "must remain unchanged");
    await symlink(other, source + "-wal");
    await assert.rejects(checkpointCutoverStore(source, "deno-v8"), /Unsafe SQLite sidecar/);
    assert.equal(await readFile(other, "utf8"), "must remain unchanged");
  }));

test("baseline-left-live codec probes use private disk scratch and clean up on success and failure", async () =>
  fixture(async (root) => {
    const artifactDirectory = join(root, "immutable-artifact");
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, "source-marker"), "immutable fixture");
    await chmod(artifactDirectory, 0o500);
    const parent = join(root, ".data/cutovers");
    const probe = async (directory: string) => {
      assert.ok(directory.startsWith(parent + "/.codec-probe-"));
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      await mkdir(join(directory, ".deno-codec-cache"));
      await writeFile(join(directory, ".deno-codec-cache/fixture"), "owned cache");
      return "baseline-left-live";
    };
    assert.equal(await withCutoverCodecProbe(root, probe), "baseline-left-live");
    await assert.rejects(
      withCutoverCodecProbe(root, async (directory) => {
        await probe(directory);
        throw new Error("Identity probe refused");
      }),
      /Identity probe refused/
    );
    assert.deepEqual(await readdir(parent), []);
    assert.deepEqual(await readdir(artifactDirectory), ["source-marker"]);
    assert.equal(await readFile(join(artifactDirectory, "source-marker"), "utf8"), "immutable fixture");
    await chmod(artifactDirectory, 0o700);
  }));

test("prepared-only ExecStopPost verifies the still-live baseline and never stops it after preflight refusal", async () =>
  fixture(async (root) => {
    await mkdir(join(root, ".data"));
    const legacy = join(root, ".data/kv.sqlite3");
    await writeFile(legacy, "live legacy writer fixture");
    const before = await fileDigest(legacy),
      calls: string[] = [];
    const prior: StoredVpsPrior = {
      sha: "1".repeat(40),
      path: ".data/releases/" + "1".repeat(40),
      archive: h("a"),
      tree: h("b"),
      selector: "releases/" + "1".repeat(40),
      port: 7999,
      profile: h("c"),
    };
    const loaded = { sha256: h("d"), needsReload: true, pid: 42, startedMonotonic: "123" };
    let healthFails = false;
    const input: Parameters<typeof verifyPreparedCutover>[0] = {
      root,
      workspace: root,
      prior,
      denoBinary: "/fixture/deno",
      denoSha256: h("e"),
      state: { bunStartupAttempted: false, legacyStartupAttempted: false, priorSourceSha256: null, conversion: null, loadedPriorUnit: loaded },
      store: { selector: () => Promise.resolve(prior.selector) },
      host: {
        assertPriorUnchanged: () => {
          calls.push("identity");
          return Promise.resolve();
        },
        loadedUnit: () => Promise.resolve(loaded),
        verifyLegacyProcess: () => {
          calls.push("process");
          return Promise.resolve();
        },
        health: () => {
          calls.push("health");
          return healthFails ? Promise.reject(new Error("Health refused")) : Promise.resolve();
        },
        publicHealth: () => {
          calls.push("public");
          return Promise.resolve();
        },
      },
    };
    const forbidden = () => {
      calls.push("unexpected service mutation");
      return Promise.reject(new Error("No stopping intent"));
    };
    let phase = "";
    await assert.rejects(
      executeCutoverTransition({
        record: (value) => {
          phase = value;
          return Promise.resolve();
        },
        preflight: () => Promise.reject(new Error("Authorization expired")),
        stop: forbidden,
        preserve: forbidden,
        convert: forbidden,
        start: forbidden,
        verify: forbidden,
        recover: forbidden,
      }),
      /before service interruption/
    );
    assert.equal(phase, "prepared");
    const journal = join(root, "prepared.json");
    await writeVpsAtomic(journal, input.state);
    input.state = JSON.parse(await readFile(journal, "utf8")) as typeof input.state;
    assert.notDeepEqual(Object.keys(input.state.loadedPriorUnit), Object.keys(loaded));
    assert.deepEqual(input.state.loadedPriorUnit, loaded);
    assert.equal((await lstat(journal)).mode & 0o777, 0o600);
    await verifyPreparedCutover(input);
    assert.deepEqual(calls, ["identity", "process", "health", "public"]);
    healthFails = true;
    await assert.rejects(verifyPreparedCutover(input), /Health refused/);
    input.state.bunStartupAttempted = true;
    await assert.rejects(verifyPreparedCutover(input), /original live baseline/);
    assert.equal(calls.includes("unexpected service mutation"), false);
    assert.equal(await fileDigest(legacy), before);
  }));

test("immutable release extraction under private umask keeps exact CI source modes and private manifests", async () =>
  fixture(async (root) => {
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".data/releases"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "src/app.ts"), "export const source = true;\n");
    const git = (...args: string[]) => fixtureCommand("git", args, root);
    await git("init", "--initial-branch=development");
    await git("config", "user.name", "Cutover umask fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await git("add", "src");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "source");
    const sha = await git("rev-parse", "HEAD");
    // Namespace root otherwise ignores umask; request GNU tar's normal non-root permission behavior.
    const program = join(root, "extract.ts");
    await writeFile(
      program,
      `import {ImmutableVpsReleaseStore} from ${JSON.stringify(fileURLToPath(new URL("../vps-release-store.ts", import.meta.url)))};\nimport {lstat,rm} from "node:fs/promises";\nconst root=process.argv[2],sha=process.argv[3];process.umask(0o077);const store=new ImmutableVpsReleaseStore(root,async(program,args,cwd)=>{const child=Bun.spawn([program,...args],{cwd,env:{PATH:"/usr/bin:/bin",TAR_OPTIONS:"--no-same-permissions"},stdout:"pipe",stderr:"pipe"});const[code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);if(code!==0)throw new Error(error);return out.trim();});const release=await store.expectedRelease(sha);const path=store.absolute(release.path);console.log(JSON.stringify({source:(await lstat(path+"/src/app.ts")).mode&0o777,directory:(await lstat(path+"/src")).mode&0o777,manifest:(await lstat(path+"/.uos-release.json")).mode&0o777,stamp:(await lstat(path+"/src/release.ts")).mode&0o777}));await rm(path,{recursive:true});\n`
    );
    const result = JSON.parse(await fixtureCommand(process.execPath, ["--no-env-file", "--no-install", program, root, sha], root)) as Record<string, number>;
    assert.deepEqual(result, { source: 0o644, directory: 0o755, manifest: 0o600, stamp: 0o600 });
  }));

test("a self-consistent existing candidate for the same Git SHA must still equal its exact accepted CI manifest", async () =>
  fixture(async (root) => {
    const repo = join(root, "git"),
      release = join(root, "release"),
      workspace = join(root, "work"),
      candidate = join(root, "candidate");
    for (const path of [repo, release, workspace, candidate]) await mkdir(path);
    await writePackage(repo, { "#kv": "./src/storage/kv.ts", "#http": "./src/runtime/http.ts" });
    for (const name of ["scripts/build-permissions.ts", "src/runtime/permissions-linux.ts", "src/runtime/permissions-native.c"]) {
      const destination = join(repo, name);
      await mkdir(join(destination, ".."), { recursive: true });
      await copyFile(join(repository, name), destination);
    }
    await mkdir(join(repo, "tools"));
    await cp(join(repository, "tools/native-kv"), join(repo, "tools/native-kv"), { recursive: true });
    const git = (...args: string[]) => fixtureCommand("git", args, repo);
    await git("init", "--initial-branch=development");
    await git("config", "user.name", "Cutover fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await git("add", ".");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "source");
    const sha = await git("rev-parse", "HEAD"),
      source = join(root, "source.tar");
    await git("archive", "--format=tar", "--output=" + source, sha);
    for (const path of [release, candidate]) {
      await fixtureCommand("/bin/sh", ["-c", 'umask 022; exec /usr/bin/tar -xf "$1" -C "$2"', "source", source, path], root);
      await writeFile(join(path, "src/release.ts"), `// Generated for this immutable VPS release.\nexport const RELEASE_GIT_SHA = "${sha}";\n`, {
        mode: 0o600,
      });
      await chmod(join(path, "src/release.ts"), 0o600);
    }
    // Package the extracted Git source as CI does; copying checkout fixtures over it changes hashed file modes.
    await prepareReleasePayload(
      release,
      sha,
      await fileDigest(source),
      join(repository, "node_modules/node-api-headers/include"),
      currentTestNativeKvBinding(),
      join(repository, "node_modules")
    );
    const archive = join(root, "artifact.zip");
    // The synthetic hosted API publishes the actual ZIP digest; all source/tree/native checks still execute.
    await fixtureCommand(
      "/usr/bin/python3",
      [
        "-c",
        'import zipfile,sys; p=sys.argv[1]; b=open(sys.argv[2],"rb").read(); z=zipfile.ZipFile(p,"w"); z.writestr("manifest.json",b); z.close()',
        archive,
        join(release, ".uos-release.json"),
      ],
      root
    );
    const zipSha = await fileDigest(archive);
    const input: CutoverArtifactInput = { revision: sha, runId: 17, artifactId: 18, archive, directory: release, sourceRepository: repo, workspace };
    const replies: Record<string, unknown> = {
      "actions/runs/17": {
        id: 17,
        head_sha: sha,
        head_branch: "development",
        event: "push",
        status: "completed",
        conclusion: "success",
        path: ".github/workflows/deno-deploy.yml",
      },
      "actions/artifacts/18": { id: 18, name: `ai-ubq-fi-source-${sha}`, expired: false, digest: "sha256:" + zipSha, workflow_run: { id: 17, head_sha: sha } },
      "actions/runs/17/jobs?per_page=100": {
        jobs: ["validate", "mac-containment", "darwin-native", "verify-artifact"].map((name) => ({ name, status: "completed", conclusion: "success" })),
      },
      "git/ref/heads/development": { object: { sha } },
    };
    const captured = await captureCutoverArtifact(input, (route) => Promise.resolve(replies[route]));
    await reuseCutoverPayload(captured)(candidate, sha, await fileDigest(source));
    await verifyCutoverCandidate(captured, candidate);
    const manifest = JSON.parse(await readFile(join(candidate, ".uos-release.json"), "utf8")) as { dependency_tree_sha256: string };
    await writeFile(join(candidate, "node_modules/foreign-fixture"), "different self-sealed graph\n");
    manifest.dependency_tree_sha256 = await treeDigest(join(candidate, "node_modules"));
    await writeFile(join(candidate, ".uos-release.json"), JSON.stringify(manifest) + "\n");
    await verifyReleasePayload(candidate, sha, captured.manifest.source_tree_sha256);
    await assert.rejects(verifyCutoverCandidate(captured, candidate), /accepted CI manifest/);
  }));
