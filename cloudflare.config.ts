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
      // Isolated rust-candidate direct-provider path. Production ai.ubq.fi keeps
      // its provider credentials on the VPS; this Worker never claims a native owner.
      UOS_AI_TOKEN: bindings.secret(),
      DEEPSEEK_API_KEY: bindings.secret(),
      CEREBRAS_API_KEY: bindings.secret(),
      LITHOSAI_API_KEY: bindings.secret(),
      OPENROUTER_API_KEY: bindings.secret(),
      SURPLUS_API_KEY: bindings.secret(),
      METERED_API_KEY: bindings.secret(),
      CLAUDE_API_KEY: bindings.secret(),
    },
    assets: { runWorkerFirst: true, notFoundHandling: "none" },
    observability: { enabled: true, traces: { enabled: true } },
  },
});
