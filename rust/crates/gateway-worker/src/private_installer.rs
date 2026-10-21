//! Private account-operator composition. Ordinary fetch must never call this module.
//! Runtime registration supplies the trusted deployment seal and actual namespace.
use gateway_authority::initial_control_owner::{
    INITIAL_AUTHORITY_BINDING, INITIAL_AUTHORITY_OBJECT, InitialControlOwnerDeployment,
    PreparedInitialControlOwner,
};
use gateway_core::GatewayError;
use gateway_migration::{NativeCapture, PreparedAdoption};
use serde::Deserialize;
use worker::{
    Env, js_sys,
    wasm_bindgen::{self, JsValue},
};

/// The generated builder exports this Rust class, not a free default-RPC method.
/// Only the named platform wrapper supplies the deployment's actual environment.
#[wasm_bindgen::prelude::wasm_bindgen]
pub struct RustInitialControlInstaller {
    env: Env,
}

#[wasm_bindgen::prelude::wasm_bindgen]
impl RustInitialControlInstaller {
    #[wasm_bindgen(constructor)]
    pub fn new(env: Env) -> Self {
        Self { env }
    }

    /// Fixed read-only target description; no object fetch, rows or owner data.
    #[wasm_bindgen(js_name = describeTarget)]
    pub fn describe_target(&self) -> Result<JsValue, JsValue> {
        let namespace = self
            .env
            .durable_object(INITIAL_AUTHORITY_BINDING)
            .map_err(|_| rejected())?;
        let object_id = namespace
            .id_from_name(INITIAL_AUTHORITY_OBJECT)
            .map_err(|_| rejected())?
            .to_string();
        let descriptor = serde_json::json!({
            "v":1,
            "worker_git_sha":env!("UOS_RUST_BUILD_GIT_SHA"),
            "worker_git_tree":env!("UOS_RUST_BUILD_GIT_TREE"),
            "authority_object_name":INITIAL_AUTHORITY_OBJECT,
            "authority_object_id":object_id
        });
        js_sys::JSON::parse(&descriptor.to_string()).map_err(|_| rejected())
    }

    #[wasm_bindgen(js_name = installInitialControlOwner)]
    pub fn install_initial_control_owner(&self, input: js_sys::Uint8Array) -> js_sys::Promise {
        let env = self.env.clone();
        worker::wasm_bindgen_futures::future_to_promise(async move {
            if input.length() as usize > gateway_migration::operational::PRIVATE_WIRE_MAX_BYTES {
                return Err(rejected());
            }
            let deployment =
                crate::candidate_bindings::initial_deployment(&env).map_err(|_| rejected())?;
            let prepared = prepare(
                &env,
                &deployment,
                &input.to_vec(),
                env!("UOS_RUST_BUILD_GIT_TREE"),
                crate::storage::now_ms().map_err(|_| rejected())?,
            )
            .map_err(|_| rejected())?;
            let store =
                crate::authority::RemoteAuthorityStore::from_env(&env).map_err(|_| rejected())?;
            let receipt = gateway_migration::adopt_empty_with_initial_control_owner(
                &store,
                &prepared.adoption,
                &prepared.owner,
                crate::storage::now_ms().map_err(|_| rejected())?,
            )
            .await
            .map_err(|_| rejected())?;
            // Preserve Installed versus read-only Reconciled without claiming
            // that a lost-response readback performed a new atomic commit.
            let encoded = serde_json::to_string(&receipt).map_err(|_| rejected())?;
            js_sys::JSON::parse(&encoded).map_err(|_| rejected())
        })
    }
}

fn rejected() -> JsValue {
    JsValue::from_str("private_initial_control_installation_refused")
}

#[derive(Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
enum InitialInstallation {
    #[serde(rename = "install_initial_control_owner")]
    InstallInitialControlOwner { v: u32, capture: Vec<u8> },
}

/// Neither field is serialized or returned to public clients. The typed M20
/// seam checks genuine adoption facts; physical custody is attested locally.
pub(crate) struct PreparedPrivateInstallation {
    pub(crate) adoption: PreparedAdoption,
    pub(crate) owner: PreparedInitialControlOwner,
}

