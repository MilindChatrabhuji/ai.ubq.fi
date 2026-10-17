# DeepSeek adapter delta handoff — 2026-09-21

## Status

Advisory handoff. Nothing in this document has been implemented, deployed, or accepted. This document authorizes no
source change, configuration change, deployment, or push.

Scope note: this is the **DeepSeek-specific** half of a two-part handoff. Read
`gateway-terminal-truthfulness-handoff-2026-09-21.md` first. That document owns the provider-agnostic program (G1–G5)
and the ownership verdicts; this one owns only the deltas that would make no sense for another upstream. Where an item
here depends on a generalized item, the dependency is named explicitly rather than restated.

The comparison baseline is the DeepSeek Harness's own first-party DeepSeek client, `@deepseek-ai/dsh-llm-deepseek`,
which is the provider vendor's own reference implementation of a DeepSeek Chat Completions adapter. Studying it is
high-value precisely because it is upstream-authored: where our gateway and DeepSeek's own client disagree on how to
interpret a DeepSeek response, the disagreement is evidence about the provider's intent, not merely a difference of
taste.

## Objective

Bring our DeepSeek translation layer to parity with the provider's own client on the specific semantics where a delta
could change client-visible behavior, and document the deltas we deliberately keep.

Success means:

- every DeepSeek-specific interpretation our gateway makes is either intentionally the same as the vendor client's or
  explicitly recorded as a deliberate divergence with a reason;
- no DeepSeek-specific guard is missing where the vendor client ships one;
- each delta names the exact upstream signal that triggers it and the exact file and line where our gateway currently
  sits.

## Baseline: the DSH DeepSeek client as installed

| Fact                               | Value                                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| Package                            | `@deepseek-ai/dsh-llm-deepseek`                                    |
| Version                            | `0.1.1-rc.2`                                                       |
| Install path                       | `~/.dsh/profiles/tui/node_modules/@deepseek-ai/dsh-llm-deepseek`   |
| Harness CLI version                | `dsh` `0.1.5-rc.2`                                                 |
| Key file                           | `lib/index.js` (78334 bytes)                                       |
| SHA-256 `lib/index.js`             | `eed9492246cc6451f060de211768d3128388046478deae7f1959de7cde56ea82` |
| SHA-256 `README.md`                | `bf8bbaf9193036b657512fbc19f1c99eb203cdf5e97d895e403b5a6c18852efa` |
| SHA-256 `lib/types/translate.d.ts` | `567371eda35fce8b9c8d71338ce3f8fad220ce5fd82ddc0ab711a8d5077bc261` |

Re-verify the hashes before relying on any specific line number below. The line references are to this exact installed
revision.

This is a client, not a gateway. It talks directly to `https://api.deepseek.com` and does not translate to the Responses
API. So the comparison is not "how do we match their wire format" — it is "how does the provider's own client decide
what a DeepSeek response _means_, and do we agree."

## Summary of deltas

| #   | Delta                                                             | Verdict                                          | Client-visible today?                             |
| --- | ----------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| 1   | `finish_reason` interpreted by the vendor, discarded by us        | Fix via generalized G1                           | Yes — `length` and `insufficient_system_resource` |
| 2   | Degenerate completion fails closed in the vendor, succeeds for us | Fix via generalized G3                           | Yes, when reachable                               |
| 3   | Vendor always sends an output cap; we never do                    | Fix via generalized G5                           | Indirectly — it is why Delta 1 bites              |
| 4   | `reasoning_content` replay scope differs                          | **Keep ours**; record the empirical boundary     | No — our rule matches all four probe outcomes     |
| 5   | Vendor sends `thinking.type`, we send `reasoning_effort: none`    | **Keep ours**; re-probe on provider change       | No — measured equivalent                          |
| 6   | Vendor subtracts cache reads; we relay them                       | **Keep ours**; do not "fix" toward the vendor    | No — different contracts by design                |
| 7   | Request-shape differences with no behavioral delta                | Record only                                      | No                                                |
| 8   | Thinking mode rejects `tool_choice` values we forward             | **Fix** — new finding, not in the original scope | Yes — HTTP 400                                    |

## Delta 1 — `finish_reason` is interpreted by the vendor client and discarded by us

**Vendor behavior.** `mapFinishReason` (`lib/index.js:910`) maps the wire vocabulary onto four distinct outcomes:

