import { defineWranglerConfig } from "wrangler/experimental-config";

// Rust is compiled explicitly on the prepared VPS build host. No build hook may
// compile, install or download during a prebuilt deployment or application start.
export default defineWranglerConfig({
  assetsDirectory: "./static",
  rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }],
  types: { generate: false },
});
