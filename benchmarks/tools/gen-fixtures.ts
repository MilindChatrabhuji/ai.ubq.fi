import { mkdir, writeFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
/**
 * Regenerates the checked-in disposable fixture snapshots under
 * benchmarks/fixtures/<task-id>/ and prints the content-addressed revision
 * for every task manifest.
 *
 * Usage:
 *   bun --no-env-file benchmarks/tools/gen-fixtures.ts
 *
 * This tool writes ONLY under benchmarks/fixtures (disposable snapshots).
 * Fixture trees are deliberately small, toolchain-free text files so that
 * verification commands (sh) and deterministic oracles run anywhere.
 */

const lines = (...ls: string[]): string => ls.join("\n") + "\n";

type FixtureSpec = {
  /** Working-tree files at the fixture root (ignored when `history` is present). */
  files?: Record<string, string>;
  /** Full-tree snapshots committed in order as repository history. */
  history?: Record<string, Record<string, string>>;
};

const SPECS: Record<string, FixtureSpec> = {
  "nav-001": {
    files: {
      "README.txt": lines("# demo", "", "A toy repository for navigation tasks."),
      "docs/guide.txt": lines("## Guide", "", "Short guide."),
      "docs/notes.txt": lines("## Notes", "", "Short notes too."),
      "docs/spec.txt": lines("# Spec", "", ...Array.from({ length: 100 }, (_, i) => `Section ${i + 1}: stable line content for size-based navigation.`)),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "docs/spec.txt" ]'),
    },
  },
  "nav-002": {
    files: {
      "src/a.txt": lines("one harmony_token", "other", "second harmony_token"),
      "src/b.txt": lines("one harmony_token"),
      "src/c.txt": lines("harmony_token", "harmony_token twice harmony_token"),
      "docs/readme.txt": lines("no harmony match here"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "6" ]'),
    },
  },
  "nav-003": {
    files: {
      "config/app.conf": lines("port = 8081"),
      "config/dev.conf": lines("port = 8082"),
      "README.txt": lines("# demo"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "8081" ]'),
    },
  },
  "nav-004": {
    files: {
      "src/mod.txt": lines("def f():", "    return 1"),
      "tests/unit.txt": lines("test_f() -> 1"),
      "docs/example.txt": lines("example"),
      "README.txt": lines("# demo"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "tests" ]'),
    },
  },
  "nav-005": {
    history: {
      "history/init": {
        "README.txt": lines("# demo"),
        "src/app.txt": lines("app v1"),
      },
      "history/add-changelog": {
        "README.txt": lines("# demo"),
        "src/app.txt": lines("app v1"),
        "docs/CHANGELOG.txt": lines("## 1.0", "", "Initial notes."),
      },
      "history/update-changelog": {
        "README.txt": lines("# demo"),
        "src/app.txt": lines("app v1"),
        "docs/CHANGELOG.txt": lines("## 1.1", "", "More notes."),
        "tests/run.sh": lines("#!/bin/sh", "set -e", 'grep -q "^add-changelog$" answer.txt'),
      },
    },
  },
  "code-001": {
    files: {
      "src/config.txt": lines("PORT = 8000"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "grep -q '^PORT = 9000$' src/config.txt"),
    },
  },
  "code-002": {
    files: {
      "src/format.txt": lines("def format_name(first, last):", '    # TODO: return "<last>, <first>"', '    return ""'),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "grep -q 'return last + \", \" + first' src/format.txt"),
    },
  },
  "code-003": {
    files: {
      "src/loop.txt": lines("for i in range(1, max_index):  # prints 1..max_index-1"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "grep -q 'range(1, max_index + 1)' src/loop.txt"),
    },
  },
  "code-004": {
    files: {
      "src/utils.txt": lines("def dup_a():", "    return 1", "", "def dup_b():", "    return 1"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(grep -c "def dup_" src/utils.txt)" -eq 1 ]'),
    },
  },
  "code-005": {
    files: {
      "src/mod.txt": lines("def helper():", "    return 42", "", "# TODO: export helper"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "grep -q '^export helper$' src/mod.txt"),
    },
  },
  "seq-001": {
    files: {
      "notes.txt": lines("alpha", "beta"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "grep -q '^gamma$' notes.txt"),
    },
  },
  "seq-002": {
    files: {
      "data/part-1.txt": lines("item=10"),
      "data/part-2.txt": lines("item=20"),
      "data/part-3.txt": lines("item=20"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "50" ]'),
    },
  },
  "seq-003": {
    files: {
      "src/todo.txt": lines("- [ ] fix the widget"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "grep -q '^- \\[x\\] fix the widget$' src/todo.txt"),
    },
  },
  "seq-004": {
    files: {
      "src/app.txt": lines("app v1"),
      "notes/CHANGES.txt": lines("# Changes"),
      "tests/run.sh": lines(
        "#!/bin/sh",
        "set -e",
        'test -z "$(git status --porcelain)"',
        "grep -q 'added note 1' notes/CHANGES.txt",
        "grep -q 'added note 2' notes/CHANGES.txt"
      ),
    },
  },
  "seq-005": {
    files: {
      "src/sample.txt": lines("hello world"),
      "src/other.txt": lines("keep me"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "grep -q '^hi world$' src/sample.txt", "grep -q '^keep me$' src/other.txt"),
    },
  },
  "fail-001": {
    files: {
      "data/source.txt": lines("the value is 42"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "the value is 42" ]'),
    },
  },
  "fail-002": {
    files: {
      "protected/keep.txt": lines("ORIGINAL"),
      "data/target.txt": lines("target"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat protected/keep.txt)" = "ORIGINAL" ]', '[ "$(cat data/target.txt)" = "changed" ]'),
    },
  },
  "fail-003": {
    files: {
      "data/note.txt": lines("note body"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "note body" ]'),
    },
  },
  "fail-004": {
    files: {
      "data/note.txt": lines("note body"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "note body" ]'),
    },
  },
  "fail-005": {
    files: {
      "src/app.txt": lines("mode=fast"),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "grep -q '^mode=safe$' src/app.txt"),
    },
  },
  "long-001": {
    files: {
      ...Object.fromEntries(["f01", "f02", "f03", "f04", "f05", "f06"].map((f) => [`${f}.txt`, lines("x=0")])),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "for f in f01 f02 f03 f04 f05 f06; do", "  grep -q '^x=1$' \"$f.txt\"", "done"),
    },
  },
  "long-002": {
    files: {
      ...Object.fromEntries(["f01", "f02", "f03", "f04", "f05", "f06", "f07", "f08"].map((f) => [`${f}.txt`, lines("x=0")])),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "for f in f01 f02 f03 f04 f05 f06 f07 f08; do", "  grep -q '^x=1$' \"$f.txt\"", "done"),
    },
  },
  "long-003": {
    files: {
      ...Object.fromEntries(["f01", "f02", "f03", "f04", "f05", "f06", "f07", "f08"].map((f) => [`${f}.txt`, lines("x=0")])),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "for f in f01 f02 f03 f04 f05 f06 f07 f08; do", "  grep -q '^x=1$' \"$f.txt\"", "done"),
    },
  },
  "long-004": {
    files: {
      ...Object.fromEntries(["f01", "f02", "f03", "f04", "f05", "f06"].map((f) => [`${f}.txt`, lines("x=0")])),
      "tests/run.sh": lines("#!/bin/sh", "set -e", "for f in f01 f02 f03 f04 f05 f06; do", "  grep -q '^x=1$' \"$f.txt\"", "done"),
    },
  },
  "long-005": {
    files: {
      ...Object.fromEntries(["1", "2", "3", "4", "5", "6"].map((n) => [`data/v0${n}.txt`, lines(`value=${n}`)])),
      "tests/run.sh": lines("#!/bin/sh", "set -e", '[ "$(cat answer.txt)" = "21" ]'),
    },
  },
};

const FIXTURES_DIR = `${process.cwd()}/benchmarks/fixtures`;

async function writeTree(base: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = `${base}/${rel}`;
    await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, content);
  }
}

/**
 * Code-unit ascending order — the order the bare `.sort()` used to reach by
 * stringifying each entry, stated explicitly so task ids sort by id.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

async function main(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const { computeFixtureRevision } = await import("../fixture.ts");
  const revisions: Record<string, string> = {};
  for (const [taskId, spec] of Object.entries(SPECS).sort(([a], [b]) => compareCodeUnits(a, b))) {
    const dir = `${FIXTURES_DIR}/${taskId}`;
    await mkdir(dir, { recursive: true });
    // Remove any stale snapshot first (generator owns this directory only).
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      await rm(`${dir}/${entry.name}`, { recursive: true });
    }
    if (spec.history) {
      for (const [snap, files] of Object.entries(spec.history)) {
        await writeTree(`${dir}/${snap}`, files);
      }
    }
    if (spec.files) {
      await writeTree(dir, spec.files);
    }
    revisions[taskId] = await computeFixtureRevision(dir);
    console.log(`${taskId}: ${revisions[taskId]}`);
  }
  console.log("\n" + JSON.stringify(revisions));
}

await main();
