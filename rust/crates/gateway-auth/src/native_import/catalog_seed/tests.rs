use super::*;
use crate::{
    native::{NATIVE_RENEWAL_AUTHORITY_PATH, signature_input},
    native_control::{
        NATIVE_AUTHORITY_MAX_BYTES, NATIVE_CONTROL_ERROR_MAX_BYTES, authority_response_input,
    },
    native_import::{NativeImportMetadata, NativeImportTarget},
};
fn request() -> ImportCatalogSeedRequestData {
    let hash = "a".repeat(64);
    let reference = "r".repeat(256);
    let long = "\u{1}".repeat(4096);
    ImportCatalogSeedRequestData {
        operation: IMPORT_CATALOG_SEED_OPERATION.into(),
        v: 1,
        state: ImportAuthorityStateData {
            action_version: 3,
            metadata: NativeImportMetadata {
                v: 1,
                operation_id: reference.clone(),
                action_ref: hash.clone(),
            },
            target: NativeImportTarget::ExistingAccount {
                account_id_hash: hash.clone(),
            },
            action_revision: long.clone(),
            native_owner_id: long.clone(),
            account_id_hash: hash.clone(),
            source_native_generation: hash.clone(),
            owner_revision: long.clone(),
            source_revision: long.clone(),
            normalized_revision: long,
            created_at_ms: 0,
            deadline_ms: 45_000,
        },
        claim_ref: reference.clone(),
        publication_revision: reference.clone(),
        native_receipt_ref: reference,
        publication_request_digest: hash,
        client_version: "1.2.3".into(),
        source_body: String::new(),
        etag: None,
        content_type: Some("application/json".into()),
    }
}
#[test]
fn exact_existing_frame_ceiling_and_one_over_are_optional_transport_not_raw_caps() {
    let mut request = request();
    let overhead = request.bytes().unwrap().len();
    request.source_body = "x".repeat(NATIVE_MAX_BODY_BYTES - overhead);
    let bytes = request.bytes().unwrap();
    assert_eq!(bytes.len(), NATIVE_MAX_BODY_BYTES);
    assert!(ImportCatalogSeedRequestData::parse(&bytes).is_ok());
    assert!(
        signature_input(
            NATIVE_RENEWAL_AUTHORITY_PATH,
            "fixture-key",
            0,
            &crate::crypto::base64url(&[7; 32]),
            &bytes
        )
        .is_ok()
    );
    request.source_body.push('x');
    assert!(request.bytes().is_err());
    assert!(
        signature_input(
            NATIVE_RENEWAL_AUTHORITY_PATH,
            "fixture-key",
            0,
            &crate::crypto::base64url(&[7; 32]),
            &serde_json::to_vec(&request).unwrap()
        )
        .is_err()
    );
}
#[test]
fn exact_seed_marker_nullable_headers_canonical_and_original_limits_stay_closed() {
    let request = request();
    let bytes = request.bytes().unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value.as_object_mut().unwrap().remove("etag");
    assert!(ImportCatalogSeedRequestData::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    let mut padded = bytes.clone();
    padded.push(b' ');
    assert!(ImportCatalogSeedRequestData::parse(&padded).is_err());
    let mut invalid = request.clone();
    invalid.v = 2;
    assert!(
        crate::native_import::authority::new_request_limit(&serde_json::to_vec(&invalid).unwrap())
            .is_err()
    );
    assert!(
        signature_input(
            NATIVE_RENEWAL_AUTHORITY_PATH,
            "fixture-key",
            0,
            &crate::crypto::base64url(&[7; 32]),
            &vec![b'x'; NATIVE_AUTHORITY_MAX_BYTES + 1]
        )
        .is_err()
    );
    for seeded in [false, true] {
        let reply = ImportCatalogSeedReplyData::new(seeded).bytes().unwrap();
        assert!(
            authority_response_input(
                "fixture-key",
                &crate::crypto::base64url(&[7; 32]),
                &bytes,
                200,
                &reply
            )
            .is_ok()
        );
        assert!(
            authority_response_input(
                "fixture-key",
                &crate::crypto::base64url(&[7; 32]),
                &bytes,
                200,
                b"{\"seeded\":true}"
            )
            .is_err()
        );
        assert!(
            authority_response_input(
                "fixture-key",
                &crate::crypto::base64url(&[7; 32]),
                &bytes,
                500,
                &vec![b'x'; NATIVE_CONTROL_ERROR_MAX_BYTES + 1]
            )
            .is_err()
        );
    }
}
#[test]
fn raw_json_and_headers_are_lossless_not_snapshot_reconstruction() {
    let mut request = request();
    request.source_body =
        r#"{"models":[{"slug":"model-a","unknown":"\ud800","context_window":1}]}"#.into();
    request.etag = Some("  original-tag  ".into());
    let body = request.bytes().unwrap();
    let parsed = ImportCatalogSeedRequestData::parse(&body).unwrap();
    assert_eq!(parsed.source_body, request.source_body);
    assert_eq!(parsed.etag, request.etag);
    let mut bad = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
    bad["extra"] = serde_json::json!(1);
    assert!(ImportCatalogSeedRequestData::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
}
