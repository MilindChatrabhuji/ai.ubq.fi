# Codex overage-usage toggle: spec (approved direction 2026-10-05)

## Goal

Make OpenAI overage-credit spending (the "backup" balance that keeps a subscription serving after its weekly window
reaches 100%) explicit and visible per Codex subscription. Default behavior: prefer banked resets; use overage only when
no banked reset can be redeemed.

## Setting

- KV key per account: `["uos_ai", "codex_overage_usage", "account", "v1", accountIdHash]` with `{ allow: boolean }`.
- Admin API mirrors the banked-reset settings surface: `GET`/`PATCH /admin/providers/codex/overage-usage`; PATCH body
  `{ account_id_hash, allow }`; the GET returns each account's effective value plus whether overage is observable
  (balance/reached flags when available).
- Providers view shows one checkbox per Codex subscription ("Allow overage spending") with the effective state; absence
  of a row means `allow: false` (never chosen to spend overage implicitly).
- Changing the switch never calls OpenAI, never redeems, and never mutates banked-reset state.

## Runtime semantics

- `allow = false` (default): when an account is quota- or capacity-exhausted, requests route through the banked-reset
  cohort (materialize/arm/spend as shipped). Only when that request cannot redeem a banked reset (no enabled credit,
  inventory empty or expired, arming still pending, daily cap reached, or fence refusal) may the gateway fall back to a
  bounded overage probe so the request can still be served; the fallback logs `codex_overage_served` with the reason the
  redemption was unavailable.
- `allow = true`: the operator has explicitly permitted overage spending; an exhausted account may probe/serve
  immediately as previous behavior did, while banked resets still redeem when their gates pass.
- Shadow-mode reset outcomes (`shadow_selected` and `already_would_spend_once`) count as no redemption because shadow
  never consumes a credit, so an explicitly allowed account may use the bounded overage probe.
- An unsubmitted local reset claim (`unsubmitted_transaction`) also counts as no redemption; submitted, unknown,
  live-armed, and in-progress states remain excluded.
- Never spend overage while a redeemable banked reset existed for the same request. Every fallback records the exact
  redemption-unavailable reason (`no_eligible_credit`, `inventory_unavailable`, `account_day_limit_reached`,
  `live_arming_pending`, `routing_fence_stale`, ...).
- The toggle is per account; one subscription's choice never affects another.

## Observability

- New events: `codex_overage_served` (account hash, reason redemption was unavailable), plus the existing
  routing/preflight events unchanged.
- Admin surfaces show the last overage observation per account when available (balance, `overage_limit_reached`) without
  exposing secrets.

## Tests

- Default (`allow` absent/false): a fully exhausted account with a redeemable credit must redeem and never serve
  overage; with no redeemable credit it falls back to exactly one bounded overage probe.
- `allow = true`: exhaustion probes serve without attempting a redemption when arming has not completed.
- Per-account isolation, PATCH round-trip through the admin API, and checkbox rendering assertions.
- Migration: absent rows read as false; no existing KV records are rewritten.

## Out of scope

- No change to OpenAI-side overage enablement or balances.
- No global (all-account) switch; no automatic switching of the setting.
- The per-account per-day redemption cap change is a separate, approved workstream (`docs/DECISIONS.md`).
