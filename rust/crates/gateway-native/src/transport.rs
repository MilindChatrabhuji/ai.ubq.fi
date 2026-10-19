use std::future::Future;

use gateway_core::GatewayError;
use serde_json::{Value, json};

use crate::credentials::{
    NativeCredentials, NativeGeneration, NativeOwnerId, OwnerFence, generation_failed,
    owner_unavailable, verify_daemon_account, verify_generation,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorMethod {
    Initialize,
    ThreadList,
    ThreadLoadedList,
    ThreadRead,
    ThreadTurnsList,
    AccountRateLimitsRead,
}
impl SupervisorMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::ThreadList => "thread/list",
            Self::ThreadLoadedList => "thread/loaded/list",
            Self::ThreadRead => "thread/read",
            Self::ThreadTurnsList => "thread/turns/list",
            Self::AccountRateLimitsRead => "account/rateLimits/read",
        }
    }
    pub fn parse(value: &str) -> Result<Self, GatewayError> {
        match value {
            "initialize" => Ok(Self::Initialize),
            "thread/list" => Ok(Self::ThreadList),
            "thread/loaded/list" => Ok(Self::ThreadLoadedList),
            "thread/read" => Ok(Self::ThreadRead),
            "thread/turns/list" => Ok(Self::ThreadTurnsList),
            "account/rateLimits/read" => Ok(Self::AccountRateLimitsRead),
            _ => Err(GatewayError::new(
                403,
                "Supervisor method is not read-only",
                Some("native_capability_forbidden"),
            )),
        }
    }
}

