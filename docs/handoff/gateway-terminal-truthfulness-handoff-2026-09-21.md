# Gateway terminal truthfulness and completion validation handoff — 2026-09-21

## Status

Advisory handoff. Nothing in this document has been implemented, deployed, or accepted. This document authorizes no
source change, configuration change, deployment, or push. It records a diagnosis and a generalized improvement program;
the DeepSeek-specific delta is a separate document (`gateway-deepseek-adapter-delta-handoff-2026-09-21.md`).

Scope note: this is the **generalized, provider-agnostic** half of a two-part handoff. Every item here is stated in
terms that apply to any OpenAI-compatible upstream behind the Responses-API translation seam. Items whose remedy only
makes sense for one provider are deliberately excluded and belong in the delta document.

## Objective

Make the gateway's terminal event a truthful description of what the upstream actually did, and stop the gateway from
converting a broken or unusable upstream completion into a client-visible success.

Success means:

- a terminal event's `status` and `incomplete_details` reflect the upstream's own stop reason, including when the
  upstream stopped because it ran out of output budget;
- a syntactically valid but semantically unusable completion is not relayed as success;
- the gateway's own terminal vocabulary is used consistently across every provider route, so an operator reading
  telemetry sees the same facts regardless of which upstream served the request;
- each change names the exact upstream signal that triggers it, and each change has a stated reversal risk.

Out of scope for this document: prompt engineering, client-side loop behavior, and any change to which provider serves a
request.

> **Correction (2026-09-21, after this document was merged): the diagnosed condition below is an artifact.** The
> frequency figures in the table that follows - 154 of 292 turns, and 24 of 67 - are not reproducible from the sessions
> they cite. No unit (turns, messages, response items) yields those numbers, and the forward-looking-phrase test used to
> label a turn "promise-narration" fires on 76% of all assistant messages, including ordinary mid-task narration that is
> immediately followed by a tool call. Reading the turns to their end shows the model closing with substantive 4,000+
> and 6,000+ character summaries after hundreds of tool calls: honest completions, not early exits. See the
> measurement-artifact correction in `docs/DECISIONS.md` for the reconciled counts.
>
> The gateway defect this document identifies is **unaffected and still stands**: the terminal event could not
> distinguish a truncated upstream response from a completed one, which was independently reproduced. What does not
> stand is the claim that the narration symptom is frequent, and any model-versus-gateway contrast drawn from those
> rates. Read the rest of this document for the terminal-truthfulness program, not for the narration diagnosis.

