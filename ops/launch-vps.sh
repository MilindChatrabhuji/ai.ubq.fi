#!/bin/sh
set -eu
uos_root=$(pwd -P)
uos_release=$(cd -P .data/current && pwd)
case "$uos_release" in "$uos_root"/.data/releases/*) ;; *) echo "Invalid immutable release selector" >&2; exit 1 ;; esac
uos_schema=$(/usr/bin/jq -r '.schema // 1' "$uos_release/.uos-release.json")
case "$uos_schema" in 1|2|3) ;; *) echo "Unsupported immutable release schema" >&2; exit 1 ;; esac
if test "$uos_schema" = 2 || test "$uos_schema" = 3; then
  uos_runtime="$uos_root/.data/runtimes/bun/linux-arm64/1.4.0-086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9/bun"
  if ! test -f "$uos_runtime" || test -L "$uos_runtime"; then echo "Managed VPS runtime unavailable or invalid" >&2; exit 1; fi
  uos_hash=$(/usr/bin/sha256sum "$uos_runtime") || { echo "Managed VPS runtime unavailable or invalid" >&2; exit 1; }
  if test "${uos_hash%% *}" != 086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9; then echo "Managed VPS runtime unavailable or invalid" >&2; exit 1; fi
  exec "$uos_runtime" --no-env-file --no-install "$uos_release/ops/launch-service.ts" vps
fi
# Exact legacy source profile retained for explicitly approved codec recovery.
uos_profile=$(/usr/bin/sed 's/port: [0-9][0-9]*/port: 0/' "$uos_release/scripts/serve-vps.ts" | /usr/bin/sha256sum)
uos_unit=$(/usr/bin/sha256sum "$uos_release/ops/ai-ubq-fi.service")
test "${uos_profile%% *}" = 50435a214d34cb7fbae3735a0a0502f8d96aaa3257dc502edc01bd64a8429ca7
test "${uos_unit%% *}" = 6563f11090766cc784361bc71a0c9c244bfa41c0f0e2163355a1f558000d3d44
if test -e "$uos_root/.data/kv-bun.sqlite3"; then
  uos_bun="$uos_root/.data/runtimes/bun/linux-arm64/1.4.0-086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9/bun"
  test -f "$uos_bun" && ! test -L "$uos_bun"
  uos_bun_hash=$(/usr/bin/sha256sum "$uos_bun")
  test "${uos_bun_hash%% *}" = 086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9
  "$uos_bun" --no-env-file --no-install "$uos_root/ops/verify-legacy-rollback.ts"
fi
exec /usr/local/bin/deno run --config="$uos_release/deno.json" --lock="$uos_release/deno.lock" --frozen --no-prompt --env-file=.env --unstable-kv --allow-env --allow-net --allow-sys=hostname --allow-read=/home/codex/repos/ubiquity/ai.ubq.fi,/home/codex/.codex --allow-write=/home/codex/repos/ubiquity/ai.ubq.fi/.data,/home/codex/.codex/app-server-control "$uos_release/scripts/serve-vps.ts"
