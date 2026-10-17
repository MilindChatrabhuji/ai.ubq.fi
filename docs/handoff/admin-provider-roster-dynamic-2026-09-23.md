# Admin provider roster from gateway APIs — 2026-09-23

## Objective

Make the ai.ubq.fi admin panel generate its provider roster, model-whitelist filters, provider labels, and
provider-health mapping dynamically from the gateway APIs instead of hardcoded provider lists, so LithosAI and any
future provider appear and can be enabled in the UI without a panel edit, then pass the repository gate and deploy to
both the Mac and VPS gateways.

## Verified current state (2026-09-23, evidence)

- Repo `/Users/nv/repos/ubiquity/ai.ubq.fi`, `development @ 9f9e8a43cc817caa8ef076455714d1b362f73cab`, in sync with
  `origin/development`.
- Mac release `mac-9f9e8a43cc817caa8ef076455714d1b362f73cab` and VPS release
  `vps-9f9e8a43cc817caa8ef076455714d1b362f73cab` both serve the live gateways.
- `GET http://127.0.0.1:7999/admin/providers/selection` (admin bearer) already answers six providers, including
  `{'id': 'lithos', 'model_count': 8, 'status': 'available', 'configured': true}`.
- The panel drops it: `static/admin.js:9169` merges API rows with the hardcoded `PROVIDER_ROSTER` and then filters
  `typeof entry.detail === "string"`, and `lithos` has no roster entry, so no chip, no row, and no way to select or
  switch it.
- Hardcoded panel vocabulary to remove: `static/admin.js` `MODEL_PROVIDER_LABELS` and `MODEL_PROVIDER_IDS` (~8049-8056),
  `PROVIDER_ROSTER` (~8633-8665), `PROVIDER_HEALTH_KEYS` (~8673-8681), `PROVIDER_TIER_LABELS`/`PROVIDER_TIER_IDS`;
  `static/admin.html` whitelist filter chips (~804-828) and tier filter chips (~694-710).

## Architecture decision

One server-owned presentation registry is the single source of provider presentation metadata. The panel keeps no
provider list, no label table, and no health-key mapping.

- New `src/provider_presentation.ts`:
  - `PROVIDER_TIERS`: ordered
    `[{ id: "subscription", label: "Subscription" }, { id: "paid", label: "Paid fallback" }, { id: "direct", label: "Direct" }]`.
  - `PROVIDER_PRESENTATION`: one entry per `SELECTABLE_PROVIDER_IDS` id with `label`, `tier`, `detail`, `endpoints`,
    `health_key`.
    - `codex` — "Codex", subscription, "ChatGPT subscription capacity. The waterfall always tries it first.",
      `["/v1/responses", "/v1/chat/completions"]`, health key `codex`.
    - `surplus` — "Metered 1", paid, "Surplus Intelligence. Second tier of the paid waterfall.", both endpoints, health
      key `surplus`.
    - `openlux` — "Metered 2", paid, "OpenLux. Last tier of the paid waterfall.", both endpoints, health key `metered`.
    - `deepseek` — "DeepSeek", direct, "Official DeepSeek key, served on Chat Completions only.",
      `["/v1/chat/completions"]`, health key `deepseek`.
    - `cerebras` — "Cerebras", direct, "GPT-OSS 120B, served on Chat Completions only.", `["/v1/chat/completions"]`,
      health key `cerebras`.
    - `lithos` — "LithosAI", direct, one honest sentence about the LithosAI route,
      `["/v1/chat/completions", "/v1/responses"]`, health key `lithos`.
  - `providerPresentation(id)` returns the entry, or a derived complete presentation for an id the table does not list
    (label = the id, tier `direct`, an explicit "no presentation entry yet" detail, empty endpoints, health key = the
    id), so a provider added to `SELECTABLE_PROVIDER_IDS` renders correctly before anyone writes its copy.
  - The health key type comes from `src/provider_health.ts` (export the existing record-provider union as a named type)
    so a health key that provider health cannot report is a type error.
