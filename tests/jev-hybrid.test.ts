import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildCompactionResponse, handleJevResponsesCompaction } from "../src/jev_compaction/compaction.ts";
import { composeHybridSummary, harvestLedger, hybridResidueEnabled, runHybridResiduePass } from "../src/jev_compaction/hybrid.ts";
import type { JevAsker, JevQuestions, JevResponse } from "../lib/jev_compaction/types.ts";

/** Focused coverage for the hybrid residue pass: mechanical guards, every
 * failure path returning null, and the route seam keeping the pure Jev summary
 * whenever the pass is absent or unusable. */

const COMPACTION_METADATA = JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses" } });
const COMPACTION_PROMPT = "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM.";
const SLIM_MARKER = "SLIM_MODEL_MARKER_summary";

const text = (role: string, value: string) => ({ type: "message", role, content: [{ type: "input_text", text: value }] });
const call = (callId: string, command: string) => ({ type: "function_call", call_id: callId, name: "shell", arguments: JSON.stringify({ command }) });
const output = (callId: string, value: string) => ({ type: "function_call_output", call_id: callId, output: value });

/** One unpinned obsolete call followed by enough turns that it is not pinned. */
const transcript = (): unknown[] => {
  const input: unknown[] = [
    text("user", "Goal: keep the current state; the old build log below is obsolete."),
    call("old_a", "tail -n 400 /tmp/old/build.log"),
    output("old_a", "RESULT_A obsolete build log line. ".repeat(60)),
    text("assistant", "The old logs are obsolete; moving on."),
  ];
  for (let index = 1; index <= 6; index += 1) {
    input.push(text("user", `Follow-up ${index}: continue the current work.`));
    input.push(text("assistant", `Continued step ${index}.`));
  }
  input.push(
    text(
      "user",
      `Final goal: keep the current state; hash 9cea11d66b4e3afe7e7d23f9452e93d8404013e68dd50725db0c3dce3d0b381b and path /private/tmp/sentinel-checkpoint.MtIQ2U/readback.json matter.`
    )
  );
  input.push(text("user", COMPACTION_PROMPT));
  return input;
};

const body = (input: unknown[], stream = true): Record<string, unknown> => ({ model: "gpt-6.1-sol", stream, input });

const decisionAsker = (verdicts: Readonly<Record<string, { keepCall: number; keepResult: number } | undefined>>): JevAsker => ({
  ask(_state, questions: JevQuestions): Promise<JevResponse> {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      const match = /^(?<kind>call|result)_(?<id>t\d+)$/.exec(name) as { groups: { kind: string; id: string } } | null;
      if (!match) continue;
      const { id, kind } = match.groups;
      const lookup = verdicts[id] ?? { keepCall: 1, keepResult: 1 };
      answers[name] = { noul: kind === "call" ? lookup.keepCall : lookup.keepResult };
    }
    return Promise.resolve({ answers });
  },
});

const dropEverything = { t1: { keepCall: 0.1, keepResult: 0.1 } };

const summaryOf = (completionBody: string): string => {
  const parsed = JSON.parse(completionBody) as { output?: { content?: { text?: string }[] }[] };
  return parsed.output?.[0]?.content?.[0]?.text ?? "";
};

const pureSummary = (): Promise<string> =>
  buildCompactionResponse(body(transcript()), decisionAsker(dropEverything), { stream: false }).then((outcome) => summaryOf(outcome.body));

const completion = (content: string, status = 200): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

test("hybrid mechanical guards keep identifiers verbatim and append the latest tail", async () => {
  const pure = await pureSummary();
  assert.ok(pure.includes("9cea11d66b4e3afe7e7d23f9452e93d8404013e68dd50725db0c3dce3d0b381b"));
  const entries = harvestLedger(pure);
  assert.ok(
    entries.some((entry) => entry.token.includes("9cea11d66b4e3afe")),
    "the ledger must harvest the SHA"
  );
  const composed = composeHybridSummary("Slim memory. " + SLIM_MARKER, pure);
  assert.ok(composed.startsWith(SLIM_MARKER) || composed.includes(SLIM_MARKER));
  assert.ok(composed.includes("9cea11d66b4e3afe7e7d23f9452e93d8404013e68dd50725db0c3dce3d0b381b"), "the ledger section must carry the SHA");
  assert.ok(composed.includes("## Verbatim identifiers"), "the ledger section marker must be present");
  assert.ok(composed.includes("## Verbatim latest transcript tail"), "the tail section marker must be present");
  assert.ok(composed.length < pure.length, "the composed summary must be smaller than the pure summary");
});

