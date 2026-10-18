//! Event-owned source observability over the existing atomic authority.
//! No provider inference, credential mutation, scheduler, or second paid ledger.
pub mod health;
mod store;
pub mod types;

use std::rc::Rc;
pub use types::*;

pub struct ObservabilityRuntime<S, H> {
    pub(crate) store: Rc<S>,
    pub(crate) host: Rc<H>,
    pub(crate) health: health::HealthWriter,
}
impl<S, H> Clone for ObservabilityRuntime<S, H> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
            host: self.host.clone(),
            health: self.health.clone(),
        }
    }
}
impl<S, H> ObservabilityRuntime<S, H> {
    pub fn new(store: S, host: H) -> Self {
        Self { store: Rc::new(store), host: Rc::new(host), health: health::HealthWriter::default() }
    }
    pub fn store(&self) -> &S { &self.store }
    pub fn host(&self) -> &H { &self.host }
}
