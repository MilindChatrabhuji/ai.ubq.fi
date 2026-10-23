use gateway_native::{connector_fd, connector_protocol};

use connector_fd::{ControlEndpoint, ReceiveProcess, Side};
use connector_protocol::{Channel, ControlError, ControlFrame, MAX_FRAME_BYTES, WIRE_VERSION};
use rustix::{
    io::{FdFlags, fcntl_getfd},
    net::{SendAncillaryBuffer, SendAncillaryMessage, SendFlags, sendmsg},
};
use std::{
    io::{IoSlice, Read, Write},
    mem::MaybeUninit,
    net::Shutdown,
    os::{
        fd::{AsFd, OwnedFd},
        unix::net::UnixStream,
    },
    sync::Arc,
    time::Duration,
};

fn connect(id: &str) -> ControlFrame {
    ControlFrame::Connect {
        v: WIRE_VERSION,
        channel: Channel::ProviderLive,
        action_ref: "action-1".into(),
        connection_id: id.into(),
        authorization_ref: "authority_1".into(),
    }
}
fn connected(id: &str) -> ControlFrame {
    ControlFrame::Connected {
        v: WIRE_VERSION,
        connection_id: id.into(),
    }
}
fn cancel(id: &str) -> ControlFrame {
    ControlFrame::Cancel {
        v: WIRE_VERSION,
        connection_id: id.into(),
    }
}
fn endpoints(process: &Arc<ReceiveProcess>) -> (ControlEndpoint, ControlEndpoint) {
    let (a, b) = UnixStream::pair().unwrap();
    (
        endpoint(a, Side::Parent, process),
        endpoint(b, Side::Connector, process),
    )
}
fn endpoint(stream: UnixStream, side: Side, process: &Arc<ReceiveProcess>) -> ControlEndpoint {
    ControlEndpoint::new(stream, side, Duration::from_secs(1), process.clone()).unwrap()
}
fn pending_parent(process: &Arc<ReceiveProcess>) -> (ControlEndpoint, UnixStream) {
    let (local, mut raw) = UnixStream::pair().unwrap();
    raw.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut parent = endpoint(local, Side::Parent, process);
    parent.send(connect("connection-1"), None).unwrap();
    let mut header = [0; 4];
    raw.read_exact(&mut header).unwrap();
    let mut data = vec![0; usize::try_from(u32::from_be_bytes(header)).unwrap()];
    raw.read_exact(&mut data).unwrap();
    assert_eq!(
        ControlFrame::decode(&data).unwrap(),
        connect("connection-1")
    );
    (parent, raw)
}
fn descriptor_pair() -> (OwnedFd, UnixStream) {
    let (sent, witness) = UnixStream::pair().unwrap();
    witness
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    (sent.into(), witness)
}
fn assert_closed(mut witness: UnixStream) {
    assert_eq!(
        witness.read(&mut [0]).unwrap(),
        0,
        "descriptor ownership leaked"
    );
}
fn packet(body: &[u8]) -> Vec<u8> {
    let mut result = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
    result.extend_from_slice(body);
    result
}
// This fixture also uses real SCM_RIGHTS, including deliberately invalid rights
// cardinality/position. It does not replace the source transport under test.
fn inject(stream: &UnixStream, data: &[u8], descriptors: Vec<OwnedFd>) {
    let rights: Vec<_> = descriptors.iter().map(AsFd::as_fd).collect();
    let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(16))];
    let mut ancillary = SendAncillaryBuffer::new(&mut storage);
    if !rights.is_empty() {
        assert!(ancillary.push(SendAncillaryMessage::ScmRights(&rights)));
    }
    let flags = SendFlags::empty();
    assert_eq!(
        sendmsg(stream, &[IoSlice::new(data)], &mut ancillary, flags).unwrap(),
        data.len()
    );
}

