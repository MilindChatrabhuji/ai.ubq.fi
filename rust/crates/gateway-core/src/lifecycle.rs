use serde::{Deserialize, Serialize};

/// Actual provider-authored or translated terminal events; EOF is not one of them.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum SemanticTerminal {
    #[serde(rename = "response.completed")]
    Completed,
    #[serde(rename = "response.failed")]
    Failed,
    #[serde(rename = "response.incomplete")]
    Incomplete,
    #[serde(rename = "error")]
    Error,
}

/// Reader termination is separate from an observed semantic terminal.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReaderTermination {
    Eof,
    Cancelled,
    Deadline,
    ReadError,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyOutcome {
    Drained,
    Interrupted,
    Failed,
}

/// Native outgoing.finish is a receipt; Workers stream EOF is only `Unobserved`.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryOutcome {
    Delivered,
    Interrupted,
    #[default]
    Unobserved,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    Reserved,
    Dispatched,
    NotDispatched,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaidTerminalState {
    Pending,
    Completed,
    Failed,
    Incomplete,
    Cancelled,
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BillingState {
    Pending,
    Settled,
    NotBilled,
    Unresolved,
}

/// Observation only: no automatic success, settlement, refund, or failover is derived here.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct TransportObservation {
    pub semantic_terminal: Option<SemanticTerminal>,
    pub reader_termination: Option<ReaderTermination>,
    pub body: Option<BodyOutcome>,
    pub delivery: DeliveryOutcome,
}
