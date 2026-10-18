# LLMs and Agents

UbiquityOS AI Gateway provides OpenAI-compatible endpoints for chat and responses, plus agent message storage for
kernel-driven workflows. This page focuses on LLM usage and agent messages.

## Base URL

Use this base URL with an OpenAI-compatible client:

```
https://ai.ubq.fi/v1
```

Use this `/v1` URL as the `baseURL` or `base_url` in OpenAI-compatible SDKs. Do not append another `/v1` in request
paths when the SDK already joins paths against the configured base URL.

## Authentication

Send a bearer token in `Authorization`:

```
Authorization: Bearer <UOS_AI_TOKEN>
```

Accepted tokens:

- Gateway tokens configured via `UOS_AI_TOKEN` on the server.
- API keys stored in Deno KV (created via `/admin/api-keys`).
- Admin tokens (Deno Deploy token or allowlisted admin token) are also accepted for client routes, but application
  integrations should not label client credentials as `DENO_DEPLOY_TOKEN`.
- GitHub tokens are accepted only when paired with kernel attestation headers.

For app integrations, name the client credential `UOS_AI_TOKEN` or another gateway/API-key-specific name. Reserve
`DENO_DEPLOY_TOKEN` for Deno Deploy admin operations.

The gateway never forwards your client token upstream. It uses Codex CLI auth configured on the server.

Administrators can upload a fresh Codex `auth.json` through the repository helper. Run these commands from an existing
`ai.ubq.fi` checkout (the directory containing `package.json` and `scripts/upload-codex-auth.ts`):

```bash
cd "$(git rev-parse --show-toplevel)"
export DENO_DEPLOY_TOKEN="..."
bun run upload:auth --url https://ai.ubq.fi --auth-json ~/.codex/auth.json
bun run upload:auth --url https://ai.ubq.fi --auth-json /secure/path/to/second-account-auth.json
```

Treat `auth.json` as a secret because it contains refresh tokens. The helper sends it only to the authenticated admin
route; never put its contents in a client request or commit it.

### GitHub token headers (kernel auth)

When using a GitHub token for any `/v1/*` route, include:

- `X-Ubiquity-Kernel-Token: <jwt>`

The attestation names the repository. `X-GitHub-Owner: <owner>` and `X-GitHub-Repo: <repo>` are optional cross-checks:
when both are sent, they must equal the repository the attestation names.

If the kernel attestation includes `installation_id`, also send:

- `X-GitHub-Installation-Id: <id>`

## Quick start (curl)

Set a gateway token:

```bash
export UOS_AI_TOKEN="..."
```

List models:

```bash
curl -sS https://ai.ubq.fi/v1/models \
  -H "Authorization: Bearer $UOS_AI_TOKEN"
```

Send a chat completion:

```bash
curl -sS https://ai.ubq.fi/v1/chat/completions \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "model": "gpt-5.5",
    "reasoning_effort": "low",
    "stream": false,
    "messages": [
      {"role": "system", "content": "You are helpful."},
      {"role": "user", "content": "Say hi."}
    ]
  }'
```

Request UOS text embeddings:

```bash
curl -sS https://ai.ubq.fi/uos/embeddings \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"model":"voyage-4-large","input":["hello","world"],"input_type":"document"}'
```

## Endpoints

OpenAI-compatible endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Codex compatibility endpoints:

- `GET /v1/models?client_version=X.Y.Z`

UOS gateway endpoints:

- `GET /uos/auth`
- `GET /uos/models/catalog` (public, no bearer token)
- `GET /uos/models/capabilities`
- `POST /uos/embeddings`
- `POST /uos/embedding-jobs`
- `GET /uos/embedding-jobs/{id}`
- `GET /uos/agent-messages`
- `POST /uos/agent-messages`

Health endpoints:

- `GET /health`
- `GET /health/providers`
- `GET /health/upstream`

## Models

