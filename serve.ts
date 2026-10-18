import { serveHttp, type ServeDefaultExport } from "#http";
import type { Kv } from "#kv";
import { config } from "./src/config.ts";
import { getKv } from "./src/kv.ts";
import { prepareNativeKvForDevelopment } from "./src/runtime/native-kv-bootstrap.ts";
import { migrateLegacyCodexResetOptOut } from "./src/codex/reset-settings.ts";
import { configureAdminAuthForListener, configureAdminAuthPeerForRequest, parseServeRuntimeOptions } from "./src/auth/local-admin.ts";
import { ensureLocalDevelopmentApiKey } from "./src/auth/local-development-key.ts";
import { closeOptionalPromptCacheAnalytics, optionalPromptCacheAnalyticsSnapshot, prunePromptCacheAnalytics } from "./src/cache/prompt-analytics.ts";
import { createServeHandler, createServeUpgradeHandler } from "./src/handler/serve-handler.ts";
import { reconcileDuePaidFallbacksV3 } from "./src/paid-fallback/ledger-backfill.ts";

/**
 * Bounded optional-telemetry shutdown for both launchers.
 *
 * Optional aggregate analytics is the only lossy terminal write, and it is
 * drained after the server's in-flight work settles and before the KV handle
 * closes. The queue's absolute drain deadline ends the wait even when an
 * optional write never progresses, so a stalled sink cannot hang shutdown; the
 * unresolved entry stays retained as bounded capacity until process exit
 * instead of being orphaned or retried. One sanitized snapshot then makes
 * drops, failures, retained capacity and an incomplete drain operationally
 * observable. Required durable evidence - quota/accounting, admin errors and
 * authenticated failure capture - is never routed through this queue.
 */
export const shutdownOptionalTelemetry = async (): Promise<void> => {
  try {
    await closeOptionalPromptCacheAnalytics();
  } catch {
    // The queue's close settles by contract; a fault still must not block exit.
  }
  const snapshot = optionalPromptCacheAnalyticsSnapshot();
  if (!snapshot) return;
  try {
    console.info(
      "[ai.ubq.fi] optional_telemetry_shutdown",
      JSON.stringify({
        enqueued: snapshot.enqueued,
        delivered: snapshot.delivered,
        failed: snapshot.failed,
        dropped_by_entries: snapshot.dropped_by_entries,
        dropped_by_bytes: snapshot.dropped_by_bytes,
        dropped_by_age: snapshot.dropped_by_age,
        dropped_after_closed: snapshot.dropped_after_closed,
        drain_timeouts: snapshot.drain_timeouts,
        // Charged entries and bytes include unresolved in-flight writes, so a
        // stalled sink is visible as retained capacity instead of a gap.
        retained_entries: snapshot.retained_entries,
        retained_bytes: snapshot.retained_bytes,
        queued_entries: snapshot.queued_entries,
        writes_in_flight: snapshot.writes_in_flight,
        last_error_class: snapshot.last_error_class,
        shutdown_incomplete: snapshot.shutdown_incomplete,
      })
    );
  } catch {
    // Shutdown telemetry is best effort and cannot block process exit.
  }
};

/**
 * The Mac startup event reconciles due billing and prunes its own KV once.
 * Later terminal, admin-read and analytics-write events maintain that same KV;
 * no periodic work runs while it is idle. If a terminal sweep cannot yet see a
 * provider log, its durable retry marker therefore waits for a later authorized
 * event instead of waking an otherwise idle Mac. The VPS launcher never calls this.
 */
export const startMacMaintenance = (kv: Kv): (() => Promise<void>) => {
  let stopped = false;
  let reconciliation: Promise<void> | null = null;
  let pruning: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const reconcile = (): void => {
    if (stopped || reconciliation) return;
    reconciliation = (async () => {
      try {
        await reconcileDuePaidFallbacksV3(Date.now(), kv);
      } catch (error) {
        console.error("[ai.ubq.fi] Mac paid fallback reconciliation failed:", error instanceof Error ? error.message : String(error));
      } finally {
        reconciliation = null;
      }
    })();
  };

  const prune = (): void => {
    if (stopped || pruning) return;
    pruning = (async () => {
      try {
        const result = await prunePromptCacheAnalytics({ kv });
        if (result.status === "unavailable") {
          console.warn("[ai.ubq.fi] prompt_cache_analytics", JSON.stringify({ status: "prune_unavailable" }));
        }
      } catch {
        console.warn("[ai.ubq.fi] prompt_cache_analytics", JSON.stringify({ status: "prune_failed" }));
      } finally {
        pruning = null;
      }
    })();
  };

  reconcile();
  prune();

  return (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = Promise.all([reconciliation ?? Promise.resolve(), pruning ?? Promise.resolve()]).then(() => {});
    return stopPromise;
  };
};

