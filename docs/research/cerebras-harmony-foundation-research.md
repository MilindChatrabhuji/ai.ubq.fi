# Cerebras GPT-OSS Harmony agent foundation — research report (m07)

Worker `m07-results-recommendation-17811d6a47`. Companion documents:
[comparison report](./cerebras-harmony-foundation-comparison.md) and
[final recommendation](../cerebras-gpt-oss-harmony-agent-foundation-recommendation.md).

Recorded on **2026-08-29** (UTC). Every claim below is anchored either to a primary source (URL + retrieval date), to
checked-in source in this repository (file:line), or is explicitly tagged **LIVE-VERIFY** — meaning it needs a real,
owner-approved live run before it may be used as evidence. Nothing in this document is a report of model behavior that
was observed live; the live matrix was not run (see the comparison report).

## 1. OpenAI GPT-OSS and Harmony requirements

### Primary sources

| Source                                             | URL                                                        | Status                                                          |
| -------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| OpenAI gpt-oss repository                          | https://github.com/openai/gpt-oss                          | verified reachable 2026-08-29 (m03 record and this session)     |
| OpenAI Harmony repository (renderer + format docs) | https://github.com/openai/harmony                          | verified reachable 2026-08-29                                   |
| Harmony format grammar                             | https://github.com/openai/harmony/blob/main/docs/format.md | referenced by the checked-in parser (`src/harmony/parse.ts:12`) |

### Requirements distilled

The plan's protocol defaults (plan §"Protocol defaults to prove, not assume") are the requirement list this work
implements; they map onto the Harmony semantics of `gpt-oss-120b`:

1. **Private analysis vs. user-visible output.** Harmony assistant output has three channels — `analysis` (private chain
   of thought), `commentary` (user-visible preamble), `final` (the answer). The parser in this repository treats
   `analysis` as private state that never leaves the adapter (`src/harmony/types.ts:90-93`,
   `src/harmony/parse.ts:100-103`, `src/harmony/adapter.ts` `normalizeHarmonyChatCompletion`).
2. **Replay semantics.** Analysis is preserved across an unfinished tool turn and dropped after a completed final
   answer; the conversation-state module implements exactly this (`src/harmony/conversation.ts`:
   `dropAnalysisBeforeCompletedFinal`, `advanceConversation`, `appendToolResult`).
3. **Tool-call wire shape.** Harmony tools are addressed by `functions.`-prefixed recipients; provider-translated OpenAI
   `tool_calls` and Harmony-native recipients are normalized to the same model-facing tool name
   (`src/harmony/parse.ts:47-50` `functionNameFromRecipient`, `src/harmony/adapter.ts` `normalizeToolCallWire`). Tool
   results may be replayed through the OpenAI `tool` role or a `user` role wrapper (`nativeToolResultStyle`, probes
   `tools.native.user-result`).
