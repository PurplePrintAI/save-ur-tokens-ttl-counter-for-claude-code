# Save ur usage limit! — Claude TTL Counter

> English | **[한국어](./README.ko.md)**

> Keep the prompt cache warm, so a TTL expiry doesn't rebuild your whole context and eat your 5-hour / weekly usage limit.

> **Renamed from "Save ur tokens!"** — the old name was slightly wrong. This extension doesn't reduce the tokens you send. It stops the cache TTL from expiring unnoticed, and with it the full cache rebuild that burns your *subscription usage limit*. Same tool, more honest name. (The GitHub repo was renamed too; old links redirect.)

**"I barely used it today, but my daily limit is already gone."** *(Claude Code has a 5-hour rolling usage limit — in practice, it feels like a daily limit.)* If that sounds familiar, it's probably not the model — it's an invisible cache setting that doesn't match how you actually work. Claude Code has a prompt cache that reuses previous context, but the default time-to-live (TTL) for that cache is set to just **5 minutes** (this was [silently changed](https://www.reddit.com/r/ClaudeCode/comments/1sk3iyq/followup_anthropic_quietly_switched_the_default/) recently). That means if more than 5 minutes pass after the last request in your session (your prompt, or the last tool call inside a turn), all the cached context resets — and the next request has to rebuild it from scratch at the cache-write price. The more context you've accumulated (conversation history, files read, tool calls), the bigger the rebuild. That's why your usage limit can suddenly drop even though you barely sent anything — it's not you using more, it's the cache silently expiring and being rebuilt.

> **TL;DR — which setting is right for you?**
> - **Idle gaps between turns usually < 5 min** → stay on `5m` (default). Cheaper cache writes, and the cache stays warm on its own.
> - **Idle gaps often 5–60 min** → switch to `1h`. Otherwise the cache silently resets between turns and your limit drops fast without you knowing why.
> - **Not sure?** Hover the status bar: the extension replays your recent turns under both settings and tells you which one would have cost less. Or run `/ttl-advisor` in Claude Code and let your own agent explain it.

**This extension shows a live countdown of your cache timer right in the status bar — so you always know how much time you have.** No more wondering "has it expired yet?" while you're reading code or thinking about your next prompt. It also replays your real turn history under both TTL settings and recommends the cheaper one. Follow the recommendation, change one setting, and stop losing usage limit to resets you didn't even know were happening.

I built this because I kept hitting the daily limit without understanding why. After switching to the right cache setting and using this counter, cache resets went from 5–6 times a day down to 1–2. I stopped rushing my prompts, started reading agent output carefully, and got better results with fewer turns. I hope this helps you waste less of your usage limit, worry less, and enjoy working with your agent a little more.

---

**Table of Contents**

