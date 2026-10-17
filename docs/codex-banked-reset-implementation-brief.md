# Codex Banked Reset: Implementation Brief

## Objective

Implement automatic redemption of exactly one banked Codex usage-limit reset when a configured ChatGPT Codex account has
genuinely exhausted its quota and no healthy account in the existing auth pool can serve the request.

A banked reset is an expensive, externally visible mutation. Treat it as a durable transaction, not as an ordinary HTTP
retry. Development and automated tests must never call the live redemption endpoint or consume a real reset.

## Non-negotiable safety rules

1. The feature must be disabled by default.
2. It must require the global feature flag and valid redemption caps.
3. Only a fully parsed upstream `429` whose OpenAI error type is exactly `usage_limit_reached` may make an account
   eligible.
4. A malformed, truncated, ambiguous, or ordinary rate-limit response must never redeem a reset.
5. Try every healthy configured Codex account before considering redemption. Do not spend a reset if an existing account
   can serve the request.
6. At most one reset may be redeemed for one account and one observed quota generation/window.
7. A timeout or ambiguous provider result must never cause a blind second redemption.
8. Inference may be retried only after the reset is independently verified as applied.
9. Retry the original inference request at most once after a verified redemption.
10. KV unavailability, CAS exhaustion, missing configuration, unsupported provider behavior, or failed verification must
    fail closed without redeeming.
11. Never log access tokens, refresh tokens, raw auth JSON, provider credentials, or raw idempotency keys.
12. No production redemption is permitted while implementing or testing this feature.

## Existing architecture to preserve

The gateway is a Deno TypeScript service. Its OpenAI-compatible public contract must remain unchanged.

Relevant existing code:

- `src/codex.ts`: auth refresh, upstream `/responses` dispatch, account iteration, 401 handling, 429 classification
  integration, bounded retry, and streaming behavior.
- `src/codex_account_routing.ts`: durable per-slot quota circuits, KV CAS updates, credential-version fencing, half-open
  probe leases, and strict parsing of `Retry-After`.
- `src/codex_quota.ts`: downstream quota-header normalization.
- `src/types.ts`: durable record types.
- `tests/codex-account-routing.test.ts`: quota classification, routing, CAS, probe, and response preservation tests.
- `tests/openai-compat.test.ts`: end-to-end gateway routing, stream/non-stream, failure, and fallback tests.

Current `readCodex429()` behavior is an important prerequisite:

- It reads a bounded response body.
- It requires a complete JSON OpenAI error envelope.
- It recognizes only `error.type === "usage_limit_reached"`.
- It preserves a replayable response for callers.
- It refuses to persist a quota block for incomplete or ambiguous responses.

Do not weaken those rules.

## Required control flow

```text
initial inference request
        |
        v
upstream account returns verified usage_limit_reached 429
        |
        v
mark that account quota-blocked using existing routing behavior
        |
        +---- another healthy account exists ----> use it; do not redeem
        |
        v
all suitable accounts exhausted or unavailable
        |
        v
check global flag + redemption caps + inventory eligibility
        |
        v
atomically claim durable redemption transaction
        |
        v
submit redemption once with deterministic idempotency key
        |
        +---- rejected/unsupported ----------> preserve normal quota failure
        |
        +---- timeout/ambiguous -------------> UNKNOWN; reconcile, never blind retry
        |
        v
independently verify reset was applied
        |
        v
clear/reconcile the account's quota circuit with generation fencing
        |
        v
retry the original inference request once on the redeemed account
        |
        v
return success or the normal OpenAI-compatible failure
```

Redemption must occur before any downstream response headers or streaming bytes have been committed.

## Provider boundary

Create a small provider interface in a separate module. Do not embed undocumented redemption HTTP calls directly in
`src/codex.ts`.

The interface should separate:

- Reading reset inventory or eligibility.
- Submitting a reset with a caller-supplied idempotency key.
- Looking up a submitted redemption by its provider receipt or idempotency key.
- Verifying that the quota reset actually took effect.

Illustrative types:

