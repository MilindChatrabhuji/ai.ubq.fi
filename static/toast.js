// Minimal Sonner-style toast singleton for the vanilla static UI.
// The app has no framework and no build step, so this module owns a single
// lazily mounted [data-toaster] container and only the behaviors this UI
// actually needs: stacking, auto-dismiss with pause-on-hover, manual dismiss,
// and idempotent updates. Styling lives in static/style.css.

const TOASTER_ATTR = "data-toaster";
const DURATION_BY_TYPE = {
  success: 3500,
  info: 4000,
  error: 6000,
};
const MAX_VISIBLE = 3;
// The shared exit fade is `--duration-fast` (140ms in static/style.css); removal waits one
// frame longer so the fade is never cut short or left as an invisible node in the stack.
const EXIT_MS = 160;

let toaster = null;
let nextToastId = 1;

const ensureToaster = () => {
  if (toaster?.isConnected) return toaster;
  toaster = document.createElement("div");
  toaster.setAttribute(TOASTER_ATTR, "");
  toaster.setAttribute("aria-live", "polite");
  document.body.appendChild(toaster);
  return toaster;
};

const removeToastEl = (toastEl) => {
  if (toastEl.isConnected) toastEl.remove();
};

const dismissToastEl = (toastEl, onDismiss) => {
  if (toastEl.dataset.exiting !== undefined) return;
  toastEl.dataset.exiting = "";
  globalThis.setTimeout(() => removeToastEl(toastEl), EXIT_MS);
  onDismiss?.();
};

const SVG_NS = "http://www.w3.org/2000/svg";

// Inline currentColor glyph in the shared 1.7 stroke family. The close button keeps its
// aria-label, so the icon stays decorative for assistive technology.
const closeGlyph = () => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M6 6 18 18M18 6 6 18");
  svg.append(path);
  return svg;
};

const showToast = (options = {}) => {
  const type = options.type === "success" || options.type === "error" ? options.type : "info";
  const title = typeof options.title === "string" ? options.title : "";
  const description = typeof options.description === "string" ? options.description : "";
  const duration = Number.isFinite(options.duration) ? Math.max(0, options.duration) : DURATION_BY_TYPE[type];

  const host = ensureToaster();
  const toastEl = document.createElement("div");
  toastEl.setAttribute("data-toast", "");
  toastEl.setAttribute("data-type", type);

  const titleEl = document.createElement("div");
  titleEl.setAttribute("data-toast-title", "");
  titleEl.textContent = title;
  toastEl.appendChild(titleEl);

  if (description) {
    const descriptionEl = document.createElement("div");
    descriptionEl.setAttribute("data-toast-desc", "");
    descriptionEl.textContent = description;
    toastEl.appendChild(descriptionEl);
  }

  const closeEl = document.createElement("button");
  closeEl.type = "button";
  closeEl.setAttribute("data-toast-close", "");
  closeEl.setAttribute("aria-label", "Dismiss notification");
  closeEl.append(closeGlyph());
  closeEl.addEventListener("click", () => dismissToastEl(toastEl, options.onDismiss));
  toastEl.appendChild(closeEl);

  host.appendChild(toastEl);
  while (host.querySelectorAll("[data-toast]:not([data-exiting])").length > MAX_VISIBLE) {
    const oldest = host.querySelector("[data-toast]:not([data-exiting])");
    if (oldest === toastEl) break;
    dismissToastEl(oldest, null);
  }

  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === "function") {
    raf(() => (toastEl.dataset.visible = ""));
  } else {
    globalThis.setTimeout(() => (toastEl.dataset.visible = ""), 0);
  }

  let timerId = 0;
  let deadline = 0;
  let remaining = 0;
  const clearTimer = () => {
    if (timerId) {
      globalThis.clearTimeout(timerId);
      timerId = 0;
    }
  };
  const startTimer = (remaining) => {
    clearTimer();
    deadline = Date.now() + remaining;
    timerId = globalThis.setTimeout(() => dismissToastEl(toastEl, options.onDismiss), remaining);
  };
  toastEl.addEventListener("mouseenter", () => {
    if (!Number.isFinite(duration) || duration <= 0) return;
    remaining = Math.max(0, deadline - Date.now());
    clearTimer();
  });
  toastEl.addEventListener("mouseleave", () => {
    if (!Number.isFinite(duration) || duration <= 0) return;
    startTimer(remaining);
  });
  if (Number.isFinite(duration) && duration > 0) startTimer(duration);

  return {
    id: nextToastId++,
    update: (next = {}) => {
      if (typeof next.type === "string" && (next.type === "success" || next.type === "error" || next.type === "info")) {
        toastEl.dataset.type = next.type;
      }
      if (typeof next.title === "string") titleEl.textContent = next.title;
      if (typeof next.description === "string") {
        if (next.description) {
          const existing = toastEl.querySelector("[data-toast-desc]");
          if (existing) {
            existing.textContent = next.description;
          } else {
            const descriptionEl = document.createElement("div");
            descriptionEl.setAttribute("data-toast-desc", "");
            descriptionEl.textContent = next.description;
            toastEl.insertBefore(descriptionEl, closeEl);
          }
        }
      }
      return this;
    },
    dismiss: () => dismissToastEl(toastEl, options.onDismiss),
  };
};

const toast = (options) => showToast(options);

toast.success = (title, options = {}) => showToast({ ...options, type: "success", title });
toast.error = (title, options = {}) => showToast({ ...options, type: "error", title });
toast.info = (title, options = {}) => showToast({ ...options, type: "info", title });
toast.loading = (title, options = {}) => showToast({ ...options, type: "info", title, duration: 0 });

toast.dismiss = (handle) => handle?.dismiss?.();
toast.dismissAll = () => {
  if (!toaster?.isConnected) return;
  for (const toastEl of [...toaster.querySelectorAll("[data-toast]")]) dismissToastEl(toastEl, null);
};

export { toast };
