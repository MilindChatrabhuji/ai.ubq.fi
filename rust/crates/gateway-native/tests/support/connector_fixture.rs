#![cfg(unix)]
mod connector_cases;
#[path = "../../src/connector_fd.rs"]
mod connector_fd;
#[path = "../../src/connector_protocol.rs"]
mod connector_protocol;
use connector_fd::{ControlEndpoint, ReceiveProcess, Side};
use connector_protocol::{Channel, ControlError, ControlFrame};
use std::{
    os::{fd::AsFd, unix::net::UnixStream},
    time::Duration,
};
fn main() {
    let name = std::env::args().nth(1).expect("finite fixture case");
    ReceiveProcess::run(|process| {
        match name.as_str() {
            "real_owned_descriptor_transfers_once_and_outlives_terminal_control_channel" => connector_cases::real_owned_descriptor_transfers_once_and_outlives_terminal_control_channel(process),
            "finite_frames_roundtrip_and_exact_4096_byte_boundary" => connector_cases::finite_frames_roundtrip_and_exact_4096_byte_boundary(process),
            "unknown_fields_channels_versions_and_duplicate_fields_are_refused" => connector_cases::unknown_fields_channels_versions_and_duplicate_fields_are_refused(process),
            "real_frame_at_limit_preserves_descriptor_ownership" => connector_cases::real_frame_at_limit_preserves_descriptor_ownership(process),
            "missing_connected_descriptor_refuses_and_closes" => connector_cases::missing_connected_descriptor_refuses_and_closes(process),
            "every_nonconnected_frame_refuses_and_closes_attached_descriptor" => connector_cases::every_nonconnected_frame_refuses_and_closes_attached_descriptor(process),
            "unmatched_connected_id_drops_the_actual_received_descriptor" => connector_cases::unmatched_connected_id_drops_the_actual_received_descriptor(process),
            "late_rights_cannot_hide_behind_plain_header_prefix" => connector_cases::late_rights_cannot_hide_behind_plain_header_prefix(process),
            "malformed_oversized_and_partial_frames_drop_owned_rights" => connector_cases::malformed_oversized_and_partial_frames_drop_owned_rights(process),
            "peer_eof_and_explicit_close_are_terminal_without_retry" => connector_cases::peer_eof_and_explicit_close_are_terminal_without_retry(process),
            "cancellation_ack_has_no_descriptor_and_both_endpoints_finish" => connector_cases::cancellation_ack_has_no_descriptor_and_both_endpoints_finish(process),
            "cancellation_on_each_side_refuses_late_connected_and_drops_fd" => connector_cases::cancellation_on_each_side_refuses_late_connected_and_drops_fd(process),
            "duplicate_pending_or_wrong_direction_frames_are_not_accepted" => connector_cases::duplicate_pending_or_wrong_direction_frames_are_not_accepted(process),
            "terminal_endpoint_discards_queued_extra_frame_and_descriptor" => connector_cases::terminal_endpoint_discards_queued_extra_frame_and_descriptor(process),
            "failed_send_consumes_fd_and_does_not_retry_after_peer_loss" => connector_cases::failed_send_consumes_fd_and_does_not_retry_after_peer_loss(process),
            "local_invalid_shape_or_version_also_consumes_supplied_fd" => connector_cases::local_invalid_shape_or_version_also_consumes_supplied_fd(process),
            "connected_message_cannot_transfer_a_nonstream_descriptor" => connector_cases::connected_message_cannot_transfer_a_nonstream_descriptor(process),
            "connected_message_also_rejects_an_actual_unconnected_stream" => connector_cases::connected_message_also_rejects_an_actual_unconnected_stream(process),
            "external-cardinality" => {
                let stream = UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned().unwrap());
                let mut parent = ControlEndpoint::new(stream, Side::Parent, Duration::from_secs(1), process)?;
                parent.send(ControlFrame::Connect { v: 1, channel: Channel::ProviderLive, action_ref: "action-1".into(), connection_id: "connection-1".into(), authorization_ref: "authority_1".into() }, None)?;
                let error = parent.receive().unwrap_err();
                assert!(matches!(error, ControlError::UnexpectedDescriptor | ControlError::AncillaryTruncated));
                assert!(parent.is_closed());
                return Err(error);
            }
            _ => return Err(ControlError::InvalidFrame),
        }
        Ok(())
    })
}
