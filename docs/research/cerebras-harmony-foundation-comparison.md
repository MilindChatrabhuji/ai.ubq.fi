# Cerebras GPT-OSS Harmony agent foundation — comparison report (m07)

Worker `m07-results-recommendation-17811d6a47`. Research record:
[research report](./cerebras-harmony-foundation-research.md). Recommendation:
[final recommendation](../cerebras-gpt-oss-harmony-agent-foundation-recommendation.md).

Everything in this document is **deterministic**: no model was called, no external service was contacted, and the live
matrix did not run. Results marked _hermetic_ were produced by the checked-in `reference` adapter; results marked
_fake-C_ were produced by the checked-in canonical config **C** driven by a scripted fake transport. **Neither class is
a report of model success.** The only admissible evidence of model behavior would come from the live A/B/C/D matrix,
which is blocked (see §7).

## 1. Commands run and reproducible evidence

The worker generated the following evidence under its git-ignored `benchmark-runs/` directory. Those files are ephemeral
worker-local outputs, not part of the delivered Git state. The checked-in tests and commands regenerate the evidence.

| Command                                                                                                                                                                                                                 | Artifact(s)                                                                                                                                                                                   | Date                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `deno task benchmark:run -- --configs=reference`                                                                                                                                                                        | `benchmark-runs/runs/<ts>-reference-<task>/{trajectory.jsonl,result.jsonl}` (25 runs)                                                                                                         | 2026-08-29T22:07:14Z |
| `deno run --allow-read --allow-write=benchmark-runs --allow-run=sh,git benchmark-runs/m07-gen-fake-c.ts` (local generator, git-ignored; replicates the fake-transport matrix from `benchmarks/tests/canonical.test.ts`) | `benchmark-runs/runs/m07-cfake-<task>/{trajectory.jsonl,result.jsonl}` (25 runs)                                                                                                              | 2026-08-29T22:07:53Z |
| `deno task benchmark:summary`                                                                                                                                                                                           | `benchmark-runs/summary.json` + table output                                                                                                                                                  | 2026-08-29T22:07:55Z |
| `deno run --allow-read --allow-write=benchmark-runs --allow-run=sh,git benchmarks/compare.ts`                                                                                                                           | `benchmark-runs/context-evidence.json` (deterministic JSON), `benchmark-runs/context-evidence.txt` (human table); also re-records 25 additional `reference` runs under `benchmark-runs/runs/` | 2026-08-29T22:07:58Z |
| `deno task benchmark:test`                                                                                                                                                                                              | n/a (suite result: **47 passed, 0 failed**)                                                                                                                                                   | 2026-08-29T22:08:20Z |
| `deno test … tests/harmony-*.test.ts tests/sentinel-bootstrap.test.ts`                                                                                                                                                  | n/a (suite result: **120 passed, 0 failed**)                                                                                                                                                  | 2026-08-29T22:08:45Z |
| `deno run --allow-env=CEREBRAS_API_KEY --allow-net=api.cerebras.ai --allow-write=docs/probes scripts/probes/cerebras-harmony-probes.ts`                                                                                 | no artifact (skipped, see §6)                                                                                                                                                                 | 2026-08-29T22:07:25Z |

Probe result files, once a live key exists, land at `docs/probes/cerebras-harmony-protocol-<utc-timestamp>.jsonl`
(`docs/probes/README.md`).

Notes:

- The worker-local `benchmark-runs/summary.json` contained 75 result records: 25 reference matrix + 25 C-fake + 25
  reference reruns recorded by `compare.ts`. The per-task `result.jsonl` files are the authoritative per-run records;
  the report tables below are computed from the **primary matrix runs only** (see `m07-gen-fake-c.ts` and §3).
- `benchmark-runs/tmp/` is reused by the runner for disposable fixture workspaces and is removed after each run.
- The m07 generator script is intentionally not committed (it mirrors a test helper); the same evidence is generated by
  the committed suite `deno task benchmark:test` (asserts 25/25 for both matrices, guard profiles, context evidence).

