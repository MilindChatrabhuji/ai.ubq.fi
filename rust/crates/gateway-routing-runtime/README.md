# Routing runtime contract

Contract v1, source `7cc83d404adf4dda7e7e842b38b07548c2262dce`. This crate composes the existing domain authority and provider wire policy. It owns one API/kernel admission across all attempts; m10 owns the separate finite process permit. The Worker owns HTTP, body readers, SSE decoding and actual delivery observation. All inputs, store and host values are owned so a session can live in a static stream/finish future. No environment discovery, networking, credential refresh, second quota ledger, periodic scheduler or backend relay belongs here.

| Route family | Source behavior | Existing owner primitive |
| --- | --- | --- |
| Direct provider | Responses DeepSeek/Lithos/Cerebras/OpenRouter; Chat Cerebras/DeepSeek/Lithos/OpenRouter; preserve provider controls and buffering | m04 prepare/decode; source handlers and `chat/envelope.ts` |
| Codex | Global sticky account, exact admitted credential and active/pool generation, one sibling model-entitlement retry, current full-pool proof before paid | m03 select/current/quota/invalid/model/probe operations; source `codex/dispatch.ts`, `routing-serial.ts` |
| Ordinary paid | Direct paid model/disabled Codex differs from proven subscription fallback; Surplus then OpenLux, advance only402/429 | m04 PaidRoutingPlan, m03 paid admission/lifecycle/settlement |
| Synthetic Flash | Lithos, DeepSeek, OpenRouter, Surplus, OpenLux; abort never advances; semantic commitment ends fallback; distinct per-hop paid IDs | m02 aliases, m04 deepseek_plan/deepseek_decision, m03 paid state |
| Claude | Owner/key eligibility, stable active roster and exact credential/workspace/capability generation, only current whole-cohort quota/auth-invalid proof permits paid | m12 roster/current binding; m03 proof-CAS extension; source `claude-code-route.ts`, `claude-code-quota.ts` |
| Reset/overage | Quota-only proof, current reset fence and native owner; false permission forbids every overage path | Existing m03 reset/probe primitives and fixed native capability; no guessed inventory |
| Terminal/recovery | Semantic intent before emission, API dispatch once, kernel completion independent of actual delivery, paid spend independent of both | Existing m03 domain rows plus replay-safe request-intent journal; event-owned recovery |

Public seam agreed with m05: `begin`, `next_attempt`, `before_dispatch`, `transport_started`, `refusal`, `observe_terminal` and `finish`. Prepared attempts own the existing m04 `PreparedRequest` and exact server-created attempt identity. The caller reports NotStarted versus Started and may request another attempt only before semantic commitment. Errors retain typed status/body and headers; raw upstream response bodies remain Worker-owned. No cached or caller-supplied text is full-pool proof.

Unresolved owned boundaries at the initial freeze are native pool publication/refresh (m06) and Claude strong proof/roster capabilities (m03/m12). Missing capabilities fail closed until those exact owners provide them; the source parser alone never authorizes a write or refresh. These remain original-goal work, not excluded functionality. Shared manifests/lock, platform adapter and other crates remain controller/owner paths.
