//! Existing public profile import, distinct from stopped complete-state adoption.
use crate::*;
use gateway_admin_data::{
    migration::{self, ImportOptions, NormalizedEntry, Profile},
    profile::{SourceDateHost, normalize_source_import_line_with_host},
};
use gateway_admin_runtime::capabilities::{Context, MigrationProfile, MigrationRequest};
use gateway_auth::AuthResponse;
use gateway_core::{
    query::QueryStore,
    state::{AtomicTransition, CommitOutcome, RecordMutation, RevisionCheck},
    value::PortableValue,
};
use serde::Serialize;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

pub trait ProfileHost: SourceDateHost {
    /// Constructor-owned fresh storage revision, never a caller-supplied proof.
    fn next_revision(&self) -> Result<String, GatewayError>;
}

#[derive(Default, Serialize)]
struct Counters {
    total: usize,
    imported: usize,
    skipped: usize,
    optional: usize,
    errors: usize,
}

pub async fn execute_profile<S: QueryStore, H: ProfileHost>(
    store: &S,
    host: &H,
    request: MigrationRequest,
    context: Context,
) -> Result<AuthResponse, GatewayError> {
    if !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&context.now_ms) {
        return Err(invalid("Profile migration clock is invalid"));
    }
    let MigrationRequest::Import(input) = request else {
        return crate::profile_validate::validate(store, context.now_ms).await;
    };
    if input.ndjson.len() > 5 * 1024 * 1024 {
        return Err(GatewayError::new(
            413,
            "Migration body is too large",
            Some("invalid_request_error"),
        ));
    }
    let options = ImportOptions {
        profile: match input.profile {
            MigrationProfile::Local => Profile::Local,
            MigrationProfile::Prod => Profile::Prod,
        },
        include_cache: input.include_cache,
        include_legacy: input.include_legacy,
        overwrite: input.overwrite,
        dry_run: input.dry_run,
    };
    let mut counters = Counters::default();
    let mut groups = BTreeMap::<String, usize>::new();
    let mut kernel_windows = BTreeSet::new();
    for line in input
        .ndjson
        .split('\n')
        .filter(|line| !gateway_schema::util::js_trim(line).is_empty())
    {
        counters.total += 1;
        match import_line(
            store,
            host,
            line,
            &options,
            context.now_ms,
            &mut groups,
            &mut kernel_windows,
        )
        .await
        {
            Ok("imported") => counters.imported += 1,
            Ok("optional") => counters.optional += 1,
            Ok(_) => counters.skipped += 1,
            Err(_) => counters.errors += 1,
        }
    }
    if !options.dry_run
        && crate::profile_coupling::finish_kernel(store, host, &kernel_windows, context.now_ms)
            .await
            .is_err()
    {
        counters.errors += 1;
    }
    let body = json!({"profile":options.profile,"include_cache":options.include_cache,"include_legacy":options.include_legacy,"overwrite":options.overwrite,"dry_run":options.dry_run,"total":counters.total,"imported":counters.imported,"skipped":counters.skipped,"optional":counters.optional,"errors":counters.errors,"groups":groups});
    Ok(AuthResponse::json(
        if counters.errors > 0 { 422 } else { 200 },
        body,
    ))
}

