//! Only fixed native files are decoded here. No receipt constructor is public.
use super::*;
use gateway_auth::{
    crypto::Secret,
    native_credentials::{NativeCredentials, parse_native_document},
};
use rustix::fs::{Mode, OFlags, fstat, openat};
use serde::{Deserialize, Serialize};
use std::{io::Read, path::Component};
const AUTH_LIMIT: u64 = 1_048_576;
const RECEIPT_LIMIT: u64 = 4096;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReceiptWire {
    v: u8,
    operation_id: String,
    action_ref: String,
    claim_ref: String,
    native_owner_id: String,
    account_id_hash: String,
    previous_native_generation: String,
    native_generation: String,
    original_document_sha256: String,
    persisted_document_sha256: String,
}
/// Native-only private proof of one actual durable file write and matching reread.
/// No Debug/Clone/Serialize/Deserialize or public constructor.
/// ```compile_fail
/// use gateway_native::existing_account_import::DurableNativeImport;
/// let forged: DurableNativeImport = serde_json::from_str("{}").unwrap();
/// ```
pub struct DurableNativeImport {
    binding: NativeImportBinding,
    receipt: ReceiptWire,
    credentials: NativeCredentials,
}
impl DurableNativeImport {
    pub(super) fn binding(&self) -> &NativeImportBinding {
        &self.binding
    }
    pub fn native_generation(&self) -> &str {
        &self.receipt.native_generation
    }
    /// This nonsecret reference contains no original/persisted document digest.
    pub fn receipt_ref(&self) -> String {
        sha256_hex(
            format!(
                "uos-native-import-receipt-v1\n{}\n{}\n{}\n{}",
                self.binding.operation_id,
                self.binding.action_ref,
                self.binding.claim_ref,
                self.receipt.native_generation
            )
            .as_bytes(),
        )
    }
    pub fn account_id_hash(&self) -> String {
        self.credentials.routing_account_hash()
    }
}
pub(super) fn open_home(home: &Path) -> Result<File, GatewayError> {
    if !home.is_absolute() {
        return Err(unavailable());
    }
    let mut directory = File::from(
        openat(
            rustix::fs::CWD,
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| unavailable())?,
    );
    for component in home.components() {
        match component {
            Component::RootDir => (),
            Component::Normal(name) => {
                directory = File::from(
                    openat(
                        &directory,
                        name,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(|_| unavailable())?,
                );
            }
            _ => return Err(unavailable()),
        }
    }
    let stat = fstat(&directory).map_err(|_| unavailable())?;
    if stat.st_mode & 0o077 != 0 {
        return Err(unavailable());
    }
    Ok(directory)
}
fn read_fixed(directory: &File, name: &str, limit: u64) -> Result<Vec<u8>, GatewayError> {
    let file = File::from(
        openat(
            directory,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| unavailable())?,
    );
    let parent = fstat(directory).map_err(|_| unavailable())?;
    let stat = fstat(&file).map_err(|_| unavailable())?;
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
        || stat.st_uid != parent.st_uid
        || stat.st_mode & 0o077 != 0
        || stat.st_nlink != 1
        || stat.st_size < 0
        || stat.st_size as u64 > limit
    {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 > limit {
        return Err(unavailable());
    }
    Ok(bytes)
}
fn receipt_name(action_ref: &str) -> Result<String, GatewayError> {
    if !gateway_auth::provider_credentials::valid_native_generation(action_ref) {
        return Err(unavailable());
    }
    Ok(format!(".uos-import-{action_ref}.receipt"))
}
fn credentials(raw: &[u8]) -> Result<NativeCredentials, GatewayError> {
    let document = serde_json::from_slice(raw).map_err(|_| unavailable())?;
    parse_native_document(&document).map_err(|_| unavailable())
}
pub(super) fn reconcile(
    store: &ExistingAccountImportStore,
    binding: &NativeImportBinding,
    original_sha256: &str,
) -> Result<DurableNativeImport, GatewayError> {
    let home = open_home(&store.home)?;
    let current_home = fstat(&home).map_err(|_| unavailable())?;
    let configured_home = fstat(&store.directory).map_err(|_| unavailable())?;
    if current_home.st_dev != configured_home.st_dev
        || current_home.st_ino != configured_home.st_ino
    {
        return Err(unavailable());
    }
    let wire: ReceiptWire = serde_json::from_slice(&read_fixed(
        &store.directory,
        &receipt_name(&binding.action_ref)?,
        RECEIPT_LIMIT,
    )?)
    .map_err(|_| unavailable())?;
    if wire.v != 1
        || wire.action_ref != binding.action_ref
        || wire.operation_id != binding.operation_id
        || wire.claim_ref != binding.claim_ref
        || wire.native_owner_id != binding.native_owner_id
        || wire.account_id_hash != binding.account_id_hash
        || wire.previous_native_generation != binding.source_native_generation
        || wire.original_document_sha256 != original_sha256
    {
        return Err(unavailable());
    }
    for hash in [
        &wire.native_generation,
        &wire.persisted_document_sha256,
        &wire.original_document_sha256,
    ] {
        if !gateway_auth::provider_credentials::valid_native_generation(hash) {
            return Err(unavailable());
        }
    }
    let bytes = read_fixed(&store.directory, "auth.json", AUTH_LIMIT)?;
    let credentials = credentials(&bytes)?;
    if sha256_hex(&bytes) != wire.persisted_document_sha256
        || credentials.generation_hash() != wire.native_generation
        || credentials.routing_account_hash() != binding.account_id_hash
        || credentials.external_user_id.is_some()
        || credentials.refresh_token == Secret::new(String::new())
    {
        return Err(unavailable());
    }
    // Reopen both fixed names after credential parsing; no old open inode can masquerade as current custody.
    let second_receipt = read_fixed(
        &store.directory,
        &receipt_name(&binding.action_ref)?,
        RECEIPT_LIMIT,
    )?;
    let second: ReceiptWire = serde_json::from_slice(&second_receipt).map_err(|_| unavailable())?;
    if serde_json::to_vec(&wire).map_err(|_| unavailable())?
        != serde_json::to_vec(&second).map_err(|_| unavailable())?
        || read_fixed(&store.directory, "auth.json", AUTH_LIMIT)? != bytes
    {
        return Err(unavailable());
    }
    Ok(DurableNativeImport {
        binding: binding.clone(),
        receipt: wire,
        credentials,
    })
}
pub(super) fn recheck(
    store: &ExistingAccountImportStore,
    receipt: &DurableNativeImport,
) -> Result<(), GatewayError> {
    let current = reconcile(
        store,
        &receipt.binding,
        &receipt.receipt.original_document_sha256,
    )?;
    if current.receipt_ref() != receipt.receipt_ref()
        || !current.credentials.same_credentials(&receipt.credentials)
    {
        return Err(unavailable());
    }
    Ok(())
}

// There is deliberately NO production writer: the existing daemon does not participate
// in an import lock. Only the actual fresh, exclusively task-owned synthetic fixture can
// invoke this issuer; it does not establish operator/live native-writer exclusion.
#[cfg(test)]
pub(super) fn issue_fixture(
    store: &ExistingAccountImportStore,
    start: gateway_authority::native_control::import::NativeImportStart<'_>,
    proof: &AuthenticatedNativeImport,
    original_body: &[u8],
    context: &crate::native_import::NativeImportContext<'_>,
    now_ms: i64,
) -> Result<DurableNativeImport, GatewayError> {
    use std::io::Write;
    context.check_document(proof, proof.metadata(), original_body)?;
    start.require_body(original_body, now_ms)?;
    let binding = start.binding();
    store.require_binding(binding)?;
    if proof.metadata().action_ref != binding.action_ref
        || proof.metadata().operation_id != binding.operation_id
    {
        return Err(unavailable());
    }
    let original_sha256 = sha256_hex(original_body);
    let document: serde_json::Value = context
        .auth_data()
        .auth()
        .deserialize()
        .map_err(|_| unavailable())?;
    use rustix::fs::{AtFlags, fsync, renameat, unlinkat};
    let previous_bytes = read_fixed(&store.directory, "auth.json", AUTH_LIMIT)?;
    let previous = credentials(&previous_bytes)?;
    let next = parse_native_document(&document).map_err(|_| unavailable())?;
    if previous.generation_hash() != binding.source_native_generation
        || previous.routing_account_hash() != binding.account_id_hash
        || next.account_id != previous.account_id
        || next.external_user_id.is_some()
    {
        return Err(unavailable());
    }
    let mut merged: serde_json::Value =
        serde_json::from_slice(&previous_bytes).map_err(|_| unavailable())?;
    let object = merged.as_object_mut().ok_or_else(unavailable)?;
    let incoming = document.as_object().ok_or_else(unavailable)?;
    // Only this one account's credential fields change; independent API keys/fields remain byte-value identical.
    for field in ["tokens", "last_refresh", "auth_mode"] {
        if let Some(value) = incoming.get(field) {
            object.insert(field.into(), value.clone());
        } else if field != "tokens" {
            object.remove(field);
        }
    }
    let bytes = serde_json::to_vec(&merged).map_err(|_| unavailable())?;
    if bytes.len() as u64 > AUTH_LIMIT {
        return Err(unavailable());
    }
    let temp_name = format!(".uos-import-{}.tmp", binding.action_ref);
    let create = |name: &str| {
        openat(
            &store.directory,
            name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map(File::from)
        .map_err(|_| unavailable())
    };
    let mut file = create(&temp_name)?;
    file.write_all(&bytes).map_err(|_| unavailable())?;
    file.sync_all().map_err(|_| unavailable())?;
    if read_fixed(&store.directory, "auth.json", AUTH_LIMIT)? != previous_bytes {
        return Err(unavailable());
    }
    // Keep the displaced credentials native-private even if a later sync/receipt step is uncertain.
    let previous_name = format!(".uos-import-{}.previous", binding.action_ref);
    rustix::fs::linkat(
        &store.directory,
        "auth.json",
        &store.directory,
        &previous_name,
        AtFlags::empty(),
    )
    .map_err(|_| unavailable())?;
    fsync(&store.directory).map_err(|_| unavailable())?;
    renameat(&store.directory, &temp_name, &store.directory, "auth.json")
        .map_err(|_| unavailable())?;
    fsync(&store.directory).map_err(|_| unavailable())?;
    if read_fixed(&store.directory, "auth.json", AUTH_LIMIT)? != bytes {
        return Err(unavailable());
    }
    let persisted = credentials(&bytes)?;
    let wire = ReceiptWire {
        v: 1,
        operation_id: binding.operation_id.clone(),
        action_ref: binding.action_ref.clone(),
        claim_ref: binding.claim_ref.clone(),
        native_owner_id: binding.native_owner_id.clone(),
        account_id_hash: binding.account_id_hash.clone(),
        previous_native_generation: binding.source_native_generation.clone(),
        native_generation: persisted.generation_hash(),
        original_document_sha256: original_sha256.clone(),
        persisted_document_sha256: sha256_hex(&bytes),
    };
    let name = receipt_name(&binding.action_ref)?;
    let receipt_temp = format!("{name}.tmp");
    let mut receipt = create(&receipt_temp)?;
    receipt
        .write_all(&serde_json::to_vec(&wire).map_err(|_| unavailable())?)
        .map_err(|_| unavailable())?;
    receipt.sync_all().map_err(|_| unavailable())?;
    // Link without replacement: an existing receipt cannot be overwritten, including after uncertainty.
    rustix::fs::linkat(
        &store.directory,
        &receipt_temp,
        &store.directory,
        &name,
        AtFlags::empty(),
    )
    .map_err(|_| unavailable())?;
    unlinkat(&store.directory, &receipt_temp, AtFlags::empty()).map_err(|_| unavailable())?;
    fsync(&store.directory).map_err(|_| unavailable())?;
    reconcile(store, binding, &original_sha256)
}