```js
function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
      return { kind: "stop" };
    case "tool_calls":
      return { kind: "tool-calls" };
    case "length":
      return { kind: "max-tokens" };
    default:
      return {
        kind: "error",
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      };
  }
}
```

Three deliberate properties:

1. `length` becomes a _distinct_ reason (`max-tokens`), not a generic stop.
2. An _unrecognized_ reason becomes an `error` finish with the uppercased value as its code, rather than being silently
   treated as a normal stop. The vendor README names `content_filter` and `insufficient_system_resource` as examples
   that take this path.
3. The mapped reason is deferred to the `[DONE]` sentinel (`lib/index.js:997`, inside `translate` at `:969`) so that no
   chunk follows `finish`, and `usage` always precedes `finish`.

**Our behavior.** `src/deepseek.ts:594` accepts any string `finish_reason` and only rejects a non-string.
`src/deepseek.ts:603` copies it onto the normalized chunk. `src/deepseek_responses.ts` contains zero occurrences of
`finish_reason`; the translator's `push` (`src/deepseek_responses.ts:814–815`) reads only `choice.delta`. No logic
branches on the value anywhere on the DeepSeek path.

**Delta.** We discard a value the vendor considers semantically load-bearing, and we do not distinguish an unrecognized
reason from a normal stop.

**Remedy.** This is an instance of generalized **G1**. The DeepSeek-specific part is the vocabulary. Research and the
vendor client together give a six-value set:

| DeepSeek value                 | Meaning                                           | Proposed terminal                                                      |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `stop`                         | Normal stop, including a configured stop sequence | `response.completed`                                                   |
| `tool_calls`                   | Tool call generated                               | `response.completed` (with actual call items present)                  |
| `length`                       | Output allowance **or context limit** exhausted   | `response.incomplete`, reason `max_output_tokens`                      |
| `content_filter`               | Filtering termination                             | `response.incomplete`, reason `content_filter`                         |
| `insufficient_system_resource` | Inference-resource interruption                   | `response.failed`                                                      |
| `aborted`                      | Generation interrupted, cause unspecified         | `response.failed` unless separately established as caller cancellation |

Two risks in that table are worth stating explicitly. First, `length` covers **context** exhaustion as well as
output-budget exhaustion, so a mapper must not assume the reason string implies an output-token cap was the binding
constraint. Second, the terminal column is our proposed mapping, not a provider-published crosswalk.

`insufficient_system_resource` is the priority case. It is a real provider condition, our gateway currently reports it
to the client as a clean completion, and unlike `length` it has no benign interpretation.

**Confidence.** High for the vendor behavior (read directly from the installed source and confirmed in its README).
Medium-high for the six-value set: it is research-sourced and consistent with the vendor's open-ended `default` branch,
but it is not a direct reading of the provider reference. Confirm before writing the table — this is Q5.

## Delta 2 — the vendor client fails closed on a degenerate completion; our route does not

**Vendor behavior.** At `[DONE]` (`lib/index.js:996–1006`, `EMPTY_RESPONSE_CODE` at `:1004`):

```js
const reason = pendingFinish ?? { kind: "stop" };
yield {
  type: "finish",
  reason: reason.kind === "stop" && order.length === 0
    ? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } }
    : reason
};
```

`EMPTY_RESPONSE` is a canonical provider-neutral harness code with a documented rationale in
`dsh-llm/lib/types/error.d.ts`:

> Canonical provider-neutral code for a response that completed normally but carried no content blocks at all. Providers
> occasionally emit a degenerate completion (a terminal stop with zero output); adapters classify it as this failure
> instead of yielding an empty assistant message, because an empty message silently ends the turn with nothing for the
> user or the loop to act on. The attempt produced nothing durable, so retry policy treats it as safe to repeat.

`EMPTY_RESPONSE` is the **first entry** in the harness default retryable set (`dsh-llm/lib/index.js:360–366`):
`[EMPTY_RESPONSE, "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]`, default `maxRetries: 5`.

**Our behavior.** `finishStream` in `streamDeepSeekResponses` records `settleTerminal("response.completed")` with no
check on whether any output item exists. The terminal envelope is built with the literal status `"completed"`. The
gateway does have exactly this guard elsewhere — `responsesStreamTerminalFailure`, `chatCompletionPreflightIsEmpty`,
and `rejectEmptyChatCompletion` — but the DeepSeek routes are dispatched before that machinery (`handleDeepSeekResponses`
for responses, `handleDeepSeekChatCompletions` for chat) and never reach it.

