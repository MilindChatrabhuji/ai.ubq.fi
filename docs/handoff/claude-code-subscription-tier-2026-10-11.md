# Claude Code subscription tier — design and handoff (2026-10-11)

## Objective

Add the owner's Claude Code subscription (Claude Pro/Max) as a gateway inference tier for Claude models, in the same
spirit as the existing Codex subscription tier: cheapest first, paid fallback behind it, fail only on authoritative
signals. The authenticated scope is the owner's own traffic; the tier must never serve other principals.

## Research basis (GPT Pro job 146b064a, verbatim record in docs/research/claude-code-subscription-2026-10-11.md)

- Anthropic's Oct 7, 2026 update keeps subscription-limit use available for the Agent SDK, `claude -p`, and third-party
  apps; legal docs still forbid routing Pro/Max credentials on behalf of other users. Verdicts: official-runtime
  personal use GREEN; owner-run raw OAuth bridge AMBER; serving other users on the owner's subscription RED; used up to
  $100/$200 monthly Max API credits through a Console key GREEN.
- Required wire shape: `Authorization: Bearer <oauth-or-setup-token>`, `anthropic-version: 2023-06-01`, and
  `anthropic-beta: oauth-2025-04-20` that must survive gateway forwarding. No fingerprint spoofing; no invented client
  identity.
- Authoritative quota signals: `anthropic-ratelimit-unified-{5h,7d}-{utilization,status,reset}` forwarded on both
  success and 429; generic 429 is not exhaustion; 401 allows one coordinated refresh then stop; explicit credential-use
  rejection disables the route and alerts; SSE errors after HTTP 200 must not be silently replayed.
- Credentials: ordinary OAuth access tokens live ~8 h with rotating refresh tokens (one refresh authority required);
  `claude setup-token` issues a documented one-year non-interactive token, which is the v1 credential.

## Chosen architecture (owner-gated adapter, off by default)

1. Provider id `claude_code`, tier `subscription`, added to the roster and presentation maps.
2. Activation requires all of: (a) the operator includes `claude_code` in the provider selection KV, (b) credentials
   exist (`CLAUDE_CODE_OAUTH_TOKEN` env setup token for v1; KV-stored OAuth credentials are a follow-up), and (c) the
   request principal's key id is in `CLAUDE_CODE_ALLOWED_KEY_IDS`. Any missing condition leaves the route inert and the
   request behaves exactly as today (paid Claude routes serve Claude models).
3. Dispatch posts the existing Anthropic Messages translation to `https://api.anthropic.com/v1/messages` with the OAuth
   headers above and no API-key header. Response and stream translation reuse `src/provider/anthropic-chat-responses.ts`
   and `src/provider/anthropic-chat-stream.ts`, which already serve the Surplus Claude route.
4. Quota accounting stores only upstream-observed unified window observations (utilization, status, reset, scope,
   observation time) in KV as advisory state. Durable exhaustion (subscription-limit 429 with a window/reset) blocks the
   tier until reset plus a margin; transient 429 honors `Retry-After` with a short cooldown; 5xx and network failures
   never advance any durable state.
5. Failover: on any ineligible outcome the request continues into the existing paid waterfall (Surplus then OpenLux),
   preserving the current ledger, admission, and telemetry paths. A mid-stream failure is never silently replayed.
6. Health: `claude_code` becomes a record provider; health events follow the existing provider-health vocabulary.
7. Admin: a status surface reports configured/enabled/gated/quota state with secrets absent; live activation remains a
   deliberate operator step on the VPS with the owner's token.

## Integration points (verified current state)

- Roster and selection: `src/provider/selection.ts` (`SELECTABLE_PROVIDER_IDS`, KV `uos_ai/provider_selection/v1`).
- Presentation: `src/provider/presentation.ts` (`PROVIDER_TIERS`, `PROVIDER_PRESENTATION`).
- Health: `src/provider/health.ts` (`RECORD_PROVIDER_IDS`).
- Request pipeline: `src/responses-handler.ts` and `src/paid-fallback/routing.ts` (`fetchResponsesWithPaidFallback`;
  Claude models currently flow through the paid providers with the Anthropic translation in
  `src/provider/surplus-claude-request.ts` and `surplus-claude-chat-request.ts`).
- KV: `src/kv.ts`; companion patterns in `src/codex/auth.ts` (pool parsing, refresh leases) and
  `src/provider/capacity*.ts`.

## Units of work

1. Provider module `src/provider/claude-code.ts`: eligibility gating, credential resolution, dispatch, quota observation
   parsing, classification. Tests with fixtures only; no live credential use.
2. Quota state module `src/provider/claude-code-quota.ts`: KV-backed window observations and cooldown decisions.
3. Routing hook: attempt the tier for Claude models when eligible; otherwise fall through unchanged.
4. Health, telemetry, ledger: record the tier's route label and outcomes without altering existing accounting.
5. Admin/ops: status readback, README/ops notes, DECISIONS.md entry.
6. Verification: `deno task verify` plus the research acceptance steps 1-8 run by the owner with their credentials.

## Implementation status (2026-10-11)

- Done: provider module `src/provider/claude-code.ts` (gated dispatch, documented OAuth headers, native Messages build,
  response translation reuse), quota state `src/provider/claude-code-quota.ts` (unified-window observations, durable
  block, transient cooldown), routing hook `src/paid-fallback/claude-code-route.ts` (cheap-gate first, KV read only when
  a request is otherwise eligible), roster/presentation/health entries, README/DECISIONS records, and fixture tests
  (`tests/claude-code-subscription.test.ts`, `tests/claude-code-route.test.ts`). Gates on this host: types, Prettier,
  ESLint, knip, size ratchet, deno fmt/lint, and the full suite except pre-existing host-toolchain drift (two
  Prettier-dirty `cerebras` files, ~19 pre-existing ESLint findings in untouched files, and ten pre-existing
  environment-dependent HTTP tests that fail identically at HEAD).
- Pending owner action: choose the tier path (owner-only OAuth tier vs documented Max API credits vs both), accept the
  AMBER residual risk for the raw OAuth bridge in writing, then set `CLAUDE_CODE_OAUTH_TOKEN` (setup token) and
  `CLAUDE_CODE_ALLOWED_KEY_IDS` on the VPS and run research acceptance steps 1-8 with real credentials.
- Pending follow-up units: admin status/credential surface, KV-stored OAuth credentials with serialized refresh, and
  model-id mapping verified against the account's live entitlement.

## Risks and open items

- AMBER permission status for the raw OAuth bridge; the adapter stays owner-gated and off by default until the owner
  accepts the residual risk in writing (DECISIONS.md).
- Setup-token rotation (one year) is an operator procedure; KV-stored OAuth refresh with single-owner serialization is a
  follow-up unit.
- Model ids: map gateway `claude-*` ids to current Anthropic ids (`claude-opus-5-5`, `claude-sonnet-5-5`,
  `claude-haiku-5-5` as of the research date) and verify entitlement on the account rather than assuming.
