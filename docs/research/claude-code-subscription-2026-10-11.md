# Claude Code subscription capacity behind a self-hosted gateway — GPT Pro research record

Provenance: user-issued `$gpt-pro` "research first" request on 2026-10-11 authorized one submission. Job
`146b064a-5763-47fb-a4c9-34461456bd13`, model `gpt-6-pro`, submitted 2026-10-11T22:12:13Z, answer recorded
2026-10-11T22:32Z. The text below is the job's verbatim answer; its inline markers like "cite turn..." reference the GPT
Pro conversation, not local files.

---

# Claude Code subscription capacity behind a self-hosted gateway

**Research date: October 11, 2026.** Sources were checked on that date; dated changes and incident reports are
identified below. I inspected documentation and public code, but did **not** authenticate an account or run live
inference tests.

**Evidence labels:** **D — documented by Anthropic**; **C — verified in community code**, meaning static inspection, not
a successful live test; **R — reverse-engineered behavior or first-hand community reports**, including project
maintainers’ implementation descriptions; **U — unknown or not established by the available evidence.** Recommendations
are engineering judgments, not claims of Anthropic approval.

**Recommendation:** For this gateway, first investigate the newly included **Max API credits**, rather than replaying
Claude Code OAuth credentials. **D:** Anthropic’s October 7 update introduced monthly API credits for Max while
retaining subscription-limit access for the Agent SDK, `claude -p`, and third-party apps. These are two distinct billing
paths—not a conversion of the subscription into an unrestricted API account.

## 1. Terms, policy, supported mechanisms, and enforcement

### Personal automation is not the same as serving other users

**D — Consumer terms:** The currently served Consumer Terms are effective **October 8, 2025**. They prohibit sharing
account credentials or making an account available to others, resale, circumventing restrictions, and automated access
except through an API key or where explicitly permitted. Therefore, “automation is always prohibited” is too broad, but
“I pay for Max, so I can serve my team through it” is also unsupported. **D — October 7, 2026 clarification:** Anthropic
explicitly says:

> “You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits.”

This is important: older summaries claiming all SDK or third-party usage necessarily requires separate API billing do
not reflect this update.

**D — Credential-use restrictions remain:** Claude Code’s legal documentation nevertheless says developers should use
API keys or supported cloud-provider authentication for products and services; they may not offer Claude.ai login or
route Free/Pro/Max credentials **on behalf of their users**, or collect/intermediate Claude.ai credentials and session
tokens. Ordinary individual Claude Code/Agent SDK usage is the basis of advertised subscription limits. Enforcement may
occur without notice. **U — Remaining ambiguity:** The October support article does not explain exactly which
third-party implementations qualify. It does **not clearly settle whether a subscriber-written, raw-HTTP OAuth-to-OpenAI
proxy is permitted**. The strongest documented personal path is the official Claude Code/Agent SDK runtime using the
subscriber’s own authentication—not an independently reconstructed Claude Code client. The SDK documentation also
retains restrictions on third-party products offering subscription login without prior approval.

### Official mechanisms

| Mechanism                          | What is established                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent SDK / `claude -p`**        | **D:** Personal subscription-limit use remains supported in the October 7 guidance. This is not blanket authorization to supply inference to other people.                                                                                       |
| **`claude setup-token`**           | **D:** Generates a one-year token for non-interactive environments; details are in §2. It is a Claude Code authentication mechanism, not a general API-key entitlement.                                                                          |
| **GitHub Actions**                 | **D:** Official guidance accepts an API key or `claude_code_oauth_token`, including a setup token. It recommends API keys rather than personal OAuth credentials for shared repositories.                                                        |
| **Hosting unmodified Claude Code** | **D:** A separate documented arrangement allows hosting the unmodified binary under Commercial Terms, with each end user authenticating themselves and paying under their own agreement. It does not authorize pooling one owner’s subscription. |

### The newly useful alternative: included API credits

