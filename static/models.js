import { toast } from "./toast.js?v=passport-design-20260922";

const summary = document.querySelector("[data-source-summary]");
const list = document.querySelector("[data-model-list]");
const count = document.querySelector("[data-model-count]");
const search = document.querySelector("[data-model-search]");

if (!summary || !list || !count || !(search instanceof HTMLInputElement)) {
  throw new Error("Models page markup is incomplete");
}

const providerNames = {
  codex: "Codex",
  openlux: "Metered 2",
  surplus: "Metered 1",
  deepseek: "DeepSeek",
  cerebras: "Cerebras",
  openrouter: "OpenRouter",
};
// Where a row's numbers came from. The catalog reports one source per field
// group, so a row can honestly read "Codex catalog + OpenRouter".
const metadataSourceNames = {
  codex_upload: "Codex catalog",
  codex_subscription: "Codex subscription",
  provider_discovery: "Provider discovery",
  openrouter: "OpenRouter",
};
const reasoningOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const tokenNumber = new Intl.NumberFormat("en-US");

const normalizeReasoningLevels = (value) => {
  if (!Array.isArray(value)) return [];
  const levels = value
    .map((entry) => (typeof entry === "string" ? entry : entry?.effort))
    .filter((entry) => typeof entry === "string" && entry.length > 0);
  return [...new Set(levels)].sort((a, b) => {
    const aIndex = reasoningOrder.indexOf(a);
    const bIndex = reasoningOrder.indexOf(b);
    return (aIndex < 0 ? reasoningOrder.length : aIndex) - (bIndex < 0 ? reasoningOrder.length : bIndex);
  });
};

// The catalog serves the reasoning tiers themselves, so the page renders what
// the gateway knows and nothing else: no client-side table fills the gap for a
// model no source describes.
const reasoningFor = (model) => {
  const levels = normalizeReasoningLevels(model.supported_reasoning_levels);
  if (!levels.length) return null;
  return { levels, defaultLevel: model.default_reasoning_effort ?? null };
};

const metadataSourceLabel = (model) => {
  const names = [model.context_source, model.reasoning_source]
    .map((source) => metadataSourceNames[source])
    .filter((name, index, all) => name !== undefined && all.indexOf(name) === index);
  return names.length ? names.join(" + ") : "No upstream metadata";
};

const positiveTokenCount = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

let catalog = [];
// The list is empty while the catalog loads, then ready, empty, or error. Typing during the
// load must not replace the live loading status with a false empty result.
let catalogReady = false;
const assignCatalog = (next) => {
  catalog = next;
  catalogReady = true;
};

const renderMessage = (message) => {
  const paragraph = document.createElement("p");
  paragraph.dataset.empty = "";
  paragraph.textContent = message;
  list.replaceChildren(paragraph);
};

