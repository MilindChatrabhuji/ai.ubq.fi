import { afterAll, describe, expect, test } from "bun:test";
import { parse } from "@std/yaml";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciScopeForSelection,
  classifyChangedPaths,
  formatScopeMessage,
  isDocumentationPath,
  isTestPath,
  ROOT,
  selectAffectedTestFiles,
  testRequiresNativeKv,
  type TestSelection,
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
writeFileSync(join(fixture, "docs.md"), "# Documentation\n");
writeFileSync(join(fixture, "tests/docs.test.ts"), "import docs from '../docs.md' with { type: 'text' };\nexport default docs;\n");
writeFileSync(join(fixture, "tests/storage.test.ts"), "import '../src/storage-consumer.ts';\n");

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

const docsSelection: TestSelection = {
  paths: ["AGENTS.md"],
  documentationOnly: true,
  affectedTests: [],
  runAll: false,
  reason: "documentation-only",
};
const sourceSelection: TestSelection = {
  paths: ["scripts/test-scope.test.ts"],
  documentationOnly: false,
  affectedTests: ["scripts/test-scope.test.ts"],
  runAll: false,
  reason: "selected",
};
const ciContext = (event: string, base = "", author = ""): NodeJS.ProcessEnv => ({
  GITHUB_EVENT_NAME: event,
  GITHUB_BASE_REF: base,
  GITHUB_PR_AUTHOR: author,
});
const protectedContexts = [
  ciContext("merge_group"),
  ciContext("pull_request", "queue-canary", "owner"),
  ciContext("pull_request", "development", "ubiquity-sentinel[bot]"),
  { ...ciContext("push"), GITHUB_REF: "refs/heads/development" },
];
const scopeCommand = (args: readonly string[], context: NodeJS.ProcessEnv, paths = "AGENTS.md") =>
  spawnSync(process.execPath, ["--no-env-file", "--no-install", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      TMPDIR: fixture,
      TEST_SCOPE_PATHS: paths,
      TEST_SCOPE_IGNORE_UNTRACKED: "1",
      ...context,
    },
  });

