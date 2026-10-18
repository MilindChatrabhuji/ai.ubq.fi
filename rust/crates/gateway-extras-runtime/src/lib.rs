//! Source-compatible Voyage jobs/cache/idempotency and image/SystemOne orchestration.
//! The host owns actual transport, cryptography and the one original m14 admission.
mod cache;
mod embeddings;
mod idempotency;
mod images;
mod jobs;
mod store;
mod systemone;
pub mod types;
use gateway_core::{GatewayError, query::QueryStore};
pub use types::*;

pub struct ExtrasRuntime<S, H> {
    store: S,
    host: H,
}
impl<S: QueryStore, H: ExtrasHost> ExtrasRuntime<S, H> {
    pub fn new(store: S, host: H) -> Self {
        Self { store, host }
    }
    pub fn store(&self) -> &S {
        &self.store
    }
    pub fn host(&self) -> &H {
        &self.host
    }
    pub async fn handle(&self, request: ExtrasRequest<'_>) -> Result<ExtrasResponse, GatewayError> {
        let mut result = match &request.route {
            ExtrasRoute::Embeddings => embeddings::sync(&self.store, &self.host, &request).await?,
            ExtrasRoute::JobCreate => jobs::create(&self.store, &self.host, &request).await?,
            ExtrasRoute::JobGet(id) => {
                let id = id.trim_matches(store::js_whitespace);
                if id.is_empty() {
                    let mut r = ExtrasResponse::error(GatewayError::new(
                        404,
                        "Not found",
                        Some("not_found"),
                    ));
                    r.kernel = KernelDisposition::Incomplete("missing_embedding_job_id");
                    return Ok(r.voyage());
                }
                jobs::get(&self.store, &self.host, &request, id).await?
            }
            ExtrasRoute::Images(kind) => images::images(&self.host, &request, *kind).await?,
            ExtrasRoute::SystemOne => {
                systemone::systemone(&self.store, &self.host, &request).await?
            }
        };
        result.kernel = match request.route {
            ExtrasRoute::Embeddings => {
                let replay = result
                    .headers
                    .get("x-uos-idempotency-replayed")
                    .is_some_and(|v| v == "true");
                if (200..300).contains(&result.status) && !replay {
                    KernelDisposition::Completed
                } else {
                    KernelDisposition::Incomplete(if replay {
                        "idempotency_replay"
                    } else {
                        "embedding_failed"
                    })
                }
            }
            ExtrasRoute::JobCreate => {
                if (200..300).contains(&result.status) {
                    KernelDisposition::Completed
                } else {
                    KernelDisposition::Incomplete("embedding_job_create_failed")
                }
            }
            ExtrasRoute::JobGet(_) => {
                KernelDisposition::Incomplete("embedding_job_read_not_counted")
            }
            ExtrasRoute::SystemOne => {
                if (200..300).contains(&result.status) {
                    KernelDisposition::Completed
                } else {
                    KernelDisposition::Incomplete("systemone_failed")
                }
            }
            ExtrasRoute::Images(_) => KernelDisposition::FromAggregate,
        };
        if matches!(
            request.route,
            ExtrasRoute::Embeddings | ExtrasRoute::JobCreate | ExtrasRoute::JobGet(_)
        ) {
            result = result.voyage();
        }
        Ok(result)
    }
}
