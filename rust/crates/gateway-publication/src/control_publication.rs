//! Fixed same-authority control publication by an authenticated configuration
//! owner. Constructor inputs are trusted runtime configuration, never HTTP JSON.
use gateway_auth::{
    crypto::{Secret, sha256_hex},
    native_auth::{AuthenticatedNativeOwner, NativeCapability, NativeTransportIdentity},
    store,
};
use gateway_authority::{
    keys,
    paid_control::{PaidControlConfig, PaidControlOwner, PaidSourceCheck},
};
use gateway_core::{
    GatewayError,
    provider::PaidProvider,
    state::{AuthorityStore, RecordMutation, RevisionCheck, StoredRecord},
};
use serde_json::{Value, json};

/// Dedicated constructor state; neither the keys nor their raw configuration are
/// serialized into derived control records or accepted by a public request.
#[derive(Clone)]
pub struct ConfiguredPaidInputs {
    surplus: Option<Secret>,
    openlux: Option<Secret>,
    immutable_configuration: Value,
}

impl ConfiguredPaidInputs {
    pub fn new(
        surplus: Option<Secret>,
        openlux: Option<Secret>,
        immutable_configuration: Value,
    ) -> Result<Self, GatewayError> {
        if !immutable_configuration.is_object()
            || surplus
                .as_ref()
                .is_some_and(|key| key.expose().trim().is_empty())
            || openlux
                .as_ref()
                .is_some_and(|key| key.expose().trim().is_empty())
        {
            return Err(unavailable(
                "Configured paid inputs are invalid",
                "paid_control_configuration_invalid",
            ));
        }
        Ok(Self {
            surplus,
            openlux,
            immutable_configuration,
        })
    }
    /// This exact reference must also be used by the credential-owning catalog
    /// host. It identifies actual constructor key bytes, not caller metadata.
    pub fn binding(&self, provider: PaidProvider) -> Option<String> {
        let key = match provider {
            PaidProvider::Surplus => self.surplus.as_ref(),
            PaidProvider::Metered => self.openlux.as_ref(),
        };
        key.map(|key| configured_paid_binding(provider, key))
    }
    fn fingerprint(&self, runtime: Option<&StoredRecord>) -> Result<String, GatewayError> {
        let source = runtime.map(StoredRecord::json_value).transpose()?;
        let value = json!({"v":1,"immutable":self.immutable_configuration,"runtime":source,"surplus":self.binding(PaidProvider::Surplus),"openlux":self.binding(PaidProvider::Metered)});
        Ok(sha256_hex(&serde_json::to_vec(&value).map_err(|_| {
            unavailable(
                "Configuration encoding failed",
                "paid_control_configuration_invalid",
            )
        })?))
    }
}

pub fn configured_paid_binding(provider: PaidProvider, key: &Secret) -> String {
    let name = match provider {
        PaidProvider::Surplus => "surplus",
        PaidProvider::Metered => "openlux",
    };
    sha256_hex(format!("uos-paid-provider-binding-v1\0{name}\0{}", key.expose()).as_bytes())
}

pub fn runtime_config_key() -> gateway_core::state::RecordKey {
    store::key(json!(["uos_ai", "runtime_config", "v2"]))
}

fn owner(identity: &NativeTransportIdentity) -> PaidControlOwner {
    PaidControlOwner {
        v: 1,
        owner_id: identity.owner_id().into(),
        owner_epoch: identity.owner_epoch().into(),
        key_fingerprint: identity.key_fingerprint().into(),
    }
}

pub fn verify_owner(
    proof: &AuthenticatedNativeOwner,
    expected: &PaidControlOwner,
    now_ms: i64,
    capability: NativeCapability,
) -> Result<(), GatewayError> {
    proof.require(capability, now_ms)?;
    if expected.v != 1
        || expected.owner_id != proof.owner_id()
        || expected.owner_epoch != proof.owner_epoch()
        || expected.key_fingerprint != proof.transport_key_fingerprint()
    {
        return Err(unavailable(
            "Current configuration owner does not match authenticated custody",
            "paid_control_owner_mismatch",
        ));
    }
    Ok(())
}

/// A missing live owner fails closed. Only an explicitly fixture-named owner may
/// install an absent row here; real installation is a separate deployment step.
pub async fn bootstrap_fixture_owner<S: AuthorityStore>(
    store: &S,
    identity: &NativeTransportIdentity,
    proof: &AuthenticatedNativeOwner,
    now_ms: i64,
    revision: &str,
) -> Result<(), GatewayError> {
    if !identity.owner_id().starts_with("fixture-") || !identity.key_id().starts_with("fixture-") {
        return Err(unavailable(
            "Live owner installation is not enabled",
            "paid_control_owner_installation_required",
        ));
    }
    let value = owner(identity);
    let statement = serde_json::to_vec(&json!({"operation":"fixture_control_owner","owner":value}))
        .map_err(|_| {
            unavailable(
                "Owner encoding failed",
                "paid_control_configuration_invalid",
            )
        })?;
    verify_owner(
        proof,
        &value,
        now_ms,
        NativeCapability::ConfigurationPublish,
    )?;
    proof.require_body(NativeCapability::ConfigurationPublish, &statement, now_ms)?;
    let key = keys::paid_control_owner();
    let row = store.read(&key).await?;
    if let Some(existing) = store::decode::<PaidControlOwner>(row.as_ref(), now_ms)? {
        if existing == value {
            return Ok(());
        }
        return Err(conflict());
    }
    if !store::commit(
        store,
        vec![store::check(&key, row.as_ref())],
        vec![store::put(key, &value, None, revision)?],
    )
    .await?
    {
        return Err(conflict());
    }
    Ok(())
}