test("hybrid residue pass composes model text with the guards when the call succeeds", async () => {
  const pure = await pureSummary();
  const composed = await runHybridResiduePass(pure, {
    apiKey: "test",
    fetcher: createFetchMock(() => Promise.resolve(completion(SLIM_MARKER + " compact text."))),
    timeoutMs: 1_000,
  });
  assert.ok(composed, "a successful pass must return the composed summary");
  assert.ok(composed.includes(SLIM_MARKER));
  assert.ok(composed.includes("## Verbatim identifiers"));
  assert.ok(composed.includes("9cea11d66b4e3afe"));
  assert.ok(composed.length < pure.length);
});

test("hybrid residue pass returns null on every failure path", async () => {
  const pure = await pureSummary();
  assert.equal(await runHybridResiduePass(pure, { apiKey: null, fetcher: createFetchMock(() => Promise.resolve(completion(SLIM_MARKER))) }), null);
  assert.equal(await runHybridResiduePass(pure, { apiKey: "test", fetcher: createFetchMock(() => Promise.resolve(completion(SLIM_MARKER, 500))) }), null);
  assert.equal(await runHybridResiduePass(pure, { apiKey: "test", fetcher: createFetchMock(() => Promise.resolve(completion("   "))) }), null);
  assert.equal(await runHybridResiduePass(pure, { apiKey: "test", fetcher: createFetchMock(() => Promise.reject(new Error("boom"))) }), null);
  const huge = "x".repeat(pure.length + 10_000);
  assert.equal(await runHybridResiduePass(pure, { apiKey: "test", fetcher: createFetchMock(() => Promise.resolve(completion(huge))) }), null);
  const hanging: typeof fetch = createFetchMock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const fail = (): void => {
          const error = new Error("aborted");
          error.name = "TimeoutError";
          reject(error);
        };
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      })
  );
  assert.equal(await runHybridResiduePass(pure, { apiKey: "test", fetcher: hanging, timeoutMs: 30 }), null);
});

test("hybrid residue pass chunks memories larger than the input bound and merges the rewrites", async () => {
  const block = (index: number): string =>
    `[tool result call_${index}] ` + `obsolete build log line with detail ${index}. `.repeat(20) + `revision ${String(index).repeat(8)} end`;
  const pure = Array.from({ length: 8 }, (_, index) => block(index)).join("\n");
  const bodies: string[] = [];
  const fetcher: typeof fetch = createFetchMock((_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    bodies.push(typeof raw === "string" ? raw : JSON.stringify(raw));
    return Promise.resolve(completion(`${SLIM_MARKER} rewrite ${bodies.length}.`));
  });
  const composed = await runHybridResiduePass(pure, { apiKey: "test", fetcher, chunkChars: 400 });
  assert.ok(composed, "a chunked pass must return the composed summary");
  assert.ok(bodies.length >= 2, "the memory must be split into multiple residue calls");
  for (const body of bodies) {
    const parsed = JSON.parse(body) as { messages: { content: string }[] };
    assert.ok(parsed.messages[0].content.length <= 400 + 8_000, "every chunk request must stay inside the residue input bound");
  }
  assert.ok(composed.includes(SLIM_MARKER));
  assert.ok(composed.includes("## Verbatim identifiers"));
  assert.ok(composed.length < pure.length, "the merged rewrite plus guards must shrink the memory");
});

test("hybrid residue keeps a failing chunk verbatim and rewrites the rest", async () => {
  const block = (index: number): string => `[tool result call_${index}] ` + `older log line ${index}. `.repeat(20);
  const pure = Array.from({ length: 8 }, (_, index) => block(index)).join("\n");
  let calls = 0;
  const fetcher: typeof fetch = createFetchMock(() => {
    calls += 1;
    return Promise.resolve(calls === 2 ? completion(SLIM_MARKER, 500) : completion(SLIM_MARKER + " rewrite."));
  });
  const composed = await runHybridResiduePass(pure, { apiKey: "test", fetcher, chunkChars: 400 });
  assert.ok(composed, "one failed chunk must not sink the rewrite");
  assert.ok(composed.includes(SLIM_MARKER), "the successful chunks must be rewritten");
  assert.ok(composed.includes("older log line"), "the failed chunk must stay verbatim");
  assert.ok(composed.length < pure.length, "the composed summary must still shrink the memory");
});

