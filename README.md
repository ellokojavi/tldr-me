# TL;DR Me — Article Summarizer for Firefox

**Reading a long article? TL;DR Me gives you the short version.**

This is a small add-on for the Firefox web browser. When you're on a news story
or blog post, a little **TL;DR** tab appears on the right edge of the page. Click
it and you get a quick summary — a one-line takeaway plus the key points — right
next to the article. You can copy it or send it to a friend on WhatsApp.

It works in the language the article is written in, and you bring your own
AI key from **MiniMax**, **Google Gemini**, or **Anthropic (Claude)** (more on
that below).

![TL;DR Me summarizing an article in its in-page side panel](docs/screenshot.jpg)

*TL;DR Me reading an article and showing the TL;DR box plus Key points in the
side panel.*

---

## Try it on your computer (no coding needed)

You don't need to be a developer to try this. Here's the whole thing:

### 1. Download the code as a ZIP

- Go to the project page: **https://github.com/ellokojavi/tldr-me**
- Click the green **`< > Code`** button, then **Download ZIP**.
- Find the downloaded file (usually in your **Downloads** folder) and
  **double-click it to unzip**. You'll get a folder named something like
  `tldr-me-main`.

### 2. Get a free AI key (pick one)

The add-on needs a key from an AI service to write the summaries. Any one works:

- **Google Gemini** — go to
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in with
  a Google account, and click **Create API key**. Copy the key (it starts with
  `AIza…`).
