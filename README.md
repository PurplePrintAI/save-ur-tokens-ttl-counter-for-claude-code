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

**PurplePrint AI** — Zero to Builder.

비개발자도 아이디어 한 줄에서 설계 완성까지. AI가 이끌어주는 설계 코칭 서비스를 만들고 있습니다.

- Email: purpleprintai@gmail.com
- Threads: [@ylkim.0to1](https://www.threads.net/@ylkim.0to1)
- GitHub: [PurplePrintAI](https://github.com/PurplePrintAI)
