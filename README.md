# Claude TTL Counter

Claude TTL Counter is a lightweight VS Code / Cursor extension that helps you see **when Claude Code prompt cache will expire** and how much of your recent turn was actually reused from cache.

Claude Code를 쓸 때, **캐시가 언제 만료되는지** 그리고 **방금 턴에서 캐시가 실제로 얼마나 재활용됐는지** 한눈에 볼 수 있는 가벼운 VS Code / Cursor 확장이에요.

---

**Table of Contents / 목차**

- [Background / 만든 배경](#background--만든-배경)
- [Important note on cost / 비용 유의사항](#important-note-on-cost--비용-관련-유의사항)
- [Why this exists / 왜 만들었나](#why-this-exists)
- [Before → After](#before--after)
- [What it does / 기능](#what-it-does--기능)
- [How it works / 작동 방식](#how-it-works--작동-방식)
- [Which TTL mode? / 어떤 모드?](#which-ttl-mode-should-you-use--어떤-모드를-쓸까)
- [Install / 설치](#install--설치)
- [Quick start / 시작하기](#quick-start--시작하기)
- [Privacy / 개인정보](#privacy--개인정보)
- [Tips for agentic coding / 에이전틱 코딩 팁](#tips-for-agentic-coding--에이전틱-코딩-팁)
- [Made by / 만든 사람](#made-by--만든-사람)

---

## Background / 만든 배경

Before I understood prompt caching, I just wondered why Claude Code burned through tokens so fast (my first turn would eat 14–20% of daily usage, then after a short break another turn would burn 15% more — I was genuinely confused). Once I learned how it worked, I realized the default 5-minute TTL was a terrible fit for my workflow — I spend long stretches reading design documents, reviewing agent reasoning and chain-of-thought, coordinating with other agent sessions, and thinking before my next turn. Every time I came back after a few minutes of reading, the cache had quietly expired and the next prompt triggered a full cache rebuild — tokens just melted away.

프롬프트 캐싱 개념을 알기 전에는, Claude Code 토큰이 왜 이렇게 빨리 쓰이는지 의문만 있었어요 (첫 턴에 일간 사용량의 14–20%가 빠지고, 잠깐 다른 작업을 하다 돌아와서 한 턴 더 보냈을 뿐인데 또 15%가 날아가서 당황한 적이 한두 번이 아니었어요). 개념을 알고 나서야, 기본값 5분 TTL이 제 작업 방식에 전혀 맞지 않다는 걸 깨달았어요 — 저는 설계 문서를 오래 읽고, 에이전트의 추론과 chain-of-thought를 전부 읽고, 다른 에이전트 세션과 병행 작업을 하고, 다음 턴을 보내기 전에 한참 생각하는 편이거든요. 몇 분만 읽다 돌아오면 캐시가 조용히 만료돼서, 다음 프롬프트에 캐싱이 다시 이루어지면서 토큰이 녹아버렸던 거죠.

I switched to 1-hour TTL immediately. The first prompt after TTL expiry still costs 10–15% for cache rebuild, but within that hour each turn only costs 1–4%. Token efficiency improved dramatically. But then a new anxiety appeared: I couldn't tell whether the hour had passed or not. I'd catch myself wondering mid-thought, "has it expired yet?" So I built this counter to remove that uncertainty — to stay focused on the work instead of watching the clock in my head.

곧바로 1시간 TTL로 바꿨어요. TTL 만료 후 첫 프롬프트는 캐싱을 다시 하느라 10–15%를 쓰지만, 1시간 이내에는 턴당 1–4%만 쓰는 걸 확인했어요. 토큰 효율이 확연히 좋아졌어요. 그런데 새로운 불안이 생겼어요: 1시간이 지났는지 안 지났는지 알 수가 없더라고요. 작업 중간에 "혹시 만료됐나?" 하고 신경 쓰이기 시작했어요. 그래서 이 카운터를 만들었어요 — 머릿속 시계를 걱정하는 대신, 작업에 집중하기 위해서.

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

- You can see the countdown in the status bar.
- You can inspect the latest turn's fresh input, cache read, cache creation, and cache hit ratio.
- You can catch repeated cache resets earlier and switch mode more intentionally.

- 상태 바에서 카운트다운을 바로 볼 수 있어요.
- 최근 턴의 새 입력, 캐시 읽기, 캐시 생성, 캐시 히트율을 확인할 수 있어요.
- 캐시 초기화가 반복되면 더 빨리 감지하고, 의도적으로 모드를 전환할 수 있어요.

## What it does / 기능

- Finds the active Claude session for the current workspace
- Reads the last user timestamp from the local Claude transcript
- Reads TTL mode (`5m` or `1h`) from `~/.claude/settings.json`
- Shows a live status bar countdown like `TTL 42:15`
- 5-stage color gradient: green → orange → warning → error → expired
- Tracks recent cache health from local transcript usage fields
- Surfaces last-turn metrics: fresh input, cache read, cache creation, hit ratio
- Warns when TTL is close to expiry or when recent cache resets look frequent
- Lets you toggle between `5m` and `1h` mode with Quick Pick

- 현재 워크스페이스의 활성 Claude 세션을 자동 감지
- 로컬 Claude 대화 기록에서 마지막 유저 타임스탬프를 읽음
- `~/.claude/settings.json`에서 TTL 모드(`5분` / `1시간`) 확인
- 상태 바에 `TTL 42:15` 같은 실시간 카운트다운 표시
- 5단계 색상: 초록 → 주황 → 경고 → 위험 → 만료
- 최근 캐시 상태 추적 (cold start / low-hit turn)
- 직전 턴 지표: 새 입력 / 캐시 읽기 / 캐시 생성 / 히트율
- TTL 만료 임박 및 캐시 초기화 반복 시 경고 알림
- Quick Pick으로 `5분` ↔ `1시간` 모드 전환

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

**TL;DR**: `5m` for speed, `1h` for depth.

**한 줄 요약**: `5분`은 속도전, `1시간`은 깊은 작업.

### Scope: global vs per-project / 전역 vs 프로젝트별

By default, clicking the status bar toggles the **global** TTL mode (`~/.claude/settings.json`). This affects all Claude Code sessions on your machine.

상태 바를 클릭하면 **전역** TTL 모드(`~/.claude/settings.json`)가 바뀌어요. 이 설정은 내 컴퓨터의 모든 Claude Code 세션에 적용돼요.

If you need different TTL modes per project — for example, `1h` for a design project and `5m` for a quick bugfix repo — you can set a project-level override. See [HOW-TO-USE.md § Per-project TTL](./HOW-TO-USE.md#per-project-ttl--프로젝트별-ttl-설정) for details.

프로젝트마다 다른 TTL이 필요하면 — 설계 프로젝트는 `1시간`, 버그 수정은 `5분` — 프로젝트별 오버라이드를 설정할 수 있어요. 방법은 [HOW-TO-USE.md § 프로젝트별 TTL](./HOW-TO-USE.md#per-project-ttl--프로젝트별-ttl-설정)을 참고하세요.

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
curl -L https://github.com/PurplePrintAI/claude-ttl-counter/releases/latest/download/claude-ttl-counter-0.1.0.vsix -o /tmp/ttl.vsix && code --install-extension /tmp/ttl.vsix

# Cursor
curl -L https://github.com/PurplePrintAI/claude-ttl-counter/releases/latest/download/claude-ttl-counter-0.1.0.vsix -o /tmp/ttl.vsix && cursor --install-extension /tmp/ttl.vsix
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

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch the extension host, or package as VSIX:

```bash
npx @vscode/vsce package --no-dependencies
```

## License

MIT

---

## Tips for agentic coding / 에이전틱 코딩 팁

If you found this repo because your token usage feels out of control, here are a few things I've learned the hard way:

이 레포를 찾아온 이유가 "토큰이 왜 이렇게 빠지지?"라면, 제가 직접 겪으며 배운 것들이에요:

**Every turn is communication cost.** Each message to the agent consumes accumulated context as tokens. Prompt caching helps, but the fundamental cost grows with context size. The key insight: reducing turns is often more impactful than optimizing tokens per turn — just like reducing meetings is often better than making each meeting shorter.

**매 턴이 소통 비용이에요.** 에이전트와 나누는 매 메시지가 누적된 컨텍스트를 토큰으로 소모해요. 프롬프트 캐싱이 도와주지만, 근본적으로 컨텍스트가 커지면 비용도 커져요. 핵심은 턴당 토큰을 줄이는 것보다, 턴 자체를 줄이는 게 더 효과적일 때가 많다는 거예요 — 회의 시간을 줄이는 것보다 회의 횟수를 줄이는 게 나은 것처럼.

**Agents don't read 100% unless you tell them to.** Multi-agent, sub-agent setups can be efficient for some tasks, but they tend to skim rather than fully read. Important context gets lost, design documents and code drift apart, and the output quality drops — quietly. If the work is high-context, make sure the agent reads everything fully.

**에이전트는 시키지 않으면 100% 안 읽어요.** 멀티에이전트, 서브에이전트가 효율적인 작업도 있지만, 대부분 전체를 읽기보다 훑어요. 중요한 맥락이 빠지고, 설계 문서와 코드가 어긋나고, 결과 품질이 조용히 떨어져요. 고맥락 작업이라면 에이전트가 전부 읽게 해야 해요.

**Your prompting quality determines token efficiency.** The better you structure what you ask — clear context, specific requirements, one instruction at a time — the fewer turns it takes to get the right result. This is the real leverage point.

**프롬프트 품질이 토큰 효율을 결정해요.** 뭘 요청하는지 명확하게 — 맥락, 구체적 요구사항, 한 번에 하나의 지시 — 구조화할수록 적은 턴으로 원하는 결과가 나와요. 이게 진짜 레버리지 포인트예요.

---

## Made by / 만든 사람

I believe the gap between "having an idea" and "building it" shouldn't be this wide. Most people stop not because their idea is bad, but because they don't have the language to turn it into something real. I build tools that close that gap — so more people can start, and fewer good ideas die quiet.

아이디어가 있는 것과 그걸 만드는 것 사이의 거리가 이렇게 멀 필요는 없다고 생각해요. 대부분은 아이디어가 나빠서가 아니라, 그걸 제품으로 바꿀 언어가 없어서 멈춰요. 저는 그 격차를 줄이는 도구를 만들어요 — 더 많은 사람이 시작할 수 있도록, 좋은 아이디어가 조용히 사라지지 않도록.

I studied biology through a doctoral program (genotyping, toxicogenomics), then spent six years running [BringTheHome](https://bringthehome.co.kr) — an IoT-based indoor climate diagnostics service that identifies and corrects temperature and humidity problems in living spaces. That experience of watching real users struggle with invisible environmental issues led me to build [kngka](https://company.kngka.com), a digital health diary for rhinitis management where users record 30 seconds of breathing sound and the app scores their nasal condition using acoustic analysis. Somewhere along the way I realized the same pattern kept appearing: people have real problems but lack the structured language to solve them. That's what brought me to AI agent systems and product design.

바이오 박사 수료(genotyping, toxicogenomics) 후, IoT 기반 실내 온습도 문제 진단·교정 솔루션 [브링더홈](https://bringthehome.co.kr)을 6년째 운영하고 있어요. 보이지 않는 환경 문제로 고생하는 유저들을 관찰하면서, 비염 관리 앱 [킁카](https://company.kngka.com)도 만들었어요 — 30초 숨소리 녹음으로 코 상태를 음향 분석해 점수로 보여주는 디지털 헬스 다이어리예요. 결국 같은 패턴이 반복되더라고요: 사람들은 진짜 문제를 가지고 있는데, 그걸 풀어낼 구조화된 언어가 없어서 멈춰요. 그게 저를 AI 에이전트 시스템과 제품 설계로 이끌었어요.

Now I build tools at that intersection. PurplePrint System (private repo) is a structured harness framework for the entire service building journey — from defining the problem and persona, through design documents, UX, branding, marketing strategy, all the way to a developer handoff. The AI doesn't just answer questions; it knows what to ask you, in what order, and structures your answers into actual design artifacts. Think of it as giving your idea a senior product manager who works 24/7 and never loses context. [PurplePrint AI](https://purpleprint-ai.com) is the web version where anyone can try it without an IDE.

지금은 그 교차점에서 도구를 만들어요. PurplePrint System(비공개 레포)은 서비스를 만드는 여정 전체를 구조화한 하네스 프레임워크예요 — 문제 정의와 페르소나부터, 설계 문서, UX, 브랜딩, 마케팅 전략, 개발 핸드오프까지. AI가 그냥 질문에 답하는 게 아니라, 뭘 물어야 하는지를 알고, 어떤 순서로 물어야 하는지 알고, 당신의 답을 실제 설계 산출물로 구조화해줘요. 24시간 일하면서 맥락을 절대 잃지 않는 시니어 PM을 아이디어에 붙여주는 느낌이에요. [PurplePrint AI](https://purpleprint-ai.com)는 IDE 없이 누구나 체험할 수 있는 웹 버전이에요.

I'm building a small founding builder network — early builders who each have domain expertise and real ideas, but haven't gone through the full service design → build → GTM journey before. They use this framework to turn their own ideas into real products, and in doing so, validate whether the system actually works before I open it wider. We're starting with a few people, learning by doing, and improving together.

지금은 소수의 파운딩 빌더들과 함께하고 있어요 — 도메인 전문성과 진짜 아이디어가 있지만, 서비스 설계 → 구현 → GTM 여정을 처음부터 끝까지 경험해본 적은 없는 사람들이에요. 이 프레임워크로 각자의 아이디어를 실제 제품으로 만들면서, 시스템이 정말 작동하는지 검증하고 있어요. 소수로 시작해서, 직접 해보면서 배우고, 함께 개선해나가는 구조예요.

On the side, I ship small open-source utilities like this TTL counter that solve real friction points I hit every day in agentic coding workflows.

그 사이사이에 이 TTL 카운터처럼, 매일 에이전틱 코딩을 하면서 직접 부딪히는 마찰을 해결하는 작은 오픈소스 도구들도 만들고 있어요.

Contact: purpleprintai@gmail.com · [@ylkim.0to1](https://www.threads.net/@ylkim.0to1)
