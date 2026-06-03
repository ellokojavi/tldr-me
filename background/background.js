/*
 * Background event page.
 * - On toolbar click: injects the Readability libs + content script into the active tab.
 * - Handles "summarize" messages by calling the configured provider's
 *   chat-completions API (MiniMax or Gemini, both OpenAI-compatible).
 *
 * The fetch lives here (not in the content script) so it runs with the
 * extension's host_permissions and isn't blocked by the page's CSP / CORS.
 */

// Supported providers. Both expose an OpenAI-compatible chat-completions
// endpoint, so the same request code works for either.
const PROVIDERS = {
  minimax: {
    label: "MiniMax",
    endpoint: "https://api.minimax.io/v1/chat/completions",
    defaultModel: "MiniMax-M2.7",
    models: ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2", "MiniMax-M3"],
    keyPattern: /^[A-Za-z0-9._-]{20,}$/,
    keyError: "That doesn't look like a MiniMax key — expected a long token (20+ chars) with no spaces.",
  },
  gemini: {
    label: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3-flash-preview"],
    keyPattern: /^AIza[A-Za-z0-9_-]{35}$/,
    keyError: 'That doesn\'t look like a Gemini key — it should start with "AIza" and be 39 characters.',
  },
};

// Validate an API key's format. Empty is allowed (means "clear this key").
// Returns { ok: true } or { ok: false, message }.
function validateApiKey(provider, key) {
  const value = (key || "").trim();
  if (!value) return { ok: true };
  const info = PROVIDERS[provider];
  if (!info) return { ok: false, message: "Unknown provider." };
  if (/\s/.test(value)) {
    return { ok: false, message: "The key contains spaces or line breaks — paste only the key." };
  }
  if (info.keyPattern && !info.keyPattern.test(value)) {
    return { ok: false, message: info.keyError };
  }
  return { ok: true };
}
// Preference order when picking a default provider (first one with a key wins).
const PROVIDER_ORDER = ["minimax", "gemini"];

// Keep prompts well within the model's context window. ~4 chars/token is a rough
// rule of thumb, so 48k chars is comfortably inside a large-context model.
const MAX_INPUT_CHARS = 48000;

// Resolve which provider + key + model to use. The active provider is whatever
// the user selected; if none is set (or its key was cleared), fall back to the
// first provider that has a key — so "the first key added" becomes the default.
async function getActiveConfig() {
  const s = await browser.storage.local.get([
    "minimaxApiKey", "geminiApiKey", "minimaxModel", "geminiModel", "activeProvider",
  ]);
  const keys = {
    minimax: (s.minimaxApiKey || "").trim(),
    gemini: (s.geminiApiKey || "").trim(),
  };
  let active = s.activeProvider;
  if (!active || !PROVIDERS[active] || !keys[active]) {
    active = PROVIDER_ORDER.find((p) => keys[p]) || null;
  }
  if (!active) return null;
  const cfg = PROVIDERS[active];
  return {
    provider: active,
    endpoint: cfg.endpoint,
    apiKey: keys[active],
    model: s[`${active}Model`] || cfg.defaultModel,
  };
}

// Separate the model's chain-of-thought from the actual answer.
// Handles <think>...</think> blocks inside the content (and an unclosed
// trailing <think>), plus a separate reasoning_content field if present.
function splitThinking(content, reasoningField) {
  let text = content || "";
  const blocks = [];

  text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, inner) => {
    blocks.push(inner.trim());
    return "";
  });

  // An opening <think> with no closing tag → treat the rest as reasoning.
  const openIdx = text.search(/<think>/i);
  if (openIdx !== -1) {
    blocks.push(text.slice(openIdx).replace(/<think>/i, "").trim());
    text = text.slice(0, openIdx);
  }

  let thinking = reasoningField ? String(reasoningField).trim() : "";
  if (blocks.length) {
    const inlineThinking = blocks.filter(Boolean).join("\n\n");
    thinking = thinking ? `${thinking}\n\n${inlineThinking}` : inlineThinking;
  }

  return { text: text.trim(), thinking: thinking.trim() };
}

