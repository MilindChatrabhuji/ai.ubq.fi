import { KvU64 } from "@deno/kv";

/** Inspect supported data graphs once, without another serialization or getter call. */
export const assertPortableKvValue = (value: unknown): void => {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error && Object.hasOwn(current, "cause")) {
      throw new TypeError("Bun KV cannot preserve Error.cause; persist an explicit error record instead");
    }
    if (current instanceof Map) {
      Map.prototype.forEach.call(current, (entry: unknown, key: unknown) => pending.push(key, entry));
      continue;
    }
    if (current instanceof Set) {
      Set.prototype.forEach.call(current, (entry: unknown) => pending.push(entry));
      continue;
    }
    if (current instanceof KvU64 || current instanceof ArrayBuffer || ArrayBuffer.isView(current) || current instanceof Date || current instanceof RegExp)
      continue;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new TypeError("Bun KV requires materialized values rather than accessor properties");
      pending.push(descriptor.value);
    }
  }
};
