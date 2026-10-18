use gateway_core::GatewayError;
use worker::{Method, Request};

pub const LIVE_SIDEBAND_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const SUPERVISOR_MAX_BYTES: usize = 1024 * 1024;
pub const NATIVE_AUTH_MAX_BYTES: usize = 64 * 1024;

/// Handshake policy only. Authentication and principal/call ownership must run
/// before constructing a WebSocketPair or opening an upstream connection.
pub fn require_upgrade(request: &Request) -> Result<(), GatewayError> {
    let upgrade = request
        .headers()
        .get("upgrade")
        .map_err(|_| invalid_upgrade())?;
    if request.method() != Method::Get
        || !upgrade.is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    {
        return Err(invalid_upgrade());
    }
    Ok(())
}

pub fn validate_frame_size(bytes: usize, max_bytes: usize) -> Result<(), GatewayError> {
    if bytes > max_bytes {
        return Err(GatewayError::new(
            413,
            "The WebSocket message is too large.",
            Some("websocket_message_too_large"),
        ));
    }
    Ok(())
}

fn invalid_upgrade() -> GatewayError {
    GatewayError::new(
        400,
        "Expected a WebSocket upgrade.",
        Some("websocket_upgrade_required"),
    )
}
