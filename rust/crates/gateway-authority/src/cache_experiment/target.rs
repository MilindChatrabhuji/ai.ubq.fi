//! Full source roster and exact capability/ordered-pool fingerprints, without discovery I/O.
use super::{PreparedTarget, model::*};
use crate::{Authority, TokenSource, store::Transaction};
use gateway_auth::{
    crypto::sha256_hex,
    provider_credentials::{codex_source_pool_key, parse_codex_source_pool},
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    model::ModelId,
    source_json::SourceJson,
    source_serialization as source,
    state::{AuthorityStore, RecordKey},
    tuple_key::{ScalarKeyPart::String as Text, TupleKey},
};
use gateway_schema::{runtime_config::normalize_runtime_config, snapshot::ModelSnapshot};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) fn key(parts: &[&str]) -> RecordKey {
    TupleKey::from_scalar_parts(&parts.iter().map(|s| Text(s)).collect::<Vec<_>>()).to_record_key()
}
pub(super) fn catalog_key() -> RecordKey {
    key(&["ubq_ai", "codex_models"])
}
pub(super) fn runtime_key() -> RecordKey {
    key(&["uos_ai", "runtime_config", "v2"])
}
pub(super) fn json<T: serde::Serialize + ?Sized>(value: &T) -> SourceJson {
    SourceJson::from_serializable(value).expect("typed cache control is valid source JSON")
}
pub(super) fn set_member(
    value: &mut SourceJson,
    key: &str,
    next: SourceJson,
) -> Result<(), GatewayError> {
    let key = JsString16::from_utf8(key);
    let mut fields = source::entries(value)
        .ok_or_else(|| failed("Prompt-cache scope experiment catalog is malformed."))?;
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == &key) {
        *old = next;
    } else {
        fields.push((key, next));
    }
    *value = source::object_keys(fields)?;
    Ok(())
}
// The existing application fingerprint recipe sorts every object key by UTF16 units,
// unlike ordinary JSON.stringify numeric-key ordering. Only the source view changed.
pub(super) fn canonical(value: &SourceJson) -> Result<String, GatewayError> {
    if let Some(mut fields) = source::entries(value) {
        fields.sort_by(|(a, _), (b, _)| a.as_units().cmp(b.as_units()));
        let fields = fields
            .iter()
            .map(|(key, value)| {
                Ok(format!(
                    "{}:{}",
                    key.to_source_json()?.as_str(),
                    canonical(value)?
                ))
            })
            .collect::<Result<Vec<_>, GatewayError>>()?;
        Ok(format!("{{{}}}", fields.join(",")))
    } else if let Some(array) = source::array(value) {
        Ok(format!(
            "[{}]",
            array
                .iter()
                .map(canonical)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        ))
    } else {
        Ok(source::canonical(value)?.as_str().to_owned())
    }
}
fn digest(value: &SourceJson) -> Result<String, GatewayError> {
    Ok(format!(
        "sha256:{}",
        sha256_hex(canonical(value)?.as_bytes())
    ))
}
fn encoded(value: &str) -> String {
    let mut result = String::new();
    for c in value.bytes() {
        if c.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&c) {
            result.push(char::from(c));
        } else {
            result.push_str(&format!("%{c:02X}"));
        }
    }
    result
}
fn text(value: Option<&SourceJson>) -> Option<JsString16> {
    value
        .and_then(source::string)
        .map(|s| gateway_schema::reasoning::js_trim_source(&s))
        .filter(|s| !s.as_units().is_empty())
}
pub(super) struct Inventory {
    pub targets: Vec<TargetBinding>,
}
pub(super) async fn inventory<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
) -> Result<Inventory, GatewayError> {
    let raw: SourceJson = tx.read_source_control(&catalog_key()).await?.ok_or_else(|| unavailable("Prompt-cache scope experiment requires a current full target inventory and runtime configuration."))?;
    let snapshot: ModelSnapshot = raw
        .deserialize()
        .map_err(|_| unavailable("Prompt-cache scope experiment catalog is malformed."))?;
    if gateway_schema::reasoning::js_trim_source(&snapshot.source)
        .as_units()
        .is_empty()
        || snapshot.updated_at_ms < 0
        || snapshot.models.is_empty()
    {
        return Err(unavailable(
            "Prompt-cache scope experiment catalog is malformed.",
        ));
    }
    let runtime: SourceJson = tx
        .read_source_control(&runtime_key())
        .await?
        .ok_or_else(|| unavailable("Prompt-cache scope experiment runtime is unavailable."))?;
    if normalize_runtime_config(&runtime).is_none() {
        return Err(unavailable(
            "Prompt-cache scope experiment runtime is unavailable.",
        ));
    }
    let source: Value = tx.read(&codex_source_pool_key()).await?.ok_or_else(|| {
        unavailable("Codex auth pool is unavailable for the prompt-cache scope experiment.")
    })?;
    let pool = parse_codex_source_pool(&source)?.ok_or_else(|| {
        unavailable("Codex auth pool is unavailable for the prompt-cache scope experiment.")
    })?;
    let identity = digest(&json(
        &json!({"v":"codex-auth-pool-identity-v1","ordered_account_ids":pool.accounts.iter().map(|a| &a.account_id).collect::<Vec<_>>()}),
    ))?;
    let catalog_revision = tx
        .revision(&catalog_key())
        .ok_or_else(|| unavailable("Prompt-cache catalog binding is unavailable."))?;
    let runtime_revision = tx
        .revision(&runtime_key())
        .ok_or_else(|| unavailable("Prompt-cache runtime binding is unavailable."))?;
    let pool_revision = tx
        .revision(&codex_source_pool_key())
        .ok_or_else(|| unavailable("Prompt-cache auth binding is unavailable."))?;
    let mut models: BTreeMap<JsString16, Vec<&SourceJson>> = BTreeMap::new();
    for record in &snapshot.models {
        if !record.as_str().starts_with('{') {
            return Err(unavailable(
                "Prompt-cache scope experiment catalog is malformed.",
            ));
        }
        let id = ["slug", "id", "model", "name"]
            .into_iter()
            .find_map(|k| text(source::member(record, k).as_ref()))
            .ok_or_else(|| unavailable("Prompt-cache scope experiment catalog is malformed."))?;
        models.entry(id).or_default().push(record);
    }
    let mut rows = Vec::new();
    let mut bindings = Vec::new();
    for (model, records) in models {
        // Source scope-targets.ts builds the URI target ID before capability hashing.
        // Successful encodeURIComponent requires paired UTF16; this proof applies only
        // to the campaign model, never source labels, efforts or other catalog controls.
        let scalar_model = model
            .try_utf8()
            .map_err(|_| failed("Prompt-cache scope experiment could not run."))?;
        let id = format!(
            "prompt-cache-scope-targets-v3:{PROVIDER}:{TELEMETRY_PROVIDER}:codex_account_pool:{PROFILE}:{}",
            encoded(&scalar_model)
        );
        let qualified = records.len() == 1
            && snapshot.scope_experiment_eligible(&ModelId::from_source(model.clone()));
        let capability = if records.len() == 1 {
            source::member(records[0], "prompt_cache")
                .as_ref()
                .and_then(|cache| {
                    gateway_schema::prompt_cache::normalize_capabilities_source(Some(cache))
                })
                .and_then(|cache| {
                    source::member(&cache, "providers")
                        .as_ref()
                        .and_then(source::array)
                })
                .and_then(|providers| {
                    providers.into_iter().find(|p| {
                        source::member(p, "id")
                            .as_ref()
                            .and_then(source::string)
                            .is_some_and(|id| {
                                id.as_units().iter().copied().eq(PROVIDER.encode_utf16())
                            })
                    })
                })
                .map(|p| {
                    source::object(vec![
                        ("id", source::member(&p, "id").expect("matched provider")),
                        (
                            "controls",
                            source::member(&p, "controls").unwrap_or_else(|| json(&())),
                        ),
                    ])
                    .expect("cache capability object")
                })
        } else {
            None
        };
        let qualification = if qualified {
            "qualified"
        } else {
            "unqualified"
        };
        let fingerprint = digest(&source::object(vec![
            ("version", json("prompt-cache-scope-targets-v3")),
            ("provider", json(PROVIDER)),
            ("telemetry_provider", json(TELEMETRY_PROVIDER)),
            ("topology_kind", json("codex_account_pool")),
            ("model", json(&model)),
            ("probe_profile", json(PROFILE)),
            (
                "catalog_entry",
                json(if records.len() == 1 {
                    "unique"
                } else {
                    "ambiguous"
                }),
            ),
            ("codex_cache_qualification", json(qualification)),
            ("codex_prompt_cache_capability", json(&capability)),
        ])?)?;
        rows.push(source::object(vec![
            ("id", json(&id)), ("provider", json(PROVIDER)), ("telemetry_provider", json(TELEMETRY_PROVIDER)), ("model", json(&model)), ("model_family_id", json(&model)),
            ("model_family_source", json("exact_model")), ("probe_profile", json(PROFILE)), ("catalog_model_present", json(&true)), ("codex_cache_qualification", json(qualification)),
            ("topology", json(&json!({"kind":"codex_account_pool","configured_slot_count":if pool.accounts.len()==2{2}else if pool.accounts.len()==1{1}else{0}}))), ("capability_fingerprint", json(&fingerprint)),
        ])?);
        if qualified && pool.accounts.len() == 2 {
            bindings.push(TargetBinding {
                id,
                provider: PROVIDER.into(),
                telemetry_provider: TELEMETRY_PROVIDER.into(),
                topology_kind: "codex_account_pool".into(),
                model: scalar_model,
                probe_profile: PROFILE.into(),
                capability_fingerprint: fingerprint,
                inventory_fingerprint: String::new(),
                catalog_versionstamp: catalog_revision.clone(),
                runtime_versionstamp: runtime_revision.clone(),
                auth_pool_versionstamp: pool_revision.clone(),
                auth_pool_identity_fingerprint: identity.clone(),
                catalog_client_version: snapshot
                    .client_version
                    .as_deref()
                    .map(gateway_schema::util::js_trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            });
        }
    }
    rows.sort_by(|a, b| {
        source::member(a, "id")
            .as_ref()
            .and_then(source::string)
            .expect("target id")
            .as_units()
            .cmp(
                source::member(b, "id")
                    .as_ref()
                    .and_then(source::string)
                    .expect("target id")
                    .as_units(),
            )
    });
    let fingerprint = digest(&source::object(vec![
        ("version", json("prompt-cache-scope-targets-v3")),
        ("probe_profile", json(PROFILE)),
        (
            "metered_fallback_roster",
            json(&json!({"status":"unknown","model_ids":[],"non_catalog_model_ids":[]})),
        ),
        ("targets", json(&rows)),
    ])?)?;
    bindings.sort_by(|a, b| a.id.encode_utf16().cmp(b.id.encode_utf16()));
    for target in &mut bindings {
        target.inventory_fingerprint.clone_from(&fingerprint);
        target.validate()?;
    }
    Ok(Inventory { targets: bindings })
}
pub(super) async fn resolve<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    expected: &TargetBinding,
) -> Result<Result<TargetBinding, Reason>, GatewayError> {
    let current = inventory(tx).await?;
    let Some(current) = current.targets.into_iter().find(|t| t.id == expected.id) else {
        return Ok(Err(Reason::TargetCatalogDrift));
    };
    if current.auth_pool_identity_fingerprint != expected.auth_pool_identity_fingerprint {
        return Ok(Err(Reason::AuthPoolDrift));
    }
    if !current.same_core(expected) {
        return Ok(Err(Reason::TargetCatalogDrift));
    }
    if current.inventory_fingerprint != expected.inventory_fingerprint {
        return Ok(Err(Reason::InventoryDrift));
    }
    if current.auth_pool_versionstamp != expected.auth_pool_versionstamp {
        return Ok(Err(Reason::AuthPoolDrift));
    }
    Ok(Ok(current))
}
impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub async fn prepare_cache_experiment(
        &self,
        release_git_sha: &str,
        now: i64,
    ) -> Result<PreparedTarget, GatewayError> {
        if !super::release_valid(release_git_sha) {
            return Err(unavailable(
                "Prompt-cache scope experiment requires current-release telemetry.",
            ));
        }
        let mut tx = self.transaction(now)?;
        let current = inventory(&mut tx).await?;
        let target = super::state::select_target(&mut tx, current.targets).await?;
        let mut recheck = self.transaction(self.fresh_time(now)?)?;
        let target=resolve(&mut recheck,&target).await?.map_err(|_| unavailable("Prompt-cache scope experiment target changed before its Stage 0 baseline could be checked."))?;
        Ok(PreparedTarget {
            target,
            release_git_sha: release_git_sha.into(),
        })
    }
}