test("hybrid residue falls back to pure Jev when every chunk fails", async () => {
  const block = (index: number): string => `[tool result call_${index}] ` + `older log line ${index}. `.repeat(20);
  const pure = Array.from({ length: 8 }, (_, index) => block(index)).join("\n");
  const fetcher: typeof fetch = createFetchMock(() => Promise.resolve(completion(SLIM_MARKER, 500)));
  assert.equal(await runHybridResiduePass(pure, { apiKey: "test", fetcher, chunkChars: 400 }), null);
});

test("route keeps the pure Jev summary when the residue seam is absent, null or throwing", async () => {
  const pureOutcome = await buildCompactionResponse(body(transcript()), decisionAsker(dropEverything), { stream: false });
  assert.ok(!(pureOutcome.headers["x-jev-compaction"] ?? "").includes("hybrid=1"));
  const nullOutcome = await buildCompactionResponse(body(transcript()), decisionAsker(dropEverything), { stream: false, residue: () => Promise.resolve(null) });
  assert.ok(!(nullOutcome.headers["x-jev-compaction"] ?? "").includes("hybrid=1"));
  assert.equal(summaryOf(nullOutcome.body), summaryOf(pureOutcome.body), "a null residue result must keep the pure summary");
  const throwing = await buildCompactionResponse(body(transcript()), decisionAsker(dropEverything), {
    stream: false,
    residue: () => Promise.reject(new Error("boom")),
  });
  assert.ok(!(throwing.headers["x-jev-compaction"] ?? "").includes("hybrid=1"));
  const same = await buildCompactionResponse(body(transcript()), decisionAsker(dropEverything), {
    stream: false,
    residue: (summary) => Promise.resolve(summary),
  });
  assert.ok(!(same.headers["x-jev-compaction"] ?? "").includes("hybrid=1"), "a non-shrinking residue result must not be applied");
});

test("route applies a shrinking residue seam and marks it on the header", async () => {
  const outcome = await buildCompactionResponse(body(transcript()), decisionAsker(dropEverything), {
    stream: false,
    residue: (summary) => Promise.resolve(composeHybridSummary(SLIM_MARKER + " compact text.", summary)),
  });
  assert.equal(outcome.status, 200);
  assert.ok((outcome.headers["x-jev-compaction"] ?? "").includes("hybrid=1"));
  assert.ok(outcome.body.includes(SLIM_MARKER));
  assert.ok(outcome.body.includes("## Verbatim identifiers"));
});

test("handler routes the residue seam through the real compaction handler", async () => {
  const request = new Request("http://127.0.0.1:7999/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-turn-metadata": COMPACTION_METADATA },
    body: JSON.stringify(body(transcript())),
  });
  const response = await handleJevResponsesCompaction(request, {
    asker: decisionAsker(dropEverything),
    residue: (summary) => Promise.resolve(composeHybridSummary(SLIM_MARKER + " compact text.", summary)),
  });
  assert.equal(response.status, 200);
  assert.ok((response.headers.get("x-jev-compaction") ?? "").includes("hybrid=1"));
  assert.ok((await response.text()).includes(SLIM_MARKER));
  assert.equal(typeof hybridResidueEnabled(), "boolean");
});

test("injected asker seams bypass the default residue pass without any network attempt", async () => {
  const request = new Request("http://127.0.0.1:7999/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-turn-metadata": COMPACTION_METADATA },
    body: JSON.stringify(body(transcript())),
  });
  const originalFetch = globalThis.fetch;
  let residueAttempts = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    if (url.includes("cerebras.ai")) residueAttempts += 1;
    return originalFetch(input as RequestInfo, init);
  });
  try {
    const response = await handleJevResponsesCompaction(request, { asker: decisionAsker(dropEverything) });
    assert.equal(response.status, 200);
    assert.ok(!(response.headers.get("x-jev-compaction") ?? "").includes("hybrid=1"));
    assert.equal(residueAttempts, 0, "an injected asker must not engage the default residue pass");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
