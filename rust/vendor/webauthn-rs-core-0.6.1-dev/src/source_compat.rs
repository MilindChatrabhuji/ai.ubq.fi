//! Stateless SimpleWebAuthn 13.2.2 attestation policy. Ceremony, current-role UV,
//! original COSE bytes and persistence remain owned by the gateway adapter.
//! Uses the maintained attestation/DER parsers and RustCrypto primitives; no
//! caller-supplied verification decisions or synthetic credential history.
use crate::{attestation::*, crypto::compute_sha256, error::WebauthnError, internals::*, proto::*};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use crypto_glue::{
    traits::{DecodeDer, EncodeDer},
    x509::{self, oiddb::rfc4519, Certificate, CrlDistributionPoints, GeneralName},
};
use serde_cbor_2::Value;
use std::time::SystemTime;

/// An untrusted CRL URL from a source-accepted certificate path.
/// Source early-stop behavior does not guarantee a configured trust anchor.
#[derive(Clone, Debug)]
pub struct RevocationCheck {
    /// First CRL distribution-point URI, exactly as in the signed certificate.
    pub url: String,
    serial: Vec<u8>,
}
impl RevocationCheck {
    /// Mirrors source best effort parsing: a malformed CRL is not a revocation;
    /// any successfully parsed entry matching this certificate is a revocation.
    pub fn is_revoked(&self, der: &[u8]) -> bool {
        x509_parser::parse_x509_crl(der)
            .ok()
            .is_some_and(|(_, crl)| {
                crl.iter_revoked_certificates().any(|entry| {
                    entry
                        .raw_serial()
                        .iter()
                        .skip_while(|b| **b == 0)
                        .eq(self.serial.iter().skip_while(|b| **b == 0))
                })
            })
    }
}
fn failure() -> WebauthnError {
    WebauthnError::AttestationStatementX5CInvalid
}
fn roots(pems: &[&str]) -> Result<Vec<Certificate>, WebauthnError> {
    pems.iter()
        .map(|pem| {
            let body: String = pem
                .lines()
                .filter(|line| !line.starts_with("-----"))
                .collect();
            let der = STANDARD.decode(body).map_err(|_| failure())?;
            Certificate::from_der(&der).map_err(|_| failure())
        })
        .collect()
}
fn certificates(value: &Value) -> Result<Vec<Certificate>, WebauthnError> {
    let map = cbor_try_map!(value)?;
    let value = map
        .get(&Value::Text("x5c".into()))
        .ok_or(WebauthnError::AttestationStatementX5CMissing)?;
    cbor_try_array!(value)?
        .iter()
        .map(|value| Certificate::from_der(cbor_try_bytes!(value)?).map_err(|_| failure()))
        .collect()
}
pub(crate) fn key_algorithm(cert: &Certificate) -> Result<COSEAlgorithm, WebauthnError> {
    let spki = &cert.tbs_certificate.subject_public_key_info;
    let oid = spki.algorithm.oid.to_string();
    match oid.as_str() {
        "1.2.840.113549.1.1.1" | "1.2.840.113549.1.1.11" => Ok(COSEAlgorithm::RS256),
        "1.3.101.112" => Ok(COSEAlgorithm::EDDSA),
        "1.2.840.10045.2.1" => {
            let curve = spki
                .algorithm
                .parameters
                .as_ref()
                .ok_or_else(failure)?
                .decode_as::<x509::ObjectIdentifier>()
                .map_err(|_| failure())?;
            match curve.to_string().as_str() {
                "1.2.840.10045.3.1.7" => Ok(COSEAlgorithm::ES256),
                "1.3.132.0.34" => Ok(COSEAlgorithm::ES384),
                "1.3.132.0.35" => Ok(COSEAlgorithm::ES521),
                _ => Err(failure()),
            }
        }
        _ => Err(failure()),
    }
}
// Source statement-certificate conversion supports these key shapes only.
// Chain verification and Apple credential-key equality retain key_algorithm.
pub(crate) fn statement_key_algorithm(cert: &Certificate) -> Result<COSEAlgorithm, WebauthnError> {
    let algorithm = key_algorithm(cert)?;
    match (cert.tbs_certificate.subject_public_key_info.algorithm.oid.to_string().as_str(), algorithm) {
        ("1.2.840.10045.2.1", COSEAlgorithm::ES256 | COSEAlgorithm::ES384)
        | ("1.2.840.113549.1.1.1", COSEAlgorithm::RS256) => Ok(algorithm),
        _ => Err(WebauthnError::COSEKeyInvalidType),
    }
}
fn cert_time(cert: &Certificate, now: SystemTime) -> Result<(), WebauthnError> {
    let now = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| failure())?;
    let valid = &cert.tbs_certificate.validity;
    if valid.not_before.to_unix_duration() > now || valid.not_after.to_unix_duration() < now {
        return Err(failure());
    }
    Ok(())
}
pub(crate) fn certificate_signature_algorithm(
    cert: &Certificate,
) -> Result<COSEAlgorithm, WebauthnError> {
    algorithm_oid(&cert.tbs_certificate.signature.oid.to_string())
}
fn signature_algorithm(cert: &Certificate) -> Result<COSEAlgorithm, WebauthnError> {
    algorithm_oid(&cert.signature_algorithm.oid.to_string())
}
fn algorithm_oid(oid: &str) -> Result<COSEAlgorithm, WebauthnError> {
    match oid {
        "1.2.840.113549.1.1.5" => Ok(COSEAlgorithm::INSECURE_RS1),
        "1.2.840.113549.1.1.11" => Ok(COSEAlgorithm::RS256),
        "1.2.840.113549.1.1.12" => Ok(COSEAlgorithm::RS384),
        "1.2.840.113549.1.1.13" => Ok(COSEAlgorithm::RS512),
        "1.2.840.10045.4.3.2" => Ok(COSEAlgorithm::ES256),
        "1.2.840.10045.4.3.3" => Ok(COSEAlgorithm::ES384),
        "1.2.840.10045.4.3.4" => Ok(COSEAlgorithm::ES521),
        "1.3.101.112" => Ok(COSEAlgorithm::EDDSA),
        _ => Err(failure()),
    }
}
fn signed_by(cert: &Certificate, issuer: &Certificate) -> Result<(), WebauthnError> {
    let key = COSEKey::try_from((key_algorithm(issuer)?, issuer))?;
    let mut key = key;
    key.type_ = signature_algorithm(cert)?;
    let message = cert.tbs_certificate.to_der().map_err(|_| failure())?;
    let signature = cert.signature.as_bytes().ok_or_else(failure)?;
    if !key.verify_signature(signature, &message)? {
        return Err(failure());
    }
    Ok(())
}
fn revocation(cert: &Certificate) -> Result<Option<RevocationCheck>, WebauthnError> {
    let Some((_, points)) = cert
        .tbs_certificate
        .get::<CrlDistributionPoints>()
        .map_err(|_| failure())?
    else {
        return Ok(None);
    };
    let Some(point) = points.0.first() else {
        return Ok(None);
    };
    let Some(x509::DistributionPointName::FullName(names)) = &point.distribution_point else {
        return Ok(None);
    };
    let Some(GeneralName::UniformResourceIdentifier(uri)) = names.first() else {
        return Ok(None);
    };
    Ok(Some(RevocationCheck {
        url: uri.to_string(),
        serial: cert.tbs_certificate.serial_number.as_bytes().to_vec(),
    }))
}
fn trusted_chain(
    chain: &[Certificate],
    anchors: &[Certificate],
    now: SystemTime,
) -> Result<Vec<RevocationCheck>, WebauthnError> {
    if chain.is_empty() || chain.len() > 32 || anchors.is_empty() {
        return Err(failure());
    }
    for cert in chain {
        cert_time(cert, now)?;
    }
    let mut accepted = None;
    for anchor in anchors {
        if cert_time(anchor, now).is_err() {
            continue;
        }
        let mut path = chain.to_vec();
        if path.last() != Some(anchor) {
            path.push(anchor.clone());
        }
        let mut valid = true;
        for pair in path.windows(2) {
            if signed_by(&pair[0], &pair[1]).is_err() {
                valid = false;
                break;
            }
            if pair[1].tbs_certificate.subject == pair[1].tbs_certificate.issuer {
                if signed_by(&pair[1], &pair[1]).is_err() {
                    valid = false;
                }
                break;
            }
        }
        if valid {
            accepted = Some(anchor);
            break;
        }
    }
    let anchor = accepted.ok_or(WebauthnError::AttestationTrustFailure)?;
    let mut checks = Vec::new();
    for cert in chain.iter().chain(std::iter::once(anchor)) {
        if let Some(check) = revocation(cert)? {
            checks.push(check);
        }
    }
    Ok(checks)
}
fn safetynet(
    att: &AttestationObject<Registration>,
    hash: &[u8; 32],
    now: SystemTime,
) -> Result<Vec<RevocationCheck>, WebauthnError> {
    let map = cbor_try_map!(&att.att_stmt)?;
    let ver = map
        .get(&Value::Text("ver".into()))
        .ok_or(WebauthnError::AttestationStatementVerMissing)?;
    if cbor_try_string!(ver)?.is_empty() {
        return Err(WebauthnError::AttestationStatementVerInvalid);
    }
    let jwt = cbor_try_bytes!(map
        .get(&Value::Text("response".into()))
        .ok_or(WebauthnError::AttestationStatementResponseMissing)?)?;
    let jwt = std::str::from_utf8(jwt).map_err(|_| failure())?;
    let parts: Vec<_> = jwt.split('.').collect();
    if parts.len() != 3 {
        return Err(failure());
    }
    let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| failure());
    let header: serde_json::Value =
        serde_json::from_slice(&decode(parts[0])?).map_err(|_| failure())?;
    let payload: serde_json::Value =
        serde_json::from_slice(&decode(parts[1])?).map_err(|_| failure())?;
    let stamp = payload["timestampMs"].as_u64().ok_or_else(failure)?;
    let now_ms = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| failure())?
        .as_millis();
    if u128::from(stamp) > now_ms
        || u128::from(stamp) + 60_000 < now_ms
        || payload["ctsProfileMatch"] != true
    {
        return Err(failure());
    }
    let mut nonce = att.auth_data_bytes.clone();
    nonce.extend(hash);
    if payload["nonce"].as_str() != Some(STANDARD.encode(compute_sha256(&nonce)).as_str()) {
        return Err(failure());
    }
    let chain: Result<Vec<_>, _> = header["x5c"]
        .as_array()
        .ok_or_else(failure)?
        .iter()
        .map(|value| {
            let der = STANDARD
                .decode(value.as_str().ok_or_else(failure)?)
                .map_err(|_| failure())?;
            Certificate::from_der(&der).map_err(|_| failure())
        })
        .collect();
    let chain = chain?;
    let leaf = chain.first().ok_or_else(failure)?;
    let cn = leaf
        .tbs_certificate
        .subject
        .0
        .iter()
        .flat_map(|rdn| rdn.0.iter())
        .find(|entry| entry.oid == rfc4519::CN)
        .ok_or_else(failure)?;
    if cn.value.value() != b"attest.android.com" {
        return Err(failure());
    }
    let checks = trusted_chain(
        &chain,
        &roots(&[include_str!("../source-roots/GlobalSign_Root_CA.pem")])?,
        now,
    )?;
    // Source derives the signature algorithm from the certificate key, not the untrusted JWT alg header.
    let mut key = COSEKey::try_from((statement_key_algorithm(leaf)?, leaf))?;
    key.type_ = certificate_signature_algorithm(leaf)?;
    if !key.verify_signature(
        &decode(parts[2])?,
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
    )? {
        return Err(WebauthnError::AttestationStatementSigInvalid);
    }
    Ok(checks)
}

