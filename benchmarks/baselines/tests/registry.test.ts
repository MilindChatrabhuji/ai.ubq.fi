import { test } from "bun:test";
import { rmSync } from "node:fs";
import { assertBaselinesRefusedByRunner, BASELINE_CONFIG_IDS, baselineAdapters } from "../registry.ts";
import { referenceAdapter } from "../../adapter.ts";
import { runBenchmarks } from "../../runner.ts";
import { freshRunOptions } from "./helpers.ts";

test("registry: exposes exactly A, B, D in stable order, all external", () => {
  const adapters = baselineAdapters();
  const ids = adapters.map((a) => a.configId);
  if (ids.join(",") !== "A,B,D") throw new Error(`unexpected registry ${ids.join(",")}`);
  if (BASELINE_CONFIG_IDS.join(",") !== "A,B,D") throw new Error("config id constant drifted");
  for (const adapter of adapters) {
    if (!adapter.requiresExternalInference) {
      throw new Error(`${adapter.configId} must be refused by the runner by default`);
    }
  }
});

test("registry: the runner refuses every baseline adapter", async () => {
  const opts = freshRunOptions();
  try {
    for (const configId of ["A", "B", "D"]) {
      let refused = false;
      try {
        await runBenchmarks({
          ...opts,
          configs: [configId],
          taskSelectors: ["nav-001"],
          adapters: baselineAdapters(),
        });
      } catch (err) {
        const message = (err as Error).message;
        refused = message.includes("external-inference") && message.includes(configId);
      }
      if (!refused) throw new Error(`config ${configId} was not refused by the runner`);
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("registry: mixed reference + baseline selection still refuses the live adapter", async () => {
  const opts = freshRunOptions();
  try {
    let refused = false;
    try {
      await runBenchmarks({
        ...opts,
        configs: ["reference", "A"],
        taskSelectors: ["nav-001"],
        // The eventual runner registry: hermetic reference plus the baselines.
        adapters: [referenceAdapter, ...baselineAdapters()],
      });
    } catch (err) {
      refused = (err as Error).message.includes("external-inference");
    }
    if (!refused) throw new Error("the external-inference refusal must win over hermetic configs");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("registry: gate assertion helper rejects the baselines", () => {
  let threw = false;
  try {
    assertBaselinesRefusedByRunner(baselineAdapters());
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("the gate assertion must reject external baselines");
});
