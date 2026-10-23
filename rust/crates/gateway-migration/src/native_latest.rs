//! Native-private latest state, one genuine row at a time; no store mirror.
use crate::engine::{Manifest, manifest_key, mapping_key};
use crate::native_spool::Writer;
use crate::staged::CanonicalRecord;
use crate::*;
use gateway_core::query::{QueryRequest, QuerySelector, QueryStore};
use serde_json::json;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
mod native_import;
const LATEST_QUERY_PAGE: u32 = 256;
pub(super) struct DiskMap {
    reader: RefCell<crate::native_spool::Reader<CanonicalRecord>>,
    index: BTreeMap<String, usize>,
}
impl DiskMap {
    fn get(&self, key: &str) -> Result<Option<StoredRecord>, GatewayError> {
        self.index
            .get(key)
            .map(|index| self.reader.borrow_mut().read(*index).map(|row| row.record))
            .transpose()
    }
    fn required(&self, key: &str) -> Result<StoredRecord, GatewayError> {
        self.get(key)?
            .ok_or_else(|| invalid("Current inverse record is missing"))
    }
}
async fn collect<S: QueryStore>(
    store: &S,
    now_ms: i64,
    directory: &Path,
) -> Result<DiskMap, GatewayError> {
    let mut writer = Writer::create(&directory.join("current-common.spool"))?;
    let mut index = BTreeMap::new();
    let mut ordinal = 0;
    let mut cursor = None;
    let mut seen = BTreeSet::new();
    loop {
        let page = store
            .query(QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix: TupleKey::from_parts(&[])?.to_record_key(),
                    start: None,
                    end: None,
                },
                reverse: false,
                // Bounded pages, not one store RPC per row. The private wire
                // remains capped independently by the transport.
                limit: LATEST_QUERY_PAGE,
                cursor: cursor.clone(),
                now_ms,
            })
            .await?;
        for entry in page.entries {
            if index.insert(entry.key.0.clone(), ordinal).is_some() {
                return Err(invalid("Inverse query repeated a source key"));
            }
            writer.push(&CanonicalRecord {
                key: entry.key,
                record: entry.record,
            })?;
            ordinal += 1;
        }
        cursor = page.next_cursor;
        if let Some(c) = &cursor {
            if !seen.insert(c.clone()) {
                return Err(invalid("Inverse query cursor loop"));
            }
        } else {
            break;
        }
    }
    let rows = writer.seal()?;
    Ok(DiskMap {
        reader: RefCell::new(rows.reader()?),
        index,
    })
}
fn validate_routing(all: &DiskMap) -> Result<(), GatewayError> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for name in all.index.keys() {
        let p = parts(&RecordKey(name.clone()))?;
        if starts(&p, &["uos_ai", "routing_runtime"]) {
            let id = p.get(4).map(Value::to_string).unwrap_or_default();
            groups.entry(id).or_default().push(name.clone());
        }
    }
    // Complete key grouping retains every original row and duplicate refusal;
    // the existing validator compares each actual session/pending pair in full.
    for names in groups.values() {
        let rows = names
            .iter()
            .map(|name| Ok((RecordKey(name.clone()), all.required(name)?)))
            .collect::<Result<Vec<_>, GatewayError>>()?;
        gateway_routing_runtime::custody::validate_journal_rows(
            rows.iter().map(|(key, record)| (key, record)),
        )?;
    }
    Ok(())
}
type LatestInventory = (
    Manifest,
    Vec<(RecordKey, Option<String>)>,
    Vec<String>,
    BTreeSet<String>,
);
fn validate(
    all: &DiskMap,
    manifest: Manifest,
    now_ms: i64,
) -> Result<LatestInventory, GatewayError> {
    let mapping_prefix = key(json!([
        "uos_ai",
        "migration",
        "v3",
        "row",
        manifest.capture_id
    ]));
    let prefix = TupleKey::from_record_key(&mapping_prefix)?;
    let mut mapping_digests = Vec::new();
    for name in all.index.keys() {
        let tuple = TupleKey::from_record_key(&RecordKey(name.clone()))?;
        if tuple.is_strict_descendant_of(&prefix) {
            mapping_digests.push((name.clone(), digest(&all.required(name)?)?));
        }
    }
    if mapping_digests.len() != manifest.source_rows
        || gateway_auth::crypto::sha256_hex(
            &serde_json::to_vec(&mapping_digests)
                .map_err(|_| invalid("Mapping checksum cannot be encoded"))?,
        ) != manifest.mapping_checksum
    {
        return Err(invalid("Inverse mapping inventory is missing or modified"));
    }
    validate_routing(all)?;
    let mut entries = Vec::new();
    let mut controls = Vec::new();
    for k in all.index.keys() {
        let key = RecordKey(k.clone());
        let p = parts(&key)?;
        // A legacy reader does not understand pending retirement. Retain the
        // suppressed mapping only in private custody, never as a joinable Bun row.
        if p.len() == 4
            && starts(&p, &["uos_ai", "codex_live_calls", "v1"])
            && all.index.contains_key(
                &crate::key(json!([
                    "uos_ai",
                    "codex_live_calls",
                    "v1",
                    "pending_retirement",
                    p[3]
                ]))
                .0,
            )
        {
            controls.push(k.clone());
            continue;
        }
        if let Some(mapping) = all.get(&mapping_key(&manifest.capture_id, k).0)? {
            let _: Mapping = decode(mapping.json_value()?)?;
            entries.push((key, Some(mapping_key(&manifest.capture_id, k).0)));
            continue;
        }
        if starts(&p, &["uos_ai", "migration"]) {
            continue;
        }
        let current = all.required(k)?;
        let record = &current;
        if starts(&p, &["uos_ai", "native_live"]) {
            record.validate_version()?;
            if p.len() != 5 || p[2] != "v1" || record.expires_at_ms.is_some() {
                return Err(invalid(
                    "Native live custody key or permanent retention is invalid",
                ));
            }
            gateway_authority::native_live::validate_live_custody(
                p[3].as_str()
                    .ok_or_else(|| invalid("Native live custody kind is invalid"))?,
                p[4].as_str()
                    .ok_or_else(|| invalid("Native live custody reference is invalid"))?,
                record.json_value()?,
            )?;
            controls.push(k.clone());
            continue;
        }
        if starts(&p, &["uos_ai", "routing_runtime"]) {
            controls.push(k.clone());
            continue;
        }
        if starts(
            &p,
            &["uos_ai", "codex_live_calls", "v1", "pending_retirement"],
        ) || starts(&p, &["uos_ai", "auth", "session_revision_index"])
        {
            record.validate_version()?;
            if starts(&p, &["uos_ai", "auth", "session_revision_index"]) {
                gateway_auth::session_index::validate_custody_record(&key, record)?;
            }
            if starts(
                &p,
                &["uos_ai", "codex_live_calls", "v1", "pending_retirement"],
            ) {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Retirement {
                    schema_version: u8,
                    call_id: String,
                    upstream_status: u16,
                    created_at_ms: i64,
                }
                let marker: Retirement = decode(record.json_value()?)?;
                if p.len() != 5
                    || p[4] != marker.call_id
                    || marker.schema_version != 1
                    || ![404, 410].contains(&marker.upstream_status)
                    || !(0..=gateway_core::identity::MAX_SAFE_INTEGER)
                        .contains(&marker.created_at_ms)
                    || record.expires_at_ms.is_some()
                {
                    return Err(invalid("Pending live-call retirement custody is malformed"));
                }
            }
            controls.push(k.clone());
            continue;
        }
        if key == gateway_auth::native_replay::native_nonce_key() {
            record.validate_version()?;
            controls.push(k.clone());
            continue;
        }
        if starts(&p, &["uos_ai", "authority", "native_owner_renewal"]) {
            gateway_authority::native_control::validate_native_control_custody(&key, record)?;
            controls.push(k.clone());
            continue;
        }
        if starts(&p, &["uos_ai", "authority"]) {
            if key == gateway_authority::keys::kernel_defaults() {
                let mut expected = gateway_authority::quota::KernelDefaults::default();
                if let Some(source) =
                    all.get(&crate::key(json!(["default", "kernel_policy_limit_requests"])).0)?
                {
                    expected.usage_limit_requests =
                        gateway_admin_runtime::parse::limit(source.json_value()?).unwrap_or(-1);
                }
                if let Some(source) =
                    all.get(&crate::key(json!(["default", "kernel_policy_window_ms"])).0)?
                {
                    expected.window_ms =
                        gateway_admin_runtime::parse::positive(source.json_value()?)
                            .unwrap_or(604800000);
                }
                let actual: gateway_authority::quota::KernelDefaults =
                    decode(record.json_value()?)?;
                if actual != expected {
                    return Err(invalid(
                        "Latest derived Kernel defaults differ from source defaults; inverse would lose policy",
                    ));
                }
            }
            if p.get(3).and_then(Value::as_str) == Some("api_policy") {
                let id = p
                    .get(4)
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("Derived API policy ID is missing"))?;
                let source = all
                    .get(&gateway_auth::api_keys::id_key(id).0)?
                    .ok_or_else(|| invalid("Derived API policy has no source ID"))?;
                let source: gateway_admin::keys::ApiKeyRecord = decode(source.json_value()?)?;
                let mut expected = gateway_admin::keys::authority_policy(&source, now_ms);
                let actual: gateway_authority::quota::ApiKeyPolicy = decode(record.json_value()?)?;
                if source.policy.revoked_at_ms.is_some() && actual.expires_at_ms <= now_ms {
                    expected.expires_at_ms = actual.expires_at_ms;
                }
                if actual != expected {
                    return Err(invalid(
                        "Latest derived API policy differs from the source ID; inverse would lose policy",
                    ));
                }
            }
            if p.get(3).and_then(Value::as_str).is_some_and(|s| {
                [
                    "codex_pool",
                    "paid_routing",
                    "paid_control_owner",
                    "paid_control_config",
                    "paid_control_observation",
                    "codex_reset_config",
                ]
                .contains(&s)
            }) {
                record.validate_version()?;
                controls.push(k.clone());
                continue;
            }
            if p.get(3).and_then(Value::as_str).is_some_and(|s| {
                [
                    "api_policy",
                    "codex_pool",
                    "kernel_defaults",
                    "paid_routing",
                    "paid_control_owner",
                    "paid_control_config",
                    "paid_control_observation",
                    "codex_reset_config",
                ]
                .contains(&s)
            }) {
                continue;
            }
            return Err(unavailable(
                "Unknown normalized authority state cannot be silently omitted from inverse",
            ));
        }
        if let Some(expected) = manifest.derived.get(k)
            && digest(record)? == *expected
        {
            continue;
        }
        if !crate::projection::known(&p) {
            return Err(unavailable(
                "Latest target includes an unmapped source key family",
            ));
        }
        entries.push((key, None));
    }
    native_import::validate(all)?;
    let mapping_keys = mapping_digests.into_iter().map(|(key, _)| key).collect();
    Ok((manifest, entries, controls, mapping_keys))
}

