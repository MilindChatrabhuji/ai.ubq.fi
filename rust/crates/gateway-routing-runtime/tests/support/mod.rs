use std::{collections::{BTreeMap,BTreeSet},future::Future,sync::{Arc,Mutex,atomic::{AtomicI64,AtomicU64,AtomicBool,Ordering}},task::{Context,Poll,Waker}};
use gateway_auth::{AuthPrincipal,AuthMethod,crypto::Secret};
use gateway_authority::{AuthorityClock,TokenSource,keys,paid::{PaidReservation,PaidUsage},routing::{CohortProof,SubscriptionPool,PoolAccount}};
use gateway_core::{GatewayError,identity::{ApiKeyId,RequestId,RequestContext,PrincipalId,RoutingAccountHash,SubscriptionSelectionHash,CredentialVersion,PoolVersionstamp},state::{AuthorityStore,RecordKey,StoredRecord,RecordMutation,AtomicTransition,CommitOutcome},query::{QueryStore,QueryRequest,QueryPage,QueryEntry},tuple_key::TupleKey};
use gateway_providers::{AuthMaterial,PrepareOptions,ClientSurface};
use gateway_routing_runtime::*;
use gateway_schema::{catalog::{CatalogInput,ProviderCatalog},snapshot::ModelSnapshot};
use serde::Serialize;
use serde_json::{Value,json};
pub const NOW:i64=1_800_000_000_000;
#[derive(Clone)]
pub struct Store{rows:Arc<Mutex<BTreeMap<String,StoredRecord>>>,now:Arc<AtomicI64>,sequence:Arc<AtomicU64>}
impl Store {
    pub fn new()->Self{Self{rows:Arc::new(Mutex::new(BTreeMap::new())),now:Arc::new(AtomicI64::new(NOW)),sequence:Arc::new(AtomicU64::new(1))}}
    pub fn seed<T:Serialize>(&self,key:RecordKey,value:T){let revision=self.next_token().unwrap();self.rows.lock().unwrap().insert(key.0,StoredRecord::json(revision,serde_json::to_value(value).unwrap(),None));}
    pub fn value(&self,key:RecordKey)->Value{self.rows.lock().unwrap().get(&key.0).map(|r|r.json_value().unwrap().clone()).unwrap_or(Value::Null)}
    pub fn advance(&self,by:i64){self.now.fetch_add(by,Ordering::SeqCst);}
}
impl AuthorityClock for Store{fn now_ms(&self)->Result<i64,GatewayError>{Ok(self.now.load(Ordering::SeqCst))}}
impl TokenSource for Store{fn next_token(&self)->Result<String,GatewayError>{Ok(format!("fixture-{}",self.sequence.fetch_add(1,Ordering::SeqCst)))}}
impl AuthorityStore for Store{
    async fn read(&self,key:&RecordKey)->Result<Option<StoredRecord>,GatewayError>{TupleKey::from_record_key(key)?.validate_stored_key()?;Ok(self.rows.lock().unwrap().get(&key.0).filter(|r|r.expires_at_ms.is_none_or(|e|e>self.now.load(Ordering::SeqCst))).cloned())}
    async fn commit(&self,transition:AtomicTransition)->Result<CommitOutcome,GatewayError>{
        let mut rows=self.rows.lock().unwrap();let now=self.now.load(Ordering::SeqCst);
        let mut checks=BTreeSet::new();for check in transition.checks{assert!(checks.insert(check.key.0.clone()),"duplicate CAS key");if rows.get(&check.key.0).filter(|r|r.expires_at_ms.is_none_or(|e|e>now)).map(|r|r.revision.clone())!=check.expected_revision{return Ok(CommitOutcome::Conflict);}}
        let mut keys=BTreeSet::new();for mutation in &transition.mutations{let key=match mutation{RecordMutation::Put{key,record}=>{record.validate_version()?;key},RecordMutation::Delete{key}=>key};TupleKey::from_record_key(key)?.validate_stored_key()?;assert!(keys.insert(key.0.clone()),"duplicate mutation");}
        for mutation in transition.mutations{match mutation{RecordMutation::Put{key,record}=>{rows.insert(key.0,record);},RecordMutation::Delete{key}=>{rows.remove(&key.0);}}}Ok(CommitOutcome::Committed)
    }
}
impl QueryStore for Store{
    async fn query(&self,request:QueryRequest)->Result<QueryPage,GatewayError>{let query=request.validate()?;let mut rows:Vec<_>=self.rows.lock().unwrap().iter().map(|(k,v)|QueryEntry{key:RecordKey(k.clone()),record:v.clone()}).collect();rows.sort_by_key(|r|TupleKey::from_record_key(&r.key).unwrap().sort_bytes().to_vec());if request.reverse{rows.reverse();}let mut accepted=vec![];for row in rows{if query.accepts_record(&row.key,&row.record)?{accepted.push(row);}}
        let more=accepted.len()>request.limit as usize;accepted.truncate(request.limit as usize);let next_cursor=if more{accepted.last().map(|r|query.cursor_after(&r.key)).transpose()?}else{None};Ok(QueryPage{entries:accepted,next_cursor})}
}
pub fn run<F:Future>(future:F)->F::Output{let mut future=std::pin::pin!(future);let mut context=Context::from_waker(Waker::noop());loop{match future.as_mut().poll(&mut context){Poll::Ready(result)=>return result,Poll::Pending=>std::thread::yield_now()}}}
pub fn seed_key(store:&Store){store.seed(keys::api_policy("key-a"),gateway_authority::quota::ApiKeyPolicy{v:3,key_id:ApiKeyId("key-a".into()),expires_at_ms:-1,usage_limit_requests:10,window_ms:gateway_authority::DAY_MS,usage_reset_at_ms:NOW+gateway_authority::DAY_MS,paid_fallback_enabled:true,paid_fallback_limit_microcredits:10000,paid_fallback_quota_per_credit:1000000,paid_fallback_pricing_checked_at_ms:NOW,paid_fallback_models:vec!["gpt-test".into(),"paid-model".into(),"deepseek-v4.1-flash".into()],paid_fallback_max_exposure_microcredits:BTreeMap::from([("gpt-test".into(),1000),("paid-model".into(),1000),("deepseek-v4.1-flash".into(),1000)])});}
pub fn seed_pool(store:&Store){store.seed(keys::pool(),SubscriptionPool{v:1,pool_versionstamp:PoolVersionstamp("pool-original".into()),accounts:["a","b"].map(|id|PoolAccount{account_id_hash:RoutingAccountHash(format!("route-{id}")),admin_account_hash:SubscriptionSelectionHash(format!("admin-{id}")),credential_version:CredentialVersion(format!("credential-{id}")),enabled:true}).to_vec()});store.seed(source_key(),json!({"fixture_owner":"native","generation":1}));}
pub fn source_key()->RecordKey{gateway_auth::provider_credentials::codex_source_pool_key()}
pub fn window(store:&Store)->Value{store.value(keys::api_window("key-a",&format!("v3:{}",gateway_authority::DAY_MS),NOW))}
pub fn input(id:&str,model:&str,providers:&[&str])->RoutingInput{
    let principal=AuthPrincipal{token:None,method:AuthMethod::KvApiKey{key_id:"key-a".into(),policy:gateway_auth::api_keys::ApiKeyPolicy{token_hash:"fixture".into(),key_id:"key-a".into(),expires_at_ms:-1,usage_limit_requests:10,window_ms:gateway_authority::DAY_MS,window_start_ms:NOW,usage_reset_at_ms:NOW+gateway_authority::DAY_MS,policy_version:format!("v3:{}",gateway_authority::DAY_MS),paid_fallback_enabled:true,paid_fallback_limit_microcredits:10000,paid_fallback_spent_microcredits:0,paid_fallback_reserved_microcredits:0,paid_fallback_reservation_request_id:None}},is_admin:false,is_super_admin:false};
    let mut catalog=CatalogInput::default();for provider in providers{catalog.providers.insert((*provider).into(),ProviderCatalog{configured:true,available:true,..Default::default()});}
    catalog.full_snapshot=Some(ModelSnapshot{models:vec![json!({"slug":"gpt-test","supported_reasoning_levels":[{"effort":"none"},{"effort":"high"},{"effort":"ultra"}],"default_reasoning_level":"none"})],source:"fixture".into(),updated_at_ms:NOW,client_version:Some("0.163.0".into())});
    RoutingInput{context:RequestContext{request_id:RequestId(id.into()),principal:PrincipalId("fixture-principal".into()),key_id:Some(ApiKeyId("key-a".into())),route:"responses".into(),started_at_ms:NOW},principal,raw:json!({"model":model,"input":"source fixture","reasoning":{"effort":"none"}}),surface:ClientSurface::Responses,catalog,runtime:None,client_version:"0.163.0".into(),native_session_id:None,retry_prohibited:false}
}
#[derive(Clone)]
pub struct Host{pub store:Store,pub cancelled:Arc<AtomicBool>}
impl Host{pub fn new(store:&Store)->Self{Self{store:store.clone(),cancelled:Arc::new(AtomicBool::new(false))}}}
impl RoutingHost for Host{
    fn cancelled(&self)->bool{self.cancelled.load(Ordering::SeqCst)}
    fn cancellation_error(&self)->GatewayError{GatewayError::new(499,"fixture cancelled",Some("fixture_cancelled"))}
    async fn wait(&self,milliseconds:i64)->Result<(),GatewayError>{self.store.advance(milliseconds);Ok(())}
    async fn credential(&self,input:CredentialRequest)->Result<PublishedCredential,GatewayError>{if let Some(admission)=input.codex{let source=self.store.read(&source_key()).await?.unwrap();Ok(PublishedCredential{material:AuthMaterial{secret:"fixture-access-only".into(),account_id:Some("fixture-account".into()),..Default::default()},fence:CredentialFence::Codex{admission,source_key:source_key(),source_revision:source.revision,native_generation:"fixture-generation".into()},options:PrepareOptions::default()})}else{Ok(direct_credential(input.provider,&Secret::new("fixture-secret".into())))}}
    async fn ensure_credential_current(&self,fence:&CredentialFence,_principal:&AuthPrincipal,_model:&str)->Result<(),GatewayError>{if let CredentialFence::Codex{source_key,source_revision,..}=fence{if self.store.read(source_key).await?.as_ref().map(|r|&r.revision)!=Some(source_revision){return Err(GatewayError::unavailable("fixture publication changed","fixture_generation_changed"));}}Ok(())}
    async fn refresh_codex(&self,_fence:&CredentialFence)->Result<RefreshOutcome,GatewayError>{Ok(RefreshOutcome::Unavailable)}
    async fn select_claude(&self,_principal:&AuthPrincipal,_model:&str,_raw:&Value)->Result<ClaudeSelection,GatewayError>{Ok(ClaudeSelection::NotApplicable)}
    async fn record_claude_refusal(&self,_fence:&CredentialFence,_model:&str,_failure:&AttemptFailure)->Result<bool,GatewayError>{Err(GatewayError::unavailable("fixture does not supply Claude proof","fixture_capability_unavailable"))}
    async fn recover_codex(&self,_proof:&CohortProof,_model:&str)->Result<CodexRecovery,GatewayError>{Ok(CodexRecovery::Declined)}
    async fn lookup_paid(&self,_reservation:&PaidReservation)->Result<Option<PaidUsage>,GatewayError>{Ok(None)}
}
