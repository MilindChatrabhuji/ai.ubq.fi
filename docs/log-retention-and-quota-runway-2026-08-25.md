# Log retention tiers and quota-runway projection — 2026-08-25

## Goal

Keep inference history as long as possible for research without unbounded raw-log growth, and let operators estimate how
long a run (for example `gpt-5.6-sol` or `gpt-5.6-luna`) can last before the paid quota balance runs out.

## Retention decision

Paid-fallback request rows used to be retained indefinitely in Deno KV. That is now bounded at one year, and
research-grade history lives in these compact stores:

| Store                         | Key prefix                                                       | Retention                     | Contents                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paid-fallback raw rows        | `uos_ai/paid_fallback/v3/request/...`                            | 365 days from `created_at_ms` | Every request row (admission, dispatch, settlement, terminal)                                                                                                                                                                                                                |
| Model usage rollups           | `uos_ai/paid_fallback/v3/usage_rollup/<hour>/<model>/<provider>` | Indefinite                    | Per-hour per-model per-provider sums: requests, quota, tokens, spend. Settled paid traffic plus one terminal observation per response that observed token usage on every route that never settles (Codex subscription capacity first); unobserved responses are not recorded |
| Metered quota balance history | `uos_ai/metered_quota/v1/balance_history/<hour>`                 | Indefinite                    | Hourly wallet balance / baseline / remaining percent (+ totals in token-usage mode)                                                                                                                                                                                          |
| Provider capacity history     | `uos_ai/provider_capacity/v1/history/...`                        | 7 days (unchanged)            | 15-minute Codex/Metered capacity snapshot used by the admin chart                                                                                                                                                                                                            |
| Provider capacity rollups     | `uos_ai/provider_capacity/v1/rollup/<hour>`                      | Indefinite                    | Hourly per-slot Codex capacity summary: min/max/last window usage                                                                                                                                                                                                            |
| Paid-fallback growth counters | `uos_ai/paid_fallback/v3/ledger_stats/<utc-day>`                 | Scanned over 365 days         | Daily settled-row/rollup byte estimates and admin projection read units                                                                                                                                                                                                      |
| Admin error log               | `uos_ai/admin_error_log/v1/...`                                  | 7 days (unchanged)            | Failed inference terminals                                                                                                                                                                                                                                                   |
| Prompt-cache analytics        | `uos_ai/prompt-cache-analytics/...`                              | 8 days (unchanged)            | Cache-token buckets                                                                                                                                                                                                                                                          |

Why rollups are the right "kept forever" shape: a settled raw row is roughly 800 B, so ~0.8 GiB per 1M rows. This was
first sized against the Deno Deploy KV plan (5 GiB included, then $0.75/GiB). That billing no longer applies: Deno
Deploy hosting is retired, and production keeps its KV in a local SQLite file under `.data/` on the VPS, which is not
billed per GiB. The hourly rollups are ~25 KB per model-provider per day, so a year of history is about
10 MB per model. The rollup captures every number the research question needs (which model, which provider, how much
quota, how many tokens, how much spend) while discarding the per-request noise.

TTL mechanics: every write to a request row re-applies `created_at_ms + PAID_FALLBACK_REQUEST_LOG_RETENTION_MS` so later
lifecycle updates can never silently drop the expiry. Keyed-anchored TTL also prevents a stuck reconciliation from
keeping a row alive forever. The KV migration that copies legacy rows applies the same TTL so a migration re-run cannot
resurrect aged-out rows.

## Where the rollup is written

`settlePaidFallbackRequestV3` (src/paid-fallback/ledger-settlement.ts) is the single choke point where the authoritative
`provider_quota`, token counts and spend are read from the provider log or direct surplus settlement. The rollup merge
happens in the _same atomic_ as the settlement, so a settled request can never miss its rollup, and a replay after an
already-settled row cannot double count. The Metered quota refresh path (`getMeteredQuotaSnapshot`) appends one hourly
balance sample per refresh; at most one sample per hour bucket is kept.

The rollup is also written by `recordTerminalUsageRollup` (src/paid-fallback/rollups.ts) from the terminal request log
in `src/handler/terminal-log.ts`, once per terminal response that observed token usage, for every route the settlement
cannot see — the Codex subscription capacity first, plus the other direct providers. That observation carries the model,
the provider route, the observed token counts and the request hour, never an upstream request id, and writes zero quota
and spend because no paid-fallback charge exists on those routes, so the paid balance math is never inflated. Providers
the settlement already covers (`metered`, `surplus`) are skipped, as are `gateway` rejections and `mixed` image-fanout
aggregates, so every request is counted exactly once. A response that never observed its input or output tokens is
skipped entirely rather than recorded as a zero-token row: a missing measurement must never be published as a measured
zero. The write is bounded and best effort: one strong read plus one atomic merge, up to three attempts on a lost
compare-and-set race, and a KV failure never changes an already-terminal response.

