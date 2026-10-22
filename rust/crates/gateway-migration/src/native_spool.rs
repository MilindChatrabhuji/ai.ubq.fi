//! Native-private immutable row frames. Never a database/runtime or wire codec.
use crate::*;
use serde::de::DeserializeOwned;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    marker::PhantomData,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
#[derive(Clone)]
struct Frame {
    offset: u64,
    size: usize,
    digest: String,
    key: Option<String>,
    expiry: Option<i64>,
    transform: Option<Transform>,
}
/// Facts come from the same typed row that is serialized, not from a caller's
/// proposed key, family subset, payload surrogate or authority document.
pub(crate) trait SpoolValue: Serialize + DeserializeOwned {
    fn facts(&self) -> (Option<String>, Option<i64>, Option<Transform>);
}
impl SpoolValue for Row {
    fn facts(&self) -> (Option<String>, Option<i64>, Option<Transform>) {
        (
            Some(self.key.0.clone()),
            self.record.expires_at_ms,
            Some(self.mapping.transform),
        )
    }
}
impl SpoolValue for crate::staged::CanonicalRecord {
    fn facts(&self) -> (Option<String>, Option<i64>, Option<Transform>) {
        (Some(self.key.0.clone()), self.record.expires_at_ms, None)
    }
}
impl SpoolValue for NativeEntry {
    fn facts(&self) -> (Option<String>, Option<i64>, Option<Transform>) {
        (None, None, None)
    }
}
#[cfg(test)]
impl SpoolValue for Value {
    fn facts(&self) -> (Option<String>, Option<i64>, Option<Transform>) {
        (None, None, None)
    }
}
pub(crate) struct Writer<T> {
    path: PathBuf,
    file: File,
    frames: Vec<Frame>,
    marker: PhantomData<T>,
}
pub(crate) struct Spool<T> {
    path: PathBuf,
    frames: Arc<Vec<Frame>>,
    bytes: u64,
    device: u64,
    inode: u64,
    marker: PhantomData<T>,
}
impl<T> Clone for Spool<T> {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            frames: self.frames.clone(),
            bytes: self.bytes,
            device: self.device,
            inode: self.inode,
            marker: PhantomData,
        }
    }
}
/// One owner-only file handle reused for every sequential pass or directed read.
/// Callers must not open the same spool per row; a fresh Reader is one open.
pub(crate) struct Reader<T> {
    spool: Spool<T>,
    file: File,
    next: usize,
}
fn failure() -> GatewayError {
    invalid("Private native spool is changed, truncated or unreadable")
}
impl<T: SpoolValue> Writer<T> {
    pub(crate) fn create(path: &Path) -> Result<Self, GatewayError> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|_| failure())?;
        Ok(Self {
            path: path.into(),
            file,
            frames: vec![],
            marker: PhantomData,
        })
    }
    pub(crate) fn push(&mut self, value: &T) -> Result<(), GatewayError> {
        let bytes = serde_json::to_vec(value).map_err(|_| failure())?;
        let (key, expiry, transform) = value.facts();
        self.push_frame(&bytes, key, expiry, transform)
    }
    pub(crate) fn push_frame(
        &mut self,
        bytes: &[u8],
        key: Option<String>,
        expiry: Option<i64>,
        transform: Option<Transform>,
    ) -> Result<(), GatewayError> {
        if bytes.len() > 2 * crate::operational::PRIVATE_WIRE_MAX_BYTES + 8192 {
            return Err(failure());
        }
        let offset = self.file.stream_position().map_err(|_| failure())?;
        self.file.write_all(bytes).map_err(|_| failure())?;
        self.frames.push(Frame {
            offset,
            size: bytes.len(),
            digest: gateway_auth::crypto::sha256_hex(bytes),
            key,
            expiry,
            transform,
        });
        Ok(())
    }
    pub(crate) fn seal(self) -> Result<Spool<T>, GatewayError> {
        self.file.sync_all().map_err(|_| failure())?;
        let m = self.file.metadata().map_err(|_| failure())?;
        Ok(Spool {
            path: self.path,
            frames: Arc::new(self.frames),
            bytes: m.len(),
            device: m.dev(),
            inode: m.ino(),
            marker: PhantomData,
        })
    }
}
impl<T: SpoolValue> Spool<T> {
    pub(crate) fn reader(&self) -> Result<Reader<T>, GatewayError> {
        Ok(Reader {
            spool: self.clone(),
            file: self.open()?,
            next: 0,
        })
    }
    pub(crate) fn encoded_size(&self, index: usize) -> usize {
        self.frames[index].size
    }
    pub(crate) fn len(&self) -> usize {
        self.frames.len()
    }
    pub(crate) fn digest(&self) -> String {
        gateway_auth::crypto::sha256_hex(
            self.frames
                .iter()
                .flat_map(|f| f.digest.bytes())
                .collect::<Vec<_>>()
                .as_slice(),
        )
    }
    fn open(&self) -> Result<File, GatewayError> {
        let before = std::fs::symlink_metadata(&self.path).map_err(|_| failure())?;
        if !before.is_file()
            || before.mode() & 0o077 != 0
            || before.dev() != self.device
            || before.ino() != self.inode
            || before.len() != self.bytes
        {
            return Err(failure());
        }
        let file = File::open(&self.path).map_err(|_| failure())?;
        let m = file.metadata().map_err(|_| failure())?;
        if m.dev() != self.device
            || m.ino() != self.inode
            || m.uid() != before.uid()
            || m.len() != self.bytes
        {
            return Err(failure());
        }
        Ok(file)
    }
    fn raw_frame(file: &mut File, frame: &Frame) -> Result<Vec<u8>, GatewayError> {
        if file.stream_position().map_err(|_| failure())? != frame.offset {
            file.seek(SeekFrom::Start(frame.offset))
                .map_err(|_| failure())?;
        }
        let mut bytes = vec![0; frame.size];
        file.read_exact(&mut bytes).map_err(|_| failure())?;
        if gateway_auth::crypto::sha256_hex(&bytes) != frame.digest {
            return Err(failure());
        }
        Ok(bytes)
    }
    pub(crate) fn key(&self, index: usize) -> Result<&str, GatewayError> {
        self.frames[index].key.as_deref().ok_or_else(failure)
    }
    pub(crate) fn expiry(&self, index: usize) -> Option<i64> {
        self.frames[index].expiry
    }
    pub(crate) fn live(&self, index: usize, now: i64) -> bool {
        self.frames[index].expiry.is_none_or(|e| e > now)
    }
    pub(crate) fn transform(&self, index: usize) -> Option<Transform> {
        self.frames[index].transform
    }
    pub(crate) fn get(&self, index: usize) -> Result<T, GatewayError> {
        self.reader()?.read(index)
    }
    pub(crate) fn visit(
        &self,
        callback: &mut dyn FnMut(T) -> Result<(), GatewayError>,
    ) -> Result<(), GatewayError> {
        // A fresh open, not try_clone: every nested/repeated pass has its own offset.
        let mut reader = self.reader()?;
        while let Some(value) = reader.next()? {
            callback(value)?;
        }
        reader.verify_end()
    }
}
impl<T: SpoolValue> Reader<T> {
    pub(crate) fn spool(&self) -> &Spool<T> {
        &self.spool
    }
    pub(crate) fn next(&mut self) -> Result<Option<T>, GatewayError> {
        let Some(bytes) = self.next_raw()? else {
            return Ok(None);
        };
        Ok(Some(serde_json::from_slice(&bytes).map_err(|_| failure())?))
    }
    pub(crate) fn next_raw(&mut self) -> Result<Option<Vec<u8>>, GatewayError> {
        let Some(frame) = self.spool.frames.get(self.next) else {
            return Ok(None);
        };
        let bytes = Spool::<T>::raw_frame(&mut self.file, frame)?;
        self.next += 1;
        Ok(Some(bytes))
    }
    pub(crate) fn read(&mut self, index: usize) -> Result<T, GatewayError> {
        serde_json::from_slice(&self.read_raw(index)?).map_err(|_| failure())
    }
    pub(crate) fn read_raw(&mut self, index: usize) -> Result<Vec<u8>, GatewayError> {
        Spool::<T>::raw_frame(
            &mut self.file,
            self.spool.frames.get(index).ok_or_else(failure)?,
        )
    }
    /// Require the complete sequential inventory to have been consumed.
    pub(crate) fn verify_end(&mut self) -> Result<(), GatewayError> {
        if self.next != self.spool.frames.len() {
            return Err(failure());
        }
        self.verify_file_end()
    }
    /// Directed/random-order passes still prove the exact file EOF and identity.
    /// The path is rechecked on every frame boundary so a replaced file cannot
    /// keep an already-open inode alive as a stale private inventory.
    pub(crate) fn verify_file_end(&mut self) -> Result<(), GatewayError> {
        let before = std::fs::symlink_metadata(&self.spool.path).map_err(|_| failure())?;
        if !before.is_file()
            || before.mode() & 0o077 != 0
            || before.dev() != self.spool.device
            || before.ino() != self.spool.inode
            || before.len() != self.spool.bytes
        {
            return Err(failure());
        }
        let end = self
            .spool
            .frames
            .last()
            .map_or(Some(0), |frame| frame.offset.checked_add(frame.size as u64));
        if end != Some(self.spool.bytes) {
            return Err(failure());
        }
        if self.file.metadata().map_err(|_| failure())?.len() != self.spool.bytes {
            return Err(failure());
        }
        self.file
            .seek(SeekFrom::Start(self.spool.bytes))
            .map_err(|_| failure())?;
        let mut extra = [0];
        if self.file.read(&mut extra).map_err(|_| failure())? != 0 {
            return Err(failure());
        }
        let metadata = self.file.metadata().map_err(|_| failure())?;
        if metadata.len() != self.spool.bytes
            || metadata.dev() != self.spool.device
            || metadata.ino() != self.spool.inode
        {
            return Err(failure());
        }
        Ok(())
    }
}
/// Complete normalized row inventory. Rows were already validated by the same
/// native validator before this spool was sealed, so the audit does not decode
/// or rebuild them a second time.
pub(crate) struct RowInventory<'a> {
    pub rows: &'a Spool<Row>,
    pub now: i64,
}
impl gateway_admin_data::migration::audit::AuditInventory for RowInventory<'_> {
    fn visit(
        &self,
        callback: &mut dyn FnMut(
            &gateway_admin_data::migration::ObservedRow,
        ) -> Result<(), GatewayError>,
    ) -> Result<(), GatewayError> {
        let mut reader = self.rows.reader()?;
        while let Some(row) = reader.next()? {
            if row
                .record
                .expires_at_ms
                .is_none_or(|expiry| expiry > self.now)
            {
                callback(&gateway_admin_data::migration::ObservedRow {
                    key: row.key,
                    parts: row.parts,
                    record: row.record,
                })?;
            }
        }
        reader.verify_end()
    }
}

