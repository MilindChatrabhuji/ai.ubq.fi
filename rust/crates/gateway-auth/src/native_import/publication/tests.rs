use super::*;
use crate::native_auth::{NativeCapability, NativeTransportIdentity};
use std::collections::BTreeSet;
fn request(normalized: bool) -> ImportPublicationCommandData {
    let id = codex_credential_identity(
        "account",
        &Secret::new("SYNTHETIC_ACCESS".into()),
        &Secret::new(String::new()),
    );
    ImportPublicationCommandData {
        operation: "codex_auth_import_publish".into(),
        v: 1,
        action_ref: "a".repeat(64),
        operation_id: "r".repeat(256),
        claim_ref: "r".repeat(256),
        native_owner_id: "\u{1}".repeat(4096),
        owner_revision: "\u{1}".repeat(4096),
        source_revision: "\u{1}".repeat(4096),
        normalized_revision: "\u{1}".repeat(4096),
        publication_revision: "r".repeat(256),
        account_id_hash: id.routing_account_hash.0,
        previous_native_source_generation: "c".repeat(64),
        native_source_generation: "d".repeat(64),
        access_generation: id.native_generation_hash,
        native_receipt_ref: "r".repeat(256),
        document: ImportAccessDocument {
            account_id: "account".into(),
            access_token: "SYNTHETIC_ACCESS".into(),
            updated_at_ms: 1_000_000.0,
            native_refreshed_at: None,
        },
        catalog: if normalized {
            ImportCatalogData::Normalized {
                snapshot: SourceJson::parse(r#"{"models":[{"slug":"\ud800"}]}"#).unwrap(),
                client_version: "0".repeat(SNAPSHOT_MAX_BYTES - 6) + ".0.0",
                upstream_status: 299,
            }
        } else {
            ImportCatalogData::AuthenticatedLimited {
                upstream_status: 429,
            }
        },
    }
}
fn reply(request: &ImportPublicationCommandData, body: &[u8]) -> NativeImportPublication {
    let normalized = matches!(request.catalog, ImportCatalogData::Normalized { .. });
    let retained = if normalized {
        request.publication_revision.clone()
    } else {
        "\u{1}".repeat(4096)
    };
    let identity = codex_credential_identity(
        &request.document.account_id,
        &Secret::new(request.document.access_token.clone()),
        &Secret::new(String::new()),
    );
    NativeImportPublication {
        v: 1,
        operation_id: request.operation_id.clone(),
        action_ref: request.action_ref.clone(),
        disposition: NativeImportPublicationDisposition::AlreadyCurrent,
        publication: ImportPublicationDataV1 {
            v: 1,
            operation_id: request.operation_id.clone(),
            claim_ref: request.claim_ref.clone(),
            publication_revision: request.publication_revision.clone(),
            native_receipt_ref: request.native_receipt_ref.clone(),
            native_source_generation: request.native_source_generation.clone(),
            access_generation: request.access_generation.clone(),
            credential_version: identity.credential_version.0,
            source_revision: request.publication_revision.clone(),
            normalized_revision: request.publication_revision.clone(),
            catalog_revision: Some(retained.clone()),
            runtime_revision: Some(retained.clone()),
            auth_generation_revision: Some(retained.clone()),
            paid_control_config_revision: Some(retained),
            publication_request_digest: sha256_hex(body),
            catalog_disposition: request.catalog.disposition(),
        },
    }
}
fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "publication-fixture".into(),
        "owner".into(),
        "epoch".into(),
        [9; 32],
        BTreeSet::from([NativeCapability::CodexAuthImport]),
    )
    .unwrap()
}
#[test]
fn exact_limited_maximum_can_be_authenticated_but_one_more_byte_cannot() {
    let request = request(false);
    let body = request.bytes().unwrap();
    let reply = reply(&request, &body);
    let bytes = serde_json::to_vec(&reply).unwrap();
    let cap = import_publication_reply_max_bytes();
    assert_eq!(bytes.len(), cap);
    assert!(cap > 65_536);
    println!("derived-import-publication-reply-max-bytes={cap}");
    let nonce = crate::crypto::base64url(&[7; 32]);
    let id = identity();
    let mac = id
        .sign_publication_response(&nonce, &body, 200, &bytes)
        .unwrap();
    id.verify_publication_response(&nonce, &body, 200, &bytes, &mac)
        .unwrap();
    let mut over = bytes;
    over.push(b' ');
    assert!(
        id.sign_publication_response(&nonce, &body, 200, &over)
            .is_err()
    );
}
#[test]
fn normalized_max_version_and_lone_utf16_command_retain_exact_shared_domain() {
    let request = request(true);
    let body = request.bytes().unwrap();
    let parsed = ImportPublicationCommandData::parse(&body).unwrap();
    let ImportCatalogData::Normalized {
        snapshot,
        client_version,
        ..
    } = &parsed.catalog
    else {
        panic!("normalized")
    };
    assert!(snapshot.as_str().contains("\\ud800"));
    assert_eq!(
        serde_json::to_vec(client_version).unwrap().len(),
        SNAPSHOT_MAX_BYTES
    );
    let reply = reply(&request, &body);
    let bytes = serde_json::to_vec(&reply).unwrap();
    assert!(bytes.len() <= import_publication_reply_max_bytes());
    let nonce = crate::crypto::base64url(&[8; 32]);
    identity()
        .sign_publication_response(&nonce, &body, 200, &bytes)
        .unwrap();
    let mut over = request.clone();
    if let ImportCatalogData::Normalized { client_version, .. } = &mut over.catalog {
        client_version.insert(0, '0');
    }
    assert!(over.bytes().is_err());
}
#[test]
fn wrong_terminal_pair_request_digest_or_required_nullable_cannot_get_large_bound() {
    let request = request(false);
    let body = request.bytes().unwrap();
    let good = reply(&request, &body);
    for field in [
        "action_ref",
        "claim_ref",
        "native_receipt_ref",
        "native_source_generation",
        "access_generation",
        "credential_version",
        "source_revision",
        "normalized_revision",
        "publication_request_digest",
    ] {
        let mut altered = serde_json::to_value(&good).unwrap();
        if field == "action_ref" {
            altered[field] = serde_json::json!("f".repeat(64));
        } else {
            altered["publication"][field] = serde_json::json!("f".repeat(64));
        }
        assert!(
            new_reply_limit(&body, 200, &serde_json::to_vec(&altered).unwrap()).is_err(),
            "{field}"
        );
    }
    let mut missing = serde_json::to_value(&good).unwrap();
    missing["publication"]
        .as_object_mut()
        .unwrap()
        .remove("runtime_revision");
    assert!(new_reply_limit(&body, 200, &serde_json::to_vec(&missing).unwrap()).is_err());
    let mut extra = serde_json::to_value(&good).unwrap();
    extra["public_generation"] = serde_json::json!(true);
    assert!(new_reply_limit(&body, 200, &serde_json::to_vec(&extra).unwrap()).is_err());
    let mut wrong_body = body.clone();
    wrong_body.push(b' ');
    assert!(new_reply_limit(&wrong_body, 200, &serde_json::to_vec(&good).unwrap()).is_err());
}
#[test]
fn old_publication_and_every_error_reply_keep_exact_old_cap() {
    let nonce = crate::crypto::base64url(&[4; 32]);
    let id = identity();
    let old = b"{}";
    let exact = vec![b'x'; 65_536];
    let over = vec![b'x'; 65_537];
    for status in [200, 400, 500] {
        id.sign_publication_response(&nonce, old, status, &exact)
            .unwrap();
        assert!(
            id.sign_publication_response(&nonce, old, status, &over)
                .is_err()
        );
    }
    let request = request(false).bytes().unwrap();
    for status in [400, 500] {
        id.sign_publication_response(&nonce, &request, status, &exact)
            .unwrap();
        assert!(
            id.sign_publication_response(&nonce, &request, status, &over)
                .is_err()
        );
    }
    let mixed = br#"{"operation":"codex_auth_import_publish","v":1,"config":{}}"#;
    assert!(
        id.sign_publication_response(&nonce, mixed, 200, &exact)
            .is_err()
    );
    let unknown = br#"{"operation":"codex_auth_import_publish_unknown","v":1}"#;
    assert!(
        id.sign_publication_response(&nonce, unknown, 200, &over)
            .is_err()
    );
}
#[test]
fn overlong_retained_revision_and_normalized_revision_mismatch_refuse() {
    for normalized in [false, true] {
        let request = request(normalized);
        let body = request.bytes().unwrap();
        let mut response = reply(&request, &body);
        response.publication.runtime_revision = Some(if normalized {
            "wrong".into()
        } else {
            "\u{1}".repeat(4097)
        });
        assert!(response.validate_for(&request, &body).is_err());
    }
}

