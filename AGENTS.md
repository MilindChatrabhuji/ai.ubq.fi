# Project Guidance

## Runtime and Migration Scope

- Run first-party TypeScript directly with pinned Bun 1.4.0, using root `package.json` dependencies and frozen `bun.lock` installs. Strict no-emit TypeScript checking is a separate required gate; Bun execution alone does not type-check the program. The 2026-10-14 decision in `docs/DECISIONS.md` supersedes Deno-only runtime, dependency-location, and gate commands only for this repository.
- Preserve the `node:http` transport delivery receipt and the actual pinned `ws@8.18.3` custom-header, payload-limit, and Unix-domain-socket contracts. Use the `#http` WebSocket loader rather than Bun's bare-`ws` substitute. Quota and paid-accounting settlement require the existing semantic terminal and actual delivery outcome, with one admission lifetime and exactly one settlement; durable request writes must drain before telemetry and KV closure.
- Disable automatic dotenv discovery for isolated checks and runtime launchers. Immutable launchers use `--no-env-file --no-install`, explicitly load only the repository-root `.env`, and refuse missing or corrupt runtime, dependency, or native artifacts. Prepare and bind artifacts before immutable publication; never download, install, or compile at application startup. Auxiliary native guard or KV builds do not compile application TypeScript.
- Treat legacy Deno V8 and Bun JavaScriptCore storage value codecs as incompatible. Open only a correctly codec-marked Bun database at `.data/kv-bun.sqlite3`; retain the legacy `.data/kv.sqlite3` untouched. Conversion requires a stopped source, consistent backup, explicit new destination, and validation of raw keys, revisions, absolute expiry, and typed values. Returning to Deno after Bun writes requires reverse conversion of the latest stopped Bun state, a verified private rollback receipt, and the supported legacy release/profile; restoring a stale backup loses writes. Never convert a live database during startup or deployment.
- Pinned Deno is permitted only for the explicit offline legacy V8 codec and reverse-conversion helper, plus the external tool-owned evidence helper. It is not the application runtime or an ordinary build, test, or CI dependency. Preserve real OS read/write/network/process confinement; unsupported platform enforcement must fail closed rather than use a JavaScript permission facade.
- The Bun migration PR does not authorize production or Mac service activation, live database conversion, credential changes, or provider-credit spend. Retain every credential, routing, accounting, review, ownership, immutable-release, and client-acceptance rule below.

## Local Credential Recovery Safety

- A request to repair one invalid local provider account does not authorize invalidating, revoking, rotating, or
  replacing other accounts' credentials or API keys. Never perform a bulk credential reset for a single-account repair.
- Before attempting OAuth refresh, login, or credential upload, identify the exact account and inspect the existing
  credential sources without exposing secrets. Check the access token's expiry, not the ID token's expiry or file
  timestamp. Do not try stale refresh tokens while a valid credential for that account may already exist.
- Treat OAuth refresh as a credential mutation: shared or synchronized refresh tokens can affect other clients and
  hosts. Do not refresh or replace shared credentials without first establishing their ownership and the effect on
  existing sessions. Preserve the user's synchronized auth files and all unrelated API keys.
- Do not use `POST /admin/codex/auth` as a harmless validation probe. It can refresh upstream credentials and replace
  the local account pool entry, model catalog, and runtime configuration. Before using it, establish those effects and
  preserve the affected local state so unintended local changes can be recovered. A local backup cannot undo upstream
  token revocation or rotation.
- Verify recovery through the requested localhost inference endpoint and confirm that existing clients still work. An
  upload HTTP 200, a valid model catalog, or a healthy server response alone is not recovery proof. If a repair breaks
  existing access, stop credential mutations, inspect the exact failure, and recover only the affected state.

- Keep OpenAI-compatible endpoints and request bodies aligned with the official OpenAI API schema. Do not add
  gateway-only aliases, sentinel values, or alternate wire formats.
- Keep `GET /v1/models` without query parameters strictly OpenAI-compatible. Treat `GET /v1/models?client_version=X.Y.Z`
  as a separate Codex-native compatibility contract that returns the rich upstream `{ "models": [...] }` catalog for
  that exact client version; never describe the versioned response as an official OpenAI schema.
