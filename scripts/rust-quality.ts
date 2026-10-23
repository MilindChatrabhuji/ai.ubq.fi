/**
 * No-growth quality gate for the first-party Rust port.
 *
 * A crate is the total physical lines in the Rust files beneath its `src` subtree
 * and is capped at 1000. Every authored Rust file below `rust/crates`, including integration
 * tests, is scanned once for visible `use`/`extern crate` re-exports, `#[path]`
 * (including nested or inactive `cfg_attr` branches), plain `include!`, and
 * `allow`/`expect` suppressions.
 *
 * This gate deliberately does not model per-target source closures: the crate
 * cap does not follow `#[path]` or `include!` into files outside `src`, and it
 * does not charge integration tests, examples, benchmarks, or build scripts to
 * the package. Those remain separate bounded crates under the Rust port rules.
 * Macro expansion is also out of scope; authored first-party source and macro
 * templates are what this lexical gate checks.
 *
 * Existing debt is recorded in `rust/quality-baseline.json`. `--check` fails on
 * new debt, growth, stale ceilings, stale violation counts, or recorded paths
 * that no longer exist. `--update` may only lower or drop debt and refuses to
 * record anything new. `--init` is the one-time bootstrap and refuses once the
 * baseline exists. The two known migration facts are grandfathered explicitly:
 * `rust/crates/gateway-schema/src/catalog_cache.rs` has one
 * `#[allow(clippy::too_many_arguments)]`, and the baseline also records legacy
 * visibility-qualified re-exports discovered by the stricter visibility check.
 *
 * Usage:
 *   bun --no-env-file scripts/rust-quality.ts
 *   bun --no-env-file scripts/rust-quality.ts --update
 *   bun --no-env-file scripts/rust-quality.ts --init
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CRATE_CAP = 1000;
const BASELINE_PATH = "rust/quality-baseline.json";
const UPDATE_HINT = "`bun run rust:quality:update`";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATES_DIRECTORY = join(ROOT, "rust", "crates");
const VIOLATION_CATEGORIES = ["pubUse", "path", "include", "suppression"] as const;

type ViolationCategory = (typeof VIOLATION_CATEGORIES)[number];
type ViolationCounts = Record<ViolationCategory, number>;
type RustFile = Readonly<{ path: string; violations: ViolationCounts }>;
type TokenKind = "identifier" | "punctuation" | "literal";
type Token = Readonly<{ kind: TokenKind; value: string; raw?: boolean }>;
type TokenRead = Readonly<{ token: Token; next: number }>;
type DeclarationCategory = "pubUse" | "include";
type Scan = Readonly<{
  crates: readonly string[];
  crateLines: ReadonlyMap<string, number>;
  files: ReadonlyMap<string, RustFile>;
  manifestFailures: readonly string[];
}>;
type Baseline = Readonly<{ crates: ReadonlyMap<string, number>; violations: ReadonlyMap<ViolationCategory, ReadonlyMap<string, number>> }>;
type Mode = "check" | "update" | "init";

const LABELS: Readonly<Record<ViolationCategory, string>> = {
  pubUse: "visible re-export",
  path: "#[path]",
  include: "include!",
  suppression: "allow/expect",
};

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const sortedEntries = (map: ReadonlyMap<string, number>): [string, number][] => [...map.entries()].sort(([left], [right]) => compareText(left, right));

const physicalLines = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const isIdentifierStart = (character: string | undefined): boolean => character !== undefined && /[A-Za-z_]/.test(character);

const isIdentifierContinue = (character: string | undefined): boolean => character !== undefined && /\w/.test(character);

const skipQuoted = (text: string, start: number, quote: string): number => {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return text.length;
};

const skipCharLiteral = (text: string, start: number): number | null => {
  let cursor = start + 1;
  if (cursor >= text.length) return null;
  if (text[cursor] === "\\") {
    cursor += 2;
    if (text[cursor] === "'") return cursor + 1;
    return null;
  }
  if (cursor + 1 < text.length && text[cursor + 1] === "'") return cursor + 2;
  return null;
};

const rawStringEnd = (text: string, start: number): number | null => {
  let cursor = start;
  if (text[cursor] === "b") cursor += 1;
  if (text[cursor] !== "r") return null;
  cursor += 1;
  let hashes = 0;
  while (text[cursor] === "#") {
    hashes += 1;
    cursor += 1;
  }
  if (text[cursor] !== '"') return null;
  const terminator = `"${"#".repeat(hashes)}`;
  const end = text.indexOf(terminator, cursor + 1);
  return end < 0 ? text.length : end + terminator.length;
};

const skipBlockComment = (text: string, start: number): number => {
  let depth = 1;
  let cursor = start + 2;
  while (cursor < text.length) {
    if (text.startsWith("/*", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith("*/", cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return cursor;
    } else {
      cursor += 1;
    }
  }
  return text.length;
};

