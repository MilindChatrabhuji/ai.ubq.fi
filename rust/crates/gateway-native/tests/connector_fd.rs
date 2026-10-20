#![cfg(unix)]
const UNEXPECTED_DESCRIPTOR: i32 = 67;
const ANCILLARY_TRUNCATED: i32 = 69;
use rustix::net::{SendAncillaryBuffer, SendAncillaryMessage, SendFlags, sendmsg};
use std::{
    io::{IoSlice, Read},
    mem::MaybeUninit,
    os::{
        fd::{AsFd, OwnedFd},
        unix::net::UnixStream,
    },
    process::{Command, Stdio},
    time::Duration,
};
fn fixture() -> std::path::PathBuf {
    let test = std::env::current_exe().unwrap();
    test.parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/uos-native-connector-fixture")
}
fn child_case(name: &str) {
    let output = Command::new(fixture())
        .arg(name)
        .env_clear()
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "case={name} status={:?} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn real_owned_descriptor_transfers_once_and_outlives_terminal_control_channel() {
    child_case("real_owned_descriptor_transfers_once_and_outlives_terminal_control_channel");
}
#[test]
fn finite_frames_roundtrip_and_exact_4096_byte_boundary() {
    child_case("finite_frames_roundtrip_and_exact_4096_byte_boundary");
}
#[test]
fn unknown_fields_channels_versions_and_duplicate_fields_are_refused() {
    child_case("unknown_fields_channels_versions_and_duplicate_fields_are_refused");
}
#[test]
fn real_frame_at_limit_preserves_descriptor_ownership() {
    child_case("real_frame_at_limit_preserves_descriptor_ownership");
}
#[test]
fn missing_connected_descriptor_refuses_and_closes() {
    child_case("missing_connected_descriptor_refuses_and_closes");
}
#[test]
fn every_nonconnected_frame_refuses_and_closes_attached_descriptor() {
    child_case("every_nonconnected_frame_refuses_and_closes_attached_descriptor");
}
#[test]
fn unmatched_connected_id_drops_the_actual_received_descriptor() {
    child_case("unmatched_connected_id_drops_the_actual_received_descriptor");
}
#[test]
fn late_rights_cannot_hide_behind_plain_header_prefix() {
    child_case("late_rights_cannot_hide_behind_plain_header_prefix");
}
#[test]
fn malformed_oversized_and_partial_frames_drop_owned_rights() {
    child_case("malformed_oversized_and_partial_frames_drop_owned_rights");
}
#[test]
fn peer_eof_and_explicit_close_are_terminal_without_retry() {
    child_case("peer_eof_and_explicit_close_are_terminal_without_retry");
}
#[test]
fn cancellation_ack_has_no_descriptor_and_both_endpoints_finish() {
    child_case("cancellation_ack_has_no_descriptor_and_both_endpoints_finish");
}
#[test]
fn cancellation_on_each_side_refuses_late_connected_and_drops_fd() {
    child_case("cancellation_on_each_side_refuses_late_connected_and_drops_fd");
}
#[test]
fn duplicate_pending_or_wrong_direction_frames_are_not_accepted() {
    child_case("duplicate_pending_or_wrong_direction_frames_are_not_accepted");
}
#[test]
fn terminal_endpoint_discards_queued_extra_frame_and_descriptor() {
    child_case("terminal_endpoint_discards_queued_extra_frame_and_descriptor");
}
#[test]
fn failed_send_consumes_fd_and_does_not_retry_after_peer_loss() {
    child_case("failed_send_consumes_fd_and_does_not_retry_after_peer_loss");
}
#[test]
fn local_invalid_shape_or_version_also_consumes_supplied_fd() {
    child_case("local_invalid_shape_or_version_also_consumes_supplied_fd");
}
#[test]
fn connected_message_cannot_transfer_a_nonstream_descriptor() {
    child_case("connected_message_cannot_transfer_a_nonstream_descriptor");
}
#[test]
fn connected_message_also_rejects_an_actual_unconnected_stream() {
    child_case("connected_message_also_rejects_an_actual_unconnected_stream");
}

#[test]
fn extra_and_kernel_truncated_ancillary_close_every_actual_descriptor() {
    for count in [2, 3, 4, 16] {
        let (local, mut raw) = UnixStream::pair().unwrap();
        raw.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let owned: OwnedFd = local.into();
        let mut child = Command::new(fixture())
            .arg("external-cardinality")
            .env_clear()
            .stdin(Stdio::from(owned))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut header = [0; 4];
        raw.read_exact(&mut header).unwrap();
        let mut body = vec![0; usize::try_from(u32::from_be_bytes(header)).unwrap()];
        raw.read_exact(&mut body).unwrap();
        let mut fds = Vec::<OwnedFd>::new();
        let mut witnesses = Vec::new();
        for _ in 0..count {
            let (fd, witness) = UnixStream::pair().unwrap();
            witness
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            fds.push(fd.into());
            witnesses.push(witness);
        }
        let body = br#"{"operation":"connected","v":1,"connection_id":"connection-1"}"#;
        let mut bytes = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
        bytes.extend_from_slice(body);
        let rights: Vec<_> = fds.iter().map(AsFd::as_fd).collect();
        let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(16))];
        let mut ancillary = SendAncillaryBuffer::new(&mut storage);
        assert!(ancillary.push(SendAncillaryMessage::ScmRights(&rights)));
        assert_eq!(
            sendmsg(
                &raw,
                &[IoSlice::new(&bytes)],
                &mut ancillary,
                SendFlags::empty()
            )
            .unwrap(),
            bytes.len()
        );
        drop(rights);
        drop(fds);
        let status = child.wait().unwrap();
        let code = status.code().expect("signal/crash cannot pass");
        if count == 2 {
            assert_eq!(code, UNEXPECTED_DESCRIPTOR);
        } else if count == 16 {
            assert_eq!(code, ANCILLARY_TRUNCATED);
        } else {
            assert!([UNEXPECTED_DESCRIPTOR, ANCILLARY_TRUNCATED].contains(&code));
        }
        for (index, mut witness) in witnesses.into_iter().enumerate() {
            assert_eq!(
                witness.read(&mut [0]).unwrap(),
                0,
                "count={count} witness={index} descriptor ownership leaked"
            );
        }
        assert_eq!(
            raw.read(&mut [0]).unwrap(),
            0,
            "receiver control not closed"
        );
    }
}
