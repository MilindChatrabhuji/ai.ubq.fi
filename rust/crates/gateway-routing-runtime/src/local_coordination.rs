//! Observed request coordination maintenance; no new source abort deadline.
use super::*;

impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalWorkHandle<S, I, C, H>
{
    pub async fn renew_kernel(&self) -> RoutingResult<LocalWorkLease> {
        if self.kernel.is_none() {
            return self
                .checkpoint_phase(
                    &[LocalWorkPhase::Running, LocalWorkPhase::ResponsePending],
                    None,
                    true,
                )
                .await;
        }
        self.checkpoint().await?;
        if let Some(kernel) = &self.kernel {
            let operation_at = self.now()?;
            let expiry =
                Authority::with_clock(self.store.clone(), self.tokens.clone(), self.clock.clone())
                    .renew_kernel(kernel, operation_at)
                    .await?;
            journal::change(
                &self.store,
                &self.tokens,
                self.id(),
                self.now()?,
                &[],
                |row| {
                    self.owned(row)?;
                    if self.host.cancelled()
                        || row.lease_expires_at_ms <= operation_at
                        || row.local_work.as_ref().is_none_or(|v| {
                            !matches!(
                                v.phase,
                                LocalWorkPhase::Running | LocalWorkPhase::ResponsePending
                            )
                        })
                    {
                        return Err(invalid());
                    }
                    row.kernel.as_mut().ok_or_else(invalid)?.lease_expires_at_ms = expiry;
                    row.lease_expires_at_ms = expiry;
                    Ok(())
                },
            )
            .await?;
        }
        self.checkpoint().await
    }
}
