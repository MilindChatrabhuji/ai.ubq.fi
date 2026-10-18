//! The source WeakMap counter belongs to one isolate's KV handle, never durable account state.
use std::{cell::Cell, rc::Rc};

use crate::claude::{AccountBinding, Credential, CredentialKind};
use gateway_auth::crypto::sha256_hex;
use serde_json::json;

/// Clone this handle across requests for the same KV object in the same isolate.
/// A new isolate/KV object starts at zero, as the source WeakMap does.
#[derive(Clone, Debug, Default)]
pub struct StateGeneration(Rc<Cell<u64>>);

#[derive(Clone, Debug)]
pub struct StateSnapshot {
    owner: StateGeneration,
    number: u64,
}

/// These events are emitted only after the corresponding source operation succeeds.
/// Generic roster changes and selecting an account are deliberately not events.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StateChange {
    CredentialStored,
    CredentialCleared,
    WorkspaceStored,
}

impl StateGeneration {
    pub fn snapshot(&self) -> StateSnapshot {
        StateSnapshot {
            owner: self.clone(),
            number: self.0.get(),
        }
    }

    pub fn record_success(&self, _event: StateChange) {
        // Source `number + 1` stops changing at 2^53. Do not invent wrapping epochs.
        self.0.set((self.0.get() + 1).min(1 << 53));
    }

    pub fn is_current(&self, snapshot: &StateSnapshot) -> bool {
        Rc::ptr_eq(&self.0, &snapshot.owner.0) && self.0.get() == snapshot.number
    }

    /// Capture `snapshot` BEFORE any account/workspace reads. Recheck it after awaits.
    /// Account IDs are null for source environment-only resolution; kind remains source text.
    pub fn catalog_identity(
        &self,
        snapshot: &StateSnapshot,
        account: Option<&AccountBinding>,
        credential: &Credential,
        workspace_id: Option<&str>,
    ) -> Option<String> {
        if !self.is_current(snapshot) {
            return None;
        }
        let kind = match credential.kind {
            CredentialKind::ApiKey => "api_key",
            CredentialKind::Oauth => "oauth",
        };
        let bytes = serde_json::to_vec(&json!([
            account.map(|value| value.account_id.as_str()),
            account.map(|value| value.account_cohort_id.as_str()),
            kind,
            credential.secret.expose(),
            workspace_id,
            snapshot.number
        ]))
        .expect("source JSON tuple");
        let identity = sha256_hex(&bytes);
        self.is_current(snapshot).then_some(identity)
    }
}

impl StateSnapshot {
    pub fn number(&self) -> u64 {
        self.number
    }

    /// A carried snapshot retains its exact isolate owner across an asynchronous read.
    pub fn is_current(&self) -> bool {
        self.owner.is_current(self)
    }
}