describe("Sentinel complete CI check set", () => {
  test("admits all real jobs without widening documentation or source test selection", () => {
    for (const context of protectedContexts) {
      for (const selection of [docsSelection, sourceSelection]) {
        expect(ciScopeForSelection(selection, ROOT, context)).toMatchObject({
          ...selection,
          completeCheckSet: true,
          docsOnly: selection.documentationOnly,
          needsDocs: true,
          needsValidate: true,
          needsNativeKv: false,
          needsNativeBuild: true,
          needsMacContainment: true,
          needsDarwinNative: true,
          needsDarwinTests: false,
          needsArtifact: true,
        });
      }
    }
  });

  test("protected complete jobs retain transitive selected-test native admission", () => {
    const selection: TestSelection = {
      paths: ["tests/storage.test.ts"],
      documentationOnly: false,
      affectedTests: selectAffectedTestFiles(["tests/storage.test.ts"], ["tests/a.test.ts", "tests/storage.test.ts"], fixture),
      runAll: false,
      reason: "selected",
    };
    for (const context of protectedContexts) {
      expect(ciScopeForSelection(selection, fixture, context)).toMatchObject({
        ...selection,
        completeCheckSet: true,
        needsDocs: true,
        needsValidate: true,
        needsNativeKv: true,
        needsNativeBuild: true,
        needsMacContainment: true,
        needsDarwinNative: true,
        needsDarwinTests: false,
        needsArtifact: true,
      });
    }
  });

  test("uses exact event, base and PR author rather than actor or branch names", () => {
    const ordinaryContexts = [
      {},
      ciContext("unknown", "queue-canary", "ubiquity-sentinel[bot]"),
      ciContext("push", "development", "ubiquity-sentinel[bot]"),
      { ...ciContext("push"), GITHUB_REF: "refs/heads/development-extra" },
      { ...ciContext("push"), GITHUB_REF: "refs/tags/development" },
      { ...ciContext("push"), GITHUB_REF: "development" },
      { ...ciContext("workflow_dispatch"), GITHUB_REF: "refs/heads/development" },
      ciContext("workflow_dispatch", "queue-canary", "ubiquity-sentinel[bot]"),
      ciContext("pull_request_target", "queue-canary", "ubiquity-sentinel[bot]"),
      ciContext("pull_request", "queue-canary-extra", "owner"),
      ciContext("pull_request", "development", "ubiquity-sentinel"),
      ciContext("pull_request", "development", "ubiquity-sentinel[bot]-extra"),
      ciContext("pull_request", "development", ""),
      ciContext("pull_request", "other", "ubiquity-sentinel[bot]"),
      { ...ciContext("pull_request", "development", "owner"), GITHUB_ACTOR: "ubiquity-sentinel[bot]", GITHUB_HEAD_REF: "queue-canary" },
    ];
    for (const context of ordinaryContexts) {
      expect(ciScopeForSelection(docsSelection, ROOT, context)).toEqual(ciScopeForSelection(docsSelection, ROOT, {}));
      expect(ciScopeForSelection(sourceSelection, ROOT, context)).toEqual(ciScopeForSelection(sourceSelection, ROOT, {}));
      expect(ciScopeForSelection(docsSelection, ROOT, context)).toMatchObject({ completeCheckSet: false, needsDocs: true, needsValidate: false });
      expect(ciScopeForSelection(sourceSelection, ROOT, context)).toMatchObject({ completeCheckSet: false, needsDocs: false, needsDarwinNative: false });
    }
    expect(
      ciScopeForSelection(sourceSelection, ROOT, { ...ciContext("pull_request", "development", "ubiquity-sentinel[bot]"), GITHUB_ACTOR: "owner" })
        .completeCheckSet
    ).toBe(true);
  });

  test("still builds artifacts for protected no-base and no-changes selections", () => {
    for (const reason of ["no-base", "no-changes"] as const) {
      const selection = { paths: [], documentationOnly: false, affectedTests: [], runAll: true, reason };
      expect(ciScopeForSelection(selection, ROOT, protectedContexts[0])).toMatchObject({ needsDocs: true, needsArtifact: true, runAll: true, reason });
      expect(ciScopeForSelection(selection, ROOT, {})).toMatchObject({ needsDocs: false, needsArtifact: false });
    }
  });

  test("exercises exact CI-policy changes on owner development PRs without admitting similar paths or other contexts", () => {
    const owner = ciContext("pull_request", "development", "owner");
    for (const path of [".github/workflows/deno-deploy.yml", "scripts/test-scope.ts"]) {
      const selection = { ...sourceSelection, paths: [path] };
      expect(ciScopeForSelection(selection, ROOT, owner)).toMatchObject({ ...selection, completeCheckSet: true, needsDocs: true, needsArtifact: true });
      for (const context of [
        ciContext("pull_request", "development-extra", "owner"),
        ciContext("push", "development", "owner"),
        ciContext("unknown", "development", "owner"),
      ]) {
        expect(ciScopeForSelection(selection, ROOT, context).completeCheckSet).toBe(false);
      }
    }
    for (const path of [
      ".github/workflows/deno-deploy.yml.backup",
      ".github/workflows/other.yml",
      "nested/.github/workflows/deno-deploy.yml",
      "scripts/test-scope.ts.backup",
      "nested/scripts/test-scope.ts",
      "scripts/test-scope.test.ts",
    ]) {
      expect(ciScopeForSelection({ ...sourceSelection, paths: [path] }, ROOT, owner).completeCheckSet).toBe(false);
    }
  });

  test("retains native and Darwin explicit-test eligibility only for the original capability paths", () => {
    const native = { ...sourceSelection, paths: ["src/storage/kv.ts"] };
    const darwin = { ...sourceSelection, paths: ["tests/gpg-dsh.test.ts"] };
    expect(ciScopeForSelection(native, ROOT, protectedContexts[0])).toMatchObject({ needsNativeKv: true, needsDarwinTests: false });
    expect(ciScopeForSelection(darwin, ROOT, protectedContexts[0])).toMatchObject({ needsDarwinTests: true });
  });

  test("real CI JSON and wrappers keep protected docs scoped to zero tests", () => {
    for (const context of protectedContexts) {
      const ci = scopeCommand(["scripts/test-scope.ts", "--ci-json"], context);
      expect(ci.status).toBe(0);
      expect(JSON.parse(ci.stdout)).toMatchObject({ ...docsSelection, completeCheckSet: true, needsDocs: true, needsArtifact: true });
      const runner = scopeCommand(["scripts/test-runner.ts", "quality", "--list"], context);
      expect(runner.status).toBe(0);
      expect(runner.stdout).toContain("TEST EXECUTION INTENTIONALLY SKIPPED");
      const verify = spawnSync("/bin/sh", ["scripts/verify.sh", "--no-native-kv"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: process.env.PATH, TMPDIR: fixture, TEST_SCOPE_PATHS: "AGENTS.md", TEST_SCOPE_IGNORE_UNTRACKED: "1", ...context },
      });
      expect(verify.status).toBe(0);
      expect(verify.stdout).toContain("TEST EXECUTION INTENTIONALLY SKIPPED");
      expect(verify.stdout).not.toContain("==> native KV");
    }
  });

  test("real source CI JSON and runner preserve the same affected profile files", () => {
    const ordinary = scopeCommand(["scripts/test-runner.ts", "quality", "--list"], {}, sourceSelection.paths[0]);
    expect(ordinary.status).toBe(0);
    expect(JSON.parse(ordinary.stdout)).toEqual([{ profile: "quality", files: sourceSelection.affectedTests, environment: ["PATH"] }]);
    for (const context of protectedContexts) {
      const ci = scopeCommand(["scripts/test-scope.ts", "--ci-json"], context, sourceSelection.paths[0]);
      expect(ci.status).toBe(0);
      expect(JSON.parse(ci.stdout)).toMatchObject({ ...sourceSelection, completeCheckSet: true, needsDarwinTests: false, needsArtifact: true });
      const runner = scopeCommand(["scripts/test-runner.ts", "quality", "--list"], context, sourceSelection.paths[0]);
      expect(runner.status).toBe(0);
      expect(runner.stdout).toBe(ordinary.stdout);
    }
  });

  test("real owner CI-policy changes preserve the selector and runner's existing affected-file scope", () => {
    const owner = ciContext("pull_request", "development", "owner");
    const ordinary = ciContext("pull_request", "other", "owner");
    for (const path of [".github/workflows/deno-deploy.yml", "scripts/test-scope.ts"]) {
      const baseline = scopeCommand(["scripts/test-scope.ts", "--ci-json"], ordinary, path);
      const complete = scopeCommand(["scripts/test-scope.ts", "--ci-json"], owner, path);
      expect(baseline.status).toBe(0);
      expect(complete.status).toBe(0);
      const { paths, documentationOnly, affectedTests, runAll, reason, needsNativeKv } = JSON.parse(baseline.stdout) as TestSelection & {
        needsNativeKv: boolean;
      };
      expect(JSON.parse(complete.stdout)).toMatchObject({
        paths,
        documentationOnly,
        affectedTests,
        runAll,
        reason,
        completeCheckSet: true,
        needsNativeKv,
        needsDarwinTests: false,
        needsArtifact: true,
      });
      const baselineRunner = scopeCommand(["scripts/test-runner.ts", "quality", "--list"], ordinary, path);
      const completeRunner = scopeCommand(["scripts/test-runner.ts", "quality", "--list"], owner, path);
      expect(baselineRunner.status).toBe(0);
      expect(completeRunner.status).toBe(0);
      expect(completeRunner.stdout).toBe(baselineRunner.stdout);
    }
  });

  test("development push wrappers use the actual before-to-head diff when the fetched development ref already equals HEAD", () => {
    const repository = mkdtempSync(join(fixture, "push-"));
    mkdirSync(join(repository, "scripts"));
    for (const path of ["test-scope.ts", "verify.sh", "_bootstrap.sh"]) {
      copyFileSync(join(ROOT, "scripts", path), join(repository, "scripts", path));
    }
    const git = (...args: string[]): string => {
      const result = spawnSync("/usr/bin/git", args, {
        cwd: repository,
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (result.status !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    const commit = () => git("-c", "user.name=CI fixture", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    git("init", "--quiet");
    git("add", ".");
    commit();
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(repository, "README.md"), "# Changed documentation\n");
    git("add", "README.md");
    commit();
    git("update-ref", "refs/remotes/origin/development", "HEAD");
    const environment = {
      PATH: process.env.PATH,
      TMPDIR: fixture,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/development",
      TEST_SCOPE_IGNORE_UNTRACKED: "1",
    };
    const readScope = (eventBefore?: string) =>
      spawnSync(process.execPath, ["--no-env-file", "--no-install", "scripts/test-scope.ts", "--ci-json"], {
        cwd: repository,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...environment, GITHUB_EVENT_BEFORE: eventBefore },
      });
    const scoped = readScope(before);
    const missingBefore = readScope();
    expect(scoped.status).toBe(0);
    expect(JSON.parse(scoped.stdout)).toMatchObject({
      paths: ["README.md"],
      reason: "documentation-only",
      runAll: false,
      affectedTests: [],
      completeCheckSet: true,
      needsArtifact: true,
    });
    expect(missingBefore.status).toBe(0);
    expect(JSON.parse(missingBefore.stdout)).toMatchObject({ paths: [], reason: "no-changes", runAll: true });
    const verify = spawnSync("/bin/sh", ["scripts/verify.sh", "--no-native-kv"], {
      cwd: repository,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...environment, GITHUB_EVENT_BEFORE: before },
    });
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain("TEST EXECUTION INTENTIONALLY SKIPPED");
    expect(verify.stdout).not.toContain("==> native KV");
  });

  test("workflow binds PR author and runs the real jobs while preserving test and deployment boundaries", () => {
    type Step = { name?: string; run?: string; if?: string };
    const workflow = parse(readFileSync(join(ROOT, ".github/workflows/deno-deploy.yml"), "utf8")) as {
      jobs: Record<string, { if?: string; env?: Record<string, string>; outputs?: Record<string, string>; steps: Step[] }>;
      env?: Record<string, string>;
      concurrency: { group: string; "cancel-in-progress": string };
    };
    const { jobs } = workflow;
    expect(workflow.env?.GITHUB_EVENT_BEFORE).toBe("${{ github.event.before }}");
    expect(Object.values(jobs).every((job) => job.env?.GITHUB_EVENT_BEFORE === undefined)).toBe(true);
    const jobNames = Object.keys(jobs).sort((left, right) => left.localeCompare(right));
    expect(jobNames).toEqual(["darwin-native", "docs", "mac-containment", "native", "rust-native", "rust-wasm", "scope", "validate", "verify-artifact"]);
    expect(jobs.scope.env?.GITHUB_PR_AUTHOR).toBe("${{ github.event.pull_request.user.login }}");
    for (const output of [
      "needs_docs",
      "needs_validate",
      "needs_native",
      "needs_native_build",
      "needs_mac",
      "needs_darwin",
      "needs_darwin_tests",
      "needs_artifact",
      "needs_typescript_validate",
      "needs_rust_native",
      "needs_rust_wasm",
      "needs_rust_build",
    ]) {
      expect(jobs.scope.outputs?.[output]).toBe(`\${{ steps.scope.outputs.${output} }}`);
    }
    const scopeStep = jobs.scope.steps.find((step) => step.name === "Determine changed-path test scope")?.run ?? "";
    expect(scopeStep).toContain("scripts/test-scope.ts --ci-json");
    expect(scopeStep).toContain("'.needsDocs'");
    expect(scopeStep).toContain("'.needsDarwinTests'");
    expect(jobs.docs.if).toBe("${{ needs.scope.outputs.needs_docs == 'true' }}");
    expect(jobs.native.steps.find((step) => step.name === "Preflight deployment and immutable release fixtures")?.if).toBe(
      "${{ needs.scope.outputs.needs_native == 'true' }}"
    );
    expect(jobs["darwin-native"].steps.find((step) => step.name === "Sandboxed-signing helper on its macOS target")?.if).toBe(
      "${{ needs.scope.outputs.needs_darwin_tests == 'true' }}"
    );
    expect(jobs["verify-artifact"].if).toContain("needs.validate.result == 'success' && needs.native.result == 'success'");
    expect(jobs["mac-containment"].steps.some((step) => step.run?.includes("ops/verify-mac-sandbox.ts"))).toBe(true);
    expect(jobs["darwin-native"].steps.some((step) => step.run?.includes('await kv.set(["darwin-native"]'))).toBe(true);
    expect(jobs["verify-artifact"].steps.some((step) => step.run?.includes("await verifyReleasePayload("))).toBe(true);
    const commands = Object.values(jobs)
      .flatMap((job) => job.steps.map((step) => step.run ?? ""))
      .join("\n");
    expect(commands).not.toContain("TEST_SCOPE_FORCE");
    expect(commands).not.toMatch(/(?:run deploy:|ops\/deploy(?:-mac)?\.ts|(?:cf|wrangler)\s+(?:deploy|publish))/);
    expect(jobs["rust-native"].if).toBe("${{ needs.scope.outputs.needs_rust_native == 'true' }}");
    expect(jobs["rust-wasm"].if).toBe("${{ needs.scope.outputs.needs_rust_wasm == 'true' }}");
    expect(jobs["rust-native"].steps.some((step) => step.run?.includes("scripts/rust-verify.ts --stage native"))).toBe(true);
    expect(jobs["rust-wasm"].steps.some((step) => step.run?.includes("scripts/rust-verify.ts --stage wasm"))).toBe(true);
    const requiredRust = jobs.validate.steps.find((step) => step.name === "Require every selected Rust gate")?.run ?? "";
    expect(requiredRust).toContain('test "$RUST_NATIVE_RESULT" = success');
    expect(requiredRust).toContain('test "$RUST_WASM_RESULT" = success');
    for (const result of ["failure", "cancelled", "skipped"]) {
      const rejected = spawnSync("/bin/sh", ["-c", requiredRust], {
        env: { RUST_NATIVE_REQUIRED: "true", RUST_NATIVE_RESULT: result, RUST_WASM_REQUIRED: "false", RUST_WASM_RESULT: "skipped" },
      });
      expect(rejected.status).not.toBe(0);
    }
    const accepted = spawnSync("/bin/sh", ["-c", requiredRust], {
      env: { RUST_NATIVE_REQUIRED: "true", RUST_NATIVE_RESULT: "success", RUST_WASM_REQUIRED: "true", RUST_WASM_RESULT: "success" },
    });
    expect(accepted.status).toBe(0);
    expect(workflow.concurrency.group).toContain("github.event_name == 'push' || github.event_name == 'merge_group'");
    expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name != 'push' && github.event_name != 'merge_group' }}");
  });
});

