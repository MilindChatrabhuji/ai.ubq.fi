# ai.ubq.fi

OpenAI API-compatible gateway for the ubq.fi ecosystem, hosted on the VPS.

See [VPS operations](ops/README.md) for service management, deployment, data, and TLS.

Autonomous agents should start at `https://ai.ubq.fi/llms.txt`. The machine-readable API contract is served at
`https://ai.ubq.fi/openapi.json`, and the complete integration guide is served at `https://ai.ubq.fi/llms-full.txt` from
[`static/docs/llms-agents.md`](static/docs/llms-agents.md).

## Runtime and checks

First-party TypeScript runs directly with Bun 1.4.0, pinned by `package.json` and CI. Require the committed lockfile before installing the root dependency graph, then run the repository gates:

```bash
test -f bun.lock && test -f tools/lint/bun.lock && bun --no-env-file install --frozen-lockfile
bun --no-env-file run verify
```

The public scripts are `bun run build`, `bun run test`, and `bun run verify`. For isolated execution, use `bun --no-env-file run <script>`. `build` delegates to strict no-emit TypeScript checking; executing TypeScript with Bun does not type-check it. `test` retains the deterministic repository segments, and `verify` aggregates type, format, lint, dead-code, size, and configured test gates. Run build and test after a lint autofix. [Quality tooling](tools/lint/README.md) owns the exact segment and formatter contract.

`bun run spec:drift` is the offline CI gate that compares the Chat and Responses request allowlists with the official OpenAI request schemas recorded in `scripts/openai-spec-pin.json` (one `openai/openai-openapi` commit and the SHA-256 of its `openapi.yaml`). `--verify-source` re-downloads that pinned file and checks its digest; `--repin <commit>` moves the pin to a newer official revision, after which the gate fails until the runtime allowlists in `src/openai-schema.ts` follow; `tests/openapi-runtime-contract.test.ts` then requires `static/openapi.json` to publish exactly those allowlists. Gateway compatibility extensions stay out of the official comparison.

Isolated test children disable dotenv and auto-install, use sparse named environment profiles and disposable state, and require the actual supported OS fixture-network boundary. `verify` includes the existing offline benchmark test profile once; stress, live e2e, and live benchmark probes remain separately selected. The explicitly selected `test:e2e` segment keeps that boundary but adds its `BASE_URL` origin (default `https://ai.ubq.fi`). On Linux it admits exactly that one destination, through a destination-scoped relay that serves only the run's own namespace. On Darwin only a host-loopback `BASE_URL` can be scoped, and the run reuses the deterministic Seatbelt profile, which admits every host-loopback port rather than only the `BASE_URL` port; any other origin, the default included, fails closed. Do not invoke live or paid-provider checks as part of migration verification.

TypeScript starts directly from verified immutable releases. Runtime/dependency/native artifacts must be prepared and manifest-bound before publication; launchers use `--no-env-file --no-install`, explicitly load the repository-root `.env`, and fail closed without downloading, installing, or compiling at startup. `build:native` prepares auxiliary native guard artifacts separately; it is not an application TypeScript compile step. Merging this source does not activate production or convert its database.

