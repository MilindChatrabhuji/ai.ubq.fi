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
The historical one-reset canary returned mode to `shadow` immediately. An explicitly approved persistent production
rollout may remain in `live`, but every new quota episode still requires a separate read-only arm request before any
later request can submit.

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
   compare-and-set fenced through inventory, arming, and consume.

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
source: routing yields the blocked identity from that observation, and the blocked-cohort evaluator materializes the
durable class block (same persisted transition a live 429 uses) before evaluating, so an ordinary request arms and later
spends. A 100%-used observation without a deadline keeps the account half-open as a bounded probe instead. A live stable
future deadline supersedes an absent or expired prior observation for the ambiguity gate while the redemption ledger
keeps each quota window spend-once. Empty blocked cohorts log `codex_banked_reset_preflight` with reason
`no_blocked_identity` instead of returning silently. The once-per-UTC-day global cap described above was still enforced
at the time of the incident; it has since been replaced by one redemption per account per UTC day (see Configuration).
The explicit per-account overage-usage setting remains approved-but-pending as recorded in `docs/DECISIONS.md`.

## Overage usage setting

Each Codex subscription has an "Allow overage spending" switch (default off) stored at
`["uos_ai", "codex_overage_usage", "account", "v1", account_id_hash]` and served by
`GET`/`PATCH /admin/providers/codex/overage-usage`. An absent row means off; changing the switch never calls OpenAI,
never redeems, and never mutates banked-reset state.

- Off (default): resets first and no overage spend. An exhausted account still evaluates the blocked cohort; if that
  request cannot redeem a reset (`no_eligible_credit`, empty or ineligible inventory, `inventory_unavailable`, or
  `account_day_limit_reached`), the gateway returns the ordinary quota-blocked response. Arming (`live_armed`), a
  completed spend, and fence/config failures also never fall back, so the next request can still redeem.
- On: a fully used capacity class with a future reset routes directly as the bounded half-open probe; when the blocked
  cohort proves no reset is redeemable, the gateway allows exactly one bounded overage probe and logs
  `codex_overage_served` with the reason. Banked resets still redeem when their gates pass.

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
Existing environment mode and caps below still apply, including for non-key authentication. Changing a switch never
calls the reset provider. A reset already authorized for submission cannot be cancelled or undone. Existing redemption
and daily-cap records are retained.

Settings are re-read on each gateway request and immediately before the consume boundary.

| Variable                                        | Safe default | Canary requirement                                                              |
| ----------------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `CODEX_BANKED_RESET_ENABLED`                    | `true`       | `true` during shadow/live; `false` for fail-closed rollback.                    |
| `CODEX_BANKED_RESET_MODE`                       | `shadow`     | Canary: `shadow` -> `live` -> `shadow`; persistent rollout: `live`.             |
| `CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_DAY`    | `0`          | Exactly `1` for any live submission; `0` (the fail-closed default) disables it. |
| `CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_WINDOW` | `1`          | Exactly `1`; every other value fails closed.                                    |

Shadow mode may GET inventory for stable blocked accounts and writes one redacted, deduplicated decision for that
blocked episode. It makes zero consume calls. A repeated selected decision returns `already_would_spend_once` without a
second inventory GET after current strong fences pass. A repeated non-selection preserves its original reason; it is
never mislabeled as a spend candidate.

Each account's daily record is charged atomically when a transaction crosses the durable `submitted` boundary. A claim
that crosses a UTC-day boundary is rejected before provider submission and cannot borrow the next day's capacity.

Never clear routing KV, shadow decisions, the redemption ledger, or daily-cap records during rollout or rollback. The
retained legacy `global_day` rows are rollback evidence and are never enforced.

## Shadow proof

1. Deploy the exact candidate while production remains in `shadow`.
2. Verify both `/health` endpoints serve the same candidate SHA and routed deployment ID:
   - `https://ai-ubq-fi.ubiquity-dao.deno.net/health`
   - `https://ai.ubq.fi/health`
3. Verify the effective configuration remains enabled, in `shadow`, and capped at exactly one.
4. Confirm `/health/providers` still shows the intended stable exhausted account and a healthy non-probing sibling.
5. Send one controlled normal inference request. Do not call the reset-credit endpoint directly.
6. Read `GET /admin/providers/codex/banked-resets/shadow-decisions` and require a current record with:
   - `decision_reason: "selected"`
   - a non-null selected account hash and credit hash
   - an expiry still in the future
   - the expected blocked-slot routing generation and quota deadline
7. Require zero `codex_reset_claimed`, `codex_reset_submit_started`, `codex_reset_submitted`, or `codex_reset_verified`
   events during the shadow request.
8. A second shadow evaluation for the same current episode must not issue another inventory GET.

An empty ledger, an expired decision, any non-`selected` reason, changed fences, or unavailable inventory is a failed
shadow gate. Stay in `shadow`.

## Historical one-reset live canary

Freeze one release operator, one exact served SHA, and one production configuration writer. Do not run another deploy,
workflow retry, console promotion, or Deno configuration change concurrently.

This procedure records the initial one-reset rollout gate. It remains the required canary before approving persistent
production live mode. Only after the shadow proof above:

1. Change only the existing mode:

   ```sh
   deno deploy env update-value CODEX_BANKED_RESET_MODE live \
     --org ubiquity-dao \
     --app ai-ubq-fi \
     --token "$DENO_DEPLOY_TOKEN_UBIQUITY_DAO"
   ```