**Delta.** The vendor treats a zero-block completion as a classified, retryable failure. We treat it as success. This is
generalized **G3**, and the vendor's existence proof strengthens it: this is not a hypothetical defensive guard, it is
behavior the provider's own client ships and retries.

**Remedy.** Generalized **G3**, adopting the vendor's classification shape. Our gateway already has the comparable kind
(`empty_upstream_completion`, 502), so the semantic vocabulary does not need inventing — but note the vendor chose
_retryable_, and ours is currently a terminal 502. See Q7.

**Important limitation of this delta.** The vendor's guard fires on `order.length === 0`, where `order` accumulates a
block for _every_ kind, including a reasoning block (`open("reasoning")` at `lib/index.js:1021`) and a text block
(`open("text")` at `:1038`). So the vendor guard does **not** fire on narration-without-action: narration opens a text
block, so `order.length > 0` and the finish is a normal `stop`. It equally does not fire on reasoning-only output with a
`stop` reason. **Neither the vendor client nor our gateway catches the symptom this investigation started from.** That
is direct evidence the narration-without-action symptom is not a defect either implementation was designed to catch, and
it supports the generalized document's verdict that the remedy does not belong in the transport layer.

**Confidence.** High — read directly from the installed source; the rationale is quoted from the vendor's own type
documentation.

## Delta 3 — the vendor client always sends an output cap; our client never sends one

**Vendor behavior.** `DEFAULT_MAX_TOKENS = 256000` (`lib/index.js:1155`). The config schema defaults `maxTokens` to it
(`lib/index.js:1634`), it resolves through `resolveAdapterOptions` as `config.maxTokens ?? 256e3` (`lib/index.js:1735`),
exact-model resolution exposes the winner as `defaultMaxTokens` (`lib/index.js:1366`), and the runtime materializes it
into every request. `requestWithMessages` (`lib/index.js:245`, the `max_tokens` spread) then serializes it:
`...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens }`.

The vendor README states the intent: the value is resolved _before_ the agent loop writes its `request/header`, "so the
wire request remains reconstructable". It also notes the adapter deliberately does **not** clamp this against the
context window: "deployments with a smaller context or provider output limit must configure a compatible `maxTokens`."

**Our behavior.** Codex sends no `max_output_tokens` and no `max_completion_tokens`. Measured: 1096 of 1096 sampled
`request_terminal` records show `output_token_allowance: null`, and 3285 of 3285 in a wider sample. `applyOutputLimit`
(`src/deepseek_responses.ts:361`) returns unchanged when the field is absent, so nothing is written to the upstream
body.

**What we now know the provider does instead, and why this matters more than it first appeared.** DeepSeek applies its
own default when `max_tokens` is omitted, and that default depends on reasoning effort. Measured directly:

| `reasoning_effort` | Effective default `max_tokens` | Observed on an oversized demand                                                 |
| ------------------ | -----------------------------: | ------------------------------------------------------------------------------- |
| `none`             |                      **8,192** | `finish_reason: "length"` at 8191–8192 completion tokens, 3 of 3 runs           |
| `high`             |                       ≥ 65,536 | `stop` on the same demand                                                       |
| `max`              |                      ≥ 131,072 | `stop`; a maximal "keep producing forever" prompt still stopped at 7,899 tokens |

The accepted range is 1–393,216; 393,217 is rejected with
`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`.

So the implicit allowance is **not uniform across efforts**, which means a truncated and a completed response can both
carry `output_token_allowance: null` in our telemetry. That is the concrete reason the terminal event cannot rely on the
allowance to be truthful.

**Delta.** The vendor makes the output budget an explicit, logged, reconstructable fact and picks a large default. We
make it an implicit provider default that appears in our telemetry as `null`, and at effort `none` that default is small
enough to truncate real work — where Delta 1 then launders the truncation into a clean success. Deltas 1, 3, and the
generalized `length` mapping compound into a single end-to-end defect.

**Remedy.** Generalized **G5**, observability half first, following the vendor's resolve-before-the-request-header
pattern.

