# Mac gateway service

The Mac companion listens on `http://0.0.0.0:7999` (LAN address, for example `http://192.168.4.47:7999`).
`com.ubiquity.ai.local` is a per-user launchd agent: it starts at login and restarts after exit. It does not run before
the user logs in or keep a sleeping Mac awake.

Configuration lives in `ops/com.ubiquity.ai.local.plist`, linked from `~/Library/LaunchAgents/`. The repository-root
`.env` contains the existing upstream credentials. Local Bun KV is `.data/kv-bun.sqlite3`, with the explicit `bun-jsc-v1` marker. Code runs from the immutable release
selected by `.data/current`, including its frozen dependencies, package imports and verified artifact manifest. Runtime identity is `mac-<full-git-sha>`.

## Loopback trust boundary

`scripts/serve-mac.ts` enables the keyless path for this listener and binds the actual TCP peer the Bun node:http adapter reports for each request
(`info.remoteAddr`). `src/auth/local-admin.ts` then decides that request:

- The bypass needs a numeric loopback TCP peer (`127.0.0.0/8`, `::1`) **and** a loopback request URL hostname
  (`localhost`, `::1`, or a `127.0.0.0/8` literal). If `Origin` is present it must equal the request URL origin, and if
  `Sec-Fetch-Site` is present it must be `same-origin` or `none`. A request without an observed peer fails closed.
- A qualifying request authenticates as the boot-provisioned local development principal
  (`src/auth/local-development-key.ts`), and on the admin surface as a super-admin (`is_super_admin: true`,
  `method.kind: "disabled"`).
- Every other client — LAN hosts, Tailscale peers, or any connection whose peer address is not loopback — keeps the
  existing gateway credentials for the API and the admin dashboard, even when its `Host` header names `127.0.0.1`.

The check is the connection's peer address, so a process on this Mac that accepts outside traffic and then opens its own
connection to `127.0.0.1:7999` is itself the loopback peer. A caller it forwards reaches the keyless principal only when
the forwarded request also presents a loopback URL hostname and its `Origin` and `Sec-Fetch-Site` headers satisfy or are
omitted from the checks above, as scripted clients normally do and a browser with a foreign `Origin` does not. Do not
place an unauthenticated forwarding path in front of this listener: a local reverse proxy (`nginx`, `caddy`), a tunnel
(`cloudflared`, `ngrok`, Tailscale Funnel/serve), `ssh -R`, or a container/host port map. Authenticate and authorize
callers in the intermediary before it forwards; a forwarded non-loopback `Host` is not sufficient protection, because a
forwarder that preserves a client's loopback `Host` satisfies the URL check too. The service cannot distinguish a local
human client from a local forwarder, so this boundary is operational; this file states the code's contract, and whether
a host runs such an intermediary must come from a live ingress inventory.

## Observed Mac ingress inventory (2026-10-02, bounded)

A read-only listener/process snapshot captured at 2026-10-02 19:29:45 UTC (receipt
`136210b2-9a4d-4a3e-b79d-532e4ab58a0b`) was classified against the entry sources named below. It found no
unauthenticated forwarding path to this listener; it does not prove that none can exist.

- The only 7999 listener was this service (`deno`, PID 61796). A keyless-boundary request to `/uos/auth` answered 200 on
  loopback, 401 from the LAN address, and 401 from the LAN with a forged `Host: 127.0.0.1:7999`; `/health` identities
  were `mac-d239b10…` on the Mac and `vps-d239b10…` publicly.
- PID 996 (`deno`, `*:8787`, all interfaces, no caller authentication of its own) is the fast-jev-compaction Codex
  adapter (`codex/jev-compaction-proxy.ts` in `/Users/nv/repos/0x4007/fast-jev-compaction`). Its product entrypoint
  fixes the upstream at `http://127.0.0.1:8000` and forwards ordinary requests there byte-transparently; it does not
  point at 7999. A live probe of the running process, `GET http://127.0.0.1:8787/healthz`, returned plaintext
  `fast-jev-compaction proxy ready; upstream=http://127.0.0.1:8000; compaction=responses`, and no process listened on 8000. That closes the running/source gap for this fixed upstream, because the running adapter reports the same
  upstream the reviewed entrypoint fixes; it is a point-in-time observation and does not establish that no exposure is
  possible. Only tests override that upstream.
