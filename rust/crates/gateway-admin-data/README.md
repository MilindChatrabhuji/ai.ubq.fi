# Admin data helpers

This crate ports pure calculations and offline migration planning from source revision `dc6be2c3b59188b0e4135b80cb4f0f6b492e232c`. It never reads a clock, a store, environment state, credentials or a network endpoint. The host supplies the observed rows, absolute time and a trusted destination revision, then commits a returned transition through the shared atomic authority.

- `projection` implements quota usage windows and refill-aware forecasts. Its locale comparator is supplied by the host because the source uses `localeCompare`. Public output removes the internal inferred-credit field.
- `profile` converts the source profile NDJSON vocabulary into explicit core `PortableValue` trees and tuple keys. Profile exports do not carry original KV expiry or storage revisions; migration plans reconstruct source retention anchors. Ordinary objects stay ordinary objects.
- `migration` classifies local/production profiles, produces fenced import plans, preserves durable pending markers, reconciles bounded legacy counters and kernel aggregates, and audits supplied inventories. Audit callers must establish complete, consistent inventories; partial inventories are refused.
- `migration::kernel::normalize_policy` is the shared source-compatible parser for admin kernel policy reads. It accepts the source's numeric-string/truncation behavior while enforcing identity and safe timestamps.

Import plans always report `requires_schema_binding: true`: copying a source-shaped record does not establish the Rust business schema or its indexes. This crate alone never adopts state, changes active authority, converts an existing database or deploys a service. The admin/runtime integration owns schema and index binding, transaction retries and all I/O.

Fixtures record 53 profile cases, 11 projection cases and 30 kernel-policy cases executed from the frozen Bun source's pure function bodies under OS network denial. The two oracle receipts preserve source, command and fixture hashes. Synthetic plan tests additionally cover expiry boundaries, typed counters, delta-only handoff, kernel aggregate reconciliation and reset/terminal identity failures.

Noncanonical date strings that need a host timezone are refused with an explicit source-normalization error. Source-produced profile dates are canonical ISO strings, including the complete ECMAScript TimeClip range. Cyclic profiles remain unsupported, and storage rejects `Error.cause` as the Bun source does.
