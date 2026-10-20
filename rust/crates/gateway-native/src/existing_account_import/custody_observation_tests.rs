//! DATA rejection only; these tests never construct a live mutation capability.
use super::*;
fn binding() -> ImportCustodyStartedRequest {
    ImportCustodyStartedRequest {
        v: 1,
        operation_id: "operation-1".into(),
        action_ref: "a".repeat(64),
        claim_ref: "claim-1".into(),
        native_owner_id: "native-owner".into(),
        account_id_hash: "b".repeat(64),
        source_native_generation: "c".repeat(64),
        owner_revision: "owner-r".into(),
        source_revision: "source-r".into(),
        normalized_revision: "normalized-r".into(),
        started_revision: "started-r".into(),
        deadline_ms: 40_000,
    }
}
fn stopped() -> Stopped {
    Stopped {
        v: 1,
        sequence: 2,
        session_ref: "d".repeat(64),
        challenge: "e".repeat(64),
        binding: binding(),
        epoch: "f".repeat(64),
        root_device: 1,
        root_inode: 2,
    }
}
#[test]
fn raw_stopped_replay_wrong_session_sequence_challenge_and_binding_are_not_live_custody() {
    let binding = binding();
    let good = stopped();
    verify(&good, &binding, &"d".repeat(64), &"e".repeat(64), 2).unwrap();
    for mutation in 0..7 {
        let mut data = stopped();
        match mutation {
            0 => data.sequence = 1,
            1 => data.session_ref = "a".repeat(64),
            2 => data.challenge = "b".repeat(64),
            3 => data.binding.claim_ref = "another-claim".into(),
            4 => data.binding.started_revision = "another-start".into(),
            5 => data.epoch = "not-an-epoch".into(),
            6 => data.root_inode = 0,
            _ => unreachable!(),
        }
        assert!(verify(&data, &binding, &"d".repeat(64), &"e".repeat(64), 2).is_err());
    }
    // Actual TCP bytes remain only DATA. A valid replay cannot be accepted for
    // a new session even when its frame is structurally well-formed.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut sender = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (mut receiver, _) = listener.accept().unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    wire::send(&mut sender, &Frame::Stopped(stopped()), deadline, None).unwrap();
    let Frame::Stopped(data) = wire::receive(&mut receiver, deadline, None).unwrap() else {
        panic!("fixed stopped DATA frame");
    };
    assert!(verify(&data, &binding, &"a".repeat(64), &"e".repeat(64), 2).is_err());
}
