/** Runtime-independent graph interchange. No V8/JSC bytes are ever confused. */
type Atom = { type: string; value?: string | number | boolean | null; ref?: number };
type GraphNode = { type: string; value?: string; items?: Atom[]; entries?: [string | Atom, Atom][]; buffer?: Atom; offset?: number; length?: number };
export type TypedValue = { root: Atom; nodes: GraphNode[] };
type Visitor = (value: unknown) => Atom;
type Reader = (value: Atom) => unknown;
const ARRAY_TYPES = {
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
  DataView,
};
const errorTypes = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new TypeError("Incomplete typed-value interchange");
  }
  return value;
};
const encodeBytes = (value: Uint8Array): string => {
  let text = "";
  for (const byte of value) {
    text += String.fromCharCode(byte);
  }
  return btoa(text);
};
const decodeBytes = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const primitiveAtom = (item: unknown): Atom | undefined => {
  if (item === null) return { type: "null", value: null };
  if (item === undefined) return { type: "undefined" };
  if (typeof item === "string" || typeof item === "boolean") return { type: typeof item, value: item };
  if (typeof item === "bigint") return { type: "bigint", value: String(item) };
  if (typeof item === "number") {
    let value: string | number = Number.isFinite(item) ? item : String(item);
    if (Object.is(item, -0)) {
      value = "-0";
    }
    return { type: "number", value };
  }
  return undefined;
};
const writeSpecialNode = (item: object, node: GraphNode, visit: Visitor): boolean => {
  if (item instanceof ArrayBuffer) {
    node.type = "ArrayBuffer";
    node.value = encodeBytes(new Uint8Array(item));
  } else if (ArrayBuffer.isView(item)) {
    node.type = item.constructor.name;
    if (!Object.hasOwn(ARRAY_TYPES, node.type)) {
      throw new TypeError("Unsupported typed array");
    }
    node.buffer = visit(item.buffer);
    node.offset = item.byteOffset;
    node.length = item.byteLength;
  } else if (item instanceof Date) {
    node.type = "Date";
    node.value = String(item.getTime());
  } else if (item instanceof RegExp) {
    node.type = "RegExp";
    node.value = item.source;
    node.items = [{ type: "string", value: item.flags }];
  } else return false;
  return true;
};
const writeContainerNode = (item: object, node: GraphNode, visit: Visitor): void => {
  if (Array.isArray(item)) {
    node.type = "Array";
    node.length = item.length;
    node.entries = Object.entries(item).map(([key, entry]) => [key, visit(entry)]);
  } else if (item instanceof Map) {
    node.type = "Map";
    node.entries = [...item].map(([key, entry]) => [visit(key), visit(entry)]);
  } else if (item instanceof Set) {
    node.type = "Set";
    node.items = [...item].map(visit);
  } else if (item instanceof Error) {
    node.type = Object.hasOwn(errorTypes, item.name) ? item.name : "Error";
    node.entries = [
      ["message", visit(item.message)],
      ["stack", visit(item.stack)],
    ];
    if (Object.hasOwn(item, "cause")) node.entries.push(["cause", visit(item.cause)]);
  } else {
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      throw new TypeError(`Unsupported runtime class: ${item.constructor.name}`);
    node.entries = Object.entries(item).map(([key, entry]) => [key, visit(entry)]);
  }
};
export const encodeTypedValue = (value: unknown): TypedValue => {
  const nodes: GraphNode[] = [];
  const seen = new Map<object, number>();
  const visit: Visitor = (item) => {
    const primitive = primitiveAtom(item);
    if (primitive) return primitive;
    if (typeof item !== "object" || item === null) throw new TypeError(`Unsupported runtime value: ${typeof item}`);
    const previous = seen.get(item);
    if (previous !== undefined) return { type: "ref", ref: previous };
    const id = nodes.length;
    const node: GraphNode = { type: "object" };
    nodes.push(node);
    seen.set(item, id);
    if (!writeSpecialNode(item, node, visit)) writeContainerNode(item, node, visit);
    return { type: "ref", ref: id };
  };
  return { root: visit(value), nodes };
};
const allocateView = (node: GraphNode, read: Reader): ArrayBufferView => {
  const buffer = read(required(node.buffer)) as ArrayBuffer;
  if (node.type === "DataView") return new DataView(buffer, node.offset, node.length);
  const ARRAY_TYPE = ARRAY_TYPES[node.type as Exclude<keyof typeof ARRAY_TYPES, "DataView">];
  return new ARRAY_TYPE(buffer, node.offset, required(node.length) / ARRAY_TYPE.BYTES_PER_ELEMENT);
};
const allocateNode = (node: GraphNode, read: Reader): unknown => {
  if (node.type === "ArrayBuffer") return decodeBytes(required(node.value)).buffer;
  if (node.type === "Date") return new Date(Number(node.value));
  if (node.type === "RegExp") return new RegExp(required(node.value), String(read(required(node.items)[0])));
  if (Object.hasOwn(ARRAY_TYPES, node.type)) return allocateView(node, read);
  if (node.type === "Array") return new Array(node.length);
  if (node.type === "Map") return new Map();
  if (node.type === "Set") return new Set();
  if (Object.hasOwn(errorTypes, node.type)) return new errorTypes[node.type as keyof typeof errorTypes]();
  if (node.type === "object") return {};
  throw new TypeError(`Unsupported interchange node: ${node.type}`);
};
const populateNode = (value: unknown, node: GraphNode, read: Reader): void => {
  if (value instanceof Map) {
    for (const [key, entry] of node.entries ?? []) {
      value.set(read(key as Atom), read(entry));
    }
    return;
  }
  if (value instanceof Set) {
    for (const entry of node.items ?? []) {
      value.add(read(entry));
    }
    return;
  }
  if (node.type !== "Array" && node.type !== "object" && !(value instanceof Error)) return;
  for (const [key, entry] of node.entries ?? []) {
    if (typeof key !== "string") throw new TypeError("Invalid interchange property key");
    Object.defineProperty(value, key, { value: read(entry), writable: true, enumerable: !(value instanceof Error), configurable: true });
  }
};
export const decodeTypedValue = (graph: TypedValue): unknown => {
  const objects = new Map<number, unknown>();
  const read: Reader = (atom) => {
    switch (atom.type) {
      case "undefined":
        return undefined;
      case "null":
        return null;
      case "string":
      case "boolean":
        return atom.value;
      case "bigint":
        return BigInt(String(atom.value));
      case "number":
        return atom.value === "-0" ? -0 : Number(atom.value);
      case "ref":
        return readNode(required(atom.ref));
      default:
        throw new TypeError(`Unsupported interchange atom: ${atom.type}`);
    }
  };
  const readNode = (id: number): unknown => {
    if (objects.has(id)) return objects.get(id);
    const node = required(graph.nodes.at(id));
    const value = allocateNode(node, read);
    objects.set(id, value);
    populateNode(value, node, read);
    return value;
  };
  return read(graph.root);
};
