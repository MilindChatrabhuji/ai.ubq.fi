use super::*;
use crate::{
    crypto::base64url,
    native::{NATIVE_MAX_BODY_BYTES, NATIVE_RENEWAL_AUTHORITY_PATH, signature_input},
    native_control::{
        NATIVE_AUTHORITY_MAX_BYTES, NATIVE_CONTROL_MAX_BYTES, authority_response_input,
    },
};
fn nonce() -> String {
    base64url(&[9; 32])
}
fn accepts_request(body: &[u8]) -> bool {
    signature_input(
        NATIVE_RENEWAL_AUTHORITY_PATH,
        "fixture-key",
        1,
        &nonce(),
        body,
    )
    .is_ok()
}
fn accepts_reply(request: &[u8], body: &[u8]) -> bool {
    authority_response_input("fixture-key", &nonce(), request, 200, body).is_ok()
}

#[test]
fn only_exact_new_lifecycle_gets_derived_larger_request_bound() {
    let state = max_state();
    let request = ImportAuthorityRequestData::new(ImportAuthorityCommand::Start {
        state,
        claim_ref: "r".repeat(256),
        start_permit: "\u{1}".repeat(4096),
    })
    .unwrap();
    let bytes = request.bytes().unwrap();
    assert_eq!(bytes.len(), import_authority_request_max_bytes());
    assert!(bytes.len() > NATIVE_AUTHORITY_MAX_BYTES);
    assert!(bytes.len() < NATIVE_MAX_BODY_BYTES);
    assert!(accepts_request(&bytes));
    let mut over = bytes.clone();
    over.push(b' ');
    assert!(!accepts_request(&over));
    for field in [
        "unknown",
        "started_revision",
        "body_digest",
        "refresh_token",
    ] {
        let mut mixed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        mixed[field] = serde_json::json!("forbidden");
        assert!(
            !accepts_request(&serde_json::to_vec(&mixed).unwrap()),
            "{field}"
        );
    }
    let mut wrong = request;
    wrong.v = 2;
    assert!(!accepts_request(&serde_json::to_vec(&wrong).unwrap()));
}
#[test]
fn bare_b1_exact_twelve_fields_keep_original_canonical_mac_body() {
    let request = max_custody();
    let bytes = request.bytes().unwrap();
    assert_eq!(bytes.len(), import_custody_request_max_bytes());
    assert!(bytes.len() > NATIVE_AUTHORITY_MAX_BYTES);
    assert!(accepts_request(&bytes));
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 12);
    assert!(value.get("operation").is_none());
    for kind in ["extra", "mixed", "missing", "version", "noncanonical"] {
        let mut value = value.clone();
        match kind {
            "extra" => {
                value["extra"] = serde_json::json!(true);
            }
            "mixed" => {
                value["operation"] = serde_json::json!("start");
            }
            "missing" => {
                value.as_object_mut().unwrap().remove("claim_ref");
            }
            "version" => {
                value["v"] = serde_json::json!(2);
            }
            _ => {}
        }
        let mut wrong = serde_json::to_vec(&value).unwrap();
        if kind == "noncanonical" {
            wrong.insert(0, b' ');
        }
        assert!(!accepts_request(&wrong), "{kind}");
    }
    let mut over = bytes;
    over.push(b' ');
    assert!(!accepts_request(&over));
}
#[test]
fn old_request_and_success_error_bounds_never_expand() {
    let mut old = br#"{"operation":"start","v":1,"operation_id":"op","claim_ref":"claim","start_permit":"permit"}"#.to_vec();
    old.resize(NATIVE_AUTHORITY_MAX_BYTES, b' ');
    assert!(accepts_request(&old));
    old.push(b' ');
    assert!(!accepts_request(&old));
    old.pop();
    let mut reply = vec![b'x'; NATIVE_CONTROL_MAX_BYTES];
    assert!(accepts_reply(&old, &reply));
    reply.push(b'x');
    assert!(!accepts_reply(&old, &reply));
    let error = vec![b'x'; NATIVE_CONTROL_ERROR_MAX_BYTES];
    assert!(authority_response_input("fixture-key", &nonce(), &old, 503, &error).is_ok());
    let error = vec![b'x'; NATIVE_CONTROL_ERROR_MAX_BYTES + 1];
    assert!(authority_response_input("fixture-key", &nonce(), &old, 503, &error).is_err());
    assert_eq!(new_request_limit(&old).unwrap(), None);
}
#[test]
fn new_replies_require_exact_direction_phase_binding_and_canonical_bytes() {
    let state = max_state();
    let request = ImportAuthorityRequestData::new(ImportAuthorityCommand::Start {
        state: state.clone(),
        claim_ref: "r".repeat(256),
        start_permit: "\u{1}".repeat(4096),
    })
    .unwrap();
    let body = request.bytes().unwrap();
    let reply = ImportAuthorityReplyData::new(ImportAuthorityResult::Start {
        state: state.clone(),
        claim_ref: "r".repeat(256),
        started_revision: Some("\u{1}".repeat(4096)),
    });
    let bytes = serde_json::to_vec(&reply).unwrap();
    assert!(bytes.len() > NATIVE_CONTROL_MAX_BYTES);
    assert!(accepts_reply(&body, &bytes));
    let wrong_phase = ImportAuthorityReplyData::new(ImportAuthorityResult::Unknown {
        state: state.clone(),
        claim_ref: "r".repeat(256),
    });
    assert!(!accepts_reply(
        &body,
        &serde_json::to_vec(&wrong_phase).unwrap()
    ));
    let mut changed = state;
    changed.owner_revision.push('x');
    let wrong = ImportAuthorityReplyData::new(ImportAuthorityResult::Start {
        state: changed,
        claim_ref: "r".repeat(256),
        started_revision: Some("revision".into()),
    });
    assert!(!accepts_reply(&body, &serde_json::to_vec(&wrong).unwrap()));
    let mut over = bytes;
    over.resize(import_authority_reply_max_bytes() + 1, b' ');
    assert!(!accepts_reply(&body, &over));
    let error = vec![b'x'; NATIVE_CONTROL_ERROR_MAX_BYTES + 1];
    assert!(authority_response_input("fixture-key", &nonce(), &body, 503, &error).is_err());
}
#[test]
fn maximal_terminal_reply_is_finite_and_matching_not_a_generic_large_body() {
    let state = max_state();
    let terminal = max_terminal();
    let request = ImportAuthorityRequestData::new(ImportAuthorityCommand::Terminal {
        state: state.clone(),
        claim_ref: "claim".into(),
        publication_revision: terminal.publication_revision.clone(),
        native_receipt_ref: terminal.native_receipt_ref.clone(),
        publication_request_digest: terminal.publication_request_digest.clone(),
    })
    .unwrap();
    let mut after = state;
    after.action_revision = terminal.publication_revision.clone();
    // This old negative mutates through Value; UTF16 has a separate direct-codec test.
    let mut completion = sample_completion();
    completion.models.source = gateway_core::js_string::JsString16::from_utf8("source");
    let reply = ImportAuthorityReplyData::new(ImportAuthorityResult::Terminal {
        state: after,
        terminal: Box::new(terminal),
        completion,
    });
    let bytes = serde_json::to_vec(&reply).unwrap();
    assert!(bytes.len() <= import_authority_reply_max_bytes_for(&request).unwrap());
    assert!(bytes.len() > NATIVE_CONTROL_MAX_BYTES);
    assert!(accepts_reply(&request.bytes().unwrap(), &bytes));
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["result"]["terminal"]["publication_request_digest"] = serde_json::json!("b".repeat(64));
    assert!(!accepts_reply(
        &request.bytes().unwrap(),
        &serde_json::to_vec(&value).unwrap()
    ));
}
#[test]
fn bare_started_reply_echoes_exact_request_and_remaining_lifetime() {
    let request = max_custody();
    let body = request.bytes().unwrap();
    let reply = ImportCustodyStartedReplyData {
        operation: IMPORT_STARTED_OPERATION.into(),
        v: 1,
        request: request.clone(),
        verified_at_ms: MAX_SAFE_INTEGER - 1,
    };
    let bytes = serde_json::to_vec(&reply).unwrap();
    assert_eq!(bytes.len(), import_custody_reply_max_bytes());
    assert!(bytes.len() > NATIVE_CONTROL_MAX_BYTES);
    assert!(accepts_reply(&body, &bytes));
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["request"]["started_revision"] = serde_json::json!("other");
    assert!(!accepts_reply(&body, &serde_json::to_vec(&value).unwrap()));
    let reply = ImportCustodyStartedReplyData {
        operation: IMPORT_STARTED_OPERATION.into(),
        v: 1,
        request,
        verified_at_ms: MAX_SAFE_INTEGER,
    };
    assert!(!accepts_reply(&body, &serde_json::to_vec(&reply).unwrap()));
}

