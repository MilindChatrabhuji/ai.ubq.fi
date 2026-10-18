import { test } from "bun:test";
import assert from "node:assert/strict";
import { LIVE_E2E_DEFAULT_BASE_URL } from "../scripts/test-network.ts";

const getBaseUrl = (): URL => {
  // A missing or empty BASE_URL falls back to the origin the test runner approves for this segment.
  const rawBaseUrl = process.env.BASE_URL?.trim();
  const value = rawBaseUrl === undefined || rawBaseUrl === "" ? LIVE_E2E_DEFAULT_BASE_URL : rawBaseUrl;
  return new URL(value);
};

const getToken = (): string => {
  // An empty or whitespace-only variable falls through to the next source.
  const uosToken = process.env.UOS_AI_TOKEN?.trim();
  if (uosToken) return uosToken;
  const deployToken = process.env.DENO_DEPLOY_TOKEN?.trim();
  if (deployToken) return deployToken;
  throw new Error("Set UOS_AI_TOKEN or DENO_DEPLOY_TOKEN to run the live default-model e2e test.");
};

const fetchJson = async (baseUrl: URL, path: string, init: RequestInit): Promise<Record<string, unknown>> => {
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = typeof payload === "object" && payload !== null ? JSON.stringify(payload) : text;
    throw new Error(`${path} failed with ${response.status}: ${detail}`);
  }
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  return payload as Record<string, unknown>;
};

const extractResponsesText = (payload: Record<string, unknown>): string => {
  const output = payload.output;
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const part = contentItem as { type?: unknown; text?: unknown };
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("");
};

const extractChatText = (payload: Record<string, unknown>): string => {
  const choices = payload.choices;
  if (!Array.isArray(choices)) return "";
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return "";
  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
};

test("live: default model is listed and used by no-model requests", async () => {
  const baseUrl = getBaseUrl();
  const token = getToken();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const modelsPayload = await fetchJson(baseUrl, "/v1/models", { headers: authHeaders });
  const models = Array.isArray(modelsPayload.data) ? modelsPayload.data : [];
  const modelIds = models
    .map((model) => (typeof model === "object" && model !== null ? (model as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  assert.ok(modelIds.length > 0, "/v1/models did not include any model IDs");

  const responsesPayload = await fetchJson(baseUrl, "/v1/responses", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ input: "Reply exactly with pong." }),
  });
  const defaultModel = typeof responsesPayload.model === "string" ? responsesPayload.model : "";
  assert.ok(defaultModel, "no-model responses request did not return a model");
  assert.ok(modelIds.includes(defaultModel), `default model was not listed: ${defaultModel}`);
  assert.equal(extractResponsesText(responsesPayload).trim(), "pong");

  const chatPayload = await fetchJson(baseUrl, "/v1/chat/completions", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Reply exactly with pong." }] }),
  });
  assert.equal(chatPayload.model, defaultModel);
  assert.equal(extractChatText(chatPayload).trim(), "pong");
}, 300_000);
