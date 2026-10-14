import { readdirSync, readFileSync } from "node:fs";
/**
 * Task manifest loading and selection.
 *
 * Manifests live in benchmarks/tasks/*.json and are validated through the
 * shared contract in schemas.ts. Selection supports exact ids, `*` glob
 * patterns per segment, and `category:<name>` selectors, comma-separated.
 */

import { type TaskCategory, type TaskManifest, validateTaskManifest } from "./schemas.ts";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export function loadTasks(tasksDir: string): TaskManifest[] {
  const files: string[] = [];
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(entry.name);
  }
  files.sort((a, b) => a.localeCompare(b));
  const tasks = files.map((name) => {
    const raw = readFileSync(`${tasksDir}/${name}`, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ManifestError(`${name}: invalid JSON: ${(err as Error).message}`);
    }
    try {
      return validateTaskManifest(parsed);
    } catch (err) {
      throw new ManifestError(`${name}: ${(err as Error).message}`);
    }
  });
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new ManifestError(`duplicate task id ${t.id}`);
    ids.add(t.id);
  }
  return tasks;
}

/** One pattern character as a regex fragment: a glob wildcard or the escaped literal. */
function globCharToRegex(c: string): string {
  if (c === "*") return ".*";
  if (c === "?") return ".";
  return c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Simple glob matcher for `*` and `?` (no `**`; segment-aligned). */
function globMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp("^" + pattern.split("").map(globCharToRegex).join("") + "$");
  return re.test(value);
}

/** Ids matched by one selector, or `null` when that selector matches no task. */
function selectByOneSelector(tasks: TaskManifest[], selector: string): string[] | null {
  if (selector.startsWith("category:")) {
    const cat = selector.slice("category:".length) as TaskCategory;
    const inCategory = tasks.filter((t) => t.category === cat);
    return inCategory.length === 0 ? null : inCategory.map((t) => t.id);
  }
  const matched = tasks.filter((t) => globMatches(selector, t.id));
  return matched.length === 0 ? null : matched.map((t) => t.id);
}

/**
 * Select tasks with comma-separated selectors: exact `nav-001`, glob
 * `code-*`, `*`, or `category:navigation`. Empty/`*` selects all tasks.
 */
export function selectTasks(tasks: TaskManifest[], selectors: string[]): TaskManifest[] {
  if (selectors.length === 0) return tasks;
  const chosen = new Set<string>();
  const unknown: string[] = [];
  for (const sel of selectors) {
    const ids = selectByOneSelector(tasks, sel);
    if (ids === null) {
      unknown.push(sel);
      continue;
    }
    for (const id of ids) chosen.add(id);
  }
  if (unknown.length > 0) {
    const known = tasks.map((t) => t.id);
    throw new ManifestError(`no tasks matched: ${unknown.join(", ")}; known ids: ${known.join(", ")}`);
  }
  return tasks.filter((t) => chosen.has(t.id));
}

/** Progressively restricted display name of a derived task family. */
export function taskFamily(task: TaskManifest): string {
  return task.id.replace(/-\d+$/, "");
}
