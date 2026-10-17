import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { missing } from "./io.ts";
import { canonicalVps, sha256 } from "./vps-release-contract.ts";
import { withVpsDeployLock } from "./vps-release-journal.ts";
import { checkedRetention, joinBinding, parseJoinCheckpoint } from "./vps-metrics-join.ts";
import type { VpsJoinCipher, VpsJoinStorage, VpsMetricsRetention, VpsMetricsScope } from "./vps-metrics-types.ts";

const refusal = (): never => {
  throw new Error("VPS telemetry checkpoint unavailable");
};
const decodeCheckpoint = (plain: Uint8Array, binding: string, now: number, policy: VpsMetricsRetention) =>
  parseJoinCheckpoint(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)), binding, now, policy);

/**
 * @public Trusted filesystem adapter. Cipher and fresh scope come only from the authenticated host.
 * It shares the deploy lock, so it lives outside the read-only journal-metrics import graph.
 */
export function createVpsJoinFileStorage(
  root: string,
  policy: VpsMetricsRetention,
  cipher: VpsJoinCipher,
  current: (scope: VpsMetricsScope) => Promise<VpsMetricsScope>,
  now = Date.now
): VpsJoinStorage {
  checkedRetention(policy);
  const directory = `${root}/.data/sentinel-vps-metrics`;
  const path = (scope: VpsMetricsScope) => `${directory}/${sha256(scope.operationId)}.sealed`;
  const assertDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (await realpath(directory)) !== directory) return refusal();
  };
  const read = async (scope: VpsMetricsScope): Promise<Uint8Array | null> => {
    await assertDirectory();
    try {
      const stat = await lstat(path(scope));
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > policy.evidenceMaxBytes) {
        return refusal();
      }
      return new Uint8Array(await readFile(path(scope)));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  return {
    load: (scope) => withVpsDeployLock(root, () => read(scope)),
    save: async (scope, expected, bytes) => {
      if (canonicalVps(await current(scope)) !== canonicalVps(scope) || bytes.byteLength > policy.evidenceMaxBytes) return false;
      return withVpsDeployLock(root, async () => {
        if (canonicalVps(await current(scope)) !== canonicalVps(scope)) return false;
        const binding = await joinBinding(scope, policy);
        const incoming = await cipher.open(bytes, new TextEncoder().encode(binding));
        try {
          const next = decodeCheckpoint(incoming, binding, now(), policy);
          if (next.sequence !== (expected ?? 0) + 1 || next.stateHead !== scope.stateHead || next.stateSequence !== scope.stateSequence) return false;
        } finally {
          incoming.fill(0);
        }
        const old = await read(scope);
        if (old === null ? expected !== null : expected === null) return false;
        if (old !== null) {
          const plain = await cipher.open(old, new TextEncoder().encode(binding));
          try {
            if (decodeCheckpoint(plain, binding, now(), policy).sequence !== expected) return false;
          } finally {
            plain.fill(0);
          }
        }
        const temporary = `${path(scope)}-${crypto.randomUUID()}`;
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          if (canonicalVps(await current(scope)) !== canonicalVps(scope)) return false;
          await rename(temporary, path(scope));
          return true;
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
  };
}
