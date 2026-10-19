use gateway_core::provider::UpstreamProvider;
use gateway_providers::*;
use serde_json::json;

fn options() -> PrepareOptions {
    PrepareOptions {
        auth: AuthMaterial {
            secret: "fixture-provider-key".into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn every_surplus_inference_post_opts_in_exactly_once_in_both_wire_and_client_modes() {
    for stream in [false, true] {
        for model in ["gpt-fixture", "claude-sonnet-4-6"] {
            for surface in [ClientSurface::Responses, ClientSurface::Chat] {
                let body = if surface == ClientSurface::Chat {
                    json!({"model":model,"messages":[{"role":"user","content":"hello"}],"stream":stream})
                } else {
                    json!({"model":model,"input":"hello","stream":stream})
                };
                let request =
                    prepare_request(UpstreamProvider::Surplus, surface, &body, &options()).unwrap();
                assert_eq!(request.method, "POST");
                let headers = request
                    .headers
                    .iter()
                    .filter(|(key, _)| key.eq_ignore_ascii_case("x-si-mask-secrets"))
                    .collect::<Vec<_>>();
                assert_eq!(headers.len(), 1);
                assert_eq!(headers[0].1, "on");
                assert_eq!(
                    request.headers["Authorization"],
                    "Bearer fixture-provider-key"
                );
                assert_eq!(
                    request.url,
                    if model.starts_with("claude-") {
                        "https://api.surplusintelligence.ai/v1/chat/completions"
                    } else {
                        "https://api.surplusintelligence.ai/v1/responses"
                    }
                );
                assert_eq!(request.decode.stream, stream);
            }
        }
    }
}

#[test]
fn masking_opt_in_does_not_escape_to_other_bearer_provider_requests() {
    let request = prepare_request(
        UpstreamProvider::Metered,
        ClientSurface::Responses,
        &json!({"model":"gpt-fixture","input":"hello"}),
        &options(),
    )
    .unwrap();
    assert!(
        request
            .headers
            .keys()
            .all(|name| !name.eq_ignore_ascii_case("x-si-mask-secrets"))
    );
}
