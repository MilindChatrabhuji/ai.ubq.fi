//! Synthetic-only private receipt issuer. It does not establish real native writer exclusion.
use super::*;
use crate::existing_account_import::{DurableNativeImport, ExistingAccountImportStore};
use gateway_authority::native_control::import::{NativeImportClaim, NativeImportMode};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
};
struct Home(PathBuf);
impl Home {
    fn fresh() -> Self {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let root = fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(root.is_dir());
        let path = root.join(format!(
            "native-import-receipt-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn write_auth(&self, value: &serde_json::Value) {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(self.0.join("auth.json"))
            .unwrap();
        file.write_all(&serde_json::to_vec(value).unwrap()).unwrap();
        file.sync_all().unwrap();
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn document(label: &str) -> serde_json::Value {
    let access = format!(
        "fixture.{}.signature",
        base64url(
            serde_json::to_string(&json!({"exp":now_ms()/1000+3600,"label":label}))
                .unwrap()
                .as_bytes()
        )
    );
    json!({"tokens":{"account_id":"synthetic-account","access_token":access,"refresh_token":format!("SYNTHETIC_REFRESH_{label}")},"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT_KEY","other":{"independent":label}})
}
fn fixture(home: &Home, old: &serde_json::Value) -> Fixture {
    let mut f = Fixture::new();
    let credentials = gateway_auth::native_credentials::parse_native_document(old).unwrap();
    let key = codex_source_pool_key();
    let mut source = {
        let rows = f.store.rows.lock().unwrap();
        gateway_auth::provider_credentials::parse_codex_source_pool(
            &rows.get(&key.0).unwrap().value,
        )
        .unwrap()
        .unwrap()
    };
    let native = source.accounts[0].native_owner.as_mut().unwrap();
    native.codex_home = home.0.to_str().unwrap().into();
    native.managed_source.as_mut().unwrap().generation_hash = credentials.generation_hash();
    f.store.seed(key, "source-1", source.private_source_value());
    f.owner =
        RegisteredRenewalOwner::configured("native-owner".into(), home.0.to_str().unwrap().into())
            .unwrap();
    f
}
struct Issuer<'a> {
    control: &'a NativeRenewalAuthority<'a, Store, Tokens, Cancel>,
    native: &'a ExistingAccountImportStore,
    claim: Mutex<Option<NativeImportClaim>>,
    receipt: Mutex<Option<DurableNativeImport>>,
}
impl NativeImportHandler for Issuer<'_> {
    fn import_document(
        &self,
        proof: &AuthenticatedNativeImport,
        metadata: &NativeImportMetadata,
        body: &[u8],
        context: &NativeImportContext<'_>,
    ) -> Result<NativeImportResult, GatewayError> {
        context.check_document(proof, metadata, body)?;
        run(context.check_current(self.control))?;
        let mut claim = run(self.control.claim_import(proof))?;
        let start = run(self.control.start_import(&mut claim, proof))?.ok_or_else(fail)?;
        let receipt = self
            .native
            .issue_fixture(start, proof, body, context, now_ms())?;
        run(self.control.unknown_import(&claim))?;
        let mut replay = run(self.control.claim_import(proof))?;
        assert_eq!(replay.mode(), NativeImportMode::ReconcileOnly);
        assert!(run(self.control.start_import(&mut replay, proof))?.is_none());
        *self.claim.lock().unwrap() = Some(replay);
        *self.receipt.lock().unwrap() = Some(receipt);
        Ok(NativeImportResult {
            status: 202,
            headers: BTreeMap::new(),
            body: SourceJson::parse(r#"{"state":"synthetic_native_durable_publication_pending"}"#)
                .unwrap(),
            completion: NativeImportCompletion::PendingUnknown,
        })
    }
}
#[test]
fn durable_native_receipt_reopens_original_context_without_refresh_or_published() {
    run(async {
        let home = Home::fresh();
        let other = Home::fresh();
        let old = document("old");
        home.write_auth(&old);
        other.write_auth(&document("independent"));
        let other_before = fs::read(other.0.join("auth.json")).unwrap();
        let f = fixture(&home, &old);
        let authority = f.authority();
        let control = NativeRenewalAuthority::configured(
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        );
        let native = ExistingAccountImportStore::configured(&f.owner, f.account.clone()).unwrap();
        let next = document("new");
        let raw = serde_json::to_vec(&json!({"auth":next,"models":{"client_version":"0.100.0"}}))
            .unwrap();
        let (proof, headers) = proof_for(&f, &authority, &raw).await;
        let original = original(&headers, &|| false);
        let issuer = Issuer {
            control: &control,
            native: &native,
            claim: Mutex::new(None),
            receipt: Mutex::new(None),
        };
        let response =
            dispatch_import(&issuer, &control, &proof, proof.metadata(), &raw, &original)
                .await
                .unwrap();
        assert!(matches!(
            response.completion,
            NativeImportCompletion::PendingUnknown
        ));
        assert_eq!(response.status, 202);
        let claim = issuer.claim.lock().unwrap().take().unwrap();
        let receipt = issuer.receipt.lock().unwrap().take().unwrap();
        native
            .recheck_receipt(&control, &claim, &proof, &raw, &receipt)
            .await
            .unwrap();
        assert_eq!(receipt.account_id_hash(), f.account);
        assert_eq!(
            receipt.native_generation(),
            gateway_auth::native_credentials::parse_native_document(&next)
                .unwrap()
                .generation_hash()
        );
        let reference = receipt.receipt_ref();
        assert_eq!(reference.len(), 64);
        assert!(!reference.contains(&sha256_hex(&raw)));
        drop(issuer);
        drop(native);
        let reopened = ExistingAccountImportStore::configured(&f.owner, f.account.clone()).unwrap();
        let recovered = reopened
            .reconcile(&control, &claim, &proof, &raw)
            .await
            .unwrap();
        assert_eq!(recovered.receipt_ref(), reference);
        reopened
            .recheck_receipt(&control, &claim, &proof, &raw, &recovered)
            .await
            .unwrap();
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(home.0.join("auth.json")).unwrap()).unwrap();
        assert_eq!(stored["OPENAI_API_KEY"], old["OPENAI_API_KEY"]);
        assert_eq!(stored["other"], old["other"]);
        assert_eq!(stored["tokens"], next["tokens"]);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(home.0.join(format!(
                    ".uos-import-{}.previous",
                    proof.metadata().action_ref
                )))
                .unwrap()
            )
            .unwrap(),
            old
        );
        assert_eq!(fs::read(other.0.join("auth.json")).unwrap(), other_before);
        let captured = f.store.captured();
        for secret in [
            "SYNTHETIC_REFRESH_old",
            "SYNTHETIC_REFRESH_new",
            "SYNTHETIC_INDEPENDENT_KEY",
            &sha256_hex(&raw),
        ] {
            assert!(!captured.contains(secret));
        }
        let rows = f.store.rows.lock().unwrap();
        let operations = rows
            .values()
            .filter(|r| r.value.get("phase").is_some())
            .collect::<Vec<_>>();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].value["phase"], "unknown");
        assert!(operations[0].value["terminal"].is_null());
    });
}
#[test]
fn native_receipt_wrong_owner_source_account_body_and_replaced_files_refuse() {
    run(async {
        for changed in [
            "body",
            "owner",
            "receipt",
            "account",
            "symlink",
            "generation",
            "home",
            "actor",
            "source_cf",
            "cancel",
        ] {
            let home = Home::fresh();
            let old = document("old");
            home.write_auth(&old);
            let f = fixture(&home, &old);
            let authority = f.authority();
            let control = NativeRenewalAuthority::configured(
                &authority,
                &f.identity,
                &f.owner,
                &f.config,
                &f.cancel,
            );
            let native =
                ExistingAccountImportStore::configured(&f.owner, f.account.clone()).unwrap();
            let raw = serde_json::to_vec(&document("new")).unwrap();
            let (proof, headers) = proof_for(&f, &authority, &raw).await;
            let original = original(&headers, &|| false);
            let issuer = Issuer {
                control: &control,
                native: &native,
                claim: Mutex::new(None),
                receipt: Mutex::new(None),
            };
            dispatch_import(&issuer, &control, &proof, proof.metadata(), &raw, &original)
                .await
                .unwrap();
            let claim = issuer.claim.lock().unwrap().take().unwrap();
            let receipt = issuer.receipt.lock().unwrap().take().unwrap();
            let mut body = raw.clone();
            let mut moved = None;
            match changed {
                "body" => body.push(b' '),
                "owner" => {
                    let foreign = ExistingAccountImportStore::configured(
                        &RegisteredRenewalOwner::configured(
                            "foreign-owner".into(),
                            home.0.to_str().unwrap().into(),
                        )
                        .unwrap(),
                        f.account.clone(),
                    )
                    .unwrap();
                    assert!(
                        foreign
                            .reconcile(&control, &claim, &proof, &body)
                            .await
                            .is_err()
                    );
                    continue;
                }
                "receipt" => {
                    let path = home.0.join(format!(
                        ".uos-import-{}.receipt",
                        proof.metadata().action_ref
                    ));
                    let mut wire: serde_json::Value =
                        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    wire["operation_id"] = json!("foreign-operation");
                    fs::write(path, serde_json::to_vec(&wire).unwrap()).unwrap();
                }
                "account" => {
                    let mut value = document("foreign");
                    value["tokens"]["account_id"] = json!("foreign-account");
                    home.write_auth(&value);
                }
                "symlink" => {
                    let original = home.0.join("retained-auth.json");
                    fs::rename(home.0.join("auth.json"), &original).unwrap();
                    std::os::unix::fs::symlink(original, home.0.join("auth.json")).unwrap();
                }
                "generation" => home.write_auth(&document("advanced-without-retry")),
                "actor" => {
                    f.store
                        .rows
                        .lock()
                        .unwrap()
                        .get_mut(&passkeys::key("users", "user-fixture").0)
                        .unwrap()
                        .revision = "user-replaced".into();
                }
                "source_cf" => {
                    f.store
                        .rows
                        .lock()
                        .unwrap()
                        .get_mut(&codex_source_pool_key().0)
                        .unwrap()
                        .revision = "source-replaced".into();
                }
                "cancel" => {
                    f.cancel.0.store(true, Ordering::SeqCst);
                }
                _ => {
                    let path = home.0.with_extension("retained");
                    fs::rename(&home.0, &path).unwrap();
                    fs::create_dir(&home.0).unwrap();
                    fs::set_permissions(&home.0, fs::Permissions::from_mode(0o700)).unwrap();
                    moved = Some(path);
                }
            }
            assert!(
                native
                    .reconcile(&control, &claim, &proof, &body)
                    .await
                    .is_err(),
                "{changed}"
            );
            if changed != "body" {
                assert!(
                    native
                        .recheck_receipt(&control, &claim, &proof, &raw, &receipt)
                        .await
                        .is_err(),
                    "{changed}"
                );
            }
            if let Some(path) = moved {
                fs::remove_dir_all(path).unwrap();
            }
        }
    });
}
#[test]
fn production_mutation_is_unavailable_without_real_native_writer_exclusion() {
    let home = Home::fresh();
    let old = document("old");
    home.write_auth(&old);
    let hash = gateway_auth::native_credentials::parse_native_document(&old)
        .unwrap()
        .routing_account_hash();
    let native = ExistingAccountImportStore::configured(
        &RegisteredRenewalOwner::configured("native-owner".into(), home.0.to_str().unwrap().into())
            .unwrap(),
        hash,
    )
    .unwrap();
    let before = fs::read(home.0.join("auth.json")).unwrap();
    let error = native.require_mutation_owner().unwrap_err();
    assert_eq!(error.status, 503);
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("native_import_owner_exclusion_unavailable")
    );
    assert_eq!(fs::read(home.0.join("auth.json")).unwrap(), before);
    assert_eq!(fs::read_dir(&home.0).unwrap().count(), 1);
}

