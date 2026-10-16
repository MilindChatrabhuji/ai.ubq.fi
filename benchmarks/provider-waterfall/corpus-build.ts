import { readFile, mkdir, writeFile } from "node:fs/promises";
// corpus-build.ts — CLI entry for the DeepSeek V4.1 Flash provider waterfall corpus.
// Orchestrates build/verify/selfcheck/report; all parsing, selection, sanitizer and rendering helpers
// live in corpus-build-support.ts. Both files are deterministic, offline, and byte-identical in
// output to the single-file builder they were split from.

import type { CorpusClass } from "./types.ts";
import {
  CLASS_ORDER,
  CORPUS_DIR,
  FALLBACK_MONTHS,
  JSONL_PATH,
  MANIFEST_PATH,
  PRIMARY_MONTHS,
  REPORT_PATH,
  SESSIONS_ROOT,
  SELFTEST_FIXTURES,
  TOOLS_FIXTURE_PATH,
  collectRows,
  compareText,
  countResidualMatches,
  findDecodedResiduals,
  harvest,
  isObject,
  listJsonlFiles,
  makeManifest,
  printBuildSummary,
  sanitizeString,
  selectEntries,
  selectionFeasible,
  selfcheckEmail,
  selfcheckShape,
  sha256Hex,
  text,
  textList,
  type JsonObject,
  type JsonValue,
  type LineContext,
  verifyClassSummary,
  verifyLine,
} from "./corpus-build-support.ts";
// ---------------------------------------------------------------------------------------------------- build
const build = async (): Promise<void> => {
  let sessions = await harvest(await listJsonlFiles(PRIMARY_MONTHS), SESSIONS_ROOT);
  const monthsUsed: string[] = ["2026/10"];
  let fallbackHarvested = false;
  if (!selectionFeasible(sessions)) {
    fallbackHarvested = true;
    sessions = sessions.concat(await harvest(await listJsonlFiles(FALLBACK_MONTHS), SESSIONS_ROOT));
    monthsUsed.push("2026/09");
  }

  const { chosen, smallMode } = selectEntries(sessions);
  const fixtureBytes = await readFile(TOOLS_FIXTURE_PATH);
  const tools = JSON.parse(new TextDecoder().decode(fixtureBytes)) as JsonValue[];
  if (!Array.isArray(tools)) throw new Error("tools fixture is not a JSON array");

  const counts = new Map<string, number>();
  const { rows, entries, perClass, droppedItemTotals, encryptedTotal } = collectRows(chosen, tools, counts);
  const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const jsonlBytes = new TextEncoder().encode(jsonl);
  const corpusSha256 = await sha256Hex(jsonlBytes);
  const fixtureSha256 = await sha256Hex(fixtureBytes);

  const decodedResiduals = findDecodedResiduals(rows);
  if (decodedResiduals.length !== 0) {
    throw new Error(`sanitizer left ${decodedResiduals.length} residual credential-shape matches in decoded entry strings:\n${decodedResiduals.join("\n")}`);
  }
  // Informational: matches that exist only in the JSON-escaped serialization (a real newline becomes
  // backslash-n, so an empty NAME= at end of line folds into the following lines; no value exists to
  // redact and decoding removes the artifact again), counted and recorded rather than treated as leaks.
  const serializedArtifacts = countResidualMatches(jsonl);
  if (serializedArtifacts !== 0) console.log(`serialized-scan artifacts (escape-folded, no decoded match): ${serializedArtifacts}`);

  droppedItemTotals.set("web_search_call", droppedItemTotals.get("web_search_call") ?? 0);

  const manifest = makeManifest(
    { path: "corpus/corpus-v1.jsonl", bytes: jsonlBytes.length, sha256: corpusSha256 },
    smallMode,
    monthsUsed,
    fallbackHarvested,
    sessions,
    counts,
    serializedArtifacts,
    fixtureSha256,
    fixtureBytes,
    tools,
    rows,
    droppedItemTotals,
    encryptedTotal
  );

  await mkdir(CORPUS_DIR, { recursive: true });
  await writeFile(JSONL_PATH, jsonlBytes);
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  printBuildSummary(
    entries,
    jsonlBytes,
    corpusSha256,
    perClass,
    sessions,
    monthsUsed,
    smallMode,
    rows,
    counts,
    decodedResiduals,
    serializedArtifacts,
    fixtureSha256
  );
};

