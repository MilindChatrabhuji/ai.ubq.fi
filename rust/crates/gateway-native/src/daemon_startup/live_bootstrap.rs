//! One purpose-bound reverse FD, delivered only to an expendable request process.
use crate::{connector_fd::ReceiveProcess, connector_protocol::ControlError};
use gateway_auth::crypto::sha256_hex;
use rustix::{
    io::{FdFlags, fcntl_getfd, fcntl_setfd},
    net::{
        RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags, SendAncillaryBuffer,
        SendAncillaryMessage, SendFlags, SocketType, recvmsg, sendmsg, sockopt,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    io::{IoSlice, IoSliceMut},
    mem::MaybeUninit,
    net::{SocketAddr, TcpStream},
    os::{
        fd::{AsFd, OwnedFd},
        unix::net::UnixStream,
    },
    time::Duration,
};

const PURPOSE: &str = "live_authority";
const MAX_BYTES: usize = 512;

/// Configuration framing permits no ancillary descriptor, including on the
/// length prefix. The one reverse descriptor belongs only to its later frame.
pub(crate) fn read_config(
    channel: &UnixStream,
    process: &ReceiveProcess,
) -> Result<Vec<u8>, ControlError> {
    let mut descriptors = Vec::new();
    let mut header = [0; 4];
    read_exact(channel, &mut header, &mut descriptors, process)?;
    let length =
        usize::try_from(u32::from_be_bytes(header)).map_err(|_| ControlError::InvalidFrame)?;
    if length == 0 || length > 65_536 {
        return Err(ControlError::FrameTooLarge);
    }
    let mut bytes = vec![0; length];
    read_exact(channel, &mut bytes, &mut descriptors, process)?;
    if !descriptors.is_empty() {
        return Err(ControlError::UnexpectedDescriptor);
    }
    Ok(bytes)
}

pub(crate) fn read_timeout(
    channel: &UnixStream,
    timeout: Option<Duration>,
) -> Result<(), ControlError> {
    // Darwin rejects timeout changes after peer close. As in the existing
    // control receiver, retain queued final bytes/rights until recvmsg/EOF.
    if let Err(error) = channel.set_read_timeout(timeout)
        && (error.kind() != std::io::ErrorKind::InvalidInput
            || !crate::connector_worker::channel_events(channel, Duration::ZERO)?
                .contains(rustix::event::PollFlags::HUP))
    {
        return Err(io_error(error));
    }
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    v: u8,
    purpose: String,
    config_sha256: String,
    peer: SocketAddr,
}

pub(crate) fn send(
    channel: &UnixStream,
    config: &[u8],
    socket: TcpStream,
) -> Result<(), ControlError> {
    send_bound(channel, config, socket, 443)
}
fn send_bound(
    channel: &UnixStream,
    config: &[u8],
    socket: TcpStream,
    expected_port: u16,
) -> Result<(), ControlError> {
    let peer = socket.peer_addr().map_err(io_error)?;
    if peer.port() != expected_port || peer.ip().is_unspecified() || peer.ip().is_multicast() {
        return Err(ControlError::InvalidDescriptor);
    }
    let body = serde_json::to_vec(&Bootstrap {
        v: 1,
        purpose: PURPOSE.into(),
        config_sha256: sha256_hex(config),
        peer,
    })
    .map_err(|_| ControlError::InvalidFrame)?;
    if body.len() > MAX_BYTES {
        return Err(ControlError::FrameTooLarge);
    }
    let mut packet = u32::try_from(body.len())
        .map_err(|_| ControlError::FrameTooLarge)?
        .to_be_bytes()
        .to_vec();
    packet.extend_from_slice(&body);
    let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut ancillary = SendAncillaryBuffer::new(&mut storage);
    let rights = [socket.as_fd()];
    if !ancillary.push(SendAncillaryMessage::ScmRights(&rights)) {
        return Err(ControlError::UnexpectedDescriptor);
    }
    let count = sendmsg(
        channel,
        &[IoSlice::new(&packet)],
        &mut ancillary,
        send_flags(),
    )
    .map_err(errno)?;
    if count != packet.len() {
        return Err(ControlError::PartialSend);
    }
    Ok(())
}

pub(crate) fn receive(
    channel: &UnixStream,
    config: &[u8],
    process: &ReceiveProcess,
) -> Result<TcpStream, ControlError> {
    receive_bound(channel, config, process, 443)
}
fn receive_bound(
    channel: &UnixStream,
    config: &[u8],
    process: &ReceiveProcess,
    expected_port: u16,
) -> Result<TcpStream, ControlError> {
    let mut descriptors = Vec::new();
    let mut header = [0; 4];
    read_part(channel, &mut header[..1], true, &mut descriptors, process)?;
    read_exact(channel, &mut header[1..], &mut descriptors, process)?;
    let length =
        usize::try_from(u32::from_be_bytes(header)).map_err(|_| ControlError::FrameTooLarge)?;
    if length == 0 || length > MAX_BYTES {
        return Err(ControlError::FrameTooLarge);
    }
    let mut body = vec![0; length];
    read_exact(channel, &mut body, &mut descriptors, process)?;
    let boot: Bootstrap = serde_json::from_slice(&body).map_err(|_| ControlError::InvalidFrame)?;
    if boot.v != 1
        || boot.purpose != PURPOSE
        || boot.config_sha256 != sha256_hex(config)
        || descriptors.len() != 1
    {
        return Err(ControlError::InvalidFrame);
    }
    let descriptor = descriptors.pop().ok_or(ControlError::InvalidDescriptor)?;
    if sockopt::socket_type(&descriptor).map_err(errno)? != SocketType::STREAM {
        return Err(ControlError::InvalidDescriptor);
    }
    let flags = fcntl_getfd(&descriptor).map_err(errno)?;
    fcntl_setfd(&descriptor, flags | FdFlags::CLOEXEC).map_err(errno)?;
    let socket = TcpStream::from(descriptor);
    let peer = socket.peer_addr().map_err(io_error)?;
    if peer != boot.peer
        || peer.port() != expected_port
        || peer.ip().is_unspecified()
        || peer.ip().is_multicast()
    {
        return Err(ControlError::InvalidDescriptor);
    }
    Ok(socket)
}

pub(crate) fn completion(
    channel: &UnixStream,
    process: &ReceiveProcess,
) -> Result<u8, ControlError> {
    let mut byte = [0];
    read_part(channel, &mut byte, false, &mut Vec::new(), process)?;
    Ok(byte[0])
}

fn read_exact(
    channel: &UnixStream,
    mut bytes: &mut [u8],
    descriptors: &mut Vec<OwnedFd>,
    process: &ReceiveProcess,
) -> Result<(), ControlError> {
    while !bytes.is_empty() {
        let count = read_part(channel, bytes, false, descriptors, process)?;
        bytes = &mut bytes[count..];
    }
    Ok(())
}

fn read_part(
    channel: &UnixStream,
    bytes: &mut [u8],
    first: bool,
    descriptors: &mut Vec<OwnedFd>,
    _process: &ReceiveProcess,
) -> Result<usize, ControlError> {
    let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(2))];
    let mut ancillary = RecvAncillaryBuffer::new(&mut storage);
    let result = recvmsg(
        channel,
        &mut [IoSliceMut::new(bytes)],
        &mut ancillary,
        RecvFlags::empty(),
    )
    .map_err(errno)?;
    // As with the existing control receiver, Darwin truncation must terminate
    // this whole request process before rustix's pinned ancillary Drop path.
    if result
        .flags
        .intersects(ReturnFlags::CTRUNC | ReturnFlags::TRUNC)
    {
        std::process::exit(ControlError::AncillaryTruncated.exit_code());
    }
    let mut added = 0;
    let mut unknown = false;
    for message in ancillary.drain() {
        match message {
            RecvAncillaryMessage::ScmRights(fds) => {
                for fd in fds {
                    descriptors.push(fd);
                    added += 1;
                }
            }
            _ => unknown = true,
        }
    }
    if unknown || (!first && added != 0) || descriptors.len() > 1 {
        return Err(ControlError::UnexpectedDescriptor);
    }
    if result.bytes == 0 {
        return Err(ControlError::Truncated);
    }
    Ok(result.bytes)
}
fn send_flags() -> SendFlags {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        SendFlags::NOSIGNAL
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        SendFlags::empty()
    }
}
fn errno(error: rustix::io::Errno) -> ControlError {
    io_error(error.into())
}
fn io_error(error: std::io::Error) -> ControlError {
    ControlError::Io(error.kind())
}

#[cfg(test)]
mod tests;
