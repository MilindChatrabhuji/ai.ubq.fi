# The `ubiquity/deepseek-flash` waterfall model — implementation plan

Decision: one synthetic model id that the gateway serves by walking the measured provider order on the client's behalf.
Agents keep addressing one id; the gateway owns provider choice, failover, and evidence.

## Identity and wire

- Model id: `ubiquity/deepseek-flash`; display name: `Ubiquity DeepSeek Flash`; description states the automatic
  provider fallback. The pre-rename id `ubiquity/deepseek-v4.1-flash` stays accepted as a hidden compatibility alias.
- Wire: `/v1/responses` only (the subagent wire). Chat Completions is out of scope for phase 1.
- Provider-specific ids are the provider-owned latest aliases listed below. Operators keep the existing
  provider-selection pinning, so benchmark batches can still force a single provider.

## Latest provider aliases

The gateway encodes no DeepSeek release number or snapshot date in the synthetic identity. At request time it resolves
each provider's latest Flash alias from the cached provider catalogues:

- official DeepSeek: always `deepseek-flash`
- OpenRouter: the explicit `~deepseek/deepseek-flash-latest` alias when present
- LithosAI, Surplus, OpenLux: the undated base id of the newest Flash entry the provider advertises

The fallback aliases are `deepseek-ai/DeepSeek-V4.1-Flash`, `deepseek-v4.1-flash`, and the same paid alias, used only
while a catalogue is cold or unreadable. Every configured provider stays in the hop plan; a catalogue gap never removes
a provider. LithosAI republished its base `deepseek-ai/DeepSeek-V4.1-Flash` alias under the same id with a new creation
instant on 2026-10-17. If a provider later adds a new base id such as `deepseek-v4.2-flash`, the resolver selects it
automatically. No gateway release pin or release-date parser exists.

The admin metadata-refresh button still force-fetches the provider catalogues, but the synthetic route does not depend
on their release dates. Paid hops use `deepseek-v4.1-flash`, the base paid alias already present in key policies.

## Order and semantics

Order: **LithosAI → DeepSeek direct → OpenRouter → Surplus → OpenLux** since the 2026-10-07 economy reorder
(docs/DECISIONS.md). Within the three direct hops the cheaper per-token routes lead: LithosAI Base and the DeepSeek
off-peak rate are $0.15/$0.60 per 1M input/output at list price, half of OpenRouter's $0.30/$1.20 for the same weights,
so OpenRouter drops from first to third. **Surplus** and **OpenLux** are the two paid hops, each pinned to its own paid
tier (`allowedPaidProviders`) so neither can silently advance to the other; the routing layer names OpenLux "metered".
The pre-reorder order was OpenRouter → LithosAI → DeepSeek → Surplus (phase 1/2).

Per request the gateway attempts each enabled provider in order and advances only on infrastructure/serving failures:

- transport/connect/DNS failure, request timeout, HTTP 429, HTTP 5xx, HTTP 402/403 quota or capacity. Phase 2 adds
  pre-semantic stream failures (malformed SSE, interrupted stream, missing completion before any output).
- Never advance on a client-caused 4xx validation response or on a valid-but-wrong answer.
- Once any semantic output has reached the client, failover stops: the gateway reports the failure and the client's
  retry restarts the chain at the top. The attempt-level integration that would cover mid-stream failover is phase 2.
- Each hop uses the existing bounded first-event deadline; the chain is bounded by the request deadline, and a hop is
  skipped when the request signal is already aborted.

## Evidence and observability

- Every attempted provider is recorded in the terminal `attempted_providers` list; the failing status or error class is
  retained for the chain, so production traffic keeps measuring the waterfall (objective section 12).
- The delivered response keeps `x-uos-upstream` = the provider that actually served, and the terminal log keeps the
  request identity.

## Capabilities and metadata

- Context window 1,048,576 tokens on every candidate; tools supported on every candidate.
- Advertised reasoning tiers are the intersection the candidates all accept verbatim: `low`, `high`, `max`. The
  waterfall boundary rejects any other value for this id with a 400 instead of letting a provider refuse it later.
  (DeepSeek official also accepts `none`; Surplus/OpenRouter advertise only low/high/max, so `none` is not advertised.)
- The Codex-facing catalogue record mirrors the LithosAI record shape; the plain `/v1/models` list also carries the id.
- The public/admin catalogue's provider rows follow the order above: the gateway identity first, then one row per
  configured hop (lithos, deepseek, openrouter, surplus, openlux).

## Phases

- **Phase 1 (this change):** resolver + wrapper over the three direct handlers, catalogue record, reasoning validation,
  fallback telemetry, hermetic unit tests, and a live smoke of every hop through provider-selection pinning.
- **Phase 2:** Surplus as the final hop through the paid pipeline (admission, reservation, ledger settlement must not be
  bypassed), and pre-semantic mid-stream failover by integrating with the attempt primitives (`prepareResponsesAttempt`
  and the precommit buffering the paid route already uses) instead of handler-level wrapping.
- **Phase 3 (optional):** explicit per-provider pin ids for experiments; not needed for production.
- **Phase 4 (shipped 2026-10-07):** the economy reorder above, the OpenLux responses hop wired to its `/v1/responses`
  endpoint as the last resort, and the paid-hop pin fix that threads `allowedPaidProviders` from the waterfall through
  the ordinary paid pipeline.

## Rollback

Remove the catalogue record, the dispatch branch, and the waterfall module. Provider-specific ids, paid-tier routing,
and the Codex waterfall are untouched by construction.

## Acceptance

