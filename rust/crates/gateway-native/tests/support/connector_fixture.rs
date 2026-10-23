#![cfg(unix)]
//! Named connector fixture runner. Test harness only; not a product role.
mod connector_bootstrap_cases;
mod connector_cases;
use gateway_native::{confinement, connector_policy, connector_worker};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
};
#[derive(serde::Deserialize)]
struct ProbeInput {
    allowed: PathBuf,
    outside: PathBuf,
    replay: PathBuf,
    denied_tcp: SocketAddr,
}
fn probe_input() -> ProbeInput {
    serde_json::from_reader(std::io::stdin().lock()).unwrap()
}
fn policy_probe() {
    let input = probe_input();
    let read_allowed = std::fs::read(&input.allowed).is_ok();
    let outside_read_denied = std::fs::read(&input.outside).is_err();
    let outside_write_denied = std::fs::write(&input.outside, b"probe-control").is_err();
    let exec_denied = std::process::Command::new("/usr/bin/true")
        .env_clear()
        .status()
        .is_err();
    let self_spawn_denied = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("probe-noop")
        .env_clear()
        .status()
        .is_err();
    let non443_denied =
        TcpStream::connect_timeout(&input.denied_tcp, Duration::from_millis(300)).is_err();
    let thread_allowed = std::thread::spawn(|| 17).join().unwrap() == 17;
    println!(
        "{}",
        serde_json::json!({"read_allowed":read_allowed,"outside_read_denied":outside_read_denied,"outside_write_denied":outside_write_denied,"exec_denied":exec_denied,"self_spawn_denied":self_spawn_denied,"non443_denied":non443_denied,"thread_allowed":thread_allowed})
    );
}
fn print_policy(name: &str) {
    let binary = std::env::current_exe().unwrap().canonicalize().unwrap();
    if name == "print-connector-policy" {
        print!("{}", connector_policy::connector(&binary).unwrap());
        return;
    }
    let input = probe_input();
    if name == "print-import-policy" {
        let local = |port| SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
        print!(
            "{}",
            connector_policy::import_actor(
                &binary,
                input.allowed.parent().unwrap(),
                &input.replay,
                (local(31001), local(31002)),
                (local(31003), local(31004)),
                &[local(31005), local(31006), local(31007)]
            )
            .unwrap()
        );
        return;
    }
    let capabilities = confinement::NativeConfinement {
        readonly_paths: vec![input.allowed],
        list_directories: vec![],
        replay_directory: input.replay,
        unix_sockets: vec![],
    };
    print!(
        "{}",
        connector_policy::request(
            &binary,
            &capabilities,
            "127.0.0.1:45678".parse().unwrap(),
            "127.0.0.1:45679".parse().unwrap()
        )
        .unwrap()
    );
}

use gateway_native::connector_fd::{ControlEndpoint, ReceiveProcess, Side};
use gateway_native::connector_protocol::{Channel, ControlError, ControlFrame};
use std::{
    os::{fd::AsFd, unix::net::UnixStream},
    time::Duration,
};
fn main() {
    let name = std::env::args().nth(1).expect("finite fixture case");
    if name == "nonblocking443" {
        connector_bootstrap_cases::nonblocking443();
        return;
    }
    if name == "probe-noop" {
        return;
    }
    if name == "policy-probe" {
        policy_probe();
        return;
    }
    if name.starts_with("print-") {
        print_policy(&name);
        return;
    }
    if name == "production-idle" {
        connector_worker::run_native_connector();
    }
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
            "blocked-dns" | "loopback-dial" => {
                let stream = UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned().unwrap());
                let blocked = name == "blocked-dns";
                return connector_worker::run_dial(stream, process.clone(), move |_| {
                    if blocked { std::thread::sleep(Duration::from_secs(60)); return Err(std::io::ErrorKind::TimedOut.into()); }
                    let address: SocketAddr = std::env::args().nth(2).unwrap().parse().unwrap();
                    assert!(address.ip().is_loopback());
                    TcpStream::connect(address)
                });
            }
            "retained-loopback" => {
                let stream = UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned().unwrap());
                let mut parent = ControlEndpoint::new(stream, Side::Parent, Duration::from_secs(2), process.clone())?;
                parent.send(ControlFrame::Connect { v: 1, channel: Channel::ProviderLive, action_ref: "action-1".into(), connection_id: "connection-1".into(), authorization_ref: "authority_1".into() }, None)?;
                let received = parent.receive()?;
                assert!(parent.is_closed());
                assert!(matches!(received.frame, ControlFrame::Connected { .. }));
                let mut actual = TcpStream::from(received.descriptor.unwrap());
                let expected: SocketAddr = std::env::args().nth(2).unwrap().parse().unwrap();
                assert_eq!(actual.peer_addr().unwrap(), expected);
                actual.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                actual.write_all(b"retained-fd").unwrap();
                let mut bytes = [0; 8]; actual.read_exact(&mut bytes).unwrap(); assert_eq!(&bytes, b"complete");
            }
            "external-cardinality" => {
                let stream = UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned().unwrap());
                let mut parent = ControlEndpoint::new(stream, Side::Parent, Duration::from_secs(1), process.clone())?;
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
