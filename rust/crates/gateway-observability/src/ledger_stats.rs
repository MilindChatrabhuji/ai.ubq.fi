//! Source paid-fallback/ledger-stats.ts. Measurement cannot move a paid balance.
use crate::{ObservabilityRuntime, store, types::ObservabilityHost};
use gateway_core::{
    GatewayError,
    query::{QuerySelector, QueryStore},
};
use serde_json::{Value, json};
const BUDGET: i64 = 5 * 1024 * 1024 * 1024;
fn prefix() -> Vec<Value> {
    vec![
        json!("uos_ai"),
        json!("paid_fallback"),
        json!("v3"),
        json!("ledger_stats"),
    ]
}
fn day(at: i64) -> i64 {
    at.max(0) / store::DAY * store::DAY
}
fn key(at: i64) -> gateway_core::state::RecordKey {
    let mut p = prefix();
    p.push(json!(day(at)));
    store::key(json!(p))
}
pub fn empty_daily(at: i64) -> Value {
    json!({"v":1,"day_start_at_ms":day(at),"settled_rows":0,"settled_row_bytes":0,"rollup_writes":0,"rollup_bytes":0,"projection_7d":{"views":0,"read_units":0,"rollup_rows":0},"projection_30d":{"views":0,"read_units":0,"rollup_rows":0},"projection_90d":{"views":0,"read_units":0,"rollup_rows":0},"updated_at_ms":0})
}
pub fn valid_daily(v: &Value) -> bool {
    v["v"] == 1
        && [
            "day_start_at_ms",
            "settled_rows",
            "settled_row_bytes",
            "rollup_writes",
            "rollup_bytes",
            "updated_at_ms",
        ]
        .iter()
        .all(|f| store::safe_i64(&v[f]).is_some())
        && ["projection_7d", "projection_30d", "projection_90d"]
            .iter()
            .all(|f| {
                v[f].is_object()
                    && ["views", "read_units", "rollup_rows"]
                        .iter()
                        .all(|n| store::safe_i64(&v[f][n]).is_some())
            })
}
fn empty_growth(at: i64) -> Value {
    let projections:Vec<Value>=[7,30,90].into_iter().map(|w|json!({"window_days":w,"views":0,"read_units":0,"rollup_rows":0,"avg_read_units_per_view":null,"avg_rollup_rows_per_view":null})).collect();
    json!({"as_of_ms":at,"scan":"unavailable","read_units":0,"retention_days":365,"leaderboard_days":30,"leaderboard":[],"settled_rows":0,"settled_row_bytes":0,"rollup_writes":0,"rollup_bytes":0,"active_days":0,"avg_row_bytes":null,"avg_settled_rows_per_active_day":null,"estimated_retained_rows":0,"estimated_retained_raw_bytes":0,"budget_bytes":BUDGET,"alert_ratio":0.8,"alert_threshold_bytes":BUDGET as f64*0.8,"alert":false,"projections":projections})
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn record_settlement_stats(
        &self,
        settled_row_bytes: u64,
        rollup_bytes: Option<u64>,
    ) -> bool {
        self.merge_ledger_stats(None, 0, 0, Some((settled_row_bytes, rollup_bytes)))
            .await
            .unwrap_or(false)
    }
    pub async fn record_projection_stats(
        &self,
        window_days: u32,
        read_units: u64,
        rollup_rows: u64,
    ) -> bool {
        if ![7, 30, 90].contains(&window_days) {
            return false;
        }
        self.merge_ledger_stats(Some(window_days), read_units, rollup_rows, None)
            .await
            .unwrap_or(false)
    }
    async fn merge_ledger_stats(
        &self,
        window: Option<u32>,
        read_units: u64,
        rollup_rows: u64,
        settlement: Option<(u64, Option<u64>)>,
    ) -> Result<bool, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let key = key(at);
        for _ in 0..8 {
            let row = self.store.read(&key).await?;
            let mut value = store::value(row.as_ref(), at)?
                .filter(|v| valid_daily(v))
                .cloned()
                .unwrap_or_else(|| empty_daily(at));
            if let Some(window) = window {
                let name = format!("projection_{window}d");
                for (field, delta) in [
                    ("views", 1),
                    ("read_units", read_units),
                    ("rollup_rows", rollup_rows),
                ] {
                    value[&name][field] =
                        json!(value[&name][field].as_f64().unwrap_or(0.0) + delta as f64);
                }
            }
            if let Some((bytes, rollup)) = settlement {
                for (field, delta) in [
                    ("settled_rows", 1),
                    ("settled_row_bytes", bytes),
                    ("rollup_writes", u64::from(rollup.is_some())),
                    ("rollup_bytes", rollup.unwrap_or(0)),
                ] {
                    value[field] = json!(value[field].as_f64().unwrap_or(0.0) + delta as f64);
                }
            }
            value["v"] = json!(1);
            value["day_start_at_ms"] = json!(day(at));
            value["updated_at_ms"] = json!(at);
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&key, row.as_ref())],
                vec![store::put(self.host.as_ref(), key.clone(), value, None)?],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub async fn ledger_growth(&self, at: i64) -> Value {
        let base = empty_growth(at);
        let read:Result<Value,GatewayError>=async{
            let mut start=prefix();start.push(json!(day(at-365*store::DAY)));let mut end=prefix();end.push(json!(at+store::DAY));let selector=QuerySelector::Range{start:store::key(json!(start)),end:store::key(json!(end))};
            let entries=store::scan_selector(self.store.as_ref(),selector,false,at,usize::MAX).await?;let rows:Vec<Value>=entries.iter().filter_map(|r|r.record.json_value().ok().filter(|v|valid_daily(v)).cloned()).collect();
            let sum=|name:&str|rows.iter().map(|r|r[name].as_f64().unwrap_or(0.0)).sum::<f64>();let settled=sum("settled_rows");let raw_bytes=sum("settled_row_bytes");let active=rows.iter().filter(|r|r["settled_rows"].as_f64().is_some_and(|n|n>0.0)).count();
            let mut out=base.clone();out["scan"]=json!("ok");out["read_units"]=json!(rows.len()+1);for field in ["settled_rows","settled_row_bytes","rollup_writes","rollup_bytes"]{out[field]=json!(sum(field));}
            out["active_days"]=json!(active);out["avg_row_bytes"]=if settled>0.0{json!((raw_bytes/settled).round())}else{Value::Null};out["avg_settled_rows_per_active_day"]=if active>0{json!((settled/active as f64*10.0).round()/10.0)}else{Value::Null};out["estimated_retained_rows"]=json!(settled);out["estimated_retained_raw_bytes"]=json!(raw_bytes);out["alert"]=json!(raw_bytes>=BUDGET as f64*0.8);
            let mut leader:Vec<Value>=rows.iter().filter(|r|store::safe_i64(&r["day_start_at_ms"]).is_some_and(|t|t>=day(at-30*store::DAY))).map(|r|{let mut value=json!({});for field in ["day_start_at_ms","settled_rows","settled_row_bytes","rollup_writes","rollup_bytes"]{value[field]=r[field].clone()}for(field,source)in[("projection_views","views"),("projection_read_units","read_units"),("projection_rollup_rows","rollup_rows")]{value[field]=json!(["projection_7d","projection_30d","projection_90d"].iter().map(|p|r[p][source].as_f64().unwrap_or(0.0)).sum::<f64>());}value}).collect();let excess=leader.len().saturating_sub(30);leader.drain(..excess);out["leaderboard"]=json!(leader);
            let projections:Vec<Value>=[7,30,90].into_iter().map(|window|{let name=format!("projection_{window}d");let views=rows.iter().map(|r|r[&name]["views"].as_f64().unwrap_or(0.0)).sum::<f64>();let reads=rows.iter().map(|r|r[&name]["read_units"].as_f64().unwrap_or(0.0)).sum::<f64>();let count=rows.iter().map(|r|r[&name]["rollup_rows"].as_f64().unwrap_or(0.0)).sum::<f64>();json!({"window_days":window,"views":views,"read_units":reads,"rollup_rows":count,"avg_read_units_per_view":if views>0.0{Some((reads/views*10.0).round()/10.0)}else{None},"avg_rollup_rows_per_view":if views>0.0{Some((count/views*10.0).round()/10.0)}else{None}})}).collect();out["projections"]=json!(projections);Ok(out)
        }.await;
        read.unwrap_or(base)
    }
}
