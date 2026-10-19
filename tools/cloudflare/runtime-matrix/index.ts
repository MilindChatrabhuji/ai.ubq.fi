import type { MatrixHarness } from "./contracts.ts";
import { codexProviderCases } from "./codex.ts";
import { directProviderCases } from "./direct.ts";

/** Definitions become evidence only after M05 executes them against the compiled Rust entrypoint. */
export async function runProviderMatrixCases(context: MatrixHarness): Promise<void> {
  await context.withScenario("direct", directProviderCases);
  await context.withScenario("codex", codexProviderCases);
}

export type { MatrixContext, MatrixHarness, MatrixScenario } from "./contracts.ts";
