import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../node_modules/bun-types/extensions.d.ts", import.meta.url));
const originalSha256 = "b1e2ccc111f0f8313f9f50bbc637564299ac19a1f76b60e51ec07e3d7d9d3792";
const patchedSha256 = "ff1269afd7044fffcec0ce8879645702ec0013c9990232e05644f1493e3dc4db";
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const source = await readFile(path, "utf8");
const current = digest(source);
if (current === patchedSha256) process.exit(0);
if (current !== originalSha256) throw new Error(`Unsupported bun-types extensions declaration: ${current}`);
const patched = source.replaceAll("export = ", "export default ");
if (digest(patched) !== patchedSha256) throw new Error("The pinned bun-types declaration patch did not produce the attested bytes");
await writeFile(path, patched, { mode: 0o644 });
