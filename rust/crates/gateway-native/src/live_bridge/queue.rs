use super::{MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, PREOPEN_MAX_FRAMES, failure};
use gateway_auth::GatewayError;
use std::{
    collections::VecDeque,
    io::{Read, Write},
};
use tungstenite::{Error, Message, WebSocket, protocol::WebSocketConfig};

pub(super) fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_BUFFERED_BYTES)
        .max_message_size(Some(MAX_PAYLOAD_BYTES))
        .max_frame_size(Some(MAX_PAYLOAD_BYTES))
}

#[derive(Default)]
pub(super) struct PreopenQueue {
    frames: VecDeque<String>,
    bytes: usize,
}
impl PreopenQueue {
    pub fn push(&mut self, text: String) -> Result<(), GatewayError> {
        if text.len() > MAX_PAYLOAD_BYTES
            || self.frames.len() >= PREOPEN_MAX_FRAMES
            || self.bytes.saturating_add(text.len()) > MAX_BUFFERED_BYTES
        {
            return Err(failure("realtime sideband frame queue overflow"));
        }
        self.bytes += text.len();
        self.frames.push_back(text);
        Ok(())
    }
    pub fn drain(self) -> impl Iterator<Item = String> {
        self.frames.into_iter()
    }
}

/// All accepted data remains charged until BOTH the WebSocket and its actual
/// underlying TLS/socket flush complete. Only one frame enters those buffers
/// at a time. A blocked TLS write therefore cannot hide another queue from the
/// native bound; subsequent frames stay in this owned, counted queue.
pub(super) struct PendingSocket<S> {
    pub socket: WebSocket<S>,
    queue: VecDeque<String>,
    pending: usize,
    in_flight: Option<usize>,
}
impl<S: Read + Write> PendingSocket<S> {
    pub fn new(socket: WebSocket<S>) -> Self {
        Self {
            socket,
            queue: VecDeque::new(),
            pending: 0,
            in_flight: None,
        }
    }
    pub fn enqueue(&mut self, text: String) -> Result<(), GatewayError> {
        if text.len() > MAX_PAYLOAD_BYTES
            || self.pending.saturating_add(text.len()) > MAX_BUFFERED_BYTES
        {
            return Err(failure("realtime sideband is not writable"));
        }
        self.pending += text.len();
        self.queue.push_back(text);
        Ok(())
    }
    pub fn pump(&mut self) -> Result<(), GatewayError> {
        loop {
            if let Some(bytes) = self.in_flight {
                match self.socket.flush() {
                    Ok(()) => {
                        self.pending -= bytes;
                        self.in_flight = None;
                    }
                    Err(error) if blocked(&error) => return Ok(()),
                    Err(_) => return Err(failure("realtime upstream send failed")),
                }
            }
            let Some(text) = self.queue.pop_front() else {
                return Ok(());
            };
            let size = text.len();
            self.in_flight = Some(size);
            match self.socket.write(Message::Text(text.into())) {
                Ok(()) => {}
                Err(error) if blocked(&error) => return Ok(()),
                Err(_) => return Err(failure("realtime upstream send failed")),
            }
        }
    }
}
pub(super) fn blocked(error: &Error) -> bool {
    matches!(error,Error::Io(error) if error.kind()==std::io::ErrorKind::WouldBlock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use tungstenite::protocol::Role;
    #[derive(Default)]
    struct Blocked;
    impl Read for Blocked {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::ErrorKind::WouldBlock.into())
        }
    }
    impl Write for Blocked {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::WouldBlock.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::WouldBlock.into())
        }
    }
    #[test]
    fn source_preopen_limits_preserve_order_and_exact_payload_budget() {
        let mut queue = PreopenQueue::default();
        for index in 0..32 {
            queue.push(index.to_string()).unwrap();
        }
        assert!(queue.push("overflow".into()).is_err());
        assert_eq!(
            queue.drain().collect::<Vec<_>>(),
            (0..32).map(|i| i.to_string()).collect::<Vec<_>>()
        );
        let mut queue = PreopenQueue::default();
        queue.push("a".repeat(MAX_PAYLOAD_BYTES)).unwrap();
        queue.push("b".repeat(MAX_PAYLOAD_BYTES)).unwrap();
        assert!(queue.push("x".into()).is_err());
    }
    #[test]
    fn blocked_actual_writer_keeps_inflight_charged_and_never_accepts_over_eight_mib() {
        let socket = WebSocket::from_raw_socket(Blocked, Role::Client, Some(websocket_config()));
        let mut peer = PendingSocket::new(socket);
        peer.enqueue("a".repeat(MAX_PAYLOAD_BYTES)).unwrap();
        peer.pump().unwrap();
        assert_eq!(peer.pending, MAX_PAYLOAD_BYTES);
        assert_eq!(peer.in_flight, Some(MAX_PAYLOAD_BYTES));
        peer.enqueue("b".repeat(MAX_PAYLOAD_BYTES)).unwrap();
        peer.pump().unwrap();
        assert_eq!(peer.pending, MAX_BUFFERED_BYTES);
        assert!(peer.enqueue("x".into()).is_err());
    }
    #[test]
    fn actual_non_draining_socket_cannot_hide_pending_frames_from_the_native_bound() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let stream = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_non_draining_peer, _) = listener.accept().unwrap();
        socket2::SockRef::from(&stream)
            .set_send_buffer_size(1024)
            .unwrap();
        stream.set_nonblocking(true).unwrap();
        let mut peer = PendingSocket::new(WebSocket::from_raw_socket(
            stream,
            Role::Client,
            Some(websocket_config()),
        ));
        let mut refused = false;
        for _ in 0..64 {
            if peer.enqueue("x".repeat(MAX_PAYLOAD_BYTES)).is_err() {
                refused = true;
                break;
            }
            peer.pump().unwrap();
            assert!(peer.pending <= MAX_BUFFERED_BYTES);
        }
        assert!(refused);
        assert!(peer.in_flight.is_some());
        assert!(peer.pending <= MAX_BUFFERED_BYTES);
    }
}
