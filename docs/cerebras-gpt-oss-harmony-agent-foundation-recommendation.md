# Cerebras GPT-OSS Harmony agent foundation — final recommendation (m07)

Worker `m07-results-recommendation-17811d6a47` (plan identity `53c80930e6`, module `17811d6a47`). Evidence base:
[research report](research/cerebras-harmony-foundation-research.md) and
[comparison report](research/cerebras-harmony-foundation-comparison.md). Prepared 2026-08-29 UTC.

**Status: PROVISIONAL.** The live A/B/C/D matrix, the live protocol probes and the live classifier probe did not run
(`CEREBRAS_API_KEY` is not set; control model D is unapproved). Therefore **no viability conclusion across A/B/C/D can
be selected yet**. Everything below that is not explicitly marked as deterministic evidence is a recommendation
conditional on the next staged live runs.

## 1. What can and cannot be concluded today

### Cannot be selected yet (explicitly)

| Question                                                                                                                   | Why not selectable                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A vs C**: is the current gateway GPT-OSS Chat loop (A) or the canonical Harmony harness (C) more reliable on real tasks? | No live run of A or C exists. A would only tell you about the _app_ (tool names, strictness, tool result replay) vs the _harness_ (guards, structured context); the deterministic fake-C evidence is not a model result.       |
| **B viability**: is codex-infinity's Cerebras path usable as a baseline at all?                                            | Its machine-readable output format, provider autodetect, tool-surface mapping, run isolation and exit behavior are all **LIVE-VERIFY** and unconfirmed; the bridge's parse assumptions are explicit assumptions, not evidence. |
| **D comparison**: does a strong control model materially outperform GPT-OSS?                                               | D refuses to run until an owner-approved control model (and baseUrl/apiKey) is configured; the default is the placeholder `<unapproved-control-model>` with a `null` transport.                                                |
| **Classifier trust**: can `gpt-oss-120b` emit a literal `true`/`false` reliably at low/medium effort?                      | The `classifier.low`/`classifier.medium` probes are skipped; only the contract is deterministically tested.                                                                                                                    |
| **Primary agent vs insufficient reliability** (the two extremes of the plan's conclusion set)                              | Both require the live comparisons above. Nothing we observed contradicts either — and nothing confirms either.                                                                                                                 |

### What is concluded (deterministic evidence only)

1. The **hermetic benchmark is real**: 25/25 reference-task success with oracle-verified outcomes, 195 tool calls,
   injected-failure profiles (7 errors, 6 recoveries, 1 invalid, 1 wrong tool), 0 false positives.
2. The **canonical harness closes its own loop**: 25/25 fake-C success with 244 model turns, 8 deterministic
   `unverified_write` guard rejections, 0 false completions, 0 semantic loops, 0 unresolved state, 1 pre-execution
   rejection, 3 blocked duplicates — i.e. the m05 reliability layer works as designed when the model cooperates with the
   protocol, and the runner still re-ran verification + oracles on every task.
3. The **context strategy is sound**: 25/25 contract preservation across short/medium/large compaction, structured
   context at 9.2%–26.9% of the full transcript, 25/25 met budget; compact surface (9 tools, 962 tok) costs 28% less
   than broad (13 tools, 1,231 tok).
4. The **bootstrap progress decision is fail-closed by construction**: deterministic `progress`/`stuck`/`ambiguous`
   only, one bounded zero-tool literal-boolean request, every failure → `unknown`, advisory-only today, no
   model-substitution path, Luna-only invariant preserved.
5. **Nothing in this repository or its artifacts contains an observed live model success.** The 25/25 hermetic and 25/25
   fake-C numbers must never be quoted as model results.

## 2. Recommendation (provisional)

**Adopt, in order: (a) narrow inference only — keep GPT-OSS solely as the bounded progress classifier plus an
experimental worker harness — as the immediate posture; and (b) bounded worker with stronger orchestrator as the only
posture that should be considered next, and only after a live C smoke result beats the measured A baseline.** Do not
select "primary agent" and do not select "insufficient reliability" until the live matrix answers the questions above.

Rationale:

- **Risk-adjusted value**: the only GPT-OSS capability the plan needs _today_ is one strict boolean per ambiguous
  observation, with `unknown` as the fail-closed residue. That is the cheapest possible live surface to validate (two
  probe scenarios), and the deterministic evidence shows the surrounding machinery (tools, guards, replay, context)
  already works end-to-end under the protocol.
- **Unproven, not disproven**: GPT-OSS tool-calling remains entirely unmeasured. The harness's reliability machinery is
  proven _against a cooperative scripted model_; a real model that ignores tool schemas, loops, or wraps booleans would
  still be caught (guards, `unknown`), but the cost would be wasted calls — which the live matrix is exactly for.
- **The orchestrator stays strong**: promotion remains gated by exact immutable revision + full-SHA health proof; the
  classifier cannot override an authoritative failure. This is the invariant that lets us accept "narrow inference only"
  as the safe interim posture.
- **Why not "insufficient reliability" today**: the failure modes that would justify it (tool-use collapse, refusal
  rates, literal-boolean violation at meaningful rates) are all live-only questions with zero measurements; declaring it
  would be as unsupported as declaring GPT-OSS a primary agent.

Decision rule for the next step (can be run by the orchestrator with owner approval):

- After probes: if `strictness.mixed` rejection, `tools.native.*`, `reasoning.*` and `classifier.low/medium` records
  show the provider honors the adapter's protocol (uniform strictness accepted, tool calls parse, literal booleans at
  acceptable rate), **proceed to C smoke**.