```ts
type ResetInventory = Readonly<{
  availableCount: number;
  observedAtMs: number;
  resetType: string;
}>;

type RedeemResetResult =
  | Readonly<{ kind: "completed"; providerReceiptId: string }>
  | Readonly<{ kind: "accepted"; providerReceiptId: string }>
  | Readonly<{ kind: "already_redeemed"; providerReceiptId: string }>
  | Readonly<{ kind: "rejected"; reason: string }>
  | Readonly<{ kind: "unknown"; providerReceiptId: string | null }>;

interface CodexUsageResetProvider {
  readInventory(input: ResetAccountContext, signal: AbortSignal): Promise<ResetInventory>;
  redeem(input: ResetAccountContext & { idempotencyKey: string }, signal: AbortSignal): Promise<RedeemResetResult>;
  lookup(
    input: ResetAccountContext & {
      idempotencyKey: string;
      providerReceiptId: string | null;
    },
    signal: AbortSignal
  ): Promise<RedeemResetResult>;
  verifyApplied(input: ResetAccountContext, signal: AbortSignal): Promise<boolean>;
}
```

Adapt these shapes to the real provider contract rather than forcing the provider into guessed semantics.

## Provider contract prerequisite

Before enabling live redemption, establish and document the exact upstream contract:

1. Endpoint, method, authentication, and required account/workspace identifiers.
2. Inventory response and reset-type identifiers.
3. Redemption request and response schemas.
4. Whether caller-supplied idempotency keys are supported and their retention period.
5. Whether a redemption can be queried after a timeout.
6. What response means `completed`, `accepted`, `already redeemed`, or `rejected`.
7. What independently proves that quota was restored.
8. Whether redemption is tied to account, subscription, organization, or workspace.

Do not infer that HTTP `200` proves the reset was applied.

If the provider supports neither idempotency nor status lookup, automatic production redemption cannot provide the
required at-most-once safety. Leave the feature disabled and document the blocker.

## Durable transaction model

Use a separate KV record from the existing routing state. Routing state represents account availability; the new record
represents an expensive external transaction.

Suggested key:

```text
["uos_ai", "codex_reset_redemption", "v1", account_id_hash, quota_generation]
```

The quota generation must be stable for the observed exhaustion event. Derive it from provider-supported
quota-window/reset identity when possible. Do not use a random request ID. If the provider exposes no stable generation,
define a conservative generation from the credential version and observed reset deadline, and explain collision/rotation
behavior in tests and documentation.

Suggested state:

```ts
type CodexResetRedemptionState = "claimed" | "submitted" | "unknown" | "verified" | "rejected";

type CodexResetRedemptionRecord = Readonly<{
  v: 1;
  accountIdHash: string;
  credentialVersion: string;
  quotaGeneration: string;
  idempotencyKeyHash: string;
  state: CodexResetRedemptionState;
  ownerToken: string;
  leaseExpiresAtMs: number;
  providerReceiptId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  submittedAtMs: number | null;
  verifiedAtMs: number | null;
  lastErrorCode: string | null;
}>;
```

The raw deterministic idempotency key may be recreated from stable inputs or stored encrypted if necessary. Logs and
admin responses should expose only its hash.

## State-machine rules

### Claim

Use KV compare-and-set to create or transition the record to `claimed`. Only one owner token may submit the provider
call.

### Submission

Transition to `submitted` immediately around the side-effect boundary as permitted by the provider protocol. Persist any
receipt as soon as it is available.

### Timeout or crash

If it is possible that the provider committed the reset, transition to `unknown`. A recovery worker or later request may
call `lookup()` and `verifyApplied()`, but must reuse the same logical idempotency key and must not submit a second
logical redemption.

### Lease expiry

A new worker may take over reconciliation after lease expiry. Lease takeover does not authorize a fresh redemption with
a new idempotency key.

### Verification

Only a fenced owner may transition to `verified`. Verification should reconcile the existing routing slot without
allowing a stale worker to clear a newer quota generation or credential version.

### Rejection

A definitive no-inventory, unsupported reset type, or provider rejection becomes `rejected`. Preserve an audit record;
do not loop.

## Integration with account routing

Keep ordinary account failover first. Redemption should be considered only after the current request determines that no
healthy account can serve it.

The reset belongs to the exhausted account that produced the qualifying response. After verification, retry on that same
account rather than randomizing the pool.

Credential rotation must fence the transaction:

- A record created for an old credential version cannot mutate a newly installed credential's routing state.
- Define whether reconciliation may still verify a reset at the account/subscription level after credential rotation.
- Never let credential refresh create a new idempotency key for the same quota generation.

Do not reuse the existing short 429 retry candidate as the redemption transaction. The existing retry is transient
request handling; redemption has independent persistence, ownership, recovery, and audit requirements.