const render = () => {
  if (!catalogReady) return;
  const query = search.value.trim().toLowerCase();
  const visible = catalog.filter((model) => {
    const reasoning = reasoningFor(model);
    const contextWindow = positiveTokenCount(model.context_window_tokens);
    const maxContextWindow = positiveTokenCount(model.max_context_window_tokens);
    const autoCompact = positiveTokenCount(model.auto_compact_token_limit_tokens);
    const contextSearch = [
      contextWindow && tokenNumber.format(contextWindow),
      maxContextWindow && tokenNumber.format(maxContextWindow),
      autoCompact && tokenNumber.format(autoCompact),
      contextWindow ? "context compact compression" : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      !query ||
      model.id.toLowerCase().includes(query) ||
      model.providers.some((provider) => (providerNames[provider.id] ?? provider.id).toLowerCase().includes(query)) ||
      metadataSourceLabel(model).toLowerCase().includes(query) ||
      reasoning?.levels.some((level) => level.includes(query)) ||
      contextSearch.includes(query)
    );
  });
  count.textContent = `${visible.length} cataloged model${visible.length === 1 ? "" : "s"}`;
  if (!visible.length) {
    list.dataset.state = "empty";
    renderMessage(query ? `No models match “${search.value.trim()}”.` : "The catalog has no models to show.");
    return;
  }
  list.removeAttribute("data-state");
  list.replaceChildren(
    ...visible.map((model) => {
      const article = document.createElement("article");
      const heading = document.createElement("h2");
      const providers = document.createElement("div");
      heading.textContent = model.id;
      providers.dataset.providers = "";
      for (const provider of model.providers) {
        const badge = document.createElement("span");
        badge.dataset.provider = provider.id;
        badge.textContent = providerNames[provider.id] ?? provider.id;
        badge.title = provider.supported_endpoints.join(", ");
        providers.append(badge);
      }
      article.append(heading, providers);

      // Coverage is part of the page: a row states which source described it, and
      // a row no source described says so instead of quietly showing nothing.
      const source = document.createElement("div");
      source.dataset.metadataSource = model.context_source ?? "unknown";
      source.textContent = `Metadata · ${metadataSourceLabel(model)}`;
      article.append(source);

      const details = document.createElement("details");
      details.dataset.disclosure = "";
      const detailsTitle = document.createElement("summary");
      detailsTitle.textContent = "Model details";
      details.append(detailsTitle);

      const reasoning = reasoningFor(model);
      if (reasoning?.levels.length) {
        const levels = document.createElement("div");
        levels.dataset.reasoningLevels = "";
        levels.textContent = `Reasoning · ${reasoning.levels.join(", ")}`;
        if (reasoning.defaultLevel) levels.title = `Default: ${reasoning.defaultLevel}`;
        details.append(levels);
      }

      const contextWindow = positiveTokenCount(model.context_window_tokens);
      const maxContextWindow = positiveTokenCount(model.max_context_window_tokens);
      const autoCompact = positiveTokenCount(model.auto_compact_token_limit_tokens);
      if (contextWindow) {
        const context = document.createElement("div");
        context.dataset.contextWindow = "";
        context.textContent = `Context · ${tokenNumber.format(contextWindow)} tokens`;
        // The catalog's maximum is the ceiling a client config may override the
        // window to, not a window the provider serves, so it belongs in the
        // tooltip rather than next to the served number.
        if (maxContextWindow && maxContextWindow !== contextWindow) {
          context.title = `Client override ceiling: ${tokenNumber.format(maxContextWindow)} tokens`;
        }
        article.append(context);
      }
      if (autoCompact) {
        const compact = document.createElement("div");
        compact.dataset.autoCompact = "";
        compact.textContent = `Auto-compact · ${tokenNumber.format(autoCompact)} tokens`;
        compact.title = "Summarize older conversation state before the physical context window fills";
        details.append(compact);
      }
      if (details.children.length > 1) article.append(details);
      return article;
    })
  );
};

search.addEventListener("input", render);

try {
  const response = await fetch("/uos/models/catalog", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}`);
  const payload = await response.json();
  assignCatalog(Array.isArray(payload.data) ? payload.data : []);
  summary.replaceChildren(
    ...Object.entries(payload.sources ?? {})
      // Credential-gated providers that the gateway has no key for are absent
      // on purpose, so they are not reported as unavailable sources. Neither is
      // a provider an operator switched off in the admin console.
      .filter(([, source]) => source?.configured !== false && source?.disabled !== true)
      .map(([id, source]) => {
        const article = document.createElement("article");
        const name = document.createElement("h2");
        const total = document.createElement("strong");
        const state = document.createElement("span");
        name.textContent = providerNames[id] ?? id;
        total.textContent = String(source.count ?? 0);
        state.textContent = source.status === "available" ? "cataloged models" : "catalog unavailable";
        article.dataset.state = source.status ?? "unavailable";
        article.append(name, total, state);
        return article;
      })
  );
  render();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unable to load models.";
  count.textContent = "Catalog unavailable";
  list.dataset.state = "error";
  list.textContent = message;
  toast.error("Catalog unavailable", { description: message });
}
