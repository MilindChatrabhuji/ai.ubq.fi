#!/bin/sh
# gpg.program for commits signed inside DSH's workspace-write sandbox. Install as ~/bin/gpg-dsh:
#   install -m 0755 ops/gpg-dsh.sh ~/bin/gpg-dsh && git config --global gpg.program ~/bin/gpg-dsh
# docs/DECISIONS.md ("Sandboxed commits sign through a GNUPGHOME inside writable roots") records why.
#
# When the real GnuPG homedir accepts a new file, gpg runs unchanged. Otherwise gpg runs from a seed
# homedir at $TMPDIR/dsh-gnupg-<uid>/seed, copied from the real homedir's *.kbx and *.gpg files and
# every file in private-keys-v1.d. Every sandboxed call compares a manifest of those inputs (each
# file's name and SHA-256 digest, hashed by one process) with the manifest recorded when the seed was
# built. Any difference - a deleted, added, or re-protected private key as well as a public keyring
# change - stops the seed's gpg-agent, discards the seed, and rebuilds it before gpg runs. So does a
# GnuPG configuration file in the seed: the helper never writes one, so it was planted from inside the
# sandbox (a gpg-agent.conf pinentry-program, for example, would see the passphrase). The manifest is
# recorded only after a complete copy, so an interrupted rebuild is rebuilt again. The per-uid parent
# is created by and private to this user even when TMPDIR is unset and /tmp is shared. Nothing is
# written to stdout: git reads the signature from it.
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
base=$tmp_root/dsh-gnupg-$uid
seed=$base/seed
stamp=$seed/.gpg-dsh-manifest

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$@"; }
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

# A real directory owned by this user; anything else is left alone.
owned_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]
}

# Runs "$1" once with every seed input as an argument, each a path relative to the real homedir. The
# manifest and the copy take the same list, so every input is a trigger.
with_inputs() {
  action=$1
  set --
  for path in "$real_home"/*.kbx "$real_home"/*.gpg "$real_home"/private-keys-v1.d/*; do
    [ -f "$path" ] && set -- "$@" "${path#"$real_home"/}"
  done
  "$action" "$@"
}

# One digest process for every input: on macOS `shasum` is a perl script, and one per file added a
# perl start per seeded file to every sandboxed commit.
digest_inputs() {
  [ "$#" -eq 0 ] || (cd "$real_home" && sha256 -- "$@")
}

copy_inputs() {
  for name in "$@"; do
    cp -p "$real_home/$name" "$seed/$name" || return 1
  done
}

# GnuPG components read their options from the homedir: gpg.conf (and gpg.conf-<version>),
# gpg-agent.conf, scdaemon.conf, common.conf and the like.
seed_has_config() {
  for path in "$seed"/*.conf "$seed"/*.conf-*; do
    if [ -e "$path" ] || [ -L "$path" ]; then return 0; fi
  done
  return 1
}

# Earlier helpers kept the seed in a parent shared by every user, $TMPDIR/dsh-gnupg/<uid>. Remove
# that copy of the keys and its agent; the parent is touched only when this user owns it.
legacy_base=$tmp_root/dsh-gnupg
legacy_seed=$legacy_base/$uid
if owned_dir "$legacy_base" && owned_dir "$legacy_seed"; then
  gpgconf --homedir "$legacy_seed" --kill gpg-agent >/dev/null 2>&1 || :
  rm -rf "$legacy_seed" || die "cannot discard the legacy seed $legacy_seed"
  rmdir "$legacy_base" 2>/dev/null || :
fi

# Read the inputs before copying them: a change made during the copy then leaves a manifest that
# no longer matches, and the next call rebuilds.
manifest=$(
  LC_ALL=C
  export LC_ALL
  printf 'source %s\n' "$real_home"
  with_inputs digest_inputs
) || die "cannot read $real_home"

private_dir "$base"
[ -L "$seed" ] && die "$seed is a symbolic link"
recorded=
if [ -e "$seed" ]; then
  if [ ! -d "$seed" ] || [ ! -O "$seed" ]; then
    die "$seed is not a directory owned by uid $uid"
  fi
  if [ -f "$stamp" ] && [ ! -L "$stamp" ] && ! seed_has_config; then
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
  with_inputs copy_inputs || die "cannot copy $real_home into $seed"
  printf '%s\n' "$manifest" >"$stamp" || die "cannot record $stamp"
else
  private_dir "$seed"
fi

umask "$caller_umask"
GNUPGHOME=$seed
export GNUPGHOME
exec gpg "$@"