/// The named platform entrypoint supplies this.env, never a namespace from JSON.
/// Build tree is supplied by immutable trusted build composition, not the envelope.
pub(crate) fn prepare(
    env: &Env,
    deployment: &InitialControlOwnerDeployment,
    exact_input: &[u8],
    actual_build_tree: &str,
    now_ms: i64,
) -> Result<PreparedPrivateInstallation, GatewayError> {
    if exact_input.len() > gateway_migration::operational::PRIVATE_WIRE_MAX_BYTES {
        return Err(refused());
    }
    let namespace = env
        .durable_object(INITIAL_AUTHORITY_BINDING)
        .map_err(|_| refused())?;
    let object_id = namespace
        .id_from_name(INITIAL_AUTHORITY_OBJECT)
        .map_err(|_| refused())?
        .to_string();
    let owner = deployment.prepare(
        exact_input,
        env!("UOS_RUST_BUILD_GIT_SHA"),
        actual_build_tree,
        &object_id,
        now_ms,
    )?;
    let capture = decode_capture(exact_input)?;
    // Migration independently derives capture/source/native/pool/projection
    // facts and compares them through the opaque owner's finite facts method.
    let adoption = gateway_migration::prepare_native(&capture).map_err(|_| refused())?;
    Ok(PreparedPrivateInstallation { adoption, owner })
}

fn decode_capture(exact_input: &[u8]) -> Result<NativeCapture, GatewayError> {
    if exact_input.len() > gateway_migration::operational::PRIVATE_WIRE_MAX_BYTES {
        return Err(refused());
    }
    let InitialInstallation::InstallInitialControlOwner { v, capture } =
        serde_json::from_slice(exact_input).map_err(|_| refused())?;
    if v != 1 || capture.is_empty() {
        return Err(refused());
    }
    serde_json::from_slice(&capture).map_err(|_| refused())
}

fn refused() -> GatewayError {
    GatewayError::unavailable(
        "The private initial control installation was refused",
        "initial_control_owner_refused",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope() -> serde_json::Value {
        let capture = json!({
            "v":2,"source_git_sha":"a".repeat(40),"captured_at_ms":1000,
            "source_codec":"bun-jsc-v1","native_schema_version":3,
            "data_revision":{"version":"7","sequence":"2"},
            "queue_entries":0,"running_queue_entries":0,"entries":[]
        });
        json!({"operation":"install_initial_control_owner","v":1,"capture":serde_json::to_vec(&capture).unwrap()})
    }

    #[test]
    fn closed_private_envelope_accepts_capture_data_without_minting_owner_authority() {
        let capture = decode_capture(&serde_json::to_vec(&envelope()).unwrap()).unwrap();
        assert_eq!(capture.source_git_sha, "a".repeat(40));
        assert_eq!(capture.data_revision.version, "7");
    }

    #[test]
    fn owner_records_capabilities_and_other_operations_are_not_request_fields() {
        for forbidden in [
            "owner",
            "records",
            "capabilities",
            "namespace",
            "physical_custody_verified",
        ] {
            let mut input = envelope();
            input[forbidden] = json!(true);
            assert!(decode_capture(&serde_json::to_vec(&input).unwrap()).is_err());
        }
        let mut input = envelope();
        input["operation"] = json!("describe_target");
        assert!(decode_capture(&serde_json::to_vec(&input).unwrap()).is_err());
        input = envelope();
        input["v"] = json!(2);
        assert!(decode_capture(&serde_json::to_vec(&input).unwrap()).is_err());
    }

    #[test]
    fn malformed_or_oversized_private_capture_refuses_before_effects() {
        assert!(decode_capture(b"{}").is_err());
        let mut input = envelope();
        input["capture"] = json!([123]);
        assert!(decode_capture(&serde_json::to_vec(&input).unwrap()).is_err());
        assert!(
            decode_capture(&vec![
                0;
                gateway_migration::operational::PRIVATE_WIRE_MAX_BYTES
                    + 1
            ])
            .is_err()
        );
    }
}
