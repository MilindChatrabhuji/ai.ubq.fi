#!/bin/sh
# gpg.program for commits signed inside DSH's workspace-write sandbox. Compare it with the installed
# helper first (diff ops/gpg-dsh.sh ~/bin/gpg-dsh): this one does not seed gpg.conf, gpg-agent.conf or
# keyboxd's public-keys.d. Then install it as ~/bin/gpg-dsh:
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

# Set while this call holds the rebuild lock or owns a staging or set-aside copy of the seed.
lock=
lock_token=
stage=
old=

# Removes the lock only while it is still this call's: a waiter may have broken it as stale.
release_lock() {
  [ -n "$lock_token" ] || return 0
  if [ "$(cat "$lock/owner" 2>/dev/null)" = "$lock_token" ]; then
    rm -rf "$lock" 2>/dev/null
  fi
  lock_token=
  trap - HUP INT TERM
}

# Drops what this call holds: a partial or stale copy of the keys, then the rebuild lock.
cleanup() {
  [ -z "$stage" ] || rm -rf "$stage" 2>/dev/null
  [ -z "$old" ] || rm -rf "$old" 2>/dev/null
  release_lock
  stage= old=
}

die() {
  printf 'gpg-dsh: %s\n' "$*" >&2
  cleanup
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
    cp -p "$real_home/$name" "$stage/$name" || return 1
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

# Earlier helpers kept the seed in a parent shared by every user, $TMPDIR/dsh-gnupg/<uid>, with their
# rebuild lock and any staging or set-aside copy (<uid>.lock, <uid>.new.*, <uid>.old.*) beside it.
# Remove those copies of the keys and the seed's agent; the parent is touched only when this user
# owns it.
legacy_base=$tmp_root/dsh-gnupg
legacy_seed=$legacy_base/$uid
if owned_dir "$legacy_base"; then
  if owned_dir "$legacy_seed"; then
    gpgconf --homedir "$legacy_seed" --kill gpg-agent >/dev/null 2>&1 || :
    rm -rf "$legacy_seed" || die "cannot discard the legacy seed $legacy_seed"
  fi
  for path in "$legacy_seed".lock "$legacy_seed".new.* "$legacy_seed".old.*; do
    if owned_dir "$path"; then
      rm -rf "$path" || die "cannot discard the legacy seed copy $path"
    fi
  done
  rmdir "$legacy_base" 2>/dev/null || :
fi

# Read the inputs before copying them: a change made during the copy then leaves a manifest that
# no longer matches, and the next call rebuilds.
read_manifest() {
  manifest=$(
    LC_ALL=C
    export LC_ALL
    printf 'source %s\n' "$real_home"
    with_inputs digest_inputs
  ) || die "cannot read $real_home"
}
read_manifest

private_dir "$base"
[ -L "$seed" ] && die "$seed is a symbolic link"

# Rebuilds are serialized by $lock, a directory only one call can create. Its owner file records the
# holder's pid and start time. A lock held for $stale_lock_seconds was left by a killed or hung holder
# (a rebuild copies a few files), so a waiter breaks it; a waiter gives up after $lock_wait_seconds.
lock=$seed.lock
stale_lock_seconds=15
lock_wait_seconds=60

take_lock() {
  wait_start=$(date +%s) || die "cannot read the clock"
  blank_since=
  while ! mkdir "$lock" 2>/dev/null; do
    [ -L "$lock" ] && die "$lock is a symbolic link"
    now=$(date +%s) || die "cannot read the clock"
    owner=$(cat "$lock/owner" 2>/dev/null) || owner=
    started=${owner#* }
    case $owner in
      *' '*) ;;
      *) started= ;;
    esac
    case $started in
      '' | *[!0-9]*)
        # No readable owner yet: a holder writes it right after mkdir, so time how long it stays blank.
        [ -n "$blank_since" ] || blank_since=$now
        started=$blank_since
        ;;
      *) blank_since= ;;
    esac
    held=$((now - started))
    if [ "$held" -lt 0 ] || [ "$held" -ge "$stale_lock_seconds" ]; then
      printf 'gpg-dsh: breaking the stale rebuild lock %s (owner: %s)\n' "$lock" "${owner:-none}" >&2
      if [ "$(cat "$lock/owner" 2>/dev/null)" = "$owner" ]; then
        rm -rf "$lock" || die "cannot break the stale rebuild lock $lock"
      fi
      blank_since=
      continue
    fi
    [ $((now - wait_start)) -lt "$lock_wait_seconds" ] || die "timed out waiting for the rebuild lock $lock (owner: ${owner:-none})"
    sleep 0.1 2>/dev/null || sleep 1
  done
  lock_token="$$ $(date +%s)" || die "cannot read the clock"
  trap 'die "interrupted"' HUP INT TERM
  printf '%s\n' "$lock_token" >"$lock/owner" || die "cannot record $lock/owner"
}

