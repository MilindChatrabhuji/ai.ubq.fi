#!/bin/sh
# Run every quality and isolated test segment; aggregate all failures.
set -u
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps
fail=0
run() {
  label="$1"
  shift
  printf '\n==> %s\n' "$label"
  if ! "$@"; then printf '!!! FAILED: %s\n' "$label"; fail=1; fi
}
run "strict Bun TypeScript (all entry points)" bun --no-env-file run check
run "prettier (all supported first-party formats)" bun --no-env-file "$TOOLS/node_modules/.bin/prettier" --check .
run "eslint (template ruleset)" bun --no-env-file "$TOOLS/node_modules/.bin/eslint" --config "$TOOLS/eslint.config.mjs" .
run "knip (unused files/exports/deps)" bun --no-env-file "$TOOLS/node_modules/.bin/knip"
run "file size ratchet" bun --no-env-file scripts/file-size-ratchet.ts
run "Bun test (vps deploy guards)" bun --no-env-file scripts/test-runner.ts deploy-guards
run "Bun test (immutable releases and retention)" bun --no-env-file scripts/test-runner.ts vps
run "Bun test (main and isolated measurement/hook/Mac fixtures)" bun --no-env-file scripts/test-runner.ts main
run "Bun test (sentinel local)" bun --no-env-file scripts/test-runner.ts sentinel
run "Bun test (quality contracts)" bun --no-env-file scripts/test-runner.ts quality
run "Bun test (benchmark harness and baselines)" bun --no-env-file scripts/test-runner.ts benchmark
printf '\n'
if [ "$fail" -ne 0 ]; then echo "verify: FAILED"; exit 1; fi
echo "verify: OK"