`GET /v1/models` returns a strict OpenAI-style model list (`object: "list"`, `data: [...]`) from the stored live Codex
model catalog. Each model object contains only the OpenAI model fields: `id`, `object`, `created`, and `owned_by`. When
no snapshot has been initialized, it returns an empty list.

`GET /v1/models?client_version=X.Y.Z` is a separate Codex-native compatibility contract. It accepts exactly one
three-part numeric version and returns the untouched rich upstream `{ "models": [...] }` JSON for that exact Codex
version. It is intentionally not part of the official OpenAI model-list schema. The gateway uses only its server-held
two-account Codex authentication pool upstream, caches validated gzip-compressed JSON by version in Deno KV for five
minutes, retains a last valid copy for 24 hours, and uses a durable refresh lease to collapse concurrent upstream
refreshes. Inference distributes requests across the two accounts and retries the other account after an account-level
`401` or `429`. Upstream `ETag` values are returned, and matching `If-None-Match` requests receive `304 Not Modified`
with no body; clients must reuse their cached catalog instead of parsing a response body. A temporary refresh failure
serves the last valid version-specific copy; the route returns `502` when no valid copy exists.

Use `/v1/models` as the source of truth instead of assuming OpenAI public API aliases are supported. The gateway is
backed by Codex with a ChatGPT account, so some OpenAI API model aliases may not be available through this gateway.
Hidden Codex catalog entries are filtered when the normalized snapshot is refreshed unless upstream marks them
`supported_in_api: true`; API-supported review models are therefore exposed by the unversioned OpenAI model list.

Use `GET /uos/models/capabilities` for gateway-specific model metadata such as `supported_reasoning_levels`,
`default_reasoning_effort`, `context_window_tokens`, `max_context_window_tokens`, `auto_compact_token_limit_tokens`,
`supported_endpoints`, and `upstream_provider`. This metadata is intentionally not included in `/v1/models` so
OpenAI-compatible SDKs receive an OpenAI-shaped response.

## Prompt-cache observations

The gateway does not store, copy, or move an upstream prompt cache. It forwards a client-supplied `prompt_cache_key`;
keep that key stable for the same conversation prefix. Do not derive it from an `auth.json` file: changing the key
deliberately creates a new cold cache.

Production observations on 2026-07-28 confirm that streaming Codex conversation traffic is cached. An identical
streaming `gpt-5.6-terra` request with a stable key reported 12,032 cached input tokens out of 12,612 input tokens. The
second Codex account also served live cache hits, including 76,032 cached tokens out of 84,188 input tokens and 83,712
out of 91,088. This means moving ordinary traffic to the second account does not make all traffic cold.

Cache reuse is still prefix-dependent: a request with a changed or non-cacheable prefix can be cold, and a cache hit on
account B alone does not prove that account B reused account A's exact upstream entry. Do not promise that every active
conversation retains its cache after an account change until a controlled A-to-B probe has completed.

Admins can inspect the current immutable-release Stage 0 telemetry at `/admin/providers/codex/cache-scope-experiment`
with a `GET` request. It is a `no-store`, redacted diagnostic for the server-selected campaign target; it never accepts
a model selector and it does not authorize or start the paid scope probe.

For this Codex upstream, use the plain `prompt_cache_key` for live traffic. During the same production investigation,
the upstream rejected `prompt_cache_options` as unsupported; do not rely on explicit-mode or TTL controls until the
upstream accepts them.

## Codex quota reporting

After an inference response, stock Codex terminal and GUI clients can show the Metered wallet in `/status` and emit
their built-in 25%, 10%, and 5% remaining warnings. The gateway publishes only the canonical `x-codex-*` family, named
`Metered balance`.

Codex 0.144.6 parses multiple response-header families but persists only one response-derived rate-limit snapshot. Named
OpenAI and Metered families therefore overwrite one another instead of remaining independent. The gateway strips every
parseable upstream quota family and prioritizes the client-relevant Metered balance. It does not combine Metered with
the shared ChatGPT subscription percentage because OpenAI provides no absolute token denominator and the shared account
is not an individual AI.UBQ client's truthful capacity.

