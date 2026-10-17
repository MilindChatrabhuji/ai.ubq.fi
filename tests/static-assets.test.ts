import { readFileSync } from "node:fs";
import { test } from "bun:test";
import assert from "node:assert/strict";

import handler from "../src/handler/index.ts";
import { corsHeaders } from "../src/http.ts";
import { handleRoot, handleStaticAsset, hasStaticAsset } from "../src/static.ts";
const readmeText = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const adminCss = readFileSync(new URL("../static/admin.css", import.meta.url), "utf8");
const adminCacheScript = readFileSync(new URL("../static/admin-cache.js", import.meta.url), "utf8");
const adminHtml = readFileSync(new URL("../static/admin.html", import.meta.url), "utf8");
const aboutHtml = readFileSync(new URL("../static/about.html", import.meta.url), "utf8");
const adminScript = readFileSync(new URL("../static/admin.js", import.meta.url), "utf8");
const authScript = readFileSync(new URL("../static/auth.js", import.meta.url), "utf8");
const chatCss = readFileSync(new URL("../static/chat.css", import.meta.url), "utf8");
const chatHtml = readFileSync(new URL("../static/chat.html", import.meta.url), "utf8");
const chatScript = readFileSync(new URL("../static/chat.js", import.meta.url), "utf8");
const companyLogoSvg = readFileSync(new URL("../static/company-logo.svg", import.meta.url), "utf8");
const contactHtml = readFileSync(new URL("../static/contact.html", import.meta.url), "utf8");
const developersHtml = readFileSync(new URL("../static/developers.html", import.meta.url), "utf8");
const docsHtml = readFileSync(new URL("../static/docs.html", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
const llmsText = readFileSync(new URL("../static/llms.txt", import.meta.url), "utf8");
const llmsFullText = readFileSync(new URL("../static/docs/llms-agents.md", import.meta.url), "utf8");
const modelsCss = readFileSync(new URL("../static/models.css", import.meta.url), "utf8");
const modelsHtml = readFileSync(new URL("../static/models.html", import.meta.url), "utf8");
const modelsScript = readFileSync(new URL("../static/models.js", import.meta.url), "utf8");
const openApiText = readFileSync(new URL("../static/openapi.json", import.meta.url), "utf8");
const privacyHtml = readFileSync(new URL("../static/privacy.html", import.meta.url), "utf8");
const styleCss = readFileSync(new URL("../static/style.css", import.meta.url), "utf8");

/**
 * Linear equivalent of `html.replace(/<[^>]+>/g, " ")`: every run from a "<" to the next ">" that has
 * at least one character between them becomes a single space. A regex here is super-linearly
 * backtracking (sonarjs/super-linear-regex), and every candidate rewrite changes which runs match.
 */
const stripHtmlTags = (html: string): string => {
  let text = "";
  let cursor = 0;
  let search = 0;
  while (search < html.length) {
    const open = html.indexOf("<", search);
    if (open === -1) break;
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      // "<>" has no tag content, so the regex cannot match here: keep the "<" and keep scanning after it.
      search = open + 1;
      continue;
    }
    text += `${html.slice(cursor, open)} `;
    cursor = close + 1;
    search = cursor;
  }
  return text + html.slice(cursor);
};

test("static assets register frontend module dependencies", () => {
  for (const path of [
    "/admin.js",
    "/admin.css",
    "/auth.js",
    "/auth-relay.js",
    "/chat-stats.js",
    "/foreground-refresh.js",
    "/network.js",
    "/models.js",
    "/models.css",
    "/reasoning-select.js",
    "/admin-cache.js",
    "/toast.js",
  ]) {
    assert.equal(hasStaticAsset(path), true, `${path} should be registered`);
  }
  assert.match(chatHtml, /<script type="module" src="\/chat\.js\?v=passport-design-20260922"><\/script>/);
  assert.match(chatScript, /from "\.\/chat-stats\.js\?v=20260827-response-stats-v4";/);
  assert.match(chatScript, /from "\.\/toast\.js\?v=passport-design-20260922";/);
});

test("chat response stats use one conversation bar below the composer", () => {
  assert.equal((chatHtml.match(/\bdata-chat-stats\b/g) ?? []).length, 1);
  assert.match(chatHtml, /<\/form>\s*<div data-chat-stats role="status" aria-live="polite" aria-atomic="true" hidden><\/div>/);
  assert.doesNotMatch(chatHtml, /data-message-stats/);
  assert.doesNotMatch(chatScript, /appendChatMessageStats|data-message-stats/);
  assert.match(chatScript, /recordCompletedChatResponse\(chatStats, sample\)/);
  assert.match(chatScript, /decodeMs: firstTokenAt === null \? undefined : completedAt - firstTokenAt/);
  assert.match(chatScript, /decodeTokens: readChatCompletionDecodeTokens\(responseUsage, reasoningEffort\)/);
  assert.match(chatScript, /if \(!assistantText\.trim\(\)\) \{[\s\S]*?return;[\s\S]*?recordAndRenderChatStats\(/);
  assert.doesNotMatch(chatScript, /firstStreamEventAt/);
  assert.match(chatCss, /\[data-chat-stats\]\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s);
  assert.doesNotMatch(chatCss, /\[data-chat-stats\]\s*\{[^}]*(?:overflow:\s*hidden|white-space:\s*nowrap)/s);
  assert.doesNotMatch(chatCss, /\[data-message-stats\]/);
});

test("chat falls back to the loopback development principal without a token", () => {
  assert.match(chatScript, /import \{\n(?:.|\n)*?isLocalDevelopmentOrigin,\n(?:.|\n)*?\} from "\.\/auth\.js";/);
  assert.match(chatScript, /let localDevelopmentAuth = false;/);
  assert.match(chatScript, /if \(!token && !localDevelopmentAuth\) \{/);
  assert.match(chatScript, /if \(auth\?\.mode !== "disabled" \|\| auth\?\.is_admin !== true\) return null;/);
  assert.match(chatScript, /const authHeaders = \(token = ""\) => \{/);
});

test("public models page is registered", () => {
  assert.equal(hasStaticAsset("/models"), true);
  assert.equal(hasStaticAsset("/models.html"), true);
  assert.match(modelsHtml, /<script type="module" src="\/models\.js\?v=passport-design-20260922"><\/script>/);
});

test("public console pages share versioned styles, canonical navigation, and accurate active states", () => {
  const sharedAssetVersion = "passport-design-20260922";
  const canonicalLinks = [
    { href: "/models", label: "Models" },
    { href: "/developers", label: "Developers" },
    { href: "/docs", label: "Docs" },
    { href: "/chat", label: "Chat" },
    { href: "/admin", label: "Admin" },
  ];
  const pages = [
    { name: "index", html: indexHtml, pageCss: "home.css", activeHref: null },
    { name: "docs", html: docsHtml, pageCss: "docs.css", activeHref: "/docs" },
    { name: "developers", html: developersHtml, pageCss: "docs.css", activeHref: "/developers" },
    { name: "models", html: modelsHtml, pageCss: "models.css", activeHref: "/models" },
    { name: "chat", html: chatHtml, pageCss: "chat.css", activeHref: "/chat" },
    { name: "about", html: aboutHtml, pageCss: "docs.css", activeHref: null },
    { name: "contact", html: contactHtml, pageCss: "docs.css", activeHref: null },
    { name: "privacy", html: privacyHtml, pageCss: "docs.css", activeHref: null },
  ];

  for (const page of pages) {
    const stylesheetHrefs = [...page.html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"[^>]*>/g)].map((match) => match[1]);
    assert.equal(stylesheetHrefs.length, 2, `${page.name} should load only the shared and page styles`);
    assert.equal(stylesheetHrefs[0], `/style.css?v=${sharedAssetVersion}`, `${page.name} should load the shared design foundation at the current version`);
    assert.match(
      stylesheetHrefs[1] ?? "",
      new RegExp(`^/${page.pageCss.replace(/\./g, "\\.")}\\?v=[\\w.-]+$`),
      `${page.name} should load its page styles with a cache-busting version`
    );
    for (const href of stylesheetHrefs) {
      assert.equal(hasStaticAsset(new URL(href, "https://ai.ubq.fi").pathname), true, `${href} should be registered`);
    }

    assert.equal((page.html.match(/<header\b[^>]*\bdata-shared-header\b[^>]*>/g) ?? []).length, 1, `${page.name} should have one shared header`);
    assert.equal((page.html.match(/<nav\b[^>]*\bdata-actions\b[^>]*>/g) ?? []).length, 1, `${page.name} should have one actions navigation`);
    const primaryNavMatches = [...page.html.matchAll(/<nav\b(?=[^>]*\bdata-actions\b)(?=[^>]*\baria-label="Primary")[^>]*>([\s\S]*?)<\/nav>/g)];
    assert.equal(primaryNavMatches.length, 1, `${page.name} should have one actions primary navigation`);
    const primaryNav = primaryNavMatches[0]?.[1] ?? "";
    assert.doesNotMatch(primaryNav, /<a\b[^>]*\bdata-variant="primary"/, `${page.name} primary navigation must derive its active treatment from aria-current`);

    const links = [...primaryNav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
      attributes: match[1],
      href: /\bhref="([^"]+)"/.exec(match[1])?.[1] ?? "",
      label: stripHtmlTags(match[2]).replace(/\s+/g, " ").trim(),
    }));
    assert.deepEqual(
      links.map(({ href, label }) => ({ href, label })),
      canonicalLinks,
      `${page.name} should preserve the canonical primary navigation order and labels`
    );
    for (const link of links) {
      assert.match(link.attributes, /\bdata-button\b/, `${page.name} ${link.label} should use the shared nav control`);
    }

    const currentLinks = links.filter((link) => /\baria-current="page"/.test(link.attributes));
    assert.equal(
      (primaryNav.match(/\baria-current=/g) ?? []).length,
      page.activeHref === null ? 0 : 1,
      `${page.name} should not expose an alternate or duplicate primary current state`
    );
    assert.deepEqual(
      currentLinks.map(({ href }) => href),
      page.activeHref === null ? [] : [page.activeHref],
      `${page.name} should mark only its matching canonical destination as current`
    );
  }

  assert.match(adminHtml, new RegExp(`/style\\.css\\?v=${sharedAssetVersion}`));
  assert.match(
    adminHtml,
    /<nav data-actions aria-label="Primary">[\s\S]*href="\/models">Models<\/a>[\s\S]*href="\/developers">Developers<\/a>[\s\S]*href="\/docs">Docs<\/a>[\s\S]*href="\/chat">Chat<\/a>[\s\S]*href="\/admin">Admin<\/a>[\s\S]*<\/nav>/,
    "admin should share the canonical primary navigation with the public pages"
  );
});

test("public console styles share the light and dark design tokens without decorative Models blue", () => {
  const ruleBodies = (css: string, selector: string): string[] => {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]);
  };
  const ruleBodyContaining = (css: string, selector: string, declaration: string): string => {
    const body = ruleBodies(css, selector).find((candidate) => candidate.includes(declaration));
    assert.ok(body, `${selector} should have a CSS rule containing ${declaration}`);
    return body;
  };
  const tokenValue = (block: string, name: string): string => new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? "";

  const headerRule = ruleBodyContaining(styleCss, "header[data-shared-header]", "border-radius");
  assert.match(headerRule, /border:\s*1px solid var\(--border\)/);
  assert.match(headerRule, /background:\s*var\(--surface\)/);
  assert.match(headerRule, /border-radius:\s*var\(--radius-lg\)/);

  const navControlRule = ruleBodyContaining(styleCss, "[data-actions] a[data-button]", "min-height");
  assert.match(navControlRule, /min-height:\s*var\(--control-height\)/);
  assert.match(navControlRule, /border-radius:\s*var\(--radius-sm\)/);
  assert.match(navControlRule, /background:\s*transparent/);
  assert.match(navControlRule, /color:\s*var\(--muted\)/);

  const activeNavRule = ruleBodyContaining(styleCss, '[data-actions] a[aria-current="page"]', "background");
  assert.match(activeNavRule, /background:\s*var\(--selection\)/);
  assert.match(activeNavRule, /color:\s*var\(--link\)/);

  // The OS picks the scheme; the light block is the base and dark overrides only the palette.
  const lightTokens = ruleBodies(styleCss, ":root")[0] ?? "";
  const darkTokens = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}\s*\}/.exec(styleCss)?.[1] ?? "";
  assert.match(lightTokens, /color-scheme:\s*light dark;/);
  assert.match(darkTokens, /color-scheme:\s*dark;/);
  assert.equal(tokenValue(lightTokens, "bg"), "#f7f9fc");
  assert.equal(tokenValue(lightTokens, "surface"), "#ffffff");
  assert.equal(tokenValue(lightTokens, "surface-2"), "#f1f5f9");
  assert.equal(tokenValue(lightTokens, "text"), "#111827");
  assert.equal(tokenValue(lightTokens, "muted"), "#5f6b7a");
  assert.equal(tokenValue(lightTokens, "accent"), "#0063d1");
  assert.equal(tokenValue(lightTokens, "accent-ink"), "#ffffff");
  assert.equal(tokenValue(lightTokens, "control-height"), "44px");
  assert.equal(tokenValue(lightTokens, "radius-sm"), "10px");
  assert.equal(tokenValue(lightTokens, "radius-lg"), "14px");
  assert.equal(tokenValue(darkTokens, "bg"), "#09090b");
  assert.equal(tokenValue(darkTokens, "surface"), "#141418");
  assert.equal(tokenValue(darkTokens, "surface-2"), "#1d1d22");
  assert.equal(tokenValue(darkTokens, "text"), "#f5f5f7");
  assert.equal(tokenValue(darkTokens, "muted"), "#a1a1aa");
  assert.equal(tokenValue(darkTokens, "accent-ink"), "#ffffff");
  assert.match(styleCss, /--font-family:\s*ui-sans-serif/);
  assert.match(styleCss, /body\s*\{[^}]*font-size:\s*14px/);

  const inputBlocks = [...styleCss.matchAll(/(?:^|\n)input,\n\s*textarea,\n\s*select\s*\{([^}]*)\}/g)].map((match) => match[1]);
  const controlBlock = inputBlocks.find((block) => block.includes("min-height")) ?? "";
  assert.notEqual(controlBlock, "", "text controls must share one base rule");
  assert.doesNotMatch(controlBlock, /color-scheme/, "controls must inherit the OS scheme instead of pinning one");

  assert.match(styleCss, /@media \(hover: hover\) and \(pointer: fine\)/);
  const reducedMotion = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(styleCss)?.[1] ?? "";
  assert.notEqual(reducedMotion, "", "the shared styles must respect prefers-reduced-motion");
  assert.doesNotMatch(reducedMotion, /transition:\s*none/, "reduced motion keeps short helpful fades");

  const cssColorLiterals = modelsCss.match(/#[\da-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
  const colorChannels = (literal: string): [number, number, number] | null => {
    if (literal.startsWith("#")) {
      const hex = literal.slice(1);
      const rgb =
        hex.length === 3 || hex.length === 4
          ? hex
              .slice(0, 3)
              .split("")
              .map((channel) => channel.repeat(2))
              .join("")
          : hex.slice(0, 6);
      if (rgb.length !== 6) return null;
      return [0, 2, 4].map((offset) => Number.parseInt(rgb.slice(offset, offset + 2), 16)) as [number, number, number];
    }
    const match = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(literal);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const decorativeBlues = cssColorLiterals.filter((literal) => {
    const channels = colorChannels(literal);
    if (!channels) return false;
    const [red, green, blue] = channels;
    return blue - red >= 24 && blue - green >= 12;
  });
  assert.deepEqual(decorativeBlues, [], "models.css should use neutral shared-console colors");
});