/// Verify the actual attestation statement after the caller has checked the
/// challenge, exact origin, RP hash, flags and source algorithm policy. The
/// current time must be the real validated host clock. Returned CRL checks are
/// raw-data reads only; the caller invokes `is_revoked` on fetched DER bytes.
pub fn verify_attestation_at_time(
    encoded: &[u8],
    hash: &[u8; 32],
    now: SystemTime,
) -> Result<Vec<RevocationCheck>, WebauthnError> {
    let att = AttestationObject::<Registration>::try_from(encoded)?;
    let acd = att
        .auth_data
        .acd
        .as_ref()
        .ok_or(WebauthnError::MissingAttestationCredentialData)?;
    COSEKey::try_from(&acd.credential_pk)?;
    match att.fmt.as_str() {
        "none" => {
            if !cbor_try_map!(&att.att_stmt)?.is_empty() {
                return Err(WebauthnError::AttestationStatementMapInvalid);
            }
            Ok(vec![])
        }
        "packed" => {
            let statement = cbor_try_map!(&att.att_stmt)?;
            if statement.contains_key(&Value::Text("x5c".into())) {
                verify_packed_attestation(acd, &att, hash)?;
                let chain = certificates(&att.att_stmt)?;
                cert_time(chain.first().ok_or_else(failure)?, now)?;
            } else {
                let alg = cbor_try_i128!(statement
                    .get(&Value::Text("alg".into()))
                    .ok_or(WebauthnError::AttestationStatementAlgMissing)?)?;
                let mut key = COSEKey::try_from(&acd.credential_pk)?;
                key.type_ = COSEAlgorithm::try_from(alg)
                    .map_err(|_| WebauthnError::COSEKeyInvalidAlgorithm)?;
                let signature = cbor_try_bytes!(statement
                    .get(&Value::Text("sig".into()))
                    .ok_or(WebauthnError::AttestationStatementSigMissing)?)?;
                let mut signed = att.auth_data_bytes.clone();
                signed.extend(hash);
                if !key.verify_signature(signature, &signed)? {
                    return Err(WebauthnError::AttestationStatementSigInvalid);
                }
            }
            Ok(vec![])
        }
        "fido-u2f" => {
            verify_fidou2f_attestation(acd, &att, hash)?;
            Ok(vec![])
        }
        "tpm" => {
            verify_source_tpm_attestation(acd, &att, hash)?;
            cert_time(
                certificates(&att.att_stmt)?.first().ok_or_else(failure)?,
                now,
            )?;
            Ok(vec![])
        }
        "apple" => {
            verify_apple_anonymous_attestation(acd, &att, hash)?;
            trusted_chain(
                &certificates(&att.att_stmt)?,
                &roots(&[include_str!("../source-roots/Apple_WebAuthn_Root_CA.pem")])?,
                now,
            )
        }
        "android-key" => {
            verify_source_android_key_attestation(acd, &att, hash)?;
            let chain = certificates(&att.att_stmt)?;
            let root_pems = [
                include_str!("../source-roots/Google_Hardware_Attestation_Root_1.pem"),
                include_str!("../source-roots/Google_Hardware_Attestation_Root_2.pem"),
                include_str!("../source-roots/Google_Hardware_Attestation_Root_3.pem"),
                include_str!("../source-roots/Google_Hardware_Attestation_Root_4.pem"),
            ];
            let root = chain.last().ok_or_else(failure)?;
            let encoded = STANDARD.encode(root.to_der().map_err(|_| failure())?);
            let lines = encoded
                .as_bytes()
                .chunks(64)
                .map(|line| std::str::from_utf8(line).map_err(|_| failure()))
                .collect::<Result<Vec<_>, _>>()?
                .join("\n");
            let root_pem =
                format!("-----BEGIN CERTIFICATE-----\n{lines}\n-----END CERTIFICATE-----\n");
            if !root_pems.contains(&root_pem.as_str()) {
                return Err(WebauthnError::AttestationTrustFailure);
            }
            trusted_chain(&chain, std::slice::from_ref(root), now)
        }
        "android-safetynet" => safetynet(&att, hash, now),
        _ => Err(WebauthnError::AttestationNotSupported),
    }
}

