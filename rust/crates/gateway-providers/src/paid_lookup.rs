//! Fixed, read-only OpenLux billing lookup policy from src/provider/metered.ts.
//! The host owns the strong paid-attempt read, current spend key, HTTP and one
//! overall deadline. These plans cannot be deserialized from client input.
use crate::types::Headers;
use gateway_core::{GatewayError, provider::PaidProvider};
use serde_json::Value;
use url::Url;

pub const OVERALL_TIMEOUT_MS: u64 = 10_000;
pub const PAGE_SIZE: u16 = 100;
pub const MAX_PAGES: u16 = 100;
pub const ENDPOINT: &str = "https://api.openlux.ai/api/log/token";
const MAX_SAFE: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq)]
pub struct TokenLog {
    pub request_id: String,
    pub quota: f64,
    pub prompt_tokens: i64,
    pub cached_prompt_tokens: Option<i64>,
    pub cache_write_prompt_tokens: Option<i64>,
    pub completion_tokens: i64,
    pub model: String,
    pub created_at: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NoLookupReason {
    SurplusTerminalUsageOnly,
    MissingProviderRequestId,
}

#[derive(Clone, Debug)]
pub enum LookupPlan {
    Openlux(OpenluxLookup),
    NoLookup(NoLookupReason),
}

#[derive(Clone, Debug)]
pub struct OpenluxLookup {
    request_id: String,
    start_timestamp: u64,
    end_timestamp: u64,
    next_page: u16,
    finished: bool,
}

/// Complete(None) means no matching evidence, never zero cost or not-billed.
#[derive(Clone, Debug, PartialEq)]
pub enum LookupStep {
    Continue,
    Complete(Option<TokenLog>),
}

/// The URL contains the paid key; Debug deliberately never includes it.
#[derive(Clone)]
pub struct LookupPageRequest {
    url: Url,
    headers: Headers,
    request_id: String,
    page: u16,
    start_timestamp: u64,
    end_timestamp: u64,
}
impl std::fmt::Debug for LookupPageRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LookupPageRequest")
            .field("endpoint", &ENDPOINT)
            .field("page", &self.page)
            .field("credential", &"[redacted]")
            .finish_non_exhaustive()
    }
}
impl LookupPageRequest {
    pub fn url(&self) -> &str {
        self.url.as_str()
    }
    pub fn method(&self) -> &'static str {
        "GET"
    }
    pub fn headers(&self) -> &Headers {
        &self.headers
    }
    pub fn page(&self) -> u16 {
        self.page
    }
    pub fn follow_redirects(&self) -> bool {
        false
    }
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|s| !s.is_empty())
}
fn integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.is_finite() && (0.0..=MAX_SAFE as f64).contains(&number) && number.fract() == 0.0)
        .then_some(number as i64)
}
fn invalid(message: &str) -> GatewayError {
    GatewayError::new(502, message, Some("metered_logs_invalid")).with_type("server_error")
}

/// Only the actual provider key is supplied here; this module never discovers
/// environment variables or accepts a URL, arbitrary selector or refresh token.
pub fn plan_lookup(
    provider: PaidProvider,
    persisted_provider_request_id: Option<&str>,
    created_at_ms: i64,
    now_ms: i64,
) -> Result<LookupPlan, GatewayError> {
    if provider == PaidProvider::Surplus {
        return Ok(LookupPlan::NoLookup(
            NoLookupReason::SurplusTerminalUsageOnly,
        ));
    }
    let Some(request_id) = persisted_provider_request_id
        .map(js_trim)
        .filter(|id| !id.is_empty())
    else {
        return Ok(LookupPlan::NoLookup(
            NoLookupReason::MissingProviderRequestId,
        ));
    };
    if !(0..=MAX_SAFE).contains(&created_at_ms) || !(0..=MAX_SAFE).contains(&now_ms) {
        return Err(GatewayError::unavailable(
            "Paid billing lookup timestamps are invalid.",
            "metered_logs_unavailable",
        ));
    }
    Ok(LookupPlan::Openlux(OpenluxLookup {
        request_id: request_id.into(),
        start_timestamp: ((created_at_ms as f64 - 60_000.0) / 1000.0)
            .floor()
            .max(0.0) as u64,
        end_timestamp: ((now_ms as f64 + 60_000.0) / 1000.0).ceil().max(0.0) as u64,
        next_page: 1,
        finished: false,
    }))
}

impl OpenluxLookup {
    /// One host deadline is created before the first page and reused for all
    /// requests and body reads; OVERALL_TIMEOUT_MS is not a per-page budget.
    pub fn next_request(
        &self,
        current_paid_key: &str,
    ) -> Result<Option<LookupPageRequest>, GatewayError> {
        if self.finished {
            return Ok(None);
        }
        let key = js_trim(current_paid_key);
        if key.is_empty() {
            return Err(GatewayError::unavailable(
                "Metered paid fallback is unavailable because METERED_API_KEY or OPENLUX_API_KEY is not configured.",
                "metered_api_key_missing",
            ));
        }
        let mut url =
            Url::parse(ENDPOINT).map_err(|_| invalid("The fixed billing endpoint is invalid."))?;
        url.query_pairs_mut()
            .append_pair("key", key)
            .append_pair("page", &self.next_page.to_string())
            .append_pair("page_size", &PAGE_SIZE.to_string())
            .append_pair("start_timestamp", &self.start_timestamp.to_string())
            .append_pair("end_timestamp", &self.end_timestamp.to_string());
        Ok(Some(LookupPageRequest {
            url,
            headers: Headers::from([("Accept".into(), "application/json".into())]),
            request_id: self.request_id.clone(),
            page: self.next_page,
            start_timestamp: self.start_timestamp,
            end_timestamp: self.end_timestamp,
        }))
    }

