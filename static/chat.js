import "./network.js";
import {
  buildBackendUrl,
  formatAuthSessionLabel,
  hasAuthPasskeyCredential,
  hasStoredPasskeyCredentials,
  isLocalDevelopmentOrigin,
  registerPasskey,
  resolveBackendBase,
  signInWithPasskey,
  signOut,
  storage,
  STORAGE_KEYS as AUTH_STORAGE_KEYS,
} from "./auth.js";
import {
  getReasoningEffortForChatRequest,
  isReasoningNoneSelection,
  modelSupportsReasoningNone,
  setReasoningPlaceholder as setSharedReasoningPlaceholder,
  updateReasoningSelectForModel,
} from "./reasoning-select.js?v=20260917-dynamic-metadata-v1";
import {
  createChatMessageElement,
  createChatStatsAccumulator,
  parseChatSseEvent,
  readChatCompletionDecodeTokens,
  readChatCompletionMessageText,
  recordCompletedChatResponse,
  renderChatStats,
  resetChatStatsAccumulator,
  setChatMessageContent,
  splitChatSseEvents,
} from "./chat-stats.js?v=20260827-response-stats-v4";
import { bindForegroundRefresh } from "./foreground-refresh.js";
import { toast } from "./toast.js?v=passport-design-20260922";

const STORAGE_KEYS = {
  rememberToken: AUTH_STORAGE_KEYS.rememberToken,
  token: AUTH_STORAGE_KEYS.token,
  passkeyHandle: AUTH_STORAGE_KEYS.passkeyHandle,
  passkeyCredentialIds: AUTH_STORAGE_KEYS.passkeyCredentialIds,
  model: "uos_ai.playground.model",
  reasoningEffort: "uos_ai.playground.reasoning_effort",
  stream: "uos_ai.playground.stream",
  systemPrompt: "uos_ai.playground.system_prompt",
};

const PANEL_STATE_PREFIX = "uos_ai.playground.panel.";

const debounce = (fn, wait = 450) => {
  let timer = null;
  const schedule = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  schedule.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return schedule;
};

const mustGet = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el;
};

const tokenInput = mustGet("token");
const rememberTokenInput = mustGet("remember-token");
const showTokenInput = mustGet("show-token");
const passkeyHandleInput = mustGet("passkey-handle");
const passkeyLoginBtn = mustGet("passkey-login");
const passkeyRegisterBtn = mustGet("passkey-register");
const signOutBtn = mustGet("sign-out");
const passkeyStatus = mustGet("passkey-status");
const modelInput = mustGet("model");
const reasoningSelect = mustGet("reasoning-effort");
const streamInput = mustGet("stream");
const streamHint = mustGet("stream-hint");
const systemInput = mustGet("system");
const authBadge = mustGet("auth-badge");
const messagesEl = mustGet("messages");
const resetChatBtn = mustGet("reset-chat");
const stopBtn = mustGet("stop");
const chatForm = mustGet("chat-form");
const promptInput = mustGet("prompt");
const sendBtn = mustGet("send");
const chatStatsEl = document.querySelector("[data-chat-stats]");
if (!chatStatsEl) throw new Error("Missing element: [data-chat-stats]");
const panels = Array.from(document.querySelectorAll("details[data-chat-panel][data-panel-key]"));

const DEFAULT_MODEL = "";
const STREAM_UNSUPPORTED_MODELS = new Set(["gpt-oss-120b"]);

const setAuthBadge = (state, text) => {
  authBadge.dataset.state = state;
  authBadge.textContent = text;
};

const setPasskeyStatus = (state, text) => {
  passkeyStatus.dataset.state = state;
  passkeyStatus.textContent = text;
};

const getActiveBackendBase = () => resolveBackendBase();

const formatBackendLabel = (baseUrl) => {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
};

const buildBackendAwareMessage = (baseUrl, fallback) => {
  const target = formatBackendLabel(baseUrl);
  return `${fallback} Re-sign in on the active backend at ${target}.`;
};

// The loopback development server disables client auth and authenticates every
// local request as its own unlimited super-admin principal. `localDevelopmentAuth`
// records that this page probed the active backend and was told so, which is what
// lets the composer work with no token at all.
let localDevelopmentAuth = false;

