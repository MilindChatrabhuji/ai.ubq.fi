import { canonicalVps, exactObject, parseVpsReceipt, sha256, gitSha, VPS_RECEIPT_MAX_BYTES, type VpsReceipt } from "./vps-release-contract.ts";

export type VpsPin = { operationId: string; requestDigest: string; candidate: string; prior: string };
const unavailable = (): never => {
  throw new Error("VPS operation journal is unavailable");
};
async function removeTemporary(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
function terminalReceipt(receipt: VpsReceipt): boolean {
  if (receipt.phase === "accepted" || receipt.phase === "failed") return true;
  return receipt.phase === "rolled_back" && receipt.settlement !== null;
}
export async function readVpsPins(path: string): Promise<VpsPin[]> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    return unavailable();
  }
  if (!stat.isFile || stat.isSymlink || stat.size > VPS_RECEIPT_MAX_BYTES || ((stat.mode ?? 0) & 0o777) !== 0o600) return unavailable();
  try {
    const value = exactObject(JSON.parse(await Deno.readTextFile(path)), ["schema", "pins"]);
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
  let file: Deno.FsFile | null = null;
  try {
    file = await Deno.open(temporary, { write: true, createNew: true, mode: 0o600 });
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
    await file.sync();
    file.close();
    file = null;
    await Deno.rename(temporary, path);
  } finally {
    file?.close();
    await removeTemporary(temporary);
  }
}

/** The sole lock used by normal deploy, bound operations and manual pruning. */
export async function withVpsDeployLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await Deno.mkdir(`${root}/.data`, { recursive: true, mode: 0o700 });
  const directory = await Deno.lstat(`${root}/.data`);
  if (!directory.isDirectory || directory.isSymlink || (await Deno.realPath(`${root}/.data`)) !== `${root}/.data`) return unavailable();
  const path = `${root}/.data/deploy.lock`;
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink) return unavailable();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const lock = await Deno.open(path, { create: true, write: true, mode: 0o600 });
  try {
    await lock.lock(true);
    return await work();
  } finally {
    lock.close();
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
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      return unavailable();
    }
    if (!stat.isFile || stat.isSymlink || stat.size > VPS_RECEIPT_MAX_BYTES || ((stat.mode ?? 0) & 0o777) !== 0o600) return unavailable();
    try {
      const receipt = parseVpsReceipt(JSON.parse(await Deno.readTextFile(path)));
      if (receipt.operationId !== id) return unavailable();
      return receipt;
    } catch {
      return unavailable();
    }
  }
  async write(value: VpsReceipt): Promise<VpsReceipt> {
    const receipt = parseVpsReceipt(value);
    const directory = `${this.root}/.data/sentinel-releases`;
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await Deno.lstat(directory);
    if (!stat.isDirectory || stat.isSymlink || (await Deno.realPath(directory)) !== directory) return unavailable();
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
