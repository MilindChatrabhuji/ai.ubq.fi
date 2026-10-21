use crate::private_https::PrivateHttps;
use gateway_auth::{
    GatewayError,
    crypto::base64url,
    native::{
        NATIVE_KEY_HEADER, NATIVE_MAC_HEADER, NATIVE_NONCE_HEADER, NATIVE_RESPONSE_MAC_HEADER,
        NATIVE_TIME_HEADER, NATIVE_VERSION_HEADER,
    },
    native_auth::NativeTransportIdentity,
    native_live::{NATIVE_LIVE_AUTHORITY_MAX_BYTES, NATIVE_LIVE_AUTHORITY_PATH},
};
use gateway_authority::native_live::{
    NativeLiveAccess, NativeLiveAuthorityRequest as Request,
    NativeLiveAuthorityResponse as Response, NativeLiveFence, NativeLiveRetirement,
};
use std::{net::TcpStream, time::Instant};

pub struct LiveAuthorization {
    pub action_ref: String,
    pub connection_id: String,
    pub authorization_ref: String,
    pub fence: NativeLiveFence,
    pub access: Option<NativeLiveAccess>,
}
pub trait NativeLiveAuthority: Send + Sync {
    fn authorize(
        &self,
        action_ref: &str,
        connection_id: &str,
        deadline: Instant,
    ) -> Result<LiveAuthorization, GatewayError>;
    fn recheck(
        &self,
        authorization: &LiveAuthorization,
        deadline: Instant,
    ) -> Result<(NativeLiveFence, NativeLiveAccess), GatewayError>;
    fn retire(
        &self,
        authorization: &LiveAuthorization,
        status: u16,
        deadline: Instant,
    ) -> Result<NativeLiveRetirement, GatewayError>;
}

pub struct NativeLiveAuthorityHttp {
    transport: PrivateHttps,
    identity: NativeTransportIdentity,
}
impl NativeLiveAuthorityHttp {
    #[cfg(test)]
    pub(crate) fn with_test_roots(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
        roots: ureq::tls::RootCerts,
    ) -> Result<Self, GatewayError> {
        Ok(Self {
            transport: PrivateHttps::from_connected(
                target,
                NATIVE_LIVE_AUTHORITY_PATH,
                socket,
                roots,
            )?,
            identity,
        })
    }
    pub fn from_connected(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
    ) -> Result<Self, GatewayError> {
        Ok(Self {
            transport: PrivateHttps::from_connected(
                target,
                NATIVE_LIVE_AUTHORITY_PATH,
                socket,
                ureq::tls::RootCerts::WebPki,
            )?,
            identity,
        })
    }
    fn exchange(&self, request: Request, deadline: Instant) -> Result<Response, GatewayError> {
        let body = serde_json::to_vec(&request).map_err(|_| super::unavailable())?;
        Request::parse(&body)?;
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(|_| super::unavailable())?;
        let nonce = base64url(&bytes);
        let now = crate::http_server::now_ms()?;
        let mac = self
            .identity
            .sign_live_authority_request(now, &nonce, &body)?;
        let headers = vec![
            (NATIVE_VERSION_HEADER.into(), "1".into()),
            (NATIVE_KEY_HEADER.into(), self.identity.key_id().into()),
            (NATIVE_TIME_HEADER.into(), now.to_string()),
            (NATIVE_NONCE_HEADER.into(), nonce.clone()),
            (NATIVE_MAC_HEADER.into(), mac),
        ];
        let response =
            self.transport
                .send(&headers, &body, deadline, NATIVE_LIVE_AUTHORITY_MAX_BYTES)?;
        let signatures = response
            .headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(NATIVE_RESPONSE_MAC_HEADER))
            .collect::<Vec<_>>();
        if signatures.len() != 1 {
            return Err(super::unavailable());
        }
        self.identity.verify_live_authority_response(
            &nonce,
            &body,
            response.status,
            &response.body,
            &signatures[0].1,
        )?;
        if response.status != 200 {
            return Err(super::unavailable());
        }
        serde_json::from_slice(&response.body).map_err(|_| super::unavailable())
    }
}
impl NativeLiveAuthority for NativeLiveAuthorityHttp {
    fn authorize(
        &self,
        action_ref: &str,
        connection_id: &str,
        deadline: Instant,
    ) -> Result<LiveAuthorization, GatewayError> {
        let Response::Authorize {
            v: 1,
            authorization_ref,
            fence,
            access,
        } = self.exchange(
            Request::Authorize {
                v: 1,
                action_ref: action_ref.into(),
                connection_id: connection_id.into(),
            },
            deadline,
        )?
        else {
            return Err(super::unavailable());
        };
        Ok(LiveAuthorization {
            action_ref: action_ref.into(),
            connection_id: connection_id.into(),
            authorization_ref,
            fence,
            access: Some(access),
        })
    }
    fn recheck(
        &self,
        a: &LiveAuthorization,
        deadline: Instant,
    ) -> Result<(NativeLiveFence, NativeLiveAccess), GatewayError> {
        let Response::Recheck {
            v: 1,
            fence,
            access,
        } = self.exchange(
            Request::Recheck {
                v: 1,
                action_ref: a.action_ref.clone(),
                connection_id: a.connection_id.clone(),
                authorization_ref: a.authorization_ref.clone(),
            },
            deadline,
        )?
        else {
            return Err(super::unavailable());
        };
        if fence.call_id != a.fence.call_id
            || fence.account_id != a.fence.account_id
            || fence.principal != a.fence.principal
            || fence.mapping_revision != a.fence.mapping_revision
            || fence.owner_id != a.fence.owner_id
            || fence.owner_epoch != a.fence.owner_epoch
        {
            return Err(super::unavailable());
        }
        Ok((fence, access))
    }
    fn retire(
        &self,
        a: &LiveAuthorization,
        status: u16,
        deadline: Instant,
    ) -> Result<NativeLiveRetirement, GatewayError> {
        if status != 404 && status != 410 {
            return Err(super::unavailable());
        }
        let Response::Retire { v: 1, outcome } = self.exchange(
            Request::Retire {
                v: 1,
                action_ref: a.action_ref.clone(),
                connection_id: a.connection_id.clone(),
                authorization_ref: a.authorization_ref.clone(),
                upstream_status: status,
            },
            deadline,
        )?
        else {
            return Err(super::unavailable());
        };
        Ok(outcome)
    }
}
