use crate::{confinement::NativeConfinement, connector_policy, connector_protocol::ControlError};
use gateway_auth::crypto::base64url;
use rustix::net::{SendAncillaryBuffer, SendAncillaryMessage, SendFlags, sendmsg};
use std::{
    io::{IoSlice, Read, Write},
    mem::MaybeUninit,
    net::{TcpListener, TcpStream},
    os::{
        fd::{AsFd, OwnedFd},
        unix::net::UnixStream,
    },
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct OwnedRequest(Child);
impl Drop for OwnedRequest {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn tcp_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (server, _) = listener.accept().unwrap();
    (client, server)
}

#[test]
fn actual_config_ancillary_rejected_before_service() {
    let binary = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("uos-native-request")
        .canonicalize()
        .unwrap();
    for position in ["header", "body"] {
        let directory = std::env::temp_dir().join(format!(
            "uos-early-config-{}-{position}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let replay = directory.join("replay");
        std::fs::create_dir(&replay).unwrap();
        let database = replay.join("nonces.sqlite3");
        let config = serde_json::json!({"v":3,"listen":"127.0.0.1:0","identity":{"key_id":"fixture-key","owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_base64url":base64url(&[73;32])},"nonce_database":database,"sources":[],"live_sideband":{"authority_origin":"https://rust-candidate.ai.ubq.fi"}});
        let body = serde_json::to_vec(&config).unwrap();
        let mut packet = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
        packet.extend_from_slice(&body);
        let (mut input, child_input) = UnixStream::pair().unwrap();
        let (mut control, child_control) = UnixStream::pair().unwrap();
        let (mut client, downstream) = tcp_pair();
        let (sent, mut witness) = tcp_pair();
        for socket in [&client, &witness] {
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
        }
        control
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let policy = connector_policy::request(
            &binary,
            &NativeConfinement {
                readonly_paths: Vec::new(),
                list_directories: Vec::new(),
                replay_directory: replay,
                unix_sockets: Vec::new(),
            },
            downstream.local_addr().unwrap(),
            downstream.peer_addr().unwrap(),
        )
        .unwrap();
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .args(["-p", &policy])
            .arg(&binary)
            .env_clear()
            .stdin(Stdio::from(OwnedFd::from(child_input)))
            .stdout(Stdio::from(OwnedFd::from(downstream)))
            .stderr(Stdio::from(OwnedFd::from(child_control)));
        let mut child = OwnedRequest(command.spawn().unwrap());
        drop(command);
        let offset = if position == "header" {
            0
        } else {
            4 + body.len() / 2
        };
        input.write_all(&packet[..offset]).unwrap();
        {
            let rights = [sent.as_fd()];
            let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
            let mut ancillary = SendAncillaryBuffer::new(&mut storage);
            assert!(ancillary.push(SendAncillaryMessage::ScmRights(&rights)));
            assert_eq!(
                sendmsg(
                    &input,
                    &[IoSlice::new(&packet[offset..])],
                    &mut ancillary,
                    SendFlags::empty()
                )
                .unwrap(),
                packet.len() - offset
            );
        }
        drop(sent);
        // Keep stdin open: a later missing-bootstrap timeout/EOF is not proof
        // that configuration-stage ancillary data was actually rejected.
        let deadline = Instant::now() + Duration::from_secs(12);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "early config child exceeded its existing bound"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(
            status.code(),
            Some(ControlError::UnexpectedDescriptor.exit_code()),
            "{position}: {status}"
        );
        assert!(
            !database.exists(),
            "configuration ancillary reached nonce/service construction"
        );
        assert_eq!(
            witness.read(&mut [0]).unwrap(),
            0,
            "{position} descriptor did not close"
        );
        assert_eq!(
            client.read(&mut [0]).unwrap(),
            0,
            "unexpected service output"
        );
        assert_eq!(
            control.read(&mut [0]).unwrap(),
            0,
            "unexpected provider dispatch"
        );
        drop(input);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
