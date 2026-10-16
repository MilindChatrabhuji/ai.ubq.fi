# Provider Decision Journal

This append-only journal records material decisions about provider routing, reliability, capacity, fallback, and
operations for `ai.ubq.fi`. Add a dated entry when a decision changes observable provider behavior. Do not rewrite old
entries when a decision changes; add a new entry that supersedes the earlier one.

Each entry must distinguish the decision from its implementation, validation, deployment, and live acceptance state.

## 2026-09-24 — A refused Ultra tier stays on `-fast` until the vendor's own reset instant

### Decision

A `429` from `deepseek-ai/DeepSeek-V4.1-Flash-ultra` still retries that one request on its sibling, and now also opens
an in-process window: every later request for the Ultra tier is dispatched straight to
`deepseek-ai/DeepSeek-V4.1-Flash-fast` until the reset instant the refusal's own headers named (`retry-after-ms`, then
`retry-after`, then the later `x-ratelimit-reset-*` delta). Once that instant passes, Ultra is asked again, and a fresh
refusal reopens the window. A refusal that names no window, or carries `x-should-retry: false`, opens nothing and stays
a per-request failover. The window is per gateway process and only for the mapped pair, so a tier without a configured
sibling never accumulates state.

The sibling's own model id is likewise accepted as the answer to an Ultra request, and only for that pair: the vendor
self-echoes `deepseek-ai/DeepSeek-V4.1-Flash-fast` when that tier serves, so without the allowance every `-fast`
failover failed closed as `lithos_upstream_invalid_response` (502). A response naming the sibling with no failover
behind it is still rejected, and the client-facing model id stays the one requested.

### Why

The owner asked for the routing to return to Ultra once the header's reset time passes, and for the change to stay
scoped to LithosAI and to the Ultra tier. The echo allowance is needed because `-ultra-chat` folded onto
`/models/DeepSeek-V4.1-Flash` and passed the unchanged guard, while `-fast` self-echoes (both probed 2026-09-24).

### Status

Implemented in `src/provider/lithos-rate-limits.ts` (the windows), `src/provider/lithos.ts` (the scoped echo acceptance,
threaded through the buffered and streamed readers) and `src/provider/lithos-handlers.ts` (window-aware dispatch), with
coverage in `tests/lithos-wiring.test.ts`. Merged as PR #506 (`3df84b307`) and deployed to both surfaces -
`mac-3df84b307a70906231262d80a0f608a8b9d97770` and `vps-3df84b307a70906231262d80a0f608a8b9d97770` - both
health-verified, with the public `/health` carrying the full SHA in its body and identity headers.

Live acceptance 2026-09-24 20:45-20:46Z on the Mac gateway: a 70-way concurrent Ultra burst saturated both tiers - every
refused request was retried on `-fast` (failover lines recording `sibling_model` `-fast`, `rate_limit_failover_model` on
the terminals, `rate_limit_wait_ms: null` throughout) and the 17 requests that outlived both buckets were relayed as the
vendor's own 429 rather than waited for; the following 30-way burst was served 30/30, with 13 of them dispatched
straight to `-fast` from the window this burst had opened; and the first probe after the vendor's reset instant was
dispatched to Ultra again with no failover line.

## 2026-09-24 — The Ultra refusal target moves from `-ultra-chat` to `-fast`

### Decision

A `429` on `deepseek-ai/DeepSeek-V4.1-Flash-ultra` now load-balances that single request onto
`deepseek-ai/DeepSeek-V4.1-Flash-fast` instead of `-ultra-chat`. Nothing else changes: one immediate retry, the vendor's
own refusal relayed when the target refuses too, and no waiting unless `LITHOSAI_RATE_LIMIT_WAIT` is set on the host.

### Why