async fn import_line<S: QueryStore, H: ProfileHost>(
    store: &S,
    host: &H,
    line: &str,
    options: &ImportOptions,
    now: i64,
    groups: &mut BTreeMap<String, usize>,
    kernel_windows: &mut BTreeSet<String>,
) -> Result<&'static str, GatewayError> {
    let decoded = normalize_source_import_line_with_host(line, host)?
        .ok_or_else(|| invalid("Empty profile row"))?;
    let decision = if starts(&decoded.parts, &["uos_ai", "codex_manual_reset"]) {
        migration::Decision {
            action: "import".into(),
            group: "codex_manual_reset".into(),
            reason: "durable".into(),
        }
    } else {
        migration::classify_key(&decoded.parts, options)
    };
    *groups.entry(decision.group).or_default() += 1;
    if decision.action != "import" {
        return Ok(if decision.action == "optional" {
            "optional"
        } else {
            "skipped"
        });
    }
    // A public profile body cannot establish fixed native custody or carry refresh into Cloudflare.
    if starts(&decoded.parts, &["ubq_ai", "codex_auth"]) {
        let value = decoded
            .value
            .to_json_lossless()
            .ok_or_else(|| invalid("Codex source pool encoding is invalid"))?;
        if value
            .get("accounts")
            .and_then(Value::as_array)
            .is_some_and(|accounts| {
                accounts.iter().any(|a| {
                    a.get("refresh_token")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                })
            })
        {
            return Err(GatewayError::unavailable(
                "Managed source credentials require fixed local native custody preparation",
                "migration_native_custody_required",
            ));
        }
    }
    let existing = store.read(&decoded.key).await?;
    let null = existing.as_ref().is_some_and(|r| {
        r.json_value().is_ok_and(Value::is_null)
            || r.portable_value().is_ok_and(|v| v == PortableValue::Null)
    });
    if !options.overwrite && existing.is_some() && !null {
        return Ok("skipped");
    }
    let entry = NormalizedEntry {
        key: decoded.key,
        parts: decoded.parts,
        value: decoded.value,
        raw: Value::Null,
    };
    // Existing null rows need their actual revision in the CAS; non-null was handled above.
    let mut planning = options.clone();
    planning.dry_run = true;
    let plan = migration::plan_import(&entry, None, &planning, now, "")?;
    if plan.outcome != "imported" && !starts(&entry.parts, &["uos_ai", "codex_manual_reset"]) {
        return Ok("skipped");
    }
    if options.dry_run {
        return Ok("imported");
    }
    let revision = host.next_revision()?;
    let expiry = match migration::retention::migration_expiry(
        &entry.parts,
        &migration::logical_fields(&entry.value),
        now,
    ) {
        migration::retention::Expiry::At(n) => Some(n),
        migration::retention::Expiry::Durable => None,
        migration::retention::Expiry::Skip => return Ok("skipped"),
    };
    let record = crate::native_capture::tree_record(entry.value.clone(), &revision, expiry)?;
    let record = project(&entry.key, &entry.parts, record)?;
    let mut transition = AtomicTransition {
        checks: if options.overwrite {
            vec![]
        } else {
            vec![RevisionCheck {
                key: entry.key.clone(),
                expected_revision: existing.as_ref().map(|r| r.revision.clone()),
            }]
        },
        mutations: vec![RecordMutation::Put {
            key: entry.key.clone(),
            record: record.clone(),
        }],
    };
    crate::profile_bindings::bind(
        store,
        crate::profile_bindings::Write {
            key: &entry.key,
            parts: &entry.parts,
            record: &record,
            previous: existing.as_ref(),
            now,
            revision: &revision,
        },
        &mut transition,
    )
    .await?;
    if store.commit(transition).await? == CommitOutcome::Committed {
        if migration::kernel::identity(&entry.parts, "window").is_some() {
            kernel_windows.insert(entry.key.0);
        }
        Ok("imported")
    } else {
        Ok("skipped")
    }
}

pub(crate) fn project(
    key: &RecordKey,
    parts: &[Value],
    record: StoredRecord,
) -> Result<StoredRecord, GatewayError> {
    let original = record.clone();
    let mut row = Row {
        key: key.clone(),
        parts: parts.to_vec(),
        record,
        mapping: Mapping {
            source: SourceEntry {
                key: vec![],
                value: SourceJson::parse("null")?,
                versionstamp: original.revision.clone(),
                expires_at_ms: original.expires_at_ms,
            },
            transform: Transform::Identity,
            baseline_digest: String::new(),
            native_origin: None,
        },
    };
    // Source import accepts parsed malformed business data. Retain it explicitly;
    // consumers fail closed and the separate source validation reports its errors.
    if crate::projection::forward(&mut row).is_err() {
        return Ok(original);
    }
    Ok(row.record)
}
