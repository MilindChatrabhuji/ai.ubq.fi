import "./network.js";

/**
 * @typedef {{ dataset: { state?: string }, textContent: string | null }} HealthBadge
 * @typedef {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} HealthFetcher
 */

/** @returns {HealthBadge | null} */
const getBadge = () => (typeof document === "undefined" ? null : document.getElementById("status-badge"));

/**
 * @param {Pick<Response, "ok"> | null | undefined} response
 * @param {Record<string, unknown> | null | undefined} data
 */
const isHealthAvailable = (response, data) => Boolean(response?.ok && data?.status === "available");

/**
 * @param {HealthBadge | null | undefined} badge
 * @param {string} state
 * @param {string} text
 */
const setBadge = (badge, state, text) => {
  if (!badge) return;
  badge.dataset.state = state;
  badge.textContent = text;
};

/**
 * @param {HealthFetcher} [fetcher]
 * @param {HealthBadge | null} [badge]
 * @returns {Promise<void>}
 */
const refreshHealthBadge = async (fetcher = globalThis.fetch, badge = getBadge()) => {
  const actualFetcher = typeof fetcher === "function" ? fetcher : globalThis.fetch;
  try {
    const response = await actualFetcher("/health", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    const available = isHealthAvailable(response, data);
    setBadge(badge, available ? "ok" : "bad", available ? "OK" : "Degraded");
  } catch {
    setBadge(badge, "bad", "Offline");
  }
};

export { isHealthAvailable, refreshHealthBadge };

if (typeof document !== "undefined") {
  await refreshHealthBadge();
}
