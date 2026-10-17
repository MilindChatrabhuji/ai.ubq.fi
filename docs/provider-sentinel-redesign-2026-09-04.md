# [Superseded] Provider Sentinel redesign

> **Historical / superseded — 2026-10-11.** This document records a proposed design saved September 4, 2026; it is not
> an active implementation plan or runbook. The active contracts are in `AGENTS.md`: production runs on
> `codex@vps.pavlovcik.com` in `/home/codex/repos/ubiquity/ai.ubq.fi` and is deployed with `deno task deploy:vps`, while
> Sentinel automation belongs to the standalone `ubiquity/sentinel` repository. Deno Deploy hosting and embedded
> Sentinel workflows, schedules, workers, and deployment credentials in this repository are retired.
>
> Retain only ideas such as bounded repair, durable evidence, exact-build attestation, serialized promotion, and
> rollback. Any future implementation must use the VPS deployment contract and standalone Sentinel; nothing below
> authorizes restoring the retired orchestration or executing this document.

Status: superseded (historical) as of October 11, 2026. No implementation, workflow dispatch, production inference test,
or deployment was performed for the original design.

## Objective and success

The historical objective was to make the provider recover from software defects without routine human intervention. It
described a small deterministic bootstrap protecting availability and an upgradeable Sentinel repairing production
failures, then completed Codex review findings, then eligible GitHub issues. Codex review would run independently and
never gate delivery. Those Sentinel roles are no longer embedded in this repository; the active automation boundary is
the standalone `ubiquity/sentinel` repository.

The historical success criterion was a real autonomous cycle: a captured defect produced a reproducible failure, a
focused candidate passed independent acceptance, the PR merged, the exact merged revision served production correctly,
and delayed review findings became subsequent work. A separate drill would prove that bootstrap restored the recorded
previous revision when both production and the coding workflow failed.

The historical design required distinguishing repairable defects from client errors, account authorization problems,
exhausted capacity, and upstream outages. Code cannot guarantee successful inference when every permitted upstream is
unavailable. These incidents remain visible and retryable; they cannot be relabeled as successful repairs.

## Current evidence

Inspection base: repository `/Users/nv/repos/ubiquity/ai.ubq.fi`, clean root checkout on `development`, local and remote
SHA `2ab2b39b61e6ae05584349e5a92d9275db1218c2`. GitHub evidence was collected around September 5, 2026 00:45 UTC, still
September 4 in New York. This is an inspection snapshot, not a current production health attestation.

