//! Routing policy only. Authoritative pool/credential/paid admission remains external.
use gateway_core::provider::{PaidProvider, UpstreamProvider};
use serde_json::Value;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HopFailure { Status(u16), Transport, StreamBeforeSemantic, Cancelled, Deadline }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HopDecision { Advance, Deliver, Abort }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeepseekHop { Lithos, Deepseek, Openrouter, Surplus, Openlux }
pub const DEEPSEEK_ORDER: [DeepseekHop;5] = [DeepseekHop::Lithos,DeepseekHop::Deepseek,DeepseekHop::Openrouter,DeepseekHop::Surplus,DeepseekHop::Openlux];
pub fn deepseek_decision(failure: HopFailure, semantic_committed: bool) -> HopDecision {
    match failure {
        HopFailure::Cancelled|HopFailure::Deadline => HopDecision::Abort,
        _ if semantic_committed => HopDecision::Deliver,
        HopFailure::Status(status) if status>=500 || [429,402,403].contains(&status) => HopDecision::Advance,
        HopFailure::Transport|HopFailure::StreamBeforeSemantic => HopDecision::Advance,
        _ => HopDecision::Deliver,
    }
}
pub fn paid_should_advance(status: Option<u16>, has_later_tier: bool) -> bool { has_later_tier && matches!(status,Some(402|429)) }
pub fn codex_paid_fallback_reason(status:u16, trusted_error:Option<&str>) -> Option<&'static str> {
    match (status,trusted_error) { (429,Some("codex_quota_blocked")) => Some("primary_quota_blocked"), (401|503,Some("codex_subscriptions_unavailable"))=>Some("primary_subscriptions_unavailable"), _=>None }
}
pub fn paid_order(surplus:bool,openlux:bool) -> Vec<PaidProvider> { [surplus.then_some(PaidProvider::Surplus),openlux.then_some(PaidProvider::Metered)].into_iter().flatten().collect() }
pub fn paid_hop_identity(request_id:&str,provider:PaidProvider)->String { format!("{request_id}:deepseek_waterfall:{}",if provider==PaidProvider::Surplus {"surplus"} else {"openlux"}) }
pub fn response_has_answer(value:&Value) -> bool { value.get("output").and_then(Value::as_array).is_some_and(|items|items.iter().any(item_has_answer)) }
pub fn item_has_answer(item:&Value)->bool {
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "reasoning"=>false,
        "function_call"|"custom_tool_call"=> nonempty(item.get("call_id")) && nonempty(item.get("name")) && (item.get("arguments").is_some_and(Value::is_string)||item.get("input").is_some_and(Value::is_string)),
        "code_interpreter_call"|"computer_call"|"file_search_call"|"image_generation_call"|"mcp_call"|"web_search_call"=>matches!(item.get("status").and_then(Value::as_str),Some("in_progress"|"completed"|"failed")),
        _=>item.get("content").and_then(Value::as_array).is_some_and(|parts|parts.iter().any(|p|nonempty(p.get("text"))||nonempty(p.get("refusal"))))
    }
}
fn nonempty(value:Option<&Value>)->bool { value.and_then(Value::as_str).is_some_and(|v|!v.is_empty()) }
pub fn semantic_event(event:&Value)->bool {
    let kind=event.get("type").and_then(Value::as_str).unwrap_or("");
    if ["response.output_text.delta","response.output_text.done","response.refusal.delta","response.refusal.done"].contains(&kind) { return nonempty(event.get("delta")) || nonempty(event.get("text")) || nonempty(event.get("refusal")); }
    if kind=="response.image_generation_call.partial_image" { return nonempty(event.get("partial_image_b64")); }
    if ["response.output_item.added","response.output_item.done"].contains(&kind) { return event.get("item").is_some_and(item_has_answer); }
    if kind=="response.completed"||kind=="response.output" { return event.get("response").is_some_and(response_has_answer)||response_has_answer(event); }
    ["code_interpreter_call","computer_call","file_search_call","image_generation_call","mcp_call","web_search_call"].iter().any(|tool|["completed","in_progress","failed"].iter().any(|status|kind==format!("response.{tool}.{status}")))
}
pub fn reasoning_progress(event:&Value)->bool { let kind=event.get("type").and_then(Value::as_str).unwrap_or(""); kind.starts_with("response.reasoning") && (nonempty(event.get("delta"))||nonempty(event.get("text"))||event.get("part").is_some_and(|p|nonempty(p.get("text")))) }
pub fn chat_has_answer(value:&Value)->bool { value.get("choices").and_then(Value::as_array).is_some_and(|choices| choices.iter().any(|c| { let m=c.get("message").or_else(||c.get("delta")).unwrap_or(&Value::Null);nonempty(m.get("content"))||nonempty(m.get("refusal"))||m.get("tool_calls").and_then(Value::as_array).is_some_and(|t|!t.is_empty()) })) }
/// Lithos refusal windows are per rung, not one deadline per original request model.
#[derive(Clone, Debug, Default)]
pub struct LithosWindows { deadlines: std::collections::BTreeMap<String,i64> }
pub fn lithos_ladder(model:&str)->Vec<String> { let family= if model.starts_with("deepseek-ai/DeepSeek-V4.1-Flash") {"deepseek-ai/DeepSeek-V4.1-Flash"} else if model.starts_with("moonshotai/Kimi-K3") {"moonshotai/Kimi-K3"} else {return vec![]}; if model==format!("{family}-ultra") {vec![format!("{family}-fast"),family.into()]} else if model==format!("{family}-fast") {vec![family.into()]} else {vec![]} }
impl LithosWindows {
    pub fn refuse(&mut self,rung:&str,now:i64,wait_ms:i64) { if wait_ms>0 {if let Some(deadline)=now.checked_add(wait_ms) {let row=self.deadlines.entry(rung.into()).or_insert(deadline);*row=(*row).max(deadline);}} }
    pub fn select(&self,model:&str,now:i64)->String { std::iter::once(model.to_owned()).chain(lithos_ladder(model)).find(|r|self.deadlines.get(r).is_none_or(|d|*d<=now)).unwrap_or_else(||model.to_owned()) }
}
#[derive(Clone,Copy,Debug)]
pub struct WaitBudget { pub waits:u8,pub waited_ms:i64,pub streamed:bool }
impl WaitBudget { pub fn claim(&mut self,wait_ms:i64,retry_prohibited:bool)->bool { let(max_waits,total)=if self.streamed{(5,300_000)}else{(2,120_000)}; if retry_prohibited||wait_ms<=0||wait_ms>75_000||self.waits>=max_waits||self.waited_ms.saturating_add(wait_ms)>total{return false};self.waits+=1;self.waited_ms+=wait_ms;true } }
pub fn direct_provider_label(provider:UpstreamProvider)->&'static str {match provider {UpstreamProvider::ChatgptCodex=>"chatgpt_codex",UpstreamProvider::ClaudeCode=>"claude_code",UpstreamProvider::Deepseek=>"deepseek",UpstreamProvider::Cerebras=>"cerebras",UpstreamProvider::Lithos=>"lithos",UpstreamProvider::Openrouter=>"openrouter",UpstreamProvider::RemovedProvider=>"removed_provider",UpstreamProvider::Metered=>"metered",UpstreamProvider::Surplus=>"surplus",UpstreamProvider::Voyage=>"voyage"} }
