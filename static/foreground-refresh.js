/**
 * @typedef {EventTarget & { visibilityState?: string }} ForegroundDocumentTarget
 * @typedef {{
 *   windowTarget?: EventTarget,
 *   documentTarget?: ForegroundDocumentTarget,
 *   delayMs?: number,
 * }} ForegroundRefreshOptions
 */

/**
 * @param {() => void} refresh
 * @param {ForegroundRefreshOptions} [options]
 * @returns {() => void}
 */
export const bindForegroundRefresh = (
  refresh,
  { windowTarget = globalThis, documentTarget = globalThis.document, delayMs = 100 } = {}
) => {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /** @param {Event} event */
  const scheduleRefresh = (event) => {
    // The first page load fires `pageshow` too; only a bfcache restore is a resume.
    if (event.type === "pageshow" && !("persisted" in event && event.persisted === true)) return;
    if (documentTarget?.visibilityState === "hidden") return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (documentTarget?.visibilityState === "hidden") return;
      refresh();
    }, delayMs);
  };

  windowTarget.addEventListener("focus", scheduleRefresh);
  windowTarget.addEventListener("pageshow", scheduleRefresh);
  documentTarget?.addEventListener("visibilitychange", scheduleRefresh);

  return () => {
    windowTarget.removeEventListener("focus", scheduleRefresh);
    windowTarget.removeEventListener("pageshow", scheduleRefresh);
    documentTarget?.removeEventListener("visibilitychange", scheduleRefresh);
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
};
