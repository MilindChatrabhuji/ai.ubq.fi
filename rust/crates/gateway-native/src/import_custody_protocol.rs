//! Closed native-only DATA. A decoded frame never grants stop, mutation or completion.
use crate::native_import::NativeImportContext;
use gateway_authority::native_control::import::ImportCustodyStartedRequest;
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::TcpStream,
    time::{Duration, Instant},
};

// Five 4096-byte authority-text fields may each escape to six bytes per UTF8 byte.
// Two original ASCII references use 256 bytes, three hashes 64 and safe time 16 digits.
// Exact serializer maximum is asserted against the complete required shape below.
pub(crate) const STARTED_BINDING_MAX: usize = 123_831;
pub(crate) const CUSTODY_FRAME_MAX: usize = 148_689;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Header {
    pub(crate) v: u8,
    pub(crate) sequence: u64,
    pub(crate) session_ref: String,
    pub(crate) challenge: String,
    pub(crate) binding: ImportCustodyStartedRequest,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Release {
    pub(crate) v: u8,
    pub(crate) sequence: u64,
    pub(crate) session_ref: String,
    pub(crate) challenge: String,
    pub(crate) binding: ImportCustodyStartedRequest,
    pub(crate) publication_revision: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Stopped {
    pub(crate) v: u8,
    pub(crate) sequence: u64,
    pub(crate) session_ref: String,
    pub(crate) challenge: String,
    pub(crate) binding: ImportCustodyStartedRequest,
    pub(crate) epoch: String,
    pub(crate) root_device: u64,
    pub(crate) root_inode: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub(crate) enum Frame {
    Quiesce(Header),
    CheckStopped(Header),
    ReleaseAfterVerifiedTerminal(Release),
    Cancel(Header),
    Stopped(Stopped),
    Refused(Header),
    Unknown(Header),
    Released(Header),
}
pub(crate) struct HeaderView<'a> {
    pub(crate) sequence: u64,
    pub(crate) session_ref: &'a str,
    pub(crate) challenge: &'a str,
    pub(crate) binding: &'a ImportCustodyStartedRequest,
}
impl Frame {
    pub(crate) fn header(&self) -> HeaderView<'_> {
        match self {
            Self::Quiesce(h)
            | Self::CheckStopped(h)
            | Self::Cancel(h)
            | Self::Refused(h)
            | Self::Unknown(h)
            | Self::Released(h) => HeaderView {
                sequence: h.sequence,
                session_ref: &h.session_ref,
                challenge: &h.challenge,
                binding: &h.binding,
            },
            Self::ReleaseAfterVerifiedTerminal(h) => HeaderView {
                sequence: h.sequence,
                session_ref: &h.session_ref,
                challenge: &h.challenge,
                binding: &h.binding,
            },
            Self::Stopped(h) => HeaderView {
                sequence: h.sequence,
                session_ref: &h.session_ref,
                challenge: &h.challenge,
                binding: &h.binding,
            },
        }
    }
    fn version(&self) -> u8 {
        match self {
            Self::Quiesce(h)
            | Self::CheckStopped(h)
            | Self::Cancel(h)
            | Self::Refused(h)
            | Self::Unknown(h)
            | Self::Released(h) => h.v,
            Self::ReleaseAfterVerifiedTerminal(h) => h.v,
            Self::Stopped(h) => h.v,
        }
    }
    pub(crate) fn validate(&self) -> Result<(), GatewayError> {
        let h = self.header();
        h.binding.validate()?;
        if self.version() != 1
            || h.sequence == 0
            || !hash(h.session_ref)
            || !hash(h.challenge)
            || h.binding.canonical_bytes()?.len() > STARTED_BINDING_MAX
        {
            return Err(unavailable());
        }
        match self {
            Self::ReleaseAfterVerifiedTerminal(h)
                if h.publication_revision.trim().is_empty()
                    || h.publication_revision.len() > 4096 =>
            {
                Err(unavailable())
            }
            Self::Stopped(h) if !hash(&h.epoch) || h.root_inode == 0 => Err(unavailable()),
            _ => Ok(()),
        }
    }
    pub(crate) fn encode(&self) -> Result<Vec<u8>, GatewayError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| unavailable())?;
        if bytes.len() > CUSTODY_FRAME_MAX {
            return Err(unavailable());
        }
        Ok(bytes)
    }
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, GatewayError> {
        if bytes.is_empty() || bytes.len() > CUSTODY_FRAME_MAX {
            return Err(unavailable());
        }
        let frame: Self = serde_json::from_slice(bytes).map_err(|_| unavailable())?;
        frame.validate()?;
        Ok(frame)
    }
}
impl HeaderView<'_> {
    pub(crate) fn copy_data(&self) -> Result<Header, GatewayError> {
        Ok(Header {
            v: 1,
            sequence: self.sequence,
            session_ref: self.session_ref.into(),
            challenge: self.challenge.into(),
            binding: copy_binding(self.binding)?,
        })
    }
}
pub(crate) fn copy_binding(
    request: &ImportCustodyStartedRequest,
) -> Result<ImportCustodyStartedRequest, GatewayError> {
    serde_json::from_slice(&request.canonical_bytes()?).map_err(|_| unavailable())
}
pub(crate) fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn random_ref() -> Result<String, GatewayError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
    Ok(gateway_auth::crypto::sha256_hex(&bytes))
}
fn remaining(deadline: Instant) -> Result<Duration, GatewayError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .map(|d| d.min(Duration::from_millis(20)))
        .ok_or_else(unavailable)
}
fn check(context: Option<&NativeImportContext<'_>>) -> Result<(), GatewayError> {
    if let Some(context) = context {
        context.check()?;
    }
    Ok(())
}
fn read_exact(
    stream: &mut TcpStream,
    mut bytes: &mut [u8],
    deadline: Instant,
    context: Option<&NativeImportContext<'_>>,
) -> Result<(), GatewayError> {
    while !bytes.is_empty() {
        check(context)?;
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| unavailable())?;
        match stream.read(bytes) {
            Ok(0) => return Err(unavailable()),
            Ok(n) => {
                bytes = &mut bytes[n..];
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err(unavailable()),
        }
    }
    check(context)
}
pub(crate) fn receive(
    stream: &mut TcpStream,
    deadline: Instant,
    context: Option<&NativeImportContext<'_>>,
) -> Result<Frame, GatewayError> {
    let mut size = [0u8; 4];
    read_exact(stream, &mut size, deadline, context)?;
    let length = usize::try_from(u32::from_be_bytes(size)).map_err(|_| unavailable())?;
    if length == 0 || length > CUSTODY_FRAME_MAX {
        return Err(unavailable());
    }
    let mut bytes = vec![0; length];
    read_exact(stream, &mut bytes, deadline, context)?;
    Frame::decode(&bytes)
}
pub(crate) fn send(
    stream: &mut TcpStream,
    frame: &Frame,
    deadline: Instant,
    context: Option<&NativeImportContext<'_>>,
) -> Result<(), GatewayError> {
    let bytes = frame.encode()?;
    let mut framed = Vec::with_capacity(4 + bytes.len());
    framed.extend_from_slice(
        &u32::try_from(bytes.len())
            .map_err(|_| unavailable())?
            .to_be_bytes(),
    );
    framed.extend_from_slice(&bytes);
    let mut remaining_bytes = framed.as_slice();
    while !remaining_bytes.is_empty() {
        check(context)?;
        stream
            .set_write_timeout(Some(remaining(deadline)?))
            .map_err(|_| unavailable())?;
        match stream.write(remaining_bytes) {
            Ok(0) => return Err(unavailable()),
            Ok(n) => remaining_bytes = &remaining_bytes[n..],
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err(unavailable()),
        }
    }
    check(context)
}
pub(crate) fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native import custody is unavailable; reconcile the original action",
        "native_import_custody_unknown",
    )
}
#[cfg(test)]
mod tests;
