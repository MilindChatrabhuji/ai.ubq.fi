import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GIT = "/usr/bin/git";
const DOCUMENTATION_FILE = /\.(?:md|mdx|markdown)$/i;
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const TEST_FILE = /(?:\.test\.tsx?|\.e2e\.ts|_test\.tsx?)$/i;
const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const ALIASES = new Map([
  ["#http", "src/runtime/http.ts"],
  ["#kv", "src/storage/kv.ts"],
]);
const UNTRACKED_ROOTS = ["src/", "scripts/", "tests/", "ops/", "benchmarks/", "tools/", "static/", "rust/"];

export type ChangeScope = Readonly<{
  paths: readonly string[];
  documentationOnly: boolean;
}>;

export type TestSelection = ChangeScope &
  Readonly<{
    affectedTests: readonly string[];
    runAll: boolean;
    reason: "no-base" | "no-changes" | "documentation-only" | "no-dependent-tests" | "selected" | "config";
  }>;

export type CiScope = TestSelection &
  Readonly<{
    completeCheckSet: boolean;
    docsOnly: boolean;
    needsDocs: boolean;
    needsValidate: boolean;
    needsNativeKv: boolean;
    needsNativeBuild: boolean;
    needsMacContainment: boolean;
    needsDarwinNative: boolean;
    needsDarwinTests: boolean;
    needsArtifact: boolean;
    needsRustNative: boolean;
    needsRustWasm: boolean;
    needsRustBuild: boolean;
    needsTypeScriptValidate: boolean;
  }>;

const git = (args: readonly string[]): string | null => {
  const result = spawnSync(GIT, args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
};

const refExists = (ref: string): boolean => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
const pathList = (args: readonly string[]): string[] => (git(args) ?? "").split("\0").filter(Boolean);
const normalizePath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "").trim();
const uniqueSorted = (paths: Iterable<string>): string[] => [...new Set(paths)].sort((left, right) => left.localeCompare(right));

const isRelevantUntrackedPath = (path: string): boolean =>
  UNTRACKED_ROOTS.some((root) => path.startsWith(root)) || /^[^/]+\.(?:json|toml|ts|tsx|mts|cts|js|mjs|cjs|sh)$/i.test(path);

const resolveBase = (): string | null => {
  const explicit = process.env.TEST_SCOPE_BASE?.trim();
  if (explicit && refExists(explicit)) return explicit;

  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  if (githubBase) {
    for (const candidate of [`origin/${githubBase}`, githubBase]) if (refExists(candidate)) return candidate;
  }

  const eventBefore = process.env.GITHUB_EVENT_BEFORE?.trim();
  if (eventBefore && !/^0+$/.test(eventBefore) && refExists(eventBefore)) return eventBefore;
  return refExists("origin/development") ? "origin/development" : null;
};

const changedPathsFromGit = (): string[] | null => {
  const explicit = process.env.TEST_SCOPE_PATHS?.split(",").map(normalizePath).filter(Boolean);
  if (explicit?.length) return uniqueSorted(explicit);

  const base = resolveBase();
  if (!base) return null;
  const paths = new Set([
    ...pathList(["diff", "--name-only", "-z", `${base}...HEAD`]).map(normalizePath),
    ...pathList(["diff", "--name-only", "-z", "HEAD"]).map(normalizePath),
  ]);
  if (process.env.TEST_SCOPE_IGNORE_UNTRACKED !== "1") {
    for (const path of pathList(["ls-files", "--others", "--exclude-standard", "-z"]).map(normalizePath)) {
      if (isRelevantUntrackedPath(path)) paths.add(path);
    }
  }
  return uniqueSorted(paths);
};

export const isDocumentationPath = (path: string): boolean => DOCUMENTATION_FILE.test(path);
export const isTestPath = (path: string): boolean => TEST_FILE.test(path);
/** Rust has its own compiler/test graph; never feed it to the Bun import scanner. */
export const isRustPath = (path: string): boolean => path.startsWith("rust/") && !isDocumentationPath(path);
export const isRustGatePath = (path: string): boolean => isRustPath(path) || /^scripts\/rust-verify(?:\.test)?\.ts$/.test(path);
export const RUST_NATIVE_ONLY_PACKAGES = ["gateway-native"] as const;
const WORKFLOW_CONTRACT_PATH = ".github/workflows/deno-deploy.yml";