test("published guidance documents endpoint-specific output caps and repository-local auth uploads", () => {
  for (const publishedText of [readmeText, llmsFullText]) {
    assert.match(publishedText, /`max_completion_tokens` is the OpenAI Chat Completions cap/);
    assert.match(publishedText, /`max_output_tokens` is the OpenAI Responses cap/);
    assert.match(publishedText, /Chat Completions to Codex[\s\S]*translated to the Codex Responses field `max_output_tokens`/);
    assert.match(publishedText, /Responses to Codex[\s\S]*`max_output_tokens` is forwarded as `max_output_tokens`/);
    assert.match(publishedText, /Chat Completions to Cerebras \(`gpt-oss-120b`\)[\s\S]*forwarded unchanged/);
    assert.match(publishedText, /Chat Completions to DeepSeek official[\s\S]*translated to DeepSeek's documented `max_tokens`/);
    assert.match(publishedText, /DeepSeek official[\s\S]*https:\/\/api\.deepseek\.com\/chat\/completions/);
    assert.match(publishedText, /DeepSeek official[\s\S]*deepseek_api_key_missing/);
    assert.match(publishedText, /Responses to DeepSeek official[\s\S]*`max_output_tokens` is translated to DeepSeek's documented `max_tokens`/);
    assert.match(publishedText, /Responses API[\s\S]*tool_calls/);
    assert.match(publishedText, /Paid fallback \(Metered or Surplus\)[\s\S]*Chat `max_completion_tokens` arrives as `max_output_tokens`/);
    assert.match(publishedText, /Do not swap these fields between endpoints/);
  }

  assert.doesNotMatch(readmeText, /cd lib\/ai\.ubq\.fi/);
  assert.match(readmeText, /git rev-parse --show-toplevel/);
  assert.match(llmsFullText, /scripts\/upload-codex-auth\.ts/);
  assert.match(llmsFullText, /bun run upload:auth --url https:\/\/ai\.ubq\.fi --auth-json ~\/\.codex\/auth\.json/);
});

test("admin console every rendered tab declares an access requirement", () => {
  // `canAccessView` returns false for a view with no `VIEW_REQUIREMENTS` entry,
  // so a tab added to the markup without one is dead for every role.
  const requirements = /const VIEW_REQUIREMENTS = \{([\s\S]*?)\n\};/.exec(adminScript)?.[1] ?? "";
  assert.notEqual(requirements, "", "VIEW_REQUIREMENTS must be declared");
  const declared = new Set([...requirements.matchAll(/^\s{2}([a-z-]+):/gm)].map((match) => match[1]));
  const tabs = [...adminHtml.matchAll(/id="view-tab-([a-z-]+)"/g)].map((match) => match[1]);
  assert.notEqual(tabs.length, 0, "the admin console must render tabs");
  for (const tab of tabs) {
    // `session` is the signed-out shell, handled before the requirement lookup.
    if (tab === "session") continue;
    assert.equal(declared.has(tab), true, `admin tab '${tab}' declares no access requirement`);
  }
});

test("admin console tabs follow the approved operator order", () => {
  // The strip renders in DOM order and arrow-key traversal follows it, so this pins the approved operator order.
  const tabs = [...adminHtml.matchAll(/id="view-tab-([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["analytics", "providers", "models", "defaults", "errors", "keys", "users", "kernel", "pubkeys", "supervisor"]);
});

test("models page labels provider counts as catalog entries, not inference availability", () => {
  assert.match(modelsHtml, /Model catalog/);
  assert.match(modelsHtml, /Availability and quota vary by\s+provider/);
  assert.match(modelsHtml, /Cataloged text models and the providers that list\s+them/);
  assert.match(modelsHtml, /does not guarantee\s+inference availability or remaining quota/);
  assert.doesNotMatch(modelsHtml, /Live upstream catalog/);
  assert.match(modelsScript, /cataloged model/);
  assert.match(modelsScript, /cataloged models/);
  assert.doesNotMatch(modelsScript, /available models/);
});

test("public brand logos are inline and inherit the page foreground", async () => {
  assert.match(styleCss, /\[data-logo\]\s*\{[^}]*color: inherit;/);
  const sourcePath = /<path\b[\s\S]*?\bd="([^"]+)"/.exec(companyLogoSvg)?.[1];
  assert.ok(sourcePath, "the source logo must define a path");

  for (const [path, sourceHtml] of [
    ["/about", aboutHtml],
    ["/contact", contactHtml],
    ["/developers", developersHtml],
    ["/models", modelsHtml],
    ["/privacy", privacyHtml],
  ]) {
    const response = await handleStaticAsset(path);
    assert.equal(response?.status, 200, `${path} must be publicly served`);
    assert.ok(response, `${path} must be publicly served`);
    const html = await response.text();
    assert.equal(html, sourceHtml, `${path} must serve the inline brand markup`);
    assert.doesNotMatch(html, /<img\b[^>]*(?:data-logo|data-models-logo)[^>]*>/, `${path} must not embed its logo`);
    assert.match(html, /<svg\b(?=[^>]*\bdata-logo\b)[^>]*>[\s\S]*?<path\b[\s\S]*?fill="currentColor"/, `${path} must use an inline currentColor logo`);
    const inlinePath = /<svg\b(?=[^>]*\bdata-logo\b)[^>]*>[\s\S]*?<path\b[\s\S]*?\bd="([^"]+)"/.exec(html)?.[1];
    assert.equal(inlinePath, sourcePath, `${path} must preserve the company logo path`);
  }
});