#[test]
fn readonly_custody_terminal_has_closed_matching_echo_and_computed_bounds() {
    let started = max_custody();
    let revision = "r".repeat(256);
    let mut terminal = max_terminal();
    terminal.source_revision = revision.clone();
    terminal.normalized_revision = revision.clone();
    let request = ImportAuthorityRequestData::new(ImportAuthorityCommand::CustodyTerminal {
        started: started.clone(),
        publication_revision: revision.clone(),
    })
    .unwrap();
    let body = request.bytes().unwrap();
    let reply = ImportAuthorityReplyData::new(ImportAuthorityResult::CustodyTerminal {
        started: started.clone(),
        publication_revision: revision.clone(),
        terminal: Box::new(terminal.clone()),
    });
    let bytes = serde_json::to_vec(&reply).unwrap();
    assert!(body.len() <= import_authority_request_max_bytes());
    assert!(bytes.len() <= import_authority_reply_max_bytes());
    assert!(bytes.len() > NATIVE_CONTROL_MAX_BYTES);
    assert!(accepts_reply(&body, &bytes));
    let mut wrong_started = started.clone();
    wrong_started.started_revision = "different".into();
    let wrong = ImportAuthorityReplyData::new(ImportAuthorityResult::CustodyTerminal {
        started: wrong_started,
        publication_revision: revision.clone(),
        terminal: Box::new(terminal.clone()),
    });
    assert!(!accepts_reply(&body, &serde_json::to_vec(&wrong).unwrap()));
    terminal.source_revision = "foreign".into();
    let wrong = ImportAuthorityReplyData::new(ImportAuthorityResult::CustodyTerminal {
        started: started.clone(),
        publication_revision: revision.clone(),
        terminal: Box::new(terminal),
    });
    assert!(!accepts_reply(&body, &serde_json::to_vec(&wrong).unwrap()));
    let mut long = started;
    long.started_revision.push('x');
    assert!(
        ImportAuthorityRequestData::new(ImportAuthorityCommand::CustodyTerminal {
            started: long,
            publication_revision: revision
        })
        .is_err()
    );
    let mut over = bytes;
    over.resize(import_authority_reply_max_bytes() + 1, b' ');
    assert!(!accepts_reply(&body, &over));
}