const LOCAL_DEVELOPMENT_PRINCIPAL = "local-development";

/** Bearer headers for a token, or none in loopback development mode. */
const authHeaders = (token = "") => {
  const trimmed = String(token ?? "").trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
};

/** The identity the model catalog was loaded for: a token, or the local principal. */
const currentPrincipal = () => tokenInput.value.trim() || (localDevelopmentAuth ? LOCAL_DEVELOPMENT_PRINCIPAL : "");

const clearLocalDevelopmentAuth = () => {
  localDevelopmentAuth = false;
};

const setSignedInState = (signedIn, options = {}) => {
  const localDevelopment = localDevelopmentAuth && !signedIn && !tokenInput.value.trim();
  const deviceRegistered = options.deviceRegistered ?? hasStoredPasskeyCredentials();
  const canRegisterPasskey = options.canRegisterPasskey ?? false;
  passkeyLoginBtn.hidden = signedIn || localDevelopment;
  passkeyRegisterBtn.hidden = localDevelopment || deviceRegistered || (signedIn && !canRegisterPasskey);
  signOutBtn.hidden = !signedIn || localDevelopment;
  if (signedIn) setPasskeyStatus("ok", options.statusText ?? "Token active");
  else if (localDevelopment) setPasskeyStatus("ok", "Auth disabled on this loopback server");
  else setPasskeyStatus("unknown", "Passkey idle");
};

const logPasskeyUsername = (handle) => {
  const username = (handle ?? "").trim();
  if (username) console.info("[ai.ubq.fi] passkey username:", username);
};

let modelsRequestId = 0;
let modelsLoadedToken = "";
let modelCatalog = new Map();
let preferredModel = DEFAULT_MODEL;
let preferredReasoningEffort = "";
let preferredStream = true;
let chatBusy = false;

const updateStreamControl = (modelId = modelInput.value) => {
  const unsupported = STREAM_UNSUPPORTED_MODELS.has(modelId.trim());
  streamInput.disabled = chatBusy || unsupported;
  streamHint.hidden = !unsupported;
  if (unsupported) {
    streamInput.checked = false;
    return;
  }
  streamInput.checked = preferredStream;
};

const normalizeModelId = (model) => {
  if (!model || typeof model !== "object") return "";
  const id = typeof model.id === "string" ? model.id : typeof model.slug === "string" ? model.slug : "";
  return id.trim();
};

const formatModelLabel = (model, fallback) => {
  const display = typeof model?.display_name === "string" ? model.display_name.trim() : "";
  if (display) return display;
  const name = typeof model?.name === "string" ? model.name.trim() : "";
  if (name) return name;
  return fallback;
};

const mergeModelCapabilities = (models, capabilities) => {
  const capabilitiesById = new Map(
    capabilities
      .map((capability) => ({ id: normalizeModelId(capability), capability }))
      .filter((entry) => entry.id)
      .map((entry) => [entry.id, entry.capability])
  );

  return models.map((model) => {
    const id = normalizeModelId(model);
    const capability = capabilitiesById.get(id);
    if (!capability) return model;

    const merged = { ...model };
    if (typeof capability.display_name === "string" && capability.display_name.trim()) {
      merged.display_name = capability.display_name;
    }
    if (Array.isArray(capability.supported_endpoints)) {
      merged.supported_endpoints = capability.supported_endpoints;
    }
    if (Array.isArray(capability.supported_reasoning_levels)) {
      merged.supported_reasoning_levels = capability.supported_reasoning_levels;
    }
    const defaultReasoning =
      typeof capability.default_reasoning_effort === "string"
        ? capability.default_reasoning_effort.trim()
        : typeof capability.default_reasoning_level === "string"
          ? capability.default_reasoning_level.trim()
          : "";
    if (defaultReasoning) {
      merged.default_reasoning_effort = defaultReasoning;
      merged.default_reasoning_level = defaultReasoning;
    }
    for (const key of ["context_window_tokens", "max_context_window_tokens", "auto_compact_token_limit_tokens"]) {
      if (typeof capability[key] === "number" || capability[key] === null) {
        merged[key] = capability[key];
      }
    }
    return merged;
  });
};

