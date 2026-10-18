//! Already-authorized finite admin operations; account/quota policy stays in m12/m21.
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformHost, response_bytes},
    transport::{
        body::discard_response,
        outbound::{Cancellation, PinnedDestination, send_http},
    },
};
use gateway_admin_runtime::{
    capabilities::{ClaudeRequest, ClaudeSubmission, Context},
    claude::{self, AccountBinding, AccountUpdate, Credential, Workspace},
};
use gateway_auth::{AuthHost, AuthResponse, AuthResponseBody};
use gateway_core::{GatewayError, source_json::SourceJson};
use gateway_observability::{ObservabilityHost, ObservabilityRuntime};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const UNVALIDATED: &str = "Stored unvalidated: the models listing could not be read.";
struct Validation {
    status: Option<u16>,
    detail: Option<&'static str>,
    snapshot: Option<(Vec<Value>, i64)>,
}
impl Validation {
    fn unavailable(status: Option<u16>) -> Self {
        Self {
            status,
            detail: (status != Some(429)).then_some(UNVALIDATED),
            snapshot: None,
        }
    }
}

pub async fn admin<H: ObservabilityHost>(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    observations: &ObservabilityRuntime<RemoteAuthorityStore, H>,
    request: ClaudeRequest,
    context: Context,
) -> Result<AuthResponse, GatewayError> {
    match request {
        ClaudeRequest::State => response(observations, context).await,
        ClaudeRequest::SelectAccount { account_id } => {
            if !claude::select_account(store, platform, &account_id, None).await? {
                return Err(not_found());
            }
            response(observations, context).await
        }
        ClaudeRequest::DeleteAccount { account_id } => {
            let account = target(
                store,
                platform,
                account_id.as_deref().filter(|id| !id.is_empty()),
            )
            .await?;
            let Some(account) = account else {
                return if account_id.as_ref().is_some_and(|id| !id.is_empty()) {
                    Err(not_found())
                } else {
                    response(observations, context).await
                };
            };
            let _removed = claude::remove_account(
                store,
                platform,
                &claude::Bootstrap::default(),
                Some(&account.account_id),
            )
            .await?;
            // This source endpoint directly removes an account; it is not the legacy clear wrapper.
            response(observations, context).await
        }
        ClaudeRequest::ClearQuota {
            account_id,
            cohort_id,
        } => {
            let account = target(
                store,
                platform,
                account_id.as_deref().filter(|id| !id.is_empty()),
            )
            .await?;
            let Some(account) = account else {
                if account_id.as_ref().is_some_and(|id| !id.is_empty()) {
                    return Err(not_found());
                }
                return cleared_response(observations, context, false).await;
            };
            if account_id.as_ref().is_some_and(|id| !id.is_empty()) && cohort_id.is_none() {
                return Err(gateway_auth::invalid(
                    "account_cohort_id is required for a targeted clear",
                ));
            }
            if cohort_id
                .as_ref()
                .is_some_and(|id| *id != account.account_cohort_id)
            {
                return Err(changed("Claude account generation changed"));
            }
            let host = super::platform::Host {
                store: store.clone(),
                platform: platform.clone(),
            };
            if gateway_claude_runtime::clear_guards(store, &host, &account)
                .await?
                .is_none()
            {
                return Err(changed("Claude guards changed during clear"));
            }
            cleared_response(observations, context, true).await
        }
        ClaudeRequest::SetCredential(input) => {
            submit(store, platform, observations, input, context).await
        }
    }
}

async fn target(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    id: Option<&str>,
) -> Result<Option<AccountBinding>, GatewayError> {
    let seed = super::platform::bootstrap_for_source(store, platform).await?;
    let roster = claude::load_roster(store, platform, &seed).await?;
    Ok(match id {
        Some(id) => roster
            .roster
            .accounts
            .into_iter()
            .find(|account| account.account_id == id),
        None => claude::active_binding(&roster.roster).cloned(),
    })
}

