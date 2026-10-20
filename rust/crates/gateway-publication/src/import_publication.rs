//! Fixed authenticated sanitized import publication. The constructor inputs and
//! original authority own the decision; wire DATA never supplies config or KV.
use crate::transport::{
    PublicationReceiver, PublicationRequest, PublicationResponse, error_response,
};
use gateway_auth::{
    GatewayError,
    native::{NATIVE_PUBLICATION_PATH, NATIVE_RESPONSE_MAC_HEADER},
};
use gateway_authority::{
    TokenSource,
    native_control::{
        NativeRenewalAuthority, NativeRenewalCancellation,
        import::{
            ImportPublicationCommandData, NativeImportPublication,
            NativeImportPublicationDisposition, import_publication_max_bytes,
        },
    },
};
use gateway_core::state::AuthorityStore;

impl PublicationReceiver {
    /// Dedicated finite entry, deliberately not selected by an old operation's
    /// decoder. M44 owns actual Worker/native dispatch and durable sender wiring.
    pub async fn handle_import<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>(
        &self,
        control: &NativeRenewalAuthority<'_, S, I, C>,
        request: PublicationRequest,
    ) -> PublicationResponse {
        if request.method != "POST" || request.path != NATIVE_PUBLICATION_PATH {
            return error_response(GatewayError::new(
                404,
                "Unknown native import publication route",
                Some("native_publication_route_invalid"),
            ));
        }
        if request.raw_body.len() > import_publication_max_bytes() {
            return error_response(GatewayError::new(
                413,
                "Native import publication exceeds its derived bound",
                Some("native_publication_body_too_large"),
            ));
        }
        let nonce = request.headers.borrowed().nonce.to_owned();
        let peer = match control
            .authenticate_import_publication(request.headers.borrowed(), &request.raw_body)
            .await
        {
            Ok(peer) => peer,
            Err(error) => return error_response(error),
        };
        let result = self.apply_import(control, &peer, &request.raw_body).await;
        let mut response = match result {
            Ok(result) => match serde_json::to_vec(&result) {
                Ok(body) => PublicationResponse {
                    status: 200,
                    headers: vec![
                        ("content-type".into(), "application/json".into()),
                        ("cache-control".into(), "no-store".into()),
                    ],
                    raw_body: body,
                },
                Err(_) => error_response(unverified()),
            },
            Err(error) => error_response(error),
        };
        match self.import_identity().sign_publication_response(
            &nonce,
            &request.raw_body,
            response.status,
            &response.raw_body,
        ) {
            Ok(mac) => response
                .headers
                .push((NATIVE_RESPONSE_MAC_HEADER.into(), mac)),
            Err(error) => return error_response(error),
        }
        response
    }
    pub async fn apply_import<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>(
        &self,
        control: &NativeRenewalAuthority<'_, S, I, C>,
        peer: &gateway_auth::native_auth::AuthenticatedNativeOwner,
        body: &[u8],
    ) -> Result<NativeImportPublication, GatewayError> {
        for _ in 0..5 {
            let prepared = control.prepare_import_publication(peer, body).await?;
            // Recheck the actual PREVIOUS configured fingerprint as well. A host
            // settings/key change cannot be smuggled through a runtime import.
            let previous = self.import_inputs().candidate_configuration(
                self.import_identity(),
                prepared.current_owner(),
                &prepared.previous_configuration().generation,
                prepared.current_runtime(),
                Some(prepared.previous_configuration()),
            )?;
            if &previous != prepared.previous_configuration() {
                return Err(unverified());
            }
            let candidate = if prepared.needs_configuration() {
                Some(self.import_inputs().candidate_configuration(
                    self.import_identity(),
                    prepared.current_owner(),
                    prepared.configuration_generation(),
                    prepared.planned_runtime(),
                    Some(prepared.previous_configuration()),
                )?)
            } else {
                None
            };
            match prepared.commit(candidate).await {
                Ok(result) => {
                    // A successful write is not an authenticated final current
                    // observation. Re-enter only the SAME publication, no effect.
                    if result.disposition == NativeImportPublicationDisposition::Applied {
                        let replay = control.prepare_import_publication(peer, body).await?;
                        let candidate = if replay.needs_configuration() {
                            Some(self.import_inputs().candidate_configuration(
                                self.import_identity(),
                                replay.current_owner(),
                                replay.configuration_generation(),
                                replay.planned_runtime(),
                                Some(replay.previous_configuration()),
                            )?)
                        } else {
                            None
                        };
                        let observed = replay.commit(candidate).await?;
                        if observed.operation_id != result.operation_id
                            || observed.action_ref != result.action_ref
                            || observed.publication != result.publication
                            || observed.disposition
                                != NativeImportPublicationDisposition::AlreadyCurrent
                        {
                            return Err(unverified());
                        }
                    }
                    return Ok(result);
                }
                Err(error)
                    if error.envelope.error.code.as_deref()
                        == Some("native_import_publication_conflict") =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        Err(unverified())
    }
}
/// Actual sender adapters may carry this non-authorizing DATA only after their
/// genuine native receipt/validation producer. No public constructor here mints
/// physical durability or native VerifiedImportPublication from a boolean.
pub fn canonical_import_command(
    data: &ImportPublicationCommandData,
) -> Result<Vec<u8>, GatewayError> {
    data.bytes()
}
fn unverified() -> GatewayError {
    GatewayError::unavailable(
        "Native import publication is not a current authenticated matching terminal; reconcile the original operation.",
        "native_import_publication_unverified",
    )
}
