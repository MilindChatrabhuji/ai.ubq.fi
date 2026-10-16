# Provider prompt caching

The gateway handles caching at the selected provider boundary for both `/v1/responses` and `/v1/chat/completions`. A
cache key is an affinity hint; a hit still requires an eligible matching prefix on the same serving cache. Keep
instruction text, tool order, and earlier messages stable between related requests.

| Provider            | Policy                                                                                                                                                                    | Reported cache usage                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Codex subscription  | Automatic caching with stable caller key and authenticated identity. The durable global active subscription remains unchanged.                                            | Native Responses counters, translated for Chat.            |
| DeepSeek            | Automatic disk caching; no additional enable flag is required.                                                                                                            | Native hit counters become standard cached-token counters. |
| Lithos              | Provider-managed caching. No undocumented enable or lifetime control is injected.                                                                                         | Measured Chat counters are preserved in both routes.       |
| Cerebras            | Automatic caching; the documented optional `prompt_cache_key` survives Responses-to-Chat translation.                                                                     | Measured counters; cached input has the same input price.  |
| OpenRouter          | Claude receives the documented ephemeral default when explicit caller policy is absent. Other models retain their provider policy.                                        | Actual cache-read and cache-write counters.                |
| Surplus             | Claude uses a cache-aware protocol when the request can be translated without losing controls, reasoning or tool semantics. Other models retain their original transport. | Actual counters and exact provider-reported buyer charges. |
| OpenLux (`metered`) | Eligible Claude requests use native content-block caching; unsupported controls retain the original transport with a warning. Other models retain their provider policy.  | Native counters and authoritative token-log settlement.    |
| Ubiquity waterfall  | Caching belongs to the actual provider hop; there is no shared cache between providers.                                                                                   | The selected hop's measured counters.                      |

OpenLux's native Claude effort contract is unverified. Requests with an explicit reasoning effort, including Max or
None, keep the original Responses body and return `x-uos-warning: openlux_claude_native_prompt_cache_unavailable`; cache
hits on that transport remain unproven. Surplus Claude's canonical Chat path preserves requested effort together with
block caching.

Explicit cache policies take precedence over defaults. A protocol change never discards a requested reasoning tier, tool
schema, unsupported history item, or cache lifetime to obtain a hit. Requests without a lossless supported translation
keep their original transport and receive a cache-availability warning. Provider minimum prefix sizes, expiry, seller
selection, and changing prefixes can still cause misses.

Claude reasoning replay retains original signed provider data privately, within authenticated principal, provider,
model, and transport scope. Public output remains standard Responses items. The bounded process-local replay store
expires; unknown, modified, expired, or cross-principal reasoning falls back without inventing encrypted content.

Responses reports cache reads and writes under `usage.input_tokens_details`; Chat uses `usage.prompt_tokens_details`.
Missing or malformed counters remain unknown, including in the browser and after a stream failure. A measured zero is
distinct from an absent measurement. Native Anthropic input counts exclude cache reads and writes, so the adapter
restores gross input before exposing standard usage. Generated tokens are outside the input cache discount.

Surplus's valid `buyer_cost_micro` settles exactly, including zero. A malformed authoritative amount remains unmeasured,
and a cache-aware Claude response without an authoritative charge is not priced through an incompatible legacy estimate.
Existing legacy Responses projection and OpenLux token-log billing remain separate.

Embeddings, image generation, and SystemOne's documented uncached decisions are outside prompt-cache eligibility.

## Provider contracts

- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [Lithos API schema](https://docs.lithosai.com/openapi.yaml) and [billing](https://docs.lithosai.com/billing.md)
- [Cerebras prompt caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching)
- [OpenRouter prompt caching](https://openrouter.ai/docs/features/prompt-caching)
- Surplus [parameter compatibility](https://www.surplusintelligence.ai/docs/reference/parameter-compatibility),
  [reasoning controls](https://www.surplusintelligence.ai/docs/reference/reasoning),
  [Messages](https://www.surplusintelligence.ai/docs/api-reference/messages), and
  [routing controls](https://www.surplusintelligence.ai/docs/marketplace/routing-controls)
- [OpenLux documentation](https://doc.openlux.ai) and [published cache pricing](https://api.openlux.ai/api/ratio_config)
