// JSON wire vocabulary retained from @deno/kv-utils 0.1.4 (MIT, Deno authors).
import { KvU64, type Kv, type KvEntry, type KvKey, type KvKeyPart, type KvListSelector } from "#kv";

export type KvValueJson = { type: string; value?: unknown; byteLength?: number };
export type KvEntryJson = { key: KvValueJson[]; value: KvValueJson; versionstamp: string };
const bytes = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(value, "base64url"));
const binary = (type: string, value: Uint8Array): KvValueJson => ({ type, value: Buffer.from(value).toString("base64url"), byteLength: value.byteLength });
const typedArrays = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};
const errors = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };

export const keyPartToJson = (value: KvKeyPart): KvValueJson => {
  if (value instanceof Uint8Array) return binary("Uint8Array", value);
  if (typeof value === "bigint") return { type: "bigint", value: String(value) };
  if (typeof value === "number") return { type: "number", value: Number.isFinite(value) ? value : String(value) };
  return { type: typeof value, value };
};
export const keyToJson = (key: KvKey): KvValueJson[] => key.map(keyPartToJson);

const profileObjectToJson = (value: object, encode: (item: unknown) => KvValueJson): KvValueJson => {
  if (value instanceof KvU64) return { type: "KvU64", value: String(value.value) };
  if (value instanceof Date) return { type: "Date", value: value.toJSON() };
  if (value instanceof RegExp) return { type: "RegExp", value: String(value) };
  if (value instanceof ArrayBuffer) return binary("ArrayBuffer", new Uint8Array(value));
  // Preserve the legacy profile payload contract, including its whole backing-buffer representation.
  if (ArrayBuffer.isView(value)) return { ...binary(value.constructor.name, new Uint8Array(value.buffer)), byteLength: value.byteLength };
  if (Array.isArray(value)) return { type: "Array", value: value.map(encode) };
  if (value instanceof Map) return { type: "Map", value: [...value].map(([key, item]) => [encode(key), encode(item)]) };
  if (value instanceof Set) return { type: "Set", value: [...value].map(encode) };
  if (value instanceof Error) {
    const detail: Record<string, unknown> = { message: value.message };
    if (value.stack) detail.stack = value.stack;
    if (value.cause) detail.cause = encode(value.cause);
    return { type: Object.hasOwn(errors, value.name) ? value.name : "Error", value: detail };
  }
  return { type: "object", value: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) };
};

export const valueToJson = (value: unknown, ancestors = new Set<object>()): KvValueJson => {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null", value: null };
  if (typeof value !== "object") {
    if (!["bigint", "boolean", "number", "string"].includes(typeof value)) throw new TypeError("Unsupported profile value");
    return keyPartToJson(value as KvKeyPart);
  }
  if (ancestors.has(value)) throw new TypeError("Profile JSON cannot represent cyclic values; use full runtime conversion");
  const next = new Set(ancestors).add(value);
  return profileObjectToJson(value, (item) => valueToJson(item, next));
};

export const toValue = (input: unknown): unknown => {
  if (!input || typeof input !== "object" || !("type" in input) || typeof input.type !== "string") throw new TypeError("Malformed profile value");
  const json = input as KvValueJson;
  const value = json.value;
  if (Object.hasOwn(typedArrays, json.type)) {
    const ARRAY_TYPE = typedArrays[json.type as keyof typeof typedArrays];
    return new ARRAY_TYPE(bytes(String(value)).buffer);
  }
  if (Object.hasOwn(errors, json.type)) {
    const ERROR_TYPE = errors[json.type as keyof typeof errors];
    const detail = value as { message: string; stack?: string; cause?: KvValueJson };
    const error = new ERROR_TYPE(detail.message, detail.cause ? { cause: toValue(detail.cause) } : undefined);
    if (detail.stack) Object.defineProperty(error, "stack", { value: detail.stack, configurable: true });
    return error;
  }
  switch (json.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "bigint":
      return BigInt(String(value));
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "boolean":
    case "string":
      return value;
    case "KvU64":
      return new KvU64(BigInt(String(value)));
    case "ArrayBuffer":
      return bytes(String(value)).buffer;
    case "DataView":
      return new DataView(bytes(String(value)).buffer);
    case "Date":
      return new Date(value as string);
    case "RegExp": {
      const pattern = String(value);
      const split = pattern.lastIndexOf("/");
      return new RegExp(pattern.slice(1, split), pattern.slice(split + 1));
    }
    case "Array":
      return (value as KvValueJson[]).map(toValue);
    case "Set":
      return new Set((value as KvValueJson[]).map(toValue));
    case "Map":
      return new Map((value as [KvValueJson, KvValueJson][]).map(([key, item]) => [toValue(key), toValue(item)]));
    case "object":
      return Object.fromEntries(Object.entries(value as Record<string, KvValueJson>).map(([key, item]) => [key, toValue(item)]));
    default:
      throw new TypeError(`Unsupported profile value type: ${json.type}`);
  }
};

export const toKey = (json: readonly KvValueJson[]): KvKey =>
  json.map((part) => {
    if (!["bigint", "boolean", "number", "string", "Uint8Array"].includes(part.type)) throw new TypeError("Unsupported profile key type");
    return toValue(part) as KvKeyPart;
  });

export const entryToJson = (entry: KvEntry<unknown>): KvEntryJson => ({
  key: keyToJson(entry.key),
  value: valueToJson(entry.value),
  versionstamp: entry.versionstamp,
});

/** This is the existing profile NDJSON contract, not an expiry-preserving database export. */
export const exportEntries = (kv: Kv, selector: KvListSelector): ReadableStream<Uint8Array> => {
  const iterator = kv.list(selector);
  return new ReadableStream({
    async pull(controller) {
      const entry = await iterator.next();
      if (entry.done) controller.close();
      else controller.enqueue(new TextEncoder().encode(`${JSON.stringify(entryToJson(entry.value))}\n`));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
};
