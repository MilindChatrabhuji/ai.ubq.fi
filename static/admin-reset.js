// A request belongs to one authenticated target/account, including through capacity rerenders.
const actions = new Map();

export const appendManualResetControl = (header, setting, label, apiUrl, getAdminToken, refresh) => {
  if (!setting) return;
  const target = apiUrl("/admin/providers/codex/banked-resets/consume");
  const token = getAdminToken();
  const key = JSON.stringify([target, token, setting.account_id_hash]);
  let action = actions.get(key);
  if (!action || (action.completedDay && action.completedDay !== new Date().toISOString().slice(0, 10))) {
    action = { busy: false, completedDay: null, message: "", listeners: new Set() };
    actions.set(key, action);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.manualReset = setting.account_id_hash;
  button.textContent = "Use banked reset";
  button.setAttribute("aria-label", "Use banked reset for " + label);
  const status = document.createElement("span");
  status.dataset.manualResetStatus = "";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const current = () => target === apiUrl("/admin/providers/codex/banked-resets/consume") && token === getAdminToken();
  const render = () => {
    button.disabled = action.busy || Boolean(action.completedDay) || setting.available_count === 0;
    button.setAttribute("aria-busy", String(action.busy));
    status.textContent = action.message;
  };
  const notify = () => {
    for (const listener of action.listeners) listener();
  };
  action.listeners.add(render);
  // Detached rows can be replaced while the request is pending; the new row adopts the same action.
  for (const listener of action.listeners)
    if (listener !== render && !header.isConnected) action.listeners.delete(listener);
  button.addEventListener("click", async () => {
    if (action.busy || action.completedDay || !current()) return;
    action.busy = true;
    action.message = "Using banked reset…";
    notify();
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ account_id_hash: setting.account_id_hash }),
      });
      const result = await response.json().catch(() => null);
      if (!current()) return;
      if (!response.ok)
        throw new Error(
          result?.error?.message || "Reset could not be confirmed. Check this account before trying again."
        );
      if (result?.reset_status !== "verified" || result.active_account_id_hash !== setting.account_id_hash) {
        throw new Error("Reset priority could not be confirmed for this account.");
      }
      action.completedDay = new Date().toISOString().slice(0, 10);
      action.message = "Reset verified. Account priority was updated.";
      // Inventory stays authoritative; never subtract a credit optimistically.
      void refresh();
    } catch (error) {
      if (current()) action.message = error instanceof Error ? error.message : "Reset could not be confirmed.";
    } finally {
      action.busy = false;
      if (current()) notify();
    }
  });
  header.append(button, status);
  render();
};
