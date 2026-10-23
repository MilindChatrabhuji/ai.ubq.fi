//! Trusted native bindings. No request-selected destination, default public
//! target, provider token, arbitrary path, generic control or caller-selected owner.
use std::{collections::BTreeSet, rc::Rc};

use gateway_auth::{
    AuthResponse, GatewayError,
    crypto::{base64url, decode_base64url},
    native::*,
    native_auth::{NativeCapability, NativeTransportIdentity},
    native_control::{
        NATIVE_CONTROL_MAX_BYTES, NATIVE_RENEWAL_MAX_MS, NativeControlEnvelope,
        NativeControlResponse, unverified,
    },
};
use serde::Deserialize;
use worker::{Context, Env, Fetcher, Response};

use crate::{
    host::{PlatformHost, response_bytes},
    native_transport::{NativeTransport, unavailable},
    transport::stream::{ObservationHandle, ObservedStream},
};

/// One exact deployment binding. No binding-name scan or request-derived destination.
pub const NATIVE_CARRIER_BINDING: &str = "UOS_NATIVE_CARRIER";
pub const NATIVE_CARRIER_CONFIG_MAX_BYTES: usize = 16_384;

#[derive(Clone, Default)]
pub struct NativeBindings {
    transport: Option<NativeTransport>,
    renewal_owners: Option<Rc<gateway_authority::native_control::RegisteredRenewalOwners>>,
}

impl NativeBindings {
    /// Read one exact deployment binding. Absence keeps the capability unavailable;
    /// malformed, partial or unsupported configuration fails closed. The binding is
    /// parsed before routing and cannot select a destination per request.
    pub fn from_worker_binding(env: &Env) -> Result<Option<Self>, GatewayError> {
        let raw = crate::host::setting(env, NATIVE_CARRIER_BINDING);
        let present = worker::js_sys::Reflect::has(
            env,
            &worker::wasm_bindgen::JsValue::from_str(NATIVE_CARRIER_BINDING),
        )
        .map_err(|_| invalid_configuration())?;
        if present && raw.is_none() {
            return Err(invalid_configuration());
        }
        Self::from_binding_value(raw.as_deref())
    }

    fn from_binding_value(raw: Option<&str>) -> Result<Option<Self>, GatewayError> {
        let Some(raw) = raw else {
            return Ok(None);
        };
        if raw.len() > NATIVE_CARRIER_CONFIG_MAX_BYTES {
            return Err(invalid_configuration());
        }
        let config: NativeCarrierConfig =
            serde_json::from_str(raw).map_err(|_| invalid_configuration())?;
        config.into_bindings().map(Some)
    }

    /// Trusted injection only. No client body/header or provider credential can
    /// acquire this capability.
    pub fn configured(carrier: Fetcher, identity: NativeTransportIdentity) -> Self {
        Self {
            transport: Some(NativeTransport::configured(carrier, identity)),
            renewal_owners: None,
        }
    }

    /// Trusted injection of one fixed HTTPS origin; never read from a request or
    /// discovered from the environment. This grants no renewal ownership.
    pub fn configured_https(
        origin: &str,
        identity: NativeTransportIdentity,
    ) -> Result<Self, GatewayError> {
        Ok(Self {
            transport: Some(NativeTransport::configured_https(origin, identity)?),
            renewal_owners: None,
        })
    }

    /// The fixed native owner registry is explicit trusted configuration. A
    /// supervisor carrier alone never supplies credential-renewal ownership.
    pub fn with_renewal_owners(
        mut self,
        owners: gateway_authority::native_control::RegisteredRenewalOwners,
    ) -> Self {
        self.renewal_owners = Some(Rc::new(owners));
        self
    }

    pub(crate) fn transport(&self) -> Result<&NativeTransport, GatewayError> {
        self.transport.as_ref().ok_or_else(unavailable)
    }

    pub(crate) fn renewal_owners(
        &self,
    ) -> Result<&gateway_authority::native_control::RegisteredRenewalOwners, GatewayError> {
        self.renewal_owners.as_deref().ok_or_else(unavailable)
    }

    /// Only shared current authority mints this action; the native carrier still
    /// resolves and rechecks its selector before opening any provider socket.
    pub async fn live_upgrade(
        &self,
        action: &gateway_authority::native_live::NativeLiveAction,
        platform: &PlatformHost,
    ) -> Result<crate::GatewayResponse, GatewayError> {
        self.transport()?
            .live_upgrade(action.action_ref(), platform)
            .await
    }