// Detect the dominant writing script of a text, so we can tell whether the
// summary came back in a different language family than the article (the
// common MiniMax failure mode: a non-Chinese article summarized in Chinese).
const SCRIPT_PATTERNS = {
  han: /\p{Script=Han}/gu,
  kana: /\p{Script=Hiragana}|\p{Script=Katakana}/gu,
  hangul: /\p{Script=Hangul}/gu,
  latin: /\p{Script=Latin}/gu,
  cyrillic: /\p{Script=Cyrillic}/gu,
  greek: /\p{Script=Greek}/gu,
  arabic: /\p{Script=Arabic}/gu,
  hebrew: /\p{Script=Hebrew}/gu,
  devanagari: /\p{Script=Devanagari}/gu,
  thai: /\p{Script=Thai}/gu,
};

function dominantScript(text) {
  const sample = (text || "").slice(0, 4000);
  let best = null;
  let bestCount = 0;
  for (const [name, re] of Object.entries(SCRIPT_PATTERNS)) {
    const matches = sample.match(re);
    const count = matches ? matches.length : 0;
    if (count > bestCount) {
      bestCount = count;
      best = name;
    }
  }
  return bestCount > 0 ? best : null;
}

// "Suspect" non-Latin scripts that indicate wrong-language contamination when
// they appear in text that shouldn't contain them. Latin is intentionally NOT
// here (loanwords/brand names/proper nouns appear in Latin across languages),
// and Greek is omitted (math/science Latin articles legitimately use π, μ, σ…).
const FOREIGN_SCRIPTS = {
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  cyrillic: /\p{Script=Cyrillic}/gu,
  arabic: /\p{Script=Arabic}/gu,
  hebrew: /\p{Script=Hebrew}/gu,
  devanagari: /\p{Script=Devanagari}/gu,
  thai: /\p{Script=Thai}/gu,
};

// Group han/kana/hangul into one "cjk" family so a Japanese article (han+kana)
// isn't flagged against itself.
function scriptFamily(script) {
  if (script === "han" || script === "kana" || script === "hangul") return "cjk";
  return script; // latin, cyrillic, arabic, hebrew, devanagari, thai, or null
}

// Count characters from a suspect script that does NOT match the article's own
// family — i.e. genuine foreign-language contamination (Russian words inside a
// Spanish answer, stray Chinese inside English, etc.).
function foreignCharCount(text, articleScript) {
  const family = scriptFamily(articleScript);
  let count = 0;
  for (const [name, re] of Object.entries(FOREIGN_SCRIPTS)) {
    if (name === family) continue; // same family as the article → allowed
    const m = (text || "").match(re);
    if (m) count += m.length;
  }
  return count;
}

// True if `summary` is in the wrong language relative to the article:
//   1. The whole text is in a different dominant script, OR
//   2. It contains foreign-script characters that don't belong (any amount of
//      Cyrillic/CJK/Arabic/… inside a Spanish/English/etc. answer).
function languageMismatch(articleScript, summary) {
  if (!summary) return false;
  if (articleScript) {
    const got = dominantScript(summary);
    if (got && got !== articleScript) return true;
  }
  return foreignCharCount(summary, articleScript) > 0;
}

// Human-readable language name for the strict retry instruction.
const LANG_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", nl: "Dutch", ru: "Russian", uk: "Ukrainian", pl: "Polish",
  sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish", tr: "Turkish",
  cs: "Czech", el: "Greek", ro: "Romanian", hu: "Hungarian", id: "Indonesian",
  vi: "Vietnamese", zh: "Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic",
  he: "Hebrew", hi: "Hindi", th: "Thai",
};

function languageName(lang) {
  const code = (lang || "").split("-")[0].toLowerCase();
  return LANG_NAMES[code] || "";
}

// Localized word for "Source", used for the link label under the summary.
const SOURCE_LABELS = {
  en: "Source", es: "Fuente", fr: "Source", de: "Quelle", it: "Fonte",
  pt: "Fonte", nl: "Bron", ru: "Источник", uk: "Джерело", pl: "Źródło",
  sv: "Källa", no: "Kilde", da: "Kilde", fi: "Lähde", tr: "Kaynak",
  cs: "Zdroj", el: "Πηγή", ro: "Sursă", hu: "Forrás", id: "Sumber",
  vi: "Nguồn", zh: "来源", ja: "出典", ko: "출처", ar: "المصدر",
  he: "מקור", hi: "स्रोत", th: "แหล่งที่มา",
};
// Fallback by script when the language code is unknown.
const SOURCE_BY_SCRIPT = {
  han: "来源", kana: "出典", hangul: "출처", cyrillic: "Источник",
  arabic: "المصدر", greek: "Πηγή", hebrew: "מקור", thai: "แหล่งที่มา",
  devanagari: "स्रोत",
};

