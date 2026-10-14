/**
 * No-growth file-size ratchet.
 *
 * Source files are capped at 1000 lines and test files at 1500. Files that
 * predate the caps carry a recorded per-file ceiling in
 * `file-size-baseline.json`; nothing over a cap may be added, and a recorded
 * ceiling may only tighten. `bun run size:check` fails whenever the tree and
 * the baseline disagree, and `bun run size:update` is the only writer: it can
 * lower or drop a ceiling and refuses to raise one or to record a new file.
 *
 * Check rules:
 *   - file over its cap with no recorded ceiling -> failure (new debt)
 *   - recorded file above its recorded ceiling  -> failure (growth)
 *   - recorded file below its recorded ceiling  -> failure (tighten now)
 *   - recorded file at/below its cap            -> failure (drop the ceiling)
 *   - recorded path with no file                -> failure (drop the ceiling)
 *
 * Scope mirrors tools/lint/eslint.config.mjs: `*.ts` only, generated `*.d.ts`
 * and vendored, generated, scratch, and worktree directories excluded.
 *
 * Usage:
 *   bun --no-env-file scripts/file-size-ratchet.ts
 *   bun --no-env-file scripts/file-size-ratchet.ts --update
 *   bun --no-env-file scripts/file-size-ratchet.ts --init
 *
 * `--init` is the one-time bootstrap; it refuses to run once the baseline
 * exists. Do not delete the baseline to re-record debt.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_CAP = 1000;
const TEST_CAP = 1500;
const BASELINE_PATH = "file-size-baseline.json";
const UPDATE_HINT = "`bun run size:update`";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors the ESLint flat-config ignores plus test scratch directories.
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".bun-cache",
  ".tmp",
  "lib",
  ".codex-worktrees",
  ".data",
  ".release",
  ".kv-migration",
  ".sentinel",
  ".diagnostics",
  ".cleanup-evidence",
  "logs",
  "benchmark-runs",
]);

// Mirrors the ESLint test-file globs: tests/, __tests__/, *.test.ts, *.spec.ts,
// and the benchmark harness.
const TEST_DIRECTORY = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/;
const TEST_FILENAME = /\.(?:test|spec)\.ts$/;

type CountedFile = Readonly<{ path: string; lines: number; cap: number }>;

const countLines = (text: string): number => {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? 0 : body.split("\n").length;
};

const listFiles = (): CountedFile[] => {
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        paths.push(relative(ROOT, full).split(sep).join("/"));
      }
    }
  };
  walk(ROOT);
  return paths.map((path) => {
    const cap = TEST_DIRECTORY.test(path) || TEST_FILENAME.test(path) || path.startsWith("benchmarks/") ? TEST_CAP : SOURCE_CAP;
    return { path, lines: countLines(readFileSync(join(ROOT, path), "utf8")), cap };
  });
};

const baselineLocation = (): string => join(ROOT, BASELINE_PATH);

const writeBaseline = (entries: ReadonlyMap<string, number>): void => {
  const lines = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, ceiling]) => `  ${JSON.stringify(path)}: ${ceiling}`);
  const body = lines.length === 0 ? "{}" : `{\n${lines.join(",\n")}\n}`;
  writeFileSync(baselineLocation(), `${body}\n`);
};

const readBaseline = (): Map<string, number> => {
  const location = baselineLocation();
  if (!existsSync(location)) {
    throw new Error(`${BASELINE_PATH} is missing; restore it from git or bootstrap it once with --init`);
  }
  const parsed: unknown = JSON.parse(readFileSync(location, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${BASELINE_PATH} must be a JSON object mapping repo-relative paths to line ceilings`);
  }
  const entries = new Map<string, number>();
  for (const [path, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${BASELINE_PATH}: ${path} must map to a positive integer line ceiling`);
    }
    entries.set(path, value);
  }
  return entries;
};

const initialize = (files: readonly CountedFile[]): void => {
  if (existsSync(baselineLocation())) {
    console.error(`size:init: ${BASELINE_PATH} already exists; use --update to tighten it`);
    process.exit(1);
  }
  const oversized = files.filter((file) => file.lines > file.cap);
  writeBaseline(new Map(oversized.map((file) => [file.path, file.lines])));
  console.log(`size:init: recorded ${oversized.length} grandfathered files in ${BASELINE_PATH}`);
};

/** One message per file whose size and recorded ceiling disagree, else null. */
const checkProblem = (file: CountedFile, recorded: number | undefined): string | null => {
  if (recorded === undefined) {
    return file.lines > file.cap ? `${file.path}: ${file.lines} lines exceeds the ${file.cap}-line cap and has no recorded ceiling; split the file` : null;
  }
  if (file.lines > recorded && recorded > file.cap) {
    return `${file.path}: grew to ${file.lines} lines from its recorded ceiling of ${recorded}; revert the growth`;
  }
  if (file.lines <= file.cap) {
    return `${file.path}: now ${file.lines} lines, within the ${file.cap}-line cap; run ${UPDATE_HINT} to drop its ${recorded}-line ceiling`;
  }
  if (file.lines < recorded) {
    return `${file.path}: shrank to ${file.lines} lines from its recorded ceiling of ${recorded}; run ${UPDATE_HINT} to tighten it`;
  }
  return null;
};