/// Parse and validate a complete COSE public key with the maintained key importer.
pub fn validate_public_key(encoded: &[u8]) -> Result<(), WebauthnError> {
    let key: Value = serde_cbor_2::from_slice(encoded).map_err(WebauthnError::ParseCBORFailure)?;
    COSEKey::try_from(&key).map(|_| ())
}
/// Verify a DER ECDSA or native RSA/Ed25519 signature with maintained primitives.
pub fn verify_public_key_signature(
    encoded: &[u8],
    signature: &[u8],
    data: &[u8],
) -> Result<bool, WebauthnError> {
    let key: Value = serde_cbor_2::from_slice(encoded).map_err(WebauthnError::ParseCBORFailure)?;
    COSEKey::try_from(&key)?.verify_signature(signature, data)
}

// Exact pinned source manufacturer catalog, including FIDO conformance devices.
pub(crate) fn valid_tpm_manufacturer(value: &str) -> bool {
    matches!(value,
        "id:414D4400"
        | "id:414E5400"
        | "id:41544D4C"
        | "id:4252434D"
        | "id:4353434F"
        | "id:464C5953"
        | "id:524F4343"
        | "id:474F4F47"
        | "id:48504900"
        | "id:48504500"
        | "id:48495349"
        | "id:49424d00"
        | "id:49424D00"
        | "id:49465800"
        | "id:494E5443"
        | "id:4C454E00"
        | "id:4D534654"
        | "id:4E534D20"
        | "id:4E545A00"
        | "id:4E534700"
        | "id:4E544300"
        | "id:51434F4D"
        | "id:534D534E"
        | "id:53454345"
        | "id:534E5300"
        | "id:534D5343"
        | "id:53544D20"
        | "id:54584E00"
        | "id:57454300"
        | "id:5345414C"
        | "id:FFFFF1D0"
    )
}
