# Provider Sentinel

Provider Sentinel is a serialized Deno orchestration workflow with a bounded concurrent repair matrix. It performs
provider incident triage, isolated repair, deterministic convergence, native review, preview replay, explicit Deno
revision promotion, and post-promotion monitoring. Repository content, Deno logs, and captured request bodies are
untrusted inputs. Agent prompts cannot change the fixed model, review, credential, deployment, or promotion policy in
`scripts/sentinel/`.

## Modes and schedule

The `Provider Sentinel` Actions workflow has three modes:

Manual workflow dispatch defaults to `hourly`, so the standard **Run workflow** action selects backlog or GitHub issue
work. Select `preview` explicitly only for a supervised failure-replay cycle.

- `preview`: a manual `workflow_dispatch` run on the trusted `development` ref. It is supervised and may deploy only the
  exact candidate SHA to `p-ai-ubq-fi`. It does not push `development` or promote production. A manual run selected on
  any other ref is skipped.
- `hourly`: the top-of-hour schedule archives an overlapping 80-minute window of raw logs and encrypted failed-request
  captures. It first selects one eligible open P2/P3 item from the native-review backlog. If that backlog has no
  eligible item, it can select one bounded GitHub issue. It sends the selected item directly to implementation without a
  triage-model call. If neither source has work, it returns before Codex authentication, replay decryption, or any agent
  call. Automatic LLM triage is incident-only.
- `incident`: an accepted gateway or provider failure writes a durable Deno KV incident before dispatching this workflow
  through the dedicated Ubiquity Sentinel GitHub App. A Codex catalog upstream 5xx or transport failure also writes an
  incident, including when a cached, rotated, or paid catalog masks the failure from the client. One repair is active at
  a time; failures during it coalesce into one pending successor. A production-only Deno cron retries pending delivery
  and creates no runs while the outbox is empty. Each batch includes at least the preceding 20 minutes and expands back
  to its first failure.

The orchestrator also has an observation mode for a supervised soak period. `--mode observe` inspects the previous 125
minutes, which supports a two-hour schedule with five minutes of overlap. It captures complete production logs, runs
only the read-only triage agent, writes `triage.json`, `observation.json`, and `cycle.json`, and then returns
unconditionally. It never exports or decrypts replay captures, creates a candidate worktree, edits code, runs replay
inference, pushes Git, dispatches a deployment, promotes a revision, or rolls back production. Observation mode needs
only the Deno log token and the two Codex auth slots; it does not receive preview credentials or the replay key.

On GitHub Actions, hourly and preview intervals are anchored to the workflow run's immutable `created_at` value. An
incident also receives its durable first-failure timestamp and expands the interval back to that point, bounded by the
48-hour replay retention window.

After anchoring the interval, the orchestrator computes one event deduplication key. Incident attempts use the durable
`<incident-id>-a<attempt>` signal. Ambiguous delivery retries reuse an attempt; a confirmed failed workflow advances it.
Hourly and preview cycles exit before raw-log capture when a 90-day evidence artifact already has that key. Incident
retries never trust artifact existence as success because failed runs also preserve encrypted evidence; every delivered
incident run must complete and write its nonce-bound acknowledgement.

The workflow uses one repository-wide concurrency group and does not cancel an active run. Durable incident outbox
retries retain signals that arrive while a repair or deployment is active. Scheduled and App-authenticated incident runs
are skipped unless `SENTINEL_AUTONOMY_ENABLED` is exactly `true`. Incident dispatch also requires the fixed GitHub App
actor, trusted `development` ref, opaque incident ID, attempt, and first-failure timestamp. Manual preview runs remain
eligible while that gate is disabled, but return without Codex when the interval contains no failed-request capture.

Each eligible cycle has three trusted phases. `prepare` fixes the exact `origin/development` base, runs triage, rejects
ambiguous or protected ownership, and writes a digest-bound matrix plan. `repair` fans out at most four independent
cells. Every cell starts from that exact base, may change only its declared paths, uses only `gpt-5.6-luna` with `max`
reasoning, runs focused validation and secret checks, and publishes an encrypted receipt for its exact branch head.
`converge` verifies all required receipts and remote heads, asks one final Luna/max integration agent for a complete
decision, and lets trusted code merge accepted cells in stable cell-ID order with visible ancestry. A missing, failed,
blocked, or rejected required cell stops publication; it is never omitted or replaced with another model.

