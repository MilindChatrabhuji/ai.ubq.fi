//! The private fixture host must bound its request before calling this decoder.
pub use gateway_migration::operational::{
    ArtifactInput, NativeMigrationRequest, NativeMigrationResponse, NativeOperation, NativeResult,
    PRIVATE_WIRE_MAX_BYTES, decode_native_request, encode_native_response,
};