function sourceLabel(lang, articleText) {
  const code = (lang || "").split("-")[0].toLowerCase();
  if (code && SOURCE_LABELS[code]) return SOURCE_LABELS[code];
  const script = dominantScript(articleText);
  if (script && SOURCE_BY_SCRIPT[script]) return SOURCE_BY_SCRIPT[script];
  return "Source";
}

const PANEL_FILES = [
  "lib/Readability.js",
  "lib/Readability-readerable.js",
  "content/content.js",
];

// Inject the summarizer (Readability + content.js) into a tab and let it run.
// Used both by the toolbar button and by a click on the on-page "TL;DR" tab.
async function injectSummarizer(tabId) {
  if (tabId == null) return;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: PANEL_FILES });
  } catch (err) {
    // Common cause: page is a privileged URL (about:, addons.mozilla.org, etc.)
    console.error("Article Summarizer: cannot run on this page.", err);
  }
}

browser.action.onClicked.addListener((tab) => {
  if (tab.id) injectSummarizer(tab.id);
});

// Green badge on the toolbar icon to signal "article detected on this tab".
function updateBadge(tabId, detected) {
  if (tabId == null) return;
  if (detected) {
    browser.action.setBadgeText({ tabId, text: "●" });
    browser.action.setBadgeBackgroundColor({ tabId, color: "#38a169" });
    if (browser.action.setBadgeTextColor) {
      browser.action.setBadgeTextColor({ tabId, color: "#ffffff" });
    }
    browser.action.setTitle({
      tabId,
      title: "Article detected — click for a TL;DR summary",
    });
  } else {
    browser.action.setBadgeText({ tabId, text: "" });
    browser.action.setTitle({
      tabId,
      title: "Summarize this article (TL;DR)",
    });
  }
}

// Inject the lightweight detector into a single tab. detect.js runs the cheap
// "is this readerable?" heuristic and messages back, which updates the badge.
// Only ever called for the ACTIVE tab, so background tabs are never scanned.
async function detectInTab(tabId) {
  if (tabId == null) return;
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["lib/Readability-readerable.js", "content/detect.js"],
    });
  } catch (_) {
    // Privileged page (about:, addons.mozilla.org, PDF viewer, etc.) — no article.
    updateBadge(tabId, false);
  }
}

// Re-check whenever the user switches tabs...
browser.tabs.onActivated.addListener(({ tabId }) => {
  detectInTab(tabId);
});

// ...and when the active tab finishes (re)loading a page.
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab && tab.active) {
    detectInTab(tabId);
  }
});

// Check the current active tab when the extension first loads.
browser.tabs
  .query({ active: true, currentWindow: true })
  .then((tabs) => {
    if (tabs && tabs[0]) detectInTab(tabs[0].id);
  })
  .catch(() => {});

browser.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === "articleDetected") {
    // Only trust detection results from the tab that is currently active.
    if (sender.tab && sender.tab.active) {
      updateBadge(sender.tab.id, message.detected);
    }
    return Promise.resolve({ ok: true });
  }
  if (message && message.type === "summarizeFromTab") {
    // User clicked the on-page "TL;DR" tab — load the summarizer now.
    injectSummarizer(sender.tab && sender.tab.id);
    return Promise.resolve({ ok: true });
  }
  if (message && message.type === "summarize") {
    // Returning a promise tells Firefox to keep the channel open for the async reply.
    return handleSummarize(message);
  }
  if (message && message.type === "discuss") {
    return handleDiscuss(message);
  }
  if (message && message.type === "saveApiKey") {
    return handleSaveApiKey(message);
  }
  if (message && message.type === "openOptions") {
    browser.runtime.openOptionsPage();
    return Promise.resolve({ ok: true });
  }
  return false;
});

