/**
 * Verify the declared fixture revisions of every task manifest against the
 * checked-in fixture snapshots. Authoring aid and CI-style invariant check.
 *
 * Usage (from the repository root):
 *   bun run benchmark:fixture-revision
 */

import { computeFixtureRevision } from "./fixture.ts";
import { loadTasks } from "./manifest.ts";
import { BENCHMARK_ROOT } from "./schemas.ts";

if (import.meta.main) {
  let failures = 0;
  const tasks = loadTasks(`${BENCHMARK_ROOT}/tasks`);
  console.log("task     fixture_revision(computed)                          declared match");
  for (const task of tasks) {
    const actual = await computeFixtureRevision(`${BENCHMARK_ROOT}/fixtures/${task.fixture}`);
    const ok = actual === task.fixture_revision;
    if (!ok) failures++;
    console.log(`${task.id.padEnd(8)} ${actual}  ${task.fixture_revision}  ${ok ? "ok" : "MISMATCH"}`);
  }
  if (failures > 0) {
    console.error(`\n${failures} fixture revision(s) mismatch; regenerate or update manifests`);
    process.exit(1);
  }
  console.log(`\n${tasks.length} fixture revisions verified`);
}
