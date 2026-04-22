# How to Use Claude TTL Counter

> English | **[한국어](./HOW-TO-USE.ko.md)**

**Table of Contents**

- [Quick idea](#quick-idea)
- [What to look at first](#what-to-look-at-first)
- [How to read the numbers](#how-to-read-the-numbers)
- [When to use 5m vs 1h](#when-to-use-5m-vs-1h)
- [Practical scenarios](#practical-scenarios)
- [How to react to warnings](#how-to-react-to-warnings)
- [Per-project TTL](#per-project-ttl)
- [Rolling status bar](#rolling-status-bar)
- [Statusline bridge](#statusline-bridge)

---

## Quick idea

This extension is most useful when you want to answer a simple question before sending your next turn:

> "If I send the next prompt now, am I still benefiting from prompt cache?"

---

## What to look at first

### 1. Status bar countdown

```text
TTL 42:15 · my-workspace
```

Time remaining until cache expires. The project name helps you tell windows apart.

### 2. Tooltip

Hover over the status bar to see the last turn's cache stats:

- Total input tokens
- Cache hit ratio — higher is better
- Fresh (non-cached) tokens — lower means more savings
- Cache health (whether cold starts occurred)

---

## How to read the numbers

**Cache hit ratio is the key metric.** High means most tokens were reused from cache. Low means fresh processing.

| Metric | Meaning | Good direction |
|---|---|---|
| Cache hit | Percentage reused from cache | Higher is better |
| Fresh input | Tokens processed from scratch | Lower saves more |
| Cache creation | Tokens newly cached this turn | Normal on first turn |
| Gross input | Total input size the model saw | Reference only |

---

## When to use 5m vs 1h

### `5m` — fast feedback loops

- Rapid bug fixes with short prompts
- Responding within 1-2 minutes
- Cost-sensitive with short pauses

### `1h` — slow, deliberate work

- Reading code, docs, or agent output at length
- Design, planning, review sessions
- Writing long, detailed prompts

Rule of thumb: fast loops → `5m`, deep work → `1h`.

---

## Practical scenarios

### Quick coding loop

Sending short prompts every minute or so.

- Stay on `5m` mode
- Check that TTL has time remaining
- If cache hit stays high, your rhythm is healthy

### Design / review / deep reasoning

Reading documents for several minutes before responding.

- `1h` mode is safer
- On `5m`, the cache may expire while you read

---

## How to react to warnings

### "TTL is under five minutes"

Cache is still alive but expiring soon.

- If you have something to send, send it now
- If you'll be reading for a while, switch to `1h`

### "Recent cache resets look frequent"

Multiple cold starts in recent turns. Fresh token cost is piling up.

- Check if your turn gaps are genuinely long
- If so, consider `1h` mode

---

## Per-project TTL

### Default: global setting

Clicking the status bar toggles `~/.claude/settings.json`. This applies to all Claude Code sessions.

### Per-project override

Create `.claude/settings.json` in your project root:

**This project uses 1h:**

```json
{
  "env": {
    "ENABLE_PROMPT_CACHING_1H": "1"
  }
}
```

**This project uses 5m:**

```json
{
  "env": {
    "FORCE_PROMPT_CACHING_5M": "1"
  }
}
```

### Priority

Claude Code checks project-level settings first, then falls back to global.

```
~/projects/
  design-project/          ← 1h (slow rhythm)
    .claude/settings.json
  bugfix-repo/             ← 5m (fast rhythm)
    .claude/settings.json
  normal-repo/             ← follows global setting
```

Note: The status bar toggle only changes the global setting. If a project-level override exists, the toggle won't affect that project.

---

## Rolling status bar

After each turn completes, the status bar briefly shows your usage before returning to the TTL countdown:

```
[1] $(clock) TTL 42:15          ← Default: countdown
[2] $(pulse) 84k in · hit 82%   ← 3s: turn usage (distinct background)
[3] $(dashboard) 5h 25.6% (+2.1%) | 7d 42.0%  ← 3s: cumulative usage + delta
[4] $(clock) TTL 42:09          ← Return to countdown
```

- **Step 2 only**: if the statusline bridge is not connected, step 3 is skipped
- **Warning priority**: if a cache reset warning is active, rolling is paused

---

## Statusline bridge

The 5h/7d usage display requires a bridge that writes Claude Code's rate limit data to a local JSON file.

### How it works

1. Claude Code outputs rate limit info via its statusline
2. `bridge/write-rate-limits.js` reads that output and writes to `~/.claude/ttl-counter-rate-limits.json`
3. The extension reads that file every 3 seconds

### Manual test

Verify the bridge works by writing test data:

```bash
echo '{"rate_limits":{"five_hour":{"used_percentage":25.6},"seven_day":{"used_percentage":42.0}}}' | node bridge/write-rate-limits.js
```

After this, the next turn completion will show the rate limit flash.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 5h/7d not showing | Bridge file doesn't exist | Set up bridge or run manual test |
| Values don't change | Bridge not updating | Check `updated_at` in the JSON file |
| Delta shows (+0.0%) | Previous and current values are the same | Will update when actual usage changes |
