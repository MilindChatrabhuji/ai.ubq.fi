# ai.ubq.fi Decisions

Read before changing model routing, cache-read telemetry, VPS acceptance, lint configuration, or Deno app inventory.
These are scoped decisions, not general policy; they narrow global defaults only for this repository and never weaken
higher authority.

Provider routing decisions are maintained separately in `docs/provider-decision-journal.md`.

## First Bun cutover uses a stopped-state operator capability - 2026-10-15

The first cross-codec deployment uses `ops/first-bun-cutover.ts` through a private pinned operator invocation. Ordinary CLI and bound-driver tracked-clean guards remain unchanged. The new operator executes from the complete accepted CI artifact and proves current shipping push CI, every required job, hosted ZIP digest, exact Git source archive/materialized source, dependency/native/permissions trees and matching service bootstrap bytes. The mutable checkout is a data/runtime anchor and immutable Git-object store; unrelated working-tree or submodule state never supplies executable source or a fabricated clean predicate.

The operator captures actual prior health and loaded-unit identity before stop, holds the existing deployment lock and release pins, verifies and reasserts only its own kernel-enforced supervisor limit across reload/start/recovery boundaries, and journals intent before each service transition. A prepared-only recovery receipt has no stopping intent: recovery verifies the original live selector/process/unit/health and never stops or restarts it. Conversion requires a stopped, checkpointed source, private consistent backup, exclusive NEW Bun target, complete metadata/typed-value proof and full reverse proof. Starting is authorized by this verified stopped boundary instead of requiring the old writable service to restart. The separately owned Sentinel acceptance receipt is pinned and strictly compared against the final gateway artifact/runtime and all required denial evidence; its exact receipt and evidence files are bound read-only at their recorded paths inside the private namespace.

After any possible Bun startup, recovery converts the latest stopped Bun state into a NEW Deno destination. Once legacy adoption is published, later Deno writes are authoritative and recovery never overwrites them from an older Bun snapshot. A pinned offline capture and recovery entry support the supervisor's `ExecStopPost` without model, GitHub, download, install or compiler dependency during outage. Failed recovery retains every copy and reports unproved service state. Effective typed unit commands and resource-only drop-ins are pinned; an existing candidate must match the independently accepted CI manifest. Partial forward publication is retained separately while the unchanged stopped legacy source stays authoritative. Capacity includes WAL bytes and is rechecked after checkpoint. Runtime hashing streams database files, the codec cache stays task-local, and finite private phase budgets are bound in the operator authorization. Health success keeps client acceptance pending and retains release pins until the coordinator proves direct authenticated Mac-to-VPS inference and settles ownership.

This change does not authorize live activation itself; the user's explicit deployment instruction and the coordinator's exact reviewed operation remain necessary. Source CI, external-reader acceptance, stopped-store rehearsal, runtime custody and live client acceptance are separate evidence surfaces.

Both private Bun entries use a cleared environment, an independently checksum-pinned explicit Bun configuration and a frozen working directory outside the mutable checkout. Disabling dotenv discovery and auto-install alone does not block configuration preloads or inherited runtime options. Private workspaces and receipts retain mode700/600; only the source archive extraction child uses umask022 to reproduce the exact hosted CI entry modes.

The gateway launcher and its Bun legacy-rollback verifier independently select `ops/runtime-bunfig.toml`, check its fixed byte hash before invoking Bun, and remove inherited preload/module-selection options while preserving the service credential environment. That config is part of the artifact-bound bootstrap comparison; a modified root `bunfig.toml` cannot supply executable source before verification. Persisted unit identities use the existing canonical encoding so journal key sorting cannot reject unchanged live state.

## Prepared VPS artifacts use trusted constructor capabilities - 2026-10-15

Deployment fixtures bind their frozen JavaScript graph, matching native headers and independently attested native KV artifact through an internal store preparation capability. Both the graph's lock and the candidate's lock must match the bound digest before packaging. The fixture imports the exact relocated deployment entry and supplies this capability to its actual candidate preparation; service environment variables do not select packaging inputs.

The production CLI keeps real frozen dependency and native artifact preparation before immutable publication. Runtime startup only verifies and loads the published payload. Source, archive, manifest, graph, native provenance, OS confinement, fresh candidate publication and rollback checks remain unchanged. Focused hosted preflights run before the complete aggregate and never replace its acceptance.

## Authoritative unavailable subscriptions permit paid failover - 2026-10-14

The owner authorized same-model paid failover after the Mac gateway stalled on 2026-10-14.

Each selected subscription must prove exhausted applicable quota or invalid current credentials.

Only matching credential fingerprints count. Generic 429s, timeouts, probe leases and unknown state never count.

Exhaustion proof and banked-reset eligibility remain separate. Existing paid caps and provider selection still apply.

A mixed pool returns `codex_subscriptions_unavailable` with no multi-day retry delay when paid routing cannot serve.

Current-invalid credentials retain the original actionable authentication body and re-auth warning. Fresh proof is
internal.

Reason: an exhausted account and failed sibling refresh returned a five-day 429 without attempting any paid provider.

Reversal risk: treating credential failure as quota exhaustion could redeem a reset or spend against unproved capacity.

## Native external consumers share access authorization without refresh credentials - 2026-10-14

The owner authorized recovery of the Mac primary and Ubiquity profiles from working same-user/workspace peers. The
gateway accepts the official native `chatgptAuthTokens` access-only leaf only from its fixed primary or
`.codex-ubiquity` home, with an empty refresh field and identical access/id JWT. Durable external ownership records the
native home, user, workspace, and credential generation; ordinary uploads, env seeds and managed donor candidates remain
strict. The existing repair CLI validates the current regular local leaf, preserves valid managed accounts and siblings,
checks passive authorization, rechecks file bytes and commits the matching slot with pool CAS. External consumers never
invoke local native refresh or OAuth; their owner must publish renewed access authorization before expiry. Managed
native refresh retains its existing expiry and precise generation-order guards.

The named home receives read permission for its auth file only. The gateway never writes either credential file. Native
daemon adoption and relay ownership remain separate watchdog operations: a file proves the pool's local source, not the
running daemon's auth mode. Initial managed-to-external native migration changes relay ownership; subsequent
same-user/workspace renewal must preserve it. A missing, stale or mismatched publication defers with an owner error
rather than switching accounts or rotating a donor. Native persistent external file loading is source-confirmed for
0.162.1 but undocumented and requires separate synthetic and passive runtime acceptance. Age-order protection remains in
this release, so recovery from an older peer generation is not a universal failover guarantee.

## External reasoning tiers use ascending Codex picker order - 2026-10-10

The native Codex catalog orders standard tiers from `none` through `ultra` only when projecting external provider
metadata. This is a permutation of advertised values: omitted tiers stay omitted, custom strings retain their positions,
and uploaded Codex records retain their own order and defaults. Raw external snapshots and official unversioned model
responses remain unchanged.

Reason: external provider metadata can advertise standard tiers in descending order, for example
`max,xhigh,high,medium,low`, reversing the native Codex scalar picker. The native client's Plan-mode preset is a
separate concern; catalog ordering does not override an effort selected for an inference request.

Validation: regression cases cover a descending standard ladder, custom tiers, and uploaded-record precedence. Live
client refresh and native Plan-mode effort preservation must be verified separately.

## Synthetic paid hops have separate billing identities - 2026-10-10

Each DeepSeek paid hop owns a separate internal billing request id derived from the client request id and provider.

The original client correlation and request-quota reservation remain shared across the complete waterfall.

Reason: reusing one paid row let a failed Surplus attempt retain ownership of a later successful OpenLux response.

Provider request ids, terminals, spend and reconciliation must belong to the provider that produced them.

Ordinary paid routes keep their current billing identity. Existing limits and pending-billing guards still apply.

Reversal risk: a shared paid id mixes providers and can leave successful fallback billed or reconciled as a failure.

## Compaction fallback retains request admission until provider dispatch - 2026-10-10

Jev compaction and its ordinary Responses fallback share one `executeInference` lifetime and quota reservation.

A failed local compaction cannot release admission before the fallback provider dispatches. Settlement runs once.

Successful local compaction still releases unused request quota. Cancellation still stops before fallback.

Reason: a failed Jev attempt released the reservation, so every DeepSeek waterfall hop failed before transport.

The live compaction-marked reproduction returned 503; the same unmarked request completed through LithosAI.

Reversal risk: settling either attempt separately restores false quota failures across the entire provider chain.

## DeepSeek paid hops use the synthetic route's verified capabilities - 2026-10-10

The synthetic route owns its paid-hop context internally; clients cannot enable it with a request-body field.

An enabled `ubiquity` selection permits its configured paid hops, even when their standalone providers are unchecked.

For its exact `deepseek-v4.1-flash` OpenLux hop, an existing catalog row also permits native Responses dispatch.

Reason: OpenLux advertises only `openai` and `anthropic` for this model, but its native Responses endpoint completes.

A direct authenticated probe on 2026-10-10 returned HTTP 200, `status: completed`, and `pong` from that endpoint.

Ordinary routes retain their catalog and selection gates. Paid admission, accounting, and per-hop pins still apply.

Reversal risk: removing the scoped capability restores a local refusal before the working final hop can dispatch.

## Every admin gets the full console; super-admin route gating is removed - 2026-10-05

Admin authentication is unchanged: admin tokens, allowlist tokens, Deno Deploy tokens, and admin passkey sessions still
authenticate, and unauthenticated requests still 401. The console now has no super-admin tier: every `/admin` route in
`src/handler/index.ts` is registered without a `superAdmin` gate, `requireSuperAdminAuth` is removed, every registered
view (including Supervisor and passkey users) renders for any signed-in admin, and any authenticated admin may register
another admin passkey. The `is_super_admin` flag survives only where it describes the credential that authenticated
(`/v1/auth` reporting and API-key audit rows), never as an admin-route gate.

Reason: the owner required one admin console with no differences for super admins; the split hid Supervisor, passkey
users, migration, and incident/replay tooling from working admins who operate them.

Reversal risk: removing the restriction widens the blast radius of a compromised normal admin credential to every admin
action (KV migration import, incident and replay export, supervisor reads, passkey administration); restore the
per-route gates if that trade stops being acceptable.

## Capacity-observed exhaustion feeds the blocked cohort and materializes the reset fence - 2026-10-05

A fresh capacity observation that shows the requested quota class at 100% used with a future reset deadline is now
authoritative quota-block evidence for banked-reset routing: the account yields a blocked identity (`quotaResetAtMs` =
the observed reset) instead of a bare skip, and the blocked-cohort evaluator materializes the durable class block
through the same persisted path a live 429 uses before it evaluates the pool. Without a deadline the account stays
half-open as a bounded probe (claimable without a class-block deadline) so either the request serves or a fresh 429
re-arms the fences. A live stable future deadline supersedes an absent or expired prior observation for the ambiguity
gate; the durable redemption ledger still makes every quota window spend-once. Empty blocked cohorts are logged
(`codex_banked_reset_preflight`, reason `no_blocked_identity`) instead of returning silently.

Reason: production spent four weeks unable to redeem resets because capacity-only exhaustion dead-ended locally with no
dispatch path, so no fence could ever arm and stuck ambiguity could never clear (incident
`docs/incident-codex-banked-reset-capacity-deadlock-2026-10-05.md`).

Reversal risk: restoring the silent skip reintroduces the dead end and hides it from telemetry; treating deadline-less
exhaustion as a blocked cohort fabricates an identity the claim fence cannot prove; removing the materialization step
leaves evaluations that pass in memory but fail the KV fence at claim time.

## Per-account daily redemption cap replaces the global daily cap - 2026-10-05

Implemented: a banked-reset submission budget is one redemption per account per UTC day instead of one redemption per
UTC day across all accounts. `CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_DAY` replaces the retired
`CODEX_BANKED_RESET_MAX_GLOBAL_PER_DAY`, which is no longer read; the parse default is `1`, and live mode requires
exactly `1`. The terminal-outcome provider keeps a dedicated failure reason
(`terminal_outcome_account_day_limit_must_be_one`); every other non-positive or non-one live value fails closed as
`per_account_day_limit_invalid`. Each account's budget is the durable record at
`["uos_ai", "codex_reset_redemption", "account_day", "v1", account_id_hash, day]`, charged atomically at the same
durable `submitted` boundary the global record used, and refusals report `account_day_limit_reached`. The exact-once per
account per quota window ledger, the shadow arming gate, and the at-most-once submission semantics are unchanged. Legacy
`["uos_ai", "codex_reset_redemption", "global_day", "v1", day]` records are retained for rollback and never enforced, so
a nonzero legacy count cannot block any account.

Reason: the global cap made two expiring credits unusable on the same night (only one redemption was possible across all
accounts).

Reversal risk: granting more than one redemption per account per day widens the worst-case credit burn if a loop
fabricates distinct exhaustion episodes; deleting or enforcing the retained legacy global_day rows would break the
rollback path or reintroduce cross-account blocking.

## Explicit per-account overage spending is implemented - 2026-10-05

Implemented: every Codex subscription carries an "Allow overage spending" switch stored at
`["uos_ai", "codex_overage_usage", "account", "v1", account_id_hash]` as `{ allow: boolean }`; an absent row is `false`
and no existing record is rewritten. `GET`/`PATCH /admin/providers/codex/overage-usage` and the Providers view checkbox
mirror the banked-reset settings surface. The default (false) keeps resets first: an exhausted account still routes
through the banked-reset cohort, and only when that request cannot redeem a reset (`no_eligible_credit`, empty or
ineligible inventory, `inventory_unavailable`, or the per-account daily cap) does one bounded overage probe serve the
request, logging `codex_overage_served` with the redemption-unavailable reason. Arming (`live_armed`), a completed
spend, and fence/config failures never fall back so the next request can still redeem. With the switch on, a
capacity-100% exhaustion routes directly as the bounded half-open probe while banked resets still redeem when their
gates pass. Changing the switch never calls OpenAI, never redeems, and never mutates banked-reset state. The approved
spec is `docs/codex-overage-usage-toggle-spec.md`.

Reason: overage spending was previously invisible and implicit, and the global cap incident showed the gateway could
silently prefer the paid backup balance over an available banked reset.

Reversal risk: enabling overage by default restores silent credit spending; removing the fallback refusal reasons makes
the gateway serve overage while a redeemable reset existed for the same request.

## Stage 1 key administration shows effective limits and audits every key change for 90 days - 2026-10-04

The API Keys view presents request-quota and paid-overflow limits with the same explicit Unlimited checkbox in the
create form and the per-key editor. A checked box disables its numeric input, sends the existing `-1` wire sentinel, and
displays no negative number; unchecking restores the last finite value (50 requests and 1 credit when the key has none).
A finite value must parse as a non-negative integer (requests) or a positive credit amount with at most six decimals, so
an empty or malformed entry is refused instead of becoming unlimited. Paid overflow stays three distinct states:
disabled, enabled with unlimited credits, and enabled with a finite cap. The existing expiry Never selector is
unchanged.

The key panel labels the effective request limit, window, used count, reset time and observation time, and the
paid-overflow section shows enablement, the window cap (or "Not enabled"), settled and reserved credits, pending
requests and the existing paid-fallback history. No new history path was added; the panel reuses
`/admin/api-keys/:id/paid-fallbacks`.

Every create, edit, revoke, unrevoke and delete that actually changes key state appends one compact event to
`["uos_ai","api_keys","change"]` in the same `kv.atomic()` commit as the key-state change, so an injected audit-commit
failure leaves the key unchanged and returns failure. A no-op PATCH and an unrevoke of an already-active key keep their
original success response and append no event: the contract is that a real state change cannot succeed without its audit
event, not that an idempotent call fabricates one. Deletion events are written before the purge loops and live under a
prefix the purge does not touch, so a deleted key keeps a minimal nonsecret event. An event carries a stable id,
timestamp, action, target key id, the key name, the safe changed policy fields (allowlisted: name, expiry, request
limit, window, paid-overflow enablement/limit, reset, revocation), the admin request id and the release identity. Actor
kinds distinguish an identified passkey user (`principal_id` = passkey user id) from the shared admin allowlist/deploy
credential, a local admin with auth disabled, and unknown; a shared credential never records a human identity. No token,
token hash, Authorization header, prompt or raw error is persisted or served.

`GET /admin/api-keys/changes` is an admin-only read surface (ordinary admin auth, not super-admin) returning
newest-first events with a bounded `limit` (default 20, maximum 50) and an opaque cursor; events carry KV TTLs of 90
days and the response reports `retention_days`. The reader additionally drops any event whose own `at_ms` is older than
90 days, because TTL expiry alone is not an exact-time visibility guarantee. Audit coverage begins at deployment: no
historical actor is reconstructed, and the UI says so.

Wire schemas, `-1` sentinel semantics, paid-accounting enforcement, reservation guards and the outstanding-billing
deletion guard are unchanged.

Reason: the approved Stage 1 plan requires clear effective-limit presentation, iPhone-safe unlimited entry without
negative numbers, and durable, safely attributed key-change history so an operator can see who changed a key's policy
and when.

Reversal risk: re-enabling negative-number entry reintroduces the iPhone input problem and lets a malformed finite value
become unlimited; moving the audit append out of the key-state commit makes a success without a durable event possible;
recording tokens, hashes or shared-credential human identities would leak secrets or fabricate attribution; dropping the
cursor/limit bound or the 90-day TTL makes the history unbounded.

## The Mac gateway uses a checksum-pinned managed Deno 2.9.5 - 2026-10-03

Only the Mac gateway launcher uses the official aarch64 Deno 2.9.5 artifact in
`.data/runtimes/deno/2.9.5-b5bd08edab254d42d7b05aa5b6cb4c9b8d4dede4975aff76951ce2cce18866fa/deno`. Released Deno 2.9.6
and 2.9.7 split read/write permission lists without decoding doubled commas, which breaks literal comma paths in
`CODEX_HOME`; 2.9.5 retains that decoder. This is a service-specific compatibility rollback, not a global downgrade, and
omits the later releases' fixes. CI remains pinned to 2.9.5. The released-source comparison is retained in the issue
#812 runtime prerequisite record, with exact commits `17fadf33a8df3af9488b9f42efd1f2290d6dc7a3` (2.9.5) and
`0c071246a412575e07423263404a5d13e7ed6aa2` (2.9.7).

The fixed official archive SHA-256 is `b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615`; the extracted
binary SHA-256 is `b5bd08edab254d42d7b05aa5b6cb4c9b8d4dede4975aff76951ce2cce18866fa`. Deployment prepares and verifies
this immutable path under the existing deployment lock before release selection or service interruption, refuses corrupt
or symlink destinations, and publishes only completed verified bytes. The launcher checks the binary again, uses it for
both the dotenv-loading task and frozen application, selects the physical release's configuration, preserves literal
native-home permissions and limits native writes to `app-server-control`. The application denies writes to
`.data/runtimes`; missing or corrupt runtime state fails closed without falling back to the global binary.

