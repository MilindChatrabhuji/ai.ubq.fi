use super::*;
use std::{
    fs::File,
    io::{Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
    time::Duration,
};

const CONFIG: &[u8] = b"synthetic-private-config-v3";
struct ReceiverChild(Child);
impl Drop for ReceiverChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn inject(channel: &UnixStream, packet: &[u8], descriptors: Vec<OwnedFd>) {
    let rights: Vec<_> = descriptors.iter().map(AsFd::as_fd).collect();
    let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(16))];
    let mut ancillary = SendAncillaryBuffer::new(&mut storage);
    if !rights.is_empty() {
        assert!(ancillary.push(SendAncillaryMessage::ScmRights(&rights)));
    }
    assert_eq!(
        sendmsg(
            channel,
            &[IoSlice::new(packet)],
            &mut ancillary,
            send_flags()
        )
        .unwrap(),
        packet.len()
    );
}

#[test]
fn exact_reverse_fd_binding_and_all_bootstrap_faults_settle_the_receiver_process() {
    let directory =
        std::env::temp_dir().join(format!("uos-reverse-fd-policy-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let binary = std::env::current_exe().unwrap().canonicalize().unwrap();
    #[cfg(target_os = "macos")]
    let profile = crate::connector_policy::request(
        &binary,
        &crate::confinement::NativeConfinement {
            readonly_paths: Vec::new(),
            list_directories: Vec::new(),
            replay_directory: directory.clone(),
            unix_sockets: Vec::new(),
        },
        "127.0.0.1:31001".parse().unwrap(),
        "127.0.0.1:31002".parse().unwrap(),
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:443").unwrap();
    for scenario in [
        "valid",
        "digest",
        "purpose",
        "version",
        "missing",
        "extra",
        "late",
        "truncated",
        "not-socket",
        "ancillary-truncated",
        "peer",
        "completion-rights",
    ] {
        let (mut sender, receiver) = UnixStream::pair().unwrap();
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command.args(["-p", &profile]).arg(&binary);
            command
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = Command::new(&binary);
        let mut child = ReceiverChild(
            command
                .args([
                    "--ignored",
                    "--exact",
                    "daemon_startup::live_bootstrap::tests::reverse_fd_receive_child",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .stdin(Stdio::from(OwnedFd::from(receiver)))
                .env_clear()
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let connected = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut witness, _) = listener.accept().unwrap();
        witness
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        if matches!(scenario, "valid" | "completion-rights") {
            send(&sender, CONFIG, connected).unwrap();
            let mut marker = [0; 8];
            witness.read_exact(&mut marker).unwrap();
            assert_eq!(&marker, b"received");
            if scenario == "valid" {
                sender.write_all(&[1]).unwrap();
            } else {
                inject(&sender, &[1], vec![File::open("/dev/null").unwrap().into()]);
            }
        } else {
            let socket = connected;
            let mut body = Bootstrap {
                v: 1,
                purpose: PURPOSE.into(),
                config_sha256: sha256_hex(CONFIG),
                peer: socket.peer_addr().unwrap(),
            };
            match scenario {
                "digest" => body.config_sha256 = sha256_hex(b"different"),
                "purpose" => body.purpose = "provider_live".into(),
                "version" => body.v = 2,
                "peer" => body.peer.set_port(442),
                _ => {}
            }
            let body = serde_json::to_vec(&body).unwrap();
            let mut packet = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
            packet.extend_from_slice(&body);
            let rights = match scenario {
                "missing" => Vec::new(),
                "not-socket" => vec![OwnedFd::from(File::open("/dev/null").unwrap())],
                "extra" => vec![socket.try_clone().unwrap().into(), socket.into()],
                "ancillary-truncated" => (0..16)
                    .map(|_| socket.try_clone().unwrap().into())
                    .collect(),
                _ => vec![socket.into()],
            };
            if scenario == "late" {
                sender.write_all(&packet[..4]).unwrap();
                inject(&sender, &packet[4..], rights);
            } else if scenario == "truncated" {
                inject(&sender, &packet[..5], rights);
            } else {
                inject(&sender, &packet, rights);
            }
        }
        drop(sender);
        let status = child.0.wait().unwrap();
        assert_eq!(
            status.success(),
            scenario == "valid",
            "{scenario}: {status}"
        );
        // No sender copy or request-process descriptor may keep this peer alive.
        assert_eq!(witness.read(&mut [0]).unwrap(), 0, "{scenario}");
    }
    std::fs::remove_dir(directory).unwrap();
}

#[test]
#[ignore = "only the bounded parent fixture launches this expendable receiver"]
fn reverse_fd_receive_child() {
    ReceiveProcess::run(|process| {
        let channel = UnixStream::from(
            std::io::stdin()
                .as_fd()
                .try_clone_to_owned()
                .map_err(io_error)?,
        );
        channel
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(io_error)?;
        let mut socket = receive(&channel, CONFIG, process)?;
        assert!(
            fcntl_getfd(&socket)
                .map_err(errno)?
                .contains(FdFlags::CLOEXEC)
        );
        #[cfg(target_os = "macos")]
        assert!(
            TcpStream::connect_timeout(
                &socket.peer_addr().map_err(io_error)?,
                Duration::from_millis(200)
            )
            .is_err(),
            "request profile must deny a new connection while retaining the inherited FD"
        );
        socket.write_all(b"received").map_err(io_error)?;
        if completion(&channel, process)? != 1 {
            return Err(ControlError::InvalidFrame);
        }
        Ok(())
    })
}
