# Codex capacity and routing contract v1

M22 owns the complete source-compatible routing/capacity schema and producer writer, based on frozen source `6d4d4790a7c06514b92938ff677dbfd52764461d`. This next-unit contract does not change frozen m17. No live observation, provider request or state migration is authorized.

## Stored schemas and constructors

`routing::RoutingState` remains the public R type with `v = 2`; its serializer and parser preserve the source `banked_reset_legacy_identity_unresolved` field. `RoutingSlot.account_id_hash` becomes `Option<RoutingAccountHash>` for real legacy null identities. Existing Rust names may retain explicit source serde names: `quota_blocks` serializes as `quota_blocks_by_class`; `retained_reset_at_ms` as `observed_reset_at_ms`; `reset_identity_ambiguous` as `banked_reset_generation_ambiguous`. R includes source slot-wide quota deadline/source/class list, primary/secondary percentages, quota and capacity observation times, timeout deadline, stable reset/recovery fields, and the complete class block map. No active field is kept only in an inverse sidecar.

`QuotaBlock.observed_at_ms` becomes `Option<i64>` and serializes as `quota_signal_observed_at_ms`; reset fields use the source names and `legacy_fallback` is explicit. `ProbeLease` gains `ProbeCircuit::{Quota, UpstreamTimeout}` and `quota_class: Option<CodexQuotaClass>`. Missing legacy probe circuit normalizes to Quota exactly as the source; unknown explicit circuits reject the slot. Timeout circuits are preserved by the source parser, then retired before live evaluation through the source generation transition; they never become quota or reset proof.

`CapacityStore` has `v = 1`, `updated_at_ms` and `observations`. `CapacityObservation` has zero-based `slot`, routing `account_id_hash`, `CapacityState::{Available, Stale, Unavailable}`, `source_observed_at_ms`, `snapshot_at_ms`, `windows: CapacityWindows` and `additional_rate_limits: Vec<CapacityAdditionalRateLimit>`. `CapacityWindows` has optional named `primary` and `secondary`. Each `CapacityWindow` retains `limit_window_seconds`, `used_percent` and `reset_at_ms`; each additional rate limit retains `limit_name`, optional `metered_feature` and its named windows. This replaces the incomplete available Boolean, anonymous window array and model-only hint. Source normalizers decide legitimate absent-field values; malformed existing state cannot be silently initialized.

These are material constructor/schema changes. M19 and M20 consume these shared types; M05 and M14 must adapt their explicit fixtures/constructors after the API commit. Old dependent receipts prove only their old source/schema and are not full-runtime acceptance of this extension. M22 edits only authority source/tests.

## Trusted producer API

The planned public methods are `Authority::begin_codex_capacity_observation(accounts: &[CodexCapacityAccountRef]) -> Result<CodexCapacityObservationFence, GatewayError>` and `Authority::record_codex_capacity_observations(fence: &CodexCapacityObservationFence, samples: &[CodexCapacitySample]) -> Result<AcceptedCodexCapacityObservations, GatewayError>`. These methods are not installed in a client HTTP/RPC surface. Fence and acceptance types have private fields, no Deserialize and no public proof constructor. Account refs identify the source slot/account, not caller-selected keys, checks or credentials. M19 supplies validated source-shaped sample facts; M05 owns the fixed trusted GET binding. No accepted/verified Boolean is a proof input.

Begin captures original raw and normalized pool/source revisions, native owner/epoch/generation, distinct account hashes and opaque fingerprint, plus trusted observation time. Record rechecks those same facts and original producer identity revisions after I/O, using AuthorityClock; it cannot restamp or rebind an old sample to a new credential. Private named fences replace arbitrary `Vec<RevisionCheck>` at the producer API.

Destination C is not a frozen prefetch input: every bounded CAS retry strongly reads its current revision and merges/retains observations exactly as source capacity-routing.ts:387-407 and native-codex-capacity.ts:598-610. No separate raw snapshot key/revision is invented. Only after that durable result does m03 reconcile R under its own fresh revision and unchanged identity fences. Do not combine the source write sets, roll back accepted C, overwrite successor R or add a scheduler. An acceptance receipt explicitly distinguishes accepted C with pending R reconciliation; retry is owned by the same source event.

## Semantic invariants

Freshness uses original sample time and source maximum age. Named additional-limit applicability, newer/equal inference quota signals, legacy fallback, independent classes, reset ambiguity/recovery and half-open ownership remain source-compatible. Stale/error/health observations cannot mint exhaustion, credential invalidity, reset eligibility or paid authority. Full-pool proof remains selection-owned. Credential rotation and pool reorder retain the source identity/generation rules.

Acceptance requires source decision/write-set vectors, original pool/credential/observation races, wrong slot/account/time, named limits, positive capacity versus newer 429, timeout/probe/legacy preservation, C conflict and restart between C and R, and quota/paid/reset separation. Exact native/WASM/strict-Clippy/rustfmt receipts remain required before integration.

## Version 1.1 fixed-fetch readback

The opaque fence exposes `fetch_bindings()` read-only borrowed views with `source_slot()`, `account_id()`, `credential_version()`, `native_generation_hash()` and optional `native_owner()`. These contain the original prefetch identities, never credentials, caller-defined checks or accepted outcome flags. M19 consumes the views and trusted capture time; M05 validates the actual fixed-GET publication and credential against them. Record still rechecks every original source revision and owner after I/O.

## Version 1.2 capacity reset materialization

Capacity materialization follows the existing stable-deadline `buildQuotaBlockedSlot` reset-identity rules: retain ambiguous stable observations, preserve independent class blocks and their source ordering, stamp the quota event with its trusted event time, refuse an owned probe lease and retain a foreign class probe's generation and lease. Observation C remains unchanged and does not itself mint reset or paid authorization. General live 429 classification and recovery remain under their existing owners.
