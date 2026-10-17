import { test } from "bun:test";
import assert from "node:assert/strict";

import { getReasoningEffortForChatRequest, modelSupportsReasoningNone, updateReasoningSelectForModel } from "../static/reasoning-select.js";

type FakeOption = {
  disabled?: boolean;
  textContent: string;
  value: string;
};

type FakeSelect = {
  disabled: boolean;
  options: FakeOption[];
  textContent: string;
  value: string;
  appendChild: (option: FakeOption) => void;
};

const withFakeDocument = (fn: () => void) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string): FakeOption => {
        assert.equal(tag, "option");
        return { textContent: "", value: "" };
      },
    },
  });
  try {
    fn();
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
};

const createSelect = (): FakeSelect => ({
  disabled: true,
  options: [],
  textContent: "stale",
  value: "",
  appendChild(option) {
    this.options.push(option);
  },
});

test("reasoning select preserves every tier advertised by the model catalog", () => {
  withFakeDocument(() => {
    const select = createSelect();
    const selected = updateReasoningSelectForModel(
      select,
      {
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: null }, "low", "medium", "high", "xhigh", "max", "ultra"],
      },
      "none"
    );

    assert.equal(selected, "none");
    assert.equal(select.disabled, false);
    assert.deepEqual(
      select.options.map((option) => [option.value, option.textContent]),
      [
        ["", "Default"],
        ["none", "None"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
        ["ultra", "ultra"],
      ]
    );
  });
});

test("reasoning select preserves none when model levels omit it", () => {
  withFakeDocument(() => {
    const select = createSelect();
    const selected = updateReasoningSelectForModel(
      select,
      {
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
      },
      "none"
    );

    assert.equal(selected, "none");
    assert.equal(select.disabled, false);
    assert.deepEqual(
      select.options.map((option) => [option.value, option.textContent]),
      [
        ["", "Default"],
        ["none", "None"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
      ]
    );
  });
});

test("reasoning select resets none for Cerebras GPT-OSS", () => {
  withFakeDocument(() => {
    const select = createSelect();
    const model = {
      id: "gpt-oss-120b",
      upstream_provider: "cerebras",
      default_reasoning_effort: "medium",
      supported_reasoning_levels: ["low", "medium", "high"],
    };
    const selected = updateReasoningSelectForModel(select, model, "none", {
      includeNone: modelSupportsReasoningNone(model.id),
    });

    assert.equal(modelSupportsReasoningNone(model.id), false);
    assert.equal(selected, "");
    assert.equal(select.disabled, false);
    assert.deepEqual(
      select.options.map((option) => [option.value, option.textContent]),
      [
        ["", "Default"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
      ]
    );
  });
});

test("reasoning select shows none when model default is none", () => {
  withFakeDocument(() => {
    const select = createSelect();
    const selected = updateReasoningSelectForModel(
      select,
      {
        default_reasoning_level: null,
        supported_reasoning_levels: ["low", "medium", "high"],
      },
      "none"
    );

    assert.equal(selected, "none");
    assert.equal(select.disabled, false);
    assert.deepEqual(
      select.options.map((option) => [option.value, option.textContent]),
      [
        ["", "Default"],
        ["none", "None"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
      ]
    );
  });
});

test("chat reasoning none selection uses OpenAI wire value", () => {
  assert.equal(getReasoningEffortForChatRequest("none"), "none");
  assert.equal(getReasoningEffortForChatRequest("max"), "max");
  assert.equal(getReasoningEffortForChatRequest("ultra"), "ultra");
});
