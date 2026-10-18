# Catalog runtime contract v1

Implement the source catalog runtime over the shared QueryStore and gateway-schema projections/cache helpers. The owned surface is this crate only; shared manifests, other crates, original TypeScript, credentials, live stores and deployments are excluded. This module is integration work and does not establish full application or live acceptance.

Preserve exact client-version isolation, source auth generation, current credential fingerprints and existing source revision checks, pool-order union, 5-minute freshness, 24-hour retention, per-version 15-second refresh leases and bounded cold waits. Client ETags hash the final served body. Ordinary models retain the official schema; rich versioned catalogs preserve advertised metadata, including explicit none and custom reasoning strings. Catalog failures are never quota or capacity-exhaustion evidence.

CredentialPublication is supplied by the credential owner and references the existing source records; it contains no secret. CatalogHost resolves fixed typed fetch targets, applies that exact publication's headers, enforces redirect/manual response bounds, and implements request cancellation, clock, randomness and waits. Only the existing owner may implement refresh_codex; its default explicitly reports an unavailable capability. The host must also persist the typed Codex response/transport health observations and standalone provider degradation through their existing event owners; an absent capability is an explicit failure. No environment lookup, native discovery, OAuth, scheduler or new durable ledger exists here. Provider memo entries are isolate-local, matching the source caches.

| Source | Behavior |
| --- | --- |
| Codex | Exact version, single-account conditional fetch, multi-account pool-order union, current source generation and credential revision fences |
| OpenLux | Credential-required 5-minute catalog, 30-second failure backoff, source endpoint metadata |
| Surplus | Credential-required routing availability; discovery GET remains unauthenticated, source text modality and pricing projection |
| Lithos | Credential-required rolling model discovery, 5-minute cache and source static cold fallback in gateway-schema |
| OpenRouter | Public discovery/enrichment, 5-minute cache, empty response retains prior snapshot; refresh is surfaced for request-owned background work |
| Claude | Credential/workspace identity-bound paginated discovery, observed capabilities only; failed refresh keeps IDs and withdraws reasoning permission |
| DeepSeek / Cerebras | Source-defined static model projection in gateway-schema, no discovery request |

Changed Rust paths map to scoped rustfmt, focused cargo test/check/clippy with warnings denied, and wasm32-unknown-unknown check, all on the isolated VPS interface. An explicit diagnostic workspace/lock overlay is noncanonical evidence. Stop at a clean owned commit, passing module checks, exact source/tree/log receipts and a handback of remaining integration/host capabilities. No push or PR is authorized in this lane.
