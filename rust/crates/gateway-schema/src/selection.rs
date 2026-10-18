//! Operator selection, whitelist and non-secret per-account model eligibility hints.
use std::collections::BTreeMap;
use serde::{Serialize,Deserialize};
use serde_json::Value;
use crate::{aliases::{SYNTHETIC_MODEL,LEGACY_SYNTHETIC_MODEL},util::*};
pub const PROVIDERS:&[&str]=&["codex","claude_code","surplus","openlux","deepseek","cerebras","lithos","openrouter","ubiquity"];
#[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
pub struct ProviderSelection{pub provider_ids:Vec<String>,pub updated_at_ms:i64}
fn subscription_hash(id:&str)->Option<&str>{id.strip_prefix("codex:").filter(|hash|hash.len()==64&&hash.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)))}
pub fn normalize_provider_ids(values:&[Value])->Vec<String>{
    let mut subscriptions=Vec::new();let mut submitted=Vec::new();for value in values{if let Some(id)=normalized_string(Some(value)){if PROVIDERS.contains(&id.as_str()){push_unique(&mut submitted,id);}else if subscription_hash(&id).is_some(){push_unique(&mut subscriptions,id);}}}
    let mut result:Vec<_>=PROVIDERS.iter().filter(|p|submitted.iter().any(|s|s==**p)).map(|s|(*s).to_owned()).collect();if !submitted.iter().any(|s|s=="codex"){subscriptions.sort();result.extend(subscriptions);}result
}
impl ProviderSelection{
    pub fn enabled(selection:Option<&Self>,provider:&str)->bool{selection.is_none_or(|s|s.provider_ids.is_empty()||s.provider_ids.iter().any(|p|p==provider)||(provider=="codex"&&s.provider_ids.iter().any(|p|subscription_hash(p).is_some())))}
    pub fn account_eligible(&self,hash:&str)->bool{self.provider_ids.is_empty()||self.provider_ids.iter().any(|p|p=="codex"||subscription_hash(p)==Some(hash))}
    pub fn normalize(value:&Value)->Option<Self>{let ids=value.get("provider_ids")?.as_array()?;if ids.iter().any(|v|!v.is_string()){return None;}let updated=positive_integer(value.get("updated_at_ms"))?;Some(Self{provider_ids:normalize_provider_ids(ids),updated_at_ms:updated})}
}
#[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
pub struct ModelWhitelist{pub model_ids:Vec<String>,pub updated_at_ms:i64}
pub fn canonical_whitelist_id(id:&str)->&str{if id==LEGACY_SYNTHETIC_MODEL{SYNTHETIC_MODEL}else{id}}
pub fn normalize_whitelist_ids(values:&[Value])->Vec<String>{let mut ids=Vec::new();for value in values{if let Some(id)=normalized_string(Some(value)){push_unique(&mut ids,canonical_whitelist_id(&id).to_owned());}}ids}
impl ModelWhitelist{
    pub fn normalize(value:&Value)->Option<Self>{let raw=value.get("model_ids")?.as_array()?;let mut ids=Vec::new();for item in raw{let id=normalized_string(Some(item))?;ids.push(canonical_whitelist_id(&id).to_owned());}Some(Self{model_ids:ids,updated_at_ms:positive_integer(value.get("updated_at_ms"))?})}
    pub fn permits(whitelist:Option<&Self>,id:&str)->bool{whitelist.is_none_or(|w|w.model_ids.is_empty()||w.model_ids.iter().any(|s|s==id))}
}
#[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
pub struct AccountModelCatalog{pub slugs:Vec<String>,pub client_version:String,pub updated_at_ms:i64}
#[derive(Clone,Debug,Default,PartialEq,Serialize,Deserialize)]
pub struct AccountModelsStore{pub accounts:BTreeMap<String,AccountModelCatalog>,pub unsupported:BTreeMap<String,BTreeMap<String,i64>>}
impl AccountModelsStore{
    pub fn record_catalogs(&self,entries:&[(String,AccountModelCatalog)])->Self{let mut next=self.clone();for(account,catalog)in entries{let mut catalog=catalog.clone();let mut slugs=Vec::new();for slug in &catalog.slugs{let slug=crate::util::js_trim(slug);if !slug.is_empty(){push_unique(&mut slugs,slug.to_owned());}}catalog.slugs=slugs;next.accounts.insert(account.clone(),catalog.clone());if let Some(rejections)=next.unsupported.get_mut(account){for slug in &catalog.slugs{rejections.remove(slug);}
if rejections.is_empty(){next.unsupported.remove(account);}}}next}
    pub fn record_unsupported(&self,account:&str,model:&str,at_ms:i64)->Self{let mut next=self.clone();let entries=next.unsupported.entry(account.into()).or_default();entries.insert(model.into(),at_ms);let mut ordered:Vec<_>=entries.iter().map(|(k,v)|(k.clone(),*v)).collect();ordered.retain(|(_,at)|at_ms-*at<=7*24*60*60_000);ordered.sort_by(|a,b|b.1.cmp(&a.1).then_with(||a.0.cmp(&b.0)));ordered.truncate(32);*entries=ordered.into_iter().collect();next}
    pub fn unavailable(&self,model:&str,current_accounts:&[String],now_ms:i64)->Vec<String>{
        let target=model.trim_matches(crate::util::js_whitespace);if target.is_empty(){return Vec::new();}let mut result=Vec::new();
        for account in current_accounts{let learned=self.unsupported.get(account).and_then(|m|m.get(target)).is_some_and(|at|now_ms-*at<=7*24*60*60_000);let absent=self.accounts.get(account).is_some_and(|c|!c.slugs.iter().any(|s|s==target)&&current_accounts.iter().any(|other|other!=account&&self.accounts.get(other).is_some_and(|s|s.client_version==c.client_version&&s.slugs.iter().any(|s|s==target))));if learned||absent{push_unique(&mut result,account.clone());}}
        result
    }
}

impl AccountModelsStore{
    pub fn parse(value:&Value)->Option<Self>{
        let accounts=value.get("accounts").filter(|v|is_record(v));let unsupported=value.get("unsupported").filter(|v|is_record(v));if accounts.is_none()&&unsupported.is_none(){return None;}let mut store=Self::default();
        if let Some(accounts)=accounts.and_then(Value::as_object){for(account,raw)in accounts{if account.trim_matches(crate::util::js_whitespace).is_empty(){continue;}let Some(client_version)=normalized_string(raw.get("client_version"))else{continue};let Some(updated_at_ms)=positive_integer(raw.get("updated_at_ms"))else{continue};let Some(raw_slugs)=raw.get("slugs").and_then(Value::as_array)else{continue};let mut slugs=Vec::new();for slug in raw_slugs.iter().filter_map(|v|normalized_string(Some(v))){push_unique(&mut slugs,slug);}store.accounts.insert(account.clone(),AccountModelCatalog{slugs,client_version,updated_at_ms});}}
        if let Some(unsupported)=unsupported.and_then(Value::as_object){for(account,raw)in unsupported{if account.trim_matches(crate::util::js_whitespace).is_empty(){continue;}let Some(models)=raw.as_object()else{continue};let entries:BTreeMap<_,_>=models.iter().filter_map(|(model,value)|if model.trim_matches(crate::util::js_whitespace).is_empty(){None}else{positive_integer(Some(value)).map(|n|(model.clone(),n))}).collect();if !entries.is_empty(){store.unsupported.insert(account.clone(),entries);}}}Some(store)
    }
}
