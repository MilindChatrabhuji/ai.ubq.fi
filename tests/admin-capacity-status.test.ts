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