4. **Single strictness value.** Cerebras requires every tool in one request to carry the same `strict` value ("Tools
   with mixed values for 'strict' are not allowed", recorded as a provider requirement in `src/harmony/types.ts:38-42`);
   the adapter normalizes by default (`normalize-false`) and `preserve` exists only for the probe that must record the
   upstream rejection (`strictness.mixed`). The exact upstream error string/status is **LIVE-VERIFY** (m03 record,
   adapter A LIVE-VERIFY list).
5. **Tools plus structured output.** Not proven for `gpt-oss-120b`, so the adapter refuses the combination
   (`unproven-combination`) unless `combinationPolicy: "probe"` is used for protocol evidence
   (`src/harmony/adapter.ts:147-153`, probes `structured.with-tools`).
6. **Bounded boolean classifier.** One request, exact model `gpt-oss-120b`, no tools, no `response_format`, small
   `max_completion_tokens` (128), `stream: false`, and a full-string anchored case-insensitive match on
   `/^(true|false)$/i` (`src/harmony/classifier.ts:23-26,75-104`); anything else — prose, JSON, refusal, tool call,
   transport failure, model mismatch — is `unknown` and fail-closed.
7. **Reasoning effort.** `low` / `medium` / `high` are the supported surface; `none` is rejected by the gateway for
   `gpt-oss-120b` with the exact message
   `reasoning_effort 'none' is not supported for gpt-oss-120b. Use low, medium,
or high.`
   (`src/openai.ts:8652-8656`). Classifier experiments start at `low` and compare `medium`
   (`src/harmony/classifier.ts:8-9`).

## 2. Current gateway behavior and gaps

### What the gateway does today (anchor: `src/openai.ts`)

- `handleCerebrasChatCompletions` (~line 8645, per m03 record): forces `model` to `gpt-oss-120b` (`src/cerebras.ts:5`),
  defaults `reasoning_effort` to `DEFAULT_REASONING_EFFORT = "medium"` (`src/defaults.ts:12`, applied at
  `src/openai.ts:8670`), runs `stream: false`, preserves the official nested `tools`/`tool_choice`/`parallel_tool_calls`
  fields, and allows `response_format` only for plain `json_object`.
- Transport `fetchCerebrasChatCompletions` (`src/cerebras.ts:247-318`): fixed URL
  `https://api.cerebras.ai/v1/chat/completions`, `Bearer` from the existing `CEREBRAS_API_KEY` only (no new secret or
  interface), gateway deadline with `gateway_timeout` (504), error normalization (`cerebras_api_key_missing` 503,
  `cerebras_request_invalid` 400, `cerebras_upstream_unreachable` 502), API-key admission dispatch, and redirect:
  `manual`.
- Response normalizer `normalizeCerebrasChatCompletion` (`src/cerebras.ts:437-477`): enforces the requested model
  exactly (mismatch is an error), requires `usage` integrity only when present, validates tool-call shape, and **drops
  reasoning fields** (`message.reasoning_content` is never relayed — only content/refusal/tool_calls survive,
  `src/cerebras.ts:397-402`).
- Schema projection `projectCerebrasRequest` (`src/cerebras.ts:218-240`): projects the tool schema onto the provider's
  JSON-Schema subset — `format`, `minItems`/`maxItems`, `minLength`/`maxLength`, `minProperties`/`maxProperties`,
  `pattern`, `uniqueItems` are removed, `const` becomes a one-item `enum`, `oneOf` becomes `anyOf`
  (`src/cerebras.ts:10-20,133-146`), and a root object union is collapsed into one object with a constrained
  `operationId` because Cerebras requires an object root (`collapseCerebrasRootObjectUnion`, `src/cerebras.ts:160-216`).
  Server-side validation remains authoritative for the omitted bounds.
- Rate-limit headers are mapped through `CEREBRAS_RATE_LIMIT_HEADERS`; provider request IDs are normalized to bounded
  header-safe values (`src/cerebras.ts:72-83`).

### Gaps this foundation addresses (and the surfaces they own)

| Gap                                                                                                                                                            | Evidence / owner                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Reasoning is dropped at the gateway; there is no Harmony replay (analysis preserved across unfinished tool turns, dropped after a final)                       | m01 adapter + conversation state (`src/harmony/conversation.ts`); probes `reasoning.*`, `replay.*` |
| Mixed per-tool `strict` is not normalized for a single request                                                                                                 | m01 adapter `ToolStrictnessMode` (`src/harmony/types.ts:38-48`); probes `strictness.*`             |
| Tools + `response_format` handshake is unproven                                                                                                                | m01 adapter combination policy; probe `structured.with-tools`                                      |
| No canonical compact model-facing tool contract; the gateway passes through whatever the client sends                                                          | m04 stable schemas + one uniform `strict` (`src/harmony/tools/schemas.ts`)                         |
| No reliability feedback (invalid calls, duplicates, failed commands, ineffective edits, missing verification, stalls, false completion) in the plain chat loop | m05 (`src/harmony/reliability/`)                                                                   |
| No deterministic progress decision for Sentinel bootstrap                                                                                                      | m06 (`scripts/sentinel/bootstrap/`)                                                                |
| No benchmark evidence that any GPT-OSS agent loop is viable                                                                                                    | m02/m03/m05 runner + adapters; this document                                                       |

Unchanged invariant (must never change): the Provider Sentinel implementation agent stays Luna-only (`gpt-5.6-luna`);
GPT-OSS is a progress classifier and experimental worker harness, never an implementation-model substitute (AGENTS.md;
plan §Objective; `scripts/sentinel/bootstrap/policy.ts`).

## 3. codex-infinity (baseline B)

Verified 2026-08-29 in the m03 record (`docs/research/cerebras-agent-baselines.md`):

- Repository https://github.com/lee101/codex-infinity is a **fork** of `openai/codex` (GitHub API `fork: true`, source
  `openai/codex`), default branch `main`, pinned commit `fbb52680c30a968384b15cfe6dadbec22faba73f`
  (2026-08-24T11:08:14Z). License Apache-2.0 (fork and upstream); the fork ships a `NOTICE`; npm package
  `@codex-infinity/codex-infinity`.
- README-verified provider facts: Cerebras provider auto-detected from model slug `cerebras/gpt-oss-120b` with env
  `CEREBRAS_API_KEY`; endpoint defaults to `https://api.cerebras.ai`; `CEREBRAS_BASE_URL` overrides it; documented CLI
  flags `-m/--model` and `--cd DIR`; `--auto-next-steps`, `--auto-next-idea`, `--auto-next-goal` are deliberately
  excluded by the bridge because they never terminate.