#[test]
fn selected_auth_timestamp_is_required_finite_and_inside_existing_access_document_budget() {
    for value in [
        0.0,
        -0.0,
        1_000_012.25,
        -f64::MAX,
        f64::MAX,
        f64::MIN_POSITIVE,
        f64::from_bits(1),
    ] {
        let mut row = request(false);
        row.document.updated_at_ms = value;
        let fixed = serde_json::to_vec(&row.document).unwrap().len();
        row.document
            .access_token
            .push_str(&"x".repeat(ACCESS_MAX_BYTES - fixed));
        assert_eq!(
            serde_json::to_vec(&row.document).unwrap().len(),
            ACCESS_MAX_BYTES
        );
        let body = row.bytes().unwrap();
        let decoded = ImportPublicationCommandData::parse(&body).unwrap();
        assert_eq!(decoded.document.updated_at_ms.to_bits(), value.to_bits());
        row.document.access_token.push('x');
        assert!(row.bytes().is_err());
    }
    let mut row = request(false);
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        row.document.updated_at_ms = value;
        assert!(row.bytes().is_err());
    }
    let mut value = serde_json::to_value(request(false)).unwrap();
    value["document"]
        .as_object_mut()
        .unwrap()
        .remove("updated_at_ms");
    assert!(ImportPublicationCommandData::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    value["document"]["updated_at_ms"] = serde_json::Value::Null;
    assert!(ImportPublicationCommandData::parse(&serde_json::to_vec(&value).unwrap()).is_err());
}
