import { appendFile, readFile, mkdir, writeFile } from "node:fs/promises";
// Benchmark runner: executes one provider batch over the frozen corpus
// through the benchmark gateway instance, pins the provider selection for the
// batch, records every attempt as one AttemptRecord line, and applies the
// production-intent retry policy without hiding the first-attempt outcome.
//
//   bun \
//     benchmarks/provider-waterfall/runner.ts --provider=surplus --period=w1-eve --batch=1 --limit=30

import { runAttempt } from "./client.ts";
import { loadCorpus } from "./corpus.ts";
import { BENCHMARK_PROVIDERS, providerById, type ProviderSpec } from "./providers.ts";
import type { AttemptRecord, CorpusEntry, FailureKind } from "./types.ts";

const RETRYABLE_FAILURES: ReadonlySet<FailureKind> = new Set([
  "connection_failure",
  "dns_network_failure",
  "timeout",
  "http_429",
  "http_5xx",
  "interrupted_stream",
  "malformed_sse",
]);

const parseArgs = (args: readonly string[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(arg);
    if (match) {
      const value: string | undefined = match[2] as string | undefined;
      map.set(match[1].toLowerCase(), value ?? "true");
    }
  }
  return map;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const gatewayHealth = async (base: string): Promise<Record<string, unknown>> => {
  const response = await fetch(`${base}/health`);
  if (!response.ok) throw new Error(`benchmark gateway ${base} is not healthy: HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
};

const setSelection = async (base: string, ids: readonly string[]): Promise<readonly string[]> => {
  const response = await fetch(`${base}/admin/providers/selection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_ids: [...ids] }),
  });
  if (!response.ok) throw new Error(`selection update failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  const readback = await fetch(`${base}/admin/providers/selection`);
  const parsed = (await readback.json()) as { data?: { selection?: { provider_ids?: string[] } } };
  return parsed.data?.selection?.provider_ids ?? [];
};

const pilotEntry = (id: string, inputText: string, tools: readonly Record<string, unknown>[], effort: string | null): CorpusEntry => ({
  id,
  cls: "small",
  source: {
    session_id: "pilot",
    thread_id: null,
    turn_id: null,
    recorded_model: "pilot",
    recorded_at: new Date().toISOString(),
    recorded_input_tokens: 0,
    item_count: 1,
    dropped_item_types: [],
  },
  request: {
    instructions: "",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: inputText }] }],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: effort === null ? null : { effort },
    max_output_tokens: 256,
  },
});

const appendLine = async (path: string, line: string): Promise<void> => {
  await appendFile(path, `${line}\n`);
};

type RunOptions = Readonly<{
  provider: ProviderSpec;
  gateway: string;
  period: string;
  batch: number;
  offset: number;
  limit: number | null;
  ids: ReadonlySet<string> | null;
  concurrency: number;
  retryBudget: number;
  pilot: boolean;
  reverse: boolean;
  out: string;
}>;

const parseRunOptions = (args: ReadonlyMap<string, string>, root: string): RunOptions => {
  const providerId = args.get("provider") ?? "";
  const provider: ProviderSpec = providerId === "all" ? BENCHMARK_PROVIDERS[0] : providerById(providerId);
  const period = args.get("period") ?? "adhoc";
  const batch = Number.parseInt(args.get("batch") ?? "1", 10);
  const idsArg = args.get("ids");
  return {
    provider,
    gateway: args.get("gateway") ?? "http://127.0.0.1:7998",
    period,
    batch,
    offset: Number.parseInt(args.get("offset") ?? "0", 10),
    limit: args.get("limit") ? Number.parseInt(args.get("limit") ?? "0", 10) : null,
    ids: idsArg
      ? new Set(
          idsArg
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        )
      : null,
    concurrency: Math.max(1, Number.parseInt(args.get("concurrency") ?? "1", 10)),
    retryBudget: Number.parseInt(args.get("retries") ?? "1", 10),
    pilot: args.get("pilot") === "true",
    reverse: args.get("reverse") === "true",
    out: args.get("out") ?? `${root}/results/${provider.id}-${period}-b${batch}.jsonl`,
  };
};

const main = async (): Promise<void> => {
  const root = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const { provider, gateway, period, batch, offset, limit, ids, concurrency, retryBudget, pilot, reverse, out } = parseRunOptions(
    parseArgs(process.argv.slice(2)),
    root
  );

  const health = await gatewayHealth(gateway);
  const releaseRecord = (health.release ?? {}) as Record<string, unknown>;
  const releaseSha = typeof releaseRecord.git_sha === "string" ? releaseRecord.git_sha : "unknown";
  console.log(`[runner] gateway ${gateway} release ${releaseSha}`);

  let entries: readonly CorpusEntry[];
  let corpusSha: string | null = null;
  if (pilot) {
    const toolsRaw = JSON.parse(await readFile(`${root}/fixtures/codex-tools-0.160.1.json`, "utf8")) as Record<string, unknown>[];
    entries = [pilotEntry("pilot-1", "Reply with exactly: pilot-ok", toolsRaw, "high")];
  } else {
    const corpus = await loadCorpus(root);
    corpusSha = corpus.sha256;
    const ordered = reverse ? [...corpus.entries].reverse() : [...corpus.entries];
    const filtered = ids ? ordered.filter((entry) => ids.has(entry.id)) : ordered;
    const sliced = filtered.slice(offset);
    entries = limit === null ? sliced : sliced.slice(0, limit);
    console.log(`[runner] corpus ${corpusSha} entries ${entries.length}`);
  }

  const selectionSet = await setSelection(gateway, provider.selection);
  console.log(`[runner] selection pinned to [${selectionSet.join(", ")}] for provider ${provider.id}`);
  await sleep(6500);

  const runId = `${provider.id}-${period}-b${batch}-${Date.now()}`;
  await mkdir(out.slice(0, out.lastIndexOf("/")), { recursive: true });
  const meta = {
    run_id: runId,
    provider: provider.id,
    label: provider.label,
    model: provider.model,
    wire: provider.wire,
    selection_requested: provider.selection,
    selection_stored: selectionSet,
    gateway,
    gateway_release: health,
    corpus_sha256: corpusSha,
    period,
    batch,
    pilot,
    started_at: new Date().toISOString(),
  };
  await writeFile(`${out}.meta.json`, JSON.stringify(meta, null, 1));

  let successFirst = 0;
  let successRetry = 0;
  let failures = 0;
  const recordWithUpstreamNote = (record: AttemptRecord): AttemptRecord => {
    if (record.upstream === null || record.upstream === provider.expected_upstream) return record;
    const base = record.notes ?? "";
    return { ...record, notes: `${base}${base ? "; " : ""}unexpected_upstream=${record.upstream}` };
  };
  const logAttempt = (entry: CorpusEntry, attempt: number, record: AttemptRecord): void => {
    const outcome = record.success ? "ok" : `fail ${record.failure_kind}`;
    const http = record.http_status ?? "-";
    const e2e = record.t_end_ms ?? "-";
    const ttft = record.t_first_output_ms ?? "-";
    const outTokens = record.usage?.output_tokens ?? "-";
    console.log(`[runner] ${provider.id} ${entry.id} (${entry.cls}) attempt ${attempt}: ${outcome} http=${http} e2e=${e2e}ms ttft=${ttft}ms out=${outTokens}`);
  };
  const runEntry = async (entry: CorpusEntry): Promise<Readonly<{ success: boolean; first_attempt: boolean }>> => {
    let attempt = 0;
    let record: AttemptRecord | undefined;
    for (;;) {
      attempt += 1;
      record = recordWithUpstreamNote(
        await runAttempt({
          gateway_base: gateway,
          provider,
          entry,
          run_id: runId,
          period,
          batch,
          attempt,
          first_attempt: attempt === 1,
          timeout_ms: 900_000,
        })
      );
      await appendLine(out, JSON.stringify(record));
      const canRetry = !record.success && record.failure_kind !== null && RETRYABLE_FAILURES.has(record.failure_kind) && attempt <= retryBudget;
      logAttempt(entry, attempt, record);
      if (!canRetry) break;
      await sleep(2_000);
    }
    return { success: record.success, first_attempt: record.first_attempt };
  };
  const tally = (result: Readonly<{ success: boolean; first_attempt: boolean }>): void => {
    if (result.success) {
      if (result.first_attempt) successFirst += 1;
      else successRetry += 1;
    } else {
      failures += 1;
    }
  };
  if (concurrency === 1) {
    for (const entry of entries) tally(await runEntry(entry));
  } else {
    const queue = [...entries];
    const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        tally(await runEntry(entry));
      }
    });
    await Promise.all(workers);
  }
  console.log(
    `[runner] done provider=${provider.id} first_attempt_success=${successFirst} retry_recovered=${successRetry} failed=${failures} concurrency=${concurrency} out=${out}`
  );
};

if (import.meta.main) await main();