**Caution.** Adopting the vendor's _value_ (256000) is a separate decision from adopting its _observability_. 256k is
the vendor's chosen policy for a direct client, not a documented provider limit, and it sits below the provider's own
393,216 maximum. Decide the value on its own merits. Note also that our production traffic is 4146 of 4153 at effort
`max`, where the provider default is already ≥131,072 and no probe reached it — so the _observed_ exposure today is
concentrated at effort `none`, which our catalog still advertises as a supported tier.

**Confidence.** High for both sides and for the default table; all direct readings or direct probes.

## Delta 4 — `reasoning_content` replay: our rule is correct, and narrower than the vendor's

**What the provider requires.** Probed directly across four history shapes:

| History shape                                                                      | Tail (assistant turns after the last `user` message) | Upstream result |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| Two user turns; earlier assistant turn lacks reasoning, final turn carries it      | `[final WITH reasoning]`                             | **ACCEPTED**    |
| One user turn; two assistant tool turns, earlier lacks reasoning, final carries it | `[earlier WITHOUT, final WITH]`                      | **REJECTED**    |
| One user turn; two assistant tool turns, earlier carries reasoning, final lacks it | `[earlier WITH, final WITHOUT]`                      | **REJECTED**    |
| One user turn; single assistant tool turn lacking reasoning                        | `[turn WITHOUT]`                                     | **REJECTED**    |

Exact error in every rejection:
`{"message": "The`reasoning_content`in the thinking mode must be passed back to the API.", "type": "invalid_request_error"}`.
An explicit empty string also satisfies the requirement (probed: `reasoning_content: ""` is ACCEPTED).

**Our documented rule**, stated at `src/deepseek_responses.ts:190–206`, is: every assistant message that follows the
**last `user` message** must carry the field. Applying that rule mechanically to the four shapes predicts ACCEPTED /
REJECTED / REJECTED / REJECTED — an exact match to all four observations.

**Vendor behavior.** `serializeAssistant` (`lib/index.js:107–124`) emits
`...reasoning.length > 0 ? { reasoning_content: reasoning } : {}` for every assistant turn, unconditionally. The vendor
README: "Reasoning passback carries every reasoned turn's chain of thought into later requests", and "Reasoning content
from a prior assistant turn is passed back verbatim, whether or not that turn called a tool."

**Delta.** The vendor replays reasoning on every reasoned assistant turn. We fill an empty string on the tail only.
These agree on the _requirement_ and differ on _scope_.

**One research claim recorded as unsupported.** GPT Pro research asserted that the current contract requires replay
"from **all prior turns**, including assistant turns that made no call", and that "the current rule is not limited to
the immediately preceding tool-call turn or the current user turn." Our probe matrix contradicts that as a general
statement: the first shape above has a prior assistant tool turn with no reasoning, and the provider accepted it,
because a later `user` message resets the boundary. The claim is correct only in the weaker form our code already
implements — within the tail after the last `user` message, every assistant turn must carry it. Do not widen our fill on
the strength of that research claim; the probes are stronger evidence and they favor the narrower rule.

**Recommendation: keep our behavior.** Our fill is the smallest mutation that satisfies the measured requirement, and
widening it would change token accounting and cache behavior for every request. The vendor's broader passthrough serves
a goal we do not have — its README explains it lets "a gateway re-encoding the conversation for another vendor recover
that turn's upstream thinking signature by hashing the replayed text." Our gateway _is_ the re-encoding gateway; we are
the consumer of that signal, not a producer preserving it for someone else.

**The real risk is that the boundary is empirical, not documented.** Our own comment says so
(`src/deepseek_responses.ts:195–196`): "The measured boundary (probed against `deepseek-v4-flash`, `reasoning_effort`
other than `none`, with tools advertised) is…". Record the probe matrix above as the regression fixture so a provider
change is detectable rather than silently breaking tool turns.

**Confidence.** High for the requirement and the boundary (four shapes probed live, in both acceptance and rejection
directions). High for both implementations.

## Delta 5 — `thinking.type` parameter: the vendor sends it, we do not

**Vendor behavior.** For the adapter-owned `off` effort, the vendor sends a top-level `thinking: { type: "disabled" }`
and omits `reasoning_effort` entirely (`requestWithMessages` at `lib/index.js:226`, `thinking` spread at `:241`;
`resolveThinking` at `:30`). Its README: "The adapter-owned `off` effort maps to `thinking: {type: 'disabled'}` and
never crosses the wire as `reasoning_effort: 'off'`."

