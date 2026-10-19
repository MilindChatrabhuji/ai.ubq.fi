//! Fixed paid control publications, derived in the same store as admission/accounting.
//! These records are provenance and a coarse index; only authority issues a request receipt.
use crate::{CatalogRuntime, host::*, state};
use gateway_authority::{keys, paid::PaidRoutingPolicy, paid_control::*};
use gateway_core::{
    GatewayError,
    identity::MAX_SAFE_INTEGER,
    model::ModelId,
    provider::PaidProvider,
    query::QueryStore,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::{
        AtomicTransition, CommitOutcome, RecordKey, RecordMutation, RevisionCheck, StoredRecord,
    },
    tuple_key::TupleKey,
};
use gateway_providers::policy::{DeepseekHop, PaidRoutingInput, paid_order, resolve_paid_route};
use gateway_schema::{
    catalog::{CatalogInput, ProviderCatalog},
    catalog_store,
    reasoning::js_trim_source,
    runtime_config::normalize_runtime_config,
    selection::ProviderSelection,
    snapshot::ModelSnapshot,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub struct PaidObservationPublication {
    provider: PaidProvider,
    revision: Option<String>,
    published_at_ms: i64,
}
impl PaidObservationPublication {
    pub fn provider(&self) -> PaidProvider {
        self.provider
    }
    pub fn revision(&self) -> Option<&str> {
        self.revision.as_deref()
    }
    pub fn published_at_ms(&self) -> i64 {
        self.published_at_ms
    }
}
#[derive(Clone, Debug)]
pub struct PaidRoutingPublication {
    revision: String,
    published_at_ms: i64,
    source_checks: Vec<RevisionCheck>,
}
impl PaidRoutingPublication {
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn published_at_ms(&self) -> i64 {
        self.published_at_ms
    }
    pub fn source_checks(&self) -> &[RevisionCheck] {
        &self.source_checks
    }
}
fn missing(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "paid_control_unavailable")
}
fn stale() -> GatewayError {
    GatewayError::unavailable(
        "Paid routing source custody changed; no stale publication was accepted",
        "paid_control_changed",
    )
}
fn text(value: &str) -> Result<(), GatewayError> {
    if value.trim().is_empty() || value.len() > 4096 {
        Err(missing("Paid control identity is missing"))
    } else {
        Ok(())
    }
}
fn time(value: i64) -> Result<(), GatewayError> {
    if (0..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(missing("Paid control clock is invalid"))
    }
}
fn catalog_provider(provider: PaidProvider) -> CatalogProvider {
    match provider {
        PaidProvider::Surplus => CatalogProvider::Surplus,
        PaidProvider::Metered => CatalogProvider::Openlux,
    }
}
fn configured(config: &PaidControlConfig, provider: PaidProvider) -> Option<&str> {
    match provider {
        PaidProvider::Surplus => config.surplus_binding.as_deref(),
        PaidProvider::Metered => config.openlux_binding.as_deref(),
    }
}
fn discovery_binding(config: &PaidControlConfig, provider: PaidProvider) -> Option<&str> {
    match provider {
        PaidProvider::Surplus => config.surplus_binding.as_deref(),
        PaidProvider::Metered => config.openlux_discovery_binding.as_deref(),
    }
}
fn decode<T: DeserializeOwned>(record: &StoredRecord) -> Result<T, GatewayError> {
    decode_source_control_record(record)?
        .deserialize()
        .map_err(|_| missing("Paid control record is malformed"))
}
async fn read_record<S: QueryStore>(
    store: &S,
    key: &RecordKey,
) -> Result<Option<StoredRecord>, GatewayError> {
    // Only these named model-bearing families opt into the source codec.
    let source_row = key == &keys::paid_routing()
        || key == &catalog_store::codex_snapshot_key()
        || key == &catalog_store::runtime_config_key()
        || [PaidProvider::Surplus, PaidProvider::Metered]
            .iter()
            .any(|p| key == &keys::paid_control_observation(*p));
    let record = if source_row {
        store.read(key).await?
    } else {
        state::read_json(store, key).await?
    };
    if let Some(row) = record.as_ref().filter(|_| source_row) {
        decode_source_control_record(row)?;
    }
    if let Some(record) = &record {
        text(&record.revision)?;
        if let Some(until) = record.expires_at_ms {
            time(until)?;
        }
    }
    Ok(record)
}
async fn source_deadline<S: QueryStore>(
    store: &S,
    source: &Checks,
    now: i64,
) -> Result<Option<i64>, GatewayError> {
    let mut deadline = None;
    for fence in source.list() {
        let record = read_record(store, &fence.key).await?;
        if record.as_ref().map(|row| &row.revision) != fence.expected_revision.as_ref()
            || record.as_ref().is_some_and(|row| expired(row, now))
        {
            return Err(stale());
        }
        deadline = expiry([deadline, record.and_then(|row| row.expires_at_ms)].into_iter());
    }
    Ok(deadline)
}
fn expired(record: &StoredRecord, now: i64) -> bool {
    record.expires_at_ms.is_some_and(|at| at <= now)
}
fn expiry(values: impl Iterator<Item = Option<i64>>) -> Option<i64> {
    values.flatten().min()
}
#[derive(Clone, Default)]
struct Checks(BTreeMap<String, Option<String>>);
impl Checks {
    fn add(&mut self, fence: RevisionCheck) -> Result<(), GatewayError> {
        TupleKey::from_record_key(&fence.key)
            .and_then(|key| key.validate_stored_key())
            .map_err(|_| missing("Paid source custody key is not canonical"))?;
        if let Some(revision) = &fence.expected_revision {
            text(revision)?;
        }
        if let Some(existing) = self.0.get(&fence.key.0) {
            if existing != &fence.expected_revision {
                return Err(stale());
            }
        } else {
            self.0.insert(fence.key.0, fence.expected_revision);
        }
        Ok(())
    }
    fn record(
        &mut self,
        key: RecordKey,
        record: Option<&StoredRecord>,
    ) -> Result<(), GatewayError> {
        self.add(state::check(key, record))
    }
    fn source(&mut self, checks: &[PaidSourceCheck]) -> Result<(), GatewayError> {
        let mut seen = BTreeSet::new();
        for check in checks {
            if !seen.insert(&check.key) || self_referential(&check.key) {
                return Err(missing(
                    "Paid source custody contains duplicate or self-referential checks",
                ));
            }
            self.add(RevisionCheck {
                key: RecordKey(check.key.clone()),
                expected_revision: check.expected_revision.clone(),
            })?;
        }
        Ok(())
    }
    fn native(&mut self, checks: &[RevisionCheck]) -> Result<(), GatewayError> {
        for check in checks {
            if self_referential(&check.key.0) {
                return Err(missing(
                    "Credential custody references derived paid control",
                ));
            }
            self.add(check.clone())?;
        }
        Ok(())
    }
    fn list(&self) -> Vec<RevisionCheck> {
        self.0
            .iter()
            .map(|(key, revision)| RevisionCheck {
                key: RecordKey(key.clone()),
                expected_revision: revision.clone(),
            })
            .collect()
    }
    fn persisted(&self) -> Vec<PaidSourceCheck> {
        self.list().iter().map(PaidSourceCheck::from).collect()
    }
}
fn self_referential(key: &str) -> bool {
    [
        keys::paid_control_owner(),
        keys::paid_control_config(),
        keys::paid_control_observation(PaidProvider::Surplus),
        keys::paid_control_observation(PaidProvider::Metered),
        keys::paid_routing(),
    ]
    .iter()
    .any(|control| control.0 == key)
}
struct Controls {
    owner_record: StoredRecord,
    owner: PaidControlOwner,
    config_record: StoredRecord,
    config: PaidControlConfig,
}
impl Controls {
    async fn capture<S: QueryStore>(store: &S, now: i64) -> Result<Self, GatewayError> {
        time(now)?;
        let owner_record = read_record(store, &keys::paid_control_owner())
            .await?
            .ok_or_else(|| missing("Paid control owner is not installed"))?;
        let config_record = read_record(store, &keys::paid_control_config())
            .await?
            .ok_or_else(|| missing("Owned paid configuration is not published"))?;
        if expired(&owner_record, now) || expired(&config_record, now) {
            return Err(stale());
        }
        let owner: PaidControlOwner = decode(&owner_record)?;
        let config: PaidControlConfig = decode(&config_record)?;
        if owner.v != 1
            || config.v != PAID_CONTROL_CONFIG_VERSION
            || owner.owner_id != config.owner_id
            || owner.owner_epoch != config.owner_epoch
        {
            return Err(stale());
        }
        for value in [
            &owner.owner_id,
            &owner.owner_epoch,
            &owner.key_fingerprint,
            &owner_record.revision,
            &config_record.revision,
            &config.generation,
            &config.configuration_fingerprint,
        ] {
            text(value)?;
        }
        for binding in [
            &config.surplus_binding,
            &config.openlux_discovery_binding,
            &config.openlux_binding,
        ]
        .into_iter()
        .flatten()
        {
            text(binding)?;
        }
        let mut source = Checks::default();
        source.source(&config.source_checks)?;
        source_deadline(store, &source, now).await?;
        Ok(Self {
            owner_record,
            owner,
            config_record,
            config,
        })
    }
    fn commit_checks(&self, checks: &mut Checks) -> Result<(), GatewayError> {
        checks.record(keys::paid_control_owner(), Some(&self.owner_record))?;
        checks.record(keys::paid_control_config(), Some(&self.config_record))
    }
    fn publication(&self, publication: &CredentialPublication) -> Result<(), GatewayError> {
        publication.validate()?;
        for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
            if publication
                .providers
                .get(&catalog_provider(provider))
                .map(|binding| binding.identity.as_str())
                != discovery_binding(&self.config, provider)
            {
                return Err(missing(
                    "Catalog credentials do not match the authenticated configuration owner publication",
                ));
            }
        }
        Ok(())
    }
    fn observation(
        &self,
        provider: PaidProvider,
        record: &StoredRecord,
        now: i64,
    ) -> Result<PaidProviderObservation, GatewayError> {
        let observation: PaidProviderObservation = decode(record)?;
        let binding = discovery_binding(&self.config, provider).ok_or_else(stale)?;
        if expired(record, now)
            || observation.v != 1
            || observation.provider != provider
            || observation.owner_id != self.owner.owner_id
            || observation.owner_epoch != self.owner.owner_epoch
            || observation.configuration_generation != self.config.generation
            || observation.configuration_fingerprint != self.config.configuration_fingerprint
            || observation.credential_binding != binding
            || observation.observed_at_ms > now
            || observation
                .source_valid_until_ms
                .is_some_and(|at| at <= now)
        {
            return Err(stale());
        }
        time(observation.observed_at_ms)?;
        if let Some(until) = observation.source_valid_until_ms {
            time(until)?;
        }
        if observation.models.iter().any(|row| {
            !row.as_str().starts_with('{')
                || source::member(row, "id")
                    .as_ref()
                    .and_then(source::string)
                    .is_none_or(|id| js_trim_source(&id).as_units().is_empty())
        }) {
            return Err(missing(
                "Provider observation contains malformed model rows",
            ));
        }
        let mut checks = Checks::default();
        checks.source(&observation.source_checks)?;
        Ok(observation)
    }
}
fn revision<H: CatalogHost>(host: &H, checks: &Checks) -> Result<String, GatewayError> {
    let revision = host.unique_id();
    text(&revision)?;
    if checks.0.values().flatten().any(|old| old == &revision) {
        return Err(missing("Paid publisher reused a source revision"));
    }
    Ok(revision)
}
impl CatalogRuntime {
    pub async fn publish_paid_observation<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        provider: PaidProvider,
        force: bool,
    ) -> Result<PaidObservationPublication, GatewayError> {
        self.publish_observation(store, host, provider, force, &Checks::default())
            .await
    }
    async fn publish_observation<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        provider: PaidProvider,
        force: bool,
        base: &Checks,
    ) -> Result<PaidObservationPublication, GatewayError> {
        let started = host.now_ms();
        let control = Controls::capture(store, started).await?;
        let key = keys::paid_control_observation(provider);
        let previous = read_record(store, &key).await?;
        let previous_observation = previous
            .as_ref()
            .map(|row| control.observation(provider, row, started))
            .transpose()?;
        let publication = host.publication().await?;
        control.publication(&publication)?;
        let mut source = Checks::default();
        source.source(&control.config.source_checks)?;
        source.native(&publication.source_checks)?;
        if let Some(old) = &previous_observation {
            source.source(&old.source_checks)?;
        }
        let source_until = source_deadline(store, &source, started).await?;
        let snapshot = if discovery_binding(&control.config, provider).is_some() {
            self.refresh_provider(store, host, catalog_provider(provider), force)
                .await?
        } else {
            None
        };
        let now = host.now_ms();
        time(now)?;
        if now < started {
            return Err(stale());
        }
        let source_until =
            expiry([source_until, source_deadline(store, &source, now).await?].into_iter());
        let mut checks = source.clone();
        for fence in base.list() {
            checks.add(fence)?;
        }
        control.commit_checks(&mut checks)?;
        checks.record(key.clone(), previous.as_ref())?;
        let (next, revision) = if let Some(snapshot) = snapshot {
            let observed = snapshot
                .updated_at_ms
                .ok_or_else(|| missing("Provider model observation has no source time"))?;
            time(observed)?;
            if observed > now {
                return Err(stale());
            }
            let revision = revision(host, &checks)?;
            let next = PaidProviderObservation {
                v: 1,
                provider,
                owner_id: control.owner.owner_id,
                owner_epoch: control.owner.owner_epoch,
                configuration_generation: control.config.generation,
                configuration_fingerprint: control.config.configuration_fingerprint,
                credential_binding: configured_binding(&publication, provider)?,
                observed_at_ms: observed,
                source_valid_until_ms: source_until,
                stale: snapshot.stale || now.saturating_sub(observed) >= 300_000,
                models: routing_rows(snapshot.models),
                source_checks: source.persisted(),
            };
            (Some(next), Some(revision))
        } else {
            (None, previous.as_ref().map(|row| row.revision.clone()))
        };
        let mutations = if let (Some(next), Some(revision)) = (next, revision.as_ref()) {
            vec![RecordMutation::Put {
                key,
                record: encode_source_control_record(
                    revision,
                    &SourceJson::from_serializable(&next)
                        .map_err(|_| missing("Provider observation serialization failed"))?,
                    source_until,
                )?,
            }]
        } else {
            Vec::new()
        };
        if store
            .commit(AtomicTransition {
                checks: checks.list(),
                mutations,
            })
            .await?
            != CommitOutcome::Committed
        {
            return Err(stale());
        }
        Ok(PaidObservationPublication {
            provider,
            revision,
            published_at_ms: now,
        })
    }
    /// Capture durable source values before any awaited provider fetch. There is one
    /// full replacement projection; missing models cannot survive from an older row.
    pub async fn publish_paid_routing<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
    ) -> Result<PaidRoutingPublication, GatewayError> {
        let started = host.now_ms();
        let control = Controls::capture(store, started).await?;
        let captured = CapturedSource::read(store, started).await?;
        let publication = host.publication().await?;
        control.publication(&publication)?;
        let mut source = captured.checks.clone();
        source.source(&control.config.source_checks)?;
        source.native(&publication.source_checks)?;
        let mut prior_observations = Vec::new();
        for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
            let key = keys::paid_control_observation(provider);
            let row = read_record(store, &key).await?;
            if let Some(row) = &row {
                control.observation(provider, row, started)?;
            }
            prior_observations.push((provider, row));
        }
        for (provider, row) in &prior_observations {
            if row.is_none() && configured(&control.config, *provider).is_some() {
                self.publish_observation(store, host, *provider, false, &source)
                    .await?;
            }
        }
        let now = host.now_ms();
        time(now)?;
        if now < started {
            return Err(stale());
        }
        let mut input = captured.input;
        let mut observation_revisions = BTreeMap::new();
        let mut source_valid_until = expiry(
            [
                control.owner_record.expires_at_ms,
                control.config_record.expires_at_ms,
                captured.valid_until,
            ]
            .into_iter(),
        );
        for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
            let key = keys::paid_control_observation(provider);
            let row = read_record(store, &key).await?;
            let binding = configured(&control.config, provider);
            if let Some(row) = &row {
                let observation = control.observation(provider, row, now)?;
                source.source(&observation.source_checks)?;
                source_valid_until = expiry(
                    [
                        source_valid_until,
                        row.expires_at_ms,
                        observation.source_valid_until_ms,
                    ]
                    .into_iter(),
                );
                input.providers.insert(
                    catalog_provider(provider).id().into(),
                    ProviderCatalog {
                        models: observation.models,
                        updated_at_ms: Some(observation.observed_at_ms),
                        configured: binding.is_some(),
                        available: true,
                        stale: observation.stale,
                    },
                );
            } else {
                input.providers.insert(
                    catalog_provider(provider).id().into(),
                    ProviderCatalog {
                        configured: binding.is_some(),
                        ..ProviderCatalog::default()
                    },
                );
            }
            observation_revisions.insert(
                catalog_provider(provider).id(),
                row.as_ref().map(|r| r.revision.clone()),
            );
        }
        source_valid_until = expiry(
            [
                source_valid_until,
                source_deadline(store, &source, now).await?,
            ]
            .into_iter(),
        );
        if source_valid_until.is_some_and(|until| until <= now) {
            return Err(stale());
        }
        let policy = coarse_policy(&input);
        let projection = PaidRoutingProjection {
            policy,
            provenance: PaidProjectionProvenance {
                v: 1,
                owner_revision: control.owner_record.revision.clone(),
                config_revision: control.config_record.revision.clone(),
                surplus_observation_revision: observation_revisions
                    .get("surplus")
                    .cloned()
                    .flatten(),
                openlux_observation_revision: observation_revisions
                    .get("openlux")
                    .cloned()
                    .flatten(),
                observed_at_ms: now,
                source_valid_until_ms: source_valid_until,
                source_checks: source.persisted(),
            },
        };
        let previous = read_record(store, &keys::paid_routing()).await?;
        let mut checks = source.clone();
        control.commit_checks(&mut checks)?;
        for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
            checks.add(RevisionCheck {
                key: keys::paid_control_observation(provider),
                expected_revision: observation_revisions
                    .get(catalog_provider(provider).id())
                    .cloned()
                    .flatten(),
            })?;
        }
        checks.record(keys::paid_routing(), previous.as_ref())?;
        let revision = revision(host, &checks)?;
        if store
            .commit(AtomicTransition {
                checks: checks.list(),
                mutations: vec![RecordMutation::Put {
                    key: keys::paid_routing(),
                    record: encode_source_control_record(
                        &revision,
                        &SourceJson::from_serializable(&projection)
                            .map_err(|_| missing("Paid projection serialization failed"))?,
                        source_valid_until,
                    )?,
                }],
            })
            .await?
            != CommitOutcome::Committed
        {
            return Err(stale());
        }
        Ok(PaidRoutingPublication {
            revision,
            published_at_ms: now,
            source_checks: source.list(),
        })
    }
}
fn routing_rows(models: Vec<SourceJson>) -> Vec<SourceJson> {
    models
        .into_iter()
        .map(|row| {
            source::object(
                [
                    "id",
                    "created",
                    "supported_endpoint_types",
                    "supports_tools",
                    "supports_parallel_tool_calls",
                    "input_price_per_token",
                    "output_price_per_token",
                    "cache_read_price_per_token",
                    "cache_write_price_per_token",
                    "max_output_tokens",
                ]
                .iter()
                .filter_map(|&key| source::member(&row, key).map(|value| (key, value)))
                .collect(),
            )
            .expect("paid observation source fields")
        })
        .collect()
}
fn identifier(row: &SourceJson) -> Option<ModelId> {
    ["slug", "id", "model", "name"]
        .iter()
        .find_map(|key| source::member(row, key).as_ref().and_then(source::string))
        .map(ModelId::from_source)
}

