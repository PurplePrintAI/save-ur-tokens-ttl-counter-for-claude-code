# Changelog

All notable changes to Claude TTL Counter.

---

## [0.2.0] — 2026-04-21

### Added
- **Per-user context size guidance** — "Which TTL mode" section now explains why the answer varies per user (CLAUDE.md, MEMORY.md, MCP, plugins, harness docs affect cache reset cost)
- **Decision rule** — short turn gaps → 5m saves daily usage; long turn gaps → 1h prevents mysterious limit drops
- **Agentic coding tips** — practical lessons on turn cost, agent reading depth, and prompt quality
- **Maker bio** — background story + PurplePrint System description + founding builder network

### Changed
- **Repo renamed** to `save-ur-tokens-ttl-counter-for-claude-code` — value-first naming for discoverability
- All internal repo references updated (install.js REPO constant, package.json URLs, README curl examples)
- README restructured: Background story, cost note, Before/After, Core + UI table, per-project scope guide

### Fixed
- npm installer now points to correct repo for GitHub Releases API

---

## [0.1.0] — 2026-04-21

Initial public release.

### Features
- **TTL countdown** in status bar — real-time display with 5-stage color (green → orange → warning → danger → expired)
- **Cache health monitoring** — tracks cold starts across recent turns
- **Usage tracking** — per-turn cache hit ratio, fresh tokens, total tokens in tooltip
- **Mode recommendation** — warns when turn gaps don't match current TTL, suggests switch
- **Quick Pick toggle** — click status bar to switch between 5m and 1h modes
- **Per-project TTL** — override global setting per workspace

### How it works
- Reads local Claude files only (`~/.claude/sessions/`, `~/.claude/projects/`, `~/.claude/settings.json`)
- Zero network calls, no proxy, no patching of Claude Code extension

### Docs
- Full bilingual README (English + Korean)
- HOW-TO-USE.md with detailed setup guide
- Per-project TTL configuration guide