**Our behavior.** `DEEPSEEK_WIRE_EFFORT_MAP` (`src/deepseek.ts:77`) maps only `ultra → max`. An effort of `none` passes
through as `reasoning_effort: "none"` (`src/deepseek.ts:187`). We never emit a `thinking` field.

**Probe result.** Both forms were tested directly for the no-thinking case and produced identical results
(`finish: stop`, content `"OK"`, no `reasoning_content`, identical usage).

**Delta.** A real difference in wire parameterization with no measured behavioral consequence.

**Recommendation: leave it, document it, re-probe on provider change.** Switching to `thinking: {type: "disabled"}`
would mean emitting a parameter the OpenAI Chat Completions schema does not define, on a route whose entire purpose is
OpenAI compatibility. The measured equivalence means there is nothing to buy.

**Correction to an earlier draft.** It previously concluded that the equivalence "means there is nothing to buy" and
stopped there. That was too confident in two ways. A single probe cannot establish durability; and more importantly,
this delta sits adjacent to a real live defect the same probe series uncovered — Delta 8, where thinking mode actively
rejects two `tool_choice` values our gateway forwards. Do not read "the two ways of disabling thinking look equivalent"
as evidence that our thinking-mode parameterization is otherwise correct.

**Confidence.** High for the measurement; low for durability, and lowered further by Delta 8.

## Delta 6 — usage accounting: the vendor subtracts, we relay