> **Qualified on 2026-10-16 (#603): the artifact conclusion above is unverified, not established.** The reconciliation
> it cites never states the 13:26–13:56 UTC window these counts are scoped to, and its counterexamples are followed by
> a tool call, so the classifier defined below counts them as negatives; the 76% figure measures the bare phrase match,
> not that classifier. No recount applying the classifier inside the window is recorded, so the counts are neither
> reproduced nor shown to be an artifact, and still must not be quoted as a rate. See the qualified measurement-artifact
> correction in `docs/DECISIONS.md`.

## Diagnosed condition

A long-running agent on the responses path frequently believes its turn completed mid-task. The measured shape is that
the model emits an assistant narration message that promises the next action and then terminates without emitting any
tool call. The gateway then reports a well-formed `response.completed` with `status: "completed"`, and the client
correctly ends the turn.

Observed frequency in two active sessions during the 2026-09-21 13:26–13:56 UTC window:

| Session                | Turns | Ended with a tool call or result | Ended on promise-narration | Ended on a substantive answer |
| ---------------------- | ----: | -------------------------------: | -------------------------: | ----------------------------: |
| `sentinel`             |   292 |                                9 |                        154 |                           129 |
| `oracle-free-arch-vps` |    67 |                                2 |                         24 |                            41 |

Promise-narration is defined as a trailing assistant text that matches a forward-looking phrase (`let me`, `I'll`,
`now let`, `let's`, `I will`, `I'm going to`, `next I`) and ends the turn with no tool call after it.

Controlled reproduction of the same code path, with a realistic multi-turn tool-bearing history and outstanding work,
produced a tool call in 19 of 20 requests. The same instruction issued directly against the upstream Chat Completions
API returned `finish_reason: "tool_calls"` in 8 of 8 requests. That asymmetry is evidence that the dominant cause is
upstream model behavior rather than transport loss, and it is why this document does **not** claim the gateway causes
the narration-without-action symptom.

What the gateway does contribute is a **trustworthiness gap**: the terminal event it emits cannot distinguish several
materially different upstream outcomes, and in one case it currently converts a truncated upstream response into a clean
success. That gap is the subject of this handoff.

## Authoritative state at handoff

- Repository: `/Users/nv/repos/ubiquity/ai.ubq.fi`
- Branch: `development`
- Local `HEAD`: `2ed95f47de7205ffbc07f5dabc684f74e577a59e`
- `origin/development`: `922c33392d8a4670968ee850312aed9a7e024f08` (local checkout was behind by one commit at handoff
  time)
- Working tree: clean at the time of the audit
- Named local deployment: `http://127.0.0.1:7999`
- Live release identity: `git_sha` and `deployment_id` both `4176e992f5edce801cb125ebd0f1db47848d1b62`
- `GET /health`: HTTP 200, `status: "available"`

Recheck all of these before implementing; they drift.

## Confirmed evidence

### The terminal vocabulary already exists but is unreachable

The gateway declares a terminal type union that includes `response.incomplete`:

- `src/openai.ts:275` —
  `export type ResponseStreamTerminalType = "response.completed" | "response.failed" | "response.incomplete" | "error" | "eof" | "cancelled" | "deadline";`

`response.incomplete` is parsed when it arrives from an upstream: `src/openai.ts:692`, `:708`, `:2582`. It is never
_constructed_ by any provider route. The only construction site in the repository is
`src/sentinel_replay_capture.ts:345`, which is an evidence-recording path, not a response path.

Consequence: a route that truncates on output budget has no way to say so. Every truncated completion is reported as
`completed`.

### A truncated upstream completion is laundered into a clean success

Measured directly on the named local deployment, both directions, same prompt:

- Direct to the upstream with `max_tokens: 16`: `finish_reason = "length"`, `content = ""`.
- Through the gateway responses route with `max_output_tokens: 16`: terminal `response.completed`,
  `status: "completed"`, `incomplete_details: null`, output items `["reasoning"]`.

So an upstream response that stopped because it ran out of budget is delivered to the client as a successful completion
carrying only a reasoning item.

### A reasoning-only completion is accepted as semantic output

`src/deepseek.ts:651` defines the predicate that decides whether a translated stream carried anything a client can act
on:

```ts
export const deepSeekChunkHasSemanticOutput = (chunk: Record<string, unknown>): boolean => {
  ...
    if (typeof delta.content === "string" && delta.content.length > 0) return true;
    // Reasoning is streamed to the client as it is generated, so it is real
    // semantic output even when the final answer has not started yet.
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
```

The predicate answers "did the client see _something_", which is a different question from "did the client see an
_answer_". A stream that produced only reasoning satisfies it.

### The same gateway already disagrees with itself about whether reasoning is output

There are three near-identical predicates in this repository that answer "did this completion carry anything usable",
and they do not agree:

| Predicate                                 | Location              | Counts `content` | Counts reasoning              | Counts tool calls           |
| ----------------------------------------- | --------------------- | ---------------- | ----------------------------- | --------------------------- |
| `cerebrasChatCompletionHasSemanticOutput` | `src/openai.ts:2094`  | yes              | **no**                        | yes (also counts `refusal`) |
| `deepseekChatCompletionHasSemanticOutput` | `src/openai.ts:9669`  | yes              | **yes** (`reasoning_content`) | yes                         |
| `deepSeekChunkHasSemanticOutput`          | `src/deepseek.ts:651` | yes              | **yes** (`reasoning_content`) | yes                         |

This is the most useful generalized finding in the audit, because it removes the need to argue about which answer is
correct. One gateway, one codebase, two providers, opposite answers to the same question — so at most one of them can be
right, and the divergence is itself the defect regardless of which side is which.

It also explains why the DeepSeek route launders a reasoning-only truncation into success while the Cerebras route
reports one closed. The Cerebras reasoning-only behavior is documented repository policy in `AGENTS.md` ("Upstream
Provider Constraints"): a Cerebras response that stops at the token budget can carry reasoning only, and the gateway
deliberately fails that closed as `cerebras_upstream_invalid_response` (502) "rather than returning an unusable empty
completion". The DeepSeek route, on the same gateway, does the opposite.

**Generalized consequence.** A route-local predicate can drift. Any fix to G2 should therefore express the rule once and
have every translation route consume it, rather than patching `deepSeekChunkHasSemanticOutput` in place and leaving the
next provider to re-derive the question. The per-provider differences that legitimately survive are matters of _field
naming_ (`reasoning` vs `reasoning_content` vs `refusal`) and of _which reasons count_, not of whether reasoning is an
answer.

Note also that the two DeepSeek predicates are not equivalent to each other. `src/deepseek.ts:651` is the streaming
predicate; `src/openai.ts:9669` is the buffered-completion predicate. A fix applied to only one of them leaves the other
route shape wrong, so both must move together.

### The DeepSeek routes bypass the gateway's own fail-closed machinery

The gateway already has a fail-closed path for empty upstream completions, but the DeepSeek routes do not pass through
it.

- `src/openai.ts:1270` `responsesStreamTerminalFailure` returns `{ trigger: "empty_upstream_completion" }` when a
  prepared stream reached `response.completed` with `prepared.semantic === null`.
- `src/openai.ts:10448` `chatCompletionPreflightIsEmpty` and `src/openai.ts:10462` `rejectEmptyChatCompletion` implement
  the same idea for the chat route, returning a 502 `empty_upstream_completion` (`src/openai.ts:10474`).
- Those call sites are at `src/openai.ts:1400` and `src/openai.ts:10663`, both on the ordinary Codex/paid waterfall.
- `src/openai.ts:11838` dispatches an explicit DeepSeek model id to `handleDeepSeekResponses` **before** the catalog
  lookup, so the request never reaches `prepareResponsesRequest`, `runResponsesFailover`, or
  `responsesStreamTerminalFailure`.
- `src/openai.ts:10703`–`:10688` does the same for the chat route: `handleDeepSeekChatCompletions` is dispatched before
  `validateChatCompletionsOptions` and the preflight.

The DeepSeek routes therefore own their own terminal behavior, and their `finishStream` settles `response.completed`
unconditionally:

- `src/openai.ts:10134` `finishStream` records `settleTerminal("response.completed")` with no check on whether any
  output item exists.
- `src/deepseek_responses.ts:827` builds the terminal envelope with the literal status `"completed"`.

### `finish_reason` is parsed and then discarded on the DeepSeek path

- `src/deepseek.ts:594` accepts any string `finish_reason` and only rejects a non-string.
- `src/deepseek.ts:603` copies it forward into the normalized chunk.
- `src/deepseek_responses.ts` contains **zero** occurrences of `finish_reason`. The translator's `push`
  (`src/deepseek_responses.ts:815`) reads only `choice.delta`.

The value therefore survives normalization and is never read by any logic that could act on it.

### CORRECTION (2026-09-21, post-research): the truncation is live, not latent

An earlier version of this document argued that output-budget truncation was unreachable in current traffic because the
client sends no cap and 1096 of 1096 sampled terminal records showed a null allowance. GPT Pro research and a direct
probe falsified that inference, and the corrected finding is materially more serious.

No client-specified cap does **not** mean no cap. DeepSeek applies a default when `max_tokens` is omitted, and that
default varies with reasoning effort. Measured directly against the provider:

| `reasoning_effort` | Default `max_tokens` observed | Behavior on an oversized demand                                            |
| ------------------ | ----------------------------: | -------------------------------------------------------------------------- |
| `none`             |                         8,192 | `finish_reason: "length"` at exactly 8191–8192 completion tokens, reliably |
| `high`             |                      ≥ 65,536 | `stop` on the same demand                                                  |
| `max`              |                     ≥ 131,072 | `stop`; a maximal "write forever" prompt still stopped at 7,899 tokens     |

`max_tokens` accepts the range 1–393,216; 393,217 is rejected with
`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`.

**The laundering is therefore reachable end-to-end, and was reproduced through the gateway.** Same prompt, three direct
upstream runs versus one gateway run:

- Direct upstream, `reasoning_effort: "none"`, exhaustive multi-hundred-thousand-word demand: `finish_reason: "length"`,
  `completion_tokens` 8192 / 8192 / 8191, content 25658 / 26008 / 23366 chars. Three of three.
- Through the gateway, identical prompt and effort: terminal `response.completed`, `status: "completed"`,
  `incomplete_details: null`, output items `["message"]`, `output_tokens: 8192`, visible text 27279 chars.

So a request the upstream explicitly cut off at its budget was delivered to the client as a clean, complete answer. The
`output_tokens: 8192` in the gateway's own telemetry is the truncation signature, and nothing in the terminal event
reports it.

**Exposure today.** Production is overwhelmingly `max`: of 4153 recent DeepSeek terminal records, 4146 are `max`, 4 are
`high`, and 3 are `none`. At `max` the default allowance is at least 131,072 and no probe reached it, so the _current_
dominant traffic is not hitting the cap. The defect is nevertheless client-reachable now — effort `none` is advertised
in our own catalog (`supported_reasoning_levels` includes `none`) and any client selecting it truncates at 8,192 into a
silent success — and it is one config change away from becoming dominant. Treat it as a live correctness defect, not a
latent one.

**What this does and does not explain.** It does not explain the narration-without-action symptom: those turns ended at
~120–180 output tokens, far below any default, and the controlled reproduction produced faithful tool calls 19 of 20
times. The two are separate defects that happened to be investigated together.

## Research-informed terminal mapping (specification findings)

GPT Pro research was used to settle the specification questions the code cannot answer. Its findings are recorded here
with an explicit confidence marker, because they are documentation-derived rather than probe-verified and one research
claim (the `reasoning_content` replay scope) was falsified by direct probe in the companion document. Do not treat the
following as verified facts of this repository; treat them as the strongest available reading of the public
specification, to be confirmed before implementation.

- **`response.completed` describes completion of the model response, not completion of the user's objective.** This is
  the most important framing result. A response containing function calls is a _complete_ model response even though
  external execution and further model turns remain necessary. It follows that the narration-without-action symptom is
  not a protocol violation by construction, and no terminal mapping can turn it into one.
- **The reason vocabulary is reported as `max_output_tokens`, `max_messages`, `content_filter`, and `steered`.** The
  last is tied to WebSocket steering and an automatically created successor response, so it has no bearing here.
  Research also warns of a documentation inconsistency: an older streaming-reference example used `max_tokens` inside
  `incomplete_details` while the current schema and the reasoning guide use `max_output_tokens`. Confirm before writing
  any mapping table; emitting the wrong spelling is a silent contract break.
- **Reaching the context-window boundary is also reported as `max_output_tokens`.** That makes the reason string
  under-describe the context case. Our own provider compounds this: DeepSeek's `length` covers context exhaustion as
  well as output-budget exhaustion (companion document, Delta 1).
- **There is no specified `incomplete_details.reason` for "the model promised an action and did not perform it".**
  Research states plainly that one must not be fabricated, that token exhaustion must not be used as a relabel, and that
  content filtering must not be repurposed as a continuation signal. This is specification-level confirmation of the
  ownership verdict below.
- **An absent `finish_reason` has no specified translation.** Research treats it as an adapter-contract problem rather
  than evidence of any particular termination cause. Two implementation consequences follow: never treat an absent
  reason as proof of a normal stop, and always defer the terminal until the stream's own end sentinel so a late-arriving
  reason is still available.
- **A malformed function call is not automatically a broken stream.** Generated arguments may legitimately contain
  invalid JSON or unsupported parameters, in which case a fully delivered call is a model-output problem for the
  executor to reject and feed back, not a transport failure. A call _truncated_ by budget exhaustion is the different
  case and must not be authorized merely because its received prefix happens to parse.

### Correspondence with a provider-authored client's four-way reason split

The companion document's Delta 1 records that DeepSeek's own client maps the upstream reason onto four distinct outcomes
— `stop`, `tool-calls`, `max-tokens`, and a fail-closed `error` carrying the uppercased unknown value. That is an
independent, provider-authored implementation of the mapping this document recommends in G1, and it diverges from our
current behavior in exactly the way G1 predicts. Where a vendor's own client and a gateway disagree about the meaning of
the vendor's own field, the vendor's reading should carry weight.

## Generalized improvement program

Each item states the change, the exact upstream signal that triggers it, the failure mode it prevents, and its reversal
risk.

### G1 — Map upstream stop reasons onto the correct terminal event

Change: define one provider-neutral mapping from an upstream stop reason to the gateway's terminal vocabulary, and apply
it on every route that translates an upstream stream.

Target mapping, subject to the specification check in Open Question Q1:

| Upstream stop reason             | Gateway terminal                                                        | Notes                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stop`                           | `response.completed`                                                    | A normal stop, subject to G2's output-validity check.                                                                                                              |
| `tool_calls`                     | `response.completed`                                                    | A tool call is a normal turn continuation, not an incompletion.                                                                                                    |
| `length`                         | `response.incomplete`, `incomplete_details.reason: "max_output_tokens"` | The new behavior. Carries the truth that the upstream stopped early. Note the reason string also covers context-window exhaustion, so it under-describes one case. |
| `content_filter`                 | `response.incomplete`, `incomplete_details.reason: "content_filter"`    | Research-supported. Preserve the filtering outcome; do not disguise it as a successful empty answer.                                                               |
| absent or any unrecognized value | Fail closed (`error`), not `response.completed`                         | Absence is unknown, not proof of a normal stop. Preserve the value (or its absence) in telemetry.                                                                  |

Signal that triggers it: the upstream `finish_reason` string, including its absence, on the terminal chunk of the
translated stream. An absent reason is handled as unknown rather than inferred to be `stop`.

Failure mode prevented: a client and an operator cannot distinguish "the model finished" from "the model was cut off",
so a truncation is indistinguishable from a natural stop in both the UI and the telemetry.

Reversal risk: mapping non-`stop` reasons to a non-completed terminal changes client-visible behavior for every route
that adopts it. If a client treats any non-success terminal as a hard error rather than a resumable condition, this
converts a silent degradation into a visible failure. That is the intended direction, but it must be verified against
the actual client before rollout. Roll out one route first.

### G2 — Decide completion validity on answer-bearing output, not on any output

Change: separate the two questions the current predicate conflates. "Did the client receive bytes" is a streaming
progress question. "Is this a usable completion" is a terminal-validity question. Only the second should gate the
terminal event.

Apply G1's stop-reason mapping before this validity check. A mapped stop reason takes precedence over output shape: in
particular, `length` remains `response.incomplete` even when the stream already contains a message or tool call, and an
absent or unrecognized reason remains fail-closed. Only a reason whose G1 mapping permits a completed terminal reaches
the output-validity rules below; G2 and G3 must not relabel a mapped incomplete or fail-closed terminal based on its
output items.

Decision rule for the terminal event, evaluated in order:

| Condition                                                   | Terminal                 | Rationale                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stop reason `length`                                        | incomplete               | G1 owns this mapping even when other output items were emitted.                                                                                                                                  |
| Stop reason `content_filter`                                | incomplete               | G1 preserves the filtering outcome instead of allowing output shape to relabel it.                                                                                                               |
| Absent or unrecognized stop reason                          | Fail closed              | G1 treats an unknown reason as an adapter error, never as a normal stop.                                                                                                                         |
| Stop reason `tool_calls`, with at least one tool call       | completed                | The turn continues.                                                                                                                                                                              |
| Stop reason `stop`, with a non-empty assistant message      | completed                | The model produced an answer.                                                                                                                                                                    |
| Stop reason `stop`, only reasoning, no message or tool call | **unspecified — see Q2** | This is the interesting case: the model spent budget thinking and then stopped. Whether that is a completion or a degenerate stop is a specification question, not an implementation preference. |
| Stop reason `stop`, with zero output items                  | Not completed            | See G3.                                                                                                                                                                                          |

Reasoning-only output remains in the G1/G2 decision path: G1 controls a `length`
stop, while G2 leaves a `stop` reason to Q2. G3 never applies because the reasoning
item counts as an output item; the Cerebras reasoning-only policy therefore remains
fail-closed rather than being relabeled as an empty completion.

Signal that triggers it: the presence and kind of terminal output items together with the stop reason from G1.

Implementation constraint: express the rule once, not per route. The audit found the same question already answered
differently in `src/openai.ts:2094` (Cerebras: reasoning is not output), `src/openai.ts:9669` and `src/deepseek.ts:651`
(DeepSeek: reasoning is output). Pick one answer, share it, and let providers contribute only field names and their own
reason vocabulary.

Failure mode prevented: a response with no answer is relayed as success, and a downstream consumer that only checks HTTP
200 or `status == "completed"` cannot tell.

Reversal risk: a client that currently receives a technically-empty completion and recovers on its own would instead
receive a non-success terminal. Verify against the real client before enabling.

### G3 — Fail closed on a degenerate completion, using the existing vocabulary

Change: reuse the gateway's existing `empty_upstream_completion` failure classification for the translation routes,
rather than inventing a second mechanism.

The gateway already fails closed when a stream reached a completed terminal with no translated semantic output
(`src/openai.ts:1270`, `:10432`, `:10446`). The DeepSeek routes bypass that machinery by dispatch order
(`src/openai.ts:11838`, `:10688`). The generalized fix is to give every translation route an equivalent pre-terminal
validity check at its own terminal seam, and to classify the outcome with the same failure kind the rest of the gateway
already uses, so telemetry stays comparable across providers.

Signal that triggers it: only after G1 and G2 have handled the stop reason, when a stream is about to emit its terminal
event with exactly zero output items. Do not trigger G3 merely because answer-bearing output is empty: a reasoning item
is still an output item, so reasoning-only outcomes remain with G1/G2 rather than triggering G3.

Failure mode prevented: the gateway reports success for a response that gives the client nothing to act on.

Reversal risk: a legitimate upstream `stop` with genuinely empty content becomes a 502 where it is currently a 200. That
is the intended trade, but it is a behavior change for any caller that tolerates empty completions.

### G4 — Treat a consumed reasoning budget as a distinct, reportable condition

Change: when a completion's answer-bearing output is empty and its reasoning accounting shows the budget was consumed by
reasoning, record that condition in the telemetry with its own failure or incompletion classification, distinct from
both "upstream produced nothing at all" and "upstream was unreachable at the transport level".

Signal that triggers it: reasoning token accounting reaching the request's output allowance, and the output-token
allowance being present at all.

Failure mode prevented: three different underlying conditions — upstream produced nothing, upstream spent everything
thinking, upstream transport failed — collapse into one indistinguishable success or one indistinguishable error, so
neither an operator nor an automated policy can choose the right response.

Reversal risk: low, provided the classification is additive telemetry rather than a new client-visible terminal. Do the
telemetry half first.

Note on a constraint this implies: a route cannot detect budget exhaustion if it never sends a budget. Detecting this
condition requires an allowance to compare against, which is why G5 is a prerequisite rather than an independent nicety.

### G5 — Make the output allowance explicit and observable instead of implicit

Change: every translation route should know and report the effective output allowance it applied, including the case
where the gateway itself supplies a default because the client sent none.

Current state: the client sends no cap at all (1096 of 1096 sampled records show a null allowance), so the effective cap
is the provider's effort-dependent default — measured at 8,192 for effort `none`, and at least 65,536 / 131,072 for
`high` / `max`. The gateway reports `output_token_allowance: null` and cannot tell whether a `length` stop was reached
against the client's intent or against an unknown provider default. Because the provider default is not uniform, a
truncated and a completed response can carry the same null allowance, which is exactly why the terminal event must not
rely on the allowance in order to be truthful.

Signal that triggers it: a request that omits an output cap.

Failure mode prevented: a truncation cannot be attributed, because nobody recorded what the budget was.

Reversal risk: introducing a gateway-supplied default cap changes generation behavior for every request that currently
relies on the upstream default. This must be a deliberate, reviewed decision with a stated default, not an incidental
side effect of adding observability. Do the observability half first and decide the default separately.

## Ownership verdicts

For each generalized item, where the fix actually belongs:

| Item                             | Verdict                                                  | Reasoning                                                                                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 terminal mapping              | Gateway                                                  | The gateway owns the translation seam and is the only component that sees both the upstream stop reason and the client's terminal contract.                                                                                                                                                       |
| G2 validity predicate            | Gateway                                                  | Same seam. This is a decision the gateway must make because it is the component that knows the stream ended with nothing usable.                                                                                                                                                                  |
| G3 degenerate completion         | Gateway                                                  | The gateway already does this elsewhere; the gap is route coverage, not capability.                                                                                                                                                                                                               |
| G4 reasoning-budget condition    | Gateway classification, upstream for the root cause      | The gateway can only classify; it cannot make the model answer instead of thinking. Do not attempt to fix the model's budget allocation in the gateway.                                                                                                                                           |
| G5 output allowance              | Gateway observability; client or operator for the policy | The gateway must report the effective allowance. Choosing a default cap is a product decision with real cost consequences and must not be made unilaterally by the gateway.                                                                                                                       |
| Narration-without-action symptom | **Neither, on current evidence**                         | The controlled reproduction shows the gateway relays a faithful tool-call response 19 of 20 times and the upstream returns tool calls 8 of 8 direct. There is no evidence the gateway loses a tool call. Do not build gateway machinery to compensate for an upstream behavior it cannot control. |

The last row is the most important negative result in this handoff. Building a "the model promised an action and didn't
act" heuristic into the gateway would mean inventing a semantic judgment about model intent in the transport layer, and
would fire on legitimate completions that happen to end with a forward-looking phrase. The correct remedies for that
symptom are client-side loop policy or model/effort configuration, both of which are outside this document's scope.

## Open questions requiring a specification answer before implementation

These are recorded as open because the current implementation cannot answer them and neither can inference from the
code.

- **Q1.** **Partially answered by research, still to be confirmed.** Research supports `response.incomplete` with
  `incomplete_details.reason: "max_output_tokens"` for output-budget exhaustion and `"content_filter"` for filtering,
  and warns that one streaming-reference example mis-spells the former as `max_tokens`. Confirm against the primary
  reference before implementing, and settle whether the context-window case should share the `max_output_tokens` reason
  or be distinguished.

- **Q2.** For a completion whose only output is reasoning and whose stop reason is `stop` rather than `length`, is the
  specified behavior completion or incompletion? The current gateway says completion; that may be correct.
- **Q3.** **Answered by research: no.** There is no specified incomplete reason meaning "the model promised an action
  but did not perform it", and research advises against fabricating one, relabeling it as token exhaustion, or reusing
  filtering as a continuation signal. This confirms the ownership verdict that the narration-without-action remedy is
  not gateway-side. The residual engineering question is only whether an agent-aware gateway should enforce such a rule
  under its _own_ service contract, explicitly labeled as product behavior rather than faithful protocol translation.

- **Q4.** What is the upstream's own default output allowance when a request omits one, and is it stable enough to
  report as a known quantity? Without this, G5's observability half can report only `null` plus a flag.

## Suggested sequencing

1. Answer Q1 and Q2 from primary specification sources. Do not implement G1 or G2 before these are settled.
2. Implement G5's observability half only (report the effective allowance, still `null` when there is none). No behavior
   change.
3. Implement G3 on one translation route, behind the existing `empty_upstream_completion` classification, and verify
   against the real client.
4. Implement G1 for the `length` case only, on the same route, and verify the client's behavior on a non-completed
   terminal.
5. Implement G2 once Q2 is settled.
6. Decide G5's policy half and G4's client-visible half separately, with explicit review.

Each step is independently reversible and independently verifiable. None of them is a prerequisite for diagnosing the
narration-without-action symptom, which is why the sequencing starts with truthfulness rather than with that symptom.

## Reference freshness

Every `src/...` line number in this document was re-verified semantically at working state
`48eed83fd8241f7eab0bf72037cd968bb0bff45d` — each citation was checked to still name the intended symbol, not merely to
fall inside the file.

Line numbers had already drifted once during this handoff. The documents were first written against
`2ed95f47de7205ffbc07f5dabc684f74e577a59e`; a single unrelated merge (`922c33392d`, "serve gpt-reserve under its own
quota class", +16 lines in `src/openai.ts` across three hunks at +11/+12/+16) invalidated 26 citations. Two survived a
naive bounds check while pointing at the wrong line, which is why the correction pass verifies the symbol and not the
position.

Consequences for a future reader:

- Treat every line number here as a claim about a specific revision, not a stable address. Re-resolve by symbol (grep
  for the function or constant name) before acting on a citation.
- Prefer the named symbol over the number when quoting this document in a new one.
- If HEAD has moved, re-run the semantic check rather than applying an arithmetic offset, because the drift is not
  uniform across hunks.

## Evidence provenance

- Session transcripts:
  `/Users/nv/.codex/sessions/2026/09/21/rollout-2026-09-21T09-36-07-01a0c42e-588f-7991-a96c-8b34b262d4b0.jsonl`,
  `/Users/nv/.codex/sessions/2026/09/19/rollout-2026-09-19T22-13-39-01a0bc97-2f60-7be3-83ef-1fecb5c94f44.jsonl`,
  `/Users/nv/.codex/sessions/2026/09/20/rollout-2026-09-20T02-01-05-01a0bd67-63e7-7992-9d31-16a4d875da24.jsonl`
- Gateway telemetry: `request_terminal` records in `/Users/nv/repos/ubiquity/ai.ubq.fi/.data/mac.stdout.log`
- Error index: `GET http://127.0.0.1:7999/admin/errors?limit=500`
- Controlled reproduction: gateway responses route and direct upstream Chat Completions calls, both executed 2026-09-21
  during the audit window
- Source references were verified at `48eed83fd8241f7eab0bf72037cd968bb0bff45d` (see Reference freshness above)