### Measured KV cost of the terminal observation

`tests/usage-optimization-measurement.test.ts` records the exact per-scenario KV budget, and the committed fixture pins
the added cost instead of absorbing it. One terminal response with observed usage costs exactly one strong read and one
compare-and-set commit; only a lost race retries the merge, bounded at three attempts. The captured
`operation-byte-budget` records (before → after) are the pre-PR canonical baseline `5803f74a` against the PR candidate
`f29ba1da`:

| Fixture scenario                       |     Reads |  Writes | Atomic commits |
| -------------------------------------- | --------: | ------: | -------------: |
| `bounded_api_key:success`              |   20 → 21 |   8 → 9 |          4 → 5 |
| `unlimited_api_key:success`            |   18 → 19 |   8 → 9 |          4 → 5 |
| `uos_allowlist:success`                |   12 → 13 |   4 → 5 |          2 → 3 |
| `admin_allowlist:success`              |   12 → 13 |   4 → 5 |          2 → 3 |
| `codex_auth_pool:retry`                |   13 → 13 |   4 → 4 |          2 → 2 |
| `bounded_api_key:client_disconnect`    |   18 → 18 |   6 → 6 |          3 → 3 |
| `bounded_api_key:upstream_failure`     |   40 → 40 | 21 → 21 |        12 → 12 |
| `bounded_api_key:concurrent_admission` | 207 → 213 | 37 → 38 |        26 → 29 |

`codex_auth_pool:retry` calls the Codex transport directly, so it produces no terminal response and no observation.
`bounded_api_key:client_disconnect` and `bounded_api_key:upstream_failure` never observed usage, so the writer performs
zero KV work for them and their totals are unchanged; the fixture asserts exactly that, which is the missing-measurement
truthfulness rule above. `bounded_api_key:concurrent_admission` gains the winning response's single observation, but its
totals vary with task scheduling and are not a per-request cost.

Against the audit profile of about 14.25 reads and 2.83 writes per request (`docs/deno-free-tier-audit-2026-08-09.md`),
one observed successful response adds about +7% reads and +35% writes for the current Codex-subscription-dominated
request mix; the captures above are the authoritative record.

## Quota-runway projection

`GET /admin/providers/quota-projection?window_days=7|30|90` (admin auth, default 30) returns:

- `window_days` — the requested consumption window; the rollup scan is bounded to it so the 30-second admin poll never
  pulls the full 90-day history.
- `quota` — normalized Metered quota view (wallet balance, baseline, remaining percent, totals in token-usage mode,
  refill facts).
- `models[]` — per model-provider, for the requested window: request count, quota sum, average quota per request, quota
  per hour, token and spend sums, plus `quota_source` (only `metered` is monitored) and `usage_source` (`paid_fallback`
  for settlement rows that carry quota/spend and runway estimates, `observability` for terminal accounting on routes
  that never settle, Codex subscription capacity first).
- `estimates[]` — for the requested window: requests remaining, run-time remaining, and the no-refill
  `exhausted_at_ms` contrast, percent-of-balance / percent-of-baseline knocked per request, and `stale_balance` when
  the quota snapshot is stale. Retained balance samples and refill observations additionally provide
  `refill_aware_status` (`sustainable`, `exhausts_without_refill`, `exhausts_with_refill`, or `unknown`), the known
  refill amount/cadence, and `refill_aware_exhausted_at_ms` when a scheduled refill-aware exhaustion point exists.
  Surplus rows always get an empty estimates array: `METERED_API_KEY` monitors only the OpenLux account, so projecting
  Surplus history against it would be wrong. `observability` rows never carry estimates either: they report consumption
  for a capacity the OpenLux balance does not measure.
- `balance_history` — trailing seven days of hourly balance samples.

Token-usage mode treats `total_available` as the remaining inventory (the gateway UI labels it "Available tokens"); it
is used directly and never has `total_used` subtracted from it. A stale quota snapshot (`cache_state: "stale"`) still
computes estimates but flags them for the UI.

`POST /admin/providers/quota-projection/backfill?limit=N` folds already-settled V3 rows (which predate this feature and
never passed through the settlement hook) into rollups and applies the anchored raw-row TTL to pre-existing rows. It is
idempotent and resumable: rows carry `usage_rollup_at_ms` set by the settlement write for live traffic and by this
backfill for historical rows, so a run can never double-count usage already folded into a rollup. The `limit` budgets
rows needing work, not already-backfilled ones. Repeat until `truncated` is false.

The balance samples, rollups and request rows are registered in `src/cache/kv-migration-base.ts` `DURABLE_PREFIXES` so
KV export and import preserve them. Window rows expire one year after their reset (matching the raw-row horizon), and
migration validation skips window consistency checks beyond that horizon instead of reporting aged-out history as
corrupt. The backfill also rewrites the window prefix with the anchored TTL for rows that predate it.

