use crate::{AdminRuntime, capabilities::RuntimeCapabilities, store};
use gateway_admin::{PaidKeyFields, source_input as input};
use gateway_auth::{
    AuthHost, conflict, invalid,
    store::{check, commit, put},
};
use gateway_authority::{
    keys,
    paid::{PaidAttempt, PaidWindow, ReconciliationGate},
};
use gateway_core::{
    GatewayError,
    identity::MAX_SAFE_INTEGER,
    lifecycle::BillingState,
    model::ModelId,
    query::QueryStore,
    source_control::decode_source_control_record,
    source_json::SourceJson,
    state::{RecordMutation, RevisionCheck},
};
use gateway_schema::{catalog_store::codex_snapshot_key, snapshot::ModelSnapshot};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn pricing_error(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "metered_pricing_invalid")
}
fn outstanding() -> GatewayError {
    GatewayError::new(
        409,
        "Cannot delete API key while metered billing is pending or unresolved",
        Some("paid_fallback_billing_outstanding"),
    )
}

impl<S: QueryStore, H: AuthHost, C: RuntimeCapabilities> AdminRuntime<'_, S, H, C> {
    pub(crate) async fn paid_policy(
        &self,
        body: &SourceJson,
    ) -> Result<PaidKeyFields, GatewayError> {
        if input::member(body, "paid_fallback_enabled")
            .as_ref()
            .is_some_and(|value| input::boolean(value).is_none())
        {
            return Err(invalid("paid_fallback_enabled must be a boolean"));
        }
        let enabled = input::member(body, "paid_fallback_enabled")
            .as_ref()
            .and_then(input::boolean)
            == Some(true);
        let limit = match input::member(body, "paid_fallback_limit_credits") {
            None => 0,
            Some(value) => {
                let credits = input::number(&value)
                    .filter(|n| n.is_finite() && (*n >= 0.0 || *n == -1.0))
                    .ok_or_else(|| {
                        invalid("paid_fallback_limit_credits must be a non-negative number or -1")
                    })?;
                if credits == -1.0 {
                    -1
                } else {
                    let micro = (credits * 1000000.0).round();
                    if micro > MAX_SAFE_INTEGER as f64 {
                        return Err(invalid(
                            "paid_fallback_limit_credits must be a non-negative number or -1",
                        ));
                    }
                    micro as i64
                }
            }
        };
        if enabled && limit == 0 {
            return Err(invalid(
                "paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled",
            ));
        }
        if !enabled {
            let mut result = PaidKeyFields::disabled();
            result.limit_microcredits = limit;
            result.quota_per_credit = 0;
            return Ok(result);
        }
        let snapshot_row = self.store.read(&codex_snapshot_key()).await?;
        let snapshot = snapshot_row.as_ref().filter(|row| row.expires_at_ms.is_none_or(|expiry| expiry > self.host.now_ms())).map(|row| decode_source_control_record(row)?.deserialize::<ModelSnapshot>().map_err(|_| pricing_error("Stored full Codex model catalog is invalid"))).transpose()?.ok_or_else(|| pricing_error("Metered paid fallback cannot be enabled before the Codex model catalog is initialized."))?;
        let mut models = Vec::new();
        let mut seen = BTreeSet::new();
        let mut contexts = BTreeMap::new();
        for model in snapshot.models {
            let id = ["slug", "id", "model", "name"]
                .into_iter()
                .find_map(|field| input::member(&model, field).as_ref().and_then(input::text))
                .map(|id| input::trim(&id))
                .filter(|id| !id.as_units().is_empty())
                .map(ModelId::from_source);
            let Some(id) = id else { continue };
            if !seen.insert(id.clone()) {
                continue;
            }
            models.push(id.clone());
            let context = [
                "context_window",
                "max_context_window",
                "auto_compact_token_limit",
            ]
            .into_iter()
            .filter_map(|field| {
                input::member(&model, field)
                    .as_ref()
                    .and_then(input::number)
                    .filter(|n| {
                        n.is_finite()
                            && n.fract() == 0.0
                            && *n > 0.0
                            && *n <= MAX_SAFE_INTEGER as f64
                    })
                    .map(|n| n as i64)
            })
            .max();
            if let Some(context) = context {
                contexts.insert(id, context);
            }
        }
        if models.is_empty() {
            return Err(pricing_error(
                "Metered paid fallback cannot be enabled before the Codex model catalog is initialized.",
            ));
        }
        let pricing = self.capabilities.pricing(&models).await?;
        if pricing.eligible_model_ids.is_empty()
            || pricing.quota_per_credit <= 0
            || pricing.quota_per_credit > MAX_SAFE_INTEGER
            || pricing.checked_at_ms <= 0
            || pricing.checked_at_ms > self.host.now_ms()
        {
            return Err(pricing_error(
                "Metered paid fallback found no valid current pricing.",
            ));
        }
        let mut exposure = BTreeMap::new();
        let mut eligible = BTreeSet::new();
        for model in &pricing.eligible_model_ids {
            if !seen.contains(model) || !eligible.insert(model.clone()) {
                return Err(pricing_error(
                    "Paid pricing contains an unadvertised or duplicate model.",
                ));
            }
            let context=contexts.get(model).copied().ok_or_else(||pricing_error("Metered paid fallback cannot be enabled because a priced Codex model has no finite context bound."))?;
            let coefficient = pricing
                .model_quota_coefficients
                .get(model)
                .copied()
                .filter(|n| n.is_finite() && *n > 0.0)
                .ok_or_else(|| pricing_error("Paid model pricing coefficient is invalid."))?;
            let maximum =
                (context as f64 * coefficient * 1000000.0 / pricing.quota_per_credit as f64).ceil();
            if !maximum.is_finite() || maximum <= 0.0 || maximum > MAX_SAFE_INTEGER as f64 {
                return Err(pricing_error(
                    "Paid model exposure is not a finite positive credit bound.",
                ));
            }
            exposure.insert(model.clone(), maximum as i64);
        }
        Ok(PaidKeyFields {
            enabled: true,
            limit_microcredits: limit,
            model_ids: pricing.eligible_model_ids,
            quota_per_credit: pricing.quota_per_credit,
            max_exposure_microcredits: exposure,
            pricing_checked_at_ms: Some(pricing.checked_at_ms),
        })
    }
    pub(crate) async fn prepare_deletion(
        &self,
        id: &str,
    ) -> Result<Vec<RevisionCheck>, GatewayError> {
        let now = self.host.now_ms();
        let id_key = gateway_auth::api_keys::id_key(id);
        let id_row = self.store.read(&id_key).await?;
        let value = gateway_admin::keys::current_record(&id_key, id_row.as_ref(), now)?
            .ok_or_else(|| GatewayError::new(404, "Not found", Some("not_found")))?;
        if value.policy.revoked_at_ms.is_none() {
            return Err(invalid("Only revoked keys can be deleted"));
        }
        let dk = keys::paid_deletion(id);
        let prior = self.store.read(&dk).await?;
        let prior_value = store::value(prior.as_ref(), now)?;
        let local = id == "local-development";
        let guard = if !local && prior_value.is_some() {
            let row = prior.expect("present ordinary guard");
            if row
                .json_value()?
                .get("created_at_ms")
                .and_then(Value::as_i64)
                .is_none_or(|at| at <= 0)
            {
                return Err(outstanding());
            }
            row
        } else {
            if local
                && prior_value.as_ref().is_some_and(|v| {
                    v.get("local_deletion").and_then(|l| l.get("owner")) != Some(&Value::Null)
                        || v.get("local_deletion")
                            .and_then(|l| l.get("completed_at_ms"))
                            != Some(&Value::Null)
                        || v.get("created_at_ms")
                            .and_then(Value::as_i64)
                            .is_none_or(|at| at <= 0)
                })
            {
                return Err(GatewayError::new(
                    409,
                    "Local API key deletion already has an owner",
                    Some("paid_fallback_deletion_in_progress"),
                ));
            }
            let revision = store::revision(self.host)?;
            let created = prior_value
                .as_ref()
                .and_then(|v| v.get("created_at_ms"))
                .and_then(Value::as_i64)
                .unwrap_or(now);
            let guard = if local {
                json!({"created_at_ms":created,"local_deletion":{"owner":store::revision(self.host)?,"completed_at_ms":null}})
            } else {
                json!({"created_at_ms":created})
            };
            if !commit(
                self.store,
                vec![check(&dk, prior.as_ref()), check(&id_key, id_row.as_ref())],
                vec![put(dk.clone(), &guard, None, &revision)?],
            )
            .await?
            {
                return Err(conflict("API key deletion was claimed concurrently"));
            }
            self.store
                .read(&dk)
                .await?
                .filter(|r| r.revision == revision)
                .ok_or_else(|| store::corrupt("Paid deletion guard changed after claim"))?
        };
        let guard_check = check(&dk, Some(&guard));
        let result = async {
            let gate_key = keys::paid_gate();
            let gate_row = self.store.read(&gate_key).await?;
            let gate: ReconciliationGate = store::value(gate_row.as_ref(), now)?
                .map(|v| serde_json::from_value(v).map_err(|_| outstanding()))
                .transpose()?
                .unwrap_or_default();
            if gate.pending.values().any(|p| p.key_id.0 == id) {
                return Err(outstanding());
            }
            let pending = store::scan(
                self.store,
                store::key(json!(["uos_ai", "paid_fallback", "v3", "pending", id])),
                false,
                now,
            )
            .await?;
            if !pending.is_empty() {
                return Err(outstanding());
            }
            let attempts = store::scan(
                self.store,
                store::key(json!(["uos_ai", "paid_fallback", "v3", "request", id])),
                false,
                now,
            )
            .await?;
            let windows = store::scan(
                self.store,
                store::key(json!(["uos_ai", "paid_fallback", "v3", "window", id])),
                false,
                now,
            )
            .await?;
            for entry in &attempts {
                let row: PaidAttempt = serde_json::from_value(entry.record.json_value()?.clone())
                    .map_err(|_| outstanding())?;
                if row.v != 3
                    || row.reservation.key_id.0 != id
                    || entry.key != keys::paid_attempt(id, &row.reservation.attempt_id.0)
                    || matches!(
                        row.billing_state,
                        BillingState::Pending | BillingState::Unresolved
                    )
                {
                    return Err(outstanding());
                }
            }
            for entry in &windows {
                let row: PaidWindow = serde_json::from_value(entry.record.json_value()?.clone())
                    .map_err(|_| outstanding())?;
                if row.v != 3
                    || row.key_id.0 != id
                    || entry.key != keys::paid_window(id, row.window_reset_at_ms)
                    || row.pending_count != 0
                    || row.reserved_microcredits != 0
                    || row.settled_microcredits < 0
                {
                    return Err(outstanding());
                }
            }
            // Every removed row is observed and fenced in its own bounded authority commit.
            // The retained guard blocks new paid admissions throughout cleanup and the key CAS.
            for entry in attempts.into_iter().chain(windows) {
                if !commit(
                    self.store,
                    vec![guard_check.clone(), check(&entry.key, Some(&entry.record))],
                    vec![RecordMutation::Delete { key: entry.key }],
                )
                .await?
                {
                    return Err(conflict(
                        "Paid fallback state changed during deletion; retry",
                    ));
                }
            }
            let lease_key = keys::paid_lease(id);
            let lease = self.store.read(&lease_key).await?;
            if lease.is_some()
                && !commit(
                    self.store,
                    vec![guard_check.clone(), check(&lease_key, lease.as_ref())],
                    vec![RecordMutation::Delete {
                        key: lease_key.clone(),
                    }],
                )
                .await?
            {
                return Err(conflict(
                    "Paid reconciliation lease changed during deletion",
                ));
            }
            Ok(vec![
                guard_check.clone(),
                check(&gate_key, gate_row.as_ref()),
                RevisionCheck {
                    key: lease_key,
                    expected_revision: None,
                },
            ])
        }
        .await;
        if result.is_err() && local {
            self.abort_deletion(id, std::slice::from_ref(&guard_check))
                .await?;
        }
        result
    }
    /// After the same key/hash/policy/audit CAS deletes the key, remove only source-owned history.
    pub async fn finish_deletion(
        &self,
        id: &str,
        prepared: &[RevisionCheck],
    ) -> Result<(), GatewayError> {
        let guard = self.deletion_fence(id, prepared).await?;
        let id_key = gateway_auth::api_keys::id_key(id);
        if self.store.read(&id_key).await?.is_some() {
            return Err(conflict("API key deletion ownership changed"));
        }
        for parts in [
            json!(["ubq_ai", "api_keys", "usage", id]),
            json!(["ubq_ai", "api_keys", "usage_daily", id]),
        ] {
            let key = store::key(parts);
            let row = self.store.read(&key).await?;
            if row.is_some()
                && !commit(
                    self.store,
                    vec![
                        guard.clone(),
                        check(&id_key, None),
                        check(&key, row.as_ref()),
                    ],
                    vec![RecordMutation::Delete { key }],
                )
                .await?
            {
                return Err(conflict("API key cleanup changed concurrently"));
            }
        }
        for prefix in [
            json!(["uos_ai", "paid_fallback", "ledger", id]),
            json!(["ubq_ai", "api_keys", "request_log", id]),
            json!(["uos_ai", "api_key_usage", "v2", id]),
            json!(["uos_ai", "api_key_usage", "v3", "window", id]),
            json!(["uos_ai", "api_key_usage", "v3", "request", id]),
        ] {
            self.delete_history_prefix(id, store::key(prefix), &guard)
                .await?;
        }
        if id == "local-development" {
            let key = keys::paid_deletion(id);
            let row = self.store.read(&key).await?;
            let mut value = store::value(row.as_ref(), self.host.now_ms())?
                .ok_or_else(|| conflict("Local API key deletion ownership changed"))?;
            if row.as_ref().map(|r| &r.revision) != guard.expected_revision.as_ref()
                || value
                    .get("local_deletion")
                    .and_then(|v| v.get("owner"))
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
            {
                return Err(conflict("Local API key deletion ownership changed"));
            }
            value["local_deletion"]["completed_at_ms"] = json!(self.host.now_ms());
            if !commit(
                self.store,
                vec![guard, check(&id_key, None)],
                vec![put(key, &value, None, &store::revision(self.host)?)?],
            )
            .await?
            {
                return Err(conflict("Local API key deletion ownership changed"));
            }
        }
        Ok(())
    }
    /// A known refusal before ID deletion releases only the local-development owner marker.
    pub async fn abort_deletion(
        &self,
        id: &str,
        prepared: &[RevisionCheck],
    ) -> Result<(), GatewayError> {
        if id != "local-development" {
            return Ok(());
        }
        let guard = self.deletion_fence(id, prepared).await?;
        let id_key = gateway_auth::api_keys::id_key(id);
        let id_row = self.store.read(&id_key).await?;
        let Some(key_value) =
            gateway_admin::keys::current_record(&id_key, id_row.as_ref(), self.host.now_ms())?
        else {
            return Ok(());
        };
        if key_value.policy.revoked_at_ms.is_none() {
            return Ok(());
        }
        let key = keys::paid_deletion(id);
        let row = self.store.read(&key).await?;
        let mut value = store::value(row.as_ref(), self.host.now_ms())?
            .ok_or_else(|| conflict("Local deletion guard changed"))?;
        value["local_deletion"] = json!({"owner":null,"completed_at_ms":null});
        if !commit(
            self.store,
            vec![guard, check(&id_key, id_row.as_ref())],
            vec![put(key, &value, None, &store::revision(self.host)?)?],
        )
        .await?
        {
            return Err(conflict("Local deletion guard changed"));
        }
        Ok(())
    }
    async fn deletion_fence(
        &self,
        id: &str,
        prepared: &[RevisionCheck],
    ) -> Result<RevisionCheck, GatewayError> {
        let key = keys::paid_deletion(id);
        let guard = prepared
            .iter()
            .find(|check| {
                check.key == key
                    && check
                        .expected_revision
                        .as_ref()
                        .is_some_and(|r| !r.is_empty())
            })
            .ok_or_else(|| {
                store::corrupt("Paid deletion requires its exact claimed guard revision")
            })?;
        let row = self.store.read(&key).await?;
        if row.as_ref().map(|row| &row.revision) != guard.expected_revision.as_ref() {
            return Err(conflict("API key deletion ownership changed"));
        }
        Ok(guard.clone())
    }
    async fn delete_history_prefix(
        &self,
        id: &str,
        prefix: gateway_core::state::RecordKey,
        guard: &RevisionCheck,
    ) -> Result<(), GatewayError> {
        use gateway_core::query::{QueryRequest, QuerySelector};
        let mut cursor = None;
        let mut seen = BTreeSet::new();
        loop {
            let request = QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix: prefix.clone(),
                    start: None,
                    end: None,
                },
                reverse: false,
                limit: 200,
                cursor: cursor.clone(),
                now_ms: self.host.now_ms(),
            };
            let valid = request.validate()?;
            let page = self.store.query(request).await?;
            for entry in page.entries {
                if !valid.accepts_record(&entry.key, &entry.record)? {
                    return Err(store::corrupt(
                        "API key cleanup query returned an unrelated row",
                    ));
                }
                if !commit(
                    self.store,
                    vec![
                        guard.clone(),
                        check(&gateway_auth::api_keys::id_key(id), None),
                        check(&entry.key, Some(&entry.record)),
                    ],
                    vec![RecordMutation::Delete { key: entry.key }],
                )
                .await?
                {
                    return Err(conflict("API key cleanup changed concurrently"));
                }
            }
            match page.next_cursor {
                Some(next) if seen.insert(next.clone()) => cursor = Some(next),
                Some(_) => return Err(store::corrupt("API key cleanup repeated its cursor")),
                None => return Ok(()),
            }
        }
    }
}
