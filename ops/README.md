# VPS operations

Production runs as `ai-ubq-fi.service` on `codex@vps.pavlovcik.com` (129.158.58.222). All service files and data belong
to `/home/codex/repos/ubiquity/ai.ubq.fi`.

- `ops/ai-ubq-fi.service`: enabled systemd service; starts at boot and restarts after exit.
- `ops/Caddyfile`: HTTPS reverse proxy, imported by `/etc/caddy/Caddyfile`.
- `ops/caddy-ai-ubq-fi.conf`: narrow read-only mounts for Caddy, which otherwise cannot access home directories.
- `.data/caddy/`: origin TLS key and certificate; the key stays on the VPS. The certificate expires on 2041-09-06.

The systemd unit and Caddy drop-in are symlinks to their files in `ops/`. Caddy reads its configuration and TLS material
through the two read-only mounts. The existing Caddy sites remain in the system Caddyfile.

## Operate the service

From the VPS repository root:

```sh
sudo systemctl status ai-ubq-fi.service
sudo journalctl -u ai-ubq-fi.service -n 100 --no-pager
sudo systemctl restart ai-ubq-fi.service
curl --fail http://127.0.0.1:7999/health
```

The verified Bun launcher explicitly loads the repository-root `.env`; automatic dotenv discovery is disabled. Keep `DENO_TIMELINE=production` in the service
unit so paid billing reconciliation, capacity sampling, and telemetry pruning run on the VPS. Do not add Deno Deploy
identity variables to `.env`; they cause the VPS launcher to reject startup.

## Deploy a change

Required GitHub CI checks must pass first. GitHub no longer deploys to Deno Deploy.

```sh
git fetch origin development
git merge --ff-only origin/development
bun run deploy:vps
```

The command validates the canonical VPS repository root before anything else, then requires a clean tracked checkout on
`development` whose `HEAD` exactly equals the existing `origin/development` tracking ref before it touches `.data`. It
takes the exclusive deployment lock, revalidates the same checkout under that lock so a queued deployment cannot release
a revision from before the wait, and only then captures the candidate commit, archives it, stamps its Git identity,
atomically selects the new release, validates the composed Caddy configuration and applies it with
`systemctl reload caddy`, restarts only the gateway, and checks the exact health identity on the loopback listener and
on the public `https://ai.ubq.fi/health` route. It fails closed when the branch, `HEAD`, or tracking ref does not match,
and it never fetches, pulls, or switches branches itself: if `origin/development` is missing or stale, refresh it with
the existing `git fetch origin development` step above. It refuses to overwrite an existing release. Use
`systemctl restart` to restart the current release.

Verify authenticated inference and the public health route after deployment. A health response alone does not prove
provider inference. The startup message, health body, and response headers identify the same immutable Git revision.

To roll back Bun code, atomically select a previously accepted Bun release and restart the service, preserving `.env` and the latest `.data/kv-bun.sqlite3`. Returning to Deno requires the stopped-store codec procedure below; never restore a stale legacy database.

After any repository change that touches `ops/ai-ubq-fi.service`, run `sudo systemctl daemon-reload` before the next
restart: systemd keeps the previously loaded unit until it reloads. Releases created before the release-root launcher
change are not rollback targets, because they execute the checkout's launcher and Deno configuration instead of their
own. Keep a release created after this change as the rollback baseline.

## Data migration and recovery

The 2026-09-10 migration retained the complete Deno export privately in `.kv-migration/production-20260910.ndjson`. The
import preserved 366,442 records and verified a matching full checksum. Four transient records were omitted: two login
sessions, one rate window, and one backfill cursor. Existing API keys, passkey credentials, provider credentials, model
configuration, and usage history were retained. Users can sign in again with their existing passkeys.

The export format does not include Deno's native expiry metadata. Imported historical rows are retained locally; new
writes use the application's normal expiry rules. The private import receipt records the count and checksum.

Back up `.env`, `.data/kv.sqlite3`, and `.data/caddy/`. Use a consistent SQLite backup or stop only the gateway while
copying the database; a plain copy of a live SQLite file can omit its WAL. The original export is a migration snapshot,
not an ongoing backup of new VPS writes.

## DNS and TLS

Cloudflare proxies the explicit `ai.ubq.fi` A record to 129.158.58.222. A Worker route for `ai.ubq.fi/*` with no script
excludes this hostname from `*.ubq.fi/*`; both are required. Leave other hostnames and the wildcard Worker unchanged.
The origin uses a Cloudflare Origin CA certificate, so direct Mac tests must explicitly trust the Cloudflare Origin CA
root and use `curl --resolve ai.ubq.fi:443:129.158.58.222`. Public clients use the normal Cloudflare edge certificate.

## Bun runtime and offline cutover

Application TypeScript executes directly in checksum-pinned Bun 1.4.0. Runtime archives, extracted binaries, frozen dependency trees and the Linux native containment payload are verified before immutable publication and service interruption. Launchers use `--no-env-file --no-install`; they load only the selected repository-root dotenv file. Missing or corrupt runtime, dependency or native payloads fail closed without downloading, installing or compiling at startup. The previous Deno runtime store and immutable releases remain untouched.

Both deployment and manual release retention share the POSIX `.data/deploy.lock`, interoperating with the retained Deno deployment lock. CI runs complete Bun gates, verifies the materialized Linux ARM64 artifact, and requires a real macOS Seatbelt acceptance job. CI contains no automatic deployment. Linux uses the packaged Landlock/seccomp helper before application imports; systemd also mounts `.data/releases` and `.data/runtimes` read-only. Missing native homes/control directories receive no Landlock grant; restart after the native daemon creates them. macOS starts the Bun application under Seatbelt, restricting reads, writes and subprocess creation.

Deploy and service startup require an existing regular `.data/kv-bun.sqlite3` with the explicit Bun/JSC codec marker. They never open, rewrite or convert the legacy `.data/kv.sqlite3`. Plan an authorized downtime separately: drain and stop the old service, preserve consistent database backups, convert the stopped legacy source into a NEW Bun target with `bun --no-env-file src/kv-conversion/cli.ts --direction deno-to-bun --source <legacy> --destination <new-bun-db> --receipt <new-receipt> --deno <pinned-deno> --deno-sha256 <pin>`, verify its complete row/revision/expiry receipt, and only then deploy the accepted Bun release. The Deno helper is an offline codec tool, separate from application/build/test runtime.

Automatic recovery to a legacy Deno release is refused after a Bun startup attempt. For an explicitly authorized codec rollback, stop and drain Bun, preserve its latest durable database and retained Deno source, move the original Deno destination aside, then convert the latest stopped Bun state to the NEW `.data/kv.sqlite3` target with `--direction bun-to-deno` and a private mode-600 `.data/bun-rollback-receipt.json`. The receipt schema is `uos-kv-runtime-conversion-v1`; source hash, codec, path and absent/empty WAL must prove the latest stopped state, and the newly converted destination hash must match. The supported VPS legacy launcher checks that receipt before adopting it and records its identity for later Deno restarts; starting Bun invalidates that adoption. On Mac, restore the archived Deno launch-agent profile and managed Deno runtime only after the same verified latest-state conversion. Repointing code to an old DB or restoring the original migration backup discards subsequent writes and is never a rollback procedure.

Health must retain the full SHA and `vps-<sha>` or `mac-<sha>` in its body and both identity headers. VPS acceptance also requires the public ingress identity and the separately authorized authenticated Mac-to-VPS inference proof; these checks are not supplied by artifact verification alone.