LithosAI told the owner on 2026-09-24 that `-ultra-chat` is tuned for short context windows and loses accuracy on the
large-context sessions this route serves, and recommended the `-fast` tier instead. Probed against the live vendor the
same day, before wiring it: `-fast` reports its own `x-ratelimit-remaining-*` counters (independent of ultra's), accepts
`reasoning_effort` none..max with `reasoning_content` on the wire, returns `get_weather` tool calls, and answered a
needle prompt at 106,403 prompt tokens correctly.

### Status

Implemented in `src/provider/lithos-rate-limits.ts` (the sibling map) with coverage in `tests/lithos-wiring.test.ts`;
this supersedes the Ultra mapping in the entry below. Merged as PR #505 (`4ef4a55ff`) and superseded within the hour by
PR #506 (`3df84b307`), which added the sticky window and the scoped sibling-echo acceptance this mapping needs - without
it a `-fast` failover failed closed as `lithos_upstream_invalid_response` (502) because the vendor self-echoes the
`-fast` id. Both surfaces now run `3df84b307a70906231262d80a0f608a8b9d97770`.

## 2026-09-24 — A LithosAI refusal is load-balanced onto the sibling tier, and waiting is opt-in

### Decision

The direct LithosAI route no longer waits out a rate-limit window by default. A `429` on the requested tier immediately
retries that single request against the tier's configured sibling - `deepseek-ai/DeepSeek-V4.1-Flash-ultra` to
`deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat` - and, if the sibling refuses too, relays the refusal with the vendor's own
status, code and rate-limit headers. No pause, no keepalive hold, no deferred stream, no jitter, no attempt budget, and
no streamed five-minute window.

Waiting is now a switch: with `LITHOSAI_RATE_LIMIT_WAIT` set to a truthy value on a host, a refusal whose own headers
name a retry window (`retry-after-ms`, then `retry-after`, then the later `x-ratelimit-reset-*` refill delta) is waited
out and the same model id retried, bounded at 75 s per attempt, 90 s in total and three dispatches per request. The
window is waited inline on both routes, and `rate_limit_wait_ms` is reported only when the switch waits.

### Why

The two ids are the same 552B weights behind separate per-model rate-limit buckets, so one immediate load-balance
attempt costs nothing and needs no clock; the owner asked for that simplification on 2026-09-24 and for the header-timed
retry to stay available behind an explicit switch rather than as the default.

### Status

Implemented in `src/provider/lithos-rate-limits.ts` (sibling map, header parsing, caps, opt-in switch),
`src/provider/lithos-handlers.ts` (failover-then-relay dispatch loop) and `src/provider/stream-relay.ts` (the
pending-source contract the deferred wait needed is gone), with coverage in `tests/lithos-wiring.test.ts`. Supersedes
the 2026-09-24 wait entries below for the default behavior; their sibling mapping, header precedence, telemetry names
and safety caps are retained.

## 2026-09-24 — An Ultra refusal fails over once per request to the sibling tier's own bucket

### Decision

When the requested LithosAI tier refuses a request with 429, the gateway first tries that tier's configured sibling -
the same weights served under a separate per-model rate-limit bucket - for that request, before any wait. The mapping is
one pair, `deepseek-ai/DeepSeek-V4.1-Flash-ultra` to `deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat`; a model with no
configured sibling keeps the wait-only behavior. The sibling is tried at most once per request, only after the requested
tier itself refused, and only when every attempt so far addressed the requested tier. If the sibling also refuses, the
wait policy applies to the sibling - behind the open stream for streamed requests.

The client's requested model id is never rewritten, the substitution is announced by `lithos_rate_limit_failover` and
recorded as `rate_limit_failover_model` on the request terminal, and the vendor's own model identity stays on the wire.
Failover is deliberately per request and one-way: it buffers a saturated bucket instead of changing any client's
configured model.

### Why

Probed 2026-09-24 against the live vendor and through this gateway: the two ids are the same 552B weights behind
independent `x-ratelimit-remaining-*` counters, and `-ultra-chat` returned the identical `get_weather` tool call on the
raw wire and on both gateway routes (`/v1/chat/completions` and a streamed `/v1/responses` with `reasoning.effort: max`,
ending in `response.completed` with a `function_call` item). A refusal on one tier therefore says nothing about the
other, and a coding turn that would otherwise wait out a saturated window can be served immediately from the sibling's
bucket.

### Status

Implemented in `src/provider/lithos-rate-limits.ts` (sibling map, failover logging, `rate_limit_failover_model`
telemetry) and `src/provider/lithos-handlers.ts` (the failover step in the dispatch loop), with coverage in
`tests/lithos-wiring.test.ts`. Merged as PR #501 (`3848c94ca`) and deployed to both surfaces -
`vps-3848c94cabed64590d8bf462636defb2685f1429` and `mac-3848c94cabed64590d8bf462636defb2685f1429` - both
health-verified.

Live acceptance 2026-09-24 15:20Z on the VPS: a 96-way concurrent Ultra burst over the loopback produced 54
`lithos_rate_limit_failover` events and 54 terminals served by `deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat` - every
failover recovered - alongside 42 absorbed waits. The 30 requests that still ended 429 were that burst saturating both
tiers (96 requests against two 60-request buckets) and exhausting the wait budget. A public authenticated streamed
`/v1/responses` with tools and `reasoning.effort: max` returned a `get_weather` `function_call` and `response.completed`
on the same release.

## 2026-09-24 — A streamed LithosAI refusal is absorbed for up to five minutes behind the open stream

### Decision

A streamed request that meets a LithosAI 429 with a waitable window no longer waits silently before its response begins.
The handler opens the SSE stream first, and the wait plus its retries run behind it while the gateway's standard
`: keepalive` frames hold the client. The streamed wait policy is a five-minute total budget, the same 75-second
per-attempt cap, and a 20-dispatch safety cap. Buffered requests keep the previous policy (75 s per attempt, 90 s total,
three dispatches), because nothing can hold a silent buffered response through an edge proxy's read bound.

If the streamed budget is spent, the refusal travels in-band with the vendor's own code (`rate_limit_exceeded`, or
`provider_overloaded` at capacity) in the Responses `response.failed` terminal or the Chat error frame, since a status
can no longer be returned. A cancellation or a gateway deadline that ends a wait keeps its own terminal and emits no
error frame. Every absorbed wait is reported as `rate_limit_wait_ms` on the request terminal.