/// Implemented only by a locally configured transport. No caller-selected socket/path/URL.
pub trait SupervisorTransport {
    fn call(
        &mut self,
        method: SupervisorMethod,
        params: Value,
    ) -> impl Future<Output = Result<Value, GatewayError>>;
    fn close(&mut self) -> impl Future<Output = Result<(), GatewayError>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenewalStep {
    Initialize,
    IdentityRead,
    RefreshRead,
}
impl RenewalStep {
    pub fn wire(self) -> (&'static str, Value) {
        match self {
            Self::Initialize => (
                "initialize",
                json!({"clientInfo":{"name":"uos_native_auth","version":"1"},"capabilities":{"experimentalApi":true}}),
            ),
            Self::IdentityRead => ("account/read", json!({"refreshToken":false})),
            Self::RefreshRead => ("account/read", json!({"refreshToken":true})),
        }
    }
}

/// Separate type from supervisor. Implementations resolve a fixed home from owner ID and enforce OS policy.
pub trait NativeOwnerTransport {
    fn read_credentials(
        &self,
        owner: &NativeOwnerId,
    ) -> impl Future<Output = Result<NativeCredentials, GatewayError>>;
    fn request(
        &self,
        owner: &NativeOwnerId,
        step: RenewalStep,
    ) -> impl Future<Output = Result<Value, GatewayError>>;
    fn verify_initialized_home(
        &self,
        owner: &NativeOwnerId,
        reply: &Value,
    ) -> impl Future<Output = Result<(), GatewayError>>;
    fn initialized(&self, owner: &NativeOwnerId) -> impl Future<Output = Result<(), GatewayError>>;
    fn close(&self, owner: &NativeOwnerId) -> impl Future<Output = Result<(), GatewayError>>;
}

pub async fn renew_owned<T: NativeOwnerTransport>(
    transport: &T,
    fence: OwnerFence,
    current: &NativeCredentials,
    now_ms: i64,
) -> Result<NativeGeneration, GatewayError> {
    if current.generation_hash() != fence.generation_hash || current.account_id != fence.account_id
    {
        return Err(crate::credentials::owner_conflict());
    }
    let mut observed = transport.read_credentials(&fence.owner).await?;
    if current.account_id != observed.account_id {
        return Err(crate::credentials::owner_conflict());
    }
    if !current.same_credentials(&observed) {
        verify_generation(current, &observed, now_ms, false)?;
        if observed
            .access_expires_at_ms()
            .is_some_and(|expiry| expiry > now_ms.saturating_add(120_000))
        {
            verify_generation(current, &observed, now_ms, true)?;
            return Ok(NativeGeneration {
                fence,
                credentials: observed,
                observed_at_ms: now_ms,
            });
        }
    }
    if observed.external_user_id.is_some() || current.external_user_id.is_some() {
        return Err(owner_unavailable());
    }
    let email = observed.email.as_deref().ok_or_else(owner_unavailable)?;
    let result = async {
        let initialized = transport
            .request(&fence.owner, RenewalStep::Initialize)
            .await?;
        transport
            .verify_initialized_home(&fence.owner, &initialized)
            .await?;
        transport.initialized(&fence.owner).await?;
        let identity = transport
            .request(&fence.owner, RenewalStep::IdentityRead)
            .await?;
        verify_daemon_account(
            &identity,
            email,
            &fence.account_id,
            Some(&observed.account_id),
        )?;
        // A successful reply is not a credential-generation receipt.
        transport
            .request(&fence.owner, RenewalStep::RefreshRead)
            .await?;
        Ok::<(), GatewayError>(())
    }
    .await;
    let close = transport.close(&fence.owner).await;
    result?;
    close?;
    observed = transport.read_credentials(&fence.owner).await?;
    if current.same_credentials(&observed) {
        return Err(generation_failed());
    }
    verify_generation(current, &observed, now_ms, true)?;
    Ok(NativeGeneration {
        fence,
        credentials: observed,
        observed_at_ms: now_ms,
    })
}

/// Source renewal with current shared-authority checks around every awaited
/// owner boundary and one durable possible-effect claim before refresh RPC.
pub async fn renew_owned_guarded<
    T: NativeOwnerTransport,
    G: crate::owner_control::NativeRenewalGuard,
>(
    transport: &T,
    guard: &G,
    fence: OwnerFence,
    current: &NativeCredentials,
) -> Result<NativeGeneration, GatewayError> {
    guard.ensure_current().await?;
    let checked = GuardedOwnerTransport {
        transport,
        guard,
        current,
        advanced: std::cell::Cell::new(false),
    };
    let result = renew_owned(&checked, fence.clone(), current, guard.now_ms()?).await;
    let mut generation = if checked.advanced.get() {
        // The fixed file advanced while the readonly handshake was running.
        // No refresh RPC was dispatched. Independently reread and validate it.
        guard.ensure_current().await?;
        let credentials = transport.read_credentials(&fence.owner).await?;
        guard.ensure_current().await?;
        verify_generation(current, &credentials, guard.now_ms()?, true)?;
        NativeGeneration {
            fence,
            credentials,
            observed_at_ms: guard.now_ms()?,
        }
    } else {
        result?
    };
    guard.ensure_current().await?;
    generation.observed_at_ms = guard.now_ms()?;
    verify_generation(
        current,
        &generation.credentials,
        generation.observed_at_ms,
        true,
    )?;
    Ok(generation)
}

struct GuardedOwnerTransport<'a, T, G> {
    transport: &'a T,
    guard: &'a G,
    current: &'a NativeCredentials,
    advanced: std::cell::Cell<bool>,
}
impl<T: NativeOwnerTransport, G: crate::owner_control::NativeRenewalGuard> NativeOwnerTransport
    for GuardedOwnerTransport<'_, T, G>
{
    async fn read_credentials(
        &self,
        owner: &NativeOwnerId,
    ) -> Result<NativeCredentials, GatewayError> {
        self.guard.ensure_current().await?;
        let value = self.transport.read_credentials(owner).await?;
        self.guard.ensure_current().await?;
        Ok(value)
    }
    async fn request(
        &self,
        owner: &NativeOwnerId,
        step: RenewalStep,
    ) -> Result<Value, GatewayError> {
        self.guard.ensure_current().await?;
        if step == RenewalStep::RefreshRead {
            let observed = self.transport.read_credentials(owner).await?;
            self.guard.ensure_current().await?;
            if !self.current.same_credentials(&observed) {
                verify_generation(self.current, &observed, self.guard.now_ms()?, true)?;
                self.advanced.set(true);
                return Err(crate::credentials::owner_conflict());
            }
            self.guard.start_refresh().await?;
            self.guard.ensure_current().await?;
        }
        let value = self.transport.request(owner, step).await?;
        self.guard.ensure_current().await?;
        Ok(value)
    }
    async fn verify_initialized_home(
        &self,
        owner: &NativeOwnerId,
        reply: &Value,
    ) -> Result<(), GatewayError> {
        self.guard.ensure_current().await?;
        self.transport.verify_initialized_home(owner, reply).await?;
        self.guard.ensure_current().await
    }
    async fn initialized(&self, owner: &NativeOwnerId) -> Result<(), GatewayError> {
        self.guard.ensure_current().await?;
        self.transport.initialized(owner).await?;
        self.guard.ensure_current().await
    }
    async fn close(&self, owner: &NativeOwnerId) -> Result<(), GatewayError> {
        // Closing an owned transport must remain possible after cancellation,
        // owner replacement or an unknown upstream outcome.
        self.transport.close(owner).await
    }
}
