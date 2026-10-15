# Claude subscription activation state - 2026-10-15

## What is live

The `claude_code` subscription tier ships with Codex-parity backend and UI (PR #1034, #1035, #1037 on `development`;
deployed on the VPS through release `c5b22838`).

- Credential: `CLAUDE_API_KEY` (Console API key, `x-api-key`) or the legacy `CLAUDE_CODE_OAUTH_TOKEN` (Bearer + OAuth
  beta), resolved KV-first so `GET/POST/DELETE /admin/providers/claude-code/auth` rotate it without a restart.
- Workspace: `CLAUDE_CODE_WORKSPACE_ID` pins `anthropic-workspace-id`; otherwise the first "not scoped to a workspace"
  rejection discovers one through `/v1/organizations/workspaces` and caches it in KV.
- Routing: attempt first for Claude models, classification of durable exhaustion / transient limits / billing /
  workspace rejections, bounded configuration cooldown, and fall-through to the paid waterfall on every rejection.
- Surfaces: Providers-view `Claude subscription` card, Kernel `Upstream (Claude)` tile, Analytics capacity row, provider
  roster entry, `/admin/providers`, `/health/providers`, and the `/health/upstream` models probe.

## Deployment configuration on the VPS (`/home/codex/repos/ubiquity/ai.ubq.fi/.env`)

| Variable                      | Value                                                             |
| ----------------------------- | ----------------------------------------------------------------- |
| `CLAUDE_API_KEY`              | the owner's Console key (`sk-ant-usr-1A6…BwAA`)                   |
| `CLAUDE_CODE_WORKSPACE_ID`    | `wrkspc_01ErorW3iFLRvQy55cpNWtEt` (the org's `Default` workspace) |
| `CLAUDE_CODE_ALLOWED_KEY_IDS` | `1df7b670-78bb-487d-b3b1-56f32eaa8dc6` (`m1 shell`)               |

A timestamped `.env` backup exists next to it (`m1` org key -> `m1 workspace` swap on 2026-10-15 15:48Z). The same
variables live in the local Mac token file (`~/.config/deno-deploy/tokens/ubiquity-dao.env`, symlinked as the
repository-root `.env`) with its own backup. The workspace pin is optional for a workspace-scoped key; it is kept so the
admin surfaces show which workspace the tier names.

## Admin-key (org-scoped) probe results - 2026-10-15 15:42-15:49Z

Both keys were tested directly against the API, bypassing the gateway:

- Workspace key (`sk-ant-usr-1Gm…`): `x-api-key` or `Bearer`, with and without a workspace header, with and without the
  OAuth beta, models opus/sonnet/haiku 5.5 and 4.5, and `count_tokens` all answer `400 billing_blocked`.
- The `Claude Code` workspace (`wrkspc_01FBEp5…`) answers `404 Workspace … not found` for API keys.
- Org/admin key (`sk-ant-usr-1A6…`): identical results on every variant.
- The org key reads the Admin API: `me`, `workspaces`, `workspaces/{id}/members`, `api_keys`, `invites`,
  `usage_report/messages`, and `cost_report`. No credit or billing route exists: the credits, credit-grants, billing,
  claims, and budgets collections all answer 404, and `/v1/billing`, `/v1/subscription`, and `/v1/me/billing` pass the
  workspace-auth gate and then answer 404.
- Spend limits are the only billing-shaped admin route. Reads need `anthropic-beta: spend-limit-reads-2026-09-26` and
  then answer `organization_type_not_supported`. Writes accept
  `{scope:{type:"organization"|"workspace",…},amount:"<whole-number decimal string>"}` and answer
  `403 spend_limits_admin_api_writes_not_enabled`.
- API keys cannot be created, updated, or re-scoped through the Admin API: the collection rejects POST and the item
  rejects PATCH and PUT with 405.
- OAuth: the token endpoint supports `authorization_code`, `refresh_token`, and `client_credentials`. The only known
  client (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`) rejects `client_secret_post`, the local CLI refresh token is unknown
  to the endpoint (`invalid_grant`), the platform host answers a blanket 429, and no `oauth/authorize` route exists.
  `claude -p` answers `Invalid API key · Please run /login` because that credential expired 2025-09-10.

Conclusion: in this environment the account's API credits are the only remaining gate; no admin-key action can add them.

## Why inference does not serve yet (account condition, not a gateway defect)

The tier reaches the account and the API answers with the Console billing rejection:

```json
{
  "kind": "billing_blocked",
  "status": 400,
  "message": "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
}
```

Verified on 2026-10-15 from both the Mac and the VPS:

- `POST /v1/messages` with the org-scoped key plus the `Default` workspace → 400 `credit balance is too low`.
- `POST /v1/messages` with the `Claude Code` workspace (`wrkspc_01FBEp5VyCHs7ghEnJqk6giF`) answers `404`; that workspace
  is not inferable by an org-scoped Console key.
- No claim/credit API exists for the Max monthly credits:
  `/v1/organizations/{credits,credit_grants,subscription,billing}` and eight further variants return 404; the claim is a
  Console (Plans & Billing) action.

## Activation steps for the owner

1. Claim or purchase API credits for the `Ubiquity` Console organization (Max includes monthly API credits that must be
   claimed into the org), or create a workspace-scoped key for a workspace the API accepts and store it with
   `POST /admin/providers/claude-code/auth` plus its `workspace_id`.
2. Add any additional principal key ids to `CLAUDE_CODE_ALLOWED_KEY_IDS` (comma/space separated) and restart, or leave
   the stored credential to rotate at runtime.
3. Clear the recorded guard from the admin panel (`Clear guards`) or wait out the ten-minute configuration cooldown,
   then send one Claude-model request; the Analytics row's 5-hour and weekly windows fill in from the first real
   response.
