//! API-key dispatch charging and kernel semantic quota are independent source contracts.
use std::collections::BTreeMap;

use gateway_core::GatewayError;
use gateway_core::identity::{ApiKeyId, RequestId};
use gateway_core::model::ModelId;
use gateway_core::provider::UpstreamProvider;
use gateway_core::state::AuthorityStore;
use serde::{Deserialize, Serialize};

use crate::{
    Authority, QUOTA_RETENTION_MS, REQUEST_LEASE_MS, TokenSource, add, invalid, keys, nonnegative,
    positive, quota_error, retention, text, unavailable,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApiKeyPolicy {
    pub v: u32,
    pub key_id: ApiKeyId,
    pub expires_at_ms: i64,
    pub usage_limit_requests: i64,
    pub window_ms: i64,
    pub usage_reset_at_ms: i64,
    pub paid_fallback_enabled: bool,
    pub paid_fallback_limit_microcredits: i64,
    pub paid_fallback_quota_per_credit: i64,
    pub paid_fallback_pricing_checked_at_ms: i64,
    pub paid_fallback_models: Vec<ModelId>,
    #[serde(with = "crate::paid_types::model_map")]
    pub paid_fallback_max_exposure_microcredits: BTreeMap<ModelId, i64>,
}

impl ApiKeyPolicy {
    pub(crate) fn validate(&self, key: &ApiKeyId, now: i64) -> Result<(), GatewayError> {
        if self.v != 3 || &self.key_id != key {
            return Err(invalid("API key policy identity is malformed."));
        }
        text(&key.0)?;
        positive(self.window_ms)?;
        nonnegative(self.usage_reset_at_ms)?;
        if self.usage_limit_requests != -1 {
            nonnegative(self.usage_limit_requests)?;
        }
        if self.expires_at_ms != -1 && self.expires_at_ms <= now {
            return Err(GatewayError::new(
                401,
                "API key has expired.",
                Some("invalid_api_key"),
            ));
        }
        Ok(())
    }

    pub fn current_window(&self, now: i64) -> Result<(i64, i64), GatewayError> {
        positive(self.window_ms)?;
        nonnegative(now)?;
        let initial = self
            .usage_reset_at_ms
            .checked_sub(self.window_ms)
            .ok_or_else(|| invalid("Invalid usage window."))?;
        if initial < 0 {
            return Err(invalid(
                "API key usage window starts before the portable epoch.",
            ));
        }
        if now < self.usage_reset_at_ms {
            return Ok((initial, self.usage_reset_at_ms));
        }
        let elapsed = (now - initial) / self.window_ms;
        let duration = elapsed
            .checked_mul(self.window_ms)
            .ok_or_else(|| invalid("API usage window overflow."))?;
        let start = add(initial, duration)?;
        Ok((start, add(start, self.window_ms)?))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApiUsageWindow {
    pub v: u32,
    pub key_id: ApiKeyId,
    pub policy_version: String,
    pub window_start_ms: i64,
    pub window_reset_at_ms: i64,
    pub committed_requests: i64,
    pub reserved_requests: i64,
    pub updated_at_ms: i64,
    /// An index of active reservations permits event-owned reclaim without store scans.
    pub reservations: BTreeMap<String, i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiUsageState {
    Reserved,
    Dispatched,
    Released,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApiUsageRequest {
    pub v: u32,
    pub key_id: ApiKeyId,
    pub request_id: RequestId,
    pub route: String,
    pub state: ApiUsageState,
    pub reserved_at_ms: i64,
    pub lease_expires_at_ms: i64,
    pub provider: Option<UpstreamProvider>,
    pub dispatched_at_ms: Option<i64>,
    pub released_at_ms: Option<i64>,
    pub release_reason: Option<String>,
    /// Conservative durable transport intent; only a known pretransport cancellation compensates.
    pub transport_started: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApiReservation {
    pub key_id: ApiKeyId,
    pub request_id: RequestId,
    pub route: String,
    pub policy_version: String,
    pub window_start_ms: i64,
    pub window_reset_at_ms: i64,
    #[serde(default)]
    pub deferred: bool,
}

fn api_row_matches(row: &ApiUsageRequest, reservation: &ApiReservation) -> bool {
    row.validate().is_ok()
        && row.v == 3
        && row.key_id == reservation.key_id
        && row.request_id == reservation.request_id
        && row.route == reservation.route
}

impl ApiUsageRequest {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.v != 3 {
            return Err(invalid("API request version is invalid."));
        }
        text(&self.key_id.0)?;
        text(&self.request_id.0)?;
        text(&self.route)?;
        nonnegative(self.reserved_at_ms)?;
        nonnegative(self.lease_expires_at_ms)?;
        if let Some(at) = self.dispatched_at_ms {
            nonnegative(at)?;
        }
        if let Some(at) = self.released_at_ms {
            nonnegative(at)?;
        }
        match self.state {
            ApiUsageState::Reserved
                if self.provider.is_some()
                    || self.dispatched_at_ms.is_some()
                    || self.released_at_ms.is_some()
                    || self.release_reason.is_some() =>
            {
                Err(invalid("Reserved API request has terminal fields."))
            }
            ApiUsageState::Dispatched
                if self.provider.is_none()
                    || self.dispatched_at_ms.is_none()
                    || self.released_at_ms.is_some()
                    || self.release_reason.is_some() =>
            {
                Err(invalid("Dispatched API request is malformed."))
            }
            ApiUsageState::Released
                if self.provider.is_some()
                    || self.dispatched_at_ms.is_some()
                    || self.released_at_ms.is_none()
                    || self.release_reason.is_none() =>
            {
                Err(invalid("Released API request is malformed."))
            }
            _ => Ok(()),
        }
    }
}

fn validate_window(
    window: &ApiUsageWindow,
    reservation: &ApiReservation,
) -> Result<(), GatewayError> {
    if window.v != 3
        || window.key_id != reservation.key_id
        || window.policy_version != reservation.policy_version
        || window.window_start_ms != reservation.window_start_ms
        || window.window_reset_at_ms != reservation.window_reset_at_ms
    {
        return Err(invalid("API key quota aggregate identity is malformed."));
    }
    nonnegative(window.committed_requests)?;
    nonnegative(window.reserved_requests)?;
    nonnegative(window.window_start_ms)?;
    nonnegative(window.window_reset_at_ms)?;
    nonnegative(window.updated_at_ms)?;
    if window.window_reset_at_ms <= window.window_start_ms {
        return Err(invalid("API window reset must follow its start."));
    }
    if window.reserved_requests != window.reservations.len() as i64 {
        return Err(invalid(
            "API quota reservation index disagrees with the aggregate.",
        ));
    }
    Ok(())
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub async fn reserve_api_key(
        &self,
        key_id: &ApiKeyId,
        request_id: &RequestId,
        route: &str,
        now: i64,
    ) -> Result<ApiReservation, GatewayError> {
        text(&key_id.0)?;
        text(&request_id.0)?;
        text(route)?;
        for _ in 0..5 {
            let mut tx = self.transaction(now)?;
            let policy: ApiKeyPolicy = tx
                .read_source_control(&keys::api_policy(&key_id.0))
                .await?
                .ok_or_else(|| {
                    GatewayError::new(401, "API key is unavailable.", Some("invalid_api_key"))
                })?;
            policy.validate(key_id, now)?;
            let (start, reset) = policy.current_window(now)?;
            let reservation = ApiReservation {
                key_id: key_id.clone(),
                request_id: request_id.clone(),
                route: route.to_owned(),
                policy_version: format!("v3:{}", policy.window_ms),
                window_start_ms: start,
                window_reset_at_ms: reset,
                deferred: false,
            };
            let window_key = keys::api_window(&key_id.0, &reservation.policy_version, start);
            let request_key =
                keys::api_request(&key_id.0, &reservation.policy_version, start, &request_id.0);
            let mut window: ApiUsageWindow =
                tx.read(&window_key).await?.unwrap_or(ApiUsageWindow {
                    v: 3,
                    key_id: key_id.clone(),
                    policy_version: reservation.policy_version.clone(),
                    window_start_ms: start,
                    window_reset_at_ms: reset,
                    committed_requests: 0,
                    reserved_requests: 0,
                    updated_at_ms: now,
                    reservations: BTreeMap::new(),
                });
            validate_window(&window, &reservation)?;
            if let Some(existing) = tx.read::<ApiUsageRequest>(&request_key).await? {
                if !api_row_matches(&existing, &reservation)
                    || existing.state != ApiUsageState::Reserved
                {
                    return Err(unavailable(
                        "api_key_quota_reservation_unavailable",
                        "API key quota request identity is already consumed or conflicts.",
                    ));
                }
                if tx.commit().await? {
                    return Ok(reservation);
                } else {
                    continue;
                }
            }
            let mut reclaimed = false;
            if policy.usage_limit_requests != -1
                && add(window.committed_requests, window.reserved_requests)?
                    >= policy.usage_limit_requests
            {
                let expired: Vec<_> = window
                    .reservations
                    .iter()
                    .filter(|(_, expiry)| **expiry <= now)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in expired {
                    let key = keys::api_request(&key_id.0, &reservation.policy_version, start, &id);
                    let mut row: ApiUsageRequest = tx
                        .read(&key)
                        .await?
                        .ok_or_else(|| invalid("API quota reservation is missing."))?;
                    if row.state != ApiUsageState::Reserved || row.lease_expires_at_ms > now {
                        return Err(invalid("API quota reservation index is malformed."));
                    }
                    row.state = ApiUsageState::Released;
                    row.released_at_ms = Some(now);
                    row.release_reason = Some("lease_expired".to_owned());
                    tx.put(&key, &row, Some(retention(reset, QUOTA_RETENTION_MS)?))?;
                    window.reservations.remove(&id);
                    window.reserved_requests -= 1;
                    reclaimed = true;
                }
                if reclaimed {
                    window.updated_at_ms = now;
                    tx.put(
                        &window_key,
                        &window,
                        Some(retention(reset, QUOTA_RETENTION_MS)?),
                    )?;
                    tx.commit().await?;
                    continue;
                }
                if tx.commit().await? {
                    return Err(quota_error(
                        "API key usage limit exceeded.",
                        "rate_limit_exceeded",
                    ));
                } else {
                    continue;
                }
            }
            let lease = add(now, REQUEST_LEASE_MS)?;
            let row = ApiUsageRequest {
                v: 3,
                key_id: key_id.clone(),
                request_id: request_id.clone(),
                route: route.to_owned(),
                state: ApiUsageState::Reserved,
                reserved_at_ms: now,
                lease_expires_at_ms: lease,
                provider: None,
                dispatched_at_ms: None,
                released_at_ms: None,
                release_reason: None,
                transport_started: false,
            };
            window.reserved_requests = add(window.reserved_requests, 1)?;
            window.reservations.insert(request_id.0.clone(), lease);
            window.updated_at_ms = now;
            let expiry = Some(retention(reset, QUOTA_RETENTION_MS)?);
            tx.put(&request_key, &row, expiry)?;
            tx.put(&window_key, &window, expiry)?;
            if tx.commit().await? {
                return Ok(reservation);
            }
        }
        Err(unavailable(
            "api_key_quota_reservation_unavailable",
            "API key quota ledger changed concurrently.",
        ))
    }

    /// Matches handler deferWhenFull: local compaction/cache paths may finish without quota.
    /// The runtime must resolve this handle immediately before its first provider dispatch.
    pub async fn reserve_api_key_deferred(
        &self,
        key_id: &ApiKeyId,
        request_id: &RequestId,
        route: &str,
        now: i64,
    ) -> Result<ApiReservation, GatewayError> {
        match self.reserve_api_key(key_id, request_id, route, now).await {
            Ok(reservation) => Ok(reservation),
            Err(error) if error.status == 429 => {
                for _ in 0..5 {
                    let mut tx = self.transaction(now)?;
                    let policy: ApiKeyPolicy = tx
                        .read_source_control(&keys::api_policy(&key_id.0))
                        .await?
                        .ok_or_else(|| {
                            unavailable(
                                "api_key_quota_reservation_unavailable",
                                "API policy is missing.",
                            )
                        })?;
                    policy.validate(key_id, now)?;
                    let (start, reset) = policy.current_window(now)?;
                    let reservation = ApiReservation {
                        key_id: key_id.clone(),
                        request_id: request_id.clone(),
                        route: route.to_owned(),
                        policy_version: format!("v3:{}", policy.window_ms),
                        window_start_ms: start,
                        window_reset_at_ms: reset,
                        deferred: true,
                    };
                    if tx.commit().await? {
                        return Ok(reservation);
                    }
                }
                Err(unavailable(
                    "api_key_quota_reservation_unavailable",
                    "Deferred API policy changed concurrently.",
                ))
            }
            Err(error) => Err(error),
        }
    }

    pub async fn resolve_deferred_api(
        &self,
        reservation: &ApiReservation,
        now: i64,
    ) -> Result<ApiReservation, GatewayError> {
        if reservation.deferred {
            self.reserve_api_key(
                &reservation.key_id,
                &reservation.request_id,
                &reservation.route,
                now,
            )
            .await
        } else {
            Ok(reservation.clone())
        }
    }

    /// Returns true only for this reservation's first charge; all retries share that charge.
    pub async fn dispatch_api_key(
        &self,
        reservation: &ApiReservation,
        provider: UpstreamProvider,
        now: i64,
    ) -> Result<bool, GatewayError> {
        if reservation.deferred {
            return Err(unavailable(
                "api_key_quota_reservation_unavailable",
                "Resolve deferred API admission before provider dispatch.",
            ));
        }
        for _ in 0..5 {
            let mut tx = self.transaction(now)?;
            let request_key = keys::api_request(
                &reservation.key_id.0,
                &reservation.policy_version,
                reservation.window_start_ms,
                &reservation.request_id.0,
            );
            let window_key = keys::api_window(
                &reservation.key_id.0,
                &reservation.policy_version,
                reservation.window_start_ms,
            );
            let mut row: ApiUsageRequest = tx.read(&request_key).await?.ok_or_else(|| {
                unavailable(
                    "api_key_quota_reservation_unavailable",
                    "API key reservation is missing.",
                )
            })?;
            if !api_row_matches(&row, reservation) || row.state == ApiUsageState::Released {
                return Err(unavailable(
                    "api_key_quota_reservation_unavailable",
                    "API key reservation is consumed.",
                ));
            }
            if row.state == ApiUsageState::Dispatched {
                if tx.commit().await? {
                    return Ok(false);
                } else {
                    continue;
                }
            }
            let mut window: ApiUsageWindow = tx
                .read(&window_key)
                .await?
                .ok_or_else(|| invalid("API quota aggregate is missing."))?;
            validate_window(&window, reservation)?;
            if window.reserved_requests < 1 || !window.reservations.contains_key(&row.request_id.0)
            {
                return Err(invalid("API quota has no reserved capacity."));
            }
            row.state = ApiUsageState::Dispatched;
            row.provider = Some(provider);
            row.dispatched_at_ms = Some(now);
            window.reserved_requests -= 1;
            window.reservations.remove(&row.request_id.0);
            window.committed_requests = add(window.committed_requests, 1)?;
            window.updated_at_ms = now;
            let expiry = Some(retention(
                reservation.window_reset_at_ms,
                QUOTA_RETENTION_MS,
            )?);
            tx.put(&request_key, &row, expiry)?;
            tx.put(&window_key, &window, expiry)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "api_key_quota_reservation_unavailable",
            "API quota dispatch changed concurrently.",
        ))
    }

    pub async fn mark_api_transport_started(
        &self,
        reservation: &ApiReservation,
        now: i64,
    ) -> Result<(), GatewayError> {
        for _ in 0..5 {
            let mut tx = self.transaction(now)?;
            let key = keys::api_request(
                &reservation.key_id.0,
                &reservation.policy_version,
                reservation.window_start_ms,
                &reservation.request_id.0,
            );
            let mut row: ApiUsageRequest = tx
                .read(&key)
                .await?
                .ok_or_else(|| invalid("API dispatch is missing."))?;
            if !api_row_matches(&row, reservation) || row.state != ApiUsageState::Dispatched {
                return Err(invalid("API dispatch is not current."));
            }
            row.transport_started = true;
            tx.put(
                &key,
                &row,
                Some(retention(
                    reservation.window_reset_at_ms,
                    QUOTA_RETENTION_MS,
                )?),
            )?;
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(unavailable(
            "api_key_quota_reservation_unavailable",
            "API dispatch changed concurrently.",
        ))
    }

    pub async fn release_api_key(
        &self,
        reservation: &ApiReservation,
        known_before_transport: bool,
        reason: &str,
        now: i64,
    ) -> Result<bool, GatewayError> {
        self.release_api_key_classified(reservation, known_before_transport, reason, now)
            .await
            .map_err(crate::local_api_release::ReleaseFailure::into_diagnostic)
    }
    pub(crate) async fn release_api_key_classified(
        &self,
        reservation: &ApiReservation,
        known_before_transport: bool,
        reason: &str,
        now: i64,
    ) -> Result<bool, crate::local_api_release::ReleaseFailure> {
        if reservation.deferred {
            return Ok(false);
        }
        for _ in 0..5 {
            let mut tx = self
                .transaction(now)
                .map_err(crate::local_api_release::ReleaseFailure::unavailable)?;
            let request_key = keys::api_request(
                &reservation.key_id.0,
                &reservation.policy_version,
                reservation.window_start_ms,
                &reservation.request_id.0,
            );
            let window_key = keys::api_window(
                &reservation.key_id.0,
                &reservation.policy_version,
                reservation.window_start_ms,
            );
            let Some(mut row) = tx
                .read_api_release::<ApiUsageRequest>(&request_key)
                .await
                .map_err(classify_release_read)?
            else {
                return Ok(false);
            };
            if !api_row_matches(&row, reservation) {
                return Err(crate::local_api_release::ReleaseFailure::malformed(
                    invalid("API release identity conflicts."),
                ));
            }
            if row.state == ApiUsageState::Released
                || (row.state == ApiUsageState::Dispatched
                    && (!known_before_transport || row.transport_started))
            {
                return Ok(false);
            }
            let mut window: ApiUsageWindow = tx
                .read_api_release(&window_key)
                .await
                .map_err(classify_release_read)?
                .ok_or_else(|| {
                    crate::local_api_release::ReleaseFailure::malformed(invalid(
                        "API quota aggregate is missing.",
                    ))
                })?;
            validate_window(&window, reservation)
                .map_err(crate::local_api_release::ReleaseFailure::malformed)?;
            if row.state == ApiUsageState::Reserved {
                if window.reserved_requests < 1
                    || window.reservations.remove(&row.request_id.0).is_none()
                {
                    return Err(crate::local_api_release::ReleaseFailure::malformed(
                        invalid("Missing API reservation capacity."),
                    ));
                }
                window.reserved_requests -= 1;
            } else {
                if window.committed_requests < 1 {
                    return Err(crate::local_api_release::ReleaseFailure::malformed(
                        invalid("Missing API committed capacity."),
                    ));
                }
                window.committed_requests -= 1;
            }
            row.state = ApiUsageState::Released;
            row.provider = None;
            row.dispatched_at_ms = None;
            row.released_at_ms = Some(now);
            row.release_reason = Some(reason.chars().take(120).collect());
            window.updated_at_ms = now;
            let expiry = Some(
                retention(reservation.window_reset_at_ms, QUOTA_RETENTION_MS)
                    .map_err(crate::local_api_release::ReleaseFailure::unavailable)?,
            );
            tx.put(&request_key, &row, expiry)
                .map_err(crate::local_api_release::ReleaseFailure::unavailable)?;
            tx.put(&window_key, &window, expiry)
                .map_err(crate::local_api_release::ReleaseFailure::unavailable)?;
            if tx
                .commit()
                .await
                .map_err(crate::local_api_release::ReleaseFailure::unavailable)?
            {
                return Ok(true);
            }
        }
        Err(crate::local_api_release::ReleaseFailure::changed(
            unavailable(
                "api_key_quota_reservation_unavailable",
                "API quota release changed concurrently.",
            ),
        ))
    }
}

pub use crate::kernel::{
    KernelDefaults, KernelPolicy, KernelReservation, KernelTerminal, KernelWindow,
};

fn classify_release_read(
    error: crate::store::ApiReleaseReadError,
) -> crate::local_api_release::ReleaseFailure {
    match error {
        crate::store::ApiReleaseReadError::Backend(error) => {
            crate::local_api_release::ReleaseFailure::unavailable(error)
        }
        crate::store::ApiReleaseReadError::Record(error) => {
            crate::local_api_release::ReleaseFailure::malformed(error)
        }
    }
}