The Metered wallet is not a weekly quota. The gateway does not emit a synthetic `primary-window-minutes` or
`primary-reset-at` value for it. A client that opens `/status` before its first inference response may still say that
limit data is unavailable because Codex learns these headers from inference responses. If no valid Metered snapshot is
available, the gateway emits no quota percentage.

The Metered percentage uses a Deno KV-backed refill cycle rather than adding all historical top-ups. Its first baseline
is the larger of the observed wallet balance and latest successful top-up. Later credits are inferred from wallet
movement and the account usage counter; a new top-up record always starts a new cycle. If the usage counter also
advanced, known inter-observation debits are restored to the observed balance before choosing that cycle's capacity so
post-refill spend does not shrink the denominator. Snapshots are fresh for five minutes, retained for 24 hours,
protected by a durable refresh lease, and served stale during temporary account API failures. Inference never waits for
a slow account refresh: it uses only a snapshot that is already available. Metered-routed responses invalidate their
pre-debit observation so the next request refreshes it. `GET /admin/defaults` exposes non-secret diagnostics in
`metered_quota`; credentials are never returned.

Observed integration behavior:

- `gpt-5.5` works for `/v1/chat/completions`.
- `gpt-5.5` accepts `reasoning_effort: "low"`.
- `gpt-5-chat-latest` and `gpt-5.1-chat-latest` are rejected when they are absent from `/v1/models`:

```json
{
  "error": {
    "message": "The model 'gpt-5-chat-latest' does not exist or is not available through this gateway. Use /v1/models for supported models.",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

The gateway does not reject non-empty reasoning tier strings before contacting Codex. Codex upstream remains
authoritative and any upstream rejection is returned in the normal OpenAI-style error envelope.

## Chat Completions

`POST /v1/chat/completions`

Required:

- `messages` must be a non-empty array.

Optional (defaulted by the gateway):

- `model` (defaults to the configured model).
- `stream` (defaults to `false`).
- `reasoning_effort` (defaults to the configured reasoning effort).

Supported message content:

- String content: `"content": "..."`
- Mixed content array with text and images:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Describe this image." },
    { "type": "image_url", "image_url": { "url": "https://..." } }
  ]
}
```

System and developer messages are combined into a single instruction block upstream. User and assistant messages are
passed through as conversation input.

Role mapping notes:

- `system` and `developer` are merged into upstream instructions.
- `tool` is treated as a developer message.
- Image parts are only accepted on user messages; assistant image parts are ignored.

### Streaming

Set `"stream": true` to receive server-sent events (`text/event-stream`) in OpenAI `chat.completion.chunk` format with a
final `data: [DONE]` sentinel.

```bash
curl -N https://ai.ubq.fi/v1/chat/completions \
  -H "Authorization: Bearer $UOS_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "stream": true,
    "messages": [
      {"role": "user", "content": "Say hello in 5 different ways."}
    ]
  }'
```

If `stream` is omitted or `false`, the gateway buffers the upstream stream and returns a standard chat completion JSON
response.

## Responses

`POST /v1/responses`

Input formats:

- String input: `"input": "..."`
- Array of message items:

```json
[{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Hello" }] }]
```

- Array of content items (coalesced into user messages):

```json
[
  { "type": "input_text", "text": "Summarize this" },
  { "type": "input_image", "image_url": "https://..." }
]
```

If `input` is omitted, the gateway sends an empty input array upstream.

Optional fields:

- `model` (defaults to the configured model).
- `instructions` (string).
- `reasoning` (object).
- `stream` (defaults to `false`).

`reasoning` object fields:

- `effort` (string).
- `summary` (string).
- `generate_summary` (string).

Example:

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