- After C smoke vs A smoke on the same ~3-task subset: choose **bounded worker with stronger orchestrator** if C's task
  success and guard-safety metrics meet the acceptance gate (§4), else **narrow inference only** (classifier only).
- Only after the full A/B/C/D matrix and the classifier acceptance gate pass may the orchestrator consider raising the
  classifier from advisory, and only the advisor may introduce that authority change (plan §Git and delivery).

## 3. Acceptance checklist for m07

| #   | Item                                                                                                                                                                            | Status / evidence                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Checked-in protocol probe command emits JSONL for reasoning, tool turns, strictness, structured output, Harmony replay                                                          | **Command + sanitization + deterministic tests done** (20 scenarios); live JSONL **pending** (probe skipped, no key)                                          |
| 2   | Checked-in benchmark command runs the same manifest through gateway path, codex-infinity, canonical harness, strong control; raw trajectories + summarized metrics reproducible | **Adapters built; live registry/gate wiring pending**; hermetic reference 25/25 and fake-C 25/25 reproducible through checked-in tests; live runs **blocked** |
| 3   | Canonical harness exposes only the nine tools with schema validation and stable contract                                                                                        | **Done** — `src/harmony/tools/`, compact surface (schemas.ts), fake-matrix evidence                                                                           |
| 4   | Reliability layer detects invalid calls, duplicates, failed commands, ineffective edits, missing verification, stalled state, false completion; full trajectories preserved     | **Done locally** — feedback/loops/retry/verify/state; fake-C measured 8 guards, 0 false completions, 0 loops; live trajectories pending                       |
| 5   | Bootstrap progress evaluation uses the documented fields and returns progress/stuck/ambiguous before any model call                                                             | **Done** — `scripts/sentinel/bootstrap/`, deterministic tests green                                                                                           |
| 6   | Classifier: one bounded data-only request, exact model, no tools, literal `/^(true\|false)$/i`                                                                                  | **Contract done + tested**; live classifier acceptance **pending**                                                                                            |
| 7   | Promotion gated by exact immutable revision + full Git SHA health proof; classifier cannot override                                                                             | **Preserved** — advisory field only, gates untouched                                                                                                          |
| 8   | Focused tests pass; benchmark artifacts contain required metrics/classifications; report is data-supported                                                                      | **Local gates done** — 47 + 120 tests green; worker-local evidence is regenerable but git-ignored; live artifacts pending                                     |
| 9   | Accepted branches merged with visible ancestry; development refreshed                                                                                                           | **Pending** — this worker commits to its module branch; PR/review/merge is the orchestrator's next step (AGENTS.md)                                           |

## 4. Suggested acceptance gate for the live C smoke (not yet evaluated)

A small fixed subset (`nav-001`, `seq-001`, `long-001`): C is preferable to A when, with oracle-verified success on all
three, C records **zero** false completions and **zero** unresolved unverified writes, and its total model calls remain
within the planned cost envelope (compare token estimates calibrated against real `usage`). Any guard rejection is fine
— guards are the point; being stuck in a guard loop is not.

## 5. Artifact locations

Ephemeral worker-local outputs (regenerable; git-ignored and not part of the delivered Git state):

- `benchmark-runs/runs/<ts>-reference-<task>/{trajectory.jsonl,result.jsonl}` — 25-run hermetic reference matrix
  (2026-08-29T22:07:14Z)
- `benchmark-runs/runs/m07-cfake-<task>/{trajectory.jsonl,result.jsonl}` — 25-run fake-C matrix (2026-08-29T22:07:53Z)
- `benchmark-runs/summary.json` — aggregated summary (75 records incl. 25 compare reruns)
- `benchmark-runs/context-evidence.json`, `benchmark-runs/context-evidence.txt` — context/surface evidence
- `benchmark-runs/m07-gen-fake-c.ts` — worker-local fake-C generator; equivalent evidence is generated by the committed
  `canonical.test.ts` suite)

Committed (this module):

- `docs/research/cerebras-harmony-foundation-research.md`
- `docs/research/cerebras-harmony-foundation-comparison.md`
- `docs/cerebras-gpt-oss-harmony-agent-foundation-recommendation.md` (this document)

Will be created by the live steps (not persisted until then):

- `docs/probes/cerebras-harmony-protocol-<utc-timestamp>.jsonl` — probe run results (live only)
- `benchmark-runs/runs/*-A-*`, `…-B-*`, `…-C-*`, `…-D-*` — live matrix runs (after gate wiring + owner approval)

## 6. Next staged actions

See comparison report §11 for the exact staged commands (probes → fixture/test gates → A/B/C/D smoke → full matrix →
summary/compare). One prerequisite change is orchestrator-owned: wiring `baselineAdapters()` (A/B/D) into the runner's
registry and constructing C/D with an approved live transport/control model; **no secret, environment variable or CLI
flag may be added without owner approval.**

## 7. Blockers and risks

Current blockers: (1) `CEREBRAS_API_KEY` not set — blocks all live probes, the live classifier, and the A/B/C/D matrix;
(2) control model for D unapproved — blocks D; (3) codex-infinity bridge LIVE-VERIFY gap — blocks any B result; (4) live
gate wiring is orchestrator-owned and not yet done; (5) live classifier acceptance is a required follow-up before the
advisory-only decision is ever reconsidered. Full risk register: comparison report §10. Local machine state was not
modified beyond `benchmark-runs/` and the three new documents; no running workflow was touched.
