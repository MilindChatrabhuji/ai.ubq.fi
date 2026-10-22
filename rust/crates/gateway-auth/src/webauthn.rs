//! Source-compatible ceremony policy. Maintained CBOR/curve libraries parse public data;
//! the platform supplies only real key import and signature verification primitives.
use std::{future::Future, io::Cursor};

use ciborium::value::Value as Cbor;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    GatewayError,
    crypto::{base64url, decode_base64url},
    invalid,
    passkeys::{
        AssertionVerification, RegistrationVerification, VerifiedRegistration, client_data,
    },
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureAlgorithm {
    Es256,
    Es384,
    Es512,
    Ed25519,
    RsaPkcs1Sha256,
    RsaPkcs1Sha384,
    RsaPkcs1Sha512,
    RsaPkcs1Sha1,
    RsaPssSha256,
    RsaPssSha384,
    RsaPssSha512,
}
impl SignatureAlgorithm {
    pub fn import_algorithm(self) -> Value {
        match self {
            Self::Es256 => json!({"name":"ECDSA","namedCurve":"P-256"}),
            Self::Es384 => json!({"name":"ECDSA","namedCurve":"P-384"}),
            Self::Es512 => json!({"name":"ECDSA","namedCurve":"P-521"}),
            Self::Ed25519 => json!({"name":"Ed25519"}),
            Self::RsaPssSha256 | Self::RsaPssSha384 | Self::RsaPssSha512 => {
                json!({"name":"RSA-PSS","hash":{"name":self.hash_name()}})
            }
            _ => json!({"name":"RSASSA-PKCS1-v1_5","hash":{"name":self.hash_name()}}),
        }
    }
    pub fn verify_algorithm(self) -> Value {
        match self {
            Self::Es256 | Self::Es384 | Self::Es512 => {
                json!({"name":"ECDSA","hash":{"name":self.hash_name()}})
            }
            Self::Ed25519 => json!({"name":"Ed25519"}),
            Self::RsaPssSha256 | Self::RsaPssSha384 | Self::RsaPssSha512 => {
                json!({"name":"RSA-PSS","saltLength":self.pss_salt_length()})
            }
            _ => json!({"name":"RSASSA-PKCS1-v1_5"}),
        }
    }
    pub fn cose_id(self) -> i64 {
        match self {
            Self::Es256 => -7,
            Self::Es384 => -35,
            Self::Es512 => -36,
            Self::Ed25519 => -8,
            Self::RsaPkcs1Sha256 => -257,
            Self::RsaPkcs1Sha384 => -258,
            Self::RsaPkcs1Sha512 => -259,
            Self::RsaPkcs1Sha1 => -65535,
            Self::RsaPssSha256 => -37,
            Self::RsaPssSha384 => -38,
            Self::RsaPssSha512 => -39,
        }
    }
    pub fn parse(id: i64) -> Result<Self, GatewayError> {
        match id {
            -7 => Ok(Self::Es256),
            -35 => Ok(Self::Es384),
            -36 => Ok(Self::Es512),
            -8 => Ok(Self::Ed25519),
            -257 => Ok(Self::RsaPkcs1Sha256),
            -258 => Ok(Self::RsaPkcs1Sha384),
            -259 => Ok(Self::RsaPkcs1Sha512),
            -65535 => Ok(Self::RsaPkcs1Sha1),
            -37 => Ok(Self::RsaPssSha256),
            -38 => Ok(Self::RsaPssSha384),
            -39 => Ok(Self::RsaPssSha512),
            _ => Err(invalid("Unsupported passkey public key algorithm")),
        }
    }
    pub fn hash_name(self) -> Option<&'static str> {
        match self {
            Self::Es256 | Self::RsaPkcs1Sha256 | Self::RsaPssSha256 => Some("SHA-256"),
            Self::Es384 | Self::RsaPkcs1Sha384 | Self::RsaPssSha384 => Some("SHA-384"),
            Self::Es512 | Self::RsaPkcs1Sha512 | Self::RsaPssSha512 => Some("SHA-512"),
            Self::RsaPkcs1Sha1 => Some("SHA-1"),
            Self::Ed25519 => None,
        }
    }
    pub fn pss_salt_length(self) -> Option<u32> {
        match self {
            Self::RsaPssSha256 => Some(32),
            Self::RsaPssSha384 => Some(48),
            Self::RsaPssSha512 => Some(64),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CosePublicKey {
    pub algorithm: SignatureAlgorithm,
    pub jwk: Value,
}
impl CosePublicKey {
    /// Source EC verification selects the real curve independently of the COSE hash ID.
    pub fn import_algorithm(&self) -> Value {
        if self.jwk["kty"] == "EC" {
            json!({"name":"ECDSA","namedCurve":self.jwk["crv"]})
        } else {
            self.algorithm.import_algorithm()
        }
    }
    pub fn verify_algorithm(&self) -> Value {
        if self.jwk["kty"] == "EC" {
            json!({"name":"ECDSA","hash":{"name":self.algorithm.hash_name()}})
        } else {
            self.algorithm.verify_algorithm()
        }
    }
}
#[derive(Clone, Debug)]
pub struct SignatureInput {
    pub key: CosePublicKey,
    pub signature: Vec<u8>,
    pub data: Vec<u8>,
}

pub trait WebAuthnCrypto {
    /// Raw DER from the signed certificate's untrusted first CRL URL. Source semantics
    /// ignore unavailable/malformed CRLs; only Rust parsing decides revocation.
    fn fetch_certificate_revocation_list(
        &self,
        _url: &str,
    ) -> impl Future<Output = Result<Vec<u8>, GatewayError>> {
        async {
            Err(GatewayError::unavailable(
                "CRL transport unavailable",
                "passkey_crl_unavailable",
            ))
        }
    }
    /// Real cryptographic key import validates curve points/RSA parameters; no Boolean-policy callback.
    fn validate_key(&self, key: &CosePublicKey) -> impl Future<Output = Result<(), GatewayError>>;
    /// ECDSA signatures are already fixed-width IEEE P1363, as required by WebCrypto.
    fn verify_signature(
        &self,
        input: SignatureInput,
    ) -> impl Future<Output = Result<bool, GatewayError>>;
}

fn field(value: &Cbor, key: i128) -> Result<&Cbor, GatewayError> {
    let Cbor::Map(entries) = value else {
        return Err(invalid("Invalid passkey public key"));
    };
    let mut matches = entries
        .iter()
        .filter(|(k, _)| matches!(k,Cbor::Integer(n)if i128::from(*n)==key));
    let first = matches
        .next()
        .map(|(_, v)| v)
        .ok_or_else(|| invalid("Invalid passkey public key"))?;
    if matches.next().is_some() {
        return Err(invalid("Duplicate passkey public key parameter"));
    }
    Ok(first)
}
fn integer(value: &Cbor) -> Result<i64, GatewayError> {
    if let Cbor::Integer(value) = value {
        i64::try_from(i128::from(*value)).map_err(|_| invalid("Invalid passkey public key"))
    } else {
        Err(invalid("Invalid passkey public key"))
    }
}
fn bytes(value: &Cbor) -> Result<&[u8], GatewayError> {
    if let Cbor::Bytes(value) = value {
        Ok(value)
    } else {
        Err(invalid("Invalid passkey public key"))
    }
}
fn cbor(bytes: &[u8]) -> Result<Cbor, GatewayError> {
    let mut cursor = Cursor::new(bytes);
    let value = ciborium::from_reader(&mut cursor).map_err(|_| invalid("Invalid passkey CBOR"))?;
    if cursor.position() != bytes.len() as u64 {
        return Err(invalid("Unexpected trailing passkey CBOR"));
    }
    Ok(value)
}
fn text_field<'a>(value: &'a Cbor, key: &str) -> Result<&'a Cbor, GatewayError> {
    let Cbor::Map(entries) = value else {
        return Err(invalid("Invalid passkey attestation"));
    };
    let mut matching = entries
        .iter()
        .filter(|(k, _)| matches!(k,Cbor::Text(text)if text==key));
    let result = matching
        .next()
        .map(|(_, v)| v)
        .ok_or_else(|| invalid("Invalid passkey attestation"))?;
    if matching.next().is_some() {
        return Err(invalid("Duplicate passkey attestation field"));
    }
    Ok(result)
}