### Why

Production evidence from 2026-09-24 08:46-08:50Z: a VPS Codex session failed with
`exceeded retry limit, last status: 429 Too Many Requests` while the same window logged 18 waits and 46 served Ultra
requests. The organization-wide, per-model bucket was saturated for about three and a half minutes - longer than the
previous 90-second budget - so one request relayed a 429 and the client's own four-retry limit then failed the turn.
Client tolerance is about ten minutes, so absorbing the window is the difference between one slow request and one failed
agent turn.

### Status

Implemented in `src/provider/lithos-handlers.ts` (streamed wait policy and pending dispatch),
`src/provider/lithos-rate-limits.ts` (the policy, header parsing and wait) and `src/provider/stream-relay.ts`
(pending-source support and in-band refusal reporting), with `rate_limit_wait_ms` in the request telemetry and terminal
log. Merged as PR #501 (`3848c94ca`) and deployed to both surfaces at `3848c94cabed64590d8bf462636defb2685f1429`,
health-verified.

Live acceptance 2026-09-24 15:20Z on the VPS: the same 96-way Ultra burst logged 42 absorbed waits while 66 requests
were served. The same day's 08:46-08:50Z window - 18 waits and 46 served Ultra requests, then one request outliving the
previous 90-second budget and failing a client turn - is the case this entry exists to remove.

## 2026-09-24 — LithosAI rate-limit refusals are waited out and retried on the same model id

### Decision

A `429` from the direct LithosAI route is no longer relayed immediately when the vendor's own retry hints name a window
the gateway can wait out. The gateway waits for that window and retries the SAME model id on the same provider, bounded
at 75 s per attempt, 90 s in total and at most three dispatches per request, with abort-aware sleeping and a small
jitter so requests refused the same window do not retry in lockstep.

The wait is derived in the vendor's own precedence: `retry-after-ms`, then `retry-after` (seconds or HTTP date), then
the later of the two `x-ratelimit-reset-*` refill deltas. A refusal that names no window, a refusal carrying
`x-should-retry: false`, a window beyond the caps, or an exhausted attempt budget is relayed unchanged with the vendor's
status, its `rate_limit_exceeded` / `provider_overloaded` code and its rate-limit headers. No other provider or model is
ever substituted, and a LithosAI 429 still never advances the Codex -> Surplus -> OpenLux waterfall: this is a retry of
the pinned route, not a failover.

