//! Named migration failure carrier. A scalar diagnostic is never the source response.
use gateway_admin_data::migration::audit::Audit;
use gateway_core::{GatewayError, source_json::SourceJson, source_serialization as source};

pub enum MigrationError {
    State(GatewayError),
    SourceInventory(Audit),
}
impl MigrationError {
    pub fn status(&self) -> u16 {
        match self {
            Self::State(error) => error.status,
            Self::SourceInventory(_) => 409,
        }
    }
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::State(error) => error.envelope.error.code.as_deref(),
            Self::SourceInventory(_) => Some("migration_state_invalid"),
        }
    }
    pub fn diagnostic(&self) -> &str {
        match self {
            Self::State(error) => &error.envelope.error.message,
            Self::SourceInventory(_) => "Complete source inventory validation failed",
        }
    }
    /// Exact pre-existing envelope, including original UTF16 message units.
    /// Never round-trip this body through Value or a String-only error carrier.
    pub fn source_body(&self) -> Result<SourceJson, GatewayError> {
        match self {
            Self::State(error) => SourceJson::from_serializable(&error.envelope),
            Self::SourceInventory(audit) => source::object(vec![(
                "error",
                source::object(vec![
                    (
                        "message",
                        audit
                            .error_message("Complete source inventory validation failed: ")
                            .to_source_json()?,
                    ),
                    (
                        "type",
                        SourceJson::from_serializable("invalid_request_error")?,
                    ),
                    (
                        "code",
                        SourceJson::from_serializable("migration_state_invalid")?,
                    ),
                ])?,
            )]),
        }
    }
}
impl From<GatewayError> for MigrationError {
    fn from(error: GatewayError) -> Self {
        Self::State(error)
    }
}
impl std::fmt::Display for MigrationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.diagnostic())
    }
}
impl std::fmt::Debug for MigrationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MigrationError")
            .field("status", &self.status())
            .field("diagnostic", &self.diagnostic())
            .finish()
    }
}
impl std::error::Error for MigrationError {}
