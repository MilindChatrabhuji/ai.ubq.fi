//! Latest native logical state; original VM bytes are never replayed as new state.
use crate::native_capture::NativeKind;
use crate::*;
use gateway_core::{
    query::QueryStore,
    value::{PortableValue, ValueEncoding},
};

pub(crate) fn current_value(row: &crate::inverse::LatestRow) -> Result<NativeValue, GatewayError> {
    if row.record.value_encoding == ValueEncoding::SourceGraphV1 {
        return Ok(NativeValue::SourceGraphV1(
            crate::graph_transport::to_source_graph(&row.record.source_graph_value()?)?,
        ));
    }
    let transform = row
        .mapping
        .as_ref()
        .map(|m| m.transform)
        .unwrap_or(crate::inverse::transform_for_new(&parts(&row.key)?));
    let value = crate::inverse::inverse_value_for_key(
        transform,
        &row.key,
        &row.record,
        row.mapping.as_ref().map(|m| &m.source),
    )?;
    if let PortableValue::KvU64(value) = &value {
        let value = value
            .parse::<u64>()
            .map_err(|_| invalid("Current native counter is malformed"))?;
        return Ok(NativeValue::CounterLe64(value.to_le_bytes().to_vec()));
    }
    let origin = row.mapping.as_ref().and_then(|m| m.native_origin.as_ref());
    if origin.is_none_or(|o| matches!(o.kind, NativeKind::Bytes))
        && let PortableValue::Binary {
            kind,
            bytes,
            byte_offset,
            byte_length,
        } = &value
        && kind == "Uint8Array"
        && *byte_offset == 0
        && *byte_length == bytes.len() as u64
    {
        return Ok(NativeValue::Bytes(bytes.clone()));
    }
    Ok(NativeValue::SourceGraphV1(
        crate::graph_transport::to_source_graph(&crate::graph_tree::from_tree(&value)?)?,
    ))
}

pub(crate) async fn export<S: QueryStore>(
    store: &S,
    now_ms: i64,
) -> Result<(NativeCapture, Vec<CustodyRecord>), MigrationError> {
    let (manifest, rows, controls) = crate::inverse::export_rows(store, now_ms).await?;
    let old = manifest
        .native_revision
        .ok_or_else(|| unavailable("An ordinary profile capture has no native revision custody"))?;
    let (version, _) = old.numbers()?;
    let mut changed = rows.len() != manifest.source_rows;
    let mut next_sequence = 0i64;
    let mut entries = Vec::new();
    for row in rows {
        let original = row.mapping.as_ref().and_then(|m| m.native_origin.as_ref());
        let unchanged = if let (Some(mapping), Some(origin)) = (&row.mapping, original) {
            row.record.revision == origin.revision.record_revision()?
                && digest(&row.record)? == mapping.baseline_digest
        } else {
            false
        };
        let revision = if unchanged {
            original.expect("checked native origin").revision.clone()
        } else {
            changed = true;
            let version = version
                .checked_add(1)
                .ok_or_else(|| invalid("Latest native inverse revision overflows SQLite"))?;
            let revision = NativeRevision {
                version: version.to_string(),
                sequence: next_sequence.to_string(),
            };
            next_sequence = next_sequence
                .checked_add(1)
                .ok_or_else(|| invalid("Latest native inverse sequence overflows SQLite"))?;
            revision
        };
        entries.push(NativeEntry {
            raw_key: TupleKey::from_record_key(&row.key)?.sort_bytes().to_vec(),
            value: current_value(&row)?,
            revision,
            expiration_ms: row.record.expires_at_ms.unwrap_or(-1),
        });
    }
    let data_revision = if changed {
        NativeRevision {
            version: version
                .checked_add(1)
                .ok_or_else(|| invalid("Latest native inverse revision overflows SQLite"))?
                .to_string(),
            sequence: (next_sequence - 1).max(0).to_string(),
        }
    } else {
        old
    };
    let capture = NativeCapture {
        v: 2,
        source_git_sha: manifest.source_git_sha,
        captured_at_ms: now_ms,
        source_codec: "bun-jsc-v1".into(),
        native_schema_version: 3,
        data_revision,
        queue_entries: 0,
        running_queue_entries: 0,
        entries,
    };
    prepare_native(&capture)?;
    Ok((capture, controls))
}

pub async fn export_native_latest<S: QueryStore>(
    store: &S,
    now_ms: i64,
) -> Result<NativeCapture, MigrationError> {
    let (capture, controls) = export(store, now_ms).await?;
    if !controls.is_empty() {
        return Err(MigrationError::from(GatewayError::unavailable(
            "Native latest inverse requires separate current Rust control custody",
            "migration_control_custody_required",
        )));
    }
    Ok(capture)
}

#[derive(Clone, Serialize)]
pub struct NativeRollbackBundle {
    pub v: u32,
    pub source: NativeCapture,
    pub rust_controls: Vec<CustodyRecord>,
    pub artifacts: ArtifactContext,
}
pub async fn export_native_rollback_bundle<S: QueryStore>(
    store: &S,
    now_ms: i64,
    artifacts: ArtifactContext,
) -> Result<NativeRollbackBundle, MigrationError> {
    crate::inverse::validate_artifacts(&artifacts)?;
    let (source, rust_controls) = export(store, now_ms).await?;
    Ok(NativeRollbackBundle {
        v: 2,
        source,
        rust_controls,
        artifacts,
    })
}
