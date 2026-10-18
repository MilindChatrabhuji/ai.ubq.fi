//! Event-owned source observability over the existing atomic authority.
//! No provider inference, credential mutation, scheduler, or second paid ledger.
pub mod health;
pub mod ledger;
pub mod telemetry;
mod counters;
pub mod prompt;
pub mod prompt_gate;
pub mod capacity_shapes;
pub mod capacity_math;
pub mod host_types;
pub mod providers;
mod store;
pub mod types;

use std::rc::Rc;
pub use types::*;

pub struct ObservabilityRuntime<S, H> {
    pub(crate) store: Rc<S>,
    pub(crate) host: Rc<H>,
    pub(crate) health: health::HealthWriter,
    pub(crate) active_health: providers::ActiveHealth,
}
impl<S, H> Clone for ObservabilityRuntime<S, H> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
            host: self.host.clone(),
            health: self.health.clone(),
            active_health: self.active_health.clone(),
        }
    }
}
impl<S, H> ObservabilityRuntime<S, H> {
    pub fn new(store: S, host: H) -> Self {
        Self { store: Rc::new(store), host: Rc::new(host), health: health::HealthWriter::default(), active_health: providers::ActiveHealth::default() }
    }
    pub fn store(&self) -> &S { &self.store }
    pub fn host(&self) -> &H { &self.host }
}
