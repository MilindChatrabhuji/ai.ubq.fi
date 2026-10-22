import { bindings, defineConfig, exports } from "cf/config";

const workerName = "uos-ai-rust-candidate";

export default defineConfig({
  accountId: "5c0228bee348f4cf48829ffe21b61fe9",
  worker: {
    name: workerName,
    compatibilityDate: "2026-10-18",
    compatibilityFlags: ["enable_request_signal", "request_signal_passthrough"],
    entrypoint: "./rust/crates/gateway-worker/entrypoint.mjs",
    workersDev: true,
    previewUrls: false,
    exports: {
      GatewayAuthority: exports.durableObject({ storage: "sqlite" }),
      InitialControlInstaller: exports.worker(),
    },
    env: {
      AUTHORITY: bindings.durableObject({ worker: workerName, exportName: "GatewayAuthority" }),
      ASSETS: bindings.assets(),
      UOS_CANDIDATE_NATIVE_V1: bindings.secret(),
      UOS_CANDIDATE_INITIAL_SEAL_V1: bindings.secret(),
    },
    assets: { runWorkerFirst: true, notFoundHandling: "none" },
    observability: { enabled: true, traces: { enabled: true } },
  },
});
