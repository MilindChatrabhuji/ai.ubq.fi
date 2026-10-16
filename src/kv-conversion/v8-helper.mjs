// One-time, pinned Deno-only offline V8 codec. Never an application or CI entrypoint.
import { deserialize, Serializer } from "node:v8";
import { encodeTypedValue, decodeTypedValue } from "./typed-value.ts";

if (Deno.args[0] === "--identity") {
  console.log(Deno.version.deno);
  Deno.exit(0);
}

let pending = "";
for await (const text of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  pending += text;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const input = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    const result =
      input.operation === "decode"
        ? encodeTypedValue(deserialize(Uint8Array.from(atob(input.bytes), (char) => char.charCodeAt(0))))
        : (() => {
            if (input.operation !== "encode") throw new Error("Unsupported V8 helper operation");
            // Native Deno KV uses the standard V8 serializer. DefaultSerializer's
            // Node host-object encoding changes typed-array buffers and is incompatible.
            const serializer = new Serializer();
            serializer.writeHeader();
            serializer.writeValue(decodeTypedValue(input.value));
            const encoded = serializer.releaseBuffer();
            if (JSON.stringify(encodeTypedValue(deserialize(encoded))) !== JSON.stringify(input.value))
              throw new Error("V8 typed-value roundtrip changed semantics");
            let binary = "";
            for (const byte of encoded) binary += String.fromCharCode(byte);
            return btoa(binary);
          })();
    await Deno.stdout.write(new TextEncoder().encode(`${JSON.stringify(result)}\n`));
  }
}
if (pending.trim()) throw new Error("Incomplete V8 helper input");
