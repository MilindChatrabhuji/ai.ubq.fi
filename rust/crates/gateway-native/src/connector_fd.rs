//! Owned Unix/SCM_RIGHTS transport confined to a terminal request process.
//! Truncated ancillary buffers terminate that process before the pinned Drop path.
use crate::connector_protocol::{ControlError, ControlFrame, MAX_FRAME_BYTES};
use rustix::{
    io::{FdFlags, fcntl_getfd, fcntl_setfd},
    net::{
        RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags, SendAncillaryBuffer,
        SendAncillaryMessage, SendFlags, SocketType, getpeername, recvmsg, sendmsg, sockopt,
    },
};
use std::{
    io::{IoSlice, IoSliceMut},
    mem::MaybeUninit,
    os::{
        fd::{AsFd, OwnedFd},
        unix::net::UnixStream,
    },
    sync::Arc,
    time::Duration,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Side {
    Parent,
    Connector,
}
struct Pending {
    id: String,
    cancelled: bool,
}
#[derive(Debug)]
pub struct ReceivedFrame {
    pub frame: ControlFrame,
    pub descriptor: Option<OwnedFd>,
}
pub struct ControlEndpoint {
    process: Arc<ReceiveProcess>,
    peer_hung_up: bool,
    stream: Option<UnixStream>,
    side: Side,
    pending: Option<Pending>,
}
impl ControlEndpoint {
    pub fn new(
        stream: UnixStream,
        side: Side,
        timeout: Duration,
        process: Arc<ReceiveProcess>,
    ) -> Result<Self, ControlError> {
        if timeout.is_zero() {
            return Err(ControlError::InvalidFrame);
        }
        if !cfg!(any(
            target_os = "linux",
            target_os = "android",
            target_os = "macos",
            target_os = "ios",
            target_os = "tvos",
            target_os = "watchos",
            target_os = "visionos",
            target_os = "freebsd",
            target_os = "dragonfly",
            target_os = "netbsd"
        )) {
            return Err(ControlError::UnsupportedPlatform);
        }
        let mut peer_hung_up = crate::connector_worker::channel_events(&stream, Duration::ZERO)?
            .contains(rustix::event::PollFlags::HUP);
        if !peer_hung_up {
            let configured = (|| {
                #[cfg(any(
                    target_os = "macos",
                    target_os = "ios",
                    target_os = "tvos",
                    target_os = "watchos",
                    target_os = "visionos",
                    target_os = "freebsd",
                    target_os = "dragonfly",
                    target_os = "netbsd"
                ))]
                sockopt::set_socket_nosigpipe(&stream, true).map_err(errno)?;
                stream.set_read_timeout(Some(timeout)).map_err(io_error)?;
                stream.set_write_timeout(Some(timeout)).map_err(io_error)?;
                Ok::<(), ControlError>(())
            })();
            if let Err(error) = configured {
                // Darwin returns EINVAL for socket timeout options after peer
                // close. Preserve queued final data/rights and let receive read
                // the actual frame/EOF; never infer EOF from HUP alone.
                if error == ControlError::Io(std::io::ErrorKind::InvalidInput)
                    && crate::connector_worker::channel_events(&stream, Duration::ZERO)?
                        .contains(rustix::event::PollFlags::HUP)
                {
                    peer_hung_up = true;
                } else {
                    return Err(error);
                }
            }
        }
        cloexec(&stream)?;
        Ok(Self {
            process,
            peer_hung_up,
            stream: Some(stream),
            side,
            pending: None,
        })
    }
    pub fn is_closed(&self) -> bool {
        self.stream.is_none()
    }
    pub fn close(&mut self) {
        // Closing the control socket also discards queued ancillary rights.
        // A successfully returned descriptor has independent owned lifetime.
        drop(self.stream.take());
        self.pending = None;
    }
    /// Consumes the sender's descriptor even on refusal/error. A short send is
    /// unknown; never resend SCM_RIGHTS or the rest of that frame automatically.
    pub fn send(
        &mut self,
        frame: ControlFrame,
        descriptor: Option<OwnedFd>,
    ) -> Result<(), ControlError> {
        let terminal = terminal(&frame);
        let result = (|| {
            if self.is_closed() {
                return Err(ControlError::Closed);
            }
            if self.peer_hung_up {
                return Err(ControlError::PeerClosed);
            }
            let body = frame.encode()?;
            descriptor_shape(&frame, descriptor.as_ref())?;
            self.transition(&frame, true)?;
            let mut packet = u32::try_from(body.len())
                .map_err(|_| ControlError::FrameTooLarge)?
                .to_be_bytes()
                .to_vec();
            packet.extend_from_slice(&body);
            let rights: Vec<_> = descriptor.as_ref().map(AsFd::as_fd).into_iter().collect();
            let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
            let mut ancillary = SendAncillaryBuffer::new(&mut storage);
            if !rights.is_empty() && !ancillary.push(SendAncillaryMessage::ScmRights(&rights)) {
                return Err(ControlError::UnexpectedDescriptor);
            }
            let count = sendmsg(
                self.stream.as_ref().ok_or(ControlError::Closed)?,
                &[IoSlice::new(&packet)],
                &mut ancillary,
                send_flags(),
            )
            .map_err(errno)?;
            if count != packet.len() {
                return Err(ControlError::PartialSend);
            }
            Ok(())
        })();
        if result.is_err() || terminal {
            self.close();
        }
        result
    }
    pub fn receive(&mut self) -> Result<ReceivedFrame, ControlError> {
        let result = (|| {
            let stream = self.stream.as_ref().ok_or(ControlError::Closed)?;
            let (body, mut descriptors) = receive_packet(stream, &self.process)?;
            let frame = ControlFrame::decode(&body)?;
            if descriptors.len() > 1 {
                return Err(ControlError::UnexpectedDescriptor);
            }
            let descriptor = descriptors.pop();
            descriptor_shape(&frame, descriptor.as_ref())?;
            if let Some(fd) = &descriptor {
                cloexec(fd)?;
            }
            self.transition(&frame, false)?;
            if terminal(&frame) {
                self.close();
            }
            Ok(ReceivedFrame { frame, descriptor })
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    fn transition(&mut self, frame: &ControlFrame, outgoing: bool) -> Result<(), ControlError> {
        let from_parent = matches!(
            (self.side, outgoing),
            (Side::Parent, true) | (Side::Connector, false)
        );
        let id = frame.connection_id();
        match frame {
            ControlFrame::Connect { .. } => {
                if !from_parent {
                    return Err(ControlError::WrongState);
                }
                if let Some(pending) = &self.pending {
                    return Err(if pending.id == id {
                        ControlError::DuplicateId
                    } else {
                        ControlError::WrongState
                    });
                }
                self.pending = Some(Pending {
                    id: id.into(),
                    cancelled: false,
                });
            }
            ControlFrame::Cancel { .. } => {
                if !from_parent {
                    return Err(ControlError::WrongState);
                }
                let pending = self.pending.as_mut().ok_or(ControlError::WrongState)?;
                if pending.id != id {
                    return Err(ControlError::UnmatchedId);
                }
                if pending.cancelled {
                    return Err(ControlError::DuplicateId);
                }
                pending.cancelled = true;
            }
            ControlFrame::Connected { .. }
            | ControlFrame::Cancelled { .. }
            | ControlFrame::Unavailable { .. } => {
                if from_parent {
                    return Err(ControlError::WrongState);
                }
                let pending = self.pending.as_ref().ok_or(ControlError::WrongState)?;
                if pending.id != id {
                    return Err(ControlError::UnmatchedId);
                }
                if pending.cancelled && frame.connected() {
                    return Err(ControlError::Cancelled);
                }
                self.pending = None;
            }
        }
        Ok(())
    }
}
fn terminal(frame: &ControlFrame) -> bool {
    matches!(
        frame,
        ControlFrame::Connected { .. }
            | ControlFrame::Cancelled { .. }
            | ControlFrame::Unavailable { .. }
    )
}
fn descriptor_shape(frame: &ControlFrame, fd: Option<&OwnedFd>) -> Result<(), ControlError> {
    match (frame.connected(), fd) {
        (true, None) => Err(ControlError::MissingDescriptor),
        (false, Some(_)) => Err(ControlError::UnexpectedDescriptor),
        (true, Some(fd)) => {
            if sockopt::socket_type(fd).map_err(errno)? != SocketType::STREAM {
                return Err(ControlError::InvalidDescriptor);
            }
            // A successful getpeername may have NO named address for an actual
            // connected Unix socket pair. Err(ENOTCONN), not Ok(None), refuses
            // an unconnected stream. The real socket-pair fixture proves this.
            let _ = getpeername(fd).map_err(errno)?;
            Ok(())
        }
        (false, None) => Ok(()),
    }
}
fn receive_packet(
    stream: &UnixStream,
    process: &ReceiveProcess,
) -> Result<(Vec<u8>, Vec<OwnedFd>), ControlError> {
    let mut descriptors = Vec::new();
    let mut header = [0u8; 4];
    // Restrict the first recvmsg to ONE byte. Later rights cannot be mistaken
    // for rights attached to an earlier plain-byte prefix on a stream socket.
    if receive_part(stream, &mut header[..1], true, &mut descriptors, process)? == 0 {
        return Err(ControlError::PeerClosed);
    }
    receive_exact(stream, &mut header[1..], &mut descriptors, process)?;
    let length =
        usize::try_from(u32::from_be_bytes(header)).map_err(|_| ControlError::FrameTooLarge)?;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(ControlError::FrameTooLarge);
    }
    let mut body = vec![0; length];
    receive_exact(stream, &mut body, &mut descriptors, process)?;
    Ok((body, descriptors))
}
fn receive_exact(
    stream: &UnixStream,
    mut bytes: &mut [u8],
    descriptors: &mut Vec<OwnedFd>,
    process: &ReceiveProcess,
) -> Result<(), ControlError> {
    while !bytes.is_empty() {
        let count = receive_part(stream, bytes, false, descriptors, process)?;
        if count == 0 {
            return Err(ControlError::Truncated);
        }
        bytes = &mut bytes[count..];
    }
    Ok(())
}
fn receive_part(
    stream: &UnixStream,
    bytes: &mut [u8],
    first: bool,
    descriptors: &mut Vec<OwnedFd>,
    process: &ReceiveProcess,
) -> Result<usize, ControlError> {
    let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(2))];
    let mut ancillary = RecvAncillaryBuffer::new(&mut storage);
    let message = recvmsg(
        stream,
        &mut [IoSliceMut::new(bytes)],
        &mut ancillary,
        recv_flags(),
    )
    .map_err(errno)?;
    // rustix 1.1.5 cannot safely drain/drop Darwin's truncated header. This
    // receiver is an expendable process, so terminate the WHOLE process before
    // either path; the supervisor must wait and independently verify closure.
    if message
        .flags
        .intersects(ReturnFlags::CTRUNC | ReturnFlags::TRUNC)
    {
        process.terminate(ControlError::AncillaryTruncated);
    }
    let mut unknown = false;
    let mut added = 0;
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
    Ok(message.bytes)
}
fn cloexec(fd: impl AsFd) -> Result<(), ControlError> {
    let flags = fcntl_getfd(&fd).map_err(errno)?;
    fcntl_setfd(fd, flags | FdFlags::CLOEXEC).map_err(errno)
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
fn recv_flags() -> RecvFlags {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        RecvFlags::CMSG_CLOEXEC
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        RecvFlags::empty()
    }
}
fn errno(error: rustix::io::Errno) -> ControlError {
    io_error(std::io::Error::from(error))
}
fn io_error(error: std::io::Error) -> ControlError {
    ControlError::Io(error.kind())
}

/// Unforgeable local lifetime: entering it never returns to a long-lived caller.
/// It is not OS-confinement evidence; only the prelaunch policy provides that.
pub struct ReceiveProcess {
    _private: (),
}
impl ReceiveProcess {
    pub fn run(operation: impl FnOnce(&Arc<Self>) -> Result<(), ControlError>) -> ! {
        let process = Arc::new(Self { _private: () });
        match operation(&process) {
            Ok(()) => std::process::exit(0),
            Err(error) => process.terminate(error),
        }
    }
    fn terminate(&self, error: ControlError) -> ! {
        std::process::exit(error.exit_code())
    }
}
