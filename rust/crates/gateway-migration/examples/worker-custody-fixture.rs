//! Synthetic-only stdin/stdout controller; no network, child process, or live owner access.
#[cfg(not(target_arch = "wasm32"))]
#[path = "worker-custody-fixture/host.rs"]
mod host;
#[cfg(not(target_arch = "wasm32"))]
#[path = "worker-custody-fixture/port.rs"]
mod port;
#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), gateway_core::GatewayError> {
    use gateway_core::state::AuthorityStore;
    use gateway_migration::{operational::ArtifactInput, *};
    use serde::{Deserialize, Serialize};
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Initialize {
        v: u32,
        directory: String,
        now_ms: i64,
        capture: NativeCapture,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Export {
        v: u32,
        now_ms: i64,
        artifacts: ArtifactInput,
    }
    #[derive(Serialize)]
    struct Candidate {
        operation: &'static str,
        capture: NativeCapture,
    }
    #[derive(Serialize)]
    struct Inverse {
        operation: &'static str,
        source: NativeCapture,
        rust_controls: Vec<CustodyRecord>,
        artifacts: ArtifactContext,
    }
    assert_eq!(
        std::env::args_os().len(),
        1,
        "The fixture accepts no source, credential, endpoint or target arguments"
    );
    let init: Initialize = port::read()?;
    if init.v != 1 {
        return Err(port::error("Unsupported fixture initialization"));
    }
    let store = port::Store::default();
    let fixed = host::Host::from_stopped_fixture(&init.directory, &init.capture, init.now_ms)?;
    let candidate = support_run(sanitize_native_capture(&init.capture, &fixed))?;
    port::write(&Candidate {
        operation: "candidate",
        capture: candidate,
    })?;
    let export: Export = port::read()?;
    if export.v != 1 {
        return Err(port::error("Unsupported fixture export"));
    }
    let current =
        support_run(store.read(&gateway_auth::provider_credentials::codex_source_pool_key()))?
            .ok_or_else(|| port::error("Current fixture source pool is missing"))?;
    let fixed = fixed.with_current_pool(&current, export.now_ms)?;
    let bundle = support_run(export_native_rollback_with_custody(
        &store,
        export.now_ms,
        &fixed,
        export.artifacts.into(),
    ))?;
    let (source, rust_controls, artifacts) = bundle.into_private_parts();
    port::write(&Inverse {
        operation: "inverse",
        source,
        rust_controls,
        artifacts,
    })
}
#[cfg(not(target_arch = "wasm32"))]
fn support_run<F: std::future::Future>(future: F) -> F::Output {
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}
#[cfg(target_arch = "wasm32")]
fn main() {}