async fn submit<H: ObservabilityHost>(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    observations: &ObservabilityRuntime<RemoteAuthorityStore, H>,
    input: ClaudeSubmission,
    context: Context,
) -> Result<AuthResponse, GatewayError> {
    let old = if input.create_new {
        None
    } else {
        target(store, platform, input.account_id.as_deref())
            .await
            .map_err(|error| gateway_auth::invalid(&error.envelope.error.message))?
    };
    if input.account_id.is_some() && old.is_none() {
        return Err(gateway_auth::invalid("Claude account was not found"));
    }
    let secret = input
        .credential
        .as_ref()
        .or_else(|| old.as_ref().map(|account| &account.credential.secret))
        .ok_or_else(|| {
            GatewayError::new(
                409,
                "No Claude credential is configured to validate this workspace against",
                Some("credential_missing"),
            )
        })?;
    let mut candidate = claude::parse_credential(
        &json!({"secret":secret.expose(),"label":input.label,"updated_at_ms":platform.now_ms()}),
        "kv",
    )
    .ok_or_else(|| gateway_auth::invalid("credential is invalid"))?;
    let workspace_id = match &input.workspace_id {
        Some(id) => id.as_deref(),
        None => old
            .as_ref()
            .and_then(|account| account.workspace.as_ref())
            .map(|workspace| workspace.id.as_str()),
    };
    let validation = validate(platform, &candidate, workspace_id).await?;
    if validation.status == Some(401) || validation.status == Some(403) {
        return Err(GatewayError::new(
            400,
            if validation.status == Some(401) {
                "The credential was rejected as unauthenticated."
            } else {
                "The credential is not permitted for this endpoint."
            },
            Some("invalid_api_key"),
        ));
    }
    candidate.updated_at_ms = Some(platform.now_ms());
    let workspace = workspace_id.map(|id| {
        submitted_workspace(
            old.as_ref().and_then(|account| account.workspace.as_ref()),
            id,
            input.workspace_id.is_some(),
            validation.status,
            platform.now_ms(),
        )
    });
    let account = claude::update_account(
        store,
        platform,
        &claude::Bootstrap::default(),
        &AccountUpdate {
            account_id: old.as_ref().map(|account| account.account_id.clone()),
            create_new: input.create_new,
            credential: input.credential.as_ref().map(|_| candidate.clone()),
            workspace: Some(workspace),
            activate: input.activate,
            expected: old,
        },
    )
    .await
    .map_err(|error| changed(&error.envelope.error.message))?;
    if let Some((models, at)) = validation.snapshot {
        let host = super::platform::Host {
            store: store.clone(),
            platform: platform.clone(),
        };
        // A changed source binding merely declines this optional cache publication.
        let _cached = super::catalog::prime(&host, &account, models, at).await;
    }
    // These are direct account operations, not source legacy generation-advance events.
    let block = block(observations, context).await?;
    #[derive(Serialize)]
    struct ValidationView {
        status: Option<u16>,
        detail: Option<&'static str>,
    }
    #[derive(Serialize)]
    struct Body<'a> {
        data: &'a SourceJson,
        account_id: &'a str,
        validation: ValidationView,
        hint: Option<&'a str>,
    }
    Ok(AuthResponse::source_json(
        200,
        SourceJson::from_serializable(&Body {
            data: &block,
            account_id: &account.account_id,
            validation: ValidationView {
                status: validation.status,
                detail: validation.detail,
            },
            hint: input.credential.as_ref().map(|_| candidate.hint.as_str()),
        })?,
    ))
}