**D — October 7 rollout:** Max 5x includes **$100/month** of API credits; Max 20x includes **$200/month**. Pro is not
eligible. Credits are claimed into a Console organization and used through normal API authentication; eligibility
includes an active account in good standing for at least seven days. They expire each billing cycle rather than rolling
over. **Recommendation:** This is the lowest-change integration for your existing Messages translator. Treat it as a
finite, prepaid API allowance—not unlimited zero-cost inference.

**R — Recorded public enforcement/enforcement-adjacent evidence:** January 28, 2026: an OpenCode issue reports the error
**“This credential is only authorized for use with Claude Code.”** That establishes a reported credential-use rejection,
not a documented universal detector or permanent account ban. September 2026: OmniRoute maintainers investigated
refresh-token invalidation and cases where a generic 403 was incorrectly interpreted as an account ban; their initial
fix claim was subsequently revised. **U:** No reliable ban rate, published non-first-party detection algorithm, or
universal 403 “not authorized for API use” wording was established. Do not equate every 401/403 with enforcement against
proxies.

## 2. Credential storage, OAuth flow, expiry, and concurrent clients

### Storage and token types

| Item                               | Current evidence                                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS storage**                  | **D:** OAuth credentials normally reside in encrypted Keychain storage. If a Keychain write fails, current documentation describes a fallback to `~/.claude/.credentials.json` with mode `0600`.                              |
| **Keychain entry name**            | **R:** A July 28, 2026 security investigation of Claude Code 2.1.185 observed the generic-password service **`Claude Code-credentials`**, associated with the local username. Treat this as a version-specific observation.   |
| **Linux storage**                  | **D:** `~/.claude/.credentials.json`, protected with mode `0600`. `CLAUDE_CONFIG_DIR` relocates file storage and also changes Keychain credential isolation on macOS.                                                         |
| **Ordinary access-token lifetime** | **R:** Approximately **eight hours** is repeatedly observed, including September’s refresh incident. **U:** This is not a published fixed SLA; use the returned expiry rather than hard-coding eight hours.                   |
| **Setup-token lifetime**           | **D:** One year. The command prints the token rather than saving it; set `CLAUDE_CODE_OAUTH_TOKEN` for the intended process. It is model-access-only, not sufficient for Remote Control or fetching Claude.ai MCP connectors. |
| **Billing identity**               | **D:** An API key can override subscription authentication, especially non-interactively. Therefore, a working `claude -p` invocation does not by itself prove it used subscription capacity.                                 |

**R — Security qualification:** The July investigation demonstrated same-user credential extraction despite Keychain
storage. **U:** remediation status for every current release was not established. A one-year setup token deserves
particularly careful handling because of its long exposure window.

### OAuth endpoints and request shapes

**C — CLIProxyAPI source inspected October 11:** Its Claude integration implements authorization-code OAuth with
PKCE/S256 and state, using:

```text
Authorization: https://claude.ai/oauth/authorize
Token/refresh: https://platform.claude.com/v1/oauth/token
Public client_id: 9d1c250a-e61b-44d9-88ed-5944d1962f5e
```