export const classifyChangedPaths = (paths: readonly string[]): ChangeScope => {
  const normalized = uniqueSorted(paths.map(normalizePath).filter(Boolean));
  return { paths: normalized, documentationOnly: normalized.length > 0 && normalized.every(isDocumentationPath) };
};

const resolveImportedPath = (from: string, specifier: string, root: string): string | null => {
  const clean = specifier.split(/[?#]/, 1)[0] ?? "";
  const alias = ALIASES.get(clean);
  if (alias) return resolve(root, alias);
  if (!clean.startsWith(".") && !clean.startsWith("/")) return null;
  const base = isAbsolute(clean) ? clean : resolve(dirname(from), clean);
  for (const suffix of MODULE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  if (extname(base) === ".js") {
    for (const suffix of [".ts", ".tsx"]) if (existsSync(base.slice(0, -3) + suffix)) return base.slice(0, -3) + suffix;
  }
  return null;
};

const dependencyCache = new Map<string, readonly string[]>();
const dependenciesOf = (file: string, root: string): readonly string[] => {
  const cached = dependencyCache.get(file);
  if (cached) return cached;
  if (!existsSync(file)) return [];
  const extension = extname(file).toLowerCase();
  if (extension === ".json") {
    dependencyCache.set(file, []);
    return [];
  }
  if (!SOURCE_FILE.test(file)) {
    dependencyCache.set(file, []);
    return [];
  }
  const loader = extension === ".tsx" || extension === ".jsx" ? "tsx" : "ts";
  const source = readFileSync(file, "utf8");
  const withoutShebang = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
  const imports = new Bun.Transpiler({ loader }).scanImports(withoutShebang);
  const dependencies = uniqueSorted(imports.map((item) => resolveImportedPath(file, item.path, root)).filter((path): path is string => path !== null));
  dependencyCache.set(file, dependencies);
  return dependencies;
};

const testTouchesChangedPath = (testPath: string, changedPaths: ReadonlySet<string>, root: string): boolean => {
  const visited = new Set<string>();
  const pending = [resolve(root, testPath)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const local = normalizePath(relative(root, file));
    if (changedPaths.has(local)) return true;
    pending.push(...dependenciesOf(file, root));
  }
  return false;
};

export const selectAffectedTestFiles = (changedPaths: readonly string[], candidateTests: readonly string[], root = ROOT): string[] => {
  const changed = new Set(changedPaths.map(normalizePath));
  return uniqueSorted(candidateTests.map(normalizePath).filter((testPath) => changed.has(testPath) || testTouchesChangedPath(testPath, changed, root)));
};

export const testRequiresNativeKv = (testPath: string, root = ROOT): boolean => {
  const required = /^(?:src\/kv\.ts|src\/storage\/(?:kv|native-addon|native-kv)\.ts|scripts\/test-native-kv\.ts)$/;
  const visited = new Set<string>();
  const pending = [resolve(root, testPath)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    if (required.test(normalizePath(relative(root, file)))) return true;
    pending.push(...dependenciesOf(file, root));
  }
  return false;
};

const RELEASE_PATH = /^(?:src\/|ops\/|static\/|serve\.ts$|package\.json$|bun\.lock$|tsconfig\.json$|tools\/native-kv\/)/;
const NATIVE_PATH =
  /^(?:src\/storage\/(?:kv|native-addon)\.ts$|tools\/native-kv\/|scripts\/(?:build-native-kv|build-native-kv-darwin|test-native-kv|prepare-native-runtime)\.ts$|ops\/prepare-ci-native-toolchain\.sh$)/;
const MAC_PATH =
  /(?:^ops\/(?:deploy-mac|macos-sandbox|verify-mac-sandbox|launch-mac|mac-runtime|mac-sqlite-temp)\.ts$|^ops\/com\.ubiquity\.ai\.local\.plist$|^scripts\/serve-mac\.ts$|^src\/storage\/native-addon\.ts$|^tools\/native-kv\/inputs-darwin-arm64\.json$)/;
const DARWIN_PATH =
  /(?:^ops\/(?:macos-sandbox|verify-mac-sandbox)\.ts$|^scripts\/build-native-kv-darwin\.ts$|^src\/storage\/native-addon\.ts$|^tools\/native-kv\/inputs-darwin-arm64\.json$|^tests\/gpg-dsh\.test\.ts$)/;

const candidateTestFiles = (changedPaths: readonly string[]): string[] =>
  uniqueSorted([...pathList(["ls-files", "-z"]).map(normalizePath).filter(isTestPath), ...changedPaths.filter(isTestPath)]);

export const detectTestSelection = (): TestSelection => {
  const paths = changedPathsFromGit();
  if (paths === null) return { paths: [], documentationOnly: false, affectedTests: [], runAll: true, reason: "no-base" };
  const scope = classifyChangedPaths(paths);
  if (scope.paths.length === 0) return { ...scope, affectedTests: [], runAll: true, reason: "no-changes" };
  if (scope.documentationOnly) return { ...scope, affectedTests: [], runAll: false, reason: "documentation-only" };

  const changedCode = scope.paths.filter((path) => !isDocumentationPath(path) && !isRustPath(path) && path !== WORKFLOW_CONTRACT_PATH);
  const candidates = candidateTestFiles(scope.paths);
  const dependencyScoped = changedCode.every((path) => SOURCE_FILE.test(path) || isTestPath(path));
  // The workflow is a readFile dependency of this contract test, not a TS import.
  const workflowTests = scope.paths.includes(WORKFLOW_CONTRACT_PATH) ? ["scripts/test-scope.test.ts"] : [];
  const affectedTests = uniqueSorted([...(dependencyScoped ? selectAffectedTestFiles(changedCode, candidates) : candidates), ...workflowTests]);
  if (affectedTests.length === 0) return { ...scope, affectedTests, runAll: false, reason: "no-dependent-tests" };
  return { ...scope, affectedTests, runAll: false, reason: dependencyScoped ? "selected" : "config" };
};

export const ciScopeForSelection = (selection: TestSelection, root = ROOT, environment: NodeJS.ProcessEnv = process.env): CiScope => {
  // Sentinel compares head failures with same-name base checks. Exercise every
  // real job for its heads, development baselines and CI-policy changes without
  // changing the dependency-scoped test selection.
  const changesCiPolicy = selection.paths.some((path) => path === ".github/workflows/deno-deploy.yml" || path === "scripts/test-scope.ts");
  const completeCheckSet =
    environment.GITHUB_EVENT_NAME === "merge_group" ||
    (environment.GITHUB_EVENT_NAME === "push" && environment.GITHUB_REF === "refs/heads/development") ||
    (environment.GITHUB_EVENT_NAME === "pull_request" &&
      (environment.GITHUB_BASE_REF === "queue-canary" ||
        (environment.GITHUB_BASE_REF === "development" && (environment.GITHUB_PR_AUTHOR === "ubiquity-sentinel[bot]" || changesCiPolicy))));
  const docsOnly = selection.reason === "documentation-only";
  const rustSelected = !docsOnly && selection.paths.some(isRustGatePath);
  const needsRustNative = completeCheckSet || selection.runAll || rustSelected;
  const rustPaths = selection.paths.filter(isRustGatePath);
  const nativeOnly = rustPaths.length > 0 && rustPaths.every((path) => RUST_NATIVE_ONLY_PACKAGES.some((name) => path.startsWith(`rust/crates/${name}/`)));
  const needsRustWasm = needsRustNative && (completeCheckSet || selection.runAll || !nativeOnly);
  const hasTypeScriptWork = selection.paths.some((path) => !isDocumentationPath(path) && !isRustPath(path));
  const needsNativeKv =
    selection.runAll ||
    selection.paths.some((path) => NATIVE_PATH.test(path)) ||
    (!docsOnly && selection.affectedTests.some((path) => testRequiresNativeKv(path, root)));
  const needsArtifact = completeCheckSet || (!docsOnly && selection.paths.some((path) => RELEASE_PATH.test(path)));
  const needsDarwinTests = !docsOnly && (selection.runAll || selection.paths.some((path) => DARWIN_PATH.test(path)));
  return {
    ...selection,
    completeCheckSet,
    docsOnly,
    needsDocs: completeCheckSet || docsOnly,
    needsValidate: completeCheckSet || !docsOnly,
    needsTypeScriptValidate: completeCheckSet || (!docsOnly && (selection.runAll || hasTypeScriptWork)),
    needsNativeKv,
    needsNativeBuild: needsNativeKv || needsArtifact,
    needsMacContainment: completeCheckSet || (!docsOnly && (selection.runAll || selection.paths.some((path) => MAC_PATH.test(path)))),
    needsDarwinNative: completeCheckSet || needsDarwinTests,
    needsDarwinTests,
    needsArtifact,
    needsRustNative,
    needsRustWasm,
    needsRustBuild: needsRustWasm,
  };
};

export const detectCiScope = (): CiScope => ciScopeForSelection(detectTestSelection());

export const formatScopeMessage = (selection: TestSelection, command: string): string => {
  if (selection.affectedTests.length > 0) {
    const shownTests = selection.affectedTests.slice(0, 20);
    const hiddenCount = selection.affectedTests.length - shownTests.length;
    return [
      `TEST SCOPE: ${selection.affectedTests.length} affected test file(s)`,
      `${command} will execute only tests whose dependency graph reaches a changed path.`,
      "Changed paths:",
      ...selection.paths.map((path) => `  - ${path}`),
      "Affected tests:",
      ...shownTests.map((path) => `  - ${path}`),
      ...(hiddenCount > 0 ? [`  ... and ${hiddenCount} more`] : []),
      "Override only for an explicitly requested full test run: TEST_SCOPE_FORCE=1",
    ].join("\n");
  }

  const reason =
    selection.reason === "documentation-only" ? "Documentation-only changes do not require runtime tests." : "No candidate test file reaches a changed path.";
  return [
    "TEST EXECUTION INTENTIONALLY SKIPPED",
    "MUST TEST ONLY THE CHANGES YOU MADE.",
    `${command} was not executed: ${reason}`,
    "Changed paths:",
    ...selection.paths.map((path) => `  - ${path}`),
    "Required checks for this change:",
    "  - Format only the changed files.",
    "  - Run `git diff --check`.",
    "  - Do not run unrelated tests, lint, Knip, native builds, or deployment suites.",
    "Override only for an explicitly requested test run: TEST_SCOPE_FORCE=1",
    ...(selection.paths.some(isRustGatePath)
      ? ["Rust checks are separate: bun --no-env-file --no-install scripts/rust-verify.ts", "This Bun test selection is not Rust verification."]
      : []),
    "Exit code: 0",
  ].join("\n");
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--ci-json")) {
    console.log(JSON.stringify(detectCiScope()));
    process.exit(0);
  }
  if (args.includes("--check-docs")) {
    const selection = detectTestSelection();
    if (selection.paths.length === 0) process.exit(0);
    const prettier = resolve(ROOT, "tools/lint/node_modules/.bin/prettier");
    if (!existsSync(prettier)) throw new Error("Prettier is not installed; run the frozen lint dependency install first");
    const result = spawnSync(prettier, ["--check", "--ignore-unknown", ...selection.paths], { cwd: ROOT, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  if (process.env.TEST_SCOPE_FORCE === "1") process.exit(10);
  const selection = detectTestSelection();
  if (selection.runAll) process.exit(10);
  console.log(formatScopeMessage(selection, "bun run verify"));
  process.exit(selection.affectedTests.length === 0 ? 0 : 10);
}
