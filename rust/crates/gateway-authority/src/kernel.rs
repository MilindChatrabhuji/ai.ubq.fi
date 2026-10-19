//! Kernel semantic quota reservations, retained separately from dispatch charging.
use crate::store::Transaction;
use crate::{
    Authority, DAY_MS, QUOTA_RETENTION_MS, REQUEST_LEASE_MS, TokenSource, add, invalid, keys,
    nonnegative, positive, quota_error, retention, text, unavailable,
};
use gateway_core::GatewayError;
use gateway_core::identity::RequestId;
use gateway_core::state::AuthorityStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct KernelPolicy<L = String> {
    pub v: u32,
    pub owner: L,
    pub repo: Option<L>,
    pub usage_limit_requests: i64,
    pub window_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct KernelDefaults {
    pub usage_limit_requests: i64,
    pub window_ms: i64,
}

impl Default for KernelDefaults {
    fn default() -> Self {
        Self {
            usage_limit_requests: -1,
            window_ms: 7 * DAY_MS,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelTerminal {
    Committed,
    Released,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct KernelReservation {
    pub v: u32,
    pub owner: String,
    pub repo: Option<String>,
    pub request_id: RequestId,
    pub route: String,
    pub window_created_at_ms: i64,
    pub window_reset_at_ms: i64,
    pub reserved_at_ms: i64,
    pub lease_expires_at_ms: i64,
    pub terminal_intent: Option<KernelTerminal>,
    pub state: Option<KernelTerminal>,
    pub terminal_at_ms: Option<i64>,
    pub release_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct KernelWindow<L = String> {
    pub v: u32,
    pub owner: L,
    pub repo: Option<L>,
    pub usage_requests: i64,
    pub reserved_requests: i64,
    pub created_at_ms: i64,
    pub usage_reset_at_ms: i64,
    pub applied_window_ms: i64,
    pub updated_at_ms: i64,
    pub reservations: BTreeMap<String, i64>,
}

pub(crate) fn kernel_identity(row: &KernelReservation, expected: &KernelReservation) -> bool {
    row.validate().is_ok()
        && row.v == 2
        && row.owner == expected.owner
        && row.repo == expected.repo
        && row.request_id == expected.request_id
        && row.route == expected.route
        && row.window_created_at_ms == expected.window_created_at_ms
        && row.window_reset_at_ms == expected.window_reset_at_ms
        && row.reserved_at_ms == expected.reserved_at_ms
}

impl KernelReservation {
    /// Includes dc6be2c3 source strict ordering/released-reason guards.
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.v != 2 {
            return Err(invalid("Kernel reservation version is invalid."));
        }
        text(&self.owner)?;
        if let Some(repo) = &self.repo {
            text(repo)?;
        }
        text(&self.request_id.0)?;
        text(&self.route)?;
        nonnegative(self.window_created_at_ms)?;
        nonnegative(self.reserved_at_ms)?;
        positive(self.window_reset_at_ms)?;
        positive(self.lease_expires_at_ms)?;
        if self.window_reset_at_ms <= self.window_created_at_ms
            || self.lease_expires_at_ms <= self.reserved_at_ms
        {
            return Err(invalid(
                "Kernel reservation temporal identity is malformed.",
            ));
        }
        if let Some(at) = self.terminal_at_ms {
            nonnegative(at)?;
        }
        match self.state {
            None if self.terminal_at_ms.is_some() || self.release_reason.is_some() => {
                return Err(invalid("Reserved kernel row contains terminal fields."));
            }
            Some(KernelTerminal::Committed)
                if self.terminal_at_ms.is_none()
                    || self.release_reason.is_some()
                    || self.terminal_intent == Some(KernelTerminal::Released) =>
            {
                return Err(invalid("Committed kernel row is malformed."));
            }
            Some(KernelTerminal::Released)
                if self.terminal_at_ms.is_none()
                    || self
                        .release_reason
                        .as_ref()
                        .is_none_or(|reason| reason.trim().is_empty())
                    || self.terminal_intent == Some(KernelTerminal::Committed) =>
            {
                return Err(invalid("Released kernel row is malformed."));
            }
            _ => {}
        }
        Ok(())
    }
}

fn validate_kernel_window(
    window: &KernelWindow,
    owner: &str,
    repo: Option<&str>,
) -> Result<(), GatewayError> {
    if window.v != 2
        || window.owner != owner
        || window.repo.as_deref() != repo
        || window.reserved_requests != window.reservations.len() as i64
    {
        return Err(invalid("Kernel quota aggregate is malformed."));
    }
    nonnegative(window.usage_requests)?;
    nonnegative(window.reserved_requests)?;
    nonnegative(window.created_at_ms)?;
    nonnegative(window.usage_reset_at_ms)?;
    positive(window.applied_window_ms)?;
    if window.usage_reset_at_ms <= window.created_at_ms {
        return Err(invalid("Kernel window reset must follow creation."));
    }
    Ok(())
}

async fn validate_kernel_index<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    window: &KernelWindow,
) -> Result<(), GatewayError> {
    for (request_id, expiry) in &window.reservations {
        let key = keys::kernel_request(
            &window.owner,
            window.repo.as_deref(),
            window.created_at_ms,
            request_id,
        );
        let row: KernelReservation = tx
            .read(&key)
            .await?
            .ok_or_else(|| invalid("Active kernel reservation has no durable row."))?;
        row.validate()?;
        if row.owner != window.owner
            || row.repo != window.repo
            || row.request_id.0 != *request_id
            || row.window_created_at_ms != window.created_at_ms
            || row.window_reset_at_ms != window.usage_reset_at_ms
            || row.state.is_some()
            || row.lease_expires_at_ms != *expiry
        {
            return Err(invalid(
                "Kernel reservation/window identity or aggregate is inconsistent.",
            ));
        }
    }
    Ok(())
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub async fn reserve_kernel(
        &self,
        owner: &str,
        repo: &str,
        request_id: &RequestId,
        route: &str,
        now: i64,
    ) -> Result<KernelReservation, GatewayError> {
        text(owner)?;
        text(repo)?;
        text(&request_id.0)?;
        text(route)?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let repo_policy: Option<KernelPolicy> =
                tx.read(&keys::kernel_policy(owner, Some(repo))).await?;
            let org_policy: Option<KernelPolicy> = if repo_policy.is_none() {
                tx.read(&keys::kernel_policy(owner, None)).await?
            } else {
                None
            };
            let defaults: KernelDefaults =
                tx.read(&keys::kernel_defaults()).await?.unwrap_or_default();
            let cutover: Option<serde_json::Value> = tx.read(&keys::kernel_cutover()).await?;
            let scope_repo = repo_policy.as_ref().map(|_| repo.to_owned());
            let policy = repo_policy.or(org_policy);
            if let Some(policy) = &policy
                && (policy.v != 2 || policy.owner != owner || policy.repo != scope_repo)
            {
                return Err(invalid("Kernel policy scope conflicts."));
            }
            if policy.is_none() && cutover.is_some() {
                return Err(unavailable(
                    "kernel_quota_unavailable",
                    "Kernel defaults are changing.",
                ));
            }
            let limit = policy
                .as_ref()
                .map_or(defaults.usage_limit_requests, |policy| {
                    policy.usage_limit_requests
                });
            let duration = policy
                .as_ref()
                .map_or(defaults.window_ms, |policy| policy.window_ms);
            positive(duration)?;
            if limit != -1 {
                nonnegative(limit)?;
            }
            if limit == 0
                || policy
                    .as_ref()
                    .is_some_and(|policy| policy.expires_at_ms != -1 && policy.expires_at_ms <= now)
            {
                return Err(quota_error(
                    "Kernel usage limit is zero or expired.",
                    "rate_limit_exceeded",
                ));
            }
            let window_key = keys::kernel_window(owner, scope_repo.as_deref());
            let prior: Option<KernelWindow> = tx.read(&window_key).await?;
            if let Some(window) = &prior {
                validate_kernel_window(window, owner, scope_repo.as_deref())?;
                validate_kernel_index(&mut tx, window).await?;
            }
            let mut window = match prior {
                Some(window)
                    if window.usage_reset_at_ms > now && window.applied_window_ms == duration =>
                {
                    window
                }
                _ => KernelWindow {
                    v: 2,
                    owner: owner.to_owned(),
                    repo: scope_repo.clone(),
                    usage_requests: 0,
                    reserved_requests: 0,
                    created_at_ms: now,
                    usage_reset_at_ms: add(now, duration)?,
                    applied_window_ms: duration,
                    updated_at_ms: now,
                    reservations: BTreeMap::new(),
                },
            };
            let row_key = keys::kernel_request(
                owner,
                scope_repo.as_deref(),
                window.created_at_ms,
                &request_id.0,
            );
            if tx.read::<KernelReservation>(&row_key).await?.is_some() {
                return Err(unavailable(
                    "kernel_quota_unavailable",
                    "Kernel request already has a reservation.",
                ));
            }
            if limit != -1 && add(window.usage_requests, window.reserved_requests)? >= limit {
                let expired = window
                    .reservations
                    .iter()
                    .find(|(_, expiry)| **expiry <= now)
                    .map(|(id, _)| id.clone());
                if let Some(id) = expired {
                    let key = keys::kernel_request(
                        owner,
                        scope_repo.as_deref(),
                        window.created_at_ms,
                        &id,
                    );
                    let mut row: KernelReservation = tx
                        .read(&key)
                        .await?
                        .ok_or_else(|| invalid("Kernel reservation is missing."))?;
                    row.validate()?;
                    if row.state.is_some() || row.lease_expires_at_ms > now {
                        return Err(invalid("Kernel expiry index is malformed."));
                    }
                    let terminal = row.terminal_intent.unwrap_or(KernelTerminal::Released);
                    row.state = Some(terminal);
                    row.terminal_intent = Some(terminal);
                    row.terminal_at_ms = Some(now);
                    row.release_reason = if terminal == KernelTerminal::Released {
                        Some("lease_expired".to_owned())
                    } else {
                        None
                    };
                    if terminal == KernelTerminal::Committed {
                        window.usage_requests = add(window.usage_requests, 1)?;
                    }
                    window.reserved_requests -= 1;
                    window.reservations.remove(&id);
                    tx.put(
                        &key,
                        &row,
                        Some(retention(row.window_reset_at_ms, QUOTA_RETENTION_MS)?),
                    )?;
                    tx.put(
                        &window_key,
                        &window,
                        Some(retention(window.usage_reset_at_ms, QUOTA_RETENTION_MS)?),
                    )?;
                    tx.commit().await?;
                    continue;
                }
                if tx.commit().await? {
                    return Err(quota_error(
                        "Kernel usage limit exceeded.",
                        "rate_limit_exceeded",
                    ));
                } else {
                    continue;
                }
            }
            let lease = add(now, REQUEST_LEASE_MS)?;
            let row = KernelReservation {
                v: 2,
                owner: owner.to_owned(),
                repo: scope_repo.clone(),
                request_id: request_id.clone(),
                route: route.to_owned(),
                window_created_at_ms: window.created_at_ms,
                window_reset_at_ms: window.usage_reset_at_ms,
                reserved_at_ms: now,
                lease_expires_at_ms: lease,
                terminal_intent: None,
                state: None,
                terminal_at_ms: None,
                release_reason: None,
            };
            window.reserved_requests = add(window.reserved_requests, 1)?;
            window.reservations.insert(request_id.0.clone(), lease);
            window.updated_at_ms = now;
            let expiry = Some(retention(window.usage_reset_at_ms, QUOTA_RETENTION_MS)?);
            tx.put(&row_key, &row, expiry)?;
            tx.put(&window_key, &window, expiry)?;
            if tx.commit().await? {
                return Ok(row);
            }
        }
        Err(unavailable(
            "kernel_quota_unavailable",
            "Kernel quota changed concurrently.",
        ))
    }

    pub async fn renew_kernel(
        &self,
        expected: &KernelReservation,
        now: i64,
    ) -> Result<i64, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let key = keys::kernel_request(
                &expected.owner,
                expected.repo.as_deref(),
                expected.window_created_at_ms,
                &expected.request_id.0,
            );
            let mut row: KernelReservation = tx.read(&key).await?.ok_or_else(|| {
                unavailable("kernel_quota_unavailable", "Kernel reservation is missing.")
            })?;
            if !kernel_identity(&row, expected)
                || row.state.is_some()
                || (row.lease_expires_at_ms <= now && row.terminal_intent.is_none())
            {
                return Err(unavailable(
                    "kernel_quota_unavailable",
                    "Kernel reservation lease expired or settled.",
                ));
            }
            let lease = add(now, REQUEST_LEASE_MS)?;
            row.lease_expires_at_ms = lease;
            let window_key = keys::kernel_window(&row.owner, row.repo.as_deref());
            let window: Option<KernelWindow> = tx.read(&window_key).await?;
            if let Some(mut window) = window {
                validate_kernel_window(&window, &row.owner, row.repo.as_deref())?;
                if window.created_at_ms == row.window_created_at_ms {
                    window.reservations.insert(row.request_id.0.clone(), lease);
                    tx.put(
                        &window_key,
                        &window,
                        Some(retention(window.usage_reset_at_ms, QUOTA_RETENTION_MS)?),
                    )?;
                }
            }
            tx.put(
                &key,
                &row,
                Some(retention(row.window_reset_at_ms, QUOTA_RETENTION_MS)?),
            )?;
            if tx.commit().await? {
                return Ok(lease);
            }
        }
        Err(unavailable(
            "kernel_quota_unavailable",
            "Kernel renewal changed concurrently.",
        ))
    }

    pub async fn record_kernel_terminal_intent(
        &self,
        expected: &KernelReservation,
        terminal: KernelTerminal,
        now: i64,
    ) -> Result<(), GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            stage_kernel_terminal_intent(&mut tx, expected, terminal, now).await?;
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(unavailable(
            "kernel_quota_unavailable",
            "Kernel terminal intent changed concurrently.",
        ))
    }

    /// Caller supplies the semantic terminal decision; downstream delivery never changes it.
    pub async fn settle_kernel(
        &self,
        expected: &KernelReservation,
        terminal: KernelTerminal,
        reason: &str,
        now: i64,
    ) -> Result<bool, GatewayError> {
        self.record_kernel_terminal_intent(expected, terminal, now)
            .await?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let key = keys::kernel_request(
                &expected.owner,
                expected.repo.as_deref(),
                expected.window_created_at_ms,
                &expected.request_id.0,
            );
            let mut row: KernelReservation = tx
                .read(&key)
                .await?
                .ok_or_else(|| invalid("Kernel reservation is missing."))?;
            if !kernel_identity(&row, expected)
                || row.terminal_intent != Some(terminal)
                || row.state.is_some_and(|state| state != terminal)
            {
                return Err(invalid("Kernel terminal state conflicts."));
            }
            if row.state == Some(terminal) {
                return Ok(false);
            }
            let window_key = keys::kernel_window(&row.owner, row.repo.as_deref());
            if let Some(mut window) = tx.read::<KernelWindow>(&window_key).await? {
                validate_kernel_window(&window, &row.owner, row.repo.as_deref())?;
                if window.created_at_ms == row.window_created_at_ms {
                    if window.reserved_requests < 1
                        || window.reservations.remove(&row.request_id.0).is_none()
                    {
                        return Err(invalid("Missing kernel reserved capacity."));
                    }
                    window.reserved_requests -= 1;
                    if terminal == KernelTerminal::Committed {
                        window.usage_requests = add(window.usage_requests, 1)?;
                    }
                    window.updated_at_ms = now;
                    tx.put(
                        &window_key,
                        &window,
                        Some(retention(window.usage_reset_at_ms, QUOTA_RETENTION_MS)?),
                    )?;
                }
            }
            row.state = Some(terminal);
            row.terminal_at_ms = Some(now);
            if terminal == KernelTerminal::Released {
                let reason = reason.chars().take(120).collect::<String>();
                row.release_reason = Some(if reason.trim().is_empty() {
                    "request_incomplete".to_owned()
                } else {
                    reason
                });
            }
            tx.put(
                &key,
                &row,
                Some(retention(row.window_reset_at_ms, QUOTA_RETENTION_MS)?),
            )?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "kernel_quota_unavailable",
            "Kernel settlement changed concurrently.",
        ))
    }
}

