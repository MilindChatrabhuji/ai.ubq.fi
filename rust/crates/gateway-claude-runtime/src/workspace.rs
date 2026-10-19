use crate::{ClaudePoolSession, host::*, persistence};
use gateway_admin_runtime::claude::{self, AccountUpdate, Workspace};
use gateway_core::{
    GatewayError, js_string::JsString16, js_string_case::lowercase_source, source_json::SourceJson,
    source_serialization as source, state::AuthorityStore,
};
use gateway_schema::reasoning::js_trim_source;

pub(crate) async fn discover<S: AuthorityStore, H: ClaudePoolHost>(
    session: &ClaudePoolSession,
    store: &S,
    host: &H,
    selected: &SelectedAccount,
) -> Result<Option<SelectedAccount>, GatewayError> {
    if selected.disabled || selected.binding.workspace.is_some() {
        return Ok(None);
    }
    if !gateway_catalog_runtime::state::checks_current(store, &selected.native_checks).await? {
        return Ok(None);
    }
    if claude::current_binding(store, &selected.binding, persistence::now(host)?)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    if session
        .access(store, host, &selected.key_id)
        .await?
        .is_none()
    {
        return Err(GatewayError::new(
            403,
            "The principal is no longer allowed to use the Claude subscription.",
            Some("claude_code_request_invalid"),
        ));
    }
    let response = match host.workspace_list(&selected.binding).await {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };
    if !(200..300).contains(&response.status) {
        return Ok(None);
    }
    let parsed = SourceJson::parse(&response.body).ok();
    let mut workspaces = parsed
        .as_ref()
        .and_then(|value| source::member(value, "data"))
        .as_ref()
        .and_then(source::array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let id = js_trim_source(&source::string(&source::member(&row, "id")?)?);
            if !id
                .as_units()
                .iter()
                .copied()
                .take(7)
                .eq("wrkspc_".encode_utf16())
                || source::member(&row, "archived_at").is_some_and(|v| v.as_str() != "null")
            {
                return None;
            }
            let name = source::member(&row, "name")
                .as_ref()
                .and_then(source::string)
                .map(|name| js_trim_source(&name))
                .filter(|name| !name.as_units().is_empty());
            Some((id, name))
        })
        .collect::<Vec<_>>();
    let index = workspaces
        .iter()
        .position(|(_, name)| {
            name.as_ref()
                .is_some_and(|name| lowercase_source(name) == JsString16::from_utf8("default"))
        })
        .unwrap_or(0);
    if workspaces.is_empty() {
        return Ok(None);
    }
    let (id, name) = workspaces.remove(index);
    if claude::current_binding(store, &selected.binding, persistence::now(host)?)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    if !gateway_catalog_runtime::state::checks_current(store, &selected.native_checks).await? {
        return Ok(None);
    }
    if session
        .access(store, host, &selected.key_id)
        .await?
        .is_none()
    {
        return Err(GatewayError::new(
            403,
            "The principal is no longer allowed to use the Claude subscription.",
            Some("claude_code_request_invalid"),
        ));
    }
    let now = persistence::now(host)?;
    let old = claude::read_roster(store, now)
        .await?
        .and_then(|r| claude::active_binding(&r.roster).and_then(|a| a.workspace.clone()));
    let same = old.as_ref().filter(|w| w.id == id);
    let workspace = Workspace {
        id,
        name: name.or_else(|| same.and_then(|w| w.name.clone())),
        source: "discovered".into(),
        discovered_at_ms: Some(now),
        verified_at_ms: same.and_then(|w| w.verified_at_ms),
        last_error: None,
    };
    let binding = match claude::update_account(
        store,
        host,
        &session.config.bootstrap,
        &AccountUpdate {
            account_id: Some(selected.binding.account_id.clone()),
            create_new: false,
            credential: None,
            workspace: Some(Some(workspace)),
            activate: false,
            expected: Some(selected.binding.clone()),
        },
    )
    .await
    {
        Ok(binding) => binding,
        Err(_) => return Ok(None),
    };
    let input = SelectionInput {
        key_id: &selected.key_id,
        model: &selected.model,
        raw: &selected.raw,
        effective_effort: selected.effective_effort.clone(),
        selection: None,
    };
    // Source exception: retain the already encoded non-disabled request; no new
    // workspace catalog fetch and no second original admission/dispatch claim.
    let next = session
        .prepare(
            store,
            host,
            binding,
            session.config.generation.snapshot(),
            &input,
            Some(selected),
        )
        .await?;
    Ok(Some(next))
}
