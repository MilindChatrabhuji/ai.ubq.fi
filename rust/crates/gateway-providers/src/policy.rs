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
/// Catalog/capability evidence used by the existing paid router, before authority admission.
#[derive(Clone,Debug)]
pub struct PaidRoutingInput {
    pub model:String,pub endpoint_type:String,pub request_uses_tools:bool,pub codex_model_known:bool,
    pub codex_enabled:bool,pub surplus_enabled:bool,pub openlux_enabled:bool,
    pub surplus_configured:bool,pub openlux_configured:bool,
    pub surplus_catalog:Option<Vec<Value>>,pub openlux_catalog:Option<Vec<Value>>,
    pub allowed_paid_providers:Option<Vec<PaidProvider>>,
    /// Server-owned scope; never derive this from a client JSON field.
    pub synthetic_hop:Option<DeepseekHop>,pub ubiquity_enabled:bool,
}
#[derive(Clone,Debug,PartialEq)]
pub struct PaidRoutingPlan {pub providers:Vec<PaidProvider>,pub paid_model_known:bool,pub metered_only:bool,pub codex_enabled:bool,pub surplus_billing:Option<Value>}
fn supports_endpoint(row:Option<&Value>,endpoint:&str)->bool{row.and_then(|r|r["supported_endpoint_types"].as_array()).is_some_and(|a|a.iter().any(|e|e==endpoint))}
fn valid_price(value:&Value)->Option<f64>{value.as_f64().filter(|v|v.is_finite()&&*v>=0.0)}
fn flash_paid_id(model:&str)->bool{let slug=model.rsplit('/').next().unwrap_or(model).to_lowercase();let Some(rest)=slug.strip_prefix("deepseek-v")else{return false};let Some((version,tail))=rest.split_once("-flash")else{return false};!version.is_empty()&&version.chars().all(|c|c.is_ascii_digit()||c=='.')&&(tail.is_empty()||tail.strip_prefix('-').is_some_and(|d|(d.len()==4||d.len()==8)&&d.chars().all(|c|c.is_ascii_digit())))}
pub fn resolve_paid_route(input:&PaidRoutingInput)->PaidRoutingPlan {
    let surplus=input.surplus_catalog.as_ref().and_then(|a|a.iter().find(|r|r["id"]==input.model));let openlux=input.openlux_catalog.as_ref().and_then(|a|a.iter().find(|r|r["id"]==input.model));
    let pinned=match input.synthetic_hop{Some(DeepseekHop::Surplus)=>Some(PaidProvider::Surplus),Some(DeepseekHop::Openlux)=>Some(PaidProvider::Metered),_=>None};
    let verified_hop=flash_paid_id(&input.model)&&input.endpoint_type=="openai-response"&&input.ubiquity_enabled&&pinned.is_some()&&input.allowed_paid_providers.as_ref().is_some_and(|a|a.len()==1&&a.first()==pinned.as_ref());
    let openlux_route=supports_endpoint(openlux,&input.endpoint_type)||(verified_hop&&pinned==Some(PaidProvider::Metered)&&supports_endpoint(openlux,"openai"));let surplus_route=supports_endpoint(surplus,&input.endpoint_type);
    let surplus_billing=surplus.and_then(|row|{let input_price=valid_price(&row["input_price_per_token"])?;let output_price=valid_price(&row["output_price_per_token"])?;let mut value=serde_json::json!({"input_price_per_token":input_price,"output_price_per_token":output_price});for key in ["cache_read_price_per_token","cache_write_price_per_token"]{if let Some(price)=row.get(key){value[key]=price.clone();}}Some(value)});
    let surplus_ok=(input.surplus_enabled||(verified_hop&&pinned==Some(PaidProvider::Surplus)))&&input.surplus_configured&&surplus_route&&surplus_billing.is_some()&&(!input.request_uses_tools||surplus.is_some_and(|r|r["supports_tools"]==true));
    let openlux_ok=(input.openlux_enabled||(verified_hop&&pinned==Some(PaidProvider::Metered)))&&input.openlux_configured&&if input.openlux_catalog.is_none(){input.codex_model_known}else{openlux_route};
    let providers=paid_order(surplus_ok,openlux_ok).into_iter().filter(|p|input.allowed_paid_providers.as_ref().is_none_or(|a|a.contains(p))).collect::<Vec<_>>();PaidRoutingPlan{metered_only:!providers.is_empty()&&!input.codex_model_known,providers,paid_model_known:openlux_route||surplus_route,codex_enabled:input.codex_enabled,surplus_billing}
}
#[derive(Clone,Debug,Eq,PartialEq)]
pub enum PaidEntry { CodexPrimary, Direct(PaidProvider), Disabled }
pub fn paid_entry(plan:&PaidRoutingPlan)->PaidEntry{if plan.metered_only||!plan.codex_enabled{plan.providers.first().copied().map(PaidEntry::Direct).unwrap_or(PaidEntry::Disabled)}else{PaidEntry::CodexPrimary}}
pub fn validate_flash_effort(raw:&Value)->Result<(),gateway_core::GatewayError>{let effort=raw["reasoning"]["effort"].as_str().filter(|s|!s.trim().is_empty()).or_else(||raw["reasoning_effort"].as_str().filter(|s|!s.trim().is_empty()));if let Some(effort)=effort{if !["low","high","max"].contains(&effort.trim()){return Err(gateway_core::GatewayError::new(400,format!("The model 'ubiquity/deepseek-flash' supports reasoning efforts low, high, max; '{effort}' is not supported."),Some("unsupported_reasoning_effort")).with_param(Some("reasoning.effort")))}}Ok(())}
pub fn deepseek_plan(configured:&[DeepseekHop],ubiquity_enabled:bool)->Vec<DeepseekHop>{if !ubiquity_enabled{return vec![]}DEEPSEEK_ORDER.into_iter().filter(|p|configured.contains(p)).collect()}
