import { readFileSync } from "node:fs";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
const adminScript = readFileSync(new URL("../static/admin.js", import.meta.url), "utf8");

class TestElement {
  dataset: Record<string, string> = {};
  textContent = "";
  value = "";
  hidden = false;
  open = false;
  disabled = false;
  parentElement: TestElement | null = null;
  children: TestElement[] = [];
  listeners = new Map<string, (() => void)[]>();
  append(...children: TestElement[]) {
    for (const child of children) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((entry) => entry !== child);
      child.parentElement = this;
      this.children.push(child);
    }
  }
  appendChild(child: TestElement) {
    this.append(child);
  }
  replaceChildren(...children: TestElement[]) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  click() {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }
}

const now = Date.now();
const source = { source: "codex", state: "available", source_observed_at_ms: now, snapshot_at_ms: now };
const provider = {
  access_token_expired: false,
  access_token_exp_ms: now + 86_400_000,
  health: {
    state: "degraded",
    stale: false,
    last_event: "reachable",
    last_status: 200,
    last_observed_at_ms: now,
    last_refresh_succeeded: false,
    last_refresh_at_ms: now - 10_000,
  },
};
const context = {
  document: { createElement: () => new TestElement() },
  formatDate: (value: number) => String(value),
  formatOptionalText: (value: unknown) => (typeof value === "string" ? value : "unknown"),
};
const sourceText = adminScript;
// Execute the shipped presenters, including their DOM fact writer. No copy of
// their status conditions or network/application bootstrap runs in this fixture.
runInNewContext(
  [
    sourceText.slice(sourceText.indexOf("const providerBadgeState"), sourceText.indexOf("const formatCapacityPercent")),
    sourceText.slice(sourceText.indexOf("const capacityProviderStatus"), sourceText.indexOf("let codexResetSettings")),
    "globalThis.present = capacityProviderStatus; globalThis.renderMeta = appendCapacitySourceMeta;",
  ].join("\n"),
  context
);
const presenters = context as typeof context & {
  present: (source: unknown, provider: unknown) => { label: string; badgeState: string; quotaReachable: boolean };
  renderMeta: (row: TestElement, source: unknown, provider: unknown) => void;
};

