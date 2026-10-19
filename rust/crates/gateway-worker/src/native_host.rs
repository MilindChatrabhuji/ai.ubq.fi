//! Request-owned native bindings. No environment lookup, default public target,
//! provider token, arbitrary path, generic control or caller-selected owner.
use std::rc::Rc;

use gateway_auth::{
    AuthResponse, GatewayError,
    native::*,
    native_auth::NativeTransportIdentity,
    native_control::{
        NATIVE_CONTROL_MAX_BYTES, NATIVE_RENEWAL_MAX_MS, NativeControlEnvelope,
        NativeControlResponse, unverified,
    },
};
use worker::{Context, Fetcher, Response};

use crate::{
    host::{PlatformHost, response_bytes},
    native_transport::{NativeTransport, unavailable},
    transport::stream::{ObservationHandle, ObservedStream},
};

#[derive(Clone, Default)]
pub struct NativeBindings {
    transport: Option<NativeTransport>,
    renewal_owners: Option<Rc<gateway_authority::native_control::RegisteredRenewalOwners>>,
}

impl NativeBindings {
    /// Trusted injection only. The ordinary entrypoint uses Default and cannot
    /// acquire this capability from a client body/header or provider credential.
    pub fn configured(carrier: Fetcher, identity: NativeTransportIdentity) -> Self {
        Self {
            transport: Some(NativeTransport::configured(carrier, identity)),
            renewal_owners: None,
        }
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
        fence: &gateway_routing_runtime::CredentialFence,
        platform: &PlatformHost,
        original: &gateway_core::identity::RequestContext,
    ) -> Result<gateway_routing_runtime::RefreshOutcome, GatewayError> {
        use gateway_authority::{Authority, native_control::NativeRenewalAuthority};
        let gateway_routing_runtime::CredentialFence::Codex {
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
        Ok(gateway_routing_runtime::RefreshOutcome::Published)
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
        self.complete_renewal(&action, &receiver, platform).await
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
        self.complete_renewal(&action, &receiver, platform).await
    }

    pub(crate) async fn renew_cache_experiment(
        &self,
        actor: &gateway_authority::native_control::actor::NativeRenewalActor,
        permit: &gateway_authority::cache_experiment::RefreshPermit,
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
        self.complete_renewal(&action, &receiver, platform).await
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
    ) -> Result<(), GatewayError> {
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
            .await?;
        Ok(())
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
        let stream = ObservedStream::new(
            source,
            ObservationHandle::default(),
            context,
            exchange.cancellation,
            Some(exchange.deadline),
            Box::new(|_| Box::pin(async {})),
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
