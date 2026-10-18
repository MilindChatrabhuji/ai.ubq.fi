//! Finite untrusted response text, never an accepted outcome or authorization proof.
use crate::GatewayError;

#[derive(Clone, Eq, PartialEq)]
pub struct ClaudeErrorEvidence {
    prefix: Option<Vec<u16>>,
    complete: bool,
}
impl ClaudeErrorEvidence {
    pub fn from_prefix(prefix: Option<Vec<u16>>, complete: bool) -> Result<Self, GatewayError> {
        if prefix.as_ref().is_some_and(|v| v.len() > 4096) {
            return Err(GatewayError::unavailable(
                "Claude error evidence exceeds its source UTF16 prefix",
                "claude_error_evidence_invalid",
            ));
        }
        Ok(Self { prefix, complete })
    }
    pub fn prefix(&self) -> Option<&[u16]> {
        self.prefix.as_deref()
    }
    pub fn complete(&self) -> bool {
        self.complete
    }
}
impl std::fmt::Debug for ClaudeErrorEvidence {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("ClaudeErrorEvidence")
            .field("prefix_units", &self.prefix.as_ref().map(Vec::len))
            .field("complete", &self.complete)
            .finish()
    }
}