- Treat Codex CLI compatibility as a first-class gateway contract for `/v1/responses`. Accept fields emitted by
  supported Codex CLI versions through explicit compatibility extensions that remain separate from the official OpenAI
  schema allowlists and drift checks; do not present those extensions as official OpenAI fields.
- Treat the uploaded Codex CLI model catalog as the source of truth for reasoning tier strings. Preserve every non-empty
  advertised tier verbatim and do not enforce a hard-coded tier allowlist or tier membership check.
- Never advertise a reasoning tier a source omitted. The endpoint rejects values its catalog does not list
  (`gpt-6-astra` answers `reasoning.effort: "none"` with a 400 naming low..max), so an injected tier is a promise the
  gateway cannot keep. Normalize a null effort in upstream metadata to `none`, because that null is the upstream's own
  no-reasoning value, and preserve `none` verbatim at the Codex upstream request boundary: never translate an explicit
  no-reasoning request to an omitted field or `null`. A model no source describes still defaults to `none` alone.
- Mirror Codex CLI wire translation for advanced presets: send `ultra` upstream as `max`. Treat Codex's automatic
  multi-agent delegation for `ultra` as client-side orchestration, not as a distinct upstream reasoning effort.
- Use this fixed inference waterfall, in cost order: eligible Codex subscription capacity first, Surplus Intelligence
  second, and OpenLux last. Advance past subscriptions only after authoritative full-pool unavailability as defined
  below; advance between paid tiers only after authoritative quota or capacity signals. Do not treat a transient
  timeout, stalled stream, network or read error, or upstream 5xx as quota exhaustion.
- Route ordinary Codex inference through one durable global active subscription shared by every principal, key, and
  model: bootstrap the first eligible configured account, keep it despite headroom, idle time, restarts, old per-key
  affinities, reorder, or successful same-identity credential refresh, and move it only for authoritative
  model-applicable quota or capacity exhaustion, a classified current-credential invalidity, or removal/replacement of
  the account in the auth pool. Never restore a retired per-key affinity override or a capacity-balancing order, and
  advance the provider waterfall only after fresh strong proof that every selected pool account has applicable quota or
  capacity exhaustion or invalid credentials matching its current credential fingerprint. Keep quota-only proof separate
  for reset eligibility and redemption; preserve the existing paid limits and provider selection.
- Production runs on `codex@vps.pavlovcik.com` in `/home/codex/repos/ubiquity/ai.ubq.fi`. Deno Deploy hosting is
  retired; do not deploy this service there.
- Keep the service configuration in `ops/` and link its systemd files from `/etc/systemd/system/`. Keep secrets in the repository-root `.env`, the marked Bun KV in `.data/kv-bun.sqlite3`, the retained legacy Deno KV in `.data/kv.sqlite3`, and immutable releases in `.data/releases/<full-git-sha>`.
- Serialize VPS deployment writers with `.data/deploy.lock`. Run `bun run deploy:vps` from the clean VPS checkout
  after required CI passes. The launcher resolves `.data/current` once so live code and assets stay on the selected
  release.
- A deployment is accepted only when a direct Mac-to-VPS authenticated inference request succeeds and `/health` returns
  the full Git SHA and `vps-<full-git-sha>` in both its body and identity headers. Verify the public
  `https://ai.ubq.fi/health` route after a DNS or proxy change.
- Cloudflare must retain the proxied `ai.ubq.fi` A record and the hostname-specific Worker exclusion route; the wildcard
  Worker otherwise sends requests to retired Deno hosting.

## Upstream Provider Constraints

- Cerebras does not support streaming for `gpt-oss-120b`. Treat that model as non-streaming whatever the request asks
  for: never depend on progressive output, never add streaming-only behavior or tests for it, and do not "fix" the
  gateway into assuming incremental delivery. The upstream still answers `stream: true` with SSE frames (a 2026-09-20
  probe received multiplexed deltas), but the gateway buffers this route and replays the finished completion in a burst,
  so a client-visible `text/event-stream` here is not incremental generation.
- A Cerebras response that stops at the token budget can carry reasoning only, with `content: null` and
  `finish_reason: "length"`. The gateway fails that closed as `cerebras_upstream_invalid_response` (502) rather than
  returning an unusable empty completion, so expect that status when `max_completion_tokens` is too small for a
  reasoning model instead of treating it as a transport fault.