// Save a provider's key (and optional model). The first key ever added — or an
// explicit setActive — becomes the active provider used for summaries.
async function handleSaveApiKey(message) {
  const provider = PROVIDERS[message.provider] ? message.provider : "minimax";
  const trimmedKey = (message.key || "").trim();

  // Safety net: never persist a malformed key (the UI validates too).
  const check = validateApiKey(provider, trimmedKey);
  if (!check.ok) {
    return { ok: false, error: "INVALID_KEY", message: check.message };
  }

  const current = await browser.storage.local.get(["activeProvider"]);
  const patch = {};
  patch[`${provider}ApiKey`] = trimmedKey;
  if (message.model) patch[`${provider}Model`] = message.model;
  // Only make this provider active if it actually has a key — so clearing a key
  // never selects a keyless provider, and the first real key becomes the default.
  if (trimmedKey && (message.setActive || !current.activeProvider)) {
    patch.activeProvider = provider;
  }
  await browser.storage.local.set(patch);
  return { ok: true };
}

async function handleSummarize({ title, text, lang }) {
  const config = await getActiveConfig();

  if (!config) {
    return {
      ok: false,
      error: "NO_API_KEY",
      message: "No API key set. Open settings to add a MiniMax or Gemini key.",
    };
  }

  let article = (text || "").trim();
  if (!article) {
    return { ok: false, error: "EMPTY", message: "No article text was found on this page." };
  }

  let truncated = false;
  if (article.length > MAX_INPUT_CHARS) {
    article = article.slice(0, MAX_INPUT_CHARS);
    truncated = true;
  }

  const systemPrompt =
    "You are a concise summarizer. Produce a well-structured TL;DR of the article in Markdown, " +
    "written in the SAME language as the article. Use this structure:\n" +
    "1. A heading that is exactly '## TL;DR' — keep this label in English, do NOT translate it — " +
    "followed by a single summary sentence.\n" +
    "2. A heading meaning 'Key points', TRANSLATED into the article's language " +
    "(for example 'Key points' in English, 'Puntos clave' in Spanish, 'Points clés' in French, " +
    "'要点' in Chinese), written as '## <translated heading>'. Under it, list 3 to 6 bullet points. " +
    "Every bullet MUST begin with '- ' (a hyphen followed by a space), one per line.\n" +
    "3. If the article describes steps, a sequence, or ranked items, use a numbered list " +
    "(1. 2. 3.) under an appropriate translated '## ' heading instead of or in addition to bullets.\n" +
    "Use '**bold**' to highlight key terms or names, sparingly. " +
    "Do not write any preamble before the first heading, and no closing remarks.\n" +
    "Write with correct spelling, grammar, accents/diacritics, and punctuation for that " +
    "language, and proofread your text before answering. " +
    "Write EVERY part of the response — headings, bullets, and sentences — in the article's " +
    "language only. Do not mix in words or characters from any other language; in particular, " +
    "do NOT use Chinese/Japanese/Korean characters unless the article itself is in that language.";

  const userPrompt =
    `Article title: ${title || "(untitled)"}\n` +
    (lang ? `Article language: ${lang}\n` : "") +
    (truncated ? "(Note: the article was truncated for length.)\n" : "") +
    `\nArticle text:\n${article}`;

  const articleScript = dominantScript(article);
  const langLabel = languageName(lang); // e.g. "English", or "" if unknown

  // Escalating language constraints, applied across up to 3 attempts. We only
  // make a follow-up call when the previous summary failed the language check.
  const target = langLabel
    ? `${langLabel} (the article's language)`
    : "the article's language";
  const escalations = [
    "",
    `\n\nCRITICAL LANGUAGE REQUIREMENT: Write the ENTIRE response — every heading, ` +
      `bullet, and word — in ${target}. Do NOT include ANY Chinese, Japanese, or Korean ` +
      `characters unless the article itself is in that language. No exceptions.`,
    `\n\nYOUR PREVIOUS ANSWER WRONGLY CONTAINED CHINESE (OR ANOTHER FOREIGN LANGUAGE). ` +
      `Rewrite it so that 100% of the text is in ${target}. The output must contain ZERO ` +
      `Chinese/Japanese/Korean characters. Translate any such fragments into ${target}.`,
  ];

  let res = null;
  let langWarning = false;
  let usedSystem = systemPrompt;
  for (let i = 0; i < escalations.length; i++) {
    usedSystem = systemPrompt + escalations[i];
    res = await requestModel({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        { role: "system", content: usedSystem },
        { role: "user", content: userPrompt },
      ],
    });
    if (!res.ok) return res;
    // No answer text (only reasoning) — nothing to language-check; stop.
    if (!res.summary) break;
    if (!languageMismatch(articleScript, res.summary)) {
      langWarning = false;
      break;
    }
    langWarning = true; // still wrong; loop will try the next escalation
  }

  // Output truncation: a verbose reasoning model can hit the token cap after
  // the TL;DR but before the Key points. If so, retry once with a much larger
  // budget so the full answer fits.
  if (res.summary && res.finishReason === "length") {
    const retry = await requestModel({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: 8192,
      messages: [
        { role: "system", content: usedSystem },
        { role: "user", content: userPrompt },
      ],
    });
    if (retry.ok && retry.summary) {
      res = retry;
      langWarning = languageMismatch(articleScript, retry.summary);
    }
  }

  if (!res.summary && !res.thinking) {
    return { ok: false, error: "NO_CONTENT", message: "The API returned no summary text." };
  }

  // Proofreading pass: a cheap second call (just the summary, not the article)
  // that fixes spelling/grammar/accents without changing meaning or structure.
  if (res.summary) {
    const corrected = await proofread(config, res.summary, articleScript);
    if (corrected) res.summary = corrected;
  }

  return {
    ok: true,
    summary: res.summary,
    thinking: res.thinking,
    truncated,
    langWarning,
    outputTruncated: res.finishReason === "length",
    sourceLabel: sourceLabel(lang, article),
  };
}

