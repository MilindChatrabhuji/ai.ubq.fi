import { readFile } from "node:fs/promises";
// Frozen corpus loading and integrity verification.

import type { CorpusClass, CorpusEntry } from "./types.ts";

export type CorpusManifest = Readonly<{
  corpus: string;
  sha256: string;
  tools_fixture_sha256?: string;
  counts?: Record<string, number>;
  entries?: readonly Readonly<{ id: string; cls: CorpusClass; session_id?: string; recorded_input_tokens?: number }>[];
}>;

const CORPUS_CLASSES: readonly CorpusClass[] = ["small", "medium", "large", "xlarge"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const validateCorpusEntry = (value: unknown): CorpusEntry => {
  if (!isRecord(value)) throw new Error("corpus entry is not an object");
  const id = value.id;
  const cls = value.cls;
  const request = value.request;
  const source = value.source;
  if (typeof id !== "string" || !id) throw new Error("corpus entry id is missing");
  if (typeof cls !== "string" || !CORPUS_CLASSES.includes(cls as CorpusClass)) throw new Error(`corpus entry ${id} has an invalid class`);
  if (!isRecord(request) || !Array.isArray(request.input) || !Array.isArray(request.tools)) throw new Error(`corpus entry ${id} has an invalid request`);
  if (!isRecord(source)) throw new Error(`corpus entry ${id} has no source`);
  return value as unknown as CorpusEntry;
};

/** First non-empty string among the manifest's supported hash fields. */
const manifestSha256 = (manifestRaw: Record<string, unknown>): string | null => {
  for (const candidate of [manifestRaw.sha256, manifestRaw.content_sha256]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const corpusRecord = isRecord(manifestRaw.corpus) ? manifestRaw.corpus : null;
  return corpusRecord && typeof corpusRecord.sha256 === "string" && corpusRecord.sha256 ? corpusRecord.sha256 : null;
};

export const loadCorpus = async (root: string): Promise<Readonly<{ entries: readonly CorpusEntry[]; manifest: CorpusManifest; sha256: string }>> => {
  const corpusPath = `${root}/corpus/corpus-v1.jsonl`;
  const manifestPath = `${root}/corpus/corpus-v1.manifest.json`;
  const bytes = await readFile(corpusPath);
  const sha256 = await sha256Hex(bytes);
  const manifestRaw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isRecord(manifestRaw)) throw new Error("corpus manifest is not an object");
  const manifestSha = manifestSha256(manifestRaw);
  if (manifestSha === null) throw new Error("corpus manifest carries no content sha256");
  if (manifestSha !== sha256) throw new Error(`corpus sha256 mismatch: manifest ${manifestSha} != file ${sha256}`);
  const text = new TextDecoder().decode(bytes);
  const entries: CorpusEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    entries.push(validateCorpusEntry(JSON.parse(line) as unknown));
  }
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.cls] = (counts[entry.cls] ?? 0) + 1;
  for (const cls of CORPUS_CLASSES) if (!counts[cls]) throw new Error(`corpus has no ${cls} entries`);
  const manifest = manifestRaw as unknown as CorpusManifest;
  return { entries, manifest, sha256 };
};
