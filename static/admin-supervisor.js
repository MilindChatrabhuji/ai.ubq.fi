// Read-only Codex supervisor view. Mounted by admin.js with the admin helpers it
// already owns; this module never mutates Codex state and never writes storage.

const REFRESH_MS = 15_000;
const FOLLOW_ENTRY_LIMIT = 200;
const STATE_LABELS = {
  active: "Active",
  idle: "Idle",
  stale: "Stale",
  unknown: "Unknown",
  system_error: "System error",
};
const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);

const repoOf = (cwd) => {
  const path = text(cwd);
  if (!path) return null;
  const parts = path.replace(/\/+$/, "").split("/");
  return parts.length > 0 ? parts[parts.length - 1] : null;
};

const formatAge = (timestampMs) => {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  const seconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const formatClock = (timestampMs) =>
  typeof timestampMs === "number" && timestampMs > 0
    ? new Date(timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "unknown";

const formatTokens = (value) => (typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : null);

const formatWindow = (minutes) => {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${Math.round(minutes)}-minute window`;
};

const formatReset = (timestampMs) =>
  typeof timestampMs === "number" && Number.isFinite(timestampMs) && timestampMs > 0
    ? new Date(timestampMs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

const stateLabel = (session) => {
  const base = STATE_LABELS[session.state] ?? "Unknown";
  if (session.state !== "active") return base;
  const flags = [];
  if (session.waitingOnApproval) flags.push("approval");
  if (session.waitingOnUserInput) flags.push("input");
  const unknownFlags = (Array.isArray(session.activeFlags) ? session.activeFlags : []).filter(
    (flag) => !/approval|user.?input|input.?request|needsinput/i.test(flag)
  );
  for (const flag of unknownFlags) flags.push(flag);
  return flags.length > 0 ? `${base} · waiting on ${flags.join(", ")}` : base;
};

const matchesFilters = (session, filters) => {
  if (filters.machine !== "all" && session.sourceId !== filters.machine) return false;
  if (filters.state === "active" && session.state !== "active") return false;
  if (filters.state === "active_idle" && session.state !== "active" && session.state !== "idle") return false;
  const needle = filters.search;
  if (!needle) return true;
  const haystack = [
    session.title,
    session.id,
    session.machine,
    session.cwd,
    session.branch,
    session.model,
    session.effort,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
};

export const createSupervisorView = ({ section, getToken, apiUrl }) => {
  const pick = (id) => section.querySelector(`#${id}`);
  const badge = pick("supervisor-badge");
  const updated = pick("supervisor-updated");
  const summary = pick("supervisor-summary");
  const quota = pick("supervisor-quota");
  const quotaList = pick("supervisor-quota-list");
  const notice = pick("supervisor-notice");
  const empty = pick("supervisor-empty");
  const search = pick("supervisor-search");
  const machineFilter = pick("supervisor-machine");
  const stateFilter = pick("supervisor-state");
  const list = pick("supervisor-list");
  const follow = pick("supervisor-follow");
  const followTitle = pick("supervisor-follow-title");
  const followStatus = pick("supervisor-follow-status");
  const followLog = pick("supervisor-follow-log");
  const followStop = pick("supervisor-follow-stop");
  const brief = pick("supervisor-brief");
  const briefTitle = pick("supervisor-brief-title");
  const briefStatus = pick("supervisor-brief-status");
  const briefBody = pick("supervisor-brief-body");
  const briefAbout = pick("supervisor-brief-about");
  const briefState = pick("supervisor-brief-state");
  const briefClose = pick("supervisor-brief-close");
  if (!badge || !updated || !summary || !notice || !empty || !search || !machineFilter || !stateFilter || !list) {
    return { setActive: () => {} };
  }

  // Upstream provider strip: the same registry the Providers tab manages,
  // rendered here so the supervisor panel reports what the gateway can dispatch
  // to without switching tabs. Read-only, best effort, and never cached.
  const providersCard = document.createElement("article");
  providersCard.dataset.card = "";
  providersCard.id = "supervisor-providers-card";
  const providersHeader = document.createElement("header");
  const providersEyebrow = document.createElement("span");
  providersEyebrow.dataset.adminEyebrow = "";
  providersEyebrow.textContent = "Read-only observation";
  const providersTitle = document.createElement("h2");
  providersTitle.id = "card-supervisor-providers";
  providersTitle.textContent = "Upstream providers";
  const providersNote = document.createElement("p");
  providersNote.textContent =
    "Health and activation of every gateway upstream, read from the same registry the Providers tab manages.";
  providersHeader.append(providersEyebrow, providersTitle, providersNote);
  const providersBody = document.createElement("div");
  providersBody.dataset.cardBody = "";
  const providersList = document.createElement("div");
  providersList.dataset.providerList = "";
  providersList.setAttribute("role", "list");
  providersBody.append(providersList);
  providersCard.setAttribute("aria-labelledby", providersTitle.id);
  providersCard.append(providersHeader, providersBody);
  section.append(providersCard);

  const providerStateLabel = (health) => {
    const state = typeof health?.state === "string" && health.state ? health.state : "unknown";
    return health?.stale === true ? `${state} · stale` : state;
  };

  const renderProviders = (selection, healthSnapshot) => {
    const entries = Array.isArray(selection?.data?.providers) ? selection.data.providers : [];
    if (entries.length === 0) return;
    const rows = entries.map((entry) => {
      const health =
        typeof entry?.health_key === "string" && entry.health_key ? healthSnapshot?.[entry.health_key] : null;
      const configured = health ? health.configured !== false : entry.configured === true;
      const state = health ? (typeof health.state === "string" ? health.state : health.health?.state) : null;
      const row = document.createElement("div");
      row.dataset.providerEntry = "";
      row.dataset.providerId = entry.id;
      row.setAttribute("role", "listitem");
      const body = document.createElement("span");
      body.dataset.providerBody = "";
      const name = document.createElement("span");
      name.dataset.providerName = "";
      name.textContent = entry.label ?? entry.id;
      const badges = document.createElement("span");
      badges.dataset.providerBadges = "";
      const tier = document.createElement("span");
      tier.dataset.providerTierBadge = entry.tier;
      tier.textContent = entry.tier_label ?? entry.tier;
      const badge = document.createElement("span");
      badge.dataset.providerHealthBadge = configured ? (state ?? "unknown") : "unknown";
      badge.textContent = configured
        ? `Health ${providerStateLabel({ state: state ?? "unknown", stale: health?.health?.stale === true })}`
        : "Not configured";
      badges.append(tier, badge);
      body.append(name, badges);
      const detail = document.createElement("span");
      detail.dataset.providerDetail = "";
      detail.textContent = entry.detail ?? "";
      const meta = document.createElement("span");
      meta.dataset.providerMeta = "";
      const facts = [`${entry.model_count ?? 0} catalog models`, (entry.endpoints ?? []).join(" · ")];
      meta.textContent = facts.filter((fact) => fact !== "").join(" · ");
      body.append(detail, meta);
      row.append(body);
      return row;
    });
    providersList.replaceChildren(...rows);
  };

  const markProvidersUnavailable = () => {
    providersList.textContent = "Provider health unavailable; previous observations cleared.";
  };

  const loadProviders = async () => {
    if (!active) return;
    const token = typeof getToken === "function" ? getToken() : "";
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const [selectionResponse, healthResponse] = await Promise.all([
        fetch(apiUrl("/admin/providers/selection"), { headers, credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/admin/providers"), { headers, credentials: "include", cache: "no-store" }),
      ]);
      const selection = selectionResponse.ok ? await selectionResponse.json().catch(() => null) : null;
      const healthSnapshot = healthResponse.ok ? await healthResponse.json().catch(() => null) : null;
      if (selection && healthSnapshot) renderProviders(selection, healthSnapshot);
      else markProvidersUnavailable();
    } catch {
      markProvidersUnavailable();
    }
  };

  let active = false;
  let timer = 0;
  let controller = null;
  let snapshot = null;
  const rows = new Map();
  const filters = { search: "", machine: "all", state: "active" };

  let followController = null;
  let followKey = null;
  let followTurnStatus = null;
  let followSeen = new Map();

  let briefController = null;
  let briefKey = null;

  /** Writes text only when it changed, so a background refresh never repaints identical rows. */
  const setText = (element, value) => {
    if (element && element.textContent !== value) element.textContent = value;
  };

  const setBadge = (state, label) => {
    badge.dataset.state = state;
    setText(badge, label);
  };

  const setNotice = (lines) => {
    notice.textContent = "";
    if (lines.length === 0) {
      notice.hidden = true;
      return;
    }
    notice.hidden = false;
    for (const line of lines) {
      const item = document.createElement("p");
      item.dataset.tone = "warning";
      item.textContent = line;
      notice.append(item);
    }
  };

  const updateSummary = () => {
    if (!snapshot) return;
    const counts = snapshot.counts ?? {};
    const repos = new Set(snapshot.sessions.map((session) => repoOf(session.cwd)).filter((repo) => repo !== null));
    const parts = [
      `${counts.total ?? 0} sessions`,
      `${repos.size} ${repos.size === 1 ? "repo" : "repos"}`,
      `${snapshot.sources.length} ${snapshot.sources.length === 1 ? "machine" : "machines"}`,
      `${counts.active ?? 0} active`,
      `${counts.waiting ?? 0} waiting`,
      `${counts.idle ?? 0} idle`,
    ];
    if ((counts.stale ?? 0) > 0) parts.push(`${counts.stale} stale`);
    if ((counts.unknown ?? 0) > 0) parts.push(`${counts.unknown} unknown`);
    if ((counts.systemError ?? 0) > 0) parts.push(`${counts.systemError} system error`);
    summary.textContent = parts.join(" · ");
  };

  const updateFilters = () => {
    if (!snapshot) return;
    const options = new Set(snapshot.sources.map((source) => source.id));
    for (const option of [...machineFilter.options]) {
      if (option.value !== "all" && !options.has(option.value)) option.remove();
    }
    for (const source of snapshot.sources) {
      if (![...machineFilter.options].some((option) => option.value === source.id)) {
        const option = document.createElement("option");
        option.value = source.id;
        option.textContent = source.name;
        machineFilter.append(option);
      }
    }
    if (filters.machine !== "all" && !options.has(filters.machine)) {
      filters.machine = "all";
      machineFilter.value = "all";
    }
  };

  const updateNotice = () => {
    if (!snapshot) return;
    const lines = [];
    for (const source of snapshot.sources) {
      if (source.state === "unavailable") {
        lines.push(
          `${source.name} is unavailable: ${
            source.reason ?? "unknown reason"
          }. Its rows below are persisted metadata, not live state.`
        );
      } else if (source.kind === "local" && source.metadata && source.metadata.available === false) {
        lines.push(
          `${source.name}: persisted branch and token usage are unavailable (${
            source.metadata.reason ?? "metadata unavailable"
          }); other fields still come from its live session list.`
        );
      }
    }
    for (const note of snapshot.coverage?.notes ?? []) lines.push(note);
    setNotice(lines);
  };

  // The account quota is one shared window: every machine reports the same
  // account-wide reading, so rows are shown per reporting machine and never summed.
  const renderQuota = () => {
    if (!quota || !quotaList) return;
    quotaList.textContent = "";
    const lines = [];
    for (const source of snapshot?.sources ?? []) {
      const buckets = Array.isArray(source.quota?.buckets) ? source.quota.buckets : [];
      for (const bucket of buckets) {
        const parts = [
          typeof bucket.usedPercent === "number" ? `${Math.round(bucket.usedPercent)}% used` : "usage unavailable",
        ];
        const window = formatWindow(bucket.windowDurationMins);
        if (window) parts.push(`of a ${window}`);
        const reset = formatReset(bucket.resetsAtMs);
        if (reset) parts.push(`· resets ${reset}`);
        if (typeof source.quota?.resetCreditsAvailable === "number" && source.quota.resetCreditsAvailable > 0) {
          parts.push(
            `· ${source.quota.resetCreditsAvailable} reset credit${source.quota.resetCreditsAvailable === 1 ? "" : "s"}`
          );
        }
        lines.push(`${source.name} · ${parts.join(" ")}`);
      }
    }
    quota.hidden = lines.length === 0;
    for (const line of lines) {
      const item = document.createElement("p");
      item.textContent = line;
      quotaList.append(item);
    }
  };

  // One flat row per session. The summary is the overview - status, title, machine,
  // repository, age - and the disclosed body holds the diagnostics and the actions.
  // The summary is phrasing content only, as the element requires.
  const buildRow = (key) => {
    const row = document.createElement("article");
    row.dataset.key = "supervisor-session";
    row.dataset.sessionKey = key;
    row.setAttribute("role", "listitem");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const head = document.createElement("span");
    head.dataset.supervisorOverview = "head";
    const title = document.createElement("strong");
    title.dataset.role = "supervisor-title";
    const machine = document.createElement("span");
    machine.dataset.muted = "";
    machine.dataset.role = "supervisor-machine";
    head.append(title, machine);
    const meta = document.createElement("span");
    meta.dataset.supervisorOverview = "meta";
    for (const role of ["state", "place", "activity"]) {
      const item = document.createElement("span");
      item.dataset.role = `supervisor-${role}`;
      meta.append(item);
    }
    summary.append(head, meta);
    const body = document.createElement("div");
    body.dataset.supervisorDisclosure = "";
    const path = document.createElement("code");
    path.dataset.role = "supervisor-path";
    const facts = document.createElement("div");
    facts.dataset.supervisorFacts = "";
    for (const role of ["model", "tokens", "sampled"]) {
      const item = document.createElement("span");
      item.dataset.role = `supervisor-${role}`;
      facts.append(item);
    }
    const actions = document.createElement("div");
    actions.dataset.layout = "row";
    const id = document.createElement("code");
    id.dataset.role = "supervisor-id";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.dataset.action = "copy-id";
    copy.textContent = "Copy ID";
    const followButton = document.createElement("button");
    followButton.type = "button";
    followButton.dataset.action = "follow";
    followButton.textContent = "Follow output";
    const briefButton = document.createElement("button");
    briefButton.type = "button";
    briefButton.dataset.action = "brief";
    briefButton.textContent = "Catch me up";
    actions.append(id, copy, followButton, briefButton);
    body.append(path, facts, actions);
    details.append(summary, body);
    row.append(details);
    return row;
  };

  const fillRow = (row, session) => {
    row.dataset.state = session.state;
    row.dataset.source = session.sourceId;
    row.dataset.sessionId = session.id;
    const title = row.querySelector('[data-role="supervisor-title"]');
    const machine = row.querySelector('[data-role="supervisor-machine"]');
    const state = row.querySelector('[data-role="supervisor-state"]');
    const place = row.querySelector('[data-role="supervisor-place"]');
    const path = row.querySelector('[data-role="supervisor-path"]');
    const model = row.querySelector('[data-role="supervisor-model"]');
    const activity = row.querySelector('[data-role="supervisor-activity"]');
    const sampled = row.querySelector('[data-role="supervisor-sampled"]');
    const tokens = row.querySelector('[data-role="supervisor-tokens"]');
    const id = row.querySelector('[data-role="supervisor-id"]');
    if (title) setText(title, text(session.title) ?? "(untitled session)");
    if (machine) setText(machine, `${session.machine}${session.sampled === false ? " · not sampled" : ""}`);
    if (state) {
      state.dataset.state = session.state;
      state.dataset.waiting = session.waitingOnApproval || session.waitingOnUserInput ? "true" : "false";
      setText(state, stateLabel(session));
    }
    if (place) {
      const repo = repoOf(session.cwd);
      const bits = [repo, session.branch].filter((value) => typeof value === "string" && value.length > 0);
      setText(place, bits.length > 0 ? bits.join(" · ") : "repository unknown");
    }
    if (path) setText(path, text(session.cwd) ?? "cwd unavailable");
    if (model) {
      const bits = [session.model, session.effort, session.sourceKind].filter(
        (value) => typeof value === "string" && value.length > 0
      );
      setText(model, bits.length > 0 ? bits.join(" · ") : "model unavailable");
    }
    // The summary carries the age alone; the status pill already names the state.
    if (activity) setText(activity, formatAge(session.lastActivityAtMs) ?? "no recorded activity");
    if (sampled) setText(sampled, `sampled ${formatClock(session.lastSampledAtMs)}`);
    if (tokens) {
      const formatted = formatTokens(session.tokensUsed);
      setText(tokens, formatted ? `${formatted} tokens (persisted)` : "tokens unavailable");
    }
    if (id) {
      setText(id, session.id);
      id.title = session.id;
    }
    const followButton = row.querySelector('[data-action="follow"]');
    if (followButton) {
      const following = followKey === row.dataset.sessionKey;
      setText(followButton, following ? "Stop following" : "Follow output");
      followButton.setAttribute("aria-pressed", following ? "true" : "false");
    }
    const briefButton = row.querySelector('[data-action="brief"]');
    if (briefButton) {
      const loading = briefKey === row.dataset.sessionKey && briefController !== null;
      setText(briefButton, loading ? "Reading logs…" : "Catch me up");
      briefButton.disabled = loading;
      briefButton.setAttribute("aria-busy", loading ? "true" : "false");
    }
    if (Array.isArray(session.unavailable) && session.unavailable.length > 0) {
      row.title = session.unavailable.join("; ");
    } else {
      row.removeAttribute("title");
    }
  };

  const visibleSessions = () =>
    snapshot ? snapshot.sessions.filter((session) => matchesFilters(session, filters)) : [];

  const render = () => {
    const sessions = visibleSessions();
    const wanted = new Set();
    for (const session of sessions) {
      const key = `${session.sourceId}:${session.id}`;
      wanted.add(key);
      let row = rows.get(key);
      if (!row) {
        row = buildRow(key);
        rows.set(key, row);
        // New sessions append in place; existing rows keep their position so a
        // server-side activity reorder never moves a card the operator is reading.
        list.append(row);
      }
      fillRow(row, session);
    }
    for (const [key, row] of rows) {
      if (wanted.has(key)) continue;
      row.remove();
      rows.delete(key);
    }
    empty.hidden = sessions.length > 0;
    if (sessions.length === 0) {
      empty.textContent = snapshot
        ? filters.search
          ? "No session matches the current search."
          : "No session matches the current filters."
        : "Waiting for the first sample.";
    }
  };

  const stopFollow = (message) => {
    if (followController) followController.abort();
    followController = null;
    followKey = null;
    followTurnStatus = null;
    followSeen = new Map();
    if (follow) follow.hidden = true;
    if (followLog) followLog.textContent = "";
    if (followStatus && message) followStatus.textContent = message;
    render();
  };

  const setFollowStatus = (message, tone) => {
    if (!followStatus) return;
    followStatus.textContent = message;
    followStatus.dataset.state = tone ?? "ok";
  };

  const fillFollowEntry = (wrapper, entry) => {
    wrapper.dataset.followEntry = entry.kind === "command" ? "command" : "message";
    wrapper.textContent = "";
    if (entry.kind === "command") {
      const command = document.createElement("code");
      command.textContent = text(entry.command) ?? "(command unavailable)";
      const output = document.createElement("pre");
      output.textContent = text(entry.text) ?? "(no recorded output yet)";
      const meta = document.createElement("span");
      meta.dataset.muted = "";
      const exit = typeof entry.exitCode === "number" ? ` · exit ${entry.exitCode}` : "";
      meta.textContent = `command ${text(entry.status) ?? "recorded"}${exit}`;
      wrapper.append(command, output, meta);
      return;
    }
    const meta = document.createElement("span");
    meta.dataset.muted = "";
    meta.textContent = entry.status === "final_answer" ? "Assistant · final" : "Assistant";
    const body = document.createElement("p");
    body.textContent = text(entry.text) ?? "";
    wrapper.append(meta, body);
  };

  const appendEntries = (payload) => {
    if (!followLog || !payload || !Array.isArray(payload.entries)) return;
    // Follow output keeps its own 2s cadence. Only auto-scroll when the
    // operator has not scrolled away from the newest recorded output.
    const stickToBottom = followLog.scrollHeight - followLog.scrollTop - followLog.clientHeight < 40;
    followTurnStatus = text(payload.turnStatus) ?? followTurnStatus;
    for (const entry of payload.entries) {
      const key = text(entry.key);
      if (!key) continue;
      const revision = text(entry.revision) ?? "";
      const existing = followSeen.get(key);
      if (existing) {
        // Keep evicted keys as tombstones: the server can re-emit a changed
        // entry below the cursor, but it must not re-enter the retained window.
        if (existing.evicted) continue;
        // The same item index can gain command output, status and an exit code
        // later; update the rendered entry in place instead of appending.
        if (existing.revision === revision) continue;
        existing.revision = revision;
        fillFollowEntry(existing.node, entry);
        continue;
      }
      const wrapper = document.createElement("div");
      wrapper.dataset.followKey = key;
      fillFollowEntry(wrapper, entry);
      followSeen.set(key, { node: wrapper, revision, evicted: false });
      followLog.append(wrapper);
    }
    while (followLog.childElementCount > FOLLOW_ENTRY_LIMIT) {
      const oldest = followLog.firstElementChild;
      if (!oldest) break;
      const trimmedKey = oldest.dataset.followKey;
      if (trimmedKey) {
        const trimmed = followSeen.get(trimmedKey);
        if (trimmed) {
          trimmed.evicted = true;
          trimmed.node = null;
        }
      }
      oldest.remove();
    }
    const age = formatClock(payload.sampledAtMs);
    const turn = followTurnStatus ? `turn ${followTurnStatus}` : "turn status unknown";
    setFollowStatus(
      `Recorded output · ${turn} · updated ${age}. Updates as Codex records output, not a token-level stream.`,
      "ok"
    );
    if (stickToBottom) followLog.scrollTop = followLog.scrollHeight;
  };

  const handleFrame = (frame) => {
    let event = "message";
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "ready") setFollowStatus(text(payload?.note) ?? "Following recorded output.", "ok");
    else if (event === "entries") appendEntries(payload);
    else if (event === "heartbeat") {
      const turn = text(payload?.turnStatus);
      setFollowStatus(`Waiting for Codex to record new output${turn ? ` (turn ${turn})` : ""}…`, "ok");
    } else if (event === "unavailable") {
      setFollowStatus(`Output temporarily unavailable: ${text(payload?.message) ?? "read failed"}`, "warning");
    } else if (event === "end") {
      setFollowStatus(`Follow ended: ${text(payload?.reason) ?? "stream closed"}.`, "warning");
    }
  };

  const startFollow = async (session) => {
    stopFollow();
    const key = `${session.sourceId}:${session.id}`;
    followKey = key;
    followSeen = new Map();
    followTurnStatus = null;
    if (follow) follow.hidden = false;
    if (followLog) followLog.textContent = "";
    if (followTitle) followTitle.textContent = `${session.machine} · ${text(session.title) ?? session.id}`;
    setFollowStatus("Connecting to recorded output…", "ok");
    const request = new AbortController();
    followController = request;
    const params = new URLSearchParams({ source: session.sourceId, id: session.id });
    const token = typeof getToken === "function" ? getToken() : "";
    try {
      const response = await fetch(apiUrl(`/admin/codex/supervisor/output?${params.toString()}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
        cache: "no-store",
        signal: request.signal,
      });
      // Every effect below is fenced to this request. Switching sessions aborts
      // this controller and installs another one, so a late response, frame, or
      // rejection must never report against or clear the new session's follow.
      if (followController !== request) return;
      if (!response.ok || !response.body) {
        setFollowStatus(`Follow unavailable: HTTP ${response.status}.`, "warning");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (followController !== request) return;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) handleFrame(frame);
      }
      if (followController !== request) return;
      followKey = null;
      followController = null;
      render();
      setFollowStatus("Follow stream closed. Select the session again to resume recorded output.", "warning");
    } catch (error) {
      if (followController !== request) return;
      if (!request.signal.aborted) {
        setFollowStatus(`Follow stopped: ${error instanceof Error ? error.message : "connection failed"}`, "warning");
      }
      followController = null;
    }
  };

  const setBriefStatus = (message, tone) => {
    if (!briefStatus) return;
    briefStatus.textContent = message;
    briefStatus.dataset.state = tone ?? "ok";
  };

  const stopBrief = (message) => {
    if (briefController) briefController.abort();
    briefController = null;
    briefKey = null;
    if (brief) brief.hidden = true;
    if (briefBody) briefBody.hidden = true;
    if (briefStatus && message) briefStatus.textContent = message;
    render();
  };

  const renderBrief = (session, payload) => {
    if (briefTitle) briefTitle.textContent = `${session.machine} · ${text(session.title) ?? session.id}`;
    if (briefAbout) briefAbout.textContent = text(payload?.about) ?? "";
    if (briefState) briefState.textContent = text(payload?.status) ?? "";
    if (briefBody) briefBody.hidden = false;
    const transcript = payload?.transcript ?? {};
    const notes = [`logs sampled ${formatClock(payload?.sampledAtMs)}`, `brief ${formatClock(payload?.generatedAtMs)}`];
    if (transcript.truncated) notes.push("log truncated to the bounded context");
    if (typeof transcript.redactions === "number" && transcript.redactions > 0) {
      notes.push(`${transcript.redactions} secret${transcript.redactions === 1 ? "" : "s"} redacted`);
    }
    if (transcript.available === false) notes.push("no recorded transcript was available");
    setBriefStatus(notes.join(" · "), "ok");
  };

  const startBrief = async (session) => {
    const key = `${session.sourceId}:${session.id}`;
    // A second click while the same brief is loading is ignored; a click on a
    // different session replaces the in-flight one.
    if (briefController && briefKey === key) return;
    if (briefController) briefController.abort();
    const request = new AbortController();
    briefController = request;
    briefKey = key;
    if (brief) brief.hidden = false;
    if (briefBody) briefBody.hidden = true;
    if (briefTitle) briefTitle.textContent = `${session.machine} · ${text(session.title) ?? session.id}`;
    setBriefStatus("Reading this session's recorded logs…", "ok");
    render();
    const token = typeof getToken === "function" ? getToken() : "";
    try {
      const response = await fetch(apiUrl("/admin/codex/supervisor/brief"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: "include",
        cache: "no-store",
        signal: request.signal,
        body: JSON.stringify({ source: session.sourceId, id: session.id }),
      });
      const payload = await response.json().catch(() => null);
      if (briefController !== request) return;
      if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      renderBrief(session, payload);
      briefController = null;
    } catch (error) {
      if (briefController !== request) return;
      setBriefStatus(`Brief unavailable: ${error instanceof Error ? error.message : "request failed"}`, "warning");
      briefController = null;
    } finally {
      if (briefController === request) briefController = null;
      render();
    }
  };

  const load = async () => {
    if (!active) return;
    void loadProviders();
    if (controller) controller.abort();
    const request = new AbortController();
    controller = request;
    const token = typeof getToken === "function" ? getToken() : "";
    try {
      const response = await fetch(apiUrl("/admin/codex/supervisor/sessions"), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
        cache: "no-store",
        signal: request.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      if (controller === request) controller = null;
      snapshot = payload;
      updateSummary();
      updateFilters();
      updateNotice();
      renderQuota();
      render();
      setBadge("ok", `Sampled ${formatClock(snapshot.sampledAtMs)}`);
      setText(
        updated,
        `Last sampled ${formatClock(snapshot.sampledAtMs)} · refreshes every 15s while this tab is visible`
      );
      if (followKey && !snapshot.sessions.some((session) => `${session.sourceId}:${session.id}` === followKey)) {
        stopFollow("Selected session left the sampled inventory.");
      }
    } catch (error) {
      if (request.signal.aborted) return;
      if (controller === request) controller = null;
      const message = error instanceof Error ? error.message : "refresh failed";
      setBadge("warning", snapshot ? "Stale · refresh failed" : "Unavailable");
      updated.textContent = snapshot
        ? `Showing the last good sample from ${formatClock(snapshot.sampledAtMs)} · ${message}`
        : `Supervisor inventory unavailable: ${message}`;
      if (!snapshot) {
        render();
        empty.textContent = "Supervisor inventory is unavailable.";
      }
    }
  };

  const tick = () => {
    if (!active) return;
    if (section.hidden) {
      setActive(false);
      return;
    }
    if (document.hidden) {
      if (controller) controller.abort();
      controller = null;
      stopFollow("Follow stopped while the tab was hidden.");
      return;
    }
    void load();
  };

  const onListClick = (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
    if (!button) return;
    const row = button.closest("[data-session-key]");
    if (!row) return;
    const key = row.dataset.sessionKey;
    const id = row.dataset.sessionId;
    const sourceId = row.dataset.source;
    if (!key || !id || !sourceId) return;
    if (button.dataset.action === "copy-id") {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") {
        button.textContent = "Copy unavailable";
        return;
      }
      clipboard.writeText(id).then(
        () => {
          button.textContent = "Copied";
          setTimeout(() => {
            button.textContent = "Copy ID";
          }, 1_500);
        },
        () => {
          button.textContent = "Copy failed";
        }
      );
      return;
    }
    if (button.dataset.action === "follow") {
      if (followKey === key) {
        stopFollow("Follow stopped.");
        return;
      }
      const session = snapshot?.sessions.find((entry) => `${entry.sourceId}:${entry.id}` === key && entry.id === id);
      if (session) void startFollow(session);
      return;
    }
    if (button.dataset.action === "brief") {
      const session = snapshot?.sessions.find((entry) => `${entry.sourceId}:${entry.id}` === key && entry.id === id);
      if (session) void startBrief(session);
    }
  };

  const onVisibility = () => {
    if (!active) return;
    if (document.hidden) stopFollow("Follow stopped while the tab was hidden.");
    else void load();
  };

  const onSearch = () => {
    filters.search = search.value.trim().toLowerCase();
    render();
  };
  const onMachine = () => {
    filters.machine = machineFilter.value;
    render();
  };
  const onState = () => {
    filters.state = stateFilter.value;
    render();
  };

  search.addEventListener("input", onSearch);
  machineFilter.addEventListener("change", onMachine);
  stateFilter.addEventListener("change", onState);
  list.addEventListener("click", onListClick);
  document.addEventListener("visibilitychange", onVisibility);
  if (followStop) {
    followStop.addEventListener("click", () => stopFollow("Follow stopped."));
  }
  if (briefClose) {
    briefClose.addEventListener("click", () => stopBrief());
  }

  const setActive = (next) => {
    const wanted = next === true;
    if (wanted === active) return;
    active = wanted;
    if (!active) {
      if (timer) globalThis.clearInterval(timer);
      timer = 0;
      if (controller) controller.abort();
      controller = null;
      stopFollow();
      return;
    }
    void load();
    timer = globalThis.setInterval(tick, REFRESH_MS);
  };

  return { setActive };
};