pub fn parse_cose_key(encoded: &[u8]) -> Result<CosePublicKey, GatewayError> {
    let value = cbor(encoded)?;
    let kind = integer(field(&value, 1)?)?;
    let algorithm = SignatureAlgorithm::parse(integer(field(&value, 3)?)?)?;
    let jwk = match kind {
        2 => {
            let curve = integer(field(&value, -1)?)?;
            let (curve_name, size) = match curve {
                1 => ("P-256", 32),
                2 => ("P-384", 48),
                3 => ("P-521", 66),
                _ => return Err(invalid("Unsupported passkey curve")),
            };
            if algorithm == SignatureAlgorithm::Ed25519 {
                return Err(invalid("Passkey algorithm and key type do not match"));
            }
            let x = bytes(field(&value, -2)?)?;
            let y = bytes(field(&value, -3)?)?;
            if x.len() != size || y.len() != size {
                return Err(invalid("Invalid passkey curve coordinate length"));
            }
            json!({"kty":"EC","crv":curve_name,"x":base64url(x),"y":base64url(y),"ext":true})
        }
        3 => {
            if !matches!(
                algorithm,
                SignatureAlgorithm::RsaPkcs1Sha256
                    | SignatureAlgorithm::RsaPkcs1Sha384
                    | SignatureAlgorithm::RsaPkcs1Sha512
                    | SignatureAlgorithm::RsaPkcs1Sha1
                    | SignatureAlgorithm::RsaPssSha256
                    | SignatureAlgorithm::RsaPssSha384
                    | SignatureAlgorithm::RsaPssSha512
            ) {
                return Err(invalid("Passkey algorithm and key type do not match"));
            }
            let modulus = bytes(field(&value, -1)?)?;
            let exponent = bytes(field(&value, -2)?)?;
            if modulus.is_empty() || exponent.is_empty() {
                return Err(invalid("Invalid passkey RSA parameters"));
            }
            json!({"kty":"RSA","n":base64url(modulus),"e":base64url(exponent),"ext":true})
        }
        1 => {
            if algorithm != SignatureAlgorithm::Ed25519 || integer(field(&value, -1)?)? != 6 {
                return Err(invalid("Unsupported passkey OKP key"));
            }
            let x = bytes(field(&value, -2)?)?;
            if x.len() != 32 {
                return Err(invalid("Invalid passkey Ed25519 key"));
            }
            json!({"kty":"OKP","crv":"Ed25519","x":base64url(x),"ext":true})
        }
        _ => return Err(invalid("Unsupported passkey public key type")),
    };
    Ok(CosePublicKey { algorithm, jwk })
}

