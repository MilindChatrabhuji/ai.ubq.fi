# Baseline adapters (m03)

Worker `m03-baseline-adapters-de0bd1341f`. Deterministic **fake-transport** baselines for the benchmark foundation
(m02): the runner still refuses every one of them (`requiresExternalInference: true`), and all traffic goes through an
injected transport, so focused tests stay hermetic and offline.

## Adapters

| id  | adapter                 | behavior                                                               | default instance                                  |
| --- | ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| A   | `gateway-gpt-oss-chat`  | current gateway GPT-OSS Chat Completions behavior (m01 generic style)  | live gateway transport (`gpt-oss-120b`), refused  |
| B   | `codex-infinity-bridge` | codex-infinity-compatible process/trajectory bridge, pinned provenance | inert: never clones, never spawns                 |
| D   | `strong-control`        | generic strong control over an owner-approved OpenAI-compatible model  | placeholder model, null transport, always refused |

All implement `BenchmarkAdapter` from `benchmarks/adapter.ts` (schema 1.0) and write schema-valid events through
`AdapterRunContext.record`. The runner derives metrics, runs verification and evaluates oracles exactly as for the
`reference` adapter; a baseline run is successful only when the declared verification and oracle pass.

## Files

```
benchmarks/baselines/
  errors.ts        # not-provisioned / config / upstream / bridge errors
  transport.ts     # ChatTransport interface, gateway + OpenAI-compatible transports
  tools.ts         # canonical tool execution (mirror of the m02 tool layer)
  chat-loop.ts     # shared deterministic chat-agent loop (A and D)
  adapter-a.ts     # current gateway GPT-OSS Chat baseline
  adapter-b.ts     # codex-infinity process/trajectory bridge + scripted driver
  adapter-d.ts     # generic strong control baseline
  registry.ts      # baselineAdapters() -> [A, B, D]
  tests/*.test.ts  # focused hermetic tests
```

## Running the focused tests

From the repository root (the test suite runs disposable workspaces and the declared verification commands, so the same
permissions as the m02 test task are needed):

```sh
deno test --allow-read --allow-write=benchmark-runs --allow-run=sh,git benchmarks/baselines/tests
```

The adapters live in `baselineAdapters()`, deliberately **outside** `defaultAdapters()` (owned by m02).
`deno task benchmark:run --configs=A` therefore reports the config as unknown until the orchestrator wires the registry
into the shared runner; the in-repo refusal property is asserted by `registry.test.ts`
(`runBenchmarks(..., adapters: baselineAdapters())` throws the external-inference refusal).

## Provisioning (never performed by the adapter)

- **A**: no setup; uses the existing `CEREBRAS_API_KEY` at request time, exactly like the gateway.
- **B**: checkout the pinned revision manually and point
  `createBaselineB({ driver: "live", config: { checkoutPath, allowLiveProcess: true } })` at it, or install the pinned
  npm package. The adapter verifies the pinned ref, then spawns the process. The `codex-infinity` JSONL output schema is
  **not verified yet** — see the research report.
- **D**: attach an approved model plus an explicitly supplied transport. No new secrets or env interfaces are introduced
  by this module.

## Research report

Primary source URLs, provenance and every fact that needs later live verification are recorded in
[docs/research/cerebras-agent-baselines.md](../../docs/research/cerebras-agent-baselines.md).