describe("test scope", () => {
  test("selects only tests whose imports reach the changed source file", () => {
    expect(selectAffectedTestFiles(["src/a.ts"], ["tests/a.test.ts", "tests/b.test.ts"], fixture)).toEqual(["tests/a.test.ts"]);
  });

  test("does not parse non-code assets reached by text imports", () => {
    expect(selectAffectedTestFiles(["docs.md"], ["tests/docs.test.ts"], fixture)).toEqual(["tests/docs.test.ts"]);
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

describe("Rust changed-path CI selection", () => {
  test("Rust-only source gets both Rust gates without unrelated TypeScript tests", () => {
    const ci = scopeCommand(["scripts/test-scope.ts", "--ci-json"], {}, "rust/crates/gateway-core/src/state.rs");
    expect(ci.status).toBe(0);
    expect(JSON.parse(ci.stdout)).toMatchObject({
      paths: ["rust/crates/gateway-core/src/state.rs"],
      affectedTests: [],
      runAll: false,
      needsValidate: true,
      needsTypeScriptValidate: false,
      needsRustNative: true,
      needsRustWasm: true,
      needsRustBuild: true,
      needsNativeKv: false,
      needsNativeBuild: false,
      needsArtifact: false,
    });
  });

  test("Rust documentation stays documentation-only on an ordinary PR", () => {
    const ci = scopeCommand(["scripts/test-scope.ts", "--ci-json"], {}, "rust/README.md");
    expect(ci.status).toBe(0);
    expect(JSON.parse(ci.stdout)).toMatchObject({
      documentationOnly: true,
      affectedTests: [],
      needsDocs: true,
      needsValidate: false,
      needsRustNative: false,
      needsRustWasm: false,
    });
  });

  test("workflow data dependency selects its contract rather than all TypeScript tests", () => {
    const ci = scopeCommand(["scripts/test-scope.ts", "--ci-json"], {}, ".github/workflows/deno-deploy.yml");
    expect(ci.status).toBe(0);
    expect(JSON.parse(ci.stdout).affectedTests).toEqual(["scripts/test-scope.test.ts"]);
  });

  test("complete contexts schedule real Rust jobs without changing documentation test selection", () => {
    for (const context of protectedContexts) {
      expect(ciScopeForSelection(docsSelection, ROOT, context)).toMatchObject({
        completeCheckSet: true,
        affectedTests: [],
        needsRustNative: true,
        needsRustWasm: true,
        needsRustBuild: true,
      });
    }
  });
});

test("native-only companion source does not schedule a WASM compilation on ordinary PRs", () => {
  const ci = scopeCommand(["scripts/test-scope.ts", "--ci-json"], {}, "rust/crates/gateway-native/src/lib.rs");
  expect(ci.status).toBe(0);
  expect(JSON.parse(ci.stdout)).toMatchObject({
    affectedTests: [],
    needsRustNative: true,
    needsRustWasm: false,
    needsRustBuild: false,
    needsTypeScriptValidate: false,
  });
});
