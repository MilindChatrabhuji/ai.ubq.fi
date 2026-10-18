use crate::{
    AdminRuntime,
    capabilities::{Context, RuntimeCapabilities},
    store,
};
use gateway_admin::{AdminInput, AdminOperation};
use gateway_auth::{
    AuthHost, AuthResponse, conflict, invalid,
    store::{check, commit, put},
};
use gateway_core::{GatewayError, query::QueryStore};
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
    let set: BTreeSet<_> = ids.iter().map(|s| s.trim()).collect();
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

fn principal_ids(value: &Value) -> Result<Vec<String>, GatewayError> {
    let values = value
        .as_array()
        .filter(|v| v.len() <= 1000)
        .ok_or_else(|| invalid("allowed_key_ids must be an explicit array of principal IDs"))?;
    let mut ids = BTreeSet::new();
    for value in values {
        let id = value
            .as_str()
            .filter(|s| {
                !s.trim().is_empty()
                    && s.encode_utf16().count() <= 256
                    && !s
                        .chars()
                        .any(|c| c.is_whitespace() || c == ',' || (c as u32) < 32 || c == '\x7f')
            })
            .ok_or_else(|| invalid("allowed_key_ids must be an explicit array of principal IDs"))?;
        ids.insert(id.to_owned());
    }
    Ok(ids.into_iter().collect())
}

impl<S: QueryStore, H: AuthHost, C: RuntimeCapabilities> AdminRuntime<'_, S, H, C> {
    fn sorted_principals(&self,value:&Value)->Result<Vec<String>,GatewayError>{
        let mut ids=principal_ids(value)?;let mut error=None;
        ids.sort_by(|a,b|match self.capabilities.compare_admin_labels(a,b){Ok(order)=>order,Err(failure)=>{error=Some(failure);std::cmp::Ordering::Equal}});
        if let Some(error)=error{return Err(error)}Ok(ids)
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
                    let scenario = v.get("scenario")?.as_str()?.trim();
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
            ("normal", 0)
        } else {
            let scenario = input
                .body
                .get("scenario")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("scenario is required"))?;
            let duration = match input.body.get("duration_ms") {
                None => 900000,
                Some(Value::Null) => 0,
                Some(Value::Bool(v)) => i64::from(*v),
                Some(Value::String(s)) if s.trim().is_empty() => 0,
                Some(value) => {
                    let n = if let Some(s) = value.as_str() {
                        s.trim().parse::<f64>().ok()
                    } else {
                        value.as_f64()
                    }
                    .ok_or_else(|| invalid("duration_ms must be between 0 and 3600000"))?;
                    if !n.is_finite() || n.fract() != 0.0 || !(0.0..=3600000.0).contains(&n) {
                        return Err(invalid("duration_ms must be between 0 and 3600000"));
                    }
                    n as i64
                }
            };
            (scenario, duration)
        };
        if !SCENARIOS.contains(&scenario) {
            return Err(invalid("Unknown debug routing scenario"));
        }
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
        let raw = input
            .body
            .get("provider_ids")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("provider_ids must be an array"))?;
        let ids: Vec<String> = raw
            .iter()
            .map(|v| {
                v.as_str()
                    .map(|s| s.trim().to_owned())
                    .ok_or_else(|| invalid("provider_ids must contain only strings"))
            })
            .collect::<Result<_, _>>()?;
        let unknown: Vec<_> = ids
            .iter()
            .filter(|id| !provider_id(id))
            .map(String::as_str)
            .collect();
        if !unknown.is_empty() {
            return Err(invalid(&format!(
                "unknown provider ids: {}",
                unknown.join(", ")
            )));
        }
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
            let ids = self.sorted_principals(input.body.get("allowed_key_ids").unwrap_or(&Value::Null))?;
            let policy =
                json!({"v":1,"source":"kv","allowed_key_ids":ids,"updated_at_ms":input.now_ms});
            let row = self.store.read(&key).await?;
            if !commit(
                self.store,
                vec![check(&key, row.as_ref())],
                vec![put(
                    key.clone(),
                    &policy,
                    None,
                    &store::revision(self.host)?,
                )?],
            )
            .await?
            {
                return Err(conflict("Claude principal policy changed concurrently"));
            }
            policy
        } else {
            let mut found = None;
            for _ in 0..8 {
                let row = self.store.read(&key).await?;
                if let Some(value) = store::value(row.as_ref(), input.now_ms)? {
                    if value.get("v") != Some(&json!(1))
                        || ![Some("env"), Some("kv")]
                            .contains(&value.get("source").and_then(Value::as_str))
                        || value
                            .get("updated_at_ms")
                            .and_then(Value::as_i64)
                            .is_none_or(|n| n <= 0)
                    {
                        return Err(store::corrupt(
                            "Claude principal policy is invalid; refusing environment fallback",
                        ));
                    }
                    let ids = self.sorted_principals(value.get("allowed_key_ids").unwrap_or(&Value::Null))
                        .map_err(|_| {
                        store::corrupt(
                            "Claude principal policy is invalid; refusing environment fallback",
                        )
                    })?;
                    found = Some(
                        json!({"v":1,"source":value["source"],"allowed_key_ids":ids,"updated_at_ms":value["updated_at_ms"]}),
                    );
                    break;
                }
                let ids = self.sorted_principals(&json!(self.config.claude_allowed_key_ids))?;
                let policy = json!({"v":1,"source":"env","allowed_key_ids":ids,"updated_at_ms":input.now_ms});
                if commit(
                    self.store,
                    vec![check(&key, row.as_ref())],
                    vec![put(
                        key.clone(),
                        &policy,
                        None,
                        &store::revision(self.host)?,
                    )?],
                )
                .await?
                {
                    found = Some(policy);
                    break;
                }
            }
            found.ok_or_else(|| conflict("Claude principal policy changed repeatedly"))?
        };
        Ok(AuthResponse::json(
            200,
            json!({"data":{"source":policy["source"],"allowed_key_ids":policy["allowed_key_ids"],"updated_at_ms":policy["updated_at_ms"]}}),
        ))
    }
}