- PID 1011 (`deno`, `*:8765`) is the Capture release download server (`server.ts` in
  `~/.local/share/prospector-release`). It answers GET/HEAD for a fixed local file set and makes no outbound request, so
  it is not a forwarding path.
- PID 17379 (`python3`, `*:8700`) was in the snapshot but no longer exists; no cwd or entry was captured, so it stays
  unclassified rather than assumed harmless.
- The other non-loopback listeners are macOS services (`rapportd` 60315, ControlCenter 5000/7000) and were not read.
  Tailscale serve and funnel are tailnet-only to `127.0.0.1:3080` and `/dsh` to `3081`, never 7999. `~/.cloudflared`
  exists with no running process observed.
- Limits: a point-in-time snapshot cannot see a forwarder started later, short-lived processes, IPv6-only sockets not
  bound at capture, or a custom launcher that imports `startProxy` with another `upstreamOrigin`. The running argv
  behind PIDs 996 and 1011 was not inspected: PID 996's classification rests on its entry source, the
  fixed-configuration decision (D4), and the live `/healthz` above, while PID 1011's rests on its entry source.

PID 996 is the concrete shape this boundary prohibits: an unauthenticated listener on all interfaces that forwards to a
loopback upstream. It does not reach 7999 today; starting a dev gateway on 8000 while it runs would create the
prohibited shape unless that adapter is authenticated or restricted. If its `upstreamOrigin` ever names 7999, a
forwarded caller becomes a loopback peer of this service only when its forwarded request passes the URL-host and
`Origin`/`Sec-Fetch-Site` checks above. Keep any such intermediary authenticated, and re-observe the host before relying
on this inventory.

Supported access:

- Local, keyless: `http://127.0.0.1:7999` — the Codex provider below and the local admin dashboard.
- LAN, authenticated: `http://192.168.4.47:7999` with existing gateway credentials; an unauthenticated `/v1/models` must
  be 401.
- Remote, authenticated: `https://ai.ubq.fi` through the VPS gateway, which serves its own loopback listener and never
  enables this bypass (`scripts/serve-vps.ts`). `GET /health` reports the identity it answered from:
  `vps-<full-git-sha>` for the VPS, `mac-<full-git-sha>` for the Mac. A public endpoint reporting a `mac-` identity
  means the Mac service is reachable through some ingress, and that ingress must be removed.

Provider quota is sampled at startup and every fifteen minutes into local KV so the Providers dashboard has current
capacity and accumulates its own history.

