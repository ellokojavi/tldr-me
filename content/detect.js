/*
 * Lightweight detector + tab. Runs on every active page (document_idle)
 * alongside Readability-readerable.js. It does two cheap things and never
 * loads the heavy summarizer code:
 *   1. Runs the "is this readerable?" heuristic and reports it to the
 *      background script (which sets/clears the green toolbar badge).
 *   2. Shows the small "TL;DR" reopen tab on the page edge.
 *
 * The summarizer (Readability + content.js) is only injected when the user
 * actually clicks the tab — see the click handler below.
 */

(function () {
  const TAB_ID = "article-summarizer-tab";
  const PANEL_ID = "article-summarizer-panel";

  function injectTabStyles() {
    if (document.getElementById("article-summarizer-tab-styles")) return;
    const style = document.createElement("style");
    style.id = "article-summarizer-tab-styles";
    style.textContent = `
      #${TAB_ID} {
        position: fixed; top: 42%; right: 0; z-index: 2147483647;
        display: none; align-items: center; justify-content: center;
        background: #2b6cb0; color: #ffffff !important; cursor: pointer;
        border: none; border-radius: 8px 0 0 8px;
        box-shadow: -2px 0 10px rgba(0,0,0,0.22); padding: 12px 5px;
        writing-mode: vertical-rl; text-orientation: mixed;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif !important;
        font-size: 12px; font-weight: 700; letter-spacing: 1px;
        user-select: none; transition: background 0.15s ease;
      }
      #${TAB_ID}.asz-tab-visible { display: flex; }
      #${TAB_ID}:hover { background: #2c5282; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureTab() {
    let tab = document.getElementById(TAB_ID);
    if (tab) return tab;
    injectTabStyles();
    tab = document.createElement("div");
    tab.id = TAB_ID;
    tab.title = "Get a TL;DR summary";
    tab.textContent = "TL;DR";
    (document.body || document.documentElement).appendChild(tab);
    tab.addEventListener("click", () => {
      // If the summarizer is already loaded, toggle it directly (cheap).
      // Otherwise ask the background to inject it now — the first click is
      // what actually fetches and summarizes the article.
      if (window.__articleSummarizer && window.__articleSummarizer.toggle) {
        window.__articleSummarizer.toggle();
      } else {
        try {
          browser.runtime.sendMessage({ type: "summarizeFromTab" });
        } catch (_) {
          /* background not ready; ignore */
        }
      }
    });
    return tab;
  }

  function setTab(detected) {
    const panel = document.getElementById(PANEL_ID);
    const panelOpen = panel && !panel.classList.contains("asz-hidden");
    if (panelOpen) return; // panel is showing; leave the tab hidden
    if (detected) {
      ensureTab().classList.add("asz-tab-visible");
    } else {
      const tab = document.getElementById(TAB_ID);
      if (tab) tab.classList.remove("asz-tab-visible");
    }
  }

  function report() {
    let detected = false;
    try {
      detected =
        typeof isProbablyReaderable === "function" &&
        isProbablyReaderable(document);
    } catch (_) {
      detected = false;
    }
    setTab(detected);
    try {
      browser.runtime.sendMessage({ type: "articleDetected", detected: !!detected });
    } catch (_) {
      /* background may not be ready; harmless */
    }
  }

  // Run once now, and re-check shortly after in case the page hydrates late
  // (common on SPAs / news sites that inject the article body after load).
  report();
  setTimeout(report, 1500);
})();