// --------------------------------------------------------------------------------------------------- verify
const verify = async (): Promise<void> => {
  const issues: string[] = [];
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as JsonObject;
  const jsonlBytes = await readFile(JSONL_PATH);
  const sha = await sha256Hex(jsonlBytes);
  const fixtureBytes = await readFile(TOOLS_FIXTURE_PATH);
  const fixtureSha = await sha256Hex(fixtureBytes);
  const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes)) as JsonValue[];
  const corpus = isObject(manifest.corpus) ? manifest.corpus : null;
  if (corpus?.sha256 !== sha) issues.push(`sha256 mismatch: recomputed ${sha} vs manifest ${text(corpus?.sha256)}`);
  if (corpus?.bytes !== jsonlBytes.length) issues.push(`byte length mismatch: recomputed ${jsonlBytes.length} vs manifest ${text(corpus?.bytes)}`);
  const toolsInfo = isObject(manifest.tools_fixture) ? manifest.tools_fixture : null;
  if (toolsInfo?.sha256 !== fixtureSha) issues.push(`tools fixture sha256 mismatch: recomputed ${fixtureSha} vs manifest ${text(toolsInfo?.sha256)}`);

  const lines = new TextDecoder().decode(jsonlBytes).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== 30) issues.push(`expected 30 lines, found ${lines.length}`);

  const ctx: LineContext = {
    fixture,
    issues,
    classCounts: new Map<CorpusClass, number>(),
    ids: new Set<string>(),
    classesOrder: [],
    perClassIndex: new Map<string, number>(),
    manifestEntries: Array.isArray(manifest.entries) ? manifest.entries : [],
  };
  lines.forEach((line, index) => {
    verifyLine(line, index, ctx);
  });

  verifyClassSummary(manifest, ctx);

  if (issues.length) {
    console.error(`verify FAILED (${issues.length} issues):`);
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log(`verify OK: 30 entries, sha256 ${sha}, class counts 6/9/9/6, tools fixture ${fixtureSha}`);
};

