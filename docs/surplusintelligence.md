Surplus Intelligence vs. OpenLux pricing

Snapshot: August 20, 2026. Surplus is currently cheaper on 7 of the 9 recent models for which I could verify matching
prices. The major exceptions are Claude Sonnet 5 and Claude Opus 4.8, where OpenLux is substantially cheaper.

All prices below are effective USD per 1 million input/output tokens. The percentage comparison uses input + 3 × output,
the same weighting Surplus uses for a typical chat workload. Surplus is a live marketplace, so its winning seller and
price can change; its public market data is cached for 60 seconds and its comparison snapshot for one hour.

Directly comparable models

Model Surplus input/output OpenLux input/output Lower weighted cost GPT-5.6 Sol $0.33 / $1.95 $0.51 / $3.09 Surplus
≈37%\
GPT-5.6 Terra $0.14 / $0.84 $0.21 / $1.24 Surplus ≈32%\
GPT-5.6 Luna $0.01 / $0.08 $0.02 / $0.12 Surplus ≈34%\
Claude Opus 5 $0.35 / $1.75 $0.44 / $2.21 Surplus ≈21%\
Claude Sonnet 5 $0.40 / $2.00 $0.18 / $0.88 OpenLux ≈56%\
Claude Fable 5 $2.14 / $10.69 $4.41 / $22.06 Surplus ≈52%\
Claude Opus 4.8 $1.01 / $5.05 ≈$0.44 / $2.21 OpenLux ≈56%\
DeepSeek V4 Pro $0.04 / $0.08 $0.66 / $1.98 Surplus ≈96%\
DeepSeek V4 Flash $0.01 / $0.02 $0.22 / $0.66 Surplus ≈97%

Family-level result

Family Better current provider Approximate difference GPT-5.6 Sol/Terra/Luna Surplus 32–37% lower on the chat-weighted
calculation DeepSeek V4 Surplus 96–97% lower Claude Opus 5 Surplus 21% lower Claude Fable 5 Surplus 52% lower Claude
Sonnet 5 OpenLux 56% lower Claude Opus 4.8 OpenLux 56% lower

Applied to your actual agent workload

You previously showed a Luna request containing 214,298 input tokens and 6,601 output tokens. Using only uncached
input/output rates:

Route Luna cost for that trace Terra cost for that trace Surplus ≈$0.00267	≈$0.03555 OpenLux ≈$0.00508	≈$0.05319 Surplus
savings ≈47% ≈33%

The Luna saving is greater than the chat-weighted 34% because your coding workload is extremely input-heavy. This
calculation excludes cache discounts, reasoning-token differences, failed requests, and any additional settlement fees.

Since you normally use Terra because OpenLux Luna succeeds only around two-thirds of the time, Surplus Terra is the most
immediately relevant comparison: approximately the same model tier for one-third less token spend, assuming its route
passes your reliability and quality tests.

Other recent 2026 models

Surplus already has current prices for several newer models for which I could not verify a matching same-day OpenLux
effective rate. I am treating OpenLux as unconfirmed, not necessarily unsupported.

Model Current Surplus input/output GLM-5.3 $0.11 / $0.35 Kimi K3 $0.18 / $0.90 Gemini 3.7 Flash $0.09 / $0.45 MiniMax
M3 $0.04 / $0.16 Grok 4.5 $0.40 / $1.20 Grok 4.6 $0.48 / $1.44 Qwen3.8 Max $0.75 / $2.25 Qwen3.8-2.4T-A95B $0.40 / $1.20
Grok 4.20 Beta $0.31 / $0.62

Surplus’s current catalog snapshot contains 153 models and was updated approximately one hour before this comparison.

Recommended routing

For your gateway, I would currently configure:

Model Primary Fallback gpt-5.6-sol Surplus OpenLux gpt-5.6-terra Surplus OpenLux gpt-5.6-luna Surplus, after reliability
test OpenLux claude-opus-5 Surplus OpenLux claude-sonnet-5 OpenLux Surplus claude-fable-5 Surplus OpenLux
claude-opus-4.8 OpenLux Surplus deepseek-v4-pro Surplus OpenLux deepseek-v4-flash Surplus OpenLux
GLM/Kimi/MiniMax/Gemini/Qwen 2026 models Surplus where available another verified provider

I would not replace OpenLux entirely. It is presently the clear pricing winner for Sonnet 5 and Opus 4.8, while Surplus
is the better primary source for GPT-5.6 and DeepSeek V4.

Important qualifications

OpenLux’s displayed cost is group-dependent. Its model pages contain multiple routing groups, and the comparison above
uses the lowest publicly tracked effective price after converting purchased credits into internal credits. A different
selected group can cost more. The official OpenLux pricing page is client-rendered, so its individual values were taken
from GetCheapAI’s tracker updated at 07:42 UTC on August 20, rather than directly extracted from OpenLux’s page. The
tracker itself labels the data as reference-only.

Surplus’s price is an order-book price. Requests are routed around unhealthy sellers and spending-cap failures, and its
market endpoint exposes seller capacity and health. However, Surplus explicitly says operational health does not prove
model identity; trusted-only routing is the default, but there is currently no cryptographic or semantic model
attestation.

Cache behavior may reverse some comparisons. Surplus’s comparison API supports separate cacheRead and cacheWrite fields,
but the public OpenLux tracker does not expose comparable effective cache pricing. Given your very large prompts, actual
cache-hit billing is potentially more important than the ordinary input rate.

Use Surplus’s API-key settlement path for sustained traffic. Its current API-key marketplace fee is documented as 0%
with no flat fee, while x402 requests can add a flat convenience fee that may dominate extremely cheap Luna or DeepSeek
calls. Settlement is in USDC on Base.

Bottom line

Net pricing is currently better on Surplus overall. The strongest practical move is to shift GPT-5.6 Terra traffic to
Surplus after a controlled reliability and tool-call test, preserve OpenLux for Claude Sonnet 5 and Opus 4.8, and retain
both as mutual failovers.

For selecting a winner in production, record four fields per route: successful requests, billable uncached input,
cache-read tokens, and total charged credits. Sticker token prices alone will not capture retries, cache handling, or
whether differently named relay routes actually produce equivalent model quality.
