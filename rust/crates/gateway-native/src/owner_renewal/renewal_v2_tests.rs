use super::*;
use crate::managed_publication_http::NativeAccessPublicationHttp;
use gateway_auth::{
    crypto::Secret,
    native::*,
    native_auth::{NativeAuthHeaders, NativeCapability, NativeTransportIdentity},
};
use gateway_authority::{
    cache_experiment::{
        RefreshContext, Sample, TargetBinding, Usage,
        model::{PROFILE, PROVIDER, SLOTS, STEPS, TELEMETRY_PROVIDER},
    },
    native_control::NativeRenewalContext,
};
use gateway_core::identity::{
    AccountBinding, CredentialVersion, PoolVersionstamp, RoutingAccountHash,
};
use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::*};
use serde_json::json;
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [47; 32],
        BTreeSet::from([
            NativeCapability::OwnerRenewal,
            NativeCapability::AccessPublish,
        ]),
    )
    .unwrap()
}
fn connected() -> bool {
    false
}
fn context() -> NativeControlContext<'static> {
    NativeControlContext::admitted(
        Instant::now() + Duration::from_secs(3),
        &connected,
        NativeAuthHeaders {
            version: "1",
            key_id: "fixture-key",
            time_ms: "1",
            nonce: "fixture-only",
            mac: "fixture-only",
        },
    )
}
fn binding() -> AccountBinding {
    AccountBinding {
        account_id_hash: RoutingAccountHash("a".repeat(64)),
        credential_version: CredentialVersion("opaque-credential-old".into()),
        pool_versionstamp: PoolVersionstamp("opaque-pool".into()),
        slot: 1,
        routing_generation: 7,
    }
}
fn contexts() -> Vec<NativeRenewalContext> {
    let target = TargetBinding {
        id: "fixture-target".into(),
        provider: PROVIDER.into(),
        telemetry_provider: TELEMETRY_PROVIDER.into(),
        topology_kind: "codex_account_pool".into(),
        model: "fixture-model".into(),
        probe_profile: PROFILE.into(),
        capability_fingerprint: "opaque-capability".into(),
        inventory_fingerprint: "opaque-inventory".into(),
        catalog_versionstamp: "opaque-catalog".into(),
        runtime_versionstamp: "opaque-runtime".into(),
        auth_pool_versionstamp: "opaque-pool".into(),
        auth_pool_identity_fingerprint: "opaque-pool-identity".into(),
        catalog_client_version: None,
    };
    target.validate().unwrap();
    let prefix = std::array::from_fn(|i| {
        let usage = Usage {
            input_tokens: 2500,
            cached_tokens: if i == 0 || i == 2 { 0 } else { 2400 },
            cache_write_tokens: if i == 0 || i == 2 { 2400 } else { 0 },
            output_tokens: 1,
            total_tokens: 2501,
        };
        Sample {
            step: STEPS[i].into(),
            slot: SLOTS[i],
            raw_usage: usage.clone(),
            usage,
            elapsed_ms: 1,
        }
    });
    vec![
        NativeRenewalContext::Inference {
            attempt_id: "actual-fixture-attempt".into(),
            original_admission_digest: "opaque-admission-digest".into(),
            model: "fixture-model".into(),
            slot: 1,
        },
        NativeRenewalContext::LiveCreate {
            binding: binding(),
            active_generation: 7,
            model_utf16: Some(vec![0xd800]),
        },
        NativeRenewalContext::LiveCreate {
            binding: binding(),
            active_generation: 7,
            model_utf16: None,
        },
        NativeRenewalContext::LiveMapped {
            call_id: "rtc_fixture".into(),
            mapping_revision: "opaque-mapping-revision".into(),
        },
        NativeRenewalContext::CacheExperiment {
            context: Box::new(RefreshContext {
                v: 1,
                release_git_sha: "1".repeat(40),
                target,
                campaign_owner: "campaign-owner".into(),
                cycle_owner: "cycle-owner".into(),
                cycle: 1,
                source_pool_revision: "opaque-pool".into(),
                slot: 1,
                state_revision: "state-revision".into(),
                cycle_lease_revision: "cycle-revision".into(),
                campaign_lease_revision: "campaign-revision".into(),
                prefix,
            }),
        },
    ]
}
fn fence(context: NativeRenewalContext) -> NativeRenewalFence {
    NativeRenewalFence {
        v: NATIVE_RENEWAL_FENCE_VERSION,
        owner_id: "fixture-owner".into(),
        owner_epoch: "fixture-epoch".into(),
        owner_revision: "opaque-owner-revision".into(),
        native_owner_id: "native-second".into(),
        source_revision: "opaque-source-revision".into(),
        normalized_revision: "opaque-normalized-revision".into(),
        account_id_hash: "a".repeat(64),
        credential_version: "opaque-credential-old".into(),
        source_native_generation: "b".repeat(64),
        access_generation: "c".repeat(64),
        access_expires_at_ms: None,
        native_refreshed_at: None,
        principal: "fixture-principal".into(),
        principal_policy_digest: "opaque-policy-digest".into(),
        original_request_id: "actual-fixture-request".into(),
        context,
    }
}
fn pair() -> (TcpStream, TcpStream, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (peer, _) = listener.accept().unwrap();
    (client, peer, port)
}
fn generation(external: bool) -> NativeGeneration {
    let now = context().now_ms().unwrap();
    let access=format!("e30.{}.fixture",base64url(json!({"exp":now/1000+3600,"https://api.openai.com/auth":{"chatgpt_user_id":"fixture-user","chatgpt_account_id":"fixture-workspace"}}).to_string().as_bytes()));
    let credentials = NativeCredentials {
        account_id: "fixture-workspace".into(),
        access_token: Secret::new(access),
        refresh_token: Secret::new(if external { "" } else { "fixture-refresh" }.into()),
        email: None,
        native_refreshed_at: Some("2026-10-19T00:00:00Z".into()),
        external_user_id: external.then(|| "fixture-user".into()),
    };
    NativeGeneration {
        fence: OwnerFence {
            owner: NativeOwnerId("native-second".into()),
            account_id: credentials.account_id.clone(),
            generation_hash: credentials.generation_hash(),
            authority_revision: "opaque-owner-revision".into(),
        },
        credentials,
        observed_at_ms: now,
    }
}

