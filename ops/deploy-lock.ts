import { hostRuntime, type DenoLockHost } from "./io.ts";

type ReleaseDeployLock = () => void;
type BunDeployLockModule = Readonly<{ acquireBunDeployLock: (path: string) => Promise<ReleaseDeployLock> }>;
const LOCK_WAIT_MS = 240_000;

/**
 * Deno.open has no O_NOFOLLOW, so the opened inode must still be the physical, non-link path entry.
 * FsFile.tryLockSync(true) is the same non-blocking exclusive flock the Bun host takes.
 */
export const acquireDenoDeployLock = async (deno: DenoLockHost, path: string, waitMs = LOCK_WAIT_MS): Promise<ReleaseDeployLock> => {
  const file = await deno.open(path, { write: true, create: true, mode: 0o600 });
  try {
    const info = await file.stat();
    const entry = await deno.lstat(path);
    if (
      !info.isFile ||
      entry.isSymlink ||
      entry.dev !== info.dev ||
      entry.ino !== info.ino ||
      ((info.mode ?? 0) & 0o777) !== 0o600 ||
      info.uid === null ||
      info.uid !== deno.uid()
    )
      throw new Error("Deployment lock is not a private owned regular file");
    // Never block the JS thread while another process owns this lock.
    const deadline = Date.now() + waitMs;
    while (!file.tryLockSync(true)) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the deployment lock");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        file.unlockSync();
      } catch {
        // As on the Bun host, an unlock result is not checked: closing the descriptor releases the flock.
      }
      file.close();
    };
  } catch (error) {
    file.close();
    throw error;
  }
};

/**
 * The one deployment lock for every writer: an exclusive POSIX flock on a private owned file, taken
 * through Bun FFI on the Bun host and through Deno's FsFile lock when Sentinel's Deno bridge drives
 * the pinned VPS driver. The Bun module is loaded by URL on the Bun host only, so a Deno host never
 * resolves a module it cannot load.
 */
export const acquireDeployLock = async (path = ".data/deploy.lock"): Promise<ReleaseDeployLock> => {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Deployment requires POSIX file locking");
  const host = hostRuntime();
  if (host.kind === "deno") return acquireDenoDeployLock(host.deno, path);
  const bun = (await import(new URL("./deploy-lock-bun.ts", import.meta.url).href)) as BunDeployLockModule;
  return bun.acquireBunDeployLock(path);
};
