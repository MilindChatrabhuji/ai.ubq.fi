//! Fixed two-account registry for the controlled fixture only.
use super::port::error;
use gateway_auth::{
    native_credentials::{NativeOwnerId, OwnerFence},
    provider_credentials::{CodexSourcePool, codex_source_pool_key, parse_codex_source_pool},
};
use gateway_core::{
    GatewayError, identity::MAX_SAFE_INTEGER, state::StoredRecord, tuple_key::TupleKey,
};
use gateway_migration::{
    NativeCapture, NativeCustody, NativeValue, OwnedNativeSnapshot,
    native_operator::{ConfiguredNativeCustody, NativeCustodyRegistration},
};
use gateway_native::{
    NativeOwnerTransport,
    unix::{NativeOwnerLocation, UnixOwnerTransport},
};
use std::{collections::BTreeMap, path::PathBuf};

pub struct Host {
    bindings: BTreeMap<String, (PathBuf, OwnerFence)>,
    // Source/ledger time is controlled separately from actual credential freshness.
    now_ms: i64,
}
impl Host {
    pub fn from_stopped_fixture(
        directory: &str,
        capture: &NativeCapture,
        now_ms: i64,
    ) -> Result<Self, GatewayError> {
        if !(0..=MAX_SAFE_INTEGER).contains(&now_ms) || now_ms < capture.captured_at_ms {
            return Err(error("Fixture source clock is invalid"));
        }
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
        Ok(Self { bindings, now_ms })
    }
    /// Fixed TEST vector from native_custody.rs:191-254: rotate only managed-a's
    /// physical refresh, prove the stale export refusal, then publish its actual projection.
    pub fn advance_managed_a(
        self,
        store: &super::port::Store,
        time: super::inputs::FixtureTime,
        artifacts: &gateway_migration::ArtifactContext,
    ) -> Result<(Self, super::producers::Receipt), gateway_migration::MigrationError> {
        use gateway_auth::{
            crypto::Secret,
            managed_access::ManagedAccessProjection,
            native_credentials::NativeGeneration,
            provider_credentials::{ManagedNativeSource, read_codex_source_pool},
        };
        use gateway_core::state::{
            AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, RevisionCheck,
        };
        time.check()?;
        if self.now_ms != time.runtime() {
            return Err(error("Fixture managed owner clock differs").into());
        }
        let snapshot = super::support_run(read_codex_source_pool(store, time.runtime()))?
            .ok_or_else(|| error("Current source pool is missing"))?;
        if snapshot.pool.accounts.len() != 2
            || snapshot.pool.accounts[0].account_id != "managed-a"
            || snapshot.pool.accounts[1].account_id != "managed-b"
        {
            return Err(error("Original fixed owner order differs").into());
        }
        let sibling = snapshot.pool.accounts[1].clone();
        let (home, old_fence) = self
            .bindings
            .get("managed-a")
            .ok_or_else(|| error("Fixed managed-a is absent"))?
            .clone();
        let sibling_path = self
            .bindings
            .get("managed-b")
            .ok_or_else(|| error("Fixed managed-b is absent"))?
            .0
            .join("auth.json");
        let sibling_bytes = std::fs::read(&sibling_path).map_err(error)?;
        let path = home.join("auth.json");
        let original = std::fs::read(&path).map_err(error)?;
        let mut document: serde_json::Value = serde_json::from_slice(&original).map_err(error)?;
        document["tokens"]["refresh_token"] =
            serde_json::json!("synthetic-native-managed-a-2-refresh");
        document["last_refresh"] = serde_json::json!("2026-10-19T00:00:00.000000002Z");
        std::fs::write(&path, serde_json::to_vec(&document).map_err(error)?).map_err(error)?;
        if super::support_run(gateway_migration::export_native_rollback_with_custody(
            store,
            time.runtime(),
            &self,
            artifacts.clone(),
        ))
        .is_ok()
        {
            return Err(error("Stale native generation was accepted").into());
        }
        let transport = UnixOwnerTransport::new(vec![NativeOwnerLocation::configured(
            old_fence.owner.clone(),
            home.clone(),
        )?])?;
        let credentials = super::support_run(transport.read_credentials(&old_fence.owner))?;
        let generation = NativeGeneration {
            fence: OwnerFence {
                generation_hash: credentials.generation_hash(),
                authority_revision: "current-pool-publication".into(),
                ..old_fence
            },
            credentials,
            observed_at_ms: time.runtime(),
        };
        let projection = ManagedAccessProjection::from_native(&generation)?;
        if projection.access_generation()
            != snapshot.pool.accounts[0].identity().native_generation_hash
            || projection.native_source_generation()
                == snapshot.pool.accounts[0]
                    .native_owner
                    .as_ref()
                    .and_then(|o| o.managed_source.as_ref())
                    .ok_or_else(|| error("Managed source missing"))?
                    .generation_hash
        {
            return Err(error("Original refresh-only generation distinction differs").into());
        }
        let mut pool = snapshot.pool;
        let account = &mut pool.accounts[0];
        account.access_token = projection.access_token().clone();
        account.refresh_token = Secret::new(String::new());
        let owner = account
            .native_owner
            .as_mut()
            .ok_or_else(|| error("Current native owner missing"))?;
        owner.generation_hash = projection.access_generation().into();
        owner.native_refreshed_at = projection.native_refreshed_at().map(str::to_owned);
        owner.managed_source = Some(ManagedNativeSource {
            v: 2,
            generation_hash: projection.native_source_generation().into(),
        });
        if pool.accounts[1] != sibling {
            return Err(error("Sibling projection changed").into());
        }
        let pool_key = codex_source_pool_key();
        if super::support_run(store.commit(AtomicTransition {
            checks: vec![RevisionCheck {
                key: pool_key.clone(),
                expected_revision: Some(snapshot.revision),
            }],
            mutations: vec![RecordMutation::Put {
                key: pool_key.clone(),
                record: StoredRecord::json(
                    "current-pool-publication",
                    pool.private_source_value(),
                    None,
                ),
            }],
        }))? != CommitOutcome::Committed
        {
            return Err(error("Current owner publication conflicted").into());
        }
        let current = super::support_run(store.read(&pool_key))?
            .ok_or_else(|| error("Published source is missing"))?;
        let fixed = self.with_current_pool(&current, time.export())?;
        super::support_run(gateway_migration::export_native_rollback_with_custody(
            store,
            time.export(),
            &fixed,
            artifacts.clone(),
        ))?;
        if std::fs::read(sibling_path).map_err(error)? != sibling_bytes {
            return Err(error("Sibling physical auth changed").into());
        }
        time.check()?;
        Ok((
            fixed,
            super::producers::Receipt {
                operation: "managed_a_advanced",
                cases: vec![
                    "stale_owner_generation_refused",
                    "actual_managed_a_current_projection",
                    "unchanged_managed_b_physical_and_projection",
                    "current_owner_inverse_accepted",
                ],
                changed_keys: vec![pool_key.0],
                deleted_keys: vec![],
            },
        ))
    }
    pub fn with_current_pool(
        mut self,
        record: &StoredRecord,
        now_ms: i64,
    ) -> Result<Self, GatewayError> {
        if !(self.now_ms..=MAX_SAFE_INTEGER).contains(&now_ms) {
            return Err(error("Fixture source clock moved backwards or is invalid"));
        }
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
        let registrations = self
            .bindings
            .values()
            .map(|(home, fence)| NativeCustodyRegistration::existing(home.clone(), fence.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        let configured = ConfiguredNativeCustody::new(registrations)?;
        configured.observe(account_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::{Directory, run};
    use gateway_auth::{crypto::base64url, native_credentials::parse_native_document};
    use serde_json::json;

    fn fixture(directory: &Directory, expires_at_seconds: u64) -> (Host, Vec<(PathBuf, Vec<u8>)>) {
        let mut bindings = BTreeMap::new();
        let mut original = Vec::new();
        for id in ["managed-a", "managed-b"] {
            let home = directory.file(id);
            std::fs::create_dir(&home).unwrap();
            let token = format!(
                "e30.{}.synthetic",
                base64url(json!({"exp":expires_at_seconds}).to_string().as_bytes())
            );
            let document = json!({"auth_mode":"chatgpt","tokens":{"account_id":id,"access_token":token,"id_token":token,"refresh_token":format!("synthetic-native-{id}-fixture-refresh")},"last_refresh":"2026-10-19T00:00:00.000000000Z"});
            let bytes = serde_json::to_vec(&document).unwrap();
            std::fs::write(home.join("auth.json"), &bytes).unwrap();
            let credentials = parse_native_document(&document).unwrap();
            bindings.insert(
                id.into(),
                (
                    home.clone(),
                    OwnerFence {
                        owner: NativeOwnerId(format!("fixture-{id}")),
                        account_id: id.into(),
                        generation_hash: credentials.generation_hash(),
                        authority_revision: "source-current".into(),
                    },
                ),
            );
            original.push((home, bytes));
        }
        (
            Host {
                bindings,
                now_ms: 0,
            },
            original,
        )
    }

    #[test]
    fn fixture_uses_configured_custody_with_real_freshness_and_preserves_siblings() {
        let directory = Directory::new();
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let (host, original) = fixture(&directory, expiry);
        assert!(run(host.observe("managed-a")).is_ok());
        assert!(run(host.observe("managed-b")).is_ok());
        assert!(run(host.observe("unregistered")).is_err());
        for (home, bytes) in original {
            assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), bytes);
        }
    }

    #[test]
    fn synthetic_ledger_clock_cannot_make_expired_native_credentials_usable() {
        let directory = Directory::new();
        let (host, original) = fixture(&directory, 3600);
        assert_eq!(host.now_ms, 0);
        assert!(run(host.observe("managed-a")).is_err());
        assert!(run(host.observe("managed-b")).is_err());
        for (home, bytes) in original {
            assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), bytes);
        }
    }
}
