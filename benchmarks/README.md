# Benchmark foundation (m02)

Deterministic, hermetic task benchmark for the Cerebras GPT-OSS Harmony agent foundation. Owned by worker
`m02-benchmark-foundation-16ed155973`; the shared result contract in [`schemas.ts`](./schemas.ts) is the agreement point
for the adapter module (`m03`), the canonical tool layer (`m04`) and the reliability layer (`m05`).

Everything here is local and deterministic by default. The bundled `reference` adapter replays recorded trails, so **no
external inference runs unless an adapter is registered that deliberately calls a model, and the runner refuses to run
external-inference adapters until an approved live gate exists (m03/m05)**.

## Commands

From the repository root:

```sh
deno task benchmark:run -- --configs=reference                 # hermetic default: all 25 tasks
deno task benchmark:run -- --configs=reference --tasks=nav-*   # selection by id/glob/category
deno task benchmark:run -- --configs=reference --tasks=category:long --limit=2
deno task benchmark:summary                                    # aggregate benchmark-runs (no inference)
deno task benchmark:summary -- --runs=some-other-root --json
deno task benchmark:fixture-revision                           # prove declared fixture revisions
deno task benchmark:test                                       # focused hermetic test suite
deno run --allow-read --allow-write --allow-run=sh,git \
  benchmarks/compare.ts                                        # m05 context evidence (no inference)
```

`benchmark:run` executes only adapters registered in `defaultAdapters()`. The registered canonical config **C** is a
live-inference adapter that carries no transport by default, so the hermetic runner refuses it
(`requiresExternalInference: true`) until an approved live gate exists — no environment variable, CLI flag or secret is
ever read. `--configs=all` therefore refuses on `C`; construct `createCanonicalAdapter({ transport })` (fake in tests)
to run it.

Run artifacts (`benchmark-runs/`, git-ignored):

```
benchmark-runs/
  runs/<run_id>/trajectory.jsonl   # one validated event per line
  runs/<run_id>/result.jsonl       # one BenchmarkResult record
  summary.json                     # written by the summarize command
  tmp/                             # disposable fixture workspaces (removed after each run)
```

The runner accepts `--` task separators exactly as `deno task` forwards them; plain
`deno run --allow-read --allow-write --allow-run=sh,git
benchmarks/runner.ts --configs=reference` works identically.
`benchmark:run` and `benchmark:test` carry the trusted runner's own unscoped `--allow-write` because Deno refuses
symlink creation under path-scoped grants; the spawned shell commands stay confined to the disposable workspace by the
platform sandbox, and their file changes are checked against `allowed_write_scope`. No environment variables are read
and no secrets are involved.

## Layout

```
benchmarks/
  schemas.ts          # shared result contract: manifest / trajectory / result / summary
  manifest.ts         # manifest loading + selection (id, glob, category:<name>)
  fixture.ts          # disposable workspaces, fixture revisions, write-scope enforcement
  adapter.ts          # adapter contract + reference (scripted) adapter over the canonical m04 tool layer
  oracle.ts           # deterministic verification + file/git oracles
  metrics.ts          # metric derivation + aggregation + formatting
  runner.ts           # CLI: run selected configs
  summarize.ts        # CLI: summarize existing JSONL without any adapter execution
  fixture-revision.ts # CLI: verify declared fixture revisions
  tasks/*.json        # 25 deterministic task manifests (5 per category)
  fixtures/<id>/…     # disposable fixture snapshots (snapshots; regenerable)
  tools/gen-fixtures.ts # regenerates fixtures and prints content revisions
  tests/*.test.ts     # focused hermetic tests (see m05 section for new suites)
  reliability.ts      # m05: derives the reliability summary from event streams
  compare.ts          # m05: full-vs-structured context + surface evidence CLI

src/harmony/tools/    # canonical model-facing tool layer (owned by m04)
  schemas.ts          # stable tool schemas + validation + m01 ToolDefinition rendering
  result.ts           # machine-readable ToolResult envelope + closed ToolErrorCode set
  backend.ts          # injected Workspace/Browser/Plan backend contracts + path boundaries
  router.ts           # runTool: validation, boundaries, dispatch, deterministic formatting
  fakes.ts            # deterministic offline fakes (workspace, shell, browser, plan)

src/harmony/reliability/  # m05 reliability + context layer (owned by m05)
  feedback.ts         # deterministic multi-issue tool-argument validation feedback
  loops.ts            # duplicate + semantic-loop detection (effect signatures)
  retry.ts            # retry policy: transient codes retried, deterministic codes blocked
  verify.ts           # verification requirements, guard rules, false-completion detection
  state.ts            # structured task state + replay + stateContract (canonical JSON)
  context.ts          # transcript compaction (short/medium/large) + token estimation
  surfaces.ts         # compact vs broad model-facing surfaces (broad is experimental)
  failure.ts          # reliability failure classification (advisory for the runner)
  harness.ts          # runReliabilityHarness: the deterministic C agent loop
```

