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

/** The checkbox the Models list renders, as far as its change listener reads it. */
class FakeCheckbox {
  type = "checkbox";
  checked: boolean;
  dataset: Record<string, string>;
  constructor(id: string, checked: boolean) {
    this.dataset = { modelToggle: id };
    this.checked = checked;
  }
  closest() {
    return null;
  }
}

type Harness = {
  save: () => Promise<void>;
  unsaved: () => boolean;
  switchTarget: () => void;
  seed: (saved: readonly string[], staged: readonly string[]) => void;
  state: () => { saved: Iterable<string>; staged: Iterable<string>; saving: boolean };
};

/**
 * Runs the shipped Models state, selection helpers, whitelist save handler and
 * checkbox change listener in one script, so the save and the edit share the
 * same module state the browser has. Only the network and rendering are faked.
 */
const loadHarness = () => {
  const requests: unknown[] = [];
  const notifications: string[] = [];
  let respond: ((response: SaveResponse) => void) | null = null;
  let rejectSave: ((error: Error) => void) | null = null;
  let changeListener: ((event: { target: FakeCheckbox }) => void) | null = null;
  const context = {
    HTMLInputElement: FakeCheckbox,
    apiUrl: (path: string) => path,
    console,
    fetch: (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body));
      return new Promise<SaveResponse>((resolve, reject) => {
        respond = resolve;
        rejectSave = reject;
      });
    },
    formatNumber: (value: number) => String(value),
    getAdminToken: () => "admin-token",
    hasAdminCredential: () => true,
    modelsList: {
      addEventListener: (type: string, listener: (event: { target: FakeCheckbox }) => void) => {
        if (type === "change") changeListener = listener;
      },
    },
    modelsOnlySelectedInput: { checked: false },
    setBadge: () => {},
    modelsWhitelistBadge: {},
    renderModelsMessage: () => {},
    renderModelsPicker: () => {},
    toast: {
      error: (message: string) => {
        notifications.push(message);
      },
      success: (message: string) => {
        notifications.push(message);
      },
    },
    updateModelsStatus: () => {},
  };
  runInNewContext(
    [
      shippedSlice("let modelsCatalog = [];", "const modelsPositiveTokenCount"),
      shippedSlice("const invalidateAdminModels =", "const modelsCatalogWarning ="),
      shippedSlice("const saveModelsWhitelist = async () => {", "const discardModelsChanges"),
      shippedSlice('modelsList.addEventListener("change"', 'modelsCheckAllBtn.addEventListener("click"'),
      "globalThis.harness = {",
      "  save: saveModelsWhitelist,",
      "  unsaved: modelsHasUnsavedChanges,",
      '  switchTarget: () => invalidateAdminModels("Target changed"),',
      "  seed: (saved, staged) => {",
      "    modelsSavedSelection = new Set(saved);",
      "    modelsSelection = new Set(staged);",
      "    modelsLoadedAt = 1;",
      "  },",
      "  state: () => ({ saved: modelsSavedSelection, staged: modelsSelection, saving: modelsSaving }),",
      "};",
    ].join("\n"),
    context
  );
  const harness = (context as typeof context & { harness: Harness }).harness;
  const toggle = (id: string, checked: boolean) => {
    assert.ok(changeListener, "the Models list change listener must be registered");
    changeListener({ target: new FakeCheckbox(id, checked) });
  };
  const succeed = (body: unknown) => {
    assert.ok(respond, "a whitelist save request must be pending");
    respond({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const fail = (transport: boolean) => {
    assert.ok(respond && rejectSave, "a whitelist save request must be pending");
    if (transport) rejectSave(new Error("offline"));
    else respond({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: "failed" } }) });
  };
  return { harness, requests, notifications, toggle, succeed, fail };
};