const setModelPlaceholder = (label) => {
  modelInput.textContent = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = label;
  option.disabled = true;
  modelInput.appendChild(option);
  modelInput.disabled = true;
  updateStreamControl();
};

const setReasoningPlaceholder = (label) => {
  setSharedReasoningPlaceholder(reasoningSelect, label);
};

const loadDefaultModelFromAdmin = async (token, baseUrl) => {
  try {
    const response = await fetch(buildBackendUrl("/admin/defaults", baseUrl), {
      headers: authHeaders(token),
      cache: "no-store",
    });
    if (!response.ok) return "";
    const payload = await response.json().catch(() => null);
    const raw = payload?.defaults?.model;
    if (typeof raw !== "string") return "";
    const model = raw.trim();
    return model;
  } catch {
    return "";
  }
};

const setModelOptions = (models, preferred, fallbackModel = "") => {
  modelInput.textContent = "";
  const options = models
    .map((model) => {
      const id = normalizeModelId(model);
      if (!id) return null;
      return { value: id, label: formatModelLabel(model, id), model };
    })
    .filter(Boolean);

  if (!options.length) {
    setModelPlaceholder("No models available");
    return "";
  }

  modelInput.disabled = false;
  options.forEach((option) => {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    modelInput.appendChild(opt);
  });

  const preferredValue = typeof preferred === "string" ? preferred.trim() : "";
  const fallbackValue = typeof fallbackModel === "string" ? fallbackModel.trim() : "";
  const firstValue = options[0].value;
  const hasStored = options.some((option) => option.value === preferredValue);
  const hasFallback = fallbackValue ? options.some((option) => option.value === fallbackValue) : false;
  const next = hasStored ? preferredValue : hasFallback ? fallbackValue : firstValue;
  modelInput.value = next;
  return next;
};

const updateReasoningForModel = (modelId, preferred) => {
  const model = modelCatalog.get(modelId);
  const includeNone = modelSupportsReasoningNone(modelId);
  const selected = updateReasoningSelectForModel(reasoningSelect, model, preferred, { includeNone });
  if (!includeNone && isReasoningNoneSelection(preferred)) {
    storage.remove(STORAGE_KEYS.reasoningEffort);
  }
  return selected;
};

const resetModelCatalog = (label = "Authenticate to load models") => {
  modelCatalog = new Map();
  modelsLoadedToken = "";
  setModelPlaceholder(label);
  setReasoningPlaceholder("No model selected");
};

