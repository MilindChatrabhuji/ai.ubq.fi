import { acquireDeployLock } from "./deploy-lock.ts";
import { assertBunConvertedStore } from "./assert-bun-store.ts";
import { prepareBunRuntime } from "./bun-runtime.ts";
import { command as runCommand } from "./io.ts";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { missing } from "./io.ts";
const readTextFile = (path: string): Promise<string> => readFile(path, "utf8");
// Run from the VPS repository root after the candidate's required CI has passed.
import { pruneReleases } from "./release-retention.ts";
import { ImmutableVpsReleaseStore, type VpsPayloadPreparation } from "./vps-release-store.ts";
import { readVpsPins } from "./vps-release-journal.ts";
const canonicalRoot = "/home/codex/repos/ubiquity/ai.ubq.fi";

/**
 * The public route `AGENTS.md` makes part of the deployment acceptance. The
 * loopback listener can report the new release while Caddy still proxies the
 * previous upstream, so the deploy proves this route too before it reports
 * success.
 */
export const PUBLIC_HEALTH_URL = "https://ai.ubq.fi/health";

const command = runCommand;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The release-identity contract shared by the loopback listener and the public
 * route: HTTP 200, the full Git revision and its `vps-<revision>` deployment id
 * in the body, and the same two values in the identity headers.
 */
export function healthServesRelease(response: Response, health: unknown, sha: string): boolean {
  const release = isRecord(health) && isRecord(health.release) ? health.release : undefined;
  const deploymentId = `vps-${sha}`;
  return (
    response.status === 200 &&
    release?.git_sha === sha &&
    release.deployment_id === deploymentId &&
    response.headers.get("x-uos-git-sha") === sha &&
    response.headers.get("x-uos-deployment-id") === deploymentId
  );
}

/**
 * Apply the configuration `ensureCaddyIngressReady` validated. Caddy keeps
 * serving its previously loaded configuration when a reload fails, which is
 * exactly the state a port cutover must not leave behind: the loopback health
 * check passes while the public route keeps answering 502 from the old upstream.
 * The runner is a parameter so the exact command contract stays testable.
 */
export async function reloadCaddyIngress(run: (program: string, args: string[]) => Promise<string> = command): Promise<void> {
  await run("sudo", ["-n", "systemctl", "reload", "caddy"]);
  console.log(JSON.stringify({ caddy_ingress: "reloaded", service: "caddy" }));
}

/**
 * Prove the public route serves the candidate release before the deploy reports
 * success or prunes anything. It is the same identity contract as the loopback
 * listener, read through the reloaded proxy and Cloudflare, so a Caddy that kept
 * the previous upstream fails here.
 */
export async function assertPublicRelease(sha: string, url: string = PUBLIC_HEALTH_URL): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const health = await response.json().catch(() => undefined);
  if (!healthServesRelease(response, health, sha)) {
    throw new Error(`The public route ${url} did not serve release ${sha} (HTTP ${response.status})`);
  }
  console.log(JSON.stringify({ public_health_verified: true, public_health_url: url, git_sha: sha, deployment_id: `vps-${sha}` }));
}

/**
 * Read-only preflight for the checkout that would be released: tracked-clean,
 * branch, full revision, and equality with the `origin/development`
 * remote-tracking ref. It runs once before `.data` is touched and again after
 * the exclusive deployment lock is acquired, because a queued deployment can
 * wait while the checkout changes underneath it. The returned SHA is the
 * candidate identity and is only trusted from the post-lock call.
 */