- Checked-in bridge `benchmarks/baselines/adapter-b.ts`: default `checkoutPath: null`, `allowLiveProcess: false`, no
  driver — `run()` throws `BaselineNotProvisionedError` (never clones, spawns, or reads the environment). Live path
  requires `allowLiveProcess: true` and verifies `git rev-parse HEAD` equals the pinned commit; process command is
  `codex-infinity -m cerebras/gpt-oss-120b --cd <workspace> <task description>`. Trajectory mapping parses process lines
  as JSONL events (`parseCodexProcessLine`) and counts unparseable lines; a non-zero exit or any skipped line fails the
  run with `bridge-parse`.
- **LIVE-VERIFY (critical, all of these)** — a B result is inadmissible until: the exact machine-readable output format
  (JSONL? TUI escapes? `codex exec --json`-style events? `~/.codex/sessions/*.jsonl`?), that `CEREBRAS_API_KEY` is
  picked up without a `config.toml` edit and `CEREBRAS_BASE_URL` works, that `--cd` isolates the disposable workspace
  and no global `~/.codex` state is written, that the fork's tool surface maps to the canonical tool names at all, and
  the CLI's exit-code/timeout behavior. `parseCodexProcessLine` is an explicit assumption, not evidence (m03 record).

## 4. Cerebras Academic Research Agent

- Cookbook: https://inference-docs.cerebras.ai/cookbook/agents/academic-research-agent — **verified reachable on
  2026-08-29** (m03 primary-source table; this session recorded the URL again but did not fetch page content). It is the
  named reference for a research-style agent loop on Cerebras.
- No claim in this document is derived from the cookbook's content beyond reachability; its exact model selection, tool
  surface and agent-loop shape should be confirmed during the live smoke stage (see comparison report, next commands).

## 5. Browser-Use (reference web-tool implementation)

- Cerebras example: https://github.com/browser-use/browser-use/blob/main/examples/models/cerebras_example.py —
  **verified reachable 2026-08-29** (m03 record); a current snapshot of the same path exists at commit
  `d19ec6ef20e5c68bf4ca198e8b0b5aea69280fe6`. No code was copied; License/provenance rules apply if any adapter is ever
  derived from it (plan §m03).
- **LIVE-VERIFY**: whether Browser-Use's Cerebras adapter exercises `gpt-oss-120b` with tools and structured output
  successfully, and which strictness/response-format combination it uses. This is the reference for the browser tools
  adopted by the canonical surface (`browser.search/open/find`); the canonical implementation here uses deterministic
  offline fakes (`src/harmony/tools/fakes.ts`) — no browser daemon, no network.

## 6. Provider quirks (consolidated)

Any quirk marked **LIVE-VERIFY** comes from a source comment, documentation or reasoning in this repository, not from a
live observation.

| #   | Quirk                                                                                                            | Source anchor                                               | Status                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Mixed `strict` values in one request are rejected                                                                | `src/harmony/types.ts:38-42`                                | LIVE-VERIFY (exact error string/status)                 |
| 2   | JSON-Schema subset: bounded fields dropped, `const`→`enum`, `oneOf`→`anyOf`, object root required for parameters | `src/cerebras.ts:10-20,133-219`                             | source-anchored; server-side enforcement authoritative  |
| 3   | `reasoning_effort: "none"` rejected for `gpt-oss-120b`                                                           | `src/openai.ts:8652-8656`                                   | source-anchored (gateway enforces it deterministically) |
| 4   | Reasoning fields never relayed by the gateway normalizer (dropped, not logged)                                   | `src/cerebras.ts:397-402`                                   | source-anchored                                         |
| 5   | `usage` may be absent from a non-streaming completion                                                            | m03 adapter-A LIVE-VERIFY                                   | LIVE-VERIFY (adapter records 0 tokens when absent)      |
| 6   | Tools + structured output unproven; defaults to error in the Harmony adapter                                     | `src/harmony/adapter.ts:147-153`                            | LIVE-VERIFY via probe `structured.with-tools`           |
| 7   | Harmony-native output may arrive untranslated inside `content` (parser required)                                 | `normalizeHarmonyChatCompletion` (`src/harmony/adapter.ts`) | LIVE-VERIFY via probes `tools.native.*`, `reasoning.*`  |
| 8   | Revenue/quota surface: existing `CEREBRAS_API_KEY` is the only credential; no new secret/flag is introduced      | plan §Benchmark design; `src/cerebras.ts:111`               | source-anchored                                         |
| 9   | `stream: false` for every baseline/probe request; bounded `max_completion_tokens` for the classifier             | plan §Protocol defaults; `src/harmony/classifier.ts:26,101` | source-anchored                                         |