    pub(crate) async fn refresh_routing(
        &self,
        fence: &gateway_routing_runtime::types::CredentialFence,
        platform: &PlatformHost,
        original: &gateway_core::identity::RequestContext,
    ) -> Result<gateway_routing_runtime::types::RefreshOutcome, GatewayError> {
        use gateway_authority::{Authority, native_control::NativeRenewalAuthority};
        let gateway_routing_runtime::types::CredentialFence::Codex {
            admission,
            source_revision,
            native_generation,
            ..
        } = fence
        else {
            return Err(unverified());
        };
        let transport = self.transport()?;
        let authority = Authority::with_clock(
            platform.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        );
        let config = crate::host::auth_config(&platform.env);
        let actor = gateway_authority::native_control::actor::authenticate_client_actor(
            &authority,
            platform,
            &config,
            &platform.original,
            original,
        )
        .await?;
        let owner = self
            .renewal_owners()?
            .for_inference(&authority, admission)
            .await?;
        let receiver = NativeRenewalAuthority::configured(
            &authority,
            &transport.identity,
            owner,
            &config,
            platform,
        );
        let action = receiver.prepare_routing(&actor).await?;
        let current = action.fence();
        if current.account_id_hash != admission.binding.account_id_hash.0
            || current.credential_version != admission.binding.credential_version.0
            || current.source_revision != *source_revision
            || current.access_generation != *native_generation
        {
            return Err(unverified());
        }
        self.complete_renewal(&action, &receiver, platform).await?;
        Ok(gateway_routing_runtime::types::RefreshOutcome::Published)
    }

    pub(crate) async fn renew_live_create(
        &self,
        actor: &gateway_authority::native_control::actor::NativeRenewalActor,
        selected: &gateway_authority::routing::LiveAccountSelection,
        platform: &PlatformHost,
        config: &gateway_auth::AuthConfig,
    ) -> Result<(), GatewayError> {
        let transport = self.transport()?;
        let authority = gateway_authority::Authority::with_clock(
            platform.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        );
        let owner = self
            .renewal_owners()?
            .for_live_create(&authority, selected)
            .await?;
        let receiver = gateway_authority::native_control::NativeRenewalAuthority::configured(
            &authority,
            &transport.identity,
            owner,
            config,
            platform,
        );
        let action = receiver
            .prepare_live_create_renewal(actor, selected)
            .await?;
        self.complete_renewal(&action, &receiver, platform).await?;
        Ok(())
    }

    pub(crate) async fn renew_live_mapped(
        &self,
        actor: &gateway_authority::native_control::actor::NativeRenewalActor,
        call_id: &str,
        platform: &PlatformHost,
        config: &gateway_auth::AuthConfig,
    ) -> Result<(), GatewayError> {
        let transport = self.transport()?;
        let authority = gateway_authority::Authority::with_clock(
            platform.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        );
        let owner = self
            .renewal_owners()?
            .for_live_mapped(&authority, actor, config, call_id)
            .await?;
        let receiver = gateway_authority::native_control::NativeRenewalAuthority::configured(
            &authority,
            &transport.identity,
            owner,
            config,
            platform,
        );
        let action = receiver.prepare_live_mapped_renewal(actor, call_id).await?;
        self.complete_renewal(&action, &receiver, platform).await?;
        Ok(())
    }

    pub(crate) async fn renew_cache_experiment(
        &self,
        actor: &gateway_authority::native_control::actor::NativeRenewalActor,
        permit: &gateway_authority::cache_experiment::RefreshPermit,
        platform: &PlatformHost,
        config: &gateway_auth::AuthConfig,
    ) -> Result<gateway_core::identity::PoolVersionstamp, GatewayError> {
        let transport = self.transport()?;
        let authority = gateway_authority::Authority::with_clock(
            platform.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        );
        let owner = self
            .renewal_owners()?
            .for_cache_experiment(&authority, permit)
            .await?;
        let receiver = gateway_authority::native_control::NativeRenewalAuthority::configured(
            &authority,
            &transport.identity,
            owner,
            config,
            platform,
        );
        let action = receiver
            .prepare_cache_experiment_renewal(actor, permit)
            .await?;
        let verified = self.complete_renewal(&action, &receiver, platform).await?;
        Ok(gateway_core::identity::PoolVersionstamp(
            verified.source_revision,
        ))
    }

