# Administrative implementation status

Contract version 3, source parity baseline e706343d4a5f11890e39ab3599bdc04e154b1fba. This is a source checkpoint, not a production-readiness claim.

Every exact administrative endpoint and both dynamic route families are registered in routes.rs and authenticate through the same gateway-auth resolver before dispatch. The former super-admin metadata never creates a second authorization tier. Core bounded query support is required for list/history/export routes; unbounded local scans and separate per-module key codecs are prohibited.

Implemented locally: API-key generation/import, ID/hash/common-authority policy transaction, expiry/quota/paid-input validation, revoke/unrevoke/delete fencing, atomic redacted audit construction, passkey role update and complete route classification. An API key is not deleted while the shared paid-ledger capability reports outstanding or unknown billing. Current paid pricing and exposure are obtained through the provider-owned capability before any atomic write.

The finite AdminHost operations preserve ownership for provider catalogs, credential validation/import, reset/overage authority, Claude accounts, native Supervisor, capacity, projections, analytics, kernel policy, portable migration and encrypted Sentinel exports. These operations are required integration work, not optional fallbacks. Missing implementations must return admin_capability_unavailable; they cannot silently return an empty roster, healthy source, cleared guard, successful migration, completed review or zero usage. No route is considered accepted until its actual owner implementation and live runtime conformance pass.

Remaining integration: source-compatible list/audit/history pagination using core QueryStore; current usage and paid-ledger projections; complete defaults/kernel cutover, provider/account/catalog operations; source-preserving native Supervisor inventory/read-only SQLite/rollout, full redaction conformance and actual OS confinement; capture retention/encryption/export; exact WASM WebAuthn verifier compatibility; native generation publication against the common authority pool; candidate-local browser ceremony. Existing Deno-token admin compatibility is retained in gateway-auth and must remain wired to fixed HTTPS verification.

No cron or DO alarm is authorized for maintenance. Due billing, capacity and analytics work remains event-owned. Candidate browser policy prepares exact https://rust-candidate.ai.ubq.fi with RP ai.ubq.fi and no changes to production DNS, trust, credentials or data.
