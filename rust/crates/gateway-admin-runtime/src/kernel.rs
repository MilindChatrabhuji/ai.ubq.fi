use crate::kernel_data::{
    SourcePolicy, SourceWindow, canonical, data_put, data_read, data_value, decode_policy, expiry,
    identity_fields, limit, new_window, part, physical_labels, positive, source_truth, summary,
    summary_document, target, validate_window, window_document,
};
use crate::{AdminRuntime, capabilities::RuntimeCapabilities, parse, store};
use gateway_admin::{AdminInput, AdminOperation, source_input as body};
use gateway_auth::{
    AuthHost, AuthResponse, conflict, invalid,
    store::{check, commit, put},
};
use gateway_authority::{
    keys,
    quota::{KernelDefaults, KernelReservation, KernelTerminal},
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::QueryStore,
    source_control::decode_source_control_record,
    source_json::SourceJson,
    source_serialization as source,
    state::{RecordKey, RecordMutation, StoredRecord},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const WEEK: i64 = 604800000;
pub(crate) fn default_limit_key() -> RecordKey {
    store::key(json!(["default", "kernel_policy_limit_requests"]))
}
pub(crate) fn default_window_key() -> RecordKey {
    store::key(json!(["default", "kernel_policy_window_ms"]))
}
impl<S: QueryStore, H: AuthHost, C: RuntimeCapabilities> AdminRuntime<'_, S, H, C> {
    pub(crate) async fn kernel_defaults(&self, now: i64) -> Result<KernelDefaults, GatewayError> {
        let combined = store::read(self.store, &keys::kernel_defaults(), now).await?;
        let mut defaults: KernelDefaults = combined
            .map(|v| {
                serde_json::from_value(v)
                    .map_err(|_| store::corrupt("Kernel defaults are malformed"))
            })
            .transpose()?
            .unwrap_or_default();
        if let Some(value) = store::read(self.store, &default_limit_key(), now).await? {
            defaults.usage_limit_requests = parse::limit(&value).unwrap_or(-1)
        }
        if let Some(value) = store::read(self.store, &default_window_key(), now).await? {
            defaults.window_ms = parse::positive(&value).unwrap_or(WEEK)
        }
        if defaults.usage_limit_requests < -1 || defaults.window_ms <= 0 {
            return Err(store::corrupt("Kernel defaults are malformed"));
        }
        Ok(defaults)
    }
    /// Reconcile only this common authority window and its exact durable reservation rows.
    pub(crate) async fn kernel_window(
        &self,
        owner: &JsString16,
        repo: Option<&JsString16>,
        now: i64,
    ) -> Result<Option<SourceWindow>, GatewayError> {
        let key = keys::kernel_window_source(owner, repo)?;
        for _ in 0..3 {
            let row = self.store.read(&key).await?;
            let Some(value) = data_value(row.as_ref(), now)? else {
                return Ok(None);
            };
            let mut window = validate_window(value, owner, repo)?;
            let mut checks = vec![check(&key, row.as_ref())];
            let mut writes = Vec::new();
            let mut retained = BTreeMap::new();
            for (id, expiry) in &window.reservations {
                let scalar_owner = owner.try_utf8()?;
                let scalar_repo = repo.map(JsString16::try_utf8).transpose()?;
                let rk = keys::kernel_request(
                    &scalar_owner,
                    scalar_repo.as_deref(),
                    window.created_at_ms,
                    id,
                );
                let rr = self.store.read(&rk).await?;
                let mut reservation: KernelReservation = store::value(rr.as_ref(), now)?
                    .map(|v| {
                        serde_json::from_value(v)
                            .map_err(|_| store::corrupt("Kernel reservation is malformed"))
                    })
                    .transpose()?
                    .ok_or_else(|| store::corrupt("Kernel reservation is missing"))?;
                reservation.validate()?;
                if JsString16::from_utf8(&reservation.owner) != *owner
                    || reservation
                        .repo
                        .as_ref()
                        .map(|v| JsString16::from_utf8(v))
                        .as_ref()
                        != repo
                    || reservation.request_id.0 != *id
                    || reservation.window_created_at_ms != window.created_at_ms
                    || reservation.window_reset_at_ms != window.usage_reset_at_ms
                    || reservation.lease_expires_at_ms != *expiry
                    || reservation.state.is_some()
                {
                    return Err(store::corrupt(
                        "Kernel reservation/window identity is inconsistent",
                    ));
                }
                if *expiry <= now {
                    let terminal = reservation
                        .terminal_intent
                        .unwrap_or(KernelTerminal::Released);
                    reservation.state = Some(terminal);
                    reservation.terminal_intent = Some(terminal);
                    reservation.terminal_at_ms = Some(now);
                    if terminal == KernelTerminal::Committed {
                        window.usage_requests = window
                            .usage_requests
                            .checked_add(1)
                            .ok_or_else(|| store::corrupt("Kernel usage overflow"))?;
                        reservation.release_reason = None;
                    } else {
                        reservation.release_reason = Some("lease_expired".into());
                    }
                    checks.push(check(&rk, rr.as_ref()));
                    writes.push(put(
                        rk,
                        &reservation,
                        Some(window.usage_reset_at_ms + WEEK),
                        &store::revision(self.host)?,
                    )?);
                } else {
                    retained.insert(id.clone(), *expiry);
                }
            }
            if writes.is_empty() {
                return Ok(Some(window));
            }
            window.reservations = retained;
            window.reserved_requests = window.reservations.len() as i64;
            window.updated_at_ms = now;
            writes.push(data_put(
                key.clone(),
                &window_document(&window),
                Some(window.usage_reset_at_ms + WEEK),
                &store::revision(self.host)?,
            )?);
            if commit(self.store, checks, writes).await? {
                return Ok(Some(window));
            }
        }
        Err(conflict("Kernel reservations changed concurrently; retry"))
    }
    pub(crate) async fn live_default_reservations(&self, now: i64) -> Result<bool, GatewayError> {
        for (name, repo_scope) in [("repo_window", true), ("org_window", false)] {
            let prefix = store::key(json!(["uos_ai", "kernel_quota", "v2", name]));
            for entry in store::scan(self.store, prefix, false, now).await? {
                let raw = decode_source_control_record(&entry.record)?;
                let owner = body::member(&raw, "owner")
                    .as_ref()
                    .and_then(body::text)
                    .ok_or_else(|| store::corrupt("Kernel window owner is missing"))?;
                let repo = if repo_scope {
                    Some(
                        body::member(&raw, "repo")
                            .as_ref()
                            .and_then(body::text)
                            .ok_or_else(|| store::corrupt("Kernel window repo is missing"))?,
                    )
                } else {
                    None
                };
                if entry.key != keys::kernel_window_source(&owner, repo.as_ref())? {
                    return Err(store::corrupt("Kernel window key identity is malformed"));
                }
                if let Some(value) = data_read(
                    self.store,
                    &keys::kernel_policy_source(&owner, repo.as_ref())?,
                    now,
                )
                .await?
                {
                    decode_policy(value, &owner, repo.as_ref())?;
                    continue;
                }
                if self
                    .kernel_window(&owner, repo.as_ref(), now)
                    .await?
                    .is_some_and(|w| w.reserved_requests > 0)
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    async fn policy_summary(
        &self,
        owner: &JsString16,
        repo: Option<&JsString16>,
        now: i64,
    ) -> Result<SourceJson, GatewayError> {
        let defaults = self.kernel_defaults(now).await?;
        let explicit =
            data_read(self.store, &keys::kernel_policy_source(owner, repo)?, now).await?;
        let selected = if explicit.is_some() { "kv" } else { "default" };
        let policy = explicit
            .map(|v| decode_policy(v, owner, repo))
            .transpose()?
            .unwrap_or(SourcePolicy {
                v: 2,
                owner: owner.clone(),
                repo: repo.cloned(),
                usage_limit_requests: defaults.usage_limit_requests,
                window_ms: defaults.window_ms,
                expires_at_ms: -1.0,
            });
        self.summary_for_policy(&policy, selected, now).await
    }
    async fn summary_for_policy(
        &self,
        policy: &SourcePolicy,
        selected: &str,
        now: i64,
    ) -> Result<SourceJson, GatewayError> {
        let raw = data_read(
            self.store,
            &keys::kernel_window_source(&policy.owner, policy.repo.as_ref())?,
            now,
        )
        .await?;
        let window = raw
            .as_ref()
            .and_then(|v| {
                if body::member(v, "scope").is_some() {
                    SourceWindow::normalize_source_document(v, &policy.owner, policy.repo.as_ref())
                } else {
                    validate_window(v.clone(), &policy.owner, policy.repo.as_ref())
                        .ok()
                        .map(|w| window_document(&w))
                }
            })
            .filter(|w| {
                body::member(w, "applied_window_ms")
                    .as_ref()
                    .and_then(body::number)
                    == Some(policy.window_ms as f64)
                    && body::member(w, "usage_reset_at_ms")
                        .as_ref()
                        .and_then(body::number)
                        .is_some_and(|v| v > now as f64)
            })
            .unwrap_or_else(|| {
                window_document(&new_window(
                    &policy.owner,
                    policy.repo.as_ref(),
                    policy.window_ms,
                    now,
                ))
            });
        let mut result = summary_document(policy, &window, now);
        body::set(&mut result, "source", body::json(selected));
        Ok(result)
    }
    pub(crate) async fn kernel(
        &self,
        op: AdminOperation,
        input: &AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        let now = input.now_ms;
        if op == AdminOperation::KernelQueue {
            let raw = data_read(
                self.store,
                &store::key(json!(["uos_ai", "kernel_policy_queue"])),
                now,
            )
            .await?;
            let rows = raw
                .as_ref()
                .and_then(|v| v.array_items().ok())
                .unwrap_or_default();
            let mut pending = Vec::new();
            for row in rows {
                let label = |name| {
                    body::member(&row, name)
                        .as_ref()
                        .and_then(body::text)
                        .map(|s| body::trim(&s))
                        .filter(|s| !s.as_units().is_empty())
                };
                let (Some(owner), Some(repo)) = (label("owner"), label("repo")) else {
                    continue;
                };
                let org =
                    data_read(self.store, &keys::kernel_policy_source(&owner, None)?, now).await?;
                let explicit = if org.as_ref().is_some_and(source_truth) {
                    None
                } else {
                    data_read(
                        self.store,
                        &keys::kernel_policy_source(&owner, Some(&repo))?,
                        now,
                    )
                    .await?
                };
                if org.as_ref().is_some_and(source_truth)
                    || explicit.as_ref().is_some_and(source_truth)
                {
                    continue;
                }
                let number = |name, fallback| {
                    body::member(&row, name)
                        .as_ref()
                        .and_then(body::number)
                        .filter(|n| n.is_finite())
                        .map(f64::trunc)
                        .unwrap_or(fallback)
                };
                let last = number("last_seen_at_ms", now as f64);
                pending.push((
                    last,
                    body::object(vec![
                        ("owner", body::json(&owner)),
                        ("repo", body::json(&repo)),
                        (
                            "request_count",
                            body::json(&number("request_count", 0.0).max(0.0)),
                        ),
                        (
                            "first_seen_at_ms",
                            body::json(&number("first_seen_at_ms", now as f64)),
                        ),
                        ("last_seen_at_ms", body::json(&last)),
                        (
                            "last_route",
                            label("last_route")
                                .as_ref()
                                .map_or_else(|| body::json(&Value::Null), body::json),
                        ),
                    ]),
                ));
            }
            pending.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .expect("normalized finite queue times")
            });
            let data =
                source::json_array(&pending.into_iter().map(|(_, v)| v).collect::<Vec<_>>())?;
            return Ok(AuthResponse::source_json(
                200,
                canonical(body::object(vec![("data", data)])),
            ));
        }
        if op == AdminOperation::KernelUsageGet {
            return self.kernel_get(input).await;
        }
        let (owner, repo) = target(&input.body)?;
        let key = keys::kernel_policy_source(&owner, repo.as_ref())?;
        let window_key = keys::kernel_window_source(&owner, repo.as_ref())?;
        let limit = if op == AdminOperation::KernelUsageSet {
            Some(body::member(&input.body,"usage_limit_requests").as_ref().and_then(limit).ok_or_else(||invalid("usage_limit_requests must be a non-negative number, -1, or 'unlimited'"))?)
        } else {
            None
        };
        let window = body::member(&input.body, "window_ms")
            .map(|v| positive(&v).ok_or_else(|| invalid("window_ms must be a positive number")))
            .transpose()?;
        let expires = body::member(&input.body, "expires_at_ms")
            .map(|v| {
                expiry(&v, now).ok_or_else(|| {
                    invalid("expires_at_ms must be a Unix epoch ms timestamp in the future, or -1")
                })
            })
            .transpose()?;
        if body::member(&input.body, "reset_usage").is_some_and(|v| body::boolean(&v).is_none()) {
            return Err(invalid("reset_usage must be a boolean"));
        }
        for _ in 0..3 {
            if op == AdminOperation::KernelUsageDelete
                && data_read(self.store, &key, now).await?.is_none()
            {
                return Err(GatewayError::new(
                    404,
                    "Kernel usage limit not found",
                    Some("not_found"),
                ));
            }
            self.kernel_window(&owner, repo.as_ref(), now)
                .await
                .map_err(|_| conflict("Concurrent modification; retry"))?;
            let defaults = self.kernel_defaults(now).await?;
            let row = self.store.read(&key).await?;
            let window_row = self.store.read(&window_key).await?;
            let cutover_key = keys::kernel_cutover();
            let cutover = self.store.read(&cutover_key).await?;
            if store::value(cutover.as_ref(), now)?.is_some() {
                return Err(conflict("Kernel default-window cutover is in progress"));
            }
            let explicit = data_value(row.as_ref(), now)?;
            if explicit.is_none() && op == AdminOperation::KernelUsageDelete {
                return Err(GatewayError::new(
                    404,
                    "Kernel usage limit not found",
                    Some("not_found"),
                ));
            }
            let old = explicit
                .map(|v| decode_policy(v, &owner, repo.as_ref()))
                .transpose()
                .map_err(|_| conflict("Concurrent modification; retry"))?;
            let current_window = data_value(window_row.as_ref(), now)?
                .map(|v| validate_window(v, &owner, repo.as_ref()))
                .transpose()
                .map_err(|_| conflict("Concurrent modification; retry"))?;
            let current_ms = old
                .as_ref()
                .map(|p| p.window_ms)
                .unwrap_or(defaults.window_ms);
            let next_ms = if limit.is_some() {
                window.unwrap_or(current_ms)
            } else {
                defaults.window_ms
            };
            let reset = body::member(&input.body, "reset_usage")
                .as_ref()
                .and_then(body::boolean)
                == Some(true)
                || current_ms != next_ms;
            if current_window
                .as_ref()
                .is_some_and(|w| w.reserved_requests > 0)
                && (reset || limit.is_none())
            {
                return Err(conflict(
                    "Active Kernel quota reservations must settle before changing this policy",
                ));
            }
            let org_key = keys::kernel_policy_source(&owner, None)?;
            let org_row = if repo.is_some() && row.is_none() {
                self.store.read(&org_key).await?
            } else {
                None
            };
            let org_window_key = keys::kernel_window_source(&owner, None)?;
            let org_window_row = if repo.is_some() && row.is_none() {
                self.store.read(&org_window_key).await?
            } else {
                None
            };
            if org_row.is_some()
                && self
                    .kernel_window(&owner, None, now)
                    .await?
                    .is_some_and(|w| w.reserved_requests > 0)
            {
                return Err(conflict(
                    "Active inherited Kernel reservations must settle before changing this policy",
                ));
            }
            let dwk = default_window_key();
            let dw = self.store.read(&dwk).await?;
            let dlk = default_limit_key();
            let dl = self.store.read(&dlk).await?;
            let dkey = keys::kernel_defaults();
            let dr = self.store.read(&dkey).await?;
            let mut checks = vec![
                check(&key, row.as_ref()),
                check(&window_key, window_row.as_ref()),
                check(&cutover_key, cutover.as_ref()),
                check(&dwk, dw.as_ref()),
                check(&dlk, dl.as_ref()),
                check(&dkey, dr.as_ref()),
            ];
            if repo.is_some() && row.is_none() {
                checks.push(check(&org_key, org_row.as_ref()));
                checks.push(check(&org_window_key, org_window_row.as_ref()));
            }
            let mut next_window = if !reset {
                current_window
                    .filter(|w| w.applied_window_ms == next_ms && w.usage_reset_at_ms > now)
                    .unwrap_or_else(|| new_window(&owner, repo.as_ref(), next_ms, now))
            } else {
                new_window(&owner, repo.as_ref(), next_ms, now)
            };
            next_window.updated_at_ms = now;
            let revision = store::revision(self.host)?;
            let mut writes = vec![data_put(
                window_key.clone(),
                &window_document(&next_window),
                None,
                &revision,
            )?];
            let mut response = body::object(vec![
                ("ok", body::json(&true)),
                (
                    "scope",
                    body::json(if repo.is_some() { "repo" } else { "org" }),
                ),
                (
                    if repo.is_some() { "repo" } else { "org" },
                    body::object(identity_fields(&owner, repo.as_ref())),
                ),
            ]);
            if let Some(limit) = limit {
                let policy = SourcePolicy {
                    v: 2,
                    owner: owner.clone(),
                    repo: repo.clone(),
                    usage_limit_requests: limit,
                    window_ms: next_ms,
                    expires_at_ms: expires
                        .unwrap_or(old.as_ref().map(|p| p.expires_at_ms).unwrap_or(-1.0)),
                };
                let mut fields = vec![
                    ("v", body::json(&2)),
                    (
                        "scope",
                        body::json(if repo.is_some() { "repo" } else { "org" }),
                    ),
                ];
                fields.extend(identity_fields(&owner, repo.as_ref()));
                fields.extend([
                    (
                        "usage_limit_requests",
                        body::json(&policy.usage_limit_requests),
                    ),
                    ("window_ms", body::json(&policy.window_ms)),
                    ("expires_at_ms", body::json(&policy.expires_at_ms)),
                    (
                        "created_at_ms",
                        data_value(row.as_ref(), now)?
                            .as_ref()
                            .and_then(|v| body::member(v, "created_at_ms"))
                            .unwrap_or_else(|| body::json(&now)),
                    ),
                    ("updated_at_ms", body::json(&now)),
                ]);
                writes.push(data_put(
                    key.clone(),
                    &canonical(body::object(fields)),
                    None,
                    &revision,
                )?);
                let mut limit = summary(&policy, &next_window, now);
                body::set(&mut limit, "source", body::json("kv"));
                body::set(&mut response, "limit", limit);
            } else {
                writes.push(RecordMutation::Delete { key: key.clone() });
                body::set(&mut response, "deleted", body::json(&true));
            }
            if commit(self.store, checks, writes).await? {
                return Ok(AuthResponse::source_json(200, canonical(response)));
            }
        }
        Err(conflict("Concurrent modification; retry"))
    }
    async fn kernel_get(&self, input: &AdminInput) -> Result<AuthResponse, GatewayError> {
        let org = parse::first(&input.query, "scope").is_some_and(|s| {
            s.trim_matches(gateway_schema::util::js_whitespace)
                .eq_ignore_ascii_case("org")
        });
        let include = parse::truth(parse::first(&input.query, "include_usage"));
        let inventory = parse::truth(parse::first(&input.query, "inventory"));
        let list = parse::truth(parse::first(&input.query, "list"));
        if inventory {
            let family = if org { "org_usage" } else { "usage" };
            let prefix = store::key(json!(["ubq_ai", "kernel_auth", family]));
            let mut records = Vec::new();
            for entry in store::scan(self.store, prefix, false, input.now_ms).await? {
                let raw = entry.record.json_value()?;
                let owner = raw
                    .get("owner")
                    .and_then(Value::as_str)
                    .ok_or_else(|| store::corrupt("Kernel inventory owner is malformed"))?;
                let repo = if org {
                    None
                } else {
                    Some(
                        raw.get("repo")
                            .and_then(Value::as_str)
                            .ok_or_else(|| store::corrupt("Kernel inventory repo is malformed"))?,
                    )
                };
                records.push(self.usage_record(owner, repo, input.now_ms, true).await?);
            }
            let records =
                gateway_schema::aliases::sort_source(records, &|a: &Value, b: &Value| {
                    for field in ["owner", "repo"] {
                        let order = self.capabilities.compare_admin_labels(
                            &JsString16::from_utf8(a[field].as_str().unwrap_or("")),
                            &JsString16::from_utf8(b[field].as_str().unwrap_or("")),
                        )?;
                        if order != std::cmp::Ordering::Equal {
                            return Ok(order);
                        }
                    }
                    Ok(std::cmp::Ordering::Equal)
                })?;
            return Ok(AuthResponse::json(
                200,
                json!({"ok":true,"scope":if org{"org"}else{"repo"},"usage":records}),
            ));
        }
        if list {
            let prefix = store::key(json!([
                "uos_ai",
                "kernel_quota",
                "v2",
                if org { "org_policy" } else { "repo_policy" }
            ]));
            let mut records = Vec::new();
            for entry in store::scan(self.store, prefix, false, input.now_ms).await? {
                let Some((owner, repo)) = physical_labels(&entry.key, org)? else {
                    continue;
                };
                let raw = decode_source_control_record(&entry.record)?;
                let Some(normalized) =
                    SourcePolicy::normalize_source_document(&raw, &owner, repo.as_ref())
                else {
                    continue;
                };
                let policy: SourcePolicy = normalized.deserialize()?;
                let mut row = self.summary_for_policy(&policy, "kv", input.now_ms).await?;
                let fields = source::entries(&row)
                    .expect("constructed source summary")
                    .into_iter()
                    .filter(|(k, _)| *k != JsString16::from_utf8("source"))
                    .collect();
                row = source::object_keys(fields)?;
                if include {
                    let scalar_owner = owner.try_utf8()?;
                    let scalar_repo = repo.as_ref().map(JsString16::try_utf8).transpose()?;
                    let usage = self
                        .usage_record(&scalar_owner, scalar_repo.as_deref(), input.now_ms, true)
                        .await?;
                    body::set(&mut row, "usage", body::json(&usage));
                }
                records.push((owner, repo, row));
            }
            let records = gateway_schema::aliases::sort_source(records, &|a: &(
                JsString16,
                Option<JsString16>,
                SourceJson,
            ),
                                                                          b: &(
                JsString16,
                Option<JsString16>,
                SourceJson,
            )| {
                let owner = self.capabilities.compare_admin_labels(&a.0, &b.0)?;
                if owner != std::cmp::Ordering::Equal {
                    return Ok(owner);
                }
                match (&a.1, &b.1) {
                    (Some(a), Some(b)) => self.capabilities.compare_admin_labels(a, b),
                    _ => Ok(std::cmp::Ordering::Equal),
                }
            })?;
            let rows = source::json_array(
                &records
                    .into_iter()
                    .map(|(_, _, row)| row)
                    .collect::<Vec<_>>(),
            )?;
            return Ok(AuthResponse::source_json(
                200,
                canonical(body::object(vec![
                    ("ok", body::json(&true)),
                    ("scope", body::json(if org { "org" } else { "repo" })),
                    ("limits", rows),
                ])),
            ));
        }
        // Query strings already have the source URL/USVString boundary; raw JSON
        // selectors alone may carry lone units. Never repair stored logical labels.
        let owner = part(parse::first(&input.query, "owner").map(body::json).as_ref())
            .ok_or_else(|| invalid("owner query parameter is required"))?;
        let repo = if org {
            None
        } else {
            Some(
                part(parse::first(&input.query, "repo").map(body::json).as_ref())
                    .ok_or_else(|| invalid("repo query parameter is required"))?,
            )
        };
        let limit = self
            .policy_summary(&owner, repo.as_ref(), input.now_ms)
            .await
            .map_err(|_| {
                GatewayError::new(
                    500,
                    if org {
                        "Failed to load kernel org usage limit"
                    } else {
                        "Failed to load kernel usage limit"
                    },
                    Some("server_error"),
                )
            })?;
        let scalar_owner = owner.try_utf8()?;
        let scalar_repo = repo.as_ref().map(JsString16::try_utf8).transpose()?;
        let usage = self
            .usage_record(&scalar_owner, scalar_repo.as_deref(), input.now_ms, include)
            .await?;
        Ok(AuthResponse::source_json(
            200,
            canonical(body::object(vec![
                ("ok", body::json(&true)),
                (
                    if org { "org" } else { "repo" },
                    body::object(identity_fields(&owner, repo.as_ref())),
                ),
                ("limit", limit),
                ("usage", body::json(&usage)),
            ])),
        ))
    }
    async fn usage_record(
        &self,
        owner: &str,
        repo: Option<&str>,
        now: i64,
        daily: bool,
    ) -> Result<Value, GatewayError> {
        let key = if let Some(repo) = repo {
            store::key(json!(["ubq_ai", "kernel_auth", "usage", owner, repo]))
        } else {
            store::key(json!(["ubq_ai", "kernel_auth", "org_usage", owner]))
        };
        let Some(raw) = store::read(self.store, &key, now).await? else {
            return Ok(Value::Null);
        };
        let mut row = json!({"owner":raw.get("owner").and_then(Value::as_str).map(gateway_schema::util::js_trim).filter(|s|!s.is_empty()).unwrap_or(owner)});
        if let Some(repo) = repo {
            row["repo"] = json!(
                raw.get("repo")
                    .and_then(Value::as_str)
                    .map(gateway_schema::util::js_trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(repo)
            );
        }
        for field in [
            "total_requests",
            "stream_requests",
            "non_stream_requests",
            "completed_requests",
            "error_requests",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "first_seen_at_ms",
            "last_seen_at_ms",
        ] {
            let fallback = if field == "first_seen_at_ms" || field == "last_seen_at_ms" {
                now
            } else {
                0
            };
            row[field] = json!(
                raw.get(field)
                    .and_then(Value::as_f64)
                    .map(|n| n.trunc() as i64)
                    .unwrap_or(fallback)
            );
        }
        for field in ["last_model", "last_reasoning", "last_route"] {
            row[field] =
                json!(parse::text(raw.get(field)).map(|s| s.chars().take(120).collect::<String>()));
        }
        if daily {
            let key = if let Some(repo) = repo {
                store::key(json!(["ubq_ai", "kernel_auth", "usage_daily", owner, repo]))
            } else {
                store::key(json!(["ubq_ai", "kernel_auth", "org_usage_daily", owner]))
            };
            let raw = store::read(self.store, &key, now).await?;
            let mut counts = BTreeMap::new();
            if let Some(days) = raw
                .as_ref()
                .and_then(|v| v.get("days"))
                .and_then(Value::as_array)
            {
                for day in days {
                    if let Some(label) = day.get("day").and_then(Value::as_str) {
                        counts.insert(
                            label
                                .trim_matches(gateway_schema::util::js_whitespace)
                                .to_owned(),
                            day.get("request_count")
                                .and_then(Value::as_f64)
                                .map(|n| (n.trunc() as i64).max(0))
                                .unwrap_or(0),
                        );
                    }
                }
            }
            let today = now.div_euclid(86400000);
            let series: Vec<i64> = (0..30)
                .map(|offset| {
                    counts
                        .get(&day_label(today - 29 + offset))
                        .copied()
                        .unwrap_or(0)
                })
                .collect();
            row["daily_requests"] = json!(series);
        }
        Ok(row)
    }
    pub(crate) async fn release_cutover(
        &self,
        key: &RecordKey,
        row: &StoredRecord,
    ) -> Result<(), GatewayError> {
        // Conditional release cannot remove another operation's claim.
        commit(
            self.store,
            vec![check(key, Some(row))],
            vec![RecordMutation::Delete { key: key.clone() }],
        )
        .await?;
        Ok(())
    }
}

fn day_label(days: i64) -> String {
    // Gregorian UTC conversion, independent of host timezone or environment discovery.
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}
