use gateway_auth::{
    GatewayError,
    crypto::{base64url, sha256_hex},
    native_auth::*,
    native_import::*,
};
use std::{
    collections::BTreeSet,
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = future.as_mut().poll(&mut context) {
            return v;
        }
    }
}
#[derive(Default)]
struct Replay(Mutex<BTreeSet<String>>);
impl NativeNonceAuthority for Replay {
    async fn consume_nonce(
        &self,
        key: &str,
        nonce: &str,
        _: i64,
        _: i64,
    ) -> Result<(), GatewayError> {
        if self.0.lock().unwrap().insert(format!("{key}:{nonce}")) {
            Ok(())
        } else {
            Err(GatewayError::new(401, "replay", Some("fixture_replay")))
        }
    }
}
fn identity(cap: NativeCapability) -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "import-test".into(),
        "owner".into(),
        "epoch".into(),
        [7; 32],
        BTreeSet::from([cap]),
    )
    .unwrap()
}
fn metadata() -> NativeImportMetadata {
    NativeImportMetadata {
        v: 1,
        operation_id: "operation".into(),
        action_ref: "action".into(),
    }
}
async fn admit(
    id: &NativeTransportIdentity,
    replay: &Replay,
    kind: NativeImportKind,
    metadata: &NativeImportMetadata,
    body: &[u8],
    nonce: &str,
    timing: (&str, i64, Option<&str>),
) -> Result<NativeImportAdmission, GatewayError> {
    let (time, now, mac) = timing;
    let digest = sha256_hex(body);
    let signature = id
        .sign_import(kind, metadata, &digest, time.parse().unwrap(), nonce)
        .unwrap();
    NativeAuthenticator::new(id, replay)
        .admit_import(
            kind,
            NativeImportAuthHeaders {
                auth: NativeAuthHeaders {
                    version: "1",
                    key_id: id.key_id(),
                    time_ms: time,
                    nonce,
                    mac: mac.unwrap_or(&signature),
                },
                body_sha256: &digest,
            },
            metadata,
            now,
        )
        .await
}
#[test]
fn native_import_domains_metadata_and_unknown_fields_fail_closed() {
    let meta = metadata();
    let nonce = base64url(&[1; 32]);
    let digest = sha256_hex(b"document");
    let auth = signature_input(
        NativeImportKind::CodexAuth,
        &meta,
        &digest,
        "import-test",
        1000,
        &nonce,
    )
    .unwrap();
    let profile = signature_input(
        NativeImportKind::NativeProfile,
        &meta,
        &digest,
        "import-test",
        1000,
        &nonce,
    )
    .unwrap();
    assert_ne!(auth, profile);
    let legacy = gateway_auth::native::signature_input(
        gateway_auth::native::NATIVE_CONTROL_PATH,
        "import-test",
        1000,
        &nonce,
        b"document",
    )
    .unwrap();
    assert_ne!(auth, legacy);
    assert!(
        serde_json::from_str::<NativeImportMetadata>(
            r#"{"v":1,"operation_id":"operation","action_ref":"action","unknown":true}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<NativeImportTarget>(
            r#"{"kind":"existing_account","account_id_hash":"aa","permission":true}"#
        )
        .is_err()
    );
    let mut bad = meta;
    bad.v = 2;
    assert!(bad.validate().is_err());
    bad.v = 1;
    bad.action_ref = "../home".into();
    assert!(bad.validate().is_err());
}
#[test]
fn actual_mac_nonce_body_and_expiry_proofs_do_not_create_effect_authority() {
    run(async {
        let id = identity(NativeCapability::CodexAuthImport);
        let replay = Replay::default();
        let nonce = base64url(&[2; 32]);
        let meta = metadata();
        let proof = admit(
            &id,
            &replay,
            NativeImportKind::CodexAuth,
            &meta,
            b"original",
            &nonce,
            ("1000", 1000, None),
        )
        .await
        .unwrap();
        assert!(
            admit(
                &id,
                &replay,
                NativeImportKind::CodexAuth,
                &meta,
                b"original",
                &nonce,
                ("1000", 1000, None)
            )
            .await
            .is_err()
        );
        assert!(proof.verify_body(b"other", 1000).is_err());
        let proof = admit(
            &id,
            &replay,
            NativeImportKind::CodexAuth,
            &meta,
            b"original",
            &base64url(&[3; 32]),
            ("1000", 1000, None),
        )
        .await
        .unwrap();
        let body = proof.verify_body(b"original", 1000).unwrap();
        assert_eq!(body.metadata(), &meta);
        assert!(body.require_body(b"other", 1000).is_err());
        assert!(body.require_body(b"original", 31001).is_err());
        let other = NativeTransportIdentity::new(
            "import-test".into(),
            "other-owner".into(),
            "epoch".into(),
            [7; 32],
            BTreeSet::from([NativeCapability::CodexAuthImport]),
        )
        .unwrap();
        assert!(body.require_owner(&other, 1000).is_err());
    });
}
#[test]
fn wrong_capability_kind_signature_and_canonical_time_refuse_before_body() {
    run(async {
        let replay = Replay::default();
        let meta = metadata();
        let nonce = base64url(&[4; 32]);
        let id = identity(NativeCapability::OwnerRenewal);
        assert!(
            admit(
                &id,
                &replay,
                NativeImportKind::CodexAuth,
                &meta,
                b"document",
                &nonce,
                ("1000", 1000, None)
            )
            .await
            .is_err()
        );
        assert!(replay.0.lock().unwrap().is_empty());
        let id = identity(NativeCapability::CodexAuthImport);
        let digest = sha256_hex(b"document");
        let mac = id
            .sign_import(NativeImportKind::CodexAuth, &meta, &digest, 1000, &nonce)
            .unwrap();
        assert!(
            NativeAuthenticator::new(&id, &replay)
                .admit_import(
                    NativeImportKind::NativeProfile,
                    NativeImportAuthHeaders {
                        auth: NativeAuthHeaders {
                            version: "1",
                            key_id: id.key_id(),
                            time_ms: "1000",
                            nonce: &nonce,
                            mac: &mac
                        },
                        body_sha256: &digest
                    },
                    &meta,
                    1000
                )
                .await
                .is_err()
        );
        assert!(
            admit(
                &id,
                &replay,
                NativeImportKind::CodexAuth,
                &meta,
                b"document",
                &nonce,
                ("01000", 1000, None)
            )
            .await
            .is_err()
        );
        assert!(
            admit(
                &id,
                &replay,
                NativeImportKind::CodexAuth,
                &meta,
                b"document",
                &nonce,
                ("1000", 31001, None)
            )
            .await
            .is_err()
        );
        assert!(
            admit(
                &id,
                &replay,
                NativeImportKind::CodexAuth,
                &meta,
                b"document",
                &nonce,
                ("1000", 1000, Some("invalid"))
            )
            .await
            .is_err()
        );
        assert!(replay.0.lock().unwrap().is_empty());
    });
}
#[test]
fn import_domain_does_not_inherit_legacy_rpc_body_cap_or_claim_parser_success() {
    run(async {
        let body = vec![b'x'; gateway_auth::native::NATIVE_MAX_BODY_BYTES + 1];
        let id = identity(NativeCapability::CodexAuthImport);
        let replay = Replay::default();
        let proof = admit(
            &id,
            &replay,
            NativeImportKind::CodexAuth,
            &metadata(),
            &body,
            &base64url(&[5; 32]),
            ("1000", 1000, None),
        )
        .await
        .unwrap();
        assert!(proof.verify_body(&body, 1000).is_ok());
        assert_eq!(
            NativeImportKind::CodexAuth.body_limit_bytes(),
            32 * 1024 * 1024
        );
        assert_eq!(
            NativeImportKind::NativeProfile.body_limit_bytes(),
            5 * 1024 * 1024
        );
    });
}