async fn validate(
    platform: &PlatformHost,
    credential: &Credential,
    workspace: Option<&str>,
) -> Result<Validation, GatewayError> {
    let cancellation = Cancellation::background()?;
    let _deadline = cancellation.set_timeout_ms(8_000)?;
    let mut models = Vec::<Value>::new();
    let mut cursors = BTreeSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let mut url = worker::Url::parse("https://api.anthropic.com/v1/models")
            .map_err(|_| super::invalid("Claude model URL is invalid."))?;
        url.query_pairs_mut().append_pair("limit", "100");
        if let Some(cursor) = &cursor {
            url.query_pairs_mut().append_pair("after_id", cursor);
        }
        let destination = PinnedDestination::new(url.as_str())?;
        let mut response = match send_http(
            &destination,
            worker::Method::Get,
            &super::platform::credential_headers(credential, workspace),
            &[],
            &cancellation,
            || async { Ok(()) },
        )
        .await
        {
            Ok(response) => response,
            Err(_) => return Ok(Validation::unavailable(None)),
        };
        let status = response.status_code();
        if !(200..300).contains(&status) {
            discard_response(&mut response);
            return Ok(Validation::unavailable(Some(status)));
        }
        let bytes = match response_bytes(&mut response, 2 * 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(_) => return Ok(Validation::unavailable(Some(status))),
        };
        let parsed: Value = match serde_json::from_str(&String::from_utf8_lossy(&bytes)) {
            Ok(value) => value,
            Err(_) => return Ok(Validation::unavailable(Some(status))),
        };
        let (page, next) = match gateway_catalog_runtime::providers::parse_page(
            gateway_catalog_runtime::CatalogProvider::ClaudeCode,
            &parsed,
        ) {
            Ok(page) => page,
            Err(_) => return Ok(Validation::unavailable(Some(status))),
        };
        for model in page {
            if let Some(old) = models
                .iter_mut()
                .find(|old| old.get("id") == model.get("id"))
            {
                *old = model;
            } else {
                models.push(model);
            }
        }
        match next {
            None => {
                return Ok(Validation {
                    status: Some(200),
                    detail: None,
                    snapshot: Some((models, platform.now_ms())),
                });
            }
            Some(next) => {
                if !cursors.insert(next.clone()) {
                    return Ok(Validation::unavailable(Some(status)));
                }
                cursor = Some(next);
            }
        }
    }
    Ok(Validation::unavailable(None))
}