## 2. Corpus

25 deterministic tasks, 5 per category (`benchmarks/tasks/*.json`, schema 1.0): `navigation` (`nav-*`), `coding`
(`code-*`), `sequential` (`seq-*`), `failure` (`fail-*`), `long` (`long-*`). Declared properties: fixture snapshot +
sha256 `fixture_revision`, write scope, verify command, file/git oracles, `scripted_trail`, per-task timeouts (1–15
min), and tool-call bounds. Long-horizon: `long-001` requires > 10 calls (15), `long-002`–`long-005` require

> 20 calls (23–24). Every fixture revision was proven against the checked-in snapshots
> (`manifests: fixture revisions match the checked-in snapshots`, suite green).

## 3. Deterministic results — hermetic reference matrix (25/25)

`reference` replays each task's recorded trail through the canonical m04 tool layer; the runner then runs the declared
verification command and all file/git oracles. Success = oracle evidence, never model text. All 25 succeeded (0
failures). Totals across the matrix:

| Metric             | value                                                      |
| ------------------ | ---------------------------------------------------------- |
| runs / success     | 25 / 25 (100%)                                             |
| tool calls (total) | 195                                                        |
| invalid tool calls | 1 (fail-003)                                               |
| wrong-tool calls   | 1 (fail-004)                                               |
| repeated calls     | 0                                                          |
| tool errors        | 7 (all in injected-failure tasks)                          |
| recovery attempts  | 6                                                          |
| model calls        | 0 (scripted; `min_model_calls` is 0 for all manifests)     |
| wall time          | median 23 ms, p95 367 ms (git fixtures are the slow paths) |

| task     | tools | invalid | wrong | errs | recov | wall   |
| -------- | ----- | ------- | ----- | ---- | ----- | ------ |
| nav-001  | 4     | 0       | 0     | 0    | 0     | 28 ms  |
| nav-002  | 3     | 0       | 0     | 0    | 0     | 19 ms  |
| nav-003  | 3     | 0       | 0     | 0    | 0     | 13 ms  |
| nav-004  | 3     | 0       | 0     | 0    | 0     | 19 ms  |
| nav-005  | 5     | 0       | 0     | 0    | 0     | 418 ms |
| code-001 | 4     | 0       | 0     | 0    | 0     | 38 ms  |
| code-002 | 4     | 0       | 0     | 0    | 0     | 23 ms  |
| code-003 | 4     | 0       | 0     | 0    | 0     | 21 ms  |
| code-004 | 4     | 0       | 0     | 0    | 0     | 23 ms  |
| code-005 | 4     | 0       | 0     | 0    | 0     | 22 ms  |
| seq-001  | 4     | 0       | 0     | 0    | 0     | 22 ms  |
| seq-002  | 5     | 0       | 0     | 0    | 0     | 18 ms  |
| seq-003  | 5     | 0       | 0     | 0    | 0     | 22 ms  |
| seq-004  | 7     | 0       | 0     | 0    | 0     | 367 ms |
| seq-005  | 7     | 0       | 0     | 0    | 0     | 28 ms  |
| fail-001 | 3     | 0       | 0     | 1    | 1     | 17 ms  |
| fail-002 | 4     | 0       | 0     | 1    | 1     | 27 ms  |
| fail-003 | 3     | 1       | 0     | 1    | 1     | 12 ms  |
| fail-004 | 3     | 0       | 1     | 1    | 0     | 13 ms  |
| fail-005 | 6     | 0       | 0     | 1    | 1     | 31 ms  |
| long-001 | 15    | 0       | 0     | 0    | 0     | 45 ms  |
| long-002 | 23    | 0       | 0     | 0    | 0     | 85 ms  |
| long-003 | 24    | 0       | 0     | 2    | 2     | 85 ms  |
| long-004 | 24    | 0       | 0     | 0    | 0     | 80 ms  |
| long-005 | 24    | 0       | 0     | 0    | 0     | 83 ms  |

