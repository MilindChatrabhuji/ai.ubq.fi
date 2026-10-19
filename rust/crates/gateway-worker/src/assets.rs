//! Immutable source assets and the existing homepage content negotiation.
use gateway_core::GatewayError;
use gateway_schema::util::js_trim;
use serde_json::json;
use worker::{Env, Method, Request, RequestInit, Response};

const ROOT_VARY: &str = "Accept, Accept-Encoding";
const CSP: &str = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self' https://ai.ubq.fi";

#[derive(Clone, Copy)]
struct Preference {
    quality: f64,
    specificity: u8,
    index: usize,
}

fn quality(raw: &str) -> f64 {
    let raw = js_trim(raw);
    let number = ["0x", "0b", "0o"]
        .iter()
        .enumerate()
        .find_map(|(index, prefix)| {
            raw.to_ascii_lowercase().strip_prefix(prefix).map(|digits| {
                u64::from_str_radix(digits, [16, 2, 8][index])
                    .ok()
                    .map(|n| n as f64)
            })
        })
        .unwrap_or_else(|| raw.parse::<f64>().ok());
    number
        .filter(|n| n.is_finite() && (0.0..=1.0).contains(n))
        .unwrap_or(0.0)
}

fn preference(accept: &str, target: (&str, &str)) -> Option<Preference> {
    let mut best: Option<Preference> = None;
    for (index, entry) in accept.split(',').enumerate() {
        let entry = js_trim(entry).to_ascii_lowercase();
        let mut components = entry.split(';');
        let mut range = js_trim(components.next().unwrap_or_default()).split('/');
        let Some(kind) = range.next() else {
            continue;
        };
        let Some(subtype) = range.next() else {
            continue;
        };
        if (kind != "*" && kind != target.0) || (subtype != "*" && subtype != target.1) {
            continue;
        }
        let quality = components
            .find_map(|parameter| {
                let mut pair = js_trim(parameter).splitn(2, '=');
                (pair.next() == Some("q")).then(|| pair.next().map_or(1.0, quality))
            })
            .unwrap_or(1.0);
        let candidate = Preference {
            quality,
            specificity: if kind == "*" {
                0
            } else if subtype == "*" {
                1
            } else {
                2
            },
            index,
        };
        if best.is_none_or(|old| {
            candidate.specificity > old.specificity
                || (candidate.specificity == old.specificity && candidate.index < old.index)
        }) {
            best = Some(candidate);
        }
    }
    best
}

fn preferred(left: Option<Preference>, right: Option<Preference>) -> Option<Preference> {
    match (left, right) {
        (None, value) | (value, None) => value,
        (Some(left), Some(right)) => {
            if left.quality > right.quality
                || (left.quality == right.quality
                    && (left.specificity > right.specificity
                        || (left.specificity == right.specificity && left.index < right.index)))
            {
                Some(left)
            } else {
                Some(right)
            }
        }
    }
}

fn root_representation(accept: &str) -> Option<&'static str> {
    if js_trim(accept).is_empty() {
        return Some("html");
    }
    let mut candidates = [
        (
            "html",
            preferred(
                preference(accept, ("text", "html")),
                preference(accept, ("application", "xhtml+xml")),
            ),
            2,
        ),
        ("markdown", preference(accept, ("text", "markdown")), 1),
        ("json", preference(accept, ("application", "json")), 0),
    ]
    .into_iter()
    .filter_map(|(kind, value, priority)| {
        value
            .filter(|p| p.quality > 0.0)
            .map(|value| (kind, value, priority))
    })
    .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .1
            .quality
            .total_cmp(&left.1.quality)
            .then(right.1.specificity.cmp(&left.1.specificity))
            .then(left.1.index.cmp(&right.1.index))
            .then(right.2.cmp(&left.2))
    });
    candidates.first().map(|candidate| candidate.0)
}

