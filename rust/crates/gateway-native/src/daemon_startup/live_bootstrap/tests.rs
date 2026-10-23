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
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let fixture_port = listener.local_addr().unwrap().port();
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
        "production-port",
        "closed-valid",
    ] {
        let (mut sender, receiver) = UnixStream::pair().unwrap();
        let expected_port = if scenario == "production-port" {
            443
        } else {
            fixture_port
        };
        sender.write_all(&expected_port.to_be_bytes()).unwrap();
        sender
            .write_all(&u32::try_from(CONFIG.len()).unwrap().to_be_bytes())
            .unwrap();
        sender.write_all(CONFIG).unwrap();
        let connected = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        assert_eq!(
            send(&sender, CONFIG, connected.try_clone().unwrap()).unwrap_err(),
            ControlError::InvalidDescriptor,
            "production sender must still require port443"
        );
        let (mut witness, _) = listener.accept().unwrap();
        witness
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        #[cfg(target_os = "macos")]
        let profile = crate::connector_policy::request(
            &binary,
            &crate::confinement::NativeConfinement {
                readonly_paths: Vec::new(),
                list_directories: Vec::new(),
                replay_directory: directory.clone(),
                unix_sockets: Vec::new(),
            },
            witness.local_addr().unwrap(),
            witness.peer_addr().unwrap(),
        )
        .unwrap();
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command.args(["-p", &profile]).arg(&binary);
            command
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = Command::new(&binary);
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
            .stderr(Stdio::piped());
        let mut child = if matches!(scenario, "valid" | "completion-rights") {
            Some(ReceiverChild(command.spawn().unwrap()))
        } else {
            None
        };
        if matches!(scenario, "valid" | "completion-rights" | "closed-valid") {
            send_bound(&sender, CONFIG, connected, fixture_port).unwrap();
            if scenario != "closed-valid" {
                let mut marker = [0; 8];
                witness.read_exact(&mut marker).unwrap();
                assert_eq!(&marker, b"received");
            }
            if matches!(scenario, "valid" | "closed-valid") {
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
        // These cases start only after sender close: queued rights must survive
        // the actual Darwin HUP/timeout race, not depend on lucky scheduling.
        if child.is_none() {
            child = Some(ReceiverChild(command.spawn().unwrap()));
        }
        drop(command);
        let status = child.as_mut().unwrap().0.wait().unwrap();
        let expected = match scenario {
            "valid" | "closed-valid" => 0,
            "extra" | "late" | "completion-rights" => {
                ControlError::UnexpectedDescriptor.exit_code()
            }
            "ancillary-truncated" => ControlError::AncillaryTruncated.exit_code(),
            "truncated" => ControlError::Truncated.exit_code(),
            "peer" | "production-port" => ControlError::InvalidDescriptor.exit_code(),
            "not-socket" => ControlError::Io(std::io::ErrorKind::Other).exit_code(),
            _ => ControlError::InvalidFrame.exit_code(),
        };
        assert_eq!(status.code(), Some(expected), "{scenario}: {status}");
        if scenario == "closed-valid" {
            let mut marker = [0; 8];
            witness.read_exact(&mut marker).unwrap();
            assert_eq!(&marker, b"received");
        }
        // No sender copy or request-process descriptor may keep this peer alive.
        assert_eq!(witness.read(&mut [0]).unwrap(), 0, "{scenario}");
    }
    std::fs::remove_dir(directory).unwrap();
}

#[test]
#[ignore = "only the bounded parent fixture launches this expendable receiver"]
fn reverse_fd_receive_child() {
    ReceiveProcess::run(|process| {
        // Test-only transport metadata; neither product entrypoint accepts a
        // caller-selected port. Unbuffered reads preserve the following rights.
        let mut input = File::from(
            std::io::stdin()
                .as_fd()
                .try_clone_to_owned()
                .map_err(io_error)?,
        );
        let mut port = [0; 2];
        input.read_exact(&mut port).map_err(io_error)?;
        drop(input);
        let fixture_port = u16::from_be_bytes(port);
        if fixture_port < 1024 && fixture_port != 443 {
            return Err(ControlError::InvalidFrame);
        }
        let channel = UnixStream::from(
            std::io::stdin()
                .as_fd()
                .try_clone_to_owned()
                .map_err(io_error)?,
        );
        read_timeout(&channel, Some(Duration::from_secs(2)))?;
        if read_config(&channel, process)? != CONFIG {
            return Err(ControlError::InvalidFrame);
        }
        let mut socket = if fixture_port == 443 {
            receive(&channel, CONFIG, process)?
        } else {
            receive_bound(&channel, CONFIG, process, fixture_port)?
        };
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
