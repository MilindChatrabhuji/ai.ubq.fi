import assert from "node:assert/strict";
import { test } from "bun:test";

import d465107dLocal from "../docs/sentinel-review-d465107d-local.json";
import backlogText from "../docs/sentinel-review-backlog.md" with { type: "text" };
import pr244Github from "../docs/sentinel-review-pr244-github.json";
import pr246Github from "../docs/sentinel-review-pr246-github.json";
import pr247Github from "../docs/sentinel-review-pr247-github.json";
import pr247Local from "../docs/sentinel-review-pr247-local.json";
import pr248Github from "../docs/sentinel-review-pr248-github.json";
import pr249Github from "../docs/sentinel-review-pr249-github.json";
import pr250Github from "../docs/sentinel-review-pr250-github.json";
import pr250Local from "../docs/sentinel-review-pr250-local.json";

type ReviewFinding = Readonly<{
  fingerprint: string;
  title: string;
  body: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const archivedFindings = (value: unknown): ReviewFinding[] => {
  if (!isRecord(value) || !isRecord(value.report) || !Array.isArray(value.report.findings)) {
    throw new Error("Sentinel review archive has no findings array");
  }
  return value.report.findings.map((finding, index) => {
    if (
      !isRecord(finding) || typeof finding.fingerprint !== "string" || typeof finding.title !== "string" ||
      typeof finding.body !== "string"
    ) {
      throw new Error(`Sentinel review archive finding ${index} is invalid`);
    }
    return { fingerprint: finding.fingerprint, title: finding.title, body: finding.body };
  });
};

const decodeCell = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const backlogFindings = (markdown: string): ReadonlyMap<string, string> => {
  const entries = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length !== 8) throw new Error("Sentinel review backlog row has the wrong number of columns");
    const fingerprint = cells[0]!.slice(1, -1);
    if (entries.has(fingerprint)) throw new Error(`Duplicate Sentinel review backlog fingerprint ${fingerprint}`);
    entries.set(fingerprint, decodeCell(cells[6]!));
  }
  return entries;
};

const normalizedFinding = (finding: ReviewFinding): string => `${finding.title} — ${finding.body}`.trim().replace(/\s+/gu, " ");

const archives = [
  d465107dLocal,
  pr244Github,
  pr246Github,
  pr247Github,
  pr247Local,
  pr248Github,
  pr249Github,
  pr250Github,
  pr250Local,
];

test("Sentinel backlog retains the complete archived finding text", () => {
  const backlog = backlogFindings(backlogText);
  const archived = new Map<string, string>();
  for (const archive of archives) {
    for (const finding of archivedFindings(archive)) {
      const text = normalizedFinding(finding);
      const previous = archived.get(finding.fingerprint);
      if (previous !== undefined) assert.equal(previous, text, `conflicting archived text for ${finding.fingerprint}`);
      archived.set(finding.fingerprint, text);
    }
  }

  for (const [fingerprint, expected] of archived) {
    const actual = backlog.get(fingerprint);
    assert.notEqual(actual, undefined, `archived finding is missing from the backlog for ${fingerprint}`);
    assert.equal(actual, expected, `backlog finding text differs from archived source for ${fingerprint}`);
  }

  const target = "eb2263f930bbad222666b00ac6b0732a8f0a58a6239d6733c92e0b1ab77692c9";
  assert.equal(backlog.get(target), archived.get(target), `backlog must retain archived finding ${target}`);
});