const literalRead = (next: number): TokenRead => ({ token: { kind: "literal", value: "" }, next });

const identifierRead = (value: string, next: number, raw = false): TokenRead => ({
  token: { kind: "identifier", value, ...(raw ? { raw: true } : {}) },
  next,
});

const skipTrivia = (text: string, cursor: number): number | null => {
  if (/\s/.test(text[cursor])) return cursor + 1;
  if (text.startsWith("//", cursor)) {
    const newline = text.indexOf("\n", cursor + 2);
    return newline < 0 ? text.length : newline + 1;
  }
  if (text.startsWith("/*", cursor)) return skipBlockComment(text, cursor);
  return null;
};

const readStringOrChar = (text: string, cursor: number): TokenRead | null => {
  const rawEnd = rawStringEnd(text, cursor);
  if (rawEnd !== null) return literalRead(rawEnd);
  const character = text[cursor];
  if (character === "b" && (text[cursor + 1] === '"' || text[cursor + 1] === "'")) {
    if (text[cursor + 1] === '"') return literalRead(skipQuoted(text, cursor + 1, '"'));
    const byteCharEnd = skipCharLiteral(text, cursor + 1);
    return byteCharEnd === null ? null : literalRead(byteCharEnd);
  }
  if (character === '"') return literalRead(skipQuoted(text, cursor, '"'));
  if (character !== "'") return null;
  const charEnd = skipCharLiteral(text, cursor);
  return charEnd === null ? null : literalRead(charEnd);
};

const readRawIdentifier = (text: string, cursor: number): TokenRead | null => {
  if (!text.startsWith("r#", cursor) || !isIdentifierStart(text[cursor + 2])) return null;
  let end = cursor + 3;
  while (isIdentifierContinue(text[end])) end += 1;
  return identifierRead(text.slice(cursor + 2, end), end, true);
};

const readIdentifier = (text: string, cursor: number): TokenRead | null => {
  if (!isIdentifierStart(text[cursor])) return null;
  let end = cursor + 1;
  while (isIdentifierContinue(text[end])) end += 1;
  return identifierRead(text.slice(cursor, end), end);
};

const readNumber = (text: string, cursor: number): TokenRead | null => {
  if (!/\d/.test(text[cursor])) return null;
  let end = cursor + 1;
  while (end < text.length && /[\w.]/.test(text[end])) end += 1;
  return literalRead(end);
};

const tokenizeRust = (text: string): Token[] => {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const triviaEnd = skipTrivia(text, cursor);
    if (triviaEnd !== null) {
      cursor = triviaEnd;
      continue;
    }
    const nextToken = readStringOrChar(text, cursor) ?? readRawIdentifier(text, cursor) ?? readIdentifier(text, cursor) ?? readNumber(text, cursor);
    if (nextToken !== null) {
      tokens.push(nextToken.token);
      cursor = nextToken.next;
      continue;
    }
    tokens.push({ kind: "punctuation", value: text[cursor] });
    cursor += 1;
  }
  return tokens;
};

const matchingBackward = (tokens: readonly Token[], closeIndex: number, open: string, close: string): number | null => {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    const value = tokens.at(index)?.value;
    if (value === close) depth += 1;
    else if (value === open) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
};

