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
  clearClaudeCodeStoredCredential,
  clearClaudeCodeWorkspaceState,
  loadClaudeCodeWorkspaceState,
  mergeClaudeCodeWorkspaceState,
  parseClaudeCodeWorkspaceId,
  resolveClaudeCodeCredential,
  partialClaudeCodeCredentialHint,
  resolveClaudeCodeWorkspace,
  storeClaudeCodeStoredCredential,
  storeClaudeCodeWorkspaceState,
} from "../provider/claude-code-credentials.ts";
import { CLAUDE_CODE_MODELS_URL, claudeCodeCredentialKind, claudeCodeRequestHeaders } from "../provider/claude-code.ts";
import { clearClaudeCodeQuotaGuards } from "../provider/claude-code-quota.ts";
import { getPassiveProviderHealthSnapshot } from "../health.ts";

const CREDENTIAL_LABEL_MAX_LENGTH = 64;
const CREDENTIAL_VALIDATION_TIMEOUT_MS = 8_000;

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
): Promise<Readonly<{ ok: boolean; status: number | null; detail: string | null }>> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Claude credential validation timed out.", "TimeoutError")),
    CREDENTIAL_VALIDATION_TIMEOUT_MS
  );
  try {
    const response = await fetch(CLAUDE_CODE_MODELS_URL, {
      method: "GET",
      headers: claudeCodeRequestHeaders({ kind: claudeCodeCredentialKind(secret), secret }, { stream: false, workspaceId }),
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { ok: true, status: response.status, detail: null };
    if (response.status === 429) return { ok: true, status: response.status, detail: null };
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        detail: response.status === 401 ? "The credential was rejected as unauthenticated." : "The credential is not permitted for this endpoint.",
      };
    }
    return { ok: true, status: response.status, detail: "Stored unvalidated: the models listing returned an error status." };
  } catch {
    return { ok: true, status: null, detail: "Stored unvalidated: the models listing could not be reached." };
  } finally {
    clearTimeout(timer);
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

export const handleAdminClaudeCodeAuthSet = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available; cannot persist the Claude credential", "server_error");

  const body = await readJsonBody(req);
  if (!body || !isRecord(body)) return openaiError(400, "Invalid JSON body", "invalid_request_error");

  const rawSecret = getString(body.credential) ?? getString(body.api_key);
  const secret = rawSecret === null ? null : rawSecret.trim();
  if (secret !== null && !secret) return openaiError(400, "credential must not be blank", "invalid_request_error");
  if (secret && secret.length > CLAUDE_CODE_CREDENTIAL_MAX_LENGTH) return openaiError(400, "credential is too long", "invalid_request_error");
  if (secret && !secret.startsWith("sk-ant-"))
    return openaiError(400, "credential must be an Anthropic API key or Claude Code OAuth token", "invalid_request_error");

  const rawLabel = getString(body.label);
  const label = rawLabel === null ? null : rawLabel.trim();
  if (label !== null && label.length > CREDENTIAL_LABEL_MAX_LENGTH) return openaiError(400, "label is too long", "invalid_request_error");

  // A workspace pin is optional: an organization-scoped key needs one, and a
  // workspace-scoped key or OAuth token works without it. A submission with no
  // credential field only changes the workspace selection.
  const workspaceField = Object.prototype.hasOwnProperty.call(body, "workspace_id") ? body.workspace_id : undefined;
  let workspaceId: string | null | undefined;
  if (workspaceField === undefined) {
    workspaceId = undefined;
  } else if (workspaceField === null || workspaceField === "") {
    workspaceId = null;
  } else {
    const parsedWorkspaceId = parseClaudeCodeWorkspaceId(workspaceField);
    if (!parsedWorkspaceId) return openaiError(400, "workspace_id must be a wrkspc_ workspace id", "invalid_request_error");
    workspaceId = parsedWorkspaceId;
  }

  if (secret === null && workspaceId === undefined) {
    return openaiError(400, "credential or workspace_id is required", "invalid_request_error");
  }

  // A workspace-only update validates against the credential that is already
  // configured; a credential submission validates the submitted secret.
  let credentialForValidation: string;
  if (secret !== null) {
    credentialForValidation = secret;
  } else {
    const current = await resolveClaudeCodeCredential(kv);
    if (!current) return openaiError(409, "No Claude credential is configured to validate this workspace against", "credential_missing");
    credentialForValidation = current.secret;
  }
  const effectiveWorkspace =
    workspaceId === undefined ? await resolveClaudeCodeWorkspace(kv) : workspaceId ? { id: workspaceId, name: null, source: "kv" as const } : null;
  const validation = await validateClaudeCodeCredential(credentialForValidation, effectiveWorkspace?.id ?? null);
  if (!validation.ok) {
    return openaiError(400, validation.detail ?? "The credential was rejected upstream.", "invalid_api_key");
  }

  if (secret !== null) {
    const stored = await storeClaudeCodeStoredCredential(kv, { secret, label });
    if (!stored) return openaiError(500, "The credential could not be stored", "server_error");
  }

  if (workspaceId !== undefined) {
    if (workspaceId) {
      const previous = await loadClaudeCodeWorkspaceState(kv).catch(() => null);
      await storeClaudeCodeWorkspaceState(kv, mergeClaudeCodeWorkspaceState(previous, { id: workspaceId, source: "kv", verified: validation.ok }));
    } else {
      await clearClaudeCodeWorkspaceState(kv);
    }
  } else if (effectiveWorkspace && validation.ok) {
    const previous = await loadClaudeCodeWorkspaceState(kv).catch(() => null);
    await storeClaudeCodeWorkspaceState(
      kv,
      mergeClaudeCodeWorkspaceState(previous, { id: effectiveWorkspace.id, name: effectiveWorkspace.name, source: effectiveWorkspace.source, verified: true })
    );
  }

  return json(200, {
    data: await claudeSubscriptionBlock(),
    validation: { status: validation.status, detail: validation.detail },
    // Mirror the hint only; the stored secret is never echoed back.
    hint: secret === null ? null : partialClaudeCodeCredentialHint(secret),
  });
};

export const handleAdminClaudeCodeAuthDelete = async (): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available; cannot clear the Claude credential", "server_error");
  await clearClaudeCodeStoredCredential(kv);
  return json(200, { data: await claudeSubscriptionBlock() });
};

/**
 * Drop the stored exhaustion guards (block, cooldown, last configuration error)
 * so the next eligible request retries the tier immediately.
 */
export const handleAdminClaudeCodeQuotaClear = async (): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available; cannot clear the Claude quota guards", "server_error");
  const cleared = await clearClaudeCodeQuotaGuards(kv);
  return json(200, { data: await claudeSubscriptionBlock(), guards_cleared: cleared !== null });
};
