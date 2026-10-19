//! Finite portable host boundary. No credentials, caller endpoint or admission identity.
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, future::Future};

pub const JEV_TIMEOUT_MS: u32 = 30_000;
pub const RESIDUE_TIMEOUT_MS: u32 = 20_000;
pub const SUMMARY_CHAR_CAP: usize = 1_500_000;

pub trait CompactionHost {
    fn now_ms(&self) -> Result<i64, GatewayError>;
    fn random_uuid(&self) -> Result<String, GatewayError>;
    /// Includes caller/kernel cancellation. No ordinary provider fallback may follow true.
    fn cancelled(&self) -> bool;
    /// Fixed existing OpenRouter SystemOne capability. The timeout covers headers and body.
    fn ask_jev(
        &self,
        state: &SourceJson,
        questions: &SourceJson,
        timeout_ms: u32,
    ) -> impl Future<Output = Result<SourceJson, GatewayError>>;
    /// Fixed buffered Cerebras capability. Missing/unusable residue is best effort only.
    fn rewrite_residue(
        &self,
        body: &SourceJson,
        timeout_ms: u32,
    ) -> impl Future<Output = Result<SourceJson, GatewayError>>;
}

#[derive(Clone, Copy, Debug)]
pub struct ResponseOptions {
    /// Already validated through the existing request stream policy by M05.
    pub stream: bool,
    /// Existing hybrid control; injected diagnostic askers use false unless explicitly enabled.
    pub hybrid: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureKind {
    UnparsableBody,
    MissingInput,
    EmptyTranscript,
    NoCandidates,
    MissingKey,
    JevFailed,
    NoReduction,
    RenderFailed,
    SummaryTooLarge,
    EmptySummary,
    Cancelled,
}
impl FailureKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::UnparsableBody => "unparsable-body",
            Self::MissingInput => "missing-input",
            Self::EmptyTranscript => "empty-transcript",
            Self::NoCandidates => "no-candidates",
            Self::MissingKey => "missing-key",
            Self::JevFailed => "jev-failed",
            Self::NoReduction => "no-reduction",
            Self::RenderFailed => "render-failed",
            Self::SummaryTooLarge => "summary-too-large",
            Self::EmptySummary => "empty-summary",
            Self::Cancelled => "cancelled",
        }
    }
    pub fn status(self) -> u16 {
        match self {
            Self::MissingKey => 503,
            Self::JevFailed | Self::RenderFailed => 502,
            Self::Cancelled => 499,
            _ => 400,
        }
    }
    pub fn code(self) -> &'static str {
        if self == Self::Cancelled {
            "request_cancelled"
        } else {
            "jev_compaction_unavailable"
        }
    }
    pub fn error_type(self) -> &'static str {
        if self.status() >= 500 || self == Self::Cancelled {
            "server_error"
        } else {
            "invalid_request_error"
        }
    }
    pub fn message(self) -> String {
        if self == Self::Cancelled {
            "Request was cancelled.".into()
        } else {
            format!("Jev compaction unavailable ({})", self.label())
        }
    }
}

#[derive(Clone, Debug)]
pub struct CompactionFailure {
    pub kind: FailureKind,
    /// Fixed structural detail only. Never upstream text or transcript content.
    pub detail: &'static str,
}
impl CompactionFailure {
    pub fn new(kind: FailureKind, detail: &'static str) -> Self {
        Self { kind, detail }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionStats {
    pub messages_before: usize,
    pub messages_after: usize,
    pub chars_before: usize,
    pub chars_after: usize,
    pub calls: usize,
    pub kept: usize,
    pub results_dropped: usize,
    pub calls_dropped: usize,
    pub pinned: usize,
    pub state_tokens: usize,
    pub state_stage: String,
    pub windows: usize,
    pub requests: usize,
    pub ms: i64,
}

#[derive(Clone, Debug)]
pub struct CompactionOutcome {
    pub status: u16,
    pub content_type: &'static str,
    pub headers: BTreeMap<String, String>,
    /// UTF8 JSON or SSE bytes; non-scalar source text remains escaped JSON strings.
    pub body: Vec<u8>,
    pub summary: JsString16,
    pub stats: CompactionStats,
    pub candidates: usize,
    pub items: usize,
    pub fitted_drops: usize,
    pub floor_bound: bool,
    pub hybrid: bool,
    pub hybrid_ms: Option<i64>,
    pub input_estimate_tokens: usize,
}
