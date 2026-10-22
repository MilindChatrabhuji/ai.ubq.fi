//! Fixed authenticated native publication shared by native and Worker receivers.
pub mod access_publication;
pub mod control_publication;
pub mod import_publication;
pub mod managed;
pub mod transport;
mod wire;

pub use access_publication::{
    AccessCredentialSource, PreparedAccessPublication, RegisteredAccessOwner,
};
pub use control_publication::{
    ConfiguredPaidInputs, PreparedConfigurationPublication, configured_paid_binding,
};
pub use managed::{
    ExpectedManagedAccessPublication, ManagedPublicationReceipt, PreparedManagedAccessCommand,
};
pub use wire::{
    ExpectedAccessPublication, PreparedPublicationCommand, PublicationDisposition,
    PublicationReceipt,
};

// Fixed import DATA construction reuses authority's existing schema dependency.
pub use gateway_authority::native_control::import::{
    ImportAccessDocument, ImportCatalogData, ImportPublicationCommandData,
    import_publication_max_bytes, prepare_import_catalog,
};