Both LithosAI streamed routes now also carry the gateway's standard `: keepalive` SSE comment frames.

### Why

The vendor's limits are per-minute budgets per model shared by the whole organization (probed 2026-09-24: 60
requests/min and 4,000,000 tokens/min on the ultra tier), while one Codex or DSH step sends roughly 150k input tokens,
so ordinary fan-out trips the org input-token budget mid-step. The observed refusals carry a short refill delta
(`x-ratelimit-reset-tokens: 3.23s`), so failing the request instead of waiting for the refill throws away a whole agent
step for a pause measured in seconds. Before this entry a pinned direct provider had no retry seam at all, and the
refusal reached the client as a terminal `response.failed`.

### Status

Implemented in `src/provider/lithos-handlers.ts` (wait policy and wait-aware dispatch loop), `src/provider/lithos.ts`
(route comment) and later split with the policy moving to `src/provider/lithos-rate-limits.ts`, with coverage in
`tests/lithos-wiring.test.ts`. Merged as PR #500 (`aac3b2c31`) and deployed from there; superseded on 2026-09-24 by PR
#501 (`3848c94ca`), which raises the streamed budget and adds the sibling failover. Both surfaces currently run
`3848c94cabed64590d8bf462636defb2685f1429`.

## 2026-09-22 — Reinstate a finite process-resource guard, narrowly superseding the 2026-08-25 admission ban

### Decision

The owner-authorized reliability program adds one finite process-resource guard to the terminal inference routes, and
this entry supersedes the 2026-08-25 entry "Remove Codex admission control" **only** for that guard; every other
prohibition in that entry stands.

The guard is one process-wide controller with 64 active permits, 128 waiting requests, and a 5-second maximum queue
wait. Waiting turns rotate fairly across authenticated principals (a principal keeps arrival order inside its own
queue), a permit releases idempotently, and there is no per-principal active cap, no caller-lane lease, no lane
derivation from thread/session/prompt identity, and no `codex_admission_busy` response.

A permit is acquired after authentication and before any provider dispatch or quota reservation, and it is held until
the request's response body and delivery settle - drain, client cancellation, or teardown - because the guarded resource
is the gateway's own process resources: an open upstream transport, its retained response buffer, and the in-flight
response wrapper. A permit that is never released because an event-loop timer has not run is not acceptable, so the
grant path re-checks the elapsed queue wait and expires an overdue waiter instead of admitting it past the advertised
bound.

### Why resource occupancy differs from upstream quota

The guard measures how much work this process is currently holding, not how much capacity any provider or account has
left. Its refusal is a local `503` with a dedicated `local_inference_overload` code and a bounded `Retry-After`; it is
never provider quota, capacity, or a transport outcome. Saturation therefore never advances the provider waterfall and
never reaches the paid-fallback ledger, and a transient upstream timeout, stall, 5xx, or network error still cannot move
the waterfall either.

One durable global active Codex subscription still serves concurrent requests; this guard never caps a principal's
active permits and never balances accounts or restores per-key affinity. It also does not replace or restore the removed
caller-lane admission system: an unrelated caller can still reach dispatch concurrently, and the only global bound is
the finite process-resource limit above.

### Status

Implementation is local and uncommitted on the reliability branch: `src/inference_admission.ts` plus the
`src/handler.ts` wiring (authenticated stable principal, overload refusal, permit lifetime through response settlement,
cancellation before transport, and queue-wait telemetry).

Validation so far: the focused admission fixture (`tests/oss-inference-admission.test.ts`) covers the active bound, the
waiting bound, finite queue wait, cancellation-safe removal, fair rotation, and idempotent release; it was captured
locally. On the frozen candidate at HEAD `d71cf726eb3004264501671ed665692313ed72f5` plus the resolved merge and worktree
changes, the registered real HTTP capture passed all three cases - admission overload, queued abort without dispatch,
still-open Chat and Responses disconnect interruption with observed-usage preservation, and bounded optional-analytics
shutdown (repository key `591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5`, receipt
`348beddd-498c-4eac-a8ad-1bb7bc9a180b`, 13411ms) - and the registered integrated capture passed together with all five
module suites (receipt `64b8b95b-3e9b-41bf-b93e-188a3d6092d0`, 23915ms). Full `sh scripts/verify.sh` is still pending.
This guard is **not deployed**, and no production provider status is claimed.