#[test]
fn wrong_uploaded_account_owner_and_physical_source_write_nothing() {
    run(async {
        for changed in ["account", "owner", "source"] {
            let home = Home::fresh();
            let old = document("old");
            home.write_auth(&old);
            let f = fixture(&home, &old);
            let authority = f.authority();
            let control = NativeRenewalAuthority::configured(
                &authority,
                &f.identity,
                &f.owner,
                &f.config,
                &f.cancel,
            );
            let foreign = RegisteredRenewalOwner::configured(
                "foreign-owner".into(),
                home.0.to_str().unwrap().into(),
            )
            .unwrap();
            let native = ExistingAccountImportStore::configured(
                if changed == "owner" {
                    &foreign
                } else {
                    &f.owner
                },
                f.account.clone(),
            )
            .unwrap();
            let mut uploaded = document("new");
            if changed == "account" {
                uploaded["tokens"]["account_id"] = json!("foreign-account");
            }
            let raw = serde_json::to_vec(&uploaded).unwrap();
            let (proof, headers) = proof_for(&f, &authority, &raw).await;
            if changed == "source" {
                home.write_auth(&document("independent-native-advance"));
            }
            let before = fs::read(home.0.join("auth.json")).unwrap();
            let original = original(&headers, &|| false);
            let issuer = Issuer {
                control: &control,
                native: &native,
                claim: Mutex::new(None),
                receipt: Mutex::new(None),
            };
            assert!(
                dispatch_import(&issuer, &control, &proof, proof.metadata(), &raw, &original)
                    .await
                    .is_err(),
                "{changed}"
            );
            assert_eq!(
                fs::read(home.0.join("auth.json")).unwrap(),
                before,
                "{changed}"
            );
            assert_eq!(fs::read_dir(&home.0).unwrap().count(), 1, "{changed}");
            assert!(issuer.receipt.lock().unwrap().is_none());
            let rows = f.store.rows.lock().unwrap();
            assert!(rows.values().all(|row| row.value["phase"] != "published"));
        }
    });
}
