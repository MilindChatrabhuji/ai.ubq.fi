import type { Kv } from "#kv";
/**
 * Admin surface for the Claude subscription tier, the counterpart of the Codex
 * auth upload: read the credential/workspace/quota state, store or rotate a
 * credential (optionally pinned to a workspace), clear a stored credential,
 * and drop exhaustion guards so the next request retries immediately. Every
 * response reports the credential only as its Console-style partial hint.
 */
import { json, openaiError } from "../http.ts";
import { getKv } from "../kv.ts";
import { readJsonBody } from "../request.ts";
import { isRecord } from "../utils.ts";
import {
  CLAUDE_CODE_CREDENTIAL_MAX_LENGTH,
  mergeClaudeCodeWorkspaceState,
  parseClaudeCodeWorkspaceId,
  partialClaudeCodeCredentialHint,
} from "../provider/claude-code-credentials.ts";
import { claudeCodeCredentialKind, type ClaudeCodeEnvLookup } from "../provider/claude-code.ts";
import {
  cacheValidatedClaudeCodeModels,
  ClaudeCodeModelsError,
  discoverClaudeCodeModels,
  type ClaudeCodeModelsSnapshot,
} from "../provider/claude-code-models.ts";
import { clearClaudeCodeQuotaGuards } from "../provider/claude-code-quota.ts";
import { getPassiveProviderHealthSnapshot } from "../health.ts";
import {
  resolveClaudeCodeAccount,
  updateClaudeCodeAccount,
  removeClaudeCodeAccount,
  selectClaudeCodeAccount,
  type ClaudeCodeAccountBinding,
} from "../provider/claude-code-accounts.ts";
import { loadClaudeCodeAccessPolicy, parseClaudeCodeAccessIds, storeClaudeCodeAccessPolicy } from "../provider/claude-code-access.ts";

const CREDENTIAL_LABEL_MAX_LENGTH = 64;

const getString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Validate one submitted credential against the models listing, the same
 * cheap endpoint the health probe uses. A 429 is treated as authenticated but
 * limited (exactly like the Codex upload), transport failures leave the
 * credential unvalidated rather than rejected, and only an explicit
 * authentication or permission rejection refuses the upload.
 */
const validateClaudeCodeCredential = async (
  secret: string,
  workspaceId: string | null
): Promise<Readonly<{ ok: boolean; status: number | null; detail: string | null; snapshot?: ClaudeCodeModelsSnapshot }>> => {
  try {
    const snapshot = await discoverClaudeCodeModels({ kind: claudeCodeCredentialKind(secret), secret }, workspaceId);
    return { ok: true, status: 200, detail: null, snapshot };
  } catch (error) {
    const status = error instanceof ClaudeCodeModelsError ? error.status : null;
    if (status === 429) return { ok: true, status, detail: null };
    if (status === 401 || status === 403) {
      return {
        ok: false,
        status,
        detail: status === 401 ? "The credential was rejected as unauthenticated." : "The credential is not permitted for this endpoint.",
      };
    }
    return { ok: true, status, detail: "Stored unvalidated: the models listing could not be read." };
  }
};

/** The exact `claude_code` block the passive provider snapshot reports. */
const claudeSubscriptionBlock = async (): Promise<Record<string, unknown> | null> => {
  const snapshot = await getPassiveProviderHealthSnapshot();
  const block = snapshot.claude_code;
  return block && typeof block === "object" ? (block as Record<string, unknown>) : null;
};

export const handleAdminClaudeCodeAuthGet = async (): Promise<Response> =>
  json(200, { data: await claudeSubscriptionBlock() }, { "Cache-Control": "no-store" });

type CredentialParse = Readonly<{ secret: string | null; label: string | null }> | Readonly<{ error: Response }>;
const parseCredentialSubmission = (body: Record<string, unknown>): CredentialParse => {
  const rawSecret = getString(body.credential) ?? getString(body.api_key);
  const secret = rawSecret === null ? null : rawSecret.trim();
  if (secret !== null && !secret) return { error: openaiError(400, "credential must not be blank", "invalid_request_error") };
  if (secret && secret.length > CLAUDE_CODE_CREDENTIAL_MAX_LENGTH) return { error: openaiError(400, "credential is too long", "invalid_request_error") };
  if (secret && !secret.startsWith("sk-ant-"))
    return { error: openaiError(400, "credential must be an Anthropic API key or Claude Code OAuth token", "invalid_request_error") };
  const rawLabel = getString(body.label);
  const label = rawLabel === null ? null : rawLabel.trim();
  if (label !== null && label.length > CREDENTIAL_LABEL_MAX_LENGTH) return { error: openaiError(400, "label is too long", "invalid_request_error") };
  return { secret, label };
};

