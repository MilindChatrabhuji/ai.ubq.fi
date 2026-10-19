use gateway_core::GatewayError;
use gateway_observability::host_types::ProviderInventory;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const PRESENTATION: &[(&str, &str, &str, &str, &str)] = &[
    (
        "codex",
        "Codex",
        "subscription",
        "ChatGPT subscription capacity. The waterfall always tries it first.",
        "codex",
    ),
    (
        "claude_code",
        "Claude Code",
        "subscription",
        "Claude subscription capacity. Tried before the paid waterfall for Claude models when a credential, the principal allowlist, and a workspace are configured.",
        "claude_code",
    ),
    (
        "surplus",
        "Metered 1",
        "paid",
        "Surplus Intelligence. Second tier of the paid waterfall.",
        "surplus",
    ),
    (
        "openlux",
        "Metered 2",
        "paid",
        "OpenLux. Last tier of the paid waterfall.",
        "metered",
    ),
    (
        "deepseek",
        "DeepSeek",
        "direct",
        "Official DeepSeek key, served on Chat Completions upstream and Responses through the gateway's translation.",
        "deepseek",
    ),
    (
        "cerebras",
        "Cerebras",
        "direct",
        "GPT-OSS 120B, served on Chat Completions only.",
        "cerebras",
    ),
    (
        "lithos",
        "LithosAI",
        "direct",
        "LithosAI key, served on Chat Completions upstream and Responses through the gateway's translation.",
        "lithos",
    ),
    (
        "openrouter",
        "OpenRouter",
        "direct",
        "OpenRouter's full served catalogue on both OpenAI wires, plus System One decisions (Typesafe Jev) for the selector-repair design step.",
        "openrouter",
    ),
    (
        "ubiquity",
        "Ubiquity",
        "gateway",
        "Gateway-owned, always-current DeepSeek Flash waterfall: official DeepSeek, OpenRouter, LithosAI, Surplus, and OpenLux when they advertise the current release.",
        "ubiquity",
    ),
];

pub(super) fn project(
    catalog: &Value,
    inventory: &ProviderInventory,
    secrets: &BTreeMap<String, String>,
) -> Result<Value, GatewayError> {
    let models = catalog["models"].as_array().ok_or_else(|| {
        GatewayError::unavailable(
            "Provider catalog is invalid.",
            "provider_picker_unavailable",
        )
    })?;
    let mut providers = Vec::new();
    for (id, label, tier, detail, health) in PRESENTATION {
        let source = &catalog["sources"][id];
        let count = models
            .iter()
            .filter(|model| {
                model["providers"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["id"] == *id))
            })
            .count();
        let gated = match *id {
            "openrouter" => Some(secrets.contains_key(*id)),
            "ubiquity" => Some(inventory.ubiquity_configured),
            _ => None,
        };
        let status = gated
            .map(|yes| if yes { "available" } else { "unavailable" })
            .unwrap_or_else(|| source["status"].as_str().unwrap_or("unavailable"));
        let configured = gated.unwrap_or_else(|| {
            source["configured"]
                .as_bool()
                .unwrap_or(status == "available")
        });
        let endpoints = match *id {
            "cerebras" => json!(["/v1/chat/completions"]),
            "ubiquity" => json!(["/v1/responses"]),
            "openrouter" => json!(["/v1/chat/completions", "/v1/responses", "/v1/systemone"]),
            _ => json!(["/v1/responses", "/v1/chat/completions"]),
        };
        let tier_label = match *tier {
            "subscription" => "Subscription",
            "paid" => "Paid fallback",
            "gateway" => "Gateway",
            _ => "Direct",
        };
        let mut row = json!({"id":id,"label":label,"tier":tier,"tier_label":tier_label,"detail":detail,"endpoints":endpoints,"health_key":health,"model_count":count,"status":status,"configured":configured});
        if *id == "codex" {
            row["subscriptions"] = json!(inventory.codex.accounts.iter().map(|account| json!({"id":format!("codex:{}",gateway_auth::crypto::sha256_hex(account.account_id.as_bytes())),"label":gateway_observability::capacity_shapes::codex_label(account.slot,None),"slot":account.slot})).collect::<Vec<_>>());
        }
        providers.push(row);
    }
    Ok(
        json!({"providers":providers,"tiers":[{"id":"subscription","label":"Subscription"},{"id":"paid","label":"Paid fallback"},{"id":"direct","label":"Direct"},{"id":"gateway","label":"Gateway"}]}),
    )
}
