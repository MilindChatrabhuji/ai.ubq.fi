#!/bin/sh
# Preserve the configured first-party entry points and measured exceptions.
set -eu
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps
exec bun --no-env-file "$TOOLS/node_modules/.bin/knip" "$@"
