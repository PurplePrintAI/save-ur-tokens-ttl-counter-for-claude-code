# How to Use Claude TTL Counter

> English | **[한국어](./HOW-TO-USE.ko.md)**

**Table of Contents**

- [Quick idea](#quick-idea)
- [What to look at first](#what-to-look-at-first)
- [How to read the numbers](#how-to-read-the-numbers)
- [When to use 5m vs 1h](#when-to-use-5m-vs-1h)
- [Practical scenarios](#practical-scenarios)
- [How to react to warnings](#how-to-react-to-warnings)
- [Ask Claude: /ttl-advisor](#ask-claude-ttl-advisor)
- [Per-project TTL](#per-project-ttl)
- [Rolling status bar](#rolling-status-bar)
- [Subscription usage (5h / 7d)](#subscription-usage-5h--7d)
- [CLI statusline (Claude Code, Codex, any terminal)](#cli-statusline-claude-code-codex-any-terminal)
- [Statusline bridge (fallback)](#statusline-bridge-fallback)

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

Time remaining until cache expires, counted from the **start of the last API request** — your prompt, or the last tool call inside the turn. While the agent is working, every tool call refreshes the cache, so the countdown restarts as the turn progresses. The project name helps you tell windows apart.

### 2. Tooltip

Hover over the status bar to see:

- Mode, and *Observed cache TTL* when the transcript shows a different tier than `settings.json` (a per-project override, for example)
- Last turn: total input tokens, cache hit ratio (higher is better), fresh tokens (lower means more savings)
- Health: TTL-expiry resets in the last 5 turns, plus other cold starts (model switch, compaction, reload) listed separately
- Rhythm: idle gap median and p75 over the last 30 turns, and how many tokens TTL-expiry rebuilds cost
- The recommendation: *"Tip: 1h mode would have cost about 27% less over your last 30 turns"*, or *"Mode check"* when you're already on the cheaper setting

### 3. Usage flash (after each turn)

Right after a turn completes the status bar briefly shows what it cost, then returns to the countdown:

```text
$(pulse) 84k in | hit 82% | 1.3k out          ← this turn's tokens and cache hit ratio
$(dashboard) 5h 22.0% (+0.4%) | 7d 23.0%      ← your real subscription usage and this turn's share
```

The second line needs [subscription usage](#subscription-usage-5h--7d) connected (or the statusline bridge). It turns red when a window is at 90% or more.

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

Two or more TTL-expiry cold starts in the last 5 turns while on `5m`. Each one rebuilt your whole context and burned usage limit.

- Check the tooltip's *Rhythm* line: if idle gaps sit between 5 and 60 minutes, switch to `1h`
- Cold starts caused by a model switch, compaction, or an IDE reload are listed separately; changing the TTL won't fix those

### "1h mode would have cost about 27% less. Switch now?"

The recommendation engine replayed your last 30 turns under both TTLs and found a strong margin. It shows once per session.

- **Switch to …** applies the setting immediately (takes effect from your next prompt)
- **Ask Claude** installs the `/ttl-advisor` skill so your agent can explain it
- Dismiss it if you know the next hour will look different from the last one

---

## Ask Claude: /ttl-advisor

Click the status bar → **Ask Claude why (/ttl-advisor)**, or run *Claude TTL: Install /ttl-advisor skill* from the command palette. This copies `analyze-transcripts.js` and a `SKILL.md` into `~/.claude/skills/ttl-advisor/`. Then type `/ttl-advisor` in Claude Code.

The agent runs the analyzer, reads the JSON (timestamps and token counts only), explains your rhythm and the cost comparison, asks about the next hour only when that would change the answer, and offers to edit `settings.json`.

Run it yourself:

```bash
node ~/.claude/skills/ttl-advisor/analyze-transcripts.js                 # this project, last 30 days
node ~/.claude/skills/ttl-advisor/analyze-transcripts.js --all --days 14 # every project
node ~/.claude/skills/ttl-advisor/analyze-transcripts.js --json          # for scripts / agents
```

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

Note: The status bar toggle only changes the global setting. If a project-level override exists, the toggle won't affect that project — but the countdown still uses the tier the transcript shows in effect, and the tooltip prints *Observed cache TTL* so you can see the override working.

---

## Rolling status bar

After each turn completes, the status bar briefly shows your usage before returning to the TTL countdown:

```
[1] $(clock) TTL 42:15          ← Default: countdown
[2] $(pulse) 84k in · hit 82%   ← 3s: turn usage (distinct background)
[3] $(dashboard) 5h 25.6% (+2.1%) | 7d 42.0%  ← 3s: cumulative usage + delta
[4] $(clock) TTL 42:09          ← Return to countdown
```

- **Step 2 only**: if neither subscription usage nor the statusline bridge is connected, step 3 is skipped
- **Red step 3**: when any window is at 90% or more, the usage flash uses the error background
- **Warning priority**: if a cache reset warning is active, rolling is paused

---

## Subscription usage (5h / 7d)

The IDE extension of Claude Code never exposes your 5-hour / weekly utilization locally, so the extension asks Anthropic for it the same way the CLI's `/usage` does: `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the login token Claude Code already stores (`~/.claude/.credentials.json`, or the macOS Keychain).

### Connect

- Accept the one-time prompt on first launch, **or**
- Click the status bar → **Connect subscription usage (real 5h/7d)**, **or**
- Run *Claude TTL: Connect subscription usage* from the command palette, **or**
- Set `"claudeTtl.subscriptionUsage.enabled": true` in your VS Code settings

Off by default. This is the extension's only network call: one request per `claudeTtl.subscriptionUsage.pollIntervalSeconds` (default 60, minimum 20) plus one about 1.5 seconds after each completed turn, so the rolling flash can show what that turn cost. Only the bearer token is sent, only to `api.anthropic.com`. Tokens are never refreshed or written by the extension.

### What you see

- Rolling flash: `$(dashboard) 5h 22.0% (+0.4%) | 7d 23.0%` — the delta is the difference between the sample after this turn and the sample after the previous one
- Tooltip: `5h usage: 22.0% | resets in 1h 12m`, `7d usage: 23.0% | resets in 5.8d`, per-model lines such as `7d Fable: 41%`, and `Usage source: subscription (max) | updated 12s ago`
- A one-time warning per reset window when 5h or 7d passes 90%
- `Limit hit at 07:22 (five_hour) | resets in 38m` when the transcript contains a refused request

### Troubleshooting

| Tooltip says | Meaning | Fix |
|---|---|---|
| `Subscription usage: not connected` | Feature is off | Connect from the status bar menu |
| `waiting for Claude Code to refresh its login` | The stored token has expired | Send any prompt in Claude Code; it refreshes the token, the extension retries within a minute |
| `no Claude Code login found on this machine` | No `claudeAiOauth` entry in `.credentials.json` / Keychain (API-key users, or not logged in) | Log in to Claude Code with your subscription (`/login`) |
| `temporarily unavailable (HTTP 429)` | Endpoint asked us to back off | Nothing to do; polling resumes after the retry-after window |
| `temporarily unavailable (HTTP 401)` | Token rejected | Re-login in Claude Code; the extension retries after 10 minutes |

---

## CLI statusline (Claude Code, Codex, any terminal)

`bridge/statusline.js` renders the TTL countdown (plus usage when available) as one terminal line. It reads Claude's local files itself, so it works regardless of which CLI you run.

```text
TTL 42:15 · ctx 34% · 5h 22% (1.2h) · 7d 23% (4.6d)
```

### Claude Code CLI (native)

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "node /absolute/path/to/bridge/statusline.js" }
}
```

Claude Code pipes session JSON to the script — transcript path, context %, and (since v2.1.80) 5h/7d `rate_limits` — so you get the full line with no network call. The script also refreshes the bridge file, so the VS Code extension stays in sync when you use both.

### Codex CLI and other CLIs (terminal-level)

Codex CLI only supports a fixed built-in status line (no custom command), and most CLIs have no statusline hook at all. Show the line at the terminal level instead — it works no matter which CLI is in front.

**tmux** (`~/.tmux.conf`):

```tmux
set -g status-right "#(node /absolute/path/to/bridge/statusline.js --usage)"
set -g status-interval 15
```

**Polling panel** in a spare split:

```bash
watch -n 5 node /absolute/path/to/bridge/statusline.js --usage
```

`--usage` lets the script fetch your real 5h/7d from Anthropic (opt-in, token only, 60s background cache), because these hosts don't pipe usage in. Drop it if you only want the TTL countdown, or if the extension / Claude Code statusline already writes a fresh sample.

### Options

| Flag / env | Effect |
|---|---|
| `--usage` or `CLAUDE_TTL_USAGE=1` | Fetch real 5h/7d from `api.anthropic.com` (background, 60s cache). Not needed in Claude Code, which pipes usage in |
| `--no-color` or `NO_COLOR` | Plain output with no ANSI colors |
| `--help` | Show wiring examples |

### Notes

- What it measures is Claude-specific (the 5m/1h cache TTL and Claude subscription usage). Codex (OpenAI) has no user-tunable cache TTL, so the line reflects your Claude sessions, shown in whichever terminal you keep open.
- Usage windows whose reset time has already passed are hidden, so you never see a stale percentage.
- The script never blocks and always exits cleanly, so it is safe as a frequently-refreshed statusline.

---

## Statusline bridge (fallback)

Before v0.7 the only source was a bridge that writes Claude Code's statusline output to a local JSON file. `statusline.js` supersedes it (same bridge-file write, plus the countdown); this section stays for the older `statusline-with-bridge.js` script. It still works, and the extension uses it whenever its file is fresher than the last subscription sample — useful if you prefer no network calls from the extension and use the terminal CLI.

### How it works

1. Claude Code outputs rate limit info via its statusline (terminal CLI only)
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
