import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
import { runMeteredPaidFallbackMatrixPart2 } from "./helpers/metered-routing-matrix-part2.ts";

test("openai: Metered paid fallback routing matrix (part 2 of 2)", () => runSequence(runMeteredPaidFallbackMatrixPart2));