fn encoded_field(response: &Value, name: &str) -> Result<Vec<u8>, GatewayError> {
    decode_base64url(
        response
            .get("response")
            .and_then(|v| v.get(name))
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Invalid passkey response"))?,
    )
    .map_err(|_| invalid("Invalid passkey response"))
}
fn verify_client(
    response: &Value,
    challenge: &str,
    origin: &str,
    kind: &str,
) -> Result<Vec<u8>, GatewayError> {
    if response.get("type").and_then(Value::as_str) != Some("public-key") {
        return Err(invalid("Invalid passkey credential type"));
    }
    let id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("Invalid passkey response"))?;
    if response.get("rawId").and_then(Value::as_str) != Some(id) {
        return Err(invalid("Passkey id and rawId do not match"));
    }
    let client = client_data(response)?;
    if client.get("type").and_then(Value::as_str) != Some(kind)
        || client.get("challenge").and_then(Value::as_str) != Some(challenge)
        || client.get("origin").and_then(Value::as_str) != Some(origin)
    {
        return Err(invalid("Invalid passkey client data"));
    }
    if let Some(binding) = client.get("tokenBinding")
        && match binding {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::String(value) => !value.is_empty(),
            Value::Number(value) => value.as_f64() != Some(0.0),
            _ => true,
        }
        && !binding
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| matches!(s, "present" | "supported" | "not-supported"))
    {
        return Err(invalid("Invalid passkey token binding"));
    }
    encoded_field(response, "clientDataJSON")
}
fn authenticator_header(
    data: &[u8],
    rp_id: &str,
    require_uv: bool,
) -> Result<(u8, u32), GatewayError> {
    if data.len() < 37 || data[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return Err(invalid("Invalid passkey RP ID hash"));
    }
    let flags = data[32];
    if flags & 1 == 0 || (require_uv && flags & 4 == 0) {
        return Err(invalid("Passkey user presence or verification is required"));
    }
    if flags & 16 != 0 && flags & 8 == 0 {
        return Err(invalid("Invalid passkey backup flags"));
    }
    let counter = u32::from_be_bytes(
        data[33..37]
            .try_into()
            .map_err(|_| invalid("Invalid passkey counter"))?,
    );
    Ok((flags, counter))
}
fn consume_extensions(data: &[u8], offset: usize, flags: u8) -> Result<(), GatewayError> {
    if flags & 128 != 0 {
        if offset >= data.len() {
            return Err(invalid("Missing passkey extensions"));
        }
        let value = cbor(&data[offset..])?;
        if !matches!(value, Cbor::Map(_)) {
            return Err(invalid("Invalid passkey extensions"));
        }
    } else if offset != data.len() {
        return Err(invalid("Unexpected passkey authenticator bytes"));
    }
    Ok(())
}