const loadModels = async (token, options = {}) => {
  const trimmed = token.trim();
  const principal = trimmed || (localDevelopmentAuth ? LOCAL_DEVELOPMENT_PRINCIPAL : "");
  if (!principal) return;
  if (!options.force && principal === modelsLoadedToken) return;
  const requestId = ++modelsRequestId;
  const backendBase = getActiveBackendBase();
  try {
    const [modelsResponse, capabilitiesResponse, defaultsResponse] = await Promise.all([
      fetch(buildBackendUrl("/v1/models", backendBase), {
        headers: authHeaders(trimmed),
        cache: "no-store",
      }).then(async (res) => ({ res, data: await res.json().catch(() => null) })),
      fetch(buildBackendUrl("/uos/models/capabilities", backendBase), {
        headers: authHeaders(trimmed),
        cache: "no-store",
      })
        .then(async (res) => ({ res, data: await res.json().catch(() => null) }))
        .catch((error) => ({ error })),
      loadDefaultModelFromAdmin(trimmed, backendBase)
        .then((model) => ({ ok: true, model }))
        .catch(() => ({
          ok: false,
          model: "",
        })),
    ]);
    const { res, data } = modelsResponse;
    if (requestId !== modelsRequestId) return;
    if (principal !== currentPrincipal()) return;
    if (!res.ok) {
      if (res.status === 401) {
        setModelPlaceholder(buildBackendAwareMessage(backendBase, "Auth failed for the configured backend."));
        return;
      }
      const message =
        typeof data?.error?.message === "string" && data?.error?.message.trim().length > 0
          ? data.error.message
          : `Failed to load models (${res.status} ${res.statusText})`;
      setModelPlaceholder(message);
      return;
    }
    const rawModels = Array.isArray(data?.data) ? data.data : [];
    const capabilities =
      "res" in capabilitiesResponse && capabilitiesResponse.res.ok && Array.isArray(capabilitiesResponse.data?.data)
        ? capabilitiesResponse.data.data
        : [];
    if (!capabilities.length && "res" in capabilitiesResponse && !capabilitiesResponse.res.ok) {
      console.warn("[ai.ubq.fi] model capabilities unavailable:", capabilitiesResponse.res.status);
    } else if ("error" in capabilitiesResponse) {
      console.warn("[ai.ubq.fi] model capabilities unavailable:", capabilitiesResponse.error);
    }
    const models = mergeModelCapabilities(rawModels, capabilities).filter((model) => {
      const endpoints = model?.supported_endpoints;
      return !Array.isArray(endpoints) || endpoints.includes("/v1/chat/completions");
    });
    if (!models.length) {
      setModelPlaceholder("No models available");
      return;
    }
    modelCatalog = new Map(
      models
        .map((model) => ({ id: normalizeModelId(model), model }))
        .filter((entry) => entry.id)
        .map((entry) => [entry.id, entry.model])
    );
    const defaultsModel = defaultsResponse.ok ? defaultsResponse.model : "";
    const selected = setModelOptions(models, preferredModel, defaultsModel);
    if (selected && selected !== preferredModel) {
      preferredModel = selected;
      persistSetting(STORAGE_KEYS.model, selected);
    } else if (selected) {
      preferredModel = selected;
    }
    modelsLoadedToken = principal;
    preferredReasoningEffort =
      updateReasoningForModel(selected || modelInput.value.trim(), preferredReasoningEffort) ?? "";
    updateStreamControl(selected || modelInput.value.trim());
  } catch {
    if (requestId !== modelsRequestId) return;
  }
};

let authCheckId = 0;
const checkAuthToken = async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setAuthBadge("bad", "Missing token");
    setSignedInState(false);
    resetModelCatalog();
    setReasoningPlaceholder("Missing token");
    return;
  }

  const requestId = ++authCheckId;
  setAuthBadge("unknown", "Checking...");
  const backendBase = getActiveBackendBase();
  try {
    const res = await fetch(buildBackendUrl("/uos/auth", backendBase), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const data = await res.json().catch(() => null);
    if (requestId !== authCheckId) return;
    if (!res.ok) {
      if (res.status === 401) {
        setAuthBadge("bad", buildBackendAwareMessage(backendBase, "Token was rejected by the active backend."));
      } else {
        setAuthBadge("bad", data?.error?.message ?? "Unauthorized");
      }
      setSignedInState(false);
      resetModelCatalog();
      setReasoningPlaceholder("Invalid token");
      return;
    }
    const mode = data?.auth?.mode;
    setAuthBadge("ok", mode ? `OK (${mode})` : "OK");
    clearLocalDevelopmentAuth();
    setSignedInState(true, {
      canRegisterPasskey: data?.auth?.is_admin === true,
      deviceRegistered: hasAuthPasskeyCredential(data?.auth) || hasStoredPasskeyCredentials(),
      statusText: formatAuthSessionLabel(data?.auth),
    });
    void loadModels(token);
  } catch {
    if (requestId !== authCheckId) return;
    setAuthBadge("bad", "Offline");
    setSignedInState(false);
  }
};

/**
 * Loopback development has no credential to obtain, so the page asks the active
 * backend whether it disables client auth and reports a super admin. Only a
 * same-origin HTTP-loopback backend may answer for this page, so the localhost
 * convenience can never authorize a remote gateway.
 */
