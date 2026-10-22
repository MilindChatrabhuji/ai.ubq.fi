use crate::{
    cache::*,
    idempotency::{self, Acquired, Lease},
    store::*,
    types::*,
};
use chrono::{DateTime, Utc};
use gateway_core::{GatewayError, lifecycle::SemanticTerminal, query::QueryStore};
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use gateway_providers::{
    extras::{self, EmbeddingsProfile},
    types::PrepareOptions,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
pub(crate) fn configured_error() -> GatewayError {
    GatewayError::unavailable(
        "Embeddings provider is not configured: set VOYAGEAI_API_KEY (or store it in Deno KV)",
        "server_error",
    )
    .with_param(None)
}
fn retry_after(headers: &Headers, at: i64) -> Option<u64> {
    let value = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("Retry-After"))?
        .1
        .trim();
    if let Ok(seconds) = value.parse::<f64>()
        && seconds.is_finite()
        && seconds > 0.0
    {
        return Some((seconds * 1000.0).trunc().min(60_000.0) as u64);
    }
    let when = DateTime::parse_from_rfc2822(value)
        .ok()?
        .with_timezone(&Utc)
        .timestamp_millis();
    (when > at).then_some((when - at).min(60_000) as u64)
}
pub(crate) fn retryable(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}
pub(crate) async fn fetch_chunk<H: ExtrasHost>(
    host: &H,
    profile: &EmbeddingsProfile,
    inputs: &[JsString16],
    options: &PrepareOptions,
    deadline: i64,
) -> Result<(Vec<Vec<f64>>, Option<u64>), DispatchFailure> {
    #[derive(serde::Serialize)]
    struct Chunk<'a> {
        model: &'a str,
        input: &'a [JsString16],
        input_type: &'a str,
        dimensions: u64,
        encoding_format: &'a str,
        truncation: bool,
    }
    let raw = SourceJson::from_serializable(&Chunk {
        model: &profile.model,
        input: inputs,
        input_type: &profile.input_type,
        dimensions: profile.dimensions,
        encoding_format: "float",
        truncation: profile.truncation,
    })
    .map_err(DispatchFailure::transport)?;
    let prepared = extras::prepare_source_embeddings(&raw, options)
        .map_err(|error| DispatchFailure::transport(error.diagnostic().clone()))?;
    let response = host
        .dispatch(ExtrasDispatch::Voyage(PreparedCall {
            prepared,
            deadline_ms: deadline,
        }))
        .await?;
    if !(200..300).contains(&response.status) {
        return Err(DispatchFailure {
            origin: DispatchFailureOrigin::Upstream,
            error: Box::new(server(
                format!("Voyage embeddings failed ({}).", response.status),
                "upstream_error",
            )),
            headers: response.headers.clone(),
            quota_refusal: false,
            upstream_status: Some(response.status),
            retry_after_ms: retry_after(&response.headers, host.now_ms()),
            before_transport: false,
            raw_error_body: Some(response.body),
        });
    }
    let payload: Value = serde_json::from_slice(&response.body).map_err(|_| {
        DispatchFailure::transport(server(
            "Voyage embeddings returned invalid JSON.",
            "upstream_error",
        ))
    })?;
    let rows = payload["data"].as_array().ok_or_else(|| {
        DispatchFailure::transport(server(
            "Voyage embeddings returned invalid JSON.",
            "upstream_error",
        ))
    })?;
    let mut vectors = Vec::new();
    for row in rows {
        let values = row["embedding"].as_array().ok_or_else(|| {
            DispatchFailure::transport(server(
                "Voyage embeddings response missing embedding vector.",
                "upstream_error",
            ))
        })?;
        let vector = values
            .iter()
            .map(|v| {
                v.as_f64().filter(|n| n.is_finite()).ok_or_else(|| {
                    DispatchFailure::transport(server(
                        "Voyage embeddings response contained non-numeric values.",
                        "upstream_error",
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        vectors.push(vector);
    }
    let tokens = payload["usage"]["total_tokens"]
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|v| v.max(0.0).trunc() as u64);
    Ok((vectors, tokens))
}
pub(crate) fn result_body(profile: &EmbeddingsProfile, vectors: &[Vec<f64>], tokens: u64) -> Value {
    let data: Vec<Value> = vectors
        .iter()
        .enumerate()
        .map(|(index, vector)| {
            let embedding = if profile.encoding_format == "base64" {
                json!(extras::base64_encode(
                    &vector
                        .iter()
                        .flat_map(|v| (*v as f32).to_le_bytes())
                        .collect::<Vec<_>>()
                ))
            } else {
                json!(vector)
            };
            json!({"object":"embedding","index":index,"embedding":embedding})
        })
        .collect();
    json!({"object":"list","data":data,"model":profile.model,"usage":{"prompt_tokens":tokens,"total_tokens":tokens}})
}
pub(crate) fn usage(tokens: u64) -> Value {
    json!({"input_tokens":tokens,"output_tokens":0,"total_tokens":tokens})
}
struct SyncLease {
    lease: Option<Lease>,
    dispatched: bool,
    confirmed: bool,
}
impl SyncLease {
    async fn before_failure<S: QueryStore, H: ExtrasHost>(
        &self,
        store: &S,
        host: &H,
        response: ExtrasResponse,
    ) -> ExtrasResponse {
        if let Some(lease) = &self.lease {
            if self.dispatched {
                idempotency::mark_indeterminate(store, host, lease).await;
                return idempotency::indeterminate();
            }
            if !idempotency::release(store, host, lease, false).await {
                return idempotency::unavailable();
            }
        }
        response
    }
    async fn explicit_failure<S: QueryStore, H: ExtrasHost>(
        &self,
        store: &S,
        host: &H,
        response: ExtrasResponse,
    ) -> ExtrasResponse {
        if let Some(lease) = &self.lease {
            if self.confirmed {
                idempotency::mark_indeterminate(store, host, lease).await;
                return idempotency::indeterminate();
            }
            if !idempotency::release(store, host, lease, true).await {
                idempotency::mark_indeterminate(store, host, lease).await;
                return idempotency::indeterminate();
            }
        }
        response
    }
    async fn ambiguous<S: QueryStore, H: ExtrasHost>(&self, store: &S, host: &H) -> ExtrasResponse {
        if let Some(lease) = &self.lease {
            idempotency::mark_indeterminate(store, host, lease).await;
        }
        idempotency::indeterminate()
    }
}
pub(crate) async fn sync<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    request: &ExtrasRequest<'_>,
) -> Result<ExtrasResponse, GatewayError> {
    let owner = uuid(host)?;
    let started = now(host)?;
    let deadline = started + TIMEOUT_MS;
    let profile = match extras::parse_source_embeddings(&request.body, false) {
        Ok(p) => p,
        Err(e) => return Ok(ExtrasResponse::source_error(e)),
    };
    let hashes: Vec<_> = profile.inputs.iter().map(hash_source).collect();
    let mut lease = SyncLease {
        lease: None,
        dispatched: false,
        confirmed: false,
    };
    if let Some(id) = &request.idempotency_key {
        if id.is_empty()
            || id.encode_utf16().count() > 255
            || id.chars().any(|c| (c as u32) <= 0x1f || c == '\u{7f}')
        {
            return Ok(ExtrasResponse::error(invalid(
                "Idempotency-Key must contain 1-255 non-control characters.",
                None,
            )));
        }
        let principal = request.context.principal.0.trim_matches(js_whitespace);
        if principal.is_empty() {
            return Ok(idempotency::unavailable());
        }
        let fingerprint = hash(
            &json!([
                "uos-embeddings-idempotency-v1",
                "voyage",
                "voyage-4-large",
                profile.input_type,
                profile.dimensions,
                "float",
                profile.encoding_format,
                profile.truncation,
                hashes
            ])
            .to_string(),
        );
        match idempotency::acquire(store, host, principal, id, fingerprint, owner).await {
            Acquired::Lease(value) => lease.lease = Some(value),
            Acquired::Response(response) => return Ok(response),
        }
    }
    let Some(options) = host.provider_options(ExtrasProvider::Voyage).await? else {
        return Ok(lease
            .before_failure(store, host, ExtrasResponse::error(configured_error()))
            .await);
    };
    let mut buckets: BTreeMap<String, (JsString16, Vec<usize>)> = BTreeMap::new();
    let mut order = Vec::new();
    for (index, (text, hash)) in profile.inputs.iter().zip(&hashes).enumerate() {
        if !buckets.contains_key(hash) {
            order.push(hash.clone());
        }
        let item = buckets
            .entry(hash.clone())
            .or_insert_with(|| (text.clone(), Vec::new()));
        item.1.push(index);
    }
    let mut vectors: Vec<Option<Vec<f64>>> = vec![None; profile.inputs.len()];
    let mut missing = Vec::new();
    for hash in order {
        let (text, indexes) = &buckets[&hash];
        if let Some(vector) = cached(
            store,
            &profile.cache_profile_key,
            &hash,
            profile.dimensions,
            now(host)?,
        )
        .await?
        {
            for &index in indexes {
                vectors[index] = Some(vector.clone());
            }
        } else {
            missing.push((hash, text.clone()));
        }
    }
    let mut total_tokens = 0;
    let mut saw_tokens = false;
    for chunk in chunks(&missing) {
        if now(host)? >= deadline {
            return Ok(lease
                .before_failure(
                    store,
                    host,
                    ExtrasResponse::error(server("Embeddings request timed out.", "timeout")),
                )
                .await);
        }
        let texts: Vec<_> = chunk.iter().map(|(_, t)| t.clone()).collect();
        let estimated = texts.iter().map(estimate).sum();
        if let Some(wait) = reserve(store, host, estimated, Some(deadline)).await? {
            let seconds = retry_seconds(wait);
            let mut r = ExtrasResponse::error(
                GatewayError::new(
                    429,
                    format!("Rate limit exceeded; retry after ~{seconds}s"),
                    Some("rate_limit_exceeded"),
                )
                .with_type("rate_limit_error")
                .with_param(None),
            );
            r.headers.insert("Retry-After".into(), seconds.to_string());
            return Ok(lease.before_failure(store, host, r).await);
        }
        let mut attempt = 0;
        let mut backoff = 250;
        let (received, tokens) = loop {
            if host.cancelled() {
                return Ok(lease
                    .before_failure(store, host, ExtrasResponse::error(cancelled()))
                    .await);
            }
            if let Some(record) = &lease.lease
                && !lease.dispatched
            {
                if !idempotency::mark_dispatched(store, host, record).await {
                    return Ok(idempotency::unavailable());
                }
                lease.dispatched = true;
            }
            match fetch_chunk(host, &profile, &texts, &options, deadline).await {
                Ok(value) => {
                    if lease.lease.is_some() {
                        lease.confirmed = true;
                    }
                    break value;
                }
                Err(failure) => {
                    if host.cancelled() {
                        return Ok(lease
                            .before_failure(store, host, ExtrasResponse::error(cancelled()))
                            .await);
                    }
                    if failure.quota_refusal {
                        if let Some(record) = &lease.lease
                            && !idempotency::release(store, host, record, lease.dispatched).await
                        {
                            return Ok(idempotency::unavailable());
                        }
                        let mut r = ExtrasResponse::error(failure.error.as_ref().clone());
                        r.headers.extend(failure.headers.clone());
                        r.upstream_errors.push(failure);
                        return Ok(r);
                    }
                    let Some(status) = failure.upstream_status else {
                        let mut response = lease.ambiguous(store, host).await;
                        response.upstream_errors.push(failure);
                        return Ok(response);
                    };
                    let wait = failure.retry_after_ms.unwrap_or(backoff);
                    let mut r = ExtrasResponse::error(server(
                        format!("Embeddings upstream request failed: {}", failure.error),
                        "upstream_error",
                    ));
                    if retryable(status)
                        && attempt < 2
                        && now(host)?.saturating_add(wait as i64) < deadline
                    {
                        if let Err(e) = host.sleep_ms(wait).await {
                            if host.cancelled() {
                                return Ok(lease
                                    .before_failure(store, host, ExtrasResponse::error(cancelled()))
                                    .await);
                            }
                            return Err(e);
                        }
                        attempt += 1;
                        backoff = (backoff * 2).min(2000);
                        continue;
                    }
                    if status == 429 && retryable(status) {
                        let seconds = retry_seconds(wait);
                        r = ExtrasResponse::error(
                            GatewayError::new(
                                429,
                                format!("Embeddings upstream request failed: {}", failure.error),
                                Some("rate_limit_exceeded"),
                            )
                            .with_type("rate_limit_error")
                            .with_param(None),
                        );
                        r.headers.insert("Retry-After".into(), seconds.to_string());
                    }
                    r.upstream_errors.push(failure);
                    return Ok(lease.explicit_failure(store, host, r).await);
                }
            }
        };
        if received.len() != chunk.len() {
            return Ok(lease
                .before_failure(
                    store,
                    host,
                    ExtrasResponse::error(server(
                        "Embeddings upstream returned a size mismatch.",
                        "upstream_error",
                    )),
                )
                .await);
        }
        if let Some(vector) = received
            .iter()
            .find(|v| v.len() != profile.dimensions as usize)
        {
            return Ok(lease
                .before_failure(
                    store,
                    host,
                    ExtrasResponse::error(server(
                        format!(
                            "Embeddings upstream returned vector length {}; expected {}.",
                            vector.len(),
                            profile.dimensions
                        ),
                        "upstream_dimension_mismatch",
                    )),
                )
                .await);
        }
        if let Some(tokens) = tokens {
            saw_tokens = true;
            total_tokens += tokens;
        }
        for ((hash, _), vector) in chunk.iter().zip(&received) {
            for &index in &buckets[hash].1 {
                vectors[index] = Some(vector.clone());
            }
            cache_best_effort(
                store,
                host,
                &profile.cache_profile_key,
                hash,
                vector,
                deadline,
            )
            .await;
        }
    }
    let Some(vectors) = vectors.into_iter().collect::<Option<Vec<_>>>() else {
        return Ok(lease
            .before_failure(
                store,
                host,
                ExtrasResponse::error(server(
                    "Embeddings gateway failed to construct a complete response.",
                    "server_error",
                )),
            )
            .await);
    };
    let mut response = ExtrasResponse::json(200, result_body(&profile, &vectors, total_tokens));
    response.semantic_terminal = Some(SemanticTerminal::Completed);
    response.usage = saw_tokens.then(|| usage(total_tokens));
    if let Some(record) = &lease.lease
        && !idempotency::success(store, host, record, &response).await
    {
        if lease.dispatched {
            return Ok(lease.ambiguous(store, host).await);
        }
        return Ok(lease
            .before_failure(store, host, idempotency::unavailable())
            .await);
    }
    Ok(response)
}