- **MiniMax** — create an account at
  [platform.minimax.io](https://platform.minimax.io) and copy your API key.
- **Anthropic (Claude)** — create a key at
  [console.anthropic.com](https://console.anthropic.com) and copy it (it starts
  with `sk-ant-…`).

Keep the key handy — you'll paste it once in step 4. It stays only on your
computer.

### 3. Load the add-on into Firefox

1. Open **Firefox** (install it from [firefox.com](https://www.firefox.com) if
   you don't have it).
2. In the address bar, type **`about:debugging`** and press Enter.
3. Click **This Firefox** on the left.
4. Click **Load Temporary Add-on…**.
5. Open the folder you unzipped and select the file named **`manifest.json`**.

A new icon appears in your toolbar. (Firefox forgets temporary add-ons when you
fully quit it — just repeat this step next time, or see
[permanent install](#install) below.)

### 4. Use it

1. Open any news article or blog post.
2. Click the blue **TL;DR** tab on the right edge of the page (or the toolbar
   icon).
3. The first time, it asks for your AI key — pick your provider, paste the key
   from step 2, and click **Save & summarize**.
4. Read your summary! Use **Copy** or the green WhatsApp **Share** button.

That's it. The rest of this document is for people who want the technical
details.

---

## Features

- **Choose your provider.** Add a **MiniMax**, **Gemini**, and/or **Anthropic
  (Claude)** API key. ⚙ Settings lists every provider, shows each one's configured
  model (or “no key”), and lets you pick the **default** with a radio. The first
  key you add becomes the default automatically; switch the default any time with
  the radio. All three use OpenAI-compatible endpoints.
- **Automatic article detection.** A lightweight check (Mozilla's
  [Readability](https://github.com/mozilla/readability) `isProbablyReaderable`)
  runs on the active tab and shows a green badge on the toolbar icon.
- **On-load "TL;DR" tab.** A small tab appears on the right edge of article
  pages *without* loading the heavy summarizer — it's fetched only when you
  click.
- **Structured Markdown summary.** A highlighted **TL;DR** box plus a
  **Key points** section with proper bullets, numbered steps, headings, and
  bold emphasis.
- **Proofread for quality.** The summary **and** the Go-deeper questions are
  generated with a strict spelling/grammar/accents instruction, then run through
  a quick second pass that fixes any orthographic errors without changing
  meaning, structure, or language (skipped if it would alter content). Runs once
  per article (cached).
- **Language-faithful.** The summary is written in the article's language. A
  built-in guard detects wrong-language output (the common "answered in
  Chinese" failure) and automatically retries with escalating constraints — the
  **Key points** heading and the **Source** label are localized too.
- **Clean source link.** The article URL is appended (canonical link preferred,
  archive/proxy wrappers like `archive.is/…/https://…` unwrapped to the real
  article, tracking params stripped) and travels with the copied/shared text.
- **Share.** Copy to clipboard, or open the installed **WhatsApp** app with the
  summary prefilled — choose to send just the **TL;DR** or the **TL;DR + key
  points**; either way the article link is included.
- **Print / save as PDF.** A **Print** button builds a clean page — the summary,
  the *Go deeper* questions and perspectives (if generated), then the full
  article below a divider — and opens your print dialog (print or save as PDF).
- **Summaries are remembered.** Once an article is summarized, the result is
  saved per URL — revisit or reload the page and the summary appears instantly
  with no new API call. Press **↻** to force a fresh one.
- **Go deeper (optional).** Below the summary, a one-click **💭 Go deeper**
  surfaces 3 article-specific questions/tensions to think about — the model's
  take on each is tucked behind a tap, so it provokes your thinking rather than
  spoon-feeding conclusions. On-demand (a second call only when you ask) and
  cached per article.
- **Collapsible reasoning.** If the model emits chain-of-thought, it's shown in
  a collapsed "Show model reasoning" section so the summary stays front and
  center.
- **In-app settings.** Set/replace your API key and pick the model from a gear
  menu in the panel — no need to dig through the add-ons page. A **🤖** in the
  header shows the active provider + model on hover.
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
                         background.js  ──▶  MiniMax / Gemini / Anthropic (chat/completions)
                              • provider selection
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

- **Provider, API key & model.** Open any article, click the **TL;DR** tab, and
  choose a provider + paste its API key when prompted — or use the **⚙ Settings**
  button in the panel header at any time. Settings shows a **provider list**
  (each provider's configured model, or “no key”) with a radio to set the
  **default**, plus an add/change-a-key form. Each provider keeps its own key and
  model; the first key becomes the
  default automatically, and you switch the default any time with the radio.
  - **MiniMax** — get a key at [platform.minimax.io](https://platform.minimax.io)
    (default model `MiniMax-M2.7`).
  - **Gemini** — get a key at
    [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
    (default model `gemini-2.5-flash`).
  - **Anthropic (Claude)** — get a key at
    [console.anthropic.com](https://console.anthropic.com)
    (default model `claude-haiku-4-5`).
- Keys are stored in `browser.storage.local`.

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
| Print / save as PDF | **Print** in the Share row → print dialog with summary + full article |
| Share to WhatsApp | the green WhatsApp **Share** button → choose "TL;DR only" or "TL;DR + Key points" (link always included) |
| Go deeper | **💭 Go deeper** below the summary → 3 questions to chew on; tap *See a perspective* on any |
| Check active model | hover the **🤖** in the header (no need to open Settings) |
| Re-summarize (fresh) | **↻** in the panel header — ignores the saved copy |
| Collapse | **→** in the header → panel slides away, tab returns |
| Settings | **⚙** in the header |

---

## Project structure

```
manifest.json              Extension manifest (MV3, Firefox 140+)
background/background.js    Toolbar/tab handlers, badge, provider selection +
                           API call, language guard + retry, <think> splitting
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

- **Article text is sent to your chosen provider** (`api.minimax.io`,
  `generativelanguage.googleapis.com`, or `api.anthropic.com`) to generate the
  summary — declared via the manifest's `data_collection_permissions`
  (`websiteContent`).
- **Passive detection** reads only a yes/no "is this an article?" signal from
  the active tab; it does not transmit page content. Full extraction and the
  network call happen only when you click.
- Outbound network access is limited to the three provider hosts.
- Your API key lives only in this browser's local extension storage. Do not
  distribute a build with a key embedded.

---

## Limitations

- Same-script language mix-ups (e.g. a Spanish article summarized in English)
  aren't caught by the language guard — it detects cross-script contamination
  (the CJK-in-Latin case). Add a word-level language detector if you need this.
- Very long articles are truncated (~48k characters) before summarizing.
- WhatsApp sharing opens the installed app via the `whatsapp://` scheme with the
  summary prefilled; you pick the recipient. (The `wa.me` web link was avoided
  because its desktop handoff dropped everything but the URL.)

---

## Changelog

### Unreleased

- **Anthropic (Claude) provider** — add an `sk-ant-…` key to summarize with
  Claude (default model `claude-haiku-4-5`) via Anthropic's OpenAI-compatible
  endpoint, alongside MiniMax and Gemini.
- **Scalable provider settings** — Settings now lists every provider with its
  configured model (or “no key”) and lets you set the **default** with a radio
  (the first key defaults automatically).
- **Active-model indicator** — a 🤖 in the panel header shows the active
  provider + model on hover.
- **Proofreading extended to Go deeper** — the provocations now get the same
  spelling/grammar pass as the summary.

### 1.3.0

- **Print / save as PDF** — a Print button that lays out the summary, the
  Go-deeper questions, and the full article (document structure preserved) on
  one printable page.
- **WhatsApp attribution footer** — shared messages end with a "summarized with
  TL;DR Me" link, placed last so the link preview stays the article.
- **Modernized panel header** — blue gradient + brand mark and glassy buttons;
  tuned the panel's translucency for better text contrast.

### 1.2.0

- **Gemini** added as a selectable provider alongside MiniMax — switch in
  ⚙ Settings; the first key you add becomes the default.
- **Go deeper**: opt-in reader provocations (3 article-specific questions) with
  tap-to-reveal perspectives.
- **Summaries cached per URL** — reloads/revisits are instant and free; **↻**
  forces a fresh one.
- **Proofreading pass** + spelling-aware prompt for cleaner output.
- **Stronger language guard** — keeps both the summary and the provocations in
  the article's language, catching stray Chinese/Cyrillic/other-script
  fragments and retrying.
- **WhatsApp share** with a choice of *TL;DR only* or *TL;DR + Key points*;
  archive/proxy URLs (e.g. `archive.is/…/https://…`) unwrapped to the real link.
- **API-key format validation** for both providers.
- Localized UI labels (en/es/pt/fr/de/it) and a frosted, translucent panel.

### 1.0.0

- Initial release: one-click article detection, in-page TL;DR + Key points
  summary via MiniMax, Copy, and settings.

---

## Credits & license

- Article extraction by Mozilla [Readability](https://github.com/mozilla/readability)
  (Apache License 2.0), vendored in `lib/`.
- Summaries by the [MiniMax](https://platform.minimax.io),
  [Gemini](https://ai.google.dev), and [Anthropic](https://www.anthropic.com)
  APIs.

This project's own code is provided as-is for personal use. Add a license of
your choice before distributing.
