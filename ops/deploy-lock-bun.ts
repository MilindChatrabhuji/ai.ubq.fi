import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

/**
 * The Bun host's deployment lock. POSIX flock interoperates with Deno's FsFile lock on the same inode.
 * Production code reaches it only through ./deploy-lock.ts on a Bun host, because Bun FFI cannot load under Deno.
 */
export const acquireBunDeployLock = async (path: string): Promise<() => void> => {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Deployment requires POSIX file locking");
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
      throw new Error("Deployment lock is not a private owned regular file");
    // Never block Bun's JS thread while another process owns this lock.
    const deadline = Date.now() + 240_000;
    while (library.symbols.flock(descriptor, 2 | 4) !== 0) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the deployment lock");
      await Bun.sleep(100);
    }
    let released = false;
    const owned = descriptor;
    return () => {
      if (released) return;
      released = true;
      library.symbols.flock(owned, 8);
      closeSync(owned);
      library.close();
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    library.close();
    throw error;
  }
};