pub async fn handle(
    request: &Request,
    env: &Env,
    path: &str,
) -> Result<Option<Response>, GatewayError> {
    if !matches!(request.method(), Method::Get | Method::Head) {
        return Ok(None);
    }
    let root = path == "/" || path == "/index.html";
    let (file, content_type, html) = if root {
        let accept = request.headers().get("Accept").map_err(|_| unavailable())?;
        match if path == "/index.html" {
            Some("html")
        } else {
            root_representation(accept.as_deref().unwrap_or_default())
        } {
            Some("html") => ("index.html", "text/html; charset=utf-8", true),
            Some("markdown") => ("home.md", "text/markdown; charset=utf-8", false),
            representation => {
                let mut response = if representation.is_none() {
                    Response::from_json(&json!({"error":{"message":"The homepage is available as text/html, text/markdown, or application/json.","type":"not_acceptable","code":"not_acceptable"}})).map_err(|_| unavailable())?.with_status(406)
                } else {
                    Response::from_json(&json!({"service":"ai.ubq.fi","name":"UbiquityOS AI Gateway","upstream":"chatgpt_codex","auth":"required","endpoints":{"openai_compat":"/v1/*","health":"/health"},"discovery":{"llms":"/llms.txt","llms_full":"/llms-full.txt","openapi":"/openapi.json","developers":"/developers","sitemap":"/sitemap.xml"}})).map_err(|_| unavailable())?
                };
                if request.method() == Method::Head {
                    response = Response::empty()
                        .map_err(|_| unavailable())?
                        .with_status(response.status_code());
                    response
                        .headers_mut()
                        .set("Content-Type", "application/json")
                        .map_err(|_| unavailable())?;
                }
                response
                    .headers_mut()
                    .set("Vary", ROOT_VARY)
                    .map_err(|_| unavailable())?;
                return Ok(Some(response));
            }
        }
    } else {
        match path {
            "/docs" | "/docs.html" => ("docs.html", "text/html; charset=utf-8", true),
            "/developers" | "/developers.html" => {
                ("developers.html", "text/html; charset=utf-8", true)
            }
            "/about" | "/about.html" => ("about.html", "text/html; charset=utf-8", true),
            "/contact" | "/contact.html" => ("contact.html", "text/html; charset=utf-8", true),
            "/privacy" | "/privacy.html" => ("privacy.html", "text/html; charset=utf-8", true),
            "/chat" | "/chat.html" => ("chat.html", "text/html; charset=utf-8", true),
            "/models" | "/models.html" => ("models.html", "text/html; charset=utf-8", true),
            "/admin" | "/admin.html" => ("admin.html", "text/html; charset=utf-8", true),
            "/style.css"
            | "/docs.css"
            | "/chat.css"
            | "/models.css"
            | "/home.css"
            | "/admin.css"
            | "/admin-supervisor.css" => (&path[1..], "text/css; charset=utf-8", false),
            "/app.js"
            | "/docs.js"
            | "/chat.js"
            | "/chat-stats.js"
            | "/models.js"
            | "/toast.js"
            | "/admin.js"
            | "/admin-reset.js"
            | "/admin-supervisor.js"
            | "/admin-cache.js"
            | "/auth.js"
            | "/auth-relay.js"
            | "/foreground-refresh.js"
            | "/network.js"
            | "/reasoning-select.js" => (&path[1..], "text/javascript; charset=utf-8", false),
            "/company-logo.svg" => ("company-logo.svg", "image/svg+xml; charset=utf-8", false),
            "/llms.txt" | "/robots.txt" => (&path[1..], "text/plain; charset=utf-8", false),
            "/llms-full.txt" => ("docs/llms-agents.md", "text/plain; charset=utf-8", false),
            "/docs/llms-agents.md" => {
                ("docs/llms-agents.md", "text/markdown; charset=utf-8", false)
            }
            "/openapi.json" => ("openapi.json", "application/json; charset=utf-8", false),
            "/sitemap.xml" => ("sitemap.xml", "application/xml; charset=utf-8", false),
            "/favicon.ico" | "/favicon.png" | "/favicon-32.png" => {
                let bytes = if path == "/favicon-32.png" {
                    include_bytes!("../../../../favicon-32.png").as_slice()
                } else {
                    include_bytes!("../../../../favicon.png").as_slice()
                };
                let mut response = if request.method() == Method::Head {
                    Response::empty()
                } else {
                    Response::from_bytes(bytes.to_vec())
                }
                .map_err(|_| unavailable())?;
                security(&mut response, "image/png", false, false)?;
                return Ok(Some(response));
            }
            _ => return Ok(None),
        }
    };
    let assets = env.assets("ASSETS").map_err(|_| unavailable())?;
    let mut init = RequestInit::new();
    init.with_method(request.method());
    let mut asset = assets
        .fetch(format!("https://assets.internal/{file}"), Some(init))
        .await
        .map_err(|_| unavailable())?;
    if asset.status_code() != 200 {
        return Err(GatewayError::new(404, "Public resource not found. Read /openapi.json for API endpoints or /llms.txt for agent guidance.", Some("not_found")).with_type("not_found"));
    }
    let mut response = if request.method() == Method::Head {
        Response::empty().map_err(|_| unavailable())?
    } else {
        Response::from_stream(asset.stream().map_err(|_| unavailable())?)
            .map_err(|_| unavailable())?
    };
    security(&mut response, content_type, html, root)?;
    Ok(Some(response))
}

fn security(
    response: &mut Response,
    content_type: &str,
    html: bool,
    root: bool,
) -> Result<(), GatewayError> {
    for (name, value) in [
        ("Content-Type", content_type),
        ("Cache-Control", "public, max-age=300"),
        ("X-Content-Type-Options", "nosniff"),
    ] {
        response
            .headers_mut()
            .set(name, value)
            .map_err(|_| unavailable())?;
    }
    if html {
        response
            .headers_mut()
            .set("Content-Security-Policy", CSP)
            .map_err(|_| unavailable())?;
        response
            .headers_mut()
            .set("Referrer-Policy", "no-referrer")
            .map_err(|_| unavailable())?;
    }
    if root {
        response
            .headers_mut()
            .set("Vary", ROOT_VARY)
            .map_err(|_| unavailable())?;
    }
    Ok(())
}

fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The immutable asset binding is unavailable.",
        "static_assets_unavailable",
    )
}
