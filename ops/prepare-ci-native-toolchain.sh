#!/bin/bash
# Artifact preparation only; never install into HOME or a system toolchain.
set -euo pipefail
: "${RUNNER_TEMP:?GitHub runner temporary directory is required}"
case "$(uname -s)-$(uname -m)" in
  Linux-aarch64) uos_target=aarch64-unknown-linux-gnu ;;
  Darwin-arm64) uos_target=aarch64-apple-darwin ;;
  *) echo "Unsupported native toolchain host" >&2; exit 1 ;;
esac
uos_workspace="$RUNNER_TEMP/uos-native-kv"
uos_toolchain="$uos_workspace/toolchain"
if [ "$uos_target" = aarch64-apple-darwin ]; then
  : "${RUSTUP_HOME:?Task Rust toolchain directory is required}"
  uos_toolchain="$RUSTUP_HOME/toolchains/1.98.1-aarch64-apple-darwin"
fi
uos_check() {
  if [ "$uos_target" = aarch64-apple-darwin ]; then shasum -a 256 --check --status; else sha256sum --check --status; fi
}
mkdir -p "$uos_workspace"
mkdir -p "$(dirname "$uos_toolchain")"
mkdir "$uos_toolchain"
for uos_component in rustc cargo rust-std; do
  case "$uos_component" in
    rustc) uos_expected=89fb83041993b48816514815606f53a5264729b8b449671a6b291e6f0ae74f40 ;;
    cargo) uos_expected=c09425a7f300af148c0bdfded0e7d5f1fe7c075b2b9674e8935afa769297b2f6 ;;
    rust-std) uos_expected=9bf796a6ec5b004813ebd0b650775a7c6a4f3aae97ad362ae294798dca4f3b23 ;;
  esac
  if [ "$uos_target" = aarch64-apple-darwin ]; then
    case "$uos_component" in
      rustc) uos_expected=738e3f60114b20550fcf4f8a57c9cea0544239f214709f45594ff3fde327f577 ;;
      cargo) uos_expected=de51d4fade4f31ad8ec405261cc96bedc000d905f98980027610d6e288dbe21b ;;
      rust-std) uos_expected=2de831ef563ce772519a4d18ba2659f0f7428d497ef66dad24b5a35e8f8cd177 ;;
    esac
  fi
  uos_name="$uos_component-1.98.1-$uos_target"
  uos_archive="$uos_workspace/$uos_name.tar.xz"
  curl --proto '=https' --tlsv1.2 --fail --location --max-time 180 \
    "https://static.rust-lang.org/dist/2026-09-03/$uos_name.tar.xz" --output "$uos_archive"
  printf '%s  %s\n' "$uos_expected" "$uos_archive" | uos_check
  tar -xJf "$uos_archive" -C "$uos_workspace"
  sh "$uos_workspace/$uos_name/install.sh" --prefix="$uos_toolchain" --disable-ldconfig
 done
if [ "$uos_target" = aarch64-apple-darwin ]; then
  uos_rustc=766eda9d8f53afd6fc7f27b3cd2e444dd22afacb5afa710a5625fc8e45b8c941
  uos_cargo=6e17e865f3a20dd55a1d212f849f58b77124179f0de7c52973096d84ba34118d
else
  uos_rustc=d4217a981a778bfe445c0a29c408f5a25a92e9bb5222701579ad5a35bd913e8f
  uos_cargo=2101d7104b91a013912c94275dcd31c2b41061ef7f6e8530df11cdad55b8fbc5
fi
printf '%s  %s\n' "$uos_rustc" "$uos_toolchain/bin/rustc" | uos_check
printf '%s  %s\n' "$uos_cargo" "$uos_toolchain/bin/cargo" | uos_check
"$uos_toolchain/bin/rustc" --version
"$uos_toolchain/bin/cargo" --version