The daemon can read the existing synced `~/.codex/auth.json` through the gateway's normal local credential loader. Keep
the existing sign-in and cross-machine sync. This uses the gateway's existing KV credential-pool behavior after initial
loading; it does not change the synced auth file. Production scheduled billing remains on the VPS. Local capped paid
billing maintenance is tracked in [#266](https://github.com/ubiquity/ai.ubq.fi/issues/266).

From the clean Mac repository root, `bun run deploy:mac` installs the committed release and loads the launch agent.
Verify authenticated local inference after deployment before changing Codex routing. The task's health check alone does
not establish provider readiness.

```sh
launchctl print gui/501/com.ubiquity.ai.local
launchctl kickstart -k gui/501/com.ubiquity.ai.local
curl --fail http://127.0.0.1:7999/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7999/v1/models # 200: loopback needs no credential
# From another LAN host the same request must be 401 without a credential:
#   curl -s -o /dev/null -w '%{http_code}\n' http://192.168.4.47:7999/v1/models
tail -n 50 .data/mac.stderr.log
```

Use a custom Codex provider with base URL `http://127.0.0.1:7999/v1` and the Responses wire API. Loopback requests need
no credential, and an existing `UOS_AI_TOKEN` in that profile keeps working unchanged. Keep the remote `uos` provider
available for an explicit remote profile. Local inference avoids the VPS round trip; traffic between the Mac and
upstream model providers still uses the internet. The two gateways have independent usage and routing state.

## Provider analytics chart

The loopback admin's Provider analytics chart shows the VPS chart: `src/admin/chart-source-proxy.ts` reads
`/admin/providers/capacity` and `/admin/errors?limit=1` from `https://ai.ubq.fi` with the first `DENO_DEPLOY_TOKEN`
entry and replaces only the chart fields and the five-xx buckets. It never forwards the loopback query string.

Only this service pushes its own capacity samples to the VPS. The signal is the LAN listener that `scripts/serve-mac.ts`
configures; a `bun run dev` or `dev:local` server holding the same token reads the VPS chart but never pushes. Each
Analytics poll starts at most one background push, which sends only samples newer than the last one the VPS
acknowledged, oldest first and at most 512 per request. The chart read never waits for it. The rows are stored under host
`UOS_CAPACITY_OBSERVATION_HOST_ID` from `.env`, or `mac` when it is unset. An invalid id disables the push.

The VPS history stays canonical. A pushed sample is drawn only in a 15-minute bucket the VPS did not observe, and only
when every configured Codex slot in it is available and reports the same account cohorts as the nearest VPS sample
before or after it. The Mac's own 401 or unreachable samples therefore never draw an outage on the VPS chart.

## Bun runtime and offline cutover

Application TypeScript executes directly in checksum-pinned Bun 1.4.0. Runtime archives, extracted binaries, frozen dependency trees and the Linux native containment payload are verified before immutable publication and service interruption. Launchers use `--no-env-file --no-install`; they load only the selected repository-root dotenv file. Missing or corrupt runtime, dependency or native payloads fail closed without downloading, installing or compiling at startup. The previous Deno runtime store and immutable releases remain untouched.

Both deployment and manual release retention share the POSIX `.data/deploy.lock`, interoperating with the retained Deno deployment lock. CI runs complete Bun gates, verifies the materialized Linux ARM64 artifact, and requires a real macOS Seatbelt acceptance job. CI contains no automatic deployment. Linux uses the packaged Landlock/seccomp helper before application imports; systemd also mounts `.data/releases` and `.data/runtimes` read-only. Missing native homes/control directories receive no Landlock grant; restart after the native daemon creates them. macOS starts the Bun application under Seatbelt, restricting reads, writes and subprocess creation.

Deploy and service startup require an existing regular `.data/kv-bun.sqlite3` with the explicit Bun/JSC codec marker. They never open, rewrite or convert the legacy `.data/kv.sqlite3`. Plan an authorized downtime separately: drain and stop the old service, preserve consistent database backups, convert the stopped legacy source into a NEW Bun target with `bun --no-env-file src/kv-conversion/cli.ts --direction deno-to-bun --source <legacy> --destination <new-bun-db> --receipt <new-receipt> --deno <pinned-deno> --deno-sha256 <pin>`, verify its complete row/revision/expiry receipt, and only then deploy the accepted Bun release. The Deno helper is an offline codec tool, separate from application/build/test runtime.

Automatic recovery to a legacy Deno release is refused after a Bun startup attempt. For an explicitly authorized codec rollback, stop and drain Bun, preserve its latest durable database and retained Deno source, move the original Deno destination aside, then convert the latest stopped Bun state to the NEW `.data/kv.sqlite3` target with `--direction bun-to-deno` and a private mode-600 `.data/bun-rollback-receipt.json`. The receipt schema is `uos-kv-runtime-conversion-v1`; source hash, codec, path and absent/empty WAL must prove the latest stopped state, and the newly converted destination hash must match. The supported VPS legacy launcher checks that receipt before adopting it and records its identity for later Deno restarts; starting Bun invalidates that adoption. On Mac, restore the archived Deno launch-agent profile and managed Deno runtime only after the same verified latest-state conversion. Repointing code to an old DB or restoring the original migration backup discards subsequent writes and is never a rollback procedure.

Health must retain the full SHA and `vps-<sha>` or `mac-<sha>` in its body and both identity headers. VPS acceptance also requires the public ingress identity and the separately authorized authenticated Mac-to-VPS inference proof; these checks are not supplied by artifact verification alone.
