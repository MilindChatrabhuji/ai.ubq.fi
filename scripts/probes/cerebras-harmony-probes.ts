import { mkdir, writeFile } from "node:fs/promises";
/**
 * Live Harmony/Cerebras protocol probe (plan m01, acceptance surface 1).
 *
 * Runs the bounded scenario manifest against the exact model `gpt-oss-120b`
 * through the existing Cerebras transport and emits one JSONL result file:
 *
 *   docs/probes/cerebras-harmony-protocol-<utc-timestamp>.jsonl
 *
 * Gating: the command is intentionally inert without the existing
 * `CEREBRAS_API_KEY`; it prints a skip notice and exits 0.  No new secrets,
 * environment variables, CLI flags, or paid fallback are involved — the
 * transport, model constant and key handling are reused from `src/cerebras.ts`.
 *
 * Output is sanitized: prompts, private reasoning, tool arguments and API
 * keys never appear; only request metadata, response metadata and a short
 * final-content preview are recorded.
 *
 * Run with: bun run scripts/probes/cerebras-harmony-probes.ts
 */

import { readCerebrasApiKey } from "../../src/provider/cerebras.ts";
import { createCerebrasTransport } from "../../src/harmony/adapter.ts";
import { createProbeContext, type ProbeContext, type ProbeScenarioResult } from "../../src/harmony/probes.ts";
import { PROBE_SCENARIOS } from "../../src/harmony/probe-scenarios.ts";

const OUTPUT_DIR = new URL("../../docs/probes/", import.meta.url);
const API_KEY_MISSING_NOTICE = "CEREBRAS_API_KEY is not set; live Harmony protocol probes are skipped (no live calls made).";

const utcStamp = (date: Date): string => date.toISOString().replaceAll(":", "-").replaceAll(".", "-").slice(0, 19);

const writeJsonl = async (path: URL, results: readonly ProbeScenarioResult[]): Promise<void> => {
  await mkdir(new URL(".", path), { recursive: true }).catch(() => {});
  const lines = results.map((result) => JSON.stringify({ probeVersion: "m01", ...result }));
  await writeFile(path, `${lines.join("\n")}\n`);
};

const runManifest = async (ctx: ProbeContext): Promise<ProbeScenarioResult[]> => {
  const results: ProbeScenarioResult[] = [];
  for (const scenario of PROBE_SCENARIOS) {
    try {
      results.push(await scenario.run(ctx));
    } catch (error) {
      const startedAt = ctx.now().toISOString();
      results.push({
        id: scenario.id,
        group: scenario.group,
        style: scenario.style,
        description: scenario.description,
        expectedOutcome: scenario.expectedOutcome,
        outcome: "failed",
        startedAt,
        durationMs: 0,
        turns: [],
        verdict: null,
        failure: `probe harness error: ${String(error)}`,
        notes: [],
      });
    }
  }
  return results;
};

console.log(`Harmony/Cerebras protocol probes (m01) — model gpt-oss-120b`);
const apiKey = readCerebrasApiKey();
if (!apiKey) {
  console.error(API_KEY_MISSING_NOTICE);
  process.exit(0);
}

const transport = createCerebrasTransport({ apiKey });
const ctx = createProbeContext(transport);
const started = new Date();
const results = await runManifest(ctx);
const finished = new Date();

const path = new URL(`cerebras-harmony-protocol-${utcStamp(started)}.jsonl`, OUTPUT_DIR);
await writeJsonl(path, results);

const expectedMatches = results.filter((result) => result.expectedOutcome !== null && result.expectedOutcome === result.outcome);
const expectationLabel = (result: ProbeScenarioResult): string => {
  if (result.expectedOutcome === null) return "info";
  if (result.expectedOutcome === result.outcome) return "matched";
  return "DIVERGED";
};
console.log(``);
console.log(`Summary (${results.length} scenarios, ${expectedMatches.length} matched expectations, ${finished.getTime() - started.getTime()} ms total):`);
for (const result of results) {
  const expectation = expectationLabel(result);
  const turns = result.turns
    .map((turn) => {
      if (turn.outcome === "ok") return "ok";
      const statusSuffix = turn.status === null ? "" : `@${turn.status}`;
      return `${turn.outcome}${statusSuffix}`;
    })
    .join(",");
  console.log(
    `  ${result.id.padEnd(32)} ${result.outcome.padEnd(17)} expected=${String(result.expectedOutcome).padEnd(17)} ${expectation.padEnd(9)} turns=[${turns}]`
  );
}
console.log(``);
console.log(`Results written to: ${path.pathname}`);
console.log(`Sanitized: prompts, reasoning, tool arguments and API keys are not recorded.`);
