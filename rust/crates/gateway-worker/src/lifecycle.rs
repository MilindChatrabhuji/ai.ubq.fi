//! Exact source-derived authenticated principal identity shared by admission/routing.
use gateway_auth::AuthPrincipal;

pub fn principal_id(principal: &AuthPrincipal) -> String {
    principal.method.principal_id(
        principal
            .token
            .as_ref()
            .map(gateway_auth::crypto::Secret::expose),
    )
}