pub(crate) fn real_owned_descriptor_transfers_once_and_outlives_terminal_control_channel(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, mut peer) = endpoints(process);
    parent.send(connect("connection-1"), None).unwrap();
    assert_eq!(peer.receive().unwrap().frame, connect("connection-1"));
    let (sent, mut witness) = descriptor_pair();
    #[cfg(target_os = "macos")]
    assert!(rustix::net::getpeername(&sent).unwrap().is_none());
    peer.send(connected("connection-1"), Some(sent)).unwrap();
    assert!(peer.is_closed());
    let received = parent.receive().unwrap();
    assert_eq!(received.frame, connected("connection-1"));
    assert!(parent.is_closed());
    let fd = received.descriptor.unwrap();
    assert!(fcntl_getfd(&fd).unwrap().contains(FdFlags::CLOEXEC));
    let mut actual = UnixStream::from(fd);
    witness.write_all(b"actual-owned-fd").unwrap();
    let mut bytes = [0; 15];
    actual.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"actual-owned-fd");
    drop(actual);
    assert_closed(witness);
    assert_eq!(parent.receive().unwrap_err(), ControlError::Closed);
    assert_eq!(
        peer.send(connect("new-id"), None),
        Err(ControlError::Closed)
    );
}

pub(crate) fn finite_frames_roundtrip_and_exact_4096_byte_boundary(_process: &Arc<ReceiveProcess>) {
    for frame in [
        connect("a"),
        cancel("a"),
        connected("a"),
        ControlFrame::Cancelled {
            v: 1,
            connection_id: "a".into(),
        },
        ControlFrame::Unavailable {
            v: 1,
            connection_id: "a".into(),
        },
    ] {
        assert_eq!(
            ControlFrame::decode(&frame.encode().unwrap()).unwrap(),
            frame
        );
    }
    let mut bytes = connected("a").encode().unwrap();
    bytes.resize(MAX_FRAME_BYTES, b' ');
    assert_eq!(ControlFrame::decode(&bytes).unwrap(), connected("a"));
    bytes.push(b' ');
    assert_eq!(
        ControlFrame::decode(&bytes),
        Err(ControlError::FrameTooLarge)
    );
    let mut maximal = connect(&"a".repeat(256));
    if let ControlFrame::Connect {
        action_ref,
        authorization_ref,
        ..
    } = &mut maximal
    {
        *action_ref = "b".repeat(256);
        *authorization_ref = "c".repeat(256);
    }
    assert!(maximal.encode().unwrap().len() <= MAX_FRAME_BYTES);
    for id in [
        "",
        "a:b",
        "host/path",
        "https://api.openai.com",
        "has space",
        "\u{d7ff}",
    ] {
        assert_eq!(connect(id).encode(), Err(ControlError::InvalidFrame));
    }
    assert_eq!(
        connect(&"a".repeat(257)).encode(),
        Err(ControlError::InvalidFrame)
    );
}

pub(crate) fn unknown_fields_channels_versions_and_duplicate_fields_are_refused(
    _process: &Arc<ReceiveProcess>,
) {
    for raw in [
        r#"{"operation":"connect","v":1,"channel":"other","action_ref":"a","connection_id":"c","authorization_ref":"r"}"#,
        r#"{"operation":"connected","v":2,"connection_id":"c"}"#,
        r#"{"operation":"connected","v":1,"connection_id":"c","host":"api.openai.com"}"#,
        r#"{"operation":"connected","v":1,"connection_id":"c","port":443}"#,
        r#"{"operation":"connected","v":1,"connection_id":"c","command":"exec"}"#,
        r#"{"operation":"connected","v":1,"connection_id":"c","secret":"synthetic"}"#,
        r#"{"operation":"connected","v":1,"connection_id":"c","home":"/tmp"}"#,
        r#"{"operation":"connected","v":1,"connection_id":"c","connection_id":"d"}"#,
        r#"{"operation":"unknown","v":1,"connection_id":"c"}"#,
    ] {
        assert!(ControlFrame::decode(raw.as_bytes()).is_err(), "{raw}");
    }
}

pub(crate) fn real_frame_at_limit_preserves_descriptor_ownership(process: &Arc<ReceiveProcess>) {
    let (mut parent, raw) = pending_parent(process);
    let mut body = connected("connection-1").encode().unwrap();
    body.resize(MAX_FRAME_BYTES, b' ');
    let (fd, witness) = descriptor_pair();
    inject(&raw, &packet(&body), vec![fd]);
    let result = parent.receive().unwrap();
    drop(result.descriptor);
    assert_closed(witness);
}

pub(crate) fn missing_connected_descriptor_refuses_and_closes(process: &Arc<ReceiveProcess>) {
    let (mut parent, raw) = pending_parent(process);
    inject(
        &raw,
        &packet(&connected("connection-1").encode().unwrap()),
        vec![],
    );
    assert_eq!(
        parent.receive().unwrap_err(),
        ControlError::MissingDescriptor
    );
    assert!(parent.is_closed());
}

