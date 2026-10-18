import * as bunTest from "bun:test";
import { resolve } from "node:path";
import { ROOT, detectTestSelection, formatScopeMessage } from "./test-scope.ts";

type ScopeGlobal = typeof globalThis & {
  __uosTestScopeAffected?: ReadonlySet<string>;
  __uosTestScopeInstalled?: boolean;
  __uosTestScopeReported?: boolean;
};

const scopeGlobal = globalThis as ScopeGlobal;
const currentStackReachesAffectedTest = (): boolean => {
  const affected = scopeGlobal.__uosTestScopeAffected;
  if (!affected) return true;
  const stack = new Error().stack ?? "";
  return [...affected].some((path) => stack.includes(path));
};

const scopedFunction = <T extends (...args: never[]) => unknown>(fn: T): T =>
  new Proxy(fn, {
    apply(target, thisArg, args) {
      return currentStackReachesAffectedTest() ? Reflect.apply(target, thisArg, args) : undefined;
    },
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" && property !== "caller" && property !== "callee" ? scopedFunction(value as (...args: never[]) => unknown) : value;
    },
  });

if (process.env.TEST_SCOPE_FORCE !== "1" && process.env.TEST_SCOPE_ACTIVE !== "1") {
  const selection = detectTestSelection();
  if (!selection.runAll) {
    if (!scopeGlobal.__uosTestScopeReported) {
      console.log(formatScopeMessage(selection, "bun test"));
      scopeGlobal.__uosTestScopeReported = true;
    }
    if (selection.affectedTests.length === 0) process.exit(0);
    scopeGlobal.__uosTestScopeAffected = new Set(selection.affectedTests.map((path) => resolve(ROOT, path)));
  }
}

if (scopeGlobal.__uosTestScopeAffected && !scopeGlobal.__uosTestScopeInstalled) {
  await bunTest.mock.module("bun:test", () => ({
    ...bunTest,
    test: scopedFunction(bunTest.test),
    it: scopedFunction(bunTest.it),
    xtest: scopedFunction(bunTest.xtest),
    xit: scopedFunction(bunTest.xit),
    describe: scopedFunction(bunTest.describe),
    xdescribe: scopedFunction(bunTest.xdescribe),
    beforeAll: scopedFunction(bunTest.beforeAll),
    afterAll: scopedFunction(bunTest.afterAll),
    beforeEach: scopedFunction(bunTest.beforeEach),
    afterEach: scopedFunction(bunTest.afterEach),
    onTestFinished: scopedFunction(bunTest.onTestFinished),
  }));
  scopeGlobal.__uosTestScopeInstalled = true;
}