test("Claude credential actions stay within the existing provider entry and survive roster renders", () => {
  const html = readFileSync(new URL("../static/admin.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /card-claude-subscription/);
  const providersStart = html.indexOf('<article data-card aria-labelledby="card-providers">');
  const controlsStart = html.indexOf('id="claude-subscription-controls"', providersStart);
  assert.ok(controlsStart > providersStart && controlsStart < html.indexOf("</article>", providersStart));

  const controls = new TestElement();
  controls.hidden = true;
  const credential = new TestElement();
  credential.value = "unsaved-credential";
  const workspace = new TestElement();
  workspace.value = "wrkspc_unsaved";
  const disclosure = new TestElement();
  disclosure.open = true;
  const buttons = Array.from({ length: 4 }, () => new TestElement());
  disclosure.append(credential, workspace, ...buttons);
  controls.append(disclosure);
  const calls = [0, 0, 0, 0];
  const fixture = {
    document: { createElement: () => new TestElement() },
    buildProviderOption: () => new TestElement(),
    providersSubscriptionsFor: () => [],
    claudeSubscriptionControls: controls,
    claudeCredentialSave: buttons[0],
    claudeWorkspaceSave: buttons[1],
    claudeCredentialClear: buttons[2],
    claudeQuotaClear: buttons[3],
    claudeAccountSelect: new TestElement(),
    claudeAccountActivate: new TestElement(),
    claudeAccessInput: new TestElement(),
    claudeAccessSave: new TestElement(),
    saveClaudeCredential: () => calls[0]++,
    saveClaudeWorkspace: () => calls[1]++,
    clearClaudeCredential: () => calls[2]++,
    clearClaudeQuotaGuards: () => calls[3]++,
  };
  runInNewContext(
    [
      sourceText.slice(sourceText.indexOf("claudeCredentialSave.addEventListener"), sourceText.indexOf("const loadProviders =")),
      sourceText.slice(sourceText.indexOf("const buildProviderEntry ="), sourceText.indexOf("const renderProvidersMessage =")),
      "globalThis.build = buildProviderEntry;",
    ].join("\n"),
    fixture
  );
  const build = (fixture as typeof fixture & { build: (entry: { id: string }) => TestElement }).build;
  const list = new TestElement();
  list.replaceChildren(build({ id: "codex" }), build({ id: "claude_code" }));
  const refreshed = build({ id: "claude_code" });
  list.replaceChildren(build({ id: "codex" }), refreshed);
  assert.equal(refreshed.children[1], controls);
  assert.equal(controls.hidden, false);
  assert.equal(credential.value, "unsaved-credential");
  assert.equal(workspace.value, "wrkspc_unsaved");
  assert.equal(disclosure.open, true);
  for (const button of buttons) button.click();
  assert.deepEqual(calls, [1, 1, 1, 1], "each preserved action retains exactly one listener");
});

test("provider selection save ignores a response after the gateway target changes", async () => {
  const saveSource = /const saveProviderSelection = async \(\) => \{[\s\S]*?\n\};/.exec(sourceText)?.[0] ?? "";
  assert.notEqual(saveSource, "", "the provider-selection saver must stay discoverable");

  type TestResponse = { ok: boolean; json: () => Promise<unknown> };
  let resolveResponse: ((response: TestResponse) => void) | null = null;
  const context = {
    getAdminToken: () => "old-token",
    hasAdminCredential: () => true,
    providerSelectionSaving: false,
    providersHasUnsavedChanges: () => true,
    providersSelectionIsEmpty: () => false,
    providerSelectionLoadId: 0,
    providerSelectionSaveError: "",
    providerSelection: new Set(["old-provider"]),
    providersSavedSelection: new Set<string>(),
    providerSelectionLoadedAt: 1,
    providersSelectedIds: () => ["old-provider"],
    providersSelectionFromIds: (ids: string[]) => new Set(ids),
    apiUrl: (path: string) => path,
    fetch: () =>
      new Promise<TestResponse>((resolve) => {
        resolveResponse = resolve;
      }),
    updateProvidersStatus: () => {},
    renderProvidersPicker: () => {},
    formatNumber: (value: number) => String(value),
    toast: { error: () => {}, success: () => {} },
    console,
  };
  runInNewContext(`${saveSource}\nglobalThis.saveProviderSelection = saveProviderSelection;`, context);
  const save = (context as typeof context & { saveProviderSelection: () => Promise<void> }).saveProviderSelection;
  const savePromise = save();

  // This is the generation bump performed by invalidateProviderSelection when
  // the base gateway changes, followed by the new target's loaded selection.
  context.providerSelectionLoadId += 1;
  context.providerSelectionSaving = false;
  context.providerSelection = new Set(["new-provider"]);
  context.providersSavedSelection = new Set(["new-provider"]);
  context.providerSelectionLoadedAt = 2;
  assert.ok(resolveResponse);
  resolveResponse({ ok: true, json: async () => ({ provider_ids: ["old-provider"] }) });
  await savePromise;

  assert.deepEqual([...context.providerSelection], ["new-provider"]);
  assert.deepEqual([...context.providersSavedSelection], ["new-provider"]);
  assert.equal(context.providerSelectionLoadedAt, 2);
});

test("Claude credential disclosure uses the existing single-column body and wrapping form actions", () => {
  const html = readFileSync(new URL("../static/admin.html", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../static/style.css", import.meta.url), "utf8");
  const controlsStart = html.indexOf('id="claude-subscription-controls"');
  const disclosure = html.slice(controlsStart, html.indexOf("</details>", controlsStart));
  assert.match(disclosure, /<summary>Manage credential<\/summary>\s*<div data-card-body>/);
  assert.doesNotMatch(disclosure, /data-layout="grid"/, "the 12-column page grid must not squeeze form fields at narrow or wide widths");
  assert.match(disclosure, /<div data-action-row>\s*<button id="claude-credential-save"/);
  const bodyRule = /\[data-card-body\]\s*\{([^}]+)\}/.exec(styles)?.[1] ?? "";
  assert.match(bodyRule, /display:\s*grid/);
  assert.doesNotMatch(bodyRule, /grid-template-columns/, "form rows use one implicit column at every viewport width");
  const actionsRule = /\[data-action-row\]\s*\{([^}]+)\}/.exec(styles)?.[1] ?? "";
  assert.match(actionsRule, /display:\s*flex/);
  assert.match(actionsRule, /flex-wrap:\s*wrap/, "credential actions wrap instead of overflowing at 500px");
});

test("shared Kernel metadata shrinks and wraps long values without hiding content", () => {
  const styles = readFileSync(new URL("../static/admin.css", import.meta.url), "utf8");
  const metaRule = /\[data-auth-meta\]\s*\{([^}]+)\}/.exec(styles)?.[1] ?? "";
  const valueRule = /\[data-auth-value\]\s*\{([^}]+)\}/.exec(styles)?.[1] ?? "";
  assert.match(metaRule, /min-width:\s*0\s*;/, "the metadata grid child must shrink within its existing card");
  assert.match(valueRule, /min-width:\s*0\s*;/, "the value flex child must shrink beside its label");
  assert.match(valueRule, /overflow-wrap:\s*anywhere\s*;/, "unbroken workspace ids wrap instead of enlarging the row");
  assert.doesNotMatch(metaRule + valueRule, /overflow(?:-[xy])?:\s*(?:hidden|clip)|text-overflow:\s*ellipsis/);
});