## 7. Implemented architecture (what exists and where)

```
benchmarks/                       m02: hermetic runner + shared schema 1.0
  schemas.ts                      manifest / trajectory event / result / summary contract (m02)
  runner.ts                       runOne + runBenchmarks; refuses requiresExternalInference adapters (m02)
  summarize.ts / metrics.ts       no-inference aggregation + table formatting (m02)
  compare.ts                      m05 context/surface evidence CLI (hermetic reference replay)
  adapter.ts                      adapter contract; reference adapter; registry (reference, C); createCanonicalAdapter
  baselines/                      m03: adapter-a (gateway A), adapter-b (codex-infinity bridge), adapter-d (generic D)
  tasks/*.json                    ︎25 deterministic manifests (5 per category)
  fixtures/                       regenerable disposable snapshots with sha256 revisions
  tests/                          hermetic suites: matrix (25-task reference), canonical (C-fake matrix + gating),
                                  compare (context/surface), aggregate, oracle, runner, schemas, reliability, tools

src/harmony/                      m01 protocol layer (isolated; never imported by gateway routes)
  adapter.ts                      request builder (generic/native styles), normalizeHarmonyChatCompletion,
                                  runHarmonyTurn, createCerebrasTransport over the existing Cerebras key
  classifier.ts                   bounded zero-tool literal-boolean classifier contract
  conversation.ts                 replay: analysis preserved/dropped, appendToolResult, pending tool calls
  parse.ts                        tolerant Harmony scanner (channels, recipients, <|call|> <|return|> stops)
  render.ts                       native system/developer rendering (tools in developer, namespace, constraints)
  probes.ts                       sanitized 20-scenario probe manifest (reasoning/replay/tools/strictness/
                                  structured/parallel/classifier)
src/harmony/tools/                m04: schemas (9 tools, one strict value), result envelopes, backend injection,
                                  router, deterministic offline fakes
src/harmony/reliability/          m05: feedback (invalid-args diagnostics), loops (duplicate + semantic),
                                  retry (transient-only), verify (pending verification + false-completion guards),
                                  state (structured state contract), context (short/medium/large compaction),
                                  surfaces (compact 9 / broad 13), failure classification, runReliabilityHarness
scripts/sentinel/bootstrap/       m06: observation (canonical state key + digest), progress (pure verdicts),
                                  classifier (advisory evidence, one call, unknown on any failure),
                                  contracts (V1 schema), activation (CAS pointer, rollback), controller
                                  (reconcile: health/rollback authority + advisory progress), policy (Luna-only,
                                  exact-SHA gates, fenced generation)
```

Design guarantees that matter for the recommendation:

- **The runner is hermetic by construction**: `defaultAdapters()` = `reference` + `C`; `C` carries no transport and is
  `requiresExternalInference: true`, so `--configs=all` fails with the exact refusal
  `refusing to run external-inference
adapters (C): the hermetic runner only executes deterministic adapters; live runs are staged and gated by m03/m05`
  (verified exit 2, 2026-08-29). No environment variable, CLI flag or secret is read by the runner.
- **Adapters are passive**: success is never decided from model text; the runner always runs the declared verification
  command and oracle (plan §Verification; `benchmarks/runner.ts:257-271`).
- **m06 preserves authority**: the controller's only mutations are a CAS activation pointer and a deduplicated
  constraint; the comment in `scripts/sentinel/bootstrap/controller.ts:55-59` and the m06 commit message
  (`609a97d feat(sentinel): add advisory bootstrap progress detection`) document that classifier evidence is advisory
  and the promotion path does not consume it yet.
- **Probe sanitization**: prompts, private reasoning, tool argument values and API keys never appear in results
  (`src/harmony/probes.ts` header); probe JSONL lands in `docs/probes/` only when a live key exists, otherwise the
  command skips with exit 0 and a notice (verified 2026-08-29).

## 8. Provenance rules used by the companion reports

| Class                                                                | What it can support                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Hermetic (25/25 reference matrix, persisted JSONL)                   | deterministic oracle/verification/tool-layer correctness; NOT model capability            |
| Fake-C (25/25 deterministic harness, persisted JSONL)                | reliability-layer behavior under a scripted model; NOT model capability                   |
| Probe tests (fake transports; harmony + bootstrap suites, 120 tests) | adapter/parser/classifier contract correctness; NOT provider behavior                     |
| Live A/B/C/D matrix, live probes, live classifier                    | the only admissible evidence of model behavior — NOT RUN (blocked, see comparison report) |