Only convergence runs combined validation, the bounded native review loop, preview, delivery, or production. Matrix
cells cannot deploy. The integrated candidate is pushed to its temporary branch and is delivered through one head-pinned
pull request with the merge method fixed to a merge commit. After GitHub merges it, Sentinel fetches
`origin/development` and proves that the integration head and every accepted cell head are ancestors of the returned
merge SHA before production can start. `matrix-cycle.json` retains every cell disposition, rejected or blocked branch,
ancestry proof, pull request number, merge SHA, and final delivery or rollback outcome.

Hourly backlog selection is deterministic: P2 before P3, then oldest first observation, then fingerprint. Only exact
`open` entries with an implementation-eligible repository location are selected. Sentinel-control paths remain protected
and require manual work. Selection reads one exact freshly fetched `development` revision and revalidates the complete
entry in the candidate before an agent starts. Only an `implemented` result with a matching nonempty diff becomes
tentatively `resolved`. No-code, already-fixed, blocked, and non-actionable results become `manual_required` through a
trusted backlog-only development commit. That push uses the workflow `GITHUB_TOKEN`, so it does not recursively start
the push deployment workflow, and the lane never dispatches or promotes a runtime revision. If native review reports the
targeted fingerprint again, that finding blocks the backlog cycle within the same three-round limit. Other new P2/P3
findings remain nonblocking and are merged into the backlog. If `development` advances after the prerequisite hint, the
cycle archives evidence and defers the new backlog state to the next hour. Empty replay sets skip the replay-evaluation
model call.

GitHub issue selection is a read-only fallback when the native-review backlog has no eligible entry. Sentinel admits
open issues in this repository without author/editor privilege, assignment, lock, estimate, template, source-file hint,
or comment-count admission rules. Parent, sub-issue and outgoing blocker relationships are context. Incoming
prerequisites are captured with their states for planning. Open prerequisites produce an explicit dependency blocker;
incomplete or unknown dependency state is unavailable source evidence. These checks run before fresh planning and again
when accepting a plan. A failed issue or comment capture records `source_unavailable` and advances to the next issue; it
never admits partial source data. Issue text and discussion are untrusted task data and cannot authorize changes to
Sentinel controls, model policy, credentials or protected files.

Priority controls ordering only: the highest recognized numeric Priority label sorts first, then the oldest creation
timestamp, then the lowest issue number. Multiple recognized labels use their highest value; missing or unrecognized
priority sorts last. Estimates and labels are not edited to make an issue eligible. Optional legacy Acceptance and Files
sections remain source hints, but ordinary issue prose can proceed to read-only planning.

The source snapshot binds issue identity, body, title, material discussion and relationships. Preparation uses the
existing read-only Sol planner to produce one complete issue plan with a bounded scope and validation requirements. The
V2 selection report binds the original source fingerprint, development base and frozen plan digest. Generated scope does
not change source identity. Execution uses the frozen scope, including necessary supporting tests, while retaining the
protected-path checks. Retained V1 evidence keeps its historical exact-file interpretation.

Sentinel revalidates source identity before publication. Prepared convergence binds its exact selected issue and plan; a
newly higher-priority issue affects the next fresh selection. Active claims, retry deadlines and terminal recovery
decisions remain authoritative. Unavailable items have explicit dispositions and later eligible items can proceed.
GitHub pagination and response limits remain bounded; an incomplete capture cannot authorize implementation.

Candidate checkpoints remain encrypted and auditable. Retry attempts preserve their source identity and generation; an
unchanged terminal decision cannot restart merely because a new workflow runs. A legacy ledger word alone does not prove
production delivery or authorize issue closure. The delivery flow requires matching candidate and pull-request evidence,
the existing deployment and health identity checks, and production acceptance. Failed, manual-required and rolled-back
work stays open. Sentinel preserves contributor branches and unfinished work, and never assigns, labels or comments
during source selection. The workflow concurrency group serializes Sentinel runs.

