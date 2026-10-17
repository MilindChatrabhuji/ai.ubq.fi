#!/bin/sh
# Use the existing typed ruleset with the root Bun TypeScript program.
set -eu
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps
if [ "$#" -eq 0 ]; then set -- .; fi
exec bun --no-env-file "$TOOLS/node_modules/.bin/eslint" --config "$TOOLS/eslint.config.mjs" "$@"