## 4. Deterministic results — fake-C matrix (25/25)

Config **C** = canonical Harmony harness: compact 9-tool surface, m05 reliability layer, medium transcript budget,
structured context mode, `reasoningEffort: "low"`, fake transport replaying the scripted trail one call per request,
then "Task complete"; when the guard rejects the final, the fake model first runs the declared verification command and
then revises the plan. All 25 succeeded (0 failures). The interesting evidence is the **reliability profile**:

| Metric                                 | value                                                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runs / success                         | 25 / 25 (100%)                                                                                                                                                                                                       |
| tool calls (total)                     | 211                                                                                                                                                                                                                  |
| model calls (total)                    | 244 (median 7; the scripted model needs 1 request per call + final/guard turns)                                                                                                                                      |
| invalid tool calls                     | 1 (fail-003 `filesystem.read` `wrong_type:arguments.path` — rejected before execution)                                                                                                                               |
| repeated calls                         | 3 (fail-001 ×1, long-003 ×2 — all blocked duplicates, not re-executed)                                                                                                                                               |
| tool errors                            | 6                                                                                                                                                                                                                    |
| recovery attempts                      | 5                                                                                                                                                                                                                    |
| guard rejections                       | 8, all kind `unverified_write` (nav-001…nav-004, seq-002, fail-001, fail-003, fail-004)                                                                                                                              |
| false completions                      | 0                                                                                                                                                                                                                    |
| semantic loops                         | 0                                                                                                                                                                                                                    |
| unresolved commands/edits at end       | 0 on all 25                                                                                                                                                                                                          |
| verification required / satisfied      | 51 / 49 (`fail-005`, `seq-004` end with `unverified_writes: 0` and `final_accepted: true` because the declared verification command satisfies all pending writes, `src/harmony/reliability/verify.ts:50-51,147-151`) |
| final accepted                         | 25 / 25                                                                                                                                                                                                              |
| input tokens (estimated, request-side) | 393,038 total; largest single request context 3,175 tokens                                                                                                                                                           |
| wall time                              | median 30 ms, p95 408 ms (same git-fixture slow paths)                                                                                                                                                               |

| task         | tools | model | guards | dups | inv | errs | recov | final | wall     |
| ------------ | ----- | ----- | ------ | ---- | --- | ---- | ----- | ----- | -------- |
| nav-001      | 6     | 8     | 1      | 0    | 0   | 0    | 0     | ✓     | 51 ms    |
| nav-002      | 5     | 7     | 1      | 0    | 0   | 0    | 0     | ✓     | 28 ms    |
| nav-003      | 5     | 7     | 1      | 0    | 0   | 0    | 0     | ✓     | 23 ms    |
| nav-004      | 5     | 7     | 1      | 0    | 0   | 0    | 0     | ✓     | 30 ms    |
| nav-005      | 5     | 6     | 0      | 0    | 0   | 0    | 0     | ✓     | 408 ms   |
| code-001…005 | 4     | 5     | 0      | 0    | 0   | 0    | 0     | ✓     | 22–39 ms |
| seq-001      | 4     | 5     | 0      | 0    | 0   | 0    | 0     | ✓     | 22 ms    |
| seq-002      | 7     | 9     | 1      | 0    | 0   | 0    | 0     | ✓     | 27 ms    |
| seq-003      | 5     | 6     | 0      | 0    | 0   | 0    | 0     | ✓     | 23 ms    |
| seq-004      | 7     | 8     | 0      | 0    | 0   | 0    | 0     | ✓     | 364 ms   |
| seq-005      | 7     | 8     | 0      | 0    | 0   | 0    | 0     | ✓     | 29 ms    |
| fail-001     | 5     | 7     | 1      | 1    | 0   | 1    | 1     | ✓     | 30 ms    |
| fail-002     | 4     | 5     | 0      | 0    | 0   | 1    | 1     | ✓     | 26 ms    |
| fail-003     | 5     | 7     | 1      | 0    | 1   | 1    | 1     | ✓     | 22 ms    |
| fail-004     | 5     | 7     | 1      | 0    | 0   | 0    | 0     | ✓     | 28 ms    |
| fail-005     | 6     | 7     | 0      | 0    | 0   | 1    | 1     | ✓     | 33 ms    |
| long-001     | 15    | 16    | 0      | 0    | 0   | 0    | 0     | ✓     | 47 ms    |
| long-002     | 23    | 24    | 0      | 0    | 0   | 0    | 0     | ✓     | 66 ms    |
| long-003     | 24    | 25    | 0      | 2    | 0   | 2    | 1     | ✓     | 65 ms    |
| long-004     | 24    | 25    | 0      | 0    | 0   | 0    | 0     | ✓     | 77 ms    |
| long-005     | 24    | 25    | 0      | 0    | 0   | 0    | 0     | ✓     | 105 ms   |

