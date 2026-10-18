//! Real platform primitives for request-owned observational reads and writes.
use gateway_core::GatewayError;
use gateway_observability::{ObservabilityHost, host_types::BuildIdentity};

#[derive(Clone, Copy)]
pub struct Host;

impl ObservabilityHost for Host {
    fn now_ms(&self) -> i64 {
        crate::storage::now_ms().unwrap_or(i64::MAX)
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        crate::transport::random::random_bytes(length)
    }
    fn compare_labels(&self, left: &str, right: &str) -> Result<std::cmp::Ordering, GatewayError> {
        crate::admin_host::compare_labels(left, right)
    }
    async fn wait_ms(&self, milliseconds: u32) -> Result<(), GatewayError> {
        worker::Delay::from(std::time::Duration::from_millis(u64::from(milliseconds))).await;
        Ok(())
    }
    fn build_identity(&self) -> Result<BuildIdentity, GatewayError> {
        let identity = BuildIdentity {
            git_sha: env!("UOS_RUST_BUILD_GIT_SHA").into(),
            deployment_id: env!("UOS_RUST_BUILD_DEPLOYMENT_ID").into(),
        };
        identity.validate()?;
        Ok(identity)
    }
}
