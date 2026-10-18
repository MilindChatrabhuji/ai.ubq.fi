//! Event-owned source observability over the existing atomic authority.
//! No provider inference, credential mutation, scheduler, or second paid ledger.
pub mod capacity_math;
pub mod capacity_shapes;
mod counters;
pub mod health;
pub mod host_types;
pub mod ledger;
pub mod ledger_stats;
pub mod prompt;
pub mod prompt_gate;
pub mod providers;
pub mod claude_capacity;
pub mod capacity_events;
mod capacity_store;
pub mod capacity;
pub mod remote_capacity;
mod store;
pub mod telemetry;
pub mod types;

use std::rc::Rc;
pub use types::*;

pub struct ObservabilityRuntime<S, H> {
    pub(crate) store: Rc<S>,
    pub(crate) host: Rc<H>,
    pub(crate) health: health::HealthWriter,
    pub(crate) active_health: providers::ActiveHealth,
    pub(crate) sampled_bucket:Rc<std::cell::Cell<i64>>,
}
impl<S, H> Clone for ObservabilityRuntime<S, H> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
            host: self.host.clone(),
            health: self.health.clone(),
            active_health: self.active_health.clone(),
            sampled_bucket:self.sampled_bucket.clone(),
        }
    }
}
impl<S, H> ObservabilityRuntime<S, H> {
    pub fn new(store: S, host: H) -> Self {
        Self {
            store: Rc::new(store),
            host: Rc::new(host),
            health: health::HealthWriter::default(),
            active_health: providers::ActiveHealth::default(),
            sampled_bucket:Rc::new(std::cell::Cell::new(0)),
        }
    }
    pub fn store(&self) -> &S {
        &self.store
    }
    pub fn host(&self) -> &H {
        &self.host
    }
}