const matchingForward = (tokens: readonly Token[], openIndex: number, open: string, close: string): number | null => {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens.at(index)?.value;
    if (value === open) depth += 1;
    else if (value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
};

const hasVisiblePrefix = (tokens: readonly Token[], declarationIndex: number): boolean => {
  const previous = tokens.at(declarationIndex - 1);
  if (previous?.value === "pub" && previous.raw !== true) return true;
  if (previous?.value !== ")") return false;
  const open = matchingBackward(tokens, declarationIndex - 1, "(", ")");
  if (open === null) return false;
  const visibilityOwner = tokens.at(open - 1);
  if (visibilityOwner?.value !== "pub" || visibilityOwner.raw === true) return false;
  const visibility = tokens.slice(open + 1, declarationIndex - 1);
  return !(visibility.length === 1 && visibility[0]?.value === "self");
};

const declarationCategory = (tokens: readonly Token[], index: number): DeclarationCategory | null => {
  const token = tokens.at(index);
  if (token?.kind !== "identifier") return null;
  if (token.value === "include" && tokens.at(index + 1)?.value === "!") return "include";
  if (token.raw === true) return null;
  if (token.value === "use" && hasVisiblePrefix(tokens, index)) return "pubUse";
  const next = tokens.at(index + 1);
  if (token.value === "extern" && next?.kind === "identifier" && next.raw !== true && next.value === "crate" && hasVisiblePrefix(tokens, index)) {
    return "pubUse";
  }
  return null;
};

const attributeTokens = (tokens: readonly Token[], index: number): readonly Token[] | null => {
  const openIndex = tokens.at(index + 1)?.value === "!" ? index + 2 : index + 1;
  if (tokens.at(openIndex)?.value !== "[") return null;
  const closeIndex = matchingForward(tokens, openIndex, "[", "]");
  return closeIndex === null ? null : tokens.slice(openIndex + 1, closeIndex);
};

const countAttributeViolations = (attribute: readonly Token[]): { path: number; suppression: number } => {
  let path = 0;
  let suppression = 0;
  for (let index = 0; index < attribute.length; index += 1) {
    const token = attribute.at(index);
    if (token?.kind !== "identifier" || token.raw === true) continue;
    const next = attribute.at(index + 1);
    if (token.value === "path" && next?.value === "=") path += 1;
    if ((token.value === "allow" || token.value === "expect") && next?.value === "(") suppression += 1;
  }
  return { path, suppression };
};

const addAttributeViolations = (tokens: readonly Token[], index: number, violations: ViolationCounts): void => {
  const attribute = attributeTokens(tokens, index);
  if (attribute === null) return;
  const counts = countAttributeViolations(attribute);
  violations.path += counts.path;
  violations.suppression += counts.suppression;
};

const analyzeRust = (text: string): ViolationCounts => {
  const tokens = tokenizeRust(text);
  const violations: ViolationCounts = { pubUse: 0, path: 0, include: 0, suppression: 0 };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens.at(index);
    if (token === undefined) continue;
    const category = declarationCategory(tokens, index);
    if (category !== null) violations[category] += 1;
    if (token.value === "#") addAttributeViolations(tokens, index, violations);
  }
  return violations;
};

const stripTomlComment = (line: string): string => {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
};

const sectionName = (line: string): string | null => {
  if (line.length < 3 || !line.startsWith("[") || !line.endsWith("]")) return null;
  const body = line.slice(1, -1).trim();
  if (body.length === 0 || body.includes("[")) return null;
  if (body.length > 1) {
    const doubleQuoted = body.startsWith('"') && body.endsWith('"');
    const singleQuoted = body.startsWith("'") && body.endsWith("'");
    if (doubleQuoted || singleQuoted) return body.slice(1, -1);
  }
  return body;
};

const inheritsWorkspaceLints = (manifest: string): boolean => {
  let section = "";
  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;
    const header = sectionName(line);
    if (header !== null) {
      section = header;
      continue;
    }
    if (section === "lints" && /^workspace\s*=\s*true$/.test(line)) return true;
  }
  return false;
};

