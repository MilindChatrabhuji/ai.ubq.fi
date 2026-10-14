#!/bin/sh
set -eu
uos_root=$(pwd -P)
uos_release=$(cd -P .data/current && pwd)
case "$uos_release" in "$uos_root"/.data/releases/*) ;; *) echo "Invalid immutable release selector" >&2; exit 1 ;; esac
uos_runtime="$uos_root/.data/runtimes/bun/darwin-arm64/1.4.0-539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf/bun"
test -f "$uos_runtime" && ! test -L "$uos_runtime"
uos_hash=$(/usr/bin/shasum -a256 "$uos_runtime")
test "${uos_hash%% *}" = 539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf
exec "$uos_runtime" --no-env-file --no-install "$uos_release/ops/launch-service.ts" mac
