import { bindings, defineConfig, exports } from "cf/config";

const workerName = "uos-ai-rust-candidate";

export default defineConfig({
  accountId: "5c0228bee348f4cf48829ffe21b61fe9",
  worker: {
    name: workerName,
    compatibilityDate: "2026-10-18",
    compatibilityFlags: ["enable_request_signal", "request_signal_passthrough"],
    entrypoint: "./rust/crates/gateway-worker/build/index.js",
    workersDev: true,
    previewUrls: false,
    exports: {
      GatewayAuthority: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      AUTHORITY: bindings.durableObject({ worker: workerName, exportName: "GatewayAuthority" }),
      ASSETS: bindings.assets(),
    },
    assets: { runWorkerFirst: true, notFoundHandling: "none" },
    observability: { enabled: true, traces: { enabled: true } },
  },
});
