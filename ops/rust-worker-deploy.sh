#!/usr/bin/env bash
set -euo pipefail

# The delivery controller verifies required green CI for this exact source SHA
# before invoking this authorized candidate deployment. No deployment runs in CI.
# This script validates accepted prebuilt files and never invokes a Rust tool.
fail() { printf '%s\n' "$1" >&2; exit 1; }
repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd -- "$repo_root"
[[ -n ${CLOUDFLARE_API_TOKEN:-} ]] || fail 'The existing Cloudflare API token must be provided explicitly.'
[[ -f bun.lock && -f tools/lint/bun.lock && -f rust/Cargo.lock ]] || fail 'Frozen dependency lockfiles are required.'
[[ -z $(git status --porcelain --untracked-files=all -- rust static package.json bun.lock cloudflare.config.ts wrangler.config.ts ops/rust-worker-build.sh ops/rust-worker-deploy.sh) ]] || fail 'Deployment inputs must match their committed source.'
env_directory=$repo_root
while :; do
  for env_name in .env .env.local .env.production .env.production.local .dev.vars; do
    [[ ! -e "$env_directory/$env_name" ]] || fail 'Use an isolated deployment checkout without automatically discovered dotenv files.'
  done
  [[ $env_directory != / ]] || break
  env_directory=$(dirname -- "$env_directory")
done
[[ ${NODE_OPTIONS:-} != *--env-file* ]] || fail 'Automatic Node dotenv loading is not permitted.'
bun_bin=$(command -v bun) || fail 'Prepared Bun 1.4.0 is required.'
[[ $("$bun_bin" --version) == 1.4.0 ]] || fail 'Bun 1.4.0 is required.'

"$bun_bin" --no-env-file --no-install -e '
import { lstat } from "node:fs/promises";
const git = (...args) => { const result = Bun.spawnSync(["git", ...args]); if (result.exitCode !== 0) throw new Error("Git provenance unavailable"); return result.stdout.toString().trim(); };
const sha = git("rev-parse", "HEAD");
const receipt = await Bun.file(`.data/rust-worker-build/${sha}/receipt.json`).json();
if (receipt.version !== 1 || receipt.gitSha !== sha || receipt.gitTree !== git("rev-parse", "HEAD^{tree}") || receipt.worker !== "uos-ai-rust-candidate" || receipt.accountId !== "5c0228bee348f4cf48829ffe21b61fe9" || receipt.compatibilityDate !== "2026-10-18" || !Array.isArray(receipt.files) || receipt.files.length === 0) throw new Error("Prebuilt source identity mismatch");
const paths = new Set();
for (const file of receipt.files) { if (typeof file.path !== "string" || file.path.startsWith("/") || file.path.split("/").some(part => part === ".." || part === "." || part === "") || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid artifact manifest"); paths.add(file.path); if (!(await lstat(file.path)).isFile() || new Bun.CryptoHasher("sha256").update(await Bun.file(file.path).arrayBuffer()).digest("hex") !== file.sha256) throw new Error("Prebuilt artifact changed"); }
for (const path of [".cloudflare/output/v0/config.json", "rust/crates/gateway-worker/entrypoint.mjs", "rust/crates/gateway-worker/build/index.js", "rust/crates/gateway-worker/build/index_bg.wasm", "cloudflare.config.ts", "wrangler.config.ts", "package.json", "bun.lock", "rust/Cargo.lock"]) if (!paths.has(path)) throw new Error("Missing required artifact input");
for (const [name, version] of [["cf", "1.0.0-beta.12"], ["wrangler", "4.151.1"]]) if ((await Bun.file(`node_modules/${name}/package.json`).json()).version !== version) throw new Error("Prepared CLI version mismatch");
'

export CLOUDFLARE_ACCOUNT_ID=5c0228bee348f4cf48829ffe21b61fe9
export XDG_CONFIG_HOME="$repo_root/.data/rust-worker-tools/config"
export XDG_CACHE_HOME="$repo_root/.data/rust-worker-tools/cache"
export WRANGLER_LOG_PATH="$repo_root/.data/rust-worker-tools/wrangler.log"
mkdir -p -- "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$(dirname -- "$WRANGLER_LOG_PATH")"
source_sha=$(git rev-parse HEAD)
exec "$bun_bin" --no-env-file --no-install run cf deploy --prebuilt --message "Rust gateway $source_sha"
