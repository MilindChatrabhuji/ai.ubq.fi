//! Finite private host operations. The host owns stopped-source and target isolation.
//! A decoded request is data, never an ownership, publication or replay capability.
use crate::{
    AdoptionReceipt, ArtifactContext, MigrationError, NativeCapture, NativeRollbackBundle,
    adopt_empty, export_native_rollback_bundle, prepare_native,
};
use gateway_core::{GatewayError, identity::MAX_SAFE_INTEGER, query::QueryStore};
use serde::{Deserialize, Serialize};

pub const PRIVATE_WIRE_MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeMigrationRequest {
    pub v: u32,
    pub request: NativeOperation,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeOperation {
    AdoptNative {
        capture: NativeCapture,
    },
    ExportNativeRollback {
        now_ms: i64,
        artifacts: ArtifactInput,
    },
}

/// Explicit artifact facts only. This does not deserialize any authority proof.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactInput {
    pub rust_git_sha: String,
    pub rust_git_tree: String,
    pub wasm_sha256: String,
    pub native_sha256: String,
    pub native_nonce_capture_sha256: Option<String>,
}

impl From<ArtifactInput> for ArtifactContext {
    fn from(input: ArtifactInput) -> Self {
        Self {
            rust_git_sha: input.rust_git_sha,
            rust_git_tree: input.rust_git_tree,
            wasm_sha256: input.wasm_sha256,
            native_sha256: input.native_sha256,
            native_nonce_capture_sha256: input.native_nonce_capture_sha256,
        }
    }
}

#[derive(Serialize)]
pub struct NativeMigrationResponse {
    pub v: u32,
    pub response: NativeResult,
}

#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum NativeResult {
    Adopted { receipt: AdoptionReceipt },
    Exported { bundle: Box<NativeRollbackBundle> },
}

pub fn decode_native_request(bytes: &[u8]) -> Result<NativeMigrationRequest, GatewayError> {
    if bytes.len() > PRIVATE_WIRE_MAX_BYTES {
        return Err(wire_error("Private migration request is too large"));
    }
    serde_json::from_slice(bytes).map_err(|_| wire_error("Private migration request is invalid"))
}

pub fn encode_native_response(response: &NativeMigrationResponse) -> Result<Vec<u8>, GatewayError> {
    // Serialize SourceJson directly: a serde_json::Value roundtrip loses source UTF16.
    let bytes = serde_json::to_vec(response)
        .map_err(|_| wire_error("Private migration response cannot be encoded"))?;
    if bytes.len() > PRIVATE_WIRE_MAX_BYTES {
        return Err(wire_error("Private migration response is too large"));
    }
    Ok(bytes)
}

pub async fn execute_native<S: QueryStore>(
    store: &S,
    request: NativeMigrationRequest,
) -> Result<NativeMigrationResponse, MigrationError> {
    if request.v != 1 {
        return Err(MigrationError::from(wire_error(
            "Private migration version is unsupported",
        )));
    }
    let response = match request.request {
        NativeOperation::AdoptNative { capture } => NativeResult::Adopted {
            receipt: adopt_empty(store, &prepare_native(&capture)?).await?,
        },
        NativeOperation::ExportNativeRollback { now_ms, artifacts } => {
            if !(0..=MAX_SAFE_INTEGER).contains(&now_ms) {
                return Err(MigrationError::from(wire_error(
                    "Private migration clock is invalid",
                )));
            }
            NativeResult::Exported {
                bundle: Box::new(
                    export_native_rollback_bundle(store, now_ms, artifacts.into()).await?,
                ),
            }
        }
    };
    Ok(NativeMigrationResponse { v: 1, response })
}

fn wire_error(message: &str) -> GatewayError {
    GatewayError::new(409, message, Some("migration_wire_invalid"))
}
