import { readFileSync } from "node:fs";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

const adminScript = readFileSync(new URL("../static/admin.js", import.meta.url), "utf8");

const shippedSlice = (start: string, end: string): string => {
  const from = adminScript.indexOf(start);
  const to = adminScript.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} must stay discoverable in static/admin.js`);
  return adminScript.slice(from, to);
};

const sorted = (ids: Iterable<string>): string[] => [...ids].sort((left, right) => left.localeCompare(right));
type SaveResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type Provider = { id: string; subscriptions?: { id: string }[] };

class FakeCheckbox {
  type = "checkbox";
  checked: boolean;
  dataset: Record<string, string>;
  constructor(id: string, checked: boolean, subscription: boolean) {
    this.dataset = subscription ? { providerSubscriptionToggle: id } : { providerToggle: id };
    this.checked = checked;
  }
}

type Harness = {
  save: () => Promise<void>;
  unsaved: () => boolean;
  seed: (saved: readonly string[], staged: readonly string[]) => void;
  state: () => { saved: Iterable<string>; staged: Iterable<string>; saving: boolean };
};

/** Runs the shipped selection state, helpers, save handler and checkbox listener; only I/O and rendering are faked. */
const loadHarness = (roster: Provider[] = [{ id: "a" }, { id: "b" }, { id: "c" }]) => {
  const requests: unknown[] = [];
  const successes: string[] = [];
  let respond: ((response: SaveResponse) => void) | null = null;
  let changeListener: ((event: { target: FakeCheckbox }) => void) | null = null;
  const context = {
    HTMLInputElement: FakeCheckbox,
    apiUrl: (path: string) => path,
    applyProvidersSelection: () => {},
    console,
    fetch: (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body));
      return new Promise<SaveResponse>((resolve) => {
        respond = resolve;
      });
    },
    formatNumber: (value: number) => String(value),
    getAdminToken: () => "admin-token",
    hasAdminCredential: () => true,
    providerRoster: roster,
    providersList: {
      addEventListener: (type: string, listener: (event: { target: FakeCheckbox }) => void) => {
        if (type === "change") changeListener = listener;
      },
    },
    providersOnlyActiveInput: { checked: false },
    renderProvidersPicker: () => {},
    setProvidersSelectionBadge: () => {},
    toast: { error: () => {}, success: (message: string) => successes.push(message) },
    updateProvidersStatus: () => {},
  };
  runInNewContext(
    [
      shippedSlice("let providerSelection = new Set();", "const setProvidersSelectionBadge"),
      shippedSlice("const providerRosterEntry", "const buildProviderTierFilterChip"),
      shippedSlice("const providersSubscriptionsFor", "const providersTierCounts"),
      shippedSlice("const saveProviderSelection = async () => {", "const discardProviderChanges"),
      shippedSlice("const setProviderChecked", 'providersCheckAllBtn.addEventListener("click"'),
      "globalThis.harness = {",
      "  save: saveProviderSelection,",
      "  unsaved: providersHasUnsavedChanges,",
      "  seed: (saved, staged) => {",
      "    providersSavedSelection = providersSelectionFromIds(saved);",
      "    providerSelection = new Set(staged);",
      "    providerSelectionLoadedAt = 1;",
      "  },",
      "  state: () => ({ saved: providersSavedSelection, staged: providerSelection, saving: providerSelectionSaving }),",
      "};",
    ].join("\n"),
    context
  );
  const harness = (context as typeof context & { harness: Harness }).harness;
  const toggle = (id: string, checked: boolean, subscription = false) => {
    assert.ok(changeListener, "the Providers list change listener must be registered");
    changeListener({ target: new FakeCheckbox(id, checked, subscription) });
  };
  const succeed = (body: unknown) => {
    assert.ok(respond, "a provider selection save request must be pending");
    respond({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { harness, requests, successes, toggle, succeed };
};

test("a provider checked while a save is pending stays staged and unsaved", async () => {
  const { harness, requests, successes, toggle, succeed } = loadHarness();
  harness.seed([], ["a"]);
  const saving = harness.save();
  assert.equal(harness.state().saving, true);
  toggle("b", true);
  succeed({ provider_ids: ["a"] });
  await saving;

  assert.deepEqual(requests, [{ provider_ids: ["a"] }], "the later edit is not part of the pending save");
  const state = harness.state();
  assert.equal(state.saving, false);
  assert.deepEqual(sorted(state.saved), ["a"]);
  assert.deepEqual(sorted(state.staged), ["a", "b"]);
  assert.equal(harness.unsaved(), true);
  assert.deepEqual(successes, ["1 providers active"], "the toast counts saved, not staged providers");
});

test("a provider unchecked during a no-filter save stays unchecked and unsaved", async () => {
  const { harness, requests, successes, toggle, succeed } = loadHarness();
  harness.seed(["a"], ["a", "b", "c"]);
  const saving = harness.save();
  toggle("b", false);
  succeed({ provider_ids: [] });
  await saving;

  assert.deepEqual(requests, [{ provider_ids: [] }], "all checked providers serialize to the no-filter state");
  const state = harness.state();
  assert.deepEqual(sorted(state.saved), ["a", "b", "c"]);
  assert.deepEqual(sorted(state.staged), ["a", "c"]);
  assert.equal(harness.unsaved(), true);
  assert.deepEqual(successes, ["Filter cleared"]);
});

test("a provider save response without provider_ids records only the submitted ids as saved", async () => {
  const { harness, requests, toggle, succeed } = loadHarness();
  harness.seed([], ["a"]);
  const saving = harness.save();
  toggle("b", true);
  succeed({ ok: true });
  await saving;

  assert.deepEqual(requests, [{ provider_ids: ["a"] }]);
  const state = harness.state();
  assert.deepEqual(sorted(state.saved), ["a"], "an id that was never sent cannot be recorded as saved");
  assert.deepEqual(sorted(state.staged), ["a", "b"]);
  assert.equal(harness.unsaved(), true);
});

for (const checking of [false, true]) {
  test(`a Codex subscription ${checking ? "checked" : "unchecked"} during a save preserves the umbrella transition`, async () => {
    const { harness, requests, toggle, succeed } = loadHarness([
      { id: "codex", subscriptions: [{ id: "codex:one" }, { id: "codex:two" }] },
      { id: "paid" },
    ]);
    const submitted = checking ? ["codex:one"] : ["codex"];
    harness.seed([], submitted);
    const saving = harness.save();
    toggle("codex:two", checking, true);
    succeed({ provider_ids: submitted });
    await saving;

    assert.deepEqual(requests, [{ provider_ids: submitted }]);
    const state = harness.state();
    assert.deepEqual(sorted(state.saved), submitted);
    assert.deepEqual(sorted(state.staged), checking ? ["codex"] : ["codex:one"]);
    assert.equal(harness.unsaved(), true);
  });
}

test("a provider save without later edits adopts the server's canonical selection and is clean", async () => {
  const { harness, requests, succeed } = loadHarness();
  harness.seed([], ["a", " b "]);
  const saving = harness.save();
  succeed({ provider_ids: ["a", "b"] });
  await saving;

  assert.deepEqual(requests, [{ provider_ids: ["a", " b "] }]);
  const state = harness.state();
  assert.deepEqual(sorted(state.saved), ["a", "b"]);
  assert.deepEqual(sorted(state.staged), ["a", "b"]);
  assert.equal(harness.unsaved(), false);
});
