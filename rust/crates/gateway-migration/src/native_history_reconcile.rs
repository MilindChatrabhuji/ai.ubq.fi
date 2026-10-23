//! Native-private candidate data only. No store, custody, publication or replay
//! authority is created by reconciling these immutable stopped inventories.
use crate::engine::Manifest;
use crate::native_stage::Captured;
use crate::{GatewayError, MigrationError, NativeCapture, NativeEntry, RecordKey, invalid};
use gateway_admin_data::migration::{ObservedRow, audit::AuditInventory};
use gateway_core::tuple_key::TupleKey;
use std::collections::{BTreeMap, BTreeSet};

type KeyIndex = BTreeMap<Vec<u8>, usize>;

/// Reconcile complete retained history with a latest inverse. The private caller
/// must obtain `manifest` and `mapping_row_keys` from the actual inverse producer
/// after its complete mapping count/checksum validation. This data-only set
/// and the returned data are not proof of those anchors or current ownership.
///
/// A mapped key missing from latest is deleted. Original keys never imported
/// survive, latest values override, and newly written latest keys are included.
/// Imported keys newer than the original capture may be absent from both inputs.
/// All typed rows and the complete merged inventory are validated before emit.
/// The returned header has no entries; emit receives one genuine row at a time.
/// On callback failure there is no completed result: discard the private partial
/// candidate rather than publishing it. Current controls and nonces stay separate.
pub(crate) fn reconcile(
    original: &Captured,
    latest: &Captured,
    manifest: &Manifest,
    mapping_row_keys: &BTreeSet<String>,
    emit: &mut dyn FnMut(&NativeEntry) -> Result<(), GatewayError>,
) -> Result<NativeCapture, MigrationError> {
    let original_header = original.metadata();
    let latest_header = latest.metadata();
    original_header.validate_header()?;
    let version = latest_header.validate_header()?;
    let latest_revision = latest_header.data_revision.numbers()?;
    let adopted_revision = manifest
        .native_revision
        .as_ref()
        .ok_or_else(|| invalid("History reconciliation requires a native mapping anchor"))?
        .numbers()?;
    if original_header.source_git_sha != latest_header.source_git_sha
        || original_header.source_codec != latest_header.source_codec
        || original_header.native_schema_version != latest_header.native_schema_version
        || latest_header.captured_at_ms < original_header.captured_at_ms
        || latest_revision < original_header.data_revision.numbers()?
        || manifest.v != 4
        || manifest.source_git_sha != latest_header.source_git_sha
        || manifest.captured_at_ms > latest_header.captured_at_ms
        || manifest.source_rows != mapping_row_keys.len()
        || adopted_revision > latest_revision
    {
        return Err(
            invalid("History reconciliation source or latest capture anchor differs").into(),
        );
    }
    for key in mapping_row_keys {
        let parts = crate::parts(&RecordKey(key.clone()))?;
        if parts.len() != 6
            || !crate::starts(
                &parts,
                &["uos_ai", "migration", "v3", "row", &manifest.capture_id],
            )
            || !parts[5].as_str().is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err(
                invalid("History reconciliation mapping capture or row key differs").into(),
            );
        }
    }
    let original_keys = index(original)?;
    let latest_keys = index(latest)?;
    let merged = Merged {
        original,
        latest,
        original_keys,
        latest_keys,
        manifest,
        mapping_row_keys,
        version,
        now_ms: latest_header.captured_at_ms,
    };
    let audit = gateway_admin_data::migration::audit::inspect_inventory(
        &merged,
        latest_header.captured_at_ms,
    )?;
    if !audit.errors.is_empty() {
        return Err(MigrationError::SourceInventory(audit));
    }
    merged.visit_entries(emit)?;
    Ok(latest_header.clone())
}

fn index(capture: &Captured) -> Result<KeyIndex, GatewayError> {
    let version = capture.metadata().validate_header()?;
    let mut keys = BTreeMap::new();
    let mut ordinal = 0usize;
    capture.visit_entries(&mut |entry| {
        // Even deleted, overwritten and expired rows retain the complete native
        // typed validator. The index stores no graph or other value payload.
        crate::native_capture::validate_entry(entry, version)?;
        if keys.insert(entry.raw_key.clone(), ordinal).is_some() {
            return Err(invalid("History reconciliation source key is duplicated"));
        }
        ordinal = ordinal
            .checked_add(1)
            .ok_or_else(|| invalid("History reconciliation row count overflows"))?;
        Ok(())
    })?;
    if ordinal != capture.count() {
        return Err(invalid("History reconciliation source inventory changed"));
    }
    Ok(keys)
}

struct Merged<'a> {
    original: &'a Captured,
    latest: &'a Captured,
    original_keys: KeyIndex,
    latest_keys: KeyIndex,
    manifest: &'a Manifest,
    mapping_row_keys: &'a BTreeSet<String>,
    version: i64,
    now_ms: i64,
}
impl Merged<'_> {
    fn visit_entries(
        &self,
        emit: &mut dyn FnMut(&NativeEntry) -> Result<(), GatewayError>,
    ) -> Result<(), GatewayError> {
        let mut latest_reader = self.latest.reader()?;
        let result = self.original.visit_entries(&mut |entry| {
            if let Some(ordinal) = self.latest_keys.get(&entry.raw_key) {
                let current = latest_reader.read(*ordinal)?;
                if current.raw_key != entry.raw_key {
                    return Err(invalid(
                        "History reconciliation latest row identity changed",
                    ));
                }
                emit(&current)?;
            } else {
                let key = TupleKey::from_sort_bytes(entry.raw_key.clone())?.to_record_key();
                let mapping = crate::engine::mapping_key(&self.manifest.capture_id, &key.0);
                if !self.mapping_row_keys.contains(&mapping.0) {
                    emit(entry)?;
                }
            }
            Ok(())
        });
        latest_reader.verify_file_end()?;
        result?;
        // Both passes use the existing independently opened sealed-spool visitor,
        // including complete EOF verification even when every latest row replaces.
        self.latest.visit_entries(&mut |entry| {
            if !self.original_keys.contains_key(&entry.raw_key) {
                emit(entry)?;
            }
            Ok(())
        })
    }
}
impl AuditInventory for Merged<'_> {
    fn visit(
        &self,
        row: &mut dyn FnMut(&ObservedRow) -> Result<(), GatewayError>,
    ) -> Result<(), GatewayError> {
        self.visit_entries(&mut |entry| {
            let value = crate::native_capture::validate_entry(entry, self.version)?;
            if value
                .record
                .expires_at_ms
                .is_none_or(|expiry| expiry > self.now_ms)
            {
                row(&ObservedRow {
                    key: value.key,
                    parts: value.parts,
                    record: value.record,
                })?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