test("a model checked while the whitelist save is pending stays staged and unsaved", async () => {
  const { harness, requests, toggle, succeed } = loadHarness();
  harness.seed(["a"], ["a", "b"]);
  const saving = harness.save();
  toggle("c", true);
  succeed({ ok: true, stored: true, model_ids: ["a", "b"] });
  await saving;

  assert.deepEqual(requests, [{ model_ids: ["a", "b"] }], "the later edit is not part of the pending save");
  const state = harness.state();
  assert.equal(state.saving, false);
  assert.deepEqual(sorted(state.saved), ["a", "b"]);
  assert.deepEqual(sorted(state.staged), ["a", "b", "c"], "the edit made after Save was clicked survives");
  assert.equal(harness.unsaved(), true, "the panel must not look clean while an unsaved edit exists");
});

test("a model unchecked while the whitelist save is pending stays unchecked and unsaved", async () => {
  const { harness, toggle, succeed } = loadHarness();
  harness.seed([], ["a", "b"]);
  const saving = harness.save();
  toggle("b", false);
  succeed({ ok: true, stored: true, model_ids: ["a", "b"] });
  await saving;

  const state = harness.state();
  assert.deepEqual(sorted(state.saved), ["a", "b"]);
  assert.deepEqual(sorted(state.staged), ["a"]);
  assert.equal(harness.unsaved(), true);
});

test("a whitelist save response without model_ids records only the submitted ids as saved", async () => {
  const { harness, toggle, succeed } = loadHarness();
  harness.seed([], ["a"]);
  const saving = harness.save();
  toggle("b", true);
  succeed({ ok: true, stored: true });
  await saving;

  const state = harness.state();
  assert.deepEqual(sorted(state.saved), ["a"], "an id that was never sent cannot be recorded as saved");
  assert.deepEqual(sorted(state.staged), ["a", "b"]);
  assert.equal(harness.unsaved(), true);
});

test("a whitelist save with no later edit adopts the server's canonical ids and is clean", async () => {
  const { harness, requests, succeed } = loadHarness();
  harness.seed([], ["a", " b "]);
  const saving = harness.save();
  // The server trims each identifier before storing it and answers with the stored form.
  succeed({ ok: true, stored: true, model_ids: ["b", "a"] });
  await saving;

  assert.deepEqual(requests, [{ model_ids: [" b ", "a"] }]);
  const state = harness.state();
  assert.deepEqual(sorted(state.saved), ["a", "b"]);
  assert.deepEqual(sorted(state.staged), ["a", "b"]);
  assert.equal(harness.unsaved(), false);
});

for (const outcome of ["success", "http-error", "transport-error"]) {
  test(`a target switch fences a pending whitelist save's ${outcome} completion`, async () => {
    const { harness, requests, notifications, succeed, fail } = loadHarness();
    harness.seed(["old-saved"], ["old-staged"]);
    const saving = harness.save();
    assert.equal(harness.state().saving, true);
    harness.switchTarget();
    assert.equal(harness.unsaved(), false, "invalidating the target clears both selections");
    harness.seed(["new-saved"], ["new-saved", "new-staged"]);
    if (outcome === "success") succeed({ model_ids: ["foreign-model"] });
    else fail(outcome === "transport-error");
    await saving;
    assert.deepEqual(requests, [{ model_ids: ["old-staged"] }]);
    const state = harness.state();
    assert.deepEqual(sorted(state.saved), ["new-saved"]);
    assert.deepEqual(sorted(state.staged), ["new-saved", "new-staged"]);
    assert.equal(state.saving, false);
    assert.equal(harness.unsaved(), true, "new-target edits retain their own unsaved status");
    assert.deepEqual(notifications, [], "the old target cannot publish save notifications to the new target");
  });
}

type Provider = { id: string; subscriptions?: { id: string }[] };

class ProviderCheckbox {
  type = "checkbox";
  checked: boolean;
  dataset: Record<string, string>;
  constructor(id: string, checked: boolean, subscription: boolean) {
    this.dataset = subscription ? { providerSubscriptionToggle: id } : { providerToggle: id };
    this.checked = checked;
  }
}

type ProviderHarness = {
  save: () => Promise<void>;
  unsaved: () => boolean;
  seed: (saved: readonly string[], staged: readonly string[]) => void;
  state: () => { saved: Iterable<string>; staged: Iterable<string>; saving: boolean };
};