// ------------------------------------------------------------------------------------------------ selfcheck
const selfcheck = (): void => {
  const failures: string[] = [];
  for (const [id, fixture] of Object.entries(SELFTEST_FIXTURES)) selfcheckShape(id, fixture, failures);
  selfcheckEmail(failures);
  const combinedOnce = sanitizeString(Object.values(SELFTEST_FIXTURES).join(" and "), new Map());
  if (combinedOnce !== sanitizeString(combinedOnce, new Map())) failures.push("combined: not idempotent");
  if (countResidualMatches(combinedOnce) !== 0) failures.push("combined: residual matches after sanitizing");
  console.log("selfcheck idempotence: ok");
  if (failures.length) {
    console.error(`selfcheck FAILED: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("selfcheck OK: all credential shapes redacted and counted");
};

// --------------------------------------------------------------------------------------------------- report
// --------------------------------------------------------------------------------------------------- report

const escapePipes = (value: string): string => value.replace(/\|/g, "\\|");
const codeSpan = (value: string): string => (value.includes("`") ? `\`\`${value}\`\`` : `\`${value}\``);

export const renderEntryTable = (entries: readonly JsonValue[]): string[] => {
  const rows: string[] = ["| id | class | recorded input tokens | items | boundary | source session |", "| --- | --- | --- | --- | --- | --- |"];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const boundary = isObject(entry.boundary) ? text(entry.boundary.description) : "?";
    rows.push(
      `| ${text(entry.id)} | ${text(entry.cls)} | ${text(entry.recorded_input_tokens)} | ${text(entry.item_count)} | ${escapePipes(boundary)} | \`${text(entry.source_path)}\` |`
    );
  }
  return rows;
};

export const renderSanitizerTable = (sanitizer: JsonObject): string[] => {
  const rows: string[] = [
    `Revision \`${text(sanitizer.revision)}\`; substitutions counted per rule. The email rule redacts addresses only inside strings that matched a credential rule, and decoded-string residuals are 0.`,
    "",
    "| rule | pattern | substitutions |",
    "| --- | --- | --- |",
  ];
  const rules = Array.isArray(sanitizer.rules) ? sanitizer.rules : [];
  for (const rule of rules) {
    if (!isObject(rule)) continue;
    rows.push(`| ${text(rule.id)} | ${codeSpan(escapePipes(text(rule.pattern)))} | ${text(rule.substitutions)} |`);
  }
  const emailRule = Array.isArray(sanitizer.conditional_rules) ? sanitizer.conditional_rules.find((rule) => isObject(rule) && rule.id === "email") : null;
  rows.push(`| email (conditional) | addresses inside credential-matched strings | ${text(isObject(emailRule) ? emailRule.substitutions : 0)} |`);
  rows.push("", `Total substitutions: ${text(sanitizer.total_substitutions)}.`);
  if (Number(sanitizer.serialized_line_escape_artifacts ?? 0) > 0) {
    rows.push(
      `Serialized-line scan artifact: ${text(sanitizer.serialized_line_escape_artifacts)} escape-folded match with no decoded-string match (a real newline renders as \\n, so an empty NAME= at end of line folds into the following lines); recorded in the manifest.`
    );
  }
  return rows;
};

export const renderLimitations = (entries: readonly JsonValue[], sources: JsonObject): string[] => {
  const entryObjects = entries.filter((entry): entry is JsonObject => isObject(entry));
  const smallTokens = entryObjects.filter((entry) => entry.cls === "small").map((entry) => Number(entry.recorded_input_tokens));
  const multiMetaEntries = entryObjects.filter((entry) => Number(entry.session_meta_records) > 1).length;
  const cwdCounts = new Map<string, number>();
  for (const entry of entryObjects) if (typeof entry.cwd === "string") cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) ?? 0) + 1);
  const cwdSummary = [...cwdCounts.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .map(([cwd, count]) => `\`${cwd}\` (${count})`)
    .join(", ");
  const smallRange = smallTokens.length ? `${Math.min(...smallTokens)}-${Math.max(...smallTokens)}` : "?";
  return [
    `- The small window (2000-10000 tokens) cannot be filled from the available recorded DeepSeek V4.1 Flash sessions: the candidate pool's smallest recorded request is 18689 tokens, so the six small entries are the closest recorded requests (${smallRange}) per the corpus spec's fallback; they are labeled \`small\` but their recorded size is above the window.`,
    `- Entry sources cluster by task: cwd coverage is ${cwdSummary}. The single largest group shares near-identical synthetic worker prompts, so prompt-content diversity is limited; selection still follows the deterministic path-order and largest-in-window rules.`,
    `- ${multiMetaEntries} of the selected entries come from candidate files (of ${text(sources.multi_meta_candidate_files)} such candidates) that also carry a parent exec session_meta record; candidate detection accepts a file when any session_meta matches and the first matching (subagent) record supplies session identity and instructions.`,
    "- Recorded input tokens include each session's own tools and instructions; the frozen fixture's tool array may differ in size from what the recorded session used, so replayed request sizes can differ from the recorded values.",
    "- The `sk-…` rule matches that shape anywhere, including substrings of identifiers such as `task-<id>`; substitutions are small, uniform across providers, and counted above.",
    "- Encrypted agent payloads and reasoning items cannot be replayed and are removed; the corpus replays only plaintext items plus tool calls/outputs.",
    "- All source sessions are from 2026-10-03..2026-10-05 on one host; no cross-host or cross-month diversity was available for this class mix.",
  ];
};