// "Go deeper": generate 3 reader provocations (sharp, article-specific
// questions/tensions) each with a brief perspective. Returns raw text the
// content script parses into Q/A pairs. On-demand only (a second call the user
// opts into), so it never slows the default summary.
async function handleDiscuss({ title, text, lang }) {
  const config = await getActiveConfig();
  if (!config) {
    return {
      ok: false,
      error: "NO_API_KEY",
      message: "No API key set. Open settings to add a MiniMax or Gemini key.",
    };
  }

  let article = (text || "").trim();
  if (!article) {
    return { ok: false, error: "EMPTY", message: "No article text was found on this page." };
  }
  if (article.length > MAX_INPUT_CHARS) article = article.slice(0, MAX_INPUT_CHARS);

  const systemPrompt =
    "You are an incisive thinking partner. The reader has already seen a summary " +
    "and now wants to think more deeply. Generate EXACTLY 3 provocations: sharp, " +
    "specific questions or tensions THIS article raises — the kind that make a " +
    "thoughtful reader pause. Ground each in the article's specifics; avoid generic " +
    "questions that could apply to any article. For each, also write a brief " +
    "perspective (2-4 sentences) offering a thoughtful angle to consider — explore " +
    "the tension, don't deliver a verdict. Write everything in the same language as " +
    "the article, with correct spelling and grammar. " +
    "Output EXACTLY this format with no preamble or extra text:\n" +
    "Q: <provocation>\nA: <perspective>\nQ: <provocation>\nA: <perspective>\n" +
    "Q: <provocation>\nA: <perspective>";

  const userPrompt =
    `Article title: ${title || "(untitled)"}\n` +
    (lang ? `Article language: ${lang}\n` : "") +
    `\nArticle text:\n${article}`;

  // Same language guard as the summary path: retry once if the output mixes in
  // foreign-script words (e.g. Russian/Chinese fragments inside Spanish).
  const articleScript = dominantScript(article);
  const langLabel = languageName(lang);
  const target = langLabel ? `${langLabel} (the article's language)` : "the article's language";
  const escalations = [
    "",
    `\n\nCRITICAL: Write EVERY question and perspective entirely in ${target}. Do NOT ` +
      `mix in any words or characters from another language — no Cyrillic/Russian, ` +
      `Chinese, Japanese, Korean, Arabic, etc. unless the article itself is in that language.`,
  ];

  let res = null;
  for (let i = 0; i < escalations.length; i++) {
    res = await requestModel({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: 2048,
      messages: [
        { role: "system", content: systemPrompt + escalations[i] },
        { role: "user", content: userPrompt },
      ],
    });
    if (!res.ok) return res;
    if (!res.summary) {
      return { ok: false, error: "NO_CONTENT", message: "No questions came back." };
    }
    if (!languageMismatch(articleScript, res.summary)) break;
  }
  // Proofreading pass (the model is weak at some languages' spelling, e.g.
  // "reconcile"/"cuestionna" in Spanish). Keeps the Q:/A: structure & language.
  const corrected = await proofreadDiscuss(config, res.summary, articleScript);
  if (corrected) res.summary = corrected;
  return { ok: true, text: res.summary };
}

