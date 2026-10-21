# Codex banked-reset operations

## Status and safety boundary

The pinned `lib/codex` submodule is the provider-contract reference. It defines the account-bound inventory and consume
routes, a caller-supplied `redeem_request_id`, exact consume response codes, and `already_redeemed` as same-attempt
success. The production adapter uses:

- `GET .../rate-limit-reset-credits`
- `POST .../rate-limit-reset-credits/consume`
- `{ "redeem_request_id": "<durable key>", "credit_id": "<exact opaque id>" }`

The adapter sends Bearer auth, `ChatGPT-Account-ID`, and the Codex user agent. It never asks upstream to select a credit
implicitly.

This rollout is deliberately **at-most-one**, not generally reconcilable exactly-once:

- A parsed 2xx JSON `code` of `reset` or `already_redeemed` is an authoritative terminal success for that one
  submission.
- `nothing_to_reset` and `no_credit` are terminal rejections.
- A non-2xx, timeout, connection loss, empty or malformed JSON, or unknown code is durable `unknown`.
- An ambiguous submission is never sent again and the terminal-only provider performs no speculative lookup or
  verification call.
- Upstream commit plus response loss can consume the credit while leaving the gateway unable to prove it. Operators must
  treat `unknown` as possibly spent.

The terminal-only path is structurally enabled only when `CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_DAY` is exactly `1`.
The cap is one provider submission per account per UTC day, not one for the lifetime of the deployment. The retired
`CODEX_BANKED_RESET_MAX_GLOBAL_PER_DAY` variable is no longer read; remove it from any environment that still sets it.
Automatic banked resets are live-only. An eligible blocked cohort performs the bounded inventory read and submits the
selected credit in the same request; no prior shadow decision or separate arm request is required. The enabled switch
remains the kill switch.

All automated tests use fake providers or mocked transports. They do not call the real reset-credit endpoint.

## Candidate and routing eligibility

Banked-reset selection is downstream of the durable Codex routing state:

1. A slot must have returned a completely parsed upstream `429` whose error type is exactly `usage_limit_reached`.
2. The response must contain an exact future integer `error.resets_at` Unix timestamp, matching the Codex client wire
   contract, or a canonical absolute `Retry-After` HTTP-date. Relative delays remain valid for ordinary routing but
   cannot identify a banked-reset window. Conflicting absolute deadlines, or a longer relative routing delay, fail
   closed for redemption.
3. A revised deadline, ambiguous generation, active recovery-probe lease, invalid credential, unmapped slot, stale
   fence, or unavailable KV prevents the cohort from being complete.
4. A fresh strong routing read must prove every current auth-pool slot is authoritatively quota- or capacity-exhausted
   under the same advertised expiry contract. A healthy, probing, unclassified, or invalid-credential account makes the
   cohort incomplete, so no reset is spent: normal routing serves any eligible active account, and a retryable routing
   error applies only when no ordinary account is eligible and the complete exhaustion proof is unavailable.
5. Only stable blocked accounts reach inventory or redemption, and the inventory considers every one of them. The
   original active-selection snapshot, the full auth pool, and the stored capacity observations are re-read and
   compare-and-set fenced through inventory and consume.

Ordinary eligible active capacity always wins: a request is served by the durable active subscription before any
inventory, redemption, or recovery work, and reset recovery runs only when no ordinary configured account is eligible
under the complete authoritative fences above. The request that first discovers a quota block still performs ordinary
reselect/failover and may be served by a sibling without any reset-provider call; a relative `Retry-After` is
authoritative for that ordinary transition even though it cannot mint a banked-reset fence. Because the serial active
account is retained until an authoritative transition, the persisted blocked cohort is evaluated only when the whole
pool is exhausted.

## Capacity-observed exhaustion (2026-10-05)

Since the 2026-10-05 incident fix (`docs/incident-codex-banked-reset-capacity-deadlock-2026-10-05.md`), a fresh capacity
observation at 100% used for the requested class with a future reset deadline is also an authoritative exhaustion
source: routing yields the blocked identity from that observation, and the blocked-cohort evaluator reconciles the
durable class block before evaluating, so an ordinary request can redeem immediately. Since 2026-10-21, a newer exhausted
sample also replaces a retained future but ambiguous reset identity; a live 429 observed after the sample remains newer
and therefore authoritative. A 100%-used observation without a deadline keeps the account half-open as a bounded probe.
A live stable future deadline supersedes an absent or expired prior observation for the ambiguity gate while the
redemption ledger keeps each quota window spend-once. Empty blocked cohorts log `codex_banked_reset_preflight` with
reason `no_blocked_identity` instead of returning silently. The once-per-UTC-day global cap described above was still
enforced at the time of the incident; it has since been replaced by one redemption per account per UTC day (see
Configuration). The explicit per-account overage-usage setting remains approved-but-pending as recorded in
`docs/DECISIONS.md`.