## Shared result contract

`BENCHMARK_SCHEMA_VERSION = "1.0"`. Adapters A/B/C/D must write this exact shape; m05 builds reliability detection on
top of it.

### Task manifest (`tasks/*.json`)

Each task declares: `id`, `category` (`navigation | coding | sequential |
failure | long`), `title`, `description`,
`fixture` (snapshot dir), `fixture_revision` (`sha256:<hex>`, validated against the snapshot on every run),
`timeout_ms`, `max_tool_calls`, `min_tool_calls`, `min_model_calls`, `allowed_write_scope` (globs, `!` negates),
optional `git` (`init`/`history`), `verify.command`, `oracle.file_checks` / `oracle.git_checks`, and an optional
`scripted_trail`.

Success requires all of:

1. no run-level failure class (see below),
2. `verification.command` exits 0 within its timeout,
3. every declared oracle check passes (file content and/or git state),
4. recorded tool calls ≥ `min_tool_calls` and model calls ≥ `min_model_calls`.

The corpus contains 25 tasks: 5 navigation, 5 coding, 5 sequential-tool, 5 injected-failure, and 5 long-horizon (four
tasks exceed 20 tool calls, one exceeds 10).

### Trajectory events (`trajectory.jsonl`, one JSON object per line)

```ts
{ type: "run", at, run_id, task_id, category, config_id, adapter_id, fixture, fixture_revision }
{ type: "model_request", at, id, model, message_count, input_tokens, output_tokens, tool_count }
{ type: "model_response", at, request_id, content?, tool_calls?[], finish_reason? }
{ type: "tool_call", at, id, tool, arguments, valid, invalid_reason?, is_wrong_tool?, is_repeated? }
{ type: "tool_result", at, id, ok, output?, error?, error_code?, duration_ms? }
{ type: "verify", at, command, passed, exit_code?, timed_out, output? }
```

Contract rules for adapters:

- record `run` as the first event (the runner does this),
- for every **attempted** tool invocation record a `tool_call` event followed by exactly one `tool_result` with the same
  `id`, including invalid calls (`valid: false`) and wrong-tool calls (`is_wrong_tool: true`),
- token fields on `model_request` are authoritative for `input_tokens` / `output_tokens` / `context_size`,
- never decide success yourself: the runner always runs the declared verification and oracle, so failures keep their
  full trajectories.

### Result record (`result.jsonl`)

`schema_version`, `run_id`, `task_id`, `config_id`, `adapter_id`, `fixture`, `fixture_revision`, `started_at`,
`ended_at`, `wall_time_ms`, `success`, `failure_class`
(`timeout | adapter_error | tool_call_limit |
min_calls_not_met | verification_failed | fixture_revision_mismatch`),
`failure_detail`, `metrics`, `verification`, `oracle`, `required_calls`, `trajectory`, `created_at`.

`metrics` is derived from the event stream and contains: `model_calls`, `tool_calls`, `invalid_tool_calls`,
`wrong_tool_calls`, `repeated_calls`, `tool_errors`, `recovery_attempts`, `input_tokens`, `output_tokens`,
`context_size` (largest request input+output).

Derivation rules (deterministic, see `metrics.ts`):

- `invalid_tool_calls`: `tool_call.valid === false` calls, plus `tool_result.error_code === "invalid_args"` results,
- `repeated_calls`: explicitly flagged calls plus consecutive identical (tool, canonical arguments) calls whose
  predecessor **succeeded** (retries after failures count as recovery, not duplication),
- `recovery_attempts`: distinct failed call ids later followed by a successful call of the same tool.