## Configuration and rollout controls

Add explicit configuration with safe defaults:

```text
CODEX_BANKED_RESET_ENABLED=false
CODEX_BANKED_RESET_MODE=disabled|shadow|live
CODEX_BANKED_RESET_MAX_GLOBAL_PER_DAY=0
CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_WINDOW=1
```

Runtime configuration should support an immediate kill switch without deleting durable records.

Recommended rollout:

1. **Offline:** provider fake only; all tests pass.
2. **Shadow:** production detects candidates and records what it would do, but provider redemption is impossible.
3. **Canary:** one account, a global limit of one, active operator observation, and a prewritten rollback command.
4. **Controlled expansion:** increase limits only after auditing the canary receipt, verification, retry, and reset
   inventory.

Rollback disables new claims and submissions while preserving `submitted` and `unknown` records for reconciliation.

## Observability

Emit structured events:

- `codex_reset_eligible`
- `codex_reset_skipped_healthy_fallback`
- `codex_reset_claimed`
- `codex_reset_submit_started`
- `codex_reset_submitted`
- `codex_reset_unknown`
- `codex_reset_rejected`
- `codex_reset_verified`
- `codex_reset_inference_retry`
- `codex_reset_inference_retry_result`
- `codex_reset_duplicate_prevented`

Useful fields:

- Gateway request ID.
- Hashed account ID.
- Credential version or its hash.
- Quota generation.
- Hashed idempotency key.
- Provider receipt ID if it is safe and non-secret.
- Previous and next state.
- Owner/fence generation.
- Latency and stable error code.

Metrics:

- Eligible exhaustion events.
- Shadow candidates.
- Submission attempts.
- Verified redemptions.
- Unknown outcomes.
- Duplicate submissions prevented.
- Verification latency.
- Post-reset inference success rate.
- Estimated and actual reset spend.

## Test architecture

All tests must use dependency injection. Production network implementations must not be reachable from unit tests.

Create:

- A deterministic fake clock.
- A deterministic token/UUID source.
- An in-memory KV fake with realistic versionstamps, CAS conflicts, and optional failures.
- A scripted `FakeCodexUsageResetProvider`.
- A scripted upstream inference fetch mock.
- Sanitized contract fixtures for every known provider response.

The fake provider must record:

- Every method call.
- Account and quota generation.
- Idempotency key.
- Commit count.
- Returned receipt.
- Whether a timeout happened before or after the simulated commit.

It should support barriers so tests can pause two isolates at exact state transitions.

## Required unit and integration tests

### Trigger classification

- Fully parsed `usage_limit_reached` plus valid provider eligibility may enter shadow/claim flow.
- Generic `429`, burst throttling, overload, policy error, invalid request, `401`, and `403` never redeem.
- Missing, invalid, decimal, expired, or overflowing `Retry-After` never weakens existing routing safety.
- Truncated, oversized, malformed, fragmented, and non-JSON bodies behave according to existing bounded parsing rules.
- Unknown future error types never redeem.

### Policy and configuration

- Disabled mode makes zero provider calls.
- Shadow mode makes zero redemption calls and emits the candidate decision.
- Live mode with a nonzero global cap may redeem any eligible account, subject to routing fences and durable
  at-most-once checks.
- Global and per-account limits fail closed.
- A healthy fallback account prevents redemption.

### Happy path

```text
account A -> qualifying 429
no healthy fallback
claim succeeds
inventory reports supported reset
redeem completes
verification succeeds
original request retries once on A
retry succeeds
```

Assert one provider commit, one stable idempotency key, one inference retry, correct routing reconciliation, and
OpenAI-compatible output.

### Already redeemed

The provider returns an existing receipt for the same idempotency key. Verify state, then retry inference once without
creating another logical redemption.

### Timeout matrix

- Timeout before the provider receives the request.
- Timeout before provider commit is known.
- Provider commits, response is lost.
- Receipt is persisted, then the isolate crashes.
- Verification times out after a confirmed submission.

For every ambiguous case, assert no new idempotency key and no blind second submission. Recovery must use
lookup/verification.

### Rejection matrix

- No inventory.
- Unsupported reset type.
- Already exhausted reset allowance.
- Authentication failure.
- Provider validation failure.
- Provider server failure with unknown commit status.

Assert stable terminal/unknown state and normal OpenAI-compatible failure behavior.

### Concurrency and fencing

