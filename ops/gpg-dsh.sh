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
# change - stops the seed's gpg-agent and rebuilds it before gpg runs. So does a GnuPG configuration
# file in the seed: the helper never writes one, and a planted pinentry-program could capture the
# passphrase. Rebuilds copy into a private sibling and publish it whole under a lock. Nothing is
# written to stdout: git reads the signature from it.
set -u

# Set while this call holds the rebuild lock or owns a staging or set-aside copy of the seed.
lock=
lock_token=
breaker=
stage=
old=

# All lock-directory mutations, including mkdir + owner write, share the breaker gate. Otherwise a
# stale blank-owner observation or a delayed holder's cleanup could still delete a fresh lock.
take_breaker() {
  # Some mkdir implementations report success after a concurrent EEXIST. Shell noclobber creates a
  # regular gate file exclusively instead. Reject existing special nodes before opening anything.
  [ ! -e "$lock.break" ] && [ ! -L "$lock.break" ] || return 1
  (set -C; : > "$lock.break") 2>/dev/null
}

release_breaker() {
  [ -n "$breaker" ] || return 0
  # A signal after removal may run cleanup after another caller has acquired the path. Relinquish
  # ownership first so cleanup cannot remove that caller's gate. Failed removal stays fail-closed.
  set -- "$breaker"
  breaker=
  rm "$1"
}

release_lock() {
  [ -n "$lock_token" ] || return 0
  releasing_token=$lock_token
  lock_token=
  release_start=$(date +%s) || return 1
  while [ -z "$breaker" ]; do
    if take_breaker; then
      breaker=$lock.break
      break
    fi
    # A stale holder may already have lost its lock; it must not remove the replacement.
    [ "$(cat "$lock/owner" 2>/dev/null)" = "$releasing_token" ] || return 0
    release_now=$(date +%s) || return 1
    [ $((release_now - release_start)) -lt "$lock_wait_seconds" ] || return 1
    sleep 0.1 2>/dev/null || sleep 1
  done
  release_status=0
  if [ "$(cat "$lock/owner" 2>/dev/null)" = "$releasing_token" ]; then
    rm -rf "$lock" || release_status=1
  fi
  release_breaker || release_status=1
  trap - HUP INT TERM
  return "$release_status"
}

# Drops what this call holds: a partial or stale copy of the keys, then the rebuild lock.
cleanup() {
  [ -z "$stage" ] || rm -rf "$stage" 2>/dev/null
  [ -z "$old" ] || rm -rf "$old" 2>/dev/null
  release_lock
  release_breaker 2>/dev/null
  breaker=
  stage=
  old=
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

# A real directory owned by this user; anything else is left alone during legacy cleanup.
owned_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]
}

