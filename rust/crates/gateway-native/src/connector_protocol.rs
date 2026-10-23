//! Private connector data only. A syntactically valid frame grants no dial or
//! effect authority; only the owning runtime may attach its real private proof.
use serde::{Deserialize, Serialize};
use std::{fmt, io};

pub const MAX_FRAME_BYTES: usize = 4096;
pub const WIRE_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    ProviderLive,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlFrame {
    Connect {
        v: u8,
        channel: Channel,
        action_ref: String,
        connection_id: String,
        authorization_ref: String,
    },
    Cancel {
        v: u8,
        connection_id: String,
    },
    Connected {
        v: u8,
        connection_id: String,
    },
    Cancelled {
        v: u8,
        connection_id: String,
    },
    Unavailable {
        v: u8,
        connection_id: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlError {
    InvalidFrame,
    FrameTooLarge,
    MissingDescriptor,
    UnexpectedDescriptor,
    InvalidDescriptor,
    AncillaryTruncated,
    DuplicateId,
    UnmatchedId,
    WrongState,
    Cancelled,
    Closed,
    PeerClosed,
    Truncated,
    PartialSend,
    UnsupportedPlatform,
    Io(io::ErrorKind),
}
impl fmt::Display for ControlError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "Private connector control: {self:?}")
    }
}
impl std::error::Error for ControlError {}

impl ControlFrame {
    pub(crate) fn connection_id(&self) -> &str {
        match self {
            Self::Connect { connection_id, .. }
            | Self::Cancel { connection_id, .. }
            | Self::Connected { connection_id, .. }
            | Self::Cancelled { connection_id, .. }
            | Self::Unavailable { connection_id, .. } => connection_id,
        }
    }
    pub(crate) fn connected(&self) -> bool {
        matches!(self, Self::Connected { .. })
    }
    pub(crate) fn validate(&self) -> Result<(), ControlError> {
        let v = match self {
            Self::Connect {
                v,
                action_ref,
                authorization_ref,
                ..
            } => {
                reference(action_ref)?;
                reference(authorization_ref)?;
                *v
            }
            Self::Cancel { v, .. }
            | Self::Connected { v, .. }
            | Self::Cancelled { v, .. }
            | Self::Unavailable { v, .. } => *v,
        };
        if v != WIRE_VERSION {
            return Err(ControlError::InvalidFrame);
        }
        reference(self.connection_id())
    }
    pub fn encode(&self) -> Result<Vec<u8>, ControlError> {
        self.validate()?;
        let data = serde_json::to_vec(self).map_err(|_| ControlError::InvalidFrame)?;
        if data.len() > MAX_FRAME_BYTES {
            return Err(ControlError::FrameTooLarge);
        }
        Ok(data)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, ControlError> {
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(ControlError::FrameTooLarge);
        }
        let frame: Self = serde_json::from_slice(bytes).map_err(|_| ControlError::InvalidFrame)?;
        frame.validate()?;
        Ok(frame)
    }
}
fn reference(value: &str) -> Result<(), ControlError> {
    gateway_auth::native_live::validate_reference(value).map_err(|_| ControlError::InvalidFrame)
}

impl ControlError {
    pub(crate) fn exit_code(self) -> i32 {
        match self {
            Self::InvalidFrame => 64,
            Self::FrameTooLarge => 65,
            Self::MissingDescriptor => 66,
            Self::UnexpectedDescriptor => 67,
            Self::InvalidDescriptor => 68,
            Self::AncillaryTruncated => 69,
            Self::DuplicateId => 70,
            Self::UnmatchedId => 71,
            Self::WrongState => 72,
            Self::Cancelled => 73,
            Self::Closed => 74,
            Self::PeerClosed => 75,
            Self::Truncated => 76,
            Self::PartialSend => 77,
            Self::UnsupportedPlatform => 78,
            Self::Io(kind) => match kind {
                io::ErrorKind::WouldBlock => 80,
                io::ErrorKind::TimedOut => 81,
                io::ErrorKind::BrokenPipe => 82,
                io::ErrorKind::ConnectionReset => 83,
                io::ErrorKind::ConnectionAborted => 84,
                io::ErrorKind::NotConnected => 85,
                io::ErrorKind::UnexpectedEof => 86,
                io::ErrorKind::PermissionDenied => 87,
                io::ErrorKind::InvalidInput => 88,
                io::ErrorKind::Interrupted => 89,
                _ => 127,
            },
        }
    }
}
