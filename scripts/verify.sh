#!/bin/sh
# Aggregate every gate and prepare one trusted native KV artifact before children.
set -u
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps
task_native_binding=""
for argument in "$@"; do
  case "$argument" in
    --native-kv-binding=*) task_native_binding=${argument#--native-kv-binding=} ;;
    *) echo "usage: verify.sh [--native-kv-binding=<parent JSON>]" >&2; exit 2 ;;
  esac
done
fail=0
run() {
  label="$1"
  shift
  printf '\n==> %s\n' "$label"
  if ! "$@"; then printf '!!! FAILED: %s\n' "$label"; fail=1; fi
}
run_test() {
  label="$1"
  profile="$2"
  if [ -z "$task_native_binding" ]; then
    printf '!!! FAILED: %s (trusted native KV preparation unavailable)\n' "$label"
    fail=1
    return
  fi
  run "$label" bun --no-env-file --no-install scripts/test-runner.ts "$profile" "--native-kv-binding=$task_native_binding"
}
run "strict Bun TypeScript (all entry points)" bun --no-env-file run check
run "prettier (all supported first-party formats)" bun --no-env-file "$TOOLS/node_modules/.bin/prettier" --check .
run "eslint (template ruleset)" bun --no-env-file "$TOOLS/node_modules/.bin/eslint" --config "$TOOLS/eslint.config.mjs" .
run "knip (unused files/exports/deps)" bun --no-env-file "$TOOLS/node_modules/.bin/knip"
run "file size ratchet" bun --no-env-file scripts/file-size-ratchet.ts
if [ -z "$task_native_binding" ]; then
  printf '\n==> native KV trusted parent preparation (once)\n'
  if ! task_native_binding=$(bun --no-env-file --no-install scripts/test-native-kv.ts prepare); then
    echo "!!! FAILED: native KV trusted parent preparation" >&2
    task_native_binding=""
    fail=1
  fi
fi
run_test "Bun test (vps deploy guards)" deploy-guards
run_test "Bun test (immutable releases and retention)" vps
run_test "Bun test (main and isolated measurement/hook/Mac fixtures)" main
run_test "Bun test (sentinel local)" sentinel
run_test "Bun test (quality contracts)" quality
run_test "Bun test (benchmark harness and baselines)" benchmark
printf '\n'
if [ "$fail" -ne 0 ]; then echo "verify: FAILED"; exit 1; fi
echo "verify: OK"