const check = (files: readonly CountedFile[], baseline: ReadonlyMap<string, number>): void => {
  const paths = new Set(files.map((file) => file.path));
  const failures: string[] = [];
  for (const file of files) {
    const problem = checkProblem(file, baseline.get(file.path));
    if (problem !== null) failures.push(problem);
  }
  for (const path of baseline.keys()) {
    if (!paths.has(path)) failures.push(`${path}: recorded ceiling has no file; run ${UPDATE_HINT} to drop it`);
  }
  const oversized = files.filter((file) => file.lines > file.cap).length;
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`size:check: FAILED (${failures.length} problems; ${files.length} files checked, ${oversized} over the caps)`);
    process.exit(1);
  }
  console.log(`size:check: OK (${files.length} files checked, ${oversized} grandfathered, caps ${SOURCE_CAP} source / ${TEST_CAP} test)`);
};

/** One message per file that `--update` must refuse to re-record, else null. */
const updateRefusal = (file: CountedFile, recorded: number | undefined): string | null => {
  if (file.lines <= file.cap) return null;
  if (recorded === undefined) {
    return `${file.path}: ${file.lines} lines exceeds the ${file.cap}-line cap with no recorded ceiling; update never adds debt, split the file`;
  }
  if (file.lines > recorded) {
    return `${file.path}: grew to ${file.lines} lines from its recorded ceiling of ${recorded}; revert the growth before tightening`;
  }
  return null;
};

/** One message per baseline change `--update` writes, else null. */
const updateChange = (file: CountedFile, recorded: number | undefined): string | null => {
  if (file.lines > file.cap) {
    return recorded !== undefined && file.lines < recorded ? `tightened ${file.path}: ${recorded} -> ${file.lines}` : null;
  }
  return recorded === undefined ? null : `dropped ${file.path}: now ${file.lines} lines, within the ${file.cap}-line cap`;
};

const update = (files: readonly CountedFile[], baseline: ReadonlyMap<string, number>): void => {
  const refusals = files.map((file) => updateRefusal(file, baseline.get(file.path))).filter((refusal): refusal is string => refusal !== null);
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(`REFUSED ${refusal}`);
    console.error("size:update: no changes written");
    process.exit(1);
  }
  const paths = new Set(files.map((file) => file.path));
  const next = new Map<string, number>();
  const changes: string[] = [];
  for (const file of files) {
    if (file.lines > file.cap) next.set(file.path, file.lines);
    const change = updateChange(file, baseline.get(file.path));
    if (change !== null) changes.push(change);
  }
  for (const path of baseline.keys()) {
    if (!paths.has(path)) changes.push(`dropped ${path}: no such file`);
  }
  if (changes.length === 0) {
    console.log(`size:update: already tight (${next.size} grandfathered files)`);
    return;
  }
  writeBaseline(next);
  for (const change of changes) console.log(`  ${change}`);
  console.log(`size:update: wrote ${BASELINE_PATH} (${changes.length} changes, ${next.size} grandfathered files)`);
};

const parseMode = (args: readonly string[]): "check" | "update" | "init" => {
  let mode: "check" | "update" | "init" = "check";
  for (const arg of args) {
    if (arg === "--check") mode = "check";
    else if (arg === "--update") mode = "update";
    else if (arg === "--init") mode = "init";
    else {
      console.error(`unknown argument: ${arg}`);
      console.error("usage: file-size-ratchet.ts [--check|--update|--init]");
      process.exit(1);
    }
  }
  return mode;
};

const main = (): void => {
  const mode = parseMode(process.argv.slice(2));
  const files = listFiles();
  if (mode === "init") {
    initialize(files);
    return;
  }
  const baseline = readBaseline();
  if (mode === "update") update(files, baseline);
  else check(files, baseline);
};

try {
  main();
} catch (error) {
  console.error(`size:check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
