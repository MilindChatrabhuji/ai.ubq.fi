//! Private readonly resource facts, never import permission or a reconstructed proof.
use super::*;
use crate::store::Transaction;
pub(in crate::native_control) async fn read<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    action_ref: &str,
) -> Result<(String, String), GatewayError> {
    let row: ImportActionRow = tx
        .read_source_control(&rows::key("action", action_ref))
        .await?
        .ok_or_else(unavailable)?;
    row.metadata.validate()?;
    row.target.validate()?;
    if !matches!(row.v, 2 | 3)
        || row.metadata.action_ref != action_ref
        || row.kind != NativeImportKind::CodexAuth
        || !matches!(&row.target,NativeImportTarget::ExistingAccount{account_id_hash}if account_id_hash==&row.facts.account_id_hash)
        || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
        || tx.now < row.created_at_ms
        || tx.now >= row.deadline_ms
    {
        return Err(unavailable());
    }
    if let Some(publication) = &row.publication {
        publication.validate()?;
        if publication.operation_id != row.metadata.operation_id {
            return Err(unavailable());
        }
    }
    Ok((row.facts.account_id_hash, row.facts.native_owner_id))
}
