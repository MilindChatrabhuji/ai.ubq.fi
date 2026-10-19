use crate::{store::*, types::*};
use futures_util::future::join_all;
use gateway_core::GatewayError;
use gateway_core::{source_json::SourceJson, source_serialization as source};
use gateway_providers::extras;
use gateway_schema::source_request::source_value::Value as SourceValue;
use serde_json::{Value, json};
use std::{cell::Cell, rc::Rc};
const INPUT_BYTES: usize = 50 * 1024 * 1024;
const JSON_BYTES: usize = INPUT_BYTES.div_ceil(3) * 4 + 1024 * 1024;
fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}
fn headers(responses: &[&UpstreamResponse]) -> Headers {
    let mut out = Headers::new();
    let mut warnings = Vec::new();
    for response in responses {
        for value in header(&response.headers, "x-uos-warning")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if !warnings.contains(&value) {
                warnings.push(value)
            }
        }
    }
    if !warnings.is_empty() {
        out.insert("x-uos-warning".into(), warnings.join(", "));
    }
    for name in [
        "x-uos-upstream",
        "Retry-After",
        "RateLimit",
        "RateLimit-Policy",
        "RateLimit-Limit",
        "RateLimit-Remaining",
        "RateLimit-Reset",
    ] {
        if let Some(first) = responses.first().and_then(|r| header(&r.headers, name))
            && responses
                .iter()
                .all(|r| header(&r.headers, name) == Some(first))
        {
            out.insert(name.into(), first.into());
        }
    }
    out
}
fn aggregate_usage(responses: &[&UpstreamResponse]) -> Option<Value> {
    if !responses.iter().any(|r| r.usage.is_some()) {
        return None;
    }
    let sum = |name: &str| -> Option<f64> {
        responses
            .iter()
            .map(|r| r.usage.as_ref()?.get(name)?.as_f64())
            .try_fold(0.0, |n, x| Some(n + x?))
    };
    let cached: Option<f64> = responses
        .iter()
        .map(|r| {
            r.usage
                .as_ref()?
                .get("input_tokens_details")?
                .get("cached_tokens")?
                .as_f64()
        })
        .try_fold(0.0, |n, x| Some(n + x?));
    Some(
        json!({"input_tokens":sum("input_tokens"),"output_tokens":sum("output_tokens"),"total_tokens":sum("total_tokens"),"input_tokens_details":{"cached_tokens":cached}}),
    )
}
pub(crate) async fn images<H: ExtrasHost>(
    host: &H,
    request: &ExtrasRequest<'_>,
    kind: ImageKind,
) -> Result<ExtrasResponse, GatewayError> {
    if request.multipart.is_some() && kind == ImageKind::Generations {
        return Ok(ExtrasResponse::error(invalid(
            "Image generation requests must use a JSON object body.",
            None,
        )));
    }
    if request.multipart.is_some() && request.raw_body_bytes > 64 * 1024 * 1024 {
        return Ok(ExtrasResponse::error(invalid(
            "Multipart image edits must be no larger than 64 MiB.",
            Some("image"),
        )));
    }
    if request.body.as_str() == "null"
        || request.raw_body_bytes
            > if kind == ImageKind::Edits {
                JSON_BYTES
            } else {
                32 * 1024 * 1024
            }
    {
        return Ok(ExtrasResponse::error(invalid(
            if kind == ImageKind::Edits {
                "Image edits must use a JSON object or multipart form-data body."
            } else {
                "Image generation requests must use a JSON object body."
            },
            None,
        )));
    }
    let parsed = if let Some(files) = &request.multipart {
        extras::parse_source_multipart_image(&request.body, files)
    } else {
        extras::parse_source_image(&request.body, kind == ImageKind::Edits)
    };
    let parsed = match parsed {
        Ok(p) => p,
        Err(e) => return Ok(ExtrasResponse::source_error(e)),
    };
    let Some(model) = host.image_base_model().await? else {
        return Ok(ExtrasResponse::error(GatewayError::new(
            503,
            "No base model is available to host image generation.",
            Some("model_unavailable"),
        )));
    };
    let plan = extras::prepare_parsed_image(&parsed, &model, &request.context.request_id.0);
    if plan.count > 1
        && serde_json::to_vec(&plan.responses)
            .map_err(|_| invalid_state())?
            .len()
            > JSON_BYTES / plan.count as usize
    {
        return Ok(ExtrasResponse::error(invalid(
            "n and the translated image request exceed the fan-out work limit.",
            Some("n"),
        )));
    }
    host.begin_image_fanout(kind, plan.count as usize).await?;
    let first = Rc::new(Cell::new(None));
    let mut results = join_all(plan.request_ids.iter().enumerate().map(|(index, id)| {
        let first = first.clone();
        let body = plan.responses.clone();
        async move {
            let result = host
                .dispatch(ExtrasDispatch::ImageChild {
                    index,
                    kind,
                    request_id: id.clone(),
                    body,
                })
                .await;
            if (result.as_ref().is_err()
                || result
                    .as_ref()
                    .is_ok_and(|r| !(200..300).contains(&r.status)))
                && first.get().is_none()
            {
                first.set(Some(index));
                host.abort_image_siblings();
            }
            let settled = host.image_child_finished(index).await;
            (result, settled)
        }
    }))
    .await;
    host.finish_image_fanout().await?;
    let leader = first.get();
    if let Some(index) = leader.filter(|index| *index > 0) {
        let first = results.remove(index);
        results.insert(0, first);
    }
    for (_, settled) in &results {
        if let Err(e) = settled {
            return Err(e.clone());
        }
    }
    let successful: Vec<_> = results
        .iter()
        .filter_map(|(r, _)| r.as_ref().ok())
        .collect();
    let usage = aggregate_usage(&successful);
    let semantic = successful
        .first()
        .and_then(|first| {
            successful
                .iter()
                .all(|r| r.semantic_terminal == first.semantic_terminal)
                .then_some(first.semantic_terminal)
        })
        .flatten();
    let mut response = if let Some((Err(failure), _)) = results.first() {
        let mut r = ExtrasResponse::error(failure.error.as_ref().clone());
        r.headers.extend(failure.headers.clone());
        r.upstream_errors.push(failure.clone());
        r
    } else {
        let mut images = Vec::new();
        let mut created = None;
        let mut format = None;
        let mut consistent = true;
        let mut failure = None;
        for (result, _) in &results {
            let result = match result {
                Ok(r) => r,
                Err(e) => {
                    failure = Some(ExtrasResponse::error(e.error.as_ref().clone()));
                    break;
                }
            };
            let payload = if result.body.is_empty() {
                SourceValue::Null
            } else {
                match SourceJson::parse_bytes(&result.body).map(SourceValue::from_source) {
                    Ok(v) => v,
                    Err(_) => {
                        let mut r = ExtrasResponse::error(GatewayError::new(
                            502,
                            "Image upstream returned a non-JSON response.",
                            Some("upstream_invalid"),
                        ));
                        r.headers.extend(headers(&[result]));
                        failure = Some(r);
                        break;
                    }
                }
            };
            if !(200..300).contains(&result.status) {
                let mut r = ExtrasResponse::source_json(
                    result.status,
                    payload.source().expect("actual source image response"),
                );
                r.headers.extend(headers(&[result]));
                failure = Some(r);
                break;
            }
            let generated = extras::extract_source_images(
                &payload.source().expect("actual source image payload"),
            );
            let Some(image) = generated.first() else {
                let mut r = ExtrasResponse::error(GatewayError::new(
                    502,
                    "The model did not return an image for this request.",
                    Some("image_generation_failed"),
                ));
                r.headers.extend(headers(&successful));
                failure = Some(r);
                break;
            };
            images.push(image.clone());
            let next = payload["output"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|v| {
                    v["type"].as_str() == Some("image_generation_call")
                        && v["result"].as_str().is_some_and(|s| !s.is_empty())
                })
                .and_then(|v| v["output_format"].as_str())
                .filter(|s| ["png", "jpeg", "webp"].contains(s));
            if let Some(next) = next {
                if let Some(current) = &format {
                    if current != next {
                        consistent = false
                    }
                } else {
                    format = Some(next.to_owned())
                }
            } else {
                consistent = false
            }
            if created.is_none() {
                created = payload["created_at"].as_f64();
            }
        }
        if let Some(r) = failure {
            r
        } else {
            #[derive(serde::Serialize)]
            struct Body {
                created: f64,
                data: Vec<SourceJson>,
                #[serde(skip_serializing_if = "Option::is_none")]
                output_format: Option<String>,
            }
            let body = SourceJson::from_serializable(&Body {
                created: created.unwrap_or_else(|| (host.now_ms() / 1000) as f64),
                data: images,
                output_format: if consistent { format } else { None },
            })
            .expect("source generated image response");
            let mut r = ExtrasResponse::source_json(
                200,
                source::canonical(&body).expect("source image serialization"),
            );
            r.headers.extend(headers(&successful));
            r
        }
    };
    response.usage = usage;
    if response.status < 400 && successful.len() == results.len() {
        response.semantic_terminal = semantic;
    }
    Ok(response)
}
