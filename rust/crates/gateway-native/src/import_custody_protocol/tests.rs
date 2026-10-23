use super::*;
fn maximal_binding() -> ImportCustodyStartedRequest {
    ImportCustodyStartedRequest {
        v: 1,
        operation_id: "a".repeat(256),
        action_ref: "a".repeat(64),
        claim_ref: "a".repeat(256),
        native_owner_id: "\0".repeat(4096),
        account_id_hash: "a".repeat(64),
        source_native_generation: "a".repeat(64),
        owner_revision: "\0".repeat(4096),
        source_revision: "\0".repeat(4096),
        normalized_revision: "\0".repeat(4096),
        started_revision: "\0".repeat(4096),
        deadline_ms: gateway_core::identity::MAX_SAFE_INTEGER,
    }
}
fn maximal_header() -> Header {
    Header {
        v: 1,
        sequence: u64::MAX,
        session_ref: "a".repeat(64),
        challenge: "a".repeat(64),
        binding: maximal_binding(),
    }
}
#[test]
fn exact_original_domains_and_serializer_maxima_are_lossless() {
    let binding = maximal_binding();
    assert_eq!(
        binding.canonical_bytes().unwrap().len(),
        STARTED_BINDING_MAX
    );
    let cases = [
        (Frame::Quiesce(maximal_header()), 124_063),
        (Frame::CheckStopped(maximal_header()), 124_069),
        (Frame::Cancel(maximal_header()), 124_062),
        (Frame::Refused(maximal_header()), 124_063),
        (Frame::Unknown(maximal_header()), 124_063),
        (Frame::Released(maximal_header()), 124_064),
        (
            Frame::Stopped(Stopped {
                v: 1,
                sequence: u64::MAX,
                session_ref: "a".repeat(64),
                challenge: "a".repeat(64),
                binding: maximal_binding(),
                epoch: "a".repeat(64),
                root_device: u64::MAX,
                root_inode: u64::MAX,
            }),
            124_207,
        ),
        (
            Frame::ReleaseAfterVerifiedTerminal(Release {
                v: 1,
                sequence: u64::MAX,
                session_ref: "a".repeat(64),
                challenge: "a".repeat(64),
                binding: maximal_binding(),
                publication_revision: "\0".repeat(4096),
            }),
            CUSTODY_FRAME_MAX,
        ),
    ];
    for (frame, expected) in cases {
        let bytes = frame.encode().unwrap();
        assert_eq!(bytes.len(), expected);
        let decoded = Frame::decode(&bytes).unwrap();
        assert_eq!(decoded.encode().unwrap(), bytes);
    }
}
#[test]
fn one_byte_over_and_closed_required_shape_refuse_without_narrowing_old_domains() {
    let mut maximal = Frame::ReleaseAfterVerifiedTerminal(Release {
        v: 1,
        sequence: u64::MAX,
        session_ref: "a".repeat(64),
        challenge: "a".repeat(64),
        binding: maximal_binding(),
        publication_revision: "\0".repeat(4096),
    })
    .encode()
    .unwrap();
    maximal.push(b' ');
    assert_eq!(maximal.len(), CUSTODY_FRAME_MAX + 1);
    assert!(Frame::decode(&maximal).is_err());
    let frame = Frame::Quiesce(maximal_header());
    let value = serde_json::to_value(&frame).unwrap();
    for (field, replacement) in [
        ("v", serde_json::json!(2)),
        ("sequence", serde_json::json!(0)),
        ("challenge", serde_json::json!("caller boolean")),
        ("operation", serde_json::json!("arbitrary_command")),
    ] {
        let mut changed = value.clone();
        changed[field] = replacement;
        assert!(Frame::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    for field in ["v", "sequence", "session_ref", "challenge", "binding"] {
        let mut changed = value.clone();
        changed.as_object_mut().unwrap().remove(field);
        assert!(Frame::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    for field in ["auth", "document_digest", "pid", "stopped", "command"] {
        let mut changed = value.clone();
        changed[field] = serde_json::json!(true);
        assert!(Frame::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    let mut changed = value;
    changed["binding"]["native_owner_id"] = serde_json::json!("a".repeat(4097));
    assert!(Frame::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    let mut trailing = frame.encode().unwrap();
    trailing.extend_from_slice(b"{}");
    assert!(Frame::decode(&trailing).is_err());
}

#[test]
fn actual_tcp_prefix_truncation_eof_oversize_and_deadline_refuse() {
    use std::net::TcpListener;
    let pair = || {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (receiver, _) = listener.accept().unwrap();
        drop(listener);
        (sender, receiver)
    };
    let deadline = || Instant::now() + Duration::from_secs(2);
    let mut header = maximal_header();
    header.sequence = 1;
    header.binding.operation_id = "op".into();
    header.binding.claim_ref = "claim".into();
    header.binding.native_owner_id = "owner".into();
    header.binding.owner_revision = "owner-1".into();
    header.binding.source_revision = "source-1".into();
    header.binding.normalized_revision = "normalized-1".into();
    header.binding.started_revision = "started-1".into();
    let frame = Frame::Quiesce(header);
    let encoded = frame.encode().unwrap();
    let (mut sender, mut receiver) = pair();
    send(&mut sender, &frame, deadline(), None).unwrap();
    assert_eq!(
        receive(&mut receiver, deadline(), None)
            .unwrap()
            .encode()
            .unwrap(),
        encoded
    );
    for partial in [
        vec![],
        vec![0, 0],
        (CUSTODY_FRAME_MAX as u32 + 1).to_be_bytes().to_vec(),
        {
            let mut bytes = (encoded.len() as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(&encoded[..encoded.len() / 2]);
            bytes
        },
        {
            let mut bytes = 2u32.to_be_bytes().to_vec();
            bytes.extend_from_slice(b"{}");
            bytes
        },
    ] {
        let (mut sender, mut receiver) = pair();
        sender.write_all(&partial).unwrap();
        sender.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(receive(&mut receiver, deadline(), None).is_err());
    }
    let (_sender, mut receiver) = pair();
    assert!(receive(&mut receiver, Instant::now(), None).is_err());
}