## Sentinel Retirement

- Sentinel automation has moved to the separate `ubiquity/sentinel` repository. Do not restore embedded Sentinel
  workflows, schedules, incident dispatch, or deployment credentials in this repository.
- The owner approved authenticated failure capture/export, bounded upstream replay data, and exact-build receipts on
  2026-09-07 for the standalone Sentinel integration. Keep scheduling and agents standalone; live activation and
  promotion ownership transfer remain separate from this integration.
- Before production Bun cutover, the standalone Sentinel integration owner must authorize and accept its frozen-source causal reader against the captured Bun source and trusted offline runtime/dependency artifacts, with frozen hashes, no dotenv or automatic installs, equivalent OS isolation, and proven process-execution denial. This migration transfers no Sentinel checkout or caller-write authority. Legacy captures remain bound to their recorded source SHA; source PR or gateway tests do not prove that external reader gate.

## Rolling Local Code Review Workflow

- Ship a bounded pull request for each unit of work and merge it only after the required deterministic CI and branch
  protections pass, then test the merged result, continue with the next pull request, and collect review findings from
  earlier pull requests only after the fact.
- Run reviews with the actual local Codex review mode: `codex review --base <base-branch>` for a pull request's
  committed diff (fetch the base and head first), or `codex review --commit <sha>` / `codex review --uncommitted` for
  other targets; `codex exec review` runs the same review mode non-interactively. Choose the reviewer with
  `review_model` where a dedicated review model is configured (the gateway exposes `codex-auto-review`).
- Never request a review by prompting a normal-mode session, and never post `@codex review` or invoke the hosted Codex
  GitHub app: external review requests are retired.
- Review latency is never a merge gate. A review that has not completed, an unreviewed pull request, or a review run
  that could not start must not block delivery, merging, testing, or the next unit of work.
- No review finding of any severity (P0, P1, P2, or P3) gates merge, delivery, testing, or the next unit of work:
  deterministic CI and branch protections are the only merge gates. Every severity enters the asynchronous official
  review backlog after the fact, with P0 then P1 priority (P0 before P1 before P2 before P3) for selection as normal
  future work. Every claim and remediation carries exact evidence (exact reviewed head and base SHA, the review command
  and model identity, and the original finding text), and the existing production preview, health-identity, monitoring,
  and acceptance safeguards remain mandatory for every deployed candidate.
- Treat malformed, incomplete, or identity-mismatched review data as fail-closed: preserve the exact evidence, ingest
  nothing, and surface the failure. Never drop findings, salvage a partial parse, or mark a failed review complete.

## Repository Completion and Checkout Handoff

- Do not leave completed or accepted work only in a worktree, local branch, or unpushed commit. Commit and push every
  completed task branch, integrate it into `development` through the normal pull request and review workflow using an
  ancestry-preserving merge commit, and push the resulting `development` state.
- Immediately before declaring a task complete, fetch `origin/development`, prove every accepted task-created tip is an
  ancestor of the refreshed `origin/development`, and prove local `development` matches `origin/development`.
- Leave the repository-root checkout clean, on `development`, and fast-forwarded to `origin/development`. If another
  writer actively owns that checkout, preserve its state and coordinate until its completed work is integrated; never
  switch or overwrite an active or dirty checkout to satisfy this handoff rule.
- Preserve unfinished work in its existing owned branch or worktree and report its owner and next action. Do not merge
  unknown or incomplete work, discard dirty state, or describe accepted work as complete while it remains outside the
  `development` Git graph.

## Lint, Format and Type Gates

