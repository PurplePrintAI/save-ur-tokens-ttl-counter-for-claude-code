# Claude TTL Counter

Claude TTL Counter is a lightweight VS Code / Cursor extension that helps you see **when Claude Code prompt cache will expire** and how much of your recent turn was actually reused from cache.

Claude TTL Counter는 **Claude Code 프롬프트 캐시가 언제 만료되는지**, 그리고 **최근 턴에서 캐시가 실제로 얼마나 재활용됐는지** 보여주는 가벼운 VS Code / Cursor 확장입니다.

## Why this exists

If you cannot see TTL, prompt cache can quietly expire between turns. That often feels like "token usage suddenly exploded" even when your workflow did not change.

TTL이 보이지 않으면, 턴 사이에 프롬프트 캐시가 조용히 만료될 수 있습니다. 그러면 작업 방식은 비슷한데도 어느 순간 **토큰 사용량이 갑자기 커진 것처럼** 느껴질 수 있습니다.

This extension gives you a simple decision surface:

- How much TTL is left?
- Was the last turn mostly cache read or mostly fresh input?
- Are cache resets happening repeatedly?
- Is `5m` still a good fit, or is `1h` safer for your rhythm?

이 확장은 아래 판단을 쉽게 하도록 돕습니다:

- TTL이 얼마나 남았는지
- 방금 턴이 캐시 재사용 중심이었는지, 새 입력 부담이 컸는지
- 최근 캐시 초기화가 반복되는지
- 지금 작업 리듬에는 `5분`이 맞는지, `1시간`이 더 안전한지

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

이 확장은 Claude Code 확장을 수정하거나, 프롬프트를 가로채지 않습니다.

대신 아래 로컬 파일만 읽어서 TTL과 캐시 상태를 계산합니다:

- `~/.claude/sessions/*.json` — active session detection / 활성 세션 감지
- `~/.claude/projects/**/<sessionId>.jsonl` — last user timestamp + cache usage / 타임스탬프 + 캐시 사용량
- `~/.claude/settings.json` — TTL mode read/write / TTL 모드 읽기·쓰기

## Which TTL mode should you use? / 어떤 모드를 쓸까?

### `5m` — fast rhythm / 빠른 리듬

- Sending turns quickly and repeatedly / 짧은 턴을 빠르게 여러 번 주고받을 때
- Tight coding / fix / retry loops / 수정·재시도·짧은 코딩 루프
- Usually responding within 1-2 minutes / 보통 1~2분 안에 다음 턴을 보낼 때
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

기본적으로 상태 바를 클릭하면 **전역** TTL 모드(`~/.claude/settings.json`)가 바뀝니다. 이 설정은 내 컴퓨터의 모든 Claude Code 세션에 적용됩니다.

If you need different TTL modes per project — for example, `1h` for a design project and `5m` for a quick bugfix repo — you can set a project-level override. See [HOW-TO-USE.md § Per-project TTL](./HOW-TO-USE.md#per-project-ttl--프로젝트별-ttl-설정) for details.

프로젝트마다 다른 TTL 모드가 필요할 때 — 예를 들어 설계 프로젝트는 `1시간`, 빠른 버그 수정 레포는 `5분` — 프로젝트별 오버라이드를 설정할 수 있습니다. 자세한 방법은 [HOW-TO-USE.md § 프로젝트별 TTL](./HOW-TO-USE.md#per-project-ttl--프로젝트별-ttl-설정)을 참고하세요.

## Install / 설치

### Option 1: npm (recommended / 추천)

```bash
npx claude-ttl-counter-install
```

Automatically detects VS Code or Cursor and installs the latest version.

VS Code 또는 Cursor를 자동 감지하고 최신 버전을 설치합니다.

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

- Reads only local Claude files on your machine / 내 컴퓨터의 로컬 Claude 파일만 읽습니다
- Does not proxy or intercept Claude requests / 프롬프트를 가로채거나 중계하지 않습니다
- Does not upload data anywhere / 데이터를 외부에 전송하지 않습니다
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

## Made by / 만든 사람

I believe the gap between "having an idea" and "building it" shouldn't be this wide. Most people stop not because their idea is bad, but because they don't have the language to turn it into something real. I build tools that close that gap — so more people can start, and fewer good ideas die quiet.

아이디어가 있는 것과 그걸 만드는 것 사이의 거리가 이렇게 멀 필요는 없다고 생각합니다. 대부분은 아이디어가 나빠서가 아니라, 그걸 제품으로 바꿀 언어가 없어서 멈춥니다. 저는 그 격차를 줄이는 도구를 만듭니다 — 더 많은 사람이 시작할 수 있도록, 좋은 아이디어가 조용히 사라지지 않도록.

I studied biology through a doctoral program (genotyping, toxicogenomics), then spent six years running [BringTheHome](https://bringthehome.com) — an IoT-based indoor climate diagnostics service that identifies and corrects temperature and humidity problems in living spaces. That experience of watching real users struggle with invisible environmental issues led me to build [kngka](https://company.kngka.com), a digital health diary for rhinitis management where users record 30 seconds of breathing sound and the app scores their nasal condition using acoustic analysis. Somewhere along the way I realized the same pattern kept appearing: people have real problems but lack the structured language to solve them. That's what brought me to AI agent systems and product design.

바이오 박사 수료(genotyping, toxicogenomics) 후, IoT 기반의 실내 온습도 문제 진단 및 교정 솔루션을 제공하는 [브링더홈](https://bringthehome.com)을 6년째 운영하고 있습니다. 보이지 않는 환경 문제로 고생하는 유저들을 관찰하면서, 비염 관리 디지털 헬스 다이어리 [킁카](https://company.kngka.com)도 만들었습니다 — 30초 숨소리 녹음으로 코 상태를 음향 분석해 점수로 보여주는 앱이에요. 결국 같은 패턴이 반복된다는 걸 깨달았어요: 사람들은 진짜 문제를 가지고 있지만, 그걸 풀어낼 구조화된 언어가 없어서 멈춘다는 것. 그게 저를 AI 에이전트 시스템과 제품 설계로 이끌었습니다.

Now I build tools at that intersection. PurplePrint System (private repo) is a structured harness framework that turns a one-line idea into a complete set of design documents through AI-guided coaching. [PurplePrint AI](https://purpleprint-ai.com) is its web incarnation where anyone can experience that process without an IDE. I'm building a small founding builder network — a handful of early builders who use this system to turn their own ideas into real products, validating the framework through actual use before opening it wider. On the side, I ship small utilities like this TTL counter that solve real friction in daily agentic coding workflows.

지금은 그 교차점에서 도구를 만듭니다. PurplePrint System(비공개 레포)은 아이디어 한 줄을 AI 코칭으로 설계 문서 세트까지 완성하는 구조화된 하네스 프레임워크이고, [PurplePrint AI](https://purpleprint-ai.com)는 누구나 IDE 없이 그 경험을 할 수 있는 웹 서비스입니다. 지금은 소수의 파운딩 빌더들과 함께 — 각자의 아이디어를 이 시스템으로 실제 제품화하면서 프레임워크를 검증하고, 그 뒤에 더 넓게 여는 구조로 진행하고 있습니다. 그 사이사이에 이 TTL 카운터처럼 에이전틱 코딩의 실제 마찰을 해결하는 작은 도구들도 만들고 있어요.

Contact: purpleprintai@gmail.com · [@ylkim.0to1](https://www.threads.net/@ylkim.0to1)
