import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
import { runMeteredPaidFallbackMatrixPart1 } from "./helpers/metered-routing-matrix-part1.ts";

test("openai: Metered paid fallback routing matrix (part 1 of 2)", () => runSequence(runMeteredPaidFallbackMatrixPart1));