async function assertDeployableCheckout(): Promise<string> {
  if (await command("git", ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("Commit or preserve tracked changes before deployment");
  }
  const branch = await command("git", ["branch", "--show-current"]);
  if (branch !== "development") throw new Error("Production deployment is allowed only from the development branch");
  const sha = await command("git", ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("A full Git revision is required");
  // Resolve the remote-tracking ref by its full name: a local branch named
  // `origin/development` would otherwise shadow it, and a missing ref must fail
  // closed instead of comparing HEAD against some other revision.
  const remoteDevelopmentSha = await command("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/development"]).catch((error: unknown) => {
    throw new Error("The origin/development tracking ref is missing; run `git fetch origin development` before deployment", { cause: error });
  });
  if (remoteDevelopmentSha !== sha) throw new Error("Checkout must exactly match origin/development before deployment");
  return sha;
}

/**
 * The repository `ops/` directory is bind-mounted read-only into Caddy, which
 * runs as the unprivileged `caddy` user. If the proxy configuration is
 * unreadable to that user, Caddy's own `ExecStartPre` validation fails and a
 * reload silently keeps the previous configuration serving while the gateway
 * has already moved. Prove the composed proxy config is valid as Caddy before
 * publishing the candidate, without changing the live ingress. Apply it only
 * after the restarted candidate passes loopback readiness. Fail closed otherwise; never
 * repair the checkout mode, which would hide the real permission fault.
 */
export async function ensureCaddyIngressReady(run: (program: string, args: string[]) => Promise<string> = command, root = canonicalRoot): Promise<void> {
  const mode = (await stat(`${root}/ops/Caddyfile`)).mode;
  // Caddy shares no group with this checkout, so only other-read exposes the
  // bind-mounted file to it.
  if ((mode & 0o004) === 0) {
    throw new Error("ops/Caddyfile is not readable by the caddy user; run `chmod 644 ops/Caddyfile` and redeploy");
  }
  // Validate inside Caddy's own unit namespace so the bind mount and the
  // unprivileged user are both exercised, exactly as the service start is.
  const mainPid = await run("sudo", ["-n", "systemctl", "show", "caddy", "-p", "MainPID", "--value"]);
  if (!/^\d+$/.test(mainPid) || mainPid === "0") throw new Error("Caddy is not running; start it before deploying");
  await run("sudo", [
    "-n",
    "nsenter",
    "-t",
    mainPid,
    "-m",
    "--",
    "sudo",
    "-u",
    "caddy",
    "caddy",
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile",
  ]);
  console.log(JSON.stringify({ ingress_preflight: "caddy_config_valid", caddy_pid: mainPid }));
}

const recoveryPath = ".data/deploy-recovery.json";
const launcherFingerprint = "50435a214d34cb7fbae3735a0a0502f8d96aaa3257dc502edc01bd64a8429ca7";
type Release = { sha: string; path: string; archive: string; tree: string };
type Previous = Release & { selector: string; port: number; profile: string };
type Phase = "prepared" | "selected" | "candidate_ready" | "ingress_applied" | "rolled_back";
/**
 * `restart_issued` is saved before this deployment first asks systemd to restart the gateway for the
 * candidate. A receipt written before the field existed leaves it undefined, which counts as issued.
 */
type Recovery = { schema: 1; candidate: Release; previous: Previous | null; phase: Phase; restart_issued?: boolean };
const notFound = (error: unknown): boolean => missing(error);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (notFound(error)) return false;
    throw error;
  }
}

// Compare every entry without following symlinks. Generated files have explicit
// modes, so verification does not depend on a later deployment's umask.
const releaseStore = new ImmutableVpsReleaseStore(canonicalRoot, (program, args) => command(program, args));
const selector = (): Promise<string | null> => releaseStore.selector();
const checkedPrevious = (selected: string): Promise<Previous> => releaseStore.checkedPrevious(selected);
const checkedPreviousRelease = (sha: string, selected: string): Promise<Previous> => releaseStore.checkedPreviousRelease(sha, selected);

async function readRecovery(): Promise<Recovery | null> {
  if (!(await exists(recoveryPath))) return null;
  const stat = await lstat(recoveryPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("Deployment recovery receipt is unsafe");
  const value: unknown = JSON.parse(await readTextFile(recoveryPath));
  const validRelease = (item: unknown): boolean =>
    isRecord(item) &&
    typeof item.sha === "string" &&
    /^[0-9a-f]{40}$/.test(item.sha) &&
    item.path === `.data/releases/${item.sha}` &&
    typeof item.archive === "string" &&
    /^[0-9a-f]{64}$/.test(item.archive) &&
    typeof item.tree === "string" &&
    /^[0-9a-f]{64}$/.test(item.tree);
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    !validRelease(value.candidate) ||
    !["prepared", "selected", "candidate_ready", "ingress_applied", "rolled_back"].includes(String(value.phase)) ||
    !(value.restart_issued === undefined || typeof value.restart_issued === "boolean") ||
    !(
      value.previous === null ||
      (validRelease(value.previous) &&
        isRecord(value.previous) &&
        typeof value.previous.selector === "string" &&
        Number.isInteger(value.previous.port) &&
        (value.previous.profile === launcherFingerprint || value.previous.profile === (await releaseStore.currentLauncherProfile())))
    )
  )
    throw new Error("Malformed deployment recovery receipt");
  return value as Recovery;
}

