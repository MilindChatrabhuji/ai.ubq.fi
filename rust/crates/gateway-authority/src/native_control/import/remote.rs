//! Actual fixed TLS import client. No generic response/carrier/reader input can
//! mint body, claim, Started, currentness or terminal proofs through this type.
use super::remote_state::RemoteImportState;
use super::remote_tls::{ImportAuthorityTls, Roots};
use super::*;
use gateway_auth::{
    crypto::base64url,
    native::*,
    native_auth::NativeTransportIdentity,
    native_import::authority::{
        ImportAuthorityClaimMode, ImportAuthorityCommand as Command,
        ImportAuthorityReplyData as Reply, ImportAuthorityRequestData as Request,
        ImportAuthorityResult as ResultData, ImportAuthorityStateData as State,
        ImportAuthorityTerminalData, ImportCompletionData, ImportCustodyStartedReplyData,
        ImportCustodyStartedWire, import_authority_reply_max_bytes_for,
        import_custody_reply_max_bytes,
    },
};
use std::{
    cell::Cell,
    net::TcpStream,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub struct RemoteImportAuthority<'a, C> {
    identity: NativeTransportIdentity,
    transport: ImportAuthorityTls,
    cancellation: &'a C,
    deadline: Instant,
    client: Arc<()>,
    last_time_ms: Cell<i64>,
}
/// Genuine header/current-action admission, before native body consumption.
/// ```compile_fail
/// use gateway_authority::native_control::import::RemoteAdmittedImport;
/// let forged:RemoteAdmittedImport=serde_json::from_str("{}").unwrap();
/// ```
pub struct RemoteAdmittedImport {
    admission: NativeImportAdmission,
    state: State,
    client: Arc<()>,
}
impl RemoteAdmittedImport {
    pub fn native_owner_id(&self) -> &str {
        &self.state.native_owner_id
    }
    pub fn account_id_hash(&self) -> &str {
        &self.state.account_id_hash
    }
    pub fn target(&self) -> &NativeImportTarget {
        &self.state.target
    }
}
/// Authenticated current catalog presence only, not catalog content or permission.
pub struct AuthenticatedImportCatalogObservation {
    revision: Option<String>,
}
impl AuthenticatedImportCatalogObservation {
    pub fn revision(&self) -> Option<&str> {
        self.revision.as_deref()
    }
}
/// A current authenticated matching terminal; NOT native physical durability.
/// ```compile_fail
/// use gateway_authority::native_control::import::AuthenticatedImportTerminal;
/// let forged:AuthenticatedImportTerminal=serde_json::from_str("{}").unwrap();
/// ```
pub struct AuthenticatedImportTerminal {
    binding: NativeImportBinding,
    terminal: ImportAuthorityTerminalData,
    completion: ImportCompletionData,
    observed_at_ms: i64,
}
/// A current matching terminal for request-correlated original B1 DATA.
/// Never proves historical Started, physical custody, or permission to stop/write.
/// ```compile_fail
/// use gateway_authority::native_control::import::VerifiedCurrentImportTerminal;
/// let forged:VerifiedCurrentImportTerminal=serde_json::from_str("{}").unwrap();
/// ```
pub struct VerifiedCurrentImportTerminal {
    request: ImportCustodyStartedRequest,
    publication_revision: String,
    terminal: ImportAuthorityTerminalData,
    observed_at_ms: i64,
}
impl VerifiedCurrentImportTerminal {
    pub fn request(&self) -> &ImportCustodyStartedRequest {
        &self.request
    }
    pub fn publication_revision(&self) -> &str {
        &self.publication_revision
    }
    pub fn terminal(&self) -> &ImportAuthorityTerminalData {
        &self.terminal
    }
    pub fn observed_at_ms(&self) -> i64 {
        self.observed_at_ms
    }
    pub fn deadline_ms(&self) -> i64 {
        self.request.deadline_ms
    }
}
impl AuthenticatedImportTerminal {
    pub fn completion(&self) -> &ImportCompletionData {
        &self.completion
    }
    pub fn binding(&self) -> &NativeImportBinding {
        &self.binding
    }
    pub fn terminal(&self) -> &ImportAuthorityTerminalData {
        &self.terminal
    }
    pub fn observed_at_ms(&self) -> i64 {
        self.observed_at_ms
    }
}
impl<'a, C: NativeRenewalCancellation> RemoteImportAuthority<'a, C> {
    pub fn from_connected(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
        cancellation: &'a C,
        deadline: Instant,
    ) -> Result<Self, GatewayError> {
        Self::with_roots(
            target,
            socket,
            identity,
            cancellation,
            deadline,
            Roots::webpki(),
        )
    }
    pub(super) fn with_roots(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
        cancellation: &'a C,
        deadline: Instant,
        roots: Roots,
    ) -> Result<Self, GatewayError> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(unavailable)?;
        if remaining > Duration::from_millis(OWNER_RENEWAL_MAX_MS as u64)
            || cancellation.cancelled()
        {
            return Err(unavailable());
        }
        let client = Self {
            identity,
            transport: ImportAuthorityTls::from_connected(target, socket, roots)?,
            cancellation,
            deadline,
            client: Arc::new(()),
            last_time_ms: Cell::new(0),
        };
        client.now()?;
        Ok(client)
    }
    #[cfg(all(test, not(feature = "native-import-fixture")))]
    pub(in crate::native_control) fn fixture_connected(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
        cancellation: &'a C,
        deadline: Instant,
        ca: &[u8],
    ) -> Result<Self, GatewayError> {
        Self::with_roots(
            target,
            socket,
            identity,
            cancellation,
            deadline,
            Roots::fixture(ca),
        )
    }
    fn now(&self) -> Result<i64, GatewayError> {
        if self.cancellation.cancelled() || Instant::now() >= self.deadline {
            return Err(unavailable());
        }
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| unavailable())?
                .as_millis(),
        )
        .map_err(|_| unavailable())?;
        crate::validate_time(now)?;
        if now < self.last_time_ms.get() {
            return Err(unavailable());
        }
        self.last_time_ms.set(now);
        Ok(now)
    }
    fn check_state(&self, state: &State) -> Result<(), GatewayError> {
        state.validate()?;
        let now = self.now()?;
        if now < state.created_at_ms || now >= state.deadline_ms {
            return Err(unavailable());
        }
        Ok(())
    }
    fn state<'p>(&self, state: &'p ImportActionState) -> Result<&'p State, GatewayError> {
        match state {
            ImportActionState::Remote(remote) if Arc::ptr_eq(&self.client, &remote.client) => {
                self.check_state(&remote.state)?;
                Ok(&remote.state)
            }
            _ => Err(unavailable()),
        }
    }
    fn remote_state(&self, state: State) -> ImportActionState {
        ImportActionState::Remote(Box::new(RemoteImportState {
            state,
            client: self.client.clone(),
        }))
    }
    fn exchange_bytes(&self, body: &[u8], max_reply: usize) -> Result<Vec<u8>, GatewayError> {
        let now = self.now()?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| unavailable())?;
        let nonce = base64url(&random);
        let signature = self
            .identity
            .sign(NATIVE_RENEWAL_AUTHORITY_PATH, now, &nonce, body)?;
        let headers = vec![
            (NATIVE_VERSION_HEADER.into(), "1".into()),
            (NATIVE_KEY_HEADER.into(), self.identity.key_id().into()),
            (NATIVE_TIME_HEADER.into(), now.to_string()),
            (NATIVE_NONCE_HEADER.into(), nonce.clone()),
            (NATIVE_MAC_HEADER.into(), signature),
        ];
        let response = self
            .transport
            .send(&headers, body, self.deadline, max_reply)?;
        let signatures = response
            .headers()
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case(NATIVE_RESPONSE_MAC_HEADER))
            .collect::<Vec<_>>();
        if signatures.len() != 1 {
            return Err(unavailable());
        }
        self.identity.verify_authority_response(
            &nonce,
            body,
            response.status(),
            response.body(),
            &signatures[0].1,
        )?;
        self.now()?;
        if response.status() != 200 {
            return Err(unavailable());
        }
        Ok(response.body().into())
    }
    fn exchange(&self, command: Command) -> Result<ResultData, GatewayError> {
        let request = Request::new(command)?;
        let bytes = request.bytes()?;
        let response =
            self.exchange_bytes(&bytes, import_authority_reply_max_bytes_for(&request)?)?;
        let reply = Reply::parse_for(&response, &request)?;
        Ok(reply.result)
    }
    pub fn admit_import(
        &self,
        admission: NativeImportAdmission,
    ) -> Result<RemoteAdmittedImport, GatewayError> {
        admission.require_owner(&self.identity, self.now()?)?;
        if admission.kind() != NativeImportKind::CodexAuth {
            return Err(unavailable());
        }
        let ResultData::Admit { state } = self.exchange(Command::Admit {
            metadata: admission.metadata().clone(),
        })?
        else {
            return Err(unavailable());
        };
        self.check_state(&state)?;
        admission.require_owner(&self.identity, self.now()?)?;
        Ok(RemoteAdmittedImport {
            admission,
            state,
            client: self.client.clone(),
        })
    }
    pub fn finish_import(
        &self,
        admitted: RemoteAdmittedImport,
        original_body: &[u8],
    ) -> Result<AuthenticatedNativeImport, GatewayError> {
        if !Arc::ptr_eq(&self.client, &admitted.client) {
            return Err(unavailable());
        }
        self.check_state(&admitted.state)?;
        admitted
            .admission
            .require_owner(&self.identity, self.now()?)?;
        let body = admitted.admission.verify_body(original_body, self.now()?)?;
        let ResultData::FinishCurrent { state } = self.exchange(Command::FinishCurrent {
            state: admitted.state,
        })?
        else {
            return Err(unavailable());
        };
        self.check_state(&state)?;
        body.require_owner(&self.identity, self.now()?)?;
        body.require_body(original_body, self.now()?)?;
        Ok(AuthenticatedNativeImport {
            body,
            state: self.remote_state(state),
        })
    }
    pub fn claim_import(
        &self,
        proof: &AuthenticatedNativeImport,
    ) -> Result<NativeImportClaim, GatewayError> {
        proof.body.require_owner(&self.identity, self.now()?)?;
        let state = self.state(&proof.state)?.clone();
        let ResultData::Claim {
            state,
            claim_ref,
            mode,
            start_permit,
        } = self.exchange(Command::Claim { state })?
        else {
            return Err(unavailable());
        };
        self.check_state(&state)?;
        proof.body.require_owner(&self.identity, self.now()?)?;
        Ok(effects::NativeImportClaim {
            binding: remote_state::phase_binding(&state, claim_ref),
            state: self.remote_state(state),
            permit: start_permit,
            mode: if mode == ImportAuthorityClaimMode::ImportOnce {
                NativeImportMode::ImportOnce
            } else {
                NativeImportMode::ReconcileOnly
            },
        })
    }
    pub fn start_import<'p>(
        &self,
        claim: &mut NativeImportClaim,
        proof: &'p AuthenticatedNativeImport,
    ) -> Result<Option<NativeImportStart<'p>>, GatewayError> {
        let fresh = claim.mode == NativeImportMode::ImportOnce;
        claim.mode = NativeImportMode::ReconcileOnly;
        let permit = claim.permit.take();
        let state = self.state(&claim.state)?.clone();
        if self.state(&proof.state)? != &state {
            return Err(unavailable());
        }
        proof.body.require_owner(&self.identity, self.now()?)?;
        if !fresh {
            return Ok(None);
        }
        let ResultData::Start {
            started_revision, ..
        } = self.exchange(Command::Start {
            state: state.clone(),
            claim_ref: claim.binding.claim_ref.clone(),
            start_permit: permit.ok_or_else(unavailable)?,
        })?
        else {
            return Err(unavailable());
        };
        self.check_state(&state)?;
        proof.body.require_owner(&self.identity, self.now()?)?;
        Ok(started_revision.map(|started_revision| NativeImportStart {
            proof,
            binding: claim.binding.clone(),
            started_revision,
        }))
    }
    pub fn recheck_import(&self, proof: &AuthenticatedNativeImport) -> Result<(), GatewayError> {
        proof.body.require_owner(&self.identity, self.now()?)?;
        let state = self.state(&proof.state)?.clone();
        self.exchange(Command::Current {
            state: state.clone(),
            claim_ref: None,
        })?;
        self.check_state(&state)?;
        proof.body.require_owner(&self.identity, self.now()?)
    }
    pub fn recheck_import_claim(&self, claim: &NativeImportClaim) -> Result<(), GatewayError> {
        let state = self.state(&claim.state)?.clone();
        self.exchange(Command::Current {
            state: state.clone(),
            claim_ref: Some(claim.binding.claim_ref.clone()),
        })?;
        self.check_state(&state)
    }
    pub fn unknown_import(&self, claim: &NativeImportClaim) -> Result<(), GatewayError> {
        let state = self.state(&claim.state)?.clone();
        self.exchange(Command::Unknown {
            state: state.clone(),
            claim_ref: claim.binding.claim_ref.clone(),
        })?;
        self.check_state(&state)
    }
    pub fn observe_import_catalog(
        &self,
        proof: &AuthenticatedNativeImport,
    ) -> Result<AuthenticatedImportCatalogObservation, GatewayError> {
        proof.body.require_owner(&self.identity, self.now()?)?;
        let state = self.state(&proof.state)?.clone();
        let ResultData::Current {
            catalog_revision, ..
        } = self.exchange(Command::Current {
            state: state.clone(),
            claim_ref: None,
        })?
        else {
            return Err(unavailable());
        };
        self.check_state(&state)?;
        proof.body.require_owner(&self.identity, self.now()?)?;
        Ok(AuthenticatedImportCatalogObservation {
            revision: catalog_revision,
        })
    }
    pub fn verify_started_custody(
        &self,
        request: &ImportCustodyStartedRequest,
    ) -> Result<VerifiedCurrentImportStarted, GatewayError> {
        if self.now()? >= request.deadline_ms {
            return Err(unavailable());
        }
        let bytes = request.canonical_bytes()?;
        let wire = ImportCustodyStartedWire::parse(&bytes)?;
        let response = self.exchange_bytes(&bytes, import_custody_reply_max_bytes())?;
        let reply = ImportCustodyStartedReplyData::parse_for(&response, &wire)?;
        if self.now()? >= request.deadline_ms {
            return Err(unavailable());
        }
        Ok(VerifiedCurrentImportStarted {
            request: serde_json::from_slice(&bytes).map_err(|_| unavailable())?,
            verified_at_ms: reply.verified_at_ms,
        })
    }
    pub fn verify_custody_terminal(
        &self,
        started: &ImportCustodyStartedRequest,
        publication_revision: &str,
    ) -> Result<VerifiedCurrentImportTerminal, GatewayError> {
        if self.now()? >= started.deadline_ms {
            return Err(unavailable());
        }
        let bytes = started.canonical_bytes()?;
        let wire = ImportCustodyStartedWire::parse(&bytes)?;
        let ResultData::CustodyTerminal {
            started: echoed,
            publication_revision: revision,
            terminal,
        } = self.exchange(Command::CustodyTerminal {
            started: wire,
            publication_revision: publication_revision.into(),
        })?
        else {
            return Err(unavailable());
        };
        if self.now()? >= started.deadline_ms || echoed.bytes()? != bytes {
            return Err(unavailable());
        }
        Ok(VerifiedCurrentImportTerminal {
            request: serde_json::from_slice(&bytes).map_err(|_| unavailable())?,
            publication_revision: revision,
            terminal: *terminal,
            observed_at_ms: self.now()?,
        })
    }
    /// Attempt only the optional existing catalog cache after primary publication.
    /// Native caller retains actual validated raw body/headers and maps an actual
    /// optional error (including existing transport-frame overflow) to false.
    pub fn seed_catalog(
        &self,
        claim: &NativeImportClaim,
        terminal: &AuthenticatedImportTerminal,
        source_body: &str,
        etag: Option<&str>,
        content_type: Option<&str>,
    ) -> Result<bool, GatewayError> {
        use gateway_auth::native_import::catalog_seed::{
            IMPORT_CATALOG_SEED_OPERATION, ImportCatalogSeedReplyData,
            ImportCatalogSeedRequestData, import_catalog_seed_reply_max_bytes,
        };
        let state = self.state(&claim.state)?.clone();
        if claim.binding != terminal.binding {
            return Err(unavailable());
        }
        let Some(client_version) = terminal.completion.models.client_version.clone() else {
            return Ok(false);
        };
        let request = ImportCatalogSeedRequestData {
            operation: IMPORT_CATALOG_SEED_OPERATION.into(),
            v: 1,
            state: state.clone(),
            claim_ref: claim.binding.claim_ref.clone(),
            publication_revision: terminal.terminal.publication_revision.clone(),
            native_receipt_ref: terminal.terminal.native_receipt_ref.clone(),
            publication_request_digest: terminal.terminal.publication_request_digest.clone(),
            client_version,
            source_body: source_body.into(),
            etag: etag.map(str::to_owned),
            content_type: content_type.map(str::to_owned),
        };
        let bytes = request.bytes()?;
        let reply = self.exchange_bytes(&bytes, import_catalog_seed_reply_max_bytes())?;
        let result = ImportCatalogSeedReplyData::parse(&reply)?;
        self.check_state(&state)?;
        Ok(result.seeded)
    }
    pub fn observe_publication(
        &self,
        claim: &NativeImportClaim,
        publication_revision: &str,
        native_receipt_ref: &str,
        publication_request_digest: &str,
    ) -> Result<AuthenticatedImportTerminal, GatewayError> {
        let state = self.state(&claim.state)?.clone();
        let ResultData::Terminal {
            state,
            terminal,
            completion,
        } = self.exchange(Command::Terminal {
            state,
            claim_ref: claim.binding.claim_ref.clone(),
            publication_revision: publication_revision.into(),
            native_receipt_ref: native_receipt_ref.into(),
            publication_request_digest: publication_request_digest.into(),
        })?
        else {
            return Err(unavailable());
        };
        self.check_state(&state)?;
        Ok(AuthenticatedImportTerminal {
            binding: claim.binding.clone(),
            terminal: *terminal,
            completion,
            observed_at_ms: self.now()?,
        })
    }
}
