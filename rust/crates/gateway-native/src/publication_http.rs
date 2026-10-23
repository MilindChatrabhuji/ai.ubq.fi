//! Constructor-bound publication HTTP only; no proxy environment, redirects,
//! alternate URL, refresh material or unauthenticated receipt acceptance.
use gateway_auth::{
    GatewayError,
    native::{NATIVE_MAX_BODY_BYTES, NATIVE_PUBLICATION_PATH},
};
use gateway_publication::transport::{PublicationCarrier, PublicationRequest, PublicationResponse};
use std::time::Duration;

pub struct HttpsPublicationCarrier {
    target: String,
    agent: ureq::Agent,
}
impl HttpsPublicationCarrier {
    pub fn configured(target: &str) -> Result<Self, GatewayError> {
        let url = url::Url::parse(target).map_err(|_| unavailable())?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != NATIVE_PUBLICATION_PATH
        {
            return Err(unavailable());
        }
        Ok(Self {
            target: url.into(),
            agent: configured_agent(ureq::tls::RootCerts::WebPki),
        })
    }
}
fn configured_agent(roots: ureq::tls::RootCerts) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .https_only(true)
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(15)))
        .tls_config(ureq::tls::TlsConfig::builder().root_certs(roots).build())
        .build();
    ureq::Agent::new_with_config(config)
}
impl PublicationCarrier for HttpsPublicationCarrier {
    async fn send(&self, request: PublicationRequest) -> Result<PublicationResponse, GatewayError> {
        if request.method != "POST"
            || request.path != NATIVE_PUBLICATION_PATH
            || request.raw_body.len() > NATIVE_MAX_BODY_BYTES
        {
            return Err(unavailable());
        }
        let mut outgoing = self
            .agent
            .post(&self.target)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json");
        for (name, value) in request.headers.pairs() {
            outgoing = outgoing.header(name.as_str(), value.as_str());
        }
        let mut response = outgoing
            .send(request.raw_body.as_slice())
            .map_err(|_| unknown())?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|value| (name.as_str().into(), value.into()))
                    .map_err(|_| unknown())
            })
            .collect::<Result<Vec<_>, GatewayError>>()?;
        let raw_body = response
            .body_mut()
            .with_config()
            .limit(65_536)
            .read_to_vec()
            .map_err(|_| unknown())?;
        Ok(PublicationResponse {
            status,
            headers,
            raw_body,
        })
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Fixed native publication HTTPS target is unavailable",
        "native_publication_transport_unavailable",
    )
}
fn unknown() -> GatewayError {
    GatewayError::unavailable(
        "Native publication HTTP outcome is unknown; reconcile with a fresh authenticated nonce",
        "native_publication_outcome_unknown",
    )
}

#[cfg(test)]
mod tests;