const scan = (): Scan => {
  const crates = readdirSync(CRATES_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareText);
  const crateLines = new Map(crates.map((crate) => [crate, 0]));
  const files = new Map<string, RustFile>();
  const manifestFailures: string[] = [];
  for (const crate of crates) {
    const crateRoot = join(CRATES_DIRECTORY, crate);
    const manifestPath = join(crateRoot, "Cargo.toml");
    const manifestRelative = relative(ROOT, manifestPath).split(sep).join("/");
    if (!existsSync(manifestPath)) {
      manifestFailures.push(`${manifestRelative}: first-party crate has no Cargo.toml with [lints] workspace = true`);
    } else if (!inheritsWorkspaceLints(readFileSync(manifestPath, "utf8"))) {
      manifestFailures.push(`${manifestRelative}: missing [lints] with workspace = true; inherit the workspace lint policy`);
    }
    const walk = (directory: string): void => {
      const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
      for (const entry of entries) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".rs")) continue;
        const path = relative(ROOT, full).split(sep).join("/");
        const crateRelative = relative(crateRoot, full).split(sep).join("/");
        const text = readFileSync(full, "utf8");
        files.set(path, { path, violations: analyzeRust(text) });
        if (crateRelative.startsWith("src/")) crateLines.set(crate, (crateLines.get(crate) ?? 0) + physicalLines(text).length);
      }
    };
    walk(crateRoot);
  }
  return { crates, crateLines, files, manifestFailures };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readIntegerMap = (value: unknown, label: string, minimum: number): Map<string, number> => {
  if (!isRecord(value)) throw new Error(`${BASELINE_PATH}: ${label} must be a JSON object mapping paths to counts`);
  const entries = new Map<string, number>();
  for (const [path, count] of Object.entries(value)) {
    if (path.length === 0) throw new Error(`${BASELINE_PATH}: ${label} contains an empty path`);
    if (typeof count !== "number" || !Number.isInteger(count) || count < minimum) {
      throw new Error(`${BASELINE_PATH}: ${label}.${path} must be an integer of at least ${minimum}`);
    }
    entries.set(path, count);
  }
  return new Map(sortedEntries(entries));
};

const emptyViolationMaps = (): Map<ViolationCategory, Map<string, number>> =>
  new Map(VIOLATION_CATEGORIES.map((category) => [category, new Map<string, number>()]));