The migration requires settled canonical verification and CI, exact native/runtime artifact proof, real platform confinement acceptance, and the requested gateway checks before readiness can be claimed. Real macOS Seatbelt and the standalone Sentinel frozen-reader acceptance remain separate prerequisites; this document records no pass for them. [The 2026-10-14 decision](docs/DECISIONS.md#bun-executes-first-party-typescript-live-cutover-remains-separate---2026-10-14) records the runtime, storage, and rollout boundaries.

## Development hooks

Enable the repository pre-commit hook once per checkout:

```bash
git config core.hooksPath .githooks
```

The hook automatically formats and applies safe lint fixes to staged files, then checks the gateway-owned source tree,
lint, build, and deterministic repository test program. It does not rewrite the pinned `lib/codex` checkout or run the
external Metered stress test; run `bun run test:stress` only when an explicitly approved local load test is required.

## How auth works

- Clients authenticate to `ai.ubq.fi` with a **UOS gateway token**: `Authorization: Bearer <token>`.
  - Accepted tokens come from `UOS_AI_TOKEN` and/or API keys stored in the SQLite-backed KV (created via `/admin/api-keys`).
  - Admin tokens (including Deno Deploy tokens) also grant access to client routes (`/v1/*`).
- The gateway **does not use or forward your client token upstream**.
  - For upstream requests, it uses a durable pool of up to two **Codex CLI ChatGPT auth** accounts. The first local seed
    can come from `CODEX_AUTH_JSON_B64` (base64 of `~/.codex/auth.json`); admin uploads populate the durable pool.
  - Requests are distributed between the configured OpenAI accounts. An account-level `401` or `429` is retried on every
    other account before the gateway returns the error or considers paid metered fallback. Rejected OAuth refresh
    credentials count as an account-level `401`; transient refresh-network failures do not.
  - Upstream usage/limits are tied to those OpenAI accounts and plans; client-provided OpenAI API keys are ignored.
  - The OAuth `client_id` used for refresh-token rotation is **public** (not a secret); the secrets are the tokens in
    `CODEX_AUTH_JSON_B64` and your client/admin tokens.

If a server-side Codex access or refresh token expires, `/v1/responses` and `/v1/chat/completions` return the
`x-uos-warning: codex_auth_reauthentication_required` header and an actionable message instead of silently presenting
the failure as a quota problem. A refresh rejection is returned as `503`; an upstream quota-shaped `403` can retain that
status when the access token is expired. Upload a fresh `auth.json` through the admin flow and retry. When the response
error code is `refresh_token_reused`, the configured refresh token was already consumed and a new sign-in or fresh
`auth.json` is required.

## Quickstart (curl)

Set a gateway token:

```bash
export UOS_AI_TOKEN="..."
```

Create one (admin):

```bash
curl -sS https://ai.ubq.fi/admin/api-keys \
  -H "Authorization: Bearer $DENO_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"example key","expires_at_ms":-1}' \
  | jq -r .token
```

Health:

```bash
curl -sS https://ai.ubq.fi/health  # public release liveness only
curl -sS https://ai.ubq.fi/health/providers -H "Authorization: Bearer $DENO_DEPLOY_TOKEN"
curl -sS https://ai.ubq.fi/health/upstream -H "Authorization: Bearer $DENO_DEPLOY_TOKEN"
```

List models:

```bash
curl -sS https://ai.ubq.fi/v1/models \
  -H "Authorization: Bearer $UOS_AI_TOKEN"
```

Codex clients request their native catalog for an exact installed version:

```bash
curl -sS 'https://ai.ubq.fi/v1/models?client_version=0.144.3' \
  -H "Authorization: Bearer $UOS_AI_TOKEN"
```

The unversioned response remains the strict OpenAI `{ "object": "list", "data": [...] }` contract. Supplying one exact
`X.Y.Z` `client_version` switches to the separate Codex compatibility contract and returns Codex's rich upstream
`{ "models": [...] }` payload without reducing its model records to OpenAI list objects. The gateway fetches this JSON
with server-held Codex authentication, caches each version independently in durable KV for five minutes, and can serve its
last valid copy for up to 24 hours during a temporary upstream failure. It forwards the upstream `ETag` and honors
`If-None-Match`; client bearer tokens, cookies, and upstream credentials are never mixed or exposed.

Inspect gateway-specific model capabilities:

```bash
curl -sS https://ai.ubq.fi/uos/models/capabilities \
  -H "Authorization: Bearer $UOS_AI_TOKEN"
```

Use this endpoint, not `/v1/models`, when clients need gateway-specific fields such as reasoning support or token-window
limits (`context_window_tokens`, `max_context_window_tokens`, and `auto_compact_token_limit_tokens`). `/v1/models` keeps
the strict OpenAI model-object shape.

Whoami (debug which auth method was used; never returns raw secrets):

```bash
curl -sS https://ai.ubq.fi/uos/auth \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  | jq
```

Chat completion (OpenAI-compatible):

```bash
curl -sS https://ai.ubq.fi/v1/chat/completions \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "reasoning_effort": "high",
    "messages": [{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"Tell me a short joke."}],
    "stream": false
  }'
```

Just the assistant message text:

```bash
curl -sS https://ai.ubq.fi/v1/chat/completions \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"Tell me a short joke."}],"stream":false}' \
  | jq -r '.choices[0].message.content'
```

Notes:

- System/developer messages are optional. When present, the gateway combines them into upstream instructions.
- The Codex upstream requires `stream: true`; when you set `"stream": false`, the gateway buffers the upstream stream
  and returns a normal JSON response.
- Chat completions and responses allow omitting `model`; the gateway falls back to its configured default.
- Use `reasoning_effort` for chat completions or `reasoning` for responses to control reasoning level.
- OpenAI models routed through OpenRouter receive web search and page retrieval tools by default on both endpoints.
  Caller tools are preserved; `tools: []` or `tool_choice: "none"` disables these defaults. Required/forced tool
  choices, legacy function requests, and batch variants retain their caller-defined tools. See the
  [web-tool defaults guide](static/docs/llms-agents.md#openai-web-tools-through-openrouter) for details.

Streaming:

```bash
curl -N https://ai.ubq.fi/v1/chat/completions \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "stream": true,
    "messages": [{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"Say hello in 5 different ways."}]
  }'
```

Responses (OpenAI-compatible):

```bash
curl -sS https://ai.ubq.fi/v1/responses \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "reasoning": { "effort": "high" },
    "instructions": "You are a helpful assistant.",
    "input": "Summarize this in 1 sentence: ..."
  }'
```

## Codex quota reporting

Successful inference responses let unmodified Codex terminal and GUI clients show the Metered wallet in `/status` and
emit their built-in 25%, 10%, and 5% remaining warnings. The gateway publishes the wallet as the sole canonical family:
`x-codex-limit-name: Metered balance` and `x-codex-primary-used-percent`.

Codex 0.144.6 parses multiple response-header families but persists only one response-derived rate-limit snapshot, so
named OpenAI and Metered families overwrite one another instead of remaining independent. AI.UBQ therefore strips every
parseable upstream quota family and prioritizes the client-relevant Metered balance. It does not combine that percentage
with the shared ChatGPT subscription percentage: OpenAI does not provide an absolute token denominator, and the shared
account is not an individual AI.UBQ client's truthful capacity.

Metered does not publish a weekly allowance, so the gateway never fabricates a window or reset time. A Codex client
receives the update after its first inference response; opening `/status` before sending a message can therefore show
`Limits: data not available yet`. If no valid Metered snapshot is available, the gateway emits no quota percentage.

Quota monitoring uses the non-billable OpenLux `GET /api/usage/token/` endpoint with the existing `METERED_API_KEY`
(`Authorization: Bearer ...`). It does not send `New-Api-User` or make inference requests. The reported token totals are
cached in durable KV for five minutes, guarded by a durable refresh lease, retained for 24 hours, and served stale during
temporary Metered failures. Signed `total_available` and `total_granted` values are kept as token usage data and are
never converted into refill-cycle credits. When `unlimited_quota` is true, the admin diagnostics show Unlimited, total
usage, and the observation time instead of a fabricated balance or reset window.

Embeddings (UOS text contract):

```bash
curl -sS https://ai.ubq.fi/uos/embeddings \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "model":"voyage-4-large",
    "input":["hello","world"],
    "input_type":"document",
    "dimensions":1024,
    "encoding_format":"float",
    "truncation":true
  }'
```

`POST /uos/embeddings` is a UOS endpoint backed by Voyage and cached in durable KV. It accepts text strings only, so it is
not presented as a fully OpenAI-compatible embeddings endpoint: OpenAI's endpoint also accepts token arrays, while
Voyage's text API does not. The response remains the familiar OpenAI-style `{object:"list", data, model, usage}` shape.

Request fields:

- `model` (required): `voyage-4-large`.
- `input` (required): one string or an array of strings. Token arrays are rejected.
- `input_type` (optional): `query` or `document`; defaults to `document`. Send it explicitly for retrieval workloads.
- `dimensions` (optional): `256`, `512`, `1024` (default), or `2048`.
- `encoding_format` (optional): `float` (default) or `base64`.
- `truncation` (optional boolean): defaults to `true`.
- `user` (optional string or `null`): accepted and ignored.
- `Idempotency-Key` (optional request header): enables the UOS durable replay contract.

The gateway sends Voyage `output_dimension` and `output_dtype="float"`; `base64` conversion happens in the gateway. When
rate limited (by Voyage or the gateway's own KV throttling), it returns `429` with `Retry-After`. See the
[Voyage embeddings documentation](https://docs.voyageai.com/docs/embeddings).

### Migration from the removed embeddings route

`POST /v1/embeddings` has been removed. Existing text clients must change both the URL and model:

```text
old (removed): POST https://ai.ubq.fi/v1/embeddings  model: text-embedding-3-small|text-embedding-3-large
new:           POST https://ai.ubq.fi/uos/embeddings model: voyage-4-large
```

The former text defaults are preserved: `input_type` defaults to `document`, dimensions default to `1024`,
`encoding_format` defaults to `float`, and truncation defaults to `true`. OpenAI embedding model names are not accepted
or mapped to Voyage; the response shape remains stable. Set `input_type` explicitly before migrating if query/document
intent matters.

Embeddings jobs (async, gateway-specific):

Use this when you might exceed Voyage's free-tier rate limits. The gateway will either return the embeddings immediately
or queue the request and let you poll for completion.

Create:

```bash
curl -sS https://ai.ubq.fi/uos/embedding-jobs \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"model":"voyage-4-large","input":["hello","world"],"input_type":"document","dimensions":1024,"truncation":false,"encoding_format":"float"}' \
  | jq
```

Poll:

```bash
job_id="$(curl -sS https://ai.ubq.fi/uos/embedding-jobs \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"model":"voyage-4-large","input":"hello","input_type":"query","dimensions":1024,"truncation":false,"encoding_format":"float"}' \
  | jq -r .id)"

curl -sS "https://ai.ubq.fi/uos/embedding-jobs/${job_id}" \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  | jq
```

Notes:

- Jobs intentionally retain their narrower profile: `model` must be exactly `voyage-4-large`, `input_type` is required,
  and `encoding_format` must be `float`.
- When queued, the gateway responds `202` with `Retry-After` and `retry_after_seconds`; poll until `status="succeeded"`.
- Jobs are scoped to the authenticated client identity; poll using credentials that resolve to the same identity scope
  used to create the job (same API key, or for GitHub/kernel auth the same `{owner, repo}` attestation context).
- Inputs are stored encrypted in durable KV for up to 24h to allow deferred processing, and deleted once the job completes.

## CLI (ubq-ai)

Run from this repo:

```bash
# Run from an existing ai.ubq.fi checkout (the directory containing package.json and bun.lock).
cd "$(git rev-parse --show-toplevel)"
export UOS_AI_TOKEN="..."
bun run ubq-ai chat --system "You are a helpful assistant." "Tell me a short joke."
```

Client commands also accept an admin token (`DENO_DEPLOY_TOKEN`) when `UOS_AI_TOKEN` is unset.

Run the first-party CLI directly with Bun from the checkout:

```bash
cd "$(git rev-parse --show-toplevel)"
bun run ubq-ai --help
```

Examples:

```bash
export UOS_AI_TOKEN="..."
bun run ubq-ai whoami | jq
bun run ubq-ai models | jq
bun run ubq-ai chat --system "You are a helpful assistant." "Tell me a short joke."
bun run ubq-ai chat --system "You are a helpful assistant." --reasoning-effort high "Solve: 24*7."
bun run ubq-ai chat --system "You are a helpful assistant." --stream "Say hello in 5 different ways."
bun run ubq-ai responses --instructions "You are a helpful assistant." "Summarize this in 1 sentence: ..."
bun run ubq-ai responses --instructions "You are a helpful assistant." --reasoning-effort high "Write a short proof sketch for the pigeonhole principle."
```

Debug (prints useful env/token fingerprints to stderr, never raw secrets):

```bash
bun run ubq-ai -v models
```

Health probe (cron-friendly):

```bash
# Public release liveness only:
bun run health:check --url https://ai.ubq.fi

# Operational diagnostics require admin authentication:
curl -H "Authorization: Bearer $DENO_DEPLOY_TOKEN" https://ai.ubq.fi/health/providers
curl -H "Authorization: Bearer $DENO_DEPLOY_TOKEN" https://ai.ubq.fi/health/upstream
```

### Historical Deno Deploy usage monitoring and rollback record

This retained procedure records the former Deno Deploy billing audit. Production hosting is on the VPS; these thresholds and old deployment-workflow references are not Bun runtime or live-cutover instructions.

This is an operator-run monitoring procedure. It does not add a gateway metric, an environment variable, a cron job, or
an automated alert. Use the Deno Deploy organization **Billing** and **Metrics** dashboards for usage data; the gateway
health endpoints report release identity and provider state, not billed Deno KV or egress use.

For the current billing cycle, create a manual warning record when any organization total reaches one of these
early-warning thresholds:

| Resource       | Warning threshold | Console handling                                                                                                           |
| -------------- | ----------------: | -------------------------------------------------------------------------------------------------------------------------- |
| Egress         |            150 GB | The console displays GiB. Treat 139 GiB displayed as a conservative warning; 140 GiB is already slightly more than 150 GB. |
| Deno KV reads  |              1.0M | Use the organization total, not a per-app value.                                                                           |
| Deno KV writes |              0.7M | Use the organization total, not a per-app value.                                                                           |

After every accepted production optimization, choose one UTC end timestamp and sample the same fixed-end custom ranges
for 7, 14, 21, and 28 days. Record both the organization total and the `ai-ubq-fi` overlay: the organization total is
the billing decision, while the overlay is only attribution. Preserve the dashboard's raw units and source time. Do not
compare GiB console values to GB allowances as though they were equal.

Keep these estimates separate in the observation record:

- Current-cycle Pro: the actual Billing dashboard value and current invoice context.
- Smoothed Pro: a 28-day fixed-end projection with its explicit rate and unit conversion.
- Hot-week Pro: a stress case only, not a forecast, unless the hot workload persists.
- Free feasibility: a separate pass/fail comparison against every Free limit; it is never proof that the next bill or a
  local test will fit Free.

Before and after a production change, record the observation UTC time, the full `release.git_sha` and
`release.deployment_id` from `/health`, and the matching `x-uos-git-sha` and `x-uos-deployment-id` headers. Cross-check
them against the deployment workflow's **Deployment attestation** summary. For each change, also record the prior
known-good SHA/deployment ID, a rollback trigger, the owner-approved revert target through the normal deployment
workflow, and the post-rollback `/health` identity. Do not delete KV data or use a health response as evidence of usage,
streaming, or billing acceptance. Append the filled record to
[the Deno usage audit](docs/deno-free-tier-audit-2026-08-09.md).

Admin examples (uses `DENO_DEPLOY_TOKEN`):

```bash
export DENO_DEPLOY_TOKEN="..."
bun run ubq-ai admin upload-auth --auth-json ~/.codex/auth.json | jq
bun run ubq-ai admin upload-auth --auth-json /secure/path/to/second-account-auth.json | jq
bun run ubq-ai admin keys create "example key"
bun run ubq-ai admin keys create "tmp key" --expires week
bun run ubq-ai admin keys list | jq
```

## Runtime env

The retained `DENO_DEPLOY_TOKEN` name identifies an admin credential; it does not select Deno Deploy hosting or change with the Bun runtime.

- `CODEX_AUTH_JSON_B64` (required for the initial seed): base64 of `~/.codex/auth.json` from a machine that ran
  `codex login`. It seeds one account; use the admin upload flow for the durable two-account pool.
- `UOS_AI_TOKEN` (optional): Comma- or newline-separated client tokens accepted via `Authorization: Bearer ...`. The
  gateway can also accept API keys stored in durable KV (created via `/admin/api-keys`).
- `DENO_DEPLOY_TOKEN` (optional, recommended): Tokens accepted for admin endpoints.
- `CODEX_BASE_URL` (optional): Defaults to `https://chatgpt.com/backend-api/codex`.
- `CEREBRAS_API_KEY` (optional): Server-side credential for explicit non-streaming Chat Completions requests to Cerebras
  `gpt-oss-120b`. It is never accepted from clients or exposed by health responses.
- `DEEPSEEK_API_KEY` (optional): Server-side credential for Chat Completions requests to DeepSeek's official API
  (`https://api.deepseek.com`) for the `deepseek-flash` model and its interchangeable `deepseek-v4-flash` alias. It is
  never accepted from clients or exposed by health responses.
- `VOYAGEAI_API_KEY` (optional): Voyage API key used for embeddings. If unset, the gateway will look for a key stored in
  durable KV at `["uos_ai","voyage_api_key"]`.
- `METERED_API_KEY` (optional): OpenLux business API key used only by the server for paid fallback and the non-billable
  token-usage quota snapshot. It is never sent to gateway clients.
- `SURPLUS_API_KEY` (optional): Surplus Intelligence API key used only by the server for paid fallback. It is never sent
  to gateway clients. When both paid-provider keys are configured, the gateway selects the provider by model family and
  fails over between them on provider authentication, quota, and upstream failures.
- `CLAUDE_API_KEY` (optional): Claude subscription credential used by the `claude_code` tier. It accepts the Console API
  key the operator created for the subscription (including organization-scoped `sk-ant-usr-` keys) and travels as
  `x-api-key`; an organization-scoped key discovers its `anthropic-workspace-id` once through
  `/v1/organizations/workspaces` and caches it in KV. A credential stored from the admin console wins over this
  environment value. It is never sent to gateway clients or exposed by health responses.
- `CLAUDE_CODE_OAUTH_TOKEN` (optional): The legacy owner-gated Claude Code subscription credential (the one-year token
  printed by `claude setup-token`), still accepted when `CLAUDE_API_KEY` is absent. It travels as
  `Authorization:
Bearer` with the documented OAuth beta. Present alone it changes nothing: the route also needs the
  requesting principal's key id in `CLAUDE_CODE_ALLOWED_KEY_IDS`, so subscription capacity can never serve a caller the
  owner did not name. It is never sent to gateway clients or exposed by health responses.
- `CLAUDE_CODE_WORKSPACE_ID` (optional): Pins the `anthropic-workspace-id` the subscription tier names for an
  organization-scoped credential (a `wrkspc_` id). When absent, the first rejection that requires a workspace triggers
  one discovery call and the result is cached in KV; the admin panel can also pin or clear the workspace without a
  restart.
- `CLAUDE_CODE_ALLOWED_KEY_IDS` (optional): Comma- or whitespace-separated API key ids allowed to use the subscription
  route. Empty or absent disables the route for everyone; there is no wildcard. The allowlist is checked per request and
  teammates outside it always fall through to the paid providers.
- Claude subscription admin surface: `GET`/`POST`/`DELETE /admin/providers/claude-code/auth` reads, stores (validated
  against the Anthropic models listing), and clears the credential plus an optional workspace pin;
  `POST /admin/providers/claude-code/quota/clear` drops a recorded exhaustion block, cooldown, or configuration error.
  `/admin/providers` and the admin panel's Claude subscription card report credential provenance, the workspace
  selection, the routing gates, unified and standard rate-limit windows, the last upstream outcome, and health.
  `/admin/providers/capacity` additionally carries a live `claude` analytics row (credential direction, workspace,
  windows, guards, last error) that the Analytics capacity list renders next to the Codex subscription rows; the stored
  Codex/metered capacity snapshot record keeps its own three sources, so the event sampler pays no extra KV reads.
- `CORS_ALLOW_ORIGIN` (optional): Defaults to `*`.
- `UOS_API_KEY_DEFAULT_USAGE_LIMIT` (optional): Default usage limit for new API keys in requests/week. Defaults to `50`.
- `UOS_API_KEY_DEFAULT_EXPIRY_DAYS` (optional): Default expiration for new API keys in days. Defaults to `90`.

## Output-token caps by endpoint and provider

`max_completion_tokens` is the OpenAI Chat Completions cap; `max_output_tokens` is the OpenAI Responses cap. Both are
positive-integer output caps, not quota or health indicators. Their transport behavior depends on the selected route:

| Request and provider                          | Gateway/upstream behavior                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat Completions to Codex                     | `max_completion_tokens` is translated to the Codex Responses field `max_output_tokens`.                                                                   |
| Responses to Codex                            | `max_output_tokens` is forwarded as `max_output_tokens`.                                                                                                  |
| Chat Completions to Cerebras (`gpt-oss-120b`) | `max_completion_tokens` is forwarded unchanged to Cerebras.                                                                                               |
| Chat Completions to DeepSeek official         | `max_completion_tokens` is translated to DeepSeek's documented `max_tokens`.                                                                              |
| Responses to DeepSeek official                | `max_output_tokens` is translated to DeepSeek's documented `max_tokens`.                                                                                  |
| Paid fallback (Metered or Surplus)            | The provider uses its Responses API, so Chat `max_completion_tokens` arrives as `max_output_tokens`, and Responses `max_output_tokens` remains unchanged. |

Do not swap these fields between endpoints: Chat Completions accepts `max_completion_tokens`, while Responses accepts
`max_output_tokens`. The paid-fallback cap limits generated output; it does not report the provider's remaining paid
capacity.

## Chat Completions provider contract

`gpt-oss-120b` is sent to Cerebras as a non-streaming Chat Completions request. Its standard `temperature` and
`max_completion_tokens` fields are forwarded unchanged. If a client requests `stream: true`, the gateway keeps the
client-facing SSE contract but buffers the Cerebras completion first, and returns
`x-uos-warning: gpt_oss_stream_downgraded`. Successful downgraded requests remain HTTP `200`; a non-2xx status would
make compatible clients treat the completed response as an error. The existing Terra/Codex Chat Completions path
translates `max_completion_tokens` to the upstream Responses `max_output_tokens` cap. Terra/Codex does not support
`temperature`; the gateway intentionally omits it and returns `x-uos-warning: temperature_ignored` rather than silently
treating it as a cost or behavior control.

When a provider supplies an opaque request ID, the gateway preserves its bounded, header-safe value as
`x-uos-provider-request-id` and in terminal response telemetry as `providerRequestId` / `provider_request_id`. It is a
support-correlation value only, never a credential or provider response body.

On a Cerebras `429`, the gateway also forwards Cerebras' documented `x-ratelimit-*` capacity headers. These values
describe the shared server-side `CEREBRAS_API_KEY` capacity, not a per-user UOS quota, and are not forwarded for other
upstream statuses. DeepSeek publishes no equivalent capacity headers (its limits are concurrency based and surface as
HTTP `429`), so the gateway forwards none for that provider.

### DeepSeek official

Every model the official API publishes is served here: `deepseek-flash`, its interchangeable legacy id
`deepseek-v4-flash`, and `deepseek-v4-pro` are all sent to `https://api.deepseek.com/chat/completions` using the
server-side `DEEPSEEK_API_KEY`. All three ids are advertised in `/v1/models`, `/uos/models/capabilities` and the
Codex-native model catalog; the two flash ids reach the API as the canonical `deepseek-flash` model and the response
echoes the canonical id, while `deepseek-v4-pro` is sent and echoed as itself. A missing `DEEPSEEK_API_KEY` fails with
`503 deepseek_api_key_missing` before any provider dispatch.

Reasoning follows the official contract: thinking mode is enabled by default at `high`, `reasoning_effort` accepts
`none` (which disables thinking), `low`, `high` and `max`, and the Codex `ultra` preset is sent upstream as `max`. The
chain of thought is relayed 1:1 as `reasoning_content` in both buffered responses and stream deltas.

Streaming is native rather than downgraded. A `stream: true` request relays the official SSE chunks as they arrive, so
no `x-uos-warning` is returned; DeepSeek's documented `: keep-alive` comment frames are relayed verbatim, and usage
rides the final content chunk exactly as the provider sends it.

#### Responses API adapter

The official API speaks only Chat Completions, while the Codex CLI speaks only the Responses API, so `/v1/responses`
translates both directions for these two ids. The gateway:

- maps `input` messages, `instructions`, flat and `namespace`-grouped `tools`, `tool_choice` and `parallel_tool_calls`
  onto the Chat contract, translating `max_output_tokens` to `max_tokens` and `reasoning.effort` to `reasoning_effort`;
- labels a flattened namespace function with its namespace on a name collision and maps the name back on the returned
  call, because the provider accepts only `[a-zA-Z0-9_-]{1,128}` function names;
- drops tool types the API cannot serve, such as `web_search`, rather than pretending to offer them;
- rejects a request it cannot translate faithfully (`text.format` other than `text` or `json_object`, an unknown input
  item type) with `invalid_request_error` before any provider dispatch;
- emits `response.created` through `response.completed`, including `function_call` items and their argument deltas.

Multi-turn tool use round-trips: a `function_call` plus its `function_call_output` become an assistant turn carrying
`tool_calls` followed by the tool result, which is the only shape the Chat contract accepts.

## Admin: upload/validate Codex auth.json

This validates a posted `auth.json` against the upstream Codex endpoint and stores it in a two-account durable KV pool.
Uploading a different `account_id` fills the empty slot; uploading an existing `account_id` rotates that account's
tokens without changing its slot. A third distinct account is rejected with `409 codex_auth_pool_full`.

Inference chooses a starting account randomly, which distributes independent requests without a per-request KV counter.
If that account returns `401` after refresh or returns `429`, the request is retried on the other account. Only a
failure from both accounts reaches the existing gateway error or paid-fallback path.

During validation, the server seeds the versioned catalog for the validated client version and updates the normalized
snapshot used by unversioned `/v1/models` and the default model picker. Replacing authentication invalidates all
previously cached versioned catalogs. Future Codex versions are fetched dynamically when they first request
`/v1/models?client_version=...`; no Codex binary or manual catalog upload is required.

Treat `auth.json` as a secret (it contains refresh tokens). Use the repo helper CLI:

```bash
# Run from an existing ai.ubq.fi checkout (the directory containing package.json and scripts/upload-codex-auth.ts).
cd "$(git rev-parse --show-toplevel)"
export DENO_DEPLOY_TOKEN="..."
bun run upload:auth --url https://ai.ubq.fi --auth-json ~/.codex/auth.json
bun run upload:auth --url https://ai.ubq.fi --auth-json /secure/path/to/second-account-auth.json
```

The helper CLI uses `DENO_DEPLOY_TOKEN`. If a local `codex` package is available, the helper sends its client version as
a hint so upstream returns the current Codex product catalog. The auth KV value is a hard-cutover pool record; after
deploying this change, upload both intended accounts because a pre-cutover single-account value is not read as a pool.

## Admin: create/manage UBQ API keys

API keys are stored in durable KV (hashed) and are only returned once on creation. Keys are prefixed with `u_` for easy
identification.

**Default Limits:**

- **Expiration**: 90 days (can be overridden with `--expires` or `--expires-at-ms`)
- **Usage Limit**: 50 requests/week (can be overridden with `--usage-limit`)
- **Reset Period**: Weekly (7 days, automatic)

Expiration:

- `expires_at_ms` is a Unix epoch millisecond timestamp; `-1` means "does not expire".
- Expired keys are rejected like revoked keys.

Usage Limits:

- `usage_limit_requests` sets maximum requests per week; `-1` means unlimited.
- `usage_requests` tracks current usage; resets automatically every 7 days.
- `usage_reset_at_ms` is the next reset timestamp.
- Rate limit errors (429) include reset time in the message.

Create (token only):

```bash
cd "$(git rev-parse --show-toplevel)"
export DENO_DEPLOY_TOKEN="..."
bun run ubq-ai admin keys create "example key"
```

Create (expires in a week):

```bash
bun run ubq-ai admin keys create "tmp key" --expires week
```

Create (with custom usage limit):

```bash
bun run ubq-ai admin keys create "high-volume key" --usage-limit 1000
```

Create (unlimited usage):

```bash
bun run ubq-ai admin keys create "unlimited key" --usage-limit unlimited
```

## Admin: kernel auth usage limits (GitHub token)

Kernel-attested GitHub token auth is tracked per `owner/repo` and can also be limited per org (`owner`). The default
limit is unlimited until an admin sets a per-repo or per-org limit. Limits reset weekly by default, unless `window_ms`
is provided.

Get repo usage/limit (admin):

```bash
export DENO_DEPLOY_TOKEN="..."
curl -sS "https://ai.ubq.fi/admin/kernel-usage?owner=acme&repo=demo" \
  -H "Authorization: Bearer $DENO_DEPLOY_TOKEN" \
  | jq
```

Get org usage/limit (admin):

```bash
export DENO_DEPLOY_TOKEN="..."
curl -sS "https://ai.ubq.fi/admin/kernel-usage?owner=acme&scope=org" \
  -H "Authorization: Bearer $DENO_DEPLOY_TOKEN" \
  | jq
```

Set repo limit (admin):

```bash
export DENO_DEPLOY_TOKEN="..."
curl -sS https://ai.ubq.fi/admin/kernel-usage \
  -H "Authorization: Bearer $DENO_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary '{"owner":"acme","repo":"demo","usage_limit_requests":500,"reset_usage":true}' \
  | jq
```

Set org limit (admin) with 1 request per minute:

```bash
export DENO_DEPLOY_TOKEN="..."
curl -sS https://ai.ubq.fi/admin/kernel-usage \
  -H "Authorization: Bearer $DENO_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary '{"owner":"acme","scope":"org","usage_limit_requests":1,"window_ms":60000,"reset_usage":true}' \
  | jq
```

CLI:

```bash
bun run ubq-ai admin kernel-usage get --owner acme --repo demo
bun run ubq-ai admin kernel-usage get --owner acme --scope org
bun run ubq-ai admin kernel-usage set --owner acme --repo demo --usage-limit 500 --reset-usage
bun run ubq-ai admin kernel-usage set --owner acme --scope org --usage-limit 1 --window-ms 60000 --reset-usage
```

List (admin):

```bash
bun run ubq-ai admin keys list
```

Revoke (admin):

```bash
bun run ubq-ai admin keys revoke --id "<id>"
```

## Supported routes

- `GET /`, `GET /docs`, `GET /chat`, `GET /admin`, and static assets
- `GET /health` (public passive release liveness)
- `GET /health/providers` (admin-only passive provider diagnostics)
- `GET /health/upstream` (admin-only active upstream diagnostics)
- `POST /api/auth/register/start`, `POST /api/auth/register/finish`
- `POST /api/auth/login/start`, `POST /api/auth/login/finish`
- `GET /api/auth/session`, `POST /api/auth/logout`
- `GET /admin/passkey-users`, `PATCH /admin/passkey-users` (super-admin only)
- `POST /admin/codex/auth` (admin only)
- `GET /admin/codex/models`, `POST /admin/codex/models` (admin only)
- `POST /admin/codex/prompts/purge` (admin only)
- `GET /admin/providers/codex/cache-scope-experiment` (super-admin-only, no-store redacted Stage 0 diagnostic; it is not
  authorization to run the probe)
- `POST /admin/providers/codex/cache-scope-experiment` (super-admin-only paid scope probe)
- `GET /admin/defaults`, `POST /admin/defaults` (admin only)
- `POST /admin/kv-migration/import`, `GET /admin/kv-migration/validate` (super-admin only)
- `GET /admin/api-keys`, `POST /admin/api-keys`, `PATCH /admin/api-keys`, `DELETE /admin/api-keys` (admin only)
- `POST /admin/api-keys/revoke`, `POST /admin/api-keys/unrevoke` (admin only)
- `GET /admin/kernel-usage`, `POST /admin/kernel-usage`, `DELETE /admin/kernel-usage` (admin only)
- `GET /admin/kernel-policy-queue` (admin only)
- `GET /admin/kernel-pubkeys`, `POST /admin/kernel-pubkeys`, `DELETE /admin/kernel-pubkeys` (admin only)
- `GET /uos/auth`
- `GET /uos/models/catalog` (public)
- `GET /uos/models/capabilities`
- `POST /uos/embeddings`
- `POST /uos/embedding-jobs`, `GET /uos/embedding-jobs/:id`
- `GET /uos/agent-messages`, `POST /uos/agent-messages`
- `GET /v1/models`
- `POST /v1/chat/completions` (streaming and non-streaming)
- `POST /v1/responses` (streaming and non-streaming; non-streaming buffers upstream SSE)

## Local dev

```bash
export UOS_AI_TOKEN="dev-token"
export CODEX_AUTH_JSON_B64="$(base64 < ~/.codex/auth.json | tr -d '\n')"
bun run dev
```

`bun run dev` binds to loopback, disables admin authentication for the loopback server, and injects the admin token
set as `DENO_DEPLOY_TOKEN` from the fallback chain `DENO_DEPLOY_TOKEN_UBIQUITY_DAO` → `DENO_DEPLOY_TOKEN` →
`local-dev-admin` (the `.env` file is read first). The `/admin` dashboard therefore opens with super-admin access and no
sign-in on `http://127.0.0.1:8000`. The injected token lives in the server process only — `.env` values are not
re-exported to your shell, and the admin credential never flows into separate commands. `bun run dev:local` behaves
the same way; `bun run admin:models` (and its `:spark` variant) use `DENO_DEPLOY_TOKEN_UBIQUITY_DAO` or
`DENO_DEPLOY_TOKEN` from your shell when set. A token is optional when the parsed `BASE_URL` hostname is loopback
(`localhost` in any case, `127.0.0.0/8`, or `::1` in any spelling, classified as the server classifies it; the default
is `http://localhost:8000`), but an exported token is still sent as `Authorization: Bearer ...`; unset both variables
if the listener must receive no deployment credential. A non-loopback `BASE_URL`, including a lookalike such as
`http://localhost.example.com`, requires one, exactly like the loopback server itself, which has admin authentication
disabled. Both tasks exit non-zero on an HTTP error rather than printing an empty result.

The dev wrappers explicitly source `.env` before invoking Bun with `--no-env-file`; `dev:local` retains its existing optional native-auth seed. Direct commands below do not discover dotenv files, so export their intended credentials first. The named `application` export and explicit entry point use the receipt-preserving `node:http` server, not Bun's automatic default-export server startup.

Admin authentication is disabled only when the server's actual TCP listener, the request's TCP peer, and the request URL
are all loopback. A local reverse proxy or tunnel that forwards an external request to this loopback server is
indistinguishable from a direct local connection (its upstream peer is loopback and the `Host` header is client
controlled), so the bypass also applies there: never expose the loopback dev server to the network. Startup fails if you
pass a listener override, run in Deno Deploy, duplicate a flag, or supply an unknown server argument; the direct entry
is fixed to `127.0.0.1:8000`. To require a real admin token even on loopback (for example to exercise the sign-in flow), start the server
directly without the baked-in flag:

```bash
export DENO_DEPLOY_TOKEN="..."
bun --no-env-file --no-install serve.ts
```

A loopback server with disabled admin authentication also provisions one unrestricted API key named
`Local development (loopback)` in its own KV at startup, and every local inference request is authenticated as that key.
Local requests are therefore a super-admin principal with no request limit and unlimited paid-provider routing instead
of a policy-free one — which is why `/chat` needs no sign-in locally and why models that route directly to a paid
provider (for example while Codex is switched off in the provider picker) still answer. The key's credential is minted,
stored, and never printed; nothing authenticates with it as a bearer token. Revoke it in `/admin` to switch local
paid-provider routing off — local requests then fall back to the policy-free principal and paid-only models are refused
— unrevoke it to restore the behavior, and delete it to have the next local start provision a fresh key with the current
pricing. Provisioning is gated on the loopback-only `--disable-admin-auth` flag, so it never runs on a hosted
deployment.

To start the same loopback listener directly with the development auth bypass, place the existing application flag after the entry point:

```bash
bun --no-env-file --no-install serve.ts --disable-admin-auth
```

## Legacy database conversion for Bun

The shared SQLite backend does not make Deno V8 values compatible with Bun's JavaScriptCore serialization. The Bun target is the explicitly marked `.data/kv-bun.sqlite3`; the legacy `.data/kv.sqlite3` remains untouched. Stop and drain all source writers, preserve a verified consistent backup, and convert offline into a new destination. Validate raw keys, revisions, absolute expiry, typed values, and the complete conversion receipt. Startup and deployment must not convert the live database automatically.

`bun --no-env-file run kv:convert` runs the explicit converter. Its required arguments are `--direction deno-to-bun|bun-to-deno`, `--source`, `--destination`, `--receipt`, `--deno`, and `--deno-sha256`. The checksum-pinned Deno 2.9.7 child is only an offline V8 codec tool with an empty environment; it is not the application runtime or a normal build/test/CI requirement. Ordinary raw remote Deno KV helpers fail closed; the historical remote commands below are not a Bun migration path.

Rollback to an accepted Bun code release preserves the latest marked Bun database. Returning to Deno after Bun has written data requires stopping Bun and reverse-converting its latest durable state into a new Deno destination with a verified private receipt before restoring the supported legacy release/profile. Reusing the original Deno database or migration backup discards later writes. Follow [VPS operations](ops/README.md#bun-runtime-and-offline-cutover) only for a separately authorized cutover or rollback; the PR and disposable fixture tests authorize no live conversion or restart.

Production Bun cutover also requires the standalone Sentinel integration owner's accepted frozen-source reader update: trusted offline Bun/runtime dependencies and hashes, disabled dotenv/installs, equivalent OS isolation, and proved process-execution denial. This gateway work grants no Sentinel checkout or caller-write authority; old captures stay bound to their recorded source SHA.

## Historical Deno-to-Deno KV migration

The following commands and import profiles are retained as the old Deno 1/Classic to Deno 2 migration record. They do not convert a Deno V8 database to the Bun codec and must not be used as the Bun rollout procedure.

Use the KV migration helper to inspect a Deno 1/Classic KV database, export it, map it into a local Deno 2 KV, and
validate it before any production import.

```bash
export DENO_KV_ACCESS_TOKEN="..."
SOURCE_KV="https://api.deno.com/databases/<database-id>/connect"

deno task kv:probe --source "$SOURCE_KV"
deno task kv:export --source "$SOURCE_KV" --out .kv-migration/deno1.ndjson
deno task kv:analyze --in .kv-migration/deno1.ndjson --profile local
deno task kv:import-local --in .kv-migration/deno1.ndjson --db .kv-migration/deno1.sqlite3 --profile local --overwrite
deno task kv:validate --db .kv-migration/deno1.sqlite3 --strict
```

For production, run the remote import as a dry run first. Remote imports do not write until `--write` is passed.

```bash
DEST_KV="https://api.deno.com/databases/<deno-2-database-id>/connect"
deno task kv:analyze --in .kv-migration/deno1.ndjson --profile prod
deno task kv:import-remote --in .kv-migration/deno1.ndjson --dest "$DEST_KV" --profile prod --overwrite
deno task kv:import-remote --in .kv-migration/deno1.ndjson --dest "$DEST_KV" --profile prod --overwrite --write
deno task kv:validate --target "$DEST_KV" --strict
```

For the KV read-budget v2 hard cutover, export the production database first. Then run the incident migration in two
tightly spaced phases so requests completed by the old revision during deployment are not lost:

```bash
deno task kv:export --source "$DEST_KV" --out .kv-migration/pre-kv-read-v2.ndjson

# Phase 1: run immediately before merging, while only the old revision writes bounded usage.
deno task kv:incident-v2 --target "$DEST_KV"

# Merge, wait for the exact production revision to become healthy, and drain every old-revision request before rerunning.
deno task kv:incident-v2 --target "$DEST_KV"
```

The first run atomically seeds each current bounded counter with its legacy count and records a per-key/window migration
baseline. It must report `handoff_phase: "predeploy_seed"`. The second run must report
`handoff_phase: "postdeploy_reconcile"`; it atomically adds only the positive legacy delta observed since phase 1, so
concurrent increments from the new revision are preserved. Repeating phase 2 is safe and reports a zero
`legacy_usage_delta_applied` once caught up, including when a bounded key moved to a new window during deployment.

Phase 1 requires exclusive access to the v2 counters: do not issue bounded requests through a PR preview, staging
revision, local process, or any other new-revision deployment that shares the destination KV from before phase 1 until
the production cutover. The old production revision may continue writing only the legacy counters during this interval.
Do not merge if phase 1 reports any other handoff phase.

After deployment, first confirm the exact production revision is healthy and every old-revision request has drained,
including requests that were already waiting on a non-streaming upstream response. Then run phase 2 until it reports
`postdeploy_reconcile`. Exact handoff is complete only after **two spaced post-deploy observations** both report zero
`legacy_usage_delta_applied`; any non-zero observation restarts that two-observation streak. Validation must also
succeed. Post-deploy reconciliation deliberately retains non-active counter and baseline versions so it cannot delete a
new-window increment racing the migration; validation requires the active counter and baseline without treating retained
versions as errors. The same runs also migrate the paid-fallback ledger and write compact runtime configuration.

If the new Deno Deploy database is only reachable from the app runtime, use the super-admin HTTP importer. It writes
through the deployed app's own `Deno.openKv()` connection and is also dry-run by default:

```bash
BASE_URL="https://ai.ubq.fi"
deno task kv:import-http --in .kv-migration/deno1.ndjson --base-url "$BASE_URL" --profile prod --overwrite
deno task kv:import-http --in .kv-migration/deno1.ndjson --base-url "$BASE_URL" --profile prod --overwrite --write
deno task kv:validate-http --base-url "$BASE_URL" --strict
```

The `local` profile imports durable settings plus Codex auth/model records and legacy rows for replay. The `prod`
profile imports modern durable settings only: it skips `codex_auth` and `codex_models` because the deploy workflow
refreshes authentication and seeds the normalized model snapshot from upstream validation, and it skips legacy
`["key", ...]` rows by default. Runtime-only state such as passkey sessions, WebAuthn challenges, embedding jobs, and
rate windows is skipped.
