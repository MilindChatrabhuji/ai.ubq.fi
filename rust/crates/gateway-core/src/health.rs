use serde::Serialize;

use crate::GatewayError;

pub const GIT_SHA_HEADER: &str = "x-uos-git-sha";
pub const DEPLOYMENT_ID_HEADER: &str = "x-uos-deployment-id";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReleaseIdentity {
    git_sha: String,
    deployment_id: String,
}

impl ReleaseIdentity {
    pub fn cloudflare(git_sha: &str, deployment_id: &str) -> Result<Self, GatewayError> {
        let full_sha = git_sha.len() == 40
            && git_sha
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !full_sha || deployment_id != format!("cloudflare-{git_sha}") {
            return Err(GatewayError::unavailable(
                "The Rust Worker release identity is unavailable.",
                "release_identity_unavailable",
            ));
        }
        Ok(Self {
            git_sha: git_sha.to_owned(),
            deployment_id: deployment_id.to_owned(),
        })
    }

    pub fn git_sha(&self) -> &str {
        &self.git_sha
    }

    pub fn deployment_id(&self) -> &str {
        &self.deployment_id
    }
}

/// Exact source health envelope. Liveness is independent of provider/KV availability.
#[derive(Debug, Serialize)]
pub struct HealthResponse<'a> {
    pub status: &'static str,
    pub release: &'a ReleaseIdentity,
}

impl<'a> HealthResponse<'a> {
    pub fn available(release: &'a ReleaseIdentity) -> Self {
        Self {
            status: "available",
            release,
        }
    }
}