const probeLocalDevelopmentAuth = async () => {
  if (!isLocalDevelopmentOrigin()) return null;
  const backendBase = getActiveBackendBase();
  if (formatBackendLabel(backendBase) !== globalThis.location.origin) return null;
  try {
    const res = await fetch(buildBackendUrl("/uos/auth", backendBase), { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const auth = data?.auth;
    if (auth?.mode !== "disabled" || auth?.is_admin !== true) return null;
    return auth;
  } catch {
    return null;
  }
};

const applyLocalDevelopmentAuth = (auth) => {
  localDevelopmentAuth = true;
  setAuthBadge("ok", auth?.is_super_admin === true ? "Local super admin" : "Local development");
  setSignedInState(false);
  void loadModels("");
};

const initializeLocalDevelopmentAuth = async () => {
  if (tokenInput.value.trim()) return;
  const requestId = ++authCheckId;
  const auth = await probeLocalDevelopmentAuth();
  // A token typed while the probe was in flight wins.
  if (requestId !== authCheckId || tokenInput.value.trim()) return;
  if (!auth) {
    setAuthBadge("bad", "Missing token");
    setSignedInState(false);
    resetModelCatalog();
    return;
  }
  applyLocalDevelopmentAuth(auth);
};

const scheduleAuthCheck = debounce(() => {
  void checkAuthToken();
}, 500);

const persistTokenIfEnabled = () => {
  if (!rememberTokenInput.checked) return;
  const token = tokenInput.value.trim();
  if (token) storage.set(STORAGE_KEYS.token, token);
  else storage.remove(STORAGE_KEYS.token);
};

const persistSetting = (key, value) => {
  const trimmed = value.trim();
  if (trimmed) storage.set(key, trimmed);
  else storage.remove(key);
};

const scheduleTokenPersist = debounce(() => {
  persistTokenIfEnabled();
}, 500);

const persistPasskeyHandle = () => {
  persistSetting(STORAGE_KEYS.passkeyHandle, passkeyHandleInput.value);
};

const schedulePasskeyHandlePersist = debounce(() => {
  persistPasskeyHandle();
}, 500);

const setPasskeyHandleValue = (handle) => {
  passkeyHandleInput.value = handle ?? "";
  persistPasskeyHandle();
  logPasskeyUsername(handle);
};

const scheduleModelPersist = debounce(() => {
  persistSetting(STORAGE_KEYS.model, modelInput.value);
}, 500);

const scheduleSystemPersist = debounce(() => {
  persistSetting(STORAGE_KEYS.systemPrompt, systemInput.value);
}, 500);

const restoreSettings = () => {
  const remember = storage.get(STORAGE_KEYS.rememberToken) === "1";
  rememberTokenInput.checked = remember;
  if (remember) tokenInput.value = storage.get(STORAGE_KEYS.token) ?? "";
  passkeyHandleInput.value = storage.get(STORAGE_KEYS.passkeyHandle) ?? "";

  preferredModel = storage.get(STORAGE_KEYS.model) ?? DEFAULT_MODEL;
  preferredReasoningEffort = storage.get(STORAGE_KEYS.reasoningEffort) ?? "";
  preferredStream = storage.get(STORAGE_KEYS.stream) !== "0";
  streamInput.checked = preferredStream;
  updateStreamControl();
  setModelPlaceholder("Loading models...");
  setReasoningPlaceholder("Loading models...");
  systemInput.value = storage.get(STORAGE_KEYS.systemPrompt) ?? "";
};

const restorePanelStates = () => {
  panels.forEach((panel) => {
    const key = panel.dataset.panelKey;
    if (!key) return;
    const stored = storage.get(`${PANEL_STATE_PREFIX}${key}`);
    if (stored === "open") panel.open = true;
    if (stored === "closed") panel.open = false;
  });
};

const bindPanelPersistence = () => {
  panels.forEach((panel) => {
    const key = panel.dataset.panelKey;
    if (!key) return;
    panel.addEventListener("toggle", () => {
      storage.set(`${PANEL_STATE_PREFIX}${key}`, panel.open ? "open" : "closed");
    });
  });
};

restoreSettings();
restorePanelStates();
bindPanelPersistence();
setSignedInState(false);
if (tokenInput.value.trim()) {
  setAuthBadge("unknown", "Checking...");
  void checkAuthToken();
} else {
  setAuthBadge("unknown", "Checking...");
  void initializeLocalDevelopmentAuth();
}

bindForegroundRefresh(() => {
  if (currentPrincipal()) void loadModels(tokenInput.value.trim(), { force: true });
});

showTokenInput.addEventListener("change", () => {
  tokenInput.type = showTokenInput.checked ? "text" : "password";
});

tokenInput.addEventListener("input", () => {
  authCheckId += 1;
  modelsRequestId += 1;
  scheduleTokenPersist();
  const token = tokenInput.value.trim();
  if (!token) {
    scheduleAuthCheck.cancel();
    clearLocalDevelopmentAuth();
    setAuthBadge("unknown", "Checking...");
    setSignedInState(false);
    resetModelCatalog();
    setReasoningPlaceholder("No model selected");
    void initializeLocalDevelopmentAuth();
    return;
  }
  clearLocalDevelopmentAuth();
  if (token !== modelsLoadedToken) resetModelCatalog("Checking token...");
  setAuthBadge("unknown", "Checking...");
  scheduleAuthCheck();
});

rememberTokenInput.addEventListener("change", () => {
  if (rememberTokenInput.checked) {
    storage.set(STORAGE_KEYS.rememberToken, "1");
    persistTokenIfEnabled();
    return;
  }
  storage.remove(STORAGE_KEYS.rememberToken);
  storage.remove(STORAGE_KEYS.token);
  setSignedInState(Boolean(tokenInput.value.trim()));
});

passkeyHandleInput.addEventListener("input", () => {
  schedulePasskeyHandlePersist();
});

const applySignedInToken = (token, options = {}) => {
  tokenInput.value = token;
  rememberTokenInput.checked = true;
  storage.set(STORAGE_KEYS.rememberToken, "1");
  storage.set(STORAGE_KEYS.token, token);
  clearLocalDevelopmentAuth();
  setSignedInState(true, options);
  authCheckId += 1;
  modelsRequestId += 1;
  setAuthBadge("unknown", "Checking...");
  void checkAuthToken();
};

passkeyLoginBtn.addEventListener("click", async () => {
  setPasskeyStatus("unknown", "Signing in...");
  passkeyLoginBtn.disabled = true;
  passkeyRegisterBtn.disabled = true;
  try {
    const passkeyHandle = passkeyHandleInput.value.trim();
    const result = await signInWithPasskey({
      baseUrl: getActiveBackendBase(),
      handle: passkeyHandle,
      useHandle: Boolean(passkeyHandle),
    });
    if (result.handle) setPasskeyHandleValue(result.handle);
    applySignedInToken(result.token, { deviceRegistered: true });
    setPasskeyStatus("ok", "Passkey signed in");
  } catch (error) {
    setSignedInState(false);
    setPasskeyStatus("bad", error?.message ?? "Passkey sign-in failed");
  } finally {
    passkeyLoginBtn.disabled = false;
    passkeyRegisterBtn.disabled = false;
  }
});

passkeyRegisterBtn.addEventListener("click", async () => {
  setPasskeyStatus("unknown", "Registering...");
  passkeyLoginBtn.disabled = true;
  passkeyRegisterBtn.disabled = true;
  try {
    const result = await registerPasskey({
      handle: passkeyHandleInput.value,
      token: tokenInput.value,
      baseUrl: getActiveBackendBase(),
    });
    if (result.handle) setPasskeyHandleValue(result.handle);
    applySignedInToken(result.token, { deviceRegistered: true });
    setPasskeyStatus("ok", "Passkey registered");
  } catch (error) {
    setPasskeyStatus("bad", error?.message ?? "Passkey registration failed");
  } finally {
    passkeyLoginBtn.disabled = false;
    passkeyRegisterBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  signOutBtn.disabled = true;
  try {
    await signOut({ token, baseUrl: getActiveBackendBase() });
  } finally {
    tokenInput.value = "";
    rememberTokenInput.checked = false;
    authCheckId += 1;
    modelsRequestId += 1;
    clearLocalDevelopmentAuth();
    setAuthBadge("unknown", "Checking...");
    setSignedInState(false);
    resetModelCatalog();
    signOutBtn.disabled = false;
    void initializeLocalDevelopmentAuth();
  }
});

globalThis.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEYS.rememberToken) {
    rememberTokenInput.checked = event.newValue === "1";
    return;
  }
  if (event.key === STORAGE_KEYS.passkeyHandle) {
    passkeyHandleInput.value = event.newValue ?? "";
    return;
  }
  if (event.key === STORAGE_KEYS.passkeyCredentialIds) {
    setSignedInState(Boolean(tokenInput.value.trim()));
    return;
  }
  if (event.key !== STORAGE_KEYS.token) return;
  if (event.newValue === null) {
    tokenInput.value = "";
    authCheckId += 1;
    modelsRequestId += 1;
    clearLocalDevelopmentAuth();
    setAuthBadge("unknown", "Checking...");
    setSignedInState(false);
    resetModelCatalog();
    void initializeLocalDevelopmentAuth();
    return;
  }
  if (!rememberTokenInput.checked) return;
  tokenInput.value = event.newValue ?? "";
  authCheckId += 1;
  modelsRequestId += 1;
  clearLocalDevelopmentAuth();
  if (tokenInput.value.trim()) {
    setAuthBadge("unknown", "Checking...");
    void checkAuthToken();
    return;
  }
  setAuthBadge("unknown", "Checking...");
  setSignedInState(false);
  resetModelCatalog();
  void initializeLocalDevelopmentAuth();
});

