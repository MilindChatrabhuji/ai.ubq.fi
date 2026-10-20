//! One authenticated/current opaque plan and one fixed import publication CAS.
//! Config DATA is supplied only by the trusted publication receiver, never wire.
use super::super::rows::{GenerationEffect, OperationRow, Phase, TerminalPublication};
use super::*;
use crate::{
    keys,
    paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig, PaidControlOwner},
    store::Transaction,
};
use gateway_auth::{
    crypto::Secret,
    crypto::sha256_hex,
    native::NATIVE_PUBLICATION_PATH,
    native_auth::{AuthenticatedNativeOwner, NativeCapability},
    provider_credentials::codex_credential_identity,
};
use gateway_core::{
    provider::PaidProvider,
    source_control::encode_source_control_record,
    source_json::SourceJson,
    state::{AtomicTransition, CommitOutcome, RecordMutation, StoredRecord},
};
use gateway_schema::catalog_store;

pub use gateway_auth::native_import::publication::{
    NativeImportPublication, NativeImportPublicationDisposition,
};
pub struct PreparedNativeImportPublication<'c, 'a, S, I, C> {
    control: &'c NativeRenewalAuthority<'a, S, I, C>,
    peer: &'c AuthenticatedNativeOwner,
    body: Vec<u8>,
    wire: ImportPublicationCommandData,
    row: ImportActionRow,
    tx: Transaction<'a, S, I>,
    owner: PaidControlOwner,
    previous_configuration: PaidControlConfig,
    current_runtime: Option<StoredRecord>,
    planned_runtime: Option<StoredRecord>,
    generation: String,
    publication: ImportPublicationDataV1,
    mutations: Vec<RecordMutation>,
    replay: bool,
}
pub(super) fn conflict() -> GatewayError {
    GatewayError::new(
        409,
        "Native import publication conflicts with current original authority.",
        Some("native_import_publication_conflict"),
    )
}
pub(super) fn effect_digest(row: &ImportActionRow) -> Result<String, GatewayError> {
    super::super::facts::digest(&(
        "uos-native-import-effect-v2",
        &row.metadata,
        &row.target,
        &row.facts,
        &row.context,
        row.created_at_ms,
        row.deadline_ms,
    ))
}
pub(super) fn matches_wire(row: &ImportActionRow, wire: &ImportPublicationCommandData) -> bool {
    row.v == 3
        && row.kind == NativeImportKind::CodexAuth
        && row.metadata.operation_id == wire.operation_id
        && row.metadata.action_ref == wire.action_ref
        && row.facts.native_owner_id == wire.native_owner_id
        && row.facts.owner_revision == wire.owner_revision
        && row.facts.source_revision == wire.source_revision
        && row.facts.normalized_revision == wire.normalized_revision
        && row.facts.account_id_hash == wire.account_id_hash
        && row.facts.source_native_generation == wire.previous_native_source_generation
}
fn terminal(publication: &ImportPublicationDataV1) -> TerminalPublication {
    TerminalPublication {
        publication_revision: publication.publication_revision.clone(),
        source_revision: publication.source_revision.clone(),
        normalized_revision: publication.normalized_revision.clone(),
        native_source_generation: publication.native_source_generation.clone(),
        access_generation: publication.access_generation.clone(),
        credential_version: publication.credential_version.clone(),
        publication_request_digest: Some(publication.publication_request_digest.clone()),
    }
}
impl<'a, S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'a, S, I, C>
{
    pub async fn prepare_import_publication<'c>(
        &'c self,
        peer: &'c AuthenticatedNativeOwner,
        body: &[u8],
    ) -> Result<PreparedNativeImportPublication<'c, 'a, S, I, C>, GatewayError> {
        let now = self.time(0)?;
        self.require_import_publication_peer(peer, body, now)?;
        let wire = ImportPublicationCommandData::parse(body)?;
        let mut tx = self.authority.transaction(now)?;
        let action_key = rows::key("action", &wire.action_ref);
        let mut row: ImportActionRow = tx
            .read_source_control(&action_key)
            .await?
            .ok_or_else(unavailable)?;
        if !matches_wire(&row, &wire)
            || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
            || now < row.created_at_ms
            || now >= row.deadline_ms
        {
            return Err(unavailable());
        }
        let replay = row.publication.is_some();
        if !replay {
            self.current_import_row(&mut tx, &row).await?;
        }
        let owner: PaidControlOwner = tx
            .read(&keys::paid_control_owner())
            .await?
            .ok_or_else(unavailable)?;
        if owner.v != 1
            || owner.owner_id != self.identity.owner_id()
            || owner.owner_epoch != self.identity.owner_epoch()
            || owner.key_fingerprint != self.identity.key_fingerprint()
            || tx.revision(&keys::paid_control_owner()).as_deref()
                != Some(row.facts.owner_revision.as_str())
        {
            return Err(unavailable());
        }
        let config: PaidControlConfig = tx
            .read(&keys::paid_control_config())
            .await?
            .ok_or_else(unavailable)?;
        let runtime_key = catalog_store::runtime_config_key();
        tx.observe_revision(&runtime_key).await?;
        let runtime = self.authority.store.read(&runtime_key).await?;
        if runtime.as_ref().map(|value| value.revision.clone()) != tx.revision(&runtime_key) {
            return Err(conflict());
        }
        let mut op: OperationRow = tx
            .read(&rows::key("operation", &wire.operation_id))
            .await?
            .ok_or_else(unavailable)?;
        let generation_key = effects::generation_key(&row)?;
        let mut generation: GenerationEffect =
            tx.read(&generation_key).await?.ok_or_else(unavailable)?;
        if op.v != 1
            || op.operation_id != wire.operation_id
            || op.action_ref != wire.action_ref
            || op.claim_ref != wire.claim_ref
            || op.request_digest != effect_digest(&row)?
            || generation.v != 1
            || generation.operation_id != op.operation_id
            || generation.claim_ref != op.claim_ref
        {
            return Err(conflict());
        }
        let digest = sha256_hex(body);
        if let Some(publication) = &row.publication {
            if publication.operation_id != wire.operation_id
                || publication.claim_ref != wire.claim_ref
                || publication.native_receipt_ref != wire.native_receipt_ref
                || publication.publication_revision != wire.publication_revision
                || publication.publication_request_digest != digest
                || publication.catalog_disposition != wire.catalog.disposition()
            {
                return Err(conflict());
            }
            return Ok(PreparedNativeImportPublication {
                control: self,
                peer,
                body: body.into(),
                wire,
                row: row.clone(),
                tx,
                owner,
                previous_configuration: config.clone(),
                current_runtime: runtime.clone(),
                planned_runtime: runtime,
                generation: config.generation,
                publication: publication.clone(),
                mutations: vec![],
                replay: true,
            });
        }
        if !matches!(op.phase, Phase::Started | Phase::Unknown)
            || op.terminal.is_some()
            || op.publication_revision.is_some()
            || op.native_source_generation.is_some()
            || op.access_generation.is_some()
            || generation.terminal.is_some()
            || generation.publication_revision.is_some()
        {
            return Err(conflict());
        }
        let source = super::publication_source::prepare(self, &mut tx, &row, &wire).await?;
        let config_changed = source.runtime.is_some();
        let generation_value = if config_changed {
            let value = self.authority.tokens.next_token()?;
            crate::text(&value)?;
            if value == config.generation {
                return Err(conflict());
            }
            value
        } else {
            config.generation.clone()
        };
        let credential = codex_credential_identity(
            &wire.document.account_id,
            &Secret::new(wire.document.access_token.clone()),
            &Secret::new(String::new()),
        );
        let publication = ImportPublicationDataV1 {
            v: 1,
            operation_id: wire.operation_id.clone(),
            claim_ref: wire.claim_ref.clone(),
            publication_revision: wire.publication_revision.clone(),
            native_receipt_ref: wire.native_receipt_ref.clone(),
            native_source_generation: wire.native_source_generation.clone(),
            access_generation: wire.access_generation.clone(),
            credential_version: credential.credential_version.0,
            source_revision: wire.publication_revision.clone(),
            normalized_revision: wire.publication_revision.clone(),
            catalog_revision: source.catalog_revision,
            runtime_revision: source.runtime_revision,
            auth_generation_revision: source.auth_generation_revision,
            paid_control_config_revision: if config_changed {
                Some(wire.publication_revision.clone())
            } else {
                tx.revision(&keys::paid_control_config())
            },
            publication_request_digest: digest,
            catalog_disposition: wire.catalog.disposition(),
        };
        publication.validate()?;
        let common = terminal(&publication);
        op.phase = Phase::Published;
        op.publication_revision = Some(wire.publication_revision.clone());
        op.native_source_generation = Some(wire.native_source_generation.clone());
        op.access_generation = Some(wire.access_generation.clone());
        op.terminal = Some(common.clone());
        generation.publication_revision = Some(wire.publication_revision.clone());
        generation.terminal = Some(common);
        row.publication = Some(publication.clone());
        let mut mutations = source.mutations;
        mutations.push(RecordMutation::Put {
            key: action_key,
            record: encode_source_control_record(
                &wire.publication_revision,
                &SourceJson::from_serializable(&row)?,
                None,
            )?,
        });
        for (key, value) in [
            (
                rows::key("operation", &wire.operation_id),
                serde_json::to_value(op).map_err(|_| unavailable())?,
            ),
            (
                generation_key,
                serde_json::to_value(generation).map_err(|_| unavailable())?,
            ),
        ] {
            mutations.push(RecordMutation::Put {
                key,
                record: StoredRecord::json(&wire.publication_revision, value, None),
            });
        }
        if config_changed {
            for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
                let key = keys::paid_control_observation(provider);
                tx.observe_revision(&key).await?;
                mutations.push(RecordMutation::Delete { key });
            }
        }
        Ok(PreparedNativeImportPublication {
            control: self,
            peer,
            body: body.into(),
            wire,
            row,
            tx,
            owner,
            previous_configuration: config,
            current_runtime: runtime,
            planned_runtime: source.runtime,
            generation: generation_value,
            publication,
            mutations,
            replay: false,
        })
    }
    /// Same-store fixed publication authentication. No alternate nonce store,
    /// route, capability or raw credential/body relay is exposed.
    pub async fn authenticate_import_publication(
        &self,
        headers: gateway_auth::native_auth::NativeAuthHeaders<'_>,
        body: &[u8],
    ) -> Result<AuthenticatedNativeOwner, GatewayError> {
        if body.len() > import_publication_max_bytes() {
            return Err(unavailable());
        }
        let replay = gateway_auth::native_replay::StoreNonceAuthority::new(&self.authority.store);
        let authenticator =
            gateway_auth::native_auth::NativeAuthenticator::new(self.identity, &replay);
        let peer = authenticator
            .authenticate(NATIVE_PUBLICATION_PATH, headers, body, self.time(0)?)
            .await?;
        self.require_import_publication_peer(&peer, body, self.time(0)?)?;
        Ok(peer)
    }
    pub(super) fn require_import_publication_peer(
        &self,
        peer: &AuthenticatedNativeOwner,
        body: &[u8],
        now: i64,
    ) -> Result<(), GatewayError> {
        peer.require_request(
            NativeCapability::CodexAuthImport,
            NATIVE_PUBLICATION_PATH,
            body,
            now,
        )?;
        if peer.owner_id() != self.identity.owner_id()
            || peer.owner_epoch() != self.identity.owner_epoch()
            || peer.transport_key_fingerprint() != self.identity.key_fingerprint()
        {
            return Err(unavailable());
        }
        Ok(())
    }
}
impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    PreparedNativeImportPublication<'_, '_, S, I, C>
{
    pub fn current_owner(&self) -> &PaidControlOwner {
        &self.owner
    }
    pub fn previous_configuration(&self) -> &PaidControlConfig {
        &self.previous_configuration
    }
    pub fn current_runtime(&self) -> Option<&StoredRecord> {
        self.current_runtime.as_ref()
    }
    pub fn planned_runtime(&self) -> Option<&StoredRecord> {
        self.planned_runtime.as_ref()
    }
    pub fn configuration_generation(&self) -> &str {
        &self.generation
    }
    pub fn needs_configuration(&self) -> bool {
        matches!(
            self.publication.catalog_disposition,
            ImportCatalogDisposition::Normalized { .. }
        )
    }
    pub async fn commit(
        mut self,
        config: Option<PaidControlConfig>,
    ) -> Result<NativeImportPublication, GatewayError> {
        self.tx.now = self.control.time(self.row.created_at_ms)?;
        self.control
            .require_import_publication_peer(self.peer, &self.body, self.tx.now)?;
        if self.tx.now >= self.row.deadline_ms {
            return Err(unavailable());
        }
        if self.needs_configuration() {
            let config = config.ok_or_else(unavailable)?;
            if config.v != PAID_CONTROL_CONFIG_VERSION
                || config.owner_id != self.owner.owner_id
                || config.owner_epoch != self.owner.owner_epoch
                || config.generation != self.generation
                || config.surplus_binding != self.previous_configuration.surplus_binding
                || config.openlux_discovery_binding
                    != self.previous_configuration.openlux_discovery_binding
                || config.openlux_binding != self.previous_configuration.openlux_binding
                || config.source_checks.len() != 1
                || config.source_checks[0].key != catalog_store::runtime_config_key().0
                || config.source_checks[0].expected_revision != self.publication.runtime_revision
            {
                return Err(conflict());
            }
            super::super::custody::hash(&config.configuration_fingerprint)?;
            if self.replay {
                if config != self.previous_configuration {
                    return Err(conflict());
                }
            } else {
                if config.generation == self.previous_configuration.generation {
                    return Err(conflict());
                }
                self.mutations.push(RecordMutation::Put {
                    key: keys::paid_control_config(),
                    record: StoredRecord::json(
                        &self.wire.publication_revision,
                        serde_json::to_value(config).map_err(|_| unavailable())?,
                        None,
                    ),
                });
            }
        } else if config.is_some() {
            return Err(conflict());
        }
        if self.replay {
            super::publication_current::verify(
                self.control,
                &mut self.tx,
                &self.row,
                &self.publication,
            )
            .await?;
        } else {
            // All original source reads remain immutable in this transaction;
            // the final CAS checks them together with newly observed catalog/paid rows.
            // Rebuilding ImportFacts after adding those unrelated group checks
            // would change its preparation digest rather than recheck currentness.
            let current =
                actor::read_current(&mut self.tx, &self.row.actor, self.control.current_config)
                    .await?;
            if current.scope != NativeActorScope::Admin {
                return Err(unavailable());
            }
            if self.tx.checks().iter().any(|check| {
                check.expected_revision.as_deref() == Some(self.wire.publication_revision.as_str())
            }) {
                return Err(conflict());
            }
        }
        self.tx.now = self.control.time(self.tx.now)?;
        self.control
            .require_import_publication_peer(self.peer, &self.body, self.tx.now)?;
        actor::validate_current_time(&self.row.actor, self.tx.now)?;
        if self.tx.now >= self.row.deadline_ms {
            return Err(unavailable());
        }
        let checks = self.tx.checks();
        if self
            .control
            .authority
            .store
            .commit(AtomicTransition {
                checks,
                mutations: self.mutations,
            })
            .await?
            != CommitOutcome::Committed
        {
            return Err(conflict());
        }
        let now = self.control.time(self.tx.now)?;
        actor::validate_current_time(&self.row.actor, now)?;
        self.control
            .require_import_publication_peer(self.peer, &self.body, now)?;
        if now >= self.row.deadline_ms {
            return Err(unavailable());
        }
        Ok(NativeImportPublication {
            v: 1,
            operation_id: self.wire.operation_id,
            action_ref: self.wire.action_ref,
            disposition: if self.replay {
                NativeImportPublicationDisposition::AlreadyCurrent
            } else {
                NativeImportPublicationDisposition::Applied
            },
            publication: self.publication,
        })
    }
}
