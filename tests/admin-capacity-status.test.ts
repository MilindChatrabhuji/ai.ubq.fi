import { readFileSync } from "node:fs";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
const adminScript = readFileSync(new URL("../static/admin.js", import.meta.url), "utf8");

class TestElement {
  dataset: Record<string, string> = {};
  textContent = "";
  children: TestElement[] = [];
  append(...children: TestElement[]) {
    this.children.push(...children);
  }
  appendChild(child: TestElement) {
    this.children.push(child);
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