test("shared Claude analytics diagnostics retain credential, workspace and routing facts", () => {
  const fixture = { ...context };
  runInNewContext(
    [
      sourceText.slice(sourceText.indexOf("const providerBadgeState"), sourceText.indexOf("const formatCapacityPercent")),
      sourceText.slice(sourceText.indexOf("const capacityProviderStatus"), sourceText.indexOf("let codexResetSettings")),
      sourceText.slice(sourceText.indexOf("const claudeCapacityCredentialLabel"), sourceText.indexOf("const claudeCapacityWindowForDisplay")),
      sourceText.slice(sourceText.indexOf("const claudeCredentialSourceLabel"), sourceText.indexOf("const renderClaudeSubscriptionControls")),
      "globalThis.render = appendCapacitySourceMeta;",
    ].join("\n"),
    fixture
  );
  const row = new TestElement();
  (fixture as typeof fixture & { render: (row: TestElement, source: unknown, provider: unknown) => void }).render(
    row,
    { source: "claude_code", credential_kind: "oauth", workspace_id: "wrkspc_current", standard: [] },
    {
      enabled: true,
      principal_allowlist_configured: true,
      credential: { source: "kv", hint: "masked", updated_at_ms: now },
      workspace: { source: "kv", name: "Current", verified_at_ms: now },
      health: { state: "healthy", last_event: "success", last_observed_at_ms: now },
    }
  );
  const facts = Object.fromEntries(row.children[0].children[1].children.map((fact) => [fact.children[0].textContent, fact.children[1].textContent]));
  assert.equal(facts.Credential, "OAuth / setup token");
  assert.equal(facts["Credential source"], "Stored in KV");
  assert.equal(facts["Credential hint"], "masked");
  assert.equal(facts.Workspace, "wrkspc_current");
  assert.equal(facts["Workspace name"], "Current");
  assert.equal(facts["Provider switch"], "On");
  assert.equal(facts["Principal allowlist"], "Configured");
  assert.equal(facts.Inference, "healthy");
  assert.equal(facts["Last event"], "success");
});

test("shipped Claude rows never reuse another account or replacement cohort's masked diagnostics", () => {
  class Row extends TestElement {
    setAttribute() {}
  }
  const providerA = { account_id: "local-a", account_cohort_id: "cohort-a", label: "A", credential: { hint: "masked-a" } };
  const providerB = { account_id: "local-b", account_cohort_id: "cohort-b", label: "B", credential: { hint: "masked-b" } };
  const rendered: unknown[] = [];
  const fixture = {
    document: { createElement: () => new Row() },
    latestClaudeSubscription: { accounts: [providerA, providerB], enabled: true, principal_allowlist_configured: true },
    latestProviderHealth: null,
    setBadge: () => {},
    capacityBadgeState: () => "unknown",
    capacityStateLabel: () => "Unknown",
    renderCapacityWindow: () => {},
    appendCapacitySourceMeta: (_row: unknown, _source: unknown, provider: unknown) => rendered.push(provider),
  };
  runInNewContext(
    sourceText.slice(sourceText.indexOf("const claudeCapacityWindowForDisplay ="), sourceText.indexOf("const renderProviderCapacityList =")) +
      "\nglobalThis.render = renderClaudeCapacitySource;",
    fixture
  );
  const render = (fixture as typeof fixture & { render: (source: unknown) => void }).render;
  render({ source: "claude_code", account_id: "local-b", account_cohort_id: "cohort-b", windows: {} });
  assert.equal((rendered[0] as { credential: { hint: string } }).credential.hint, "masked-b");
  render({ source: "claude_code", account_id: "local-b", account_cohort_id: "old-cohort-b", windows: {} });
  assert.equal(rendered[1], null, "a poll racing credential replacement displays unknown metadata, never the replacement's provenance");
});

test("shipped shared capacity list supports legacy singleton and distinct roster rows with stable disclosure state", () => {
  class CapacityRow extends TestElement {
    details = new TestElement();
    querySelector() {
      return this.details;
    }
  }
  const list = new TestElement();
  const fixture = {
    providerCapacityList: list,
    providerForCodexSlot: () => null,
    renderCodexCapacitySource: () => new CapacityRow(),
    renderClaudeCapacitySource: (entry: { account_id?: string }) => {
      const row = new CapacityRow();
      row.dataset.accountId = entry.account_id ?? "legacy";
      return row;
    },
  };
  runInNewContext(
    sourceText.slice(sourceText.indexOf("const claudeCapacitySourcesForDisplay ="), sourceText.indexOf("const unavailableCodexCapacitySource =")) +
      "\nglobalThis.render = renderProviderCapacityList;",
    fixture
  );
  const render = (fixture as typeof fixture & { render: (sources: unknown[], active: unknown, accounts?: unknown[]) => void }).render;
  const sources = [
    { source: "codex", slot: 1, account_cohort_id: "codex-a" },
    { source: "codex", slot: 2, account_cohort_id: "codex-b" },
  ];
  const a = { source: "claude_code", account_id: "local-a" };
  const b = { source: "claude_code", account_id: "local-b" };
  render(sources, a);
  assert.equal(list.children.length, 3, "an old server's singleton still renders once");
  render(sources, a, [a, b]);
  assert.equal(list.children.length, 4, "the active projection is not appended again beside the roster");
  (list.children[2] as CapacityRow).details.open = true;
  render(sources, b, [b, a]);
  assert.equal((list.children[2] as CapacityRow).details.open, false, "reordering cannot move another account's disclosure state");
  assert.equal((list.children[3] as CapacityRow).details.open, true);
  render(sources, a, []);
  assert.equal(list.children.length, 2, "an explicit empty roster does not resurrect a stale active projection");
});

