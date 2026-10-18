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
  let respond: ((response: SaveResponse) => void) | null = null;
  let changeListener: ((event: { target: FakeCheckbox }) => void) | null = null;
  const context = {
    HTMLInputElement: FakeCheckbox,
    apiUrl: (path: string) => path,
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
    modelsList: {
      addEventListener: (type: string, listener: (event: { target: FakeCheckbox }) => void) => {
        if (type === "change") changeListener = listener;
      },
    },
    modelsOnlySelectedInput: { checked: false },
    renderModelsPicker: () => {},
    toast: { error: () => {}, success: () => {} },
    updateModelsStatus: () => {},
  };
  runInNewContext(
    [
      shippedSlice("let modelsCatalog = [];", "const modelsPositiveTokenCount"),
      shippedSlice("const saveModelsWhitelist = async () => {", "const discardModelsChanges"),
      shippedSlice('modelsList.addEventListener("change"', 'modelsCheckAllBtn.addEventListener("click"'),
      "globalThis.harness = {",
      "  save: saveModelsWhitelist,",
      "  unsaved: modelsHasUnsavedChanges,",
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
  return { harness, requests, toggle, succeed };
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
