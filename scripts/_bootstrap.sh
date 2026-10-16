# Shared Bun bootstrap for the quality wrappers. Sourced, never executed directly.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TOOLS="$ROOT/tools/lint"
cd "$ROOT" || exit 1

require_runtime() {
  command -v bun >/dev/null 2>&1 || { echo "error: Bun 1.4.0 is required" >&2; exit 1; }
  [ "$(bun --version)" = "1.4.0" ] || { echo "error: this checkout requires Bun 1.4.0" >&2; exit 1; }
  [ -f "$ROOT/bun.lock" ] || { echo "error: restore the root bun.lock before installing dependencies" >&2; exit 1; }
  [ -f "$TOOLS/bun.lock" ] || { echo "error: restore tools/lint/bun.lock before installing dependencies" >&2; exit 1; }
}

deps_ready_at() {
  [ -x "$1/node_modules/.bin/eslint" ] && [ -x "$1/node_modules/.bin/prettier" ] && [ -x "$1/node_modules/.bin/knip" ]
}

# Reuse only a byte-identical tool manifest and lock. Never replace existing state.
link_main_checkout_tools() {
  main=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  [ -n "$main" ] && [ "$main" != "$ROOT" ] || return 1
  main_tools="$main/tools/lint"
  deps_ready_at "$main_tools" || return 1
  for manifest in bun.lock package.json; do
    cmp -s "$TOOLS/$manifest" "$main_tools/$manifest" || return 1
  done
  ln -s "$main_tools/node_modules" "$TOOLS/node_modules" 2>/dev/null || return 1
}

ensure_deps() {
  require_runtime
  if ! deps_ready_at "$TOOLS"; then
    if ! link_main_checkout_tools; then
      echo "==> installing locked quality dependencies"
      (cd "$TOOLS" && bun --no-env-file install --frozen-lockfile --cache-dir "$ROOT/.bun-cache" --no-summary) || exit 1
    fi
  fi
  deps_ready_at "$TOOLS" || { echo "error: locked quality dependencies are unavailable" >&2; exit 1; }
  bun --no-env-file --no-install scripts/patch-bun-types.ts || exit 1
  # The type-aware parser must fail rather than silently lint without Bun types.
  [ -f "$ROOT/node_modules/@types/bun/index.d.ts" ] && [ -f "$ROOT/node_modules/@types/node/index.d.ts" ] && [ -f "$ROOT/node_modules/typescript/bin/tsc" ] || {
    echo "error: install the locked root dependencies with bun install --frozen-lockfile" >&2
    exit 1
  }
}
