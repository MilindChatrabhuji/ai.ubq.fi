import "./network.js";

const contentEl = document.querySelector("[data-docs-content]");
const statusEl = document.querySelector("[data-docs-status]");
const tocEl = document.querySelector("[data-docs-toc]");
const source = contentEl?.dataset.docsSource;

const copyIcon =
  `<svg data-copy-icon viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<rect x="9" y="9" width="11" height="11" rx="2.5" />` +
  `<path d="M5.5 15H4.5A1.5 1.5 0 0 1 3 13.5v-8A1.5 1.5 0 0 1 4.5 4h8A1.5 1.5 0 0 1 14 5.5v1" />` +
  `</svg>`;
const checkIcon =
  `<svg data-check-icon viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<path d="m5 12.5 4.5 4.5L19 7" />` +
  `</svg>`;
const errorIcon =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<circle cx="12" cy="12" r="9" />` +
  `<path d="M12 7.5V12" />` +
  `<path d="M12 16h.01" />` +
  `</svg>`;

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const escapeAttr = (value) => escapeHtml(value).replaceAll("`", "&#96;");

const sanitizeUrl = (raw) => {
  const trimmed = raw.trim();
  if (!trimmed) return "#";
  if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) return trimmed;
  return "#";
};

const renderLinks = (text) => {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let result = "";
  let lastIndex = 0;
  for (const match of text.matchAll(linkRegex)) {
    const index = match.index ?? 0;
    const label = match[1] ?? "";
    const url = match[2] ?? "";
    result += escapeHtml(text.slice(lastIndex, index));
    result += `<a href="${escapeAttr(sanitizeUrl(url))}" rel="noreferrer">${escapeHtml(label)}</a>`;
    lastIndex = index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
};

const renderInline = (text) => {
  const parts = text.split("`");
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        return `<code>${escapeHtml(part)}</code>`;
      }
      return renderLinks(part);
    })
    .join("");
};

const splitTableRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isTableRow = (line) => /^\s*\|?.*\|.*\|?\s*$/.test(line);

const isTableSeparator = (line) => {
  if (!isTableRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

const renderTable = (headerCells, rows) => {
  const head = headerCells.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("");
  return `<div data-table-scroll tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
};

const renderCodeBlock = (language, code) => {
  const languageClass = language ? ` class="language-${escapeAttr(language)}"` : "";
  return (
    `<div data-code-block>` +
    `<pre data-code tabindex="0"><code${languageClass}>${escapeHtml(code)}</code></pre>` +
    `<button type="button" data-copy-code aria-label="Copy code" data-tooltip="Copy">${copyIcon}${checkIcon}</button>` +
    `</div>`
  );
};

const slugify = (text, counts) => {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  if (count === 1) return base || "section";
  return `${base || "section"}-${count}`;
};

const parseMarkdown = (markdown) => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const toc = [];
  const headingCounts = new Map();
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let paragraph = [];
  let listType = null;
  let listItem = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    if (text) html.push(`<p>${renderInline(text)}</p>`);
    paragraph = [];
  };

  const flushListItem = () => {
    if (listItem === null) return;
    html.push(`<li>${listItem}</li>`);
    listItem = null;
  };

  const closeList = () => {
    if (!listType) return;
    flushListItem();
    html.push(`</${listType}>`);
    listType = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.replace(/\s+$/g, "");
    if (inCode) {
      if (line.startsWith("```")) {
        html.push(renderCodeBlock(codeLang, codeLines.join("\n")));
        inCode = false;
        codeLang = "";
        codeLines = [];
      } else {
        codeLines.push(rawLine);
      }
      continue;
    }

    if (line.startsWith("```")) {
      flushParagraph();
      closeList();
      inCode = true;
      codeLang = line.slice(3).trim();
      codeLines = [];
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const id = slugify(text, headingCounts);
      if (level >= 2) {
        toc.push({ level, text, id });
      }
      html.push(`<h${level} id="${escapeAttr(id)}">${renderInline(text)}</h${level}>`);
      continue;
    }

    const listMatch = line.match(/^\s*(?:([*+-])|(\d+)\.)\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      const type = listMatch[1] ? "ul" : "ol";
      if (listType && listType !== type) {
        closeList();
      }
      if (!listType) {
        listType = type;
        html.push(`<${listType}>`);
      }
      flushListItem();
      const itemText = listMatch[3] ?? "";
      listItem = renderInline(itemText.trim());
      continue;
    }

    if (isTableRow(line) && isTableSeparator(lines[index + 1] ?? "")) {
      flushParagraph();
      closeList();
      const headerCells = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      html.push(renderTable(headerCells, rows));
      continue;
    }

    if (listItem !== null) {
      listItem += ` ${renderInline(line.trim())}`;
      continue;
    }
    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();

  if (inCode) {
    html.push(renderCodeBlock(codeLang, codeLines.join("\n")));
  }

  return { html: html.join("\n"), toc };
};