    async fn complete_renewal(
        &self,
        action: &gateway_authority::native_control::NativeRenewalAction,
        receiver: &gateway_authority::native_control::NativeRenewalAuthority<
            '_,
            crate::authority::RemoteAuthorityStore,
            crate::host::PlatformTokens,
            PlatformHost,
        >,
        platform: &PlatformHost,
    ) -> Result<gateway_authority::native_control::NativeRenewalFence, GatewayError> {
        use gateway_auth::native_control::{NativeControlDisposition, NativeControlRequest};
        let envelope = NativeControlEnvelope {
            v: NATIVE_WIRE_VERSION,
            operation_id: crate::transport::random::opaque_token()?,
            request: NativeControlRequest::CodexRenewAccess {
                action_ref: action.action_ref().to_owned(),
            },
        };
        let response = self.renew(&envelope, platform).await?;
        if !matches!(
            response.disposition,
            NativeControlDisposition::Published | NativeControlDisposition::AlreadyCurrent
        ) {
            return Err(GatewayError::unavailable(
                "The current native credential owner did not establish a renewed access publication.",
                "codex_auth_owner_unavailable",
            ));
        }
        let publication = response
            .publication_revision
            .as_deref()
            .ok_or_else(unverified)?;
        receiver
            .verify_action_publication(action, &envelope.operation_id, publication)
            .await
    }

    pub async fn rpc(
        &self,
        request: NativeReadRequest,
        platform: &PlatformHost,
    ) -> Result<AuthResponse, GatewayError> {
        let transport = self.transport.as_ref().ok_or_else(unavailable)?;
        let envelope = NativeRpcEnvelope {
            v: NATIVE_WIRE_VERSION,
            request,
        };
        envelope.validate()?;
        let body = serde_json::to_vec(&envelope).map_err(|_| unavailable())?;
        let mut exchange = transport
            .send(NATIVE_RPC_PATH, body, platform, 15_000)
            .await?;
        let result = async {
            if exchange.response.status_code() != 200 {
                return Err(unavailable());
            }
            let body = response_bytes(&mut exchange.response, NATIVE_MAX_BODY_BYTES).await?;
            let response: NativeRpcResponse =
                serde_json::from_slice(&body).map_err(|_| unavailable())?;
            response.validate_for(&envelope)?;
            let mut output = AuthResponse::json(response.status, response.body);
            if response.stream.is_some() {
                // The placeholder headers are merged onto the physical follow
                // response; JSON here would overwrite its actual SSE type.
                output.headers.insert(
                    "content-type".into(),
                    "text/event-stream; charset=utf-8".into(),
                );
            }
            output.stream = response.stream;
            Ok(output)
        }
        .await;
        exchange.cancellation.abort();
        result
    }