- Hermetic tests: order resolution with disabled providers, failover on 5xx/429/402/403, no failover on 400, rejection
  of unadvertised reasoning tiers, catalog record shape.
- Live smoke (local benchmark instance, provider selection pinned per hop): default selection serves via OpenRouter;
  pinning to `["lithos"]` / `["deepseek"]` serves via those providers through the synthetic id; the terminal log records
  the served provider.
- Repository gate: `sh scripts/verify.sh` plus the CI checks on the pull request.

## Phase 2 implementation notes (scoped 2026-10-06)

Phase 1 shipped as PR #938 (merged `05f59243`). Phase 2 executes with these concrete mechanisms:

1. **Surplus hop through the ordinary pipeline tail.**
   - Export the tail of `handleResponsesInternal` (`prepareResponsesRequest` → `runResponsesFailover` →
     `buildResponsesDelivery` → `deliverPreparedResponses`) from `src/responses-handler.ts` as one function and call it
     from both the ordinary router and the waterfall, so nothing is duplicated.
   - The waterfall handler keeps `rawBody` (its dispatch branch gains the argument) and, for the final hop, builds a
     fresh `Request` whose body is `{...rawBody, model: <the resolved paid snapshot id>}` and calls that tail. Admission,
     reservation and ledger settlement stay exactly the paid path's.
   - `fetchResponsesWithPaidFallback` gains an optional `allowedPaidProviders` filter (default unchanged) so this hop
     pins `["surplus"]` and can never silently advance to metered/OpenLux.
   - The hop's success/failure is the tail's response status; it is last, so nothing advances past it.

2. **Pre-semantic mid-stream failover.**
   - Gate every 200 streaming hop response on the first semantic commitment using the paid route's own helpers:
     `readResponsesStream`, `responsesEventSemanticKind`, `appendResponsesPrecommitEvent` (bounds
     `MAX_RESPONSES_PRECOMMIT_EVENTS` / `MAX_RESPONSES_PRECOMMIT_CHARS`) and replay through
     `createOwnedResponsesStream`.
   - A parse error, premature EOF, malformed frame or missing terminal observed before any text or tool-call event is a
     failed hop: discard its buffer and continue the chain. Once semantic output exists, deliver the replayed stream and
     stop failing over.
   - The pre-commit phase stays bounded by the existing first-event and semantic deadlines; a hop that stalls before
     commitment fails like a timeout.

3. **Tests for phase 2.**
   - Injected dispatchers over synthetic SSE streams: dropped before first output advances the chain; dropped after
     first output does not; the surplus hop receives the paid model id and delegates to the tail stub.
   - Paid-routing unit coverage: `allowedPaidProviders: ["surplus"]` never selects metered, including on surplus
     capacity failure; the absent filter preserves today's behavior byte-for-byte.
   - Live: four-hop smoke (each direct hop pinned through the operator selection plus the surplus hop) and one forced
     pre-output stream failure against the scratch instance.

4. **Docs.** Update the benchmark report and this plan with the phase-2 evidence and the final waterfall semantics.

## Phase 2 status (implemented 2026-10-06)

All four hops are live behind the synthetic id on a scratch instance of this revision:

- selection `["openrouter"]` / `["lithos"]` / `["deepseek"]` served 200 with `x-uos-upstream` equal to the pinned
  provider;
- selection `["surplus"]` served 200 with `x-uos-upstream: surplus`, and the paid ledger settled it (surplus
  `spend_microcredits` 291478 -> 291526, request count 35 -> 36), so admission, reservation and ledger settlement were
  not bypassed;
- `x-uos-attempted-providers` reports the chain on every response.

Implementation deltas from the scoped notes, kept truthful:

- The streaming gate replays the buffered pre-commit bytes and then forwards the hop handler's own response stream
  verbatim, instead of rebuilding the stream through `createOwnedResponsesStream`. That preserves each handler's own
  delivery machinery (keepalive, terminal synthesis, telemetry), which the gap analysis showed matters more than
  sequence rewriting; the gate itself still uses `readResponsesStream` + `prepareResponsesStreamForCommit`.
- Simulated infrastructure failures were validated live with a fault-injecting instance of this revision (the process
  intercepts only OpenRouter's completion endpoints; everything else passes through to the real network and the real
  handler stack serves the request): with the operator selection pinned to `["openrouter","deepseek"]`, an injected 503
  on the first hop produced HTTP 200 from DeepSeek with `x-uos-attempted-providers: openrouter,deepseek` and terminal
  `fallback_reason: deepseek_waterfall:openrouter:503`; an injected stream that sent only `response.created` before
  closing produced the same advancement through the pre-output stream-death path. Hermetic tests additionally cover
  stream death after output (delivered, no further provider spent) and transport failure.

## Phase 4 status (implemented 2026-10-07)

The cost-first economy order ships behind the same synthetic id:

- order `["lithos","deepseek","openrouter","surplus","openlux"]`; the plan drops switched-off and uncredentialed hops
  without reordering the rest;
- the Surplus hop's paid tail receives `allowedPaidProviders: ["surplus"]` and the OpenLux hop's receives `["metered"]`
  (the routing layer's name for OpenLux), threaded end-to-end from the waterfall through `runOrdinaryResponsesTail` to
  `fetchResponsesWithPaidFallback`; every other caller keeps the default Surplus -> Metered paid order;
- OpenLux serves the Responses wire through the existing `fetchMeteredResponses` transport
  (`https://api.openlux.ai/v1/responses`), so the last hop is wired rather than merely advertised;
- hermetic coverage: order/plan assertions, both paid-hop pin assertions, and a last-hop failover test where every prior
  paid hop fails and OpenLux serves, pinned to metered.