pub(crate) fn every_nonconnected_frame_refuses_and_closes_attached_descriptor(
    process: &Arc<ReceiveProcess>,
) {
    for frame in [
        connect("connection-1"),
        cancel("connection-1"),
        ControlFrame::Cancelled {
            v: 1,
            connection_id: "connection-1".into(),
        },
        ControlFrame::Unavailable {
            v: 1,
            connection_id: "connection-1".into(),
        },
    ] {
        let (mut parent, raw) = pending_parent(process);
        let (fd, witness) = descriptor_pair();
        inject(&raw, &packet(&frame.encode().unwrap()), vec![fd]);
        assert_eq!(
            parent.receive().unwrap_err(),
            ControlError::UnexpectedDescriptor
        );
        assert_closed(witness);
        assert!(parent.is_closed());
    }
}

pub(crate) fn unmatched_connected_id_drops_the_actual_received_descriptor(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, raw) = pending_parent(process);
    let (fd, witness) = descriptor_pair();
    inject(
        &raw,
        &packet(&connected("wrong-id").encode().unwrap()),
        vec![fd],
    );
    assert_eq!(parent.receive().unwrap_err(), ControlError::UnmatchedId);
    assert_closed(witness);
}

pub(crate) fn late_rights_cannot_hide_behind_plain_header_prefix(process: &Arc<ReceiveProcess>) {
    let (mut parent, mut raw) = pending_parent(process);
    let (fd, witness) = descriptor_pair();
    let bytes = packet(&connected("connection-1").encode().unwrap());
    raw.write_all(&bytes[..1]).unwrap();
    inject(&raw, &bytes[1..], vec![fd]);
    assert_eq!(
        parent.receive().unwrap_err(),
        ControlError::UnexpectedDescriptor
    );
    assert_closed(witness);
}

pub(crate) fn malformed_oversized_and_partial_frames_drop_owned_rights(
    process: &Arc<ReceiveProcess>,
) {
    let cases=[vec![0,0],vec![0,0,0,10,b'{',b'}'],packet(b"{}"),packet(br#"{"operation":"connected","v":1,"connection_id":"connection-1","url":"https://invalid"}"#),u32::try_from(MAX_FRAME_BYTES+1).unwrap().to_be_bytes().to_vec(),vec![0,0,0,0]];
    for bytes in cases {
        let (mut parent, raw) = pending_parent(process);
        let (fd, witness) = descriptor_pair();
        inject(&raw, &bytes, vec![fd]);
        raw.shutdown(Shutdown::Write).unwrap();
        assert!(parent.receive().is_err());
        assert!(parent.is_closed());
        assert_closed(witness);
    }
}

pub(crate) fn peer_eof_and_explicit_close_are_terminal_without_retry(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, raw) = pending_parent(process);
    drop(raw);
    assert_eq!(parent.receive().unwrap_err(), ControlError::PeerClosed);
    assert!(parent.is_closed());
    let (a, mut b) = UnixStream::pair().unwrap();
    let mut endpoint = endpoint(a, Side::Parent, process);
    endpoint.close();
    endpoint.close();
    assert_eq!(b.read(&mut [0]).unwrap(), 0);
    assert_eq!(
        endpoint.send(connect("id"), None),
        Err(ControlError::Closed)
    );
}

pub(crate) fn cancellation_ack_has_no_descriptor_and_both_endpoints_finish(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, mut peer) = endpoints(process);
    parent.send(connect("id"), None).unwrap();
    peer.receive().unwrap();
    parent.send(cancel("id"), None).unwrap();
    assert_eq!(peer.receive().unwrap().frame, cancel("id"));
    peer.send(
        ControlFrame::Cancelled {
            v: 1,
            connection_id: "id".into(),
        },
        None,
    )
    .unwrap();
    let result = parent.receive().unwrap();
    assert!(result.descriptor.is_none());
    assert!(parent.is_closed());
    assert!(peer.is_closed());
}

pub(crate) fn cancellation_on_each_side_refuses_late_connected_and_drops_fd(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, mut peer) = endpoints(process);
    parent.send(connect("id"), None).unwrap();
    peer.receive().unwrap();
    parent.send(cancel("id"), None).unwrap();
    peer.receive().unwrap();
    let (fd, witness) = descriptor_pair();
    assert_eq!(
        peer.send(connected("id"), Some(fd)),
        Err(ControlError::Cancelled)
    );
    assert_closed(witness);
    let (mut parent, raw) = pending_parent(process);
    parent.send(cancel("connection-1"), None).unwrap();
    let (fd, witness) = descriptor_pair();
    inject(
        &raw,
        &packet(&connected("connection-1").encode().unwrap()),
        vec![fd],
    );
    assert_eq!(parent.receive().unwrap_err(), ControlError::Cancelled);
    assert_closed(witness);
}