- Run `bun --no-env-file run verify` (or `sh scripts/verify.sh`) before declaring any change ready. The public script is `bun run verify`; it aggregates strict TypeScript checking, Prettier, ESLint, Knip, the file-size ratchet, and the configured deterministic test segments rather than stopping at the first failure. Both root and `tools/lint/bun.lock` must exist before a frozen install; never regenerate either lockfile to make verification pass or fall back to another package manager.
- Prettier owns every supported first-party format through `.prettierrc`, `.prettierignore`, and `scripts/format.sh`: TypeScript and `.mjs` retain 160 columns, supported non-TypeScript formats retain 120, and Markdown preserves paragraph wrapping. Use `bun --no-env-file run format:check`; do not add a Deno formatter fallback or apply a whole-repository autofix.
- Run `bun --no-env-file run build` and `bun --no-env-file run test` after any `--fix` run. `build` delegates to the strict no-emit `check` task; the explicit TypeScript checker is the type authority, and successful execution or transpilation cannot replace it. Isolated test children disable dotenv and auto-install, retain their original named environment profiles, and run behind the actual supported OS fixture-network boundary. `verify` includes the existing offline benchmark test profile once; stress, live e2e, and live benchmark probes remain separately selected.
- The TypeScript check and test suite decide whether a lint fix is correct. Never add `eslint-disable`, `@ts-ignore` or `as any` to silence a finding: if a finding is deliberate-by-design, narrow it in `tools/lint/eslint.config.mjs` with the measurement recorded in a comment, the way the existing DIVERGENCE entries do.
- File-size no-growth is enforced by `scripts/file-size-ratchet.ts`: source files cap at 1000 lines and tests at 1500,
  and `file-size-baseline.json` records a per-file ceiling for every grandfathered oversized file. Never raise a
  recorded ceiling or hand-add an entry; after shrinking a recorded file run `bun run size:update`, which only lowers
  or drops ceilings and refuses to record new debt.
- Declare first-party runtime and development dependencies in the root `package.json` and pin the install graph in `bun.lock`. Preserve the selected dependency versions and repository import/type contracts; a runtime migration is not permission for unrelated upgrades.
- Use the committed TypeScript configuration with explicit Bun and Node types for the application and typed lint environment. Do not restore a blanket Deno global shim or the retired `.deno-types.d.ts` generation step.

## Codex Orchestration

- Treat each implementation and delivery unit as a versioned work contract. Before editing, state the objective, non-goals, invariants, provider or behavior matrix, owned and prohibited paths, acceptance surface and commands, unknowns, and stop condition. Material requirement changes increment the contract version and mark affected code, tests, and evidence stale before further implementation.
- Resolve material assumptions before implementation. Provider, catalog, schema, and host semantics must come from a current observation or an explicitly named fallback behavior; do not implement a guess that a later answer may replace. For multi-provider routing, collect the provider matrix once during discovery and derive one implementation strategy before code.
- For work spanning discovery, implementation, verification, and deployment, separate controller, research, implementation, verification, and delivery responsibilities when delegation is enabled and authorized. Discovery returns a compact matrix; one worker owns writes; verification returns exact gates and evidence; delivery returns health and inference receipts. The controller integrates summaries, paths, hashes, and receipts rather than replaying raw logs.
- Define a long operation's result, expected runtime, observable progress, recovery action, and call and output budget before starting it. Batch independent reads and commands, request only the output needed, and stop a phase with a compact checkpoint when it exceeds its expected time or produces no new evidence.
- Do not re-enter the model only to ask whether external work has finished. Use one persistent execution handle or delivery watcher, emit state changes only, and return once with the terminal result. A poll is justified only by changed external state or a confirmed-live handle.
- Make delivery a bounded pipeline after an authorized push: identify the exact CI run for the pushed SHA, wait for terminal success, run Mac and VPS deployment concurrently because their hosts and deployment locks are independent, then collect both health and authenticated inference receipts before acceptance. A failed CI run stops deployment, and every claim remains bound to the exact green SHA.
- Preserve the rule that CI contains no automatic deployment. A local delivery watcher may wait for CI and then invoke the separately authorized deployment commands; it must not add a hosted automatic deployment trigger.
- Bind pre-push evidence to the exact commit tree. After all writers stop, run the full `bun --no-env-file run verify` gate once on the final tree and record the full commit SHA, tree hash, and result. Any subsequent source edit invalidates that receipt; focused tests, typechecking, lint, or a queued CI run are not substitutes.
- Run `bun --no-env-file run size:check` immediately after a large source edit as an early signal, but retain the full `verify` run as the final gate.
- Before declaring readiness, reconcile the contract version, changed paths, exact commit and tree, CI run, deployment identities, and live acceptance evidence. Reject stale or partially matching receipts.
