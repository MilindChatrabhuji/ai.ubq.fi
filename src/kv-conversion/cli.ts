import { convertKvDatabase } from "./convert.ts";
import type { ConversionDirection } from "./cursors.ts";

const main = async (): Promise<void> => {
  const flags = new Map<string, string>();
  for (let index = 2; index < Bun.argv.length; index += 2) {
    const key = Bun.argv[index];
    const value = Bun.argv[index + 1];
    if (!key.startsWith("--") || !value || value.startsWith("--") || flags.has(key)) throw new Error("Expected unique --flag value pairs");
    flags.set(key, value);
  }
  const required = (name: string): string => {
    const value = flags.get(`--${name}`);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const signal = new AbortController();
  const interrupt = () => {
    signal.abort(new Error("Conversion interrupted before publication"));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const receipt = await convertKvDatabase({
      direction: required("direction") as ConversionDirection,
      source: required("source"),
      destination: required("destination"),
      receipt: required("receipt"),
      deno: required("deno"),
      denoSha256: required("deno-sha256"),
      signal: signal.signal,
    });
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
};
if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Conversion failed");
    process.exitCode = 1;
  });
