use serde::{Deserialize, Serialize};

/// Operator-facing vocabulary from src/provider/selection.ts; not accounting labels.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectableProviderId {
    Codex,
    ClaudeCode,
    Surplus,
    Openlux,
    Deepseek,
    Cerebras,
    Lithos,
    Openrouter,
    Ubiquity,
}

/// Dispatch/usage vocabulary from ApiKeyUsageRequestV3, including the embeddings route.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamProvider {
    Cerebras,
    ChatgptCodex,
    ClaudeCode,
    Deepseek,
    Lithos,
    Openrouter,
    RemovedProvider,
    Metered,
    Surplus,
    Voyage,
}

/// Existing paid ledger spelling: the operator-facing OpenLux tier is `metered` here.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaidProvider {
    Surplus,
    Metered,
}

/// Source quota classes; model eligibility is deliberately separate from quota exhaustion.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexQuotaClass {
    Spark,
    #[serde(rename = "gpt_oss_120b")]
    GptOss120b,
    Reserve,
    Standard,
    Unknown,
}

/// Missing, malformed, or disabled permission never authorizes an overage probe.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct OveragePermission(bool);

impl OveragePermission {
    pub fn from_stored_record(record: Option<&serde_json::Value>) -> Self {
        Self(
            record
                .and_then(|value| value.get("allow"))
                .and_then(|value| value.as_bool())
                == Some(true),
        )
    }

    pub fn allows_dispatch(self) -> bool {
        self.0
    }
}
