# Save ur tokens! — Claude TTL Counter

**"I barely used it today, but my daily limit is already gone."** If that sounds familiar, it's probably not the model — it's an invisible cache setting that doesn't match how you actually work. Claude Code has a prompt cache that reuses previous context, but the default time-to-live (TTL) for that cache is set to just **5 minutes** (this was [silently changed](https://www.reddit.com/r/ClaudeCode/comments/1sk3iyq/followup_anthropic_quietly_switched_the_default/) recently). That means if more than 5 minutes pass after your last prompt, all the cached context in your session resets — and the next turn has to rebuild it from scratch. The more context you've accumulated (conversation history, files read, tool calls), the bigger the rebuild cost. That's why your daily usage can suddenly spike even though you barely sent anything — it's not you using more, it's the cache silently resetting and rebuilding everything.

**"오늘 거의 안 썼는데 일간 리밋이 왜 벌써 없지?"** 이 느낌이 익숙하다면, 모델이 비싼 게 아니라 보이지 않는 캐시 설정이 작업 방식과 안 맞아서일 가능성이 높아요. Claude Code에는 이전 맥락을 재활용하는 프롬프트 캐시가 있는데, 이 캐시가 살아있는 시간(TTL) 기본값이 **5분**으로 설정되어 있어요 ([최근에 잠수함 패치됐었어요](https://www.reddit.com/r/ClaudeCode/comments/1sk3iyq/followup_anthropic_quietly_switched_the_default/)). 다시 말해, 프롬프트를 입력한 지 5분이 지나면 채팅 세션에 잔뜩 쌓인 캐시가 초기화되고, 다음 턴에서 처음부터 다시 캐싱하면서 일간 사용량이 급증하는 거예요. 특히 쌓여 있는 게 많을수록(대화 히스토리, 읽은 파일, 도구 호출 결과) 재구축 비용이 커지면서, 갑자기 일간 사용량이 폭발하는 것처럼 보이는 거죠.

> **TL;DR — which setting is right for you?**
> - **Turn gaps usually < 5 min** → stay on `5m` (default). Cache stays warm. Cheaper per-token rate. Daily usage stays steady.
> - **Turn gaps often > 5 min** → switch to `1h`. Otherwise the cache silently resets between turns and your daily limit drops fast without you knowing why.
>
> **TL;DR — 어떤 설정이 맞을까요?**
> - **턴 간격이 보통 5분 미만** → `5분` (기본값) 유지하세요. 캐시가 자연스럽게 유지돼요. 토큰당 비용도 저렴하고, 일간 사용량이 차곡차곡 절약돼요.
> - **턴 간격이 5분 넘는 경우가 많다** → `1시간`으로 바꾸세요. 안 바꾸면 턴 사이에 캐시가 조용히 리셋되면서, 영문도 모른 채 일간 리밋이 급감해요.

**This extension shows a live countdown of your cache timer right in the status bar — so you always know how much time you have.** No more wondering "has it expired yet?" while you're reading code or thinking about your next prompt. It also watches your work rhythm and recommends the right cache setting for you. Follow the recommendation, change one setting, and stop losing tokens to resets you didn't even know were happening.

**이 확장은 캐시 만료까지 남은 시간을 상태 바에서 실시간 카운트다운으로 보여줘요 — 지금 얼마나 남았는지 항상 알 수 있어요.** 코드를 읽거나 다음 프롬프트를 고민하면서 "혹시 만료됐나?" 불안해할 필요가 없어요. 그리고 작업 리듬을 보고 적합한 캐시 설정도 추천해줘요. 추천에 따라 설정 하나만 바꾸면, 모르는 사이에 캐시가 리셋되면서 토큰이 낭비되는 걸 막을 수 있어요.

I built this because I kept hitting the daily limit without understanding why. After switching to the right cache setting and using this counter, cache resets went from 5–6 times a day down to 1–2. I stopped rushing my prompts, started reading agent output carefully, and got better results with fewer turns. I hope this helps you waste fewer tokens, worry less, and enjoy working with your agent a little more.

저도 일간 리밋에 왜 자꾸 걸리는지 모르겠어서 만들었어요. 적합한 캐시 설정으로 바꾸고 이 카운터를 쓰기 시작한 뒤, 캐시 리셋이 하루 5–6번에서 1–2번으로 줄었어요. 프롬프트를 급하게 보내지 않게 됐고, 에이전트 산출물을 꼼꼼히 읽게 됐고, 더 적은 턴으로 더 좋은 결과를 얻게 됐어요. 이 도구가 토큰 낭비를 줄이고, 불안을 덜고, 에이전트와의 작업을 조금 더 즐기는 데 도움이 되면 좋겠어요.

---

**Table of Contents / 목차**

- [Background / 만든 배경](#background--만든-배경)
- [Important note on cost / 비용 유의사항](#important-note-on-cost--비용-관련-유의사항)
- [Why this exists / 왜 만들었나](#why-this-exists)
- [Before → After](#before--after)
- [What it does / 기능 + UI 예시](#what-it-does--기능)
- [How it works / 작동 방식](#how-it-works--작동-방식)
- [Which TTL mode? / 어떤 모드?](#which-ttl-mode-should-you-use--어떤-모드를-쓸까)
- [Install / 설치](#install--설치)
- [Quick start / 시작하기](#quick-start--시작하기)
- [Privacy / 개인정보](#privacy--개인정보)
- [Tips for agentic coding / 에이전틱 코딩 팁](#tips-for-agentic-coding--에이전틱-코딩-팁)
- [Made by / 만든 사람](#made-by--만든-사람)

---

## Background / 만든 배경

Before I understood prompt caching, I just wondered why Claude Code burned through tokens so fast (my first turn would eat 14–20% of daily usage, then after a short break another turn would burn 15% more — I was genuinely confused). Once I learned how it worked, I realized the default 5-minute TTL was a terrible fit for my workflow — I spend long stretches reading design documents, reviewing agent reasoning and chain-of-thought, coordinating across multiple agent sessions (e.g. designing and reviewing in Claude Code while delegating implementation or research to Codex in parallel), and thinking before my next turn. Every time I came back after a few minutes of reading, the cache had quietly expired and the next prompt triggered a full cache rebuild — tokens just melted away.

프롬프트 캐싱 개념을 알기 전에는, Claude Code 토큰이 왜 이렇게 빨리 쓰이는지 의문만 있었어요 (첫 턴에 일간 사용량의 14–20%가 빠지고, 잠깐 다른 작업을 하다 돌아와서 한 턴 더 보냈을 뿐인데 또 15%가 날아가서 당황한 적이 한두 번이 아니었어요). 개념을 알고 나서야, 기본값 5분 TTL이 제 작업 방식에 전혀 맞지 않다는 걸 깨달았어요 — 저는 설계 문서를 오래 읽고, 에이전트의 추론과 chain-of-thought를 전부 읽고, 다른 에이전트 세션과 병행 작업을 하고 (예를 들어 Claude Code로 설계와 검수를 하면서 동시에 Codex에게 구현이나 리서치를 지시하는 식으로, 여러 세션을 오가며 작업하는 경우), 다음 턴을 보내기 전에 한참 생각하는 편이거든요. 몇 분만 읽다 돌아오면 캐시가 조용히 만료돼서, 다음 프롬프트에 캐싱이 다시 이루어지면서 토큰이 녹아버렸던 거죠.

I knew this was a serious problem — daily usage limits create a real bottleneck in agentic coding workflows. So I dug in: discussed it with my agent, researched on Reddit, and reasoned through the mechanics until I was convinced that the 5-minute TTL was the root cause of the token drain. I switched to 1-hour TTL immediately. The first prompt after TTL expiry still costs 10–15% for cache rebuild, but within that hour each turn only costs 1–4%. Token efficiency improved dramatically. But then a new anxiety appeared: I couldn't tell whether the hour had passed or not. I'd catch myself wondering mid-thought, "has it expired yet?" So I built this counter to remove that uncertainty — to stay focused on the work instead of watching the clock in my head. Since then, I don't worry about cache expiry at all. I take my time reading the agent's reasoning process carefully, going through hundreds or thousands of lines of research documents, implementation reports, and task instructions that the agents produce. That reading time turns into learning and better judgment, which leads to more precise prompts with richer context — and ultimately fewer turns for better results.

이게 큰 문제라고 생각했어요. 일간 사용량 제한은 에이전틱 코딩에서 매우 큰 병목을 만드니까요. 해결하기 위해 에이전트와 토론하고, 레딧을 리서치하고, 직접 추론해본 결과 TTL 5분이 토큰이 녹아버리는 원인이라는 확신을 얻었고, 곧바로 1시간 TTL로 바꿨어요. TTL 만료 후 첫 프롬프트는 캐싱을 다시 하느라 10–15%를 쓰지만, 1시간 이내에는 턴당 1–4%만 쓰는 걸 확인했어요. 토큰 효율이 확연히 좋아졌어요. 그런데 새로운 불안이 생겼어요: 1시간이 지났는지 안 지났는지 알 수가 없더라고요. 작업 중간에 "혹시 만료됐나?" 하고 신경 쓰이기 시작했어요. 그래서 이 카운터를 만들었어요 — 머릿속 시계를 걱정하는 대신, 작업에 집중하기 위해서. 만들고 나서는 캐시 만료를 걱정 안 해요. 오롯이 에이전트의 추론 과정을 꼼꼼히 읽고, 에이전트들이 작성한 수백, 수천 줄의 리서치 문서와 구현 결과 문서, 지시서들을 꼼꼼히 읽으면서, 스스로 학습하고 점검하는 시간을 넉넉하게 가져요. 그리고 그 결과는 더 구체적인 맥락과 품질을 갖춘 지시 프롬프트로 이어지고, 더 적은 턴으로 더 좋은 에이전틱 코딩을 할 수 있게 됐어요.

I see a lot of people on Threads frustrated about token consumption. But often the fix is surprisingly simple — a settings change that takes seconds. The real problem is that many people don't even know this lever exists, or what question to ask to find it. This isn't just a beginner issue; I've seen experienced developers with years of coding struggle with the same thing. You can't fix what you can't see.

쓰레드에서 토큰 소모가 심하다고 불편을 말하는 사람들이 정말 많아요. 그런데 해결은 놀라울 정도로 간단한 경우가 많아요 — 몇 초 만에 끝나는 설정 변경 하나로요. 진짜 문제는 이 레버가 존재하는지도 모르거나, 이걸 해결하려면 어떤 맥락으로 질문해야 하는지조차 모른다는 거예요. 입문자만 그런 게 아니에요. 개발을 수년 이상 해온 경험자도 마찬가지예요. 보이지 않는 건 고칠 수 없으니까요.

I hope this small tool helps you save a few more tokens, worry a little less, and enjoy the conversation with your agent a bit more.

이 작은 도구가 토큰을 조금이라도 아끼고, 불안을 조금이라도 줄이고, 에이전트와의 대화를 조금 더 즐기는 데 도움이 되면 좋겠어요.

## Important note on cost / 비용 관련 유의사항

The 5-minute and 1-hour cache modes have [different pricing](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing). 1-hour caching costs more per cached token than 5-minute. So yes, there is a price difference — and you should be aware of it.

5분 캐싱과 1시간 캐싱은 [가격이 달라요](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing). 1시간 캐싱이 토큰당 비용이 더 높아요. 이 차이는 알고 있어야 해요.

But here's what actually hurts more in practice: **cache resets**. If you're on the default 5-minute TTL and you don't know it, every time you take a few minutes to read or think before your next turn, the cache silently expires. The next prompt triggers a full cache rebuild. That single reset can consume 10–30% of your daily usage in one shot. A lot of people say "Opus just eats too many tokens" — but it's usually not the model being expensive. It's the cache silently resetting and rebuilding from scratch every few turns. Without understanding prompt caching and TTL, the only thing left to blame is the model.

그런데 실제로 더 아픈 건 **캐시 리셋**이에요. 기본값 5분 TTL인 줄도 모르고 쓰다가, 코드를 읽거나 생각하느라 몇 분만 쉬면 캐시가 조용히 만료돼요. 다음 프롬프트에 캐싱이 처음부터 다시 이루어지면서, 이 리셋 한 번에 일간 사용량의 10–30%가 한 방에 녹아버릴 수 있어요. 많은 사람들이 "Opus가 토큰을 너무 많이 잡아먹는다"고 느끼는데, 사실 모델이 비싼 게 아니라 캐시가 보이지 않게 리셋되면서 매번 처음부터 다시 캐싱하고 있었던 거예요. 프롬프트 캐싱과 TTL 개념을 모르면 이걸 모델 탓으로 돌릴 수밖에 없어요.

So the real question isn't "is this model too expensive?" — it's "how much am I losing to invisible cache rebuilds that I didn't even know were happening?"

그래서 진짜 질문은 "이 모델이 비싼 건가?"가 아니라, "모르는 사이에 캐시가 리셋돼서 얼마나 날리고 있었냐?"예요.

### Community discussions / 커뮤니티에서도 같은 문제를 겪고 있어요

This isn't a niche issue. In early March 2025, Anthropic quietly changed the default prompt cache TTL from 1 hour to 5 minutes without prior announcement. Users across Reddit immediately noticed their daily usage limits draining far faster than before — many hitting the 5-hour quota cap for the first time. The community traced the root cause back to this silent TTL change, and the discussion quickly escalated into a transparency debate.

이건 일부만 겪는 문제가 아니에요. 2025년 3월 초, Anthropic이 프롬프트 캐시 TTL 기본값을 1시간에서 5분으로 사전 공지 없이 변경했어요. Reddit에서 즉시 "갑자기 일간 사용량이 급감한다"는 보고가 쏟아졌고, 많은 유저가 5시간 쿼터 제한에 처음으로 도달했어요. 커뮤니티가 원인을 추적해서 이 조용한 TTL 변경이 근본 원인이라는 걸 밝혀냈고, 투명성 논란으로 번졌어요.

- **[Reddit r/ClaudeAI — "Did they just find the issue with Claude cache?"](https://www.reddit.com/r/ClaudeAI/comments/1sjxrp1/did_they_just_find_the_issue_with_claude_cache/)** (Apr 13, 2025) — The post that first suspected the link: the sudden spike in Opus daily usage starting early March might be related to Anthropic's silent TTL default change on March 6th. Not confirmed, but the timing and symptoms align.
  3월 초부터 Opus 일간 사용량이 급증한 현상의 원인이 TTL 기본값 변경일 수 있다고 처음 추정한 포스트. 확정은 아니지만 시점과 증상이 일치.

- **[Reddit r/ClaudeCode — "Followup: Anthropic quietly switched the default TTL"](https://www.reddit.com/r/ClaudeCode/comments/1sk3iyq/followup_anthropic_quietly_switched_the_default/)** (Apr 13, 2025) — Follow-up with evidence: 17–32% increase in cache rebuild costs confirmed. Multiple users reporting first-time quota hits. Community demanding advance notice for cost-affecting changes.
  후속 포스트. 캐시 재생성 비용 17~32% 증가 확인. "처음으로 쿼터에 도달했다"는 다수 보고. 비용 변경은 사전 공지가 필수라는 요구.

- **[GeekNews (한국어) — 같은 사건 토론](https://news.hada.io/topic?id=28461)** (Apr 13, 2025) — Korean developer community discussion of the same incident. Frustration over silent policy changes, some teams already switching tools.
  같은 사건의 한국어 개발자 커뮤니티 토론. 무공지 정책 변경에 대한 불만과 일부 팀의 도구 전환 움직임.

## Why this exists

If you cannot see TTL, prompt cache can quietly expire between turns. That often feels like "token usage suddenly exploded" even when your workflow did not change.

TTL이 안 보이면, 턴 사이에 캐시가 조용히 만료돼요. 작업 방식은 그대로인데 어느 순간 **토큰이 갑자기 폭발한 것처럼** 느껴지는 게 이 때문이에요.

This tool helps you answer four simple questions before your next turn:

- **How much time do I have?** — Is the cache still alive, or has it already expired?
- **Was the last turn efficient?** — Did most of it come from cache, or did I pay for fresh input?
- **Is something going wrong?** — Are cache resets happening more often than expected?
- **Am I in the right mode?** — Should I be on `5m` or `1h` given my current work rhythm?

이 도구는 다음 턴을 보내기 전에 네 가지를 바로 알 수 있게 해줘요:

- **시간이 얼마나 남았지?** — 캐시가 아직 살아 있는지, 이미 만료된 건지
- **방금 턴은 효율적이었나?** — 대부분 캐시에서 재사용된 건지, 새로 처리하느라 토큰을 많이 쓴 건지
- **뭔가 잘못되고 있나?** — 캐시 리셋이 예상보다 자주 일어나고 있는 건 아닌지
- **지금 모드가 맞나?** — 내 작업 리듬에 `5분`이 맞는지, `1시간`이 더 안전한지

## Before → After

### Before / 이전

- You guess when TTL may expire.
- You see a large token number and cannot tell whether it was real fresh usage or cache reuse.
- You only notice cache resets after the damage is done.

- TTL 만료 시점을 감으로 추측해야 했어요.
- 큰 토큰 숫자를 봐도, 실제 새 입력인지 캐시 재사용인지 구분이 안 됐어요.
- 캐시 초기화를 이미 일어난 뒤에야 알아차렸어요.

### After / 이후

- You can see the countdown in the status bar — no more guessing.
- You can inspect the latest turn's cache hit ratio to know if you're actually saving tokens.
- The extension analyzes your turn rhythm and shows a strength-graded recommendation in the tooltip (e.g. "5m may save tokens" / "1h is safer" / "strongly recommend 1h"). If cache resets happen frequently, you get a separate warning. The switch itself is still manual — you click the status bar and choose — but you know *when*, *why*, and *how urgently* to switch.

- 상태 바에서 카운트다운을 바로 볼 수 있어요 — 더 이상 추측할 필요 없어요.
- 직전 턴의 캐시 히트율을 확인해서 실제로 토큰이 절약되고 있는지 알 수 있어요.
- 확장이 턴 리듬을 분석해서 tooltip에 강도별 추천을 보여줘요 (예: "5분 모드가 토큰을 아낄 수 있어요" / "1시간 모드가 더 안전해요" / "1시간 모드를 강하게 추천해요"). 캐시 리셋이 자주 발생하면 별도 경고도 떠요. 모드 전환 자체는 직접 클릭해야 하지만, *언제*, *왜*, *얼마나 급하게* 바꿔야 하는지를 알 수 있어요.

## What it does / 기능

**Core / 핵심:**
- Finds the active Claude session for your current workspace / 현재 워크스페이스의 Claude 세션을 자동 감지
- Tracks TTL countdown based on your last prompt timestamp / 마지막 프롬프트 시각 기준으로 TTL 카운트다운 추적
- Monitors cache health across recent turns / 최근 턴들의 캐시 상태를 모니터링
- Analyzes your turn rhythm (median gap) and recommends the right mode — conservative on 5m suggestions, proactive on 1h suggestions / 턴 리듬(중간값 gap)을 분석해서 적합한 모드를 추천 — 5분 추천은 보수적으로, 1시간 추천은 적극적으로

**What you see / 유저가 보는 UI:**

| 위치 | 예시 | 설명 |
|---|---|---|
| **Status bar** | `$(clock) TTL 42:15 · my-project` | 실시간 카운트다운 + 프로젝트명. 5단계 색상 (초록 → 주황 → 경고 → 위험 → 만료) |
| **Tooltip** (마우스 올림) | `Last turn: 39,685 tokens` | 직전 턴의 캐시 히트율, fresh 토큰 수, 캐시 상태 요약 |
| | `Cache hit 85.2% · Fresh 5,842` | |
| | `Health: 2 cold starts in last 5 turns` | 최근 턴 중 캐시가 완전 리셋된 횟수 |
| | `Tip: 1h mode is safer.` | 턴 리듬 기반 3단계 추천 (절약형 5분 / 일반 1시간 / 강력 1시간) |
| **Quick Pick** (클릭) | `$(check) 1h mode · Current · 42:15` | 클릭해서 5분 ↔ 1시간 모드 전환 |
| **Notification** | `"Cache resets look frequent..."` | cold start가 2회 이상이면 경고 (추천과 분리) |
| | `"TTL is under five minutes..."` | 만료 임박 시 안내 |

## How it works / 작동 방식

This extension does **not** patch the Claude Code extension and does **not** proxy Claude requests.

Instead, it reads local Claude files:

Claude Code 확장을 건드리거나 프롬프트를 가로채지 않아요.

아래 로컬 파일만 읽어서 TTL과 캐시 상태를 계산해요:

- `~/.claude/sessions/*.json` — active session detection / 활성 세션 감지
- `~/.claude/projects/**/<sessionId>.jsonl` — last user timestamp + cache usage / 타임스탬프 + 캐시 사용량
- `~/.claude/settings.json` — TTL mode read/write / TTL 모드 읽기·쓰기

## Which TTL mode should you use? / 어떤 모드를 쓸까?

### `5m` — fast rhythm / 빠른 리듬

- Sending turns quickly and repeatedly / 짧은 턴을 빠르게 여러 번 주고받을 때
- Tight coding / fix / retry loops / 수정·재시도·짧은 코딩 루프
- Usually responding within 1-2 minutes / 보통 1–2분 안에 다음 턴을 보낼 때
- Cheaper cache mode with short pauses / 작업 공백이 짧고 비용을 줄이고 싶을 때

### `1h` — slow rhythm / 느린 리듬

- Pausing to read code, docs, or output / 코드·문서·산출물을 읽고 검토할 때
- Design, planning, review between turns / 설계·기획·리뷰 등 긴 사고가 필요할 때
- Validating agent work for several minutes / 에이전트 결과물을 한참 확인한 뒤 답할 때
- Longer, more deliberate prompts / 프롬프트를 길고 구체적으로 작성할 때

### But it depends on your setup / 그런데, 사람마다 다를 수 있어요

The "right" TTL isn't universal — it depends on **how much context you carry**. When cache expires, everything currently loaded has to be re-cached from scratch. The bigger that context is, the more painful a single reset becomes.

"정답" TTL은 모두에게 같지 않아요 — **내가 얼마나 많은 컨텍스트를 들고 있느냐**에 따라 달라요. 캐시가 만료되면, 지금 올라가 있는 모든 컨텍스트를 처음부터 다시 캐싱해야 해요. 그게 클수록, 리셋 한 번이 더 아파요.

**What makes up your context / 내 컨텍스트를 구성하는 것들:**

Things that load every session (always-on):
- `CLAUDE.md` — some people have 5 lines, others have 200+ lines with detailed project rules
- `MEMORY.md` — auto-memory that grows over time
- MCP servers — each connected tool adds its schema to context
- Plugins and custom slash commands
- Harness/framework docs — if you use a structured system (like a design framework, coding standards, or agent orchestration rules), those documents load every session too

세션마다 항상 올라가는 것들 (always-on):
- `CLAUDE.md` — 5줄인 사람도 있고, 프로젝트 규칙이 200줄 넘는 사람도 있어요
- `MEMORY.md` — 시간이 지나면서 쌓이는 자동 메모리
- MCP 서버 — 연결한 도구마다 스키마가 컨텍스트에 들어가요
- 플러그인, 커스텀 슬래시 커맨드
- 하네스/프레임워크 문서 — 설계 시스템이나 코딩 표준, 에이전트 오케스트레이션 규칙 같은 구조화된 시스템을 쓰면, 그 문서들도 매 세션 올라가요

Things that accumulate during a session:
- Conversation history — grows with every turn
- Files and code the agent has read
- Tool call results

세션 중에 쌓이는 것들:
- 대화 히스토리 — 턴마다 커져요
- 에이전트가 읽은 파일과 코드
- 도구 호출 결과

All of this combined is "what gets re-cached when TTL expires." If your always-on context is small (just a short CLAUDE.md, no MCP), a reset might cost 3–5%. If it's large (framework docs + MCP + long conversation), a single reset can cost 15–30%.

이 전부를 합친 게 "TTL 만료 시 다시 캐싱해야 하는 크기"예요. always-on이 작으면 (짧은 CLAUDE.md, MCP 없음) 리셋 한 번에 3–5% 정도. 크면 (프레임워크 문서 + MCP + 긴 대화) 리셋 한 번에 15–30%가 될 수 있어요.

### So which one? / 그래서 뭘 고를까?

Here's a simple rule:

간단한 기준이에요:

- **Turn gaps usually < 5 minutes** → stay on `5m` (default). Cache stays warm naturally. You get the cheaper per-token rate and save daily usage over time.
- **Turn gaps often > 5 minutes** → switch to `1h`. Without it, the cache silently resets between turns, and your daily limit drops fast without you understanding why.

- **턴 간격이 보통 5분 미만** → `5분` (기본값) 유지하세요. 캐시가 자연스럽게 유지돼요. 토큰당 비용도 저렴하고, 일간 사용량이 차곡차곡 절약돼요.
- **턴 간격이 5분 넘는 경우가 많다** → `1시간`으로 바꾸세요. 안 바꾸면 턴 사이에 캐시가 조용히 리셋되면서, 영문도 모른 채 일간 리밋이 급감해요.

The heavier your always-on context, the more `1h` acts as a safety net. If you're someone who reads agent output carefully, reviews documents, or thinks before prompting — `1h` prevents the kind of invisible token drain that makes people say "I barely used it today and my limit is already gone."

always-on 컨텍스트가 클수록, `1시간`이 안전망 역할을 해요. 에이전트 산출물을 꼼꼼히 읽거나, 문서를 검토하거나, 프롬프트 전에 생각하는 타입이라면 — `1시간`이 "오늘 거의 안 썼는데 리밋이 왜 벌써 없지?"라는 상황을 막아줘요.

**TL;DR**: `5m` for speed, `1h` for depth.

**한 줄 요약**: `5분`은 속도전, `1시간`은 깊은 작업.

### Scope: global vs per-project / 전역 vs 프로젝트별

By default, clicking the status bar toggles the **global** TTL mode (`~/.claude/settings.json`). This affects all Claude Code sessions on your machine.

상태 바를 클릭하면 **전역** TTL 모드(`~/.claude/settings.json`)가 바뀌어요. 이 설정은 내 컴퓨터의 모든 Claude Code 세션에 적용돼요.

If you need different TTL modes per project — for example, `1h` for a design project and `5m` for a quick bugfix repo — you can set a project-level override. See [HOW-TO-USE.md § Per-project TTL](./HOW-TO-USE.md#per-project-ttl--프로젝트별-ttl-설정) for details.

프로젝트마다 다른 TTL이 필요하면 — 설계 프로젝트는 `1시간`, 버그 수정은 `5분` — 프로젝트별 오버라이드를 설정할 수 있어요. 방법은 [HOW-TO-USE.md § 프로젝트별 TTL](./HOW-TO-USE.md#per-project-ttl--프로젝트별-ttl-설정)을 참고하세요.

### ⚠️ When you switch modes / 모드를 바꿀 때 꼭 알아두세요

**The new TTL takes effect from your next prompt — no new session needed.** According to the [official docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), cache is refreshed each time it's used. However, the docs don't explicitly say whether changing the TTL tier (5m → 1h) retroactively extends existing cache. Based on our testing, it appears that cache created under the old tier keeps its original TTL — meaning it likely can't be extended retroactively. (If Anthropic clarifies this, we'll update.)

**새 TTL은 다음 프롬프트부터 적용돼요 — 새 세션은 필요 없어요.** [공식 문서](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)에 따르면, 캐시는 사용될 때마다 TTL이 리프레시돼요. 다만 TTL tier를 바꿨을 때(5분 → 1시간) 기존 캐시의 TTL이 소급 연장되는지는 공식 문서에 명시되어 있지 않아요. 테스트 기반으로는, 이전 tier로 만들어진 캐시는 원래의 TTL을 유지하는 것으로 보여요 — 소급 연장은 안 되는 것 같아요. (Anthropic이 이 부분을 공식 확인하면 업데이트할게요.)

What this means in practice: if you switch from `5m` → `1h` and **more than 5 minutes have already passed** since your last prompt, the old 5-minute cache has likely already expired. Your next turn will trigger one cache rebuild — that single turn may feel expensive. **But from that turn onward, all new cache is created with the 1-hour TTL**, and you'll be stable. **Tip**: if you're about to switch modes, sending one quick prompt *before* switching can refresh the existing cache, making the transition smoother.

실제로 이런 뜻이에요: `5분` → `1시간`으로 바꿨는데, 마지막 프롬프트로부터 **이미 5분이 지난 상태**라면, 기존 5분 캐시는 이미 만료됐을 가능성이 높아요. 다음 턴에서 캐시 재구축이 한 번 발생해요 — 이 한 턴이 비싸게 느껴질 수 있어요. **하지만 그 턴부터 모든 새 캐시가 1시간 TTL로 만들어지면서**, 이후에는 안정돼요. **팁**: 모드를 바꾸기 전에 간단한 프롬프트를 하나 보내면, 기존 캐시의 TTL이 리프레시되면서 전환이 더 부드러워질 수 있어요.

> **Don't panic if the first turn after switching feels heavy.** It's likely the last echo of the old setting — not a sign that the change didn't work. From the second turn onward, you're on the new TTL.
>
> **모드 바꾼 직후 첫 턴이 무겁게 느껴져도 걱정하지 마세요.** 이전 설정의 마지막 잔향일 가능성이 높아요 — 변경이 안 된 게 아니에요. 두 번째 턴부터는 새 TTL이 적용되고 있어요.

> **Accidentally switched? No worries.** If you switch modes and switch back *before* sending a prompt, nothing changes — no new cache is created, no tokens spent. The setting only takes effect when you actually send your next prompt.
>
> **실수로 전환했어도 걱정 없어요.** 모드를 바꿨다가 프롬프트를 보내기 *전에* 다시 되돌리면, 아무 일도 안 일어나요 — 새 캐시가 만들어지지 않고, 토큰도 소모되지 않아요. 설정은 실제로 다음 프롬프트를 보낼 때만 적용돼요.

## Install / 설치

### Option 1: npm (recommended / 추천)

```bash
npx claude-ttl-counter-install
```

Automatically detects VS Code or Cursor and installs the latest version.

VS Code 또는 Cursor를 자동 감지하고 최신 버전을 설치해요.

### Option 2: Manual VSIX / 수동 설치

```bash
# VS Code
curl -L https://github.com/PurplePrintAI/save-ur-tokens-ttl-counter-for-claude-code/releases/latest/download/claude-ttl-counter-0.3.0.vsix -o /tmp/ttl.vsix && code --install-extension /tmp/ttl.vsix

# Cursor
curl -L https://github.com/PurplePrintAI/save-ur-tokens-ttl-counter-for-claude-code/releases/latest/download/claude-ttl-counter-0.3.0.vsix -o /tmp/ttl.vsix && cursor --install-extension /tmp/ttl.vsix
```

### Option 3: From IDE / IDE에서 직접

`Ctrl+Shift+P` → "Extensions: Install from VSIX..." → select the `.vsix` file.

## Quick start / 시작하기

1. Install the extension / 확장 설치
2. Open the same workspace you use with Claude Code / Claude Code와 같은 워크스페이스 열기
3. Look for the countdown in the bottom status bar / 하단 상태 바에서 카운트다운 확인
4. Click to switch between `5m` and `1h` / 클릭해서 5분 ↔ 1시간 전환
5. Hover to inspect cache metrics / 마우스 올려서 캐시 지표 확인

For a detailed guide, see [HOW-TO-USE.md](./HOW-TO-USE.md).

더 자세한 사용 가이드는 [HOW-TO-USE.md](./HOW-TO-USE.md)를 참고해 주세요.

## Privacy / 개인정보

- Reads only local Claude files on your machine / 내 컴퓨터의 로컬 파일만 읽어요
- Does not proxy or intercept Claude requests / 프롬프트를 가로채거나 중계하지 않아요
- Does not upload data anywhere / 데이터를 외부에 전송하지 않아요
- Zero network calls / 네트워크 호출 없음

## Development / 개발

Contributions and forks are welcome. This is a small, focused project — the core logic is in five TypeScript files.

기여와 포크를 환영해요. 작고 집중된 프로젝트예요 — 핵심 로직이 TypeScript 파일 5개에 들어 있어요.

**Help improve the recommendation logic**: The mode recommendation engine uses a median-based asymmetric matrix to suggest 5m or 1h mode based on your turn rhythm. We've documented exactly how it works and are collecting real-world feedback — see **[Issue #1: RFC — Recommendation logic](https://github.com/PurplePrintAI/save-ur-tokens-ttl-counter-for-claude-code/issues/1)**. Try the extension, and if the recommendation felt right or wrong for your workflow, let us know!

**추천 로직 개선에 참여해 보세요**: 모드 추천 엔진은 턴 리듬의 median gap을 기반으로 5분 또는 1시간 모드를 추천해요. 로직이 어떻게 작동하는지 전부 공개해뒀고, 실제 사용 피드백을 모으고 있어요 — **[Issue #1: RFC — Recommendation logic](https://github.com/PurplePrintAI/save-ur-tokens-ttl-counter-for-claude-code/issues/1)**을 확인해 보세요. 확장을 써보고, 추천이 맞았는지 아니었는지 경험을 공유해 주시면 로직 개선에 큰 도움이 돼요!

```bash
npm install        # install dependencies / 의존성 설치
npm run compile    # build / 빌드
```

To test locally, package as VSIX and install in your IDE:

로컬에서 테스트하려면 VSIX로 패키징해서 IDE에 설치하면 돼요:

```bash
npx @vscode/vsce package --no-dependencies
# then: Ctrl+Shift+P → "Extensions: Install from VSIX..."
```

## License

MIT

---

## Tips for agentic coding / 에이전틱 코딩 팁

If you found this repo because your token usage feels out of control, here are a few things I've learned the hard way:

이 레포를 찾아온 이유가 "토큰이 왜 이렇게 빠지지?"라면, 제가 직접 겪으며 배운 것들이에요:

**Every turn is communication cost.** Each message to the agent consumes accumulated context as tokens. Prompt caching helps, but the fundamental cost grows with context size. The key insight: reducing turns is often more impactful than optimizing tokens per turn — just like reducing meetings is often better than making each meeting shorter.

**매 턴이 소통 비용이에요.** 에이전트와 나누는 매 메시지가 누적된 컨텍스트를 토큰으로 소모해요. 프롬프트 캐싱이 도와주지만, 근본적으로 컨텍스트가 커지면 비용도 커져요. 핵심은 턴당 토큰을 줄이는 것보다, 턴 자체를 줄이는 게 더 효과적일 때가 많다는 거예요 — 회의 시간을 줄이는 것보다 회의 횟수를 줄이는 게 나은 것처럼.

**Agents don't read 100% unless you tell them to.** Multi-agent, sub-agent setups can be efficient for some tasks, but they tend to skim rather than fully read. Important context gets lost, design documents and code drift apart, and the output quality drops — quietly. On top of that, they consume a lot of tokens. The result: your daily usage burns fast, but the work moves forward with critical context missing. That's why my harness is designed to only summon multi-agent/sub-agents for specific task types. For high-context work, having the main agent read everything fully turned out to save tokens *and* produce better results.

**에이전트는 시키지 않으면 100% 안 읽어요.** 멀티에이전트, 서브에이전트가 효율적인 작업도 있지만, 대부분 전체를 읽기보다 훑어요. 중요한 맥락이 빠지고, 설계 문서와 코드가 어긋나고, 결과 품질이 조용히 떨어져요. 게다가 토큰을 꽤 많이 잡아먹어요. 그 결과, 일간 사용량이 확 소모되는데, 중요 맥락이 누락된 채로 작업이 진행되는 경우가 많았어요. 그래서 제 하네스는 멀티에이전트/서브에이전트를 특수한 작업 케이스에서만 소환하도록 설계해뒀어요. 고맥락 작업이라면 메인 에이전트가 전부 읽게 하는 게 결과적으로 토큰도 절약되고, 작업 결과 품질도 좋았어요.

**Your prompting quality determines token efficiency.** The better you structure what you ask — clear context, specific requirements, one instruction at a time — the fewer turns it takes to get the right result. This is the real leverage point.

**프롬프트 품질이 토큰 효율을 결정해요.** 뭘 요청하는지 명확하게 — 맥락, 구체적 요구사항, 한 번에 하나의 지시 — 구조화할수록 적은 턴으로 원하는 결과가 나와요. 이게 진짜 레버리지 포인트예요.

---

## Made by / 만든 사람

I believe the gap between "having an idea" and "building it" shouldn't be this wide. Most people stop not because their idea is bad, but because they don't have the language to turn it into something real. I build tools that close that gap — so more people can start, and fewer good ideas die quiet.

아이디어가 있는 것과 그걸 만드는 것 사이의 거리가 이렇게 멀 필요는 없다고 생각해요. 대부분은 아이디어가 나빠서가 아니라, 그걸 제품으로 바꿀 언어가 없어서 멈춰요. 저는 그 격차를 줄이는 도구를 만들어요 — 더 많은 사람이 시작할 수 있도록, 좋은 아이디어가 조용히 사라지지 않도록.

I studied biology through a doctoral program (genotyping, toxicogenomics), then spent six years running [BringTheHome](https://bringthehome.co.kr) — an IoT-based indoor climate diagnostics service that identifies and corrects temperature and humidity problems in living spaces. That experience of watching real users struggle with invisible environmental issues led me to build [kngka](https://company.kngka.com), a digital health diary for rhinitis management where users record 30 seconds of breathing sound and the app scores their nasal condition using acoustic analysis. Somewhere along the way I realized the same pattern kept appearing: people have real problems but lack the structured language to solve them. That's what brought me to AI agent systems and product design. Through building products across these different domains — and through 40+ days of intensive agentic coding — I've developed a working fluency in AI-assisted service design, multi-agent orchestration, prompt engineering, and the kind of structured product thinking that turns vague ideas into buildable specs.

바이오 박사 수료(genotyping, toxicogenomics) 후, IoT 기반 실내 온습도 문제 진단·교정 솔루션 [브링더홈](https://bringthehome.co.kr)을 6년째 운영하고 있어요. 보이지 않는 환경 문제로 고생하는 유저들을 관찰하면서, 비염 관리 앱 [킁카](https://company.kngka.com)도 만들었어요 — 30초 숨소리 녹음으로 코 상태를 음향 분석해 점수로 보여주는 디지털 헬스 다이어리예요. 결국 같은 패턴이 반복되더라고요: 사람들은 진짜 문제를 가지고 있는데, 그걸 풀어낼 구조화된 언어가 없어서 멈춰요. 그게 저를 AI 에이전트 시스템과 제품 설계로 이끌었어요. 이 다양한 도메인에서 제품을 만들고, 40일 이상 집중적으로 에이전틱 코딩을 하면서, AI 기반 서비스 설계, 멀티에이전트 오케스트레이션, 프롬프트 엔지니어링, 그리고 막연한 아이디어를 구현 가능한 설계로 바꾸는 구조화된 프로덕트 사고를 실전에서 익히게 됐어요.

Now I build tools at that intersection. I've built a structured harness framework (private repo) for the entire service building journey — from defining the problem and persona, through design documents, UX, branding, marketing strategy, all the way to a developer handoff. The AI doesn't just answer questions; it knows what to ask you, in what order, and structures your answers into actual design artifacts. Think of it as giving your idea a senior product manager who works 24/7 and never loses context. I'm also building a web service so anyone can experience this harness without a complex IDE setup.

지금은 그 교차점에서 도구를 만들어요. 서비스를 만드는 여정 전체를 구조화한 하네스 프레임워크(비공개 레포)를 만들었어요 — 문제 정의와 페르소나부터, 설계 문서, UX, 브랜딩, 마케팅 전략, 개발 핸드오프까지. AI가 그냥 질문에 답하는 게 아니라, 뭘 물어야 하는지를 알고, 어떤 순서로 물어야 하는지 알고, 당신의 답을 실제 설계 산출물로 구조화해줘요. 24시간 일하면서 맥락을 절대 잃지 않는 시니어 PM을 아이디어에 붙여주는 느낌이에요. 그리고 이 하네스를 복잡한 IDE 없이도 누구나 경험할 수 있는 웹 서비스를 만들고 있어요.

I'm working with a small group of founding builders — people with deep domain expertise and real ideas, but who haven't been through the full service design → build → GTM journey before, and are just getting started with agentic coding. They have a genuine intention to solve real problems and inefficiencies in their domains. Using the harness I've built and everything I've learned along the way, I'm helping them turn their ideas into real products. We're starting small, learning by doing, and improving together.

지금은 제가 구축한 하네스, 그리고 지금까지의 모든 경험을 토대로 소수의 파운딩 빌더들을 돕고 있어요. 도메인 전문성과 진짜 아이디어가 있지만, 서비스 설계 → 구현 → 사업화(GTM) 여정을 처음부터 끝까지 경험해본 적은 없고, 에이전틱 코딩도 이제 막 시작하는 분들이에요. 선한 의도를 토대로 자기 도메인의 문제와 비효율을 해결하려는 사람들이에요. 소수로 시작해서, 직접 해보면서 배우고, 함께 개선해나가는 구조예요.

On the side, I ship small open-source utilities like this TTL counter that solve real friction points I hit every day in agentic coding workflows.

그 사이사이에 이 TTL 카운터처럼, 매일 에이전틱 코딩을 하면서 직접 부딪히는 마찰을 해결하는 작은 오픈소스 도구들도 만들고 있어요.

Contact: purpleprintai@gmail.com · [@ylkim.0to1](https://www.threads.net/@ylkim.0to1)