Existing synthetic proof: runtime preparation and actual disposable deploy ordering passed 14 tests in receipt
`591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/4fa44cf3-59d5-4fa1-9b5b-dadc5685e414`; the actual
managed launcher passed all 11 native-home, configuration/lock, write-denial, failure and shutdown cases in
`591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/6ac18d06-c49d-438e-a398-b22be79ddd65`. A disposable
native KV roundtrip seeded with 2.9.7, updated with 2.9.5 and reread with 2.9.7 preserved exact values and rejected
stale CAS, with every child and KV handle settled; its result is
`.codex-worktrees/plan-issue-812-abcb41d3034/.data/issue-812/kv-compatibility/roundtrip-result.json`. These proofs cover
synthetic state, not the live gateway database or service.

The normal test task adds three separate scoped Mac fixtures, retaining all existing suite segments and permissions. The
launcher matrix must execute 2.9.5, including on Linux: only its disposable runtime coordinates and checksum comparison
are substituted, and comma, symlink, absent-directory and runtime-write-denial cases remain required. Running that
matrix with 2.9.7 must report the unsupported runtime rather than skip assertions. The existing `verify.sh` task call
and CI test call include these fixtures without duplicate invocations or new tasks.

Status: source and focused synthetic evidence accepted for integration; committed combined verification and
whole-gateway synthetic acceptance remain required. Preparing the runtime in the canonical store or adopting it through
live `deploy:mac`/launchd requires the separately approved concrete rollout. This decision authorizes no global binary
or PATH change, other service downgrade, real credential mutation, live database probe, automatic upgrade, runtime
fallback or runtime-store pruning. Reversal risk: restoring the global 2.9.6/7 launcher breaks escaped native-home
paths; removing integrity checks or the runtime write denial lets the service use or alter an unverified executable.

## Codex collaboration tools work over the Chat-only routes - 2026-10-03

Codex clients expose the multi-agent tools (`spawn_agent`, `followup_task`, `send_message`, `wait_agent`,
`interrupt_agent`, `list_agents`) as a single `namespace` tool named `collaboration`, and resolve a returned call by its
`(namespace, name)` pair. The Chat-only projection behind the DeepSeek, LithosAI, and Cerebras routes flattened
namespace groups into bare Chat function names and returned only a name, so every call for a namespaced tool reached the
client unqualified and failed as `unsupported call: spawn_agent` even though the tool had been delivered to the model.
Three changes to that one adapter fixed the loop, all deployed as Mac release `92493574`:

1. `ee641318` stores `{name, namespace}` for every namespace-grouped function, not only for renamed collisions, and both
   response emitters write `namespace` on `function_call` items.
2. `963f44d9` projects an `agent_message` input item (author, recipient, content) onto a user turn that names both
   endpoints. Before this the projection rejected every input type other than `message`, so a parent turn failed with
   `input item type 'agent_message' is not supported` as soon as a sub-agent answered.
3. `92493574` forwards an unsealed `encrypted_content` agent-message payload verbatim and marks a Fernet-shaped payload
   (`gAAAAA` prefix, at least 100 characters) as omitted. On these routes the client moves the payload text into that
   field in the clear, so dropping it left every sub-agent with an empty task and its own "payload arrived
   encrypted/unreadable" report.

Evidence on 2026-10-03, against the local Mac service: `spawn_agent` returns `{"task_name":"/root/<name>"}` from a
deepseek parent for both a deepseek child and a `qwen-3.8-27b` child; a deepseek worker received its task, wrote its
handoff file, and the parent read `pong` back from disk; separately a parent received a worker's mailbox reply `pong`
without any file handoff. Measured overhead: 884 ms from tool call to spawn result and 192 ms more until the child's
first turn.

Cross-backend delegation does not carry a payload (measured 2026-10-03). A parent whose model is served by the Codex
backend (`gpt-6-astra`, `gpt-6.1-sol`) emits the spawn message as a sealed Fernet token (`gAAAAA...`), because that
backend seals every `encrypted: true` tool argument and only it can open the seal. A gateway-served child therefore
receives an empty task: two `deepseek-ai/DeepSeek-V4.1-Flash-ultra` children of a `gpt-6-astra` parent reported the
assignment arrived as an unreadable blob, and neither edited a file (`agent_message` items carried the plaintext
envelope and a sealed `encrypted_content` part that this gateway correctly marks omitted). Delegation payloads survive
only when both ends are served by the same backend: gateway parent to gateway child (deepseek or qwen) works, Codex
parent to Codex child works, and a cross-backend assignment needs an out-of-band handoff. Gateway-side unsealing is not
available: forwarding the same tool schemas with the `encrypted` annotation removed is rejected by the Codex backend
("Invalid Value: 'tools'. Function 'collaboration.followup_task' is reserved for use by this model and must match the
configured schema."), so the annotation is enforced server-side and only a client-side change could carry a
cross-backend payload another way. The recorded convention is a file at `/tmp/codex-agent-tasks/<task_name>.md` written
by the parent before the spawn and read by the child first, which works because the plaintext envelope still carries the
task name and sender.

Limits recorded with the same evidence: a sealed payload from a ChatGPT-backed thread stays opaque to this gateway
because the opening key lives in that backend and the client implements no such crypto, so it is declared rather than
invented; a sub-agent receives no collaboration tools in this client build, so fan-out depth is 1; `qwen-3.8-27b`
rejects `reasoning_effort: max` (none/low/medium/high only) and its Cerebras quota can be exhausted, so an orchestrator
should retry a rate-limited child with a deepseek model; and a child is aborted when its parent session exits, so the
parent must wait for it.

To re-verify the loop, run a headless session on the orchestrator model that spawns a child, waits for it, and prints
what it received; the client-side knobs that matter are `[agents] default_subagent_model` and
`default_subagent_reasoning_effort` in `~/.codex/config.toml`, where a `max` default serves deepseek children and is
rejected by `qwen-3.8-27b`. The Mac service deploys from a clean canonical checkout with `deno task deploy:mac`, which
snapshots HEAD into `.data/releases/<sha>` and restarts the launch agent; client builds are never patched.

Reason: the owner asked for deepseek orchestrators that spawn deepseek and Qwen workers through this gateway, after
`spawn_agent` failed with `unsupported call: spawn_agent` on every attempt.

Reversal risk: reverting any one change restores its exact failure (`unsupported call: spawn_agent`, `agent_message`
request rejection, or empty child tasks). If a future client seals payloads locally the `gAAAAA` heuristic would forward
ciphertext as text until the marker is updated.

## Analytics drops the Quota forecast card and the Metered capacity panels - 2026-10-03

The admin Analytics view no longer renders the "Quota forecast" (quota runway) card, and the Provider analytics card
renders only the two Codex pool accounts: the "Metered 2 refill" chart series and legend entry, the "Metered 2" and
"Metered 1" (surplus) capacity rows, the metered staleness caption note, and the client-side quota-projection fetch,
snapshot-cache restore, visible-poll refresh, and app-resume refresh are removed. The quota-projection HTTP endpoints
and `src/quota-projection.ts` remain for operator and backfill use, and the Metered wallet/paid-fallback surfaces in the
Defaults and Providers views are unchanged. This supersedes the 2026-10-02 "Admin Analytics quota panels refresh on a
visible poll and on app resume" decision only where it named the quota runway panel; provider health and provider
capacity keep the 30-second visible poll and the resume refresh.

Reason: the owner reported that the quota forecast and Metered 1/2 "never showed any useful info" and asked for their
removal from Analytics (2026-10-03).

Reversal risk: restoring the card re-adds the fetch, cache restore, and resume hook; the removed refill series was
Analytics' only rendering of the Metered wallet refill cycle, so metered wallet state is now observable only in the
Defaults metered-quota panel.

## Normal capacity reads revalidate Codex quota on a 30-second freshness window - 2026-10-02

`GET /admin/providers/capacity` serves the persisted snapshot only while it is younger than
`PROVIDER_CAPACITY_READ_FRESH_MS` (30 s, matching the Analytics visible poll) and otherwise awaits the existing
lease-guarded `refreshProviderCapacity()` probe before responding. Concurrent stale reads coalesce through the same
lease and its bounded cold wait, so one refresh serves them all and no request stacks a duplicate upstream call.
`?refresh=live` keeps its documented force-probe semantics. Durable history keeps its fifteen-minute bucket:
`PROVIDER_CAPACITY_HISTORY_BUCKET_MS` is unchanged and a same-bucket refresh overwrites that bucket's point rather than
adding one. A refresh that throws keeps the last known persisted snapshot; a refresh that reaches upstream but fails
leaves the affected source unavailable instead of reporting a fabricated percentage.

Reason: the default read was persisted-only, so the Analytics quota cards could show a fifteen-minute-bucket-old Codex
percentage, or an unbounded older one on a quiet gateway, while the client already polled every 30 seconds. The
displayed value therefore did not change even though the poll and render path were correct.

Reversal risk: restoring the persisted-only default read brings back the stale display; shortening the window below the
poll cadence only repeats upstream probes, and making the read await an unbounded probe would reintroduce the latency
the persisted-only boundary avoided. The probe itself stays read-only: usage reads with existing credentials, no OAuth
refresh, inference, account, provider-selection, or quota-accounting change.

## The Mac gateway delegates a shared CLI credential lineage to native Codex - 2026-10-02

Only exact account and credential equality binds the local CLI file account to a durable `native_owner` in its KV pool
entry. The gateway then requests refresh from the existing native daemon, verifies its `initialize.codexHome` and
ChatGPT identity, and adopts the same-account persisted generation with pool CAS; it never writes `auth.json` or
performs its own OAuth for that owner. Uploaded sibling accounts retain their existing refresh path. Upload and repair
cannot erase the binding or replace it with stale credentials.

A changed generation requires a usable access token and nonregressing access expiry. When two native rotations share a
JWT expiry, the native owner's persisted `last_refresh` orders them, including its submillisecond precision. This
metadata never bootstraps ownership, and filesystem mtime never selects a credential source. Missing or mismatched
files, daemon failures and inconclusive replies refuse gateway refresh with local owner errors; they do not establish
current-credential invalidity or quota exhaustion.

The observed CLI sessions share one native daemon, whose in-process semaphore serializes refreshes. Independent native
processes have no cross-process mutex; guarded reload and reuse recovery remain necessary. This change preserves CLI
sign-in and sync and does not repair an external stale sync writer or change VPS credentials, service permissions or
configuration.

Status: focused synthetic ownership, existing auth regressions and concurrent native CLI/gateway loopback acceptance
passed. The native proof used strict HTTPS and a task-owned test CA; no real credentials were refreshed by this work.

2026-10-14: A newer expired generation may request one native-owner refresh. Adoption still requires usable tokens.

Rollback and missing order proof still refuse refresh. A revoked native chain still requires native sign-in.

## `/v1/live` calls are bound to the authenticated gateway principal that created them - 2026-10-02

Call creation resolves the authenticated principal (`resolveIdempotencyPrincipal`, e.g. `api-key:<key_id>`) and persists
it alongside the account in the `codex_live_calls` v1 mapping; the sideband join must present the same principal. A join
by a different valid principal, and a legacy mapping that records no principal at all, are both refused with 403 before
the WebSocket upgrade, with no permissive compatibility fallback; a reconnect by the creating principal still upgrades
and rejoins on the mapped upstream account. The mapping TTL is unchanged at one hour.

Reason: `/v1/live` authenticated the request but bound the call only to the upstream account, so any valid gateway
principal that learned a call id could attach to another principal's call and use the creator's upstream credentials.

Status: implemented and locally tested (focused loopback HTTP/WebSocket regression and changed-file lint, receipts
`591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/58ac6b41-8949-40a6-9eff-46f2de4d9bcf` and
`591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/e08bfb68-25ca-48fd-ab60-3be8a56082aa`); not deployed.

Reversal risk: dropping the principal comparison restores cross-principal sideband attachment and creator-credential
use; treating an absent `principal_id` as authorized would reopen it for every mapping written before this change, and
extending the TTL would lengthen that window.

## Admin Analytics quota panels refresh on a visible poll and on app resume - 2026-10-02

The admin console's Analytics quota panels (provider health, provider capacity, and the quota runway) keep the existing
30-second visible poll, and `bindForegroundRefresh` now also refreshes them immediately when a resume is observed:
window `focus`, `visibilitychange` to visible, or a bfcache `pageshow` (`event.persisted === true`; the first load's
`pageshow` is ignored). The helper coalesces those events into one scheduled refresh and each loader returns early while
its own request is in flight, so focusing a window, returning to the tab, and restoring from bfcache cannot stack
duplicate requests or timers. The quota-projection request keeps its 30-day window and the capacity endpoint keeps
serving the persisted snapshot, so this client lifecycle change adds no upstream polling: the metered quota snapshot
still refreshes upstream only at its own `METERED_QUOTA_FRESH_MS` (5 minute) boundary.

Reason: Analytics is the authenticated default view, but the foreground-refresh binding only refreshed the Defaults
view, so an app resumed from background or bfcache kept showing a stale quota until the next visible poll tick, which
mobile background timer suspension can delay indefinitely, or until a full reload.

Reversal risk: removing the resume hook restores the stale-after-resume display; removing the `pageshow` initial-load
guard refreshes on every ordinary page load; adding a second interval instead of reusing the existing poll duplicates
requests.

## Codex model availability follows the per-account pool - 2026-10-02

The Codex-native catalog `GET /v1/models?client_version=X.Y.Z` and the normalized `["ubq_ai","codex_models"]` snapshot
are built from the union of every pool account's own `/codex/models` answer: rows deduplicate by `slug` in pool order,
the first-in-pool-order row is kept verbatim, and a single configured account keeps the previous single-account response
including its conditional-request and 304 revalidation contract. Per-account catalog rows and learned account+model
rejections live in `["uos_ai","codex_account_models","v1"]` as a non-secret routing hint; the operator whitelist filter
stays downstream and unchanged, so it still narrows whatever the union advertises.

A named model an account provably cannot serve — a learned rejection, or a stored catalog for the same client version
that lacks a model a sibling's same-version catalog lists — is skipped in routing without touching quota fences,
invalidating a credential, or opening an upstream-timeout circuit; unknown availability never skips. When the durable
active account is skipped for that reason and an entitled sibling exists, the ordinary election advances once with the
new transition reason `model_unavailable`, and when no account is entitled the gateway answers a graceful OpenAI-shaped
404 `model_not_found` naming the model rather than 429 or 503.

Upstream's `The '<model>' model is not supported when using Codex with a ChatGPT account.` 400 is the one learned
eligibility signal: that account+model pair is recorded and the request makes exactly one bounded sibling attempt
through the existing reselection machinery before falling back to the same graceful 404. Every other 400 passes through
byte-for-byte with no retry and no new state. Single-active-account admission, quota and credential fencing, and
paid-fallback authorization are otherwise unchanged.

Reason: on 2026-10-02 the catalog refresh stored one account's answer, so `gpt-daybreak-blue-latest` — served only by
pool account `54e77f76-...` — disappeared from both the versioned catalog and the normalized snapshot, and the gateway's
own model validation rejected the client's request while its entitled account was healthy.

Reversal risk: reverting to a single account's catalog hides per-account entitlements again; treating an ineligible
account as quota-exhausted or credential-invalid writes fences, unlocks paid fallback, or wedges routing; learning from
any 400 other than the exact upstream shape misattributes ordinary request errors and can skip a capable account.

## Model-switch replay repairs gateway item ids and drops gateway-local reasoning - 2026-10-02

The Chat-only Responses routes (DeepSeek, LithosAI, Cerebras) minted synthetic item ids as `${responseId}_<kind>_<n>`,
but OpenAI validates replayed item ids by their type prefix (`rs`, `msg`, `fc`, `ctc`), so a Codex thread that had
completed a DeepSeek turn failed every later `gpt-6.1-sol` turn with
`Invalid 'input[n].id' ... Expected an ID that begins with 'fc'`; a replayed synthetic reasoning item also cannot be
resolved under `store: false` (`Item with id ... not found`). The shared output builders now emit
`<kind>_${responseId}_<n>` (the streamed custom tool call included, so it carries the same `ctc_` prefix the buffered
builder uses), and `buildCodexRequest` is the Codex seam that repairs an already-stored history: a replayed reasoning
item whose id matches either producer shape and carries no non-empty `encrypted_content` is dropped, every other
recognized synthetic id (message, function call, custom tool call) loses only its `id` while keeping content, order and
`call_id`, and genuine OpenAI ids, encrypted reasoning bytes, and the DeepSeek/LithosAI/Cerebras request bodies are
untouched. The Responses assembler now forwards the builder's repaired `input` to the Codex upstream and hands the
original input back to the removed-provider fallback, so only the Codex replay is repaired. Live probes: omitting one
synthetic function-call id alone returned `response.completed` with `pong`, while an unencrypted reasoning item
re-prefixed to `rs_` still answered 404.

Reason: the upstream validator sees another provider's replayed history on a model switch, and a stateless
(`store: false`) upstream can only resolve reasoning it can decrypt; both must be repaired at the one place that builds
the Codex request.

Reversal risk: widening the drop to every reasoning item without `encrypted_content` would discard items a `store: true`
client can legitimately replay; matching ids by a loose `resp_` substring would rewrite genuine ids, so only the
producer's exact `<kind>_...` shapes are recognized.

## Public models use the enabled set for every provider - 2026-10-02

Apply the operator whitelist to every `/uos/models/catalog` row, including OpenRouter.

`/models` renders this feed. An empty or absent whitelist keeps the existing no-filter behavior.

Admin discovery, `/v1/models`, and `/uos/models/capabilities` retain their existing contracts.

Reason: disabled OpenRouter rows were appended after filtering and appeared on the public page.

Reversal risk: bypassing the filter again makes disabled models visible.

## The Codex-native catalog honors the operator whitelist for every assembled provider - 2026-10-02

On 2026-10-02 the user's intent is that the enabled-model policy, the operator's model whitelist, controls what a Codex
client can select. The Codex-native versioned contract `GET /v1/models?client_version=X.Y.Z` therefore filters every
assembled row through that one authority, OpenRouter's dynamic rows included; neither the stored-catalog cache fast path
nor the metered fallback may serve rows past a nonempty whitelist. An absent or empty whitelist remains no filter at
all, so OpenRouter's rows still list on their own snapshot TTL without an operator re-save. Per-model metadata is
preserved verbatim; only the advertised set is narrowed. The unversioned `GET /v1/models` and the provider-discovery
surfaces (`/uos/models/catalog`, `/uos/models/capabilities`) keep their existing contracts unchanged, deliberately,
because the reported bug is the Codex client picker and this entry expands no policy beyond it.

Reason: the operator enabled 16 ids while Codex showed 477, because OpenRouter's rows were appended after the whitelist
on every listing surface (commit `9531d8b8`, 2026-09-30) and the versioned catalog's cache fast path bypassed the filter
entirely. The versioned catalog is the one Codex selects from, and it is the seam corrected for this report; the other
surfaces were not part of the reported defect and are intentionally left as they are.

Reversal risk: appending OpenRouter rows after the filter again restores hundreds of unenabled models in the Codex
picker; treating an absent or empty whitelist as "nothing enabled" hides the dynamic catalogue without an operator
selection; extending this gate to the unversioned or discovery surfaces is a separate decision this entry does not
authorize.

## `/v1/live` relays call creation to the ChatGPT backend and the sideband to api.openai.com - 2026-09-30

The Codex client's realtime voice (TUI, v3/frameless) creates a WebRTC call with `POST <provider-base>/live` (multipart
`sdp` + `session` parts) and joins the call's control socket at `wss://<ws-base>/v1/live/<call_id>`. The gateway serves
both under `src/live/`: call creation is translated to the ChatGPT backend JSON shape at
`${CODEX_BASE_URL}/realtime/calls?intent=quicksilver&architecture=avas` on one eligible Codex pool account, the returned
`Location` is rewritten to `/v1/live/<call_id>`, and the creating account is mapped to that id (1 h TTL) so the sideband
rejoins on the same credentials; the sideband then bridges text frames to `wss://api.openai.com/v1/live/<call_id>`. The
two legs cannot share one upstream base: the ChatGPT backend rejects the multipart shape
(`400 Unsupported content
type`), and the API host refuses subscription-created calls
(`403 Voice session access denied`) while accepting the sideband join with the same subscription token. SDP, ICE, and
media are passed through untouched, so WebRTC media still flows between the client and OpenAI directly.

