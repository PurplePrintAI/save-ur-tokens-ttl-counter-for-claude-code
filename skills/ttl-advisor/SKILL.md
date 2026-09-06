---
name: ttl-advisor
description: Recommend the Claude Code prompt-cache TTL (5m vs 1h) from the user's own transcript timing and token usage, explain the trade-off in their words, and optionally apply the setting. Use when the user asks about TTL, cache mode, cache resets, ENABLE_PROMPT_CACHING_1H, FORCE_PROMPT_CACHING_5M, or why their 5-hour / weekly usage limit drains fast.
---

# TTL advisor

You are helping the user pick the prompt-cache TTL that wastes the least of their subscription usage limit. Claude Code caches the whole context (system prompt, CLAUDE.md, tool schemas, conversation, files read). The cache lives 5 minutes by default or 1 hour with `ENABLE_PROMPT_CACHING_1H=1`, measured from the **start** of the last request that touched it. When it expires, the next request rebuilds everything from scratch at the cache-write price, which is what makes a usage limit drop 10-30% after a coffee break.

Pricing relative to the base input price: cache read 0.1x (0.025x on Claude Fable 5.1), cache write 1.25x on the 5-minute TTL, 2x on the 1-hour TTL. So 1h costs more per turn but avoids rebuilds when the user pauses 5-60 minutes; 5m is cheaper only when pauses are almost always under 5 minutes.

## Step 1 - run the analyzer

The analyzer sits next to this file (`~/.claude/skills/ttl-advisor/analyze-transcripts.js`). It reads only timestamps and token counts from `~/.claude/projects/**/*.jsonl` and never prints prompt text.

```bash
node "$HOME/.claude/skills/ttl-advisor/analyze-transcripts.js" --json
```

On Windows PowerShell use `node "$env:USERPROFILE\.claude\skills\ttl-advisor\analyze-transcripts.js" --json`. Useful flags: `--all` (every project on this machine), `--days 14`, `--window 30` (turns per session used for the per-session comparison), `--session <id>`. If the current directory is not the project the user means, pass `--project <dir>`.

Read the JSON. Key fields:

- `observedTier.latest` and `writesByTier`: the TTL actually in effect, taken from `usage.cache_creation.ephemeral_*` in the transcript. If it disagrees with `~/.claude/settings.json`, a project-level `.claude/settings.json` override or an old Claude Code version is the likely reason.
- `rhythm.idleGapMinutes`: gap between the last API request of a turn and the next prompt. This, not prompt-to-prompt spacing, is what the TTL sees. `turnDurationMinutes.over5mPct` shows how often agentic turns themselves run past 5 minutes (each tool call refreshes the cache, so long turns are fine).
- `rhythm.idleBuckets`: cold-start rate per idle bucket. Cold starts between 5 and 60 minutes mean the 5-minute TTL is expiring; cold starts above 60 minutes are unavoidable with either setting.
- `rhythm.coldStarts.other`: cold starts that were not TTL expiry (model switch, compaction, IDE reload). Changing the TTL will not fix those; say so.
- `rhythm.contextTokens` and `alwaysOnPrefixTokens`: how big a rebuild is. The always-on prefix is shared across sessions of the same project and often survives while the conversation part is lost.
- `simulation.overall` / `simulation.latestSession`: counterfactual cost of replaying the same requests under each TTL. `marginPct` is the relative saving of the cheaper policy.
- `recommendation`: the deterministic call using the same thresholds as the status-bar extension (1h needs >= 5 turns and >= 8% margin; 5m needs >= 8 turns and >= 20% margin, because a wrong 5m call costs more than a wrong 1h call).

## Step 2 - explain, then add what the data cannot know

Give the user a short, concrete picture in plain language: their typical idle gap, how many rebuilds the current TTL caused and roughly how many tokens they cost, and what the other TTL would have cost. Quote the margin. Keep it to a few sentences; a small table of the idle buckets is fine.

Then ask one question only if it changes the answer: what the next hour looks like (tight edit-run loops vs. reading, reviewing, or working in several sessions at once). Long reading between turns, parallel sessions, and large always-on context all push toward 1h. A margin under ~10% means both settings are close; say that rather than forcing a call.

Mention the caveats briefly when relevant: the cost unit is an estimate that assumes usage limits are weighted like API pricing; the 1-hour TTL cannot be extended further, so pauses over an hour rebuild either way; switching takes effect from the next prompt and the old cache keeps its old TTL until then.

## Step 3 - offer to apply it

If the user wants the change, edit the `env` block in `~/.claude/settings.json` (global) or `<project>/.claude/settings.json` (this project only). Show the exact edit and confirm before writing:

- 1 hour: set `"ENABLE_PROMPT_CACHING_1H": "1"` and remove `FORCE_PROMPT_CACHING_5M`.
- 5 minutes: set `"FORCE_PROMPT_CACHING_5M": "1"` and remove `ENABLE_PROMPT_CACHING_1H`.

Keep every other key in the file untouched. Tell the user the new TTL applies from their next prompt and that the Claude TTL Counter status bar will show the observed tier once the next request goes out.

## Do not

- Do not print or summarize prompt contents; the report has none and you should not open transcripts yourself.
- Do not recommend 5m from a handful of fast turns at the start of a session; the analyzer already requires a larger sample for that.
- Do not present the simulated cost as the user's real bill.