type WorkspaceParse = Readonly<{ workspaceId: string | null | undefined }> | Readonly<{ error: Response }>;
const parseWorkspaceSubmission = (body: Record<string, unknown>): WorkspaceParse => {
  if (!Object.prototype.hasOwnProperty.call(body, "workspace_id")) return { workspaceId: undefined };
  const value = body.workspace_id;
  if (value === null || value === "") return { workspaceId: null };
  const workspaceId = parseClaudeCodeWorkspaceId(value);
  return workspaceId ? { workspaceId } : { error: openaiError(400, "workspace_id must be a wrkspc_ workspace id", "invalid_request_error") };
};

const submissionTarget = async (kv: Kv, body: Record<string, unknown>, env?: ClaudeCodeEnvLookup) => {
  if (body.account_id !== undefined && (typeof body.account_id !== "string" || !/^[a-f0-9-]{36}$/.test(body.account_id)))
    throw new Error("account_id is invalid");
  if (body.create_new !== undefined && typeof body.create_new !== "boolean") throw new Error("create_new must be boolean");
  if (body.activate !== undefined && typeof body.activate !== "boolean") throw new Error("activate must be boolean");
  if (body.create_new === true && body.account_id !== undefined) throw new Error("create_new cannot target an existing account");
  const target =
    body.create_new === true ? null : await resolveClaudeCodeAccount(kv, env, { accountId: typeof body.account_id === "string" ? body.account_id : undefined });
  if (body.account_id && !target) throw new Error("Claude account was not found");
  return target;
};
type ValidatedSubmission = Readonly<{
  body: Record<string, unknown>;
  target: ClaudeCodeAccountBinding | null;
  credential: Readonly<{ secret: string | null; label: string | null }>;
  secret: string;
  workspaceId: string | null;
  requestedWorkspace: string | null | undefined;
  validation: Awaited<ReturnType<typeof validateClaudeCodeCredential>>;
  env?: ClaudeCodeEnvLookup;
}>;
const submittedWorkspace = (input: ValidatedSubmission) => {
  if (!input.workspaceId) return null;
  return mergeClaudeCodeWorkspaceState(input.target?.workspace ?? null, {
    id: input.workspaceId,
    name: input.target?.workspace?.id === input.workspaceId ? input.target.workspace.name : null,
    source: input.requestedWorkspace === undefined ? (input.target?.workspace?.source ?? "kv") : "kv",
    verified: input.validation.status === 200,
  });
};
const persistSubmission = async (kv: Kv, input: ValidatedSubmission): Promise<ClaudeCodeAccountBinding | Response> => {
  const credential = input.credential.secret
    ? {
        secret: input.secret,
        label: input.credential.label,
        kind: claudeCodeCredentialKind(input.secret),
        hint: partialClaudeCodeCredentialHint(input.secret),
        source: "kv" as const,
        updated_at_ms: Date.now(),
      }
    : undefined;
  try {
    const account = await updateClaudeCodeAccount(
      kv,
      {
        accountId: input.target?.account_id,
        createNew: input.body.create_new === true,
        activate: input.body.activate === true,
        expected: input.target ?? undefined,
        credential,
        workspace: submittedWorkspace(input),
      },
      input.env
    );
    if (input.validation.snapshot) await cacheValidatedClaudeCodeModels(kv, input.secret, input.workspaceId, input.validation.snapshot, input.env, account);
    return account;
  } catch (error) {
    return openaiError(409, error instanceof Error ? error.message : "Claude account changed before persistence", "claude_code_account_changed");
  }
};
export const handleAdminClaudeCodeAuthSet = async (req: Request, options: Readonly<{ env?: ClaudeCodeEnvLookup }> = {}): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "KV is not available; cannot persist the Claude credential", "server_error");
  const body = await readJsonBody(req);
  if (!isRecord(body)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const credential = parseCredentialSubmission(body);
  if ("error" in credential) return credential.error;
  const workspace = parseWorkspaceSubmission(body);
  if ("error" in workspace) return workspace.error;
  if (credential.secret === null && workspace.workspaceId === undefined)
    return openaiError(400, "credential or workspace_id is required", "invalid_request_error");
  let target: ClaudeCodeAccountBinding | null;
  try {
    target = await submissionTarget(kv, body, options.env);
  } catch (error) {
    return openaiError(400, error instanceof Error ? error.message : "Invalid account target", "invalid_request_error");
  }
  const secret = credential.secret ?? target?.credential.secret;
  if (!secret) return openaiError(409, "No Claude credential is configured to validate this workspace against", "credential_missing");
  const workspaceId = workspace.workspaceId === undefined ? (target?.workspace?.id ?? null) : workspace.workspaceId;
  const validation = await validateClaudeCodeCredential(secret, workspaceId);
  if (!validation.ok) return openaiError(400, validation.detail ?? "The credential was rejected upstream.", "invalid_api_key");
  const account = await persistSubmission(kv, {
    body,
    target,
    credential,
    secret,
    workspaceId,
    requestedWorkspace: workspace.workspaceId,
    validation,
    env: options.env,
  });
  if (account instanceof Response) return account;
  return json(200, {
    data: await claudeSubscriptionBlock(),
    account_id: account.account_id,
    validation: { status: validation.status, detail: validation.detail },
    hint: credential.secret ? partialClaudeCodeCredentialHint(secret) : null,
  });
};