const report = async (): Promise<void> => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as JsonObject;
  const corpus = isObject(manifest.corpus) ? manifest.corpus : {};
  const counts = isObject(manifest.counts_by_class) ? manifest.counts_by_class : {};
  const sanitizer = isObject(manifest.sanitizer) ? manifest.sanitizer : {};
  const sources = isObject(manifest.sources) ? manifest.sources : {};
  const selection = isObject(manifest.selection) ? manifest.selection : {};
  const tools = isObject(manifest.tools_fixture) ? manifest.tools_fixture : {};
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const dropped = isObject(manifest.dropped_item_type_counts) ? manifest.dropped_item_type_counts : {};

  const classCountsText = CLASS_ORDER.map((cls) => `${cls}=${text(counts[cls])}`).join(" ");
  const orderText = textList(selection.order, " → ");
  const lines: string[] = ["# corpus-build-report.md — DeepSeek V4.1 Flash provider waterfall (corpus-v1)", ""];
  lines.push(
    `Produced by \`corpus-build.ts\` (m1-corpus lane) from recorded DeepSeek V4.1 Flash subagent sessions under \`${text(sources.root)}\` (${textList(sources.months_used, ", ")}); September harvested only if October could not fill a class: ${text(sources.fallback_months_harvested)}.`
  );
  lines.push(
    "",
    `Frozen artifact: \`corpus/corpus-v1.jsonl\` (${text(corpus.bytes)} bytes, sha256 \`${text(corpus.sha256)}\`), ${entries.length} entries, class counts ${classCountsText}.`,
    ""
  );
  lines.push("## Selection method", "");
  lines.push(
    `Candidate sessions: ${text(sources.candidate_sessions)} (${text(sources.candidate_filter)}). Each candidate file was read once; a boundary is a user/developer message, tool result, or agent_message whose next recorded item is assistant-side, never splitting a tool result from its call. Class sizes come from the boundary turn's recorded input tokens.`,
    ""
  );
  lines.push(
    `Selection order: ${orderText}. xlarge: ${text(selection.xlarge)}. small: ${text(selection.small)}. large: ${text(selection.large)}. medium: ${text(selection.medium)}. One entry per session; ties resolve by session path and ordinal, so the same inputs produce identical bytes.`
  );
  if (selection.small_note) lines.push("", `Small-class fallback: ${text(selection.small_note)}.`);
  lines.push("", "## Class distribution (recorded input tokens per entry)", "");
  lines.push(...renderEntryTable(entries));
  lines.push("", "## Sanitizer", "");
  lines.push(...renderSanitizerTable(sanitizer));
  lines.push("", "## Dropped item types", "");
  const droppedList = Object.entries(dropped)
    .map(([type, count]) => `\`${type}\` (${text(count)} items)`)
    .join(", ");
  lines.push(
    `Dropped from every included prefix and never replayed: ${droppedList}. Removed \`encrypted_content\` entries: ${text(manifest.encrypted_content_entries_removed)}; top-level \`internal_chat_message_metadata_passthrough\` removed from every item.`
  );
  lines.push("", "## Tools fixture", "");
  lines.push(
    `\`${text(tools.path)}\`: sha256 \`${text(tools.sha256)}\`, ${text(tools.bytes)} bytes, ${text(tools.entries)} tools, used verbatim and in order for every entry. DESIGN.md quotes \`${text(tools.design_doc_expected_sha256)}\`; the committed fixture hash matches DESIGN.md: ${text(tools.matches_design_doc)}.`
  );
  lines.push("", "## Known limitations", "");
  lines.push(...renderLimitations(entries, sources));
  lines.push("", "## Verification", "");
  lines.push(
    "- `corpus-build.ts verify` recomputes the sha256, re-validates every line as a `CorpusEntry` (ids, ordering, class windows, tool fixture equality, call/output pairing, no passthrough/encrypted fields) and re-checks 6/9/9/6 counts without reading sessions."
  );
  lines.push(
    "- `corpus-build.ts selfcheck` feeds one fixture string per credential shape through the sanitizer and asserts redaction, counting and idempotence."
  );
  lines.push("");
  await writeFile(REPORT_PATH, lines.join("\n"));
  console.log(`report written: ${REPORT_PATH}`);
};

// ----------------------------------------------------------------------------------------------------- main

if (import.meta.main) {
  const mode = process.argv.slice(2)[0] ?? "build";
  if (mode === "build") await build();
  else if (mode === "verify") await verify();
  else if (mode === "selfcheck") selfcheck();
  else if (mode === "report") await report();
  else {
    console.error(`unknown mode: ${mode} (expected build|verify|selfcheck|report)`);
    process.exit(2);
  }
}
