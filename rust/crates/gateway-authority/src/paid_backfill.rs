//! Source historical paid usage and retention, owned by the existing atomic authority.
//! Cursors are progress hints only; request markers and revision checks prevent double folds.
use crate::{Authority, TokenSource, keys, paid::PaidAttempt, validate_time};
use gateway_core::{
    GatewayError,
    query::{QueryPage, QueryRequest, QuerySelector, QueryStore},
    state::RecordKey,
    tuple_key::{DecodedKeyPart, ScalarKeyPart, TupleKey},
};
use serde::Serialize;
use serde_json::{Value, json};
mod values;

const PAGE_SIZE: u32 = 128;
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct PaidRequestBackfill {
    pub scanned: u32,
    pub processed: u32,
    pub rollups_written: u32,
    pub failed: u32,
    pub truncated: bool,
}
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct PaidWindowBackfill {
    pub scanned: u32,
    pub rewritten: u32,
    pub truncated: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PaidBackfillReceipt {
    pub requests: PaidRequestBackfill,
    pub windows: PaidWindowBackfill,
}
fn family(name: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("paid_fallback"),
        ScalarKeyPart::String("v3"),
        ScalarKeyPart::String(name),
    ])
    .to_record_key()
}
enum RequestStep {
    Missing,
    Retained,
    Processed(bool),
    Failed,
    Budget,
}
impl<S: QueryStore, I: TokenSource> Authority<S, I> {
    /// Finite source admin operation; no provider request, admission or settlement occurs here.
    pub async fn backfill_paid_usage(
        &self,
        limit: u32,
        now: i64,
    ) -> Result<PaidBackfillReceipt, GatewayError> {
        validate_time(now)?;
        let limit = limit.clamp(1, 10_000);
        let requests = self.backfill_requests(limit, now).await?;
        let windows = self.backfill_windows(limit, now).await?;
        Ok(PaidBackfillReceipt { requests, windows })
    }
    async fn page(
        &self,
        prefix: &RecordKey,
        resume: &Option<RecordKey>,
        cursor: Option<String>,
        limit: u32,
        now: i64,
    ) -> Result<QueryPage, GatewayError> {
        self.store
            .query(QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix: prefix.clone(),
                    start: resume.clone(),
                    end: None,
                },
                reverse: false,
                limit,
                cursor,
                now_ms: now,
            })
            .await
    }
    async fn load_backfill_cursor(
        &self,
        key: &RecordKey,
        now: i64,
    ) -> Result<Option<RecordKey>, GatewayError> {
        // Source get failures and non-array cursor values restart safely from the prefix.
        let Ok(Some(row)) = self.store.read(key).await else {
            return Ok(None);
        };
        if row.expires_at_ms.is_some_and(|expiry| expiry <= now) {
            return Ok(None);
        }
        let Ok(value) = row.json_value() else {
            return Ok(None);
        };
        value["request_key"]
            .as_array()
            .map(|parts| TupleKey::from_json_parts(parts).map(|tuple| tuple.to_record_key()))
            .transpose()
    }
    async fn finish_backfill_cursor(&self, key: &RecordKey, value: Option<&RecordKey>, now: i64) {
        // Like source cursor set/delete, failure affects only progress, never accounting.
        let result = async {
            let mut tx = self.transaction(now)?;
            let _: Option<Value> = tx.read(key).await?;
            if let Some(value) = value {
                tx.put(key, &json!({"request_key": cursor_parts(value)?}), None)?;
            } else {
                tx.delete(key)?;
            }
            tx.commit().await
        }
        .await;
        let _ = result;
    }
    async fn backfill_requests(
        &self,
        limit: u32,
        now: i64,
    ) -> Result<PaidRequestBackfill, GatewayError> {
        let prefix = family("request");
        let cursor_key = family("rollup_backfill_cursor");
        let resume = self.load_backfill_cursor(&cursor_key, now).await?;
        let mut cursor = None;
        let mut last = None;
        let mut result = PaidRequestBackfill::default();
        'scan: loop {
            let page = self.page(&prefix, &resume, cursor, PAGE_SIZE, now).await?;
            for entry in page.entries {
                result.scanned += 1;
                if result.scanned > limit * 10 {
                    result.truncated = true;
                    break 'scan;
                }
                match self
                    .backfill_request(&entry.key, result.processed < limit, now)
                    .await?
                {
                    RequestStep::Missing => continue,
                    RequestStep::Retained => {}
                    RequestStep::Processed(rollup) => {
                        result.processed += 1;
                        result.rollups_written += u32::from(rollup);
                    }
                    RequestStep::Failed => {
                        result.failed += 1;
                        result.truncated = true;
                        break 'scan;
                    }
                    RequestStep::Budget => {
                        result.truncated = true;
                        break 'scan;
                    }
                }
                last = Some(entry.key);
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        let next = if result.truncated {
            last.as_ref().or(resume.as_ref())
        } else {
            None
        };
        if !result.truncated || next.is_some() {
            self.finish_backfill_cursor(&cursor_key, next, now).await;
        }
        Ok(result)
    }
    async fn backfill_request(
        &self,
        key: &RecordKey,
        may_fold: bool,
        now: i64,
    ) -> Result<RequestStep, GatewayError> {
        let mut tx = self.transaction(now)?;
        let Some(mut raw): Option<gateway_core::source_json::SourceJson> =
            tx.read_source_control(key).await?
        else {
            return Ok(RequestStep::Missing);
        };
        let row: PaidAttempt = raw
            .deserialize()
            .map_err(|_| crate::invalid("Malformed paid backfill request."))?;
        if row.v != 3
            || keys::paid_attempt(&row.reservation.key_id.0, &row.reservation.attempt_id.0) != *key
        {
            return Err(crate::invalid("Paid backfill request identity conflicts."));
        }
        let expiry = values::expiry(row.reservation.created_at_ms, now)?;
        if gateway_core::source_serialization::member(&raw, "usage_rollup_at_ms")
            .as_ref()
            .and_then(gateway_core::source_serialization::number)
            .is_some()
        {
            tx.put_source_control(key, &raw, Some(expiry))?;
            return Ok(if tx.commit().await.unwrap_or(false) {
                RequestStep::Retained
            } else {
                RequestStep::Failed
            });
        }
        if !may_fold {
            return Ok(RequestStep::Budget);
        }
        let model = gateway_core::model::ModelId::from_source(
            gateway_schema::reasoning::js_trim_source(row.model.as_js_string()),
        );
        let eligible = row.billing_state == gateway_core::lifecycle::BillingState::Settled
            && row.provider_quota.is_some()
            && row.spend_microcredits.is_some()
            && !model.as_js_string().as_units().is_empty();
        let mut fields = gateway_core::source_serialization::entries(&raw)
            .ok_or_else(|| crate::invalid("Malformed paid backfill request."))?;
        for name in ["usage_rollup_at_ms", "updated_at_ms"] {
            let next = gateway_core::source_json::SourceJson::from_serializable(&now)?;
            if let Some((_, value)) = fields
                .iter_mut()
                .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
            {
                *value = next;
            } else {
                fields.push((name.into(), next));
            }
        }
        raw = gateway_core::source_serialization::object_keys(fields)?;
        tx.put_source_control(key, &raw, Some(expiry))?;
        if eligible {
            let bucket = row.reservation.created_at_ms / 3_600_000 * 3_600_000;
            let provider = match row.reservation.provider {
                gateway_core::provider::PaidProvider::Surplus => "surplus",
                gateway_core::provider::PaidProvider::Metered => "metered",
            };
            let rollup_key = keys::paid_rollup_model(
                bucket,
                &model,
                provider,
                crate::paid::rollup_shard(&row.reservation.attempt_id.0),
            );
            let old: Option<gateway_core::source_json::SourceJson> =
                tx.read_source_control(&rollup_key).await?;
            let rollup =
                values::merge_source_rollup(old.as_ref(), &row, &model, provider, bucket, now)?;
            tx.put_source_control(&rollup_key, &rollup, None)?;
        }
        Ok(if tx.commit().await? {
            RequestStep::Processed(eligible)
        } else {
            RequestStep::Failed
        })
    }
    async fn backfill_windows(
        &self,
        limit: u32,
        now: i64,
    ) -> Result<PaidWindowBackfill, GatewayError> {
        let prefix = family("window");
        let cursor_key = family("rollup_backfill_window_cursor");
        let resume = self.load_backfill_cursor(&cursor_key, now).await?;
        let mut cursor = None;
        let mut last = None;
        let mut result = PaidWindowBackfill::default();
        'scan: loop {
            let page = self.page(&prefix, &resume, cursor, PAGE_SIZE, now).await?;
            for entry in page.entries {
                result.scanned += 1;
                // Unlike requests, source window resume skips its inclusive cursor row.
                if resume.as_ref() == Some(&entry.key) {
                    continue;
                }
                let mut tx = self.transaction(now)?;
                let raw: Option<Value> = tx.read(&entry.key).await?;
                let Some(raw) = raw else { continue };
                let Some(reset) = values::window_anchor(&raw) else {
                    continue;
                };
                tx.put(&entry.key, &raw, Some(values::expiry(reset, now)?))?;
                if !tx.commit().await.unwrap_or(false) {
                    result.truncated = true;
                    break 'scan;
                }
                last = Some(entry.key);
                result.rewritten += 1;
                if result.rewritten < limit {
                    continue;
                }
                // Source probes two inclusive rows before calling a final batch truncated.
                result.truncated = self.page(&prefix, &last, None, 2, now).await?.entries.len() > 1;
                break 'scan;
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        let next = if result.truncated {
            last.as_ref().or(resume.as_ref())
        } else {
            None
        };
        if !result.truncated || next.is_some() {
            self.finish_backfill_cursor(&cursor_key, next, now).await;
        }
        Ok(result)
    }
}
fn cursor_parts(key: &RecordKey) -> Result<Vec<Value>, GatewayError> {
    TupleKey::from_record_key(key)?
        .decoded_parts()?
        .into_iter()
        .map(|part| match part {
            DecodedKeyPart::String(bytes) => String::from_utf8(bytes)
                .map(Value::String)
                .map_err(|_| crate::invalid("Paid cursor text is invalid.")),
            DecodedKeyPart::Number(number) => serde_json::Number::from_f64(number)
                .map(Value::Number)
                .ok_or_else(|| crate::invalid("Paid cursor number is invalid.")),
            _ => Err(crate::invalid(
                "Paid cursor requires its source text/number identity.",
            )),
        })
        .collect()
}
#[cfg(test)]
mod tests;