#[test]
fn constructed_unsupported_fence_never_writes_either_publication_protocol() {
    let managed = generation(false);
    let projection = ManagedAccessProjection::from_native(&managed).unwrap();
    let external = generation(true);
    for version in [0, 1, 3, u8::MAX] {
        let (mut bad, request) = (
            fence(contexts().remove(0)),
            NativeControlEnvelope {
                v: 1,
                operation_id: "operation".into(),
                request: NativeControlRequest::CodexRenewAccess {
                    action_ref: "opaque-action".into(),
                },
            },
        );
        bad.account_id_hash = managed.credentials.routing_account_hash();
        bad.v = version;
        let (client, peer, port) = pair();
        peer.set_nonblocking(true).unwrap();
        let publisher = NativeAccessPublicationHttp::from_connected(
            &format!("https://localhost:{port}{NATIVE_PUBLICATION_PATH}"),
            client,
            identity(),
        )
        .unwrap();
        assert!(
            publisher
                .managed(&request, &bad, &projection, &context())
                .is_err()
        );
        assert!(publisher.external(&bad, &external, &context()).is_err());
        assert!(
            matches!(peer.peek(&mut[0;1]),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
        );
    }
}
struct NoPublication;
impl NativeAccessPublisher for NoPublication {
    fn managed(
        &self,
        _: &NativeControlEnvelope,
        _: &NativeRenewalFence,
        _: &ManagedAccessProjection,
        _: &NativeControlContext<'_>,
    ) -> Result<PublishedAccess, GatewayError> {
        panic!("invalid fence reached publisher")
    }
    fn external(
        &self,
        _: &NativeRenewalFence,
        _: &NativeGeneration,
        _: &NativeControlContext<'_>,
    ) -> Result<PublishedAccess, GatewayError> {
        panic!("invalid fence reached publisher")
    }
}
#[test]
fn constructed_unsupported_fence_cannot_reconcile_or_enter_native_effects() {
    let (client, peer, port) = pair();
    peer.set_nonblocking(true).unwrap();
    let authority = NativeAuthorityHttp::from_connected(
        &format!("https://localhost:{port}{NATIVE_RENEWAL_AUTHORITY_PATH}"),
        client,
        identity(),
    )
    .unwrap();
    let service = NativeOwnerRenewalService::configured(
        authority,
        NoPublication,
        vec![
            NativeOwnerLocation::configured(
                NativeOwnerId("native-second".into()),
                "/tmp/fixture-only/unopened-native-owner".into(),
            )
            .unwrap(),
        ],
    )
    .unwrap();
    let mut bad = fence(contexts().remove(1));
    bad.v = 1;
    let claim = RemoteClaim {
        action_ref: "opaque-action".into(),
        operation_id: "opaque-operation".into(),
        claim_ref: "opaque-claim".into(),
        start_permit: RefCell::new(None),
        mode: NativeRenewalMode::ReconcileOnly,
        deadline_ms: 0,
        fence: bad,
        publication_revision: Some("opaque-publication".into()),
    };
    assert!(service.execute(&claim, &context()).is_err());
    assert!(
        matches!(peer.peek(&mut[0;1]),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
}
fn request_bytes(stream: &mut impl Read) -> (String, Vec<u8>) {
    let mut bytes = Vec::new();
    loop {
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            let head = std::str::from_utf8(&bytes[..end]).unwrap();
            let header = |name: &str| {
                head.lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))
                    .unwrap()
                    .1
                    .trim()
                    .to_owned()
            };
            let size = header("content-length").parse::<usize>().unwrap();
            if bytes.len() >= end + 4 + size {
                return (
                    header(NATIVE_NONCE_HEADER),
                    bytes[end + 4..end + 4 + size].to_vec(),
                );
            }
        }
        assert!(bytes.len() < 100_000);
        let mut block = [0; 4096];
        let n = stream.read(&mut block).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&block[..n]);
    }
}
fn signed_recheck<T: serde::Serialize + Send + 'static>(
    value: T,
    replayed_body: bool,
) -> Result<Response, GatewayError> {
    let (client, peer, port) = pair();
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    peer.set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let server = thread::spawn(move || {
        let cert = CertificateDer::from(
            include_bytes!("../../tests/fixtures/native-tls/leaf.der").to_vec(),
        );
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            include_bytes!("../../tests/fixtures/native-tls/leaf.pk8.der").to_vec(),
        ));
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .unwrap();
        let mut tls = StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), peer);
        let (nonce, body) = request_bytes(&mut tls);
        assert!(matches!(
            Request::parse(&body).unwrap(),
            Request::Recheck { v: 1, .. }
        ));
        #[derive(serde::Serialize)]
        struct RecheckFrame<T> {
            v: u8,
            operation: &'static str,
            fence: T,
        }
        let response = serde_json::to_vec(&RecheckFrame {
            v: 1,
            operation: "recheck",
            fence: value,
        })
        .unwrap();
        let old = serde_json::to_vec(&Request::Recheck {
            v: 1,
            operation_id: "old-opaque-operation".into(),
            claim_ref: "old-opaque-claim".into(),
        })
        .unwrap();
        let mac = identity()
            .sign_authority_response(
                &nonce,
                if replayed_body { &old } else { &body },
                200,
                &response,
            )
            .unwrap();
        tls.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{NATIVE_RESPONSE_MAC_HEADER}: {mac}\r\nConnection: close\r\n\r\n",response.len()).as_bytes()).unwrap();
        tls.write_all(&response).unwrap();
        tls.flush().unwrap();
    });
    let ca =
        ureq::tls::Certificate::from_der(include_bytes!("../../tests/fixtures/native-tls/ca.der"))
            .to_owned();
    let authority = NativeAuthorityHttp::with_roots(
        &format!("https://localhost:{port}{NATIVE_RENEWAL_AUTHORITY_PATH}"),
        client,
        identity(),
        ureq::tls::RootCerts::new_with_certs(&[ca]),
    )
    .unwrap();
    let result = authority.exchange(
        &Request::Recheck {
            v: 1,
            operation_id: "new-opaque-operation".into(),
            claim_ref: "new-opaque-claim".into(),
        },
        &context(),
    );
    server.join().unwrap();
    result
}
#[test]
fn actual_signed_v2_rechecks_preserve_four_contexts_and_opaque_old_new_versions() {
    for (index, context) in contexts().into_iter().enumerate() {
        let mut expected = fence(context);
        expected.credential_version = if index % 2 == 0 {
            "opaque-old"
        } else {
            "opaque-new"
        }
        .into();
        let response = signed_recheck(expected.clone(), false).unwrap();
        assert!(matches!(response,Response::Recheck{v:1,fence} if fence==expected));
    }
}
#[test]
fn actual_signed_v2_rechecks_preserve_source_model_units_as_ordinary_strings() {
    use gateway_core::{js_string::JsString16, model::ModelId};
    for units in [
        vec![0xd800],
        vec![0xdc00],
        vec![0xfffd],
        vec![0xd83d, 0xde80],
        vec![0, 10, 34, 92],
        r"\ud800".encode_utf16().collect(),
        vec![u16::from(b'm'); 4097],
    ] {
        let model = ModelId::from_source(JsString16::from_units(units.clone()));
        let expected = fence(NativeRenewalContext::Inference {
            attempt_id: "actual-fixture-attempt".into(),
            original_admission_digest: "opaque-admission-digest".into(),
            model,
            slot: 1,
        });
        let wire = serde_json::to_vec(&expected).unwrap();
        assert!(wire.windows(8).any(|part| part == b"\"model\":"));
        assert!(!wire.windows(11).any(|part| part == b"model_utf16"));
        let response = signed_recheck(expected.clone(), false).unwrap();
        let Response::Recheck { v: 1, fence } = response else {
            panic!("expected the actual signed v1 recheck response");
        };
        assert_eq!(fence, expected);
        assert!(
            matches!(fence.context, NativeRenewalContext::Inference { model, .. }
            if model.as_js_string().as_units() == units)
        );
        assert!(signed_recheck(expected, true).is_err());
    }
}
#[test]
fn actual_signed_rechecks_reject_legacy_missing_and_replayed_frames() {
    let original = serde_json::to_value(fence(contexts().remove(1))).unwrap();
    let mut legacy = original.clone();
    legacy["v"] = json!(1);
    assert!(signed_recheck(legacy, false).is_err());
    for field in [
        "v",
        "context",
        "access_expires_at_ms",
        "native_refreshed_at",
    ] {
        let mut missing = original.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(signed_recheck(missing, false).is_err());
    }
    let mut omitted_model = original.clone();
    omitted_model["context"]
        .as_object_mut()
        .unwrap()
        .remove("model_utf16");
    assert!(signed_recheck(omitted_model, false).is_err());
    assert!(signed_recheck(original, true).is_err());
    let mut replaced = serde_json::to_value(fence(contexts().remove(0))).unwrap();
    replaced["owner_epoch"] = json!("replacement-epoch");
    assert!(signed_recheck(replaced, false).is_err());
}
