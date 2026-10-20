//! Fixed same-authority control publication by an authenticated configuration
//! owner. Constructor inputs are trusted runtime configuration, never HTTP JSON.
use gateway_auth::{
    crypto::{Secret, sha256_hex},
    native_auth::{AuthenticatedNativeOwner, NativeCapability, NativeTransportIdentity},
    store,
};
use gateway_authority::{
    keys,
    paid_control::{
        PAID_CONTROL_CONFIG_VERSION, PaidControlConfig, PaidControlOwner, PaidSourceCheck,
    },
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
    openlux_discovery: Option<Secret>,
    openlux_spend: Option<Secret>,
    immutable_configuration: Value,
}

impl ConfiguredPaidInputs {
    pub fn new(
        surplus: Option<Secret>,
        openlux_discovery: Option<Secret>,
        openlux_spend: Option<Secret>,
        immutable_configuration: Value,
    ) -> Result<Self, GatewayError> {
        if !immutable_configuration.is_object()
            || surplus
                .as_ref()
                .is_some_and(|key| key.expose().trim().is_empty())
            || openlux_discovery
                .as_ref()
                .is_some_and(|key| key.expose().trim().is_empty())
            || openlux_spend
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
            openlux_discovery,
            openlux_spend,
            immutable_configuration,
        })
    }
    /// Inference and billing use the actual constructor-supplied spend key.
    /// Its fingerprint domain remains stable across the private schema change.
    pub fn binding(&self, provider: PaidProvider) -> Option<String> {
        let key = match provider {
            PaidProvider::Surplus => self.surplus.as_ref(),
            PaidProvider::Metered => self.openlux_spend.as_ref(),
        };
        key.map(|key| configured_paid_binding(provider, key))
    }
    /// Catalog discovery has its own explicit key, even when both roles use the
    /// same bytes. Missing role inputs are never filled from another role.
    pub fn discovery_binding(&self, provider: PaidProvider) -> Option<String> {
        match provider {
            PaidProvider::Surplus => self.binding(provider),
            PaidProvider::Metered => self
                .openlux_discovery
                .as_ref()
                .map(|key| configured_paid_binding(provider, key)),
        }
    }
    fn fingerprint(&self, runtime: Option<&StoredRecord>) -> Result<String, GatewayError> {
        // Preserve the exact existing JSON envelope, field ordering and SHA.
        // Only the runtime leaf uses the existing lossless control-record codec.
        #[derive(serde::Serialize)]
        struct Fingerprint<'a> {
            v: u32,
            immutable: &'a Value,
            runtime: Option<gateway_core::source_json::SourceJson>,
            surplus_binding: Option<String>,
            openlux_discovery_binding: Option<String>,
            openlux_binding: Option<String>,
        }
        let source = runtime
            .map(gateway_core::source_control::decode_source_control_record)
            .transpose()?;
        let value = Fingerprint {
            v: PAID_CONTROL_CONFIG_VERSION,
            immutable: &self.immutable_configuration,
            runtime: source,
            surplus_binding: self.binding(PaidProvider::Surplus),
            openlux_discovery_binding: self.discovery_binding(PaidProvider::Metered),
            openlux_binding: self.binding(PaidProvider::Metered),
        };
        let encoded = gateway_core::source_json::SourceJson::from_serializable(&value)?;
        Ok(sha256_hex(encoded.as_str().as_bytes()))
    }

    /// Derive only configuration DATA from trusted current/planned records. The
    /// caller still owns current-row reads and their atomic revision fences.
    /// No store, mutation, nonce or publication capability is accepted here.
    pub(crate) fn candidate_configuration(
        &self,
        identity: &NativeTransportIdentity,
        current_owner: &PaidControlOwner,
        generation: &str,
        runtime: Option<&StoredRecord>,
        previous: Option<&PaidControlConfig>,
    ) -> Result<PaidControlConfig, GatewayError> {
        if generation.trim().is_empty() {
            return Err(unavailable(
                "Configuration generation is missing",
                "paid_control_configuration_invalid",
            ));
        }
        let expected = owner(identity);
        if current_owner != &expected {
            return Err(unavailable(
                "Configuration owner changed",
                "paid_control_owner_mismatch",
            ));
        }
        if previous.is_some_and(|config| config.v != PAID_CONTROL_CONFIG_VERSION) {
            return Err(unavailable(
                "Stored configuration has an unsupported private schema",
                "paid_control_configuration_invalid",
            ));
        }
        let runtime_check = store::check(&runtime_config_key(), runtime);
        let config = PaidControlConfig {
            v: PAID_CONTROL_CONFIG_VERSION,
            owner_id: expected.owner_id,
            owner_epoch: expected.owner_epoch,
            generation: generation.into(),
            configuration_fingerprint: self.fingerprint(runtime)?,
            surplus_binding: self.binding(PaidProvider::Surplus),
            openlux_discovery_binding: self.discovery_binding(PaidProvider::Metered),
            openlux_binding: self.binding(PaidProvider::Metered),
            source_checks: vec![PaidSourceCheck::from(&runtime_check)],
        };
        // Reusing a generation for different source/key bytes is not an update.
        if previous.is_some_and(|old| old.generation == config.generation && old != &config) {
            return Err(conflict());
        }
        Ok(config)
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
        if old
            .as_ref()
            .is_some_and(|config| config.v != PAID_CONTROL_CONFIG_VERSION)
        {
            return Err(unavailable(
                "Stored configuration has an unsupported private schema",
                "paid_control_configuration_invalid",
            ));
        }
        let runtime_key = runtime_config_key();
        let runtime_row = store.read(&runtime_key).await?;
        if let Some(row) = &runtime_row {
            gateway_core::source_control::decode_source_control_record(row)?;
        }
        let runtime_check = store::check(&runtime_key, runtime_row.as_ref());
        let config = inputs.candidate_configuration(
            identity,
            &current,
            generation,
            runtime_row.as_ref(),
            old.as_ref(),
        )?;
        let changed = old.as_ref() != Some(&config);
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
        if !crate::wire::valid_revision(revision)
            || self.changed && self.checks[1].expected_revision.as_deref() == Some(revision)
        {
            return Err(crate::wire::invalid());
        }
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

#[cfg(test)]
mod candidate_tests {
    use super::*;
    use std::collections::BTreeSet;

    fn identity() -> NativeTransportIdentity {
        NativeTransportIdentity::new(
            "fixture-key".into(),
            "fixture-owner".into(),
            "fixture-epoch".into(),
            [11; 32],
            BTreeSet::from([NativeCapability::ConfigurationPublish]),
        )
        .unwrap()
    }

    fn inputs() -> ConfiguredPaidInputs {
        ConfiguredPaidInputs::new(
            Some(Secret::new("fixture-surplus-key".into())),
            Some(Secret::new("fixture-discovery-key".into())),
            Some(Secret::new("fixture-spend-key".into())),
            json!({"overage_enabled":true}),
        )
        .unwrap()
    }

    #[test]
    fn profile_v2_runtime_uses_existing_lossless_fingerprint_envelope() {
        use gateway_core::{
            source_control::{decode_source_control_record, encode_source_control_record},
            source_json::SourceJson,
            source_serialization as source,
        };
        let identity = identity();
        let owner = owner(&identity);
        let inputs = inputs();
        let raw = SourceJson::parse(r#"{"model":"\ud800","reasoning":"none"}"#).unwrap();
        let runtime = encode_source_control_record("planned-runtime", &raw, None).unwrap();
        assert_eq!(
            runtime.value_encoding,
            gateway_core::value::ValueEncoding::ProfileV2
        );
        let expected = source::object_keys(vec![
            (
                "v".into(),
                SourceJson::from_serializable(&PAID_CONTROL_CONFIG_VERSION).unwrap(),
            ),
            (
                "immutable".into(),
                SourceJson::from_serializable(&inputs.immutable_configuration).unwrap(),
            ),
            (
                "runtime".into(),
                decode_source_control_record(&runtime).unwrap(),
            ),
            (
                "surplus_binding".into(),
                SourceJson::from_serializable(&inputs.binding(PaidProvider::Surplus)).unwrap(),
            ),
            (
                "openlux_discovery_binding".into(),
                SourceJson::from_serializable(&inputs.discovery_binding(PaidProvider::Metered))
                    .unwrap(),
            ),
            (
                "openlux_binding".into(),
                SourceJson::from_serializable(&inputs.binding(PaidProvider::Metered)).unwrap(),
            ),
        ])
        .unwrap();
        let actual = inputs
            .candidate_configuration(&identity, &owner, "g1", Some(&runtime), None)
            .unwrap();
        assert_eq!(
            actual.configuration_fingerprint,
            sha256_hex(expected.as_str().as_bytes())
        );
        assert!(expected.as_str().contains("\\ud800"));
        let literal = StoredRecord::json(
            "planned-runtime",
            json!({"model":"\\ud800","reasoning":"none"}),
            None,
        );
        assert_ne!(
            actual.configuration_fingerprint,
            inputs.fingerprint(Some(&literal)).unwrap()
        );
    }

    #[test]
    fn runtime_revision_changes_only_source_check_and_requires_fresh_generation() {
        let identity = identity();
        let owner = owner(&identity);
        let inputs = inputs();
        let first = StoredRecord::json("runtime-r1", json!({"model":"fixture-model"}), None);
        let next = StoredRecord::json("runtime-r2", first.value.clone(), None);
        let old = inputs
            .candidate_configuration(&identity, &owner, "g1", Some(&first), None)
            .unwrap();
        let config = inputs
            .candidate_configuration(&identity, &owner, "g2", Some(&next), Some(&old))
            .unwrap();
        assert_eq!(
            config.configuration_fingerprint,
            old.configuration_fingerprint
        );
        assert_eq!(
            config.source_checks,
            vec![PaidSourceCheck {
                key: runtime_config_key().0,
                expected_revision: Some("runtime-r2".into())
            }]
        );
        assert_ne!(config.source_checks, old.source_checks);
        assert_eq!(
            inputs
                .candidate_configuration(&identity, &owner, "g1", Some(&next), Some(&old))
                .unwrap_err(),
            conflict()
        );
        assert_eq!(
            inputs
                .candidate_configuration(&identity, &owner, "g1", Some(&first), Some(&old))
                .unwrap(),
            old
        );
    }

    #[test]
    fn runtime_value_change_reuses_existing_fingerprint_constructor() {
        let identity = identity();
        let owner = owner(&identity);
        let inputs = inputs();
        let first = StoredRecord::json("runtime-r1", json!({"model":"first-model"}), None);
        let next = StoredRecord::json("runtime-r2", json!({"model":"next-model"}), None);
        let old = inputs
            .candidate_configuration(&identity, &owner, "g1", Some(&first), None)
            .unwrap();
        let config = inputs
            .candidate_configuration(&identity, &owner, "g2", Some(&next), Some(&old))
            .unwrap();
        assert_ne!(
            config.configuration_fingerprint,
            old.configuration_fingerprint
        );
        assert_eq!(
            config.configuration_fingerprint,
            inputs.fingerprint(Some(&next)).unwrap()
        );
        assert_eq!(config.owner_id, old.owner_id);
        assert_eq!(config.owner_epoch, old.owner_epoch);
        assert_eq!(config.surplus_binding, old.surplus_binding);
        assert_eq!(
            config.openlux_discovery_binding,
            old.openlux_discovery_binding
        );
        assert_eq!(config.openlux_binding, old.openlux_binding);
        assert_eq!(
            inputs
                .candidate_configuration(&identity, &owner, "g1", Some(&next), Some(&old))
                .unwrap_err(),
            conflict()
        );
    }

    #[test]
    fn configured_owner_generation_and_previous_schema_remain_required() {
        let identity = identity();
        let owner = owner(&identity);
        let inputs = inputs();
        for field in 0..4 {
            let mut wrong = owner.clone();
            match field {
                0 => wrong.v = 2,
                1 => wrong.owner_id.push_str("-other"),
                2 => wrong.owner_epoch.push_str("-other"),
                _ => wrong.key_fingerprint.push_str("-other"),
            }
            assert_eq!(
                inputs
                    .candidate_configuration(&identity, &wrong, "g1", None, None)
                    .unwrap_err()
                    .envelope
                    .error
                    .code
                    .as_deref(),
                Some("paid_control_owner_mismatch")
            );
        }
        assert_eq!(
            inputs
                .candidate_configuration(&identity, &owner, " ", None, None)
                .unwrap_err()
                .envelope
                .error
                .code
                .as_deref(),
            Some("paid_control_configuration_invalid")
        );
        let mut previous = inputs
            .candidate_configuration(&identity, &owner, "g1", None, None)
            .unwrap();
        previous.v = 1;
        assert_eq!(
            inputs
                .candidate_configuration(&identity, &owner, "g2", None, Some(&previous))
                .unwrap_err()
                .envelope
                .error
                .code
                .as_deref(),
            Some("paid_control_configuration_invalid")
        );
    }

    #[test]
    fn missing_runtime_and_independent_nullable_bindings_stay_explicit() {
        let identity = identity();
        let owner = owner(&identity);
        for (discovery, spend) in [
            (None, None),
            (Some("fixture-discovery"), None),
            (None, Some("fixture-spend")),
        ] {
            let inputs = ConfiguredPaidInputs::new(
                None,
                discovery.map(|s| Secret::new(s.into())),
                spend.map(|s| Secret::new(s.into())),
                json!({}),
            )
            .unwrap();
            let config = inputs
                .candidate_configuration(&identity, &owner, "g1", None, None)
                .unwrap();
            assert_eq!(config.v, PAID_CONTROL_CONFIG_VERSION);
            assert_eq!(
                config.source_checks,
                vec![PaidSourceCheck {
                    key: runtime_config_key().0,
                    expected_revision: None
                }]
            );
            let encoded = serde_json::to_value(&config).unwrap();
            for field in [
                "surplus_binding",
                "openlux_discovery_binding",
                "openlux_binding",
            ] {
                assert!(encoded.get(field).is_some());
                let mut omitted = encoded.clone();
                omitted.as_object_mut().unwrap().remove(field);
                assert!(serde_json::from_value::<PaidControlConfig>(omitted).is_err());
            }
            assert!(encoded["surplus_binding"].is_null());
            assert_eq!(
                config.openlux_discovery_binding.is_some(),
                discovery.is_some()
            );
            assert_eq!(config.openlux_binding.is_some(), spend.is_some());
        }
    }

    #[test]
    fn pure_derivation_has_no_store_capability_and_preserves_all_inputs() {
        let identity = identity();
        let owner = owner(&identity);
        let inputs = inputs();
        let runtime = StoredRecord::json("planned-runtime", json!({"model":"fixture-model"}), None);
        let previous = inputs
            .candidate_configuration(&identity, &owner, "g1", None, None)
            .unwrap();
        let before = serde_json::to_vec(&(&owner, &runtime, &previous)).unwrap();
        let fingerprint = inputs.fingerprint(Some(&runtime)).unwrap();
        let config = inputs
            .candidate_configuration(&identity, &owner, "g2", Some(&runtime), Some(&previous))
            .unwrap();
        assert_eq!(config.configuration_fingerprint, fingerprint);
        assert_eq!(
            before,
            serde_json::to_vec(&(&owner, &runtime, &previous)).unwrap()
        );
        assert_eq!(inputs.fingerprint(Some(&runtime)).unwrap(), fingerprint);
        let mut invalid = runtime;
        invalid.schema_version += 1;
        assert!(
            inputs
                .candidate_configuration(&identity, &owner, "g3", Some(&invalid), Some(&config))
                .is_err()
        );
    }
}
