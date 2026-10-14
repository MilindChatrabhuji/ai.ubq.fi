#!/bin/sh
# One formatter owns all supported first-party files; TS keeps 160 columns.
set -eu
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps
mode=--write
if [ "${1:-}" = "--check" ]; then mode=--check; shift; fi
if [ "$#" -eq 0 ]; then set -- .; fi
exec bun --no-env-file "$TOOLS/node_modules/.bin/prettier" "$mode" "$@"
