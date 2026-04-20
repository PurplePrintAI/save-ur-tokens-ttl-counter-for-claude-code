# Claude TTL Counter

Claude TTL Counter is a lightweight VS Code extension that shows a live countdown for Claude Code prompt cache TTL.

## What it does

- Reads the active Claude session for the current workspace
- Finds the last user prompt timestamp from the local Claude JSONL transcript
- Detects the current cache TTL mode from `~/.claude/settings.json`
- Shows a status bar countdown like `TTL 42:15`
- Warns when the TTL is close to expiry or already expired
- Lets you switch between `5분` and `1시간` mode from a Quick Pick

## How it works

The extension does **not** patch the Claude Code extension.  
Instead, it reads local Claude files:

- `~/.claude/sessions/*.json`
- `~/.claude/projects/**/<sessionId>.jsonl`
- `~/.claude/settings.json`

## Commands

- `Claude TTL: 캐시 모드 변경`
- `Claude TTL: 상태 보기`

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch the extension host.

## Notes

- Status bar text stays in English for marketplace friendliness
- Notifications are currently Korean-first
- TTL mode follows Claude Code's current settings pattern:
  - `ENABLE_PROMPT_CACHING_1H`
  - `FORCE_PROMPT_CACHING_5M`

## License

MIT