## 2026-08-25 — Remove Codex admission control

### Status

- Decision: accepted by the service owner.
- Implementation: complete on local `development`.
- Validation: complete for the local build, lint, focused provider suites, and standard repository test task.
- Commit: none yet.
- Push: not performed.
- Deployment: not performed or authorized.
- Live acceptance: not performed.

### Trigger

Several independent `plz` requests using `gpt-oss-120b`, `gpt-5.3-codex-spark`, and `gpt-5.6-sol` failed with the
client-visible message `API error: "Unknown error"`.

Production telemetry for request `a8fc2006-dbd2-42a7-8c31-c686071e2373` on Git SHA
`0d795e28e42be63bbd7f0d4ce44d8ea0f6ab9d4a` and Deno revision `hbw1zer2k6pz` recorded:

```json
{
  "event": "codex_attempt",
  "attempt": 1,
  "slot": 1,
  "phase": "initial",
  "status": null,
  "status_class": "admission_caller_busy"
}
```

This proves the gateway rejected the request before upstream model dispatch. The failure was not an upstream HTTP
response, model error, or quota response.

### Decision

Remove the Codex admission-control system from the inference path as a hard cutover. Do not replace it with another
gateway concurrency limit, caller-lane lease, queue, or compatibility fallback.

Let the serverless gateway scale normally and let each upstream provider enforce its own capacity and quota limits.
Preserve existing routing behavior for authoritative upstream auth, quota, timeout, and transport outcomes.

### Rationale

The admission system did not provide a reliable capacity signal. It derived a caller lane from thread, session, prompt
cache, or authenticated-principal identity. When clients omitted the more specific metadata, unrelated requests using
the same credential could collapse into one lane.

The `caller_busy` result then stopped routing immediately. It could reject a request while gateway compute, other
account slots, sibling accounts, and other models still had capacity. Rapid retries repeated the same rejection, and the
client hid the structured `codex_admission_busy` response as `Unknown error`.

This created a gateway-originated outage mode without proving that an upstream provider was unavailable. Upstream
capacity remains finite, but speculative gateway serialization is not an accurate substitute for authoritative provider
responses.

### Removal scope

- Remove caller-lane identity derivation and distributed admission leases.
- Remove account admission slots, lease renewal, release retries, and lease-expiry stream cancellation.
- Remove the synthetic `codex_admission_busy` response and routing classification.
- Remove admission-specific image fan-out batching and release waits.
- Remove admission-only tests and update affected routing, streaming, usage, and KV-budget tests.
- Keep API-key quota reservation, account quota routing, timeout circuits, authentication handling, and paid-provider
  policy unchanged unless removal requires a direct mechanical adjustment.

### Acceptance

- Concurrent requests that previously shared an admission caller lane can reach normal provider dispatch independently.
- No runtime path reads or writes the `uos_ai/codex_admission/v1` KV namespace.
- No runtime response uses `codex_admission_busy`.
- Focused Codex routing, OpenAI compatibility, streaming, image fan-out, and KV-budget tests pass.
- Deployment and live verification require separate explicit authorization.

### Local implementation result

- Deleted `src/codex_admission.ts` and its dedicated test suite.
- Removed caller-lane derivation, account-slot leases, renewals, release retries, synthetic busy responses, and
  admission-specific stream signals.
- Removed the four-child image admission batch; all requested image children may dispatch concurrently subject to
  existing API-key quota policy and upstream behavior.
- Added a regression that dispatches eight concurrent Codex requests and requires eight upstream calls with HTTP 200
  responses.
- `deno task build` passed.
- Focused provider and quota validation passed with 111 tests.
- `deno task test` passed with 1,085 tests, 300 test steps, 12 ignored tests, and no failures; the measurement task also
  passed.
