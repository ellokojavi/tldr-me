# TL;DR Me — project rules for Claude

A Firefox (MV3) extension that detects articles, extracts them with Mozilla
Readability, and summarizes them via MiniMax, Gemini, or Anthropic (Claude)
(OpenAI-compatible APIs).

## Push rules

**Before every `git push`, review the ENTIRE `README.md` for consistency and
accuracy — not just the sections touched by this push.**

- Read the whole README and check every part for drift: intro/pitch, features,
  "How it works", install/config steps, usage table, project structure, privacy,
  limitations, changelog, version references, links, and the screenshot.
- Update anything the pushed commits changed — features, settings, supported
  providers/models, permissions, UI labels, usage steps — and fix any pre-existing
  inconsistency you notice while reviewing.
- Keep the GitHub repository **description** ("subtitle") in sync with the README
  when supported providers/models or the core pitch change.
- Only push once the README is internally consistent and accurately reflects the
  current behavior.

## Conventions

- After changing extension code, run `npx web-ext lint --source-dir .` (expect 0
  errors; the `innerHTML` notices are sanitized/static and acceptable).
- Prefer simple, single-purpose shell commands (use `git -C <repo>` and absolute
  paths rather than `cd …` chains) so they match the project permission allowlist.
- Never commit API keys; the user's MiniMax/Gemini/Anthropic keys live only in
  `browser.storage.local` at runtime, never in the repo.