## Adapter contract (m03/m04/m05)

```ts
interface BenchmarkAdapter {
  configId: string; // stable result id: A, B, C, D, ...
  name: string;
  description: string;
  requiresExternalInference: boolean; // refused by the runner when true
  run(ctx: AdapterRunContext): Promise<void>;
}
```

`AdapterRunContext` provides `runId`, `task`, `workspace`, `record(event)`, `checkToolLimit()`, `signal` (whole-run
timeout), `time()`. Register adapters in `defaultAdapters()` (`adapter.ts`); the runner refuses
`requiresExternalInference: true` adapters with a clear error until an approved live-inference gate exists. `m05`
decides failure-classes and reliability semantics; the runner only classifies terminal causes.

## Fixtures, revisions and write scope

- Writes never leave the repository: the runner copies `benchmarks/fixtures/<id>` into `benchmark-runs/tmp/<run_id>` (a
  disposable directory; removed after the run) and the adapter may write only there.
- `allowed_write_scope` globs are enforced by the canonical tool layer (`write_scope` error code); paths are resolved
  inside the workspace root. `shell.exec` runs inside the supported platform sandbox (bubblewrap on Linux, Seatbelt on
  macOS), and the filesystem changes it makes are checked against the same scope afterwards: unauthorized creations,
  edits and deletions are rolled back inside the disposable workspace and rejected with a deterministic `write_scope`
  failure. A missing or failing sandbox is a command failure, never an unsandboxed fallback.
- `fixture_revision` is a SHA-256 over sorted relative paths + contents (prefix `fixture-v1`).
  `benchmark:fixture-revision` proves all declared revisions match the snapshots; the runner fails a run on mismatch
  before the adapter executes.
- `gen-fixtures.ts` regenerates only `benchmarks/fixtures/` and prints the current revision for every task; never run it
  against other directories.

## Canonical tool layer (m04)

The compact model-facing tool surface is owned by `src/harmony/tools/` (m04) and is the single source of truth for the
nine tools: `filesystem.read/find/search`, `browser.search/open/find`, `shell.exec`, `editor.apply_patch`, and
`task.update_plan`.

- Stable schemas: `schemas.ts` holds the JSON Schema of every tool, `validateToolArguments` type-checks every present
  argument (unknown keys rejected; required string parameters non-empty; `editor.apply_patch` `old`/`new`/`add` and
  `filesystem.find` `pattern` stay optional), and `toolDefinitions` renders the surface as m01 `ToolDefinition` entries
  with one uniform `strict` value.
- Machine-readable envelopes: every `runTool` call returns `{ ok, output?, error?, error_code? }` plus
  `exit_code/stdout/stderr` for `shell.exec`; failures use the closed set
  `invalid_args | path_escape | write_scope |
not_found | exec_failed | timeout | patch_failed | unavailable | internal`.
- Boundaries: paths are normalized inside the workspace root (absolute paths and `..` segments are `path_escape`
  rejections) and writes must match the manifest `allowed_write_scope` (`write_scope`).
- Replaceable backends: `WorkspaceBackend`/`BrowserBackend`/`PlanBackend` are injected; `fixture.ts` is bridged into the
  canonical contract by `adapter.ts`, and the reference adapter runs browser/search/find and plan tracking against
  deterministic offline fakes (`fakes.ts` — no browser daemon, no network). A configuration without browser support gets
  the `unavailable` error code instead.

Tool failure is always an envelope, never an exception, so trajectories record invalid calls, `patch_failed` edits and
failed commands with identical bookkeeping.

## Deterministic oracles and verification

`verify.command` runs via `sh -c` inside the workspace with its declared timeout (default 20s). Oracle checks:

- `file_checks`: `exists | equals | contains | regex` (with `invert`),
- `git_checks`: `commit_count | head_message | worktree_clean |
file_committed` — fail closed when the task declares
  no git repository.

Git fixtures (`nav-005`, `seq-004`) initialize a repository rooted inside the disposable workspace, so git never touches
the surrounding checkout. History fixtures (`nav-005`) commit full-tree snapshots in order as the repository history;
the verification script ships inside the final snapshot.

## Reliability and context layer (m05)