- [Background](#background)
- [Important note on cost](#important-note-on-cost)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Real subscription usage (5h / 7d)](#real-subscription-usage-5h--7d)
- [How the recommendation works](#how-the-recommendation-works)
- [Which TTL mode?](#which-ttl-mode-should-you-use)
- [Install](#install)
- [Quick start](#quick-start)
- [Ask your own agent: /ttl-advisor](#ask-your-own-agent-ttl-advisor)
- [Privacy](#privacy)
- [Tips for agentic coding](#tips-for-agentic-coding)
- [Made by](#made-by)

---

## Background

Before I understood prompt caching, I just wondered why Claude Code burned through tokens so fast (my first turn would eat 14–20% of daily usage, then after a short break another turn would burn 15% more — I was genuinely confused). Once I learned how it worked, I realized the default 5-minute TTL was a terrible fit for my workflow — I spend long stretches reading design documents, reviewing agent reasoning and chain-of-thought, coordinating across multiple agent sessions (e.g. designing and reviewing in Claude Code while delegating implementation or research to Codex in parallel), and thinking before my next turn. Every time I came back after a few minutes of reading, the cache had quietly expired and the next prompt triggered a full cache rebuild — tokens just melted away.

I knew this was a serious problem — daily usage limits create a real bottleneck in agentic coding workflows. So I dug in: discussed it with my agent, researched on Reddit, and reasoned through the mechanics until I was convinced that the 5-minute TTL was the root cause of the token drain. I switched to 1-hour TTL immediately. The first prompt after TTL expiry still costs 10–15% for cache rebuild, but within that hour each turn only costs 1–4%. Token efficiency improved dramatically. But then a new anxiety appeared: I couldn't tell whether the hour had passed or not. I'd catch myself wondering mid-thought, "has it expired yet?" So I built this counter to remove that uncertainty — to stay focused on the work instead of watching the clock in my head. Since then, I don't worry about cache expiry at all. I take my time reading the agent's reasoning process carefully, going through hundreds or thousands of lines of research documents, implementation reports, and task instructions that the agents produce. That reading time turns into learning and better judgment, which leads to more precise prompts with richer context — and ultimately fewer turns for better results.

I see a lot of people on Threads frustrated about token consumption. But often the fix is surprisingly simple — a settings change that takes seconds. The real problem is that many people don't even know this lever exists, or what question to ask to find it. This isn't just a beginner issue; I've seen experienced developers with years of coding struggle with the same thing. You can't fix what you can't see.

I hope this small tool helps you save a few more tokens, worry a little less, and enjoy the conversation with your agent a bit more.

## Important note on cost

The 5-minute and 1-hour cache modes have [different pricing](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing). 1-hour caching costs more per cached token than 5-minute. So yes, there is a price difference — and you should be aware of it.

But here's what actually hurts more in practice: **cache resets**. If you're on the default 5-minute TTL and you don't know it, every time you take a few minutes to read or think before your next turn, the cache silently expires. The next prompt triggers a full cache rebuild. That single reset can consume 10–30% of your daily usage in one shot. A lot of people say "Opus just eats too many tokens" — but it's usually not the model being expensive. It's the cache silently resetting and rebuilding from scratch every few turns. Without understanding prompt caching and TTL, the only thing left to blame is the model.

So the real question isn't "is this model too expensive?" — it's "how much am I losing to invisible cache rebuilds that I didn't even know were happening?"

**Here's a real example**: just reloading the IDE window (Developer: Reload Window) triggers a temporary "Untitled" session that rebuilds the cache for all your always-on context — CLAUDE.md, MEMORY.md, MCP schemas, plugins. In our testing, this consumed about **8% of daily usage** just from re-caching system context, without sending a single prompt. The problem? **You don't actually use that Untitled session.** You go right back to your real session — meaning that 8% was pure waste. If your always-on context is large (long CLAUDE.md, multiple MCP servers, harness framework docs), even a single reload can be a surprisingly expensive throwaway.

### Community discussions

This isn't a niche issue. In early March 2025, Anthropic quietly changed the default prompt cache TTL from 1 hour to 5 minutes without prior announcement. Users across Reddit immediately noticed their daily usage limits draining far faster than before — many hitting the 5-hour quota cap for the first time. The community traced the root cause back to this silent TTL change, and the discussion quickly escalated into a transparency debate.

- **[Reddit r/ClaudeAI — "Did they just find the issue with Claude cache?"](https://www.reddit.com/r/ClaudeAI/comments/1sjxrp1/did_they_just_find_the_issue_with_claude_cache/)** (Apr 13, 2025) — The post that first suspected the link: the sudden spike in Opus daily usage starting early March might be related to Anthropic's silent TTL default change on March 6th. Not confirmed, but the timing and symptoms align.
- **[Reddit r/ClaudeCode — "Followup: Anthropic quietly switched the default TTL"](https://www.reddit.com/r/ClaudeCode/comments/1sk3iyq/followup_anthropic_quietly_switched_the_default/)** (Apr 13, 2025) — Follow-up with evidence: 17–32% increase in cache rebuild costs confirmed. Multiple users reporting first-time quota hits. Community demanding advance notice for cost-affecting changes.
- **[GeekNews (Korean) — same incident](https://news.hada.io/topic?id=28461)** (Apr 13, 2025) — Korean developer community discussion. Frustration over silent policy changes, some teams already switching tools.

## What it does

**Core:**
- Finds the active Claude session for your current workspace
- Follows same-project session switching more reliably by tracking the latest workspace transcript activity
- Tracks the TTL countdown from the **start of the last API request** (your prompt, or the last tool call inside a turn). Anthropic measures the TTL from there, so long agentic turns no longer show a false "expired"
- Reads the cache tier **actually used** by each request (`usage.cache_creation.ephemeral_5m / ephemeral_1h`), so the countdown is right even with a per-project override, and the tooltip flags a mismatch with `settings.json`
- Classifies cold starts on the opening call of each turn: session start / TTL expiry / other (model switch, compaction, reload)
- **Counterfactual recommendation**: replays your last 30 turns under both TTLs with real timestamps and token counts, and recommends the cheaper one with the margin (e.g. "1h would have cost about 27% less")
- **`/ttl-advisor`**: one click installs a Claude Code skill so your own agent runs the analyzer and explains the recommendation in context
- **Real subscription usage (opt-in)**: reads your 5-hour / 7-day / per-model weekly utilization from Anthropic with the login Claude Code already stores, so the status bar shows the same numbers as `/usage` — no terminal statusline needed
- **Rolling status bar feedback** after each turn: `TTL → turn usage → 5h/7d rate limit → TTL`

**What you see:**

| Location | Example | Description |
|---|---|---|
| **Status bar** | `$(clock) TTL 42:15 · my-project` | Default: live countdown + project name. 5-stage color |
| **Turn usage flash** | `$(pulse) 84k in · hit 82% · 1.3k out` | 3s after turn completes. Distinct background color |
| **Rate limit flash** | `$(dashboard) 5h 25.6% (+2.1%) · 7d 42.0%` | Real 5h/7d usage + per-turn delta. Turns red at 90%. Subscription connection (opt-in) or statusline bridge |
| **Tooltip** (hover) | `Rhythm: idle gap median 3.4m · p75 16m` | Cache hit ratio, health, observed tier, TTL-expiry rebuilds, recommendation with margin |
| **Quick Pick** (click) | `$(check) 1h mode · Current · 42:15` | Switch between 5m and 1h, or **Ask Claude why (/ttl-advisor)** |
| **Notification** | `"1h would have cost about 27% less. Switch now?"` | Once per session on a strong recommendation, with **Switch** / **Ask Claude** buttons. A separate warning fires when TTL-expiry resets pile up on 5m |

> **"Why don't I see 5h/7d usage?"** Click the status bar → **Connect subscription usage**, or accept the one-time prompt on first launch. Until v0.6 the numbers only appeared when Claude Code's terminal statusline wrote them to a bridge file, which never happens inside the VS Code / Cursor extension. v0.7 reads them from Anthropic directly — see [Real subscription usage](#real-subscription-usage-5h--7d). Without a connection, the rolling sequence is `TTL → turn usage → TTL`.

## How it works

This extension does **not** patch the Claude Code extension and does **not** proxy Claude requests. Instead, it reads local Claude files:

- `~/.claude/sessions/*.json` — active session detection
- `~/.claude/projects/**/<sessionId>.jsonl` — request timestamps, cache usage, and the cache tier per request (read incrementally: only lines appended since the last poll are parsed)
- `~/.claude/settings.json` — TTL mode read/write
- `~/.claude/skills/ttl-advisor/` — written only when you install the `/ttl-advisor` skill
- `~/.claude/.credentials.json` (macOS: Keychain) — read only when you connect subscription usage, to send Claude Code's own login token to `api.anthropic.com/api/oauth/usage`

## Real subscription usage (5h / 7d)

Claude Code shows your 5-hour and weekly utilization in `/usage`, but it never writes those numbers anywhere the extension can read — the terminal statusline gets them, the IDE extension doesn't. So v0.7 asks Anthropic directly: the same `GET /api/oauth/usage` request the CLI makes, authenticated with the login token Claude Code already keeps on this machine. You get:

- **5h and 7d utilization** with reset countdowns (`5h 22.0% | resets in 1h 12m`)
- **Per-model weekly limits** when your plan has them (`7d Fable: 41%`)
- **Per-turn delta** in the rolling flash: a fresh sample is taken right after each turn completes, so `(+2.1%)` is what that turn cost
- **Red flash and a one-time warning** when a window passes 90%
- **"Limit hit at 07:22 (five_hour) | resets in 38m"** in the tooltip when the transcript shows a refused request

How to connect: click the status bar → **Connect subscription usage**, or run *Claude TTL: Connect subscription usage*. The first launch also offers it once. It is **off by default** because it is the extension's only network call: one request about every minute (`claudeTtl.subscriptionUsage.pollIntervalSeconds`) plus one after each turn, sent only to `api.anthropic.com`, carrying only the bearer token. The extension never refreshes or writes tokens; if the token has expired it simply waits for Claude Code to refresh it on its next request. Disconnect anytime from the same menu or `claudeTtl.subscriptionUsage.enabled`.

The statusline bridge from v0.4 still works and is used as a fallback whenever its file is fresher than the last subscription sample.

## How the recommendation works

Earlier versions thresholded the median gap between your prompts. Analyzing a month of real transcripts showed two problems with that:

1. **Prompt-to-prompt gaps overstate idle time.** Agentic turns are long — in that data the median turn ran 6.6 minutes and 57% ran longer than 5 minutes. Every tool call inside a turn refreshes the cache, so what the TTL actually sees is the gap between the *last request of a turn* and the *next prompt*. Median prompt gap: 16 minutes. Median idle gap: 3.4 minutes.
2. **A median hides mixed rhythms.** Many sessions alternate 1–3 minute bursts with 15–90 minute reading gaps. One number can't price that trade-off.

v0.6 replaces the threshold with a **counterfactual cost simulation** (`src/recommendation.ts`):

- Take the API calls of your last 30 turns: real request timestamps, real `cache_read` / `cache_creation` sizes, model.
- Replay them under `5m` and under `1h`. A call whose gap from the previous request exceeds the TTL rebuilds the whole context at the cache-write price; otherwise it reads from cache.
- Price it with Anthropic's published multipliers relative to base input: cache read 0.1× (0.025× on Claude Fable 5.1), cache write 1.25× on `5m` or 2× on `1h`.
- Recommend the cheaper policy only when the margin is large enough for the sample: `1h` needs ≥ 5 turns and ≥ 8% margin; `5m` needs ≥ 8 turns and ≥ 20% margin, because a wrong `5m` call costs far more than a wrong `1h` call. ≥ 25% / ≥ 35% counts as "strong" and also triggers a one-time notification with a Switch button.

The tooltip shows the result as *"Tip: 1h mode would have cost about 27% less over your last 30 turns"* — or *"Mode check: 1h mode is the cheaper choice"* when you're already on the right one.

The same engine runs standalone in `bridge/analyze-transcripts.js` over any number of days or projects, and the `/ttl-advisor` skill hands its JSON to your own agent so it can add what the data can't know — what you're about to do next.

**Assumption to keep in mind**: subscription usage limits are assumed to be weighted like API pricing. Treat absolute numbers as estimates; the *comparison* between the two policies is the signal.

For reference, one heavy user's month (207 sessions, 1,800 turns, contexts around 460k tokens): `1h` was about 27% cheaper overall, every long design session preferred `1h`, and only tiny one-shot sessions preferred `5m`. Yours will differ — that's the point of measuring instead of guessing. Feedback on the engine is collected in [Issue #1](https://github.com/PurplePrintAI/save-ur-usage-limit-ttl-counter-for-claude-code/issues/1).

## Which TTL mode should you use?

### `5m` — fast rhythm

- Sending turns quickly and repeatedly
- Tight coding / fix / retry loops
- Usually responding within 1-2 minutes
- Cheaper cache mode with short pauses

### `1h` — slow rhythm

- Pausing to read code, docs, or output
- Design, planning, review between turns
- Validating agent work for several minutes
- Longer, more deliberate prompts

### But it depends on your setup

The "right" TTL isn't universal — it depends on **how much context you carry**. When cache expires, everything currently loaded has to be re-cached from scratch. The bigger that context is, the more painful a single reset becomes.

**What makes up your context:**

Things that load every session (always-on):
- `CLAUDE.md` — some people have 5 lines, others have 200+ lines with detailed project rules
- `MEMORY.md` — auto-memory that grows over time
- MCP servers — each connected tool adds its schema to context
- Plugins and custom slash commands
- Harness/framework docs — if you use a structured system, those documents load every session too

Things that accumulate during a session:
- Conversation history — grows with every turn
- Files and code the agent has read
- Tool call results

All of this combined is "what gets re-cached when TTL expires." If your always-on context is small, a reset might cost 3–5%. If it's large, a single reset can cost 15–30%.

The heavier your always-on context, the more `1h` acts as a safety net.

**TL;DR**: `5m` for speed, `1h` for depth.

### Scope: global vs per-project

By default, clicking the status bar toggles the **global** TTL mode (`~/.claude/settings.json`). If you need different TTL modes per project, you can set a project-level override. See [HOW-TO-USE.md § Per-project TTL](./HOW-TO-USE.md#per-project-ttl--프로젝트별-ttl-설정) for details.

### When you switch modes

**The new TTL takes effect from your next prompt — no new session needed.** According to the [official docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), cache is refreshed each time it's used. However, the docs don't explicitly say whether changing the TTL tier retroactively extends existing cache. Based on our testing, it appears that cache created under the old tier keeps its original TTL — meaning it likely can't be extended retroactively. (If Anthropic clarifies this, we'll update.)

What this means in practice: if you switch from `5m` → `1h` and **more than 5 minutes have already passed** since your last prompt, the old 5-minute cache has likely already expired. Your next turn will trigger one cache rebuild. **But from that turn onward, all new cache is created with the 1-hour TTL**, and you'll be stable. **Tip**: if you're about to switch modes, sending one quick prompt *before* switching can refresh the existing cache, making the transition smoother.

> **Don't panic if the first turn after switching feels heavy.** It's likely the last echo of the old setting — not a sign that the change didn't work. From the second turn onward, you're on the new TTL.

> **Accidentally switched? No worries.** If you switch modes and switch back *before* sending a prompt, nothing changes — no new cache is created, no tokens spent. The setting only takes effect when you actually send your next prompt.

## Install

### Option 1: npm (recommended)

```bash
npx claude-ttl-counter-install
```

Automatically detects VS Code or Cursor and installs the latest version.

### Option 2: Manual VSIX

```bash
# VS Code
curl -L https://github.com/PurplePrintAI/save-ur-usage-limit-ttl-counter-for-claude-code/releases/latest/download/claude-ttl-counter-0.7.0.vsix -o /tmp/ttl.vsix && code --install-extension /tmp/ttl.vsix

# Cursor
curl -L https://github.com/PurplePrintAI/save-ur-usage-limit-ttl-counter-for-claude-code/releases/latest/download/claude-ttl-counter-0.7.0.vsix -o /tmp/ttl.vsix && cursor --install-extension /tmp/ttl.vsix
```

### Option 3: From IDE

`Ctrl+Shift+P` → "Extensions: Install from VSIX..." → select the `.vsix` file.

## Quick start

1. Install the extension
2. Open the same workspace you use with Claude Code
3. Look for the countdown in the bottom status bar
4. Click to switch between `5m` and `1h`
5. Hover to inspect cache metrics

For a detailed guide, see [HOW-TO-USE.md](./HOW-TO-USE.md).

## Ask your own agent: /ttl-advisor

The status bar can tell you *which* setting is cheaper. Your agent can tell you *why*, in the context of what you're doing. Click the status bar → **Ask Claude why (/ttl-advisor)**, or run the command *Claude TTL: Install /ttl-advisor skill*. That copies a small analyzer plus a `SKILL.md` into `~/.claude/skills/ttl-advisor/`. Then, in Claude Code:

```text
/ttl-advisor
```

Your agent runs the analyzer (timestamps and token counts only — it never reads prompt text), explains your idle-gap distribution and how many rebuilds each TTL would have caused, asks what the next hour looks like when that would change the answer, and offers to edit `settings.json` for you — globally or just for this project.

You can also run the analyzer yourself:

```bash
node ~/.claude/skills/ttl-advisor/analyze-transcripts.js            # this project, last 30 days
node ~/.claude/skills/ttl-advisor/analyze-transcripts.js --all --json
```

## Privacy

- Reads only local Claude files on your machine
- Does not proxy or intercept Claude requests
- Does not upload data anywhere
- Zero network calls by default. The optional subscription usage connection makes exactly one kind of request — `GET https://api.anthropic.com/api/oauth/usage` with the login token Claude Code already stores — about once a minute. It is off until you turn it on, and nothing else is ever sent
- The `/ttl-advisor` analyzer reads timestamps and token counts only; its report contains no prompt text

## Development

Contributions and forks are welcome. This is a small, focused project — the core logic is in seven TypeScript files. `src/transcript-tracker.ts` and `src/recommendation.ts` have no `vscode` dependency, so you can exercise them with plain node.

**Help improve the recommendation logic**: The engine is a counterfactual cost simulation (see [How the recommendation works](#how-the-recommendation-works)). Run `node bridge/analyze-transcripts.js --all` on your own machine and tell us whether the verdict matches your experience — see **[Issue #1: RFC — Recommendation logic](https://github.com/PurplePrintAI/save-ur-usage-limit-ttl-counter-for-claude-code/issues/1)**.

```bash
npm install        # install dependencies
npm run compile    # build
```

To test locally, package as VSIX and install in your IDE:

```bash
npx @vscode/vsce package --no-dependencies
# then: Ctrl+Shift+P → "Extensions: Install from VSIX..."
```

## License

MIT

---

## Tips for agentic coding

If you found this repo because your token usage feels out of control, here are a few things I've learned the hard way:

**Every turn is communication cost.** Each message to the agent consumes accumulated context as tokens. Prompt caching helps, but the fundamental cost grows with context size. The key insight: reducing turns is often more impactful than optimizing tokens per turn — just like reducing meetings is often better than making each meeting shorter.

**Agents don't read 100% unless you tell them to.** Multi-agent, sub-agent setups can be efficient for some tasks, but they tend to skim rather than fully read. Important context gets lost, design documents and code drift apart, and the output quality drops — quietly. On top of that, they consume a lot of tokens. The result: your daily usage burns fast, but the work moves forward with critical context missing. That's why my harness is designed to only summon multi-agent/sub-agents for specific task types. For high-context work, having the main agent read everything fully turned out to save tokens *and* produce better results.

**Your prompting quality determines token efficiency.** The better you structure what you ask — clear context, specific requirements, one instruction at a time — the fewer turns it takes to get the right result. This is the real leverage point.

---

## Made by

I believe the gap between "having an idea" and "building it" shouldn't be this wide. Most people stop not because their idea is bad, but because they don't have the language to turn it into something real. I build tools that close that gap — so more people can start, and fewer good ideas die quiet.

I studied biology through a doctoral program (genotyping, toxicogenomics), then spent six years running [BringTheHome](https://bringthehome.co.kr) — an IoT-based indoor climate diagnostics service that identifies and corrects temperature and humidity problems in living spaces. That experience of watching real users struggle with invisible environmental issues led me to build [kngka](https://company.kngka.com), a digital health diary for rhinitis management where users record 30 seconds of breathing sound and the app scores their nasal condition using acoustic analysis. Somewhere along the way I realized the same pattern kept appearing: people have real problems but lack the structured language to solve them. That's what brought me to AI agent systems and product design. Through building products across these different domains — and through 40+ days of intensive agentic coding — I've developed a working fluency in AI-assisted service design, multi-agent orchestration, prompt engineering, and the kind of structured product thinking that turns vague ideas into buildable specs.

Now I build tools at that intersection. I've built a structured harness framework (private repo) for the entire service building journey — from defining the problem and persona, through design documents, UX, branding, marketing strategy, all the way to a developer handoff. The AI doesn't just answer questions; it knows what to ask you, in what order, and structures your answers into actual design artifacts. Think of it as giving your idea a senior product manager who works 24/7 and never loses context. I'm also building a web service so anyone can experience this harness without a complex IDE setup.

I'm working with a small group of founding builders — people with deep domain expertise and real ideas, but who haven't been through the full service design → build → GTM journey before, and are just getting started with agentic coding. They have a genuine intention to solve real problems and inefficiencies in their domains. Using the harness I've built and everything I've learned along the way, I'm helping them turn their ideas into real products. We're starting small, learning by doing, and improving together.

On the side, I ship small open-source utilities like this TTL counter that solve real friction points I hit every day in agentic coding workflows.

Contact: purpleprintai@gmail.com · [@ylkim.0to1](https://www.threads.net/@ylkim.0to1)
