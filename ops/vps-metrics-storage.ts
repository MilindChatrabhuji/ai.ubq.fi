import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { missing } from "./io.ts";
import { canonicalVps, sha256 } from "./vps-release-contract.ts";
import { withVpsDeployLock } from "./vps-release-journal.ts";
import { checkedRetention, freshJoinCheckpoint, joinBinding, parseJoinCheckpoint } from "./vps-metrics-join.ts";
import { VPS_METRICS_STATE_READ_MS, type VpsJoinCipher, type VpsJoinStorage, type VpsMetricsRetention, type VpsMetricsScope } from "./vps-metrics-types.ts";

const refusal = (): never => {
  throw new Error("VPS telemetry checkpoint unavailable");
};
const decodeCheckpoint = (plain: Uint8Array, binding: string, now: number, policy: VpsMetricsRetention) =>
  parseJoinCheckpoint(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)), binding, now, policy);
const CHECKPOINT = /^[0-9a-f]{64}\.sealed$/;
const TEMPORARY = /^[0-9a-f]{64}\.sealed-[0-9a-f-]{36}$/;
/** Settles with null when the work does not settle in time; a late result is ignored. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @public Trusted filesystem adapter. Cipher and fresh scope come only from the authenticated host.
 * It shares the deploy lock, so it lives outside the read-only journal-metrics import graph.
 */
export function createVpsJoinFileStorage(
  root: string,
  policy: VpsMetricsRetention,
  cipher: VpsJoinCipher,
  current: (scope: VpsMetricsScope) => Promise<VpsMetricsScope>,
  now = Date.now,
  stateReadMs = VPS_METRICS_STATE_READ_MS
): VpsJoinStorage {
  checkedRetention(policy);
  if (!Number.isSafeInteger(stateReadMs) || stateReadMs <= 0) return refusal();
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
  /**
   * Runs under the deploy lock. Temporaries are only written under that lock, so any other one was left by a crashed
   * writer. A checkpoint untouched for the whole evidence age has expired. File ages compare filesystem mtimes, so they
   * use the system clock.
   */
  const prune = async (keep: string) => {
    const cutoff = Date.now() - policy.evidenceMaxAgeMs;
    for (const name of await readdir(directory)) {
      const file = `${directory}/${name}`,
        temporary = TEMPORARY.test(name);
      if (file === keep || (!temporary && !CHECKPOINT.test(name))) continue;
      const stat = await lstat(file).catch(() => null);
      if (stat?.isFile() && (temporary || stat.mtimeMs <= cutoff)) await rm(file, { force: true });
    }
  };
  const syncDirectory = async () => {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  return {
    load: (scope) => withVpsDeployLock(root, () => read(scope)),
    save: async (scope, expected, bytes) => {
      if (bytes.byteLength > policy.evidenceMaxBytes || canonicalVps(await current(scope)) !== canonicalVps(scope)) return false;
      const binding = await joinBinding(scope, policy);
      const incoming = await cipher.open(bytes, new TextEncoder().encode(binding));
      try {
        const next = freshJoinCheckpoint(decodeCheckpoint(incoming, binding, now(), policy), now());
        if (next.sequence !== (expected ?? 0) + 1 || next.stateHead !== scope.stateHead || next.stateSequence !== scope.stateSequence) return false;
      } finally {
        incoming.fill(0);
      }
      return withVpsDeployLock(root, async () => {
        const old = await read(scope);
        if (old === null ? expected !== null : expected === null) return false;
        if (old !== null) {
          const plain = await cipher.open(old, new TextEncoder().encode(binding));
          try {
            // Only the sequence matters here; an expired predecessor is still the one this write replaces.
            if (decodeCheckpoint(plain, binding, now(), policy).sequence !== expected) return false;
          } finally {
            plain.fill(0);
          }
        }
        await prune(path(scope));
        const temporary = `${path(scope)}-${crypto.randomUUID()}`;
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          // The only release-state read made under the deploy lock. It is bounded, so a slow state store refuses
          // this write rather than holding up a deploy waiting on the lock.
          const latest = await bounded(current(scope), stateReadMs);
          if (latest === null || canonicalVps(latest) !== canonicalVps(scope)) return false;
          await rename(temporary, path(scope));
          await syncDirectory();
          return true;
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
  };
}
