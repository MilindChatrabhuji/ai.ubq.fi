import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciScopeForSelection,
  classifyChangedPaths,
  formatScopeMessage,
  isDocumentationPath,
  isTestPath,
  selectAffectedTestFiles,
  testRequiresNativeKv,
} from "./test-scope.ts";

const fixture = mkdtempSync(join(tmpdir(), "uos-test-scope-"));
mkdirSync(join(fixture, "src"));
mkdirSync(join(fixture, "src/storage"));
mkdirSync(join(fixture, "tests"));
writeFileSync(join(fixture, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(fixture, "src/b.ts"), "export const b = 1;\n");
writeFileSync(join(fixture, "src/unused.ts"), "export const unused = 1;\n");
writeFileSync(join(fixture, "src/consumer.ts"), "import { a } from './a.ts';\nexport const consumer = a;\n");
writeFileSync(join(fixture, "tests/a.test.ts"), "import '../src/consumer.ts';\n");
writeFileSync(join(fixture, "tests/b.test.ts"), "import '../src/b.ts';\n");
writeFileSync(join(fixture, "src/storage/kv.ts"), "export const kv = 1;\n");
writeFileSync(join(fixture, "src/storage-consumer.ts"), "import './storage/kv.ts';\n");
writeFileSync(join(fixture, "tests/storage.test.ts"), "import '../src/storage-consumer.ts';\n");

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("test scope", () => {
  test("selects only tests whose imports reach the changed source file", () => {
    expect(selectAffectedTestFiles(["src/a.ts"], ["tests/a.test.ts", "tests/b.test.ts"], fixture)).toEqual(["tests/a.test.ts"]);
  });

  test("skips testing when no candidate test reaches the change", () => {
    expect(selectAffectedTestFiles(["src/unused.ts"], ["tests/a.test.ts", "tests/b.test.ts"], fixture)).toEqual([]);
  });

  test("detects whether selected tests need the native KV artifact", () => {
    expect(testRequiresNativeKv("tests/a.test.ts", fixture)).toBe(false);
    expect(testRequiresNativeKv("tests/storage.test.ts", fixture)).toBe(true);
  });

  test("classifies documentation separately from executable changes", () => {
    expect(classifyChangedPaths(["AGENTS.md", "docs/runtime.mdx"]).documentationOnly).toBe(true);
    expect(classifyChangedPaths(["AGENTS.md", "src/http.ts"]).documentationOnly).toBe(false);
    expect(isDocumentationPath("docs/guide.MDX")).toBe(true);
    expect(isDocumentationPath("docs/openapi.json")).toBe(false);
  });

  test("recognizes test files and echoes the dependency-scoped instructions", () => {
    expect(isTestPath("tests/example.test.ts")).toBe(true);
    expect(isTestPath("src/http.ts")).toBe(false);
    const message = formatScopeMessage(
      {
        paths: ["src/http.ts"],
        documentationOnly: false,
        affectedTests: ["tests/http.test.ts"],
        runAll: false,
        reason: "selected",
      },
      "bun test"
    );
    expect(message).toContain("TEST SCOPE: 1 affected test file(s)");
    expect(message).toContain("  - tests/http.test.ts");
    expect(message).toContain("TEST_SCOPE_FORCE=1");
  });

  test("derives CI capability flags from the same selection", () => {
    const base = { paths: ["src/http.ts"], documentationOnly: false, runAll: false, reason: "selected" as const };
    expect(ciScopeForSelection({ ...base, affectedTests: ["tests/a.test.ts"] }, fixture)).toMatchObject({
      docsOnly: false,
      needsValidate: true,
      needsNativeKv: false,
      needsNativeBuild: true,
      needsArtifact: true,
    });
    expect(ciScopeForSelection({ ...base, affectedTests: ["tests/storage.test.ts"] }, fixture).needsNativeKv).toBe(true);
    expect(ciScopeForSelection({ ...base, paths: ["src/storage/kv.ts"], affectedTests: ["tests/storage.test.ts"] }, fixture).needsNativeKv).toBe(true);
    expect(
      ciScopeForSelection(
        {
          paths: ["AGENTS.md"],
          documentationOnly: true,
          affectedTests: [],
          runAll: false,
          reason: "documentation-only",
        },
        fixture
      )
    ).toMatchObject({
      docsOnly: true,
      needsValidate: false,
      needsNativeKv: false,
      needsNativeBuild: false,
      needsArtifact: false,
    });
  });

  test("a test-only change schedules native CI for its transitive KV imports without producing an artifact", () => {
    const paths = ["tests/storage.test.ts"];
    const selected = selectAffectedTestFiles(paths, ["tests/a.test.ts", "tests/storage.test.ts"], fixture);
    expect(selected).toEqual(paths);
    expect(ciScopeForSelection({ paths, affectedTests: selected, documentationOnly: false, runAll: false, reason: "selected" }, fixture)).toMatchObject({
      needsValidate: true,
      needsNativeKv: true,
      needsNativeBuild: true,
      needsArtifact: false,
      needsMacContainment: false,
      needsDarwinNative: false,
    });
  });

  test("portable test and documentation changes do not inherit native requirements from unselected tests", () => {
    const paths = ["tests/a.test.ts"];
    const selected = selectAffectedTestFiles(paths, ["tests/a.test.ts", "tests/storage.test.ts"], fixture);
    expect(selected).toEqual(paths);
    const portable = ciScopeForSelection({ paths, affectedTests: selected, documentationOnly: false, runAll: false, reason: "selected" }, fixture);
    expect(portable).toMatchObject({ needsNativeKv: false, needsNativeBuild: false, needsArtifact: false });
    const docs = ciScopeForSelection(
      { paths: ["docs/runtime.md"], affectedTests: [], documentationOnly: true, runAll: false, reason: "documentation-only" },
      fixture
    );
    expect(docs).toMatchObject({ docsOnly: true, needsValidate: false, needsNativeKv: false, needsNativeBuild: false, needsArtifact: false });
  });
});