test("shipped routing warnings describe only disabled capacity and paid fallback, not a false Claude paid-first route", () => {
  const selection = new Set(["claude_code"]);
  const fixture = {
    providerSelection: selection,
    providersSelectionIsEmpty: () => selection.size === 0,
    providersMissingSelectionIds: () => [],
    providerCodexSelection: () => ({ total: 2, selected: selection.has("codex") ? 2 : 0 }),
    isProviderChecked: (id: string) => selection.has(id),
    formatNumber: (value: number) => String(value),
  };
  runInNewContext(
    sourceText.slice(sourceText.indexOf("const providersRoutingWarnings ="), sourceText.indexOf("const providersHealthWarning =")) +
      "\nglobalThis.warnings = providersRoutingWarnings;",
    fixture
  );
  const warnings = (fixture as typeof fixture & { warnings: () => string[] }).warnings;
  assert.deepEqual(Array.from(warnings()), [
    "Codex is off; Codex subscription capacity stays unused.",
    "Both paid tiers are off; no paid fallback is available after subscription routing.",
  ]);
  assert.doesNotMatch(warnings().join(" "), /requests start at the paid|outside the Codex roster/);
  selection.add("codex");
  assert.deepEqual(Array.from(warnings()), ["Both paid tiers are off; no paid fallback is available after subscription routing."]);
  selection.add("surplus");
  assert.deepEqual(Array.from(warnings()), []);
  selection.clear();
  assert.deepEqual(Array.from(warnings()), [], "an empty selection keeps its existing unfiltered semantics");
});

test("shipped capacity summary counts exactly displayed Claude roster or legacy rows without changing Codex chart inputs", () => {
  const badges: string[] = [];
  const chartSources: { source: string }[][] = [];
  const fixture = {
    latestProviderCapacityChartState: null,
    providerCapacityBadge: new TestElement(),
    providerCapacityUpdated: new TestElement(),
    renderProviderCapacityChart: (_snapshot: unknown, sources: { source: string }[]) => chartSources.push(sources),
    renderProviderCapacityList: () => {},
    renderProviderCapacityLedger: () => {},
    setBadge: (_element: unknown, _state: string, label: string) => badges.push(label),
    formatCapacityTimestamp: () => "observed",
  };
  runInNewContext(
    sourceText.slice(sourceText.indexOf("const claudeCapacitySourcesForDisplay ="), sourceText.indexOf("const renderProviderCapacityList =")) +
      sourceText.slice(sourceText.indexOf("const unavailableCodexCapacitySource ="), sourceText.indexOf("const CAPACITY_CHART_SVG_NS =")) +
      sourceText.slice(sourceText.indexOf("const renderProviderCapacity ="), sourceText.indexOf("const loadProviderCapacity =")) +
      "\nglobalThis.render = renderProviderCapacity;",
    fixture
  );
  const render = (fixture as typeof fixture & { render: (snapshot: unknown) => void }).render;
  const codex = (state: string) => [1, 2].map((slot) => ({ source: "codex", slot, state }));
  const account = (id: string, state: string) => ({ source: "claude_code", account_id: id, state });
  const a = account("a", "available");
  const b = account("b", "stale");
  const snapshot = { sources: codex("unavailable"), claude: a, claude_accounts: [a, b], prompt_cache: { status: "ready" } };
  const before = structuredClone(snapshot);
  render(snapshot);
  assert.equal(badges.at(-1), "Partial quota · 2 unavailable", "live Claude capacity cannot be summarized as wholly unavailable");
  assert.deepEqual(snapshot, before, "summary presentation cannot fabricate a quota or mutate the snapshot");
  render({ ...snapshot, sources: codex("available"), claude: account("old-active", "unavailable"), claude_accounts: [b] });
  assert.equal(badges.at(-1), "Quota stale · 1 source", "do not append the active compatibility projection beside an explicit roster");
  render({ ...snapshot, sources: codex("available"), claude: account("removed", "unavailable"), claude_accounts: [] });
  assert.equal(badges.at(-1), "Up to date", "a present empty roster does not resurrect removed current evidence");
  render({ sources: codex("unavailable"), claude: a, prompt_cache: { status: "ready" } });
  assert.equal(badges.at(-1), "Partial quota · 2 unavailable", "old singleton servers retain truthful summary presentation");
  render({ sources: codex("unavailable"), claude_accounts: [account("a", "unavailable")] });
  assert.equal(badges.at(-1), "Quota unavailable");
  render({});
  assert.equal(badges.at(-1), "Quota unavailable", "missing evidence is not made available");
  assert(chartSources.every((sources) => sources.length === 2 && sources.every((entry) => entry.source === "codex")));
});