/// Stages exactly the existing kernel intent/window writes in the caller's
/// same-authority transaction. Expired inference leases do not erase a prior
/// genuine semantic choice. Returns whether this same intent already existed.
pub(crate) async fn stage_kernel_terminal_intent<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    expected: &KernelReservation,
    terminal: KernelTerminal,
    now: i64,
) -> Result<bool, GatewayError> {
    let key = keys::kernel_request(
        &expected.owner,
        expected.repo.as_deref(),
        expected.window_created_at_ms,
        &expected.request_id.0,
    );
    let mut row: KernelReservation = tx
        .read(&key)
        .await?
        .ok_or_else(|| invalid("Kernel reservation is missing."))?;
    if !kernel_identity(&row, expected)
        || row.terminal_intent.is_some_and(|intent| intent != terminal)
        || row.state.is_some_and(|state| state != terminal)
    {
        return Err(invalid("Kernel terminal state conflicts."));
    }
    let was_chosen = row.terminal_intent == Some(terminal) || row.state == Some(terminal);
    if row.state.is_none() {
        row.terminal_intent = Some(terminal);
        row.lease_expires_at_ms = add(now, REQUEST_LEASE_MS)?;
        let window_key = keys::kernel_window(&row.owner, row.repo.as_deref());
        if let Some(mut window) = tx.read::<KernelWindow>(&window_key).await? {
            validate_kernel_window(&window, &row.owner, row.repo.as_deref())?;
            if window.created_at_ms == row.window_created_at_ms {
                window
                    .reservations
                    .insert(row.request_id.0.clone(), row.lease_expires_at_ms);
                tx.put(
                    &window_key,
                    &window,
                    Some(retention(window.usage_reset_at_ms, QUOTA_RETENTION_MS)?),
                )?;
            }
        }
        tx.put(
            &key,
            &row,
            Some(retention(row.window_reset_at_ms, QUOTA_RETENTION_MS)?),
        )?;
    }
    Ok(was_chosen)
}