const handleModelChange = () => {
  const nextModel = modelInput.value.trim();
  if (nextModel) preferredModel = nextModel;
  scheduleModelPersist();
  preferredReasoningEffort = updateReasoningForModel(nextModel, reasoningSelect.value) ?? "";
  updateStreamControl(nextModel);
};

modelInput.addEventListener("input", handleModelChange);
modelInput.addEventListener("change", handleModelChange);
systemInput.addEventListener("input", () => scheduleSystemPersist());
reasoningSelect.addEventListener("change", () => {
  preferredReasoningEffort = reasoningSelect.value;
  persistSetting(STORAGE_KEYS.reasoningEffort, reasoningSelect.value);
});
streamInput.addEventListener("change", () => {
  preferredStream = streamInput.checked;
  persistSetting(STORAGE_KEYS.stream, preferredStream ? "1" : "0");
  updateStreamControl();
});

const appendMessage = (role, text) => {
  const el = createChatMessageElement(document, role, text);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
};

const setBusy = (busy) => {
  chatBusy = busy;
  sendBtn.disabled = busy;
  stopBtn.disabled = !busy;
  promptInput.disabled = busy;
  resetChatBtn.disabled = busy;
  updateStreamControl();
};

let abortController = null;
let conversation = [];
const chatStats = createChatStatsAccumulator();