test("current accepted quota access is reachable while its failed refresh attempt stays visible", () => {
  const status = presenters.present(source, provider);
  assert.equal(status.label, "Reachable · Live");
  assert.equal(status.badgeState, "ok");
  assert.equal(provider.health.state, "degraded");
  const row = new TestElement();
  presenters.renderMeta(row, source, provider);
  const facts = row.children[0].children[1].children;
  const refresh = facts.find((fact) => fact.children[0].textContent === "Last refresh attempt");
  assert.equal(refresh?.children[1].textContent, `Failed · ${provider.health.last_refresh_at_ms} · Quota reads currently succeed`);
});

test("unavailable, stale and expired access retain warnings, while inference success remains healthy", () => {
  const cases = [
    {
      source: { ...source, state: "unavailable" },
      provider: { ...provider, health: { ...provider.health, state: "invalid", last_status: 401 } },
      label: "invalid · Quota unavailable",
    },
    { source: { ...source, state: "stale" }, provider, label: "degraded · Quota stale" },
    { source, provider: { ...provider, health: { ...provider.health, stale: true } }, label: "degraded · stale · Live" },
    { source, provider: { ...provider, access_token_expired: true }, label: "degraded · Live" },
    { source, provider: { ...provider, access_token_exp_ms: now - 1 }, label: "degraded · Live" },
    { source, provider: { ...provider, health: { ...provider.health, state: "healthy", last_event: "success" } }, label: "healthy · Live" },
  ];
  for (const fixture of cases) {
    const status = presenters.present(fixture.source, fixture.provider);
    assert.equal(status.label, fixture.label);
    assert.equal(status.quotaReachable, false);
    const row = new TestElement();
    presenters.renderMeta(row, fixture.source, fixture.provider);
    const refresh = row.children[0].children[1].children.find((fact) => fact.children[0].textContent === "Last refresh attempt");
    assert.equal(refresh?.children[1].textContent, `Failed · ${provider.health.last_refresh_at_ms}`);
  }
});

type CapacityScrollNode = {
  clientWidth: number;
  offsetWidth: number;
  scrollWidth: number;
  scrollLeft: number;
  querySelector: (_selector: string) => { dataset: Record<string, string> } | null;
};

let visibleCapacityScroll: CapacityScrollNode | null = null;
const capacityScrollContext = {
  providerCapacityChart: {
    querySelector: () => visibleCapacityScroll,
  },
};
const markerStart = sourceText.indexOf("const capacityChartMarkerX");
const markerEnd = sourceText.indexOf("const capacityChartPromptCacheBuckets", markerStart);
const scrollStart = sourceText.indexOf("const capacityChartScrollMaximum");
const scrollEnd = sourceText.indexOf("const capacityChartOptimalSpendCoordinates", scrollStart);
assert.ok(markerStart >= 0 && markerEnd > markerStart, "shipped capacity marker fixture boundary");
assert.ok(scrollStart >= 0 && scrollEnd > scrollStart, "shipped capacity scroll fixture boundary");
runInNewContext(
  [
    "let capacityChartScrollState = null;",
    "let capacityChartFollowsLatest = true;",
    "let capacityChartScrollNeedsVisiblePosition = false;",
    sourceText.slice(markerStart, markerEnd),
    sourceText.slice(scrollStart, scrollEnd),
    "globalThis.remember = rememberCapacityChartScroll; globalThis.restore = restoreCapacityChartScroll;",
    "globalThis.reset = () => {",
    "  capacityChartScrollState = null;",
    "  capacityChartFollowsLatest = true;",
    "  capacityChartScrollNeedsVisiblePosition = false;",
    "};",
  ].join("\n"),
  capacityScrollContext,
  { timeout: 1000 }
);
const capacityScrollPresenter = capacityScrollContext as typeof capacityScrollContext & {
  remember: () => void;
  restore: (scroll: CapacityScrollNode, displayWindow: { startAtMs: number; durationMs: number }, plot: { left: number; width: number }) => void;
  reset: () => void;
};

test("capacity refresh preserves a scrolled anchor before the queued scroll event", () => {
  capacityScrollPresenter.reset();
  const svg = {
    dataset: {
      capacityChartStartAtMs: "0",
      capacityChartDurationMs: "1000",
      capacityChartPlotLeft: "10",
      capacityChartPlotWidth: "1000",
    },
  };
  const oldScroll: CapacityScrollNode = {
    clientWidth: 100,
    offsetWidth: 100,
    scrollWidth: 500,
    scrollLeft: 150,
    querySelector: () => svg,
  };
  visibleCapacityScroll = oldScroll;
  capacityScrollPresenter.remember();

  const refreshedScroll: CapacityScrollNode = {
    clientWidth: 100,
    offsetWidth: 100,
    scrollWidth: 600,
    scrollLeft: 0,
    querySelector: () => svg,
  };
  visibleCapacityScroll = refreshedScroll;
  capacityScrollPresenter.restore(refreshedScroll, { startAtMs: 0, durationMs: 1000 }, { left: 10, width: 1000 });

  assert.equal(refreshedScroll.scrollLeft, 150);
});