async fn block<H: ObservabilityHost>(
    observations: &ObservabilityRuntime<RemoteAuthorityStore, H>,
    context: Context,
) -> Result<SourceJson, GatewayError> {
    let response = observations
        .passive_provider_response(true, context)
        .await?;
    subscription_block(response.body)
}
fn subscription_block(body: AuthResponseBody) -> Result<SourceJson, GatewayError> {
    match body {
        AuthResponseBody::Json(value) => {
            SourceJson::from_serializable(value.get("claude_code").unwrap_or(&Value::Null))
        }
        AuthResponseBody::SourceJson(value) => Ok(value
            .object_entries()?
            .into_iter()
            .rev()
            .find(|(key, _)| {
                key.as_units()
                    .iter()
                    .copied()
                    .eq("claude_code".encode_utf16())
            })
            .map(|(_, value)| value)
            .unwrap_or(SourceJson::parse("null")?)),
    }
}
fn submitted_workspace(
    previous: Option<&Workspace>,
    id: &str,
    requested: bool,
    status: Option<u16>,
    at: i64,
) -> Workspace {
    let previous = previous.filter(|workspace| workspace.id == id);
    let source = if requested {
        "kv".into()
    } else {
        previous
            .map(|workspace| workspace.source.clone())
            .unwrap_or_else(|| "kv".into())
    };
    Workspace {
        id: id.into(),
        name: previous.and_then(|workspace| workspace.name.clone()),
        discovered_at_ms: if source == "discovered" {
            Some(at)
        } else {
            previous.and_then(|workspace| workspace.discovered_at_ms)
        },
        verified_at_ms: if status == Some(200) {
            Some(at)
        } else {
            previous.and_then(|workspace| workspace.verified_at_ms)
        },
        source,
        last_error: None,
    }
}
async fn response<H: ObservabilityHost>(
    observations: &ObservabilityRuntime<RemoteAuthorityStore, H>,
    context: Context,
) -> Result<AuthResponse, GatewayError> {
    #[derive(Serialize)]
    struct Body {
        data: SourceJson,
    }
    Ok(AuthResponse::source_json(
        200,
        SourceJson::from_serializable(&Body {
            data: block(observations, context).await?,
        })?,
    ))
}
async fn cleared_response<H: ObservabilityHost>(
    observations: &ObservabilityRuntime<RemoteAuthorityStore, H>,
    context: Context,
    cleared: bool,
) -> Result<AuthResponse, GatewayError> {
    #[derive(Serialize)]
    struct Body {
        data: SourceJson,
        guards_cleared: bool,
    }
    Ok(AuthResponse::source_json(
        200,
        SourceJson::from_serializable(&Body {
            data: block(observations, context).await?,
            guards_cleared: cleared,
        })?,
    ))
}
fn not_found() -> GatewayError {
    GatewayError::new(404, "Claude account was not found", Some("not_found"))
}
fn changed(message: &str) -> GatewayError {
    GatewayError::new(409, message, Some("claude_code_account_changed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_readback_preserves_both_unpaired_utf16_directions_in_raw_quota() {
        let raw = r#"{"claude_code":{"accounts":[{"quota":{"last_error":{"message":"high\ud800"}}}],"quota":{"last_error":{"message":"low\udfff"}}}}"#;
        assert!(serde_json::from_str::<Value>(raw).is_err());
        let block = subscription_block(AuthResponseBody::SourceJson(
            SourceJson::parse(raw).unwrap(),
        ))
        .unwrap();
        let body =
            SourceJson::from_serializable(&std::collections::BTreeMap::from([("data", block)]))
                .unwrap();
        let response = AuthResponse::source_json(200, body);
        assert_eq!(response.headers["cache-control"], "no-store");
        let bytes = response.body.to_bytes().unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains(r#""message":"high\ud800""#));
        assert!(text.contains(r#""message":"low\udfff""#));
        assert!(!text.contains(r#"\\ud800"#));
    }

    #[test]
    fn state_readback_uses_the_last_source_property_and_missing_block_is_null() {
        let body = SourceJson::parse(
            r#"{"claude_code":{"configured":false},"claude_code":{"configured":true}}"#,
        )
        .unwrap();
        assert_eq!(
            subscription_block(AuthResponseBody::SourceJson(body))
                .unwrap()
                .as_str(),
            r#"{"configured":true}"#
        );
        assert_eq!(
            subscription_block(AuthResponseBody::Json(json!({})))
                .unwrap()
                .as_str(),
            "null"
        );
    }

    #[test]
    fn source_workspace_merge_preserves_or_replaces_generation_timestamps() {
        let previous = Workspace {
            id: "wrkspc_old".into(),
            name: Some("Existing".into()),
            source: "discovered".into(),
            discovered_at_ms: Some(100),
            verified_at_ms: Some(120),
            last_error: Some("old error".into()),
        };
        let inherited = submitted_workspace(Some(&previous), "wrkspc_old", false, Some(429), 500);
        assert_eq!(
            (
                inherited.source.as_str(),
                inherited.discovered_at_ms,
                inherited.verified_at_ms,
                inherited.last_error
            ),
            ("discovered", Some(500), Some(120), None)
        );
        let explicit = submitted_workspace(Some(&previous), "wrkspc_old", true, Some(200), 500);
        assert_eq!(
            (
                explicit.source.as_str(),
                explicit.discovered_at_ms,
                explicit.verified_at_ms
            ),
            ("kv", Some(100), Some(500))
        );
        let replacement = submitted_workspace(Some(&previous), "wrkspc_new", true, None, 500);
        assert_eq!(
            (
                replacement.name,
                replacement.discovered_at_ms,
                replacement.verified_at_ms
            ),
            (None, None, None)
        );
    }

    #[test]
    fn limited_validation_has_no_unvalidated_warning_and_source_errors_are_exact() {
        assert_eq!(Validation::unavailable(Some(429)).detail, None);
        assert_eq!(Validation::unavailable(None).detail, Some(UNVALIDATED));
        assert_eq!(Validation::unavailable(Some(502)).status, Some(502));
        assert_eq!(not_found().status, 404);
        let stale = changed("Claude account generation changed");
        assert_eq!(stale.status, 409);
        assert_eq!(
            stale.envelope.error.code.as_deref(),
            Some("claude_code_account_changed")
        );
    }
}