const recordAndRenderChatStats = (sample) => {
  if (recordCompletedChatResponse(chatStats, sample)) renderChatStats(chatStatsEl, chatStats);
};

resetChatBtn.addEventListener("click", () => {
  if (abortController) abortController.abort();
  abortController = null;
  conversation = [];
  messagesEl.textContent = "";
  resetChatStatsAccumulator(chatStats);
  renderChatStats(chatStatsEl, chatStats);
  setBusy(false);
  promptInput.focus();
});

stopBtn.addEventListener("click", () => {
  if (!abortController) return;
  abortController.abort();
});

const streamSse = async (response, onEvent) => {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const framed = splitChatSseEvents(buffer);
    buffer = framed.remaining;
    for (const rawEvent of framed.events) onEvent(rawEvent);
  }

  buffer += decoder.decode();
  const framed = splitChatSseEvents(buffer, true);
  for (const rawEvent of framed.events) onEvent(rawEvent);
};

const sendPrompt = async () => {
  const token = tokenInput.value.trim();
  if (!token && !localDevelopmentAuth) {
    appendMessage("error", "Sign in with a passkey first, or use the fallback gateway token under Account.");
    passkeyLoginBtn.focus();
    return;
  }

  const text = promptInput.value.trim();
  if (!text) return;

  const systemPrompt = systemInput.value.trim();

  promptInput.value = "";
  conversation.push({ role: "user", content: text });
  appendMessage("user", text);

  const requestMessages = [];
  if (systemPrompt) requestMessages.push({ role: "system", content: systemPrompt });
  requestMessages.push(...conversation);

  const payload = {
    model: modelInput.value.trim() || undefined,
    messages: requestMessages,
    stream: streamInput.checked,
  };

  const reasoningEffort = getReasoningEffortForChatRequest(reasoningSelect.value);
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  if (payload.stream) payload.stream_options = { include_usage: true };
  if (!payload.model) delete payload.model;

  const assistantEl = appendMessage("assistant", "");
  setBusy(true);

  abortController = new AbortController();
  const backendBase = getActiveBackendBase();
  const requestStartedAt = performance.now();
  try {
    const res = await fetch(buildBackendUrl("/v1/chat/completions", backendBase), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const errorPayload = await res.json().catch(() => null);
      assistantEl.dataset.message = "error";
      if (res.status === 401) {
        setChatMessageContent(assistantEl, buildBackendAwareMessage(backendBase, "Auth failed for this chat request."));
      } else {
        setChatMessageContent(assistantEl, errorPayload?.error?.message ?? `${res.status} ${res.statusText}`);
      }
      toast.error("Chat request failed", {
        description: errorPayload?.error?.message ?? `${res.status} ${res.statusText}`,
      });
      return;
    }

    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      const data = await res.json().catch(() => null);
      const messageText = readChatCompletionMessageText(data);
      if (messageText !== null) {
        setChatMessageContent(assistantEl, messageText);
        conversation.push({ role: "assistant", content: messageText });
        recordAndRenderChatStats({
          llmMs: performance.now() - requestStartedAt,
          usage: data?.usage,
        });
      } else {
        setChatMessageContent(assistantEl, JSON.stringify(data, null, 2));
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    let assistantText = "";
    let firstTokenAt = null;
    let responseUsage = null;
    let streamCompleted = false;
    let streamCompletedAt = null;
    let streamFailure = "";
    let pendingStreamFlush = null;
    const flushAssistantText = () => {
      pendingStreamFlush = null;
      if (assistantEl.dataset.streaming === undefined) return;
      setChatMessageContent(assistantEl, assistantText);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    };
    const scheduleStreamFlush = () => {
      if (pendingStreamFlush !== null) return;
      const raf = globalThis.requestAnimationFrame;
      pendingStreamFlush =
        typeof raf === "function" ? raf(flushAssistantText) : globalThis.setTimeout(flushAssistantText, 16);
    };
    assistantEl.dataset.streaming = "";
    await streamSse(res, (rawEvent) => {
      const event = parseChatSseEvent(rawEvent);
      if (event.kind === "done") {
        streamCompleted = true;
        streamCompletedAt ??= performance.now();
        return;
      }
      if (event.kind === "invalid") {
        streamFailure ||= "The response stream returned an invalid event.";
        return;
      }
      if (event.kind === "error") {
        streamFailure ||= event.message;
        return;
      }
      if (event.kind !== "event") return;
      if (event.usage !== undefined) responseUsage = event.usage;
      if (!event.delta) return;
      if (firstTokenAt === null) firstTokenAt = performance.now();
      assistantText += event.delta;
      scheduleStreamFlush();
    });
    flushAssistantText();

    if (streamFailure || !streamCompleted) {
      assistantEl.dataset.message = "error";
      const message = streamFailure || "The response stream ended before completion.";
      setChatMessageContent(assistantEl, assistantText.trim() ? `${assistantText}\n\n[${message}]` : message);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    if (!assistantText.trim()) {
      assistantEl.dataset.message = "error";
      setChatMessageContent(assistantEl, "The response stream completed with no assistant output.");
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    conversation.push({ role: "assistant", content: assistantText });
    const completedAt = streamCompletedAt ?? performance.now();
    recordAndRenderChatStats({
      llmMs: completedAt - requestStartedAt,
      decodeMs: firstTokenAt === null ? undefined : completedAt - firstTokenAt,
      decodeTokens: readChatCompletionDecodeTokens(responseUsage, reasoningEffort),
      ttftMs: firstTokenAt === null ? undefined : firstTokenAt - requestStartedAt,
      usage: responseUsage,
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (error) {
    if (error?.name === "AbortError") {
      assistantEl.dataset.message = "system";
      setChatMessageContent(assistantEl, "[stopped]");
      return;
    }
    assistantEl.dataset.message = "error";
    setChatMessageContent(assistantEl, "Request failed.");
    toast.error("Chat request failed", { description: "Request failed." });
  } finally {
    abortController = null;
    setBusy(false);
    delete assistantEl.dataset.streaming;
    promptInput.focus();
  }
};

promptInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  chatForm.requestSubmit();
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendPrompt();
});

setBusy(false);
promptInput.focus();
