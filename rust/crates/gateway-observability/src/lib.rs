//! Event-owned source observability over the existing atomic authority.
//! No provider inference, credential mutation, scheduler, or second paid ledger.
pub mod api;
pub mod capacity;
pub mod capacity_events;
pub mod capacity_math;
pub mod capacity_shapes;
mod capacity_store;
pub mod claude_capacity;
mod completion;
mod counters;
pub mod health;
pub mod host_types;
pub mod incidents;
pub mod ledger;
pub mod ledger_stats;
pub mod metered;
pub mod prompt;
pub mod prompt_gate;
pub mod providers;
pub mod records;
pub mod remote_capacity;
mod replay_bootstrap;
mod replay_cleanup;
pub mod replay_crypto;
mod replay_metadata;
pub mod replay_model;
pub mod replay_producer;
pub mod replay_read;
pub mod replay_retention;
pub mod replay_retention_schema;
pub mod replay_trace;
mod replay_values;
pub mod settings;
mod store;
pub mod telemetry;
pub mod types;

use std::rc::Rc;

/// Isolate-owned coordination data only. It never retains a store, host, or I/O future.
#[derive(Clone, Default)]
pub struct ObservabilityState {
    health: health::HealthWriter,
    active_health: providers::ActiveHealth,
    sampled_bucket: Rc<std::cell::Cell<i64>>,
    replay_bootstrap: Rc<std::cell::RefCell<replay_bootstrap::OwnerIndex>>,
}

pub struct ObservabilityRuntime<S, H> {
    pub(crate) store: Rc<S>,
    pub(crate) host: Rc<H>,
    pub(crate) health: health::HealthWriter,
    pub(crate) active_health: providers::ActiveHealth,
    pub(crate) sampled_bucket: Rc<std::cell::Cell<i64>>,
    pub(crate) replay_bootstrap: Rc<std::cell::RefCell<replay_bootstrap::OwnerIndex>>,
}
impl<S, H> Clone for ObservabilityRuntime<S, H> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
            host: self.host.clone(),
            health: self.health.clone(),
            active_health: self.active_health.clone(),
            sampled_bucket: self.sampled_bucket.clone(),
            replay_bootstrap: self.replay_bootstrap.clone(),
        }
    }
}
impl<S, H> ObservabilityRuntime<S, H> {
    pub fn new(store: S, host: H) -> Self {
        Self::with_state(store, host, ObservabilityState::default())
    }
    pub fn with_state(store: S, host: H, state: ObservabilityState) -> Self {
        Self {
            store: Rc::new(store),
            host: Rc::new(host),
            health: state.health,
            active_health: state.active_health,
            sampled_bucket: state.sampled_bucket,
            replay_bootstrap: state.replay_bootstrap,
        }
    }
    pub fn shared_state(&self) -> ObservabilityState {
        ObservabilityState {
            health: self.health.clone(),
            active_health: self.active_health.clone(),
            sampled_bucket: self.sampled_bucket.clone(),
            replay_bootstrap: self.replay_bootstrap.clone(),
        }
    }
    pub fn store(&self) -> &S {
        &self.store
    }
    pub fn host(&self) -> &H {
        &self.host
    }
}