# The manifest and the copy walk the same list, passing relative names as separate arguments.
with_inputs() {
  action=$1
  set --
  for path in "$real_home"/*.kbx "$real_home"/*.gpg "$real_home"/private-keys-v1.d/*; do
    [ -f "$path" ] && set -- "$@" "${path#"$real_home"/}"
  done
  "$action" "$@"
}

# macOS shasum is a perl script: start it once per manifest, not once per input.
digest_inputs() {
  [ "$#" -eq 0 ] || (cd "$real_home" && sha256 -- "$@")
}

copy_inputs() {
  for name in "$@"; do
    cp -p "$real_home/$name" "$stage/$name" || return 1
  done
}

# GnuPG components read options from these files; none belongs in a seed built by this helper.
seed_has_config() {
  for path in "$seed"/*.conf "$seed"/*.conf-*; do
    if [ -e "$path" ] || [ -L "$path" ]; then return 0; fi
  done
  return 1
}

# Retire the earlier layout, including interrupted rebuilds, under the new layout's rebuild lock.
# Never touch another user's shared parent or follow a planted symbolic link.
legacy_base=$tmp_root/dsh-gnupg
legacy_seed=$legacy_base/$uid
has_legacy_seed() {
  owned_dir "$legacy_base" || return 1
  for path in "$legacy_seed" "$legacy_seed".lock "$legacy_seed".lock.break "$legacy_seed".new.* "$legacy_seed".old.*; do
    if owned_dir "$path"; then return 0; fi
  done
  return 1
}

discard_legacy_seed() {
  has_legacy_seed || return 0
  gpgconf --homedir "$legacy_seed" --kill gpg-agent >/dev/null 2>&1 || :
  for path in "$legacy_seed" "$legacy_seed".lock "$legacy_seed".lock.break "$legacy_seed".new.* "$legacy_seed".old.*; do
    if owned_dir "$path"; then
      rm -rf "$path" || die "cannot discard the legacy seed copy $path"
    fi
  done
  rmdir "$legacy_base" 2>/dev/null || :
}

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

private_dir "$base"
[ -L "$seed" ] && die "$seed is a symbolic link"

# Rebuilds are serialized by $lock, a directory only one call can create. Its owner file records the
# holder's pid and start time. A lock held for $stale_lock_seconds with no live owner is recoverable.
# A live slow or hung holder retains ownership; a waiter gives up after $lock_wait_seconds.
lock=$seed.lock
stale_lock_seconds=15
lock_wait_seconds=60

take_lock() {
  wait_start=$(date +%s) || die "cannot read the clock"
  blank_since=
  trap 'die "interrupted"' HUP INT TERM
  while :; do
    if take_breaker; then
      breaker=$lock.break
      if mkdir "$lock" 2>/dev/null; then
        lock_token="$$ $(date +%s)" || die "cannot read the clock"
        printf '%s\n' "$lock_token" >"$lock/owner" || die "cannot record $lock/owner"
        release_breaker || die "cannot release the lock-breaker gate $breaker"
        return 0
      fi
      [ -L "$lock" ] && die "$lock is a symbolic link"
      owner=$(cat "$lock/owner" 2>/dev/null) || owner=
      now=$(date +%s) || die "cannot read the clock"
      owner_pid=${owner%% *}
      started=${owner#* }
      case $owner in
        *' '*) ;;
        *) started= ;;
      esac
      case $started in
        '' | *[!0-9]*)
          # No readable owner yet: allow a killed holder's incomplete acquisition 15 seconds.
          [ -n "$blank_since" ] || blank_since=$now
          started=$blank_since
          ;;
        *) blank_since= ;;
      esac
      held=$((now - started))
      # A future timestamp is clock skew, not evidence that a live lock is stale. Re-read under the
      # gate before deleting; no other breaker, acquisition, or release can replace it here.
      owner_alive=false
      case $owner_pid in
        '' | 0 | *[!0-9]*) ;;
        *) if kill -0 "$owner_pid" 2>/dev/null; then owner_alive=true; fi ;;
      esac
      if [ "$held" -ge "$stale_lock_seconds" ] && [ "$owner_alive" = false ]; then
        if [ "$(cat "$lock/owner" 2>/dev/null)" = "$owner" ]; then
          printf 'gpg-dsh: breaking the stale rebuild lock %s (owner: %s)\n' "$lock" "${owner:-none}" >&2
          # A failed removal is retried by the wait loop, not a fatal failure for this signing.
          rm -rf "$lock" || :
        fi
        blank_since=
      fi
      release_breaker || die "cannot release the lock-breaker gate $breaker"
    else
      now=$(date +%s) || die "cannot read the clock"
      owner=unavailable
    fi
    [ $((now - wait_start)) -lt "$lock_wait_seconds" ] || die "timed out waiting for the rebuild lock $lock (owner: ${owner:-none})"
    sleep 0.1 2>/dev/null || sleep 1
  done
}

# Staging (.new.*) and set-aside (.old.*) copies exist only while the lock holder rebuilds; any other
# is left from a killed rebuild and may hold a key that has since been deleted.
has_leftovers() {
  for path in "$seed".new.* "$seed".old.* "$seed"/*.new.* "$seed"/*.old.*; do
    if [ -e "$path" ] || [ -L "$path" ]; then return 0; fi
  done
  return 1
}

discard_leftovers() {
  for path in "$seed".new.* "$seed".old.* "$seed"/*.new.* "$seed"/*.old.*; do
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
  # Portable mv can nest a stage if a destination reappears after the guard. Remove any such key
  # copies and fail closed; do not rely on GNU-only mv -T on the owner's Mac.
  if has_leftovers; then
    discard_leftovers
    die "unexpected seed copy after publishing $seed"
  fi
}

# Steady state takes no lock. A mismatch, a missing seed (another call may be swapping it), or a
# leftover copy waits for the lock and checks again, so a burst of calls after one input change
# rebuilds once and the rest reuse that seed.
read_recorded
manifest=
[ -z "$recorded" ] || read_manifest
if [ -z "$recorded" ] || [ "$recorded" != "$manifest" ] || has_leftovers || has_legacy_seed || ! chmod 700 "$seed" 2>/dev/null; then
  take_lock
  discard_legacy_seed
  discard_leftovers
  [ -L "$seed" ] && die "$seed is a symbolic link"
  if [ -e "$seed" ] && { [ ! -d "$seed" ] || [ ! -O "$seed" ]; }; then
    die "$seed is not a directory owned by uid $uid"
  fi
  read_recorded
  if [ -z "$recorded" ] || [ "$recorded" != "$manifest" ]; then
    # The inputs may have changed while this call waited; copy what they are now.
    read_manifest
    [ "$recorded" = "$manifest" ] || rebuild_seed
  fi
  private_dir "$seed"
  release_lock || die "cannot release the rebuild lock $lock"
fi

umask "$caller_umask"
GNUPGHOME=$seed
export GNUPGHOME
exec gpg "$@"
