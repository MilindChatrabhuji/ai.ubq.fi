import type { MatrixHarness } from "./contracts.ts";
import { codexProviderCases } from "./codex.ts";
import { directProviderCases } from "./direct.ts";
import { claudeProviderCases } from "./claude.ts";
import { openluxProviderCases, paidProviderCases, unknownPaidCases } from "./paid.ts";
import { cacheBodyRejection } from "./cache.ts";

/** Definitions become evidence only after M05 executes them against the compiled Rust entrypoint. */
export async function runProviderMatrixCases(context: MatrixHarness): Promise<void> {
  await context.withScenario("direct", async (context) => {
    await cacheBodyRejection(context);
    await directProviderCases(context);
  });
  await context.withScenario("codex", codexProviderCases);
  await context.withScenario("claude", claudeProviderCases);
  await context.withScenario("paid", paidProviderCases);
  await context.withScenario("paid", openluxProviderCases);
  await context.withScenario("paid", unknownPaidCases);
}

export type { MatrixContext, MatrixHarness, MatrixScenario } from "./contracts.ts";