## 5. What the deterministic comparison shows

- **Reference vs fake-C tool budgets are close** (195 vs 211 total calls): the harness adds at most
  `verify-command + plan-revision` turns on the 8 guarded tasks, which is the designed recovery path, not waste.
- **Guard behavior is exactly the designed behavior**: the scripted model writes without verifying first; 8 finals were
  rejected with the deterministic `unverified_write` guard, and after executing the declared verification command the
  final was accepted — and the runner still re-ran the same verification (`verification: passed: true`) plus every
  oracle on all 25. `false_completions: 0` confirms no final was ever accepted without an intervening action.
- **Duplicates are blocked, not executed**: 3 flagged repeats (identical args after a success) never re-ran, and
  `recovery_attempts` counts retries after errors only.
- **Invalid calls fail before execution** (`fail-003`, wrong-typed path argument) with `invalid_reason`
  `wrong_type:arguments.path`; the envelope stays machine-readable.
- **Zero unresolved state at completion** on every task, i.e. the m05 "verification before final" loop is closed by
  construction.
- **No live claim**: apart from the failed-call and duplicate determinism, none of this is evidence that `gpt-oss-120b`
  can drive the tool surface or that the guards are needed/sufficient for a real model.

## 6. Protocol-probe status

**Live probes did not run.** Command exit was 0 with:
`CEREBRAS_API_KEY is not set; live Harmony protocol probes are
skipped (no live calls made).` (verified
2026-08-29T22:07:25Z). No `docs/probes/cerebras-harmony-protocol-*.jsonl` files exist.

The probe subsystem is fully implemented and deterministically tested:

- Manifest: 20 scenarios in 7 groups — `reasoning` (low/medium/high effort), `replay` (after-final, deliberate
  `reasoning_content` echo boundary), `tools` (generic sequence, native sequence, native user-role result replay,
  generic consecutive turns), `strictness` (mixed / all-false / all-true), `structured` (json_object / json_schema /
  native developer formats / tools+response_format), `parallel` (native / generic flag), `classifier` (low / medium).
- Every request is sanitized (no prompts, private reasoning, tool argument values, API keys, or raw bodies — probes
  README).
- Deterministic contract tests: `tests/harmony-probes.test.ts` plus
  `harmony-{adapter,classifier,conversation,parse,
render,tools-router,tools-schemas}.test.ts` — 120 passed, 0 failed
  (2026-08-29).
- **Each of the 20 scenarios needs one live run before any Harmony-semantics claim is admissible** (mixed strictness
  rejection string, reasoning-field presence/shape, native Harmony translation, tool+format support, literal-boolean
  classifier reliability at low vs medium).

## 7. Live A/B/C/D matrix status

