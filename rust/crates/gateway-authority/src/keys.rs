//! Versioned portable keys. Array encoding preserves string/number identity without legacy codecs.
use gateway_core::state::RecordKey;
use serde_json::json;

fn key(value: serde_json::Value) -> RecordKey { RecordKey(value.to_string()) }

pub fn pool() -> RecordKey { key(json!(["uos_ai","authority","v1","codex_pool"])) }
pub fn active() -> RecordKey { key(json!(["uos_ai","codex_active_account","v1"])) }
pub fn routing() -> RecordKey { key(json!(["uos_ai","codex_account_routing","v2"])) }
pub fn capacity() -> RecordKey { key(json!(["uos_ai","codex_capacity_routing","v1","observations"])) }
pub fn models() -> RecordKey { key(json!(["uos_ai","codex_account_models","v1"])) }
pub fn overage(hash: &str) -> RecordKey { key(json!(["uos_ai","codex_overage_usage","account","v1",hash])) }
pub fn reset_usage(hash: &str) -> RecordKey { key(json!(["uos_ai","codex_reset_usage","account","v1",hash])) }
pub fn api_policy(id: &str) -> RecordKey { key(json!(["uos_ai","authority","v1","api_policy",id])) }
pub fn api_window(id: &str, version: &str, start: i64) -> RecordKey { key(json!(["uos_ai","api_key_usage","v3","window",id,version,start])) }
pub fn api_request(id: &str, version: &str, start: i64, request: &str) -> RecordKey { key(json!(["uos_ai","api_key_usage","v3","request",id,version,start,request])) }
pub fn kernel_policy(owner: &str, repo: Option<&str>) -> RecordKey { match repo { Some(repo) => key(json!(["uos_ai","kernel_quota","v2","repo_policy",owner,repo])), None => key(json!(["uos_ai","kernel_quota","v2","org_policy",owner])) } }
pub fn kernel_defaults() -> RecordKey { key(json!(["uos_ai","authority","v1","kernel_defaults"])) }
pub fn kernel_cutover() -> RecordKey { key(json!(["uos_ai","kernel_quota","v2","default_window_cutover"])) }
pub fn kernel_window(owner: &str, repo: Option<&str>) -> RecordKey { match repo { Some(repo) => key(json!(["uos_ai","kernel_quota","v2","repo_window",owner,repo])), None => key(json!(["uos_ai","kernel_quota","v2","org_window",owner])) } }
pub fn kernel_request(owner: &str, repo: Option<&str>, created: i64, id: &str) -> RecordKey { match repo { Some(repo) => key(json!(["uos_ai","kernel_quota","v2","repo_reservation",owner,repo,created,id])), None => key(json!(["uos_ai","kernel_quota","v2","org_reservation",owner,created,id])) } }
pub fn paid_routing() -> RecordKey { key(json!(["uos_ai","authority","v1","paid_routing"])) }
pub fn paid_window(id: &str, reset: i64) -> RecordKey { key(json!(["uos_ai","paid_fallback","v3","window",id,reset])) }
pub fn paid_attempt(id: &str, request: &str) -> RecordKey { key(json!(["uos_ai","paid_fallback","v3","request",id,request])) }
pub fn paid_pending(id: &str, request: &str) -> RecordKey { key(json!(["uos_ai","paid_fallback","v3","pending",id,request])) }
pub fn paid_gate() -> RecordKey { key(json!(["uos_ai","paid_fallback","v3","reconciliation_gate"])) }
pub fn paid_lease(id: &str) -> RecordKey { key(json!(["uos_ai","paid_fallback","v3","reconciliation_lease",id])) }
pub fn paid_deletion(id: &str) -> RecordKey { key(json!(["uos_ai","paid_fallback","v3","deletion_guard",id])) }
pub fn paid_rollup(bucket: i64, model: &str, provider: &str, shard: u8) -> RecordKey { key(json!(["uos_ai","paid_fallback","v3","usage_rollup",bucket,model,provider,shard])) }
pub fn reset_redemption(hash: &str, generation: &str) -> RecordKey { key(json!(["uos_ai","codex_reset_redemption","v1",hash,generation])) }
pub fn reset_day(hash: &str, day: &str) -> RecordKey { key(json!(["uos_ai","codex_reset_redemption","account_day","v1",hash,day])) }
pub fn reset_config() -> RecordKey { key(json!(["uos_ai","authority","v1","codex_reset_config"])) }
pub fn reset_shadow(episode: &str) -> RecordKey { key(json!(["uos_ai","codex_reset_shadow_decision","v1",episode])) }
