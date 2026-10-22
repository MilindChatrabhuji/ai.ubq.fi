//! Private stopped-file preparation. No full-capture payload collection, VM,
//! database, public import route, or capability is created by these spool files.
use crate::native_spool::{RowInventory, Spool, Writer};
use crate::*;
use serde::de::{DeserializeSeed, Error, MapAccess, SeqAccess, Visitor};
use std::{
    collections::BTreeMap,
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
};

/// Each replay reads the same verified frames in original order. This header
/// contains no entry payload; a separate sealed spool retains every original row.
pub struct Captured {
    header: NativeCapture,
    entries: Spool<NativeEntry>,
    directory: PathBuf,
}
impl Captured {
    pub fn read(path: &Path, directory: &Path) -> Result<Self, GatewayError> {
        let mut writer = Writer::create(&directory.join("native-entries.spool"))?;
        let file = private_file(path)?;
        let mut decoder = serde_json::Deserializer::from_reader(BufReader::new(file));
        let header = CaptureSeed(&mut writer)
            .deserialize(&mut decoder)
            .map_err(|_| invalid("Private native source document is malformed"))?;
        decoder
            .end()
            .map_err(|_| invalid("Private native source has trailing data"))?;
        header.validate_header()?;
        Ok(Self {
            header,
            entries: writer.seal()?,
            directory: directory.into(),
        })
    }
    pub fn owned(mut source: NativeCapture, directory: &Path) -> Result<Self, GatewayError> {
        source.validate_header()?;
        let mut writer = Writer::create(&directory.join("native-entries.spool"))?;
        for entry in std::mem::take(&mut source.entries) {
            writer.push(&entry)?;
        }
        Ok(Self {
            header: source,
            entries: writer.seal()?,
            directory: directory.into(),
        })
    }
    pub(crate) fn from_parts(
        header: NativeCapture,
        entries: Spool<NativeEntry>,
        directory: &Path,
    ) -> Self {
        Self {
            header,
            entries,
            directory: directory.into(),
        }
    }
    pub(crate) fn replay(&self, directory: &Path) -> Self {
        Self {
            header: self.header.clone(),
            entries: self.entries.clone(),
            directory: directory.into(),
        }
    }
    pub fn count(&self) -> usize {
        self.entries.len()
    }
    pub(crate) fn metadata(&self) -> &NativeCapture {
        &self.header
    }
    pub fn visit_entries(
        &self,
        callback: &mut dyn FnMut(&NativeEntry) -> Result<(), GatewayError>,
    ) -> Result<(), GatewayError> {
        self.entries.visit(&mut |entry| callback(&entry))
    }
    pub fn entry(&self, index: usize) -> Result<NativeEntry, GatewayError> {
        self.entries.get(index)
    }
    /// Select the bounded operational core without touching a target or opening
    /// a credential. The returned capture still needs the existing preparation
    /// and custody gates before any adoption.
    pub fn core_capture(&self) -> Result<crate::CoreStateCapture, MigrationError> {
        crate::core_state::select_spool(&self.header, &self.entries)
    }
    /// Select and prepare the bounded core in one private offline operation.
    /// The returned plan still needs the existing staged adoption and activation gates.
    pub async fn prepare_core<H: crate::NativeCustody>(
        self,
        host: &H,
    ) -> Result<(crate::CoreStateManifest, crate::staged::StagePlan), MigrationError> {
        let crate::CoreStateCapture { capture, manifest } = self.core_capture()?;
        let directory = crate::native_stage::directory(&self.directory)?;
        let plan = Captured::owned(capture, &directory)?.prepare(host).await?;
        Ok((manifest, plan))
    }
    pub(crate) fn reader(&self) -> Result<crate::native_spool::Reader<NativeEntry>, GatewayError> {
        self.entries.reader()
    }
    pub async fn verify_configured(
        &self,
        custody: &crate::native_operator::ConfiguredNativeCustody,
    ) -> Result<(), MigrationError> {
        let mut reader = self.entries.reader()?;
        while let Some(entry) = reader.next()? {
            custody.verify_access_only_entry(&entry).await?;
        }
        reader.verify_end()?;
        Ok(())
    }
    pub async fn prepare<H: NativeCustody>(
        self,
        host: &H,
    ) -> Result<crate::staged::StagePlan, MigrationError> {
        let version = self.header.validate_header()?;
        let mut writer = Writer::<Row>::create(&self.directory.join("normalized-rows.spool"))?;
        let mut seen = std::collections::BTreeSet::new();
        // Every complete source row, including expired data, passes the original
        // tuple/version/expiry/typed graph/counter and current-custody validators.
        // One sequential pass validates and seals the normalized row inventory.
        let mut reader = self.entries.reader()?;
        while let Some(mut entry) = reader.next()? {
            crate::native_custody::normalize_entry(&mut entry, host).await?;
            let key = TupleKey::from_sort_bytes(entry.raw_key.clone())?.to_record_key();
            if !seen.insert(key.0) {
                return Err(invalid(
                    "Native source key is duplicated or attempts to mint private state",
                )
                .into());
            }
            let row = crate::native_capture::validate_entry(&entry, version)?;
            writer.push(&row)?;
        }
        reader.verify_end()?;
        let normalized = writer.seal()?;
        let audited = gateway_admin_data::migration::audit::inspect_inventory(
            &RowInventory {
                rows: &normalized,
                now: self.header.captured_at_ms,
            },
            self.header.captured_at_ms,
        )?;
        if !audited.errors.is_empty() {
            return Err(MigrationError::SourceInventory(audited));
        }
        // Identity binds the complete original ordered private entry inventory and
        // header. It does not authorize that captured state as current ownership.
        let capture_id = gateway_auth::crypto::sha256_hex(
            &serde_json::to_vec(&(&self.header, self.entries.digest()))
                .map_err(|_| invalid("Private source identity cannot be encoded"))?,
        );
        let revision = format!("capture:{capture_id}");
        let mut projected = Writer::<Row>::create(&self.directory.join("projected-rows.spool"))?;
        let mut reader = normalized.reader()?;
        while let Some(mut row) = reader.next()? {
            let p = &row.parts;
            // The original generic retained graph branch is an identity return.
            // Its full typed validators and complete audit already ran above.
            if !(crate::projection::retained_typed(p)
                && crate::projection::known(p)
                && !crate::source_metadata::named_key(p)
                && (starts(p, &["agent_messages"])
                    || starts(p, &["embeddings"])
                    || starts(p, &["key"])
                    || (starts(p, &["default"])
                        && !matches!(
                            p.get(1).and_then(Value::as_str),
                            Some("kernel_policy_limit_requests" | "kernel_policy_window_ms")
                        ))))
            {
                crate::projection::forward(&mut row)?;
            }
            projected.push(&row)?;
        }
        reader.verify_end()?;
        let projected = projected.seal()?;
        let (bound, derived) = crate::indexes::bind_spooled(
            &projected,
            self.header.captured_at_ms,
            &revision,
            &self.directory.join("bound-rows.spool"),
        )?;
        let mut canonical = Writer::create(&self.directory.join("canonical-rows.spool"))?;
        let mut mapping_digests = BTreeMap::new();
        let mut keys = std::collections::BTreeSet::new();
        let mut reader = bound.reader()?;
        let mut index = 0usize;
        while let Some(bytes) = reader.next_raw()? {
            #[derive(Deserialize)]
            struct RawRow<'a> {
                key: String,
                #[serde(borrow)]
                record: &'a serde_json::value::RawValue,
                mapping: Mapping,
            }
            let mut row: RawRow<'_> = serde_json::from_slice(&bytes)
                .map_err(|_| invalid("Private canonical row cannot be decoded"))?;
            row.mapping.baseline_digest =
                gateway_auth::crypto::sha256_hex(row.record.get().as_bytes());
            if row.mapping.transform == Transform::Identity {
                row.mapping.source.value = SourceJson::parse("null")?;
                row.mapping.source.key.clear();
            }
            let mapping = crate::engine::mapping_key(&capture_id, &row.key);
            let record = StoredRecord::json(&revision, json(&row.mapping)?, None);
            mapping_digests.insert(mapping.0.clone(), digest(&record)?);
            if !keys.insert(row.key.clone()) {
                return Err(invalid("Staged canonical inventory has duplicate keys").into());
            }
            canonical.push(&crate::staged::CanonicalRecord {
                key: mapping,
                record,
            })?;
            if row.key != reader.spool().key(index)? {
                return Err(invalid("Private canonical key changed").into());
            }
            canonical.push_canonical(row.key, row.record, reader.spool().expiry(index))?;
            index += 1;
        }
        reader.verify_end()?;
        let mut derived_digests = BTreeMap::new();
        for (key, record) in derived {
            if !keys.insert(key.0.clone())
                || derived_digests
                    .insert(key.0.clone(), digest(&record)?)
                    .is_some()
            {
                return Err(invalid("Derived schema key collides with source state").into());
            }
            canonical.push(&crate::staged::CanonicalRecord { key, record })?;
        }
        let entries: Vec<_> = mapping_digests.into_iter().collect();
        let manifest = crate::engine::Manifest {
            v: 4,
            capture_id,
            source_git_sha: self.header.source_git_sha,
            captured_at_ms: self.header.captured_at_ms,
            source_rows: normalized.len(),
            mapping_checksum: gateway_auth::crypto::sha256_hex(
                &serde_json::to_vec(&entries)
                    .map_err(|_| invalid("Mapping checksum cannot be encoded"))?,
            ),
            derived: derived_digests,
            native_revision: Some(self.header.data_revision),
        };
        Ok(crate::staged::StagePlan::from_spool(
            manifest,
            canonical.seal()?,
        )?)
    }
}
fn private_file(path: &Path) -> Result<File, GatewayError> {
    use std::os::unix::fs::MetadataExt;
    let before =
        std::fs::symlink_metadata(path).map_err(|_| invalid("Private source cannot be opened"))?;
    if !path.is_absolute() || !before.is_file() || before.mode() & 0o077 != 0 {
        return Err(invalid(
            "Private native capture file is not owner-only/regular",
        ));
    }
    let file = File::open(path).map_err(|_| invalid("Private source cannot be opened"))?;
    let opened = file
        .metadata()
        .map_err(|_| invalid("Private source cannot be opened"))?;
    if before.dev() != opened.dev() || before.ino() != opened.ino() || before.uid() != opened.uid()
    {
        return Err(invalid("Private native capture file changed before read"));
    }
    Ok(file)
}
struct CaptureSeed<'a>(&'a mut Writer<NativeEntry>);
impl<'de> DeserializeSeed<'de> for CaptureSeed<'_> {
    type Value = NativeCapture;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<NativeCapture, D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for CaptureSeed<'_> {
    type Value = NativeCapture;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("complete native capture")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<NativeCapture, M::Error> {
        let mut header = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if header.contains_key(&key) {
                return Err(M::Error::custom("Duplicate native capture field"));
            }
            if key == "entries" {
                map.next_value_seed(EntriesSeed(self.0))?;
                header.insert(key, serde_json::json!([]));
            } else {
                if ![
                    "v",
                    "source_git_sha",
                    "captured_at_ms",
                    "source_codec",
                    "native_schema_version",
                    "data_revision",
                    "queue_entries",
                    "running_queue_entries",
                ]
                .contains(&key.as_str())
                {
                    return Err(M::Error::custom("Unknown native capture field"));
                }
                header.insert(key, map.next_value()?);
            }
        }
        serde_json::from_value(Value::Object(header)).map_err(M::Error::custom)
    }
}
struct EntriesSeed<'a>(&'a mut Writer<NativeEntry>);
impl<'de> DeserializeSeed<'de> for EntriesSeed<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for EntriesSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("native entry sequence")
    }
    fn visit_seq<S: SeqAccess<'de>>(self, mut entries: S) -> Result<(), S::Error> {
        while let Some(entry) = entries.next_element::<NativeEntry>()? {
            self.0.push(&entry).map_err(S::Error::custom)?;
        }
        Ok(())
    }
}

/// Fresh private directory under the caller's task-owned stopped-file location.
pub fn directory(parent: &Path) -> Result<PathBuf, GatewayError> {
    use std::os::unix::fs::DirBuilderExt;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| invalid("Private spool clock is invalid"))?
        .as_nanos();
    static NEXT_DIRECTORY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = NEXT_DIRECTORY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = parent.join(format!(
        "uos-native-stage-{}-{stamp}-{sequence}",
        std::process::id()
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&path)
        .map_err(|_| invalid("Private spool directory cannot be created"))?;
    Ok(path)
}