const renderToc = (toc) => {
  if (!tocEl) return;
  if (!toc.length) {
    tocEl.innerHTML = "<p data-empty>No sections found.</p>";
    return;
  }
  tocEl.innerHTML = toc
    .filter((entry) => entry.level === 2)
    .map((entry) => {
      const label = escapeHtml(entry.text);
      const id = escapeAttr(entry.id);
      return `<a href="#${id}" data-level="${entry.level}">${label}</a>`;
    })
    .join("\n");
};

const setDocsState = (state) => {
  if (!contentEl) return;
  if (state === "ready") {
    delete contentEl.dataset.docsState;
    contentEl.removeAttribute("aria-busy");
    return;
  }
  contentEl.dataset.docsState = state;
  if (state === "loading") {
    contentEl.setAttribute("aria-busy", "true");
  } else {
    contentEl.removeAttribute("aria-busy");
  }
};

const setDocsStatus = (message) => {
  if (statusEl) statusEl.textContent = message;
};

const renderDocsError = (message) => {
  setDocsStatus(message);
  if (!contentEl) return;
  contentEl.innerHTML = `<p data-docs-error>${errorIcon}<span>${escapeHtml(message)}</span></p>`;
  setDocsState("error");
};

const loadDocs = async () => {
  if (!contentEl) return;
  setDocsStatus("Loading docs…");
  setDocsState("loading");
  if (!source) {
    renderDocsError("Missing docs source.");
    return;
  }
  try {
    const res = await fetch(source, { cache: "no-store" });
    if (!res.ok) {
      renderDocsError(`Failed to load docs (${res.status}).`);
      return;
    }
    const text = await res.text();
    const { html, toc } = parseMarkdown(text);
    contentEl.innerHTML = html;
    contentEl.querySelector("h1")?.remove();
    setDocsStatus("");
    setDocsState("ready");
    renderToc(toc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderDocsError(`Failed to load docs (${message}).`);
  }
};

const COPY_FEEDBACK_MS = 1400;
const copyResetTimers = new WeakMap();

const resetCopyFeedback = (button) => {
  delete button.dataset.copied;
  delete button.dataset.copyError;
  button.dataset.tooltip = "Copy";
};

const showCopyFeedback = (button, copied, label) => {
  globalThis.clearTimeout(copyResetTimers.get(button));
  delete button.dataset.copied;
  delete button.dataset.copyError;
  if (copied) {
    button.dataset.copied = "";
  } else {
    button.dataset.copyError = "";
  }
  button.dataset.tooltip = label;
  copyResetTimers.set(
    button,
    globalThis.setTimeout(() => resetCopyFeedback(button), COPY_FEEDBACK_MS)
  );
};

const copyCodeBlock = async (button) => {
  const code = button.closest("[data-code-block]")?.querySelector("pre[data-code] code")?.textContent ?? "";
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showCopyFeedback(button, true, "Copied");
  } catch {
    showCopyFeedback(button, false, "Copy failed");
  }
};

contentEl?.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-copy-code]") : null;
  if (button instanceof HTMLButtonElement) void copyCodeBlock(button);
});

loadDocs();