    pub async fn follow(
        &self,
        descriptor: AuthStream,
        platform: &PlatformHost,
        context: Rc<Context>,
    ) -> Result<Response, GatewayError> {
        let transport = self.transport.as_ref().ok_or_else(unavailable)?;
        let body = serde_json::to_vec(&descriptor).map_err(|_| unavailable())?;
        // Source Supervisor FOLLOW_MAX_DURATION_MS is ten minutes. Keep the
        // cancellation and absolute timer alive for the entire outgoing body.
        let mut exchange = transport
            .send(NATIVE_FOLLOW_PATH, body, platform, 600_000)
            .await?;
        let content_type = exchange
            .response
            .headers()
            .get("content-type")
            .map_err(|_| unavailable())?;
        if exchange.response.status_code() != 200
            || !content_type.as_deref().is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("text/event-stream"))
            })
        {
            exchange.cancellation.abort();
            return Err(unavailable());
        }
        let source = exchange.response.stream().map_err(|_| unavailable())?;
        // Child signals do not own the root's incoming abort listener. Retain
        // that guard after routing returns headers, until this body finalizes.
        let caller_cancellation = platform.cancellation.clone();
        let stream = ObservedStream::new(
            source,
            ObservationHandle::default(),
            context,
            exchange.cancellation,
            Some(exchange.deadline),
            Box::new(move |_| {
                Box::pin(async move {
                    drop(caller_cancellation);
                })
            }),
        );
        let mut response = stream.into_response().map_err(|_| unavailable())?;
        for (name, value) in [
            ("content-type", "text/event-stream; charset=utf-8"),
            ("cache-control", "no-store"),
            ("x-accel-buffering", "no"),
        ] {
            response
                .headers_mut()
                .set(name, value)
                .map_err(|_| unavailable())?;
        }
        Ok(response)
    }

    /// The action reference must already have been prepared by shared current
    /// authority. This transport authenticates a result; it grants no action.
    pub async fn renew(
        &self,
        envelope: &NativeControlEnvelope,
        platform: &PlatformHost,
    ) -> Result<NativeControlResponse, GatewayError> {
        envelope.validate()?;
        let authority = gateway_authority::Authority::with_clock(
            platform.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        );
        let gateway_auth::native_control::NativeControlRequest::CodexRenewAccess { action_ref } =
            &envelope.request;
        self.renewal_owners()?
            .for_action(&authority, action_ref)
            .await?;
        let transport = self.transport.as_ref().ok_or_else(unavailable)?;
        let body = serde_json::to_vec(envelope).map_err(|_| unavailable())?;
        let mut exchange = transport
            .send(
                NATIVE_CONTROL_PATH,
                body,
                platform,
                NATIVE_RENEWAL_MAX_MS as i32,
            )
            .await?;
        let result = async {
            let status = exchange.response.status_code();
            let signatures = exchange
                .response
                .headers()
                .entries()
                .filter(|(name, _)| name.eq_ignore_ascii_case(NATIVE_RESPONSE_MAC_HEADER))
                .collect::<Vec<_>>();
            let body = response_bytes(&mut exchange.response, NATIVE_CONTROL_MAX_BYTES)
                .await
                .map_err(|_| unverified())?;
            if signatures.len() != 1 {
                return Err(unverified());
            }
            transport
                .identity
                .verify_control_response(
                    &exchange.nonce,
                    &exchange.request,
                    status,
                    &body,
                    &signatures[0].1,
                )
                .map_err(|_| unverified())?;
            if status != 200 {
                return Err(unverified());
            }
            let response: NativeControlResponse =
                serde_json::from_slice(&body).map_err(|_| unverified())?;
            response.validate_for(envelope)?;
            Ok(response)
        }
        .await;
        exchange.cancellation.abort();
        result
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeCarrierConfig {
    origin: String,
    identity: NativeCarrierIdentity,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeCarrierIdentity {
    key_id: String,
    owner_id: String,
    owner_epoch: String,
    key_base64url: String,
    capabilities: Vec<NativeCarrierCapability>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum NativeCarrierCapability {
    SupervisorRead,
    ConfigurationPublish,
    AccessPublish,
    OwnerRenewal,
    CodexAuthImport,
    NativeProfileImport,
    LiveSideband,
}

impl NativeCarrierConfig {
    fn into_bindings(self) -> Result<NativeBindings, GatewayError> {
        let key =
            decode_base64url(&self.identity.key_base64url).map_err(|_| invalid_configuration())?;
        if key.len() != 32 || base64url(&key) != self.identity.key_base64url {
            return Err(invalid_configuration());
        }
        let key: [u8; 32] = key.try_into().map_err(|_| invalid_configuration())?;
        let capabilities = self
            .identity
            .capabilities
            .into_iter()
            .map(NativeCapability::from)
            .collect::<BTreeSet<_>>();
        let identity = NativeTransportIdentity::new(
            self.identity.key_id,
            self.identity.owner_id,
            self.identity.owner_epoch,
            key,
            capabilities,
        )?;
        NativeBindings::configured_https(&self.origin, identity)
            .map_err(|_| invalid_configuration())
    }
}

impl From<NativeCarrierCapability> for NativeCapability {
    fn from(value: NativeCarrierCapability) -> Self {
        match value {
            NativeCarrierCapability::SupervisorRead => Self::SupervisorRead,
            NativeCarrierCapability::ConfigurationPublish => Self::ConfigurationPublish,
            NativeCarrierCapability::AccessPublish => Self::AccessPublish,
            NativeCarrierCapability::OwnerRenewal => Self::OwnerRenewal,
            NativeCarrierCapability::CodexAuthImport => Self::CodexAuthImport,
            NativeCarrierCapability::NativeProfileImport => Self::NativeProfileImport,
            NativeCarrierCapability::LiveSideband => Self::LiveSideband,
        }
    }
}

fn invalid_configuration() -> GatewayError {
    GatewayError::unavailable(
        "Native carrier configuration is invalid",
        "native_configuration_invalid",
    )
}

#[cfg(test)]
mod carrier_config_tests {
    use super::*;

    fn identity(key: &str, capabilities: &str) -> String {
        format!(
            r#"{{"key_id":"native-key","owner_id":"native-owner","owner_epoch":"native-epoch","key_base64url":"{key}","capabilities":[{capabilities}]}}"#
        )
    }

    fn config(origin: &str, identity: &str) -> String {
        format!(r#"{{"origin":"{origin}","identity":{identity}}}"#)
    }

    fn code(error: GatewayError) -> Option<String> {
        error.envelope.error.code
    }

    fn error_code(raw: &str) -> Option<String> {
        match NativeBindings::from_binding_value(Some(raw)) {
            Ok(_) => panic!("invalid carrier configuration was accepted"),
            Err(error) => code(error),
        }
    }

    #[test]
    fn exact_binding_parses_a_fixed_https_transport_identity() {
        let key = base64url(&[7; 32]);
        let raw = config(
            "https://native.example",
            &identity(&key, r#""live_sideband","supervisor_read""#),
        );
        let bindings = NativeBindings::from_binding_value(Some(&raw))
            .unwrap()
            .unwrap();
        let transport = bindings.transport().unwrap();
        assert_eq!(transport.identity.key_id(), "native-key");
        assert_eq!(transport.identity.owner_id(), "native-owner");
        assert_eq!(transport.identity.owner_epoch(), "native-epoch");
    }

    #[test]
    fn absent_binding_leaves_the_capability_unavailable() {
        assert!(NativeBindings::from_binding_value(None).unwrap().is_none());
    }

    #[test]
    fn unknown_fields_and_capabilities_fail_closed() {
        let key = base64url(&[8; 32]);
        let unknown_capability = config(
            "https://native.example",
            &identity(&key, r#""live_sideband","future_capability""#),
        );
        let unknown_field = config(
            "https://native.example",
            &format!(
                r#"{{"key_id":"native-key","owner_id":"native-owner","owner_epoch":"native-epoch","key_base64url":"{key}","capabilities":["live_sideband"],"extra":true}}"#
            ),
        );
        for raw in [unknown_capability, unknown_field] {
            assert_eq!(
                error_code(&raw).as_deref(),
                Some("native_configuration_invalid")
            );
        }
    }

    #[test]
    fn malformed_origins_and_keys_fail_closed() {
        let key = base64url(&[9; 32]);
        for origin in [
            "http://native.example",
            "https://native.example:8443",
            "https://user@native.example",
            "https://native.example/path",
            "https://native.example?target=elsewhere",
            "https://native.example#fragment",
        ] {
            let raw = config(origin, &identity(&key, r#""live_sideband""#));
            assert_eq!(
                error_code(&raw).as_deref(),
                Some("native_configuration_invalid")
            );
        }
        let short = base64url(&[9; 31]);
        let raw = config(
            "https://native.example",
            &identity(&short, r#""live_sideband""#),
        );
        assert_eq!(
            error_code(&raw).as_deref(),
            Some("native_configuration_invalid")
        );
    }

    #[test]
    fn empty_or_partial_identity_is_rejected() {
        let key = base64url(&[10; 32]);
        for raw in [
            config(
                "https://native.example",
                &identity(&key, r#""live_sideband""#),
            )
            .replace(r#","owner_id":"native-owner""#, ""),
            config("https://native.example", &identity(&key, "")),
            config("https://native.example", "{}"),
            String::new(),
        ] {
            assert!(NativeBindings::from_binding_value(Some(&raw)).is_err());
        }
    }

    #[test]
    fn oversized_configuration_is_rejected_before_json_parsing() {
        let raw = "x".repeat(NATIVE_CARRIER_CONFIG_MAX_BYTES + 1);
        assert_eq!(
            error_code(&raw).as_deref(),
            Some("native_configuration_invalid")
        );
    }
}