test("capacity refresh retains follow-latest intent after a hidden render", () => {
  capacityScrollPresenter.reset();
  const hiddenScroll: CapacityScrollNode = {
    clientWidth: 0,
    offsetWidth: 0,
    scrollWidth: 0,
    scrollLeft: 0,
    querySelector: () => ({ dataset: {} }),
  };
  visibleCapacityScroll = hiddenScroll;
  capacityScrollPresenter.restore(hiddenScroll, { startAtMs: 0, durationMs: 1000 }, { left: 10, width: 1000 });

  const visibleScroll: CapacityScrollNode = {
    clientWidth: 100,
    offsetWidth: 100,
    scrollWidth: 600,
    scrollLeft: 0,
    querySelector: () => ({
      dataset: {
        capacityChartStartAtMs: "0",
        capacityChartDurationMs: "1000",
        capacityChartPlotLeft: "10",
        capacityChartPlotWidth: "1000",
      },
    }),
  };
  visibleCapacityScroll = visibleScroll;
  capacityScrollPresenter.remember();
  capacityScrollPresenter.restore(visibleScroll, { startAtMs: 0, durationMs: 1000 }, { left: 10, width: 1000 });

  assert.equal(visibleScroll.scrollLeft, 500);
});

const retentionContext = { errorsRetention: new TestElement() };
runInNewContext(
  [
    ["const numberFormatter", "const compactNumberFormatter"],
    ["const toNumber", "const formatCompactNumber"],
    ["const formatRetentionBytes", "const invalidateAdminErrors"],
  ]
    .map(([start, end]) => {
      const from = sourceText.indexOf(start);
      const to = sourceText.indexOf(end, from);
      assert.ok(from >= 0 && to > from, `shipped retention fixture boundary ${start}`);
      return sourceText.slice(from, to);
    })
    .concat("globalThis.render = renderErrorsRetention;")
    .join("\n"),
  retentionContext,
  { timeout: 1000 }
);
const retentionPresenter = retentionContext as typeof retentionContext & { render: (payload: unknown) => void };
const validRetention: Record<string, unknown> = {
  state: "ok",
  accounting_complete: true,
  accounting_error: null,
  stored_bytes: 2 * 1024 ** 2,
  reserved_bytes: 1024 ** 2,
  budget_bytes: 1024 ** 3,
  records: 12,
};

test("shipped retention renderer preserves measured zero, normal accounting and storage warnings", () => {
  retentionPresenter.render({ retention: validRetention });
  assert.equal(retentionContext.errorsRetention.textContent, "Capture storage 3 MiB of 1 GiB · 12 recordings.");
  retentionPresenter.render({ retention: { ...validRetention, stored_bytes: 0, reserved_bytes: 0, records: 0 } });
  assert.equal(retentionContext.errorsRetention.textContent, "Capture storage 0 KiB of 1 GiB · 0 recordings.");
  retentionPresenter.render({
    retention: { ...validRetention, evicted_records: 2, skipped_reason: "storage_full" },
    log_files: { total_bytes: 2 * 1024 ** 3, warning: true },
  });
  assert.match(retentionContext.errorsRetention.textContent, /Oldest recordings were removed/);
  assert.match(retentionContext.errorsRetention.textContent, /Newest recording skipped: not enough space/);
  assert.match(retentionContext.errorsRetention.textContent, /Gateway text logs 2 GiB/);
  assert.match(retentionContext.errorsRetention.textContent, /Text logs reached 1 GiB; rotation is separate/);
  retentionPresenter.render({ retention: { ...validRetention, near_capacity: true } });
  assert.match(retentionContext.errorsRetention.textContent, /Approaching the storage limit/);
});

test("shipped retention renderer refuses incomplete, errored, unavailable or corrupt accounting without hiding log warnings", () => {
  const missingCompleteness = { ...validRetention };
  Reflect.deleteProperty(missingCompleteness, "accounting_complete");
  const invalid: unknown[] = [
    undefined,
    null,
    missingCompleteness,
    { ...validRetention, accounting_complete: false },
    { ...validRetention, accounting_complete: false, stored_bytes: 0, reserved_bytes: 0, records: 0 },
    { ...validRetention, accounting_error: "ledger_corrupt" },
    { ...validRetention, state: "unavailable" },
    { ...validRetention, state: "corrupt" },
    { ...validRetention, stored_bytes: null, reserved_bytes: null, records: null, accounting_error: "ledger_corrupt" },
    { ...validRetention, stored_bytes: Number.MAX_VALUE, reserved_bytes: Number.MAX_VALUE },
  ];
  for (const field of ["stored_bytes", "reserved_bytes", "budget_bytes", "records"]) {
    const missing = { ...validRetention };
    Reflect.deleteProperty(missing, field);
    invalid.push(missing);
    for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, "0"]) invalid.push({ ...validRetention, [field]: value });
  }
  for (const retention of invalid) {
    retentionPresenter.render({ retention, log_files: { total_bytes: 2 * 1024 ** 3, warning: true } });
    assert.equal(
      retentionContext.errorsRetention.textContent,
      "Capture storage usage unavailable · Gateway text logs 2 GiB · Text logs reached 1 GiB; rotation is separate."
    );
  }
});

