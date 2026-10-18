import { stat } from "node:fs/promises";
import { command } from "./io.ts";

// Release identity and Caddy ingress steps shared by the deploy CLI, the cutover host and the VPS
// release driver. Sentinel's Deno bridge evaluates the driver graph, so this module stays apart
// from the deploy CLI and its Bun-only store checks.

/**
 * The public route `AGENTS.md` makes part of the deployment acceptance. The
 * loopback listener can report the new release while Caddy still proxies the
 * previous upstream, so the deploy proves this route too before it reports
 * success.
 */
export const PUBLIC_HEALTH_URL = "https://ai.ubq.fi/health";

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
 * The repository `ops/` directory is bind-mounted read-only into Caddy, which
 * runs as the unprivileged `caddy` user. If the proxy configuration is
 * unreadable to that user, Caddy's own `ExecStartPre` validation fails and a
 * reload silently keeps the previous configuration serving while the gateway
 * has already moved. Prove the composed proxy config is valid as Caddy before
 * publishing the candidate, without changing the live ingress. Apply it only
 * after the restarted candidate passes loopback readiness. Fail closed otherwise; never
 * repair the checkout mode, which would hide the real permission fault.
 */
export async function ensureCaddyIngressReady(run: (program: string, args: string[]) => Promise<string>, root: string): Promise<void> {
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