2. The environment update restarts isolates without creating a new build. Re-read the effective configuration without
   require mode `live` and both caps `1`, then re-attest both health domains at the unchanged candidate SHA and
   deployment ID.
3. Send exactly one controlled normal inference request.
4. Expect at most:
   - one fresh account-bound inventory GET for the blocked account;
   - one consume POST for the exact shadow-selected credit;
   - one terminal `reset` or `already_redeemed` result;
   - one post-reset inference probe on the reset account.
5. Immediately return mode to `shadow`, regardless of whether the outcome was terminal or ambiguous:

   ```sh
   deno deploy env update-value CODEX_BANKED_RESET_MODE shadow \
     --org ubiquity-dao \
     --app ai-ubq-fi \
     --token "$DENO_DEPLOY_TOKEN_UBIQUITY_DAO"
   ```

6. Verify the effective mode is again `shadow` and both health domains still report the unchanged candidate SHA and
   deployment ID after the isolate restart.
7. Inspect bounded logs for the attested deployment and require:
   - exactly one `codex_reset_claimed`;
   - exactly one `codex_reset_submit_started`;
   - either one terminal `codex_reset_verified` with `redeem_outcome` equal to `reset` or `already_redeemed`, or one
     durable `codex_reset_unknown`;
   - at most one `codex_reset_inference_retry` and matching result;
   - no second submission attempt.

If the live request returns through the healthy sibling after a definitive `401`, `403`, or `429` probe, the reset
submission may still have succeeded; judge the consume result from the durable transaction event, not only the client
response.

## Persistent production live

After the historical canary is accepted, mode may remain `live` with both caps fixed at `1` and the full approved Do not
call the consume route directly. Ordinary inference traffic drives both phases:

1. The first eligible request for a new quota episode strongly reads every cohort fence, performs the bounded
   account-bound inventory reads, then strongly checks every fence again.
2. If one exact eligible credit is available, that request atomically writes one redacted decision and returns
   `live_armed`. It creates no redemption claim, reserves no daily capacity, sends no consume request, and starts no
   post-reset inference probe. Concurrent first evaluations deduplicate on the same decision and also do not consume.
3. The arm path runs only when every configured account is authoritatively exhausted, so the arm request returns the
   ordinary quota-blocked response. A request that still has an eligible active subscription is served normally and
   never reaches inventory.
4. A later ordinary request strongly re-reads the persisted decision, repeats inventory and fence validation, and
   requires the exact selected account, credit hash, credit expiry, and episode fences to match.
5. Only that later matching request may enter the unchanged durable claim/submission path, atomically reserve the
   account's daily budget, submit one consume request, and run the single post-reset inference probe.

Invalid, unavailable, expired, or ineligible inventory cannot arm or consume. A negative live observation is not
persisted, so later requests may repeat the bounded inventory read until the episode becomes eligible. An expired
decision, changed inventory, changed fence, ambiguous generation, or unavailable KV remains fail-closed. Manual `shadow`
-> `live` promotion remains valid for a controlled canary, and the rollback rules below are unchanged.

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

1. Return mode to `shadow`; use the full rollback below if any unexpected activity continues.
2. Preserve the ledger, routing state, decision, account-day cap records (and the retained legacy global_day rows),
   logs, and exact deployment identity.
3. Do not repeat the consume request, even with the same `redeem_request_id`.
4. Treat the credit as possibly spent and investigate manually.

## Fail-closed rollback

If logs show more than one attempted submission, a fence mismatch, unexpected provider traffic, or any ongoing live
activity, set both values:

```sh
deno deploy env update-value CODEX_BANKED_RESET_ENABLED false \
  --org ubiquity-dao \
  --app ai-ubq-fi \
  --token "$DENO_DEPLOY_TOKEN_UBIQUITY_DAO"

deno deploy env update-value CODEX_BANKED_RESET_MODE disabled \
  --org ubiquity-dao \
  --app ai-ubq-fi \
  --token "$DENO_DEPLOY_TOKEN_UBIQUITY_DAO"
```

Do not delete KV records during rollback.

Run every `deno deploy` command from a temporary directory. The current CLI can otherwise modify repository `deno.json`
even for administrative commands.

## Validation and observability

Events include `codex_reset_eligible`, `codex_reset_skipped_healthy_fallback`, `codex_reset_claimed`,
`codex_reset_submit_started`, `codex_reset_submitted`, `codex_reset_unknown`, `codex_reset_rejected`,
`codex_reset_verified`, `codex_reset_inference_retry`, `codex_reset_inference_retry_result`,
`codex_reset_duplicate_prevented`, and `codex_reset_shadow_candidate`.

The terminal verified event includes the safe `redeem_outcome` enum. Logs and KV must never contain raw tokens, auth
JSON, credentials, raw account IDs, raw credit IDs, or raw idempotency keys.

Before release, run:

```sh
deno fmt --check serve.ts src tests scripts docs
deno lint serve.ts src tests scripts
deno task build
deno task test
git diff --check
```

The gateway tests cover complete-cohort shadow selection, persistent-live all-blocked auto-arm, sequential
deduplication, exact decision-to-live credit matching, one terminal consume, concurrency and the per-account daily cap,
definitive probe fallback, transport no-replay, inventory timeout, fence and credit drift, and full-pool recovery.