// Spelling/grammar proofread for the "Go deeper" Q:/A: provocations. Returns
// corrected text, or null if the pass failed / broke the structure / changed
// language / dropped content (so the caller keeps the original).
async function proofreadDiscuss(config, text, articleScript) {
  const sys =
    "You are a meticulous proofreader. Correct ONLY spelling, grammar, " +
    "accent/diacritic, and punctuation mistakes in the text below. Keep the " +
    "EXACT line structure (every line starts with 'Q:' or 'A:'), keep the same " +
    "language and meaning, and change nothing else. Return ONLY the corrected " +
    "text — no preamble, no commentary.";
  const r = await requestModel({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: 2048,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: text },
    ],
  });
  if (!r.ok || !r.summary) return null;
  if (r.finishReason === "length") return null;
  if (languageMismatch(articleScript, r.summary)) return null;
  if (!/^\s*Q:/im.test(r.summary)) return null; // structure must survive
  if (r.summary.trim().length < text.trim().length * 0.6) return null;
  return r.summary.trim();
}

// Correct spelling/grammar/accents in an already-written Markdown summary,
// preserving meaning, structure, and language. Returns the corrected text, or
// null if the pass failed or produced something suspicious (so the caller keeps
// the original).
async function proofread(config, summary, articleScript) {
  const sys =
    "You are a meticulous proofreader. Correct ONLY spelling, grammar, " +
    "accent/diacritic, and punctuation mistakes in the user's Markdown text. " +
    "Do NOT change the meaning, the wording (beyond fixing errors), the " +
    "structure, the headings (keep '## TL;DR' exactly), the bullet markers, or " +
    "the language. Preserve the Markdown exactly. Return ONLY the corrected " +
    "text — no preamble, no commentary, no code fences.";
  const r = await requestModel({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: 4096,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: summary },
    ],
  });
  if (!r.ok || !r.summary) return null;
  // Reject if the proofread was cut off, changed the language, or dropped a lot
  // of content (a sign it rewrote/truncated rather than just fixing errors).
  if (r.finishReason === "length") return null;
  if (languageMismatch(articleScript, r.summary)) return null;
  if (r.summary.trim().length < summary.trim().length * 0.6) return null;
  return r.summary.trim();
}

// Single call to an OpenAI-compatible chat-completions API (MiniMax or Gemini).
// Returns { ok, summary, thinking, finishReason } or { ok:false, error, message }.
// max_tokens must be generous: reasoning models spend output tokens "thinking"
// before the answer, so a low cap can truncate the answer (e.g. TL;DR present
// but Key points cut off).
async function requestModel({ endpoint, apiKey, model, messages, maxTokens = 4096 }) {
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    const raw = await resp.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return {
        ok: false,
        error: "BAD_RESPONSE",
        message: `Unexpected response (HTTP ${resp.status}): ${raw.slice(0, 300)}`,
      };
    }

    if (!resp.ok) {
      const apiMsg =
        (data && data.error && (data.error.message || data.error)) ||
        (data && data.base_resp && data.base_resp.status_msg) ||
        `HTTP ${resp.status}`;
      return { ok: false, error: "API_ERROR", message: String(apiMsg) };
    }

    const choice = (data && data.choices && data.choices[0]) || {};
    const choiceMsg = choice.message || {};
    const finishReason = choice.finish_reason || "";

    // Reasoning models emit their chain-of-thought either inline in
    // <think>...</think> tags or in a separate reasoning_content field.
    const { text, thinking } = splitThinking(
      choiceMsg.content || "",
      choiceMsg.reasoning_content
    );

    if (!text && !thinking) {
      return { ok: false, error: "NO_CONTENT", message: "The API returned no summary text." };
    }

    return { ok: true, summary: text, thinking, finishReason };
  } catch (err) {
    return {
      ok: false,
      error: "NETWORK",
      message: `Request failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
}