pub(crate) fn duplicate_pending_or_wrong_direction_frames_are_not_accepted(
    process: &Arc<ReceiveProcess>,
) {
    for (frame, expected) in [
        (connect("id"), ControlError::DuplicateId),
        (connect("other"), ControlError::WrongState),
        (cancel("other"), ControlError::UnmatchedId),
    ] {
        let (mut parent, mut peer) = endpoints(process);
        parent.send(connect("id"), None).unwrap();
        peer.receive().unwrap();
        assert_eq!(parent.send(frame, None), Err(expected));
        assert!(parent.is_closed());
    }
    let (_, mut peer) = endpoints(process);
    assert_eq!(
        peer.send(connect("id"), None),
        Err(ControlError::WrongState)
    );
    let (mut parent, mut peer) = endpoints(process);
    parent.send(connect("id"), None).unwrap();
    peer.receive().unwrap();
    parent.send(cancel("id"), None).unwrap();
    assert_eq!(
        parent.send(cancel("id"), None),
        Err(ControlError::DuplicateId)
    );
}

pub(crate) fn terminal_endpoint_discards_queued_extra_frame_and_descriptor(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, raw) = pending_parent(process);
    let (first, w1) = descriptor_pair();
    let (extra, w2) = descriptor_pair();
    let bytes = packet(&connected("connection-1").encode().unwrap());
    inject(&raw, &bytes, vec![first]);
    inject(&raw, &bytes, vec![extra]);
    let result = parent.receive().unwrap();
    assert!(parent.is_closed());
    assert_closed(w2);
    drop(result.descriptor);
    assert_closed(w1);
    assert_eq!(parent.receive().unwrap_err(), ControlError::Closed);
}

pub(crate) fn failed_send_consumes_fd_and_does_not_retry_after_peer_loss(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, mut peer) = endpoints(process);
    parent.send(connect("id"), None).unwrap();
    peer.receive().unwrap();
    drop(parent);
    let (fd, witness) = descriptor_pair();
    assert!(peer.send(connected("id"), Some(fd)).is_err());
    assert_closed(witness);
    assert!(peer.is_closed());
    let (fd, witness) = descriptor_pair();
    assert_eq!(
        peer.send(connected("id"), Some(fd)),
        Err(ControlError::Closed)
    );
    assert_closed(witness);
}

pub(crate) fn local_invalid_shape_or_version_also_consumes_supplied_fd(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, _) = endpoints(process);
    let (fd, witness) = descriptor_pair();
    assert_eq!(
        parent.send(connect("id"), Some(fd)),
        Err(ControlError::UnexpectedDescriptor)
    );
    assert_closed(witness);
    let (mut parent, _) = endpoints(process);
    let (fd, witness) = descriptor_pair();
    assert_eq!(
        parent.send(
            ControlFrame::Connected {
                v: 2,
                connection_id: "id".into()
            },
            Some(fd)
        ),
        Err(ControlError::InvalidFrame)
    );
    assert_closed(witness);
    let (a, _) = UnixStream::pair().unwrap();
    assert!(ControlEndpoint::new(a, Side::Parent, Duration::ZERO, process.clone()).is_err());
}

pub(crate) fn connected_message_cannot_transfer_a_nonstream_descriptor(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, raw) = pending_parent(process);
    let (a, _) = std::os::unix::net::UnixDatagram::pair().unwrap();
    inject(
        &raw,
        &packet(&connected("connection-1").encode().unwrap()),
        vec![a.into()],
    );
    assert_eq!(
        parent.receive().unwrap_err(),
        ControlError::InvalidDescriptor
    );
    assert!(parent.is_closed());
}

pub(crate) fn connected_message_also_rejects_an_actual_unconnected_stream(
    process: &Arc<ReceiveProcess>,
) {
    let (mut parent, raw) = pending_parent(process);
    let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None).unwrap();
    inject(
        &raw,
        &packet(&connected("connection-1").encode().unwrap()),
        vec![socket.into()],
    );
    assert!(matches!(parent.receive(), Err(ControlError::Io(_))));
    assert!(parent.is_closed());
}