test("public agent-readiness pages and crawl artifacts are registered", () => {
  for (const path of [
    "/developers",
    "/developers.html",
    "/about",
    "/about.html",
    "/contact",
    "/contact.html",
    "/privacy",
    "/privacy.html",
    "/robots.txt",
    "/sitemap.xml",
  ]) {
    assert.equal(hasStaticAsset(path), true, `${path} should be registered`);
  }
});

test("admin analytics view places capacity history before current providers", () => {
  const listIndex = adminHtml.indexOf('id="provider-capacity-list"');
  const chartIndex = adminHtml.indexOf('id="provider-capacity-chart"');
  assert.ok(chartIndex >= 0);
  assert.ok(listIndex > chartIndex);

  assert.match(adminHtml, /id="card-provider-capacity">Provider analytics/);
  assert.match(adminHtml, /id="view-tab-analytics"[\s\S]*?>\s*Analytics\s*</);
  assert.doesNotMatch(adminHtml, /Fifteen-minute capacity, cached-input, and cache-write history/);
  assert.match(adminHtml, /admin\.css\?v=passport-design-20260922/);
  assert.match(adminHtml, /admin\.js\?v=admin-supervisor-v4-20261009/);
  assert.match(adminScript, /toLocaleString\(undefined,/);
  assert.match(adminScript, /timeZoneName: "short"/);
  assert.match(adminScript, /creditExpiries/);
  // ECMA-402 forbids combining `dateStyle`/`timeStyle` with `timeZoneName`; V8
  // throws `TypeError: Invalid option : option`, which aborted the capacity
  // render and blanked the analytics panel.
  const expiryFormatter = adminScript.slice(adminScript.indexOf("const formatCreditExpiry"), adminScript.indexOf("const creditExpiryHint"));
  assert.match(expiryFormatter, /timeZoneName: "short"/);
  assert.doesNotMatch(expiryFormatter, /dateStyle|timeStyle/);
  assert.match(adminHtml, /admin-supervisor\.css\?v=admin-permissions-20261005/);
  assert.match(adminScript, /from "\.\/admin-supervisor\.js\?v=20261001-supervisor-v4";/);
  assert.doesNotMatch(adminScript, /super-admin/);
  assert.doesNotMatch(adminHtml, /removed_provider-failover|debug-routing/);
  assert.doesNotMatch(adminScript, /RemovedProviderFailover|refresh=live/);
  assert.match(adminScript, /fetch\(apiUrl\("\/admin\/providers\/capacity"\)/);
  assert.match(adminScript, /Cached input share/);
  assert.match(adminScript, /written to cache/);
  assert.match(adminScript, /cache_write_input_tokens/);
  assert.match(adminScript, /cacheWriteFieldsMissing/);
  assert.match(adminScript, /snapshot\?\.prompt_cache\?\.buckets/);
  assert.match(adminScript, /snapshot\?\.prompt_cache\?\.status !== "ready"/);
  assert.match(adminScript, /cache analytics unavailable/);
  assert.match(adminScript, /const loadId = \+\+providersLoadId/);
  assert.match(adminScript, /if \(loadId !== providersLoadId\) return/);
  assert.match(adminScript, /cache: "no-store"/);
  assert.match(adminScript, /Authorization: `Bearer \$\{token\}`/);
  assert.match(adminScript, /auth\.js\?v=passkey-relay-20260823-v5/);
  assert.match(adminScript, /credentials: "include"/);
  assert.match(adminScript, /if \(!getAdminToken\(\) \|\| \(isRemoteRelayOrigin\(\) && relaySessionActive\)\) headers\.delete\("Authorization"\)/);
  const cookieFirstIndex = adminScript.indexOf("authResult = await requestAuth({});");
  const bearerFallbackIndex = adminScript.indexOf("authResult = await requestAuth({ Authorization: `Bearer ${token}` });");
  assert.ok(cookieFirstIndex >= 0);
  assert.ok(bearerFallbackIndex > cookieFirstIndex);
  assert.match(adminScript, /relaySessionActive = false;\s+const authenticated = await testAdminToken\(\{ allowBearerFallback: false \}\)/);
  assert.match(adminScript, /testAdminToken\(\{ allowBearerFallback: false \}\)/);
  assert.match(adminScript, /authResult\.data\?\.auth\?\.method\?\.kind === "passkey_session"/);
  assert.match(adminScript, /if \(relaySessionActive\) return ""/);
  assert.match(adminScript, /token: isRemoteRelayOrigin\(\) && relaySessionActive \? "" : token/);
  assert.match(adminScript, /if \(isRemoteRelayOrigin\(\) && relaySessionActive\) \{/);
  assert.match(adminScript, /authenticated: true/);
  assert.doesNotMatch(adminScript, /token: result\.token/);
  assert.doesNotMatch(adminScript, /applySignedInToken\(relay\.token/);
  assert.match(adminScript, /!adminAccessState\.isAdmin \|\| !hasAdminCredential\(\)/);
  assert.match(authScript, /relay_session !== true/);
  assert.match(authScript, /credentials: init\?\.credentials \?\? "include"/);
});

test("admin error tab opens its view", () => {
  assert.match(adminScript, /viewTabErrors\.addEventListener\("click", \(\) => setAdminView\("errors", \{ hashMode: "push", focusAuth: true \}\)\)/);
  assert.match(adminScript, /const loadId = \+\+errorsLoadId/);
  assert.match(adminScript, /if \(loadId !== errorsLoadId\) return/);
  assert.match(adminScript, /invalidateAdminErrors\("Sign in to load gateway errors\."\)/);
  assert.match(adminScript, /invalidateAdminErrors\("Target changed\. Sign in to load gateway errors\."\)/);
});

test("admin responses use a scoped IndexedDB stale cache", () => {
  assert.match(adminCacheScript, /const DATABASE_NAME = "uos_ai\.admin-cache";/);
  assert.match(adminCacheScript, /store\.createIndex\(SCOPE_INDEX, "scope", \{ unique: false \}\)/);
  assert.match(adminCacheScript, /objectStore\(STORE_NAME\)\.get/);
  assert.doesNotMatch(adminCacheScript, /localStorage|Authorization|Cookie/);

  assert.match(adminScript, /import \{ createAdminSnapshotCache \} from "\.\/admin-cache\.js\?v=admin-indexeddb-cache-20260830-v7";/);
  assert.match(adminScript, /const cacheFreshAdminRead = \(response, cacheKey, scope, epoch\) =>/);
  assert.match(adminScript, /if \(!response\.ok \|\| !cacheKey \|\| !scope/);
  assert.match(adminScript, /const hydrateAdminSnapshots = async \(\) =>/);
  assert.match(
    adminScript,
    /setAdminSnapshotScopeFromAuth\(data\.auth\);\s+setAdminAccessState\(\{ checked: true, isAdmin: true, isSuperAdmin \}\);\s+void hydrateAdminSnapshots\(\);/
  );
  assert.match(adminScript, /globalThis\.requestAnimationFrame\(\(\) => \{\s+globalThis\.setTimeout/);
  assert.doesNotMatch(adminScript, /showPendingAdminViewAfterPrefetch/);
  assert.match(
    adminScript,
    /adminAccessState\.checked && adminAccessState\.isAdmin && currentAdminView === ADMIN_VIEW_DEFAULT\) \{\s+setAdminView\(ADMIN_VIEW_AUTHENTICATED_DEFAULT, \{ allowInaccessible: false \}\);/
  );
  assert.match(adminScript, /"Cached · refreshing"/);
  assert.match(adminScript, /setKeysBadge\("ok", view === "all" \? "No API keys" : `No \$\{view\} API keys`\);/);
  assert.match(adminScript, /const readCachedApiKeyRequestLogs = async \(keyId\) =>/);
  assert.match(adminScript, /renderApiKeyRequestLogs\(panel, list, summary, cached\.records, "Cached · refreshing"\);/);
  assert.match(adminScript, /const inFlightEntry = \{ scope, epoch, request: null \};/);
  assert.match(adminScript, /isCurrentApiKeyRequestLogCacheEntry\(cached, scope, epoch\)[\s\S]*now - cached\.fetchedAt < API_KEY_REQUEST_LOGS_TTL_MS/);
  assert.match(adminScript, /if \(isCurrentApiKeyRequestLogScope\(scope, epoch\)\) \{\s+apiKeyRequestLogCache\.set\(cacheKey, \{[\s\S]*scope,[\s\S]*epoch,/);
  assert.match(adminScript, /if \(apiKeyRequestLogPromises\.get\(cacheKey\) === inFlightEntry\) \{\s+apiKeyRequestLogPromises\.delete\(cacheKey\);/);
  assert.match(
    adminScript,
    /const scope = adminCacheScope;\s+const epoch = adminCacheEpoch;\s+const isCurrentPanel = \(\) =>[\s\S]*isCurrentApiKeyRequestLogScope\(scope, epoch\);/
  );
  assert.match(adminScript, /const cached = await readCachedApiKeyRequestLogs\(currentKeyId\);\s+if \(!isCurrentPanel\(\)\)/);
  assert.match(adminScript, /const response = await refresh;\s+if \(!isCurrentPanel\(\)\)/);
  assert.match(adminScript, /clearAdminSnapshotScope\(\);/);
});

test("admin boot probes server auth mode without requiring a browser token", () => {
  assert.doesNotMatch(adminScript, /if \(!token && !relaySessionActive && !isRemoteRelayOrigin\(\)\)/);
  assert.match(adminScript, /requestAuth\(token \? \{ Authorization: `Bearer \$\{token\}` \} : \{\}\)/);
  assert.match(adminScript, /resetAdminPrefetchState\("Checking admin session\.\.\."\)/);
});

test("expanded auth widget keeps its mobile toggle right-aligned", () => {
  assert.match(adminCss, /\[data-auth-widget\]\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(adminCss, /#auth-widget-toggle\s*\{[^}]*grid-column:\s*1;[^}]*justify-self:\s*end/);
  assert.match(adminCss, /#auth-widget-panel\s*\{[^}]*grid-column:\s*1/);
});

test("provider analytics graph reports inference 5xx buckets", () => {
  assert.match(adminScript, /label: "Errors \(5xx\)"/);
  assert.match(adminScript, /five_xx_buckets/);
  assert.match(adminScript, /marker\.dataset\.capacityInferenceError/);
  assert.doesNotMatch(adminScript, /marker\.dataset\.capacityInference5xx/);
  assert.match(adminCss, /\[data-capacity-inference-error\] path/);
  assert.match(adminCss, /\[data-capacity-legend-item="inference-error"\]/);
  assert.match(adminScript, /15-minute bucket starting/);
  assert.match(adminScript, /Failed inference buckets/);
  assert.match(adminScript, /marker\.setAttribute\("tabindex", "0"\)/);
});

test("provider analytics graph preserves its SVG text aspect ratio", () => {
  assert.match(adminScript, /preserveAspectRatio: "xMinYMin meet"/);
  assert.match(adminScript, /viewBox: `0 0 \$\{width\} \$\{height\}`,[\s\S]*?width,[\s\S]*?height,/);
  assert.match(adminCss, /\[data-capacity-chart-svg\]\s*\{[\s\S]*?height:\s*var\(--capacity-chart-height-px, 180px\)/);
  assert.doesNotMatch(adminCss, /\[data-capacity-chart-svg\]\s*\{[^}]*height:\s*clamp\(/);
});

test("provider analytics chart fills its column and follows the newest edge", () => {
  assert.match(adminCss, /\[data-capacity-chart-body\]\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.doesNotMatch(adminCss, /\[data-capacity-chart-body\][^}]*minmax\((180|210)px/);
  assert.match(adminScript, /let capacityChartFollowsLatest = true;/);
  assert.match(adminScript, /if \(scroll\.clientWidth <= 0\) return;/);
  assert.match(adminScript, /!capacityChartFollowsLatest && typeof state\?\.anchorAtMs === "number"/);
  assert.match(adminScript, /view === "analytics"[\s\S]*?scheduleProviderCapacityChartResize\(\);/);
});

test("static assets register autonomous agent discovery documents", () => {
  for (const path of ["/llms.txt", "/llms-full.txt", "/docs/llms-agents.md", "/openapi.json"]) {
    assert.equal(hasStaticAsset(path), true, `${path} should be registered`);
  }
});

test("OpenAPI discovery contract describes the public inference API", () => {
  const document = JSON.parse(openApiText);

  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.servers[0].url, "https://ai.ubq.fi");
  assert.ok(document.components.securitySchemes.bearerAuth);
  for (const [path, method] of [
    ["/health", "get"],
    ["/v1/models", "get"],
    ["/v1/chat/completions", "post"],
    ["/v1/responses", "post"],
    ["/v1/images/generations", "post"],
    ["/v1/images/edits", "post"],
    ["/uos/models/capabilities", "get"],
  ]) {
    const operation = document.paths[path][method];
    assert.equal(typeof operation.operationId, "string", `${method.toUpperCase()} ${path} needs an operation id`);
    assert.ok(operation.description.length > 80, `${method.toUpperCase()} ${path} needs a useful description`);
  }
  assert.equal(document.components.schemas.ChatCompletionRequest.properties.tools.items.$ref, "#/components/schemas/FunctionTool");
  assert.equal(document.components.schemas.ChatCompletionRequest.properties.tool_choice.$ref, "#/components/schemas/ToolChoice");
  assert.equal(document.components.schemas.ResponseRequest.properties.tools.items.$ref, "#/components/schemas/ResponseFunctionTool");
  assert.equal(document.components.schemas.ResponseRequest.properties.tool_choice.$ref, "#/components/schemas/ResponseToolChoice");
  assert.equal(document.components.schemas.ResponseRequest.required, undefined);
  const responseFunctionTool = document.components.schemas.ResponseFunctionTool;
  assert.deepEqual(responseFunctionTool.required, ["type", "name"]);
  assert.ok(responseFunctionTool.properties.name);
  assert.ok(responseFunctionTool.properties.description);
  assert.ok(responseFunctionTool.properties.parameters);
  assert.equal(responseFunctionTool.properties.function, undefined);
  const responseForcedToolChoice = document.components.schemas.ResponseToolChoice.oneOf[1];
  assert.deepEqual(responseForcedToolChoice.required, ["type", "name"]);
  assert.ok(responseForcedToolChoice.properties.name);
  assert.equal(responseForcedToolChoice.properties.function, undefined);
  assert.ok(document.components.headers.RateLimit);
  assert.ok(document.components.headers.RateLimitPolicy);
  assert.ok(document.components.responses.RateLimited.headers["Retry-After"]);
  assert.ok(document.components.responses.RateLimited.headers.RateLimit);

  const generation = document.paths["/v1/images/generations"].post;
  const edit = document.paths["/v1/images/edits"].post;
  assert.equal(generation.operationId, "createImage");
  assert.equal(edit.operationId, "createImageEdit");
  assert.deepEqual(Object.keys(generation.requestBody.content), ["application/json"]);
  assert.deepEqual(
    Object.keys(edit.requestBody.content).sort((a, b) => a.localeCompare(b)),
    ["application/json", "multipart/form-data"]
  );
  assert.equal(generation.requestBody.content["application/json"].schema.$ref, "#/components/schemas/ImageGenerationRequest");
  assert.equal(edit.requestBody.content["application/json"].schema.$ref, "#/components/schemas/ImageEditJsonRequest");
  assert.equal(edit.requestBody.content["multipart/form-data"].schema.$ref, "#/components/schemas/ImageEditMultipartRequest");
  assert.deepEqual(document.components.schemas.ImageGenerationRequest.required, ["prompt"]);
  assert.deepEqual(document.components.schemas.ImageEditJsonRequest.required, ["images", "prompt"]);
  assert.deepEqual(document.components.schemas.ImageEditMultipartRequest.required, ["prompt"]);
  assert.deepEqual(document.components.schemas.ImageEditMultipartRequest.anyOf, [{ required: ["image"] }, { required: ["image[]"] }]);
  assert.deepEqual(
    document.components.schemas.ImageEditMultipartRequest.properties["image[]"].oneOf,
    document.components.schemas.ImageEditMultipartRequest.properties.image.oneOf
  );
  assert.equal(document.components.schemas.ImageEditJsonRequest.properties.images.items.$ref, "#/components/schemas/ImageRef");
  assert.equal(document.components.schemas.ImageEditJsonRequest.properties.mask.$ref, "#/components/schemas/ImageMaskRef");
  const imageRef = document.components.schemas.ImageRef;
  assert.deepEqual(imageRef.required, ["image_url"]);
  assert.equal(imageRef.anyOf, undefined);
  assert.equal(imageRef.not, undefined);
  assert.equal(imageRef.additionalProperties, false);
  assert.equal(imageRef.properties.image_url.format, "uri");
  assert.equal(imageRef.properties.image_url.minLength, 1);
  assert.equal(imageRef.properties.image_url.maxLength, 20_971_520);
  assert.equal(
    imageRef.properties.image_url.pattern,
    "^(?:[hH][tT][tT][pP][sS]?://|[dD][aA][tT][aA]:[iI][mM][aA][gG][eE]/(?:[pP][nN][gG]|[xX]-[pP][nN][gG]|[jJ][pP](?:[eE][gG]|[gG])|[wW][eE][bB][pP]);[bB][aA][sS][eE]64,)"
  );
  assert.equal(imageRef.properties.file_id, undefined);
  const imageMaskRef = document.components.schemas.ImageMaskRef;
  assert.deepEqual(imageMaskRef.required, ["image_url"]);
  assert.equal(imageMaskRef.anyOf, undefined);
  assert.equal(imageMaskRef.not, undefined);
  assert.equal(imageMaskRef.additionalProperties, false);
  assert.equal(imageMaskRef.properties.image_url.maxLength, 20_971_520);
  assert.equal(imageMaskRef.properties.image_url.pattern, "^[dD][aA][tT][aA]:[iI][mM][aA][gG][eE]/[pP][nN][gG];[bB][aA][sS][eE]64,");
  assert.equal(imageMaskRef.properties.file_id, undefined);
  const generationSchema = document.components.schemas.ImageGenerationRequest;
  const editJsonSchema = document.components.schemas.ImageEditJsonRequest;
  const editMultipartSchema = document.components.schemas.ImageEditMultipartRequest;
  assert.deepEqual(generationSchema.properties.n.type, ["integer", "null"]);
  assert.equal(generationSchema.properties.model.default, "gpt-image-1");
  assert.equal(editJsonSchema.properties.model.default, "gpt-image-1.5");
  assert.equal(editMultipartSchema.properties.model.default, "gpt-image-1.5");
  assert.match(editMultipartSchema.description, /together they must total no more than 50 MiB/);
  assert.deepEqual(editJsonSchema.properties.input_fidelity.type, ["string", "null"]);
  for (const schema of [generationSchema, editJsonSchema, editMultipartSchema]) {
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.prompt.maxLength, 32_000);
    assert.equal(schema.properties.user.type, "string");
    assert.match(schema.properties.user.description, /x-uos-warning: user_ignored/);
    assert.deepEqual(schema.properties.stream.enum, [false, null]);
    assert.deepEqual(schema.properties.output_compression.type, ["integer", "null"]);
  }
  assert.deepEqual(generationSchema.properties.response_format.enum, ["b64_json", null]);
  assert.equal(generationSchema.properties.style, undefined);
  assert.deepEqual(generationSchema.properties.quality.enum, ["low", "medium", "high", "auto", null]);
  assert.deepEqual(editJsonSchema.properties.size.type, ["string", "null"]);
  assert.equal(editJsonSchema.properties.size.minLength, 1);
  assert.equal(editJsonSchema.properties.size.enum, undefined);
  assert.deepEqual(editJsonSchema.properties.quality.enum, ["low", "medium", "high", "auto", null]);
  assert.deepEqual(editMultipartSchema.properties.quality.enum, ["low", "medium", "high", "auto", null]);
  assert.equal(editMultipartSchema.properties.moderation, undefined);
  assert.deepEqual(editMultipartSchema.properties.response_format.enum, ["b64_json", null]);
  assert.equal(document.components.schemas.ImagesResponse.properties.data.items.$ref, "#/components/schemas/Image");
  assert.ok(document.components.schemas.ImagesResponse.properties.output_format);
  assert.equal(document.components.schemas.Image.properties.output_format, undefined);
});

test("published agent contracts distinguish bodyless catalog revalidation and conditional rate limits", () => {
  const document = JSON.parse(openApiText);
  const developerText = stripHtmlTags(developersHtml).replace(/\s+/g, " ");
  const modelResponses = document.paths["/v1/models"].get.responses;
  const modelList = modelResponses["200"];
  const notModified = document.paths["/v1/models"].get.responses["304"];

  assert.equal(modelList.headers.ETag.$ref, "#/components/headers/ETag");
  assert.equal(notModified.headers.ETag.$ref, "#/components/headers/ETag");
  assert.match(document.components.headers.ETag.description, /versioned 200 and 304 responses/i);
  assert.match(document.components.headers.ETag.description, /omitted from the unversioned/i);
  assert.equal(notModified.content, undefined);
  assert.match(notModified.description, /no response body; reuse the cached catalog/i);
  assert.match(developerText, /matching If-None-Match request to GET \/v1\/models\?client_version=X\.Y\.Z can return 304 Not Modified with no body/i);
  assert.match(llmsFullText, /matching `If-None-Match` requests receive `304 Not Modified`\s+with no body/i);

  for (const publishedText of [openApiText, llmsFullText]) {
    assert.doesNotMatch(publishedText, /RFC 9449/);
    assert.match(publishedText, /draft-ietf-httpapi-ratelimit-headers-11/);
  }
  assert.match(document.components.headers.RetryAfter.description, /when present/i);
  assert.match(document.components.responses.RateLimited.description, /Retry-After when present/i);
  assert.match(developerText, /For a 429 error, honor Retry-After when present/i);
  assert.match(llmsText, /honor `Retry-After` when present/);
});

test("agent discovery documents are served with useful media types", async () => {
  const llms = await handleStaticAsset("/llms.txt");
  const llmsFull = await handleStaticAsset("/llms-full.txt");
  const markdown = await handleStaticAsset("/docs/llms-agents.md");
  const openapi = await handleStaticAsset("/openapi.json");

  assert.equal(llms?.status, 200);
  assert.equal(llms.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.ok(llms, "/llms.txt must be publicly served");
  assert.match(await llms.text(), /https:\/\/ai\.ubq\.fi\/openapi\.json/);
  assert.equal(llmsFull?.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(markdown?.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(openapi?.headers.get("content-type"), "application/json; charset=utf-8");
});

test("homepage content negotiation serves server-rendered HTML, Markdown, and explicit JSON", async () => {
  const generic = await handleRoot(new Request("https://ai.ubq.fi/", { headers: { Accept: "*/*" } }));
  const html = await handleRoot(new Request("https://ai.ubq.fi/", { headers: { Accept: "text/html" } }));
  const xhtml = await handleRoot(new Request("https://ai.ubq.fi/", { headers: { Accept: "application/xhtml+xml" } }));
  const markdown = await handleRoot(new Request("https://ai.ubq.fi/", { headers: { Accept: "text/markdown" } }));
  const unacceptable = await handleRoot(new Request("https://ai.ubq.fi/", { headers: { Accept: "image/png" } }));

  for (const response of [generic, html, xhtml]) {
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("vary"), "Accept, Accept-Encoding");
  }
  const rawHtml = await html.text();
  assert.match(rawHtml, /<h1>UbiquityOS AI Gateway<\/h1>/);
  const readableText = stripHtmlTags(rawHtml).replace(/\s+/g, " ").trim();
  assert.ok(readableText.length >= 500);
  assert.ok(readableText.length / rawHtml.length >= 0.05, "homepage should keep readable text above 5% of HTML");

  assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(markdown.headers.get("vary"), "Accept, Accept-Encoding");
  assert.match(await markdown.text(), /^# UbiquityOS AI Gateway/m);

  assert.equal(unacceptable.status, 406);
  assert.equal(unacceptable.headers.get("content-type"), "application/json");
  assert.equal((await unacceptable.json()).error.code, "not_acceptable");
});

test("public HEAD routes preserve GET metadata without a response body", async () => {
  const routes = [
    ["/", { Accept: "text/html" }],
    ["/index.html", {}],
    ["/style.css", {}],
    ["/docs/llms-agents.md", {}],
    ["/openapi.json", {}],
  ] as const;

  for (const [path, headers] of routes) {
    const getResponse = await handler(new Request("https://ai.ubq.fi" + path, { headers }));
    const headResponse = await handler(new Request("https://ai.ubq.fi" + path, { method: "HEAD", headers }));

    assert.equal(headResponse.status, getResponse.status, path);
    assert.deepEqual(
      [...headResponse.headers].filter(([name]) => name !== "x-uos-request-id"),
      [...getResponse.headers].filter(([name]) => name !== "x-uos-request-id"),
      path
    );
    assert.equal(await headResponse.text(), "", path);
  }
});

test("admin routes and page aliases are never cacheable before authentication", async () => {
  const adminRoutes = [
    ["GET", "/admin/passkey-users"],
    ["PATCH", "/admin/passkey-users"],
    ["POST", "/admin/codex/auth"],
    ["GET", "/admin/providers/codex/banked-resets"],
    ["PATCH", "/admin/providers/codex/banked-resets"],
    ["GET", "/admin/providers/codex/overage-usage"],
    ["PATCH", "/admin/providers/codex/overage-usage"],
    ["GET", "/admin/providers/codex/banked-resets/shadow-decisions"],
    ["GET", "/admin/providers/codex/cache-scope-experiment"],
    ["POST", "/admin/providers/codex/cache-scope-experiment"],
    ["GET", "/admin/codex/models"],
    ["POST", "/admin/codex/models"],
    ["GET", "/admin/models/whitelist"],
    ["POST", "/admin/models/whitelist"],
    ["GET", "/admin/models/catalog"],
    ["POST", "/admin/models/refresh"],
    ["POST", "/admin/codex/prompts/purge"],
    ["POST", "/admin/kv-migration/import"],
    ["GET", "/admin/kv-migration/validate"],
    ["GET", "/admin/sentinel/replay-captures"],
    ["GET", "/admin/sentinel/incidents"],
    ["GET", "/admin/codex/supervisor/sessions"],
    ["GET", "/admin/codex/supervisor/output"],
    ["POST", "/admin/codex/supervisor/brief"],
    ["GET", "/admin/errors"],
    ["GET", "/admin/defaults"],
    ["POST", "/admin/defaults"],
    ["GET", "/admin/debug/routing"],
    ["POST", "/admin/debug/routing"],
    ["DELETE", "/admin/debug/routing"],
    ["GET", "/admin/providers"],
    ["GET", "/admin/providers/selection"],
    ["POST", "/admin/providers/selection"],
    ["GET", "/admin/providers/capacity"],
    ["POST", "/admin/providers/capacity/observations"],
    ["GET", "/admin/providers/capacity/rollups"],
    ["GET", "/admin/providers/claude-code/access"],
    ["POST", "/admin/providers/claude-code/access"],
    ["POST", "/admin/providers/claude-code/accounts/active"],
    ["GET", "/admin/providers/claude-code/auth"],
    ["POST", "/admin/providers/claude-code/auth"],
    ["DELETE", "/admin/providers/claude-code/auth"],
    ["POST", "/admin/providers/claude-code/quota/clear"],
    ["GET", "/admin/providers/quota-projection"],
    ["POST", "/admin/providers/quota-projection/backfill"],
    ["GET", "/admin/prompt-cache-analytics"],
    ["GET", "/admin/api-keys"],
    ["POST", "/admin/api-keys"],
    ["PATCH", "/admin/api-keys"],
    ["DELETE", "/admin/api-keys"],
    ["GET", "/admin/api-keys/changes"],
    ["POST", "/admin/api-keys/revoke"],
    ["POST", "/admin/api-keys/unrevoke"],
    ["GET", "/admin/kernel-usage"],
    ["POST", "/admin/kernel-usage"],
    ["DELETE", "/admin/kernel-usage"],
    ["GET", "/admin/kernel-policy-queue"],
    ["GET", "/admin/kernel-pubkeys"],
    ["POST", "/admin/kernel-pubkeys"],
    ["DELETE", "/admin/kernel-pubkeys"],
    ["POST", "/admin/providers/codex/1/recheck"],
    ["GET", "/admin/api-keys/example/paid-fallbacks"],
  ] as const;
  const requests = [
    ["GET", "/admin"],
    ["HEAD", "/admin"],
    ["GET", "/admin.html"],
    ["HEAD", "/admin.html"],
    ["OPTIONS", "/admin/defaults"],
    ["GET", "/admin/not-a-real-route"],
    ...adminRoutes,
  ] as const;
  for (const authorization of [undefined, "Bearer definitely-wrong"] as const) {
    for (const [method, path] of requests) {
      const headers = authorization ? { Authorization: authorization } : undefined;
      const response = await handler(new Request(`https://ai.ubq.fi${path}`, { method, headers }));
      assert.equal(
        response.headers.get("cache-control"),
        "no-store",
        `${method} ${path} ${authorization ?? "anonymous"}`
      );
      await response.body?.cancel();
    }
  }
});

test("admin API-key actions preserve expired and unrevoke states", () => {
  const keyRenderer = adminScript.slice(
    adminScript.indexOf("const renderKeys"),
    adminScript.indexOf("const renderPasskeyUsers")
  );
  assert.match(keyRenderer, /if \(statusKind !== "revoked"\)/);
  assert.match(keyRenderer, /const keyLabel = key\.name \|\| key\.id \|\| "unnamed API key"/);
  assert.match(keyRenderer, /actionRow\.textContent = "";\s+actionRow\.appendChild\(editBtn\);/);
  assert.match(adminScript, /if \(inputsUnchanged && !expiresMismatch\) renderKeys\(allKeys, currentKeyView\);/);
  assert.match(adminScript, /const updateKeyStatus = \(\) =>/);
  assert.match(adminScript, /row\.hidden = currentKeyView !== "all" && currentKeyView !== nextStatusKind;/);
  assert.match(adminScript, /scheduleKeyExpiryRefresh\(\);/);
  assert.match(adminScript, /updateAccessApiKeysSummary\(\);/);
  assert.match(styleCss, /\[data-key\]\[data-state="expired"\][\s\S]*?--key-accent:\s*var\(--warning\)/);
  assert.match(adminScript, /toast\.info\(`Unrevoked \$\{name\}`,[\s\S]*?remains expired/);
  assert.match(adminScript, /if \(!confirm\(`Revoke API key "\$\{name\}"\?`\)\) return;/);
});

test("admin defaults keep queued edits through reloads and debounce the follow-up", () => {
  assert.match(adminScript, /if \(!defaultsLoaded\) \{\s+queueDefaultsSave\(\);\s+return;/);
  assert.match(adminScript, /const scheduleQueuedDefaultsSave = \(loadTarget\) =>/);
  assert.match(adminScript, /const clearDefaultsSaveQueue = \(\) => \{\s+cancelDefaultsSaveSchedule\(\);/);
  assert.match(adminScript, /defaultsEditRevision \+= 1;\s+clearDefaultsSaveQueue\(\);/);
  assert.match(adminScript, /else scheduleDefaultsSave\(\);/);
});

test("unknown public HEAD routes remain 404", async () => {
  const response = await handler(new Request("https://ai.ubq.fi/not-a-real-public-route", { method: "HEAD" }));

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "");
});

test("credentialed root responses retain content-negotiation Vary tokens", async () => {
  const response = await handler(
    new Request("https://ai.ubq.fi/", {
      headers: {
        Accept: "text/html",
        Origin: "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net",
      },
    })
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("vary"), "Accept, Accept-Encoding, Origin");
});

test("JSON root advertises autonomous agent discovery documents", async () => {
  const response = await handleRoot(new Request("https://ai.ubq.fi/", { headers: { Accept: "application/json" } }));
  const body = await response.json();

  assert.equal(response.headers.get("vary"), "Accept, Accept-Encoding");
  assert.equal(body.name, "UbiquityOS AI Gateway");
  assert.equal(body.discovery.llms, "/llms.txt");
  assert.equal(body.discovery.llms_full, "/llms-full.txt");
  assert.equal(body.discovery.openapi, "/openapi.json");
  assert.equal(body.discovery.developers, "/developers");
  assert.equal(body.discovery.sitemap, "/sitemap.xml");
});

test("homepage metadata and agent guidance expose the canonical service identity", () => {
  assert.match(indexHtml, /<html lang="en">/);
  assert.match(indexHtml, /<link rel="canonical" href="https:\/\/ai\.ubq\.fi\/" \/>/);
  assert.match(indexHtml, /<meta property="og:type" content="website" \/>/);
  assert.match(indexHtml, /<meta property="og:image" content="https:\/\/ai\.ubq\.fi\/favicon\.png" \/>/);
  for (const path of ["/developers", "/openapi.json", "/llms.txt", "/llms-full.txt"]) {
    assert.match(indexHtml, new RegExp(`href="${path}"`), `homepage should link ${path}`);
  }
  const jsonLdText = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(indexHtml)?.[1]?.trim();
  if (!jsonLdText) throw new Error("homepage should include JSON-LD");
  const jsonLd = JSON.parse(jsonLdText);
  assert.ok(jsonLd.some((entry: { "@type"?: string }) => entry["@type"] === "SoftwareApplication"));
  assert.ok(jsonLd.some((entry: { "@type"?: string }) => entry["@type"] === "Organization"));
  assert.match(llmsText, /## When to use this service/);
  assert.match(llmsText, /https:\/\/ai\.ubq\.fi\/developers/);
});

test("trust pages and crawl artifacts are public, substantial, and well formed", async () => {
  for (const path of ["/developers", "/about", "/contact", "/privacy"]) {
    const response = await handleStaticAsset(path);
    assert.equal(response?.status, 200, `${path} should be public`);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.ok(response, `${path} should be public`);
    const body = await response.text();
    assert.ok(stripHtmlTags(body).replace(/\s+/g, " ").trim().length >= 500, `${path} should have real text`);
  }

  const robots = await handleStaticAsset("/robots.txt");
  const sitemap = await handleStaticAsset("/sitemap.xml");
  assert.ok(robots, "/robots.txt should be public");
  assert.ok(sitemap, "/sitemap.xml should be public");
  assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(await robots.text(), /Sitemap: https:\/\/ai\.ubq\.fi\/sitemap\.xml/);
  assert.equal(sitemap.headers.get("content-type"), "application/xml; charset=utf-8");
  const sitemapText = await sitemap.text();
  assert.match(sitemapText, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  for (const path of ["", "/developers", "/docs", "/about", "/contact", "/privacy"]) {
    const sitemapPath = path || "/";
    assert.match(sitemapText, new RegExp(`<loc>https://ai\\.ubq\\.fi${sitemapPath}<\\/loc>`));
  }
  assert.match(sitemapText, /<lastmod>2026-08-21<\/lastmod>/);
});

test("public delivery returns structured JSON errors and exposes rate-limit fields to browsers", async () => {
  const missing = await handler(new Request("https://ai.ubq.fi/not-a-real-public-route"));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "application/json");
  const body = await missing.json();
  assert.equal(body.error.code, "not_found");
  assert.match(body.error.message, /Not found/);

  const exposed = new Headers(corsHeaders()).get("Access-Control-Expose-Headers") ?? "";
  for (const header of ["RateLimit", "RateLimit-Policy", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
    assert.match(exposed, new RegExp(header));
  }
});

test("admin passkey sign-in uses discoverable credentials instead of a saved username", () => {
  const loginCall = /const result = await signInWithPasskey\(\{([\s\S]*?)\}\);/.exec(adminScript);
  assert.ok(loginCall);
  assert.doesNotMatch(loginCall[1], /handle:|useHandle:/);
  assert.match(loginCall[1], /baseUrl: getPasskeyBaseUrl\(\)/);
});

test("admin paid-provider wallet display never claims a balance the token endpoint cannot prove", () => {
  // OpenLux's only balance surface answers `unlimited_quota: true` for every
  // token and its granted/available/used totals do not track the real wallet
  // (a confirmed top-up moved them the wrong way), and inference responses carry
  // no balance header. The UI must therefore never render those figures, and
  // must never present the token-scope flag as an unlimited balance.
  assert.doesNotMatch(adminScript, /Unlimited quota/);
  assert.doesNotMatch(adminHtml, /Unlimited quota/);
  assert.doesNotMatch(adminScript, /formatQuotaTokens/);
  assert.doesNotMatch(adminScript, /"Available tokens"|"Granted tokens"|"Used tokens"/);
  assert.doesNotMatch(adminHtml, /Available tokens|Granted tokens|Used tokens/);
  assert.doesNotMatch(adminScript, /meteredQuotaGranted|meteredQuotaTokenUsage/);
  assert.match(adminHtml, /<dt>Balance<\/dt>/);
  // The Analytics Metered capacity row and quota forecast card that carried the
  // removed "Not reported" labels are gone (2026-10-03 trim); the surviving
  // Defaults metered-quota panel must still refuse to report an unprovable balance.
  assert.match(adminScript, /meteredQuotaBalance\.textContent = "Not reported"/);
  // The real, event-derived provider signal and its timestamp survive.
  assert.match(adminScript, /appendProviderFact\(facts, "Inference", status\.health \? providerStateLabel\(status\.health\) : "Not observed"\)/);
  assert.match(adminScript, /appendProviderFact\(facts, "Last response", formatDate\(status\.health\?\.last_observed_at_ms\)\)/);
});