pub(crate) async fn write_latest<
    S: QueryStore,
    H: NativeCustody,
    W: std::io::Write,
    C: std::io::Write,
>(
    store: &S,
    now_ms: i64,
    host: &H,
    artifacts: ArtifactContext,
    source_sink: &mut W,
    custody_sink: &mut C,
) -> Result<usize, MigrationError> {
    write_latest_for_reconciliation(store, now_ms, host, artifacts, source_sink, custody_sink)
        .await
        .map(|(count, _, _)| count)
}

/// Internal composition data, returned only after the same complete latest
/// inverse, mapping checksum, source audit and current-custody path succeeds.
pub(crate) async fn write_latest_for_reconciliation<
    S: QueryStore,
    H: NativeCustody,
    W: std::io::Write,
    C: std::io::Write,
>(
    store: &S,
    now_ms: i64,
    host: &H,
    artifacts: ArtifactContext,
    source_sink: &mut W,
    custody_sink: &mut C,
) -> Result<(usize, Manifest, BTreeSet<String>), MigrationError> {
    crate::inverse::validate_artifacts(&artifacts)?;
    let manifest = store
        .read(&manifest_key())
        .await?
        .ok_or_else(|| invalid("No adopted capture manifest"))?;
    let manifest: Manifest = decode(manifest.json_value()?)?;
    if manifest.v != 4 || now_ms < manifest.captured_at_ms {
        return Err(invalid("Inverse capture clock/version invalid").into());
    }
    let directory = crate::native_stage::directory(&std::env::temp_dir())?;
    let all = collect(store, now_ms, &directory).await?;
    let (manifest, rows, controls, mapping_keys) = validate(&all, manifest, now_ms)?;
    let old = manifest
        .native_revision
        .clone()
        .ok_or_else(|| unavailable("An ordinary profile capture has no native revision custody"))?;
    let (version, _) = old.numbers()?;
    let mut changed = rows.len() != manifest.source_rows;
    let mut sequence = 0i64;
    let mut writer = Writer::create(&directory.join("latest-source.spool"))?;
    for (key, mapping_key) in &rows {
        let record = all.required(&key.0)?;
        let mapping = mapping_key
            .as_ref()
            .map(|key| {
                all.required(key)
                    .and_then(|r| decode::<Mapping>(r.json_value()?))
            })
            .transpose()?;
        let original = mapping.as_ref().and_then(|m| m.native_origin.as_ref());
        let unchanged = if let (Some(mapping), Some(origin)) = (&mapping, original) {
            record.revision == origin.revision.record_revision()?
                && digest(&record)? == mapping.baseline_digest
        } else {
            false
        };
        let revision = if unchanged {
            original.expect("checked native origin").revision.clone()
        } else {
            changed = true;
            let revision = NativeRevision {
                version: version
                    .checked_add(1)
                    .ok_or_else(|| invalid("Latest native inverse revision overflows SQLite"))?
                    .to_string(),
                sequence: sequence.to_string(),
            };
            sequence = sequence
                .checked_add(1)
                .ok_or_else(|| invalid("Latest native inverse sequence overflows SQLite"))?;
            revision
        };
        let row = crate::inverse::LatestRow {
            key: key.clone(),
            record,
            mapping,
        };
        let mut entry = NativeEntry {
            raw_key: TupleKey::from_record_key(key)?.sort_bytes().to_vec(),
            value: crate::native_inverse::current_value(&row)?,
            revision,
            expiration_ms: row.record.expires_at_ms.unwrap_or(-1),
        };
        crate::native_custody::reconstruct_entry(store, &mut entry, host).await?;
        writer.push(&entry)?;
    }
    let data_revision = if changed {
        NativeRevision {
            version: version
                .checked_add(1)
                .ok_or_else(|| invalid("Latest native inverse revision overflows SQLite"))?
                .to_string(),
            sequence: (sequence - 1).max(0).to_string(),
        }
    } else {
        old
    };
    let header = NativeCapture {
        v: 2,
        source_git_sha: manifest.source_git_sha.clone(),
        captured_at_ms: now_ms,
        source_codec: "bun-jsc-v1".into(),
        native_schema_version: 3,
        data_revision,
        queue_entries: 0,
        running_queue_entries: 0,
        entries: vec![],
    };
    let entries = writer.seal()?;
    // The exact complete latest source is audited/re-adoptable before either sink
    // receives payload bytes. Current credentials are verified, never captured grants.
    let count = entries.len();
    let source = crate::native_stage::Captured::from_parts(header.clone(), entries, &directory);
    let candidate = source.replay(&directory);
    let mut validation = candidate.prepare(host).await?;
    while validation.write_next_batch(&mut std::io::sink())? {}
    // Reopen a separately sealed latest native stream (the validated input is retained
    // in its existing private file; this cursor has an independent offset).

    let mut prefix =
        serde_json::to_vec(&header).map_err(|_| invalid("Latest header cannot be encoded"))?;
    if !prefix.ends_with(b"[]}") {
        return Err(invalid("Latest header is malformed").into());
    }
    prefix.truncate(prefix.len() - 3);
    source_sink
        .write_all(&prefix)
        .and_then(|_| source_sink.write_all(b"["))
        .map_err(|_| invalid("Private latest source sink failed"))?;
    let mut first = true;
    source.visit_entries(&mut |entry| {
        if !first {
            source_sink
                .write_all(b",")
                .map_err(|_| invalid("Private latest source sink failed"))?;
        }
        first = false;
        serde_json::to_writer(&mut *source_sink, entry)
            .map_err(|_| invalid("Private latest source sink failed"))
    })?;
    source_sink
        .write_all(b"]}")
        .map_err(|_| invalid("Private latest source sink failed"))?;
    custody_sink
        .write_all(b"{\"rust_controls\":[")
        .map_err(|_| invalid("Private latest custody sink failed"))?;
    for (index, key) in controls.iter().enumerate() {
        if index != 0 {
            custody_sink
                .write_all(b",")
                .map_err(|_| invalid("Private latest custody sink failed"))?;
        }
        serde_json::to_writer(
            &mut *custody_sink,
            &CustodyRecord {
                key: key.clone(),
                record: all.required(key)?,
            },
        )
        .map_err(|_| invalid("Private latest custody sink failed"))?;
    }
    custody_sink
        .write_all(b"],\"artifacts\":")
        .map_err(|_| invalid("Private latest custody sink failed"))?;
    serde_json::to_writer(&mut *custody_sink, &artifacts)
        .map_err(|_| invalid("Private latest custody sink failed"))?;
    custody_sink
        .write_all(b"}")
        .map_err(|_| invalid("Private latest custody sink failed"))?;
    Ok((count, manifest, mapping_keys))
}
