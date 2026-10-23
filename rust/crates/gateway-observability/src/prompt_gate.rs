//! Source cache/telemetry-gate.ts: release-bound Stage0 actual completion evidence.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{
    counters,
    prompt::{PROVIDERS, PromptEvent, ROUTES, known_release, model_hash, model_text},
    store,
};
use gateway_auth::crypto::sha256_hex;
use gateway_core::{GatewayError, query::QueryStore, state::RecordKey};
use serde_json::{Value, json};

fn counter_key(
    release: &str,
    provider: &str,
    model: &str,
    route: &str,
    counter: &str,
) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "prompt_cache_telemetry_gate",
        "v1",
        release,
        provider,
        model,
        route,
        counter
    ]))
}
fn result(
    status: &str,
    reason: &str,
    release: Option<&str>,
    provider: Option<&str>,
    route: Option<&str>,
    model: Option<&str>,
) -> Value {
    json!({"status":status,"reason":reason,"release":release,"provider":provider,"route":route,"model_hash":model})
}
fn summary(c: &[u128; 4]) -> Value {
    let coverage = |n: u128| {
        (n * 1_000_000)
            .checked_div(c[0])
            .map(|n| json!(n as f64 / 1_000_000.0))
            .unwrap_or(Value::Null)
    };
    json!({"completed":c[0].to_string(),"reported":c[1].to_string(),"cache_write_reported":c[2].to_string(),"invalid":c[3].to_string(),"reported_coverage":coverage(c[1]),"reported_coverage_passed":c[0]>0&&c[1]*200>=c[0]*199,"cache_write_reported_coverage":coverage(c[2]),"cache_write_reported_coverage_passed":c[0]>0&&c[2]*200>=c[0]*199})
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn record_prompt_telemetry(&self, event: &PromptEvent, release: &str) -> Value {
        let Some(release) = known_release(release) else {
            return result("ignored", "unknown_release", None, None, None, None);
        };
        if !event.completed || !(200..300).contains(&event.status) {
            return result(
                "ignored",
                "not_completed_2xx",
                Some(&release),
                None,
                None,
                None,
            );
        }
        let Some(provider) = event.provider.as_deref().filter(|s| PROVIDERS.contains(s)) else {
            return result(
                "ignored",
                "unsupported_provider",
                Some(&release),
                None,
                None,
                None,
            );
        };
        if !ROUTES.contains(&event.route.as_str()) {
            return result(
                "ignored",
                "unsupported_route",
                Some(&release),
                Some(provider),
                None,
                None,
            );
        }
        let Some(model) = model_hash(
            event.model.as_ref(),
            "uos-prompt-cache-telemetry-model-v1\0",
        ) else {
            return result(
                "ignored",
                "invalid_model",
                Some(&release),
                Some(provider),
                Some(&event.route),
                None,
            );
        };
        let mut deltas = vec![(
            counter_key(&release, provider, &model, &event.route, "completed"),
            1,
        )];
        if event.usage_telemetry_status == "reported" {
            deltas.push((
                counter_key(&release, provider, &model, &event.route, "reported"),
                1,
            ));
            if event.cache_write_tokens_present {
                deltas.push((
                    counter_key(
                        &release,
                        provider,
                        &model,
                        &event.route,
                        "cache_write_reported",
                    ),
                    1,
                ));
            }
        }
        if event.usage_telemetry_status == "invalid" {
            deltas.push((
                counter_key(&release, provider, &model, &event.route, "invalid"),
                1,
            ));
        }
        let record = async {
            let at = store::now(self.host.as_ref())?;
            for _ in 0..33 {
                if counters::add(
                    self.store.as_ref(),
                    self.host.as_ref(),
                    at,
                    &deltas,
                    Vec::new(),
                    Vec::new(),
                )
                .await?
                {
                    return Ok(());
                }
            }
            Err(store::error("Stage0 counter contention"))
        }
        .await;
        match record {
            Ok(()) => result(
                "recorded",
                "recorded",
                Some(&release),
                Some(provider),
                Some(&event.route),
                Some(&model),
            ),
            Err(_) => result(
                "unavailable",
                "kv_unavailable",
                Some(&release),
                Some(provider),
                Some(&event.route),
                Some(&model),
            ),
        }
    }
    pub async fn prompt_telemetry_baseline(
        &self,
        provider: &str,
        model: &str,
        release: &str,
    ) -> Value {
        let unavailable = |reason: &str,
                           release: Option<&str>,
                           provider: Option<&str>,
                           model: Option<&str>| json!({"status":if reason=="kv_unavailable"{"unavailable"}else{"not_ready"},"reason":reason,"release":release,"provider":provider,"model_hash":model,"aggregate":null,"routes":[]});
        let Some(release) = known_release(release) else {
            return unavailable("unknown_release", None, None, None);
        };
        let Some(model) = model_text(Some(model)).filter(|_| PROVIDERS.contains(&provider)) else {
            return unavailable(
                "unsupported_target",
                Some(&release),
                PROVIDERS.contains(&provider).then_some(provider),
                None,
            );
        };
        let model = sha256_hex(format!("uos-prompt-cache-telemetry-model-v1\0{model}").as_bytes());
        let read=async{
            let at=store::now(self.host.as_ref())?;let mut aggregate=[0u128;4];let mut routes=Vec::new();
            for route in ROUTES{
                let mut values=[None;4];for(i,counter)in ["completed","reported","cache_write_reported","invalid"].iter().enumerate(){let row=self.store.read(&counter_key(&release,provider,&model,route,counter)).await?;let Ok(value)=counters::read(row.as_ref(),at)else{return Ok(unavailable("invalid_counter",Some(&release),Some(provider),Some(&model)))};values[i]=value;}
                if values[0].is_none()&&values.iter().any(Option::is_some){return Ok(unavailable("invalid_counter",Some(&release),Some(provider),Some(&model)))}
                let c=values.map(|n|u128::from(n.unwrap_or(0)));if c[1]>c[0]||c[2]>c[1]||c[3]>c[0]||c[1]+c[3]>c[0]{return Ok(unavailable("invalid_counter",Some(&release),Some(provider),Some(&model)))}
                for(i,n)in c.iter().enumerate(){aggregate[i]+=n;}
                let mut value=summary(&c);value["route"]=json!(route);value["observed"]=json!(c[0]>0);value["completed_minimum_passed"]=json!(c[0]>=1000);routes.push(value);
            }
            let summed=summary(&aggregate);let observed:Vec<&Value>=routes.iter().filter(|r|r["observed"]==true).collect();
            let gates=[(aggregate[0]>=10000,"aggregate_completed_below_minimum"),(observed.iter().all(|r|r["completed_minimum_passed"]==true),"route_completed_below_minimum"),(summed["reported_coverage_passed"]==true,"aggregate_reported_coverage_below_minimum"),(observed.iter().all(|r|r["reported_coverage_passed"]==true),"route_reported_coverage_below_minimum"),(summed["cache_write_reported_coverage_passed"]==true,"aggregate_cache_write_reported_coverage_below_minimum"),(observed.iter().all(|r|r["cache_write_reported_coverage_passed"]==true),"route_cache_write_reported_coverage_below_minimum")];
            let reason=gates.iter().find(|g|!g.0).map(|g|g.1).unwrap_or("eligible");Ok(json!({"status":if reason=="eligible"{"eligible"}else{"not_ready"},"reason":reason,"release":release,"provider":provider,"model_hash":model,"aggregate":summed,"routes":routes}))
        }.await;
        read.unwrap_or_else(|_: GatewayError| {
            unavailable(
                "kv_unavailable",
                Some(&release),
                Some(provider),
                Some(&model),
            )
        })
    }
}