The Metered balance history is namespaced by a non-secret fingerprint of the configured OpenLux credentials, so rotating
`METERED_API_KEY` starts a fresh curve for the new account instead of mixing accounts in one run-down series.

Rollup keys are sharded by request id (16 shards) so concurrent settlements of the same model/provider never contend on
one KV key inside the settlement atomic; readers sum all shards. Windows and rates are hour-bucket precise: the selected
window includes the bucket that contains its start, and the rate divides by the full window, idle hours included.

The no-refill contrast remains deliberately conservative: run-time is `remaining balance / quota
per hour` (from the same window), and requests remaining is `balance / average
quota per request`. The refill-aware branch uses repeated positive balance changes to estimate a cadence, combines that
with the latest refill amount and cycle timestamps, and reports sustainable capacity when the refill rate covers the
selected burn rate. Unlimited quota yields no exhaustion estimate rather than a fake one.

The "Quota runway" card was removed from the admin Analytics view on 2026-10-03 (docs/DECISIONS.md), so no client now
polls the quota-projection endpoint. The current operator surface for the measured ledger growth is the Provider
analytics card: `GET /admin/providers/capacity` carries the same bounded growth view as `ledger_growth`, and the card
renders the estimated retained bytes, the measured bytes per settled row, the measured projection read cost and the
storage alert state (static/admin.html, static/admin.js). The endpoint itself is retained for operator and backfill use.

## Measured growth and the storage alert

The estimates above are instrumented instead of assumed. Every settlement appends one small daily counter row
(`uos_ai/paid_fallback/v3/ledger_stats/<utc-day>`, registered as a durable migration prefix) with:

- `settled_rows` / `settled_row_bytes`: settled raw rows written and their JSON-serialized size, measured with the same
  serializer the admin payload size checks use.
- `rollup_writes` / `rollup_bytes`: merged hourly rollup records written and their serialized size. This is rollup write
  volume, not retained rollup size.
- `projection_7d` / `projection_30d` / `projection_90d`: admin quota-projection views and the KV read units they
  consumed (one per KV operation plus one per returned entry), so the real cost of a 7/30/90-day view is measurable.

Counter writes are best-effort CAS merges: a lost sample never fails a settlement or an admin view, so the alert is a
lower bound on actual writes.

`GET /admin/providers/quota-projection` returns the bounded view as `ledger_growth`; `GET /admin/providers/capacity`
carries the same view, and the Provider analytics card renders it. Both are scanned over the 365-day row retention
window with a daily leaderboard bounded to 30 entries:

| Field                                    | Meaning                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `estimated_retained_raw_bytes` / `_rows` | Settled writes inside the retention window, as the raw-store estimate           |
| `avg_row_bytes`                          | Measured bytes per settled row (the earlier ~800 B estimate)                    |
| `projections[].avg_read_units_per_view`  | Measured admin projection cost per requested 7/30/90-day window                 |
| `budget_bytes` / `alert_threshold_bytes` | Operational 5 GiB raw-store budget and its 80% storage-growth warning threshold |
| `alert`                                  | True once the estimated retained store reaches the threshold                    |

These byte counters measure the JSON-serialized logical record, which is what the retention design sizes. They are not
the physical shared SQLite database or WAL footprint and not total host storage: those add page overhead, indexes,
checkpoints and every other key family, and the KV file is shared with all gateway state.

A 2026-09-22 fixture measurement confirms the row estimate: one settled V3 row with the standard fields serializes to
787 bytes, so 1M rows is ~0.73 GiB. Production rows-per-day, rollup sizes and projection read units come from the
Provider analytics card (or the `ledger_growth` payload) and should be recorded here as a representative week
accumulates.

## Follow-ups

- Byte/count baseline: instrumented as of 2026-09-22 (`ledger_stats` counters exposed as `ledger_growth`); read the
  production rows-per-day, bytes-per-row, rollup and projection-read numbers from the Provider analytics card and record
  them here before re-tuning the raw-row horizon.
- Oldest-first hard cap: not implemented, and declined by the owner on 2026-10-16 (issue #139): the KV lives on the VPS
  with ample disk, so the per-GiB billing that motivated a hard cap no longer applies. The 365-day TTL bounds the raw
  rows, and the 5 GiB `budget_bytes` figure only sets the growth alert; nothing is evicted when it is reached. If a
  byte budget ever becomes necessary, it would need timestamp-ordered keys or a global age index — note the legacy
  analytics key shape `[keyId, createdAtMs, requestId]` as a precedent.
- The provider-capacity chart view stays at seven days on purpose. Long-run capacity research reads the separate
  forever-kept hourly rollups through `GET /admin/providers/capacity/rollups?window_days=N` (default 90, capped at 365):
  every persisted capacity sample folds its per-slot window summaries into the same atomic as the 15-minute history
  point, and that read never feeds the chart payload.