## Overage usage setting

Each Codex subscription has an "Allow overage spending" switch (default off) stored at
`["uos_ai", "codex_overage_usage", "account", "v1", account_id_hash]` and served by
`GET`/`PATCH /admin/providers/codex/overage-usage`. An absent row means off; changing the switch never calls OpenAI,
never redeems, and never mutates banked-reset state.

- Off (default): resets first and no overage spend. An exhausted account still evaluates the blocked cohort; if that
  request cannot redeem a reset (`no_eligible_credit`, empty or ineligible inventory, `inventory_unavailable`, or
  `account_day_limit_reached`), the gateway returns the ordinary quota-blocked response. A completed spend and
  fence/config failures also never fall back, so the next request can still evaluate.
- On: a fully used capacity class with a future reset routes directly as the bounded half-open probe; when the blocked
  cohort proves no reset is redeemable, the gateway allows exactly one bounded overage probe and logs
  `codex_overage_served` with the reason. Banked resets still redeem when their gates pass.

Only a proven no-redemption outcome may fall back. A completed live redemption, a submitted or unknown transaction,
an in-progress transaction, and a fence or configuration failure remain ineligible for overage.

Enabled overage requests do not take the reset recovery-probe lease. That lease exists to serialize reset recovery, not
ordinary allowed spending, so concurrent requests may each make one bounded upstream attempt without returning a
single-flight 429.

The fallback claim reuses the probe-lease machinery (one live attempt at a time) under a scoped pre-transport lease
fence, so it never weakens the durable routing fences. The choice is per account; one subscription's switch never
changes another account's routing.

The Providers diagnostics panel shows the banked-reset credit expiries (`credits` on the reset-settings GET, earliest
first, with raw credit ids never included) and, when the upstream usage read succeeds, the account's overage balance
string plus the `overage_limit_reached` flag from `GET /admin/providers/codex/overage-usage`. Both reads share the
five-second bound; an unavailable or malformed upstream reports nulls instead of stale or zero values, each credit
expiry renders as a list item in the viewer's local time zone with a day hint, and the switch itself renders as a plain
`true`/`false` state.

Inventory reads have a fixed five-second deadline. Inventory failure or timeout skips reset work and leaves the ordinary
retryable error in place. Malformed or unavailable durable routing state also fails retryably before dispatch; the
gateway never guesses a sibling, deletes state, or advances the paid waterfall from an unproven cohort.

The ordinary bounded `429` retry remains separate. A successful ordinary retry serves the request and never falls
through to a reset. After an authoritative transition classification, an unchanged active account may still spend its
one bounded short retry before inventory or redemption; any actual active switch discards that retry.

After a verified reset is elected to the active selection, the original inference request is the one recovery probe
against that account:

- `2xx` returns directly and retains the normal completion probe until the response is explicitly completed.
- A definitive `401`, `403`, or `429` is returned; every account is exhausted, so there is no healthy sibling to fall
  through to.
- Any transport error or timeout may have dispatched upstream work, so it is rethrown and never replayed on a sibling.
- Any other HTTP response is returned directly.

## Configuration

The API-key-level reset switch is retired. `GET /admin/api-keys` no longer returns `banked_resets_enabled`, and `POST`
and `PATCH /admin/api-keys` reject that field with `400 invalid_request_error` instead of silently ignoring it. Do not
use the old API-key disable procedure; configure reset usage on the **Providers** view, per Codex subscription, through
`GET`/`PATCH /admin/providers/codex/banked-resets`. The PATCH body is
`{ "account_id_hash": "…", "enabled": true|false }`.

Subscription choices remain independent, while restored Codex capacity remains shared. The per-subscription setting is
read strongly at selection and atomically checked before recording an inventory decision or authorizing submission.
Environment caps below still apply, including for non-key authentication. Changing a switch never calls the reset
provider. A reset already authorized for submission cannot be cancelled or undone. Existing redemption
and daily-cap records are retained.

Settings are re-read on each gateway request and immediately before the consume boundary.