const readBaseline = (): Baseline => {
  const location = join(ROOT, BASELINE_PATH);
  if (!existsSync(location)) throw new Error(`${BASELINE_PATH} is missing; restore it from git or bootstrap it once with --init`);
  const parsed: unknown = JSON.parse(readFileSync(location, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${BASELINE_PATH} must be a JSON object with "crates" and "violations" objects`);
  const topLevel = Object.keys(parsed).sort(compareText);
  if (topLevel.length !== 2 || topLevel[0] !== "crates" || topLevel[1] !== "violations") {
    throw new Error(`${BASELINE_PATH} must contain exactly "crates" and "violations"`);
  }
  const violationValue = parsed.violations;
  if (!isRecord(violationValue)) throw new Error(`${BASELINE_PATH}: violations must be a JSON object`);
  const categories = Object.keys(violationValue).sort(compareText);
  const expected = [...VIOLATION_CATEGORIES].sort(compareText);
  if (categories.length !== expected.length || categories.some((category, index) => category !== expected[index])) {
    throw new Error(`${BASELINE_PATH}: violations must contain exactly ${VIOLATION_CATEGORIES.join(", ")}`);
  }
  const violations = emptyViolationMaps();
  for (const category of VIOLATION_CATEGORIES) violations.set(category, readIntegerMap(violationValue[category], `violations.${category}`, 1));
  return { crates: readIntegerMap(parsed.crates, "crates", CRATE_CAP + 1), violations };
};

const mapObject = (map: ReadonlyMap<string, number>): Record<string, number> => Object.fromEntries(sortedEntries(map));

const writeBaseline = (baseline: Baseline): void => {
  const violations: Record<string, Record<string, number>> = {};
  for (const category of VIOLATION_CATEGORIES) violations[category] = mapObject(baseline.violations.get(category) ?? new Map<string, number>());
  writeFileSync(join(ROOT, BASELINE_PATH), `${JSON.stringify({ crates: mapObject(baseline.crates), violations }, null, 2)}\n`);
};

const currentBaseline = (scanned: Scan): Baseline => {
  const crates = new Map<string, number>();
  for (const crate of scanned.crates) {
    const lines = scanned.crateLines.get(crate) ?? 0;
    if (lines > CRATE_CAP) crates.set(crate, lines);
  }
  const violations = emptyViolationMaps();
  for (const file of scanned.files.values()) {
    for (const category of VIOLATION_CATEGORIES) {
      const count = file.violations[category];
      if (count > 0) violations.get(category)?.set(file.path, count);
    }
  }
  return { crates, violations };
};

const violationTotals = (scanned: Scan): { totals: ViolationCounts; files: number } => {
  const totals: ViolationCounts = { pubUse: 0, path: 0, include: 0, suppression: 0 };
  let files = 0;
  for (const file of scanned.files.values()) {
    let count = 0;
    for (const category of VIOLATION_CATEGORIES) {
      count += file.violations[category];
      totals[category] += file.violations[category];
    }
    if (count > 0) files += 1;
  }
  return { totals, files };
};

const totalsText = (totals: ViolationCounts): string =>
  `${totals.pubUse} visible re-exports + ${totals.path} #[path] + ${totals.include} include! + ${totals.suppression} allow/expect violations`;

const oversizedCrates = (scanned: Scan): number => scanned.crates.filter((crate) => (scanned.crateLines.get(crate) ?? 0) > CRATE_CAP).length;

const initialize = (): void => {
  if (existsSync(join(ROOT, BASELINE_PATH))) {
    console.error(`rust:quality:init: ${BASELINE_PATH} already exists; use --update to tighten it`);
    process.exit(1);
  }
  const scanned = scan();
  if (scanned.manifestFailures.length > 0) {
    for (const failure of scanned.manifestFailures) console.error(`FAIL ${failure}`);
    console.error(`rust:quality:init: FAILED (${scanned.manifestFailures.length} manifest policy problems)`);
    process.exit(1);
  }
  const baseline = currentBaseline(scanned);
  writeBaseline(baseline);
  const { totals, files } = violationTotals(scanned);
  console.log(`rust:quality:init: recorded ${baseline.crates.size} oversized crates and ${files} violation files in ${BASELINE_PATH} (${totalsText(totals)})`);
};

const crateProblem = (crate: string, lines: number, recorded: number | undefined): string | null => {
  const path = `rust/crates/${crate}`;
  if (recorded === undefined) {
    return lines > CRATE_CAP ? `${path}: ${lines} production lines exceeds the ${CRATE_CAP}-line crate cap and has no recorded ceiling; split the crate` : null;
  }
  if (lines > recorded) return `${path}: grew to ${lines} production lines from its recorded ceiling of ${recorded}; revert the growth`;
  if (lines <= CRATE_CAP) {
    return `${path}: now ${lines} production lines, within the ${CRATE_CAP}-line crate cap; run ${UPDATE_HINT} to drop its ${recorded}-line ceiling`;
  }
  if (lines < recorded) return `${path}: shrank to ${lines} production lines from its recorded ceiling of ${recorded}; run ${UPDATE_HINT} to tighten it`;
  return null;
};

const crateFailures = (scanned: Scan, baseline: Baseline): string[] => {
  const failures: string[] = [];
  const crates = new Set(scanned.crates);
  for (const crate of scanned.crates) {
    const problem = crateProblem(crate, scanned.crateLines.get(crate) ?? 0, baseline.crates.get(crate));
    if (problem !== null) failures.push(problem);
  }
  for (const crate of baseline.crates.keys()) {
    if (!crates.has(crate)) failures.push(`rust/crates/${crate}: recorded ceiling has no first-party crate; run ${UPDATE_HINT} to drop it`);
  }
  return failures;
};

const violationProblem = (path: string, file: RustFile, category: ViolationCategory, recorded: number | undefined): string | null => {
  const actual = file.violations[category];
  if (recorded === undefined) {
    return actual > 0 ? `${path}: ${LABELS[category]} count is ${actual}, but no baseline count is recorded; remove the new violation` : null;
  }
  if (actual > recorded) return `${path}: ${LABELS[category]} count grew to ${actual} from ${recorded}; revert the growth`;
  if (actual < recorded) return `${path}: ${LABELS[category]} count shrank to ${actual} from ${recorded}; run ${UPDATE_HINT} to tighten it`;
  return null;
};

const violationFailures = (scanned: Scan, baseline: Baseline): string[] => {
  const paths = new Set(scanned.files.keys());
  for (const category of VIOLATION_CATEGORIES) {
    for (const path of baseline.violations.get(category)?.keys() ?? []) paths.add(path);
  }
  const failures: string[] = [];
  for (const path of [...paths].sort(compareText)) {
    const file = scanned.files.get(path);
    if (file === undefined) {
      failures.push(`${path}: recorded violation path has no Rust source file; run ${UPDATE_HINT} to drop it`);
      continue;
    }
    for (const category of VIOLATION_CATEGORIES) {
      const problem = violationProblem(path, file, category, baseline.violations.get(category)?.get(path));
      if (problem !== null) failures.push(problem);
    }
  }
  return failures;
};

const check = (scanned: Scan, baseline: Baseline): void => {
  const failures = [...scanned.manifestFailures, ...crateFailures(scanned, baseline), ...violationFailures(scanned, baseline)];
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(
      `rust:quality:check: FAILED (${failures.length} problems; ${scanned.crates.length} crates, ${scanned.files.size} Rust files, ${oversizedCrates(scanned)} over the ${CRATE_CAP}-line cap)`
    );
    process.exit(1);
  }
  const { totals } = violationTotals(scanned);
  console.log(
    `rust:quality:check: OK (${scanned.crates.length} crates, ${scanned.files.size} Rust files; ${oversizedCrates(scanned)} oversized crates; ${totalsText(totals)}; cap ${CRATE_CAP})`
  );
};

const crateUpdateRefusal = (crate: string, lines: number, recorded: number | undefined): string | null => {
  if (lines <= CRATE_CAP) return null;
  const path = `rust/crates/${crate}`;
  if (recorded === undefined) {
    return `${path}: ${lines} production lines exceeds the ${CRATE_CAP}-line crate cap with no recorded ceiling; update never adds debt, split the crate`;
  }
  return lines > recorded ? `${path}: grew to ${lines} production lines from its recorded ceiling of ${recorded}; revert the growth before tightening` : null;
};

const violationUpdateRefusal = (path: string, category: ViolationCategory, actual: number, recorded: number | undefined): string | null => {
  if (actual === 0) return null;
  if (recorded === undefined) return `${path}: ${LABELS[category]} count is ${actual} with no recorded count; update never adds debt, remove the new violation`;
  return actual > recorded ? `${path}: ${LABELS[category]} count grew to ${actual} from ${recorded}; revert the growth before tightening` : null;
};

const crateUpdateRefusals = (scanned: Scan, baseline: Baseline): string[] => {
  const refusals: string[] = [];
  for (const crate of scanned.crates) {
    const refusal = crateUpdateRefusal(crate, scanned.crateLines.get(crate) ?? 0, baseline.crates.get(crate));
    if (refusal !== null) refusals.push(refusal);
  }
  return refusals;
};

const violationUpdateRefusals = (scanned: Scan, baseline: Baseline): string[] => {
  const refusals: string[] = [];
  for (const file of scanned.files.values()) {
    for (const category of VIOLATION_CATEGORIES) {
      const refusal = violationUpdateRefusal(file.path, category, file.violations[category], baseline.violations.get(category)?.get(file.path));
      if (refusal !== null) refusals.push(refusal);
    }
  }
  return refusals;
};

const crateChanges = (scanned: Scan, baseline: Baseline): string[] => {
  const changes: string[] = [];
  const crates = new Set(scanned.crates);
  for (const crate of scanned.crates) {
    const lines = scanned.crateLines.get(crate) ?? 0;
    const recorded = baseline.crates.get(crate);
    if (lines > CRATE_CAP) {
      if (recorded !== undefined && lines < recorded) changes.push(`tightened rust/crates/${crate}: ${recorded} -> ${lines}`);
    } else if (recorded !== undefined) {
      changes.push(`dropped rust/crates/${crate}: now ${lines} production lines, within the ${CRATE_CAP}-line crate cap`);
    }
  }
  for (const crate of baseline.crates.keys()) {
    if (!crates.has(crate)) changes.push(`dropped rust/crates/${crate}: no such first-party crate`);
  }
  return changes;
};

const fileViolationChanges = (scanned: Scan, baseline: Baseline): string[] => {
  const changes: string[] = [];
  for (const file of scanned.files.values()) {
    for (const category of VIOLATION_CATEGORIES) {
      const actual = file.violations[category];
      const recorded = baseline.violations.get(category)?.get(file.path);
      if (actual === 0) {
        if (recorded !== undefined) changes.push(`dropped ${file.path} [${LABELS[category]}]: no violation remains`);
      } else if (recorded !== undefined && actual < recorded) {
        changes.push(`tightened ${file.path} [${LABELS[category]}]: ${recorded} -> ${actual}`);
      }
    }
  }
  return changes;
};

const missingViolationPathChanges = (scanned: Scan, baseline: Baseline): string[] => {
  const changes: string[] = [];
  for (const category of VIOLATION_CATEGORIES) {
    for (const path of baseline.violations.get(category)?.keys() ?? []) {
      if (!scanned.files.has(path)) changes.push(`dropped ${path} [${LABELS[category]}]: no such Rust source file`);
    }
  }
  return changes;
};

const update = (scanned: Scan, baseline: Baseline): void => {
  const refusals = [...scanned.manifestFailures, ...crateUpdateRefusals(scanned, baseline), ...violationUpdateRefusals(scanned, baseline)];
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(`REFUSED ${refusal}`);
    console.error("rust:quality:update: no changes written");
    process.exit(1);
  }

  const next = currentBaseline(scanned);
  const changes = [...crateChanges(scanned, baseline), ...fileViolationChanges(scanned, baseline), ...missingViolationPathChanges(scanned, baseline)];
  if (changes.length === 0) {
    const { totals } = violationTotals(scanned);
    console.log(`rust:quality:update: already tight (${next.crates.size} oversized crates; ${totalsText(totals)})`);
    return;
  }
  writeBaseline(next);
  for (const change of changes) console.log(`  ${change}`);
  const { totals, files } = violationTotals(scanned);
  console.log(
    `rust:quality:update: wrote ${BASELINE_PATH} (${changes.length} changes; ${next.crates.size} oversized crates; ${files} violation files; ${totalsText(totals)})`
  );
};

const parseMode = (args: readonly string[]): Mode => {
  let mode: Mode = "check";
  for (const arg of args) {
    if (arg === "--check") mode = "check";
    else if (arg === "--update") mode = "update";
    else if (arg === "--init") mode = "init";
    else {
      console.error(`unknown argument: ${arg}`);
      console.error("usage: rust-quality.ts [--check|--update|--init]");
      process.exit(1);
    }
  }
  return mode;
};

const main = (): void => {
  const mode = parseMode(process.argv.slice(2));
  if (mode === "init") {
    initialize();
    return;
  }
  const scanned = scan();
  const baseline = readBaseline();
  if (mode === "update") update(scanned, baseline);
  else check(scanned, baseline);
};

try {
  main();
} catch (error) {
  console.error(`rust:quality: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
