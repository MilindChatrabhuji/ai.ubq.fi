//! Same index predicates, with native-private independent cursor lookups.
use super::*;
use crate::native_spool::{Spool, Writer};
use std::collections::BTreeSet;
use std::path::Path;
type BoundRows = (Spool<Row>, Vec<(RecordKey, StoredRecord)>);
pub(crate) fn bind_spooled(
    rows: &Spool<Row>,
    now: i64,
    revision: &str,
    path: &Path,
) -> Result<BoundRows, GatewayError> {
    let mut output = Writer::create(path)?;
    let mut snapshot = BTreeMap::new();
    for index in 0..rows.len() {
        if rows.live(index, now) {
            snapshot.insert(rows.key(index)?.to_owned(), index);
        }
    }
    // One persistent directed reader for coupled-key lookups, never one open per row.
    let mut references = rows.reader()?;
    let mut get = |key: &str| -> Result<Option<StoredRecord>, GatewayError> {
        snapshot
            .get(key)
            .map(|i| references.read(*i).map(|row| row.record))
            .transpose()
    };
    let mut paid_limits = BTreeMap::new();
    let mut source_paid_windows = BTreeSet::new();
    for key in snapshot.keys() {
        let p = parts(&RecordKey(key.clone()))?;
        if starts(&p, &["ubq_ai", "api_keys", "id"]) {
            let record: gateway_admin::keys::ApiKeyRecord = decode(
                get(key)?
                    .ok_or_else(|| invalid("API key ID row is missing"))?
                    .json_value()?,
            )?;
            paid_limits.insert(
                record.policy.id,
                record.policy.paid_fallback_limit_microcredits,
            );
        } else if starts(&p, &["uos_ai", "paid_fallback", "v3", "window"]) {
            source_paid_windows.insert(key.clone());
        }
    }
    let mut derived = Vec::new();
    let mut defaults = KernelDefaults::default();
    let mut explicit_defaults = false;
    if let Some(row) = get(&key(json!(["default", "kernel_policy_limit_requests"])).0)? {
        defaults.usage_limit_requests =
            gateway_admin_runtime::parse::limit(row.json_value()?).unwrap_or(-1);
        explicit_defaults = true;
    }
    if let Some(row) = get(&key(json!(["default", "kernel_policy_window_ms"])).0)? {
        defaults.window_ms =
            gateway_admin_runtime::parse::positive(row.json_value()?).unwrap_or(604800000);
        explicit_defaults = true;
    }
    if explicit_defaults {
        derived.push((
            keys::kernel_defaults(),
            StoredRecord::json(revision, json(&defaults)?, None),
        ));
    }
    // The raw source pool and the authority routing projection are distinct
    // records. Derive the latter here, inside the same atomic adoption, using
    // the canonical account identities and the exact retained source revision.
    if let Some(source) = get(&gateway_auth::provider_credentials::codex_source_pool_key().0)? {
        let pool =
            gateway_auth::provider_credentials::parse_codex_source_pool(source.json_value()?)?
                .ok_or_else(|| invalid("Source Codex pool is malformed"))?;
        let accounts = pool
            .accounts
            .iter()
            .map(|account| {
                let identity = account.identity();
                gateway_authority::routing::PoolAccount {
                    account_id_hash: identity.routing_account_hash,
                    admin_account_hash: identity.administrative_account_hash,
                    credential_version: identity.credential_version,
                    // Same absent-projection initialization as access publication;
                    // current provider selection is rechecked by the routing reader.
                    enabled: true,
                }
            })
            .collect();
        let normalized = gateway_authority::routing::SubscriptionPool {
            v: 1,
            pool_versionstamp: gateway_core::identity::PoolVersionstamp(source.revision.clone()),
            accounts,
        };
        derived.push((
            keys::pool(),
            StoredRecord::json(revision, json(&normalized)?, None),
        ));
    }
    let mut reader = rows.reader()?;
    let mut index = 0usize;
    while let Some(raw) = reader.next_raw()? {
        let p = parts(&RecordKey(rows.key(index)?.to_owned()))?;
        let live = rows.live(index, now);
        index += 1;
        if !live
            || !(starts(&p, &["ubq_ai", "api_keys"])
                || starts(&p, &["uos_ai", "auth"])
                || starts(&p, &["uos_ai", "api_key_usage"])
                || starts(&p, &["uos_ai", "kernel_quota"])
                || starts(&p, &["uos_ai", "paid_fallback"]))
        {
            continue;
        }
        let row: Row = serde_json::from_slice(&raw)
            .map_err(|_| invalid("Private bound row cannot be decoded"))?;
        (|| -> Result<(), GatewayError> {
            if starts(&row.parts, &["ubq_ai", "api_keys", "id"]) {
                let id: gateway_admin::keys::ApiKeyRecord = decode(row.record.json_value()?)?;
                let hash_key = gateway_auth::api_keys::hash_key(&id.hash);
                let hash =
                    get(&hash_key.0)?.ok_or_else(|| invalid("API key hash index is missing"))?;
                let hash: gateway_auth::api_keys::ApiKeyHashRecord = decode(hash.json_value()?)?;
                if hash != id.policy {
                    return Err(invalid("API ID/hash policy pair conflicts"));
                }
                let policy = gateway_admin::keys::authority_policy(&id, now);
                derived.push((
                    keys::api_policy(&id.policy.id),
                    StoredRecord::json(revision, json(&policy)?, None),
                ));
            } else if starts(&row.parts, &["ubq_ai", "api_keys", "hash"]) {
                let hash: gateway_auth::api_keys::ApiKeyHashRecord =
                    decode(row.record.json_value()?)?;
                let id = get(&gateway_auth::api_keys::id_key(&hash.id).0)?
                    .ok_or_else(|| invalid("Orphan API hash index"))?;
                if id.json_value()?["hash"] != row.parts[3] {
                    return Err(invalid("API hash names another ID"));
                }
            } else if starts(&row.parts, &["uos_ai", "auth", "users"]) {
                let user: PasskeyUser = decode(row.record.json_value()?)?;
                let handle = get(&gateway_auth::passkeys::key("handles", &user.handle).0)?;
                if handle
                    .as_ref()
                    .map(|r| r.json_value())
                    .transpose()?
                    .and_then(Value::as_str)
                    != Some(user.id.as_str())
                {
                    return Err(invalid("Passkey handle index conflicts"));
                }
                for id in &user.credential_ids {
                    let credential = get(&gateway_auth::passkeys::key("credentials", id).0)?
                        .ok_or_else(|| invalid("Passkey credential index missing"))?;
                    let credential: PasskeyCredential = decode(credential.json_value()?)?;
                    if credential.user_id != user.id {
                        return Err(invalid("Passkey credential belongs to another user"));
                    }
                }
            } else if starts(&row.parts, &["uos_ai", "auth", "credentials"]) {
                let credential: PasskeyCredential = decode(row.record.json_value()?)?;
                let user = get(&gateway_auth::passkeys::key("users", &credential.user_id).0)?
                    .ok_or_else(|| invalid("Passkey credential owner missing"))?;
                let user: PasskeyUser = decode(user.json_value()?)?;
                if !user.credential_ids.contains(&credential.credential_id) {
                    return Err(invalid("Passkey user omits credential index"));
                }
            } else if starts(&row.parts, &["uos_ai", "auth", "sessions"]) {
                let session: gateway_auth::passkeys::PasskeySession =
                    decode(row.record.json_value()?)?;
                derived.push((
                    gateway_auth::session_index::index_key(&gateway_auth::session_index::digest(
                        &session.token,
                    ))?,
                    gateway_auth::session_index::record_for_session(
                        &session,
                        &row.record.revision,
                        row.record.expires_at_ms,
                    )?,
                ));
            }
            Ok(())
        })()?;
    }
    reader.verify_end()?;
    let mut api: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    let mut kernel: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    let mut paid: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut paid_accounting = BTreeMap::new();
    let mut pending = BTreeMap::new();
    let mut reader = rows.reader()?;
    let mut index = 0usize;
    while let Some(raw) = reader.next_raw()? {
        let p = parts(&RecordKey(rows.key(index)?.to_owned()))?;
        let live = rows.live(index, now);
        index += 1;
        if !live
            || !(starts(&p, &["ubq_ai", "api_keys"])
                || starts(&p, &["uos_ai", "auth"])
                || starts(&p, &["uos_ai", "api_key_usage"])
                || starts(&p, &["uos_ai", "kernel_quota"])
                || starts(&p, &["uos_ai", "paid_fallback"]))
        {
            continue;
        }
        let row: Row = serde_json::from_slice(&raw)
            .map_err(|_| invalid("Private bound row cannot be decoded"))?;
        (|| -> Result<(), GatewayError> {
            match row.mapping.transform {
                Transform::ApiRequest => {
                    let request: ApiUsageRequest = decode(row.record.json_value()?)?;
                    if request.state == ApiUsageState::Reserved {
                        let start = row.parts[6]
                            .as_f64()
                            .ok_or_else(|| invalid("API window tuple start missing"))?
                            as i64;
                        let window = keys::api_window(
                            &request.key_id.0,
                            row.parts[5]
                                .as_str()
                                .ok_or_else(|| invalid("API policy version missing"))?,
                            start,
                        );
                        if !snapshot.contains_key(&window.0) {
                            return Err(invalid("API request window missing"));
                        }
                        api.entry(window.0)
                            .or_default()
                            .insert(request.request_id.0, request.lease_expires_at_ms);
                    }
                }
                Transform::KernelRequest => {
                    let request: KernelReservation = decode(row.record.json_value()?)?;
                    let expected = keys::kernel_request(
                        &request.owner,
                        request.repo.as_deref(),
                        request.window_created_at_ms,
                        &request.request_id.0,
                    );
                    if expected != row.key {
                        return Err(invalid("Kernel request tuple/identity conflict"));
                    }
                    if request.state.is_none() {
                        let window = keys::kernel_window(&request.owner, request.repo.as_deref());
                        let source = get(&window.0)?
                            .ok_or_else(|| invalid("Kernel request window missing"))?;
                        let source = source.json_value()?;
                        if decode::<i64>(&source["created_at_ms"])? != request.window_created_at_ms
                            || decode::<i64>(&source["usage_reset_at_ms"])?
                                != request.window_reset_at_ms
                        {
                            return Err(invalid("Kernel reservation belongs to another window"));
                        }
                        kernel
                            .entry(window.0)
                            .or_default()
                            .insert(request.request_id.0, request.lease_expires_at_ms);
                    }
                }
                Transform::PaidRequest => {
                    let attempt =
                        gateway_authority::paid::decode_paid_attempt_record(&row.key, &row.record)?;
                    if attempt.reservation.window_reset_at_ms > now {
                        account_paid(&mut paid_accounting, &attempt)?;
                    }
                    if crate::projection::outstanding(&attempt) {
                        if !snapshot.contains_key(
                            &keys::paid_pending(
                                &attempt.reservation.key_id.0,
                                &attempt.reservation.attempt_id.0,
                            )
                            .0,
                        ) {
                            return Err(invalid(
                                "Outstanding paid request lacks its persistent pending marker",
                            ));
                        }
                        if paid_limits.get(&attempt.reservation.key_id.0).copied() != Some(-1) {
                            let window = keys::paid_window(
                                &attempt.reservation.key_id.0,
                                attempt.reservation.window_reset_at_ms,
                            );
                            let count = paid.entry(window.0).or_default();
                            count.0 = count
                                .0
                                .checked_add(1)
                                .ok_or_else(|| invalid("Paid pending count overflows"))?;
                            count.1 = count
                                .1
                                .checked_add(attempt.reservation.reserved_microcredits)
                                .ok_or_else(|| invalid("Paid exposure overflows"))?;
                        }
                    }
                }
                Transform::PaidPending => {
                    let marker: PendingPaid = decode(row.record.json_value()?)?;
                    let attempt_key = keys::paid_attempt(&marker.key_id.0, &marker.attempt_id.0);
                    let attempt = get(&attempt_key.0)?.ok_or_else(|| {
                        invalid("Pending paid marker has missing or expired request")
                    })?;
                    let attempt = gateway_authority::paid::decode_paid_attempt_record(
                        &attempt_key,
                        &attempt,
                    )?;
                    if !matches!(
                        attempt.billing_state,
                        BillingState::Pending | BillingState::Unresolved
                    ) {
                        return Err(invalid(
                            "Settled paid request retains conflicting pending marker",
                        ));
                    }
                    pending.insert(
                        json!([marker.key_id.0, marker.attempt_id.0]).to_string(),
                        marker,
                    );
                }
                _ => {}
            }
            Ok(())
        })()?;
    }
    reader.verify_end()?;
    let mut has_gate = false;
    let mut reader = rows.reader()?;
    let mut index = 0usize;
    while let Some(raw) = reader.next_raw()? {
        let key = rows.key(index)?.to_owned();
        let p = parts(&RecordKey(key.clone()))?;
        let transform = rows.transform(index);
        let expiry = rows.expiry(index);
        let live = rows.live(index, now);
        index += 1;
        if !live
            || !(matches!(
                transform,
                Some(Transform::ApiWindow | Transform::KernelWindow | Transform::PaidGate)
            ) || starts(&p, &["uos_ai", "paid_fallback", "v3", "window"]))
        {
            output.push_frame(&raw, Some(key), expiry, transform)?;
            continue;
        }
        let mut row: Row = serde_json::from_slice(&raw)
            .map_err(|_| invalid("Private bound row cannot be decoded"))?;
        (|| -> Result<(), GatewayError> {
            match row.mapping.transform {
                Transform::ApiWindow => {
                    let mut window: ApiUsageWindow = decode(row.record.json_value()?)?;
                    window.reservations = api.remove(&row.key.0).unwrap_or_default();
                    if window.reserved_requests != window.reservations.len() as i64 {
                        return Err(invalid("API reserved aggregate lacks exact source rows"));
                    }
                    row.record.value = json(&window)?;
                }
                Transform::KernelWindow => {
                    let reservations = kernel.remove(&row.key.0).unwrap_or_default();
                    let mut bound = row.record.json_value()?.clone();
                    bound["reservations"] = json(&reservations)?;
                    let window: KernelWindow = decode(&bound)?;
                    if keys::kernel_window(&window.owner, window.repo.as_deref()) != row.key {
                        return Err(invalid("Kernel window tuple identity conflict"));
                    }
                    if window.reserved_requests != window.reservations.len() as i64 {
                        return Err(invalid("Kernel reserved aggregate lacks exact source rows"));
                    }
                    // Preserve source-only fields for m12/source admin readers and the inverse.
                    row.record.value["reservations"] = json(&window.reservations)?;
                }
                Transform::PaidGate => {
                    has_gate = true;
                    let old: ReconciliationGate = decode(row.record.json_value()?)?;
                    let minimum = pending.values().map(|p| p.next_reconciliation_at_ms).min();
                    let next = match (old.next_due_at_ms, minimum) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                    row.record.value = json(&ReconciliationGate {
                        next_due_at_ms: next,
                        pending: pending.clone(),
                    })?;
                }
                _ => {
                    if starts(&row.parts, &["uos_ai", "paid_fallback", "v3", "window"]) {
                        let window: PaidWindow = decode(row.record.json_value()?)?;
                        let (count, exposure) = paid.remove(&row.key.0).unwrap_or_default();
                        if count != window.pending_count || exposure != window.reserved_microcredits
                        {
                            return Err(invalid(
                                "Paid window outstanding count/exposure conflicts with imported requests",
                            ));
                        }
                    }
                }
            }
            output.push(&row)?;
            Ok(())
        })()?;
    }
    reader.verify_end()?;
    for ((key_id, reset_at_ms), accounting) in paid_accounting {
        if accounting.settled_microcredits == 0
            && accounting.reserved_microcredits == 0
            && accounting.pending_count == 0
        {
            continue;
        }
        let window_key = keys::paid_window(&key_id, reset_at_ms).0;
        if source_paid_windows.contains(&window_key) {
            continue;
        }
        let limit_microcredits = paid_limits
            .get(&key_id)
            .copied()
            .ok_or_else(|| invalid("Paid accounting key is missing"))?;
        derived.push(derive_paid_window(
            &key_id,
            reset_at_ms,
            limit_microcredits,
            &accounting,
            revision,
        )?);
        paid.remove(&window_key);
    }
    if !api.is_empty() || !kernel.is_empty() || !paid.is_empty() {
        return Err(invalid("Reservation index has an orphan window"));
    }
    if !has_gate && !pending.is_empty() {
        let gate = ReconciliationGate {
            next_due_at_ms: pending.values().map(|p| p.next_reconciliation_at_ms).min(),
            pending,
        };
        derived.push((
            keys::paid_gate(),
            StoredRecord::json(revision, json(&gate)?, None),
        ));
    }
    Ok((output.seal()?, derived))
}
