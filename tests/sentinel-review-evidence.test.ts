import assert from "node:assert/strict";
import { test } from "bun:test";

import backlog from "../docs/sentinel-review-backlog.md" with { type: "text" };
import evidence from "../docs/sentinel-review-evidence/2ab2b39b61e6ae05584349e5a92d9275db1218c2-backlog.txt" with { type: "text" };

const FULL_SHA = /^`[0-9a-f]{40}`$/u;
const FINGERPRINT = /^`[0-9a-f]{64}`$/u;

const markdownRows = (source: string): string[][] =>
  source
    .split("\n")
    .filter((line) => line.startsWith("| `") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
    );

const validateMigratedReviewEvidence = (source: string): void => {
  const reviewTableStart = source.indexOf("| Fingerprint                                                        | Reviewed head SHA");
  assert.ok(reviewTableStart >= 0, "the evidence archive must contain its review identity table");
  const reviewTableEnd = source.indexOf("\n- PR #226", reviewTableStart);
  assert.ok(reviewTableEnd > reviewTableStart, "the review identity table must be bounded");

  const rows = markdownRows(source.slice(reviewTableStart, reviewTableEnd));
  const archiveTableEnd = source.indexOf("\n## Review evidence");
  assert.ok(archiveTableEnd > 0, "the evidence archive must contain its review section");
  const archiveRows = markdownRows(source.slice(0, archiveTableEnd));
  assert.equal(rows.length, archiveRows.length, "every migrated finding must have one review identity row");
  assert.deepEqual(
    rows.map(([fingerprint]) => fingerprint),
    archiveRows.map(([fingerprint]) => fingerprint),
    "review identity rows must cover the archive findings in order"
  );
  for (const [fingerprint, head, base, reviewer] of rows) {
    assert.match(fingerprint, FINGERPRINT);
    assert.match(head, FULL_SHA);
    assert.match(base, FULL_SHA);
    assert.match(reviewer, /^`[^`]+`$/u);
  }
  for (const [index, archiveRow] of archiveRows.entries()) {
    assert.match(archiveRow[4] ?? "", FULL_SHA);
    assert.equal(rows[index]?.[1], archiveRow[4], "the affected SHA must be the exact reviewed head");
  }
  assert.doesNotMatch(
    source.slice(reviewTableStart),
    /\b(?:reviewed (?:head|base)|amended head|over base) \(?`[0-9a-f]{1,39}`/u,
    "review evidence must not use abbreviated reviewed SHAs"
  );
};

test("migrated Sentinel review evidence keeps exact review identities", () => {
  validateMigratedReviewEvidence(evidence);
});

test("migrated Sentinel review evidence rejects abbreviated table SHAs", () => {
  const tableEnd = evidence.indexOf("\n- PR #226");
  const tableShas = Array.from(evidence.slice(0, tableEnd).matchAll(/`[0-9a-f]{40}`/gu));
  assert.ok(tableShas.length > 0, "the committed archive must contain full table SHAs");
  for (const match of tableShas) {
    const offset = match.index;
    const shortened = `${evidence.slice(0, offset)}${match[0].slice(0, 8)}\`${evidence.slice(offset + match[0].length)}`;
    assert.throws(
      () => {
        validateMigratedReviewEvidence(shortened);
      },
      assert.AssertionError,
      `table SHA at offset ${offset}`
    );
  }
});

for (const record of evidence.split("\n").filter((line) => line.startsWith("- PR #"))) {
  const label = record
    .slice(2, record.indexOf("("))
    .trim()
    .replace(/ head$/u, "");
  for (const [index, match] of Array.from(record.matchAll(/`[0-9a-f]{40}`/gu)).entries()) {
    test(`migrated Sentinel review evidence rejects abbreviated ${label} ${index === 0 ? "head" : "base"}`, () => {
      const offset = evidence.indexOf(record) + match.index;
      const shortened = `${evidence.slice(0, offset)}${match[0].slice(0, 8)}\`${evidence.slice(offset + match[0].length)}`;
      assert.throws(() => {
        validateMigratedReviewEvidence(shortened);
      }, assert.AssertionError);
    });
  }
}

test("canonical Sentinel backlog records a full reviewed base for every row", () => {
  const rows = markdownRows(backlog);
  assert.ok(rows.length > 0, "the canonical backlog must not be empty");
  const header = backlog.split("\n").find((line) => line.startsWith("| Fingerprint"));
  assert.match(header ?? "", /Reviewed base SHA/u);
  for (const row of rows) {
    assert.equal(row.length, 9, "canonical backlog rows must include the reviewed base column");
    assert.match(row[5] ?? "", FULL_SHA);
  }
});
