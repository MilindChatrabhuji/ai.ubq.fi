import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TypedValue } from "./typed-value.ts";

export const LEGACY_DENO_VERSION = "2.9.7";
export const fileDigest = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
};

/** Hash pin and permissions are enforced before invoking the one-time codec child. */
export const openLegacyCodec = async (binary: string, expectedSha256: string, cwd: string, signal?: AbortSignal) => {
  const path = resolve(binary);
  const binarySha256 = await fileDigest(path);
  if (!lstatSync(path).isFile() || !/^[a-f0-9]{64}$/.test(expectedSha256) || binarySha256 !== expectedSha256)
    throw new Error(`Pinned legacy Deno binary does not match its SHA-256: expected ${expectedSha256}, observed ${binarySha256}`);
  const helper = fileURLToPath(new URL("./v8-helper.mjs", import.meta.url));
  const versionChild = Bun.spawn([path, "run", "--no-config", "--no-lock", "--no-prompt", helper, "--identity"], {
    cwd,
    env: {},
    stdout: "pipe",
    stderr: "pipe",
  });
  const [version, versionError, code] = await Promise.all([
    new Response(versionChild.stdout).text(),
    new Response(versionChild.stderr).text(),
    versionChild.exited,
  ]);
  if (code !== 0 || versionError || version.trim() !== LEGACY_DENO_VERSION) throw new Error("Unsupported pinned legacy Deno version");
  const child = Bun.spawn([path, "run", "--no-config", "--no-lock", "--no-prompt", helper], { cwd, env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const interrupted = () => {
    child.kill();
  };
  signal?.addEventListener("abort", interrupted, { once: true });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled = false;
  const request = async (input: unknown): Promise<unknown> => {
    await child.stdin.write(`${JSON.stringify(input)}\n`);
    await child.stdin.flush();
    while (!buffer.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Legacy codec failed: ${await stderr}`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const newline = buffer.indexOf("\n");
    const output: unknown = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    return output;
  };
  return {
    identity: { version: LEGACY_DENO_VERSION, binary: path, sha256: expectedSha256 },
    decode: async (bytes: Uint8Array): Promise<TypedValue> =>
      (await request({ operation: "decode", bytes: Buffer.from(bytes).toString("base64") })) as TypedValue,
    encode: async (value: TypedValue): Promise<Uint8Array> => Uint8Array.from(Buffer.from((await request({ operation: "encode", value })) as string, "base64")),
    async close() {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", interrupted);
      await child.stdin.end();
      const [exit, errors] = await Promise.all([child.exited, stderr]);
      reader.releaseLock();
      if (exit !== 0) throw new Error(`Legacy codec exited ${exit}: ${errors}`);
    },
    async abort() {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", interrupted);
      child.kill();
      await Promise.all([child.exited, stderr]);
      reader.releaseLock();
    },
  };
};
