import type { CapturedCutoverArtifact } from "./cutover-artifact.ts";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { digest, fileDigest } from "./io.ts";

export type CutoverReaderReceipt = Readonly<{ path: string; sha256: string }>;
export type CutoverReaderGate =
  Readonly<{ kind: "accepted"; receipt: CutoverReaderReceipt }> | Readonly<{ kind: "owner-waived"; receipt: CutoverReaderReceipt }>;
type GateBinding = CutoverReaderReceipt & Readonly<{ kind: CutoverReaderGate["kind"] }>;

/** A missing receipt, an extra alternative or an unknown kind never selects a waiver. */
export function cutoverReaderGateBinding(value: unknown): GateBinding {
  const gate = object(value, ["kind", "receipt"]);
  if (gate.kind !== "accepted" && gate.kind !== "owner-waived") return refused();
  const receipt = object(gate.receipt, ["path", "sha256"]);
  if (typeof receipt.path !== "string" || !isAbsolute(receipt.path) || receipt.path.length > 4096 || /\p{Cc}/u.test(receipt.path)) return refused();
  return { kind: gate.kind, path: receipt.path, sha256: hash(receipt.sha256) };
}

const evidenceNames = [
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
];
const refused = (): never => {
  throw new Error("Standalone Sentinel reader acceptance is unavailable or belongs to another source");
};
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  const compare = (left: string, right: string) => left.localeCompare(right);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).toSorted(compare).join(",") !== keys.toSorted(compare).join(","))
    return refused();
  return value as Record<string, unknown>;
};
const hash = (value: unknown, length = 64): string => {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) return refused();
  return value;
};

/** Frozen contract owned by Sentinel thread01a13c8f; this parser grants no Sentinel write or promotion authority. */
export function assertCutoverReaderAcceptance(value: unknown, artifact: CapturedCutoverArtifact): { path: string; sha256: string }[] {
  const receipt = object(value, ["schemaVersion", "scope", "status", "owner", "gateway", "sentinel", "runtime", "execution", "evidence", "completedAt"]);
  if (receipt.schemaVersion !== "sentinel-bun-reader-acceptance-v1" || receipt.scope !== "frozen-reader-compatibility" || receipt.status !== "accepted")
    return refused();
  const owner = object(receipt.owner, ["threadId", "role"]);
  if (owner.threadId !== "01a13c8f-3411-7b82-ba62-d048bc6f87c7" || owner.role !== "sentinel-integration-owner") return refused();
  const gateway = object(receipt.gateway, [
    "repository",
    "gitSha",
    "artifactId",
    "artifactZipSha256",
    "releaseManifestSha256",
    "sourceTreeSha256",
    "dependencyLockSha256",
    "dependencyTreeSha256",
    "permissionsTreeSha256",
    "nativeKv",
  ]);
  const manifest = artifact.manifest;
  if (
    manifest.schema !== 3 ||
    gateway.repository !== "ubiquity/ai.ubq.fi" ||
    gateway.gitSha !== artifact.revision ||
    gateway.artifactId !== artifact.artifactId ||
    gateway.artifactZipSha256 !== artifact.archiveSha256 ||
    gateway.releaseManifestSha256 !== artifact.manifestSha256 ||
    gateway.sourceTreeSha256 !== manifest.source_tree_sha256 ||
    gateway.dependencyLockSha256 !== manifest.dependency_lock_sha256 ||
    gateway.dependencyTreeSha256 !== manifest.dependency_tree_sha256 ||
    gateway.permissionsTreeSha256 !== manifest.permissions_tree_sha256
  )
    return refused();
  const native = object(gateway.nativeKv, ["treeSha256", "artifactSha256", "provenanceSha256", "inputsSha256"]);
  if (
    native.treeSha256 !== manifest.native_kv.tree_sha256 ||
    native.artifactSha256 !== manifest.native_kv.artifact_sha256 ||
    native.provenanceSha256 !== manifest.native_kv.provenance_sha256 ||
    native.inputsSha256 !== manifest.native_kv.inputs_sha256
  )
    return refused();
  const sentinel = object(receipt.sentinel, [
    "repository",
    "canonicalGitSha",
    "readerGitSha",
    "readerInputsSha256",
    "bootstrapSha256",
    "permissionsNativeSha256",
  ]);
  if (sentinel.repository !== "ubiquity/sentinel") return refused();
  for (const key of ["canonicalGitSha", "readerGitSha"]) hash(sentinel[key], 40);
  for (const key of ["readerInputsSha256", "bootstrapSha256", "permissionsNativeSha256"]) hash(sentinel[key]);
  const runtime = object(receipt.runtime, ["name", "version", "platform", "architecture", "archiveSha256", "binarySha256"]);
  if (
    runtime.name !== "bun" ||
    runtime.version !== "1.4.0" ||
    runtime.platform !== "linux" ||
    runtime.architecture !== "arm64" ||
    runtime.archiveSha256 !== manifest.runtime.archiveSha256 ||
    runtime.binarySha256 !== manifest.runtime.binarySha256
  )
    return refused();
  const execution = object(receipt.execution, ["platform", "architecture", "kernel", "landlockAbi", "isolation", "environmentMode", "dependencyMode"]);
  if (
    execution.platform !== "linux" ||
    execution.architecture !== "arm64" ||
    typeof execution.kernel !== "string" ||
    !execution.kernel.length ||
    execution.kernel.length > 256 ||
    /\p{Cc}/u.test(execution.kernel) ||
    !Number.isSafeInteger(execution.landlockAbi) ||
    Number(execution.landlockAbi) < 8 ||
    execution.isolation !== "bwrap+landlock-tsync+seccomp-tsync" ||
    execution.environmentMode !== "allowlisted-no-dotenv" ||
    execution.dependencyMode !== "verified-offline-no-install" ||
    !Array.isArray(receipt.evidence) ||
    receipt.evidence.length !== evidenceNames.length
  )
    return refused();
  const seen = new Set<string>();
  const evidence = receipt.evidence.map((entry) => {
    const row = object(entry, ["name", "outcome", "receiptPath", "receiptSha256", "commandExitCode"]);
    if (
      typeof row.name !== "string" ||
      !evidenceNames.includes(row.name) ||
      seen.has(row.name) ||
      row.outcome !== "passed" ||
      row.commandExitCode !== 0 ||
      typeof row.receiptPath !== "string" ||
      !isAbsolute(row.receiptPath) ||
      row.receiptPath.length > 4096 ||
      /\p{Cc}/u.test(row.receiptPath)
    )
      return refused();
    seen.add(row.name);
    return { path: row.receiptPath, sha256: hash(row.receiptSha256) };
  });
  if (
    typeof receipt.completedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT.*Z$/.test(receipt.completedAt) ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    Date.parse(receipt.completedAt) > Date.now()
  )
    return refused();
  return evidence;
}