## Authoritative recovery eligibility

Durable recovery decisions from the `sentinel/recovery-state` ref are authoritative over both the embedded workflow
prerequisite selector and the runtime issue and review-backlog selection. One snapshot is fetched per selection stage
and every individual selection pass uses it; a malformed or unreadable snapshot fails closed and never falls back to an
empty ledger. For the exact repository, source kind, source ID, and source revision across all generations, an existing
`delivered` or `manual_required` decision blocks a new generation, and a rejected unchanged source stays blocked until
the source revision changes (rejection never resets attempts). An active record proceeds only through its own due retry
decision; an active non-due record is unavailable, as is an exact source with colliding active generations or a live
lease held by another owner. A truly unseen source revision remains eligible, and matrix convergence continues the
exactly prepared claimed record (bound by run ID and lease token) instead of treating it as a competitor. Unavailable
first items are skipped so later eligible work advances, and the decision is rechecked against a fresh authoritative
snapshot before a generation is claimed. The bounded 512-record ledger retains one newest terminal circuit decision per
unchanged issue/review source revision and fails closed when the required protected records cannot fit; unrelated
terminal records stay eligible for recency-based pruning.

Convergence binds the exact prepared work item (issue or review backlog) by source identity and never re-runs the
time-dependent queue selector, so an earlier item becoming due while cells run cannot discard completed matrix work. PR
#243 review finding [226fe1c6...](https://github.com/ubiquity/ai.ubq.fi/pull/243#discussion_r3944350738) (review
5125735701, comment 3944350738, reviewed head `4cf7a31712ecb5ac7deb803f70ddfd6a6e736002`, base
`64d1d075bc102dc375e6be4292fc5871808f4572`) raised this race; remediation is tracked in
`docs/sentinel-review-backlog.md` and is resolved only after the exact-prepared-source regressions for both issue and
review backlog convergence pass.

The workflow supports public, private, and internal repository visibility. It fails before checkout or raw-log capture
unless `SENTINEL_ARTIFACT_KEY` is present and decodes to exactly 32 bytes. After the cycle, it scans every prospective
artifact path for credentials, encrypts raw logs and durable reports with AES-256-GCM, reads the persisted ciphertext
back, decrypts it, verifies every original byte, and only then removes the plaintext directories. The upload step
accepts only the single verified ciphertext envelope. A scan or encryption failure uploads no raw logs or reports.

## Required repository configuration

Add these Actions secrets:

- `SENTINEL_CODEX_AUTH_SLOT_1_B64`: base64 encoding of one complete Codex CLI `auth.json` document.
- `SENTINEL_CODEX_AUTH_SLOT_2_B64`: base64 encoding of a second complete Codex CLI `auth.json` document.
- `SENTINEL_ARTIFACT_KEY`: one cryptographically random 32-byte value encoded as standard base64. It encrypts the full
  raw-log and report artifact before upload and remains separate from the replay key.
- `SENTINEL_REPLAY_KEY`: one cryptographically random 32-byte value encoded as base64url. The deployment workflow
  validates its decoded size without printing it, then synchronizes it to preview and production with
  `deno deploy env load --replace`.
- `SENTINEL_GITHUB_APP_PRIVATE_KEY`: the private key for App ID `4682172`, installed only on this repository with
  Actions write and Metadata read. The deployment workflow sends it through one Deno v2 app patch as a secret limited to
  the production context. It never enters the general deploy environment file or a preview timeline.

The managed-`auth.json` slots are a temporary compatibility path, not the durable authentication design for this public
repository. OpenAI's [Codex CI/CD auth guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth) limits that pattern to
trusted private automation and explicitly excludes public or open-source repositories. While the compatibility path
remains, each slot must come from a distinct ChatGPT account and an isolated, file-backed `CODEX_HOME` that is not used
by another machine or workflow after seeding. Managed ChatGPT refresh tokens are a single-writer credential: a local
Codex process that continues using the copied file can rotate the refresh token first and strand Sentinel with an old
copy.