**Vendor behavior.** `mapUsage` (`lib/index.js:932`) reconciles two counting conventions: "DeepSeek's `prompt_tokens`
INCLUDES cache hits (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`); the harness TokenUsage
convention is DISJOINT counts, so cache reads are subtracted out of `inputTokens`."

**Our behavior.** We relay the cache counter rather than subtracting it, per the repository decision of 2026-09-19
recorded in `docs/DECISIONS.md` ("Cache-read telemetry is reported, never defaulted") and implemented at
`src/deepseek.ts:409` / `:455`: DeepSeek's `usage.prompt_cache_hit_tokens` is relayed as the official OpenAI field
`prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`, and an absent counter is reported as
unknown (`usage_telemetry_status: "partial"`), never as a measured zero.

**Delta.** Not a defect in either direction. The two implementations serve different contracts. The vendor must produce
_disjoint_ counts because its internal convention is disjoint. We must produce _OpenAI-shaped_ counts, and the OpenAI
contract defines `cached_tokens` as a subset detail of `prompt_tokens` rather than a disjoint bucket — so relaying
without subtracting is the OpenAI-faithful choice, and subtracting would corrupt the field's meaning for every
OpenAI-compatible reader.

**Recommendation: keep, and do not "fix" toward the vendor.** This is the clearest case where matching the vendor client
would be a regression. Record it so a future reader does not mistake the difference for drift.

**Confidence.** High. The rationale is already in the repository decision document; this entry adds the
vendor-comparison angle.

## Delta 7 — request-shape differences with no behavioral delta

Recorded so a future audit does not re-derive them as suspected defects.

| Field               | Vendor client                                                                                                | Our gateway                                                                                                                                                                         | Assessment                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `stream`            | Always `true`; the adapter is streaming-only (`lib/index.js:226`, `stream: true` at `:239`).                 | Client-controlled; supports buffered and streaming (the gateway parses the client's `stream` and writes it into the upstream body).                                                 | Our gateway must serve both; not a delta to close.                                                                                |
| `stream_options`    | Always `{ include_usage: true }` (`lib/index.js:240`).                                                       | Set when streaming (`src/deepseek_responses.ts:421`), deleted when not (`src/openai.ts:9965`), because the provider answers 400 for `stream_options` without `stream: true`.        | Equivalent where it matters; ours additionally encodes a provider 400 avoidance the vendor avoids by never sending non-streaming. |
| `tool_choice`       | Not mapped. Vendor README lists this under "Known Limitations": "not part of the core vocabulary (MVP cut)". | Mapped (`toChatToolChoice`, `src/deepseek_responses.ts:333`, written at `:393`).                                                                                                    | We do more than the vendor — and that is exactly how Delta 8 was introduced.                                                      |
| Parallel tool calls | Not defended against; `delta?.tool_calls ?? []` iterates all entries.                                        | Verified: upstream sends the tool-call `name` in an earlier chunk than `arguments`, so our announcement gate (`src/deepseek_responses.ts:751`) does not drop a call.                | No defect found on either side.                                                                                                   |
| Timeout model       | `streamIdleTimeoutMs`, default 300000, bounding each outstanding provider read and re-armed by SSE comments. | `STREAM_INACTIVITY_DEADLINE_MS` / `STREAM_FIRST_EVENT_DEADLINE_MS` in `src/deepseek.ts`, with the same keep-alive-comment rationale documented at `src/deepseek.ts:693` and `:839`. | Same design; no delta.                                                                                                            |

## Delta 8 — thinking mode rejects `tool_choice` values our gateway forwards (new finding)

This delta was not part of the original scope. It surfaced while probing Delta 5, and unlike the other deltas it is a
live, reproducible client-visible failure.

**Provider behavior.** Probed directly with `reasoning_effort: "high"` and tools advertised:

| `tool_choice` sent                                       | Upstream result                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `"auto"`                                                 | accepted                                                         |
| `"required"`                                             | **HTTP 400** — `Thinking mode does not support this tool_choice` |
| `{"type":"function","function":{"name":"exec_command"}}` | **HTTP 400** — `Thinking mode does not support this tool_choice` |

**Our behavior.** `toChatToolChoice` (`src/deepseek_responses.ts:333`) explicitly permits `"none"`, `"auto"`,
`"required"`, and a named-object form, and writes the result into the upstream body at `:393`. We do not consider
reasoning effort when validating it.

**Observed result through the gateway.** The gateway forwards the request and surfaces the upstream rejection raw:

```
HTTP 400
{"error":{"message":"Thinking mode does not support this tool_choice","type":"invalid_request_error","code":"invalid_request_error"}}
```

with response headers `x-uos-upstream: deepseek`, `x-uos-git-sha: 4176e992f5edce801cb125ebd0f1db47848d1b62`.

**Why this is a real defect and not merely a forwarded vendor error.** Our gateway advertises `tool_choice: "required"`
as an accepted capability: it passes our own request validation, it reaches the provider, and only then fails. A client
cannot know from our contract that combining a supported `tool_choice` with a supported reasoning tier is invalid. The
correct behavior is to reject the incompatible _combination_ at the gateway boundary with a gateway-shaped error that
names both fields, or to route to a verified-capable configuration — not to discover the conflict upstream and relay the
provider's message as if it were the client's fault.

The vendor client avoids the whole class by not mapping `tool_choice` at all (Delta 7). That is one valid resolution,
but it would remove a capability our responses path deliberately provides, so it is not the right one for us.

**Exposure.** Low today. Codex was never observed sending `tool_choice` in the sampled traffic (`"tool_choice":"…"`
appears zero times in the gateway log), so this is not causing current failures. It is a contract gap: we accept a
shaped request we cannot serve, and the failure appears only in combination with thinking mode.

**Remedy and open question.** Either validate the combination at the boundary or document the restriction in our
advertised capabilities. Which one is correct depends on an unresolved question: the provider's _native Responses_
documentation reportedly lists required/named tool choice as supported without repeating the Chat thinking restriction
(Delta 9), so the restriction may be Chat-endpoint-specific rather than model-wide. Do not assume it applies identically
or is absent until it is probed on the endpoint we actually use.

**Confidence.** High — the rejection is a direct, repeatable probe result, and the gateway pass-through was executed and
captured.

## Delta 9 — DeepSeek now exposes a native Responses endpoint (context, not a delta)

**Finding.** DeepSeek serves a native Responses API. Probed directly:

- `POST https://api.deepseek.com/responses` → HTTP 200
- `POST https://api.deepseek.com/v1/responses` → HTTP 200

Both returned a native Responses envelope (`"object": "response"`, `"status": "completed"`,
`"incomplete_details": null`, `"max_output_tokens": null`), not a Chat Completions translation.

**Why this is recorded here.** The entire premise of this gateway's DeepSeek path is that "the Codex client speaks only
the Responses API, and the official DeepSeek API speaks only Chat Completions" (quoted from the comment block at
`src/openai.ts:10016`). That premise is now **out of date**. The translation layer is no longer required solely because
the provider lacks Responses.