fn configured_binding(
    publication: &CredentialPublication,
    provider: PaidProvider,
) -> Result<String, GatewayError> {
    publication
        .providers
        .get(&catalog_provider(provider))
        .map(|binding| binding.identity.clone())
        .ok_or_else(|| missing("Provider credential publication is unavailable"))
}
struct CapturedSource {
    checks: Checks,
    input: CatalogInput,
    valid_until: Option<i64>,
}
impl CapturedSource {
    async fn read<S: QueryStore>(store: &S, now: i64) -> Result<Self, GatewayError> {
        let mut checks = Checks::default();
        let mut values = BTreeMap::new();
        let mut expiries = Vec::new();
        for (name, key) in [
            ("runtime", catalog_store::runtime_config_key()),
            ("full", catalog_store::codex_snapshot_key()),
            ("selection", state::selection_key()),
            ("generation", catalog_store::auth_generation_key()),
            ("raw_pool", state::source_key(&["ubq_ai", "codex_auth"])),
            ("pool", keys::pool()),
        ] {
            let record = read_record(store, &key).await?;
            checks.record(key, record.as_ref())?;
            if let Some(record) = record {
                if expired(&record, now) {
                    return Err(stale());
                }
                expiries.push(record.expires_at_ms);
                if matches!(name, "runtime" | "full" | "selection" | "generation") {
                    values.insert(name, decode_source_control_record(&record)?);
                }
            }
        }
        let snapshot = values
            .get("runtime")
            .map(|raw| {
                normalize_runtime_config(raw)
                    .ok_or_else(|| missing("Runtime model source is malformed"))
            })
            .transpose()?
            .as_ref()
            .and_then(|runtime| source::member(runtime, "codex_models"))
            .map(|raw| {
                raw.deserialize::<ModelSnapshot>()
                    .map_err(|_| missing("Compact model source is malformed"))
            })
            .transpose()?;
        let full_snapshot = values
            .get("full")
            .map(|raw| {
                raw.deserialize::<ModelSnapshot>()
                    .map_err(|_| missing("Full model source is malformed"))
            })
            .transpose()?;
        if full_snapshot.as_ref().is_some_and(|s| {
            s.models.is_empty()
                || s.models.iter().any(|row| !row.as_str().starts_with('{'))
                || js_trim_source(&s.source).as_units().is_empty()
                || s.updated_at_ms <= 0
        }) {
            return Err(missing("Full model source is malformed"));
        }
        let selection = values
            .get("selection")
            .map(|raw| {
                ProviderSelection::normalize(&raw.deserialize::<Value>()?)
                    .ok_or_else(|| missing("Provider selection source is malformed"))
            })
            .transpose()?;
        if values
            .get("generation")
            .is_some_and(|v| source::string(v).is_none_or(|s| s.as_units().is_empty()))
        {
            return Err(missing("Catalog generation source is malformed"));
        }
        Ok(Self {
            checks,
            input: CatalogInput {
                snapshot,
                full_snapshot,
                selection,
                ..CatalogInput::default()
            },
            valid_until: expiry(expiries.into_iter()),
        })
    }
}
fn coarse_policy(input: &CatalogInput) -> PaidRoutingPolicy {
    let mut codex_models = input
        .snapshot
        .as_ref()
        .into_iter()
        .flat_map(|snapshot| snapshot.models.iter())
        .filter_map(identifier)
        .collect::<Vec<_>>();
    // Owner-authorized Codex transport ID; this is routing classification, not an invented catalog row.
    if !codex_models
        .iter()
        .any(|id| id.matches_scalar("gpt-reserve"))
    {
        codex_models.push("gpt-reserve".into());
    }
    let mut models = codex_models
        .iter()
        .cloned()
        .chain(
            input
                .full_snapshot
                .as_ref()
                .into_iter()
                .flat_map(|snapshot| snapshot.models.iter())
                .filter_map(identifier),
        )
        .chain(
            input
                .rows("surplus")
                .iter()
                .chain(input.rows("openlux"))
                .filter_map(|row| {
                    source::member(row, "id")
                        .as_ref()
                        .and_then(source::string)
                        .map(ModelId::from_source)
                }),
        )
        .collect::<BTreeSet<_>>();
    models.retain(|model| !js_trim_source(model.as_js_string()).as_units().is_empty());
    let mut result = BTreeMap::new();
    for model in models {
        let mut allowed = Vec::new();
        for endpoint in ["openai-response", "openai"] {
            for hop in [None, Some(DeepseekHop::Surplus), Some(DeepseekHop::Openlux)] {
                let pinned = hop.map(|hop| {
                    vec![if hop == DeepseekHop::Surplus {
                        PaidProvider::Surplus
                    } else {
                        PaidProvider::Metered
                    }]
                });
                let plan = resolve_paid_route(&PaidRoutingInput {
                    model: model.clone(),
                    endpoint_type: endpoint.into(),
                    request_uses_tools: false,
                    codex_model_known: codex_models.contains(&model),
                    codex_enabled: input.enabled("codex"),
                    surplus_enabled: input.enabled("surplus"),
                    openlux_enabled: input.enabled("openlux"),
                    surplus_configured: input.configured("surplus"),
                    openlux_configured: input.configured("openlux"),
                    surplus_catalog: input
                        .providers
                        .get("surplus")
                        .filter(|p| p.available)
                        .map(|p| p.models.clone()),
                    openlux_catalog: input
                        .providers
                        .get("openlux")
                        .filter(|p| p.available)
                        .map(|p| p.models.clone()),
                    allowed_paid_providers: pinned,
                    synthetic_hop: hop,
                    ubiquity_enabled: input.enabled("ubiquity"),
                });
                for provider in plan.providers {
                    if !allowed.contains(&provider) {
                        allowed.push(provider);
                    }
                }
            }
        }
        let providers = paid_order(
            allowed.contains(&PaidProvider::Surplus),
            allowed.contains(&PaidProvider::Metered),
        );
        if !providers.is_empty() {
            result.insert(model, providers);
        }
    }
    PaidRoutingPolicy {
        v: 2,
        codex_enabled: input.enabled("codex"),
        codex_models,
        models: result,
    }
}