const claudeChartContext = {
  CAPACITY_CHART_BUCKET_MS: 900_000,
  clampCapacityChartPercent: (value: number) => Math.max(0, Math.min(100, value)),
  formatCapacityTimestamp: (value: unknown) => {
    if (typeof value === "number" || typeof value === "string") return String(value);
    return "Not reported";
  },
};
runInNewContext(
  sourceText.slice(sourceText.indexOf("const CLAUDE_CAPACITY_CHART_SERIES ="), sourceText.indexOf("const capacityChartFailureIsDowntime =")) +
    "\nglobalThis.points = claudeCapacityChartPoints; globalThis.summary = claudeHistorySummary;",
  claudeChartContext
);
const claudeChart = claudeChartContext as typeof claudeChartContext & {
  points: (view: unknown, account: string, window: string, interval: unknown) => ({ remainingPercent: number } | null)[];
  summary: (snapshot: unknown, now: number) => string;
};
const historyStart = 1_800_000_000_000;
const historyInterval = { startAtMs: historyStart, resetAtMs: historyStart + 3_600_000, durationMs: 3_600_000 };
const historySample = (offset: number, patch: Record<string, unknown> = {}) => ({
  account_id: "local-a",
  account_cohort_id: "cohort-a",
  credential_kind: "oauth",
  workspace_id: null,
  state: "available",
  sampled_at_ms: historyStart + offset,
  source_observed_at_ms: historyStart + offset,
  bucket_start_at_ms: Math.floor((historyStart + offset) / 900_000) * 900_000,
  windows: { five_hour: { used_percent: 7, reset_at_ms: historyStart + 18_000_000, observed_at_ms: historyStart + offset } },
  ...patch,
});

test("shipped Claude chart uses actual window timestamps and never anchors a current value", () => {
  const view = { stale_after_ms: 1_800_000, points: [historySample(0), historySample(1_000)] };
  const points = claudeChart.points(view, "local-a", "five_hour", historyInterval);
  assert.equal(points.filter(Boolean).length, 2);
  assert.equal(points.filter((point) => point === null).length, 1);
  assert.equal(points.at(-1)?.remainingPercent, 93);
  assert.deepEqual(Array.from(claudeChart.points(view, "local-a", "seven_day", historyInterval).filter(Boolean)), []);
  const noTime = historySample(2_000, { windows: { five_hour: { used_percent: 0, reset_at_ms: null, observed_at_ms: null } } });
  assert.equal(claudeChart.points({ points: [noTime] }, "local-a", "five_hour", historyInterval).filter(Boolean).length, 0);
});

