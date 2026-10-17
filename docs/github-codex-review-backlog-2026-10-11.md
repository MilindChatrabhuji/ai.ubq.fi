# Local Codex review backlog — Claude Code subscription tier (2026-10-11)

## Purpose

Record the after-the-fact local Codex review of merged commit `6d287025` (PR #994, merge `81fbe65e`) with exact
evidence, as the rolling review workflow requires. This document selects future work only; it authorizes no deployment,
API change, or review reply by itself.

## Provenance

- Reviewed commit: `6d287025` (head of `codex/claude-code-subscription-2026-10-11`); merge commit `81fbe65e`.
- Command: `codex review --commit 6d287025` (actual review mode, run from the VPS checkout).
- Reviewer identity: model `~anthropic/claude-opus-latest` via provider `uos`, reasoning effort low, session
  `01a12d3d-8191-7480-bed1-441c41196540`.
- First attempt failed closed (nested sandbox could not create its socket directory); the rerun completed and produced
  one finding. Nothing from the failed attempt was ingested.

## Findings

### P2 — A failed subscription hop keeps the request's first-dispatch attribution

Original text: "`attemptClaudeCodeSubscription` calls `beforeProviderDispatch(\"claude_code\")`. That commits this
request's usage reservation as `dispatched` with `provider: \"claude_code\"`. If the subscription then fails with a 429,
401/403, 5xx, a network error or a rejection, the request falls through to Surplus or OpenLux. Their
`beforeProviderDispatch` call sees `state === \"dispatched\"` and returns `undefined`. The paid provider that actually
serves the request therefore gets no dispatch context, and the usage ledger still names `claude_code` as the provider.
This affects every allowlisted request that falls back after reaching the transport. It breaks per-provider ledger and
settlement accuracy, and the paid hop loses its own `cancelBeforeTransport` compensation. Either release or compensate
the subscription dispatch before falling through, or record dispatch only after the subscription succeeds."

Disposition: no remediation in this unit. The described behavior is the established, tested dispatch contract, not a
defect the tier introduces: `beforeProviderDispatch` records exactly one pre-transport dispatch per request
(`src/api-key-policy.ts` `reservationContext`), and `tests/api-key-policy-dispatch-reuse.test.ts` pins it ("V3 retry and
upstream failure retain one dispatch" — a retry must not commit another dispatch). The Codex primary has always used the
same `beforeProviderDispatch("chatgpt_codex")` pattern, so a Codex-transport failure followed by a paid success already
keeps the primary's attribution. Changing attribution to the last-serving provider is a systemic behavioral decision
across every hop and is out of scope for this tier. Kept open as informational P2 for a possible future systemic change;
if selected, it must change the reservation contract and its tests together.
