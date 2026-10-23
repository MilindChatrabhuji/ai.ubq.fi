//! Codex-only image children with actual transport receipts and sibling abort.
use crate::{
    extras_host::Handle,
    host::PlatformHost,
    transport::{
        body,
        outbound::{self, Cancellation, DispatchAttempt, PinnedDestination},
    },
};
use gateway_core::{GatewayError, model::ModelId, source_json::SourceJson};
use gateway_extras_runtime::{DispatchFailure, DispatchFailureOrigin, ImageKind, UpstreamResponse};
use gateway_providers::{decode_response, policy::HopFailure};
use gateway_routing_runtime::{
    extras::{ChildScope, DispatchTicket},
    types::{AttemptFailure, RefusalDecision, TransportState},
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use worker::Method;

struct Child {
    scope: ChildScope,
    cancellation: Rc<Cancellation>,
    transport: Cell<TransportState>,
    finished: Cell<bool>,
}
pub struct Images {
    admission: Handle,
    platform: PlatformHost,
    children: RefCell<Option<(ImageKind, Vec<Rc<Child>>)>>,
    model: Option<ModelId>,
}
impl Images {
    pub fn new(admission: Handle, platform: PlatformHost, default_model: Option<ModelId>) -> Self {
        Self {
            admission,
            model: crate::host::provider_secret(&platform.env, "IMAGE_BASE_MODEL")
                .map(ModelId::from)
                .or(default_model),
            platform,
            children: RefCell::new(None),
        }
    }
    pub fn model(&self) -> Option<ModelId> {
        self.model.clone()
    }
    pub async fn begin(&self, kind: ImageKind, count: usize) -> Result<(), GatewayError> {
        if self.children.borrow().is_some() || !(1..=10).contains(&count) {
            return Err(invalid());
        }
        let scopes = self
            .admission
            .children(u32::try_from(count).map_err(|_| invalid())?)
            .await
            .map_err(|error| *error.error)?;
        let children = scopes
            .iter()
            .map(|scope| {
                Ok(Rc::new(Child {
                    scope: scope.clone(),
                    cancellation: Rc::new(self.platform.cancellation.child()?),
                    transport: Cell::new(TransportState::NotStarted),
                    finished: Cell::new(false),
                }))
            })
            .collect::<Result<Vec<_>, GatewayError>>();
        match children {
            Ok(children) => {
                self.children.replace(Some((kind, children)));
                Ok(())
            }
            Err(error) => {
                for scope in scopes {
                    self.admission
                        .child_finished(&scope, TransportState::NotStarted)
                        .await
                        .map_err(|error| *error.error)?;
                }
                Err(error)
            }
        }
    }
    fn child(&self, index: usize, kind: Option<ImageKind>) -> Result<Rc<Child>, GatewayError> {
        let children = self.children.borrow();
        let (actual, rows) = children.as_ref().ok_or_else(invalid)?;
        if kind.is_some_and(|kind| kind != *actual) {
            return Err(invalid());
        }
        rows.get(index).cloned().ok_or_else(invalid)
    }
    pub fn abort(&self) {
        if let Some((_, children)) = self.children.borrow().as_ref() {
            for child in children {
                if !child.finished.get() {
                    child.cancellation.abort();
                }
            }
        }
    }
    pub async fn child_finished(&self, index: usize) -> Result<(), GatewayError> {
        let child = self.child(index, None)?;
        if !child.finished.get() {
            self.admission
                .child_finished(&child.scope, child.transport.get())
                .await
                .map_err(|error| *error.error)?;
            child.finished.set(true);
        }
        Ok(())
    }
    pub async fn ensure_settled(&self) -> Result<(), GatewayError> {
        let states = self
            .children
            .borrow()
            .as_ref()
            .map(|(_, children)| children.iter().all(|child| child.finished.get()));
        match states {
            Some(true) => Ok(()),
            Some(false) => Err(invalid()),
            None => {
                self.admission
                    .children(0)
                    .await
                    .map_err(|error| *error.error)?;
                Ok(())
            }
        }
    }
    async fn mark_started(
        &self,
        child: &Child,
        ticket: Option<DispatchTicket>,
    ) -> Result<(), DispatchFailure> {
        child.transport.set(TransportState::Unknown);
        self.admission
            .transport_started(
                &child.scope,
                &ticket.ok_or_else(|| DispatchFailure::gateway(invalid(), false))?,
            )
            .await
            .map_err(|error| DispatchFailure::gateway(*error.error, false))?;
        child.transport.set(TransportState::Started);
        Ok(())
    }
    pub async fn dispatch(
        &self,
        index: usize,
        kind: ImageKind,
        request_id: String,
        raw: SourceJson,
    ) -> Result<UpstreamResponse, DispatchFailure> {
        let child = self
            .child(index, Some(kind))
            .map_err(|error| DispatchFailure::gateway(error, true))?;
        if child.scope.request_id() != request_id || child.finished.get() {
            return Err(DispatchFailure::gateway(invalid(), true));
        }
        let _deadline = child
            .cancellation
            .set_timeout_ms(1_800_000)
            .map_err(|error| DispatchFailure::gateway(error, true))?;
        loop {
            let attempt = self
                .admission
                .prepare_image_child(&child.scope, raw.clone())
                .await
                .map_err(|error| {
                    DispatchFailure::gateway(
                        *error.error,
                        child.transport.get() == TransportState::NotStarted,
                    )
                })?;
            let target = PinnedDestination::new(&attempt.request.url)
                .map_err(|error| DispatchFailure::gateway(error, true))?;
            let wire = attempt.request.body.as_bytes().to_vec();
            let ticket = RefCell::new(None);
            let result = outbound::send_http(
                &target,
                Method::Post,
                &attempt.request.headers,
                &wire,
                &child.cancellation,
                || async {
                    let actual = self
                        .admission
                        .before_image_dispatch(&attempt)
                        .await
                        .map_err(|error| *error.error)?;
                    ticket.replace(Some(actual));
                    Ok(())
                },
            )
            .await;
            let ticket = ticket.into_inner();
            let mut response = match result {
                Ok(response) => response,
                Err(failure) => {
                    if failure.attempt == DispatchAttempt::Started {
                        self.mark_started(&child, ticket).await?;
                    }
                    return Err(DispatchFailure {
                        origin: match failure.origin {
                            outbound::DispatchOrigin::Gateway => DispatchFailureOrigin::Gateway,
                            outbound::DispatchOrigin::Transport => DispatchFailureOrigin::Transport,
                        },
                        error: Box::new(failure.error),
                        headers: Default::default(),
                        quota_refusal: false,
                        upstream_status: None,
                        retry_after_ms: None,
                        before_transport: failure.attempt == DispatchAttempt::NotStarted,
                        raw_error_body: None,
                    });
                }
            };
            let status = response.status_code();
            let mut headers = response
                .headers()
                .entries()
                .collect::<gateway_providers::Headers>();
            headers.insert(
                "x-uos-upstream".into(),
                gateway_providers::policy::direct_provider_label(
                    gateway_core::provider::UpstreamProvider::ChatgptCodex,
                )
                .into(),
            );
            if let Err(mut failure) = self.mark_started(&child, ticket).await {
                failure.headers = headers;
                failure.upstream_status = Some(status);
                body::discard_response(&mut response);
                return Err(failure);
            }
            let bytes = body::response_bytes(
                &mut response,
                crate::multipart::IMAGE_JSON_BYTES,
                &child.cancellation.signal(),
            )
            .await
            .map_err(DispatchFailure::transport)?;
            if status >= 400 {
                let decision = self
                    .admission
                    .image_refusal(
                        &attempt,
                        AttemptFailure {
                            origin: gateway_routing_runtime::types::FailureOrigin::Provider,
                            status: Some(status),
                            headers: headers.clone(),
                            body: bytes.clone(),
                            body_complete: true,
                            failure: HopFailure::Status(status),
                            transport: TransportState::Started,
                            semantic_committed: false,
                            cancelled: child.cancellation.signal().aborted(),
                        },
                    )
                    .await
                    .map_err(|error| DispatchFailure::gateway(*error.error, false))?;
                if decision == RefusalDecision::Continue {
                    continue;
                }
                if decision == RefusalDecision::Abort {
                    return Err(DispatchFailure::transport(
                        gateway_admission::cancellation_error(),
                    ));
                }
                return Ok(UpstreamResponse {
                    status,
                    headers,
                    body: bytes,
                    semantic_terminal: None,
                    usage: None,
                });
            }
            let decoded = decode_response(&attempt.request.decode, status, &headers, &bytes)
                .map_err(DispatchFailure::transport)?;
            if !attempt.request.warnings.is_empty() {
                headers.insert("x-uos-warning".into(), attempt.request.warnings.join(", "));
            }
            return Ok(UpstreamResponse {
                status: decoded.status,
                headers,
                body: decoded.body.as_bytes().to_vec(),
                semantic_terminal: decoded.terminal,
                usage: decoded.usage,
            });
        }
    }
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "The original image child capability is unavailable.",
        "image_child_unavailable",
    )
}