test("shipped Claude chart breaks cohort, reset, unavailable and missing-bucket runs without inventing downtime", () => {
  const cases = [
    historySample(1_000, { account_cohort_id: "replacement" }),
    historySample(1_000, { credential_kind: "api_key" }),
    historySample(1_000, { workspace_id: "other-workspace" }),
    historySample(1_000, { state: "unavailable" }),
    historySample(1_000, { windows: { five_hour: { used_percent: 0, reset_at_ms: historyStart + 36_000_000, observed_at_ms: historyStart + 1_000 } } }),
    historySample(2_700_000),
  ];
  for (const sample of cases) {
    const points = claudeChart.points({ points: [historySample(0), sample] }, "local-a", "five_hour", historyInterval);
    assert.equal(points.filter((point) => point === null).length, 2);
    assert.equal(points.filter(Boolean).length, 2, "a measured zero stays an observed point, not a fabricated missing value");
  }
  assert.match(claudeChart.summary({ claude_history: { scan: "unavailable", points: [] } }, historyStart), /unavailable/);
  assert.match(claudeChart.summary({ claude_history: { scan: "ok", truncated: true, points: [] } }, historyStart), /truncated/);
  const aggregate = /const CAPACITY_CHART_SERIES = ([^;]+);/.exec(sourceText)?.[1] ?? "";
  assert.doesNotMatch(aggregate, /claude/, "Claude never changes Codex aggregate membership");
  assert.doesNotMatch(
    sourceText.slice(sourceText.indexOf("const renderClaudeHistorySelector ="), sourceText.indexOf("const renderClaudeHistoryPaths =")),
    /fetch\(|mutateClaude|activate/,
    "history selection is view-only"
  );
});

test("shipped shared account controls preserve scoped drafts and send only explicit account/access actions", async () => {
  const names = [
    "claudeCredentialSummary",
    "claudeCredentialInput",
    "claudeWorkspaceInput",
    "claudeCredentialSave",
    "claudeWorkspaceSave",
    "claudeCredentialClear",
    "claudeQuotaClear",
    "claudeSubscriptionStatus",
    "claudeAccountSelect",
    "claudeAccountActivate",
    "claudeAccountLabel",
    "claudeAccessInput",
    "claudeAccessSource",
    "claudeAccessSave",
  ] as const;
  const elements = Object.fromEntries(names.map((name) => [name, new TestElement()])) as Record<(typeof names)[number], TestElement>;
  const account = (id: string, active: boolean) => ({
    account_id: id,
    account_cohort_id: `cohort-${id}`,
    label: `Local ${id}`,
    active,
    credential: { kind: "oauth", source: "kv", hint: "masked" },
    workspace: null,
  });
  let status = {
    accounts: [account("a", true), account("b", false)],
    active_account_id: "a",
    active_reason: "bootstrap",
    access: { source: "env", allowed_key_ids: ["existing-key"], updated_at_ms: null as number | null },
  };
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const fixture = {
    ...elements,
    document: { createElement: () => new TestElement() },
    adminAccessState: { isAdmin: true },
    hasAdminCredential: () => true,
    getAdminToken: () => "fixture-admin",
    apiUrl: (path: string) => `http://fixture.invalid${path}`,
    formatDate: (value: unknown) => JSON.stringify(value),
    toast: {
      error: () => {
        throw new Error("unexpected UI action failure");
      },
    },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      if (url.endsWith("/access") && method === "POST") {
        status = { ...status, access: { source: "kv", allowed_key_ids: body?.allowed_key_ids as string[], updated_at_ms: 1 } };
        return Promise.resolve(Response.json({ data: status.access }));
      }
      return Promise.resolve(Response.json({ data: status, guards_cleared: true }));
    },
  };
  runInNewContext(
    sourceText.slice(sourceText.indexOf("let latestClaudeSubscription = null;"), sourceText.indexOf("const loadProviders =")) +
      "\nglobalThis.api = {apply:(value)=>{latestClaudeSubscription=value;renderClaudeSubscriptionControls();},save:saveClaudeCredential,clear:clearClaudeQuotaGuards};",
    fixture
  );
  const ui = (fixture as typeof fixture & { api: { apply: (value: unknown) => void; save: () => Promise<void>; clear: () => Promise<void> } }).api;
  ui.apply(status);
  assert.equal(calls.length, 0, "loading controls never grants access or switches active account");
  elements.claudeCredentialInput.value = "draft-a";
  elements.claudeWorkspaceInput.value = "wrkspc_draft_a";
  elements.claudeAccountLabel.value = "Label A";
  const select = (value: string) => {
    elements.claudeAccountSelect.value = value;
    for (const listener of elements.claudeAccountSelect.listeners.get("change") ?? []) listener();
  };
  select("b");
  elements.claudeCredentialInput.value = "draft-b";
  select("a");
  assert.equal(elements.claudeCredentialInput.value, "draft-a");
  assert.equal(elements.claudeWorkspaceInput.value, "wrkspc_draft_a");
  ui.apply({ ...status, active_account_id: "b", accounts: [account("a", false), account("b", true)] });
  assert.equal(elements.claudeCredentialInput.value, "draft-a", "polling preserves the selected account's unsaved draft");
  await ui.clear();
  const clear = calls.find((call) => call.url.endsWith("/quota/clear"));
  assert.deepEqual(clear?.body, { account_id: "a", account_cohort_id: "cohort-a" });
  await ui.save();
  const save = calls.find((call) => call.method === "POST" && call.url.endsWith("/auth"));
  assert.deepEqual(save?.body, { account_id: "a", credential: "draft-a", workspace_id: "wrkspc_draft_a", label: "Label A" });
  select("");
  elements.claudeCredentialInput.value = "new-account-draft";
  await ui.save();
  const added = calls.filter((call) => call.method === "POST" && call.url.endsWith("/auth")).at(-1);
  assert.equal(added?.body?.create_new, true);
  assert.equal(added.body.activate, false);
  elements.claudeAccessInput.value = "";
  for (const listener of elements.claudeAccessInput.listeners.get("input") ?? []) listener();
  elements.claudeAccessSave.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const access = calls.find((call) => call.url.endsWith("/access"));
  assert.deepEqual(access?.body, { allowed_key_ids: [] });
  assert.match(elements.claudeAccessSource.textContent, /stored policy.*0 allowed/);
  assert.equal(
    calls.some((call) => call.url.endsWith("/accounts/active")),
    false,
    "account viewing/import never silently changes active selection"
  );
});
