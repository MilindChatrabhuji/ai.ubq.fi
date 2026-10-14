/**
 * Offline Stage 0 prompt-cache telemetry analyzer.
 *
 * This script deliberately accepts only stdin. It never reads a log file,
 * connects to a service, or persists the input. Its JSON output contains only
 * release identity and aggregate provider/opaque-model-cohort/route telemetry;
 * it never echoes an input line or request-level identifiers.
 */

import { Stage0CacheTelemetryAccumulator } from "./stage0-cache-telemetry-accumulator.ts";
import { Stage0CacheTelemetryGateError, type Stage0CacheTelemetryReport } from "./stage0-cache-telemetry-types.ts";
export {
  Stage0CacheTelemetryGateError,
  STAGE0_AGGREGATE_MIN_COMPLETED,
  STAGE0_COHORT_MIN_COMPLETED,
  STAGE0_MIN_REPORTED_COVERAGE,
} from "./stage0-cache-telemetry-types.ts";

export const analyzeStage0CacheTelemetryLines = (lines: Iterable<string>): Stage0CacheTelemetryReport => {
  const accumulator = new Stage0CacheTelemetryAccumulator();
  let lineNumber = 0;
  for (const line of lines) {
    lineNumber += 1;
    accumulator.addLine(line, lineNumber);
  }
  return accumulator.finish();
};

async function* readStdinLines(): AsyncGenerator<string> {
  let remaining = "";
  for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
    const lines = `${remaining}${chunk}`.split("\n");
    remaining = lines.pop() ?? "";
    for (const line of lines) yield line.endsWith("\r") ? line.slice(0, -1) : line;
  }
  if (remaining.length > 0) yield remaining.endsWith("\r") ? remaining.slice(0, -1) : remaining;
}

const analyzeStdin = async (): Promise<Stage0CacheTelemetryReport> => {
  const accumulator = new Stage0CacheTelemetryAccumulator();
  let lineNumber = 0;
  for await (const line of readStdinLines()) {
    lineNumber += 1;
    accumulator.addLine(line, lineNumber);
  }
  return accumulator.finish();
};

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error("stage0-cache-telemetry-gate accepts stdin only and does not support arguments");
    process.exit(2);
  }

  try {
    console.log(JSON.stringify(await analyzeStdin(), null, 2));
  } catch (error) {
    if (error instanceof Stage0CacheTelemetryGateError) {
      console.error(`stage0-cache-telemetry-gate: ${error.message}`);
    } else {
      // Do not serialize unexpected errors: some runtimes include input values
      // in parser diagnostics, and request-level data must never be echoed.
      console.error("stage0-cache-telemetry-gate: analysis failed");
    }
    process.exitCode = 2;
  }
}
