# Cerebras agent baselines (m03): source facts and provenance

Worker `m03-baseline-adapters-de0bd1341f` (retry lane `…-retry-de0bd1341f`). Research record for the benchmark baseline
adapters A (current gateway GPT-OSS Chat), B (codex-infinity-compatible process/trajectory bridge) and D (generic strong
control). Every claim below is either **verified against a primary source on 2026-08-29** or explicitly tagged
**LIVE-VERIFY** (needs a real, owner-approved live run before it may be used as evidence).

All adapters implement `BenchmarkAdapter` from `benchmarks/adapter.ts` (schema 1.0) and set
`requiresExternalInference: true`; the runner refuses them until an approved live-inference gate exists (m03/m05).

## Primary sources

| Source                                       | URL                                                                                      | Status                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| codex-infinity (fork, default branch `main`) | https://github.com/lee101/codex-infinity                                                 | verified 2026-08-29                           |
| codex-infinity upstream (OpenAI Codex CLI)   | https://github.com/openai/codex                                                          | verified (Apache-2.0)                         |
| OpenAI gpt-oss                               | https://github.com/openai/gpt-oss                                                        | verified reachable                            |
| OpenAI Harmony format/library                | https://github.com/openai/harmony                                                        | verified reachable                            |
| Cerebras Academic Research Agent cookbook    | https://inference-docs.cerebras.ai/cookbook/agents/academic-research-agent               | verified reachable                            |
| Browser-Use Cerebras example/adapter         | https://github.com/browser-use/browser-use/blob/main/examples/models/cerebras_example.py | verified reachable                            |
| Cerebras Chat Completions API                | https://api.cerebras.ai/v1/chat/completions                                              | verified reachable (HTTP 401 unauthenticated) |
| codex-infinity homepage                      | https://codex-infinity.com/                                                              | verified in README                            |

## Adapter A — current gateway GPT-OSS Chat Completions behavior

Anchored to gateway code in this repository (read-only references, no changes):

- `src/openai.ts` → `handleCerebrasChatCompletions` (~line 8645): `model` forced to `gpt-oss-120b`, `reasoning_effort`
  defaulted to `medium` (`src/defaults.ts`), `stream: false`, official nested
  `tools`/`tool_choice`/`parallel_tool_calls` preserved, `response_format` allowed only for plain `json_object`.
- `src/openai.ts` ~line 8652: `reasoning_effort: "none"` is rejected for `gpt-oss-120b` with exactly
  `"reasoning_effort 'none' is not supported for
gpt-oss-120b. Use low, medium, or high."` — adapter A mirrors this
  deterministically at construction time.
- `src/cerebras.ts` → `fetchCerebrasChatCompletions` + `normalizeCerebrasChatCompletion`: the transport (URL, `Bearer`
  from the existing `CEREBRAS_API_KEY`, gateway deadline, Cerebras JSON-Schema projection) and the response normalizer.
  Adapter A reuses both, so its fake-transport tests exercise the _real_ gateway normalizer.

Baseline A loop: system + user message → Chat Completions request (official canonical tool definitions, `strict`
normalized to one value, default `false`) → normalized choice → tool execution through the benchmark tool layer →
recorded `model_request`/`model_response`/`tool_call`/`tool_result` events → final turn. Token counts become
`input_tokens`/`output_tokens` whenever the provider returns `usage`, else `0`.

LIVE-VERIFY (adapter A):

- Whether Cerebras actually rejects mixed per-tool `strict` values on one request for `gpt-oss-120b` (m01 probe evidence
  exists; the exact error string and status code need one live confirmation).
- Whether `usage.prompt_tokens`/`completion_tokens` are returned on every non-streaming `gpt-oss-120b` completion.
- Whether the canonical tool set (9 functions with `additionalProperties:
false`) is accepted by the Cerebras
  strict-tools path, and whether the model reliably returns JSON-string tool arguments (invalid JSON must be treated as
  a `valid: false` call — covered by tests).
- Whether `reasoning_content` appears and whether the gateway drops it (the baseline ignores reasoning fields, matching
  the gateway normalizer).

## Adapter B — codex-infinity-compatible process/trajectory bridge

Pinned primary-source record (verified 2026-08-29):

- Repository: https://github.com/lee101/codex-infinity
- Default branch: `main`; pinned commit `fbb52680c30a968384b15cfe6dadbec22faba73f` (author date `2026-08-24T11:08:14Z`;
  repo `pushed_at` `2026-08-24T11:08:17Z`).
- License: Apache-2.0 (both the fork and its upstream `openai/codex`); the fork ships a `NOTICE` file; upstream is
  Apache-2.0 as well.
- Relationship: `lee101/codex-infinity` is a **fork** of `openai/codex` (GitHub API `fork: true`,
  `source: openai/codex`).
- Package: `@codex-infinity/codex-infinity` (npm; install global on the CLI).
- README-verified provider facts: Cerebras provider is auto-detected from the model slug `cerebras/gpt-oss-120b` with
  env `CEREBRAS_API_KEY`; endpoint defaults to `https://api.cerebras.ai`; `CEREBRAS_BASE_URL` overrides it; the README
  also documents `-m/--model` and `--cd DIR`.

