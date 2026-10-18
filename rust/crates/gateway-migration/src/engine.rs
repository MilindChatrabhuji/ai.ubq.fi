use crate::*;
use gateway_core::{query::{QueryRequest,QuerySelector,QueryStore}, state::{AtomicTransition,CommitOutcome,RecordMutation,RevisionCheck}};
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Clone,Deserialize,Serialize)]
pub(crate) struct Manifest {
    pub v:u32,
    pub capture_id:String,
    pub source_git_sha:String,
    pub captured_at_ms:i64,
    pub source_keys:Vec<String>,
    pub derived:BTreeMap<String,String>,
}
pub struct PreparedAdoption {
    pub(crate) manifest:Manifest,
    pub(crate) rows:Vec<Row>,
    pub(crate) derived:Vec<(RecordKey,StoredRecord)>,
}
#[derive(Clone,Debug,Deserialize,Serialize)]
pub struct AdoptionReceipt {
    pub capture_id:String,
    pub source_git_sha:String,
    pub source_rows:usize,
    pub derived_rows:usize,
    pub atomic_committed:bool,
}
pub(crate) fn manifest_key()->RecordKey {key(json!(["uos_ai","migration","v1","manifest"]))}
pub(crate) fn mapping_key(id:&str,source:&str)->RecordKey {key(json!(["uos_ai","migration","v1","row",id,source]))}

pub fn prepare(capture:&PrivateCapture,host:&dyn SourceDateHost)->Result<PreparedAdoption,GatewayError> {
    let capture_id=gateway_auth::crypto::sha256_hex(&serde_json::to_vec(capture).map_err(|_|invalid("Capture cannot be encoded"))?);
    let mut rows=capture.validate(host)?;
    for row in &mut rows {crate::projection::forward(row)?;}
    let revision=format!("capture:{capture_id}");
    let derived=crate::indexes::bind(&mut rows,capture.captured_at_ms,&revision)?;
    let mut derived_digests=BTreeMap::new();
    for (key,record) in &derived {
        if rows.iter().any(|r|r.key==*key) || derived_digests.insert(key.0.clone(),digest(record)?).is_some() {return Err(invalid("Derived schema key collides with source state"));}
    }
    for row in &mut rows {
        row.mapping.baseline_digest=digest(&row.record)?;
        // Identity values already live once at the source key. Do not duplicate historical
        // provider/refresh/session secrets in rollback metadata.
        if row.mapping.transform==Transform::Identity {row.mapping.source.value=Value::Null;}
    }
    let manifest=Manifest{v:1,capture_id,source_git_sha:capture.source_git_sha.clone(),captured_at_ms:capture.captured_at_ms,source_keys:rows.iter().map(|r|r.key.0.clone()).collect(),derived:derived_digests};
    Ok(PreparedAdoption{manifest,rows,derived})
}

/// Only for an actually isolated, empty target held quiescent by its existing host owner.
/// This API cannot prove process stoppage or fence arbitrary uncoordinated new-key writers.
/// No runtime/pubication capability is created by a committed capture.
pub async fn adopt_empty<S:QueryStore>(store:&S,prepared:&PreparedAdoption)->Result<AdoptionReceipt,GatewayError> {
    let existing=store.query(QueryRequest{selector:QuerySelector::Prefix{prefix:TupleKey::from_parts(&[])?.to_record_key(),start:None,end:None},reverse:false,limit:1,cursor:None,now_ms:0}).await?;
    if !existing.entries.is_empty() || existing.next_cursor.is_some() {return Err(invalid("Adoption target is not empty"));}
    let mut writes=Vec::new();
    for row in &prepared.rows {
        writes.push((row.key.clone(),row.record.clone()));
        writes.push((mapping_key(&prepared.manifest.capture_id,&row.key.0),StoredRecord::json(format!("capture:{}",prepared.manifest.capture_id),json(&row.mapping)?,None)));
    }
    writes.extend(prepared.derived.clone());
    writes.push((manifest_key(),StoredRecord::json(format!("capture:{}",prepared.manifest.capture_id),json(&prepared.manifest)?,None)));
    let mut checks=Vec::new();let mut mutations=Vec::new();
    for (key,record) in writes {
        if store.read(&key).await?.is_some(){return Err(invalid("Adoption target changed before commit"));}
        checks.push(RevisionCheck{key:key.clone(),expected_revision:None});mutations.push(RecordMutation::Put{key,record});
    }
    if store.commit(AtomicTransition{checks,mutations}).await?!=CommitOutcome::Committed {return Err(invalid("Adoption conflicted; no partial data was accepted"));}
    Ok(AdoptionReceipt{capture_id:prepared.manifest.capture_id.clone(),source_git_sha:prepared.manifest.source_git_sha.clone(),source_rows:prepared.rows.len(),derived_rows:prepared.derived.len(),atomic_committed:true})
}
