//! Fixed two-account registry for the controlled fixture only.
use super::port::error;
use gateway_auth::{
    native_credentials::{NativeGeneration, NativeOwnerId, OwnerFence},
    provider_credentials::{CodexSourcePool, codex_source_pool_key, parse_codex_source_pool},
};
use gateway_core::{GatewayError, state::StoredRecord, tuple_key::TupleKey};
use gateway_migration::{NativeCapture, NativeCustody, NativeValue, OwnedNativeSnapshot};
use gateway_native::{
    NativeOwnerTransport,
    unix::{NativeOwnerLocation, UnixOwnerTransport},
};
use std::{collections::BTreeMap, path::PathBuf};

pub struct Host {
    transport: UnixOwnerTransport,
    bindings: BTreeMap<String, (PathBuf, OwnerFence)>,
    now_ms: i64,
}
impl Host {
    pub fn from_stopped_fixture(
        directory: &str,
        capture: &NativeCapture,
        now_ms: i64,
    ) -> Result<Self, GatewayError> {
        let root = std::fs::canonicalize("/tmp/ai-rust-wasm-20261018").map_err(error)?;
        let directory = std::fs::canonicalize(directory).map_err(error)?;
        if directory == root || !directory.starts_with(&root) {
            return Err(error("Fixture directory is outside its task scope"));
        }
        let key = TupleKey::from_record_key(&codex_source_pool_key())?;
        let entry = capture
            .entries
            .iter()
            .find(|e| e.raw_key == key.sort_bytes())
            .ok_or_else(|| error("Synthetic source pool is missing"))?;
        let NativeValue::SourceGraphV1(graph) = &entry.value else {
            return Err(error("Synthetic source pool is not a graph"));
        };
        let tree = gateway_migration::graph_transport::from_source_graph(graph)?
            .try_identity_free_tree()?
            .and_then(|v| v.to_json_lossless())
            .ok_or_else(|| error("Synthetic source pool has identity"))?;
        let pool = parse_codex_source_pool(&tree)?
            .ok_or_else(|| error("Synthetic source pool is invalid"))?;
        let mut locations = Vec::new();
        let mut bindings = BTreeMap::new();
        if pool.accounts.len() != 2 {
            return Err(error("Fixture registry requires its two fixed accounts"));
        }
        for id in ["managed-a", "managed-b"] {
            let account = pool
                .accounts
                .iter()
                .find(|a| a.account_id == id)
                .ok_or_else(|| error("Fixture account differs"))?;
            if !account
                .refresh_token
                .expose()
                .starts_with(&format!("synthetic-native-{id}-"))
                || !account.access_token.expose().ends_with(".synthetic")
            {
                return Err(error(
                    "Only explicit synthetic fixture credentials are accepted",
                ));
            }
            let home = directory.join(id);
            if !std::fs::symlink_metadata(home.join("auth.json"))
                .map_err(error)?
                .file_type()
                .is_file()
            {
                return Err(error(
                    "Fixture credential file must be an ordinary task-owned file",
                ));
            }
            if std::fs::canonicalize(&home).map_err(error)? != home {
                return Err(error("Fixture owner path is not canonical"));
            }
            let owner = NativeOwnerId(format!("fixture-{id}"));
            locations.push(NativeOwnerLocation::configured(
                owner.clone(),
                home.clone(),
            )?);
            bindings.insert(
                id.into(),
                (
                    home,
                    OwnerFence {
                        owner,
                        account_id: id.into(),
                        generation_hash: String::new(),
                        authority_revision: format!(
                            "native-v1:{}:{}",
                            entry.revision.version, entry.revision.sequence
                        ),
                    },
                ),
            );
        }
        let transport = UnixOwnerTransport::new(locations)?;
        for (home, fence) in bindings.values_mut() {
            let document = super::support_run(transport.read_credentials(&fence.owner))?;
            if document.account_id != fence.account_id
                || home.file_name().and_then(|s| s.to_str()) != Some(&fence.account_id)
            {
                return Err(error("Fixture owner account differs"));
            }
            fence.generation_hash = document.generation_hash();
        }
        Ok(Self {
            transport,
            bindings,
            now_ms,
        })
    }
    pub fn with_current_pool(
        mut self,
        record: &StoredRecord,
        now_ms: i64,
    ) -> Result<Self, GatewayError> {
        let pool: CodexSourcePool = parse_codex_source_pool(record.json_value()?)?
            .ok_or_else(|| error("Current fixture pool is invalid"))?;
        if pool.accounts.len() != self.bindings.len() {
            return Err(error("Current fixture pool changed accounts"));
        }
        for (id, (home, fence)) in &mut self.bindings {
            let account = pool
                .accounts
                .iter()
                .find(|a| a.account_id == *id)
                .ok_or_else(|| error("Current fixture account is missing"))?;
            let owner = account
                .native_owner
                .as_ref()
                .ok_or_else(|| error("Current fixture owner is missing"))?;
            if owner.codex_home != home.to_string_lossy() {
                return Err(error("Current fixture owner home differs"));
            }
            fence.authority_revision = record.revision.clone();
            fence.generation_hash = owner
                .managed_source
                .as_ref()
                .ok_or_else(|| error("Current fixture managed generation is missing"))?
                .generation_hash
                .clone();
        }
        self.now_ms = now_ms;
        Ok(self)
    }
}
impl NativeCustody for Host {
    async fn observe(&self, account_id: &str) -> Result<OwnedNativeSnapshot, GatewayError> {
        let (home, fence) = self
            .bindings
            .get(account_id)
            .ok_or_else(|| error("Unregistered fixture owner"))?;
        let credentials = self.transport.read_credentials(&fence.owner).await?;
        OwnedNativeSnapshot::verify(
            home.to_str()
                .ok_or_else(|| error("Fixture home is not UTF8"))?,
            fence,
            NativeGeneration {
                fence: fence.clone(),
                credentials,
                observed_at_ms: self.now_ms,
            },
        )
    }
}
