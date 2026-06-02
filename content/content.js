/*
 * Content script. Injected on toolbar click (along with Readability libs).
 *
 * Responsibilities:
 *  - Detect & extract the article via Mozilla Readability.
 *  - Render an in-page sidebar panel with a loading state.
 *  - Ask the background script for a MiniMax summary and render the result.
 *
 * Re-injection safe: clicking the toolbar button again toggles the panel
 * instead of redeclaring everything (functions only; no top-level const/class).
 */

(function () {
  const PANEL_ID = "article-summarizer-panel";
  const TAB_ID = "article-summarizer-tab";
  const WHATSAPP_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.247-.694.247-1.289.173-1.413z"/></svg>';
  let lastSummary = ""; // full copy text (summary + source line)
  let lastSummaryRaw = ""; // just the model's summary markdown
  let lastSourceLine = ""; // "\n\n<label>: <url>" or ""

  // Provider metadata for the settings UI (kept in sync with background.js).
  const PROVIDERS = {
    minimax: {
      label: "MiniMax",
      models: ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2", "MiniMax-M3"],
      defaultModel: "MiniMax-M2.7",
      hint: "Get a key at platform.minimax.io.",
      keyPattern: /^[A-Za-z0-9._-]{20,}$/,
      keyError: "That doesn't look like a MiniMax key — expected a long token (20+ chars) with no spaces.",
    },
    gemini: {
      label: "Gemini",
      models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3-flash-preview"],
      defaultModel: "gemini-2.5-flash",
      hint: "Get a key at aistudio.google.com/apikey.",
      keyPattern: /^AIza[A-Za-z0-9_-]{35}$/,
      keyError: 'That doesn\'t look like a Gemini key — it should start with "AIza" and be 39 characters.',
    },
  };
  const PROVIDER_ORDER = ["minimax", "gemini"];

  // Validate a key's format. Empty is allowed (means "clear this key").
  function validateKey(provider, key) {
    const value = (key || "").trim();
    if (!value) return { ok: true };
    if (/\s/.test(value)) {
      return { ok: false, message: "The key contains spaces or line breaks — paste only the key." };
    }
    const info = PROVIDERS[provider];
    if (info && info.keyPattern && !info.keyPattern.test(value)) {
      return { ok: false, message: info.keyError };
    }
    return { ok: true };
  }

  // Second+ injection: toggle the existing instance and bail.
  if (window.__articleSummarizer && window.__articleSummarizer.toggle) {
    window.__articleSummarizer.toggle();
    return;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Escape for use inside a double-quoted HTML attribute (e.g. href).
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  // Tracking/analytics query params that only add length to a shared URL.
  const TRACKING_PARAM =
    /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|mc_cid$|mc_eid$|igshid$|_ga$|yclid$|_hsenc$|_hsmi$|vero_id$|oly_enc_id$|oly_anon_id$|ref_src$|guccounter$|guce_referrer|spm$|scm$)/i;

  // Produce a clean URL to share: prefer the page's canonical link, then drop
  // the #fragment and known tracking parameters.
  function cleanUrl() {
    let href = location.href;
    try {
      const canonical = document.querySelector('link[rel="canonical"]');
      if (canonical && canonical.href && /^https?:/i.test(canonical.href)) {
        href = canonical.href;
      }
    } catch (_) {
      /* ignore */
    }
    try {
      const u = new URL(href);
      u.hash = "";
      for (const key of Array.from(u.searchParams.keys())) {
        if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
      }
      return u.toString();
    } catch (_) {
      return href;
    }
  }

  // Inline Markdown: **bold**, __bold__, *italic*. Escapes HTML first.
  function renderInline(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
  }

  // Small Markdown renderer: headings (#..######), ordered & unordered lists,
  // paragraphs, and inline emphasis.
  function renderSummary(text) {
    const lines = text.split(/\r?\n/);
    let html = "";
    let listType = null; // "ol" | "ul" | null
    let inTldr = false; // whether we're inside the highlighted TL;DR box
    const closeList = () => {
      if (listType) {
        html += listType === "ol" ? "</ol>" : "</ul>";
        listType = null;
      }
    };
    const closeTldr = () => {
      if (inTldr) {
        html += "</div>";
        inTldr = false;
      }
    };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        closeList();
        continue;
      }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        closeList();
        closeTldr(); // any new heading ends the TL;DR box
        const level = Math.min(m[1].length, 3); // # → h3, ## → h4, ### → h5
        const tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
        // The "TL;DR" section gets wrapped in a highlighted box.
        if (/tl\s*;?\s*dr/i.test(m[2])) {
          html += `<div class="asz-tldr">`;
          inTldr = true;
        }
        html += `<${tag}>${renderInline(m[2])}</${tag}>`;
      } else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
        if (listType !== "ol") {
          closeList();
          html += "<ol>";
          listType = "ol";
        }
        html += `<li>${renderInline(m[1])}</li>`;
      } else if ((m = line.match(/^[-*•·▪◦‣●○–—]\s+(.*)$/))) {
        if (listType !== "ul") {
          closeList();
          html += "<ul>";
          listType = "ul";
        }
        html += `<li>${renderInline(m[1])}</li>`;
      } else {
        closeList();
        html += `<p>${renderInline(line)}</p>`;
      }
    }
    closeList();
    closeTldr();
    return html;
  }

  function injectStyles() {
    if (document.getElementById("article-summarizer-styles")) return;
    const style = document.createElement("style");
    style.id = "article-summarizer-styles";
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; top: 0; right: 0; height: 100vh; width: 380px;
        max-width: 90vw; background: #ffffff; color: #1a202c;
        box-shadow: -2px 0 16px rgba(0,0,0,0.18); z-index: 2147483647;
        display: flex; flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 15px; line-height: 1.5;
        transform: translateX(0); transition: transform 0.18s ease-out;
      }
      #${PANEL_ID}.asz-hidden { transform: translateX(100%); }
      #${PANEL_ID} * { box-sizing: border-box; }
      /* Force our font on every descendant so host-page rules (e.g. a serif
         "p { font-family: Georgia }") can't leak in and change the panel font. */
      #${PANEL_ID}, #${PANEL_ID} * {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif !important;
      }
      #${PANEL_ID} .asz-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 14px; background: #2b6cb0; color: #fff; flex: 0 0 auto;
      }
      #${PANEL_ID} .asz-header h2 {
        margin: 0; font-size: 15px; font-weight: 600;
        color: #ffffff !important;
      }
      #${PANEL_ID} .asz-actions { display: flex; gap: 6px; align-items: center; }
      #${PANEL_ID} button.asz-btn {
        display: inline-flex; align-items: center; justify-content: center;
        height: 30px; min-width: 34px; padding: 0 10px; line-height: 1;
        background: rgba(255,255,255,0.15); color: #fff; border: none;
        border-radius: 6px; cursor: pointer; font-size: 13px;
      }
      #${PANEL_ID} button.asz-btn:hover { background: rgba(255,255,255,0.3); }
      #${PANEL_ID} button.asz-btn.asz-btn-icon { font-size: 17px; }
      #${PANEL_ID} .asz-body { padding: 16px; overflow-y: auto; flex: 1 1 auto; }
      #${PANEL_ID} .asz-title {
        font-size: 18px; color: #1a202c; margin: 0 0 10px; font-weight: 700;
        line-height: 1.3; word-break: break-word;
      }
      #${PANEL_ID} .asz-share {
        display: flex; gap: 8px; flex-wrap: wrap;
        margin: 0 0 16px; padding-bottom: 14px; border-bottom: 1px solid #e2e8f0;
      }
      #${PANEL_ID} button.asz-share-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: 32px; padding: 0 12px; border: none; border-radius: 6px;
        font-size: 13px; font-weight: 600; cursor: pointer; color: #fff;
        background: #2b6cb0; line-height: 1;
      }
      #${PANEL_ID} button.asz-share-btn:hover { background: #2c5282; }
      #${PANEL_ID} button.asz-share-btn.asz-copied { background: #38a169; }
      #${PANEL_ID} button.asz-share-btn.asz-wa { background: #25d366; color: #0b3d1f; }
      #${PANEL_ID} button.asz-share-btn.asz-wa:hover { background: #1fb457; }
      #${PANEL_ID} button.asz-share-btn svg { width: 15px; height: 15px; display: block; }
      #${PANEL_ID} .asz-wa-wrap { position: relative; display: inline-flex; }
      #${PANEL_ID} .asz-wa-menu {
        display: none; position: absolute; top: calc(100% + 4px); right: 0;
        z-index: 5; min-width: 190px; padding: 4px; background: #ffffff;
        border: 1px solid #e2e8f0; border-radius: 8px;
        box-shadow: 0 6px 18px rgba(0,0,0,0.18);
      }
      #${PANEL_ID} .asz-wa-menu.asz-open { display: flex; flex-direction: column; }
      #${PANEL_ID} .asz-wa-menu button {
        background: transparent; color: #1a202c; border: none; text-align: left;
        padding: 8px 10px; border-radius: 6px; font-size: 13px; cursor: pointer;
      }
      #${PANEL_ID} .asz-wa-menu button:hover { background: #edf2f7; }
      #${PANEL_ID} .asz-body p { margin: 0 0 10px; }
      #${PANEL_ID} .asz-body h3 {
        font-size: 20px; font-weight: 700; margin: 18px 0 8px; color: #2b6cb0;
      }
      #${PANEL_ID} .asz-body h3:first-child { margin-top: 0; }
      #${PANEL_ID} .asz-body h4 {
        font-size: 17px; font-weight: 700; margin: 16px 0 6px; color: #2b6cb0;
      }
      #${PANEL_ID} .asz-body h5 {
        font-size: 15px; font-weight: 700; margin: 12px 0 4px; color: #4a5568;
      }
      /* Force list markers with !important so host-page resets like
         "ul { list-style: none }" can't turn our bullets into plain paragraphs. */
      #${PANEL_ID} .asz-body ul,
      #${PANEL_ID} .asz-body ol {
        margin: 0 0 10px !important; padding-left: 24px !important;
      }
      #${PANEL_ID} .asz-body ul { list-style: disc outside !important; }
      #${PANEL_ID} .asz-body ol { list-style: decimal outside !important; }
      #${PANEL_ID} .asz-body li {
        display: list-item !important; margin: 0 0 6px !important;
        padding: 0 !important; text-indent: 0 !important;
      }
      #${PANEL_ID} .asz-body li::marker { color: #2b6cb0; }
      #${PANEL_ID} .asz-body strong { font-weight: 700; }
      #${PANEL_ID} .asz-body em { font-style: italic; }
      #${PANEL_ID} .asz-tldr {
        background: #ebf4ff; border: 1px solid #bee3f8;
        border-left: 4px solid #2b6cb0; border-radius: 8px;
        padding: 10px 14px; margin: 0 0 14px;
      }
      #${PANEL_ID} .asz-tldr h3,
      #${PANEL_ID} .asz-tldr h4 { margin-top: 0; }
      #${PANEL_ID} .asz-tldr p:last-child { margin-bottom: 0; }
      #${PANEL_ID} .asz-source {
        font-size: 12px; color: #718096; margin-top: 14px;
        border-top: 1px solid #e2e8f0; padding-top: 10px; word-break: break-all;
      }
      #${PANEL_ID} .asz-source a { color: #2b6cb0; text-decoration: underline; }
      #${PANEL_ID} .asz-source a:hover { color: #2c5282; }
      #${PANEL_ID} .asz-note {
        font-size: 12px; color: #718096; margin-top: 14px;
        border-top: 1px solid #e2e8f0; padding-top: 10px;
      }
      #${PANEL_ID} .asz-warn {
        font-size: 13px; color: #975a16; background: #fffaf0;
        border: 1px solid #fbd38d; border-radius: 8px;
        padding: 8px 12px; margin: 0 0 12px;
      }
      #${PANEL_ID} .asz-think {
        margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 12px;
      }
      #${PANEL_ID} .asz-think > summary {
        cursor: pointer; font-size: 13px; font-weight: 600; color: #4a5568;
        user-select: none; outline: none;
      }
      #${PANEL_ID} .asz-think > summary:hover { color: #2b6cb0; }
      #${PANEL_ID} .asz-think[open] > summary { margin-bottom: 8px; }
      #${PANEL_ID} .asz-think-body {
        font-size: 13px; color: #4a5568; line-height: 1.5;
        background: #f7fafc; border-radius: 8px; padding: 10px 12px;
        max-height: 320px; overflow-y: auto;
      }
      #${PANEL_ID} .asz-think-body p { margin: 0 0 8px; }
      #${PANEL_ID} .asz-think-body p:last-child { margin-bottom: 0; }
      #${PANEL_ID} .asz-think-body h3,
      #${PANEL_ID} .asz-think-body h4,
      #${PANEL_ID} .asz-think-body h5 { color: #4a5568; font-size: 13px; }
      #${PANEL_ID} .asz-spinner {
        width: 26px; height: 26px; border: 3px solid #cbd5e0;
        border-top-color: #2b6cb0; border-radius: 50%;
        animation: asz-spin 0.8s linear infinite; margin: 24px auto 12px;
      }
      #${PANEL_ID} .asz-loading-text { text-align: center; color: #4a5568; }
      #${PANEL_ID} .asz-error {
        background: #fff5f5; border: 1px solid #feb2b2; color: #c53030;
        border-radius: 8px; padding: 12px;
      }
      #${PANEL_ID} .asz-error button {
        margin-top: 10px; background: #c53030; color: #fff; border: none;
        border-radius: 6px; padding: 6px 12px; cursor: pointer;
      }
      #${PANEL_ID} .asz-keyform input,
      #${PANEL_ID} .asz-keyform select {
        width: 100%; padding: 9px 10px; font-size: 14px; margin: 6px 0 10px;
        border: 1px solid #cbd5e0; border-radius: 6px; box-sizing: border-box;
        background: #ffffff; color: #1a202c;
      }
      #${PANEL_ID} .asz-keyform button {
        background: #2b6cb0; color: #fff; border: none; border-radius: 6px;
        padding: 9px 14px; font-size: 14px; cursor: pointer;
      }
      #${PANEL_ID} .asz-keyform button:hover { background: #2c5282; }
      #${PANEL_ID} .asz-keyform button.asz-secondary {
        background: #edf2f7; color: #2d3748;
      }
      #${PANEL_ID} .asz-keyform button.asz-secondary:hover { background: #e2e8f0; }
      #${PANEL_ID} .asz-settings-title { margin: 0 0 10px; font-size: 16px; color: #2b6cb0; }
      #${PANEL_ID} .asz-label {
        display: block; font-size: 13px; font-weight: 600; color: #4a5568; margin-top: 4px;
      }
      #${PANEL_ID} .asz-settings-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      #${PANEL_ID} .asz-field-error {
        font-size: 12px; color: #c53030; margin: 8px 0 0; font-weight: 600;
      }
      #${PANEL_ID} button.asz-btn.asz-copied { background: #38a169; }
      @keyframes asz-spin { to { transform: rotate(360deg); } }

      /* Collapsed-state reopen tab: a small blue handle on the right edge. */
      #${TAB_ID} {
        position: fixed; top: 42%; right: 0; z-index: 2147483647;
        display: none; align-items: center; justify-content: center;
        background: #2b6cb0; color: #ffffff !important; cursor: pointer;
        border: none; border-radius: 8px 0 0 8px;
        box-shadow: -2px 0 10px rgba(0,0,0,0.22);
        padding: 12px 5px;
        writing-mode: vertical-rl; text-orientation: mixed;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif !important;
        font-size: 12px; font-weight: 700; letter-spacing: 1px;
        user-select: none; transition: background 0.15s ease;
      }
      #${TAB_ID}.asz-tab-visible { display: flex; }
      #${TAB_ID}:hover { background: #2c5282; }
    `;
    document.documentElement.appendChild(style);
  }

  function buildPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="asz-header">
        <h2>TL;DR Me</h2>
        <div class="asz-actions">
          <button class="asz-btn asz-btn-icon" data-asz="settings" title="Settings (API key &amp; model)">⚙</button>
          <button class="asz-btn asz-btn-icon" data-asz="refresh" title="Summarize again">↻</button>
          <button class="asz-btn asz-btn-icon" data-asz="close" title="Collapse panel">→</button>
        </div>
      </div>
      <div class="asz-body"></div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector('[data-asz="close"]').addEventListener("click", () => {
      window.__articleSummarizer.close();
    });
    panel.querySelector('[data-asz="refresh"]').addEventListener("click", () => {
      run();
    });
    panel.querySelector('[data-asz="settings"]').addEventListener("click", () => {
      showSettings();
    });
    return panel;
  }

  async function copySummary(btn) {
    if (!lastSummary) return;
    try {
      await navigator.clipboard.writeText(lastSummary);
    } catch (_) {
      // Fallback for contexts where the async clipboard API is unavailable.
      const ta = document.createElement("textarea");
      ta.value = lastSummary;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (_) {
        /* give up silently */
      }
      ta.remove();
    }
    if (btn) {
      if (btn._aszCopiedTimer) clearTimeout(btn._aszCopiedTimer);
      btn.textContent = "Copied";
      btn.classList.add("asz-copied");
      btn._aszCopiedTimer = setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("asz-copied");
        btn._aszCopiedTimer = null;
      }, 5000);
    }
  }

  function setBody(html) {
    const panel = buildPanel();
    panel.querySelector(".asz-body").innerHTML = html;
    return panel;
  }

  function showLoading() {
    setBody(
      `<div class="asz-spinner"></div>` +
        `<div class="asz-loading-text">Reading the article and summarizing…</div>`
    );
  }

  function showError(message) {
    setBody(`<div class="asz-error">${escapeHtml(message)}</div>`);
  }

  function providerOptionsHtml(selected) {
    return PROVIDER_ORDER.map(
      (p) =>
        `<option value="${p}"${p === selected ? " selected" : ""}>${escapeHtml(PROVIDERS[p].label)}</option>`
    ).join("");
  }
  function modelOptionsHtml(provider, selectedModel) {
    const info = PROVIDERS[provider];
    const sel = selectedModel || info.defaultModel;
    return info.models
      .map(
        (m) =>
          `<option value="${escapeAttr(m)}"${m === sel ? " selected" : ""}>${escapeHtml(m)}</option>`
      )
      .join("");
  }

  // Shown when no provider key is stored yet — pick a provider and paste a key.
  function showApiKeyForm(message) {
    let provider = "minimax";
    const panel = setBody(
      `<div class="asz-keyform">` +
        `<p>${escapeHtml(message || "Add an API key to get started.")}</p>` +
        `<label class="asz-label">Provider</label>` +
        `<select data-asz="provider">${providerOptionsHtml(provider)}</select>` +
        `<label class="asz-label">API key</label>` +
        `<input type="password" data-asz="key" placeholder="Paste API key" autocomplete="off" />` +
        `<button data-asz="save-key">Save &amp; summarize</button>` +
        `<p class="asz-field-error" data-asz="key-error" hidden></p>` +
        `<p class="asz-note" data-asz="hint">${escapeHtml(PROVIDERS[provider].hint)}</p>` +
        `</div>`
    );
    const providerSel = panel.querySelector('[data-asz="provider"]');
    const input = panel.querySelector('[data-asz="key"]');
    const hint = panel.querySelector('[data-asz="hint"]');
    const errorEl = panel.querySelector('[data-asz="key-error"]');
    const clearError = () => {
      errorEl.hidden = true;
      errorEl.textContent = "";
    };
    providerSel.addEventListener("change", () => {
      provider = providerSel.value;
      hint.textContent = PROVIDERS[provider].hint;
      clearError();
    });
    input.addEventListener("input", clearError);
    const submit = async () => {
      const key = input.value.trim();
      if (!key) {
        input.focus();
        return;
      }
      const check = validateKey(providerSel.value, key);
      if (!check.ok) {
        errorEl.textContent = check.message;
        errorEl.hidden = false;
        input.focus();
        return;
      }
      const resp = await browser.runtime.sendMessage({
        type: "saveApiKey",
        provider: providerSel.value,
        key,
        setActive: true,
      });
      if (resp && resp.ok === false) {
        errorEl.textContent = resp.message || "Could not save the key.";
        errorEl.hidden = false;
        return;
      }
      run();
    };
    panel.querySelector('[data-asz="save-key"]').addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    input.focus();
  }

  // In-app settings: choose the active provider and set/replace its key + model.
  async function showSettings() {
    window.__articleSummarizer.open();
    const stored = await browser.storage.local.get([
      "minimaxApiKey", "geminiApiKey", "minimaxModel", "geminiModel", "activeProvider",
    ]);
    const keyOf = (p) => stored[`${p}ApiKey`] || "";
    let selected = stored.activeProvider;
    if (!selected || !PROVIDERS[selected]) {
      selected = PROVIDER_ORDER.find((p) => keyOf(p)) || "minimax";
    }

    const panel = setBody(
      `<div class="asz-keyform">` +
        `<h3 class="asz-settings-title">Settings</h3>` +
        `<label class="asz-label">Provider</label>` +
        `<select data-asz="provider">${providerOptionsHtml(selected)}</select>` +
        `<div data-asz="provider-fields"></div>` +
        `<div class="asz-settings-actions">` +
        `<button data-asz="save-settings">Save</button>` +
        (lastSummary
          ? `<button class="asz-secondary" data-asz="cancel-settings">Back to summary</button>`
          : "") +
        `</div>` +
        `<p class="asz-note" data-asz="settings-status"></p>` +
        `</div>`
    );

    const providerSel = panel.querySelector('[data-asz="provider"]');
    const fields = panel.querySelector('[data-asz="provider-fields"]');
    const status = panel.querySelector('[data-asz="settings-status"]');

    function renderFields(p) {
      fields.innerHTML =
        `<label class="asz-label">${escapeHtml(PROVIDERS[p].label)} API key</label>` +
        `<input type="password" data-asz="key" value="${escapeAttr(keyOf(p))}" placeholder="Paste API key" autocomplete="off" />` +
        `<label class="asz-label">Model</label>` +
        `<select data-asz="model">${modelOptionsHtml(p, stored[`${p}Model`])}</select>` +
        `<p class="asz-note">${escapeHtml(PROVIDERS[p].hint)} The first key you add becomes the default provider.</p>`;
    }
    renderFields(selected);

    const setStatus = (text, isError) => {
      status.textContent = text;
      status.classList.toggle("asz-field-error", Boolean(isError));
    };

    providerSel.addEventListener("change", () => {
      renderFields(providerSel.value);
      setStatus("", false);
    });

    panel.querySelector('[data-asz="save-settings"]').addEventListener("click", async () => {
      const p = providerSel.value;
      const key = fields.querySelector('[data-asz="key"]').value.trim();
      const model = fields.querySelector('[data-asz="model"]').value;
      const check = validateKey(p, key);
      if (!check.ok) {
        setStatus(check.message, true);
        return;
      }
      const resp = await browser.runtime.sendMessage({
        type: "saveApiKey",
        provider: p,
        key,
        model,
        setActive: true,
      });
      if (resp && resp.ok === false) {
        setStatus(resp.message || "Could not save the key.", true);
        return;
      }
      // Keep the local copy in sync so switching providers shows saved values.
      stored[`${p}ApiKey`] = key;
      stored[`${p}Model`] = model;
      setStatus(
        key
          ? `Saved ✓ — ${PROVIDERS[p].label} is now active.`
          : `Saved ✓ — ${PROVIDERS[p].label} key cleared.`,
        false
      );
    });

    const cancelBtn = panel.querySelector('[data-asz="cancel-settings"]');
    if (cancelBtn) cancelBtn.addEventListener("click", () => run());

    const firstInput = fields.querySelector('[data-asz="key"]');
    if (firstInput) firstInput.focus();
  }

  function showSummary(title, summary, thinking, truncated, url, langWarning, sourceLabel) {
    const srcLabel = sourceLabel || "Source";
    lastSummaryRaw = summary || "";
    lastSourceLine = url ? `\n\n${srcLabel}: ${url}` : "";
    // Copy text = the full summary plus the source line.
    lastSummary = lastSummaryRaw + lastSourceLine;
    let html = title ? `<p class="asz-title">${escapeHtml(title)}</p>` : "";
    if (langWarning) {
      html +=
        `<div class="asz-warn">⚠ This summary may not be in the article's language. ` +
        `Use ↻ to try again.</div>`;
    }
    // Share subsection: Copy + a WhatsApp button with a "what to share" menu.
    html +=
      `<div class="asz-share">` +
      `<button class="asz-share-btn" data-asz="copy" title="Copy summary to clipboard">Copy</button>` +
      `<div class="asz-wa-wrap">` +
      `<button class="asz-share-btn asz-wa" data-asz="whatsapp" title="Share via WhatsApp" aria-haspopup="true">` +
      WHATSAPP_ICON +
      `WhatsApp ▾</button>` +
      `<div class="asz-wa-menu" data-asz="wa-menu">` +
      `<button data-asz="wa-tldr">TL;DR only</button>` +
      `<button data-asz="wa-full">TL;DR + Key points</button>` +
      `</div>` +
      `</div>` +
      `</div>`;
    html += summary
      ? renderSummary(summary)
      : `<p><em>The model returned only reasoning — see below.</em></p>`;
    if (url) {
      html +=
        `<div class="asz-source">${escapeHtml(srcLabel)}: ` +
        `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>` +
        `</div>`;
    }
    if (thinking && thinking.trim()) {
      html +=
        `<details class="asz-think">` +
        `<summary>Show model reasoning</summary>` +
        `<div class="asz-think-body">${renderSummary(thinking)}</div>` +
        `</details>`;
    }
    if (truncated) {
      html +=
        `<div class="asz-note">Note: the article was long and was truncated before summarizing.</div>`;
    }
    const panel = setBody(html);
    panel.querySelector('[data-asz="copy"]').addEventListener("click", (e) => {
      copySummary(e.currentTarget);
    });

    // WhatsApp button opens a small menu to pick what to share.
    const waBtn = panel.querySelector('[data-asz="whatsapp"]');
    const waMenu = panel.querySelector('[data-asz="wa-menu"]');
    const closeMenu = () => {
      waMenu.classList.remove("asz-open");
      document.removeEventListener("click", onDocClick, true);
    };
    function onDocClick(e) {
      if (!waMenu.isConnected) {
        document.removeEventListener("click", onDocClick, true);
        return;
      }
      if (!waMenu.parentElement.contains(e.target)) closeMenu();
    }
    waBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (waMenu.classList.contains("asz-open")) {
        closeMenu();
      } else {
        waMenu.classList.add("asz-open");
        document.addEventListener("click", onDocClick, true);
      }
    });
    panel.querySelector('[data-asz="wa-tldr"]').addEventListener("click", () => {
      shareWhatsApp("tldr");
      closeMenu();
    });
    panel.querySelector('[data-asz="wa-full"]').addEventListener("click", () => {
      shareWhatsApp("full");
      closeMenu();
    });
  }

  // Pull just the "## TL;DR" section (heading + its text, up to the next
  // heading) out of the summary markdown. Falls back to the whole thing.
  function extractTldrSection(md) {
    const lines = (md || "").split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^#{1,6}\s+.*tl\s*;?\s*dr/i.test(lines[i].trim())) {
        start = i;
        break;
      }
    }
    if (start === -1) return (md || "").trim();
    const out = [lines[start]];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,6}\s+/.test(lines[i].trim())) break; // next heading ends section
      out.push(lines[i]);
    }
    return out.join("\n").trim();
  }

  // Convert summary Markdown to WhatsApp-friendly plain text: drop heading
  // markers (keep the heading text) and turn **bold** into WhatsApp *bold*.
  function toWhatsAppText(md) {
    return (md || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      .trim();
  }

  // Open the installed WhatsApp app via its URL scheme with the chosen text
  // prefilled; the user picks the recipient inside WhatsApp. `variant` is
  // "tldr" (TL;DR only) or "full" (TL;DR + key points). Both include the URL.
  function shareWhatsApp(variant) {
    if (!lastSummaryRaw) return;
    const body = variant === "tldr" ? extractTldrSection(lastSummaryRaw) : lastSummaryRaw;
    const text = toWhatsAppText(body) + lastSourceLine;
    const a = document.createElement("a");
    a.href = "whatsapp://send?text=" + encodeURIComponent(text);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Extract the article. Returns { title, text, lang } or null.
  function extractArticle() {
    try {
      if (typeof isProbablyReaderable === "function" && !isProbablyReaderable(document)) {
        return null;
      }
      const docClone = document.cloneNode(true);
      const reader = new Readability(docClone);
      const result = reader.parse();
      if (!result || !result.textContent || result.textContent.trim().length < 200) {
        return null;
      }
      return {
        title: result.title || document.title || "",
        text: result.textContent.trim(),
        lang: document.documentElement.lang || "",
      };
    } catch (e) {
      console.error("Article Summarizer: extraction failed", e);
      return null;
    }
  }

  async function run() {
    window.__articleSummarizer.open();
    showLoading();

    const article = extractArticle();
    if (!article) {
      showError(
        "This page doesn't look like an article, or the main text couldn't be detected."
      );
      return;
    }

    try {
      const resp = await browser.runtime.sendMessage({
        type: "summarize",
        title: article.title,
        text: article.text,
        lang: article.lang,
      });
      if (!resp) {
        showError("No response from the extension background.");
        return;
      }
      if (resp.ok) {
        showSummary(
          article.title,
          resp.summary,
          resp.thinking,
          resp.truncated,
          cleanUrl(),
          resp.langWarning,
          resp.sourceLabel
        );
      } else if (resp.error === "NO_API_KEY") {
        showApiKeyForm(resp.message);
      } else {
        showError(resp.message || "Something went wrong.");
      }
    } catch (e) {
      showError(`Could not reach the summarizer: ${e && e.message ? e.message : e}`);
    }
  }

  // The small blue handle shown on the right edge while the panel is collapsed.
  function buildReopenTab() {
    let tab = document.getElementById(TAB_ID);
    if (tab) return tab;
    tab = document.createElement("div");
    tab.id = TAB_ID;
    tab.title = "Show TL;DR summary";
    tab.textContent = "TL;DR";
    document.documentElement.appendChild(tab);
    tab.addEventListener("click", () => {
      // If we already have a panel (even collapsed), reveal it with its existing
      // summary. Otherwise this is a fresh page → summarize now.
      if (document.getElementById(PANEL_ID)) {
        window.__articleSummarizer.open();
      } else {
        run();
      }
    });
    return tab;
  }

  // Public toggle/open/close API stored on window so re-injection can find it.
  window.__articleSummarizer = {
    open() {
      injectStyles();
      const panel = buildPanel();
      panel.classList.remove("asz-hidden");
      const tab = document.getElementById(TAB_ID);
      if (tab) tab.classList.remove("asz-tab-visible");
    },
    close() {
      injectStyles();
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.classList.add("asz-hidden");
      buildReopenTab().classList.add("asz-tab-visible");
    },
    toggle() {
      const panel = document.getElementById(PANEL_ID);
      if (panel && !panel.classList.contains("asz-hidden")) {
        this.close(); // open → collapse
      } else if (panel && lastSummary) {
        this.open(); // collapsed with a cached summary → just reveal it
      } else {
        run(); // nothing yet → fetch + summarize
      }
    },
  };

  // First injection is always a deliberate action (toolbar button or a click on
  // the on-page tab), so fetch + summarize right away.
  run();
})();
