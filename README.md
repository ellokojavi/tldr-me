# TL;DR Me — Article Summarizer for Firefox

**Reading a long article? TL;DR Me gives you the short version.**

This is a small add-on for the Firefox web browser. When you're on a news story
or blog post, a little **TL;DR** tab appears on the right edge of the page. Click
it and you get a quick summary — a one-line takeaway plus the key points — right
next to the article. You can copy it or send it to a friend on WhatsApp.

It works in the language the article is written in, and you bring your own free
AI key from either **MiniMax** or **Google Gemini** (more on that below).

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

The add-on needs a key from an AI service to write the summaries. Either works:

- **Google Gemini** — go to
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in with
  a Google account, and click **Create API key**. Copy the key (it starts with
  `AIza…`).
- **MiniMax** — create an account at
  [platform.minimax.io](https://platform.minimax.io) and copy your API key.

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

- **Choose your provider.** Add a **MiniMax** and/or **Gemini** API key; the
  first key you add becomes the active provider, and you can switch anytime from
  the ⚙ Settings panel. Both use OpenAI-compatible endpoints.
- **Automatic article detection.** A lightweight check (Mozilla's
  [Readability](https://github.com/mozilla/readability) `isProbablyReaderable`)
  runs on the active tab and shows a green badge on the toolbar icon.
- **On-load "TL;DR" tab.** A small tab appears on the right edge of article
  pages *without* loading the heavy summarizer — it's fetched only when you
  click.
- **Structured Markdown summary.** A highlighted **TL;DR** box plus a
  **Key points** section with proper bullets, numbered steps, headings, and
  bold emphasis.
- **Proofread for quality.** The summary is generated with a strict
  spelling/grammar/accents instruction, then run through a quick second pass
  that fixes any orthographic errors without changing meaning, structure, or
  language (skipped if it would alter content). Runs once per article (cached).
- **Language-faithful.** The summary is written in the article's language. A
  built-in guard detects wrong-language output (the common "answered in
  Chinese" failure) and automatically retries with escalating constraints — the
  **Key points** heading and the **Source** label are localized too.
- **Clean source link.** The article URL is appended (canonical link preferred,
  tracking params stripped) and travels with the copied/shared text.
- **Share.** Copy to clipboard, or open the installed **WhatsApp** app with the
  summary prefilled — choose to send just the **TL;DR** or the **TL;DR + key
  points**; either way the article link is included.
- **Summaries are remembered.** Once an article is summarized, the result is
  saved per URL — revisit or reload the page and the summary appears instantly
  with no new API call. Press **↻** to force a fresh one.
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
                         background.js  ──▶  MiniMax or Gemini (chat/completions)
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
  button in the panel header at any time. Each provider keeps its own key and
  model; the first key you add becomes the default.
  - **MiniMax** — get a key at [platform.minimax.io](https://platform.minimax.io)
    (default model `MiniMax-M2.7`).
  - **Gemini** — get a key at
    [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
    (default model `gemini-2.5-flash`).
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
| Share to WhatsApp | the green WhatsApp **Share** button → choose "TL;DR only" or "TL;DR + Key points" (link always included) |
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

- **Article text is sent to your chosen provider** (`api.minimax.io` or
  `generativelanguage.googleapis.com`) to generate the summary — declared via
  the manifest's `data_collection_permissions` (`websiteContent`).
- **Passive detection** reads only a yes/no "is this an article?" signal from
  the active tab; it does not transmit page content. Full extraction and the
  network call happen only when you click.
- Outbound network access is limited to the two provider hosts.
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
- Summaries by the [MiniMax](https://platform.minimax.io) and
  [Gemini](https://ai.google.dev) APIs.

This project's own code is provided as-is for personal use. Add a license of
your choice before distributing.
