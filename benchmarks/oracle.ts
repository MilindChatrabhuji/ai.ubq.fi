/**
 * Deterministic task oracles and verification.
 *
 * Success is decided only by: (1) the declared verification command exit
 * status, (2) declared file/git oracle checks, and (3) required-call minima.
 * Model text and adapter prose are never consulted. All checks are pure
 * functions of the workspace state after the adapter finishes.
 */

import { FixtureWorkspace } from "./fixture.ts";
import { type FileCheck, type GitCheck, type OracleCheckOutcome, type OracleOutcome, type TaskManifest, type VerificationOutcome } from "./schemas.ts";

export const VERIFY_OUTPUT_LIMIT = 4000;

function truncate(s: string, limit = VERIFY_OUTPUT_LIMIT): string {
  return s.length > limit ? `${s.slice(0, limit)}…[truncated ${s.length} bytes]` : s;
}

/** Run the task's declared verification command inside the workspace. */
export async function runVerification(task: TaskManifest, workspace: FixtureWorkspace): Promise<VerificationOutcome> {
  if (!task.verify) {
    return { ran: false, passed: true, command: null, exit_code: null, timed_out: false, output: null };
  }
  let res: Awaited<ReturnType<FixtureWorkspace["execShell"]>>;
  try {
    res = await workspace.execShell(task.verify.command, task.verify.timeout_ms ?? 20_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ran: true,
      passed: false,
      command: task.verify.command,
      exit_code: null,
      timed_out: false,
      output: truncate(`verification failed: ${message}`),
    };
  }
  const output = [res.stdout, res.stderr].filter((s) => s.trim() !== "").join("\n");
  return {
    ran: true,
    passed: !res.timedOut && res.code === 0,
    command: task.verify.command,
    exit_code: res.timedOut ? null : res.code,
    timed_out: res.timedOut,
    output: truncate(output),
  };
}

function checkFile(check: FileCheck, workspace: FixtureWorkspace): OracleCheckOutcome {
  const valueSuffix = check.value === undefined ? "" : ` ${JSON.stringify(check.value)}`;
  const detail = `${check.path}: ${check.kind}${valueSuffix}`;
  let positive: boolean;
  let unreadable = "";
  try {
    const content = workspace.read(check.path);
    switch (check.kind) {
      case "exists":
        positive = true;
        break;
      case "equals":
        positive = content === check.value;
        break;
      case "contains":
        positive = content.includes(check.value ?? "");
        break;
      case "regex":
        positive = new RegExp(check.value ?? "").test(content);
        break;
      default:
        // Unknown check kinds cannot be confirmed, so the check fails closed.
        positive = false;
        break;
    }
  } catch (err) {
    // Missing or unreadable files pass the invert of a positive check.
    positive = false;
    unreadable = ` (unreadable: ${(err as Error).message})`;
  }
  const passed = check.invert ? !positive : positive;
  return { kind: "file", detail: `${detail}${unreadable}`, passed };
}

async function gitCheck(check: GitCheck, workspace: FixtureWorkspace): Promise<OracleCheckOutcome> {
  const git = workspace.task.git;
  const valueSuffix = check.value === undefined ? "" : ` ${JSON.stringify(check.value)}`;
  const detail = `git: ${check.kind}${valueSuffix}`;
  if (!git?.init) {
    return { kind: "git", detail: `${detail} (task has no git repository)`, passed: false };
  }
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> => {
    return await workspace.exec(["git", "-c", "user.email=benchmark@invalid.invalid", "-c", "user.name=benchmark", ...args], {
      timeoutMs: 10_000,
      capture: true,
    });
  };
  switch (check.kind) {
    case "commit_count": {
      const res = await run(["rev-list", "--count", "HEAD"]);
      const count = parseInt(res.stdout.trim(), 10);
      const min = parseInt(check.value ?? "0", 10);
      return { kind: "git", detail, passed: !res.timedOut && res.code === 0 && count >= min };
    }
    case "head_message": {
      const res = await run(["log", "-1", "--format=%s"]);
      return {
        kind: "git",
        detail,
        passed: !res.timedOut && res.code === 0 && res.stdout.trim().includes(check.value ?? ""),
      };
    }
    case "worktree_clean": {
      const res = await run(["status", "--porcelain"]);
      return { kind: "git", detail, passed: !res.timedOut && res.code === 0 && res.stdout.trim() === "" };
    }
    case "file_committed": {
      const path = check.value ?? "";
      const tracked = await run(["ls-files", "--error-unmatch", "--", path]);
      const dirty = await run(["status", "--porcelain", "--", path]);
      return {
        kind: "git",
        detail,
        passed: tracked.code === 0 && dirty.code === 0 && dirty.stdout.trim() === "",
      };
    }
    default:
      // Unknown check kinds cannot be evaluated, so the check fails closed.
      return { kind: "git", detail: `${detail} (unsupported check kind)`, passed: false };
  }
}

/** Evaluate all declared oracle checks against the final workspace state. */
export async function evaluateOracle(task: TaskManifest, workspace: FixtureWorkspace): Promise<OracleOutcome> {
  const checks: OracleCheckOutcome[] = [];
  const oracle = task.oracle ?? {};
  for (const check of oracle.file_checks ?? []) checks.push(checkFile(check, workspace));
  for (const check of oracle.git_checks ?? []) checks.push(await gitCheck(check, workspace));
  return { passed: checks.every((c) => c.passed), checks };
}