**This is context, not a recommendation.** Research is explicit that native Responses is not a verified drop-in
replacement: it is documented as stateless, it ignores state-related and parallel-call control parameters, it has
limited reasoning-replay representations, and it treats `developer` messages as `user`. Our client depends on several of
those behaviors. Removing this translator could eliminate a class of translation defects (Deltas 1, 2, 3, 8 all live in
the translation seam), but it cannot establish that the model stops producing narration without action, and it would
introduce a new compatibility surface.

**Recommendation.** Record the finding, correct the stale premise comment, and treat a native-Responses comparison as a
separate, evidence-driven evaluation against representative histories — not as an assumed cure and not as part of this
handoff's scope.

**Confidence.** High for the endpoint existing (direct probe, both paths, HTTP 200 with a native envelope). Unverified
for capability parity; the compatibility differences are research-sourced and must be re-probed before any migration
decision.

## Provider facts established by direct probe during this audit

Recorded because they answer questions the generalized document leaves open, and because they are cheap to lose and
expensive to re-derive.

- **Tool-call streaming order.** The tool-call `name` arrives in an earlier chunk than the `arguments`. Confirmed on the
  wire: first NAME at chunk #16, first ARGS at chunk #17, terminal `finish_reason: "tool_calls"`. Consequence: a
  translator that gates announcement on the name being present cannot drop a call.
- **`reasoning_content` replay requirement.** Mandatory on assistant turns in the tail after the last `user` message
  while thinking is active; an explicit empty string satisfies it. Exact 400 quoted in Delta 4.
- **Reasoning effort controls the output cap.** The strongest operational finding in this document. Omitted `max_tokens`
  is not "unlimited": it is 8,192 at effort `none`, and at least 65,536 / 131,072 at `high` / `max`. Effort therefore
  changes the truncation threshold as well as the thinking budget. See Delta 3.
- **`length` is reachable in production shape.** A `none`-effort request for an exhaustive long output hit `length` at
  exactly 8192 tokens on 3 of 3 direct runs (content 23366–26008 chars), and the identical request through the gateway
  was reported as `response.completed` with `incomplete_details: null` and `output_tokens: 8192`.
- **`prompt_cache_miss_tokens` is present on the wire** alongside `prompt_cache_hit_tokens` and
  `completion_tokens_details.reasoning_tokens`, confirming the disjoint decomposition the vendor client relies on.
- **`reasoning_effort: "none"` vs `thinking: {type:"disabled"}`.** Equivalent on the response path for a trivial prompt
  (Delta 5). Durability unproven.

## Open questions specific to DeepSeek

- **Q5.** What is the authoritative, currently-documented set of DeepSeek `finish_reason` values? The six-value set in
  Delta 1 is research-sourced; the vendor client's open-ended `default` branch is consistent with it but does not
  enumerate it. Confirm against the provider reference before writing the table.
- **Q6.** Does DeepSeek document the narration-without-action behavior? Research found no named issue, dedicated finish
  reason, or provider-level remedy. The vendor client does not defend against it (Delta 2 limitation), which is weak
  corroboration that it is not a documented provider condition. If it is documented, the remedy becomes
  provider-recommended rather than invented.
- **Q7.** Should a degenerate DeepSeek completion be _retried_ rather than failed? The vendor treats `EMPTY_RESPONSE` as
  retryable with up to 5 attempts, on the stated grounds that "the attempt produced nothing durable, so retry policy
  treats it as safe to repeat." Our `empty_upstream_completion` is a terminal 502. Real policy divergence; needs a
  decision.
- **Q8.** Is there a provider signal distinguishing "the model chose to stop after reasoning" from "the model was cut
  off"? Our terminal vocabulary currently conflates them (generalized Q2). Usage accounting (`reasoning_tokens` vs
  `completion_tokens`) is the only candidate signal observed.
- **Q9.** (new) Does the Chat-endpoint `tool_choice` + thinking-mode restriction also apply to DeepSeek's native
  Responses endpoint? Delta 8's remedy depends on the answer.
- **Q10.** (new) What are the actual capability differences between the native Responses endpoint and our translation
  layer, measured on representative histories? This gates any future migration decision and is not answerable from
  documentation alone.

## Recommended sequencing

