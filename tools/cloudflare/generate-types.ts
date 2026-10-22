import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// First-party orchestration runs on pinned Bun. The installed cf CLI declares
// Node >=22 and invokes its pinned workerd generator as an external tool.
if (Bun.version !== "1.4.0") throw new Error("Cloudflare type generation requires Bun 1.4.0.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
for (const [name, version] of [
  ["cf", "1.0.0-beta.12"],
  ["wrangler", "4.151.1"],
]) {
  const installed = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")) as { version?: unknown };
  if (installed.version !== version) throw new Error(`The prepared ${name} version is incorrect.`);
}
const stateRoot = join(root, ".data/cloudflare-typegen");
await mkdir(stateRoot, { recursive: true });
const isolated = await mkdtemp(join(stateRoot, "source-"));
const config = await readFile(join(root, "cloudflare.config.ts"));
await copyFile(join(root, "cloudflare.config.ts"), join(isolated, "cloudflare.config.ts"));

// cf types has no source-directory option. A fresh task-owned cwd prevents
// automatic cwd dotenv discovery without changing the real repository .env.
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH_JSON)/.test(name)));
if (environment.NODE_OPTIONS?.includes("--env-file")) throw new Error("Automatic Node dotenv loading is not permitted.");
environment.XDG_CONFIG_HOME = join(isolated, "config");
environment.XDG_CACHE_HOME = join(isolated, "cache");
environment.WRANGLER_LOG_PATH = join(isolated, "wrangler.log");
const child = Bun.spawn(["node", join(root, "node_modules/cf/bin/cf"), "workers", "types"], {
  cwd: isolated,
  env: environment,
  stdout: "pipe",
  stderr: "pipe",
});
const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
await Promise.all([writeFile(join(isolated, "stdout.log"), stdout), writeFile(join(isolated, "stderr.log"), stderr)]);
if (exitCode !== 0) throw new Error(`Pinned cf type generation failed with exit ${exitCode}; see ${isolated}.`);
const sourceAfter = await readFile(join(root, "cloudflare.config.ts"));
if (!sourceAfter.equals(config)) throw new Error("Cloudflare configuration changed during type generation.");
const generated = await readFile(join(isolated, ".cloudflare/types/index.d.ts"), "utf8");
if (!generated.includes("// Begin runtime types") || !generated.includes("interface Env extends Cloudflare.Env")) {
  throw new Error("Pinned cf did not produce complete binding and runtime declarations.");
}
const identity = createHash("sha256").update(config).digest("hex");
await writeFile(join(root, "tools/cloudflare/runtime.generated.d.ts"), `// Configuration SHA-256: ${identity}\n${generated}`);
console.log("Generated isolated Cloudflare configuration types.");
