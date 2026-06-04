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
  // Small brand mark shown in the header (white "summary lines" glyph).
  const HEADER_LOGO =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<rect x="5" y="6" width="14" height="2.2" rx="1.1" fill="#fff"/>' +
    '<rect x="5" y="11" width="14" height="2.2" rx="1.1" fill="#fff" opacity="0.85"/>' +
    '<rect x="5" y="16" width="9" height="2.2" rx="1.1" fill="#fff" opacity="0.7"/>' +
    "</svg>";
  let lastSummary = ""; // full copy text (summary + source line)
  let lastSummaryRaw = ""; // just the model's summary markdown
  let lastSourceLine = ""; // "\n\n<label>: <url>" or ""
  let lastDeeper = null; // cached "Go deeper" provocations [{q, a}] for this article
  let currentUrl = ""; // clean URL of the article currently shown (cache key)

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

  // Localized UI strings, keyed by the article's language code. English fallback.
  const UI_STRINGS = {
    en: { reading: "Reading the article and summarizing…", thinking: "Thinking of questions worth chewing on…", chewTitle: "Questions to chew on", seePerspective: "See a perspective", goDeeper: "Go deeper — questions to think about", source: "Source", fullArticle: "Full article", summaryHeading: "Summary" },
    es: { reading: "Leyendo el artículo y resumiendo…", thinking: "Pensando en preguntas para reflexionar…", chewTitle: "Preguntas para reflexionar", seePerspective: "Ver una perspectiva", goDeeper: "Profundizar — preguntas para pensar", source: "Fuente", fullArticle: "Artículo completo", summaryHeading: "Resumen" },
    pt: { reading: "Lendo o artigo e resumindo…", thinking: "Pensando em perguntas para refletir…", chewTitle: "Perguntas para refletir", seePerspective: "Ver uma perspetiva", goDeeper: "Aprofundar — perguntas para pensar", source: "Fonte", fullArticle: "Artigo completo", summaryHeading: "Resumo" },
    fr: { reading: "Lecture de l'article et résumé…", thinking: "Je réfléchis à des questions à méditer…", chewTitle: "Questions à méditer", seePerspective: "Voir une perspective", goDeeper: "Aller plus loin — questions à se poser", source: "Source", fullArticle: "Article complet", summaryHeading: "Résumé" },
    de: { reading: "Artikel wird gelesen und zusammengefasst…", thinking: "Ich überlege Fragen zum Nachdenken…", chewTitle: "Fragen zum Nachdenken", seePerspective: "Eine Perspektive ansehen", goDeeper: "Tiefer gehen — Fragen zum Nachdenken", source: "Quelle", fullArticle: "Vollständiger Artikel", summaryHeading: "Zusammenfassung" },
    it: { reading: "Lettura dell'articolo e riassunto…", thinking: "Sto pensando a domande su cui riflettere…", chewTitle: "Domande su cui riflettere", seePerspective: "Vedi una prospettiva", goDeeper: "Approfondisci — domande su cui riflettere", source: "Fonte", fullArticle: "Articolo completo", summaryHeading: "Riepilogo" },
  };

  function uiLang() {
    return ((document.documentElement.lang || "").split("-")[0] || "").toLowerCase();
  }
  function t(key) {
    const lang = uiLang();
    return (UI_STRINGS[lang] && UI_STRINGS[lang][key]) || UI_STRINGS.en[key];
  }

  // Tracking/analytics query params that only add length to a shared URL.
  const TRACKING_PARAM =
    /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|mc_cid$|mc_eid$|igshid$|_ga$|yclid$|_hsenc$|_hsmi$|vero_id$|oly_enc_id$|oly_anon_id$|ref_src$|guccounter$|guce_referrer|spm$|scm$)/i;

  // Produce a clean URL to share: prefer the page's canonical link, unwrap
  // archive/proxy wrappers to the real article URL, then drop the #fragment and
  // known tracking parameters.
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
    href = unwrapUrl(href);
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

  // Unwrap archive/proxy URLs that embed the original article URL
  // (e.g. archive.is/<ts>/https://nytimes.com/…, web.archive.org/web/…,
  // 12ft.io/proxy?q=https://…). Returns the inner URL. Besides being the real
  // article link, this removes the nested "https://" that breaks WhatsApp's
  // text sharing (it collapses such messages to just the URL).
  function unwrapUrl(href) {
    try {
      // Inner URL embedded in the path: take from the first nested scheme.
      const inPath = href.match(/^https?:\/\/[^?#]*?(https?:\/\/.+)$/i);
      if (inPath) return decodeURIComponent(inPath[1]);
      // Inner URL passed as a query value: ?url=… / ?q=… / ?u=…
      const q = href.match(/[?&](?:url|u|q|target)=([^&]+)/i);
      if (q) {
        const decoded = decodeURIComponent(q[1]);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    } catch (_) {
      /* fall through */
    }
    return href;
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
        max-width: 90vw; color: #1a202c;
        /* Lightly frosted pane: a faint hint of what's behind, but mostly
           opaque so text stays high-contrast and easy to read. */
        background: rgba(255, 255, 255, 0.9);
        backdrop-filter: blur(4px) saturate(1.05);
        -webkit-backdrop-filter: blur(4px) saturate(1.05);
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
        padding: 11px 14px; flex: 0 0 auto; color: #fff;
        background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%);
        box-shadow: inset 0 -1px 0 rgba(255,255,255,0.12),
          0 4px 14px rgba(30,58,138,0.28);
      }
      #${PANEL_ID} .asz-brand { display: flex; align-items: center; gap: 9px; }
      #${PANEL_ID} .asz-logo {
        width: 26px; height: 26px; flex: 0 0 auto; border-radius: 8px;
        background: rgba(255,255,255,0.16);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18);
        display: inline-flex; align-items: center; justify-content: center;
      }
      #${PANEL_ID} .asz-logo svg { width: 16px; height: 16px; display: block; }
      #${PANEL_ID} .asz-header h2 {
        margin: 0; font-size: 15px; font-weight: 700; letter-spacing: 0.2px;
        color: #ffffff !important;
      }
      #${PANEL_ID} .asz-actions { display: flex; gap: 6px; align-items: center; }
      #${PANEL_ID} button.asz-btn {
        display: inline-flex; align-items: center; justify-content: center;
        height: 30px; min-width: 34px; padding: 0 10px; line-height: 1;
        background: rgba(255,255,255,0.14); color: #fff;
        border: 1px solid rgba(255,255,255,0.2); border-radius: 8px;
        cursor: pointer; font-size: 13px;
        transition: background 0.15s ease, transform 0.05s ease;
      }
      #${PANEL_ID} button.asz-btn:hover { background: rgba(255,255,255,0.28); }
      #${PANEL_ID} button.asz-btn:active { transform: translateY(1px); }
      #${PANEL_ID} button.asz-btn.asz-btn-icon { font-size: 17px; }
      #${PANEL_ID} .asz-model-badge {
        display: inline-flex; align-items: center; justify-content: center;
        height: 30px; min-width: 30px; font-size: 17px; line-height: 1;
        cursor: default; user-select: none;
      }
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
      #${PANEL_ID} button.asz-share-btn.asz-print { background: #475569; color: #ffffff; }
      #${PANEL_ID} button.asz-share-btn.asz-print:hover { background: #334155; }
      #${PANEL_ID} button.asz-share-btn.asz-wa { background: #25d366; color: #ffffff; }
      #${PANEL_ID} button.asz-share-btn.asz-wa:hover { background: #1fb457; }
      #${PANEL_ID} button.asz-share-btn svg { width: 16px; height: 16px; display: block; }
      #${PANEL_ID} button.asz-share-btn .asz-caret { font-size: 10px; opacity: 0.85; margin-left: 1px; }
      #${PANEL_ID} .asz-wa-wrap { position: relative; display: inline-flex; }
      #${PANEL_ID} .asz-wa-menu {
        display: none; position: absolute; top: calc(100% + 6px); left: 0;
        z-index: 5; min-width: 196px; padding: 5px; background: #ffffff;
        border: 1px solid #e2e8f0; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.16);
      }
      #${PANEL_ID} .asz-wa-menu.asz-open { display: flex; flex-direction: column; }
      #${PANEL_ID} .asz-wa-menu-title {
        font-size: 11px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.04em; color: #a0aec0; padding: 6px 10px 4px;
      }
      #${PANEL_ID} .asz-wa-menu button {
        background: transparent; color: #1a202c; border: none; text-align: left;
        padding: 9px 10px; border-radius: 6px; font-size: 13px; line-height: 1.3;
        cursor: pointer; white-space: nowrap; width: 100%;
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
      /* "Go deeper" provocations layer */
      #${PANEL_ID} .asz-deeper { margin: 14px 0 0; }
      #${PANEL_ID} button.asz-deeper-btn {
        width: 100%; padding: 11px 12px; border: 1px dashed #cbd5e0;
        border-radius: 10px; background: #f7fafc; color: #2b6cb0;
        font-size: 14px; font-weight: 600; cursor: pointer; text-align: center;
      }
      #${PANEL_ID} button.asz-deeper-btn:hover { background: #edf4ff; border-color: #2b6cb0; }
      #${PANEL_ID} .asz-deeper-title {
        font-size: 13px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.04em; color: #718096; margin: 6px 0 10px;
      }
      #${PANEL_ID} .asz-prov {
        border-left: 3px solid #cbd5e0; padding: 2px 0 2px 12px; margin: 0 0 14px;
      }
      #${PANEL_ID} .asz-prov-q {
        font-size: 15px; font-weight: 400; font-style: italic; color: #4a5568;
        margin: 0 0 6px;
      }
      #${PANEL_ID} .asz-prov-a > summary {
        cursor: pointer; font-size: 12px; font-weight: 600; color: #2b6cb0;
        user-select: none; outline: none;
      }
      #${PANEL_ID} .asz-prov-a > summary:hover { color: #2c5282; }
      #${PANEL_ID} .asz-prov-a[open] > summary { margin-bottom: 6px; }
      #${PANEL_ID} .asz-prov-a > div { font-size: 13px; color: #4a5568; }
      #${PANEL_ID} .asz-prov-a > div p { margin: 0 0 6px; }
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
      #${PANEL_ID} .asz-loading-text {
        text-align: center; color: #a0aec0; font-style: italic; font-size: 13px;
      }
      #${PANEL_ID} .asz-error {
        background: #fff5f5; border: 1px solid #feb2b2; color: #c53030;
        border-radius: 8px; padding: 12px;
      }
      #${PANEL_ID} .asz-error button {
        margin-top: 10px; background: #c53030; color: #fff; border: none;
        border-radius: 6px; padding: 6px 12px; cursor: pointer;
      }
      #${PANEL_ID} .asz-keyform input:not([type="radio"]):not([type="checkbox"]),
      #${PANEL_ID} .asz-keyform select {
        width: 100%; padding: 9px 10px; font-size: 14px; margin: 6px 0 10px;
        border: 1px solid #cbd5e0; border-radius: 6px; box-sizing: border-box;
        background: #ffffff; color: #1a202c;
      }
      /* Native radios/checkboxes — defeat the rule above and any host-page
         input{width:100%} leakage that would stretch/center them. */
      #${PANEL_ID} .asz-keyform input[type="radio"],
      #${PANEL_ID} .asz-keyform input[type="checkbox"] {
        width: auto !important; height: auto !important; margin: 0 !important;
        padding: 0 !important; flex: 0 0 auto !important; box-shadow: none !important;
        appearance: auto; -webkit-appearance: auto;
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
      #${PANEL_ID} .asz-provider-list {
        margin: 4px 0 6px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;
      }
      #${PANEL_ID} .asz-prov-row {
        display: flex !important; flex-direction: row !important;
        align-items: center !important; justify-content: flex-start !important;
        text-align: left !important; gap: 9px; padding: 9px 11px; width: 100%;
        font-size: 13px; cursor: pointer; background: #ffffff; box-sizing: border-box;
      }
      #${PANEL_ID} .asz-prov-row + .asz-prov-row { border-top: 1px solid #edf2f7; }
      #${PANEL_ID} .asz-prov-name { font-weight: 600; color: #1a202c; }
      #${PANEL_ID} .asz-prov-status {
        margin-left: auto; font-size: 12px; color: #718096; white-space: nowrap;
      }
      #${PANEL_ID} .asz-prov-row.asz-disabled { cursor: default; }
      #${PANEL_ID} .asz-prov-row.asz-disabled .asz-prov-name,
      #${PANEL_ID} .asz-prov-row.asz-disabled .asz-prov-status { color: #a0aec0; }
      #${PANEL_ID} .asz-check {
        display: flex !important; flex-direction: row !important;
        align-items: center !important; justify-content: flex-start !important;
        text-align: left !important; gap: 8px; font-size: 13px;
        color: #2d3748; margin: 8px 0 0; cursor: pointer; font-weight: 600;
      }
      #${PANEL_ID} .asz-status {
        font-size: 12px; color: #2f855a; margin: 10px 0 0; font-weight: 600;
      }
      #${PANEL_ID} .asz-status:empty { margin: 0; }
      /* Declared last so it wins when an element has both status + error. */
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
        <div class="asz-brand">
          <span class="asz-logo">${HEADER_LOGO}</span>
          <h2>TL;DR&nbsp;Me</h2>
        </div>
        <div class="asz-actions">
          <span class="asz-model-badge" data-asz="model-badge" title="Checking active model…" aria-label="Active model">🤖</span>
          <button class="asz-btn asz-btn-icon" data-asz="settings" title="Settings (API key &amp; model)">⚙</button>
          <button class="asz-btn asz-btn-icon" data-asz="refresh" title="Regenerate (ignore the saved summary)">↻</button>
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
      run(true); // ↻ forces a fresh summary, bypassing the cache
    });
    panel.querySelector('[data-asz="settings"]').addEventListener("click", () => {
      showSettings();
    });
    updateModelBadge();
    return panel;
  }

  // Fill the robot badge's tooltip with the active provider + model, so hovering
  // shows which model is in use without opening Settings.
  async function updateModelBadge() {
    const el = document.querySelector(`#${PANEL_ID} [data-asz="model-badge"]`);
    if (!el) return;
    try {
      const s = await browser.storage.local.get([
        "minimaxApiKey", "geminiApiKey", "minimaxModel", "geminiModel", "activeProvider",
      ]);
      const keyOf = (p) => (s[`${p}ApiKey`] || "").trim();
      let p = s.activeProvider;
      if (!p || !PROVIDERS[p] || !keyOf(p)) p = PROVIDER_ORDER.find((x) => keyOf(x)) || null;
      if (!p) {
        el.title = "No model configured — open Settings (⚙)";
        return;
      }
      const model = s[`${p}Model`] || PROVIDERS[p].defaultModel;
      el.title = `Active model: ${PROVIDERS[p].label} · ${model}`;
    } catch (_) {
      el.title = "Active model";
    }
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
        `<div class="asz-loading-text">${escapeHtml(t("reading"))}</div>`
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
    const keyOf = (p) => (stored[`${p}ApiKey`] || "").trim();
    const configured = () => PROVIDER_ORDER.filter((p) => keyOf(p));
    const activeProvider = () => {
      let a = stored.activeProvider;
      if (!a || !PROVIDERS[a] || !keyOf(a)) a = configured()[0] || null;
      return a;
    };
    let selected = activeProvider() || "minimax";

    const panel = setBody(
      `<div class="asz-keyform">` +
        `<h3 class="asz-settings-title">Settings</h3>` +
        `<label class="asz-label">Default provider</label>` +
        `<div class="asz-provider-list" data-asz="provider-list"></div>` +
        `<label class="asz-label">Add or change a key</label>` +
        `<select data-asz="provider">${providerOptionsHtml(selected)}</select>` +
        `<div data-asz="provider-fields"></div>` +
        `<div class="asz-settings-actions">` +
        `<button data-asz="save-settings">Save</button>` +
        (lastSummary
          ? `<button class="asz-secondary" data-asz="cancel-settings">Cancel</button>`
          : "") +
        `</div>` +
        `<p class="asz-status" data-asz="settings-status"></p>` +
        `</div>`
    );

    const listEl = panel.querySelector('[data-asz="provider-list"]');
    const providerSel = panel.querySelector('[data-asz="provider"]');
    const fields = panel.querySelector('[data-asz="provider-fields"]');
    const status = panel.querySelector('[data-asz="settings-status"]');
    const setStatus = (text, isError) => {
      status.textContent = text;
      status.classList.toggle("asz-field-error", Boolean(isError));
    };

    // The provider list: which providers have a key + a radio to pick the default.
    function renderList() {
      const act = activeProvider();
      listEl.innerHTML = PROVIDER_ORDER.map((p) => {
        const has = keyOf(p);
        return (
          `<label class="asz-prov-row${has ? "" : " asz-disabled"}">` +
          `<input type="radio" name="asz-default" value="${p}"${p === act ? " checked" : ""}${has ? "" : " disabled"}>` +
          `<span class="asz-prov-name">${escapeHtml(PROVIDERS[p].label)}</span>` +
          `<span class="asz-prov-status">${has ? "key set" : "no key"}</span>` +
          `</label>`
        );
      }).join("");
      listEl.querySelectorAll('input[name="asz-default"]').forEach((r) => {
        r.addEventListener("change", async () => {
          const resp = await browser.runtime.sendMessage({
            type: "setDefaultProvider",
            provider: r.value,
          });
          if (resp && resp.ok) {
            stored.activeProvider = r.value;
            setStatus(`Default set to ${PROVIDERS[r.value].label}.`, false);
            updateModelBadge();
            renderFields(providerSel.value);
          } else {
            setStatus((resp && resp.message) || "Could not set default.", true);
            renderList();
          }
        });
      });
    }

    // The add/edit form for the selected provider. The default provider is
    // chosen via the radio list above, not here.
    function renderFields(p) {
      const noKeysAtAll = configured().length === 0;
      const firstKeyNote = noKeysAtAll
        ? `<p class="asz-note">This will be your default provider.</p>`
        : "";
      fields.innerHTML =
        `<label class="asz-label">${escapeHtml(PROVIDERS[p].label)} API key</label>` +
        `<input type="password" data-asz="key" value="${escapeAttr(keyOf(p))}" placeholder="Paste API key" autocomplete="off" />` +
        `<label class="asz-label">Model</label>` +
        `<select data-asz="model">${modelOptionsHtml(p, stored[`${p}Model`])}</select>` +
        firstKeyNote +
        `<p class="asz-note">${escapeHtml(PROVIDERS[p].hint)}</p>`;
    }

    renderList();
    renderFields(selected);

    providerSel.addEventListener("change", () => {
      renderFields(providerSel.value);
      setStatus("", false);
    });

    panel.querySelector('[data-asz="save-settings"]').addEventListener("click", async () => {
      const p = providerSel.value;
      const key = fields.querySelector('[data-asz="key"]').value.trim();
      const model = fields.querySelector('[data-asz="model"]').value;
      // The default provider is set via the radio list, not here. The backend
      // still auto-defaults the very first key that gets saved.
      const makeDefault = false;
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
        makeDefault,
      });
      if (resp && resp.ok === false) {
        setStatus(resp.message || "Could not save the key.", true);
        return;
      }
      stored[`${p}ApiKey`] = key;
      stored[`${p}Model`] = model;
      if (resp && "activeProvider" in resp) stored.activeProvider = resp.activeProvider || "";
      renderList();
      renderFields(providerSel.value);
      updateModelBadge();
      setStatus(
        key
          ? `Saved ✓ — ${PROVIDERS[p].label} key updated.`
          : `Saved ✓ — ${PROVIDERS[p].label} key cleared.`,
        false
      );
    });

    const cancelBtn = panel.querySelector('[data-asz="cancel-settings"]');
    if (cancelBtn) cancelBtn.addEventListener("click", () => run());

    const firstInput = fields.querySelector('[data-asz="key"]');
    if (firstInput) firstInput.focus();
  }

  function showSummary(title, summary, thinking, truncated, url, langWarning, sourceLabel, outputTruncated) {
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
    if (outputTruncated) {
      html +=
        `<div class="asz-warn">⚠ The summary may be cut short (the model hit its length limit). ` +
        `Use ↻ to try again.</div>`;
    }
    // Share subsection: Copy + a WhatsApp button with a "what to share" menu.
    html +=
      `<div class="asz-share">` +
      `<button class="asz-share-btn" data-asz="copy" title="Copy summary to clipboard">Copy</button>` +
      `<button class="asz-share-btn asz-print" data-asz="print" title="Print or save as PDF (summary + full article)">Print</button>` +
      `<div class="asz-wa-wrap">` +
      `<button class="asz-share-btn asz-wa" data-asz="whatsapp" title="Share via WhatsApp" aria-haspopup="true">` +
      WHATSAPP_ICON +
      `Share<span class="asz-caret" aria-hidden="true">▾</span></button>` +
      `<div class="asz-wa-menu" data-asz="wa-menu">` +
      `<div class="asz-wa-menu-title">Share to WhatsApp</div>` +
      `<button data-asz="wa-tldr">TL;DR only</button>` +
      `<button data-asz="wa-full">TL;DR + Key points</button>` +
      `</div>` +
      `</div>` +
      `</div>`;
    html += summary
      ? renderSummary(summary)
      : `<p><em>The model returned only reasoning — see below.</em></p>`;
    // "Go deeper" — opt-in third layer of provocations (rendered on click).
    if (summary) {
      html += `<div class="asz-deeper" data-asz="deeper"></div>`;
    }
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
    panel.querySelector('[data-asz="print"]').addEventListener("click", printSummary);

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

    // "Go deeper" layer.
    const deeper = panel.querySelector('[data-asz="deeper"]');
    if (deeper) renderDeeperButton(deeper);
  }

  // ---- "Go deeper": reader provocations to think with ----

  function renderDeeperButton(container) {
    container.innerHTML =
      `<button class="asz-deeper-btn" data-asz="go-deeper">` +
      `💭 ${escapeHtml(t("goDeeper"))}</button>`;
    container
      .querySelector('[data-asz="go-deeper"]')
      .addEventListener("click", () => goDeeper(container));
  }

  // Parse the model's "Q: …\nA: …" output into {q, a} pairs.
  function parseDeeper(text) {
    const items = [];
    let cur = null;
    for (const raw of (text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const qm = line.match(/^Q:\s*(.*)$/i);
      const am = line.match(/^A:\s*(.*)$/i);
      if (qm) {
        if (cur) items.push(cur);
        cur = { q: qm[1], a: "" };
      } else if (am && cur) {
        cur.a = (cur.a ? cur.a + " " : "") + am[1];
      } else if (cur) {
        cur.a = (cur.a ? cur.a + " " : "") + line; // continuation
      }
    }
    if (cur) items.push(cur);
    return items.filter((it) => it.q);
  }

  function renderDeeper(container, items) {
    let html = `<div class="asz-deeper-title">${escapeHtml(t("chewTitle"))}</div>`;
    for (const it of items) {
      html +=
        `<div class="asz-prov">` +
        `<p class="asz-prov-q">${renderInline(it.q)}</p>` +
        (it.a
          ? `<details class="asz-prov-a"><summary>${escapeHtml(t("seePerspective"))}</summary>` +
            `<div>${renderSummary(it.a)}</div></details>`
          : "") +
        `</div>`;
    }
    container.innerHTML = html;
  }

  async function goDeeper(container) {
    // Already have them (freshly generated or restored from cache) → just render.
    if (lastDeeper && lastDeeper.length) {
      renderDeeper(container, lastDeeper);
      return;
    }
    container.innerHTML =
      `<div class="asz-spinner"></div>` +
      `<div class="asz-loading-text">${escapeHtml(t("thinking"))}</div>`;

    const article = extractArticle();
    if (!article) {
      container.innerHTML = `<div class="asz-error">Couldn't read the article to go deeper.</div>`;
      return;
    }
    try {
      const resp = await browser.runtime.sendMessage({
        type: "discuss",
        title: article.title,
        text: article.text,
        lang: article.lang,
      });
      if (!resp || !resp.ok) {
        if (resp && resp.error === "NO_API_KEY") {
          showApiKeyForm(resp.message);
          return;
        }
        container.innerHTML = `<div class="asz-error">${escapeHtml(
          (resp && resp.message) || "Couldn't generate deeper questions."
        )}</div>`;
        return;
      }
      const items = parseDeeper(resp.text);
      if (!items.length) {
        container.innerHTML = `<div class="asz-error">No questions came back — try again.</div>`;
        return;
      }
      lastDeeper = items;
      if (currentUrl) mergeDeeperIntoCache(currentUrl, items);
      renderDeeper(container, items);
    } catch (e) {
      container.innerHTML = `<div class="asz-error">Could not reach the model: ${escapeHtml(
        e && e.message ? e.message : String(e)
      )}</div>`;
    }
  }

  // Persist provocations alongside the cached summary so reopening is instant.
  async function mergeDeeperIntoCache(url, items) {
    try {
      const data = await browser.storage.local.get(CACHE_STORE_KEY);
      const map = data[CACHE_STORE_KEY] || {};
      if (map[url]) {
        map[url].deeper = items;
        await browser.storage.local.set({ [CACHE_STORE_KEY]: map });
      }
    } catch (_) {
      /* best-effort */
    }
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

  // Share the chosen text to WhatsApp with the full summary prefilled; the user
  // picks the recipient inside WhatsApp. `variant` is "tldr" (TL;DR only) or
  // "full" (TL;DR + key points). Both include the article URL.
  //
  // Uses the whatsapp:// scheme via a transient anchor click. This passes the
  // text VERBATIM to the installed app — the https://wa.me/ handoff on desktop
  // was stripping everything except the URL, so we deliberately avoid it.
  function shareWhatsApp(variant) {
    if (!lastSummaryRaw) return;
    const body = variant === "tldr" ? extractTldrSection(lastSummaryRaw) : lastSummaryRaw;
    // Footer goes LAST so WhatsApp builds its link preview from the article URL
    // (which appears earlier in lastSourceLine), not from the GitHub link.
    const footer = "\n\n(summarized with TL;DR Me: https://github.com/ellokojavi/tldr-me)";
    const text = toWhatsAppText(body) + lastSourceLine + footer;
    const a = document.createElement("a");
    a.href = "whatsapp://send?text=" + encodeURIComponent(text);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---- Print / save-as-PDF ----

  // Turn Readability's structured HTML into clean, print-friendly markup:
  // keep the document structure (paragraphs, headings, lists, quotes) but strip
  // media (often lazy-loaded / broken in print), scripts, and inline
  // styles/classes/handlers. Falls back to paragraph-split plain text.
  function articleHtmlForPrint(contentHtml, text) {
    if (contentHtml) {
      try {
        const tmp = document.createElement("div");
        tmp.innerHTML = contentHtml; // setting innerHTML never executes scripts
        tmp
          .querySelectorAll(
            "script,style,noscript,img,picture,source,figure,figcaption," +
              "video,audio,iframe,svg,canvas,button,form,input,object,embed,link"
          )
          .forEach((el) => el.remove());
        // Strip presentational/JS attributes; keep structural ones like href.
        tmp.querySelectorAll("*").forEach((el) => {
          for (const attr of Array.from(el.attributes)) {
            const n = attr.name.toLowerCase();
            if (n === "style" || n === "class" || n === "id" || n.startsWith("on")) {
              el.removeAttribute(attr.name);
            }
          }
        });
        const out = tmp.innerHTML.trim();
        if (out) return out;
      } catch (_) {
        /* fall through to plain-text */
      }
    }
    const paras = (text || "")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join("");
    return paras || `<p><em>The full article text could not be extracted.</em></p>`;
  }

  // Build a standalone, print-friendly HTML document: title + source, the
  // summary (TL;DR + Key points), the "Go deeper" questions & perspectives if
  // generated, then a divider and the full article (with its structure intact).
  function buildPrintDoc() {
    const article = extractArticle(); // {title, text, lang} or null
    const docTitle =
      (article && article.title) || document.title || "Article";
    const url = currentUrl || cleanUrl();

    const summaryHtml = lastSummaryRaw ? renderSummary(lastSummaryRaw) : "";

    let deeperHtml = "";
    if (lastDeeper && lastDeeper.length) {
      deeperHtml = `<h2 class="p-h2">${escapeHtml(t("chewTitle"))}</h2>`;
      for (const it of lastDeeper) {
        deeperHtml +=
          `<div class="p-prov"><p class="p-prov-q">${renderInline(it.q)}</p>` +
          (it.a ? `<div class="p-prov-a">${renderSummary(it.a)}</div>` : "") +
          `</div>`;
      }
    }

    const articleHtml = article
      ? articleHtmlForPrint(article.contentHtml, article.text)
      : `<p><em>The full article text could not be extracted.</em></p>`;

    const css =
      `*{box-sizing:border-box}` +
      `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a202c;max-width:720px;margin:28px auto;padding:0 28px;line-height:1.55}` +
      `.p-title{font-size:24px;margin:0 0 6px;line-height:1.25}` +
      `.p-src{font-size:12px;color:#718096;margin:0 0 20px;word-break:break-all}` +
      `.p-src a{color:#2b6cb0}` +
      `.asz-tldr{background:#ebf4ff;border:1px solid #bee3f8;border-left:4px solid #2b6cb0;border-radius:8px;padding:10px 16px;margin:0 0 16px}` +
      `.asz-tldr h3,.asz-tldr h4{margin-top:0}` +
      `h3{font-size:19px;color:#2b6cb0;margin:18px 0 8px}` +
      `h4{font-size:16px;color:#2b6cb0;margin:16px 0 6px}` +
      `h5{font-size:14px;color:#4a5568;margin:12px 0 4px}` +
      `ul,ol{padding-left:22px;margin:0 0 12px}li{margin:0 0 6px}` +
      `strong{font-weight:700}em{font-style:italic}` +
      `.p-h2{font-size:18px;margin:22px 0 10px;border-bottom:2px solid #e2e8f0;padding-bottom:4px}` +
      `.p-prov{border-left:3px solid #cbd5e0;padding-left:12px;margin:0 0 14px}` +
      `.p-prov-q{font-style:italic;font-weight:600;color:#4a5568;margin:0 0 6px}` +
      `.p-prov-a{font-size:14px;color:#2d3748}.p-prov-a p{margin:0 0 6px}` +
      `.p-divider{border:none;border-top:2px dashed #cbd5e0;margin:28px 0}` +
      // Full article: keep the document's structure, styled neutrally.
      `.p-article{font-size:15px}` +
      `.p-article p{margin:0 0 12px}` +
      `.p-article h1,.p-article h2,.p-article h3,.p-article h4,.p-article h5,.p-article h6{color:#1a202c;line-height:1.3;margin:20px 0 8px}` +
      `.p-article h1{font-size:21px}.p-article h2{font-size:18px}.p-article h3{font-size:16px}.p-article h4,.p-article h5,.p-article h6{font-size:15px}` +
      `.p-article ul,.p-article ol{padding-left:24px;margin:0 0 12px}.p-article li{margin:0 0 6px}` +
      `.p-article blockquote{margin:0 0 14px;padding:4px 0 4px 14px;border-left:3px solid #cbd5e0;color:#4a5568;font-style:italic}` +
      `.p-article a{color:#2b6cb0}` +
      `.p-article pre{white-space:pre-wrap;background:#f7fafc;padding:10px;border-radius:6px;overflow:auto}` +
      `.p-article code{background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:13px}` +
      `.p-article figure,.p-article table{margin:0 0 14px;max-width:100%}` +
      `@media print{a{color:#1a202c;text-decoration:none}.p-article{font-size:12pt}}`;

    return (
      `<!DOCTYPE html><html lang="${escapeAttr(
        (article && article.lang) || document.documentElement.lang || ""
      )}"><head><meta charset="utf-8">` +
      `<title>${escapeHtml(docTitle)} — TL;DR Me</title><style>${css}</style></head><body>` +
      `<h1 class="p-title">${escapeHtml(docTitle)}</h1>` +
      (url
        ? `<p class="p-src">${escapeHtml(t("source"))}: <a href="${escapeAttr(url)}">${escapeHtml(url)}</a></p>`
        : "") +
      `<div class="p-summary">${summaryHtml}</div>` +
      deeperHtml +
      `<hr class="p-divider">` +
      `<h2 class="p-h2">${escapeHtml(t("fullArticle"))}</h2>` +
      `<div class="p-article">${articleHtml}</div>` +
      `</body></html>`
    );
  }

  // Open the printable page (as a blob URL, so it has its own origin and isn't
  // blocked or stripped by the page's CSP) in a new tab; a tiny embedded script
  // auto-opens the print dialog and closes the tab afterward. Falls back to an
  // off-screen iframe if the popup is blocked.
  function printSummary() {
    if (!lastSummaryRaw) return;
    const baseHtml = buildPrintDoc();
    const printScript =
      '<script>window.addEventListener("load",function(){setTimeout(function(){window.focus();window.print();},250);});' +
      'window.addEventListener("afterprint",function(){window.close();});<\/script>';
    const html = baseHtml.replace("</body>", printScript + "</body>");

    let url = null;
    try {
      url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    } catch (_) {
      url = null;
    }
    if (url) {
      const win = window.open(url, "_blank");
      if (win) {
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch (_) {
            /* ignore */
          }
        }, 60000);
        return;
      }
      try {
        URL.revokeObjectURL(url);
      } catch (_) {
        /* ignore */
      }
    }
    // Popup blocked or blob unavailable → off-screen iframe (opener drives print).
    printViaIframe(baseHtml);
  }

  // Fallback used only if the popup is blocked: a rendered (off-screen) iframe.
  function printViaIframe(html) {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText =
      "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;";
    iframe.onload = () => {
      const win = iframe.contentWindow;
      try {
        win.focus();
        win.print();
      } catch (_) {
        iframe.remove();
        return;
      }
      const cleanup = () => setTimeout(() => iframe.remove(), 200);
      win.addEventListener("afterprint", cleanup);
      setTimeout(cleanup, 60000);
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
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
        contentHtml: result.content || "", // structured HTML, used for printing
        lang: document.documentElement.lang || "",
      };
    } catch (e) {
      console.error("Article Summarizer: extraction failed", e);
      return null;
    }
  }

  // ---- Summary cache (keyed by clean URL, persisted in storage.local) ----
  const CACHE_STORE_KEY = "summaryCache";
  const CACHE_MAX = 50;

  async function getCached(url) {
    try {
      const data = await browser.storage.local.get(CACHE_STORE_KEY);
      const map = data[CACHE_STORE_KEY] || {};
      return map[url] || null;
    } catch (_) {
      return null;
    }
  }

  async function setCached(url, entry) {
    try {
      const data = await browser.storage.local.get(CACHE_STORE_KEY);
      const map = data[CACHE_STORE_KEY] || {};
      map[url] = entry;
      // Keep only the most recent CACHE_MAX entries.
      const keys = Object.keys(map);
      if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0));
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete map[k];
      }
      await browser.storage.local.set({ [CACHE_STORE_KEY]: map });
    } catch (_) {
      /* storage full or unavailable — caching is best-effort */
    }
  }

  function renderEntry(e) {
    currentUrl = e.url || "";
    lastDeeper = e.deeper || null; // restore cached provocations if present
    showSummary(
      e.title,
      e.summary,
      e.thinking,
      e.truncated,
      e.url,
      e.langWarning,
      e.sourceLabel,
      e.outputTruncated
    );
  }

  // `force` (from the ↻ button) bypasses the cache and regenerates.
  async function run(force) {
    window.__articleSummarizer.open();
    const url = cleanUrl();

    if (!force) {
      const cached = await getCached(url);
      if (cached && cached.summary) {
        renderEntry(cached);
        return;
      }
    }

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
        const entry = {
          title: article.title,
          summary: resp.summary,
          thinking: resp.thinking,
          truncated: resp.truncated,
          url,
          langWarning: resp.langWarning,
          sourceLabel: resp.sourceLabel,
          outputTruncated: resp.outputTruncated,
          ts: Date.now(),
        };
        renderEntry(entry);
        if (entry.summary) setCached(url, entry); // persist for next visit
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
