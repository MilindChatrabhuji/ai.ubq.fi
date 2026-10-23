//! Authenticated fixed reverse authority over one preconnected TLS capability.
//! Parsed references are observations until the same-store receiver verifies
//! the original actor/action. This client cannot mint a local action or claim.
use crate::{owner_control::NativeControlContext, private_https::PrivateHttps};
use gateway_auth::{
    GatewayError,
    crypto::base64url,
    native::*,
    native_auth::NativeTransportIdentity,
    native_control::{
        NATIVE_AUTHORITY_MAX_BYTES, NATIVE_CONTROL_MAX_BYTES, NATIVE_RENEWAL_MAX_MS,
        NativeControlEnvelope, NativeControlRequest, unverified,
    },
};
use gateway_authority::native_control::{
    NATIVE_RENEWAL_FENCE_VERSION, NativeRenewalMode,
    wire::{NativeRenewalAuthorityRequest as Request, NativeRenewalAuthorityResponse as Response},
};
use std::{net::TcpStream, time::Instant};

pub struct NativeAuthorityHttp {
    identity: NativeTransportIdentity,
    transport: PrivateHttps,
}
impl NativeAuthorityHttp {
    pub fn from_connected(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
    ) -> Result<Self, GatewayError> {
        Self::with_roots(target, socket, identity, ureq::tls::RootCerts::WebPki)
    }
    /// Trusted fixture/operator preparation only; roots never come from a
    /// control request. The normal constructor retains WebPKI validation.
    pub fn with_roots(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
        roots: ureq::tls::RootCerts,
    ) -> Result<Self, GatewayError> {
        Ok(Self {
            identity,
            transport: PrivateHttps::from_connected(
                target,
                NATIVE_RENEWAL_AUTHORITY_PATH,
                socket,
                roots,
            )?,
        })
    }
    pub fn exchange(
        &self,
        request: &Request,
        context: &NativeControlContext<'_>,
    ) -> Result<Response, GatewayError> {
        context.check()?;
        request.validate()?;
        let body = serde_json::to_vec(request).map_err(|_| unverified())?;
        if body.len() > NATIVE_AUTHORITY_MAX_BYTES {
            return Err(unverified());
        }
        let mut nonce_bytes = [0u8; 32];
        getrandom::fill(&mut nonce_bytes).map_err(|_| unverified())?;
        let nonce = base64url(&nonce_bytes);
        let now = context.now_ms()?;
        let signature = self
            .identity
            .sign(NATIVE_RENEWAL_AUTHORITY_PATH, now, &nonce, &body)?;
        let headers = vec![
            (NATIVE_VERSION_HEADER.into(), "1".into()),
            (NATIVE_KEY_HEADER.into(), self.identity.key_id().into()),
            (NATIVE_TIME_HEADER.into(), now.to_string()),
            (NATIVE_NONCE_HEADER.into(), nonce.clone()),
            (NATIVE_MAC_HEADER.into(), signature),
        ];
        let response = self.transport.send(
            &headers,
            &body,
            context.deadline(),
            NATIVE_CONTROL_MAX_BYTES,
        )?;
        let signatures = response
            .headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case(NATIVE_RESPONSE_MAC_HEADER))
            .collect::<Vec<_>>();
        if signatures.len() != 1 {
            return Err(unverified());
        }
        self.identity
            .verify_authority_response(
                &nonce,
                &body,
                response.status,
                &response.body,
                &signatures[0].1,
            )
            .map_err(|_| unverified())?;
        context.check()?;
        if response.status != 200 {
            return Err(unverified());
        }
        let decoded: Response = serde_json::from_slice(&response.body).map_err(|_| unverified())?;
        self.validate(request, &decoded, now)?;
        Ok(decoded)
    }
    fn validate(
        &self,
        request: &Request,
        response: &Response,
        now: i64,
    ) -> Result<(), GatewayError> {
        let valid = match (request, response) {
            (
                Request::Claim { .. },
                Response::Claim {
                    v,
                    action_ref,
                    operation_id,
                    claim_ref,
                    start_permit,
                    mode,
                    deadline_ms,
                    fence,
                    publication_revision,
                },
            ) => {
                let original = NativeControlEnvelope::parse(&request.original_control_body()?)?;
                let NativeControlRequest::CodexRenewAccess {
                    action_ref: expected,
                } = original.request;
                *v == 1
                    && fence.v == NATIVE_RENEWAL_FENCE_VERSION
                    && action_ref == &expected
                    && operation_id == &original.operation_id
                    && identifier(claim_ref)
                    && fence.owner_id == self.identity.owner_id()
                    && fence.owner_epoch == self.identity.owner_epoch()
                    && publication_revision.as_deref().is_none_or(identifier)
                    && (publication_revision.is_none() || *mode == NativeRenewalMode::ReconcileOnly)
                    && match mode {
                        NativeRenewalMode::RenewOnce => {
                            start_permit.as_deref().is_some_and(identifier)
                                && *deadline_ms > now
                                && *deadline_ms <= now.saturating_add(NATIVE_RENEWAL_MAX_MS)
                        }
                        NativeRenewalMode::ReconcileOnly => start_permit.is_none(),
                    }
            }
            (Request::Recheck { .. }, Response::Recheck { v, fence }) => {
                *v == 1
                    && fence.v == NATIVE_RENEWAL_FENCE_VERSION
                    && fence.owner_id == self.identity.owner_id()
                    && fence.owner_epoch == self.identity.owner_epoch()
            }
            (Request::Start { .. }, Response::Start { v, .. })
            | (Request::Unknown { .. }, Response::Unknown { v }) => *v == 1,
            (
                Request::Published {
                    publication_revision: expected,
                    ..
                },
                Response::Published {
                    v,
                    publication_revision,
                },
            ) => *v == 1 && publication_revision == expected,
            _ => false,
        };
        if !valid {
            return Err(unverified());
        }
        Ok(())
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

/// The preopened transport never extends its original effect lease.
pub fn authority_deadline(
    context: &NativeControlContext<'_>,
    deadline_ms: i64,
) -> Result<Instant, GatewayError> {
    let remaining = deadline_ms
        .checked_sub(context.now_ms()?)
        .filter(|value| *value > 0 && *value <= NATIVE_RENEWAL_MAX_MS)
        .ok_or_else(unverified)?;
    Ok(context
        .deadline()
        .min(Instant::now() + std::time::Duration::from_millis(remaining as u64)))
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