pub fn fixture_owner_statement(
    identity: &NativeTransportIdentity,
) -> Result<Vec<u8>, GatewayError> {
    serde_json::to_vec(&json!({"operation":"fixture_control_owner","owner":owner(identity)}))
        .map_err(|_| {
            unavailable(
                "Owner encoding failed",
                "paid_control_configuration_invalid",
            )
        })
}

/// Preparation captures current owner/config/source/observation revisions once.
/// An old publisher cannot reread a new revision and roll configuration backward.
pub struct PreparedConfigurationPublication {
    pub(crate) owner: PaidControlOwner,
    pub(crate) config: PaidControlConfig,
    pub(crate) checks: Vec<RevisionCheck>,
    pub(crate) changed: bool,
    statement: Vec<u8>,
}

impl PreparedConfigurationPublication {
    pub async fn capture<S: AuthorityStore>(
        store: &S,
        identity: &NativeTransportIdentity,
        inputs: &ConfiguredPaidInputs,
        generation: &str,
        now_ms: i64,
    ) -> Result<Self, GatewayError> {
        if generation.trim().is_empty() {
            return Err(unavailable(
                "Configuration generation is missing",
                "paid_control_configuration_invalid",
            ));
        }
        let owner_key = keys::paid_control_owner();
        let owner_row = store.read(&owner_key).await?;
        let expected = owner(identity);
        let current =
            store::decode::<PaidControlOwner>(owner_row.as_ref(), now_ms)?.ok_or_else(|| {
                unavailable(
                    "Configuration owner installation is required",
                    "paid_control_owner_unavailable",
                )
            })?;
        if current != expected {
            return Err(unavailable(
                "Configuration owner changed",
                "paid_control_owner_mismatch",
            ));
        }
        let config_key = keys::paid_control_config();
        let config_row = store.read(&config_key).await?;
        let old = store::decode::<PaidControlConfig>(config_row.as_ref(), now_ms)?;
        let runtime_key = runtime_config_key();
        let runtime_row = store.read(&runtime_key).await?;
        if let Some(row) = &runtime_row {
            row.json_value()?;
        }
        let runtime_check = store::check(&runtime_key, runtime_row.as_ref());
        let config = PaidControlConfig {
            v: 1,
            owner_id: expected.owner_id.clone(),
            owner_epoch: expected.owner_epoch.clone(),
            generation: generation.into(),
            configuration_fingerprint: inputs.fingerprint(runtime_row.as_ref())?,
            surplus_binding: inputs.binding(PaidProvider::Surplus),
            openlux_binding: inputs.binding(PaidProvider::Metered),
            source_checks: vec![PaidSourceCheck::from(&runtime_check)],
        };
        let changed = old.as_ref() != Some(&config);
        // Reusing a generation for different source/key bytes is not an update.
        if old
            .as_ref()
            .is_some_and(|old| old.generation == config.generation && old != &config)
        {
            return Err(conflict());
        }
        let mut checks = vec![
            store::check(&owner_key, owner_row.as_ref()),
            store::check(&config_key, config_row.as_ref()),
            runtime_check,
        ];
        for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
            let key = keys::paid_control_observation(provider);
            let row = store.read(&key).await?;
            checks.push(store::check(&key, row.as_ref()));
        }
        let statement=serde_json::to_vec(&json!({"operation":"configuration_publish","config":config,"owner_revision":owner_row.as_ref().map(|r|&r.revision),"previous_config_revision":config_row.as_ref().map(|r|&r.revision)})).map_err(|_|unavailable("Configuration encoding failed","paid_control_configuration_invalid"))?;
        Ok(Self {
            owner: expected,
            config,
            checks,
            changed,
            statement,
        })
    }
    pub fn statement(&self) -> &[u8] {
        &self.statement
    }
    pub fn configuration(&self) -> &PaidControlConfig {
        &self.config
    }
    pub async fn publish<S: AuthorityStore>(
        self,
        store: &S,
        proof: &AuthenticatedNativeOwner,
        now_ms: i64,
        revision: &str,
    ) -> Result<PaidControlConfig, GatewayError> {
        let body = self.statement.clone();
        self.publish_received(store, proof, now_ms, revision, &body)
            .await
    }
    pub(crate) async fn publish_received<S: AuthorityStore>(
        self,
        store: &S,
        proof: &AuthenticatedNativeOwner,
        now_ms: i64,
        revision: &str,
        authenticated_body: &[u8],
    ) -> Result<PaidControlConfig, GatewayError> {
        verify_owner(
            proof,
            &self.owner,
            now_ms,
            NativeCapability::ConfigurationPublish,
        )?;
        proof.require_body(
            NativeCapability::ConfigurationPublish,
            authenticated_body,
            now_ms,
        )?;
        let mut mutations = Vec::new();
        if self.changed {
            mutations.push(store::put(
                keys::paid_control_config(),
                &self.config,
                None,
                revision,
            )?);
            // Obsolete catalogs must become checked absence, preserving source
            // configured+known-Codex fallback instead of becoming stale truth.
            for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
                mutations.push(RecordMutation::Delete {
                    key: keys::paid_control_observation(provider),
                });
            }
        }
        if !store::commit(store, self.checks, mutations).await? {
            return Err(conflict());
        }
        Ok(self.config)
    }
}

pub(crate) fn conflict() -> GatewayError {
    GatewayError::new(
        409,
        "Configuration or credential publication changed concurrently",
        Some("native_publication_conflict"),
    )
}
pub(crate) fn unavailable(message: &str, code: &str) -> GatewayError {
    GatewayError::unavailable(message, code)
}