Bridge design (checked in, `benchmarks/baselines/adapter-b.ts`):

- Default configuration: `checkoutPath: null`, `allowLiveProcess: false`, no driver. `run()` throws
  `BaselineNotProvisionedError` — the adapter never clones, never spawns, and never reads environment variables.
- Live path: requires `allowLiveProcess: true`; when `checkoutPath` is set, `git -C <path> rev-parse HEAD` must equal
  the pinned commit (no clone, no network); the process is
  `codex-infinity -m cerebras/gpt-oss-120b --cd
<workspace> <task description>`. `--auto-next-steps`,
  `--auto-next-idea` and `--auto-next-goal` are deliberately excluded (they never terminate).
- Trajectory mapping: process lines are parsed by `parseCodexProcessLine` (assumed JSONL events
  `model_request`/`model_response`/`tool_call`/ `tool_result`); unparseable or unknown lines are skipped and counted,
  and a non-zero exit or any skipped line fails the run with `bridge-parse` instead of being interpreted as evidence.
- Deterministic driver: `scriptedBridgeDriverFromTrail()` replays the task's recorded `scripted_trail` as bridge events
  (with injected failures and wrong-tool flags preserved), used by focused tests.

LIVE-VERIFY (adapter B) — **critical**: all of these must be confirmed before any B result is admissible:

- The exact machine-readable output format of `codex-infinity` when launched non-interactively (JSONL? TUI escape
  sequences? `codex exec --json`-style event schema? `~/.codex/sessions/*.jsonl` transcripts?). Nothing about the real
  format is verified; `parseCodexProcessLine` is an explicit assumption.
- That `CEREBRAS_API_KEY` is picked up by the fork's provider autodetection without a `config.toml` edit, and that
  `CEREBRAS_BASE_URL` works when set.
- That `--cd` points the agent at the disposable benchmark workspace and that no global state (e.g. `~/.codex`, host
  caches) is written that would break run isolation.
- That tool use inside codex-infinity maps to the canonical tool names (`filesystem.read`, `shell.exec`,
  `editor.apply_patch`, …) at all; if the fork exposes its own tool surface, the mapping must be recorded here before
  comparability with A/C/D can be claimed.
- Exit codes and timeout behavior of the wrapped CLI (the bridge currently treats any non-zero exit as failure and
  relies on the runner's whole-run timeout for hangs).

## Adapter D — generic strong control (Browser-Use trace notes)

- D is a generic OpenAI-compatible Chat Completions agent loop with an injected transport, a configured model string,
  and no adapters reading process environment variables. No new secret, environment variable or CLI flag is introduced;
  the API key must be supplied via configuration by the owner of an approved live gate. The default instance uses the
  placeholder model `<unapproved-control-model>` with a `null` transport and refuses to run
  (`BaselineNotProvisionedError`).
- Browser-Use tracing: the plan names Browser-Use as the reference web-tool implementation; the Cerebras example lives
  at https://github.com/browser-use/browser-use/blob/main/examples/models/cerebras_example.py. No code was copied.
  LIVE-VERIFY: whether Browser-Use's Cerebras adapter exercises `gpt-oss-120b` with tools and structured output
  successfully, and which strictness/response-format combination it uses.
- LIVE-VERIFY (adapter D): any concrete control model is unapproved; `baseUrl`/`apiKey`/`model` must be owner-confirmed,
  and the model's tool-calling reliability profile has to be measured before D is used in a comparison.
  OpenAI-compatible completion payload differences (usage fields, refusal text) must be confirmed for the chosen
  provider.

## Runner refusal and registry integration

- `baselineAdapters()` (`benchmarks/baselines/registry.ts`) returns the default A/B/D instances in stable order; all
  three have `requiresExternalInference: true`.
- The runner (`benchmarks/runner.ts`) refuses any selected adapter with `requiresExternalInference: true` before
  executing (message: "refusing to run external-inference adapters … live runs are staged and gated by m03/m05"). This
  is asserted by `benchmarks/baselines/tests/registry.test.ts`.
- `benchmarks/adapter.ts` (`defaultAdapters()`) is owned by m02 and remains hermetic: the baselines are **not**
  registered there yet. Wiring `baselineAdapters()` into the shared registry is an orchestrator-owned integration step,
  deliberately left outside this worker's ownership.

## Verification of this record

- GitHub REST API (`/repos/lee101/codex-infinity`, commit list, license endpoint) and the raw `README.md` at the pinned
  ref were retrieved on 2026-08-29; pinned ref, license, fork relationship and package name come from those responses.
- All URLs in the table returned HTTP 200 on 2026-08-29 (the Cerebras API returned 401 unauthenticated, which confirms
  the endpoint exists).
- Nothing in this document is evidence of model behavior: every protocol claim beyond the gateway code anchors is marked
  LIVE-VERIFY.
