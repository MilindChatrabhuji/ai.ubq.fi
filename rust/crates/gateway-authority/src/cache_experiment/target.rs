//! Full source roster and exact capability/ordered-pool fingerprints, without discovery I/O.
use super::{PreparedTarget, model::*};
use crate::{Authority, TokenSource, store::Transaction};
use gateway_auth::{
    crypto::sha256_hex,
    provider_credentials::{codex_source_pool_key, parse_codex_source_pool},
};
use gateway_core::{
    GatewayError,
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
pub(super) fn canonical(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("string serialization"),
                        canonical(&object[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(array) => format!(
            "[{}]",
            array.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => gateway_schema::util::json_stringify(value),
    }
}
fn digest(value: &Value) -> String {
    format!("sha256:{}", sha256_hex(canonical(value).as_bytes()))
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
fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(gateway_schema::util::js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
pub(super) struct Inventory {
    pub targets: Vec<TargetBinding>,
}
pub(super) async fn inventory<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
) -> Result<Inventory, GatewayError> {
    let raw: Value = tx.read(&catalog_key()).await?.ok_or_else(|| unavailable("Prompt-cache scope experiment requires a current full target inventory and runtime configuration."))?;
    let snapshot: ModelSnapshot = serde_json::from_value(raw.clone())
        .map_err(|_| unavailable("Prompt-cache scope experiment catalog is malformed."))?;
    if snapshot
        .source
        .trim_matches(gateway_schema::util::js_whitespace)
        .is_empty()
        || snapshot.updated_at_ms < 0
        || snapshot.models.is_empty()
    {
        return Err(unavailable(
            "Prompt-cache scope experiment catalog is malformed.",
        ));
    }
    let runtime: Value = tx
        .read(&runtime_key())
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
    let identity = digest(
        &json!({"v":"codex-auth-pool-identity-v1","ordered_account_ids":pool.accounts.iter().map(|a| &a.account_id).collect::<Vec<_>>()}),
    );
    let catalog_revision = tx
        .revision(&catalog_key())
        .ok_or_else(|| unavailable("Prompt-cache catalog binding is unavailable."))?;
    let runtime_revision = tx
        .revision(&runtime_key())
        .ok_or_else(|| unavailable("Prompt-cache runtime binding is unavailable."))?;
    let pool_revision = tx
        .revision(&codex_source_pool_key())
        .ok_or_else(|| unavailable("Prompt-cache auth binding is unavailable."))?;
    let mut models: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for record in &snapshot.models {
        if !record.is_object() {
            return Err(unavailable(
                "Prompt-cache scope experiment catalog is malformed.",
            ));
        }
        let id = ["slug", "id", "model", "name"]
            .into_iter()
            .find_map(|k| text(record.get(k)))
            .ok_or_else(|| unavailable("Prompt-cache scope experiment catalog is malformed."))?;
        models.entry(id).or_default().push(record);
    }
    let mut rows = Vec::new();
    let mut bindings = Vec::new();
    for (model, records) in models {
        let qualified = records.len() == 1 && snapshot.scope_experiment_eligible(&model);
        let capability = if records.len() == 1 {
            gateway_schema::prompt_cache::normalize_capabilities(records[0].get("prompt_cache"))
                .and_then(|c| {
                    c["providers"]
                        .as_array()
                        .and_then(|ps| ps.iter().find(|p| p["id"] == PROVIDER))
                        .cloned()
                })
                .map(|p| json!({"id":p["id"],"controls":p.get("controls").unwrap_or(&Value::Null)}))
        } else {
            None
        };
        let qualification = if qualified {
            "qualified"
        } else {
            "unqualified"
        };
        let fingerprint = digest(
            &json!({"version":"prompt-cache-scope-targets-v3","provider":PROVIDER,"telemetry_provider":TELEMETRY_PROVIDER,"topology_kind":"codex_account_pool","model":model,"probe_profile":PROFILE,"catalog_entry":if records.len()==1{"unique"}else{"ambiguous"},"codex_cache_qualification":qualification,"codex_prompt_cache_capability":capability}),
        );
        let id = format!(
            "prompt-cache-scope-targets-v3:{PROVIDER}:{TELEMETRY_PROVIDER}:codex_account_pool:{PROFILE}:{}",
            encoded(&model)
        );
        rows.push(json!({"id":id,"provider":PROVIDER,"telemetry_provider":TELEMETRY_PROVIDER,"model":model,"model_family_id":model,"model_family_source":"exact_model","probe_profile":PROFILE,"catalog_model_present":true,"codex_cache_qualification":qualification,"topology":{"kind":"codex_account_pool","configured_slot_count":if pool.accounts.len()==2{2}else if pool.accounts.len()==1{1}else{0}},"capability_fingerprint":fingerprint}));
        if qualified && pool.accounts.len() == 2 {
            bindings.push(TargetBinding {
                id,
                provider: PROVIDER.into(),
                telemetry_provider: TELEMETRY_PROVIDER.into(),
                topology_kind: "codex_account_pool".into(),
                model,
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
        a["id"]
            .as_str()
            .unwrap_or_default()
            .encode_utf16()
            .cmp(b["id"].as_str().unwrap_or_default().encode_utf16())
    });
    let fingerprint = digest(
        &json!({"version":"prompt-cache-scope-targets-v3","probe_profile":PROFILE,"metered_fallback_roster":{"status":"unknown","model_ids":[],"non_catalog_model_ids":[]},"targets":rows}),
    );
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