export async function verifyCutoverReaderAcceptance(receipt: CutoverReaderReceipt, artifact: CapturedCutoverArtifact): Promise<void> {
  const info = await lstat(receipt.path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 65_536) return refused();
  const bytes = await readFile(receipt.path);
  if (digest(bytes) !== hash(receipt.sha256)) return refused();
  const evidence = assertCutoverReaderAcceptance(JSON.parse(bytes.toString()), artifact);
  for (const proof of evidence) {
    const file = await lstat(proof.path);
    if (!file.isFile() || file.isSymbolicLink() || (await fileDigest(proof.path)) !== proof.sha256) return refused();
  }
}

type BoundFields = Readonly<{ [key: string]: string | number | BoundFields }>;
const exactBinding = (value: unknown, expected: BoundFields): void => {
  const actual = object(value, Object.keys(expected));
  for (const [key, field] of Object.entries(expected)) {
    if (typeof field === "object") exactBinding(actual[key], field);
    else if (actual[key] !== field) refused();
  }
};
const privateRecord = async (receipt: CutoverReaderReceipt): Promise<unknown> => {
  const info = await lstat(receipt.path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 65_536) return refused();
  const bytes = await readFile(receipt.path);
  if (digest(bytes) !== hash(receipt.sha256)) return refused();
  return JSON.parse(bytes.toString()) as unknown;
};
const instant = (value: unknown): number => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) return refused();
  return Date.parse(value);
};

/** This is an operator-recorded user waiver, never an external reader success or signature. */
const verifyOwnerWaiver = async (receipt: CutoverReaderReceipt, artifact: CapturedCutoverArtifact): Promise<void> => {
  const waiver = object(await privateRecord(receipt), ["schemaVersion", "scope", "status", "gateway", "runtime", "instruction", "issuedAt", "expiresAt"]);
  if (
    waiver.schemaVersion !== "uos-first-bun-cutover-reader-waiver-v1" ||
    waiver.scope !== "external-Sentinel-reader-only" ||
    waiver.status !== "owner-waived" ||
    instant(waiver.issuedAt) > Date.now() ||
    instant(waiver.expiresAt) <= Date.now()
  )
    return refused();
  const manifest = artifact.manifest;
  if (manifest.schema !== 3 || manifest.platform !== "linux" || manifest.architecture !== "arm64") return refused();
  exactBinding(waiver.gateway, {
    repository: "ubiquity/ai.ubq.fi",
    gitSha: artifact.revision,
    artifactId: artifact.artifactId,
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
  });
  exactBinding(waiver.runtime, {
    name: "bun",
    version: "1.4.0",
    platform: "linux",
    architecture: "arm64",
    archiveSha256: manifest.runtime.archiveSha256,
    binarySha256: manifest.runtime.binarySha256,
  });
  const instruction = cutoverReaderGateBinding({ kind: "owner-waived", receipt: waiver.instruction });
  const record = object(await privateRecord(instruction), ["v", "status", "scope", "source", "instructions", "note"]);
  if (
    record.v !== 1 ||
    record.status !== "owner-instruction-record" ||
    record.scope !== "external-Sentinel-reader-only" ||
    record.source !== "user messages in this task" ||
    typeof record.note !== "string" ||
    !record.note.length ||
    !Array.isArray(record.instructions) ||
    record.instructions.length === 0 ||
    record.instructions.length > 32 ||
    record.instructions.some((line) => typeof line !== "string" || !line.trim() || line.length > 4096 || /\p{Cc}/u.test(line))
  )
    return refused();
};

/** Explicit private input selects exactly one truthful gate; accepted parsing stays unchanged. */
export async function verifyCutoverReaderGate(value: unknown, artifact: CapturedCutoverArtifact): Promise<CutoverReaderGate["kind"]> {
  const binding = cutoverReaderGateBinding(value);
  if (binding.kind === "accepted") await verifyCutoverReaderAcceptance(binding, artifact);
  else await verifyOwnerWaiver(binding, artifact);
  return binding.kind;
}