/**
 * No scheduled work starts in this shared handler. Everything the deploy crons used to do
 * now happens because an event happened, and the mapping is deliberate:
 *
 * - "reconcile pending metered billing" (every minute) -> a paid-fallback request
 *   reaching a terminal state (`src/paid_fallback.ts`) or an operator reading the
 *   paid-fallback ledger (`src/admin.ts`).
 * - "sample Codex provider capacity" (every 15 minutes) -> a capacity observation
 *   in `src/codex.ts` (quota exhaustion, upstream outage or unreachable host, a
 *   verified banked reset, or a served request), or an operator asking for a live
 *   view (`?refresh=live`). One probe per fifteen-minute history bucket,
 *   lease-guarded.
 * - "prune prompt cache analytics" (hourly) -> the first analytics write in a new
 *   bucket (`src/prompt_cache_analytics.ts`).
 *
 * Consequences are intentional for the shared handler: with no traffic and no operator, nothing runs.
 * Durable state (pending reconciliation markers, capacity buckets, retained
 * analytics) waits for the next event instead of a timer.
 * The Mac launcher also checks due billing and analytics once on startup
 * against its own KV, then the same event hooks handle subsequent work.
 */
const serveHandler = createServeHandler();
const serveUpgradeHandler = createServeUpgradeHandler();

let runtimeOptions = parseServeRuntimeOptions([], config);

// Imported loopback launchers must opt in explicitly; hosted/deploy and
// production-timeline listeners remain unable to disable admin auth through the
// parser's fail-closed guard.
export const configureLoopbackServeRuntime = async (args: readonly string[]): Promise<void> => {
  runtimeOptions = parseServeRuntimeOptions(args, config);
  if (!runtimeOptions.disableAdminAuth) return;
  try {
    const kv = await getKv();
    if (kv) {
      const status = await ensureLocalDevelopmentApiKey(kv);
      if (status === "created") console.log("[ai.ubq.fi] Provisioned the local development API key for loopback inference.");
      else if (status === "revoked") console.warn("[ai.ubq.fi] The local development API key is revoked; local paid-provider routing stays off.");
    }
  } catch (error) {
    console.warn("[ai.ubq.fi] Local development key provisioning failed:", error instanceof Error ? error.message : String(error));
  }
};

if (import.meta.main) {
  await prepareNativeKvForDevelopment();
  await configureLoopbackServeRuntime(process.argv.slice(2));
}

/**
 * One bounded, idempotent pass materializes a persisted global banked-reset
 * opt-out into per-subscription settings for the accounts in the current strong
 * auth-pool snapshot. It is deliberately not awaited: the read path enforces the
 * same opt-out and retries the same completion, whose single atomic commit is
 * conditional on that snapshot, so a slow or unavailable KV cannot delay
 * listener startup. An empty pool or a concurrent pool change leaves the marker
 * unset and the next guarded read resumes; the legacy key is never deleted.
 */
const migrateCodexResetSettings = async (): Promise<void> => {
  try {
    const kv = await getKv();
    if (!kv) return;
    const status = await migrateLegacyCodexResetOptOut(kv);
    if (status === "pending") {
      console.warn(
        "[ai.ubq.fi] Codex reset-settings migration waits for a configured account pool and an unchanged snapshot; the persisted global opt-out stays in force."
      );
    }
  } catch (error) {
    console.warn("[ai.ubq.fi] Codex reset-settings migration failed:", error instanceof Error ? error.message : String(error));
  }
};

void migrateCodexResetSettings();

/** Named so Bun cannot auto-start a native server and bypass delivery receipts. */
export const application: ServeDefaultExport = {
  fetch(request, info) {
    if (runtimeOptions.disableAdminAuth) configureAdminAuthPeerForRequest(info.remoteAddr, request);
    return serveHandler(request, info);
  },
  upgrade(request, info) {
    if (runtimeOptions.disableAdminAuth) configureAdminAuthPeerForRequest(info.remoteAddr, request);
    return serveUpgradeHandler(request, info);
  },
  onListen(address) {
    if (runtimeOptions.disableAdminAuth) configureAdminAuthForListener(runtimeOptions, address);
    const hostname = address.hostname.includes(":") ? `[${address.hostname}]` : address.hostname;
    console.log(`Listening on http://${hostname}:${address.port}/`);
    if (runtimeOptions.disableAdminAuth) console.warn("[ai.ubq.fi] WARNING: admin authentication is disabled for this loopback development server.");
  },
};

if (import.meta.main) {
  const server = serveHttp({ hostname: "127.0.0.1", port: 8000, onListen: application.onListen, upgrade: application.upgrade }, application.fetch);
  const shutdown = (): void => {
    void server.shutdown().catch(() => {
      console.error("[ai.ubq.fi] Development HTTP shutdown failed");
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await server.ready;
    await server.finished;
    await shutdownOptionalTelemetry();
    (await getKv())?.close();
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
  process.exit(0);
}