Reason: live calls are metered on the ChatGPT backend route while the call's control socket lives on the API host; only
the two-step relay keeps both legs on one account without terminating WebRTC in the gateway.

Reversal risk: pointing creation at `api.openai.com/v1/live` restores the 403; dropping the call-id-to-account map makes
sideband joins fail closed with 404; and a client without `experimental_realtime_ws_base_url` set to the gateway base
joins `api.openai.com` directly with the gateway's own credential and fails, so that client-side setting is part of this
deployment contract. `/v1/live` stays outside inference metering and admission, but its responses feed Codex provider
health/capacity.

## Sandboxed commits sign through a GNUPGHOME inside writable roots - 2026-09-29

DSH's `workspace-write` file sandbox permits writes only under the workspace root, `/tmp`, and `os.tmpdir()`
(`writableRoots` in `@deepseek-ai/dsh-sandbox`). GnuPG must write its homedir — `trustdb.gpg`, `random_seed`, and the
`S.gpg-agent*` sockets — so a signed commit from a confined shell failed with
`gpg: can't connect to the gpg-agent: Operation not permitted` while `GNUPGHOME` stayed at `~/.gnupg`. Committing
therefore required a per-commit `danger-full-access` escalation.

`~/bin/gpg-dsh` is to be installed from `ops/gpg-dsh.sh` and set as `gpg.program`. Merging a change to the helper
changes no machine: the installed copy keeps its old behaviour until the owner installs the new one, so this entry
describes the repository helper, not what `~/bin/gpg-dsh` runs today. The helper uses the real homedir when that is
genuinely writable (a probe file can be created there). Otherwise it signs from a homedir seeded under
`$TMPDIR/dsh-gnupg/<uid>` from `~/.gnupg`: the `*.kbx` and `*.gpg` files plus every file in `private-keys-v1.d`.
Interactive shells take the passthrough branch and are unaffected.

