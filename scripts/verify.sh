#!/bin/sh
# Aggregate every gate and prepare one trusted native KV artifact before children.
set -u
. "$(dirname -- "$0")/_bootstrap.sh"
if [ "${TEST_SCOPE_FORCE:-0}" != "1" ]; then
  if bun --no-env-file --no-install scripts/test-scope.ts; then
    exit 0
  else
    scope_status=$?
    if [ "$scope_status" -ne 10 ]; then exit "$scope_status"; fi
  fi
fi
ensure_deps
task_native_binding=""
no_native_kv=0
for argument in "$@"; do
  case "$argument" in
    --native-kv-binding=*) task_native_binding=${argument#--native-kv-binding=} ;;
    --no-native-kv) no_native_kv=1 ;;
    *) echo "usage: verify.sh [--native-kv-binding=<parent JSON>] [--no-native-kv]" >&2; exit 2 ;;
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
  if [ -n "$task_native_binding" ]; then
    run "$label" bun --no-env-file --no-install scripts/test-runner.ts "$profile" "--native-kv-binding=$task_native_binding"
  elif [ "$no_native_kv" -eq 1 ]; then
    run "$label" bun --no-env-file --no-install scripts/test-runner.ts "$profile" --portable
  else
    printf '!!! FAILED: %s (trusted native KV preparation unavailable)\n' "$label"
    fail=1
  fi
}
run "strict Bun TypeScript (all entry points)" bun --no-env-file run check
run "prettier (all supported first-party formats)" bun --no-env-file "$TOOLS/node_modules/.bin/prettier" --check .
run "eslint (template ruleset)" bun --no-env-file "$TOOLS/node_modules/.bin/eslint" --config "$TOOLS/eslint.config.mjs" .
run "knip (unused files/exports/deps)" bun --no-env-file "$TOOLS/node_modules/.bin/knip"
run "file size ratchet" bun --no-env-file scripts/file-size-ratchet.ts
if [ -z "$task_native_binding" ] && [ "$no_native_kv" -eq 0 ]; then
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
