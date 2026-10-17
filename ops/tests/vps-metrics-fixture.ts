import { VpsJournalMetrics, type VpsJournalReader } from "../vps-release-metrics.ts";
import type { VpsIdentity } from "../vps-release-contract.ts";
import type { VpsMetricsOptions } from "../vps-metrics-types.ts";

export const boundedRows = (raw: string, start: number, end: number): string =>
  raw
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const at = Number(JSON.parse(line).__REALTIME_TIMESTAMP) / 1000;
      return at >= start && at < end;
    })
    .join("\n");
/** Test-only key, memory CAS and explicit policy. No configured key or live defaults. */
export async function metricsFixture(
  identity: VpsIdentity,
  reader: VpsJournalReader,
  now: () => number,
  start = 1_800_000_000_000,
  timeoutKinds: readonly string[] = [],
  wideKinds: readonly string[] = []
) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  let bytes: Uint8Array | null = null,
    sequence: number | null = null;
  const options: VpsMetricsOptions = {
    retention: { evidenceMaxAgeMs: 4 * 60 * 60_000, evidenceMaxBytes: 8 * 1024 * 1024 },
    deadline: start + 4 * 60 * 60_000,
    context: () =>
      Promise.resolve({
        operationId: "1".repeat(64),
        requestDigest: "2".repeat(64),
        controllerSha: "3".repeat(40),
        driverSha256: "4".repeat(64),
        candidate: identity,
        prior: { ...identity, gitSha: "f".repeat(40), deploymentId: `vps-${"f".repeat(40)}` },
        monitoringStartedAt: start,
        baselineStart: start - 1_800_000,
        baselineEnd: start,
        stateHead: "5".repeat(40),
        stateSequence: 1,
      }),
    storage: {
      load: () => Promise.resolve(bytes?.slice() ?? null),
      save: (_scope, expected, next) => {
        if (expected !== sequence) return Promise.resolve(false);
        sequence = (sequence ?? 0) + 1;
        bytes = next.slice();
        return Promise.resolve(true);
      },
    },
    cipher: {
      seal: async (plain, associatedData) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const result = new Uint8Array(
          await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array(associatedData) }, key, new Uint8Array(plain))
        );
        const sealed = new Uint8Array(iv.length + result.length);
        sealed.set(iv);
        sealed.set(result, iv.length);
        return sealed;
      },
      open: async (sealed, associatedData) =>
        new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: new Uint8Array(associatedData) },
            key,
            new Uint8Array(sealed.slice(12))
          )
        ),
    },
  };
  const metrics = new VpsJournalMetrics(reader, now, 5000, timeoutKinds, wideKinds, options);
  metrics.beginTick(now());
  return {
    metrics,
    options,
    stored: () => bytes?.slice() ?? null,
    corrupt: () => {
      if (bytes) bytes[bytes.length - 1] ^= 1;
    },
  };
}