To install it, compare it with the installed helper first, `diff ops/gpg-dsh.sh ~/bin/gpg-dsh`, then run
`install -m 0755 ops/gpg-dsh.sh ~/bin/gpg-dsh && git config --global gpg.program ~/bin/gpg-dsh`. The repository helper
does not seed `gpg.conf`, `gpg-agent.conf` (for example a `pinentry-program pinentry-mac` line), or keyboxd's
`public-keys.d`. If the installed helper seeds any of these, installing over it can make sandboxed signing fail closed,
with no usable pinentry or with a public key missing under keyboxd. The first sandboxed call after an install discards
the old seed and stops its agent (added 2026-10-17, #1139).

Every seeded file invalidates the seed, not `pubring.kbx` alone. This entry first said the seed was refreshed only
"when `pubring.kbx` changes", and the installed helper compared only that file's mtime and size. Deleting a secret key
or changing its passphrase leaves `pubring.kbx` untouched, so the old private key stayed usable from the seed
(corrected 2026-10-16, #587). Every sandboxed call now records the name and SHA-256 digest of each seeded file and
compares that manifest with the one recorded when the seed was built. Any difference, including a deleted, added, or
re-protected private key, stops the seed's `gpg-agent`, discards the seed, and rebuilds it before gpg runs. The
manifest is written only after a complete copy, so an interrupted rebuild is rebuilt on the next call. The seed and
its `dsh-gnupg` parent must be real directories owned by the caller and are forced to mode 0700; anything else fails
closed before gpg runs. `tests/gpg-dsh.test.ts` covers each trigger.

Rebuilds are serialized and published whole (added 2026-10-17, #1139). Before this, every call that found a stale
manifest stopped the agent, removed the shared seed, and rebuilt it in place, with no lock. Calls started together after
one input change deleted the seed under each other: with real GnuPG 2.4.4, 2 to 8 of every 8 concurrent signings after
an added `*.gpg` file exited 2. A `cp` that had opened a just-deleted key could also write it into a seed that another
call had already stamped with the new manifest. Now a call whose manifest matches the seed's takes no lock. Any other
call (a mismatch, a missing seed, or a leftover copy beside it) waits for `<seed>.lock`, a directory created with
`mkdir` whose owner file records the holder's pid and start time. Under the lock it checks again and re-reads the
inputs, so a burst of calls after one change rebuilds once and the others reuse that seed. The holder copies the inputs
into a private sibling (`<seed>.new.XXXXXX`) and records the manifest there. It then stops the seed's `gpg-agent`,
renames the old seed aside (`<seed>.old.XXXXXX`), renames the new one into place, and only then removes the old one. No
call writes into a seed that another call has published, and no call sees a partly copied seed. Leftover siblings from
a killed rebuild are removed under the lock. A lock held for 15 seconds is treated as left by a killed holder and
broken, and a waiter gives up (exit 2) after 60 seconds. A signing that is already running from the seed when an input
changes can still fail, because the rebuild removes the old seed once the new one is in place.

Reason: the sandbox exposes no configuration hook for adding writable roots — `writableRoots` takes only the policy and
hard-codes the three roots — so the only durable fix inside the existing policy is to put the signing homedir where the
sandbox already allows writes. Escalating every commit instead is not a fix, and `danger-full-access` grants far more
than signing needs.

Reversal risk: pointing `gpg.program` back at the real `gpg` restores the denial under `workspace-write`; copying the
private key to a stable non-writable-root location such as `~/.local/share` looks persistent but is unwritable under the
restricted policy and silently reintroduces the escalation. The seed is not trusted to disappear by itself: `$TMPDIR`
is not cleared at boot for every caller, and an unset `TMPDIR` falls back to `/tmp`. The manifest check on every call
is what keeps the seed from becoming a second long-lived key store. Going back to a `pubring.kbx`-only trigger lets a
deleted or re-protected secret key keep signing from the seed. Rebuilding in place, or without the lock, brings back
the failed concurrent signings after an input change and the window in which a deleted key survives in a seed stamped
as current.

## Forwarded payloads are bounded by a declared, versioned policy, and `truncation: "disabled"` fails closed - 2026-09-25

The DeepSeek/Lithos translation counts every forwarded byte as text tokens. On 2026-09-24 a single 744,586-byte
`view_image` tool result took one session from 736,213 to 1,250,713 requested tokens against the 1,048,576-token window;
the provider rejected every later replay, including compaction, and the thread could not be resumed. The first repair
cut each payload at an undeclared 64 KiB constant. That stopgap is replaced by `FORWARDED_PAYLOAD_POLICY`
(`deepseek-forwarded-payload/v1`, one source of truth in `src/deepseek/forwarded-payload-policy.ts`): a versioned
per-message byte limit, advertised to Codex clients as a `forwarding_policy` extension on the gateway-served catalog
records, carried in the visible elision marker and the `forwarding_elision` operator log line, and enforced
deterministically (byte prefix plus marker inside the declared limit).

Behavior: an absent `truncation` field or `"auto"` keeps the bounded reduction, because the clients this route serves
omit the field and cannot repair a rejected history; an explicit `truncation: "disabled"` fails closed with HTTP 400
`context_length_exceeded` naming the item path, byte counts, and declared limit instead of mutating the input; any other
value is rejected with `param: "truncation"`. This is a deliberate gateway policy, not an OpenAI guarantee: the
documented default for an absent field would reject rather than reduce.

Reversal risk: reverting to silent cutting restores unreported evidence loss; removing the bound restores the 2026-09-24
poisoning; treating an absent field as `"disabled"` wedges Codex clients that cannot alter their history. Residual gap:
aggregate admission (the whole rendered prompt against the model window minus the output reserve) is not implemented;
this policy bounds one message, not the sum.

## Coverage is measured per src line and branch, and no threshold is enforced yet - 2026-09-24

The first real coverage measurement of `src/` came from running all three segments of `deno task test` with `--coverage`
and merging them with `deno coverage .data/cov-main .data/cov-oss .data/cov-meas --include='^file://<repo>/src/'`: 83.4%
lines and 82.8% branches at tip `125185c5c`, with `src/types.ts` the only source file absent because it is type-only and
erased at runtime. Measuring one segment under-reports: `tests/oss-gateway-http.test.ts` runs under stripped
`SURPLUS_API_KEY`/`METERED_API_KEY` with `--unstable-kv`, and `tests/usage-optimization-measurement.test.ts` runs with
only `UOS_AI_TOKEN`/`DENO_DEPLOY_TOKEN`.

The program target is 90% for both lines and branches, and it is now met: four coverage waves took `src/` from 83.4%
lines and 82.8% branches at `125185c5c` to 92.15% lines and 90.10% branches, with `sh scripts/verify.sh` green and 2101
tests passing. That work added 21 test files plus `tests/helpers/sentinel-kv-stub.ts`. No gate enforces the threshold
yet; this entry records the measurement and its command so a later decision can add one without re-deriving either.
`sentinel` went from 58.0% to 96.3% of its replay cluster by driving those modules with an in-memory KV stub, which is
required because `Deno.openKv` is undefined in the default test task (no `--unstable-kv`): a KV-backed path is reachable
in that suite only when the test passes a stub.

What is still uncovered is recorded per file in the lane handbacks and falls into four kinds, none reachable by a test
without changing production code or widening the test command's permissions: permission-denied environment reads for
keys the allowlist excludes (`SENTINEL_REPLAY_KEY`, the deploy-runtime slugs) plus the deny-listed
`.data/codex-supervisor.json` and `--allow-read` state-DB paths in `supervisor-inventory.ts`; branches unreachable by
construction, such as the deflate ciphertext ceiling, validation re-checks of values the same function just validated,
and `typeof x !== "string"` guards after `JSON.stringify`; timer-driven reservation machinery whose pending ops would
leak across tests; and fixtures that need a concurrent writer or a real WebAuthn attestation.

Two traps found while measuring. A process-wide `fetch` stub counts unrelated background traffic: the paid-fallback
quota refreshes schedule their own requests on timers that outlive the test that armed them (`src/provider/metered.ts`,
`src/provider/surplus.ts`), which intermittently failed `tests/codex-account-routing-part3.test.ts` with two dispatches
inside a zero-dispatch window, so its counters now attribute dispatches by the test's own request body. Coverage is also
not a review: the first wave needed manual repair of nine guessed expectations, for example a JSON byte length asserted
as 20 where `{"model_ids":["gpt-5"]}` is 23 bytes, and `listKernelUsageLimits` projecting a malformed `acme/demo/extra`
key onto a second `acme/demo` row because `kernelPolicyRow` reads only the first two key segments.

## Filenames are kebab-case and enforced by ESLint, and `src/` is grouped by domain - 2026-09-24

`check-file/filename-naming-convention` in `tools/lint/eslint.config.mjs` uses the built-in `KEBAB_CASE` naming
convention with `{ ignoreMiddleExtensions: true }`, over `**/*.{js,ts}` at any depth. `ignoreMiddleExtensions` is
required: without it the convention rejects the dot in `*.test.ts`, so every test file reported.

The rule had been in this config since the ruleset was ported, but it did not enforce anything. Its naming pattern was
the ts-template default `"+([-._a-z0-9])"`, a micromatch expression that admits `_` and `.`, so snake_case filenames
satisfied it and the whole `src/` tree passed. That pattern was never intended as kebab-case enforcement: the canonical
`ubiquity/ts-template` config carries the same string and uses camelCase filenames. Measured with the plugin's own
`micromatch` dependency, `isMatch("admin_api_keys.ts", "+([-._a-z0-9])")` is `true`, so the file passed; the plugin
strips the extension and tests the resulting basename against the `KEBAB_CASE` expression
`+([a-z])*([a-z0-9])*(-+([a-z0-9]))`, which that basename does not match. Two further traps sat behind it:
`eslint-plugin-check-file@3` bails out of the check when the glob key itself matches a predefined convention, and its
`micromatch.capture` returns the _directory_ in capture group 0 for a nested path, so a nested file is validated against
its parent directory name rather than its basename.

The enforcement change is inseparable from the rename, because the rule is repo-wide and one unrenamed `*.ts` file fails
the gate. `src/` is now grouped by domain - `admin/`, `auth/`, `cache/`, `catalog/`, `chat/`, `codex/`, `deepseek/`,
`embeddings/`, `handler/`, `harmony/`, `kernel/`, `models/`, `paid-fallback/`, `provider/`, `sentinel/` - with genuinely
shared singletons left at the `src/` root. `tests/` keeps one flat directory and is only kebab-renamed, so the
`../src/...` depth in every test import is unchanged.

Reversal risk: this config is also where three measured, file-scoped exemptions live, and each names its target by path.
Renaming or moving a file silently orphans its exemption, and the gate then reports the suppressed rule as if the code
had regressed - which is exactly what happened here to `sonarjs/function-return-type` on `src/models/codex-models.ts`
(formerly `src/codex_models.ts`). When you move a file, grep this config for its path first. Widening the naming pattern
back to a character-class expression would also silently stop enforcing the convention without failing anything, so
prefer a predefined convention, or verify any custom pattern against a known-bad filename.

## Oversized files are capped with a tightening-only baseline - 2026-09-23

`scripts/file-size-ratchet.ts`, run by `sh scripts/verify.sh`, caps source files at 1000 lines and test files at 1500.
The 31 files already above their caps are grandfathered by a recorded per-file ceiling in `file-size-baseline.json`,
checked in at the repository root. Their ceilings were recorded with `--init` on 2026-09-23 at HEAD `411b3db04f`.

The check fails whenever the tree and the baseline disagree: a file over its cap with no entry, a recorded file above
its recorded ceiling, a recorded file that shrank below its recorded ceiling, a recorded file that fell back within its
cap, or a recorded path with no file left. `deno task size:update` is the only writer; it lowers or drops ceilings and
refuses to raise one or to record a file that is over its cap. That is stricter than the ESLint `max-lines` rule the
flat config leaves off: a recorded ceiling tracks the file's real size, so shrinking a 14,296-line file to 12,000 must
be committed with a 12,000 ceiling before the next change can grow past it. ESLint bulk suppressions are deliberately
not used, because they count violations rather than lines and would let a file grow from 1,001 to 10,000 unchecked.

Reversal risk: deleting an entry from the baseline re-authorizes unbounded growth for that file while a `verify` run
would only start failing after the file passes the deleted ceiling, and disabling `size:update` in favor of hand edits
removes the raise-refusal. The recorded ceilings are intentionally large numbers; do not read them as targets.

## LithosAI advertises its full context window - 2026-09-23

`LITHOS_EFFECTIVE_CONTEXT_WINDOW_PERCENT` in `src/provider/lithos.ts` is 100, not the 95 percent reserve the other
providers keep: the direct LithosAI route advertises its full 1,048,576-token window to `/v1/models` and the Codex
catalog instead of a padded one. The 95 percent value would publish an effective window 52,428 tokens smaller than the
one the provider advertises, and nothing in the panel or the catalog would show that the difference is a local choice.
Reversal risk: lowering it again silently shrinks every consumer's view of this route, so change it only with a
measurement showing the upstream refuses the advertised size.

## Immutable releases are pruned after a verified deploy: the newest five plus the running one - 2026-09-23

Both deploy paths unpack a full `git archive` of the released revision into `.data/releases/<sha>`, so a repeatedly
deployed checkout carried one complete copy of `src`, `tests`, `docs` and `static` per revision: 47 directories and 391
MB on the Mac, roughly 12,000 duplicate TypeScript files that every recursive search and editor walk pays for. Retention
is now enforced by the deploy itself rather than left to an operator. `ops/release_retention.ts` keeps the five newest
releases by mtime plus whatever `.data/current` resolves to, and `ops/deploy-mac.ts` and `ops/deploy.ts` call it only
after the health check proves the new release is live, so a pruning fault is reported in the JSON receipt
(`releases_pruned`) instead of failing a verified deployment.

Guardrails: only a directory whose name is a full 40-character Git revision is a candidate; a candidate is skipped when
it resolves outside the store, so a planted symlink cannot redirect the delete; `.staging-*` directories and plain files
are never touched; the running release survives even when it is the oldest directory present. `deno task prune:releases`
applies the same policy by hand for a checkout that predates retention, and `deno task test:vps` carries the retention
tests inside the verify gate.

Retention is a policy constant (`RELEASE_RETENTION_KEEP = 5`), not a per-invocation flag: rollback only needs recent
releases, and an operator-facing knob would be tuned ad hoc. The Mac was pruned once under the new policy (47
releases/391 MB to 5 releases/47 MB) with `.data/current` and the live `git sha` health identity unchanged; the VPS
prunes on its next `deno task deploy:vps`. The separate duplication in `.codex-worktrees` (about 90,000 TypeScript
files, mostly `tools/node_modules` materialized per worktree by `scripts/_bootstrap.sh`) is acknowledged and remains
unaddressed by this decision.

## Capture storage is bounded per host with oldest-first eviction - 2026-09-22

The owner authorized capturing private request contents and deleting the oldest capture-owned records when storage
grows, around a 1 GiB per-host budget. Each host therefore keeps one fixed 1 GiB budget for capture-owned encoded KV
payload (base64-expanded ciphertext chunks plus metadata/status/dedupe/index row overhead) plus in-flight charges, with
a hard record-count bound. **Durable per-capture accounting rows are the source of truth** and the ledger is derived
cached state: admission, publication, release, eviction, payload expiry and status admit/prune change a charge in the
same `kv.atomic()` commit as its row, checking both exact versionstamps. Accounting rows are timestamp-first keyed (the
oldest-first index), carry no KV TTL, and stop existing only through the atomic commit that deletes them and decrements
the ledger. Bootstrap materializes each missing legacy accounting row together with its ledger charge; cleanup of a
manifest that predates request ownership retains only its fingerprint tombstone rather than inventing an owner status.

Admission reserves in durable KV before any chunk is written. A fence-advance commit precedes each batch, and one atomic
chunk transaction checks its committed accounting-row versionstamp before writing at most twelve 48 KiB chunks (576 KiB
payload plus bounded keys/check overhead, below the 800 KiB atomic limit). Revoke or release changes that row, so a
paused transaction cannot append after capacity was reclaimed. Publish transitions `reserved -> stored` together with
the manifest, dedupe, request status, incident evidence and ledger; a refused admission is skipped with a visible
`storage_full` status instead of storing unaccounted data. Eviction claims a victim by CAS before deleting anything,
releases the charge only once its chunk prefix is provably empty, and CAS-deletes the dedupe row only when it still
references that victim's manifest key. TTL expiry is a separate reclamation path reporting `expired`/`payload_expired`
with no `evicted_*` increment. Capture-owned status and tombstone rows are bounded by a fixed 64 MiB reserve inside the
1 GiB (payload admissions may use at most `budget - 64 MiB`) and a 50,000-row bound, pruned oldest-first; a pruned
lookup reports `status_not_retained`. Native metadata TTL deletion is not an atomic ledger update: maintenance and
metadata pressure reconstruct those derived counters only after a complete bounded strong scan of both prefixes and a
CAS on the ledger version captured before scanning. Concurrent accounted mutations invalidate the scan; TTL deletion
during scanning can leave a conservative overcount until a later pass, without incrementing pruning history.
Pre-existing captures are counted by a resumable bootstrap that sweeps every capture-owned prefix, counts scanned
entries and fails closed on a corrupt in-scope row or an unreadable ledger, never assuming zero.

The budget deliberately does not bound the shared SQLite database, its WAL, reusable allocated pages, other namespaces,
the incident index namespace in `src/sentinel/incident-outbox.ts` (separate incident bookkeeping whose capture reference
rows are TTL-bound to evidence expiry), or auth/quota/usage state, and eviction never touches them. Host text logs are
separate: the Mac gateway's launchd `mac.stdout.log`/`mac.stderr.log` sizes are reported stat-only as `null` when
unmeasured, with an independent 1 GiB warning, and no rotation or truncation is performed by this feature. The 32 MiB
request and 4 MiB/4,096-chunk/8-attempt trace ceilings are unchanged; one derived limit module now feeds serialization,
encryption, export/decode and the offline reader so the previous mismatched 256 KiB metadata cap and reader bound cannot
disagree. The admin error-history panel shows usage, cap, eviction and skip notices from the existing capture-retention
status.

Reversal risk: reverting to unbounded growth, counting raw ciphertext instead of the encoded payload, publishing a
manifest before its budget transition, letting an expired lease free budget while an unfenced writer can still append
chunks, making the ledger authoritative instead of the rows, applying a ledger delta in a commit separate from its row
change, releasing a charge before the chunk prefix is provably empty, evicting without a claim CAS, or letting
capture-owned status metadata grow without bound would each restore silent unbounded growth, double-charge capacity or
lose accounting.

## Gateway Jev compaction for marked Codex requests - 2026-09-22

`POST /v1/responses` answers an explicitly marked Codex compaction locally instead of dispatching a main model. The
predicate is header-only: `x-codex-turn-metadata` must parse as JSON with `request_kind: "compaction"` and
`compaction.implementation: "responses"` (the one enum variant verified against official Codex rust-v0.155.1). Absent,
malformed, unknown and `responses_compaction_v2` markers keep the existing route; prompt text is never inspected. The
seam is inside `runResponsesRoute` in `src/handler/terminal-route.ts`, after `authenticateClient` and admission, so the
route keeps `executeInference` ownership and its terminal wrapper, and an ordinary request's body, abort signal and
provider routing are untouched.

The handler reuses the finished selection and rendering core of `0x4007/fast-jev-compaction` (MIT) at
`c1eab5fdbd6bde7d67f2da070116496558836884`, pinned with its license and a file map in `lib/jev_compaction/`; the gateway
adapter is `src/jev_compaction/compaction.ts`. Only the library and Codex item mapping were ported; the upstream HTTP
proxy, CLI and server are not part of this gateway. One handled compaction may make several bounded Jev batches (state
ceiling 25,000 tokens, request ceiling 30,000 tokens, 30-second per-call transport bound, caller abort forwarded), and
local code renders retained text verbatim under the existing 400,000-character summary cap.

Failure is closed and local: malformed or empty input, no unpinned candidates, no measured reduction, Jev error or
timeout, partial decisions, empty or oversized summary, and cancellation each return a non-success response before any
completion is emitted, so Codex keeps its existing history. There is no main-model fallback, no account rotation, no
invented usage, and no `encrypted_content`. `TYPESAFE_API_KEY` is read lazily with `Deno.env` only when a recognized
compaction is handled; a missing or denied value is an explicit 503, never a startup failure. A successful local answer
carries explicit completion telemetry (`setResponseCompletionTelemetry` in `src/openai-telemetry.ts`: completed,
semantic output observed, a `response.completed` stream terminal, and usage counters left null), so the normal terminal
wrapper's own completion decision commits the repository reservation after delivery instead of releasing it as a stream
that ended without a completion; a failed or cancelled answer stays unmarked and releases through the same wrapper. No
main-model token, allowance, model or cost counter is fabricated either way.

Reason: the official client decides when to compact and must keep its normal history and routing; only the summary text
for an explicitly marked local compaction is gateway-owned. The alternative client-side fork would need per-client
maintenance and was rejected by the user.

Status: implemented and accepted as a prototype on 2026-09-22. The focused tests and the credential-free real HTTP
fixture exercise the real handler over loopback HTTP with an injected asker, including the actual completion/telemetry
settlement and the history-preserving failure path. Historically, the stock Mac Codex client 0.155.1 against the
hash-verified candidate completed one manual and one automatic compaction with real Jev, each path making one Jev API
request; the next requests carried the adopted summaries, and normal turns made zero Jev calls. The live receipt is
`591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/9baf75f6-b2e7-4a74-9962-e61ceb3ad0df`. The current
port was additionally accepted on the installed stock Codex 0.160.0 in credential-free fake-asker mode: the real CLI
completed one manual and one automatic compaction, the next request adopted the automatic summary, an injected Jev
outage left the original history intact, normal turns invoked no Jev asker, no marked compaction reached the main-model
upstream, and the run made zero real Jev API requests and no paid API calls. Repository verification and PR/CI delivery
remain pending, and nothing here is deployed.

Reversal risk: removing the predicate restores main-model compaction dispatch, and widening it to prompt matching or to
unverified metadata variants would claim requests the gateway cannot answer. Treating a Jev failure as success, or
truncating kept content to force a summary, would silently replace the client's history.

## Gateway reliability program: finite admission, terminal parity, deadlines, optional analytics - 2026-09-22

A finite process-resource guard now bounds terminal inference routes at 64 active requests and 128 waiting requests with
a 5-second queue bound, fair rotation across authenticated principals, and idempotent release; a permit is held from
before provider dispatch until the response body and delivery settle, and the overload refusal is a local 503
`local_inference_overload` with `Retry-After`, distinct from the 499 a cancelled caller receives. The narrow
supersession of the 2026-08-25 admission ban, and why process-resource occupancy is not upstream quota and never
advances paid tiers, is recorded in `docs/provider-decision-journal.md`.

Terminal truthfulness fixes carried by the same program: streamed DeepSeek Responses events now stamp a monotonic
`sequence_number` at the single encoder seam while keeping every `output_index`/`content_index` stable, refusal
delta/done remain answer-bearing parts, truncated streams and buffered truncations stay truthful `response.incomplete`
results, and the stream deadline factories now release their timers when an attempt is aborted or cleared instead of
holding a budget handle to the deadline.

Optional analytics durability boundary: only the aggregate prompt-cache analytics write is enqueued on a bounded
best-effort queue (256 entries, 256 KiB, 60-second age, 4 concurrent writes, absolute 5-second drain deadline). The
prompt-cache telemetry gate counters, admin error evidence, Sentinel replay capture and degradation, and
quota/accounting settlement stay awaited and lossless, and a stalled optional sink cannot extend or hang the terminal
handoff. Bounded shutdown is exported from `serve.ts` and awaited by both the Mac and VPS launchers after server work
settles and before the KV handle closes; one sanitized counter snapshot is logged when the queue existed.

Status: implemented and locally verified. On the frozen candidate at HEAD `d71cf726eb3004264501671ed665692313ed72f5`
plus the resolved merge and worktree changes, the registered real HTTP capture passed all three cases (repository key
`591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5`, receipt `348beddd-498c-4eac-a8ad-1bb7bc9a180b`,
13411ms) and the registered integrated capture passed together with all five module suites (receipt
`64b8b95b-3e9b-41bf-b93e-188a3d6092d0`, 23915ms). The `deno task test` command runs `tests/oss-gateway-http.test.ts` as
its own isolated `deno test --unstable-kv` process, because that suite uses a real in-memory Deno KV while the ordinary
suite keeps its established monkeypatched KV tests unchanged. Full `sh scripts/verify.sh` is still pending and none of
this is deployed.

## Codex premature turn endings: real reproduction, and the continuation-guidance contract - 2026-09-22

The case that Codex can end a turn with an outstanding requested action is recorded here as reproduced, not inferred
from the invalid frequencies corrected below. The contract this repository now carries is: on the DeepSeek Responses
translation seam, a tool-bearing request whose mapped executable tools exist and whose `tool_choice` is not `none` gets
one short neutral continuation instruction appended to the caller's own instructions, or carried as the system message
when the caller sent none. It never forces a tool call, forbids a legitimate final answer, or claims a tool action
happened.

The reproduced pair, one real `codex-cli 0.155.1` run per variant against a task-owned loopback bridge serving the
Responses wire API, same fixed cwd, same provider id, same captured native catalog, same model `deepseek-flash` at
effort `max`, and the same 16-step read-only chain prompt (receipt
`591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/509ce225-f066-4bf6-af9c-fcd85739173f`):

| Variant                           | Reads                    | Terminal state                                                                                                                                                                                                                                     | Exit | Checksum |
| --------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| baseline (`a4d0b470`)             | 11 of 16 files, in order | one `turn.completed`, final text `Step 12 of 16, reading nodes/2c/rotate-4571.snippet`; last upstream call HTTP 200, `finish_reason` `stop`, zero tool calls, 20 completion tokens of an 8192 allowance, `[DONE]` present, no error, no truncation | 0    | absent   |
| candidate (continuation guidance) | 16 of 16 files, in order | one `turn.completed`, one marker per successful tool result, no human confirmation and no goal auto-continuation                                                                                                                                   | 0    | 3961     |

The probe's own `incomplete-chain` classification wins its check order, and its `earlyTextOnlyStopObserved: false` is a
consequence of that ordering; neither refutes the captured upstream facts above.

Scope and limits, so the claim is not overstated: this is one paired long run, so it establishes that the behaviour
occurs and that in this pair the baseline stopped while the candidate completed; that supports the reminder as a
mitigation, not a rate, a probability, a universal cure, or a causal claim from n = 1. The mechanism that makes the
model stop mid-chain is still not identified. A frozen historical replay did not reproduce the stop, and a real-Codex
phase-only A/B ended after one request for both `commentary` and `final_answer`, so changing output phase alone did not
make Codex continue. This change does not modify phase, and that phase-only test says nothing about upstream
history-phase effects. Related but non-causal measurements: the served native catalog's `deepseek-flash` entry has empty
`base_instructions` and the native client sends `instructions: ""` with the developer/system input text still present;
that catalog fact alone is not claimed as the cause. The vendor `thinking` field is now accepted on DeepSeek and
projected to `reasoning_effort` (PR #391, the base revision for this measurement), and that compatibility change did not
fix these premature stops.

Reversal risk: the guidance is appended to every DeepSeek tool-bearing request that permits tool use, so removing it
restores the measured baseline, while widening or rewording it can make the model prefer tool calls over a legitimate
final answer or pad otherwise ordinary agent traffic. The truthfulness, `tool_choice: none`, non-agent and
legitimate-final cases in `tests/deepseek-responses.test.ts` preserve the request and terminal contracts; they do not
detect a model's semantic preference, and the real-client controls are what check that a legitimate final answer is not
displaced.

Residual obligation: the visible behaviour above was measured against a task-owned loopback. Loopback evidence and
served-release acceptance are distinct: the exact served identities, and the actual client outcomes against them, must
be recorded in the release handoff, using the served-client probe beside this entry's evidence directory.

### Follow-up: the reminder alone is insufficient - 2026-09-22

The PR #395 reminder was merged and deployed as `e04f67ff`. The VPS real 16-step run passed, but on the Mac the real
client stopped at 10 of 16 with final text `step 11 of 16, reading nodes/7b/tally.sql`, exit 0, one completed turn, and
receipt `591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/cb7c10e7-08d5-41b3-8e0b-e421cdaa969a`. That
outcome establishes that the reminder alone is insufficient. The original paired reproduction stays recorded as
historical evidence of the baseline stop, and it must not be recast as proof that the reminder never works.

For part of that day the gateway also carried one semantic recheck on a successful, text-only stop where mapped
executable tools existed, `tool_choice` was automatic, the stop carried no refusal, usage was known, and positive output
remained. It ran the same model with the same tools and effort, added no wire fields or settings, buffered the recheck,
kept the first stream progressive and kept the original response identity; accepted returned tools were delivered before
the terminal event and no duplicate recheck text was emitted. The original answer was preserved on a legitimate final
answer, on no tools, and on advisory failure. The guard skipped the recheck for `none`, `required`, or named tool
choice, truncation, empty output, a refusal, no tools, an unmeasured first-leg usage, a non-finite numeric allowance,
and an exhausted known budget. A null allowance was neither a skip nor a zero budget: real Codex `high`/`max` traffic
omits `max_output_tokens`, so no finite original cap was requested and no provider default for those tiers has been
measured, which is why telemetry kept that allowance unknown instead of back-filling a fabricated default while the one
advisory call still proceeded, bounded at 8,192 tokens and reporting no aggregate remaining budget because none is
known. When a numeric allowance did exist, an explicit caller cap or the measured `none`-tier default, the recheck
subtracted the first leg's use and took `min(remaining, 8192)`. Cancellation aborted the extra call, and there was no
second admission or reservation. One extra provider request was the cost for an eligible text-only final: input cost and
latency rose, and the output cap was `min(remaining original allowance, 8192)`. Actual usage from both requests was
summed; missing fields stayed partial and no cache zeros were invented. Refusal metadata was preserved through provider
normalization so the guard could observe it; on this route a refusal is also rendered as an answer-bearing content part,
and the guard skipped the recheck for it.

### Decision: invisible extra inference is forbidden, and the semantic recheck is retired - 2026-09-22

The semantic recheck described above is retired. The user's rule is explicit: invisible inference, or an inference leak,
is never allowed. A gateway that repeats a caller's task with a hidden appended user prompt is a second generation the
requesting client never asked for, cannot see, and cannot audit, so it is not a permitted mitigation regardless of its
effect on premature stops. The implementation was removed from `src/openai.ts` and `src/deepseek/responses.ts`: no
hidden recheck prompt, no second upstream dispatch, no folding of a second generation's tools into the first response,
and no combined two-request usage accounting remain. After a successful text-only first response the gateway completes
with that provider output, and the streamed and buffered single-dispatch regression checks assert exactly one upstream
provider invocation, the original text, the first call's own measured usage, and one terminal response.

Output-budget availability is not authorization. A positive caller `max_output_tokens`, or a measured provider tier
default, only bounded the extra request; neither made the extra inference visible or consented. Combined accounting is
not authorization either: summing both requests' usage truthfully described a second generation that should not have
happened, and truthful bookkeeping cannot retrofit consent. Extra model work, if it is ever explicitly opted into, must
be exposed by the requesting client with an attributable, persisted visible record; the gateway must not invent that
opt-in on the client's behalf.

The previous semantic recheck's historic acceptance receipts do not prove a currently supported behavior: any receipt
describing a second dispatch, a merged two-request total, or cancellation of a pending recheck records a retired
operation. The historic failure evidence stays recorded, including the Mac run above, because the retained
original-request reminder remains an imperfect mitigation. The premature-stop problem is not claimed to be universally
fixed by this decision, and no client hook or other client-side continuation mechanism is installed by it. The
deterministic gateway repair is the removal itself; a visible, officially supported client action would be a separate,
authorized change.

## App-wide visual language follows the deno-universal-auth reference - 2026-09-22

The app-wide design is the shared token system in `static/style.css`, ported from the `deno-universal-auth` reference
contract: OS-driven light and dark, system-UI type at 14px body and 20px headings, 10px control and 14px panel radii,
44px controls, quiet shadows, and blue reserved for actions and selection.

- Palette, light: `--bg` `#f7f9fc`, `--surface` `#ffffff`, `--surface-2` `#f1f5f9`, `--surface-3` `#e2e8f0`, `--text`
  `#111827`, `--muted` `#5f6b7a`, `--muted-2` `#55606e`.
- Palette, dark: `--bg` `#09090b`, `--surface` `#141418`, `--surface-2` `#1d1d22`, `--surface-3` `#29292f`, `--text`
  `#f5f5f7`, `--muted` `#a1a1aa`, `--muted-2` `#8e8e99`.
- Light is the base block and `@media (prefers-color-scheme: dark)` overrides only the palette; `color-scheme` stays
  native (`light dark`) and no page declares a theme class, toggle, or stored preference.
- Actions use `--accent` `#0063d1`, `--accent-hover` `#006fe6`, and white `--accent-ink`; dark uses `#0a6ae0` and
  `#0f70e0` with the same white label, while the brighter `--link` `#4da3ff` and translucent `--selection` carry dark
  link, focus, and selected states.
- The contrast repairs are deliberate: the reference's `#007aff`-on-white action, `#0a84ff`-with-white dark label, and
  1.3:1 `#d5dee9` input border are replaced, so quiet text clears 4.5:1 and `--input-border`, `--border-strong`, and
  `--focus-ring` clear 3:1.
- Page styles consume `--radius-sm` for controls, `--radius-lg` for panels, and `--control-height` instead of
  redeclaring a palette; no page adds a second alias token system.
- Motion uses `--duration-fast` at 140ms for press and hover feedback and `--duration-med` at 220ms for occasional
  surface changes; hover motion is gated by `(hover: hover) and (pointer: fine)`, keyboard actions stay immediate, and
  reduced motion keeps short fades while dropping transforms.

Reason: the app was dark-only, with hardcoded `rgba(255,255,255,...)` surfaces through the shared sheet, a pinned
`color-scheme: dark`, and a visual contract that lived only in `tests/static-assets.test.ts`. Recording the tokens, the
light and dark ownership, and the contrast repairs here keeps the next page-local restyle from re-deriving a divergent
palette.

Reversal risk: a page-local `:root` palette, a pinned `color-scheme: dark`, or a light-only literal re-splits the app
and restores the measured contrast failures, and deleting the token assertions in `tests/static-assets.test.ts` removes
the only automated guard because no browser or screenshot check exists in the repository.

## Terminal truthfulness questions are settled - 2026-09-21

The generalized terminal-truthfulness program asked two specification questions before any stop-reason mapping could be
written. Both are answered from primary OpenAI specification sources, and the merged mapping depends on the answers, so
they are recorded here rather than left open in the handoff.

**Q1 - the incomplete reason vocabulary.** The current Responses schema defines `incomplete_details.reason` as exactly
`max_output_tokens`, `max_messages`, `content_filter`, `steered`, and the response `status` enum as
`completed | failed | in_progress | cancelled | queued | incomplete`. The reasoning guide states that reaching either
the context-window limit or `max_output_tokens` yields `status: "incomplete"` with
`incomplete_details.reason: "max_output_tokens"`. Therefore output-budget exhaustion and context-window exhaustion share
`max_output_tokens`; no separate context reason is invented, and the mis-spelled `max_tokens` found in one
streaming-reference example is never emitted.

**Q2 - reasoning-only output with stop reason `stop`.** This is not a specified incompletion, so no incomplete reason
may be fabricated for it. Under this gateway's own declared route contract, a stream that accumulated no tool call, no
non-empty assistant text and no refusal is an unusable completion, and it is classified with the existing
`empty_upstream_completion` failure kind rather than as `response.incomplete`. An explicit upstream truncation or
filtering signal is an incompletion and wins over that classification.

Reason: without a recorded answer, the next provider adapter would re-derive the rule, and the two plausible readings
differ in exactly the case (reasoning-only `stop`) that the gateway now classifies. The reason spelling is a wire
contract, so `max_output_tokens` is not a stylistic choice.

Reversal risk: emitting `max_tokens`, inventing a context-specific reason, or reporting a reasoning-only `stop` as
either a clean completion or an incomplete response would each restate a fact the specification does not support, and
would silently change what clients and operators read from a terminal event.

## Codex honors response.incomplete, measured end to end - 2026-09-21

The generalized mapping emits `response.incomplete` with `incomplete_details.reason` for a truncated generation. Whether
that is a safe change depends on how the actual Codex client reacts, which no amount of reading the gateway can settle.
It was therefore measured directly with a controlled A/B: two byte-identical Responses SSE streams that differ only in
their terminal event, served to `codex-cli 0.155.1` as a configured Responses provider.

| Terminal served                                   | Codex output                                                                                                             | Exit | `task_complete.error` |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---- | --------------------- |
| `response.incomplete`, reason `max_output_tokens` | the streamed text, then `stream disconnected before completion: Incomplete response returned, reason: max_output_tokens` | 1    | that message          |
| `response.completed`, same text                   | the streamed text, no error                                                                                              | 0    | none                  |

Each run made exactly one HTTP request to the scripted upstream, so an incomplete terminal causes neither a silent
acceptance nor a retry loop.

Two consequences are recorded here so they are not re-derived:

- **The mapping is safe to keep.** Codex parses the incomplete terminal natively, surfaces the reason string verbatim,
  and fails the turn. A truncated generation therefore moves from "accepted as success with exit 0" to "reported with
  the reason and exit 1", which is the intended trade rather than a regression.
- **The mapping is already opt-in per provider, so no filter is needed.** `deepSeekFinishDisposition` reaches a route
  only through a `ChatOnlyResponsesProfile` that names it; the per-upstream truncation entry below lists the sites that
  construct `response.incomplete` and the routes that relay it, so this mapping is not the only constructor (corrected
  2026-10-16, #606). Surplus, OpenLux, OpenRouter, and the Codex upstream route through their own paths and cannot
  inherit it. Adding a provider inherits nothing; a provider that should use it needs its own deliberate mapping.

Reversal risk: removing the mapping restores the silent truncation, and reading a non-completed terminal as a transport
failure would discard a partial answer the client can still use. Do not add a per-provider allow/deny list for this
mapping on the assumption that it leaks across routes; it does not.

Residual gap: Surplus and OpenLux were not probed, so their truncation-stop behaviour remains unverified. Codex's
handling of the terminal is proven; which upstreams ever emit it is not.

## Deployment status of the terminal-truthfulness work - 2026-09-21

The measurement-artifact correction above retracts the premise that motivated this work. It therefore matters which
parts are actually running, and whether any deployed behaviour change was justified by the retracted claim.

**Status update, same day: both deployments now run the program.** At the time this entry was first written none of it
was deployed, and the two running releases predated every commit in it. The program was then deployed to both surfaces
at `2207a757fb6f8c362e18cbf890d59ee191d53e26`, after CI passed on that exact SHA and `verify: OK` on the same revision:

| Deployment                                                 | Release      | Identity                                       |
| ---------------------------------------------------------- | ------------ | ---------------------------------------------- |
| VPS (production, and the public `https://ai.ubq.fi` route) | `2207a757fb` | `vps-2207a757fb6f8c362e18cbf890d59ee191d53e26` |
| Mac local (`localhost:7999`)                               | `2207a757fb` | `mac-2207a757fb6f8c362e18cbf890d59ee191d53e26` |

Acceptance ran against the deployed releases, not the branch:

- the truncation reproduction returns `response.incomplete` with `incomplete_details.reason: "max_output_tokens"` and
  `output_tokens: 8192` on both hosts, where it previously returned `response.completed` with
  `incomplete_details: null`;
- three normal completions still return `status: completed` with `incomplete_details: null`, so it does not over-fire;
- authenticated inference through the public route succeeds, and `gpt-reserve` serves on both hosts.

> **Qualified on 2026-10-16 (#608): acceptance of this release is unverified against `AGENTS.md`.** `AGENTS.md` accepts
> a deployment only when a direct Mac-to-VPS authenticated inference request succeeds and `/health` returns the full Git
> SHA and `vps-<full-git-sha>` in both its body and identity headers. That rule was already in `AGENTS.md` at
> `2207a757fb6f8c362e18cbf890d59ee191d53e26`. Neither observation is recorded for this release:
>
> - The authenticated inference above went through the public `https://ai.ubq.fi` route. That does not show a direct
>   Mac-to-VPS authenticated inference request succeeding.
> - The identity table names each host's release and identity, but not where they were read. It does not record that the
>   VPS `/health` returned `2207a757fb6f8c362e18cbf890d59ee191d53e26` and
>   `vps-2207a757fb6f8c362e18cbf890d59ee191d53e26` in both its body and identity headers.
>
> The bullets above are kept as first written. They show the fix behaving as intended on both hosts; they do not show that
> the release met the repository's acceptance rule. This note adds no new observation, and nothing in this repository
> supplies the missing ones. Read the status line above as "deployed to both surfaces, acceptance unverified".

The retracted premise is now moot in one direction: the deployed G3 is narration-independent by construction - it fires
only when a would-be completion carries no assistant text, no refusal and no tool call, so it cannot act on the
retracted symptom. Worth revisiting before any future change: the changelog wording that described it as a "no tool
call" guard, which reads as narration-targeted although the code does not test for that alone.

Prior state, retained: the two then-running releases (`922c33392d` on the VPS, `4176e992f5` on the Mac) preceded every
commit in the program, so at that time no production inference behaviour had changed.

**Only one of the three changes depends on the retracted premise, and partially.**

- **G5 (report the effective output allowance)** - independent. It is telemetry only, changes no generation behaviour,
  and was justified by the provider's tier-dependent default (8,192 at `none`), measured directly.
- **G1 (`length` to `response.incomplete`)** - independent. It was reproduced end to end: an upstream
  `finish_reason: "length"` reached the client as a clean `response.completed` with `incomplete_details: null` while the
  gateway's own telemetry recorded `output_tokens: 8192`. That demonstration does not involve narration at all.
- **G3 (fail closed on a degenerate completion)** - **partially dependent.** Its stated trigger is a stream about to
  complete "with no tool call, no non-empty assistant text and no refusal". The no-tool-call clause was written for the
  narration symptom that has now been retracted. The reasoning-only clause stands on its own: a completion whose only
  output is reasoning hands the client nothing, which the Cerebras route already failed closed for independently of any
  narration claim. The no-tool-call clause is nonetheless required on its own merits, whatever motivated it:
  `isAnswerBearingCompletion` in `src/upstream-wire.ts` counts a tool call as answer-bearing, and the stream relay fails
  a completed terminal closed only when that predicate is false, so dropping the clause would fail every tool-call-only
  turn - an ordinary agent step - closed as `empty_upstream_completion`. The retracted narration cases carried non-empty
  assistant text, so they never depended on this clause.

Reason for recording this: the correction above removes the motivation for one clause of one change, and a future reader
deciding whether to deploy needs to know that the other two changes and most of the third rest on reproductions that
survived the retraction.

Reversal risk: deploying on the belief that the narration symptom is real, or reverting the whole program because its
original motivation was retracted. The first is unfounded; the second discards two independently reproduced fixes.

**Post-deployment follow-up (updated 2026-10-16, #608).** This entry first ended with a pre-deployment next action: "if
the program is to be deployed", re-derive G3's trigger from the surviving evidence alone. The program was deployed on
2026-09-21, so that next action is historical. The G3 bullet above now carries the re-derivation, and it keeps every
clause of the deployed trigger: the reasoning-only and empty-output clauses stand on the surviving evidence, and the
no-tool-call clause rests on the completion-validity predicate, not on the invalidated frequency claim. What remains
after deployment:

- Before any future change to G3, revise the changelog wording that calls it a "no tool call" guard (see above). Keep the
  no-tool-call clause for as long as `isAnswerBearingCompletion` counts a tool call as answer-bearing output; re-derive
  the trigger if that predicate changes.
- Do not cite this entry as an accepted deployment under `AGENTS.md`. The missing acceptance observations were not
  recorded while `2207a757fb` ran, and both surfaces moved to `3661bcfd13` on 2026-09-22 (see "Buffered-terminal fix
  deployed to both surfaces" below).

## CORRECTION: the narration symptom was itself a measurement artifact - 2026-09-21

> **Superseded in part on 2026-09-22.** The reported counts remain unreproducible and cannot be quoted as a rate. A
> paired real-client reproduction did observe one premature stop with outstanding work, so these invalid counts are not
> evidence that the behaviour is absent either. See the entry at the top of this file.

> **Qualified on 2026-10-16 (#603): the artifact conclusion is unverified, not established.** Two comparisons below do
> not test the handoff's measurement as it was recorded, so they cannot show that it was an artifact. The text below is
> kept as first written; read its "not reproducible" as "not reproduced".
>
> - **Window.** The handoff scopes its counts to the 2026-09-21 13:26–13:56 UTC window. The reconciliation table below
>   counts "the two sessions" and never states that window, so it is not a like-for-like comparison: counts over a
>   different span are not expected to equal the windowed ones, and "no column matches" does not show that the original
>   measurement cannot be reconstructed.
> - **Classifier.** The handoff defines promise-narration as a trailing assistant text that matches a forward-looking
>   phrase _and_ ends the turn with no tool call after it. The two counterexamples below are followed by a tool call, so
>   that classifier counts them as negatives, and the 805-of-1,053 figure measures the bare phrase match over all
>   messages, not that classifier over turn endings. They show only that the phrase alone is not a discriminator.
>
> No recount applying the documented classifier inside the stated window is recorded, so the 154-of-292 and 24-of-67
> counts are neither reproduced nor shown to be an artifact. They remain unverified and still must not be quoted as a
> rate; the sampled turn endings below are examples, not a recount.

The entry below and the terminal-truthfulness handoff both rest on an observed condition: a long-running agent
"frequently believes its turn completed mid-task", quantified as 154 of 292 turns in one session and 24 of 67 in
another. **Those reported counts are not reproducible from the recorded sessions.** It appears to be an artifact of how
the original count was taken, and the entries that depend on it should not be cited as evidence that the behaviour is
common.

**The numbers do not reconcile.** For the two sessions the handoff names, counting every plausible unit:

| Session                | `task_started` | `task_complete` | assistant text messages | matching a forward-looking phrase |
| ---------------------- | -------------: | --------------: | ----------------------: | --------------------------------: |
| `sentinel`             |            423 |             414 |                   1,053 |                               805 |
| `oracle-free-arch-vps` |            145 |             143 |                     497 |                               269 |

The handoff reports 292 turns / 154 narrated for `sentinel` and 67 / 24 for `oracle`. **No column matches either
figure**, so the original measurement cannot be reconstructed from the sessions it cites.

**The forward-looking-phrase test does not identify premature endings.** Inspecting the messages it matches shows they
are ordinary mid-task narration that is _followed by a tool call_ — "Let me load the required harness policy and verify
key facts in parallel", "Let me answer the ai.ubq.fi question definitively". The phrase appears in 76% of all assistant
messages (805 of 1,053), which is why the test is unusable as a discriminator: it fires on normal working text, not on a
malfunction.

**What the turns actually look like.** Reading turns to their end shows the model doing hundreds of tool calls and then
closing with a substantive summary. The 4211- and 6380-character closers on `task_complete` are honest completions of
long investigation work, not a model believing it finished early. Turns cluster at a median of 7 response items, with
only 3 of 13 in one sampled window exceeding 10 items.

Reason for recording this: two merged documents and six merged corrections treat this symptom as established and build
on it. A future reader must know that the premise is unsupported, or the chain of reasoning above this entry inherits an
artifact. The gateway trustworthiness findings in the handoff stand on their own evidence and are unaffected; only the
claim that the symptom is frequent, and the model-versus-gateway contrast drawn from it, depend on this.

Reversal risk: quoting 154-of-292, treating forward-looking phrasing as a malfunction signal, or building any detector
on that regex. Each propagates the artifact.

Method note: the original count was never reproduced, so the defect is most likely in the counting procedure rather than
in the sessions. Any replacement measurement must state its unit (turn, message, or item), its window, and how it
decides a turn was premature, and must show that the classifier does not fire on ordinary mid-task narration.

## CORRECTION: context size is unconfirmed as the narration trigger - 2026-09-21

> **Qualified on 2026-10-16 (#603): unconfirmed, not falsified.** As first written, this entry was headed "the narration
> trigger is not context size", headlined "That is falsified", labelled its first measurement "The disconfirming
> measurement", concluded "Length alone therefore cannot be the trigger, which falsifies both" the trigger and the
> onset, filed both under "Does not survive" (in "What survives, and what does not"), and called the trigger "a
> falsified trigger". Its own time-controlled contrasts are non-significant (`p = 0.47` each), the only significant
> contrast (`p = 0.016`) pools runs from different time windows (the first table's 8/28 against 0/18 gives that value),
> and the original effect did not replicate on its own payload (`p = 0.14`). That supports "unconfirmed", not
> "falsified": context size is not established as the trigger, and context length is not excluded as one either. Those
> phrases are replaced with "unconfirmed" wording below; the measurements, tables and `p` values are unchanged.

The entry below reports that context size gates narration-without-action. **That is unconfirmed.** It is retained for
history, but the trigger section and the onset threshold must not be relied on. The reason is an external-validity
failure in the experiment: every payload used to derive the curve repeated one identical filler block in every tool
output, so "long context" and "degenerate repetitive context" were confounded and could not be separated.

**The contrasting measurement.** A second payload family was built with genuinely distinct tool outputs (20 rotating
result shapes plus per-index text, every output unique) and matched to the original on byte size and item count. Both
were run against `deepseek-flash` at matched effort:

| Payload               | Actual input tokens |      n | Narrated |   Rate |
| --------------------- | ------------------: | -----: | -------: | -----: |
| repetitive (original) |              66,533 |     28 |        8 |    29% |
| **varied (matched)**  |          **71,295** | **18** |    **0** | **0%** |

The varied payload is _larger_ than the repetitive one and narrates _never_. If that contrast holds, length alone is not
the trigger, which leaves both "context size is the trigger" and the recorded onset of "between roughly 1k and 4k"
unconfirmed.

**A controlled interleaved run, and its non-result.** To separate condition from time drift, the three conditions
(repetitive ~66k, varied ~71k, small ~1k) were cycled round-robin inside a single time window, eight rounds:

| Condition       | Narrated in the interleaved window |
| --------------- | ---------------------------------: |
| repetitive ~66k |                          2/8 (25%) |
| varied ~71k     |                           0/8 (0%) |
| small ~1k       |                           0/8 (0%) |

Neither contrast is significant in this design (`p = 0.47` each). Pooling all batches raises the repetitive-vs-varied
contrast to `p = 0.016`, but that pool mixes runs from different time windows and the original effect did not replicate
across batches on its own payload (5/10, then 1/10, `p = 0.14`).

**What survives, and what is unconfirmed.**

- **Unconfirmed:** context size as the trigger; the onset threshold; the implication that long real sessions
  narrate _because_ they are long. Real sessions are also full of varied content, so the synthetic confound may explain
  the original 154-of-292 observation as easily as the model does.
- **Weakly survives:** that _some_ conditions produce narration at a low rate. The pooled repetitive cells total 8/28,
  which is not zero. Its true trigger is unidentified; repetitive content is a candidate, not an established cause.
- **Survives:** that `gpt-reserve` never narrated on any payload at any size tested - 0 of 30 pooled across every cell
  run in this investigation, spanning 61k to 176k input tokens and both payload families. The model contrast is weaker
  than first reported, because the DeepSeek rate it is measured against fell, but it has not been contradicted.

Reason for recording at this length: the previous entry states a specific causal trigger with statistics behind it, and
this repository treats that as load-bearing. Leaving an unconfirmed trigger recorded as established would be worse than
the correction itself — a future reader would tune context budgets or payload shapes against a confound.

Reversal risk: acting on the size trigger, quoting the onset threshold, or treating repetitive context as a confirmed
cause. Any of those propagates an experiment artifact.

Method note for the next attempt: vary payload content independently of length, and interleave conditions inside one
time window. Both were missing here, and both are what caught it.

## Narration-without-action is model-specific and context-gated - 2026-09-21

> **Superseded.** The condition this entry measures - a model frequently believing its turn completed mid-task - is not
> reproducible from the sessions it cites; see the measurement-artifact correction above. The context-size trigger and
> onset threshold are separately unconfirmed. Treat every rate here as an artifact. The gateway trustworthiness findings
> in the handoff are unaffected, since they rest on their own evidence.

> **Qualified on 2026-10-16 (#603).** The note above first said the trigger and onset were "separately falsified"; the
> correction above supports only "unconfirmed". Three conclusions below are also narrowed to what this entry's data
> support; the measurements and tables are kept as first recorded.
>
> - **Model versus gateway.** The control does not traverse the same gateway path. Explicit DeepSeek ids take the
>   Responses-to-Chat-Completions translation (`handleDeepSeekResponses`), while `gpt-reserve` is a trusted Codex id
>   (`src/request-policy.ts`) served on the Codex Responses path. A defect specific to the DeepSeek translation route
>   could drop tool calls on DeepSeek and spare `gpt-reserve` exactly as measured, so the data show a model-and-route
>   difference and do not clear the gateway for the DeepSeek route. "A translation or transport defect in this gateway
>   would not spare one provider and hit the other on an identical body" is unsupported; clearing the route needs a
>   same-path control, such as the raw DeepSeek upstream on the same high-context bodies.
> - **Pooled rate.** The six DeepSeek bands above 1k narrate 3 + 4 + 1 + 5 + 4 + 5 = 22 of 60 runs: 36.7% (37%), not
>   the 38% recorded below. The Fisher exact `p = 0.025` of the 951-token band against those 60 runs is correct.
> - **Effort.** `gpt-reserve` was measured only at `medium` and `max`, and the DeepSeek sweep ranged from 20% to 60%
>   across four tiers. The supported conclusion is limited to the matched `max`-versus-`max` comparison (DeepSeek 5/10
>   against `gpt-reserve` 0/10, `p = 0.033`): the difference persisted with effort held at `max`, subject to the route
>   caveat above. At n = 10 per cell that comparison and the sweep are underpowered, so "reasoning effort is ruled out
>   as the cause" is unsupported; effort is neither established nor excluded as a contributor.

The investigation that produced the terminal-truthfulness work began with a model believing its turn completed mid-task:
it narrates the next action in text and terminates without emitting the tool call it described. Earlier measurement
could not reproduce that shape and reported the gateway as faithful (a tool call in 19 of 20 requests). That measurement
was taken at a context size far below the real sessions, which is why it came back clean.

**Measured with a context-size sweep.** One payload family, identical tool schemas and identical conversation, varying
only the amount of prior tool history; nothing else differs between the two models except the id and the reasoning
effort. Ten runs per cell, work outstanding, classification by whether a `function_call` item was emitted:

| Model                           | Actual input tokens |   n | Emitted tool call | Narrated and stopped |    Rate |
| ------------------------------- | ------------------: | --: | ----------------: | -------------------: | ------: |
| `deepseek-flash` (effort `max`) |                 951 |  10 |                10 |                    0 |      0% |
| `deepseek-flash` (effort `max`) |               4,400 |  10 |                 7 |                    3 |     30% |
| `deepseek-flash` (effort `max`) |               9,003 |  10 |                 6 |                    4 |     40% |
| `deepseek-flash` (effort `max`) |              14,186 |  10 |                 9 |                    1 |     10% |
| `deepseek-flash` (effort `max`) |              18,787 |  10 |                 5 |                    5 | **50%** |
| `deepseek-flash` (effort `max`) |              28,558 |  10 |                 6 |                    4 |     40% |
| `deepseek-flash` (effort `max`) |              66,533 |  10 |                 5 |                    5 | **50%** |
| `gpt-reserve` (effort `medium`) |              61,005 |  10 |                10 |                    0 |      0% |
| `gpt-reserve` (effort `max`)    |              61,005 |  10 |                10 |                    0 |      0% |
| `gpt-reserve` (effort `medium`) |             175,888 |  10 |                10 |                    0 |      0% |

Every run in every cell terminated `response.completed`; the difference is only whether a tool call accompanied it.

Two conclusions follow, and they are the reason this entry exists:

- **It is a model behaviour, not a gateway defect.** At the same ~66k context with the same payload, DeepSeek drops the
  tool call half the time and `gpt-reserve` never does — including at 175k, nearly three times the DeepSeek band. A
  translation or transport defect in this gateway would not spare one provider and hit the other on an identical body.
- **Context size is the trigger, and the onset is between roughly 1k and 4k input tokens.** Fine-grained bands place it
  lower than first recorded: 0% at 951 tokens, then 30% already at 4,400. Above that onset the rate is flat and noisy
  across 4k-67k (30 / 40 / 10 / 50 / 40 / 50%) with no monotone trend, pooling to 38% across all bands above 1k. A
  Fisher exact test of the tiny band against everything above it gives `p = 0.025`. It is a step change, not a gradual
  degradation, and the earlier clean result was a correctly executed experiment at the wrong scale.

The real symptomatic sessions ran at a median of about 485k input tokens, far above the onset, which is consistent with
154 of 292 turns ending in narration there.

Reason: the honest scope of the merged fix depends on this distinction. The terminal work makes the outcome _truthful_
(`response.completed` carrying no tool call is reported accurately instead of being laundered), but no gateway change
can make the model emit the call it decided to describe and skip. Recording the model-versus-gateway separation, with
the control that establishes it, prevents a future reader from either re-deriving it or "fixing" the gateway for a
behaviour it does not cause.

Reversal risk: treating this as a gateway defect and adding gateway-side tool-call requirements or prose heuristics
would fire on legitimate completions that end with forward-looking wording, and would misattribute an upstream model
behaviour to the transport layer.

**Effort is not the variable.** The control was re-run at effort `max`, matching DeepSeek exactly on the same payload:
10 of 10 tool calls, 0% narration at the same 61,005 input tokens, identical to its `medium` result. So the model
difference survives effort being held constant, and reasoning effort is ruled out as the cause.

**Effort does not show a detectable effect on the DeepSeek side either.** The curve was swept at the ~66k band across
`max`, `high`, `low` and `none` (10 runs each): 50%, 20%, 30%, 60% narrated. Those point estimates look like a trend and
are not one — every pairwise Fisher exact comparison among the four levels is non-significant (`p` from 0.17 to 1.00):

| Comparison       | Narrated     |     p |
| ---------------- | ------------ | ----: |
| `max` vs `high`  | 5/10 vs 2/10 | 0.350 |
| `max` vs `low`   | 5/10 vs 3/10 | 0.650 |
| `max` vs `none`  | 5/10 vs 6/10 | 1.000 |
| `high` vs `low`  | 2/10 vs 3/10 | 1.000 |
| `high` vs `none` | 2/10 vs 6/10 | 0.170 |
| `low` vs `none`  | 3/10 vs 6/10 | 0.370 |

The **model** difference, by contrast, is solid on the same data: DeepSeek pooled across effort narrated 16 of 40 (40%)
against `gpt-reserve` 0 of 20 (0%), Fisher exact `p = 0.0005`; restricted to the directly matched `max`-vs-`max` cells,
5/10 against 0/10, `p = 0.033`.

Reason for recording the non-result: the four DeepSeek point estimates could easily be read as "lower effort helps" or
"higher effort hurts", and neither is supported. n = 10 per cell does not resolve differences of this size, so a future
reader should not tune reasoning effort on the strength of those numbers.

Reversal risk: selecting or advertising a reasoning tier as a narration mitigation, or dismissing the model difference
because a single-effort cell happened to look clean, would each act on noise rather than on the measured effect.

Residual limits: rates are point estimates from 10 runs per cell, and the intermediate bands are individually noisy
enough that only the onset (between ~1k and ~4k) is established rather than a precise threshold. The effort sweep is
underpowered to exclude a small effort effect.

## Per-upstream truncation coverage for the terminal mapping - 2026-09-21

> **Corrected on 2026-10-16 (#606): construction and relaying are separate, and the untested surface is not empty.** As
> first written, this entry said `response.incomplete` "is built at exactly one place, `src/deepseek/responses.ts`",
> that "No other provider route can emit it", and of Surplus and OpenLux that "neither can currently emit the
> incompletion at all, so the untested surface is empty". The gateway constructs the terminal in three translations and
> relays it on further routes, Surplus, OpenLux and OpenRouter included, so those two paragraphs are rewritten below.
> The provider table, the Cerebras reproduction and the 2026-09-22 recheck are unchanged.

The terminal-truthfulness work changes what a truncated generation reports. Whether that is safe per provider was
checked provider by provider rather than assumed from one implementation, because the mapping lives inside a route.

**Where the incompletion is constructed.** The gateway builds a `response.incomplete` terminal itself in three
translations, each mapping one upstream stop-reason vocabulary on purpose:

- the shared Chat-only Responses translation: `deepSeekTerminalEnvelope` in `src/deepseek/responses-payload.ts`, used by
  the buffered payload and by the stream translator in `src/deepseek/responses-stream.ts`. `deepSeekFinishDisposition`
  maps `length` to `incomplete_details.reason: "max_output_tokens"` and `content_filter` to `"content_filter"`, and the
  DeepSeek, LithosAI and Cerebras profiles in `src/deepseek/responses.ts` all reuse it, so a Cerebras truncation that
  carries content becomes `response.incomplete` while the reasoning-only case below still fails closed;
- the Claude Chat writer, `createClaudeResponsesWriter` in `src/provider/anthropic-response-wire.ts`, which maps the
  same two Chat reasons for Surplus's native Claude path;
- the Anthropic Messages translation in `src/provider/anthropic-responses.ts`, which maps `max_tokens` to
  `"max_output_tokens"` for OpenLux's native Claude path and for the Claude Code route.

**Where it is relayed or mapped.** `relayResponsesStream` in `src/provider/stream-relay.ts` emits the translator's
terminal and settles the request as `response.incomplete` when the translator's terminal kind is incomplete; the
streamed DeepSeek and LithosAI routes (`src/deepseek/handlers.ts`, `src/provider/lithos-streams.ts`) both use it. The
buffered DeepSeek, LithosAI and Cerebras Responses paths map the payload status the same way through
`deepSeekTerminalTypeForPayload`. The native Responses paths - Surplus, OpenLux and OpenRouter `/v1/responses` and the
Codex subscription - pass an upstream-authored `response.incomplete` through as the terminal. OpenRouter's route,
`handleOpenRouterResponses` in `src/provider/openrouter-handlers.ts`, is reached directly and as the third hop of the
DeepSeek waterfall. It streams through `proxyResponsesStream` (`src/provider/openrouter-streams.ts`), which forwards
every upstream event, the terminal included, and its buffered path returns the upstream payload unchanged, including a
`status: "incomplete"`.

A per-provider allow/deny filter would still be solving a leak that does not exist: every construction is a deliberate
per-route mapping, and every relay forwards a terminal that a translator or the upstream already chose. A provider that
should use the mapping still needs its own deliberate wiring.

| Provider | Reachable | Truncation behaviour                                                                         |
| -------- | --------- | -------------------------------------------------------------------------------------------- |
| DeepSeek | yes       | `length` maps to `response.incomplete` with `incomplete_details.reason: "max_output_tokens"` |
| Cerebras | yes       | Reasoning-only truncation fails closed as `cerebras_upstream_invalid_response` (502)         |
| Surplus  | no        | HTTP 402 `insufficient_credit`: "Insufficient balance to fund this request from prepaid"     |
| OpenLux  | no        | `local:insufficient_quota`: "user quota is not enough"                                       |

**The Cerebras path was reproduced, not inferred.** A direct probe with `max_completion_tokens: 16` returned
`finish_reason: "length"` with the `content` key absent entirely and only `reasoning` populated (53 characters), on two
consecutive runs. That trips `choiceHasNoPayload` (`src/provider/cerebras.ts:376`, applied at `:403`), which rejects a
choice carrying neither content, nor a tool call, nor a refusal. Through the gateway the same request returns HTTP 502
`cerebras_upstream_invalid_response`, recorded in the error ledger as
`chat.completions 502 cerebras_upstream_invalid_response model=gpt-oss-120b`. Note that reasoning alone is deliberately
not sufficient payload: it is preserved for clients as `message.reasoning`, but it is not content.

Reason: this is the contrast the whole program turns on. Cerebras already refused to call a reasoning-only truncation a
success while the DeepSeek route reported the equivalent outcome as a clean completion. Recording the reproduced
mechanism keeps that contrast as evidence instead of as an argument.

Reversal risk: treating reasoning as payload, or reporting a reasoning-only truncation as a completed generation, would
restore the silent truncation on both routes.

**Residual gap, stated rather than closed.** Surplus and OpenLux are blocked on external account state, so their
truncation behaviour is unverified, and the untested surface is not empty. Each provider has two paths, and both can
deliver the incompletion:

- **Native Claude paths construct it.** Surplus maps Claude Chat `length` and `content_filter` through
  `createClaudeResponsesWriter`, and OpenLux maps Anthropic `max_tokens` through `src/provider/anthropic-responses.ts`.
  Whether either upstream reports those stop reasons when it truncates is unmeasured, so neither mapping has been
  exercised against a real truncation.
- **Native Responses paths relay it.** Both pass the upstream's own `/v1/responses` terminal type through, so whether a
  client sees `response.incomplete` on truncation depends on what that upstream sends, which is also unmeasured.

OpenRouter is reachable, but its truncation behaviour is unmeasured too: its `/v1/responses` route relays the upstream's
own terminal, and no probe has recorded what OpenRouter sends when a generation is cut off.

Probe both paths on both blocked providers, and OpenRouter's `/v1/responses`, before trusting any of them, and recheck
the blockers before treating them as permanent.

**Recheck 2026-09-22, both blockers still hold.** Surplus answers a probe on a Surplus-routed id with HTTP 402
`Insufficient USDC balance: need ~$1.0000, have $0.9895` (request id `01M33CFBC7AHTBXM365KNCM28D`), and the terminal
ledger records `provider: "surplus"`, `status: 402`, `failure_kind: "read_error"`. OpenLux is still not reached at all:
`gpt-5.6-luna` and `gpt-6-astra` both answer `provider: "chatgpt_codex"` with `fallback_reason: null`, because the Codex
subscription tier serves them first, so the paid tier is never exercised through those ids. The gap therefore remains
open in the same shape, and no truncation evidence was obtained for either provider. Note also that `deepseek-v4-pro` is
served by `provider: "deepseek"`, not Surplus, despite the id appearing in the paid catalogue - so probing that id does
not test Surplus truncation.

## Buffered-terminal fix deployed to both surfaces - 2026-09-22

The buffered DeepSeek Responses fix from PR #387 is live on both surfaces at `3661bcfd13a9c1b9056fe5dc1786bb49b18ad594`,
deployed through `deno task deploy:vps` and `deno task deploy:mac` off CI-green `development`.

| Deployment                                                 | Release      | Identity                                       |
| ---------------------------------------------------------- | ------------ | ---------------------------------------------- |
| VPS (production, and the public `https://ai.ubq.fi` route) | `3661bcfd13` | `vps-3661bcfd13a9c1b9056fe5dc1786bb49b18ad594` |
| Mac local (`localhost:7999`)                               | `3661bcfd13` | `mac-3661bcfd13a9c1b9056fe5dc1786bb49b18ad594` |

Acceptance ran against the deployed releases, not the branch, and covered every DeepSeek wire shape plus the
subscription path:

- buffered `/v1/responses` truncation still reports `response.incomplete` with
  `incomplete_details.reason: "max_output_tokens"` and `output_tokens: 8192` on both hosts;
- three normal buffered completions per host still report `status: "completed"` with `incomplete_details: null`, so the
  new guard does not over-fire;
- the streamed `/v1/responses` path still reaches `response.completed` on both hosts;
- `/v1/chat/completions` (the DeepSeek Harness wire) still answers `finish_reason: "stop"` with content on both hosts;
- `gpt-reserve` still serves on both hosts through the Codex subscription capacity path.

The error ledgers after deployment show no `empty_upstream_completion` fires on either host - the guard has not fired in
production in either direction. The only rows on the new revision are this acceptance run's own truncation
(`max_output_tokens`) and two deliberate 400s from a malformed probe.

`sh scripts/verify.sh` reported `verify: OK` on the merged revision before deployment. Root checkout is clean on
`development`, matching `origin/development`, with the task branches removed.

## Client behaviour on a degenerate completion, and the terminal-truthfulness 502 surface - 2026-09-22

Two questions were left open when the terminal-truthfulness program was recorded: which clients actually fail closed on
the terminals the gateway now emits, and exactly where the program added 5xx responses. Both are answered here from
direct measurement on the merged revision, not from reading the code alone.

**Codex was already measured** (the 2026-09-21 A/B above): `response.incomplete` fails the turn with exit 1 and the
reason string verbatim. **DeepSeek Harness is now measured too**, because the operator uses both and the harness reaches
the gateway over a different wire.

The harness path is `@deepseek-ai/dsh-llm-pi-ai` -> `@earendil-works/pi-ai` `openai-completions`, and the operator's
`ubiquity` provider in `~/.dsh/settings.yaml` is configured with `api: openai-completions` against
`https://ai.ubq.fi/v1/`. Driving that real adapter stack against a scripted upstream (not a reimplementation of it)
gives:

| Wire result the gateway emits                        | Harness outcome                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `finish_reason: "stop"` with reasoning and no answer | `stop` with a `thinking`-only message; **no error, no empty-content guard fires** |
| `finish_reason: "stop"` with `content: ""`           | `stop` with an empty message; **no error**                                        |
| `finish_reason: "length"`                            | `{ kind: "max-tokens" }`, a first-class turn-end reason with its own UI notice    |

So the harness is **not** a backstop for the gateway's completion-validity rule: it maps the wire faithfully and accepts
a degenerate `stop` as a success. Codex is the stricter client of the two. G3 is gateway-owned where a route implements
it, but this does **not** mean that G3 protects DeepSeek Chat Completions.

The DeepSeek Chat Completions route deliberately carries no gateway completion-validity guard. On the streamed route,
`relayChatCompletionStream`'s `finishStream` records completion usage, settles `response.completed`, records success
health, and emits `[DONE]` without testing `chatCompletionHasAnswerBearingOutput`; on the buffered route,
`handleDeepSeekChatCompletions` uses that predicate only to mark telemetry before returning HTTP 200. A reasoning-only
or empty-content `stop` is therefore reported as success to the harness. If a guard is added later, the route-local
terminal seams are `finishStream` for streaming and the buffered handler immediately before its successful 200 response,
not the harness.

**The truncated-generation path itself is unchanged for the harness.** `length` maps to `max-tokens` on both the pi-ai
adapter and the vendored `dsh-llm-deepseek` adapter, so a truncation the gateway reports stays reported. The gap is
narrow and one-directional: _degenerate completions_ (`stop` with nothing usable) are invisible to the harness.

**A wire boundary worth knowing before repointing any harness route at this gateway.** Capture of the pi-ai
`openai-completions` request shows the operator's `ubiquity` route sends `model`, `messages`, `stream`, `stream_options`
and `store` - and no `thinking` and no `reasoning_effort`, because the configured model entries declare no reasoning
capability. That traffic is accepted. The vendored `dsh-llm-deepseek` adapter sends `thinking: { "type": "enabled" }`
for any non-`off` effort. **Correction 2026-09-22: that field is no longer rejected.** PR #391 (base revision
`a4d0b470`) accepts the vendor's own `thinking` field on the DeepSeek route and projects it to `reasoning_effort`; it
remains outside the official OpenAI schema everywhere else, so the earlier HTTP 400
`Unrecognized request argument supplied: thinking` no longer describes this route's behaviour. That compatibility change
did not fix the Codex premature turn endings recorded at the top of this file, which remain a separate mechanism.

**The program added no new 5xx responses.** Counting every `openaiError(<n>, ...)` and `streamErrorResponse(<n>, ...)`
call in `src/openai.ts` between the pre-program revision `922c33392d` and the merged terminal-truthfulness revision: 31
five-hundred-and-two calls before, 32 after. The one addition was made on 2026-09-22 by the follow-up below, not by the
program. The only status code the original program itself added anywhere in `src/` was a single `openaiError(400, ...)`
for the DeepSeek thinking-mode `tool_choice` conflict.

Before that follow-up, the three `empty_upstream_completion` 502s were unchanged from their pre-program locations, and
all three were on routes that already had them:

| Site                  | Function                    | Reachable from                                     |
| --------------------- | --------------------------- | -------------------------------------------------- |
| `src/openai.ts:1132`  | `safeFailedAttemptResponse` | Codex Responses attempts (pre-commit)              |
| `src/openai.ts:7901`  | `completeChatCompletions`   | the ordinary Chat Completions path                 |
| `src/openai.ts:10683` | `rejectEmptyChatCompletion` | the shared Chat preflight, not the DeepSeek branch |

The DeepSeek routes bypass `rejectEmptyChatCompletion` by dispatch order: both DeepSeek handlers return before the
shared preflight runs. The Responses route therefore implements G3 in its own streamed and buffered terminal seams;
DeepSeek Chat Completions deliberately does not implement a completion-validity guard and cannot inherit one from that
shared preflight.

### The buffered DeepSeek Responses branch was missing G3

Found while answering the two questions above, fixed by PR #387 (`d7472165`), and worth recording because it is the one
place the program was not applied consistently.

The streamed DeepSeek Responses path fails a degenerate completion closed. The **buffered branch of the same route did
not**: a `stop` carrying only reasoning, or only empty content, returned HTTP 200 `status: "completed"` with
`error: null`. The same logical outcome was a failure on one transport and a success on the other.

Reproduced against the real handler with a mocked upstream, before the fix:

    RESPONSES streamed  -> HTTP 200 | terminal: event: response.failed
    RESPONSES buffered  -> HTTP 200 | status: completed | error: null

After the fix the buffered branch returns the ordinary gateway 502 with the existing `empty_upstream_completion` code
and message. Order is preserved: the provider's own reason is read first, so a `length` truncation still returns
`response.incomplete` with `incomplete_details.reason: "max_output_tokens"` and is never converted into the
empty-completion failure. Only a would-be completion is measured for answer-bearing output, through the same one shared
predicate the streamed path and the Chat route consume.

Two facts about why it survived: no test exercised the non-streaming DeepSeek `/v1/responses` path, and the branch is
reachable in production - 10 non-streaming `/v1/responses` requests were served on the deployed revision `2207a757fb`.
The lesson generalises: "the route is covered" is not the same claim as "every branch of the route is covered", and a
single-transport test does not establish a single-route behaviour.

Reversal risk: removing the buffered guard restores the transport-dependent success/failure split; converting an
explicit truncation into the empty-completion failure would break the precedence G1 requires. Both are covered by the
five-step regression test beside the existing streamed G3 test.

## DeepSeek adapter deliberately diverges from the vendor client - 2026-09-21

Four DeepSeek interpretations were compared against the provider's own first-party client
(`@deepseek-ai/dsh-llm-deepseek` 0.1.1-rc.2, `lib/index.js` SHA-256
`eed9492246cc6451f060de211768d3128388046478deae7f1959de7cde56ea82`) and are deliberately kept as they are. Do not "fix"
this gateway toward the vendor client on these four points; each difference serves a different contract.

- **Reasoning replay scope (Delta 4).** The vendor replays `reasoning_content` on every reasoned assistant turn. This
  gateway fills an empty string only on the tail after the last `user` message. Probed 2026-09-21 across four history
  shapes: the provider accepts a later `user` turn resetting the boundary, so the narrower rule satisfies the same
  requirement with the smallest mutation. Widening the fill would change token accounting and cache behavior on every
  request. A related research claim that replay is required "from all prior turns" is contradicted by those probes and
  must not be used to widen the fill.
- **Disabling thinking (Delta 5).** The vendor sends `thinking: { type: "disabled" }`; this gateway sends
  `reasoning_effort: "none"`, which the provider documents as the same thing ("`none` disables thinking mode"). Probed
  equivalent on the response path. The vendor's form is not part of the OpenAI Chat Completions schema, and this route
  exists to be OpenAI-compatible, so the documented OpenAI-shaped field stays. Re-probe if the provider changes the
  toggle.
- **Usage accounting (Delta 6).** The vendor subtracts cache reads because its internal convention is disjoint counts.
  This gateway relays `prompt_cache_hit_tokens` as the official `prompt_tokens_details.cached_tokens`, which the OpenAI
  contract defines as a subset detail of `prompt_tokens`. Subtracting here would corrupt the field's meaning for every
  OpenAI-compatible reader. This is the same rule as "Cache-read telemetry is reported, never defaulted" (2026-09-19).
- **Translation seam exists by design (Delta 9).** DeepSeek now serves a native Responses endpoint (`POST /responses`
  and `POST /v1/responses`, both HTTP 200 with a native envelope, probed 2026-09-21), so the translation layer is no
  longer required by a provider gap. It stays because the native endpoint is documented as stateless with several
  control parameters ignored and because this adapter's measured `reasoning_content` fill for tool-bearing tails is a
  provider requirement a native response would have to reproduce. A migration is a separate evidence-driven evaluation,
  not an assumed cure.

Reversal risk: reverting any of these four toward the vendor client reintroduces a contract mismatch (wider cache
accounting, a non-OpenAI parameter on an OpenAI-compatible route, changed token/cache behavior on every request), or
re-justifies the translator with a premise that is no longer true.

## DeepSeek thinking mode rejects two tool_choice values - 2026-09-21

DeepSeek answers HTTP 400 `Thinking mode does not support this tool_choice` for `tool_choice: "required"` and for the
named-function form whenever thinking mode is active. Probed 2026-09-21 on `POST /chat/completions` at `low`, `high`,
and the omitted default, on the provider's native Responses endpoint, and in the accepting direction with
`reasoning_effort: "none"` and `thinking: { type: "disabled" }`; `none` and `auto` are accepted in every mode. The
official Chat Completions reference documents the restriction ("`required` and named tool choices are not supported in
thinking mode; the API returns a 400 error").

The gateway therefore rejects the incompatible combination at its own boundary on both DeepSeek request seams, with one
shared predicate and an error naming both conflicting fields, instead of forwarding the request and relaying the
provider's message about a parameter the gateway's own contract advertises.

Reason: a client cannot know from this gateway's advertised capabilities that a supported `tool_choice` combined with a
supported reasoning tier is invalid. The boundary is the only place that sees both.

Reversal risk: removing the guard restores a live client-visible 400 whose message blames the caller for a combination
the gateway accepted, and re-opens the gap on both seams.

## Reserve Codex model id with its own quota class - 2026-09-20

`gpt-reserve` is luna served under a second Codex model id the owner authorized on 2026-09-20 as a distinct model with
its own quota limit, so it is not a gateway-only alias: the requested id is passed upstream verbatim and is never
renamed to `gpt-5.6-luna`. It owns the `reserve` quota class in `src/codex/account-routing.ts`, so exhausting the
reserve class must not block the standard class on the same account, and standard-class exhaustion must not block
reserve. The gateway accepts the id as a known Codex model while the upstream discovery catalog still omits it, without
inventing a catalog entry.

Reason: the upstream serves the id today but its discovery catalog may lag, and whether the upstream meters reserve
separately is unproven. Keeping the id verbatim and giving it its own durable bucket leaves the distinction observable
instead of folding a possibly separate limit into the standard class.

Reversal risk: renaming the id upstream, folding `reserve` back into `standard`, or widening the trusted accepted-id
list beyond the owner-authorized id each removes the distinction this authorization depends on.

## Cache-read telemetry is reported, never defaulted - 2026-09-19

Relay the upstream cache-read counter when the provider publishes one; report an absent counter as unknown
(`usage_telemetry_status: "partial"`), never as a measured zero. DeepSeek publishes `usage.prompt_cache_hit_tokens`,
which this gateway relays as the official `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`
field so one reader serves either spelling.

Reason: every DeepSeek response previously hard-coded a cache read of zero, so the gateway and the Codex client both
reported a 0% cache hit rate for a caching feature that was working. That default erased the measurement the user asked
for and made a healthy upstream look unoptimized; a missing measurement and a measured zero are different facts and must
not share one value. A reported count larger than the request's own input is impossible, so it is dropped as unknown
rather than published.

Provider cache _control_ stays unsupported for DeepSeek, and that is separate from telemetry: DeepSeek's context cache
is automatic, prefix-based, and always on, with no client-facing request to enable, disable, pin, or expire it, so the
gateway still refuses `prompt_cache_options` and explicit breakpoints instead of forwarding parameters the upstream
cannot honor. Absent cache control is not absent caching.

Reversal risk: defaulting an unreported cache read to zero, publishing `prompt_tokens_details` when the upstream
reported no counter, or gating the metric on the model's `prompt_cache` catalog field, each reintroduces a number the
gateway cannot stand behind.

## Serial subscription routing - 2026-09-14

Summary only: `docs/provider-decision-journal.md` owns this provider-routing decision (entry dated 2026-09-14, "Serial
subscription routing"). Exhaust one Codex subscription before advancing the provider chain; never spread ordinary
requests across subscriptions while the active one still has capacity.

## Serial-depletion VPS acceptance - 2026-09-15

For this named goal, the user excluded the offline Mac and confirmed VPS deployment. Use authenticated VPS-origin
inference, superseding this delivery's Mac-only handoff requirement. Preserve exact release checks, bounded inference
budget, and reset-credit safeguards.

## Lint migration - 2026-09-12

Use Prettier width 160 and cover all tracked source, tests, scripts, benchmarks, ops, and serve.ts. Fix the full finding
set, including behavior-preserving test fixes, rather than adding a suppression baseline. Leave CI unchanged for now.
Preserve the existing chore/lint-stack worktree.

Decision evidence: DSH session-8d0f4b3a-9ab5-43e1-96e6-fd092c509c26, recovered during the 2026-09-13 Codex takeover.

## Deno inventory cleanup - 2026-09-14

For the recorded cleanup, delete unused p-ai-ubq-fi and ai-ubq-fi-feat-shared-admin-toke. Retain ai-ubq-fi and
ubiquity-prospector; the Prospector monorepo's own `DECISIONS.md` owns the latter's retention and migration decisions.

## Local-development key deletion ownership - 2026-10-03

For the local-development API key only, the retained paid-deletion guard keeps created_at_ms and adds local_deletion
with an exclusive owner and completed_at_ms. Admin deletion CAS-claims ownership while the revoked ID exists, checks
that claim before deleting the ID, and publishes completion only after all awaited paid-state, request-log, counter and
V3 usage cleanup finishes, using the same owner version and an absent-ID CAS. A known settled pre-ID refusal or failure
may release only its own claim for explicit admin retry; legacy and crashed active guards remain blocked without owner
stealing. Startup reprovision requires a completed local marker, no outstanding billing, pending markers, lease or
remaining cleanup rows, and atomically checks the absent ID, token hash and unchanged guard while publishing the
replacement and clearing only that local guard. Empty prefixes and an absent ID alone never prove completion; every
nonlocal guard keeps its existing meaning.

## Client catalog ETags - 2026-10-03

Client catalog ETags are hashes of the final bytes served to that client, in both the fast path and the assembled path.
Raw upstream ETags remain source metadata used only for upstream conditional fetches. Enrichment that changes the served
body changes its client validator even when upstream metadata is unchanged; only a validator for the current served body
permits a client 304 response.

## Supported VPS activation recovery - 2026-10-03

For supported VPS releases, same-SHA retry uses a private atomic deployment-owned recovery receipt under the existing
deploy lock, binding the candidate and previous full SHA, source archive and complete immutable tree digests, exact
selectors, verified fixed listener port and known launcher/unit profile. Before ingress changes, a failed candidate
restores the supported previous selector and actual listener/public identity; daemon-reload refusal restores only the
selector and issues no gateway restart. After successful ingress reload, a public verification failure retains the ready
candidate and ingress-applied intent for nondestructive same-SHA verification retry. Candidate bytes remain immutable,
and pruning occurs only after exact loopback and public identity acceptance. Unsupported or historical root-relative
launchers are refused before destructive activation. The normal deployment command must permit the verified prior
loopback port, and verify/CI must provide the scoped shell and loopback capabilities required by every actual launcher
fixture.

2026-10-16: A first deployment has no previous release, selector or listener to restore. If it fails before the gateway
restart, recovery removes the selector it created and records `rolled_back`, and the same SHA starts again. After a
restart attempt the unit can run only the candidate, so recovery leaves that candidate selected and unaccepted rather than
removing a selector that cannot stop it. The next same-SHA run resumes at ingress when the candidate serves its exact
loopback identity, and otherwise restarts only that verified selected candidate. Any other selector or phase state stays
refused. Historical restoration is no longer an open scope: historical root-relative launchers stay refused before
activation, and a Bun startup still refuses automatic rollback to a Deno release under the Bun runtime rules in
`AGENTS.md`.

## Jev compaction upstream - 2026-10-05

Compaction asks Jev through the gateway's normal Jev route: the OpenRouter System One endpoint with the shared
`OPENROUTER_API_KEY` and default model that `/v1/systemone` serves with. The standalone `TYPESAFE_API_KEY` path is
removed; a missing OpenRouter credential is the only missing-key failure. Selection, batching, the 30-second Jev bound,
and fail-closed behavior are unchanged. The adapter's rendered-memory bound is 1.5M characters, raised from the ported
400k because text and pinned segments are never dropped or truncated and a text-heavy session can legitimately exceed
the ported value; fitting first drops additional unpinned kept results, lowest Jev `keepResult` first, taking the
minimal fitting prefix across re-renders, cap-forced drops count toward the reduction contract, and the request still
fails closed above the raised bound. `JEV_COMPACTION_DISABLED=1` bypasses interception entirely for an operator fallback
to the ordinary provider route; it stays unset by default.

## Jev compaction dynamic floor acceptance - 2026-10-05

A floor-bound render - nothing left that may be dropped or truncated, so text, pinned and already dropped content alone
exceed the 1.5M-character fit target - is no longer an automatic failure. It is accepted when its token estimate (the
library's calibrated estimator) is at most 85% of the token estimate of the request input it replaces. The bound is a
ratio, so it scales with any session size and leaves the client headroom for the continuation after the adopted summary.
Accepted floors are logged with `floor_bound=true`, `floor_tokens` and `input_estimate_tokens`, and the response header
carries `floor=1`. Every other summary-too-large path is unchanged: a floor that cannot be measured or is not
sufficiently smaller than its input still fails closed with 400. The no-reduction contract still rejects a summary that
did not shrink at all.

Reason: a production VPS session with a ~1M-token context produced a 1.63M-character floor that nothing could shrink, so
every compaction attempt failed closed and the session could not continue (the client retried in a loop). The fixed 1.5M
cap was chosen for bounded memory, not as a client-window limit; a floor that is token-measurably smaller than the input
it replaces is adoptable and is strictly better than a session that can never compact. Reversal risk: a session whose
text alone is very large can now adopt a multi-megabyte memory; the input-relative ratio keeps it below the window
implied by the input, and summaries that did not shrink are still refused.

## Jev compaction bounded degradation - 2026-10-05

A dropped tool interaction is no longer erased. `renderSummary` (lib/jev_compaction/codex_items.ts) now emits every call
as a provenance line - a kept call renders its input verbatim, a dropped call renders a bounded input head - and every
result as either verbatim (keep), a bounded head (`drop_result`), or a bounded head labelled `truncated (call dropped)`
(`drop_call`); the existing rule already keeps whole any result shorter than the truncation floor. The adapter
(src/jev_compaction/compaction.ts) measures its reduction contract and reports `chars_after` in the log line and
`x-jev-compaction` header on the rendered text, not on the decision projection, because the projection still models
erasure; the embedded `[fast-jev-compaction stats]` line keeps the decision projection.

Measured 2026-10-05 by the eval harness (`evals/jev-compaction`, offline mode with the real Jev asker on the two saved
fixtures): the tool-output-only fact the deployed renderer lost (f3 receipt UUID) survives, needles are 15/15 and 14/14,
continuation is unchanged (4/4 and 3/4, the same probe-wording miss as the deployed run), and rendered size grows by 38k
chars (f1 111,732 -> 150,085) and 53k chars (f3 ~175k -> 227,920) because each dropped stub carries a bounded head.
Supersession ambiguity is untouched by this change and needs the planned residue pass. Focused tests were updated
deliberately (the old assertions pinned erasure) and pass 11/11.

Reason: the previous policy deleted the call and its result together on `drop_call`, erasing the evidence layer (57% of
f1's input bytes) and making tool-only facts unrecoverable by construction. Bounded degradation keeps provenance and
identifiers at an explicit, bounded size cost without changing Jev's decisions, the fail-closed paths, or kept-content
verbatimness. Reversal risk: sessions whose dropped material dominates now retain heads and fail closed on the 1.5M-char
cap more readily; fitting still drops the lowest-relevance kept results first, and the cap failure path is unchanged.

## Jev compaction hybrid residue pass - 2026-10-06

The hybrid residue pass adds one best-effort Cerebras gpt-oss-120b call after the verbatim Jev selection: the model
compresses the memory (dedupe, supersession, prose reduction) and deterministic guards append a harvested identifier
ledger (latest occurrences first, capped) and a verbatim tail of the latest memory, so identifier retention never
depends on the model. The pass runs through the gateway's own Cerebras transport with a bounded deadline; any missing
credential, transport failure, timeout, empty or non-shrinking output keeps the pure Jev summary unchanged. The pass
runs by default with no configuration (`JEV_COMPACTION_HYBRID=0` is the operator kill switch, and an injected asker seam
bypasses it for tests and diagnostics), and the accepted answer is marked `hybrid=1` in the `x-jev-compaction` header
with `hybrid`/`hybrid_ms` in the completion log line, so a hybrid memory is always distinguishable from a verbatim one.
No client usage, model or cost counter is invented: the residue call uses the provider credential, like the Jev calls,
and the route still fails closed on every pre-existing path.

Reason: measured on the eval harness, the hybrid scored 100% needle retention on both fixtures with 4/4 continuation and
no stale-endorsement, materially better than the pure selection renderer, while staying inside the 10-second compaction
budget. Reversal risk: the summary is now partly generated prose, so a degraded residue call could in principle add text
the model invented; the guards copy every identifier mechanically, the output must be strictly smaller than the pure
render, and setting `JEV_COMPACTION_HYBRID=0` restores the verbatim-only contract exactly.

## Gateway provider identity is selectable - 2026-10-06

`ubiquity` is now a selectable provider id on the admin provider picker, on equal footing with the upstream routes: the
checkbox stages, saves, reloads, and participates in check-all, invert, and the active-only filter like any other row,
and the roster row reports its catalog count and credential readiness instead of a selection-derived status. Checking it
allows the synthetic `ubiquity/deepseek-v4.1-flash` route, whose hop plan stays the model's fixed definition (every
configured hop in the measured order); an active selection without `ubiquity` switches the whole route off, so the model
leaves `/v1/models`, the public catalog, and the Codex catalog, and a direct request answers 503
`deepseek_waterfall_unavailable` without dispatching. An absent or empty selection still keeps every provider, this
route included, enabled.

Reason: the operator asked for the gateway identity to behave like every other provider instead of a display-only row,
and unchecking it must mean it is off. Reversal risk: a non-empty stored selection written before this change does not
list `ubiquity`, so the route stays hidden until the operator checks the new row; the empty default selection is
unaffected.

## DeepSeek waterfall economy order and the OpenLux hop - 2026-10-07

The `ubiquity/deepseek-v4.1-flash` synthetic waterfall now runs the cost-first economy order
`["lithos","deepseek","openrouter","surplus","openlux"]`. The operator chose the economy ordering priorities cost 50 /
reliability 30 / speed 20 (the prior ranking was cost 50 / speed 30 / reliability 20) and the listed per-token costs.
LithosAI Base and the DeepSeek off-peak rate are $0.15/$0.60 per 1M input/output at list price, half of OpenRouter's
$0.30/$1.20 for the same weights, so the cheaper direct routes lead and OpenRouter drops to third; Surplus and OpenLux
remain the two paid hops. The OpenLux hop is now wired to its `/v1/responses` endpoint through the existing
`fetchMeteredResponses` transport as the final fallback, instead of being excluded because the earlier chat-wire
benchmark record could not serve Responses. The paid routing layer already accepted `options.allowedPaidProviders` but
no production caller supplied it, so the Surplus hop could silently advance to metered; the waterfall now threads an
explicit per-hop pin through `runOrdinaryResponsesTail` to `fetchResponsesWithPaidFallback` (`surplus` -> `["surplus"]`,
`openlux` -> `["metered"]`, which is the routing layer's name for OpenLux), keeping the default `[surplus, metered]`
order for every other caller.

Reason: the operator asked for a cost-first order under the benchmark's stated priorities and for OpenLux to serve as
the last resort rather than be skipped by a chat-only wire record, and the pin closes a live correctness gap the recon
found. Reversal risk: the paid hops depend on their own tier credentials and catalog records, so a model missing from
one paid catalog now fails that hop closed instead of advancing to the sibling tier within the same hop; the next hop in
the waterfall still runs, and the pin only narrows one request's paid selection.

## Owner-only Claude Code subscription tier - 2026-10-11

`claude_code` is a new selectable provider, second in roster order after `codex` and first for Claude models on the
request path. It speaks the native Anthropic Messages wire (`https://api.anthropic.com/v1/messages`) with the
subscriber's own credential through `Authorization: Bearer` plus `anthropic-version: 2023-06-01` and
`anthropic-beta: oauth-2025-04-20`, and no synthesized client fingerprint. Every gate is conjunctive and deliberate: the
operator selection must keep the provider on, `CLAUDE_CODE_OAUTH_TOKEN` must hold a credential (v1: the documented
one-year `claude setup-token` token), the request principal's key id must be in `CLAUDE_CODE_ALLOWED_KEY_IDS` (no
wildcard, empty allowlist means nobody), and no authoritative quota window may still block. Any missing gate leaves the
request on the unchanged paid path, and a dormant tier costs no storage read. Durable exhaustion is recorded only from
the documented `anthropic-ratelimit-unified-*` evidence on a rejection, blocked until the upstream reset plus a margin;
a generic 429 becomes only a short local cooldown, and 401/403 never permanently label the account. The tier is off by
default: no credential and no allowlist exist in the deployment until the owner adds them.

Reason: the operator asked to add Claude Code subscription support to the gateway; the 2026-10-11 research (docs/
research/claude-code-subscription-2026-10-11.md) rates a hosted gateway serving other users on the owner's Pro/Max
credentials RED and an owner-gated proxy AMBER, so the implemented scope is strictly owner-only, fails over to the paid
waterfall on every failure, and never reuses the Codex plumbing to serve team traffic. Reversal risk: the AMBER verdict
means Anthropic has not clearly authorized this exact bridge; the owner must accept that residual account risk in
writing before live activation, and a stored provider selection written after this change must include `claude_code` to
keep the tier servable, exactly like every other provider.

## Linux gateways delegate a shared CLI credential lineage to the local native daemon - 2026-10-13

The gateway's native-owner binding now runs on Linux with the same single canonical home as macOS (`CODEX_HOME` or
`~/.codex`). A managed-auth daemon whose active provider does not require OpenAI auth (a gateway-routed custom provider
reports `requiresOpenaiAuth: false`) returns no account from `account/read` even though it refreshes the home's ChatGPT
credentials; that exact blank reply is accepted only when it is the daemon's own shape and the home's credential file
holds the account id the pool entry was bound to. Every other reply keeps requiring a matching ChatGPT identity, and the
caller still refuses any rotation that fails to advance the persisted generation. The admin upstream health block also
reports each slot's refresh-token SHA-256 and bound native-owner home so a local watchdog can detect an unbound pool
slot that shares a refresh lineage with a credential file without seeing token material, while treating equality on a
slot bound to that same home as the expected delegation state.

Reason: the 2026-10-13 VPS auth recovery proved a gateway KV slot and the native CLI store rotated one personal lineage
until the first consumer invalidated the second (`refresh_token_reused`); the VPS daemon cannot name its ChatGPT account
while it routes inference through the gateway, which blocked the previous Darwin-only binding handshake. Reversal risk:
a blank-account reply from a daemon holding the wrong file account stays refused, but a same-account file swap between
bind and refresh is caught only by the generation checks; the fallback trusts the local home configured on that host,
never a remote path.

## Claude subscription parity: API-key credential, workspace selection, and admin surfaces - 2026-10-15

The `claude_code` tier now accepts the Console-billed `CLAUDE_API_KEY` direction alongside the owner-gated OAuth setup
token, and it carries the operational surface the Codex subscription always had. Credential resolution is KV first and
environment second (`CLAUDE_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`), so the admin console can rotate a credential
without a restart; `api_key` credentials travel as `x-api-key` and OAuth tokens keep `Authorization: Bearer` plus
`anthropic-beta: oauth-2025-04-20`. An organization-scoped key that rejects the first request with the documented "not
scoped to a workspace" error triggers one workspace discovery through `/v1/organizations/workspaces` (preferring a
workspace named `Default`), cached in KV and overridable by `CLAUDE_CODE_WORKSPACE_ID` or an admin pin; the retry reuses
the request's single pre-transport dispatch reservation instead of claiming a second one, because the API-key usage
ledger records exactly one pre-transport dispatch per request. Billing and workspace rejections are classified from the
upstream error body into `billing_blocked` / `workspace_not_found` / `workspace_required`, stored with a bounded
ten-minute configuration cooldown and their sanitized message, and they never become durable quota exhaustion; a served
request clears the recorded configuration error. `GET`/`POST`/`DELETE /admin/providers/claude-code/auth` reads, stores
(validated against the Anthropic models listing), and clears the credential plus an optional workspace pin;
`POST /admin/providers/claude-code/quota/clear` drops the guards; `/admin/providers`, `/health/upstream`, and the admin
panel's Claude subscription card report credential provenance, the workspace selection, the routing gates, unified and
standard rate-limit windows, the last upstream outcome, and health. `normalizeApiKeyUsageRequestV3` now derives its
provider allowlist from `API_KEY_USAGE_PROVIDERS`, because a `claude_code` dispatch row previously failed normalization
and surfaced as `api_key_quota_reservation_unavailable` for the paid hop that followed it.

Reason: the operator asked for Claude subscription feature parity with the Codex subscription, including admin switches,
panels, and analytics, and named `CLAUDE_API_KEY` as the credential to use. The Console API-key direction is the
research's documented authentication path (GREEN) where the raw OAuth bridge is only AMBER, so the owner-gated allowlist
stays in force while the credential itself becomes operator-managed and independently rotatable. Reversal risk: a
workspace pin or discovery result is advisory state that names the workspace sent as `anthropic-workspace-id`; a wrong
pin fails closed with the recorded `workspace_not_found` state until it is corrected, and the tier still falls through
to the paid routes on every rejection. The environment's own account state (no API credits in the Console organization,
an admin-only `Claude Code` workspace) is an account condition, not a gateway defect: the tier records the exact
upstream rejection instead of retrying it per request.

## Claude subscription joins the provider capacity analytics - 2026-10-15

`GET /admin/providers/capacity` now carries a live `claude` block next to the Codex/metered `sources`, and the admin
Analytics capacity list renders it as a third row beside the two Codex subscription rows: state badge, the observed
5-hour and weekly subscription windows as remaining capacity (the upstream fraction is normalized to a percentage), and
diagnostics for credential direction, workspace, guards, standard API-key limits, and the last upstream error. The block
is computed on the admin read from the tier's own credential, workspace, guard, and quota state; it is deliberately not
written into the stored capacity snapshot, because that record is sampled on inference events and its command budget is
pinned by test. Older three-source stored records therefore stay valid and the sampler cost is unchanged.

Reason: the operator asked for Codex-grade analytics parity for the Claude subscription, and the Codex subscriptions are
read from the capacity pipeline. Reversal risk: the analytics row reflects the tier's recorded guard state, so a billing
or workspace rejection shows as `unavailable` with its exact upstream status and message until the operator fixes the
account and clears the guard; the row never blocks inference itself.

## Native KV build scratch remains outside immutable releases - 2026-10-15

Native KV preparation retains its disk-backed source, Cargo home, compiler target, and logs below the operating-system temporary root rather than below the builder module checkout. The independently supplied artifact and provenance binding remains mandatory for immutable release preparation and isolated release fixtures.

Reason: a builder imported from a staged release must not add retained scratch to the published source tree or change its recorded digest. The scratch remains disk-backed; application startup still never compiles, downloads, or installs.

## Claude Code subscription requests carry the native attribution on the OAuth lane - 2026-10-15

When the `claude_code` credential is an OAuth setup token (`sk-ant-oat...`), `buildClaudeCodeRequest` prepends the native
client attribution (`You are Claude Code, Anthropic's official CLI for Claude.`) as the first system block; Console API
keys (`sk-ant-usr...` / `sk-ant-api...`) never send it. A 12-variant probe matrix against `https://api.anthropic.com` on
2026-10-15 established the requirement: without the attribution every `/v1/messages` request answers an opaque
`429 rate_limit_error` (`message: "Error"`), while the same request with it answers 200 and carries the
`anthropic-ratelimit-unified-*` subscription windows; `metadata.user_id` and `anthropic-workspace-id` are not required.

Reason: the operator activated the Claude Max subscription through the documented `claude setup-token` flow and asked
that it serve the gateway through the existing owner-gated `claude_code` tier. The endpoint strips the attribution block
before generation, so it changes no request semantics; it is sent only on the credential kind the official client owns,
and no other fingerprint (device id, session id, user agent, or additional headers) is synthesized. Reversal risk: none
beyond the tier's existing fall-through - an attribution-less OAuth request fails closed into the paid waterfall, and the
attribution can be removed at its single call site if the upstream requirement changes.

## Claude uses the shared catalog and existing provider controls - 2026-10-15

Claude model discovery belongs in the same model catalog, provider counts, and whitelist surfaces as the other providers. Read the actual authenticated upstream model listing, preserve returned model identifiers, and bind cached discovery to the credential and workspace that produced it. Credential validation must not discard the discovery result, and changing credentials must not publish stale models from the prior credential. No guessed model list substitutes for discovery.

The Claude credential and workspace controls belong under its existing provider entry. Remove the separate `card-claude-subscription` dashboard card and its duplicated diagnostics; keep quota diagnostics in the shared Analytics capacity list and the existing Kernel summary. Preserve provider selection and credential/guard actions through the existing endpoints.

Reason: the owner reported that the Claude whitelist showed zero models and rejected the invented standalone card because it did not follow the Codex subscription UI. A live quota row and single stored credential do not establish historical-chart or multi-account-pool parity; those capabilities remain separate acceptance requirements.

## Bun persistent-store startup and restart confinement - 2026-10-15

A real immutable Mac startup, not an in-memory SQLite fixture, is the acceptance surface for database permissions. Grant directory data and metadata only for the literal repository root needed by cwd resolution, plus metadata only for the literal ancestors needed by native SQLite path resolution. Do not grant ancestor contents or recursive reads. The required Darwin native gate must exercise persistent KV open and a separate-process restart using its prepared binding, while retaining unrelated file, write, network, and process denials.

Codec inspection must try ordinary read-only SQLite first so it observes a live WAL. A stopped WAL-mode database without sidecars can fail that query with SQLITE_CANTOPEN; only that failure may use a closed, synchronous immutable inspection, fenced by absent WAL/SHM/journal files and unchanged precise source identity/stat metadata before and after inspection. Any sidecar, race, unsupported stat precision, legacy codec, or missing marker fails closed. Never use unrestricted immutable reads against live WAL, open an unvalidated store writable, or rewrite its journal mode to get startup past validation.

The offline converter may use an explicitly URI-enabled read-only immutable connection only for its exclusive newly copied private snapshot after source/copy hash validation and precise identity and sidecar absence checks. Its reader contract admits only parameterless statements, rejects missing-bind queries before execution, and requires exact safe-integer reads; output databases retain strict and safe-integer configuration. Ordinary read-only opens can create private WAL sidecars on Linux, so do not substitute them or delete sidecars to pass final snapshot validation. This is not permission to open the canonical source immutably or writable. Preserve stopped-source validation and canonical-path rollback receipt binding. Actual private Bun-to-Deno-to-Bun acceptance must preserve raw keys, typed values, revisions and absolute expiry; do not make Deno an ordinary test or CI runtime dependency.

## Claude request metadata and proven disabled thinking - 2026-10-15

Resolve enabled Claude subscription models from the same credential/workspace-bound discovery used by the shared catalog before a chat-only paid row can reject their Responses route. Preserve Codex precedence, principal eligibility, quota guards, provider selection and the operator whitelist.

Only an observed boolean `capabilities.thinking.types.disabled.supported: true` authorizes the native `thinking: { type: "disabled" }` translation of an explicit or effective `none`; it emits no native effort. This permission is independent of adaptive thinking and effort support, binds the exact dispatch credential/workspace/generation, and is rechecked before transport. False, missing, malformed or stale proof retains lossless refusal and never creates a `none` preset/default. Stale discovery keeps its recorded model IDs and error state but withdraws this permission. The [Models API](https://platform.claude.com/docs/en/api/http/models) describes independent thinking-type flags; [Haiku effort constraints](https://platform.claude.com/docs/en/build-with-claude/effort) make omission or a fabricated higher effort an invalid substitute for disabled thinking.

A disabled-thinking request cannot reuse that proof for an automatically discovered different workspace: retain its original workspace-required response and identity without a second attempt. Existing non-none workspace discovery and retry are unchanged; an operator can establish the intended workspace through the existing controls. This bounded correction does not add other reasoning tiers or change the user's global default.

## Mac native SQLite temporary storage is private per launch - 2026-10-15

The immutable Mac service launcher prepares a new physical mode700 temporary directory under its existing writable `.data` anchor after explicitly loading only the root `.env`, then overrides only the child `SQLITE_TMPDIR`. It grants no additional sandbox access, does not use a global temporary directory, and leaves the VPS environment unchanged. Cleanup follows child settlement, requires the original directory and anchor identities, preserves any changed identity with a diagnostic, and never adopts or removes retained directories from another launch.

A real same-native, same-profile synthetic spill failed with `no such savepoint: denokv_atomic_write` when all SQLite temporary roots were denied; binding the private directory made the identical atomic write succeed. The failed batch retained its original rows and revisions without partial quota writes. Keep that negative control, rollback checks and the successful private-path write in the required Darwin-native verifier. Do not classify this masked SQLite I/O failure as provider quota exhaustion, retry missing-savepoint blindly, replace the verified native artifact, or weaken confinement.

## Explicit owner waiver of the external Sentinel reader gate - 2026-10-15

The owner explicitly waived the standalone Sentinel reader acceptance prerequisite for this gateway cutover. The supported first-Bun operator accepts either the unchanged strict external-reader acceptance or a separate private, expiring owner-waived record bound to the exact source, runtime, dependencies and immutable artifacts plus the recorded owner instruction. Its discriminated input, authorization digest, journal and recovery preserve which gate was used; owner-waived is never reported as external-reader acceptance. Missing, ambiguous, expired or identity-mismatched input fails before stopping the service. No environment flag silently bypasses the gate.

This exception applies only to the external Sentinel reader prerequisite. It grants no Sentinel repository or caller-write authority and does not weaken shipping CI, deployment locking, stopped-source backups, codec conversion and reverse-conversion proof, credential preservation, operating-system isolation, immutable release checks or actual client acceptance. Legacy captures remain bound to their original source.

## Claude subscription account, evidence and shared-admin parity - 2026-10-15

Claude subscription state uses a durable account roster with opaque local identifiers, a stable active account and credential/workspace-bound cohorts. Backward-compatible singleton bootstrap preserves existing credentials and access restrictions; an explicit bootstrap tombstone prevents deleted accounts from reappearing from legacy environment state. A never-configured passive read does not persist an empty roster, so later intentional first environment bootstrap remains possible; any existing empty roster or explicit clear remains a durable tombstone. First bootstrap/import and explicit deletion serialize through real KV compare-and-set, while a targeted nonexistent deletion changes no state. A local account label is not verified upstream identity. Credential import does not grant principals access. Explicit stored access policy is authoritative after an intentional admin change, and account-targeted credential, workspace, selection and guarded-clear operations remain in the existing provider controls, not a standalone dashboard card.

Switching the active subscription and advancing to paid providers are separate decisions. Keep the active account across restarts, reordering and unchanged binding; change it only for explicit operator selection, removal or authoritative applicable exhaustion/current-credential invalidity. Paid continuation requires fresh, applicable, current-binding strong evidence for the entire selected eligible pool. Transient transport failures, unknown discovery, configuration rejection and upstream server errors do not prove exhaustion. Quota, health and model capability evidence belongs to its exact account/cohort; an in-flight result cannot overwrite a replacement or reblock a newly cleared guard. Advertised reasoning capabilities and native translations require actual upstream metadata, not a model-name guess.

Claude historical windows and hourly rollups are additive to the existing Codex and metered history contracts. Persist actual upstream observations through the quota writer's accepted-observation seam, registered before the first inference; admin reads never create samples. The source observation clock is the gateway receipt time of raw upstream headers, not a provider-issued timestamp; sampling/persistence time is separate. Preserve missing observation times as null, absent windows and gaps across staleness, cohorts and reset anchors. Bounded sampling, retention and truncation remain explicit. Claude window series share the existing Analytics chart without altering the Codex capacity denominator. Retained legacy unbound evidence is not silently relabeled as an account's history, and host-local persistence is not a claim of cross-host synchronization.

Feature parity does not justify invented upstream operations: expose only capabilities supported by the supplied credentials and actual provider contracts. A setup token without refresh material does not establish automatic refresh, a second live account has not been supplied for live failover acceptance, and local fixtures do not establish live banked-reset or redemption support.
