//! Source replay-envelope.ts: HKDF/HMAC domains, gzip and AES256-GCM framing.
//! The constructor receives the existing configured key; this module never reads environment or credentials.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use gateway_core::GatewayError;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::io::{Read, Write};
use zeroize::Zeroizing;

pub const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_METADATA_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PLAINTEXT_BYTES: usize = 4 + MAX_REQUEST_BYTES + MAX_METADATA_BYTES;
pub const MAX_CIPHERTEXT_BYTES: usize = MAX_PLAINTEXT_BYTES + 1024 * 1024 + 16;
pub const CHUNK_BYTES: usize = 48 * 1024;
const SALT: &[u8] = b"uos-sentinel-replay-v1";
#[derive(Clone)]
pub struct ReplayKey(Zeroizing<[u8; 32]>);
/// One request's immutable bytes. It is never stored in isolate coordination state.
pub struct ReplayBody(Zeroizing<Vec<u8>>);
impl ReplayBody {
    pub fn from_vec(bytes: Vec<u8>) -> Self {
        Self(Zeroizing::new(bytes))
    }
    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_slice()
    }
}
pub struct FingerprintInput<'a> {
    pub method: &'a str,
    pub endpoint: &'a str,
    pub headers: &'a str,
    pub body: &'a [u8],
    pub failure_signature: &'a str,
    pub canonical_upstream: &'a str,
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Sentinel replay cryptographic envelope is invalid.",
        "sentinel_replay_crypto_invalid",
    )
}
impl ReplayKey {
    /// Matches source's URL-safe43-character key, including its permitted trailing bits/padding.
    pub fn decode(raw: &str) -> Result<Self, GatewayError> {
        let bytes = raw.as_bytes();
        if !(bytes.len() == 43 || (bytes.len() == 44 && bytes[43] == b'='))
            || !bytes[..43]
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'_' | b'-'))
        {
            return Err(invalid());
        }
        let engine = GeneralPurpose::new(
            &alphabet::URL_SAFE,
            GeneralPurposeConfig::new()
                .with_decode_padding_mode(DecodePaddingMode::Indifferent)
                .with_decode_allow_trailing_bits(true),
        );
        let decoded = Zeroizing::new(engine.decode(raw).map_err(|_| invalid())?);
        let key: [u8; 32] = decoded.as_slice().try_into().map_err(|_| invalid())?;
        Ok(Self(Zeroizing::new(key)))
    }
    fn derive(&self, purpose: &[u8]) -> Result<Zeroizing<[u8; 32]>, GatewayError> {
        let mut key = Zeroizing::new([0; 32]);
        Hkdf::<Sha256>::new(Some(SALT), &*self.0)
            .expand(purpose, &mut *key)
            .map_err(|_| invalid())?;
        Ok(key)
    }
    fn framed_hmac(&self, purpose: &[u8], parts: &[&[u8]]) -> Result<String, GatewayError> {
        let key = self.derive(purpose)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&*key).map_err(|_| invalid())?;
        for part in parts {
            mac.update(&(part.len() as u64).to_be_bytes());
            mac.update(part)
        }
        let bytes = mac.finalize().into_bytes();
        let mut out = String::with_capacity(64);
        use std::fmt::Write;
        for byte in bytes {
            write!(out, "{byte:02x}").expect("String formatting cannot fail");
        }
        Ok(out)
    }
    pub fn fingerprint(&self, input: &FingerprintInput<'_>) -> Result<String, GatewayError> {
        self.framed_hmac(
            b"fingerprint",
            &[
                b"uos-sentinel-replay-v2:fingerprint",
                input.method.as_bytes(),
                input.endpoint.as_bytes(),
                input.headers.as_bytes(),
                input.body,
                input.failure_signature.as_bytes(),
                input.canonical_upstream.as_bytes(),
            ],
        )
    }
    pub fn case_group(&self, input: &FingerprintInput<'_>) -> Result<String, GatewayError> {
        self.framed_hmac(
            b"case-group",
            &[
                b"uos-sentinel-replay-v1:case-group",
                input.method.as_bytes(),
                input.endpoint.as_bytes(),
                input.headers.as_bytes(),
                input.body,
            ],
        )
    }
    fn aad(fingerprint: &str) -> Result<Vec<u8>, GatewayError> {
        if fingerprint.len() != 64
            || !fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        let mut bytes = b"uos-sentinel-replay-v1\0".to_vec();
        bytes.extend_from_slice(fingerprint.as_bytes());
        Ok(bytes)
    }
    pub fn encrypt(
        &self,
        iv: &[u8; 12],
        fingerprint: &str,
        encoded: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, GatewayError> {
        if encoded.len() > MAX_PLAINTEXT_BYTES {
            return Err(invalid());
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(encoded).map_err(|_| invalid())?;
        let compressed = Zeroizing::new(encoder.finish().map_err(|_| invalid())?);
        if compressed.len() + 16 > MAX_CIPHERTEXT_BYTES {
            return Err(invalid());
        }
        let key = self.derive(b"encryption")?;
        let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| invalid())?;
        let aad = Self::aad(fingerprint)?;
        cipher
            .encrypt(
                Nonce::from_slice(iv),
                Payload {
                    msg: &compressed,
                    aad: &aad,
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| invalid())
    }
    pub fn decrypt(
        &self,
        iv: &[u8; 12],
        fingerprint: &str,
        encrypted: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, GatewayError> {
        if encrypted.len() > MAX_CIPHERTEXT_BYTES {
            return Err(invalid());
        }
        let key = self.derive(b"encryption")?;
        let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| invalid())?;
        let aad = Self::aad(fingerprint)?;
        let compressed = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(iv),
                    Payload {
                        msg: encrypted,
                        aad: &aad,
                    },
                )
                .map_err(|_| invalid())?,
        );
        let mut decoder = flate2::read::MultiGzDecoder::new(compressed.as_slice())
            .take(MAX_PLAINTEXT_BYTES as u64 + 1);
        let mut out = Zeroizing::new(Vec::new());
        decoder.read_to_end(&mut out).map_err(|_| invalid())?;
        if out.len() > MAX_PLAINTEXT_BYTES {
            return Err(invalid());
        }
        Ok(out)
    }
}
