/** Capture both native child pipes concurrently so neither can block the child. */
export const runCommand = async (
  argv: readonly string[],
  options: Readonly<{ cwd?: string; capture?: boolean; signal?: AbortSignal }> = {}
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> => {
  const child = Bun.spawn([...argv], { cwd: options.cwd, signal: options.signal, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    if (options.capture !== false) return await new Response(stream).text();
    const reader = stream.getReader();
    try {
      while (!(await reader.read()).done) {
        // Discard output when the caller requested no capture.
      }
      return "";
    } finally {
      reader.releaseLock();
    }
  };
  const [code, stdout, stderr] = await Promise.all([child.exited, read(child.stdout), read(child.stderr)]);
  return { code, stdout, stderr };
};
