#!/bin/sh
# gpg.program for commits signed inside DSH's workspace-write sandbox. Install as ~/bin/gpg-dsh:
#   install -m 0755 ops/gpg-dsh.sh ~/bin/gpg-dsh && git config --global gpg.program ~/bin/gpg-dsh
# docs/DECISIONS.md ("Sandboxed commits sign through a GNUPGHOME inside writable roots") records why.
#
# When the real GnuPG homedir accepts a new file, gpg runs unchanged. Otherwise gpg runs from a seed
# homedir under $TMPDIR/dsh-gnupg/<uid>, copied from the real homedir's *.kbx and *.gpg files and every
# file in private-keys-v1.d. Every sandboxed call compares a manifest of those inputs (each file's name
# and SHA-256 digest) with the manifest recorded when the seed was built. Any difference - a deleted,
# added, or re-protected private key as well as a public keyring change - stops the seed's gpg-agent,
# discards the seed, and rebuilds it before gpg runs. The manifest is recorded only after a complete
# copy, so an interrupted rebuild is rebuilt again. Nothing is written to stdout: git reads the
# signature from it.
set -u

die() {
  printf 'gpg-dsh: %s\n' "$*" >&2
  exit 2
}

real_home=${GNUPGHOME:-${HOME:?HOME is unset}/.gnupg}
real_home=${real_home%/}

# Passthrough: the homedir is genuinely writable (the sandbox denies creating files, whatever the
# permission bits say), or there is no homedir to seed from.
if [ ! -d "$real_home" ]; then
  exec gpg "$@"
fi
if probe=$(mktemp "$real_home/.gpg-dsh-probe.XXXXXX" 2>/dev/null); then
  rm -f "$probe"
  exec gpg "$@"
fi

caller_umask=$(umask)
umask 077
tmp_root=${TMPDIR:-/tmp}
tmp_root=${tmp_root%/}
case $tmp_root in
  /?*) ;;
  *) die "TMPDIR must be an absolute path" ;;
esac
uid=$(id -u) || die "cannot read the user id"
base=$tmp_root/dsh-gnupg
seed=$base/$uid
stamp=$seed/.gpg-dsh-manifest

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256; }
else
  die "neither sha256sum nor shasum is available"
fi

# A directory that holds key material must be a real directory owned by this user, mode 0700.
private_dir() {
  [ -L "$1" ] && die "$1 is a symbolic link"
  [ -e "$1" ] || mkdir -m 700 "$1" 2>/dev/null || [ -d "$1" ] || die "cannot create $1"
  if [ -L "$1" ] || [ ! -d "$1" ] || [ ! -O "$1" ]; then
    die "$1 is not a directory owned by uid $uid"
  fi
  chmod 700 "$1" || die "cannot restrict $1 to mode 0700"
}

# The seed's inputs. The manifest and the copy walk the same list, so every input is a trigger.
for_each_input() {
  for path in "$real_home"/*.kbx "$real_home"/*.gpg "$real_home"/private-keys-v1.d/*; do
    [ -f "$path" ] || continue
    "$1" "${path#"$real_home"/}" || return 1
  done
}

manifest_line() {
  digest=$(sha256 <"$real_home/$1") || return 1
  digest=${digest%% *}
  case $digest in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  printf '%s %s\n' "$digest" "$1"
}

copy_input() {
  cp -p "$real_home/$1" "$seed/$1"
}

# Read the inputs before copying them: a change made during the copy then leaves a manifest that
# no longer matches, and the next call rebuilds.
manifest=$(
  LC_ALL=C
  export LC_ALL
  printf 'source %s\n' "$real_home"
  for_each_input manifest_line
) || die "cannot read $real_home"

private_dir "$base"
[ -L "$seed" ] && die "$seed is a symbolic link"
recorded=
if [ -e "$seed" ]; then
  if [ ! -d "$seed" ] || [ ! -O "$seed" ]; then
    die "$seed is not a directory owned by uid $uid"
  fi
  if [ -f "$stamp" ] && [ ! -L "$stamp" ]; then
    recorded=$(cat "$stamp") || recorded=
  fi
fi

if [ "$recorded" != "$manifest" ]; then
  if [ -e "$seed" ]; then
    gpgconf --homedir "$seed" --kill gpg-agent >/dev/null 2>&1 || :
    rm -rf "$seed" || die "cannot discard the stale seed $seed"
  fi
  private_dir "$seed"
  private_dir "$seed/private-keys-v1.d"
  for_each_input copy_input || die "cannot copy $real_home into $seed"
  printf '%s\n' "$manifest" >"$stamp" || die "cannot record $stamp"
else
  private_dir "$seed"
fi

umask "$caller_umask"
GNUPGHOME=$seed
export GNUPGHOME
exec gpg "$@"
