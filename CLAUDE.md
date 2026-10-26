# CLAUDE.md

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `yurenju/manga-translator` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Real-site debugging

A bug that shows on a real manga site (Jump+, Kindle) but not on the e2e mock site: have the user reproduce it while `npm run debug:chrome` records a trace of the whole pipeline. Timing and performance: measure in that Chrome with `npm run debug:eval`. See `docs/agents/real-site-debugging.md`.

## Coding standards

Reviewing a change: check it against `CODING_STANDARDS.md`.