| Config | Name                                                                    | Status                                   | Blocking condition                                                                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | current gateway GPT-OSS Chat loop (`benchmarks/baselines/adapter-a.ts`) | **NOT RUN**                              | `CEREBRAS_API_KEY` unavailable; live gate unwired                                                                                                                                                                            |
| B      | codex-infinity bridge (`adapter-b.ts`)                                  | **NOT RUN**                              | key unavailable; `allowLiveProcess`/pinned checkout; the bridge's LIVE-VERIFY list (output format, provider autodetect, tool-surface mapping, isolation, exit codes)                                                         |
| C      | canonical Harmony harness (registered, inert)                           | **NOT RUN** (fake-C only, §4)            | no approved live gate — the runner refuses `C` with `refusing to run external-inference adapters (C): the hermetic runner only executes deterministic adapters; live runs are staged and gated by m03/m05` (verified exit 2) |
| D      | generic strong control (`adapter-d.ts`)                                 | **NOT RUN** (also blocked independently) | control model is the placeholder `<unapproved-control-model>` with `null` transport; baseUrl/apiKey/model need owner confirmation (AGENTS.md + benchmark design: no new secret/flag without owner approval)                  |

Also not run: the live bootstrap classifier (`classifier.low`/`classifier.medium` probe scenarios; the m06
`createBootstrapGptOssClassifier` transport needs the same key). Observed live model success: **zero** — nothing in this
worktree or its artifacts reports one; any future report must distinguish it from the 25/25 hermetic and 25/25 fake-C
evidence above.

## 8. Tool-surface and context evidence (m05, deterministic)

`benchmark-runs/context-evidence.json` (replay of the full corpus through the reference adapter; no inference):

- **Surfaces**: compact = 9 tools / 962 tokens; broad = 13 tools / 1,231 tokens (+44% tools, +28.0% definition tokens,
  computed 1231/962 = 1.280).
- **Context tiers** (25 tasks each):

| budget      | target | full transcript | compaction | structured context | struct/full | contract preserved | comp-mets | struct-mets |
| ----------- | ------ | --------------- | ---------- | ------------------ | ----------- | ------------------ | --------- | ----------- |
| short (4k)  | 4,000  | 40,873          | 40,153     | 3,778              | 9.2%        | 25/25              | 25/25     | 25/25       |
| medium (8k) | 8,000  | 40,873          | 40,303     | 7,265              | 17.8%       | 25/25              | 25/25     | 25/25       |
| large (16k) | 16,000 | 40,873          | 40,873     | 11,010             | 26.9%       | 25/25              | 25/25     | 25/25       |

- Largest full transcript: `long-003` 2,832 tokens; all 25 tasks fit the 4k tier. Compaction drops read/explore/analysis
  pairs only, never failed calls, patches, plan updates, shell commands or guards — and the structured-state contract is
  byte-identical (25/25 across all tiers), which is what makes `contextMode: "structured"` a sound default for C.

## 9. Bootstrap decision design (m06) — as implemented

- **Observation** (`scripts/sentinel/bootstrap/observation.ts`, `contracts.ts`): run/source identity, generation,
  phase/milestone, failure fingerprint, Git SHA, ledger version, retry state, verification evidence.
- **State key**: fixed-order JSON over the 9 durable fields; a state that never changes produces the same key, so cycles
  and identical states are detected deterministically (`sentinelBootstrapProgressStateKey`).
- **Verdicts** (`progress.ts`): `stuck` (unchanged state in the bounded window, or a cycle back to a previous state),
  `progress` only for verified durable advancement (`verified_phase_or_milestone_change`, `new_verified_git_identity`,
  `verified_ledger_advance`, `verified_generation_advance`, `corrective_action_with_new_evidence`), `ambiguous`
  otherwise. Window = 4 observations, hard bound = 16.
- **Classifier**: one bounded data-only request (`gpt-oss-120b`, no tools, no `response_format`, 128 output tokens,
  `stream: false`), observation as inert data in the user turn, decision definition in developer, `low` effort with
  `medium` as the comparison arm. Trimmed final content must be exactly `/^(true|false)$/i`; refusal, tool call, prose,
  JSON wrapper, transport error or model mismatch → `unknown` (`src/harmony/classifier.ts`).