1. Answer Q5 and Q6. Q5 gates the Delta 1 mapping table; Q6 gates whether the original symptom has any
   provider-sanctioned remedy at all.
2. Adopt generalized G5's observability half so the effective allowance and the provider default are recorded (Delta 3).
   No behavior change; makes every later measurement attributable.
3. Adopt generalized G3 on the DeepSeek responses route, classified as `empty_upstream_completion`, and resolve Q7
   before shipping.
4. Adopt the Delta 1 `length` mapping via generalized G1, then the unrecognized-reason handling
   (`insufficient_system_resource`, `aborted`), which is the DeepSeek-specific half.
5. Fix Delta 8 — validate the `tool_choice` × reasoning-effort combination at the boundary. Small, isolated, and the
   only item here that currently returns a confusing error to a well-formed client request. Resolve Q9 first if the fix
   is to reject rather than to route.
6. Record Deltas 4, 5, 6, and 9 as deliberate divergences or corrected premises with their probe methods.
7. Correct the stale "DeepSeek speaks only Chat Completions" comment at `src/openai.ts:10016` (Delta 9).

Deltas 4, 5, 6, and 9 require no behavioral code change. They require documentation, because the failure mode this
handoff exists to prevent is a future reader "fixing" our gateway toward the vendor client in a case where the vendor's
choice serves a different goal — or, for Delta 9, continuing to justify the translation layer with a premise that is no
longer true.

## Reference freshness

The `src/...` line numbers in this document are historical pointers from the audit, not a claim that every citation has
been semantically re-verified at the current checkout. The source has since been split, so resolve each gateway citation
against the exact revision before acting on it.

Line numbers had already drifted once during this handoff. The documents were first written against
`2ed95f47de7205ffbc07f5dabc684f74e577a59e`; a single unrelated merge (`922c33392d`, "serve gpt-reserve under its own
quota class", +16 lines in `src/openai.ts` across three hunks at +11/+12/+16) invalidated 26 citations. Two survived a
naive bounds check while pointing at the wrong line, which is why line numbers must not be used without checking the
named symbol at the cited revision.

Consequences for a future reader:

- Treat every line number here as a claim about a specific revision, not a stable address. Re-resolve by symbol (grep
  for the function or constant name) before acting on a citation.
- Prefer the named symbol over the number when quoting this document in a new one.
- If HEAD has moved, re-run the semantic check rather than applying an arithmetic offset, because the drift is not
  uniform across hunks.

## Evidence provenance

- Vendor client: `~/.dsh/profiles/tui/node_modules/@deepseek-ai/dsh-llm-deepseek` at version `0.1.1-rc.2`,
  `lib/index.js` SHA-256 `eed9492246cc6451f060de211768d3128388046478deae7f1959de7cde56ea82`. Line numbers refer to this
  revision.
- Vendor rationale quotations: `dsh-llm/lib/types/error.d.ts` (`EMPTY_RESPONSE_CODE`) and `dsh-llm/lib/index.js:360–366`
  (default retryable set), plus the `dsh-llm-deepseek` `README.md`.
- Provider probes: direct `POST https://api.deepseek.com/chat/completions` and `POST https://api.deepseek.com/responses`
  calls executed 2026-09-21 during the audit window, covering tool-call ordering, `reasoning_content` replay across four
  history shapes, the omitted-`max_tokens` defaults per effort tier, the accepted `max_tokens` range, `tool_choice`
  rejection in thinking mode, and the native Responses endpoint.
- Gateway probes: `POST http://127.0.0.1:7999/v1/responses` for the truncation-laundering reproduction and the
  `tool_choice` pass-through capture.
- Our gateway references are historical audit pointers; re-resolve them against the exact revision before use (see
  Reference freshness above).
- Enrichment: GPT Pro job `8c4a76a4-4ed9-49f0-9cde-98187297c9f7`, model `gpt-6-pro`, submitted 2026-09-21T14:02:01Z.
  Answer archived at `.data/agent-work/gpt-pro-answer-2026-09-21.md`; query at
  `.data/agent-work/gpt-pro-query-2026-09-21.md`. One claim from that research was contradicted by direct probe and is
  recorded as unsupported in Delta 4.
- Related document: `docs/handoff/gateway-terminal-truthfulness-handoff-2026-09-21.md` (generalized G1–G5, ownership
  verdicts, Q1–Q4).
