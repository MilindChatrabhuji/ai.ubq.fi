export type ConversionDirection = "deno-to-bun" | "bun-to-deno";
const prefix = ["uos_ai", "sentinel_replay", "v1"];
const bootstrapParts = ["accounting", "chunk", "dedupe", "evicted", "manifest", "request", "reservation"];
/** These known keys use ASCII string parts only; arbitrary database keys stay opaque. */
export const packStringKey = (parts: readonly string[]): Uint8Array => new Uint8Array(parts.flatMap((part) => [2, ...new TextEncoder().encode(part), 0]));
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const cursorForPrefix = (cursor: string, parts: readonly string[], direction: ConversionDirection): string => {
  const packed = packStringKey(parts);
  if (direction === "deno-to-bun") {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(cursor)) throw new Error("Invalid legacy cursor");
    const suffix = Buffer.from(cursor, "base64url");
    let unpadded = cursor;
    while (unpadded.endsWith("=")) unpadded = unpadded.slice(0, -1);
    if (suffix.toString("base64url") !== unpadded) throw new Error("Noncanonical legacy cursor");
    return Buffer.from(JSON.stringify({ lastYieldedKeyBytes: hex(new Uint8Array([...packed, ...suffix])) })).toString("base64");
  }
  const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as { lastYieldedKeyBytes?: unknown };
  if (typeof decoded.lastYieldedKeyBytes !== "string" || !/^(?:[a-f0-9]{2})+$/.test(decoded.lastYieldedKeyBytes)) throw new Error("Invalid Bun cursor");
  const full = Buffer.from(decoded.lastYieldedKeyBytes, "hex");
  if (!full.subarray(0, packed.length).equals(packed)) throw new Error("Cursor outside expected replay prefix");
  return full.subarray(packed.length).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
};

/** Translate only the two persisted opaque cursor fields; typed-key cursors are unchanged. */
export const transcodePersistedCursor = (key: Uint8Array, value: unknown, direction: ConversionDirection): { value: unknown; changed: boolean } => {
  if (hex(key) === hex(packStringKey([...prefix, "reap_cursor"]))) {
    if (typeof value !== "string" || !value) throw new Error("Malformed replay reaper cursor");
    return { value: cursorForPrefix(value, [...prefix, "accounting"], direction), changed: true };
  }
  if (hex(key) !== hex(packStringKey([...prefix, "budget"]))) return { value, changed: false };
  if (value === null || typeof value !== "object" || !("bootstrap_cursor" in value)) throw new Error("Malformed replay budget ledger");
  const ledger = value as Record<string, unknown>;
  if (ledger.bootstrap_cursor === null) return { value, changed: false };
  if (typeof ledger.bootstrap_cursor !== "string") throw new Error("Malformed replay bootstrap cursor");
  const match = /^(\d+)\|(.*)$/.exec(ledger.bootstrap_cursor);
  if (!match || !bootstrapParts[Number(match[1])]) throw new Error("Unsupported replay bootstrap prefix");
  if (!match[2]) return { value, changed: false };
  return {
    value: { ...ledger, bootstrap_cursor: `${match[1]}|${cursorForPrefix(match[2], [...prefix, bootstrapParts[Number(match[1])]], direction)}` },
    changed: true,
  };
};