- **Fail-closed**: `unknown` never authorizes promotion; the controller's progress field is advisory today — the
  promotion path does not consume it and the exact-SHA/immutable-revision health gates are untouched
  (`scripts/sentinel/bootstrap/controller.ts:55-59,91-98`); the implementation-agent invariant remains Luna-only.
- **Deterministic coverage**: the sentinel-bootstrap suite verifies one-call-per-ambiguous, unknown-on-failure without
  blocking rollback, malformed-observation fail-closed, no classifier call for deterministic verdicts, and no
  mutation/model-substitution path (120 tests green, above).

## 10. Risks and open questions

Ordered by how much they can change the recommendation:

1. **No live evidence of GPT-OSS tool use at all.** Every "A/C works" statement would be an inference from a scripted
   fake. (Blocked: no key.)
2. **B's bridge assumptions are unverified** — the machine-readable process output format, provider autodetect,
   tool-surface mapping and run isolation. A B result is inadmissible until confirmed (m03 LIVE-VERIFY list).
3. **D cannot be compared** without an owner-approved control model; the placeholder instance refuses to run.
4. **Harmony-native vs generic translation** (probes `tools.native.*`, `reasoning.*`) — unproven; if native rendering
   fails live, C must fall back to the generic style with provider-translated tool calls, which changes the classifier
   and tool-replay semantics.
5. **Mixed-strictness rejection** — normalization to one value is the safe default, but the live error text/status still
   needs recording.
6. **Schema projection is lossy** (pattern/length/bounds removed from the provider-bound copy) — canonical tool schemas
   must not rely on those keywords for enforcement; server-side validation stays authoritative.
7. **Tools + structured output** stays refused (`unproven-combination`) until `structured.with-tools` passes live; this
   keeps the classifier format-free by design.
8. **Classifier reliability unknown**: literal `true`/`false` adherence and any refusal/injection behavior need live
   measurement at low vs medium before trust can be raised; the design stays advisory/fail-closed regardless.
9. **Token accounting is estimated** for fake-C (`input_tokens` from `estimateTokens`; `output_tokens` 0) and the real
   gateway may report usage differently (LIVE-VERIFY) — cost projections must be re-derived from live `usage`.
10. **Quota discipline**: the plan requires staged runs (probes → small smoke → full matrix only after costs are
    reported and approved). All live commands below are staged; the bridge's deliberately-removed auto-* flags prevent
    non-terminating B runs.
11. **No interference rule**: no running Codex/DSH/tmux/browser/deployment workflow was touched; the probes and
    benchmark runs are local-only.

## 11. Next staged actions

```sh
# 1) After the owner supplies CEREBRAS_API_KEY in the execution environment,
#    run protocol probes first (bounded; 20 scenarios; classifier.low/medium included).
#    Writes docs/probes/cerebras-harmony-protocol-<utc>.jsonl when live.
deno run --allow-env=CEREBRAS_API_KEY --allow-net=api.cerebras.ai --allow-write=docs/probes \
  scripts/probes/cerebras-harmony-probes.ts

# 2) gate re-checks (no inference)
deno task benchmark:fixture-revision
deno task benchmark:test

# 3) Before any live benchmark, implement and review the live gate wiring:
#    register A/B/D, inject the approved Cerebras transport into C, and configure
#    an owner-approved control model for D. No runnable A/B/C/D CLI command exists
#    until that wiring is implemented. B also requires every LIVE-VERIFY item.

# 4) After gate wiring, report the exact smoke commands and estimated calls/cost.
#    Run the small smoke only with owner quota approval, then request approval for
#    the full A/B/C/D matrix.

# 5) evidence (no inference)
deno task benchmark:summary
deno run --allow-read --allow-write=benchmark-runs --allow-run=sh,git benchmarks/compare.ts
```

Live classifier evidence is produced by the same probe run (`classifier.low`, `classifier.medium`) and, for the advisory
m06 flow, by `createBootstrapGptOssClassifier` injection into `reconcileSentinelBootstrap` with the same key — the
controller calls it at most once per `ambiguous` decision and converts any failure to `unknown`.