/** Runs the shipped selection state, helpers, save handler and checkbox listener; only I/O and rendering are faked. */
const loadProviderHarness = (roster: Provider[] = [{ id: "a" }, { id: "b" }, { id: "c" }]) => {
  const requests: unknown[] = [];
  const successes: string[] = [];
  let respond: ((response: SaveResponse) => void) | null = null;
  let changeListener: ((event: { target: ProviderCheckbox }) => void) | null = null;
  const context = {
    HTMLInputElement: ProviderCheckbox,
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
      addEventListener: (type: string, listener: (event: { target: ProviderCheckbox }) => void) => {
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
  const harness = (context as typeof context & { harness: ProviderHarness }).harness;
  const toggle = (id: string, checked: boolean, subscription = false) => {
    assert.ok(changeListener, "the Providers list change listener must be registered");
    changeListener({ target: new ProviderCheckbox(id, checked, subscription) });
  };
  const succeed = (body: unknown) => {
    assert.ok(respond, "a provider selection save request must be pending");
    respond({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { harness, requests, successes, toggle, succeed };
};

test("a provider checked while a save is pending stays staged and unsaved", async () => {
  const { harness, requests, successes, toggle, succeed } = loadProviderHarness();
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
  assert.deepEqual(successes, ["1 provider active"], "the toast counts saved, not staged providers");
});

test("a provider unchecked during a no-filter save stays unchecked and unsaved", async () => {
  const { harness, requests, successes, toggle, succeed } = loadProviderHarness();
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
  const { harness, requests, toggle, succeed } = loadProviderHarness();
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
    const { harness, requests, toggle, succeed } = loadProviderHarness([
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
  const { harness, requests, succeed } = loadProviderHarness();
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

test("provider pending-save toasts count saved tiers once while later edits stay staged", async () => {
  const { harness, successes, toggle, succeed } = loadProviderHarness([
    { id: "codex", subscriptions: [{ id: "codex:one" }, { id: "codex:two" }, { id: "codex:three" }] },
    { id: "paid" },
  ]);
  harness.seed([], ["codex:one", "codex:two"]);
  const saving = harness.save();
  toggle("paid", true);
  succeed({ provider_ids: ["codex:one", "codex:two"] });
  await saving;
  assert.deepEqual(successes, ["1 provider active"], "two saved subscriptions form one tier, and the later paid edit is unsaved");
  assert.deepEqual(sorted(harness.state().staged), ["codex:one", "codex:two", "paid"]);
  assert.equal(harness.unsaved(), true);
});

test("unchecking Codex during a pending provider save removes missing subscriptions and preserves a valid next save", async () => {
  const removed = `codex:${"a".repeat(64)}`;
  const { harness, requests, successes, toggle, succeed } = loadProviderHarness([
    { id: "codex", subscriptions: [{ id: "codex:one" }, { id: "codex:two" }] },
    { id: "surplus" },
  ]);
  harness.seed([], [removed, "codex:one", "surplus"]);
  const saving = harness.save();
  toggle("codex", false);
  succeed({ provider_ids: [removed, "codex:one", "surplus"] });
  await saving;

  assert.deepEqual(sorted(harness.state().saved), sorted([removed, "codex:one", "surplus"]));
  assert.deepEqual(sorted(harness.state().staged), ["surplus"], "the later tier-off edit covers configured and missing subscriptions");
  assert.equal(harness.unsaved(), true);
  assert.deepEqual(successes, ["2 providers active"], "the completed request reports its saved tiers before the later edit");

  const nextSave = harness.save();
  assert.deepEqual(requests.at(-1), { provider_ids: ["surplus"] }, "the next valid save cannot reintroduce the retired Codex id");
  succeed({ provider_ids: ["surplus"] });
  await nextSave;
  assert.equal(harness.unsaved(), false);
  assert.deepEqual(successes, ["2 providers active", "1 provider active"]);
});