    /// The host passes JSON only after a successful complete body read. None
    /// represents invalid JSON; transport/timeout failures never become a page.
    pub fn accept_page(
        &mut self,
        request: &LookupPageRequest,
        status: u16,
        body: Option<&Value>,
    ) -> Result<LookupStep, GatewayError> {
        if self.finished
            || request.page != self.next_page
            || request.request_id != self.request_id
            || request.start_timestamp != self.start_timestamp
            || request.end_timestamp != self.end_timestamp
        {
            return Err(invalid(
                "Billing page does not belong to the current lookup.",
            ));
        }
        if !(200..300).contains(&status) {
            self.finished = true;
            return Err(GatewayError::new(
                502,
                "Metered billing logs returned an unsuccessful response.",
                Some("metered_logs_unavailable"),
            )
            .with_type("server_error"));
        }
        let page = match parse_page(body) {
            Ok(page) => page,
            Err(error) => {
                self.finished = true;
                return Err(error);
            }
        };
        // Source backfill builds a Map after normalizing the whole page, so the
        // last valid same-ID row wins, not the first matching raw entry.
        let mut matched = None;
        for item in page.items {
            if let Some(row) = normalize_token_log(item)
                && row.request_id == self.request_id
            {
                matched = Some(row);
            }
        }
        if matched.is_some() {
            self.finished = true;
            return Ok(LookupStep::Complete(matched));
        }
        if u64::from(self.next_page) * u64::from(PAGE_SIZE) >= page.total
            || page.items.is_empty()
            || self.next_page == MAX_PAGES
        {
            self.finished = true;
            return Ok(LookupStep::Complete(None));
        }
        self.next_page += 1;
        Ok(LookupStep::Continue)
    }
}

struct Page<'a> {
    items: &'a [Value],
    total: u64,
}
fn parse_page(body: Option<&Value>) -> Result<Page<'_>, GatewayError> {
    let body = body.ok_or_else(|| invalid("Metered billing logs returned invalid JSON."))?;
    let envelope = body
        .as_object()
        .ok_or_else(|| invalid("Metered billing logs returned an invalid response envelope."))?;
    if envelope.get("success") != Some(&Value::Bool(true)) {
        return Err(invalid(
            "Metered billing logs returned an invalid response envelope.",
        ));
    }
    let data = envelope
        .get("data")
        .ok_or_else(|| invalid("Metered billing logs returned an invalid response envelope."))?;
    let items = data
        .as_array()
        .or_else(|| {
            data.as_object()
                .and_then(|object| object.get("items"))
                .and_then(Value::as_array)
        })
        .ok_or_else(|| invalid("Metered billing logs returned an invalid response envelope."))?;
    let total = data
        .as_object()
        .and_then(|object| integer(object.get("total")))
        .map(|n| n as u64)
        .unwrap_or(items.len() as u64);
    Ok(Page { items, total })
}

pub fn normalize_token_log(value: &Value) -> Option<TokenLog> {
    let object = value.as_object()?;
    let parsed_other = object
        .get("other")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    let other = object
        .get("other")
        .and_then(Value::as_object)
        .or_else(|| parsed_other.as_ref().and_then(Value::as_object));
    let request_id = text(object.get("request_id"))
        .or_else(|| other.and_then(|other| text(other.get("request_id"))))?;
    let model = text(object.get("model_name"))?;
    let quota = object.get("quota")?.as_f64()?;
    integer(object.get("quota"))?;
    let mut result = TokenLog {
        request_id: request_id.into(),
        model: model.into(),
        quota,
        prompt_tokens: integer(object.get("prompt_tokens"))?,
        completion_tokens: integer(object.get("completion_tokens"))?,
        created_at: integer(object.get("created_at"))?,
        cached_prompt_tokens: integer(object.get("cached_prompt_tokens")),
        cache_write_prompt_tokens: None,
    };
    let Some(other) = other else {
        return Some(result);
    };
    // Match the source case-sensitive Surplus-Claude identity, not a broader
    // provider normalization that could add cache input to another model.
    let claude = model
        .strip_prefix("~anthropic/")
        .or_else(|| model.strip_prefix("anthropic/"))
        .unwrap_or(model)
        .starts_with("claude-");
    if !claude || other.get("claude") != Some(&Value::Bool(true)) {
        return Some(result);
    }
    let Some(cached) = integer(other.get("cache_tokens")) else {
        return Some(result);
    };
    let write = match other.get("cache_creation_tokens") {
        None => 0,
        value => match integer(value) {
            Some(value) => value,
            None => return Some(result),
        },
    };
    let Some(gross) = result
        .prompt_tokens
        .checked_add(cached)
        .and_then(|n| n.checked_add(write))
        .filter(|n| *n <= MAX_SAFE)
    else {
        return Some(result);
    };
    result.prompt_tokens = gross;
    result.cached_prompt_tokens = Some(cached);
    result.cache_write_prompt_tokens = other.get("cache_creation_tokens").map(|_| write);
    Some(result)
}