The code exchange supplies `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, and `state`. Redirect
handling varies by implementation; a project’s localhost port is not a universal Claude Code requirement.

**C — Current requested scopes in that implementation:**

```text
user:profile user:inference user:sessions:claude_code
user:mcp_servers user:file_upload
```

These are observed implementation choices, not an Anthropic-published third-party OAuth registration contract.

**C — Representative refresh exchange, with secrets omitted:**

```http
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "client_id": "<public-client-id>",
  "refresh_token": "<secret>"
}
```

```json
{
  "access_token": "<secret>",
  "refresh_token": "<replacement-when-returned>",
  "token_type": "Bearer",
  "expires_in": 28800
}
```

Here `28800` is illustrative, not a guaranteed TTL. CLIProxyAPI additionally sends `scope`; ccflare’s implementation
does not. ccflare computes expiry from `expires_in` and retains the prior refresh token when no replacement is returned.

### Refresh rotation and multiple hosts

**R:** The September OmniRoute incident reports competing clients using the same account/grant and losing refresh
validity. It also exposed recovery logic that deleted a refresh token before later retries could use it. **C:** Current
CLIProxyAPI code uses refresh serialization and special treatment of ambiguous refresh failures; October releases also
address stale in-flight refreshes overwriting newer credentials. **U:** Public evidence does not establish a universal
“one host per account” rule, rotation grace period, or whether independent official logins always remain independent.
**Copying one refresh token to several independently refreshing hosts is demonstrably a different risk from obtaining
separate legitimate login grants.** **Recommendation:** Use one credential owner and one refresh authority per grant.
Atomically persist the complete replacement credential set before releasing waiting requests. Treat `invalid_grant` as
requiring reconciliation or reauthentication, not endless retries or automatic account deletion.

## 3. Subscription wire protocol and capability differences

### What is documented versus merely reproduced

| Attribute                              | Evidence and interpretation                                                                                                                                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bearer authentication**              | **C:** LiteLLM and CLIProxyAPI send OAuth access tokens through `Authorization: Bearer …`, removing `x-api-key` rather than sending both.                                                                                                                                                           |
| **`anthropic-version`**                | **D:** Current gateway documentation specifies `2023-06-01`.                                                                                                                                                                                                                                        |
| **OAuth beta**                         | **D:** Anthropic says the OAuth capability must survive gateway forwarding; removing it can cause 401s. **C:** Current bridge code uses `oauth-2025-04-20`.                                                                                                                                         |
| **`user-agent`, `x-app`, SDK headers** | **C:** CLIProxyAPI reconstructs or preserves a substantial client profile, including `x-app: cli` and Stainless/runtime headers. **U:** This does not prove that the example `claude-cli/<version> (external, cli)` or every copied header is universally server-required.                          |
| **System attribution**                 | **D:** Native Claude Code places attribution first in its system blocks. Anthropic documents stripping that block at its endpoint and warns gateways not to merge or reorder it. **U:** That is not a published instruction to authenticate arbitrary applications by adding “You are Claude Code.” |
| **Session and `metadata.user_id`**     | **C:** CLIProxyAPI aligns `X-Claude-Code-Session-Id` with the conversation UUID represented in `metadata.user_id`. **U:** I did not establish a stable, officially supported serialization format for arbitrary clients to generate `metadata.user_id`.                                             |
| **Other betas**                        | **C:** Current implementations assemble betas according to model, request type, and capabilities—not one constant header string. **D:** Anthropic recommends preserving native-client beta headers verbatim through gateways.                                                                       |

**R — Useful counterexample, July 4, 2026:** A CodexBar contributor reported successful subscription inference with only
Bearer authentication, the API version, OAuth beta, content type, and a minimal Messages body—without the proposed CLI
identity headers or system prompt. This does **not** prove the same minimum works today, but it prevents treating every
community fingerprint recipe as an established requirement. **U:** Server-side client classification, fingerprint
weighting, rollout cohorts, and enforcement thresholds are not publicly specified. Copying headers can produce a working
request without establishing either permission or long-term compatibility.

### Capability differences

| Capability         | What is known                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1M context**     | **D:** Current Opus 5.5, Sonnet 5.5, and Haiku 5.5 have native 1M context in Claude Code. Older 4.6 `[1m]` variants have plan/usage-credit conditions. Do not apply an old blanket “OAuth cannot use 1M” rule.                                          |
| **Prompt caching** | **D:** Supported with both subscriptions and API keys. Claude Code defaults included-subscription main conversations to a one-hour cache; API-key/usage-credit main conversations default to five minutes. Preserve `cache_control` and required betas. |
| **Web search**     | **D:** Claude Code’s feature matrix supports WebSearch with subscription and Console authentication. **U:** That does not guarantee every raw API server-tool version works with every OAuth grant.                                                     |
| **`count_tokens`** | **D:** It is optional for Claude Code-compatible gateways; Claude Code can fall back to estimation. **R:** July testing found it unsuitable for obtaining subscription quota headers.                                                                   |
| **Thinking**       | **D:** Current 5.5 models support adaptive reasoning/effort. **U:** An older `budget_tokens` translation is not evidence of full compatibility with current reasoning controls.                                                                         |

**Recommendation:** Preserve semantic content—system instructions, tool IDs/results, thinking blocks, cache markers—not
merely enough headers to obtain HTTP 200.

## 4. Quotas, headers, resets, and failover classification

### What subscription limits mean

**D:** Both Pro and Max have a **five-hour session limit and weekly limit**. Max additionally has a **separate weekly
Fable limit**. Usage is shared across Claude and Claude Code, so gateway-local accounting cannot know the account’s
remaining allowance independently. **D:** Consumption depends on model, context, task complexity, and effort. Anthropic
describes Opus as consuming more allowance than Sonnet, and Sonnet more than Haiku. **U:** No authoritative fixed token
allowance or complete numerical per-model weight table for Pro, Max 5x, and Max 20x was found.

### Authoritative signals and their limits

**D:** Anthropic now explicitly documents forwarding **`anthropic-ratelimit-unified-*` on both successful and 429
responses** so Claude Code can display usage and distinguish durable limits from transient throttling. Thus, the header
family itself is no longer merely undocumented folklore. **R — Observed July header examples:**

```http
anthropic-ratelimit-unified-5h-utilization: 0.01
anthropic-ratelimit-unified-5h-status: allowed
anthropic-ratelimit-unified-5h-reset: 1783180800
anthropic-ratelimit-unified-7d-utilization: 0.63
anthropic-ratelimit-unified-7d-reset: 1783713600
anthropic-ratelimit-unified-representative-claim: five_hour
```

The observed utilization values are fractions; resets are Unix seconds. **U:** Exact field presence, all status values,
model-specific windows, and selection of the representative constraint are not a fully published subscription API
contract.

**D — A supported display schema:** Claude Code’s statusline documents:

```text
rate_limits.five_hour.used_percentage
rate_limits.five_hour.resets_at
rate_limits.seven_day.used_percentage
rate_limits.seven_day.resets_at
```

Percentages are 0–100; resets are Unix seconds. Fields can be absent before the first response or after a reset. This is
a statusline interface—not evidence that every headless SDK invocation emits the same object. **R:** The internal
`/api/oauth/usage` endpoint can require `user:profile`; July testing found inference-only setup tokens received 403
there while inference worked. Do not diagnose that as an account ban or failed model entitlement. **C:** ccflare parses
unified status/reset fields, but its implementation also includes fallback assumptions for otherwise unclassified 429s.
Such assumptions are proxy policy, not authoritative remaining-subscription measurements.

### Recommended classification

**D — Baseline API semantics:** Anthropic documents 401 authentication errors, 403 permissions, 429 rate/spend limits,
and 529 overload. It also documents errors arriving inside an SSE stream after HTTP 200. These distinctions matter
independently of subscription billing.

| Observation                                                        | Recommended gateway action                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Explicit subscription-limit rejection with a relevant window/reset | Mark that account/window unavailable until reset plus a small clock margin; proceed to an eligible paid tier.            |
| Model-specific weekly exhaustion                                   | Disable that model on the subscription tier, not automatically every model.                                              |
| Generic 429 with no durable-limit evidence                         | Honor `Retry-After`, apply bounded backoff, and use a short transient cooldown. Do not invent a weekly exhaustion state. |
| 500/529/network failure                                            | Bounded retry or per-request failover; keep separate from quota accounting.                                              |
| 401                                                                | Allow one coordinated credential reconciliation/refresh attempt. Stop retrying an invalid grant.                         |
| Explicit credential-use rejection                                  | Disable the affected subscription route and alert the owner; do not attempt fingerprint escalation.                      |
| Generic 403 or request-specific refusal                            | Preserve the error’s scope. Do not permanently label the account banned or use failover to bypass a safety refusal.      |
| HTTP 200 followed by SSE error                                     | Mark the operation incomplete. Do not transparently restart after exposing partial output or executing tools.            |

**U:** A string such as “Claude usage limit reached. Resets at …” should be treated as an observed diagnostic, not a
guaranteed machine-readable contract. Prefer structured error types and upstream window/reset evidence; retain sanitized
text for diagnosis.

## 5. Current model and plan matrix

**D — October 11 documentation:** The following are current Claude Code model mappings on Anthropic’s endpoint, not the
older 2025 model lineup.

| Family | Current explicit model ID | Pro                        | Max 5x / 20x               |
| ------ | ------------------------- | -------------------------- | -------------------------- |
| Opus   | `claude-opus-5-5`         | Available; current default | Available; current default |
| Sonnet | `claude-sonnet-5-5`       | Available                  | Available                  |
| Haiku  | `claude-haiku-5-5`        | Available                  | Available                  |

**D:** Availability should be checked in the authenticated account’s `/model` picker; configuration, model rollout, and
client version can affect what is offered. **U:** No current universal, separately quantified Opus/Sonnet weekly cap for
each plan was verified. Do not import historical cap tables as current entitlements. **D:** Fable 5.1/5 also exists in
the current model catalog. Max’s separate weekly Fable limit is documented; some plan/model combinations require usage
credits. Non-interactive Fable usage may bill those credits without an interactive consent prompt. **D:** `opus`,
`sonnet`, `haiku`, `opusplan`, and `[1m]` are Claude Code configuration conventions, not interchangeable raw server
model IDs. **U:** No separate general-purpose “subscription-only model namespace” was established. Resolve and pin
explicit IDs, then validate actual entitlement under the selected authentication mode.

## 6. Public implementations: what they actually bridge

A crucial distinction is direction: **Claude Code → other providers** is not evidence of **other applications → Claude
Code subscription capacity**.

| Project                              | Implementation evidence                                                                                                                                                                                                                                                                    | Maintenance and failure evidence                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLIProxyAPI**                      | **C:** Genuine subscription bridge: Claude OAuth/refresh handling, translation, credential selection, and extensive Claude request reconstruction. It is the closest reviewed prior art to the requested gateway tier.                                                                     | **R, release history:** Active October releases. October 7 changes address missing-thread errors and moving caller system prompts into message content; other fixes address concurrent credential updates. These are significant compatibility hazards, not cosmetic changes. |
| **ccflare / better-ccflare**         | **C, ccflare:** Claude OAuth provider refreshes credentials, replaces authentication, and otherwise preserves incoming headers. **R, project docs:** Primarily native-protocol proxying/account management, not proof of OpenAI-to-Claude translation. Your translator would still matter. | **U:** Current release cadence was not conclusively established. **R:** Sticky-account behavior and refresh features are described in project/fork documentation; stickiness is a proxy choice, not proof of a server-mandated five-hour session.                             |
| **LiteLLM**                          | **C:** Current Anthropic utilities recognize OAuth credentials, replace API-key authentication with Bearer authentication, and merge the OAuth beta. This handler alone is not a complete login/refresh/session-management service.                                                        | **R:** January/February 2026 issues report wrong authentication headers or beta overwriting in particular versions. **U:** Those reports do not establish that current `main` still has those defects.                                                                        |
| **claude-code-router**               | **R, project documentation:** Primarily routes Claude Code requests to configured provider APIs. **U:** Its name and routing features do not establish a supported Claude subscription upstream.                                                                                           | **U:** Current subscription-backend correctness or an exact audited release was not established. Evaluate the relevant provider implementation, not the project name.                                                                                                         |
| **y-router; 1rgs/claude-code-proxy** | **R, project documentation:** y-router targets Claude Code → OpenRouter; 1rgs’ proxy targets Claude Code → other API providers. These are principally the reverse direction from your requirement.                                                                                         | **U:** Current release cadence and subscription-upstream support were not established. They should not be shortlisted merely because they contain “Claude” and “proxy.”                                                                                                       |
| **OpenCode**                         | **R, current project docs:** The page says bundled Claude subscription plugins were removed as of **1.3.0**, and characterizes their use as prohibited. An adjacent Pro/Max setup instruction remains, making the page internally inconsistent.                                            | **R:** January credential-authorization failures are documented. **U:** Historical plugin instructions are not reliable evidence of currently supported subscription authentication.                                                                                          |
| **Cline**                            | **R, June 24, 2025 project documentation:** Its Claude Code provider wraps the installed CLI, rather than simply treating OAuth as an API key. This is a materially different architecture.                                                                                                | **R:** 2026 issues report integration failures; a September 9 report describes native file edits bypassing expected Cline approval UI. Treat outer-application permission guarantees as something to test.                                                                    |
| **Roo Code**                         | **R, repository notice:** The project was archived/shut down **May 15, 2026**.                                                                                                                                                                                                             | Not a maintained foundation for this integration. **U:** Historical feature requests are not evidence of a functioning subscription bridge.                                                                                                                                   |

**Policy assessment:** API-key routing follows the documented authentication direction. Raw OAuth bridges have **no
established Anthropic authorization merely because they are public or maintained**. A native-CLI integration is closer
to the documented personal path, but its use for serving third parties still needs separate scrutiny. OpenCode’s own
warning also conflicts with an expansive reading of the October support article; do not silently resolve that conflict
in favor of permission.

## 7. Recommended design and validation plan

### Architecture: separate three different provider types

**Recommendation — preferred production tier:** Add an **Anthropic API-credit tier** using the normal Console API key
and your existing translator. Keep its balance/cost controls separate from subscription quota. **D:** Included credits
are consumed before purchased credits in the linked organization. Purchased balance and auto-reload can therefore turn
continued operation into paid usage; exhaustion does not automatically transfer charges to the Claude subscription.

**Recommendation — optional owner-only automation:** Use an **unmodified Claude Code/Agent SDK sidecar**, authenticated
through the official flow, for explicitly supported personal tasks. Give it a dedicated OS identity, persistent private
configuration storage, restricted filesystem/network access, and no unnecessary shell, MCP, or tool permissions.

**Recommendation — experimental raw OAuth bridge:** Keep this a separately enabled, owner-only adapter pending written
clarification. Do not disguise it as an ordinary API-key provider. Do not make it the team gateway’s default cheapest
tier.

A native agent runtime is not automatically a transparent Messages implementation. **R:** Cline’s integration reports
and CLIProxyAPI’s system-prompt relocation demonstrate that tool ownership and instruction placement can change across
these adapters.

### Minimum operational rules

| Area                    | Recommended rule                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Routing eligibility** | Apply **caller identity and capability checks before cost ordering**. A teammate, shared service account, or third-party request must never fall into the owner’s subscription route accidentally.                             |
| **Credentials**         | Prefer native credential management. For an approved raw adapter, use one encrypted credential store, one refresh authority, atomic replacement, and credential generations that prevent stale writers overwriting new grants. |
| **Request identity**    | Let the native runtime generate its own identity and attribution. For native pass-through, preserve them. Do not build a fingerprint-spoofing subsystem.                                                                       |
| **Session handling**    | Maintain conversation affinity to the appropriate account/runtime and model. Preserve transcript/tool continuity. Do not rotate accounts or identities to circumvent limits.                                                   |
| **Quota state**         | Store upstream-observed window, utilization, reset, scope, observation time, and source. Local token totals are estimates, not the account’s authoritative remaining allowance.                                                |
| **Failover**            | Use the classification in §4. Disable unexpected extra usage/auto-reload where a hard marginal-cost ceiling is required. Require explicit permission for model substitutions.                                                  |
| **Health**              | Track authentication health, quota availability, model capability, and transport health independently. “Logged in” and “HTTP 200 received” are insufficient success criteria.                                                  |
| **Telemetry**           | Record provider/model, pseudonymous account ID, request ID, credential generation, expiry, limit resets, retry reason, and paid-fallback result. Exclude tokens, cookies, token responses, and full prompts by default.        |

**D — Affinity qualification:** Prompt caching depends on matching model/prefix and provider isolation boundaries.
Native Claude Code’s working-directory and environment content affects the prefix. Therefore, stable sessions can
improve cache reuse, but this is not evidence of a universal server requirement to pin every request to one host for
five hours.

### Step-by-step validation

The following is a proposed acceptance procedure, **not a report of tests already run**.

1. **Establish the permitted scope and billing path.** Record the account, plan, chosen authentication mechanism,
   allowed callers, and approved models. Remove conflicting API-key/profile environment settings. For Max credits,
   verify the organization actually received the allowance.
2. **Prove a native subscription baseline.** Through the official runtime, issue a small deterministic request for each
   intended model. Confirm the response and the account’s subscription usage view; verify that Console API billing did
   not silently handle the request. Capture only redacted diagnostics.
3. **Prove adapter semantics.** Test non-streaming and streaming output, cancellation, multi-turn history, tool-call
   round trips, images, thinking, and caching individually. Reject unsupported features rather than dropping them. Do
   not start by burning allowance on a 1M-token stress test.
4. **Prove credential continuity.** For ordinary OAuth, test normal expiry, concurrent waiting requests, process
   restart, and atomic credential recovery with a single refresh owner. For setup tokens, test controlled replacement
   and revoked-token handling. Do not deliberately distribute one rotating refresh token among competing clients.
5. **Prove deterministic failover with fixtures.** Inject separate cases for five-hour exhaustion, weekly exhaustion,
   model-specific exhaustion, generic 429, 529, expired authentication, explicit credential rejection, and mid-stream
   failure. Assert the selected next provider, cooldown scope, and absence of leaked OAuth headers.
6. **Prove real exhaustion separately.** When legitimate usage naturally reaches a subscription limit, retain sanitized
   upstream evidence and the matching account usage display. Send one eligible gateway request and verify a successful
   paid-provider response, provider identity, and billing trace. A fabricated 429 proves routing logic—not real upstream
   quota recognition.
7. **Prove reset recovery.** After the actual blocking reset, allow one guarded probe rather than releasing all waiting
   traffic. Verify that an expired five-hour block does not override a still-active weekly or model-specific block.
8. **Prove isolation and spend safety.** Test that teammate credentials cannot reach the personal tier, including
   through retries and fallback. Scan logs for secrets. Verify that paid fallback is explicit, bounded, and observable,
   and that a broken subscription route cannot trigger an unbounded retry bill.

### Feasibility verdicts

| Scenario                                                                                                   | Verdict                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Subscriber-only personal automation through official Claude Code/Agent SDK**                             | **GREEN within documented ordinary personal use**, with quota and compatibility limits. The October 7 support update supports this path.                                 |
| **Subscriber-only, arbitrary OpenAI-compatible raw OAuth proxy**                                           | **AMBER.** Public code demonstrates technical feasibility, but neither a stable protocol contract nor unambiguous permission for this exact architecture is established. |
| **Hosted gateway serving other users through the owner’s Pro/Max credentials**                             | **RED under the published credential-use restrictions.** “Small team” and “not charging them” do not establish an exception.                                             |
| **The same personal/team application using normal API authentication, including eligible Max API credits** | **GREEN as the documented integration path**, subject to applicable Commercial Terms, credit conditions, and spending controls.                                          |

### Ranked risks

1. **Contract and account-access risk:** scope creep from personal automation to serving others, or treating technical
   acceptance as authorization. **D/U basis:** published restrictions; unresolved raw-proxy interpretation.
2. **Credential compromise and refresh races:** long-lived secrets, competing refreshers, and stale credential writes.
   **R/C basis:** July security research and September/October refresh fixes.
3. **Semantic/protocol drift:** an adapter “works” while changing system instructions, tool permissions, or session
   behavior. **R/C basis:** current bridge changes and integration incidents.
4. **Unexpected spending or false exhaustion:** shared quota, usage credits, API-credit depletion, and generic 429s
   being conflated. **D basis:** distinct subscription and API billing mechanisms.
5. **Duplicate work after partial failure:** replaying a stream or agent task after output or side effects have already
   occurred. **D basis:** errors can arrive after HTTP 200.

### Top uncertainties requiring confirmation or live testing

**U:** Whether Anthropic approves this exact owner-only raw-proxy design; the account’s actual model entitlements and
credit rollout; current required request attributes and `metadata.user_id` serialization; rotation behavior across
independent grants versus copied credentials; exact exhaustion/reset payloads for every applicable window; and whether
the adapter preserves full streaming/tool/thinking semantics.

**Immediate next step:** Check whether the owner’s Max account can claim the included API credits. That path can satisfy
the “cheapest Anthropic tier” objective with a provider configuration and spending guard, instead of making
subscription-client emulation a new reliability dependency.
