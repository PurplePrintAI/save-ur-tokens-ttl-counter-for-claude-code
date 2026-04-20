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

이 확장은 아래 판단을 쉽게 하도록 돕습니다.

- TTL이 얼마나 남았는지
- 방금 턴이 캐시 재사용 중심이었는지, 새 입력 부담이 컸는지
- 최근 캐시 초기화가 반복되는지
- 지금 작업 리듬에는 `5분`이 맞는지, `1시간`이 더 안전한지

## Before -> After

### Before
- You guess when TTL may expire.
- You see a large token number and cannot tell whether it was real fresh usage or cache reuse.
- You only notice cache resets after the damage is done.

### After
- You can see the countdown in the status bar.
- You can inspect the latest turn's fresh input, cache read, cache creation, and cache hit ratio.
- You can catch repeated cache resets earlier and switch mode more intentionally.

## What it does

- Finds the active Claude session for the current workspace
- Reads the last user timestamp from the local Claude transcript
- Reads TTL mode (`5m` or `1h`) from `~/.claude/settings.json`
- Shows a live status bar countdown like `TTL 42:15`
- Tracks recent cache health from local transcript usage fields
- Surfaces last-turn metrics:
  - fresh input tokens
  - cache read tokens
  - cache creation tokens
  - gross input tokens
  - effective fresh tokens
  - cache hit ratio
- Warns when TTL is close to expiry or when recent cache resets look frequent
- Lets you toggle between `5m` and `1h` mode with Quick Pick

## How it works

This extension does **not** patch the Claude Code extension and does **not** proxy Claude requests.

Instead, it reads local Claude files:

- `~/.claude/sessions/*.json`
- `~/.claude/projects/**/<sessionId>.jsonl`
- `~/.claude/settings.json`

즉 이 확장은 Claude Code 확장을 수정하거나, 프롬프트를 가로채는 도구가 아닙니다.

대신 아래 로컬 파일을 읽어서 TTL과 캐시 상태를 계산합니다.

- `~/.claude/sessions/*.json`
- `~/.claude/projects/**/<sessionId>.jsonl`
- `~/.claude/settings.json`

## Which TTL mode should you use?

### Use `5m` when...

- you are sending turns quickly and repeatedly
- you are doing tight coding / fix / retry loops
- you usually respond again within a minute or two
- you want the cheaper cache mode and your pauses are short

### `5분`이 유리한 경우

- 짧은 턴을 빠르게 여러 번 주고받을 때
- 수정, 재시도, 짧은 코딩 루프처럼 리듬이 빠를 때
- 보통 1~2분 안에 다음 턴을 보내는 작업일 때
- 더 저렴한 캐시 모드를 선호하고, 작업 공백이 짧을 때

### Use `1h` when...

- you pause to read code, documents, or generated output
- you do design, planning, review, or longer reasoning between turns
- you often spend several minutes validating the agent's work before replying
- your prompts are longer and more deliberate

### `1시간`이 유리한 경우

- 코드, 문서, 산출물을 읽고 검토하는 시간이 길 때
- 설계, 기획, 리뷰, 긴 추론 작업처럼 턴 사이 공백이 길 때
- 에이전트 결과물을 직접 확인한 뒤 한참 후에 다음 턴을 보낼 때
- 프롬프트를 길고 구체적으로 작성하는 편일 때

Short version:

- `5m` is better for **fast rhythm**
- `1h` is better for **slow rhythm**

한 줄 요약:

- `5분`은 **빠른 리듬**
- `1시간`은 **느린 리듬**

## Install

### Option 1: npm installer

```bash
npx claude-ttl-counter-install
```

### Option 2: GitHub Release

```bash
curl -L https://github.com/PurplePrintAI/claude-ttl-counter/releases/latest/download/claude-ttl-counter-0.1.0.vsix -o /tmp/ttl.vsix && cursor --install-extension /tmp/ttl.vsix
```

## Quick start

1. Install the extension.
2. Open the same workspace you are using with Claude Code.
3. Look for the status bar countdown in the bottom area.
4. Click the item to switch between `5m` and `1h` mode.
5. Hover the item to inspect the latest turn's cache metrics.

더 자세한 사용 가이드는 [HOW-TO-USE.md](./HOW-TO-USE.md)를 참고해 주세요.

## Privacy

- Reads local Claude files on your machine
- Does not proxy Claude requests
- Does not upload transcript contents to a separate backend

## Current scope

This project is intentionally focused on a simple decision layer:

- TTL visibility
- recent cache visibility
- mode switching
- early warning for repeated cache resets

More advanced UX polish can be layered on top later.

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch the extension host.

## License

MIT