When `stream` is `false`, the gateway buffers the upstream stream and returns the final `response` object. When `stream`
is `true`, the upstream SSE stream is passed through.

## OpenAI web tools through OpenRouter

For OpenAI models routed through OpenRouter, both `/v1/chat/completions` and `/v1/responses` add `openrouter:web_search`
and `openrouter:web_fetch` by default. This includes Pro and older OpenAI models; OpenRouter uses native provider search
when available and a fallback engine otherwise. The model decides when to use the tools, and tool usage incurs the
applicable OpenRouter charges. Enabling the tools does not impose a research duration.

Caller-provided function tools and web-tool settings are preserved. Missing web tools are appended without duplicating
OpenRouter or native web-tool entries. Send `"tools": []` or `"tool_choice": "none"` to opt out. Defaults are also
omitted for required or forced tool choices, legacy `functions`/`function_call` requests, and `:batch` models. Other
providers retain their existing behavior. No gateway-only request field is needed.

For a long research request, select an available Pro model, choose its supported reasoning effort, and enable streaming.
The gateway's OpenRouter route remains tied to the client connection and has a 30-minute deadline; it does not expose
stored-response retrieval or a background research job API.

See [OpenRouter web search](https://openrouter.ai/docs/guides/features/server-tools/web-search) and
[web fetch](https://openrouter.ai/docs/guides/features/server-tools/web-fetch) for engine behavior and pricing.

## Embeddings

`POST /uos/embeddings`

UOS's text-only embeddings endpoint is backed by Voyage and cached in Deno KV. It is not a fully OpenAI-compatible
embeddings endpoint: OpenAI accepts token arrays, while this Voyage-backed route accepts text only. The response keeps
the OpenAI-style `{object:"list", data, model, usage}` shape.

Request:

- `model` (string, required): `voyage-4-large`.
- `input` (string or string[], required). Token arrays are rejected.
- `input_type` (optional): `query` or `document`; defaults to `document`. Send it explicitly for retrieval workloads.
- `dimensions` (optional): `256`, `512`, `1024` (default), or `2048`.
- `encoding_format` (optional): `float` (default) or `base64`.
- `truncation` (optional boolean): defaults to `true`.
- `user` (optional string or `null`): accepted and ignored.
- `Idempotency-Key` (optional header): enables durable UOS replay.

The gateway sends `voyage-4-large` to Voyage and returns one `data[]` entry per input string. OpenAI embedding model
names are not accepted or mapped to Voyage.

Notes:

- Batching is strongly recommended (send `input` as an array).
- When rate limited (by Voyage or the gateway's own KV throttling), the gateway responds `429` with `Retry-After`.
- `base64` encoding is converted by the gateway; Voyage is always called with float output.

### Migration from the removed embeddings route

`POST /v1/embeddings` has been removed. Text clients must change both the URL and model:

```text
old (removed): POST https://ai.ubq.fi/v1/embeddings  model: text-embedding-3-small|text-embedding-3-large
new:           POST https://ai.ubq.fi/uos/embeddings model: voyage-4-large
```

The former text defaults remain (`document`, `1024`, `float`, and `truncation=true`), and the response shape remains
stable. OpenAI embedding model names are not accepted or mapped to Voyage. Send `input_type` explicitly before migrating
when query/document intent matters.

## Embedding Jobs (Async)

`POST /uos/embedding-jobs` creates an async job. The gateway either completes it immediately (`200`) or queues it
(`202`) when Voyage is rate limited.

`GET /uos/embedding-jobs/{id}` polls the job until `status="succeeded"` or `status="failed"`.

Notes:

- Jobs retain a narrower contract: `model` must be exactly `voyage-4-large`, `input_type` is required, and
  `encoding_format` must be `float`.
- When queued, the gateway responds with `Retry-After` and `retry_after_seconds`.
- Jobs are scoped to the authenticated client identity; poll using credentials that resolve to the same identity scope
  used to create the job (same API key, or for GitHub/kernel auth the same `{owner, repo}` attestation context).
- Inputs are stored encrypted in Deno KV for up to 24h to allow deferred processing, and deleted once the job completes.

## Reasoning defaults

- Models with `supported_reasoning_levels` in the stored Codex catalog default to the configured reasoning effort.
- Non-reasoning models default to `none`.
- Reasoning tier strings come from each model's uploaded Codex CLI metadata; inspect `/uos/models/capabilities` instead
  of relying on a hard-coded tier list.
- Use `reasoning_effort: "none"` (chat completions) or `reasoning: { "effort": "none" }` (responses) to disable
  reasoning on Codex models. `none` remains available there even when the uploaded catalog omits it, and the gateway
  preserves it verbatim at the Codex upstream boundary. Cerebras `gpt-oss-120b` supports only `low`, `medium`, and
  `high`; omit the field to use its `medium` default.
- Other non-empty tier strings pass through to Codex upstream without gateway validation unless the stored catalog
  provides a wire translation. If upstream rejects one, inspect `/uos/models/capabilities` and retry with a tier
  advertised for that model.
- The stored catalog includes a metadata-derived `reasoning_effort_wire_map`; request handling applies that map
  generically and otherwise passes the selected effort through unchanged. For the current Codex catalog this maps the
  `ultra` orchestration preset to upstream effort `max`. Automatic multi-agent delegation is performed by Codex clients
  and is not provided by this stateless API gateway.
- In the browser chat playground, `Default` omits `reasoning_effort`; `None` sends `reasoning_effort: "none"` for models
  that support it. Cerebras `gpt-oss-120b` does not show the `None` option.

Defaults can be managed via `/admin/defaults` (admin auth required). When no model is explicitly configured, the gateway
uses the first model in the current Codex model snapshot. If neither a configured default nor a snapshot is available,
no-model requests fail with `503` instead of fetching a live fallback catalog.

`GET /uos/models/capabilities` is the endpoint to inspect reasoning support and token-window limits programmatically.
`/v1/models` remains OpenAI-compatible and does not include gateway metadata.

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

### DeepSeek official

Every model the official API publishes routes to `https://api.deepseek.com/chat/completions` using the server-side
`DEEPSEEK_API_KEY`: `deepseek-flash`, its interchangeable legacy id `deepseek-v4-flash` (both reach the API as the
canonical `deepseek-flash` model, which is the id echoed in responses), and `deepseek-v4-pro`, which is sent and echoed
as itself. Their catalog rows report `upstream_provider: "deepseek"`, tiers `none`/`low`/`high`/`max`, and a `high`
default. Catalog rows list every provider that publishes an id; the operator's whitelist selection, not the catalog
builder, decides which models the gateway advertises.

Both ids are also served on `/v1/responses` through a translation adapter, because the Codex CLI speaks only the
Responses API while the official API speaks only Chat Completions. `input`, `instructions`, flat and `namespace`-grouped
`tools`, `tool_choice` and `parallel_tool_calls` are mapped onto the Chat contract; `max_output_tokens` becomes
`max_tokens` and `reasoning.effort` becomes `reasoning_effort`. Namespaced functions are flattened (a collision takes
its namespace as a prefix and is mapped back on the returned call), tool types the API cannot serve such as `web_search`
are dropped, and a request that cannot be translated faithfully is rejected with `invalid_request_error` before
dispatch. Multi-turn tool use round-trips as an assistant turn carrying `tool_calls` followed by the tool result.

Streaming is native rather than downgraded: `stream: true` relays the official SSE chunks as they arrive with no
`x-uos-warning`, `: keep-alive` comment frames pass through verbatim, and usage rides the final content chunk exactly as
the provider sends it. `reasoning_content` is relayed 1:1, `none` disables thinking, and the Codex `ultra` preset is
sent upstream as `max`. A missing `DEEPSEEK_API_KEY` fails with `503 deepseek_api_key_missing` before any provider
dispatch.

## Ignored parameters and warnings

Requests accept a broad set of OpenAI-compatible keys, but unknown top-level keys are rejected with
`invalid_request_error`. Only a subset are forwarded upstream. Ignored keys are reported in the `x-uos-warning` response
header (comma-separated).

For the most portable request, start with only `model`, `messages`, `stream`, and `reasoning_effort`. Add optional
OpenAI parameters only after checking this section or validating the target endpoint.

Keys forwarded to ChatGPT Codex for chat completions:

- `tools`
- `tool_choice`
- `parallel_tool_calls`
- `prompt_cache_key`

Keys forwarded to ChatGPT Codex for responses:

- `tools`
- `tool_choice`
- `parallel_tool_calls`
- `prompt_cache_key`
- `text`
- `include`
- `context_management`

The public endpoints accept `prompt_cache_options`, `prompt_cache_retention`, and explicit cache breakpoints, but the
ChatGPT Codex subscription transport does not. The gateway omits those controls only from that upstream leg and reports
`prompt_cache_options_ignored`, `prompt_cache_retention_ignored`, or `prompt_cache_breakpoint_ignored` as applicable.
Validated controls remain available to a paid fallback that supports them.

The Codex CLI compatibility extension `client_metadata` is accepted as a string map and stripped before the gateway
builds the upstream request. It remains separate from the official OpenAI request schema. The gateway generates its own
upstream request metadata instead of forwarding client-supplied session identifiers.

`store` is set to `false` on the ChatGPT Codex subscription transport. OpenRouter requests forward the caller's `store`
field; OpenRouter's stateless Responses API rejects `store: true`. The following are ignored by the ChatGPT Codex
subscription transport and will produce warnings when that transport handles the request:

- `temperature` -> `temperature_ignored`
- `max_tokens` -> `max_output_tokens_ignored` (the endpoint-specific output-cap fields above are handled separately)
- `moderation` -> `moderation_ignored`

Any other accepted-but-unused key will emit a `<key>_ignored` warning.

### Function-tool example

For an agent that can safely call an application-owned function, send a typed OpenAI function tool. Give every function
a stable name, a clear description, and a JSON Schema `parameters` object. The tool result must be returned through the
normal endpoint-specific tool-result format; never use a tool schema to carry a bearer token or an administrator action.

```json
{
  "model": "<a model returned by /v1/models>",
  "input": "Find the current status for issue 42.",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_issue_status",
        "description": "Read the status of one application issue by its numeric identifier.",
        "parameters": {
          "type": "object",
          "properties": { "issue_id": { "type": "integer", "minimum": 1 } },
          "required": ["issue_id"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

The machine-readable request schema, response variants, and error envelopes are published at `/openapi.json`. Query the
live model list before a tool-enabled inference request so a client does not assume an unavailable model alias.

## Agent Messages (LLM agents)

`/uos/agent-messages` stores and retrieves agent messages in Deno KV. It requires GitHub token auth with kernel
attestation.

Required headers:

- `Authorization: Bearer <github_token>`
- `X-Ubiquity-Kernel-Token: <jwt>`

Optional cross-check headers, compared with the attested repository only when both are sent:

- `X-GitHub-Owner: <owner>`
- `X-GitHub-Repo: <repo>`

If the kernel attestation includes `installation_id`, also send:

- `X-GitHub-Installation-Id: <id>`

### POST /uos/agent-messages

Body:

- `agent_id` (string, required, max 120 chars)
- `body` (string, required, max 8000 chars)
- `channel` (string, optional, max 120 chars)
- `kind` (string, optional, max 120 chars)
- `metadata` (object, optional, JSON-encoded size <= 8000 chars)

The server assigns `id`, `created_at_ms`, `owner`, `repo`, and `state_id` from the kernel attestation.

### GET /uos/agent-messages

Query parameters:

- `since` (ms, optional)
- `limit` (optional, default 50, max 200)
- `cursor` (optional)
- `channel` (optional)
- `agent_id` (optional)

Response includes:

- `messages`: list of agent messages
- `next_since`: ms timestamp of last message in the page
- `next_cursor`: cursor for pagination
- `has_more`: whether another page is available

## Auth introspection

`GET /uos/auth` returns the auth mode, the method used, and a token fingerprint (never the raw token). Use it to confirm
which auth path was selected.

If the auth method is a KV API key, the response includes key metadata and usage counters.

This is the best first check when an integration fails. It confirms whether the presented token resolved as a gateway
token, a KV API key, an admin token, a passkey session, or a GitHub/kernel token.

## Health

- `GET /health` is a public passive release-liveness check. It makes no upstream or KV calls.
- `GET /health/providers` returns passive, last-known Codex-slot and Metered health from Deno KV. It never sends an
  upstream or inference request and never exposes Codex account identifiers. It requires admin authentication.
- `GET /health/upstream` is an admin-only active probe of Codex models and the configured non-billable Metered quota
  endpoint. It never sends inference and never returns upstream bodies.

The authenticated `GET /admin/providers` view adds cached Metered wallet diagnostics to the passive provider state. The
admin Providers tab refreshes this cached view automatically. A stale state means ordinary traffic has not exercised
that provider recently; opening either view does not verify or spend a model request.

Use `/health/providers` for passive auth/provider state inspection. A stale or invalid Codex slot means server-side
Codex auth needs repair even if a client credential remains valid.

## Errors

Errors from `/v1/*` OpenAI-compatible endpoints follow an OpenAI-style envelope, including upstream Codex `detail`
responses normalized by the gateway:

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "code": "..."
  }
}
```

UOS, admin, or health/debug routes should still be parsed defensively by integrations that call them directly:

```ts
const message = body?.error?.message ?? body?.detail ?? response.statusText;
```

Common status codes:

- `401` invalid or missing auth
- `403` forbidden (e.g., GitHub token required for agent messages)
- `429` rate limit exceeded for KV API keys
- `5xx` upstream or server errors

### Rate-limit headers

Every `429` uses the JSON error envelope and includes `Retry-After` when the gateway has a retry delay. For an enforced
KV API-key request window, the gateway also returns the structured `RateLimit` field and `RateLimit-Policy` defined by
the active IETF HTTPAPI RateLimit Headers Internet-Draft (`draft-ietf-httpapi-ratelimit-headers-11`), plus
`RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` compatibility fields. The structured fields use
`RateLimit: "api-key";r=0;t=60` and `RateLimit-Policy: "api-key";q=100;w=3600`; `t` and `Retry-After` are seconds from
the response time.

Only fields backed by the gateway's own authoritative API-key window are emitted. An absent `RateLimit` field does not
mean unlimited upstream capacity, and clients must not invent a quota from provider-specific or Metered balance headers.
When a `429` includes `Retry-After`, wait at least that duration before retrying. Otherwise use bounded exponential
backoff, preserve idempotency where supported, and surface a persistent quota or authentication failure to the operator.

When a Codex account's server-side access or refresh token expires, the gateway adds
`x-uos-warning: codex_auth_reauthentication_required` and includes an actionable re-authentication message in the OpenAI
error body. A refresh rejection normally returns `503`; an upstream quota-shaped `403` may retain `403` when the access
token is expired. In either case, this warning identifies gateway Codex auth, not the client's remaining quota, as the
repair target. Upload a fresh `auth.json` through the admin flow and retry. The `refresh_token_reused` error code means
the configured refresh token was already consumed, so sign in again or upload fresh auth credentials.

Useful response headers for debugging:

- `x-deno-trace-id`
- `x-uos-warning`
- `x-uos-request-id`
- `x-uos-upstream`
- `x-uos-router-revision`