- No commit, push, deployment, or live production acceptance was performed.

## 2026-08-25 — Publish Codex admission-control removal for review

### Status

- Implementation commit: `6a5724047c033a0b33b241b0c42860d4efafdd9b`.
- Branch: `fix/remove-codex-admission-control`.
- Push: complete.
- Pull request: [#132](https://github.com/ubiquity/ai.ubq.fi/pull/132), targeting `development`.
- Local Codex review: complete with no actionable defects.
- Pull-request checks and hosted review: pending at the time of this entry.
- Deployment: not performed or authorized.
- Live acceptance: not performed.

### Decision state

The publication state above supersedes only the earlier implementation-status snapshot. The decision and removal scope
remain unchanged.

## 2026-09-18 — Mac local no-auth on a LAN-facing listener, VPS stays authenticated

### Status

- Decision: accepted by the service owner ("mac is no auth and vps has auth i guess cause vps is public").
- Implementation: complete on local `codex/mac-local-auth-20260918`.
- Validation: pending the registered focused suites and repository `verify` gate; no live acceptance yet.
- Commit: none yet.
- Push: not performed.
- Deployment: not performed or authorized. The running Mac daemon keeps its current build until an accepted deploy.
- Live acceptance: not performed; one bounded real Mac request remains a separate user acceptance step.

### Decision

The Mac companion keeps its LAN-facing `0.0.0.0:7999` listener, and authentication is decided per request by the actual
TCP peer:

- An actual numeric loopback peer (`127.0.0.0/8`, `::1`) is passwordless. It authenticates as the existing
  boot-provisioned local development principal (`src/local_development_key.ts`), so local Codex inference and the admin
  dashboard work without a credential.
- Every other peer — LAN clients, and any request that only presents a loopback URL through a forward, tunnel, or forged
  `Host` header — stays authenticated with the existing gateway credentials, for both the client and admin surfaces.
- The public VPS gateway is unchanged: it stays authenticated because it is public (Caddy to `127.0.0.1:7999`), and
  `scripts/serve-vps.ts` never enables a bypass.

### Implementation notes

- `src/local_admin_auth.ts` keeps `shouldDisableAdminAuthForListener` rejecting a non-loopback listener for the generic
  `--disable-admin-auth` path. The Mac entry point uses the narrowly named internal
  `configureMacLocalAdminAuthBypassForListener`, which accepts only the wildcard TCP listener and still requires the
  existing numeric-loopback-peer, loopback-URL, and same-origin checks in `isAdminAuthDisabledForRequest`.
- The bypass state is process-wide, but the peer is bound to the request object
  (`configureAdminAuthPeerForRequest(peer, request)`), because routing awaits before it authenticates: a single
  process-wide peer slot could otherwise be overwritten by a concurrent request, letting a LAN request inherit a
  loopback peer.
- No new CLI flag, environment variable, secret, route, or public response field was added.

## 2026-09-14 — Serial subscription routing: exhaust one Codex subscription before advancing

### Status

- Decision: accepted by the service owner; implementation merged and deployed.
- Implementation: complete on `codex/serial-subscription-routing`, merged as PR
  [#307](https://github.com/ubiquity/ai.ubq.fi/pull/307), merge commit `8bf9daad53a22abf8db4488ef1db2ac2d25c9d34`
  (ancestor of `development`).
- Validation: repository gates passed on the merged SHA; the durable active-subscription behavior is covered by the
  focused suites.
- Deployment: complete 2026-09-15 as `8bf9daad53a22abf8db4488ef1db2ac2d25c9d34`.
- Live acceptance: accepted; three authenticated VPS-origin inference requests succeeded.
- Open follow-ups: issues [#308](https://github.com/ubiquity/ai.ubq.fi/issues/308) and
  [#309](https://github.com/ubiquity/ai.ubq.fi/issues/309) (concurrent-admission edge cases).

### Decision

Route ordinary Codex inference through one durable global active subscription shared by every principal, key, and model.
Bootstrap the first eligible configured account and keep it despite headroom, idle time, restarts, old per-key
affinities, reorder, or a successful same-identity credential refresh. Move it only for authoritative model-applicable
quota or capacity exhaustion, a classified current-credential invalidity, or removal/replacement of the account in the
auth pool.

Each subscription is a separate prompt-cache and account-health identity, so spreading ordinary requests across
subscriptions keeps neither cache warm and obscures which subscription is degrading. The provider fallback chain Codex
-> Surplus -> OpenLux is intentional and ordered by cost; advance it only after authoritative exhaustion.

### Reversal risk

Restoring a retired per-key affinity override, load-balancing across subscriptions while the active one still has
capacity, or reordering the provider chain all reintroduce the cache and account-health problem this decision removed.
Do not make the order dynamic without a new dated entry.

## 2026-09-25 — LithosAI refusals have one behaviour (owner decision)

A refusal on the LithosAI route now has exactly one shape: the refused request is retried once on the tier's configured
sibling (`deepseek-ai/DeepSeek-V4.1-Flash-ultra` → `deepseek-ai/DeepSeek-V4.1-Flash-fast`), and a refusal whose own
headers name a reset instant keeps later requests on that sibling until the instant passes, after which the requested
tier is tried again. A refusal that names no window is relayed once both tiers have refused.

Removed in the same change: the `LITHOSAI_RATE_LIMIT_WAIT` opt-in that waited out a window and retried the same model
id, together with its caps and telemetry hooks. The owner asked for the simplest possible policy and confirmed the Codex
iOS client cannot read response headers, so substitution is not signalled on the response.

Reversal risk: restoring the wait switch, capping the sibling window with an invented duration, or adding a header-based
signal all reintroduce behaviour the owner's client cannot see or act on. Change this only with a new dated entry.

## 2026-09-25 — A streamed LithosAI refusal is absorbed behind the open stream again (five-minute budget)

A streamed Responses request that meets a refusal on both tiers no longer waits silently up to the buffered cap and then
relays. It opens its SSE response immediately, holds the client with the gateway's standard `: keepalive` frames, and
spends the vendor's own windows behind it: up to five waits totalling 300 seconds, the same 75-second per-wait cap, and
one sibling failover per round. If the budget is exhausted the vendor's refusal travels in-band as the stream's
`response.failed` terminal; a cancellation or gateway deadline keeps its own terminal and emits no error frame. Buffered
requests keep the smaller silent budget (two waits, 120 seconds), because nothing can hold a silent buffered response
through an edge proxy's read bound.

Why this returns: on 2026-09-25 the iOS client's `exceeded retry limit, last status: 429` was traced to the Mac
companion gateway, which had never been updated past `mac-3df84b307` while the VPS carried the fixes; its log held 152
relayed 429 terminals. The vendor's saturation windows measured three and a half minutes (2026-09-24 08:46-08:50Z and
2026-09-25 04:04-04:07Z), which the buffered 120-second budget cannot cover. The 2026-09-24 decision (PR #501,
`mac-`/`vps-3848c94ca`) absorbed five minutes behind the open stream; #509 removed it together with the wait switch.
This entry restores the streamed half of that policy on top of #509's sibling-first behaviour and #511's header-driven,
abort-aware waits, so both surfaces now share it unconditionally.

Reversal risk: relaying a waitable refusal because a silent hold looks simpler reintroduces the client-visible 429 the
streamed budget exists to remove; letting a buffered request hold silently that long reintroduces the edge read bound
the split budget exists to avoid. Coverage: `tests/lithos-wiring.test.ts` asserts the streamed budget persists past the
buffered caps, that exhaustion reports in-band, and that an unwaitable refusal still relays unchanged.

## 2026-09-25 — The streamed absorb covers the Chat Completions route too

The Mac companion gateway's own log reframed the case: of its 137 client-visible LithosAI 429s, 128 were on
`/v1/chat/completions` (106 on `deepseek-ai/DeepSeek-V4.1-Flash`), the wire the agent harness workers use, against 9 on
the Responses wire. The deferred streamed absorb therefore applies to the Chat route as well: the stream opens first,
`: keepalive` frames hold the client, the vendor's own windows are spent behind it under the same five-wait / 300-second
budget and 75-second per-wait cap, and an exhausted budget reports the refusal in-band as the Chat error frame.
`relayChatCompletionStream` accepts a pending upstream like `relayResponsesStream`, and the served tier is read after
the deferred attempt lands.

Reversal risk: leaving the Chat route on the buffered-only budget restores the client-visible 429s its own surface
logged most often; opening the stream without the in-band refusal terminal would turn a spent budget into a silent hang.
Coverage: `tests/lithos-wiring.test.ts` asserts the Chat budget past the buffered caps and the in-band exhaustion
terminal.

## 2026-09-25 — LithosAI failover walks the whole ladder, and a streamed refusal never returns an HTTP 429

Two changes close the client-visible 429 class on this route. First, the single sibling hop becomes an ordered ladder:
`-ultra` refuses -> `-fast` is tried -> the family's normal tier is tried, and each rung carries its own
4,000,000-token/minute bucket (probed live 2026-09-25: consuming 250,006 tokens on `-fast` left `-ultra` reporting
`remaining-tokens: 4000000`), so every hop moves real capacity, not just a label. The sticky window now carries its
target and deepens on each refusal, so a later request resumes at the rung the vendor last refused past instead of
bouncing back to a saturated tier. Kimi K3 gets the same ladder; `-ultra-chat` stays out for the recorded accuracy
reason.

Second, a streamed request can no longer receive an HTTP 429 from this route at all. When the ladder is exhausted (or
the vendor says do not retry), the handler opens the stream and reports the refusal in-band as `response.failed` with
the vendor's own code and message. Codex's `exceeded retry limit, last status: 429` banner requires an HTTP 429, so on
the streamed wires this route cannot produce it any more; buffered requests keep the status because no stream exists to
carry the terminal.

Why: the 2026-09-25 incidents showed the banner arriving on both the Responses wire (9 events) and the Chat wire (128
events) while the absorb was bounded or absent, and the earlier single-hop ladder assumed a shared bucket that the live
probe refutes. Reversal risk: collapsing the ladder back to one hop re-shares the saturation across tiers; returning a
status for a streamed refusal restores the banner and the client's pointless retry loop. Coverage:
`tests/lithos-wiring.test.ts` asserts the full descent, the deepening sticky window, in-band refusals on both wires, and
the buffered status path.

## Independent Lithos tier refusal windows - 2026-10-03

A refusal deadline belongs to the refused rung of the requested model ladder. New refusals extend only that rung’s
unexpired deadline, and selection chooses the highest eligible rung in the existing ladder. Each rung recovers at its
own reset; preserve native deadline and caller-cancellation reasons, bounded opt-in waits, and the existing provider
waterfall.

## 2026-10-10 — Claude OpenRouter requests enable the five-minute prompt cache

### Decision

For OpenRouter Claude models, add request-root `cache_control: { type: "ephemeral" }` on the upstream wire when the
client has not supplied a cache policy or explicit content/tool breakpoints. Preserve native Responses and Chat
Completions, client input, explicit cache controls, reasoning effort, and provider routing. Keep this provider extension
out of the public OpenAI request allowlists. Report effective cache policy and both provider cache-read and cache-write
counts without inventing zeros for absent counters.

### Why

The gateway's native OpenRouter handlers forwarded Claude requests without a default automatic-cache policy. The public
OpenAI request allowlists reject provider-specific root `cache_control`, so ordinary accepted client requests could not
enable that policy. Adding the hint on the upstream payload makes the default effective while leaving request input and
explicit controls intact.

OpenRouter documents request-root automatic caching for both native Responses and Chat Completions:
https://openrouter.ai/docs/guides/best-practices/prompt-caching. The default TTL is five minutes, and cache reads
refresh it. Hits require matching input prefixes and do not discount generated output. Longer TTLs remain explicit
choices.

### Status and reversal risk

Mock transport regressions cover streamed and buffered native requests, explicit controls, unrelated models, and missing
usage counters. These tests verify payload preservation and cache accounting; they do not establish production cache
hits or cost savings. Live cache acceptance remains a separate validation step. Removing the default leaves caching
dependent on client controls; overriding explicit breakpoints could change the selected cache behavior.