impl Writer<crate::staged::CanonicalRecord> {
    // Only native preparation calls this after full row validation, global audit,
    // projection/index binding, and verified source-frame hashing. The record raw
    // token is unchanged from that genuine typed record's serializer.
    pub(crate) fn push_canonical(
        &mut self,
        key: String,
        record: &serde_json::value::RawValue,
        expiry: Option<i64>,
    ) -> Result<(), GatewayError> {
        let bytes = format!(
            "{{\"key\":{},\"record\":{}}}",
            serde_json::to_string(&key).map_err(|_| failure())?,
            record.get()
        );
        self.push_frame(bytes.as_bytes(), Some(key), expiry, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        crate::native_stage::directory(&std::env::temp_dir()).unwrap()
    }
    #[test]
    fn independent_replays_keep_order_and_callback_failures() {
        let dir = directory();
        let mut writer = Writer::<Value>::create(&dir.join("frames")).unwrap();
        for n in 0..3 {
            writer
                .push(&serde_json::json!({"n":n,"typed":[1,2,3]}))
                .unwrap();
        }
        let rows = writer.seal().unwrap();
        let mut visits = vec![];
        rows.visit(&mut |row| {
            let mut nested = vec![];
            rows.visit(&mut |value| {
                nested.push(value["n"].clone());
                Ok(())
            })?;
            assert_eq!(nested, vec![Value::from(0), Value::from(1), Value::from(2)]);
            visits.push(row["n"].clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(visits.len(), 3);
        let result = rows.visit(&mut |_| Err(invalid("callback refusal")));
        assert!(result.is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn replay_rejects_truncation_replacement_and_changed_payload() {
        use std::io::{Seek, SeekFrom};
        let dir = directory();
        let path = dir.join("frames");
        let mut writer = Writer::<Value>::create(&path).unwrap();
        writer.push(&serde_json::json!({"a":1})).unwrap();
        let rows = writer.seal().unwrap();
        let mut file = OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(5)).unwrap();
        file.write_all(b"2").unwrap();
        file.sync_all().unwrap();
        assert!(rows.visit(&mut |_| Ok(())).is_err());
        file.set_len(2).unwrap();
        assert!(rows.get(0).is_err());
        drop(file);
        std::fs::rename(&path, dir.join("old")).unwrap();
        std::fs::write(&path, b"{\"a\":1}").unwrap();
        assert!(rows.visit(&mut |_| Ok(())).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
