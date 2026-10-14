import assert from "node:assert/strict";
import { createVpsJournalReader, readVpsJournalProcess, runVpsJournalCommand, type VpsJournalProcess } from "../vps-journal-reader.ts";
const fixtureRoot = new URL(".", import.meta.url).pathname;
const limits = () => ({ deadline: Date.now() + 1000, maxBytes: 100, maxEntries: 2 });
Deno.test("VPS journal reader: fixed unit slices and caller output bounds reach the actual command port", async () => {
  const calls: unknown[] = [];
  const reader = createVpsJournalReader(
    (args, bound, cwd) => {
      calls.push([args, bound, cwd]);
      return Promise.resolve("{}\n");
    },
    fixtureRoot,
    () => Promise.resolve(null)
  );
  const bound = limits();
  assert.equal(await reader.read(1000, 31000, bound), "{}\n");
  assert.deepEqual(calls, [[["--unit=ai-ubq-fi.service", "--since=@1", "--until=@31", "--output=json", "--no-pager"], bound, fixtureRoot]]);
  assert.throws(() => reader.read(1000, 31001, bound), /range/);
  assert.throws(() => runVpsJournalCommand(["--unit=another.service"], bound, "/tmp"), /refused/);
});
Deno.test("VPS journal output: complete result, byte overflow and row overflow settle their owned child", async () => {
  for (const [text, bytes, entries, valid] of [
    ["{}\n", 20, 1, true],
    ["{}\n{}\n", 3, 2, false],
    ["{}\n{}\n", 20, 1, false],
  ] as const) {
    const signals: string[] = [];
    const child: VpsJournalProcess = {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      }),
      status: Promise.resolve({ success: true }),
      kill: (signal) => {
        signals.push(signal);
      },
    };
    const work = () => readVpsJournalProcess(child, { ...limits(), maxBytes: bytes, maxEntries: entries });
    if (valid) assert.equal(await work(), text);
    else {
      await assert.rejects(work, /bounds/);
      assert.ok(signals.includes("SIGTERM"));
    }
  }
});
Deno.test("VPS journal output: a silent owned child is cancelled and settled at the caller deadline", async () => {
  let settle!: (result: { success: boolean }) => void;
  let close!: () => void;
  const signals: string[] = [];
  const child: VpsJournalProcess = {
    stdout: new ReadableStream({
      start(c) {
        close = () => {
          c.close();
        };
      },
    }),
    status: new Promise((resolve) => {
      settle = resolve;
    }),
    kill: (signal) => {
      signals.push(signal);
      close();
      settle({ success: false });
    },
  };
  await assert.rejects(() => readVpsJournalProcess(child, { ...limits(), deadline: Date.now() + 30 }), /budget/);
  assert.ok(signals.includes("SIGTERM"));
});