When either slot can no longer refresh, create fresh seeds instead of restoring an older artifact. Replace both slot
secrets first, then change `SENTINEL_CODEX_AUTH_GENERATION` to a new, never-used label. Changing the generation last is
the atomic cutover: the next serialized Sentinel run ignores encrypted artifacts from the old generation, bootstraps
from the new secrets, and persists only the refreshed files it receives from Codex. Never paste an auth document into an
issue, pull request, workflow input, or chat.

The supported migration target is
[Codex workload identity federation](https://learn.chatgpt.com/docs/enterprise/workload-identity) with GitHub Actions
OIDC. It requires a managed ChatGPT workspace, workspace-admin configuration, and beta enablement. Workload identity
writes no `auth.json`, so the Sentinel auth-state, quota-selection, and relay contracts must be migrated deliberately
before the compatibility secrets can be removed.

The workflow also requires existing secrets `DENO_DEPLOY_TOKEN` and `PREVIEW_UOS_AI_USER_TOKEN`. The deployment workflow
installs the preview credential only on `p-ai-ubq-fi`, and replay uses that same credential to replace authorization.
Production secret synchronization selects only `UBIQUITY_AI_USER_TOKEN`; an absent production token fails the deployment
instead of falling through to the preview token. `GITHUB_TOKEN` comes from the workflow and has `actions: write`,
`contents: write`, and `issues: read` permissions. Checkout does not persist it in Git configuration; the trusted
orchestrator passes a process-local Git HTTP authorization header only to explicit fetch and push commands without
writing the token into the checkout. The selected real Codex auth remains only in the parent orchestrator and its
loopback relay. Agent `CODEX_HOME` directories contain a synthetic non-secret auth document. The outer Bubblewrap
sandbox hides host runner files and PIDs and mounts only system files, the repository, the selected checkout, and the
synthetic home. Neither real nor synthetic auth is placed under `.sentinel/`, logged, prompted, or uploaded. Workflow
secrets are scoped to the orchestration and final artifact-scan steps, not dependency installation or artifact upload
actions.

Complete raw Deno log captures are given to triage without field sanitization, filtering, or summarization. Raw logs and
durable reports are then compressed and encrypted into one authenticated ciphertext envelope before Actions receives
them. The repository or organization must permit 90-day artifact retention. Runs with new captures upload a separate
encrypted replay bundle. Both artifacts use 90-day retention. Codex auth documents and deployment credentials are not
artifacts.

Each encrypted replay bundle uses a non-sensitive, digest-addressed `sentinel-replay-bundle-v1-*` name and includes its
index manifest. The keyed case-group Bloom filter in the artifact name lets future runs locate and download only bundles
that may match the current incident. The index contains no request bodies, decrypted capture fields, authorization
values, cookies, or credentials. Matching retained bundles are subject to fail-closed aggregate artifact-count,
compressed-byte, and extracted-byte limits. Duplicate retained captures are collapsed by capture fingerprint before
decryption and replay. Time-window exports enforce both interval boundaries. Incident exports also follow opaque KV
references to an earlier encrypted manifest when the same failed input was deduplicated during the active batch.

Generate a replay key locally without writing the plaintext to shell history:

```sh
openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

The Sentinel and deployment workflows pin third-party actions to full commit SHAs and pin Deno to `2.9.5`. Review and
update these pins deliberately; do not replace them with moving major-version tags before autonomous operation. The
Sentinel primes one run-scoped `DENO_DIR`, then starts the orchestrator with locked, frozen, cached-only dependency
resolution.

## Local failure capture export and offline replay

Every accepted terminal inference failure can be found by its gateway request id on the Mac. After the local
`SENTINEL_REPLAY_KEY` is provisioned, a super-admin bearer token reads one capture without any time window:

```sh
curl -sS -H "Authorization: Bearer $DENO_DEPLOY_TOKEN" \
  "http://localhost:7999/admin/sentinel/replay-captures?request_id=<x-uos-request-id>"
```

Live public or VPS deployment is out of scope and has not happened.

The response is `{ data, cursor: null, capture_status }`. `after_ms` and `before_ms` are not required for a request-id
lookup and are ignored there. Time-window listing still requires a valid `after_ms`/`before_ms` interval, `limit=1` and
a valid cursor, and `incident_id` listing is unchanged. `request_id` and `incident_id` are mutually exclusive, and a
malformed request id is rejected with 400.

`capture_status.status` is one of `ready`, `incomplete`, `disabled`, `failed`, `expired`, or `unknown`. `ready` and
`incomplete` carry the manifest key, fingerprint and expiry; `incomplete` means at least one evidence gap is listed in
the decrypted `unavailable` reasons. `disabled` records `key_missing` or a body omission such as `body_over_limit`;
`failed` records `persist_failed`; `rejected_before_capture` marks an authenticated request refused before capture
setup. `expired` is derived from the stored expiry, while `unknown` with reason `no_capture_record` means no row exists.
An unavailable store cannot record its own failure: when KV is unavailable the admin export returns a storage error and
cannot promise a persisted per-request row. Request status rows are retained for 96 hours while encrypted payloads
expire after 48 hours. Unauthenticated rejections write nothing.

The current private plaintext is version 3. It carries the exact accepted request bytes (up to 32 MiB), method and
endpoint, content type, the fixed compatibility-header allowlist, the recorded request's own model/reasoning/stream
settings, the client-visible terminal (`terminal_type`, `failure_kind`, `error_code`, `error_param`) with a bounded 64
KiB terminal body, the internal failure observation, the build identity and request id, the body length and SHA-256, and
`capture_status`/`replay_coverage`/`unavailable`. The upstream trace is version 2 and holds each dispatched attempt in
order: provider, status, content type, the response chunks exactly as the network delivered them (bounded in aggregate,
with no fixed network chunk size), safe response headers, per-chunk timing, start/header/end times and terminal (`eof`,
`read_error`, `fetch_error`, `cancelled`). Aggregate bounds are 8 attempts, 4,096 chunks and 4 MiB of recorded upstream
bytes; the 48 KiB unit is the encrypted KV storage chunk, not a network framing size. Authorization, cookie and API-key
headers and host credentials are excluded, but original request bodies and tool content are retained byte-for-byte and
are not generally redacted; captures stay encrypted at rest and admin-only on export. The private plaintext v3 and trace
v2 belong to this gateway source: an older external decoder does not automatically understand a newly versioned payload,
and the fixed consumer is part of the matching gateway source. Older version-2 plaintext and version-1 traces still
decode here, and the default time-window and `incident_id` export contracts are unchanged.

### Bounded growth and retention

Each host keeps one fixed **1 GiB budget** for capture-owned retained data: the encoded KV payload this feature owns
(base64-expanded ciphertext chunks plus metadata, status, dedupe and index row overhead) and in-progress reservations. A
hard record-count bound also applies. The budget is not a bound on the shared SQLite database, its WAL, the reusable
allocated pages, or any other namespace; the admin status labels its scope explicitly. The 32 MiB request and 4 MiB
trace ceilings are unchanged and now share one derived set of constants across serialization, encryption, export/decode
and the offline reader, so one allowed capture cannot be accepted by one layer and rejected by another.

**Durable accounting rows are the source of truth, not the ledger.** Every capture writes one durable row under
`["uos_ai","sentinel_replay","v1","accounting", captured_at_ms, capture_id]`; the timestamp-first key order _is_ the
oldest-first index, so there is no second index namespace. Rows carry no KV TTL: a row stops existing only through one
atomic commit that deletes it and decrements the ledger in the same operation. The ledger under
`["uos_ai","sentinel_replay","v1","budget"]` is derived cached state. Every accounting mutation — admit, publish,
revoke, release, evict, expire and status admit/prune — is one `kv.atomic()` commit that checks the exact versionstamp
of both the row it mutates and the ledger, and writes both, so a ledger delta is never applied apart from the row change
it describes. The state machine is `reserved -> stored -> (evicted | expired)` and `reserved -> revoked -> released`.

Admission writes the row as `reserved` and increments `reserved_bytes` in the same commit, before any chunk is written.
Chunks are staged in bounded batches of 32: **before each batch** one atomic commit re-checks the row's versionstamp and
requires `state=reserved`, this writer's fence and an unexpired lease, incrementing `stage`. Publish then transitions
`reserved -> stored` and commits the manifest, dedupe, request status, incident evidence, the actual charge and the
ledger transition together, verifying in that commit that the row is still reserved at the writer's fence, unexpired,
that the actual charge fits the reserved bound and that the payload budget holds. A reaper revoking the row increments
the fence, so a paused writer that resumes can never advance again and can never publish.

**Cleanup is fenced and release is conditional.** Revoke sets `state=revoked`, increments the fence and leaves the
charge held; chunks are then deleted in bounded passes (512 per pass) and the charge is released only when a fresh
listing over the chunk prefix returns zero entries — the release commit deletes the row and subtracts `reserved_bytes`
together. A partial deletion leaves the row revoked and charged for a later pass. Eviction is exactly-once: a caller
must win a CAS that moves `stored -> evicting` at the row's exact versionstamp before it may touch anything, so a loser
cannot delete a victim another caller claimed. Only once the chunk prefix is empty does the winner commit row deletion
with `stored_bytes-=`, `records-=` and `evicted_bytes`/`evicted_records`/`last_eviction_at_ms`. Dedupe deletion is a CAS
against the exact dedupe row proven to still reference that victim's manifest key, so evicting old capture A can never
delete a newer capture B that shares a fingerprint. A failed final commit leaves the victim `evicting` with its charge
held, and a later pass resumes it.

**TTL expiry is reclaimed, not evicted.** Because accounting rows outlive the payload TTL, a maintenance pass selects
rows with `expires_at_ms <= now` and `state=stored`, claims them, deletes the payload and releases the charge with
`records-=` and **no** `evicted_*` increment, writing `expired` with reason `payload_expired`. This is what lets a
restart after TTL expiry reclaim capacity instead of facing a permanently full empty store; `evicted` and `expired`
counters stay truthful and distinct. If safe bounded cleanup cannot admit the newest capture, it is skipped with a
visible `storage_full` status instead of growing above budget.

**Bootstrap is resumable, counts every in-scope row and fails closed.** It sweeps every capture-owned prefix that holds
retained bytes or metadata — accounting rows, payload chunks, dedupe, request status, eviction tombstones and legacy
reservation rows — counting scanned entries rather than only valid records, and advancing a durable cursor. A corrupt or
unreadable in-scope row makes accounting incomplete: new admissions are refused with the existing
`storage_accounting_in_progress` reason and the admin status reports `accounting_complete:false` until a later pass
resolves it. An invalid row never causes a key to be deleted on a guess: a manifest's key shape and its
`capture_id`/`fingerprint` are validated before anything derived from it is touched. A ledger whose counters are
negative, non-integer or inconsistent with the row set is rejected and reported, never silently replaced with an empty
ledger. Legacy reservation rows are read only to release their charge once, then deleted.

**Status metadata is bounded by a 64 MiB reserve inside the 1 GiB.** Payload admissions may use at most
`budget - 64 MiB`, so capture-owned request status and eviction/expiry tombstone rows can never starve payload
retention. Status rows are admitted through a CAS on the ledger's `status_records`/`metadata_bytes` counters under a
50,000-row bound and the reserve byte bound; when either bound is exceeded the oldest capture-owned status/tombstone
rows are pruned first and the counters decremented in the same commits. Once pruning has removed any status row, a
missing lookup reports the distinct `status_not_retained` code instead of inventing `evicted`, `expired` or `ready`.

The Admin error-history panel shows the current capture usage and cap, the eviction notice ("Oldest recordings were
removed to keep new ones within the 1 GiB limit"), a near-capacity warning and any skipped capture reason from the
existing plain-text capture-retention line rendered with `role="status"` and `aria-live="polite"`; storage that cannot
be accounted for is reported as unavailable rather than zero. Host text logs are separate: the Mac
`.data/mac.stdout.log` and `.data/mac.stderr.log` sizes are reported stat-only, as `null` when unmeasured, with an
independent warning at 1 GiB, and this feature does not rotate or truncate them.

**Honest scope limits.** The 1 GiB budget bounds only the capture-owned encoded KV payload and its accounting rows. It
is _not_ a bound on the shared SQLite database file, its WAL, reusable allocated pages, or any other namespace — those
are outside the budget and are never evicted through it. The incident index rows in `src/sentinel/incident-outbox.ts`
are separate incident bookkeeping: their capture reference rows are TTL-bound to the evidence expiry and the incident
index namespace is likewise outside the recording-byte budget, and no unrelated incident history is ever deleted by
retention.

Export returns the encrypted manifest and chunks. After decryption, the plaintext `body` bytes are the request bytes and
`upstream` is the recorded trace. The fixed consumer runs from a disposable checkout of `src/`, `scripts/replay.ts` and
`tests/helpers/` with the trusted dispatch metadata in `.sentinel-replay-input.json`:

```json
{
  "version": "v1",
  "requestPath": "fixtures/request.json",
  "upstreamPath": "fixtures/upstream.json",
  "testIds": ["replay-roundtrip"],
  "report": "structured-v1"
}
```

`fixtures/request.json` is the existing envelope
`{ "version": 1, "endpoint", "method", "request_id", "body": "<request JSON text>" }` and `fixtures/upstream.json` is
the decrypted `upstream` trace. The consumer replays through the real gateway parsers and provider transports with
`tests/helpers/sentinel-recorded-upstream.ts`; it never contacts a provider or reads credentials. The command is fixed:

```sh
deno run --no-prompt --no-config --no-remote --allow-read=. scripts/replay.ts
```

Exit 0 means a complete replay, exit 1 is the fixed causal-failure line, and exit 2 is unavailable. The optional
`report: "structured-v1"` adds one diagnostic report line; without it the trusted marker output is unchanged.

Current consumer limits: provider HTTP-error mapping, empty-completion mapping and gateway validation mapping are not
exercised by the offline consumer, and multi-attempt replay reproduces the recorded attempt sequence without replaying
routing or retry policy. A byte-complete capture is not a claim that every consumer mapping is supported. macOS
activation and `SENTINEL_REPLAY_KEY` provisioning remain separate operator steps.

## Deployment identity and workflow dispatch

The default workflow token does not create another push workflow run for its own repository changes. After a matrix
candidate passes preview, Provider Sentinel merges its one head-pinned delivery pull request, rebinds the production
candidate to that ancestry-preserving merge SHA, and dispatches `.github/workflows/deno-deploy.yml` at the exact
`development` ref. Non-matrix maintenance paths retain their established trusted publication behavior. Sentinel accepts
only the deployment run whose recorded head SHA equals the delivered candidate SHA. Preview runs use the same explicit
dispatch with `deploy_preview=true` at the temporary Sentinel ref. Every Sentinel dispatch also sets
`sentinel_build_only=true`. For that path, the pinned reusable workflow is forced into its mode without `--prod` while
its preview target is set to the requested application. The run requires exactly one post-baseline revision, verifies
its immutable body and header identity, and uploads `sentinel-deployment-<run-id>` with the exact app, SHA, and
revision. The orchestrator follows the run ID returned by GitHub's dispatch API and accepts only that run-scoped
artifact. Normal push and manual deployment runs retain the workflow-owned verification and promotion behavior.

Deployment success alone is not production identity. The orchestrator resolves the new routed revision whose revision
URL `/health` reports the exact candidate Git SHA, promotes that revision with Deno's revision API, requires HTTP 204,
and verifies the public Deno host and `ai.ubq.fi` report both the candidate SHA and promoted revision. It records the
previous healthy SHA and revision before deployment so rollback has an exact target. Health attestation requires HTTP 200. An identity-bearing error response is not treated as healthy.

Every preview, production, rollback, and revert promotion is dispatched to
`.github/workflows/sentinel-revision-control.yml`. That short workflow shares the `ai-ubq-fi-deploy` concurrency queue
with all deployment writers. It rechecks the live `development` SHA, the expected stable identity, application
membership, routed status, and immutable health immediately before promotion. Production runs retain the existing
`production` environment gate. If a promotion attempt has an ambiguous result or post-promotion verification fails, the
workflow observes the managed route while it still holds the lock. It restores and verifies the saved revision when the
target is live, records a verified no-change result when the previous revision remained live, and records an unknown
outcome without overwriting an unrelated identity.

Preview replay uses the resolved revision's immutable hostname, not the shared `p-ai-ubq-fi` stable hostname. Production
`keep` is finalized only after one last managed-host identity check and custom-host probe. An exact custom-host HTTP 200
identity mismatch is fatal. An identified Cloudflare Bot Fight Mode challenge is recorded once as a warning after the
managed route passes, without repeated identical probes. Before rollback can promote the recorded old revision, the
orchestrator re-fetches `origin/development`, checks production identity, and stops if the managed identity belongs to
an unknown deployment. The automatic rollback controller (`scripts/sentinel/rollback-controller.ts`) is the objective
restore engine for every failed post-promotion production acceptance: it promotes only the exact immutable prior
revision from the pre-deploy healthy attestation through the serialized revision-control workflow, verifies the exact
previous SHA and revision on the managed route in body and headers, probes the custom domain with the Cloudflare-403
warning policy, persists machine-readable rollback evidence, and fails closed when identity or promotion cannot be
proven. Codex review findings alone never trigger a rollback. Durable preview and production decision files use the
declared deployment-identity shape with app, Git SHA, revision, health URL, and observation time for both candidate and
previous revisions.

The supervised preview always proves the rollback leg after monitoring. It restores the candidate only after a `keep`
decision. A `rollback` decision leaves the prior preview revision live and records the candidate as rejected.

Replay transport has a hard inference-only endpoint allowlist. Failed stateful embedding-job requests may remain in the
encrypted incident evidence, but Sentinel never replays `/uos/embedding-jobs` or administrative endpoints and never
executes tool calls returned by a model.

The cycle will not start a production push after its first 90 minutes. This preserves a large part of the hosted
runner's six-hour limit for the fixed 30-minute observation window, the separate monitoring agent, and a deployment plus
Git revert if any production-stage operation fails.

## Supervised preview acceptance

Keep `SENTINEL_AUTONOMY_ENABLED` unset or `false` until the ciphertext artifact policy and immutable dependency pins
satisfy the gates above and one manual preview cycle on `development` demonstrates all of these results:

1. Both auth slots are validated without disclosure, quota selection is correct, and account changes between stages are
   handled.
2. Complete raw logs and durable reports are exported only as authenticated ciphertext, and new encrypted KV captures
   preserve exact request bytes and allowed compatibility headers while replay replaces authorization.
3. Triage reports every evidence-backed finding, implementation records every disposition, and the rolling asynchronous
   Codex review later ingests every severity (P0, P1, P2, and P3) into `docs/sentinel-review-backlog.md` with P0 then P1
   priority, never blocking the reviewed pull request merge.
4. Formatting, lint, build, affected tests, served HTTP/SSE checks, secret scanning, and replay validation pass for the
   exact candidate SHA.
5. The exact SHA reaches `p-ai-ubq-fi`; a simulated keep and rollback both restore the expected revision identity.

After the supervised run has a complete durable report, set the repository variable `SENTINEL_AUTONOMY_ENABLED=true`.
Remove or change that variable to stop new autonomous hourly archival and incident cycles.

## Local verification gate

Run `deno task sentinel:test-local` from the repository root before creating any pull request that touches Provider
Sentinel. It is the single canonical local verification harness (`scripts/sentinel/local-test-harness.ts`) and runs in
fixed fail-fast order the workflow-contract, rolling-review, artifact-recovery (with the read/write/run permissions its
fixtures need), recovery/controller, matrix, Luna policy/orchestrator, and rollback tests, then the `fmt` check, `lint`,
and `build` tasks. It is hermetic by default: child processes get no network access and no GitHub, Deno, or model
credentials, so no paid model or deployment call can run, and every dependency resolution is locked and cached-only. It
prints concise per-stage timing and status, preserves child output when a stage fails, exits nonzero on the first failed
stage, and writes the machine-readable result to the ignored `.sentinel/local-test/result.json`.

CI repeats only that exact command. The `provider-sentinel.yml` workflow invokes exactly `deno task sentinel:test-local`
and defines no independent Sentinel verification steps of its own; new verification belongs in the local harness. The
local run must pass before the pull request is created, not after review findings arrive.