- [Run 33931495629](https://github.com/ubiquity/ai.ubq.fi/actions/runs/33931495629): preparation and convergence fail
  with `Sentinel review backlog row has an invalid fingerprint or SHA`; repair is skipped.
- [Run 33933366948](https://github.com/ubiquity/ai.ubq.fi/actions/runs/33933366948): triage fails with
  `CodexInvocationError: Codex invocation stopped (runtime_failure).`; convergence then tries to read an absent matrix
  plan. The logs do not establish the underlying model runtime cause.
- [Bootstrap run 33931923259](https://github.com/ubiquity/ai.ubq.fi/actions/runs/33931923259): successful workflow
  result, but no recovery action despite eight observations of stuck progress.
- The latest 200 inspected Sentinel runs contained 164 failures and 33 successes. These counts describe the inspected
  window only. A green run that publishes a branch is not evidence of a deployed repair.
- GitHub APIs reported `development` as unprotected, no repository or inherited rulesets, and no effective branch rules.
  Required deterministic checks therefore need actual enforced delivery authority, not assumptions about branch
  protection.

Source-confirmed mismatches at the inspection SHA:

| Intended behavior                                | Current behavior and evidence                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed payloads first on every wake-up           | `scripts/sentinel/main.ts:273` makes hourly captures archive-only.                                                                                            |
| Required replays must pass                       | `main.ts:1259` accepts model dispositions for still-failing, regressed, and unavailable results.                                                              |
| Success means a valid API result                 | `src/sentinel_replay_capture.ts:303` can classify malformed or non-JSON HTTP 200 as completed.                                                                |
| Review latency is independent                    | `.github/workflows/provider-sentinel.yml:1552` runs the review worker before main repair; one review can occupy 40 minutes.                                   |
| Review merged changes                            | `scripts/sentinel/rolling-review.ts:630` treats an already merged ancestor head as unreachable instead of retaining the original comparison base.             |
| Main Sentinel can improve itself                 | `scripts/sentinel/policy.ts:41` protects all Sentinel source, workflows, and Sentinel tests.                                                                  |
| Bootstrap survives broken main code              | Preparation uses current development before convergence selects `activation.active_sha`; bootstrap imports modules outside its digest boundary.               |
| Bootstrap can restore production                 | Bootstrap lacks retired Deno Deploy promotion authority. `bootstrap/main.ts:255` and `rollback-controller.ts:329` require healthy production before recovery. |
| Bootstrap decides availability deterministically | Main runs a 30-minute passive monitor and then invokes a model for keep/rollback at `main.ts:5499`.                                                           |

Prior work existed in `docs/provider-sentinel-self-healing-plan.md` and its recorded worktrees, plus open Sentinel
recovery PRs. Preserve those artifacts and their ownership. The proposal would have replaced the orchestration design if
accepted; it authorized no merging, discarding, or cleaning of old candidates. Those artifacts remain historical, and
this document requests no inventory or reuse action.

## Canonical implementation identity (historical only)

This was a single-writer implementation plan. The sequence below was dependent work, not a parallel module assignment.
It creates no implementation branch or worktree, and its recorded lane must not be revived.

- Canonical plan path and goal identifier:
  `/Users/nv/repos/ubiquity/ai.ubq.fi/docs/provider-sentinel-redesign-2026-09-04.md`.
- Goal slug: `provider-sentinel-redesign-2026-09-04`; hash suffix: `gac146ab309`.
- Repository root: `/Users/nv/repos/ubiquity/ai.ubq.fi`.
- Canonical worktree name: `provider-sentinel-redesign-2026-09-04-gac146ab309`.
- Canonical worktree path:
  `/Users/nv/repos/ubiquity/ai.ubq.fi/.codex-worktrees/provider-sentinel-redesign-2026-09-04-gac146ab309`.
- Canonical branch: `codex/provider-sentinel-redesign-2026-09-04-gac146ab309`.
- Base ref: `origin/development`; inspected base SHA: `2ab2b39b61e6ae05584349e5a92d9275db1218c2`.
- Lane state: planned in the historical snapshot; no implementer owns or should create this lane. No module lanes were
  assigned.

The original plan instructed an implementer to reconcile this base against current development, existing goal work,
active writers, and open PRs. That lane is retired. Current work follows `AGENTS.md` and the active VPS and standalone
Sentinel contracts instead; this document does not prescribe a branch, worktree, or implementation sequence.

## Architecture (historical / superseded)

The following records the proposal's retired authority model; it is not an instruction to restore embedded Sentinel
automation. Sentinel scheduling, agents, review intake, and deployment credentials now belong to `ubiquity/sentinel`,
while serving-code promotion remains governed by the VPS contract in `AGENTS.md`.

There were two authority domains. The separate reviewer was a background worker, not another release decision-maker.

| Component         | Responsibility                                                                                                               | Authority                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Bootstrap         | Observe health, resume work, enforce acceptance, activate Sentinel versions, serialize promotions, restore previous versions | Fixed owner-controlled code and policy; sole production promotion authority                      |
| Evolving Sentinel | Diagnose incidents, implement repairs, improve its own allowed code, prepare candidate branches and PRs                      | Candidate workspace only; no bootstrap, release-state, credential, or acceptance-policy writes   |
| Review worker     | Run native Codex review on frozen revisions and publish exact evidence                                                       | Read-only code access; write review results through a controlled interface; no release authority |

The proposal used one active coding candidate and one production release transaction. It would have removed repair
matrix fan-out and convergence from the replacement. Read-only diagnosis could run concurrently when useful. No model
was required to select a queue, determine a test result, promote a revision, or roll back.

The proposal required bootstrap to be an independently pinned package with its whole import graph, runtime, and
dependencies fixed. It must not import the provider, evolving Sentinel, current development configuration, or generated
Markdown. The workflow that loaded it would also be protected from candidate edits. A tiny protected workflow could load
the pinned package in the current repository; a separate control repository was an optional stronger isolation choice,
not a prerequisite for that prototype.

The proposal noted that prompt instructions alone do not enforce this boundary. It called for isolated jobs, restricted
credentials, trusted diff checks, and an independently controlled merge/promotion executor. Its coding process received
neither repository write nor Deno admin credentials. The executor verified the actual Git diff and required checks, and
repository rules were to prevent the automation identity from bypassing this path.

Keep the existing direct Codex connection independent of `ai.ubq.fi`. Preserve `gpt-5.6-luna` with maximum reasoning for
CI/runtime implementation. Local implementation uses the configured DSH model as required by `AGENTS.md`; it must not
change the runtime Luna invariant.

## Durable state

Reuse existing Git state branches with compare-and-swap commits and encrypted capture/artifact storage. Avoid a new
database for the first slice. Store operational state as validated JSON. Render Markdown as a view; never parse a
manually edited Markdown table to decide whether incident repair can run.

Keep three small record types:

1. Work item: source/fingerprint, immutable evidence references, occurrence count and first/last seen, priority, state,
   base/candidate SHA, branch/PR, attempt count, lease generation, next eligible time, exact last failure, and
   acceptance references.
2. Release transaction: transaction and fencing generation, previous production SHA/revision, candidate SHA/revision,
   pre-promotion evidence, observed routing identity, promotion intent/result, acceptance deadline, decision, rollback
   evidence, and config compatibility identity without secret values.
3. Review task: PR number, exact base SHA, exact head SHA, reviewer/run identity, state, original result digest,
   findings, and retry information.

Track Sentinel separately: stable controller SHA, active controller SHA, candidate controller SHA, generation,
startup/functional acceptance, and previous controller. A provider `/health` SHA does not identify a tested Sentinel
controller release.

Useful work-item states are queued, implementing, candidate_saved, validating, release_pending, observing, resolved,
retry_wait, and blocked. Keep reasons structured. A timeout is not resolution. Completed review state and release state
are independent. Persist candidate commits before model-output parsing and validation; reconcile ambiguous pushes
against the exact remote ref.

Keep operational state bounded without dropping unresolved work. One malformed review batch is retained with a visible
ingestion failure and contributes no findings. It must not block capture intake, incident repair, or rollback. This
preserves fail-closed review parsing without making review health a prerequisite for uptime.

## Work selection and retries (historical / superseded)

The historical model had incident dispatch and scheduled wake-ups drain the same queue:

1. Bootstrap handles an active production regression or interrupted release transaction.
2. Resume an eligible saved repair or select the highest-impact current production failure family.
3. Select completed review findings in P0, P1, P2, P3 order.
4. Select eligible GitHub issues.

An active outage preempts ordinary issue work at the next safe checkpoint. A review finding that is independently
confirmed to cause an active incident joins incident work; review severity alone never triggers rollback. Ingest
completed reviews early but without waiting for running reviews.

Group repeated failures by endpoint, normalized request features, terminal failure signature, and relevant
provider/configuration identity. Retain exact encrypted request bytes and compatibility headers for reproduction.
Preserve frequency and affected traffic so a thousand repeated failures create one high-priority incident, not a
thousand coding jobs.

Use bounded attempts per unchanged failure fingerprint with backoff. A failed attempt resumes its durable branch when
still applicable. Exhausted authorization, unavailable capacity, corrupt state, or repeated identical failures remain
explicit blocked/retry states with evidence. Reopen when the dependency, evidence, or base meaningfully changes.
Continue other independent eligible work while blocked dependencies wait.

Retain faithful incident fixtures beyond the current 48-hour capture TTL. Do not copy private raw prompts into
repository tests, PRs, or ordinary Actions logs. Give the developer enough request structure and recorded behavior to
reproduce the fault through a controlled diagnostic artifact or minimized fixture. Treat all captured text and issue
content as data, never workflow instructions.

## Independent payload acceptance

Freeze the acceptance manifest before the coding attempt. The coding agent may add regression tests but cannot remove
required cases, change expected results, disable validators, or waive failures. Bootstrap runs trusted validators from
its pinned package in a clean job.

Classify each captured request against the existing API contract:

- Valid supported request: require a correctly structured response and valid terminal behavior, including requested
  streaming, tool-call, model, and reasoning semantics where relevant.
- Invalid or unauthorized request: require the correct deterministic error response. Never change authorization or
  fabricate an HTTP 200 to make this case pass.
- Upstream dependency unavailable: retain as unresolved or inconclusive with evidence. It never counts as a passed
  repair.

Do not compare generated text verbatim. Validate protocol and task-specific invariants. Examples include no malformed
JSON, no missing or duplicated stream terminal, valid tool-call arguments, proper error framing, bounded time to first
useful output and completion, and no truncated stream being counted as success. A legitimate tool-call response need not
contain assistant text.

Use two complementary layers:

1. Deterministic regression: replay sanitized/minimized request fixtures through the real gateway handler with recorded
   upstream behaviors, including a stalled stream, upstream 5xx, disconnect, malformed event, and quota signal.
   Demonstrate the targeted defect on the previous code and its absence in the candidate. Preserve the fixed cost
   waterfall.
2. Live acceptance: replay the required valid cases and a small established healthy corpus against the immutable
   candidate deployment with equivalent relevant provider configuration and isolated credentials. Use the real
   authenticated API path, not just `/health`. Replay authorized effects only; neutralize external tool execution and
   state-changing operations. Do not duplicate customer side effects.

Persist live results keyed by candidate SHA/revision, validator version, corpus digest, configuration identity, and
time. Reuse immutable evidence where valid; repeat live checks when code/configuration changes or evidence is too old
for the release decision. Bound requests and provider spend under the existing policy.

A focused fix must pass every required case for its target failure family and introduce no regression in the healthy
corpus. Keep unrelated failing families open and work toward all supported captured cases passing. Do not require one
giant patch to cure all unrelated incidents before any improvement can ship. Record baseline failures explicitly; the
model cannot designate new exceptions after seeing candidate results.

For concurrency failures, preserve the recorded overlap/load pattern in a bounded test. Serial payload replay cannot
prove a race is fixed. Real traffic failure and latency observations remain necessary after promotion.

## Delivery and rollback (historical / superseded)

The proposed serial transaction was:

1. Save the focused candidate and open/reuse its PR. Record the immutable review base/head and enqueue Codex review
   immediately.
2. Run independent payload acceptance, the established healthy corpus, required deterministic CI, and the standalone
   Sentinel repository's canonical harness for Sentinel changes. Merge only through the enforced delivery path using an
   ancestry-preserving merge commit.
3. Build the exact merged SHA without moving stable traffic. Verify the immutable revision's body and headers against
   the full Git SHA and revision ID. If the base changed or the merged tree differs from the tested candidate,
   invalidate affected evidence and rerun acceptance.
4. Under the short shared deployment lock, record the previous proven healthy revision before promotion. When production
   is healthy, refresh its attestation. When production is already unavailable, retain the previously attested target
   from durable state, verify its immutable identity and configuration compatibility, and recover that transaction
   before starting a new ordinary release. Do not require a fresh healthy response from the broken app. Reconcile all
   existing VPS deployment writers so an unselected release cannot silently replace the selected `.data/current`.
   Persist promotion intent and an observation deadline before the VPS deployment command.
5. Promote only the identified candidate through the active VPS contract: from the clean VPS checkout, serialize
   `deno task deploy:vps` with `.data/deploy.lock` after required CI passes, and retain the immutable release under
   `.data/releases/<full-git-sha>`. Require a direct Mac-to-VPS authenticated inference request and `/health` to report
   the full Git SHA and `vps-<full-git-sha>` in both its body and identity headers; verify the public route after DNS or
   proxy changes. Do not call the retired Deno Deploy API or restore embedded Sentinel workers.
6. Keep Sentinel observation and evidence in the standalone `ubiquity/sentinel` repository. A kept release updates the
   healthy record only after the defined checks/window pass. Candidate-attributable acceptance failure triggers
   restoration of exactly the recorded previous VPS release. Verify restored identity and inference before reporting
   recovery.

Codex review completion and findings of any severity never gate this transaction. Existing deterministic checks and
production acceptance still do. Preserve the current observation window initially; moving it out of the developer runner
removes idle coding time without silently weakening acceptance. The next candidate may be prepared during observation,
but production promotions remain serialized.

Initial deterministic failure rules should use the current 30-second observation cadence. Restore a transaction-owned
candidate after three consecutive liveness or authenticated-inference failures when the recorded prior revision passes
equivalent control probes, or after a frozen gateway invariant fails twice on the candidate and passes on the prior
revision. A repeated managed-route identity mismatch is a release failure: first reconcile control-plane ownership, then
restore only if this transaction still owns the route. Do not overwrite a later legitimate release. Equivalent controls
require matching relevant credentials/configuration; an immutable preview URL does not imply production-equivalent
context. If both revisions fail from the same upstream dependency, record dependency failure and stop ordinary
promotions instead of cycling revisions. These initial thresholds are proposed fixed policy for the prototype, to be
validated in preview drills before activation.

Rollback must work when the current app times out, returns non-JSON, or returns HTTP 500. Use the durable transaction
plus the authoritative VPS release identity to prove ownership of the failing candidate. Do not require the broken app
to return healthy identity data before restoration. A stale observer cannot roll back a later release. If routing
identity or exclusive ownership cannot be established, retain the intent and report unresolved recovery; never guess a
revision from time or list order.

Arm recovery before promotion. If the VPS deployment command dies after selecting a release, reconcile the serving VPS
release and unfinished transaction. Loss of an observer is an uncertainty signal, not evidence by itself that the
candidate caused an outage; run independent acceptance and restore on the defined candidate failure conditions. A
missing transaction completion must never become an implicit healthy attestation.

All deployment operations, including bootstrap rollback and human/CI releases, use the same short promotion authority
and generation checks. Keep model calls and long tests outside that lock. After runner loss, verify or cancel the old
executor before reclaiming promotion ownership; an expired lease alone does not stop a stale process.

Revision rollback changes serving code; do not assume it restores KV contents, provider credentials, or external
effects. Keep destructive migrations, production secret changes, and incompatible persistent-data changes outside the
automatic repair lane. After rollback, leave Git history intact and prepare a focused revert or forward fix through the
normal PR flow. Do not force-push development or republish the rejected candidate automatically.

## Sentinel self-upgrades (historical / superseded)

The embedded planner/worker and self-upgrade design above is retired. Do not add or restore Sentinel workflows,
schedules, workers, deployment credentials, or controller entrypoints in this repository. If bounded self-upgrades,
queue selection, checkpoint recovery, or review intake remain wanted, implement and validate them in the standalone
`ubiquity/sentinel` repository. Keep serving-code acceptance, exact-build evidence, and release/rollback execution
aligned with the VPS contract in `AGENTS.md`; changing application code here must not implicitly activate Sentinel.

## Independent asynchronous review (historical / superseded)

The proposal called for native Codex review in a separate workflow with its own concurrency group and frozen base/head.
Current review scheduling and intake belong to the standalone `ubiquity/sentinel` repository; this repository must not
restore that embedded workflow. The historical comparison rule was not to derive a new base from current development
after merge. Git ancestry after merge was expected and did not make the original diff unreachable.

Persist pending review before dispatch. A failed dispatch or unavailable reviewer stays retryable and does not block
delivery. The reviewer never holds coding or deployment locks. Validate the whole result and exact target identity
before ingesting; preserve original finding text and fingerprints. Malformed evidence remains an ingestion failure
without partial salvage.

Feed completed findings into the next eligible repair selection. A later PR must prove the finding is fixed on current
code; merging the reviewed PR is not proof of remediation. The proposal retained `docs/sentinel-review-backlog.md` as an
official human-readable backlog view; current review records and backlog ownership belong to standalone Sentinel.

## Timing and uptime limits (historical / superseded)

The original proposal considered GitHub Actions for coding, tests, PR delivery, and release operations. That embedded
automation is superseded: scheduling, agents, and incident dispatch belong to the standalone `ubiquity/sentinel`
repository, and serving releases use the VPS deployment contract in `AGENTS.md`. GitHub documents a five-minute minimum
schedule interval and possible delayed or dropped scheduled jobs; this historical Actions-only design therefore could
not promise recovery within seconds.
[GitHub scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

For tighter recovery timing, the historical recommendation was a tiny independent deterministic watchdog on an already
managed independent host or separate deployment. Any surviving watchdog idea must be implemented in the standalone
Sentinel repository and must invoke the approved VPS release contract; it must not restore embedded workflows or use a
separate Deno Deploy app.

Prevent immediate request storms with existing deterministic provider controls: bounded concurrency, request deadlines,
backoff with jitter, and circuit breakers keyed to the actual provider/account failure. Change these only for a
demonstrated incident. Preserve the rule that a timeout or upstream 5xx cannot authorize escalation to the next paid
tier. Sentinel repairs the recurring cause while these controls limit damage.

## Implementation sequence and acceptance (historical / superseded)

The historical sequence used one writer and small PRs. Its ideas are retained only as evidence; do not execute this
sequence or recreate its embedded orchestration.

1. Restore the safety boundary: pinned bootstrap, independent provider/controller records, protected promotion executor,
   and rollback that survives unavailable app health. Demonstrate with two immutable preview revisions, a failed
   candidate, and a terminated release worker. Reuse exact revision attestation and promotion code.
2. Deliver one incident end to end: one JSON queue, deterministic priority, faithful capture fixture, strict trusted
   validator, one Luna candidate, one PR, exact merged deployment through the VPS contract, and independent observation
   by standalone Sentinel. Keep review dispatch and unresolved evidence in `ubiquity/sentinel`; do not run competing
   release controllers in this repository.
3. Complete and verify asynchronous review result intake in the standalone Sentinel repository. Prove a review can
   finish after merge and enter its backlog while urgent repair proceeds. Prove malformed review data contributes no
   findings and does not stop incident work.
4. If controller self-upgrades and ordinary issue fallback remain wanted, enable and validate them in standalone
   Sentinel under its own acceptance and rollback policy. Do not add a controller or orchestration entrypoint here.
5. Verify every imported unresolved identity has a preserved disposition and explicit deduplication evidence in the
   standalone Sentinel records. Keep this document, historical evidence, and unfinished user-owned work; do not restore
   the superseded matrix or orchestration entrypoints in this repository.

Required evidence matrix:

| Scenario                                   | Required observable result                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| One captured valid-request defect          | Previous handler fails the fixed case; candidate and deployed merged revision pass it and healthy corpus   |
| Duplicate incident storm                   | One work item with increased frequency; bounded dispatch and one active coding attempt                     |
| Invalid request                            | Correct rejection remains; no fake success or disabled auth                                                |
| Transient/total upstream outage            | Bounded retries and explicit unresolved dependency; no false pass or forbidden paid-tier escalation        |
| Corrupt review batch                       | Exact evidence retained, no partial ingestion, incident repair proceeds                                    |
| Slow review finishing after merge          | Original base/head reviewed; result ingested later; release timing unaffected                              |
| Worker timeout after edits                 | Durable saved candidate and bounded continuation, not lost runner-only work                                |
| `/health` responds 200 but inference fails | Candidate acceptance fails on real API behavior                                                            |
| Production app cannot answer               | Bootstrap restores the exact attested prior revision using control-plane identity                          |
| Runner dies after promotion                | Independent bootstrap observes/reconciles transaction and applies the defined acceptance/rollback decision |
| Stale observer races newer promotion       | Generation and exact routing checks prevent rollback of the later release                                  |
| Broken standalone Sentinel entrypoint      | Standalone Sentinel starts from its pinned controller and preserves the previous controller                |
| No active incident or review work          | An eligible issue is implemented and delivered through the same acceptance path                            |

The standalone Sentinel repository owns its canonical local harness and focused deterministic cases for these contracts.
This repository must instead validate the active VPS release contract through required CI, direct authenticated
inference, and `/health` identity checks. Live replay is a separate explicitly evidenced stage; a hermetic harness
cannot establish deployed inference or rollback. Do not deliberately take down production to prove recovery. Use preview
drills first and perform any production fault exercise only with specific approval.

For repository implementation, follow the required commit, push, PR, asynchronous review, deterministic CI, merge,
deployment identity, ancestry, and clean-development handoff rules. This planning document does not authorize executing
the redesign or changing repository protection settings in this turn. Report source, local tests, preview proof,
production proof, controller activation, and unresolved cases as distinct outcomes.

## Sources and design limits

- Repository code and Actions evidence listed above are the primary basis for this proposal.
- [Deno timeline documentation](https://docs.deno.com/deploy/reference/timelines/) was cited by the original proposal
  for selecting and locking an existing revision for rollback without rebuilding. It is historical context only; active
  promotion identity requirements come from the VPS contract in `AGENTS.md` and the current implementation.
- [Official OpenAI GitHub Action documentation](https://learn.chatgpt.com/docs/github-action) establishes independent CI
  execution and output capture; it does not establish this repository's native review implementation or model/account
  availability. Preserve the current native review and owner-selected model contracts.
- A narrow deterministic test suite plus live observation reduces release risk but cannot prove correctness for every
  future payload or upstream behavior. The regression corpus must grow from real failures, and operational success must
  measure resolved incidents and recovery time rather than green workflow counts.