# Staging (.new.*) and set-aside (.old.*) copies exist only while the lock holder rebuilds; any other
# is left from a killed rebuild and may hold a key that has since been deleted.
has_leftovers() {
  for path in "$seed".new.* "$seed".old.*; do
    if [ -e "$path" ] || [ -L "$path" ]; then return 0; fi
  done
  return 1
}

discard_leftovers() {
  for path in "$seed".new.* "$seed".old.*; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      rm -rf "$path" || die "cannot discard the leftover seed copy $path"
    fi
  done
}

# The manifest recorded in the seed, or nothing when there is no complete seed of this user's or the
# seed holds a GnuPG configuration file.
read_recorded() {
  recorded=
  if [ -d "$seed" ] && [ ! -L "$seed" ] && [ -O "$seed" ] && [ -f "$stamp" ] && [ ! -L "$stamp" ] && ! seed_has_config; then
    recorded=$(cat "$stamp" 2>/dev/null) || recorded=
  fi
}

# Builds the new seed in a private sibling and records its manifest there, then swaps it in whole:
# no call ever sees a partly copied seed, and nothing writes into a seed another call has published.
rebuild_seed() {
  stage=$(mktemp -d "$seed.new.XXXXXX") || die "cannot create a staging seed next to $seed"
  private_dir "$stage"
  private_dir "$stage/private-keys-v1.d"
  with_inputs copy_inputs || die "cannot copy $real_home into $stage"
  printf '%s\n' "$manifest" >"$stage/.gpg-dsh-manifest" || die "cannot record $stage/.gpg-dsh-manifest"
  if [ -e "$seed" ]; then
    gpgconf --homedir "$seed" --kill gpg-agent >/dev/null 2>&1 || :
    old=$(mktemp -d "$seed.old.XXXXXX") || die "cannot create a directory to set $seed aside"
    mv "$seed" "$old/seed" || die "cannot set the stale seed $seed aside"
  fi
  # mv would move the stage into an existing directory instead of renaming it.
  if [ -e "$seed" ] || [ -L "$seed" ]; then
    die "$seed reappeared while the rebuild lock was held"
  fi
  mv "$stage" "$seed" || die "cannot move the rebuilt seed into $seed"
  stage=
  if [ -n "$old" ]; then
    rm -rf "$old" || die "cannot discard the stale seed $old"
    old=
  fi
}

# Steady state takes no lock. A mismatch, a missing seed (another call may be swapping it), or a
# leftover copy waits for the lock and checks again, so a burst of calls after one input change
# rebuilds once and the rest reuse that seed.
read_recorded
if [ "$recorded" != "$manifest" ] || has_leftovers || ! chmod 700 "$seed" 2>/dev/null; then
  take_lock
  discard_leftovers
  [ -L "$seed" ] && die "$seed is a symbolic link"
  if [ -e "$seed" ] && { [ ! -d "$seed" ] || [ ! -O "$seed" ]; }; then
    die "$seed is not a directory owned by uid $uid"
  fi
  read_recorded
  if [ "$recorded" != "$manifest" ]; then
    # The inputs may have changed while this call waited; copy what they are now.
    read_manifest
    [ "$recorded" = "$manifest" ] || rebuild_seed
  fi
  private_dir "$seed"
  release_lock
fi

umask "$caller_umask"
GNUPGHOME=$seed
export GNUPGHOME
exec gpg "$@"