| Variable                                        | Safe default | Requirement                                                                     |
| ----------------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `CODEX_BANKED_RESET_ENABLED`                    | `true`       | `true` for automatic redemptions; `false` for fail-closed rollback.             |
| `CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_DAY`    | `0`          | Exactly `1` for any live submission; `0` (the fail-closed default) disables it. |
| `CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_WINDOW` | `1`          | Exactly `1`; every other value fails closed.                                    |

Each account's daily record is charged atomically when a transaction crosses the durable `submitted` boundary. A claim
that crosses a UTC-day boundary is rejected before provider submission and cannot borrow the next day's capacity.

Never clear routing KV, the redemption ledger, or daily-cap records during rollout or rollback. The
retained legacy `global_day` rows are rollback evidence and are never enforced.

## Live redemption flow

Every eligible blocked cohort uses the same one-request flow:

1. Strongly read and compare every auth-pool, credential, routing and quota fence.
2. Perform the bounded account-bound inventory reads.
3. Select one exact eligible credit across the blocked accounts, ranking finite expiry first.
4. Atomically claim the deterministic redemption identity and reserve the account's one-per-UTC-day budget.
5. Submit one consume request, verify its terminal result, and make at most one post-reset inference probe.

No shadow decision, arm step, or second request is required. Invalid, unavailable, expired, or ineligible inventory
cannot consume. An ambiguous generation, unavailable KV, stale fence, or cap other than the exact configured one fails
closed. Concurrent requests share the durable claim and budget, so only one can submit.

## Durable state and ambiguity

The redemption ledger key and the per-account daily budget key are separate from routing state:

```text
["uos_ai", "codex_reset_redemption", "v1", account_id_hash, quota_generation]
["uos_ai", "codex_reset_redemption", "account_day", "v1", account_id_hash, day]
```

The budget row uses the retired global record's shape (`{ v, day, submission_count, updated_at_ms }`) and is charged in
the same transaction that crosses the durable `submitted` boundary. Legacy
`["uos_ai", "codex_reset_redemption", "global_day", "v1", day]` rows are retained for rollback and are never read or
enforced after the per-account cutover.

`claimed` has an owner lease. `submitted` means the provider may have received the request. `unknown` means it may have
committed but did not return a recognized terminal result. `verified` follows exact `reset` or `already_redeemed`, or a
future independently verified contract. `rejected` is terminal for a definitive policy, inventory, or provider
rejection.

The deterministic identity derives from account hash and canonical observed deadline, never from the inference request
ID. Claims and submissions fence routing slot, credential version, account hash, quota deadline, routing generation, and
auth-pool slot.

Verified routing repair clears only the exact quota block, retains its ambiguity tombstone, and reserves the single
post-reset probe. Only a successfully completed recovery response clears that ambiguity.

For a terminal-only `submitted` or `unknown` record:

1. Set `CODEX_BANKED_RESET_ENABLED=false`; use the full rollback below if any unexpected activity continues.
2. Preserve the ledger, routing state, decision, account-day cap records (and the retained legacy global_day rows),
   logs, and exact deployment identity.
3. Do not repeat the consume request, even with the same `redeem_request_id`.
4. Treat the credit as possibly spent and investigate manually.

## Fail-closed rollback

If logs show more than one attempted submission, a fence mismatch, unexpected provider traffic, or any ongoing live
activity, set `CODEX_BANKED_RESET_ENABLED=false` in the repository-root `.env` on the affected host and restart its
service. Do not delete KV records during rollback.

## Validation and observability

Events include `codex_reset_eligible`, `codex_reset_skipped_healthy_fallback`, `codex_reset_claimed`,
`codex_reset_submit_started`, `codex_reset_submitted`, `codex_reset_unknown`, `codex_reset_rejected`,
`codex_reset_verified`, `codex_reset_inference_retry`, `codex_reset_inference_retry_result`,
`codex_reset_duplicate_prevented`.

The terminal verified event includes the safe `redeem_outcome` enum. Logs and KV must never contain raw tokens, auth
JSON, credentials, raw account IDs, raw credit IDs, or raw idempotency keys.

Before release, run:

```sh
bun --no-env-file run format:check
bun --no-env-file run lint
bun --no-env-file run check
bun --no-env-file run test
git diff --check
```

The gateway tests cover complete-cohort live selection, immediate one-request redemption, one terminal consume,
concurrency and the per-account daily cap, definitive probe fallback, transport no-replay, inventory timeout, fence and
credit drift, and full-pool recovery.
