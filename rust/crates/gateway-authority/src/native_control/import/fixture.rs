//! Default-off compile-only trust preparation, not an import permission issuer.
use super::remote_tls::Roots;
use super::{NativeRenewalCancellation, RemoteImportAuthority, unavailable};
use gateway_auth::native_auth::NativeTransportIdentity;
use gateway_core::GatewayError;
use std::{
    net::{SocketAddr, TcpStream},
    time::Instant,
};
const CA: &[u8] = include_bytes!("../../../../gateway-native/tests/fixtures/import-tls/ca.der");
fn verify_addresses(peer: SocketAddr, local: SocketAddr) -> Result<(), GatewayError> {
    if !peer.ip().is_loopback() || !local.ip().is_loopback() {
        return Err(unavailable());
    }
    Ok(())
}
impl<'a, C: NativeRenewalCancellation> RemoteImportAuthority<'a, C> {
    /// Prepare ONLY the committed synthetic CA and exact localhost authority path.
    /// No target, trust bytes, reply, reader or boolean can be supplied. This
    /// returns a sealed client, never proof before actual TLS/MAC/currentness.
    pub fn from_fixture_connected(
        socket: TcpStream,
        identity: NativeTransportIdentity,
        cancellation: &'a C,
        deadline: Instant,
    ) -> Result<Self, GatewayError> {
        verify_addresses(
            socket.peer_addr().map_err(|_| unavailable())?,
            socket.local_addr().map_err(|_| unavailable())?,
        )?;
        Self::with_roots(
            "https://localhost/uos/native/renewal-authority",
            socket,
            identity,
            cancellation,
            deadline,
            Roots::fixture(CA),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn marker_is_denial_only_and_both_actual_address_roles_are_loopback_gated() {
        assert!(std::hint::black_box(crate::NATIVE_IMPORT_FIXTURE_ENABLED));
        for peer in ["127.0.0.1:443", "[::1]:443"] {
            for local in ["127.0.0.1:3000", "[::1]:3000"] {
                verify_addresses(peer.parse().unwrap(), local.parse().unwrap()).unwrap();
            }
        }
        for other in ["192.0.2.1:443", "10.0.0.1:443", "[2001:db8::1]:443"] {
            let other = other.parse().unwrap();
            let loopback = "127.0.0.1:443".parse().unwrap();
            assert!(verify_addresses(other, loopback).is_err());
            assert!(verify_addresses(loopback, other).is_err());
        }
    }
}