export const handleAdminClaudeCodeAuthDelete = async (req?: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "KV is not available; cannot remove the Claude account", "server_error");
  const accountId = req ? (new URL(req.url).searchParams.get("account_id") ?? undefined) : undefined;
  const account = await resolveClaudeCodeAccount(kv, undefined, { accountId });
  if (!account) return accountId ? openaiError(404, "Claude account was not found", "not_found") : json(200, { data: await claudeSubscriptionBlock() });
  await removeClaudeCodeAccount(kv, account.account_id);
  return json(200, { data: await claudeSubscriptionBlock() });
};

/** Clear only gateway guards for the targeted generation, never upstream quota or other accounts. */
export const handleAdminClaudeCodeQuotaClear = async (req?: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "KV is not available; cannot clear Claude guards", "server_error");
  const raw = req?.body ? await readJsonBody(req) : {};
  if (!isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  if (raw.account_id !== undefined && typeof raw.account_id !== "string") return openaiError(400, "account_id must be a string", "invalid_request_error");
  const account = await resolveClaudeCodeAccount(kv, undefined, { accountId: typeof raw.account_id === "string" ? raw.account_id : undefined });
  if (!account)
    return raw.account_id
      ? openaiError(404, "Claude account was not found", "not_found")
      : json(200, { data: await claudeSubscriptionBlock(), guards_cleared: false });
  if (raw.account_id && typeof raw.account_cohort_id !== "string")
    return openaiError(400, "account_cohort_id is required for a targeted clear", "invalid_request_error");
  if (raw.account_cohort_id !== undefined && raw.account_cohort_id !== account.account_cohort_id)
    return openaiError(409, "Claude account generation changed", "claude_code_account_changed");
  const cleared = await clearClaudeCodeQuotaGuards(kv, account);
  if (!cleared) return openaiError(409, "Claude guards changed during clear", "claude_code_account_changed");
  return json(200, { data: await claudeSubscriptionBlock(), guards_cleared: true });
};

export const handleAdminClaudeCodeAccess = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(503, "Claude principal policy storage is unavailable", "server_error");
  if (req.method === "GET") {
    const policy = await loadClaudeCodeAccessPolicy(kv);
    return json(200, { data: { source: policy.source, allowed_key_ids: policy.allowed_key_ids, updated_at_ms: policy.updated_at_ms } });
  }
  const body = await readJsonBody(req);
  const ids = isRecord(body) ? parseClaudeCodeAccessIds(body.allowed_key_ids) : null;
  if (!ids) return openaiError(400, "allowed_key_ids must be an explicit array of principal IDs", "invalid_request_error");
  const policy = await storeClaudeCodeAccessPolicy(kv, ids);
  return json(200, { data: { source: policy.source, allowed_key_ids: policy.allowed_key_ids, updated_at_ms: policy.updated_at_ms } });
};
export const handleAdminClaudeCodeAccountActive = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(503, "Claude account storage is unavailable", "server_error");
  const body = await readJsonBody(req);
  if (!isRecord(body) || typeof body.account_id !== "string") return openaiError(400, "account_id is required", "invalid_request_error");
  if (!(await selectClaudeCodeAccount(kv, body.account_id))) return openaiError(404, "Claude account was not found", "not_found");
  return json(200, { data: await claudeSubscriptionBlock() });
};
