# Deno Deploy Free-tier audit — 2026-08-09

## Scope and conclusion

This is a read-only audit of the Ubiquity DAO organization and the deployed `ai-ubq-fi` service. It uses the Deno Deploy
console, the organization metrics dashboard, the current repository at `development` (`3639d611b9ec`), and the official
pricing page. No plan change, app deletion, deployment, or production configuration change was performed.

The read-only production health check at 07:31:34 UTC returned HTTP 200 and reported git SHA
`3639d611b9ec9ad3d5bd8f2a538df65375e2a47d` with deployment `s648v6w0rzbh`, matching the checked-out `HEAD` used for the
code review.

**Conclusion: do not downgrade to the Free plan with the current utilization.** Outbound traffic, KV reads, KV writes,
and active-app count already exceed Free limits. A seven-day linear projection also exceeds the request and CPU limits.
The recent optimization and the later usage spike are separate effects: the code reduced the intended warm-path
accounting work, then real production use grew substantially as more coding projects used the service. The later V3
ledger also added durable admission and dispatch accounting, so raw KV totals cannot be used as proof that the whole
system became cheaper per request.

## Official Free limits

The current [Deno Deploy pricing page](https://deno.com/deploy/pricing/) lists these monthly Free-plan limits for an
organization:

| Metric           |    Free limit |
| ---------------- | ------------: |
| HTTP requests    |     1,000,000 |
| CPU time         |      15 hours |
| Memory time      |     350 GiB·h |
| Outbound traffic |         20 GB |
| Deno KV reads    | 450,000 units |
| Deno KV writes   | 300,000 units |
| Active apps      |            20 |

The pricing page is the authority for the current limits. Deno's usage and changelog documentation also describe
Free-plan over-limit behavior: request, bandwidth, CPU, or memory overages can pause a Free organization until the next
billing cycle.

## Billing snapshot

Captured from [`console.deno.com/ubiquity-dao/~/billing`](https://console.deno.com/ubiquity-dao/~/billing) at 07:27 UTC
on 2026-08-09. The billing cycle is Jul 31–Aug 31, 2026. The organization is currently on Pro ($20/month), with a $200
usage spend limit and approximately $1.99 usage-based spend. Console values are rounded and recent usage can lag in the
invoice preview.

| Metric           | Current console usage | Free limit | Result                        |
| ---------------- | --------------------: | ---------: | ----------------------------- |
| HTTP requests    |                  0.3M |         1M | under now; projection is over |
| CPU time         |                 9.4 h |       15 h | under now; projection is over |
| Memory time      |           229.6 GiB·h |  350 GiB·h | under now                     |
| Outbound traffic |                87 GiB |      20 GB | **over 4×**                   |
| KV reads         |            3.3M units |    450,000 | **over 7×**                   |
| KV writes        |            0.6M units |    300,000 | **over 2×**                   |
| Active apps      |                    24 |         20 | **4 apps over**               |

The Pro plan's larger included amounts explain why the current invoice is only about $1.99 in usage charges; those Pro
allowances are not Free allowances. Using the rounded console values directly, the current excess is about 67 GiB of
outbound traffic, 2.85M KV reads, 0.3M KV writes, and four apps. The unit labels differ (the console displays GiB while
the Free limit is published as GB), so these are order-of-magnitude comparisons rather than invoice-exact byte
conversions. Requests, CPU, and memory are still below Free at this instant; that does not erase the four resources
already over their limits.

## Recent metrics and projections

The Metrics dashboard was read at approximately 06:46–06:50 UTC. Values below are organization totals unless an
`ai-ubq-fi` value is shown separately.

### Last seven days

| Metric           | Organization | `ai-ubq-fi` |
| ---------------- | -----------: | ----------: |
| Requests         |      254,967 |     209,676 |
| CPU time         |        8.5 h |         6 h |
| Incoming traffic |     85.3 GiB |    83.6 GiB |
| Outgoing traffic |     82.9 GiB |    81.8 GiB |
| KV reads         |    3,045,320 |   2,988,453 |
| KV writes        |      596,431 |     593,723 |

Using a simple 31-day / 7-day linear projection for this billing cycle gives approximately 1.13M requests, 37.7 CPU
hours, 367 GiB outbound, 13.5M KV reads, and 2.64M KV writes. This is a planning projection, not a promise: it assumes
the recent production workload continues and does not account for future traffic changes.

`ai-ubq-fi` represents about 82% of requests, 71% of CPU time, 99% of outbound traffic, 98% of KV reads, and 99.5% of KV
writes in the seven-day window. Its outbound average is about **409 KiB per request** (binary KiB), with about 14.25 KV
reads and 2.83 KV writes per request.

### Longer windows

| Window       | Scope        | Requests |    CPU |  Outbound |  KV reads | KV writes |
| ------------ | ------------ | -------: | -----: | --------: | --------: | --------: |
| Last 30 days | Organization |  645,787 |   20 h | 164.2 GiB | 7,226,336 | 1,353,973 |
| Last 30 days | `ai-ubq-fi`  |  414,535 | 12.3 h | 160.8 GiB | 7,134,322 | 1,342,897 |
| Last 90 days | Organization |  754,400 | 24.6 h | 166.8 GiB | 7,242,853 | 1,357,431 |
| Last 90 days | `ai-ubq-fi`  |  426,372 | 12.8 h | 161.1 GiB | 7,150,838 | 1,346,355 |

The seven-day window is materially hotter than the earlier 90-day baseline. The 30-day and 90-day figures also show that
almost all KV and egress usage is from `ai-ubq-fi`, not the other 23 apps.

### Fixed-end trend samples: 7, 14, 21, and 28 days

To compare the optimization periods without a moving endpoint, I used the Metrics dashboard custom range with the same
end timestamp for every sample: **2026-08-09 07:05:21 UTC**. These are cumulative windows, not independent weeks.

#### Organization totals

| Window ending at fixed timestamp | Requests |    CPU |  Outbound |  KV reads | KV writes |
| -------------------------------- | -------: | -----: | --------: | --------: | --------: |
| 7 days                           |  256,201 |  8.5 h |  83.4 GiB | 3,055,011 |   601,698 |
| 14 days                          |  460,757 | 15.4 h | 146.3 GiB | 4,765,195 |   959,034 |
| 21 days                          |  570,660 | 18.7 h | 164.1 GiB | 7,233,992 | 1,357,736 |
| 28 days                          |  621,356 | 19.8 h | 164.6 GiB | 7,238,694 | 1,359,554 |

#### `ai-ubq-fi` overlay

| Window ending at fixed timestamp | Requests |    CPU |  Outbound |  KV reads | KV writes |
| -------------------------------- | -------: | -----: | --------: | --------: | --------: |
| 7 days                           |  210,866 |  6.0 h |  82.3 GiB | 2,997,685 |   598,888 |
| 14 days                          |  356,658 | 10.4 h | 144.3 GiB | 4,686,969 |   953,685 |
| 21 days                          |  405,100 | 12.3 h | 161.4 GiB | 7,141,771 | 1,346,655 |
| 28 days                          |  413,992 | 12.3 h | 161.4 GiB | 7,146,473 | 1,348,473 |

#### Non-overlapping weekly deltas

Subtracting adjacent cumulative windows gives this approximate sequence, with the newest week first:

| Relative week | Org requests | Org outbound | Org KV reads/writes | `ai-ubq-fi` requests | `ai-ubq-fi` outbound | `ai-ubq-fi` KV reads/writes |
| ------------- | -----------: | -----------: | ------------------: | -------------------: | -------------------: | --------------------------: |
| Days 0–7      |      256,201 |     83.4 GiB | 3,055,011 / 601,698 |              210,866 |             82.3 GiB |         2,997,685 / 598,888 |
| Days 8–14     |      204,556 |     62.9 GiB | 1,710,184 / 357,336 |              145,792 |             62.0 GiB |         1,689,284 / 354,797 |
| Days 15–21    |      109,903 |     17.8 GiB | 2,468,797 / 398,702 |               48,442 |             17.1 GiB |         2,454,802 / 392,970 |
| Days 22–28    |       50,696 |      0.5 GiB |       4,702 / 1,818 |                8,892 |             <0.1 GiB |               4,702 / 1,818 |

CPU deltas over those rows were 8.5 h, 6.9 h, 3.3 h, and 1.1 h for the organization; `ai-ubq-fi` was 6.0 h, 4.4 h, 1.9
h, and under 0.1 h (rounded) in the same order. The newest week is therefore the dominant workload, while the oldest
week is nearly idle. The high KV count in days 15–21 despite fewer requests suggests background/reconciliation or retry
activity; the dashboard does not identify its route, so it should not be attributed to a code change without a
route-level export.

At the 28-day average, a 30-day linear projection is approximately 666k organization requests, 21.2 CPU hours, 176 GiB
outbound, 7.76M KV reads, and 1.46M KV writes. The corresponding `ai-ubq-fi` projection is approximately 444k requests,
13.2 CPU hours, 173 GiB outbound, 7.66M KV reads, and 1.44M KV writes. Even this calmer four-week average remains
incompatible with Free for CPU (organization-wide), outbound traffic, KV reads, and KV writes.

For the organization-wide projection, the distance from Free is:

| Metric           | 30-day projection | Free limit | Projected difference | Multiple of Free |
| ---------------- | ----------------: | ---------: | -------------------: | ---------------: |
| HTTP requests    |              666k |         1M |           334k under |            0.67× |
| CPU time         |            21.2 h |       15 h |           6.2 h over |            1.41× |
| Outbound traffic |           176 GiB |      20 GB |  about 156 GiB over* |       about 8.8× |
| KV reads         |             7.76M |       450k |           7.31M over |            17.2× |
| KV writes        |             1.46M |       300k |           1.16M over |             4.9× |

\*The console reports GiB while the published Free allowance is expressed as GB, so the outbound difference is
intentionally rounded.

At the same projected 666k requests/month, the average resource budget would need to look like this:

| Resource         | Current 28-day average | Free budget at 666k requests | Required reduction |
| ---------------- | ---------------------: | ---------------------------: | -----------------: |
| Outbound traffic |  about 277 KiB/request |         about 29 KiB/request |                89% |
| KV reads         |          11.65/request |                 0.68/request |                94% |
| KV writes        |           2.19/request |                 0.45/request |                79% |
| CPU time         |         115 ms/request |                81 ms/request |                29% |

This is the practical feasibility boundary. CPU reduction is plausible through normal engineering work, and four
inactive apps could be removed to meet the app cap. The outbound and KV targets are architectural: they require roughly
9× less outbound/request traffic and 14–17× fewer KV reads than the current production profile, plus a substantially
cheaper durable-accounting path.

### Special-key path

The repository already has a special allowlist path; a new bypass is not needed just to test the idea:

| Credential path                                     | Handler auth kind                       | V3 API-key ledger? | Assessment                                                                                           |
| --------------------------------------------------- | --------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `UOS_AI_TOKEN`                                      | `auth_tokens_allowlist`                 | No                 | Can avoid the API-key reservation/dispatch ledger, but is a shared bearer with no per-project quota. |
| `/admin/api-keys` key, even with an unlimited limit | `kv_api_key`                            | **Yes**            | The V3 ledger still records unlimited keys; an unlimited setting does not make this path KV-free.    |
| `DENO_DEPLOY_TOKEN`                                 | `admin_allowlist` / `deno_deploy_token` | No                 | Must remain an administrative credential; do not use it as a project data-plane key.                 |

An allowlist key would remove a large part of the V3 KV overhead and could make the read side close to the Free budget
in warm isolates. It would not make the request free: successful responses still run prompt-cache telemetry, and Codex
routing, model/configuration, retries, and background jobs still use KV. To fit the write budget, telemetry would likely
need sampling or a separate trusted policy. This path is therefore a credible KV optimization, but it does not solve
outbound egress. It also removes per-project accounting and makes one leaked shared secret a system-wide incident.

### Official Codex client and outbound payloads

The gateway accepts the official Responses `context_management` parameter and forwards it upstream, but it still
receives and serializes the complete client `input` array before the upstream POST. Prompt-cache hits reduce upstream
model work; they do not remove those bytes from the Deno-to-Codex egress path. The gateway currently accepts
`previous_response_id` in its schema but does not forward it as a stateful conversation reference.

Therefore, if preserving the official Codex client semantics is a hard requirement, an 89% egress reduction cannot come
from silently dropping or rewriting old turns in the gateway. It would require a validated upstream transport/protocol
change, client-side compaction that is actually reflected in the submitted input, or materially lower production context
sizes. This is the strongest Free-tier constraint.

## Optimization timeline and normalized efficiency

The relevant commits are:

- `206f793` — **2026-07-22 15:37 EDT**, `fix: cut inference KV traffic`. This added the 30-second API-key policy cache,
  replaced the old success-only counter path with a V2 atomic `sum`, removed the old per-request dual-record API-key
  usage update, and added Codex auth/rate-limit caching. Its budget tests explicitly expected warm unlimited inference
  to perform zero KV operations and warm bounded inference to perform one read plus one atomic sum.
- `a01fc61`, `ef003be`, and `1ebcb31` — follow-up review fixes on Jul 22; `2628c23` — **2026-07-23 03:47 EDT**,
  `fix: eliminate inference-path KV
exhaustion`, completing the migration-window hardening.
- `a6d25e2` and `a8d1054` — **2026-07-23 23:16–23:22 EDT**, decoupling boot from reconciliation and making KV
  initialization lazy. These mainly reduce cold-start/background work.
- `b63990e` — **2026-07-27 05:06 EDT**, `feat: replace API-key quota
accounting with V3 ledger`. This is a
  correctness/accounting rewrite, not a pure optimization: a normal successful API-key inference now performs a policy
  read, window/request reads, a reservation CAS, dispatch reads, a dispatch CAS, and completion reads. In the current
  code that is at least seven strong `get` calls and two atomic commits writing four ledger records, before optional
  prompt-cache telemetry and retry/background work.
- Jul 27–28 prompt-cache telemetry commits (`fdfcb38`, `cf351d3`, `6eea2e5`, `94aeb70`, `a33dbe8`, `37a3b14`, `7c16025`,
  `19f5548`, `80a1f7b`, `9aa1746`) added diagnostic and capability counters. They are observability work and can add one
  or more writes per successful request.
- `c1bd41e` — **2026-07-29 15:39 EDT**, `perf(gateway): fast-path unlimited
Cerebras requests`; this is limited to
  Cerebras and does not materially change the dominant Codex path.

The live Metrics dashboard supplied two same-app comparison pairs (read at 07:29–07:33 UTC on Aug 9). These are useful
diagnostics, not a controlled experiment: request mix, provider, retry rate, background work, and deployment timing
differ between windows.

### V2 optimization window (`ai-ubq-fi`)

| Window (UTC)                                                | Requests | KV reads | KV writes | Outbound | Reads/request | Writes/request | Outbound/request |
| ----------------------------------------------------------- | -------: | -------: | --------: | -------: | ------------: | -------------: | ---------------: |
| Jul 20 00:00 → Jul 22 19:30 (before `206f793`)              |   22,038 |  449,135 |   157,050 | 11.1 GiB |         20.38 |           7.13 |          527 KiB |
| Jul 23 12:00 → Jul 26 07:30 (after V2 hardening, before V3) |   18,902 |  445,043 |   128,621 |  4.6 GiB |         23.54 |           6.80 |          257 KiB |

Outbound per request fell by about half and writes fell slightly in this pair, while reads rose. The large egress change
is consistent with a different request/input mix, so it is supporting evidence rather than causal proof of `206f793`.

### V3 ledger window (`ai-ubq-fi`)

| Window (UTC)                                         | Requests | KV reads | KV writes | Outbound | Reads/request | Writes/request | Outbound/request |
| ---------------------------------------------------- | -------: | -------: | --------: | -------: | ------------: | -------------: | ---------------: |
| Jul 25 00:00 → Jul 27 08:00 (before `b63990e`)       |   35,892 |  221,805 |    47,731 | 10.7 GiB |          6.18 |           1.33 |          313 KiB |
| Jul 27 12:00 → Jul 29 20:00 (after V3 and telemetry) |   64,200 |  661,728 |   160,353 | 28.6 GiB |         10.31 |           2.50 |          467 KiB |

This second pair shows the expected direction for the V3 accounting change: roughly 1.7× more reads and 1.9× more writes
per request. It does not mean the ledger is wrong; it means the durable reservation/dispatch invariant has a real KV
cost that must be included in any Free-tier plan.

The fixed-end weekly samples tell the same volume story. `ai-ubq-fi` averaged about 6.9k requests/day in days 15–21,
20.8k/day in days 8–14, and 30.1k/day in the newest days 0–7. Its KV rates were approximately 50.7/8.1, 11.6/2.4, and
14.2/2.8 reads/writes per request, respectively. The newest week is therefore heavier mainly because the system was used
3–4× more; the days 15–21 bucket also straddles the Jul 22–27 migrations and contains background/retry activity, so it
must not be read as a clean regression test.

## Continued read-only exploration

### The four apps above the Free app cap

The second page of the organization Applications view (`Showing 21–24 of
24`) contains:

| App                  | Console state                                 |
| -------------------- | --------------------------------------------- |
| `audit-ubq-fi`       | Last updated 3 months ago; no recent requests |
| `uusd-ubq-fi`        | Last updated 3 months ago; no recent requests |
| `uusd-ubq-fi-deno2`  | Last updated 3 months ago; no recent requests |
| `uusd-ubq-fi-canary` | Not deployed yet                              |

These are candidates for an owner decision about cleanup, but no app was deleted or disabled during this audit.

### What is driving egress

The application Logs view was sampled over the one-hour range around 06:54 UTC. The console returned 12 terminal records
in that view; this is a bounded UI sample, not a complete export of all requests. All sampled records were `responses`
SSE requests with HTTP 200. Input/output telemetry was:

- input tokens: 26,722–220,739 (median 89,483; 1,399,607 total);
- output tokens: 39–1,247 (median 138; 2,710 total);
- output tokens were only 0.194% of input tokens in this sample.

The gateway serializes the complete request body and sends it to the Codex upstream (`JSON.stringify(body)` and a
`fetch` POST in [`src/codex.ts`](../src/codex.ts#L1579)). The request body includes the full `input` array and
`stream: true` ([`src/codex.ts`](../src/codex.ts#L2692)). Deno defines the Free bandwidth allowance as egress across
deployments and excludes inbound request data. Therefore the approximately 409 KiB of outbound traffic per request is
**strongly consistent with large upstream request bodies (plus the streamed response and protocol overhead)**, rather
than with the small generated output alone. A direct per-request byte split is not available in the current terminal log
schema, so this is an attribution hypothesis supported by the code and token telemetry, not a byte-level proof.

### KV accounting boundary

For the normal API-key inference path, the code shows several separate KV stages: authentication reads the key policy;
admission strongly reads the policy, window, and request records and commits the reservation; provider dispatch reads
the request/window records and commits the dispatched state; and completion releases/settles the reservation. Terminal
prompt-cache telemetry then performs an atomic counter commit per successful completion. Same-isolate routing and
capacity state are cached for 5 seconds, and the Codex auth pool is cached for 5 minutes, so those control-plane reads
are not intended to occur on every request.

The observed seven-day average (14.25 KV reads and 2.83 KV writes per `ai-ubq-fi` request) is compatible with this
combination of quota CAS, telemetry, retries, cold isolates, and background jobs. The next optimization question is not
whether to remove quota correctness, but whether optional telemetry and redundant/retry reads can be reduced without
weakening the admission and settlement invariants.

As a separate scope check, the `ai-ubq-fi` production Metrics view showed 2,703 requests, 4.2 CPU minutes, 1.2 GiB
incoming, 1.2 GiB outgoing, 27,922 KV reads, and 10,524 KV writes in its last-hour range around 07:00 UTC. That is about
455 KiB outgoing/request, 10.3 reads/request, and 3.9 writes/request. This production-only view does not match the
organization-wide app overlay because the latter includes organization/app activity across its selected scope. The
organization-wide values remain the correct basis for Free-plan limits; the production view is useful only as a
corroborating traffic sample.

### Historical low-activity baseline

Subtracting the last-30-day totals from the last-90-day totals leaves a rough 60-day low-activity baseline of 108,613
requests, 4.6 CPU hours, 2.6 GiB outbound, 16,517 KV reads, and 3,458 KV writes for the organization. Normalized to 30
days, that is about 54k requests, 2.3 CPU hours, 1.3 GiB outbound, 8.3k KV reads, and 1.7k KV writes per month. The
subtraction is approximate because the console rounds values and does not expose a matching historical memory-time
series here. The user has since confirmed that the newer, heavier activity is real production usage, so this older
low-activity period is not a valid reason to expect a Free-tier fit.

The current production workload has already exceeded several Free limits, and the organization still has 24 apps. A
future Free-plan trial would require materially reducing production resource use, a fresh full-cycle measurement
(including memory time), and an owner decision to bring active apps to 20 or fewer.

## Code-level usage drivers

These are cost/accounting observations, not a recommendation to remove safety or quota controls without a separate
design review:

- [`serve.ts`](../serve.ts#L9) registers a KV-backed reconciliation cron every minute and a provider-capacity sampler
  every 15 minutes. These create a background floor even when request traffic is quiet.
- [`src/auth.ts`](../src/auth.ts#L665) resolves KV during client authentication. API-key requests then perform a strong
  policy read through `authenticateApiKeyToken` and continue into quota admission.
- [`src/api_key_policy.ts`](../src/api_key_policy.ts#L618) performs a strong policy read plus strong window/request
  reads for admission, followed by an atomic reservation commit (`#L708`). Dispatch and release paths perform additional
  reads/atomic commits. This is the main candidate for reducible per-request KV overhead, but any change must preserve
  idempotency and quota correctness.
- [`src/handler.ts`](../src/handler.ts#L188) logs terminal telemetry and calls `recordPromptCacheTelemetry` for
  completed requests. The telemetry gate uses an atomic KV counter commit per successful completion
  ([`src/prompt_cache_telemetry_gate.ts`](../src/prompt_cache_telemetry_gate.ts#L321)). This is an observability write,
  separate from the quota ledger.
- [`src/handler.ts`](../src/handler.ts#L265) forwards SSE response chunks from the provider without a compression layer.
  The response path can therefore add framing and output bytes, but the one-hour sample suggests that the much larger
  upstream request body is the dominant egress component. The metrics do not by themselves provide a per-request byte
  split.

## Raspberry Pi feasibility

This service is technically portable to ARM64 Linux because the runtime entrypoint is a normal Deno `serve.ts` handler
and local Deno KV is supported. The earlier Pi 5 estimate below is hardware-conditional; it does not describe the
Raspberry Pi that is currently available.

### Live Pi preflight (2026-08-09 08:00 UTC)

The requested bounded SSH inspection was read-only. It found:

| Fact                     | Observation                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| Hardware                 | Raspberry Pi Zero 2 W Rev 1.0; 4 Cortex-A53 cores; aarch64                                              |
| Operating system         | Debian GNU/Linux 12 (Bookworm); Linux 6.12.47+rpt-rpi-v8                                                |
| Memory                   | 464 MiB total; 160 MiB available during the check; 860 MiB swap, 602 MiB free                           |
| Runtime                  | Deno 2.9.2, Bun 1.1.21, Node 22.19.0                                                                    |
| Storage                  | 119.4 GB `mmcblk0` microSD root disk; 92 GB free; no SSD/NVMe                                           |
| Current load             | 0.20 (1-minute load); SoC temperature about 40.8 C                                                      |
| Existing public services | Two `cloudflared` tunnels, a Pi-local KV service, and other Pi tooling                                  |
| Target checkout          | `/home/pi/repos/ubiquity/ai.ubq.fi`, clean `development` branch, 14 commits behind `origin/development` |
| Target service           | No `ai.ubq.fi` systemd service, listener, or scheduled job is installed                                 |

The running `pi-agent-deno.service` is a separate application rooted at `/home/pi/repos/0x4007/pi-agent`; the other Deno
listener is the Ubiquity OS kernel. Existing timers cover Pi telemetry and a Pi-agent KV backup only. The Pi therefore
is not currently serving this gateway, and its current idle headroom is not a gateway capacity measurement.

The Zero 2 W is not a realistic production primary for the observed workload. At roughly 0.35 requests/second and 1.2
Mbps average outbound traffic, its CPU could plausibly serve a low-concurrency personal proxy, but the 464 MiB memory
budget leaves little room for a Deno gateway, large Codex input arrays, local KV cache/database pages, two tunnels, and
request concurrency. The system is already using swap at idle, and the microSD-backed root disk is a poor target for
write-heavy local KV state. Large-body peaks and tail latency were not measured, so an average-rate calculation cannot
establish safe capacity.

The appropriate hardware floor for a serious self-hosting experiment is at least a Pi 5 with 8 GB RAM, active cooling,
and SSD/NVMe-backed local KV. Even that would need a bounded load test, external backups, a reverse proxy or tunnel,
TLS/firewall rules, watchdog/restart policy, and an explicit availability plan. It would move the current approximately
82 GiB/week of egress to the home/office uplink and make the device a single point of failure.

The current Deploy-specific behavior is also incomplete on a Pi: the two `Deno.cron` jobs are registered only when
`config.isDeploy` is true. A Pi deployment would need systemd timers or another scheduler for paid-fallback
reconciliation and provider-capacity sampling, plus a deliberate local-KV backup and restore procedure.

The latest `ai-ubq-fi` week averaged about 0.35 requests/second, 1.2 Mbps of outbound traffic, 3.6% of one CPU core by
the dashboard's CPU-time measure, about 5 KV reads/second, and about 1 KV write/second. A Pi 5 with 8 GB RAM, active
cooling, and an SSD/NVMe-backed local KV database should plausibly handle that average gateway workload. Peak
concurrency, large request bodies, and memory-time were not measured here, so a Pi 4 or SD-card-only setup should not be
treated as production-capable without a load test.

Running on a Pi would not make the resource use disappear. The approximately 82 GiB/week of current outbound traffic
would move to the home/office ISP or the tunnel provider, and the Pi would become a single point of failure. Public
service would need a reverse proxy or Cloudflare/Tailscale tunnel, TLS, firewalling, secret protection, SSD backups, a
UPS, and systemd restart/watchdog policy. Local KV would also lose Deno Deploy's managed durability and multi-isolate
availability. The Pi is realistic for a personal gateway or a carefully operated primary with a standby, but it is not
an equivalent drop-in replacement for Deno Deploy's edge and availability model.

## Cheaper hosting options

Deno remains the best runtime fit for this codebase. The entrypoint is already Deno/TypeScript, the upstream path uses
standard `fetch` and Web Streams, and the current tests and scripts are Deno-native. Deno Deploy is the best managed
fit, but it is not the lowest-cost host once the gateway is used heavily.

The official [Deno Deploy pricing page](https://deno.com/deploy/pricing/) currently lists Pro at $20/month, with 200 GB
egress, 1.3M KV reads, and 0.9M KV writes included. Overage is $0.50/GB egress, $1/M reads, and $2.50/M
writes. Applying those rates to the existing 28-day organization projection
(666k requests, 176 GiB egress, 7.76M reads, 1.46M writes) gives an estimated
**$27.86/month** before taxes or unrelated usage. This is a rounded planning estimate; the egress GiB-to-GB conversion
can move it slightly.

The newest `ai-ubq-fi` week is much hotter than that smoothed average (about 82.3 GiB egress, 3.0M reads, and 0.6M
writes). If that week repeats for a month, Pro egress alone would exceed its included allowance, and the total is
roughly **$115–$125/month** depending on the unit conversion. This is why the recent production pattern matters more
than the quiet historical baseline. This is a **stress-case run-rate**, not the current invoice forecast. In the 08:00
UTC snapshot, requests, CPU, memory time, egress, and writes were within Pro allowances; only KV reads were over the
included Pro amount. The displayed $1.99 usage charge is consistent with approximately 2M read units over the 1.3M
monthly allowance. The current-cycle expectation is therefore closer to the $20 base plus a small KV overage unless the
newest hot week continues.

| Host                                                                              |                                                               Current public starting point | Fit for this gateway                                                        | Main trade-off                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------: | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Deno Deploy Pro](https://deno.com/deploy/pricing/)                               |                                                                        $20/month plus usage | Drop-in managed edge, Deploy KV, logs, and scaling                          | Most operationally convenient; hot-week egress can make it expensive                                                          |
| [AWS Lightsail](https://aws.amazon.com/lightsail/pricing/)                        | $10/month for 2 GB, 2 vCPUs, 60 GB SSD, 3 TB transfer (North America; 1 GB/$5 is too tight) | Strong low-cost first migration target; run Deno under systemd and local KV | You own patching, backups, TLS, monitoring, and availability                                                                  |
| [DigitalOcean Droplet](https://www.digitalocean.com/pricing/droplets)             |                                   $12/month for 2 GB, 1 vCPU, 50 GB SSD, 2,000 GiB transfer | Similar VPS path with simple tooling                                        | More expensive than Lightsail at this size; still self-managed                                                                |
| [Hetzner Cloud](https://www.hetzner.com/cloud)                                    |                                    Usually the lowest-cost VPS class, region/plan dependent | Good economics and generous transfer for a Deno VM                          | Check US-region availability and accept full operations responsibility                                                        |
| [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/) |                                $5/month paid account minimum; no additional transfer charge | Potentially the cheapest managed egress path                                | Not a drop-in: replace Deno KV with D1/Durable Objects and replace `Deno.cron`; validate long SSE and strong ledger semantics |
| Current Pi Zero 2 W                                                               |                                                                              No hosting fee | Development or low-concurrency standby only                                 | 464 MiB RAM, swap pressure, microSD writes, home-network failure domain                                                       |

The practical recommendation is to keep the Deno code and, if the goal is lower cash cost, move the same service to a
**2 GB VPS**. Lightsail at $10 or a similar Hetzner plan is likely materially cheaper than a hot Deno Deploy month while
retaining enough memory for large Codex request bodies. Use SSD-backed local KV, systemd timers for the two Deploy cron
jobs, Caddy or another streaming-safe TLS proxy, off-host backups, and a rollback path. This saves hosting money but
transfers operations and availability risk to us.

Cloudflare Workers is worth a separate prototype only if eliminating egress charges is more important than preserving
the current storage implementation. It would be an architectural migration, not an infrastructure-only move.

## Open questions for the next read-only pass

1. Confirm which of the 24 apps are intentionally retained; the four overflow apps and their current console states are
   recorded above. Deleting or disabling them requires explicit approval.
2. Separate unavoidable KV operations (authentication, quota reservation, dispatch/release) from optional telemetry and
   background reconciliation.
3. Obtain a bounded byte-level measurement for upstream request bodies versus streamed responses; terminal logs provide
   token counts but not byte counts.
4. Re-run the projection after any production optimization; evaluate Free only after the resource budgets are met for a
   full cycle and active apps are at most 20.

## Post-optimization observation and rollback records

Append one completed record below after every accepted production optimization. Do not revise an earlier record's
observed values, timestamp, sampling end, or release identity. The organization total is the billing decision; the
`ai-ubq-fi` overlay is attribution only. This is a manual Deno Console record, not a new gateway metric, cron job, or
automated alert.

### Template — `<change name>` — `<observed_at_utc>`

**Change and sampling boundary**

| Field                       | Value                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| Accepted source commit      | `<full commit SHA>`                                                           |
| Observation UTC time        | `<YYYY-MM-DDTHH:MM:SSZ>`                                                      |
| Billing-cycle start and end | `<start UTC>` to `<end UTC>`                                                  |
| Common fixed Metrics end    | `<YYYY-MM-DDTHH:MM:SSZ>`                                                      |
| Metrics source              | `Deno Deploy organization Metrics; organization total plus ai-ubq-fi overlay` |
| Raw dashboard units         | `<record exactly as displayed; egress is GiB in the Console>`                 |

Use the same fixed Metrics end for each cumulative custom range. Preserve the raw values and units; do not treat GiB and
GB as interchangeable.

| Cumulative window | Scope               |  Requests |  CPU time | Memory time |    Egress |  KV reads | KV writes |
| ----------------- | ------------------- | --------: | --------: | ----------: | --------: | --------: | --------: |
| 7 days            | Organization        | `<value>` | `<value>` |   `<value>` | `<value>` | `<value>` | `<value>` |
| 7 days            | `ai-ubq-fi` overlay | `<value>` | `<value>` |   `<value>` | `<value>` | `<value>` | `<value>` |
| 14 days           | Organization        | `<value>` | `<value>` |   `<value>` | `<value>` | `<value>` | `<value>` |
| 14 days           | `ai-ubq-fi` overlay | `<value>` | `<value>` |   `<value>` | `<value>` | `<value>` | `<value>` |
| 21 days           | Organization        | `<value>` | `<value>` |   `<value>` | `<value>` | `<value>` | `<value>` |
| 21 days           | `ai-ubq-fi` overlay | `<value>` | `<value>` |   `<value>` | `<value>` | `<value>` | `<value>` |
| 28 days           | Organization        | `<value>` | `<value>` |   `<value>` | `<value>` | `<value>` | `<value>` |
| 28 days           | `ai-ubq-fi` overlay | `<value>` | `<value>` |   `<value>` | `<value>` | `<value>` | `<value>` |

**Warning and economics**

| Item                             | Record                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Current-cycle organization usage | `<Billing dashboard values and source time>`                                                             |
| Manual warning state             | `Egress: <below/at-or-over 150 GB>; reads: <below/at-or-over 1.0M>; writes: <below/at-or-over 0.7M>`     |
| Egress unit handling             | `Console GiB value: <value>; 139 GiB is the conservative warning before 150 GB; preserve the raw unit.`  |
| Current-cycle Pro economics      | `<actual base charge, accrued usage charge, and dashboard timestamp>`                                    |
| Smoothed Pro economics           | `<28-day fixed-end projection, rate source, unit conversion, and estimate>`                              |
| Hot-week Pro economics           | `<stress-case window, extrapolation, rate source, and estimate; not a forecast unless sustained>`        |
| Free feasibility                 | `<pass/fail for every Free limit, including active apps; never substitute this for a Pro cost estimate>` |

**Live deployment identity and rollback**

| Field                                           | Value                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Health URL and observation time                 | `<URL>; <YYYY-MM-DDTHH:MM:SSZ>`                                         |
| `release.git_sha` / `x-uos-git-sha`             | `<full SHA; values must match>`                                         |
| `release.deployment_id` / `x-uos-deployment-id` | `<deployment ID; values must match>`                                    |
| Deployment workflow attestation                 | `<Actions run URL or identifier; Git SHA and deployment ID>`            |
| Prior known-good SHA and deployment ID          | `<full SHA>; <deployment ID>`                                           |
| Rollback trigger                                | `<specific correctness, availability, streaming, or budget regression>` |
| Owner-approved rollback target                  | `<known-good SHA via the normal deployment workflow>`                   |
| Post-rollback health identity                   | `<UTC time; full SHA; deployment ID; header/body match>`                |
| Post-rollback fixed-end sample                  | `<UTC time and result, or not yet due>`                                 |

Do not delete KV data to roll back an optimization. A healthy `/health` result attests the routed release only; it does
not prove egress, KV usage, streaming, or billing acceptance.