`src/harmony/reliability/` implements the m05 semantics; the canonical harness (`runReliabilityHarness`) composes them
into benchmark config **C**:

- **Deterministic argument feedback**: every invalid call is validated in one pass; every issue (unknown tool,
  unknown/required/typed/non-empty/array items) gets a stable code and a corrective hint, and the call is never
  executed. The envelope code stays `invalid_args`.
- **Duplicate and semantic-loop detection**: identical adjacent calls are blocked (`duplicate_call` after success,
  `repeated_failure` after a deterministic failure) and recorded with `is_repeated: true`. Semantic loops are detected
  from recurring call patterns or three equal (tool, arguments, effect) signatures; a loop guard fires after a streak of
  three and a final answer is rejected while the loop is active.
- **Retry policy**: only transient codes (`timeout`, `internal`, `unavailable`, `transport`) may be retried (default one
  retry, fixed backoff, configurable). Deterministic codes (`invalid_args`, `path_escape`, `write_scope`, `not_found`,
  `patch_failed`, `exec_failed`) are never re-executed with identical arguments — the same call in the same state yields
  the same result.
- **Verification requirements**: every successful `editor.apply_patch` creates a pending verification for its path; it
  is satisfied by a later read of the path containing the written marker, a successful command naming the path, or the
  task's declared verification command (exact match). A failed command or edit must be resolved by a later successful
  command, a successful write of the same path, a read of the same path (review evidence), or a revision of the plan
  before any final answer.
- **False-completion prevention**: while verifications are pending, failures unresolved, or a loop is active, the
  harness rejects the final answer with a deterministic `[guard] ...` message; repeating the same final without any
  intervening action aborts with `false_completion`.
- **Structured task state**: `state.ts` derives the phase, plan, reads, writes, verification state, unresolved failures
  and final attempts by replaying the same rule engines; `stateContract` is the canonical JSON of the durable
  projection. Diagnostic counters (duplicates, loops, invalid calls) are reported separately.
- **Compaction policies**: `context.ts` defines short (4k tokens, aggressive), medium (8k) and large (16k, minimal)
  tiers. Failed calls, patches, plan updates, shell commands and guards are never dropped; stale reads and old explore
  results are. Dropping is always whole pairs and never alters content, which makes the structured-state contract
  invariant — the compare evidence below proves it for the whole corpus.

Trajectory events: an additive m05 `guard` event type records rejections (`kind`, `reason`, `attempt`, `phase`); readers
that do not know it ignore it. Result records carry an optional derived `reliability` summary (`phase`,
guard/false-completion/duplicate/loop counters, retry and verification totals, advisory `failure_class`,
`state_contract`); the runner derives it from the event stream only.

### Configuration C

`canonicalAdapter` is registered in `defaultAdapters()`, marked `requiresExternalInference: true`, and carries no
transport (fail-fast with a clear message; nothing is read from the environment). Build it with
`createCanonicalAdapter({ transport, configId?, requiresExternalInference? ,
toolSurface?, transcriptBudget?, contextMode?, ... })`:
fake transports drive it deterministically (compact surface = the nine canonical tools; the broad surface is the
experimental cost-measurement surface and never routed).

### Comparison evidence

`benchmarks/compare.ts` re-runs the task corpus through the hermetic `reference` adapter (no inference) and emits for
every task and budget tier: full-transcript estimated tokens, post-compaction tokens, structured-context tokens (state
summary + recent tail, exactly what C sends in structured mode), and whether compaction preserved the state contract. It
also compares the compact (nine tools) and broad (thirteen) surface definition costs. The focused test suite asserts
`contract_preserved` for every corpus task and `structured_tokens < full_transcript_tokens` for the long-horizon task.

## Hermetic testing

`benchmark:test` runs the hermetic suites: m02 (schema validation, manifest corpus revision proof, oracle
pass/fail/timeout, runner classification, external adapter refusal, metric derivation, aggregation, the 25-task
reference matrix and its injected-failure profile), plus the m05 suites — `reliability.test.ts` (event-stream
derivation), `canonical.test.ts` (config C gating + the fake-transport C matrix over all 25 tasks) and `compare.test.ts`
(context/surface evidence). The m05 unit suites live in `tests/reliability-*.test.ts` (validation feedback, loops,
retry, verification, state, compaction, harness integration).
