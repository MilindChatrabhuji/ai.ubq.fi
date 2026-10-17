#!/bin/bash
# Artifact preparation only; never install into HOME or a system toolchain.
set -euo pipefail
: "${RUNNER_TEMP:?GitHub runner temporary directory is required}"
test "$(uname -s)" = Linux && test "$(uname -m)" = aarch64
uos_workspace="$RUNNER_TEMP/uos-native-kv"
uos_toolchain="$uos_workspace/toolchain"
mkdir -p "$uos_workspace"
mkdir "$uos_toolchain"
for uos_component in rustc cargo rust-std; do
  case "$uos_component" in
    rustc) uos_expected=89fb83041993b48816514815606f53a5264729b8b449671a6b291e6f0ae74f40 ;;
    cargo) uos_expected=c09425a7f300af148c0bdfded0e7d5f1fe7c075b2b9674e8935afa769297b2f6 ;;
    rust-std) uos_expected=9bf796a6ec5b004813ebd0b650775a7c6a4f3aae97ad362ae294798dca4f3b23 ;;
  esac
  uos_name="$uos_component-1.98.1-aarch64-unknown-linux-gnu"
  uos_archive="$uos_workspace/$uos_name.tar.xz"
  curl --proto '=https' --tlsv1.2 --fail --location --max-time 180 \
    "https://static.rust-lang.org/dist/2026-09-03/$uos_name.tar.xz" --output "$uos_archive"
  printf '%s  %s\n' "$uos_expected" "$uos_archive" | sha256sum --check --status
  tar -xJf "$uos_archive" -C "$uos_workspace"
  sh "$uos_workspace/$uos_name/install.sh" --prefix="$uos_toolchain" --disable-ldconfig
 done
printf '%s  %s\n' d4217a981a778bfe445c0a29c408f5a25a92e9bb5222701579ad5a35bd913e8f "$uos_toolchain/bin/rustc" | sha256sum --check --status
printf '%s  %s\n' 2101d7104b91a013912c94275dcd31c2b41061ef7f6e8530df11cdad55b8fbc5 "$uos_toolchain/bin/cargo" | sha256sum --check --status
"$uos_toolchain/bin/rustc" --version
"$uos_toolchain/bin/cargo" --version