pub async fn verify_assertion<C: WebAuthnCrypto>(
    crypto: &C,
    input: AssertionVerification,
) -> Result<u32, GatewayError> {
    let client = verify_client(
        &input.response,
        &input.challenge,
        &input.origin,
        "webauthn.get",
    )?;
    if input.response.get("id").and_then(Value::as_str) != Some(&input.credential.credential_id) {
        return Err(invalid("Passkey credential ID does not match"));
    }
    let data = encoded_field(&input.response, "authenticatorData")?;
    let (flags, counter) =
        authenticator_header(&data, &input.rp_id, input.require_user_verification)?;
    if flags & 64 != 0 {
        return Err(invalid("Unexpected attested credential data in assertion"));
    }
    consume_extensions(&data, 37, flags)?;
    if (counter > 0 || input.credential.sign_count > 0) && counter <= input.credential.sign_count {
        return Err(invalid("Invalid passkey assertion counter"));
    }
    let key = parse_cose_key(&decode_base64url(&input.credential.public_key)?)?;
    let signature = encoded_field(&input.response, "signature")?;
    let signature = match (key.jwk["kty"].as_str(), key.jwk["crv"].as_str()) {
        (Some("EC"), Some("P-256")) => p256::ecdsa::Signature::from_der(&signature)
            .map_err(|_| invalid("Invalid passkey ECDSA signature"))?
            .to_bytes()
            .to_vec(),
        (Some("EC"), Some("P-384")) => p384::ecdsa::Signature::from_der(&signature)
            .map_err(|_| invalid("Invalid passkey ECDSA signature"))?
            .to_bytes()
            .to_vec(),
        (Some("EC"), Some("P-521")) => p521::ecdsa::Signature::from_der(&signature)
            .map_err(|_| invalid("Invalid passkey ECDSA signature"))?
            .to_bytes()
            .to_vec(),
        _ => signature,
    };
    let mut verification = data;
    verification.extend_from_slice(&Sha256::digest(client));
    if !crypto
        .verify_signature(SignatureInput {
            key,
            signature,
            data: verification,
        })
        .await?
    {
        return Err(invalid("Invalid passkey assertion"));
    }
    Ok(counter)
}

