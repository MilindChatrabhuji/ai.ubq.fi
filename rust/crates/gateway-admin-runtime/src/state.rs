use crate::{
    AdminRuntime,
    capabilities::{Context, RuntimeCapabilities},
    store,
};
use gateway_admin::{AdminInput, AdminOperation, source_input as source_body};
use gateway_auth::{
    AuthHost, AuthResponse, conflict, invalid,
    store::{check, commit, put},
};
use gateway_core::{GatewayError, query::QueryStore};
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub const PROVIDER_IDS: [&str; 9] = [
    "codex",
    "claude_code",
    "surplus",
    "openlux",
    "deepseek",
    "cerebras",
    "lithos",
    "openrouter",
    "ubiquity",
];
fn subscription(id: &str) -> bool {
    id.strip_prefix("codex:").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn provider_id(id: &str) -> bool {
    PROVIDER_IDS.contains(&id) || subscription(id)
}
fn normalize_ids(ids: &[String]) -> Vec<String> {
    let set: BTreeSet<_> = ids
        .iter()
        .map(|s| s.trim_matches(gateway_schema::util::js_whitespace))
        .collect();
    let mut result: Vec<String> = PROVIDER_IDS
        .into_iter()
        .filter(|s| set.contains(s))
        .map(str::to_owned)
        .collect();
    if !set.contains("codex") {
        result.extend(
            set.into_iter()
                .filter(|s| subscription(s))
                .map(str::to_owned),
        );
    }
    result
}
fn selection(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let ids: Vec<String> = value
        .get("provider_ids")?
        .as_array()?
        .iter()
        .map(|s| s.as_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    let time = value
        .get("updated_at_ms")?
        .as_i64()
        .filter(|n| *n > 0 && *n <= gateway_core::identity::MAX_SAFE_INTEGER)?;
    Some(json!({"provider_ids":normalize_ids(&ids),"updated_at_ms":time}))
}

impl<S: QueryStore, H: AuthHost, C: RuntimeCapabilities> AdminRuntime<'_, S, H, C> {
    fn sorted_principals(&self, value: &SourceJson) -> Result<Vec<JsString16>, GatewayError> {
        crate::claude_access::parse_source_ids(value, &|a, b| {
            self.capabilities.compare_admin_labels(a, b)
        })
    }
    pub(crate) async fn debug(
        &self,
        operation: AdminOperation,
        input: &AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        let key = store::key(json!(["uos_ai", "debug_routing", "v1"]));
        let normal =
            || json!({"scenario":"normal","expires_at_ms":null,"updated_at_ms":input.now_ms});
        const SCENARIOS: [&str; 7] = [
            "normal",
            "metered_first",
            "removed_provider_first",
            "codex_401",
            "codex_403",
            "codex_429",
            "codex_503",
        ];
        if operation == AdminOperation::DebugGet {
            // Source deliberately falls back to normal for invalid/expired/unreadable debug state.
            let value = store::read(self.store, &key, input.now_ms)
                .await
                .ok()
                .flatten()
                .and_then(|v| {
                    let scenario = v
                        .get("scenario")?
                        .as_str()?
                        .trim_matches(gateway_schema::util::js_whitespace);
                    let updated = v.get("updated_at_ms")?.as_i64().filter(|n| *n > 0)?;
                    if !SCENARIOS.contains(&scenario) {
                        return None;
                    }
                    let expiry = v
                        .get("expires_at_ms")
                        .and_then(Value::as_i64)
                        .filter(|n| *n > 0);
                    if expiry.is_some_and(|n| n <= input.now_ms) {
                        return None;
                    }
                    Some(
                        json!({"scenario":scenario,"expires_at_ms":expiry,"updated_at_ms":updated}),
                    )
                })
                .unwrap_or_else(normal);
            return Ok(AuthResponse::json(200, json!({"routing":value})));
        }
        let (scenario, duration) = if operation == AdminOperation::DebugDelete {
            (JsString16::from_utf8("normal"), 0)
        } else {
            let scenario =
                crate::parse::source_text(source_body::member(&input.body, "scenario").as_ref())
                    .ok_or_else(|| invalid("scenario is required"))?;
            let duration = match source_body::member(&input.body, "duration_ms") {
                None => 900000,
                Some(value) => {
                    let n = crate::parse::source_coerced_number(&value);
                    if !n.is_finite() || n.fract() != 0.0 || !(0.0..=3600000.0).contains(&n) {
                        return Err(invalid("duration_ms must be between 0 and 3600000"));
                    }
                    n as i64
                }
            };
            (scenario, duration)
        };
        let scenario = SCENARIOS
            .into_iter()
            .find(|candidate| {
                scenario
                    .as_units()
                    .iter()
                    .copied()
                    .eq(candidate.encode_utf16())
            })
            .ok_or_else(|| invalid("Unknown debug routing scenario"))?;
        let value = json!({"scenario":scenario,"expires_at_ms":if scenario=="normal"||duration==0 {None}else{Some(input.now_ms+duration)},"updated_at_ms":input.now_ms});
        let row = self.store.read(&key).await?;
        if !commit(
            self.store,
            vec![check(&key, row.as_ref())],
            vec![put(
                key,
                &value,
                Some(input.now_ms + 3900000),
                &store::revision(self.host)?,
            )?],
        )
        .await?
        {
            return Err(conflict("Debug routing changed concurrently; retry"));
        }
        Ok(AuthResponse::json(200, json!({"routing":value})))
    }
    pub(crate) async fn selection(
        &self,
        operation: AdminOperation,
        input: &AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        let key = store::key(json!(["uos_ai", "provider_selection", "v1"]));
        if operation == AdminOperation::ProviderSelectionGet {
            let selected = selection(store::read(self.store, &key, input.now_ms).await?.as_ref())
                .unwrap_or_else(|| json!({"provider_ids":[],"updated_at_ms":0}));
            let mut data = self
                .capabilities
                .provider_picker(Context {
                    request_id: input.request_id.clone(),
                    now_ms: input.now_ms,
                })
                .await?;
            if !data.is_object()
                || !data.get("providers").is_some_and(Value::is_array)
                || !data.get("tiers").is_some_and(Value::is_array)
            {
                return Err(store::corrupt("Provider picker metadata is invalid"));
            }
            data["filter_active"] = json!(
                selected["provider_ids"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty())
            );
            data["selection"] = selected;
            return Ok(AuthResponse::json(200, json!({"data":data})));
        }
        let raw = source_body::member(&input.body, "provider_ids")
            .and_then(|value| value.array_items().ok())
            .ok_or_else(|| invalid("provider_ids must be an array"))?;
        let ids = raw
            .iter()
            .map(|value| {
                source_body::text(value)
                    .map(|text| source_body::trim(&text))
                    .ok_or_else(|| invalid("provider_ids must contain only strings"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let unknown = ids
            .iter()
            .filter(|id| id.try_utf8().ok().is_none_or(|text| !provider_id(&text)))
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            let mut units = "unknown provider ids: ".encode_utf16().collect::<Vec<_>>();
            for (index, id) in unknown.iter().enumerate() {
                if index > 0 {
                    units.extend(", ".encode_utf16());
                }
                units.extend_from_slice(id.as_units());
            }
            let message = JsString16::from_units(units);
            if let Ok(message) = message.try_utf8() {
                return Err(invalid(&message));
            }
            let error = gateway_schema::source_request::SourceRequestError::new(
                400,
                message,
                "invalid_request_error",
                Some("invalid_request_error"),
                None,
            );
            return Ok(AuthResponse::source_json(
                error.status,
                error.body().clone(),
            ));
        }
        // Every accepted provider label has the independently closed ASCII
        // roster/hash grammar above; only that proven field becomes scalar.
        let ids = ids
            .iter()
            .map(|id| id.try_utf8().expect("validated closed provider label"))
            .collect::<Vec<_>>();
        let ids = normalize_ids(&ids);
        let selected = json!({"provider_ids":ids,"updated_at_ms":input.now_ms});
        let row = self.store.read(&key).await?;
        if !commit(
            self.store,
            vec![check(&key, row.as_ref())],
            vec![put(key, &selected, None, &store::revision(self.host)?)?],
        )
        .await?
        {
            return Err(conflict("Provider selection changed concurrently; retry"));
        }
        Ok(AuthResponse::json(
            200,
            json!({"stored":true,"provider_ids":ids,"updated_at_ms":input.now_ms}),
        ))
    }
    pub(crate) async fn claude_access(
        &self,
        operation: AdminOperation,
        input: &AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        let key = store::key(json!(["uos_ai", "claude_code_access", "v1"]));
        let policy = if operation == AdminOperation::ClaudeAccessSet {
            let ids = self.sorted_principals(
                &source_body::member(&input.body, "allowed_key_ids")
                    .unwrap_or_else(|| source_body::json(&())),
            )?;
            let policy = crate::claude_access::ClaudeAccessPolicy {
                v: 1,
                source: crate::claude_access::PolicySource::Kv,
                allowed_key_ids: ids,
                updated_at_ms: input.now_ms,
            };
            let row = self.store.read(&key).await?;
            if !commit(
                self.store,
                vec![check(&key, row.as_ref())],
                vec![gateway_core::state::RecordMutation::Put {
                    key: key.clone(),
                    record: crate::claude_access::encode_policy_record(
                        &store::revision(self.host)?,
                        &policy,
                        None,
                    )?,
                }],
            )
            .await?
            {
                return Err(conflict("Claude principal policy changed concurrently"));
            }
            policy
        } else {
            crate::claude_access::load_policy(
                self.store,
                self.host,
                &self.config.claude_allowed_key_ids,
                &|a, b| self.capabilities.compare_admin_labels(a, b),
            )
            .await?
            .policy
        };
        Ok(AuthResponse::source_json(
            200,
            source_body::object(vec![(
                "data",
                source_body::object(vec![
                    ("source", source_body::json(&policy.source)),
                    (
                        "allowed_key_ids",
                        source_body::json(&policy.allowed_key_ids),
                    ),
                    ("updated_at_ms", source_body::json(&policy.updated_at_ms)),
                ]),
            )]),
        ))
    }
}
