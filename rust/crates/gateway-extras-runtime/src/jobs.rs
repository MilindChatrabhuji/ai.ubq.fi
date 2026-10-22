use crate::{
    cache::*,
    embeddings::{configured_error, fetch_chunk, result_body, retryable, usage},
    store::*,
    types::*,
};
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::STANDARD},
};
use gateway_auth::{AuthMethod, crypto::Secret};
use gateway_core::js_string::JsString16;
use gateway_core::{
    GatewayError,
    lifecycle::SemanticTerminal,
    query::QueryStore,
    state::{RecordKey, RecordMutation, StoredRecord},
};
use gateway_providers::extras::{self, EmbeddingsProfile};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
const TTL: i64 = 86_400_000;
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Job {
    id: String,
    status: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    model: String,
    cache_profile_key: String,
    upstream: String,
    upstream_model: String,
    input_type: String,
    dimensions: u64,
    output_dtype: String,
    encoding_format: String,
    truncation: bool,
    input_hashes: Vec<String>,
    input_count: usize,
    total_chars: usize,
    usage_total_tokens: u64,
    retry_after_seconds: Option<u64>,
    locked_until_ms: Option<i64>,
    error: Option<Value>,
}
#[derive(Deserialize, Serialize)]
struct InputRecord {
    v: u8,
    iv_b64: String,
    data_b64: String,
    created_at_ms: i64,
}
pub(crate) fn job_key(owner: &str, profile: &str, id: &str) -> RecordKey {
    key(json!(["embeddings", "jobs", "v2", owner, profile, id]))
}
pub(crate) fn lookup_key(owner: &str, id: &str) -> RecordKey {
    key(json!(["embeddings", "jobs", "v2", "lookup", owner, id]))
}
fn input_key(owner: &str, profile: &str, id: &str, hash: &str) -> RecordKey {
    key(json!([
        "embeddings",
        "jobs",
        "v2",
        "input",
        owner,
        profile,
        id,
        hash
    ]))
}
fn seed(request: &ExtrasRequest<'_>, id: &str) -> Secret {
    if let Some(id) = &request.context.key_id {
        return Secret::new(format!("uos_api_key_id:{}", id.0));
    }
    if let AuthMethod::GithubToken { owner, repo, .. } = &request.principal.method {
        return Secret::new(format!("uos_kernel_repo:{owner}/{repo}"));
    }
    request
        .principal
        .token
        .clone()
        .unwrap_or_else(|| Secret::new(id.into()))
}
fn crypto_key(seed: &Secret) -> [u8; 32] {
    Sha256::digest(format!("uos_embeddings_job_v2:{}", seed.expose()).as_bytes()).into()
}
fn decode64(value: &str) -> Option<Vec<u8>> {
    let cleaned: Vec<_> = value
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        .collect();
    GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
    .decode(cleaned)
    .ok()
}
async fn encrypt<H: ExtrasHost>(
    host: &H,
    seed: &Secret,
    text: &JsString16,
) -> Result<InputRecord, GatewayError> {
    let iv: [u8; 12] = host.random_bytes(12)?.try_into().map_err(|_| {
        server(
            "Embeddings encryption random source failed.",
            "embeddings_crypto_unavailable",
        )
    })?;
    let encoded = source_utf8(text);
    let cipher = host
        .aes_gcm_encrypt(&crypto_key(seed), &iv, encoded.as_bytes())
        .await?;
    if cipher.len() != encoded.len() + 16 {
        return Err(server(
            "Embeddings encryption returned invalid authenticated ciphertext.",
            "embeddings_crypto_unavailable",
        ));
    }
    Ok(InputRecord {
        v: 1,
        iv_b64: STANDARD.encode(iv),
        data_b64: STANDARD.encode(cipher),
        created_at_ms: now(host)?,
    })
}
async fn decrypt<H: ExtrasHost>(
    host: &H,
    seed: &Secret,
    record: &InputRecord,
) -> Option<JsString16> {
    let iv = decode64(&record.iv_b64)?;
    let data = decode64(&record.data_b64)?;
    let bytes = host
        .aes_gcm_decrypt(&crypto_key(seed), &iv, &data)
        .await
        .ok()?;
    Some(JsString16::from_utf8(&String::from_utf8_lossy(&bytes)))
}
fn profile(job: &Job) -> EmbeddingsProfile {
    EmbeddingsProfile {
        model: job.model.clone(),
        inputs: Vec::new(),
        input_type: job.input_type.clone(),
        dimensions: job.dimensions,
        encoding_format: job.encoding_format.clone(),
        truncation: job.truncation,
        cache_profile_key: job.cache_profile_key.clone(),
        total_chars: job.total_chars,
    }
}
fn body(job: &Job, result: Option<Value>) -> Value {
    json!({"id":job.id,"object":"embeddings.job","status":job.status,"created_at_ms":job.created_at_ms,"updated_at_ms":job.updated_at_ms,"model":job.model,"upstream":job.upstream,"upstream_model":job.upstream_model,"input_type":job.input_type,"dimensions":job.dimensions,"output_dtype":job.output_dtype,"encoding_format":job.encoding_format,"truncation":job.truncation,"input_count":job.input_count,"total_chars":job.total_chars,"retry_after_seconds":job.retry_after_seconds,"error":job.error,"result":result})
}
fn response(job: &Job, result: Option<Value>, status: u16) -> ExtrasResponse {
    ExtrasResponse::json(status, body(job, result)).voyage()
}
async fn update<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    owner: &str,
    job: &Job,
) -> Result<(), GatewayError> {
    let at = now(host)?;
    let writes = vec![
        put(
            host,
            job_key(owner, &job.cache_profile_key, &job.id),
            job,
            Some(at + TTL),
        )?,
        put(
            host,
            lookup_key(owner, &job.id),
            &json!({"cache_profile_key":job.cache_profile_key}),
            Some(at + TTL),
        )?,
    ];
    if commit(store, vec![], writes).await? {
        Ok(())
    } else {
        Err(server(
            "Embeddings job could not be persisted.",
            "server_error",
        ))
    }
}
async fn delete_inputs<S: QueryStore, H: ExtrasHost>(store: &S, _host: &H, owner: &str, job: &Job) {
    let unique: std::collections::BTreeSet<_> = job.input_hashes.iter().collect();
    for hash in unique {
        let _ = commit(
            store,
            vec![],
            vec![RecordMutation::Delete {
                key: input_key(owner, &job.cache_profile_key, &job.id, hash),
            }],
        )
        .await;
    }
}
async fn vectors<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    job: &Job,
) -> Result<Option<Vec<Vec<f64>>>, GatewayError> {
    let mut out = Vec::new();
    for hash in &job.input_hashes {
        let Some(v) = cached(
            store,
            &job.cache_profile_key,
            hash,
            job.dimensions,
            now(host)?,
        )
        .await?
        else {
            return Ok(None);
        };
        out.push(v)
    }
    Ok(Some(out))
}
async fn fail<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    owner: &str,
    job: &mut Job,
    message: impl Into<String>,
    code: &str,
) -> Result<ExtrasResponse, GatewayError> {
    job.status = "failed".into();
    job.updated_at_ms = now(host)?;
    job.locked_until_ms = None;
    job.retry_after_seconds = None;
    job.error = Some(json!({"message":message.into(),"type":"server_error","code":code}));
    update(store, host, owner, job).await?;
    delete_inputs(store, host, owner, job).await;
    let mut r = response(job, None, 200);
    r.semantic_terminal = Some(SemanticTerminal::Error);
    r.failure_kind = Some(code.into());
    Ok(r)
}
async fn queued<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    owner: &str,
    job: &mut Job,
    wait: u64,
    failure: Option<String>,
) -> Result<ExtrasResponse, GatewayError> {
    let seconds = retry_seconds(wait);
    job.status = "queued".into();
    job.updated_at_ms = now(host)?;
    job.locked_until_ms = None;
    job.retry_after_seconds = Some(seconds);
    job.error = None;
    update(store, host, owner, job).await?;
    let mut r = response(job, None, 202);
    r.headers.insert("Retry-After".into(), seconds.to_string());
    r.failure_kind = failure;
    Ok(r)
}
async fn succeeded<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    owner: &str,
    job: &mut Job,
) -> Result<ExtrasResponse, GatewayError> {
    let Some(vectors) = vectors(store, host, job).await? else {
        return fail(
            store,
            host,
            owner,
            job,
            "Embeddings job completed but cache entries were missing.",
            "embeddings_job_cache_miss",
        )
        .await;
    };
    job.status = "succeeded".into();
    job.updated_at_ms = now(host)?;
    job.locked_until_ms = None;
    job.retry_after_seconds = None;
    job.error = None;
    update(store, host, owner, job).await?;
    delete_inputs(store, host, owner, job).await;
    let mut r = response(
        job,
        Some(result_body(&profile(job), &vectors, job.usage_total_tokens)),
        200,
    );
    r.semantic_terminal = Some(SemanticTerminal::Completed);
    r.usage = (job.usage_total_tokens > 0).then(|| usage(job.usage_total_tokens));
    Ok(r)
}
struct JobAttempt<'a> {
    owner: &'a str,
    seed: &'a Secret,
    entry: Option<&'a StoredRecord>,
    job: Job,
    options: &'a gateway_providers::types::PrepareOptions,
    deadline: i64,
}
async fn attempt<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    input: JobAttempt<'_>,
) -> Result<ExtrasResponse, GatewayError> {
    let JobAttempt {
        owner,
        seed,
        entry,
        mut job,
        options,
        deadline,
    } = input;
    let at = now(host)?;
    if let Some(until) = job.locked_until_ms.filter(|e| *e > at) {
        let mut r = response(&job, None, 202);
        r.headers.insert(
            "Retry-After".into(),
            retry_seconds((until - at) as u64).to_string(),
        );
        return Ok(r);
    }
    let original = job.clone();
    job.status = "running".into();
    job.locked_until_ms = Some(at + 30_000);
    job.updated_at_ms = at;
    job.retry_after_seconds = None;
    let k = job_key(owner, &job.cache_profile_key, &job.id);
    if !commit(
        store,
        vec![check(&k, entry)],
        vec![
            put(host, k.clone(), &job, Some(at + TTL))?,
            put(
                host,
                lookup_key(owner, &job.id),
                &json!({"cache_profile_key":job.cache_profile_key}),
                Some(at + TTL),
            )?,
        ],
    )
    .await?
    {
        let mut r = response(&original, None, 202);
        r.headers.insert("Retry-After".into(), "1".into());
        return Ok(r);
    }
    let mut unique = Vec::new();
    for h in &job.input_hashes {
        if !unique.contains(h) {
            unique.push(h.clone());
        }
    }
    let mut missing = Vec::new();
    for hash in unique {
        if cached(
            store,
            &job.cache_profile_key,
            &hash,
            job.dimensions,
            now(host)?,
        )
        .await?
        .is_some()
        {
            continue;
        }
        let row = store
            .read(&input_key(owner, &job.cache_profile_key, &job.id, &hash))
            .await?;
        let raw: Option<Value> = decoded(row.as_ref(), now(host)?)?;
        let record = raw.and_then(|v| serde_json::from_value::<InputRecord>(v).ok());
        let Some(record) = record.filter(|r| {
            r.v == 1 && !r.iv_b64.is_empty() && !r.data_b64.is_empty() && r.created_at_ms >= 0
        }) else {
            return fail(
                store,
                host,
                owner,
                &mut job,
                "Embeddings job input expired or was unavailable.",
                "embeddings_job_input_missing",
            )
            .await;
        };
        let Some(text) = decrypt(host, seed, &record).await else {
            return fail(
                store,
                host,
                owner,
                &mut job,
                "Embeddings job input could not be decrypted.",
                "embeddings_job_input_decrypt_failed",
            )
            .await;
        };
        missing.push((hash, text));
    }
    if missing.is_empty() {
        return succeeded(store, host, owner, &mut job).await;
    }
    for chunk in chunks(&missing) {
        if now(host)? >= deadline {
            return queued(
                store,
                host,
                owner,
                &mut job,
                1000,
                Some("embeddings_job_deadline".into()),
            )
            .await;
        }
        let texts: Vec<_> = chunk.iter().map(|(_, s)| s.clone()).collect();
        let tokens = texts.iter().map(estimate).sum();
        if let Some(wait) = reserve(store, host, tokens, None).await? {
            return queued(store, host, owner, &mut job, wait.max(1000), None).await;
        }
        let fetched = fetch_chunk(host, &profile(&job), &texts, options, deadline).await;
        let (received, tokens) = match fetched {
            Ok(r) => r,
            Err(failure) => {
                if failure.quota_refusal {
                    return queued(store, host, owner, &mut job, 1000, None).await;
                }
                if let Some(status) = failure.upstream_status.filter(|s| retryable(*s)) {
                    let mut r = queued(
                        store,
                        host,
                        owner,
                        &mut job,
                        failure
                            .retry_after_ms
                            .unwrap_or(if status == 429 { 60_000 } else { 1000 }),
                        Some(format!("embeddings_job_upstream_http_{status}")),
                    )
                    .await?;
                    r.upstream_errors.push(failure);
                    return Ok(r);
                }
                let mut r = fail(
                    store,
                    host,
                    owner,
                    &mut job,
                    format!("Embeddings upstream request failed: {}", failure.error),
                    "embeddings_job_upstream_error",
                )
                .await?;
                r.upstream_errors.push(failure);
                return Ok(r);
            }
        };
        if received.len() != chunk.len() {
            return fail(
                store,
                host,
                owner,
                &mut job,
                "Embeddings upstream returned a size mismatch.",
                "embeddings_job_upstream_mismatch",
            )
            .await;
        }
        if let Some(v) = received.iter().find(|v| v.len() != job.dimensions as usize) {
            let message = format!(
                "Embeddings upstream returned vector length {}; expected {}.",
                v.len(),
                job.dimensions
            );
            return fail(
                store,
                host,
                owner,
                &mut job,
                message,
                "embeddings_job_upstream_dimension_mismatch",
            )
            .await;
        }
        if let Some(n) = tokens {
            job.usage_total_tokens = job.usage_total_tokens.saturating_add(n);
        }
        for ((hash, _), v) in chunk.iter().zip(&received) {
            cache_best_effort(store, host, &job.cache_profile_key, hash, v, deadline).await;
        }
    }
    if vectors(store, host, &job).await?.is_some() {
        succeeded(store, host, owner, &mut job).await
    } else {
        queued(store, host, owner, &mut job, 60_000, None).await
    }
}
pub(crate) async fn create<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    request: &ExtrasRequest<'_>,
) -> Result<ExtrasResponse, GatewayError> {
    let started = now(host)?;
    let p = match extras::parse_source_embeddings(&request.body, true) {
        Ok(p) => p,
        Err(e) => return Ok(ExtrasResponse::source_error(e)),
    };
    let Some(options) = host.provider_options(ExtrasProvider::Voyage).await? else {
        return Ok(ExtrasResponse::error(configured_error()));
    };
    let id = format!("embjob_{}", uuid(host)?.replace('-', ""));
    let seed = seed(request, &id);
    let owner = hash(seed.expose());
    let at = now(host)?;
    let hashes: Vec<_> = p.inputs.iter().map(hash_source).collect();
    let mut unique = std::collections::BTreeMap::new();
    for (text, h) in p.inputs.iter().zip(&hashes) {
        unique.insert(h, text);
    }
    for (h, text) in unique {
        let encrypted = encrypt(host, &seed, text).await?;
        if !commit(
            store,
            vec![],
            vec![put(
                host,
                input_key(&owner, &p.cache_profile_key, &id, h),
                &encrypted,
                Some(now(host)? + TTL),
            )?],
        )
        .await?
        {
            return Err(server(
                "Embeddings job could not be persisted.",
                "server_error",
            ));
        }
    }
    let job = Job {
        id: id.clone(),
        status: "queued".into(),
        created_at_ms: at,
        updated_at_ms: at,
        model: p.model,
        cache_profile_key: p.cache_profile_key,
        upstream: "voyage".into(),
        upstream_model: "voyage-4-large".into(),
        input_type: p.input_type,
        dimensions: p.dimensions,
        output_dtype: "float".into(),
        encoding_format: p.encoding_format,
        truncation: p.truncation,
        input_hashes: hashes,
        input_count: p.inputs.len(),
        total_chars: p.total_chars,
        usage_total_tokens: 0,
        retry_after_seconds: None,
        locked_until_ms: None,
        error: None,
    };
    update(store, host, &owner, &job).await?;
    let row = store
        .read(&job_key(&owner, &job.cache_profile_key, &id))
        .await?;
    let value: Job = decoded(row.as_ref(), now(host)?)?
        .ok_or_else(|| server("Embeddings job could not be persisted.", "server_error"))?;
    attempt(
        store,
        host,
        JobAttempt {
            owner: &owner,
            seed: &seed,
            entry: row.as_ref(),
            job: value,
            options: &options,
            deadline: started + TIMEOUT_MS,
        },
    )
    .await
}
pub(crate) async fn get<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    request: &ExtrasRequest<'_>,
    id: &str,
) -> Result<ExtrasResponse, GatewayError> {
    let started = now(host)?;
    let seed = seed(request, id);
    let owner = hash(seed.expose());
    let lookup = store.read(&lookup_key(&owner, id)).await?;
    let lookup: Option<Value> = decoded(lookup.as_ref(), started)?;
    let not_found =
        || GatewayError::new(404, "Embeddings job not found", Some("not_found")).with_param(None);
    let Some(profile) = lookup
        .as_ref()
        .and_then(|v| v["cache_profile_key"].as_str())
        .filter(|s| !s.is_empty())
    else {
        return Ok(ExtrasResponse::error(not_found()));
    };
    let row = store.read(&job_key(&owner, profile, id)).await?;
    let Some(mut job) = decoded::<Job>(row.as_ref(), now(host)?)? else {
        return Ok(ExtrasResponse::error(not_found()));
    };
    if job.cache_profile_key != profile {
        return Ok(ExtrasResponse::error(not_found()));
    }
    if job.status == "succeeded" {
        if let Some(v) = vectors(store, host, &job).await? {
            return Ok(response(
                &job,
                Some(result_body(
                    &self::profile(&job),
                    &v,
                    job.usage_total_tokens,
                )),
                200,
            ));
        }
        job.status = "failed".into();
        job.updated_at_ms = now(host)?;
        job.locked_until_ms = None;
        job.retry_after_seconds = None;
        job.error = Some(
            json!({"message":"Embeddings job result was unavailable; please resubmit.","type":"server_error","code":"embeddings_job_result_missing"}),
        );
        update(store, host, &owner, &job).await?;
        return Ok(response(&job, None, 200));
    }
    if job.status == "failed" {
        return Ok(response(&job, None, 200));
    }
    let Some(options) = host.provider_options(ExtrasProvider::Voyage).await? else {
        return Ok(ExtrasResponse::error(configured_error()));
    };
    attempt(
        store,
        host,
        JobAttempt {
            owner: &owner,
            seed: &seed,
            entry: row.as_ref(),
            job,
            options: &options,
            deadline: started + TIMEOUT_MS,
        },
    )
    .await
}
