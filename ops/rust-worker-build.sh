#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd -- "$repo_root"
build_host=$(uname -s):$(uname -m)
case "$build_host" in
  Linux:aarch64|Linux:arm64|Darwin:arm64) ;;
  *) fail 'Rust Worker builds require a prepared Darwin or Linux ARM64 host.' ;;
esac

env_directory=$repo_root
while :; do
  for env_name in .env .env.local .env.production .env.production.local .dev.vars; do
    [[ ! -e "$env_directory/$env_name" ]] || fail 'Use an isolated build checkout without automatically discovered dotenv files.'
  done
  [[ $env_directory != / ]] || break
  env_directory=$(dirname -- "$env_directory")
done
[[ ${NODE_OPTIONS:-} != *--env-file* ]] || fail 'Automatic Node dotenv loading is not permitted.'

for tool_directory in CARGO_HOME RUSTUP_HOME CARGO_TARGET_DIR XDG_CACHE_HOME TMPDIR; do
  tool_path=${!tool_directory:-}
  case "$tool_path" in "$repo_root"/*|/var/tmp/*|/tmp/*|/private/tmp/*) ;; *) fail 'Prepared Rust tools, targets and caches must be task-local.' ;; esac
done
for binary_name in WASM_BINDGEN_BIN WASM_OPT_BIN ESBUILD_BIN; do
  [[ -x ${!binary_name:-} ]] || fail 'All pinned Worker build-tool binary overrides must be prepared.'
done
[[ -f bun.lock && -f tools/lint/bun.lock && -f rust/Cargo.lock ]] || fail 'Frozen dependency lockfiles are required.'
[[ -z $(git status --porcelain --untracked-files=all -- rust static package.json bun.lock cloudflare.config.ts wrangler.config.ts ops/rust-worker-build.sh ops/rust-worker-deploy.sh) ]] || fail 'Build inputs must match their committed source.'
[[ -z $(git status --porcelain --untracked-files=all) ]] || fail 'Exact-source Worker builds require a clean immutable Git checkout.'
build_sha=$(git rev-parse HEAD)
build_tree=$(git rev-parse 'HEAD^{tree}')
# Cargo build-script fingerprints can retain absolute Git watcher paths from a
# different immutable checkout. Never share that provenance cache across trees.
export CARGO_TARGET_DIR="$CARGO_TARGET_DIR/exact-worker/$build_sha-$build_tree"
mkdir -p -- "$CARGO_TARGET_DIR"

bun_bin=$(command -v bun) || fail 'Prepared Bun 1.4.0 is required.'
[[ $("$bun_bin" --version) == 1.4.0 ]] || fail 'Bun 1.4.0 is required.'
worker_build_bin=$(command -v worker-build) || fail 'Prepared worker-build 0.8.7 is required.'
if [[ $build_host == Darwin:arm64 ]]; then
  worker_build_bin=$("$bun_bin" --no-env-file --no-install -e 'import {rustToolPath,rustVerificationEnvironment} from "./scripts/rust-verify.ts"; process.stdout.write(rustToolPath("worker-build",rustVerificationEnvironment()));')
fi
[[ $("$worker_build_bin" --version) == 0.8.7 ]] || fail 'Prepared worker-build 0.8.7 is required.'
[[ $("$WASM_BINDGEN_BIN" --version) == 'wasm-bindgen 0.2.129' ]] || fail 'Prepared wasm-bindgen 0.2.129 is required.'
"$bun_bin" --no-env-file --no-install -e 'for (const [name, version] of [["cf", "1.0.0-beta.12"], ["wrangler", "4.151.1"]]) { if ((await Bun.file(`node_modules/${name}/package.json`).json()).version !== version) throw new Error("Prepared CLI version mismatch"); }'

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$repo_root/.data/rust-worker-tools/config}"
export WRANGLER_LOG_PATH="$repo_root/.data/rust-worker-tools/wrangler.log"
mkdir -p -- "$XDG_CONFIG_HOME" "$(dirname -- "$WRANGLER_LOG_PATH")"
if [[ $build_host == Darwin:arm64 ]]; then
  "$bun_bin" --no-env-file --no-install -e '
import {rustToolPath,rustVerificationEnvironment} from "./scripts/rust-verify.ts";
const env=rustVerificationEnvironment();
for (const name of ["rustc","cargo"]) { const result=Bun.spawnSync([rustToolPath(name,env),"--version"],{env}); if(result.exitCode!==0 || !result.stdout.toString().startsWith(`${name} 1.98.1 `)) throw new Error(`Prepared ${name} 1.98.1 is required`); }
const child=Bun.spawnSync([rustToolPath("worker-build",env),"--release","--locked"],{cwd:"rust/crates/gateway-worker",env,stdin:"inherit",stdout:"inherit",stderr:"inherit"});
if(child.error) throw child.error;
process.exit(child.exitCode);
'
else
  (cd -- rust/crates/gateway-worker; "$worker_build_bin" --release --locked)
fi
[[ -s rust/crates/gateway-worker/build/index.js && -s rust/crates/gateway-worker/build/index_bg.wasm ]] || fail 'The prepared Rust Worker artifacts are missing.'
"$bun_bin" --no-env-file --no-install tools/cloudflare/verify-build-identity.ts "$build_sha"
"$bun_bin" --no-env-file --no-install run cf build
"$bun_bin" --no-env-file --no-install run cf deploy --prebuilt --dry-run

"$bun_bin" --no-env-file --no-install -e '
import { readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
const root = process.cwd();
const git = (...args) => { const result = Bun.spawnSync(["git", ...args], { cwd: root }); if (result.exitCode !== 0) throw new Error("Git provenance unavailable"); return result.stdout.toString().trim(); };
const sha = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const selected = Bun.spawnSync(["git", "ls-files", "-z", "--", "rust", "static", "package.json", "bun.lock", "cloudflare.config.ts", "wrangler.config.ts", "ops/rust-worker-build.sh", "ops/rust-worker-deploy.sh"], { cwd: root });
if (selected.exitCode !== 0) throw new Error("Source manifest unavailable");
const files = new Set(selected.stdout.toString().split("\0").filter(Boolean));
async function visit(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isSymbolicLink()) throw new Error("Artifact links are forbidden"); if (entry.isDirectory()) await visit(file); else if (entry.isFile()) files.add(relative(root, file)); else throw new Error("Unsupported artifact entry"); } }
await visit(join(root, ".cloudflare/output/v0"));
files.add("rust/crates/gateway-worker/build/index.js");
files.add("rust/crates/gateway-worker/build/index_bg.wasm");
const entries = [];
for (const path of [...files].sort()) { if (!(await lstat(path)).isFile()) throw new Error("Source inputs must be regular files"); entries.push({ path, sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex") }); }
const directory = join(root, ".data/rust-worker-build", sha);
await mkdir(directory, { recursive: true });
const receipt = join(directory, "receipt.json");
await writeFile(receipt, JSON.stringify({ version: 1, gitSha: sha, gitTree: tree, worker: "uos-ai-rust-candidate", accountId: "5c0228bee348f4cf48829ffe21b61fe9", compatibilityDate: "2026-10-18", tools: { bun: "1.4.0", workerBuild: "0.8.7", wasmBindgen: "0.2.129", cf: "1.0.0-beta.12", wrangler: "4.151.1" }, files: entries }, null, 2) + "\n", { flag: "wx" });
console.log(relative(root, receipt));
'
