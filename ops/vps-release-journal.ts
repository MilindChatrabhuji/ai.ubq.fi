import type { Stats } from "node:fs";
import { acquireDeployLock } from "./deploy-lock.ts";
import { lstat, mkdir, open, readFile, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { missing } from "./io.ts";
const readTextFile = (path: string): Promise<string> => readFile(path, "utf8");
import { canonicalVps, exactObject, parseVpsReceipt, sha256, gitSha, VPS_RECEIPT_MAX_BYTES, type VpsReceipt } from "./vps-release-contract.ts";

export type VpsPin = { operationId: string; requestDigest: string; candidate: string; prior: string };
const unavailable = (): never => {
  throw new Error("VPS operation journal is unavailable");
};
async function removeTemporary(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
function terminalReceipt(receipt: VpsReceipt): boolean {
  if (receipt.phase === "accepted" || receipt.phase === "failed") return true;
  return receipt.phase === "rolled_back" && receipt.settlement !== null;
}
export async function readVpsPins(path: string): Promise<VpsPin[]> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (missing(error)) return [];
    return unavailable();
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > VPS_RECEIPT_MAX_BYTES || (stat.mode & 0o777) !== 0o600) return unavailable();
  try {
    const value = exactObject(JSON.parse(await readTextFile(path)), ["schema", "pins"]);
    if (value.schema !== 1 || !Array.isArray(value.pins) || value.pins.length > 256) return unavailable();
    const pins = value.pins.map((entry) => {
      const pin = exactObject(entry, ["operationId", "requestDigest", "candidate", "prior"]);
      return { operationId: sha256(pin.operationId), requestDigest: sha256(pin.requestDigest), candidate: gitSha(pin.candidate), prior: gitSha(pin.prior) };
    });
    if (new Set(pins.map((pin) => pin.operationId)).size !== pins.length) return unavailable();
    return pins;
  } catch {
    return unavailable();
  }
}

export async function writeVpsAtomic(path: string, value: unknown): Promise<void> {
  const text = canonicalVps(value) + "\n";
  if (new TextEncoder().encode(text).byteLength > VPS_RECEIPT_MAX_BYTES) return unavailable();
  const temporary = `${path}-${crypto.randomUUID()}`;
  let file: FileHandle | null = null;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(text, "utf8");
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await removeTemporary(temporary);
  }
}

/** The sole lock used by normal deploy, bound operations and manual pruning. */
export async function withVpsDeployLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(`${root}/.data`, { recursive: true, mode: 0o700 });
  const directory = await lstat(`${root}/.data`);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (await realpath(`${root}/.data`)) !== `${root}/.data`) return unavailable();
  const path = `${root}/.data/deploy.lock`;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return unavailable();
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const releaseLock = await acquireDeployLock(path);
  try {
    return await work();
  } finally {
    releaseLock();
  }
}

function isValidReceiptSuccessor(previous: VpsReceipt, receipt: VpsReceipt): boolean {
  if (receipt.sequence !== previous.sequence + 1 || receipt.updatedAt < previous.updatedAt) return false;
  for (const key of ["binding", "controllerSha", "driverSha256", "candidate", "prior", "createdAt"] as const)
    if (canonicalVps(receipt[key]) !== canonicalVps(previous[key])) return false;
  if (terminalReceipt(previous)) return false;
  if (previous.intent !== null && receipt.intent === null) return false;
  if (
    receipt.phase === "failed" &&
    receipt.intent === null &&
    (previous.phase !== "prepared" ||
      previous.sequence !== 1 ||
      previous.intent !== null ||
      previous.loopback !== null ||
      previous.public !== null ||
      previous.restoration !== null ||
      previous.settlement !== null ||
      previous.error !== null)
  )
    return false;
  return true;
}

/** All mutations are called only inside withVpsDeployLock. */
export class VpsOperationJournal {
  constructor(readonly root: string) {}
  get pinsPath(): string {
    return `${this.root}/.data/vps-release-pins.json`;
  }
  path(id: string): string {
    return `${this.root}/.data/sentinel-releases/${sha256(id)}.json`;
  }
  async read(id: string): Promise<VpsReceipt | null> {
    const path = this.path(id);
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (missing(error)) return null;
      return unavailable();
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > VPS_RECEIPT_MAX_BYTES || (stat.mode & 0o777) !== 0o600) return unavailable();
    try {
      const receipt = parseVpsReceipt(JSON.parse(await readTextFile(path)));
      if (receipt.operationId !== id) return unavailable();
      return receipt;
    } catch {
      return unavailable();
    }
  }
  async write(value: VpsReceipt): Promise<VpsReceipt> {
    const receipt = parseVpsReceipt(value);
    const directory = `${this.root}/.data/sentinel-releases`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory) return unavailable();
    const previous = await this.read(receipt.operationId);
    if (previous) {
      if (!isValidReceiptSuccessor(previous, receipt)) return unavailable();
    } else if (receipt.sequence !== 1 || receipt.phase !== "prepared") return unavailable();
    // Publish the conservative retention hold first; a crash can only retain too much.
    const pins = await readVpsPins(this.pinsPath);
    if (!pins.some((pin) => pin.operationId === receipt.operationId)) {
      if (pins.length > 0) throw new Error("Another VPS operation owns promotion");
      pins.push({
        operationId: receipt.operationId,
        requestDigest: receipt.binding.requestDigest,
        candidate: receipt.candidate.gitSha,
        prior: receipt.prior.identity.gitSha,
      });
      await writeVpsAtomic(this.pinsPath, { schema: 1, pins });
    }
    await writeVpsAtomic(this.path(receipt.operationId), receipt);
    return receipt;
  }
  async releasePin(receipt: VpsReceipt): Promise<void> {
    if (receipt.settlement === null || !["accepted", "rolled_back", "failed"].includes(receipt.phase)) return unavailable();
    const pins = await readVpsPins(this.pinsPath);
    const own = pins.find((pin) => pin.operationId === receipt.operationId);
    if (
      own &&
      (own.requestDigest !== receipt.binding.requestDigest || own.candidate !== receipt.candidate.gitSha || own.prior !== receipt.prior.identity.gitSha)
    )
      return unavailable();
    await writeVpsAtomic(this.pinsPath, { schema: 1, pins: pins.filter((pin) => pin.operationId !== receipt.operationId) });
  }
}
