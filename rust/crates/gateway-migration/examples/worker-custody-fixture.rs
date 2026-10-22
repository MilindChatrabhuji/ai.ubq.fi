//! Synthetic-only stdin/stdout controller; no network, child process, or live owner access.
#[cfg(not(target_arch = "wasm32"))]
#[path = "worker-custody-fixture/host.rs"]
mod host;
#[cfg(not(target_arch = "wasm32"))]
#[path = "worker-custody-fixture/inputs.rs"]
mod inputs;
#[cfg(not(target_arch = "wasm32"))]
#[path = "worker-custody-fixture/port.rs"]
mod port;
#[cfg(not(target_arch = "wasm32"))]
#[path = "worker-custody-fixture/producers.rs"]
mod producers;
#[cfg(not(target_arch = "wasm32"))]
#[path = "worker-custody-fixture/staged.rs"]
mod staged;
#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), gateway_migration::MigrationError> {
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
        adoption_receipt: AdoptionReceipt,
    }
    #[derive(Deserialize)]
    #[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
    enum Phase {
        ExerciseRuntime { v: u32 },
        AdvanceManagedA { v: u32, artifacts: ArtifactInput },
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
    #[derive(Deserialize)]
    #[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
    enum Preparation {
        PrepareInputs {
            v: u32,
            directory: String,
            now_ms: i64,
        },
        StagedCase {
            v: u32,
            directory: String,
            now_ms: i64,
        },
        StagedPrepareOnly {
            v: u32,
            directory: String,
            now_ms: i64,
        },
    }
    // Inspect only the finite operation selector, then deserialize the ORIGINAL
    // raw document. Untagged serde buffering must not erase NativeCapture SourceJson.
    #[derive(Deserialize)]
    struct Selector {
        #[serde(default)]
        operation: Option<String>,
    }
    let initial: gateway_core::source_json::SourceJson = port::read()?;
    let selector: Selector = initial.deserialize()?;
    let init: Initialize = if selector.operation.is_none() {
        initial.deserialize()?
    } else {
        match initial.deserialize::<Preparation>()? {
            Preparation::StagedCase {
                v: 1,
                directory,
                now_ms,
            } => {
                return crate::staged::run(&directory, now_ms, false);
            }
            Preparation::StagedPrepareOnly {
                v: 1,
                directory,
                now_ms,
            } => {
                return crate::staged::run(&directory, now_ms, true);
            }
            Preparation::PrepareInputs {
                v: 1,
                directory,
                now_ms,
            } => {
                port::write(&inputs::prepare(&directory, now_ms)?)?;
                return Ok(());
            }
            _ => return Err(port::error("Unsupported fixture preparation").into()),
        }
    };
    if init.v != 1 {
        return Err(port::error("Unsupported fixture initialization").into());
    }
    let time = inputs::FixtureTime::new(init.capture.captured_at_ms)?;
    if init.now_ms != time.runtime() {
        return Err(port::error("Fixture initialization time differs").into());
    }
    time.check()?;
    let store = port::Store::default();
    let fixed = host::Host::from_stopped_fixture(&init.directory, &init.capture, init.now_ms)?;
    let candidate = support_run(sanitize_native_capture(&init.capture, &fixed))?;
    let prepared = prepare_native(&candidate)?;
    let adoption_receipt = support_run(adopt_empty(&store, &prepared))?;
    time.check()?;
    port::write(&Candidate {
        operation: "candidate",
        capture: candidate,
        adoption_receipt,
    })?;
    match port::read::<Phase>()? {
        Phase::ExerciseRuntime { v: 1 } => {}
        _ => return Err(port::error("Expected the fixed runtime producer phase").into()),
    }
    time.check()?;
    let runtime = producers::exercise(&store, time)?;
    time.check()?;
    port::write(&runtime)?;
    let artifacts: ArtifactContext = match port::read::<Phase>()? {
        Phase::AdvanceManagedA { v: 1, artifacts } => artifacts.into(),
        _ => return Err(port::error("Expected the fixed managed-a producer phase").into()),
    };
    time.check()?;
    let (fixed, receipt) = fixed.advance_managed_a(&store, time, &artifacts)?;
    time.check()?;
    port::write(&receipt)?;
    let export: Export = port::read()?;
    if export.v != 1 || export.now_ms != time.export() {
        return Err(port::error("Unsupported fixture export").into());
    }
    time.check()?;
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
    time.check()?;
    port::write(&Inverse {
        operation: "inverse",
        source,
        rust_controls,
        artifacts,
    })?;
    Ok(())
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