fn sample_completion() -> ImportCompletionData {
    ImportCompletionData {
        account_count: 2,
        account_ids: vec!["one".into(), "two".into()],
        updated_at_ms: 1234.5,
        models: ImportCompletionModelsData {
            count: 3,
            source: gateway_core::source_json::SourceJson::parse(r#""\ud800""#)
                .unwrap()
                .deserialize()
                .unwrap(),
            updated_at_ms: 9876,
            client_version: None,
        },
    }
}
#[test]
fn actor_completion_preserves_required_nullable_utf16_and_request_specific_ceiling() {
    let state = max_state();
    let terminal = max_terminal();
    let request = ImportAuthorityRequestData::new(ImportAuthorityCommand::Terminal {
        state: state.clone(),
        claim_ref: "claim".into(),
        publication_revision: terminal.publication_revision.clone(),
        native_receipt_ref: terminal.native_receipt_ref.clone(),
        publication_request_digest: terminal.publication_request_digest.clone(),
    })
    .unwrap();
    let mut after = state.clone();
    after.action_revision = terminal.publication_revision.clone();
    let reply = ImportAuthorityReplyData::new(ImportAuthorityResult::Terminal {
        state: after,
        terminal: Box::new(terminal),
        completion: sample_completion(),
    });
    let bytes = serde_json::to_vec(&reply).unwrap();
    let parsed = ImportAuthorityReplyData::parse_for(&bytes, &request).unwrap();
    let ImportAuthorityResult::Terminal { completion, .. } = parsed.result else {
        panic!("terminal")
    };
    assert_eq!(completion.models.source.as_units(), [0xd800]);
    assert_eq!(completion.models.client_version, None);
    assert_eq!(completion.account_ids, ["one", "two"]);
    let cap = import_authority_reply_max_bytes_for(&request).unwrap();
    assert!(cap > import_authority_reply_max_bytes());
    println!(
        "legacy-authority-reply-cap={} actor-completion-reply-cap={cap}",
        import_authority_reply_max_bytes()
    );
    let current = ImportAuthorityRequestData::new(ImportAuthorityCommand::Current {
        state,
        claim_ref: None,
    })
    .unwrap();
    assert_eq!(
        import_authority_reply_max_bytes_for(&current).unwrap(),
        import_authority_reply_max_bytes()
    );
    let mut over = bytes;
    over.resize(cap + 1, b' ');
    assert!(ImportAuthorityReplyData::parse_for(&over, &request).is_err());
}
