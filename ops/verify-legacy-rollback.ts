import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, exists, fileDigest } from "./io.ts";

type Receipt = {
  schema: string;
  direction: string;
  source: { path: string; codec: string; file: { sha256: string }; snapshot: { wal: string; drain_boundary: string } };
  destination: { path: string; codec: string; file: { sha256: string } };
};
/** A retained Deno DB is never substituted for latest Bun writes. */
export const verifyLegacyRollback = async (root: string): Promise<void> => {
  const bun = join(root, ".data/kv-bun.sqlite3");
  if (!(await exists(bun))) return;
  const receiptPath = join(root, ".data/bun-rollback-receipt.json");
  const receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || (receiptInfo.mode & 0o777) !== 0o600)
    throw new Error("A private latest-state codec rollback receipt is required");
  const bytes = await readFile(receiptPath);
  const receipt: Receipt = JSON.parse(bytes.toString());
  const destination = join(root, ".data/kv.sqlite3");
  for (const path of [bun, destination]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Codec rollback databases must be regular files");
  }
  if (
    receipt.schema !== "uos-kv-runtime-conversion-v1" ||
    receipt.direction !== "bun-to-deno" ||
    receipt.source.codec !== "bun-jsc-v1" ||
    receipt.destination.codec !== "deno-v8" ||
    (await realpath(receipt.source.path)) !== (await realpath(bun)) ||
    (await realpath(receipt.destination.path)) !== (await realpath(destination)) ||
    !["absent", "empty"].includes(receipt.source.snapshot.wal) ||
    receipt.source.snapshot.drain_boundary !== "checkpointed-no-wal" ||
    (await fileDigest(bun)) !== receipt.source.file.sha256
  )
    throw new Error("Legacy rollback receipt does not prove the latest stopped Bun state");
  if ((await exists(bun + "-wal")) && (await lstat(bun + "-wal")).size !== 0) throw new Error("Bun WAL still contains writes; drain before rollback");
  const active = join(root, ".data/legacy-rollback-active.json");
  const identity = JSON.stringify({ schema: 1, receipt_sha256: digest(bytes), source_sha256: receipt.source.file.sha256, destination });
  if (await exists(active)) {
    const info = await lstat(active);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || (await readFile(active, "utf8")).trim() !== identity)
      throw new Error("The active legacy codec receipt changed");
    return;
  }
  if ((await fileDigest(destination)) !== receipt.destination.file.sha256) throw new Error("Converted latest-state Deno destination differs from the receipt");
  const temporary = active + "-" + crypto.randomUUID();
  try {
    await writeFile(temporary, identity + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, active);
  } finally {
    await rm(temporary, { force: true });
  }
};
if (import.meta.main) await verifyLegacyRollback(await realpath("."));