- Two simultaneous requests exhaust the same account.
- Two isolates attempt to claim the same generation.
- Claim owner stalls; another worker takes over after lease expiry.
- Stale owner wakes after takeover and tries to submit.
- Stale owner tries to mark verified.
- CAS conflicts occur at every transition.
- KV becomes unavailable before claim, after claim, after submit, and during verification.
- Credential refresh or auth-pool replacement occurs during every state.
- Auth-pool slot ordering changes while a transaction exists.

Core assertion: one quota generation produces at most one logical redemption and one deterministic idempotency key.

### Streaming and retry behavior

Test `/v1/responses` and any Codex-backed chat compatibility route in both buffered and streaming modes:

- No downstream headers or SSE bytes are sent before redemption and verification finish.
- Verified redemption allows one retry.
- Failed or unknown redemption sends no partial successful stream.
- A retry that returns another `429` does not redeem again.
- A retry that times out or streams a terminal error preserves current gateway telemetry semantics.
- Client abort before submission prevents redemption when safe.
- Client abort after possible commit enters reconciliation rather than resubmission.

### Property/model tests

Generate event sequences from:

```text
request, qualifying_429, claim, submit, provider_commit, response_loss,
lookup, verify, retry, crash, lease_expire, credential_rotate, kv_failure
```

Required invariants:

1. `providerCommitCount(account, quotaGeneration) <= 1`.
2. A retry occurs only after `verified`.
3. At most one post-redemption inference retry occurs.
4. `unknown` never transitions to a fresh claim with a different idempotency key.
5. A stale fence cannot advance or finalize the record.
6. Disabled and shadow modes have zero provider commits.
7. No non-qualifying response can reach the submission state.

Run randomized sequences with reproducible seeds and retain failing seeds.

### Contract tests

Use sanitized fixtures representing:

- Inventory available and empty.
- Redemption completed.
- Redemption accepted asynchronously.
- Already redeemed/idempotent replay.
- Definitive rejection.
- Authentication error.
- Rate limit.
- Server error.
- Malformed and schema-drift responses.
- Lookup pending, completed, rejected, and not found.

The parser must reject unknown or incomplete success shapes rather than treating them as success.

## Production canary checklist

The one permitted real-reset canary should happen only after:

- All unit, integration, race, and property tests pass repeatedly.
- Shadow mode has observed real qualifying events without false positives.
- The provider contract and sanitized fixtures have been reviewed.
- Idempotency and status lookup behavior are confirmed.
- The target account has exactly the expected inventory.
- Any currently routed account may be selected when its inventory is eligible.
- Global live redemption limit is exactly one.
- An operator is watching structured logs and KV state.
- The kill switch and rollback procedure have been rehearsed without a live call.
- The canary request is buffered/non-streaming and deterministic.

Expected canary evidence:

1. One qualifying exhaustion observation.
2. One durable claim.
3. One provider request with the expected idempotency key hash.
4. One receipt or idempotent completion.
5. Independent verification.
6. One successful inference retry.
7. Reset inventory decreases by exactly one.
8. No second submission during concurrent traffic or isolate restart.

Immediately disable live mode after the first canary and audit all records before considering expansion.

## Definition of done

- The provider boundary is documented and mockable.
- No live provider implementation is accessible from automated tests.
- Durable state survives isolate termination and deployment.
- Cross-isolate races cannot create two logical redemptions.
- Ambiguous outcomes fail closed and reconcile without blind resubmission.
- Public OpenAI-compatible endpoint schemas remain unchanged.
- Existing Codex account routing tests still pass.
- New trigger, policy, failure, race, streaming, property, and contract tests pass.
- Shadow mode is deployable independently of live mode.
- Live mode defaults off and requires a nonzero global cap.
- Operator documentation covers alerts, reconciliation, kill switch, and rollback.
- No real banked reset has been consumed during implementation or automated validation.

## Implementation-agent instruction

Start by inspecting the current working tree and preserving unrelated user changes. Produce a short implementation plan,
then implement the feature in small reviewable layers: provider interface and fake, durable state machine,
policy/configuration, routing integration, observability, tests, and documentation. Do not call, probe, or infer the
live redemption endpoint from production credentials. If the exact provider contract is unavailable or lacks the
required idempotency/reconciliation guarantees, complete the safe abstractions, mocks, shadow mode, and tests, leave
live mode disabled, and report the precise blocker.