- `handleAdminProviderSelectionGet` (`src/admin.ts`) adds to each provider row: `label`, `tier`, `tier_label`, `detail`,
  `endpoints`, `health_key`; and adds top-level `tiers: [{ id, label }]`. Roster ids stay in waterfall order and
  `handleAdminProviderSelectionSet` is unchanged.
- Hard cutover: no compatibility path, no client-side fallback list.

## Client requirements

- `static/admin.js`: delete `MODEL_PROVIDER_LABELS`, `MODEL_PROVIDER_IDS`, `PROVIDER_ROSTER`, `PROVIDER_HEALTH_KEYS`,
  `PROVIDER_TIER_LABELS`, `PROVIDER_TIER_IDS`, `PROVIDER_ALL_IDS`; keep one dictionary loaded from
  `/admin/providers/selection` shared by the Models tab and the Providers tab.
- Models tab: render the provider chips into the existing `[data-model-filters]` container as "All" plus one chip per
  roster provider in roster order, with the same `data-model-provider` attribute, `aria-pressed` state, and live counts;
  label from the dictionary, raw id when unknown. Chip clicks must work after the dynamic render (delegation or
  re-binding, not the load-time `querySelectorAll` snapshot at ~234). A stored filter id the dictionary no longer lists
  resets the filter to `all`. `modelsCatalogWarning` and the per-provider badges read the dictionary and the catalog
  sources instead of the deleted constants.
- Providers tab: render the tier chips into the existing `[data-provider-filters]` container from the payload `tiers`
  with live counts; build rows from the payload alone (no `PROVIDER_ROSTER` merge, no `detail`-typed drop); order by
  roster order; read provider health through the row's `health_key`.
- `static/admin.html`: the two filter containers become empty containers that keep their `role`/`aria-label`; no
  `data-model-provider` or `data-provider-tier` chip markup remains. Bump the admin asset version in the
  `<script src="/admin.js?v=...">` reference and update the assertion in `tests/static-assets.test.ts` that pins it.
- No provider label, tier label, or health key literal may remain in `static/admin.js` or `static/admin.html`.

## Optional item (include when it stays this small)

`src/lithos.ts` `LITHOS_EFFECTIVE_CONTEXT_WINDOW_PERCENT` 95 -> 100 to expose the full 1,048,576-token window, with a
one-line rationale at the constant; update the `95` assertion in `tests/lithos-wiring.test.ts` (~622) and add two or
three sentences to `docs/DECISIONS.md` recording why this route deviates from the 95 percent convention.

## Validation

- Focused:
  `deno test --frozen --allow-env=CEREBRAS_API_KEY,DEEPSEEK_API_KEY,LITHOSAI_API_KEY,VOYAGEAI_API_KEY,METERED_API_KEY,SURPLUS_API_KEY,OPENROUTER_API_KEY,IMAGE_BASE_MODEL,GIT_REVISION,GITHUB_SHA,DENO_DEPLOYMENT_ID,DENO_DEPLOY_BUILD_ID tests/provider-selection.test.ts`,
  `tests/admin-models-catalog.test.ts`, `tests/static-assets.test.ts`, `tests/lithos-wiring.test.ts`, plus
  `deno task build` (deno check) and the formatter for every edited file (Prettier for `*.ts`, `deno fmt` for
  JSON/Markdown/HTML/`static/*.js`).
- New server assertions: every selectable provider row carries a complete presentation; `lithos` reports label
  "LithosAI" and health key `lithos`; `tiers` is ordered; every `health_key` is a key the provider-health view
  publishes; the derived fallback presentation is complete for an unlisted id.
- Repository gate: `sh scripts/verify.sh` once, after all writers stop, reporting `verify: OK`.
- Live acceptance after deployment: both gateways answer `/admin/providers/selection` with the `lithos` row carrying
  `label: "LithosAI"`, the admin panel shows the LithosAI chip in both tabs, and a saved selection round-trips through
  `POST /admin/providers/selection`.

## Out of scope

`static/models.js` (public Models page) keeps its own label map and its raw-id fallback; catalog provider labels and
provider-selection semantics do not change.