async function saveRecovery(receipt: Recovery): Promise<void> {
  const temporary = `${recoveryPath}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, recoveryPath);
  } finally {
    if (await exists(temporary)) await rm(temporary);
  }
}

const selectRelease = (target: string | null): Promise<void> => releaseStore.selectRelease(target);

async function ready(sha: string, port: number, attempts = 30): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (healthServesRelease(response, await response.json(), sha)) return true;
    } catch {
      /* The listener may still be starting. */
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function previousPublicIdentity(previous: Previous): Promise<void> {
  const response = await fetch(PUBLIC_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
  if (!healthServesRelease(response, await response.json().catch(() => undefined), previous.sha))
    throw new Error("The previous public release identity could not be proven");
}

type ActivationState = { restartAttempted: boolean; ingressApplied: boolean };

async function verifyPreviousRecovery(previous: Previous): Promise<void> {
  const checked = await checkedPreviousRelease(previous.sha, previous.selector);
  if (JSON.stringify(checked) !== JSON.stringify(previous)) throw new Error("Previous immutable recovery profile changed");
}

/**
 * A first-deployment candidate that no deployment ever restarted, with no selector, is the state a
 * restoration leaves when it stops after clearing the selector and before recording `rolled_back`,
 * or a run leaves when it stops after recording `prepared` and before selecting. There is no earlier
 * release to protect and the candidate is verified again before it is selected, so a same-SHA retry
 * may select and start it. Once a restart was issued, a missing selector stays unexplained.
 */
const unstartedFirstCandidate = (selected: string | null, receipt: Recovery): boolean =>
  receipt.previous === null && selected === null && receipt.restart_issued === false && (receipt.phase === "prepared" || receipt.phase === "selected");

async function assertUnselectedRecovery(selected: string | null, receipt: Recovery, fresh: boolean): Promise<void> {
  if (unstartedFirstCandidate(selected, receipt)) return;
  if (!fresh && receipt.phase !== "rolled_back") throw new Error("Unselected recovery candidate has no proven rollback disposition");
  if (!["prepared", "rolled_back"].includes(receipt.phase) || selected !== (receipt.previous?.selector ?? null))
    throw new Error("Deployment recovery selector or phase mismatch");
  if (receipt.previous !== null) {
    if (selected === null) throw new Error("Missing previous recovery selector");
    await verifyPreviousRecovery(receipt.previous);
    await previousPublicIdentity(receipt.previous);
  }
}

/**
 * Returns whether the selected candidate already serves its exact identity, so a
 * retry resumes at ingress without another restart. A first deployment has no
 * earlier listener or public identity to protect, and its unit can only start
 * this verified selected candidate, so an unready one is restarted rather than
 * refused. With a previous release, an unready candidate stays ambiguous.
 */
async function selectedRecoveryServes(candidate: Release, receipt: Recovery): Promise<boolean> {
  if (receipt.phase !== "rolled_back") {
    if (await ready(candidate.sha, 7999, 1)) {
      if (receipt.previous !== null) await verifyPreviousRecovery(receipt.previous);
      return true;
    }
    if (receipt.previous === null) return false;
  }
  throw new Error("Selected recovery candidate identity is ambiguous; refusing destructive recovery");
}

/**
 * Selects and restarts the candidate. A first-deployment retry can restart a selected candidate whose
 * Caddy configuration an earlier run already applied; its receipt keeps `ingress_applied`, so the
 * phase never stops recording the applied ingress.
 */
async function startCandidate(candidate: Release, receipt: Recovery, state: ActivationState): Promise<void> {
  const ingressApplied = receipt.phase === "ingress_applied";
  const record = async (phase: Phase): Promise<void> => {
    if (!ingressApplied) receipt.phase = phase;
    await saveRecovery(receipt);
  };
  await record("prepared");
  await selectRelease("releases/" + candidate.sha);
  await record("selected");
  await command("sudo", ["-n", "systemctl", "daemon-reload"]);
  console.log(JSON.stringify({ systemd_daemon_reload: "before-restart", service: "ai-ubq-fi.service" }));
  receipt.restart_issued = true;
  await saveRecovery(receipt);
  state.restartAttempted = true;
  await command("sudo", ["-n", "systemctl", "restart", "ai-ubq-fi.service"]);
  if (!(await ready(candidate.sha, 7999))) throw new Error("The VPS did not serve the expected release; inspect journalctl -u ai-ubq-fi.service");
  await record("candidate_ready");
}

/**
 * A first deployment has no earlier release to restore. Before this deployment
 * restarts the gateway, clearing the candidate's selector restores the original
 * selector state; a candidate systemd started meanwhile (see `activate`) keeps
 * running, and a same-SHA retry selects and restarts it. After a restart attempt
 * the unit can only run this candidate: clearing the selector would not stop it
 * and would only break the unit's next start, so the candidate stays selected,
 * unaccepted and resumable by the same SHA.
 */
async function restoreFirstDeployment(receipt: Recovery, restartAttempted: boolean): Promise<void> {
  if (restartAttempted) {
    console.error("[deploy] First deployment has no previous release; the unaccepted candidate stays selected for a same-SHA retry");
    return;
  }
  if ((await selector()) !== null) await selectRelease(null);
  receipt.phase = "rolled_back";
  await saveRecovery(receipt);
}

async function restorePrevious(receipt: Recovery, restartAttempted: boolean): Promise<void> {
  const previous = receipt.previous;
  if (previous === null) return restoreFirstDeployment(receipt, restartAttempted);
  if (restartAttempted && previous.profile === launcherFingerprint)
    throw new Error("Cross-codec rollback requires stopped latest-state Bun-to-Deno conversion; refusing stale legacy state");
  await selectRelease(previous.selector);
  // A refused daemon-reload leaves the prior listener running. Do not restart
  // either release through a definition systemd refused to load.
  if (restartAttempted) {
    await command("sudo", ["-n", "systemctl", "restart", "ai-ubq-fi.service"]);
    if (!(await ready(previous.sha, previous.port))) throw new Error("Previous listener restoration failed");
    await previousPublicIdentity(previous);
  }
  receipt.phase = "rolled_back";
  await saveRecovery(receipt);
}

async function verifySelectedOnly(candidate: Release, selected: boolean): Promise<void> {
  if (!selected) throw new Error("Existing unselected release has no deployment-owned recovery receipt");
  if (!(await ready(candidate.sha, 7999, 1))) throw new Error("Selected immutable release is not ready; refusing a guessed restart or rollback");
  await reloadCaddyIngress();
  await assertPublicRelease(candidate.sha);
}

async function recoverFailedActivation(receipt: Recovery, restartAttempted: boolean): Promise<void> {
  try {
    await restorePrevious(receipt, restartAttempted);
  } catch (recoveryError) {
    console.error("[deploy] Recovery failed: " + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError)));
  }
}

async function activate(candidate: Release, selected: string | null, receipt: Recovery | null, fresh: boolean): Promise<void> {
  const candidateSelected = selected !== null && (await realpath(".data/current")) === canonicalRoot + "/" + candidate.path;
  if (receipt === null) {
    await verifySelectedOnly(candidate, candidateSelected);
    return;
  }
  if (JSON.stringify(receipt.candidate) !== JSON.stringify(candidate)) throw new Error("Stale or changed deployment recovery receipt");
  const candidateServes = candidateSelected && (await selectedRecoveryServes(candidate, receipt));
  if (!candidateSelected) await assertUnselectedRecovery(selected, receipt, fresh);
  // A candidate that is already selected may have been restarted by an earlier
  // run, so recovery must treat it as possibly running even when this run issues
  // no restart: clearing or swapping its selector alone cannot stop it. That holds
  // even when the receipt says no restart was issued: an enabled unit that cannot
  // start retries every RestartSec (ops/ai-ubq-fi.service) and resolves
  // `.data/current` on each attempt, so on a first deployment systemd itself can
  // start a candidate as soon as it is selected. `restart_issued` therefore never
  // clears a selected candidate's selector.
  const state = { restartAttempted: candidateSelected, ingressApplied: receipt.phase === "ingress_applied" };
  try {
    if (!candidateServes) await startCandidate(candidate, receipt, state);
    await reloadCaddyIngress();
    state.ingressApplied = true;
    receipt.phase = "ingress_applied";
    await saveRecovery(receipt);
    await assertPublicRelease(candidate.sha);
    await rm(recoveryPath);
  } catch (error) {
    if (!state.ingressApplied) await recoverFailedActivation(receipt, state.restartAttempted);
    throw error;
  }
}

async function assertDataDirectories(): Promise<void> {
  for (const directory of [".data", ".data/releases"]) {
    if (await exists(directory)) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== canonicalRoot + "/" + directory)
        throw new Error("Deployment data directory is unsafe");
    }
  }
}

async function prepareCandidate(sha: string, preparePayload?: VpsPayloadPreparation): Promise<void> {
  const release = ".data/releases/" + sha;
  const selected = await selector();
  let receipt = await readRecovery();
  const present = await exists(release);
  if (receipt !== null && receipt.candidate.sha !== sha) throw new Error("Stale deployment recovery receipt belongs to another candidate");
  if (present && receipt === null && (selected === null || (await realpath(".data/current")) !== canonicalRoot + "/" + release))
    throw new Error("Existing unselected release has no deployment-owned recovery receipt");
  let previous: Previous | null = null;
  if (!present) {
    if (receipt !== null) throw new Error("Recovery candidate is missing");
    if (selected !== null) {
      previous = await checkedPrevious(selected);
      await previousPublicIdentity(previous);
    }
  }
  const candidateStore = new ImmutableVpsReleaseStore(canonicalRoot, (program, args) => command(program, args), preparePayload);
  const candidate = await candidateStore.checkedRelease(sha, !present);
  if (!present) {
    receipt = { schema: 1, candidate, previous, phase: "prepared", restart_issued: false };
    await saveRecovery(receipt);
  }
  await activate(candidate, selected, receipt, !present);
}

export async function deploy(preparePayload?: VpsPayloadPreparation): Promise<void> {
  let releaseLock: (() => void) | undefined;
  try {
    // The canonical-root boundary stays before any Git subprocess: running Git in
    // an arbitrary checkout can execute configured helpers, so an unvalidated
    // directory is rejected first. The read-only checkout preflight then runs
    // before `.data` exists, and again under the deployment lock before the
    // candidate SHA is used.
    const root = await realpath(".");
    if (root !== canonicalRoot) throw new Error("Run from the canonical VPS repository root");
    await assertDeployableCheckout();
    await assertBunConvertedStore(root);
    await assertDataDirectories();
    await mkdir(".data/releases", { recursive: true, mode: 0o700 });
    releaseLock = await acquireDeployLock();
    // Capture the candidate only after the lock: a deployment that waited for it
    // must not release a revision from before the wait.
    const sha = await assertDeployableCheckout();
    await assertDataDirectories();
    if ((await readVpsPins(`${canonicalRoot}/.data/vps-release-pins.json`)).length > 0)
      throw new Error("A bound VPS release operation owns promotion; reconcile its receipt before another deploy");
    // Refuse ingress faults before publishing or selecting an immutable release,
    // so correcting the fault can retry this same revision.
    await ensureCaddyIngressReady();
    const release = `.data/releases/${sha}`;
    await prepareBunRuntime(root);
    await prepareCandidate(sha, preparePayload);
    // Retention runs only after both health checks prove the release is live, so
    // a pruning fault cannot turn a verified deployment into a failed one.
    let releasesPruned: number | "failed" = "failed";
    try {
      releasesPruned = (await pruneReleases()).removed.length;
    } catch (error) {
      console.error(`[deploy] Release retention was not applied: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(JSON.stringify({ git_sha: sha, deployment_id: `vps-${sha}`, release, health_verified: true, releases_pruned: releasesPruned }));
    return;
  } finally {
    releaseLock?.();
  }
}

if (import.meta.main) await deploy();
