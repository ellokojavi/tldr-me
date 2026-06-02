# TL;DR Me — project rules for Claude

A Firefox (MV3) extension that detects articles, extracts them with Mozilla
Readability, and summarizes them via MiniMax or Gemini (OpenAI-compatible APIs).

## Push rules

**Before every `git push`, review `README.md` and make sure it is up to date.**

- Check whether the commits being pushed change anything user-facing — features,
  settings, supported providers/models, permissions, UI labels, usage steps — and
  update the README to match before pushing.
- Keep the GitHub repository **description** ("subtitle") in sync with the README
  when supported providers/models or the core pitch change.
- Only push once the README accurately reflects the current behavior. If nothing
  user-facing changed, no README edit is needed — just confirm it's still correct.

## Conventions

- After changing extension code, run `npx web-ext lint --source-dir .` (expect 0
  errors; the `innerHTML` notices are sanitized/static and acceptable).
- Prefer simple, single-purpose shell commands (use `git -C <repo>` and absolute
  paths rather than `cd …` chains) so they match the project permission allowlist.
- Never commit API keys; the user's MiniMax/Gemini keys live only in
  `browser.storage.local` at runtime, never in the repo.
