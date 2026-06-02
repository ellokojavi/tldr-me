# TL;DR Me — Article Summarizer for Firefox

A Firefox extension that detects the article on the current page, extracts its
main text, and shows a clean **TL;DR summary** in an in-page sidebar — powered
by the [MiniMax](https://platform.minimax.io) API (OpenAI-compatible).

It's built for fast, low-friction reading: a small **TL;DR** tab appears on
article pages, one click gives you a structured summary with key points, and you
can copy it or share it straight to WhatsApp.

> **Status:** personal-use / developer build. Loads as a temporary add-on (see
> [Install](#install)); package & sign it for permanent installation.

---

## Features

- **Automatic article detection.** A lightweight check (Mozilla's
  [Readability](https://github.com/mozilla/readability) `isProbablyReaderable`)
  runs on the active tab and shows a green badge on the toolbar icon.
- **On-load "TL;DR" tab.** A small tab appears on the right edge of article
  pages *without* loading the heavy summarizer — it's fetched only when you
  click.
- **Structured Markdown summary.** A highlighted **TL;DR** box plus a
  **Key points** section with proper bullets, numbered steps, headings, and
  bold emphasis.
- **Language-faithful.** The summary is written in the article's language. A
  built-in guard detects wrong-language output (the common "answered in
  Chinese" failure) and automatically retries with escalating constraints — the
  **Key points** heading and the **Source** label are localized too.
- **Clean source link.** The article URL is appended (canonical link preferred,
  tracking params stripped) and travels with the copied/shared text.
- **Share.** Copy to clipboard, or open the installed **WhatsApp** app with the
  summary prefilled to send to any contact.
- **Collapsible reasoning.** If the model emits chain-of-thought, it's shown in
  a collapsed "Show model reasoning" section so the summary stays front and
  center.
- **In-app settings.** Set/replace your API key and pick the model from a gear
  menu in the panel — no need to dig through the add-ons page.
- **CSS-isolated UI.** The panel forces its own fonts and list styles so host
  pages can't bleed into the summary's appearance.

---

## How it works

```
                 ┌─────────────────────────── active tab ───────────────────────────┐
 toolbar click ─▶│                                                                   │
                 │  detect.js (+ Readability-readerable)   ← injected on tab load     │
 tab click ─────▶│     • is this an article? → badge + show "TL;DR" tab              │
                 │                                                                    │
                 │  content.js (+ Readability)             ← injected on click only   │
                 │     • extract article → sidebar panel                              │
                 └───────────────────────────┬────────────────────────────────────────┘
                                              │ summarize { title, text, lang }
                                              ▼
                         background.js  ──▶  MiniMax /v1/chat/completions
                              • language guard + retry
                              • <think> reasoning split out
                              • localized "Source" label
```

The heavy summarizer (`Readability.js` + `content.js`) is injected **only when
you click** the toolbar button or the on-page tab. Passive detection uses a tiny
script so normal browsing stays light.

---

## Install

This is loaded as a **temporary add-on** (no signing required):

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**.
3. Select the `manifest.json` file in this folder.
4. (Optional) Pin the toolbar icon via the puzzle-piece menu.

Temporary add-ons are removed when Firefox restarts. For permanent installation,
package and sign via [addons.mozilla.org](https://addons.mozilla.org) or
`web-ext sign`.

### Grant site access (one time)

Firefox MV3 treats host access as opt-in. To enable the green badge and the
on-load tab everywhere, grant access once:

- Click the **puzzle-piece** button → the extension's **⚙ / …** menu →
  **"Always Allow on All Sites"**, or
- `about:addons` → the extension → **Permissions** → enable
  **"Access your data for all websites."**

Choose **"Always Allow on All Sites"** (not "Allow for this time"), otherwise
Firefox re-prompts on every page.

---

## Configuration

- **API key & model.** Open any article, click the **TL;DR** tab, and paste your
  MiniMax API key when prompted — or use the **⚙ Settings** button in the panel
  header at any time to change the key or model (default: `MiniMax-M2.7`).
- The key is stored in `browser.storage.local`.

### Make the key (and permission) persist across restarts

Because this is a temporary add-on, Firefox clears its storage and host-access
grant on a full restart. The extension already declares a stable add-on ID; to
keep data across restarts during development, set both flags in `about:config`
to `true`:

- `extensions.webextensions.keepStorageOnUninstall`
- `extensions.webextensions.keepUuidOnUninstall`

Packaging and signing the extension removes this caveat entirely.

---

## Usage

| Action | How |
|--------|-----|
| Summarize | Click the on-page **TL;DR** tab or the toolbar icon |
| Copy | **Copy** button in the Share row (turns into "Copied" for 5s) |
| Share to WhatsApp | **WhatsApp** button → opens the app with text prefilled |
| Re-summarize | **↻** in the panel header |
| Collapse | **→** in the header → panel slides away, tab returns |
| Settings | **⚙** in the header |

---

## Project structure

```
manifest.json              Extension manifest (MV3, Firefox 140+)
background/background.js    Toolbar/tab handlers, badge, MiniMax call,
                           language guard + retry, <think> splitting
content/detect.js          Lightweight detector + on-load "TL;DR" tab
content/content.js         Article extraction, sidebar UI, Markdown renderer,
                           Copy/WhatsApp, settings, clean-URL
options/options.html|js     Standalone API key & model settings page
lib/Readability*.js         Mozilla Readability (vendored, Apache-2.0)
icons/icon.svg             Toolbar / extension icon
```

---

## Development

Lint with [`web-ext`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):

```bash
npx web-ext lint --source-dir .
```

Run it in a temporary Firefox profile:

```bash
npx web-ext run --source-dir .
```

Expect 0 errors. The remaining `web-ext` warnings are `innerHTML` notices in
the vendored Readability library and the panel renderer (all inputs are
HTML-escaped or static templates).

---

## Privacy & permissions

- **Article text is sent to MiniMax** (`api.minimax.io`) to generate the
  summary — declared via the manifest's `data_collection_permissions`
  (`websiteContent`).
- **Passive detection** reads only a yes/no "is this an article?" signal from
  the active tab; it does not transmit page content. Full extraction and the
  network call happen only when you click.
- Outbound network access is limited to `api.minimax.io`.
- Your API key lives only in this browser's local extension storage. Do not
  distribute a build with a key embedded.

---

## Limitations

- Same-script language mix-ups (e.g. a Spanish article summarized in English)
  aren't caught by the language guard — it detects cross-script contamination
  (the CJK-in-Latin case). Add a word-level language detector if you need this.
- Very long articles are truncated (~48k characters) before summarizing.
- WhatsApp sharing uses the `whatsapp://` scheme, so it requires the WhatsApp
  app/handler to be registered.

---

## Credits & license

- Article extraction by Mozilla [Readability](https://github.com/mozilla/readability)
  (Apache License 2.0), vendored in `lib/`.
- Summaries by the [MiniMax](https://platform.minimax.io) API.

This project's own code is provided as-is for personal use. Add a license of
your choice before distributing.