pub async fn verify_registration<C: WebAuthnCrypto>(
    crypto: &C,
    input: RegistrationVerification,
    now_ms: i64,
) -> Result<VerifiedRegistration, GatewayError> {
    let client = verify_client(
        &input.response,
        &input.challenge,
        &input.origin,
        "webauthn.create",
    )?;
    let encoded = encoded_field(&input.response, "attestationObject")?;
    let attestation = cbor(&encoded)?;
    let _format = match text_field(&attestation, "fmt")? {
        Cbor::Text(value) => value.as_str(),
        _ => return Err(invalid("Invalid passkey attestation format")),
    };
    let _statement = text_field(&attestation, "attStmt")?;
    let data = bytes(text_field(&attestation, "authData")?)?;
    let (flags, counter) =
        authenticator_header(data, &input.rp_id, input.require_user_verification)?;
    if flags & 64 == 0 || data.len() < 55 {
        return Err(invalid("Missing attested credential data"));
    }
    let length = u16::from_be_bytes([data[53], data[54]]) as usize;
    let key_start = 55usize
        .checked_add(length)
        .ok_or_else(|| invalid("Invalid passkey credential length"))?;
    if length == 0 || key_start >= data.len() {
        return Err(invalid("Invalid passkey credential length"));
    }
    let id = &data[55..key_start];
    // The source stores the credential ID from authenticated authData. The
    // browser response id/rawId consistency was already checked by verify_client.
    let mut reader = Cursor::new(&data[key_start..]);
    let _: Cbor = ciborium::from_reader(&mut reader)
        .map_err(|_| invalid("Invalid passkey public key CBOR"))?;
    let key_end = key_start + reader.position() as usize;
    let public_key = data[key_start..key_end].to_vec();
    let parsed = parse_cose_key(&public_key)?;
    // Preserve the actual SimpleWebAuthn verification allowlist, wider than advertised creation options.
    if parsed.algorithm == SignatureAlgorithm::Es384 {
        return Err(invalid("Unsupported registration algorithm"));
    }
    consume_extensions(data, key_end, flags)?;
    crypto.validate_key(&parsed).await?;
    if !(0..=9_007_199_254_740_991).contains(&now_ms) {
        return Err(GatewayError::unavailable(
            "Host clock is invalid",
            "auth_clock_unavailable",
        ));
    }
    let now = std::time::UNIX_EPOCH
        .checked_add(std::time::Duration::from_millis(now_ms as u64))
        .ok_or_else(|| {
            GatewayError::unavailable("Host clock overflow", "auth_clock_unavailable")
        })?;
    // The maintained verifier owns real attestation crypto; this adapter owns the
    // source ceremony and stores exact original COSE bytes, without invented legacy metadata.
    let revocations = webauthn_rs_core::source_compat::verify_attestation_at_time(
        &encoded,
        &Sha256::digest(client).into(),
        now,
    )
    .map_err(|error| invalid(&format!("Invalid passkey attestation: {error}")))?;
    for check in revocations {
        if let Ok(der) = crypto.fetch_certificate_revocation_list(&check.url).await
            && check.is_revoked(&der)
        {
            return Err(invalid("Revoked passkey attestation certificate"));
        }
    }
    let transports = input
        .response
        .get("response")
        .and_then(|v| v.get("transports"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok(VerifiedRegistration {
        credential_id: base64url(id),
        public_key,
        sign_count: counter,
        transports,
    })
}
