#!/usr/bin/env node
'use strict';

/**
 * Claude TTL Counter — universal CLI statusline.
 *
 * Renders one line: the prompt-cache TTL countdown plus (when available) your 5h/7d subscription
 * usage. It is self-sourcing — it reads Claude's local files directly, so it does not depend on the
 * host CLI piping anything. That lets you show it in:
 *
 *   - Claude Code CLI   — settings.json  "statusLine": { "type": "command",
 *                         "command": "node <path>/statusline.js" }   (stdin enriches it)
 *   - Codex CLI / any   — via tmux status-right, a shell prompt segment, or `watch`, because it
 *     other terminal      reads ~/.claude itself. Codex has no custom-command statusline hook.
 *
 * What it measures is Anthropic-specific (Claude's 5m/1h cache TTL and Claude subscription usage);
 * it displays that in whatever terminal you run it in.
 *
 * Sourcing, in priority order:
 *   TTL countdown : stdin transcript_path -> newest ~/.claude/projects transcript (tail read)
 *   5h / 7d usage : stdin rate_limits (Claude Code) -> bridge file -> OAuth cache (--usage only)
 *
 * Network: none by default. With --usage (or CLAUDE_TTL_USAGE=1) it refreshes a 60s-cached usage
 * sample from api.anthropic.com/api/oauth/usage using the login token Claude Code already stores,
 * in a detached background process so the status line never blocks. Claude Code CLI users get
 * usage from stdin and do not need --usage.
 *
 * Always exits 0 and never throws — a status line must not break the host.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const BRIDGE_PATH = path.join(CLAUDE_DIR, 'ttl-counter-rate-limits.json');
const USAGE_CACHE_PATH = path.join(CLAUDE_DIR, 'ttl-counter-usage-cache.json');

const TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 };
const TAIL_BYTES = 256 * 1024;
const STDIN_TIMEOUT_MS = 150;
const USAGE_CACHE_TTL_MS = 60 * 1000;
const USAGE_FETCH_TIMEOUT_MS = 6000;
const HIGH_USAGE_PERCENT = 90;
const INTERRUPT_TEXT = '[Request interrupted by user]';
const SYNTHETIC_MODEL = '<synthetic>';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const USAGE_ENABLED = hasFlag('--usage') || process.env.CLAUDE_TTL_USAGE === '1';
const NO_COLOR = hasFlag('--no-color') || Boolean(process.env.NO_COLOR);

function color(code, text) {
  return NO_COLOR ? text : `[${code}m${text}[0m`;
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function readStdinPayload() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(undefined);
      return;
    }
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(data.trim() ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.resume();
    } catch {
      finish();
    }
  });
}

function workspaceSlug(cwd) {
  return path.resolve(cwd).replace(/[:\\/]/g, '-').toLowerCase();
}

/** Newest .jsonl under a project dir (skips subagent transcripts). */
function newestTranscriptIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best;
  let bestAt = -1;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('agent-')) continue;
    const full = path.join(dir, entry.name);
    try {
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > bestAt) { bestAt = mtime; best = full; }
    } catch { /* ignore */ }
  }
  return best ? { path: best, mtimeMs: bestAt } : undefined;
}

/** Resolve the transcript to read: stdin's path, else the cwd's project, else newest overall. */
function resolveTranscript(stdin) {
  const fromStdin = stdin && (stdin.transcript_path || stdin.transcriptPath);
  if (typeof fromStdin === 'string' && fs.existsSync(fromStdin)) {
    return fromStdin;
  }

  const cwd = stdin && (stdin.cwd || (stdin.workspace && stdin.workspace.current_dir));
  if (typeof cwd === 'string') {
    const scoped = newestTranscriptIn(path.join(PROJECTS_DIR, workspaceSlug(cwd)));
    if (scoped) return scoped.path;
  }

  let best;
  let bestAt = -1;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const found = newestTranscriptIn(path.join(PROJECTS_DIR, entry.name));
    if (found && found.mtimeMs > bestAt) { bestAt = found.mtimeMs; best = found.path; }
  }
  return best;
}

function isRealUserPrompt(line) {
  const content = line.message && line.message.content;
  if (typeof content === 'string') return content.trim() && content.trim() !== INTERRUPT_TEXT;
  if (!Array.isArray(content)) return false;
  if (content.some((item) => item && item.type === 'tool_result')) return false;
  return content.some((item) => item && item.type === 'text' && typeof item.text === 'string'
    && item.text.trim() && item.text.trim() !== INTERRUPT_TEXT);
}

/**
 * Tail-read the transcript for the cache anchor (start of the most recent request = timestamp of
 * the last user-type line), the observed cache tier, and the last completed assistant usage.
 */
function readTranscriptTail(transcriptPath) {
  const result = { anchorAt: undefined, observedTier: undefined, lastUsage: undefined };
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      // Drop a possibly-partial first line.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const raw = lines[i].trim();
      if (!raw) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; }
      if (!line || typeof line !== 'object' || line.isSidechain) continue;
      const ts = toTimestamp(line.timestamp);

      if (line.type === 'user' && ts !== undefined && result.anchorAt === undefined) {
        // Both real prompts and tool_result lines are request starts.
        const content = line.message && line.message.content;
        const isToolResult = Array.isArray(content) && content.some((it) => it && it.type === 'tool_result');
        if (isToolResult || isRealUserPrompt(line)) result.anchorAt = ts;
      }

      if (line.type === 'assistant' && line.message && line.message.usage
        && line.message.model !== SYNTHETIC_MODEL) {
        const usage = line.message.usage;
        if (!result.lastUsage) {
          result.lastUsage = {
            cacheRead: toNumber(usage.cache_read_input_tokens) || 0,
            cacheCreation: toNumber(usage.cache_creation_input_tokens) || 0,
            input: toNumber(usage.input_tokens) || 0,
            output: toNumber(usage.output_tokens) || 0,
          };
        }
        if (result.observedTier === undefined) {
          const cc = usage.cache_creation || {};
          if (toNumber(cc.ephemeral_1h_input_tokens) > 0) result.observedTier = '1h';
          else if (toNumber(cc.ephemeral_5m_input_tokens) > 0) result.observedTier = '5m';
        }
      }

      if (result.anchorAt !== undefined && result.observedTier !== undefined && result.lastUsage) break;
    }
  } catch {
    /* ignore */
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return result;
}

function readConfiguredMode() {
  const settings = safeReadJson(SETTINGS_PATH);
  const env = (settings && settings.env) || {};
  if (env.FORCE_PROMPT_CACHING_5M) return '5m';
  if (env.ENABLE_PROMPT_CACHING_1H) return '1h';
  return '5m';
}

function normalizeWindow(win) {
  if (!win || typeof win !== 'object') return undefined;
  const percent = toNumber(win.used_percentage != null ? win.used_percentage : win.usedPercentage);
  if (percent === undefined) return undefined;
  return { percent, resetsAt: toTimestamp(win.resets_at != null ? win.resets_at : win.resetsAt) };
}

/** Merge usage from stdin / bridge file / OAuth cache; the freshest sample wins. */
function collectUsage(stdin) {
  const candidates = [];

  const stdinLimits = stdin && (stdin.rate_limits || stdin.rateLimits);
  if (stdinLimits) {
    const fiveHour = normalizeWindow(stdinLimits.five_hour || stdinLimits.fiveHour);
    const sevenDay = normalizeWindow(stdinLimits.seven_day || stdinLimits.sevenDay);
    if (fiveHour || sevenDay) {
      candidates.push({ updatedAt: Date.now(), fiveHour, sevenDay, source: 'live' });
      writeBridgeFile(stdinLimits);
    }
  }

  for (const [file, source] of [[BRIDGE_PATH, 'bridge'], [USAGE_CACHE_PATH, 'subscription']]) {
    const parsed = safeReadJson(file);
    const limits = parsed && (parsed.rate_limits || parsed.rateLimits);
    if (!limits) continue;
    const fiveHour = normalizeWindow(limits.five_hour || limits.fiveHour);
    const sevenDay = normalizeWindow(limits.seven_day || limits.sevenDay);
    if (fiveHour || sevenDay) {
      candidates.push({ updatedAt: toTimestamp(parsed.updated_at) || 0, fiveHour, sevenDay, source });
    }
  }

  if (!candidates.length) return undefined;
  candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const best = candidates[0];
  best.ageMs = best.updatedAt ? Date.now() - best.updatedAt : Infinity;
  return best;
}

const STALE_SAMPLE_MS = 6 * 60 * 60 * 1000;

/** A usage window is stale if its reset already passed, or the sample is old with no reset time. */
function isWindowStale(win, ageMs, now) {
  if (!win) return true;
  if (win.resetsAt !== undefined) return win.resetsAt <= now;
  return ageMs > STALE_SAMPLE_MS;
}

function writeBridgeFile(limits) {
  try {
    const payload = { updated_at: Date.now(), rate_limits: {} };
    if (limits.five_hour || limits.fiveHour) payload.rate_limits.five_hour = limits.five_hour || limits.fiveHour;
    if (limits.seven_day || limits.sevenDay) payload.rate_limits.seven_day = limits.seven_day || limits.sevenDay;
    if (Object.keys(payload.rate_limits).length) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
      fs.writeFileSync(BRIDGE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    }
  } catch { /* ignore */ }
}

function maybeRefreshUsageInBackground() {
  if (!USAGE_ENABLED) return;
  const cache = safeReadJson(USAGE_CACHE_PATH);
  const age = cache && cache.updated_at ? Date.now() - toTimestamp(cache.updated_at) : Infinity;
  if (age < USAGE_CACHE_TTL_MS) return;
  try {
    const child = require('child_process').spawn(process.execPath, [__filename, '--refresh-usage'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch { /* ignore */ }
}

// ---- formatting ---------------------------------------------------------------------------------

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatShort(ms) {
  if (ms === undefined || ms <= 0) return '';
  const min = ms / 60000;
  if (min < 60) return `${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${hr.toFixed(hr < 10 ? 1 : 0)}h`;
  return `${(hr / 24).toFixed(1)}d`;
}

function ttlSegment(anchorAt, ttlMs) {
  if (anchorAt === undefined) return color('90', 'TTL --:--');
  const remaining = ttlMs - (Date.now() - anchorAt);
  if (remaining <= 0) return color('1;31', 'TTL expired');
  const ratio = remaining / ttlMs;
  const clock = `TTL ${formatClock(remaining)}`;
  if (ratio <= 0.1) return color('31', clock);
  if (ratio <= 0.2) return color('33', clock);
  if (ratio <= 0.5) return color('33', clock);
  return color('32', clock);
}

function usageSegment(label, win, now) {
  if (!win) return undefined;
  const pct = `${label} ${win.percent.toFixed(win.percent < 10 ? 1 : 0)}%`;
  const reset = win.resetsAt && win.resetsAt > now ? ` (${formatShort(win.resetsAt - now)})` : '';
  const text = `${pct}${reset}`;
  return win.percent >= HIGH_USAGE_PERCENT ? color('1;31', text) : text;
}

function render(stdin, transcript, mode, usage) {
  const now = Date.now();
  const observedMode = (transcript && transcript.observedTier) || mode;
  const ttlMs = TTL_MS[observedMode] || TTL_MS['5m'];
  const segments = [ttlSegment(transcript ? transcript.anchorAt : undefined, ttlMs)];

  const ctx = stdin && stdin.context_window
    && toNumber(stdin.context_window.used_percentage != null
      ? stdin.context_window.used_percentage
      : stdin.context_window.usedPercentage);
  if (ctx !== undefined) segments.push(`ctx ${Math.round(ctx)}%`);

  if (usage) {
    const five = isWindowStale(usage.fiveHour, usage.ageMs, now) ? undefined : usageSegment('5h', usage.fiveHour, now);
    const seven = isWindowStale(usage.sevenDay, usage.ageMs, now) ? undefined : usageSegment('7d', usage.sevenDay, now);
    if (five) segments.push(five);
    if (seven) segments.push(seven);
  }

  return segments.join(color('90', ' · '));
}

// ---- usage refresh subcommand (detached) --------------------------------------------------------

function loadAccessToken() {
  const parsed = safeReadJson(path.join(CLAUDE_DIR, '.credentials.json'));
  const oauth = parsed && parsed.claudeAiOauth;
  if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken) {
    if (oauth.expiresAt && toTimestamp(oauth.expiresAt) <= Date.now()) return undefined;
    return oauth.accessToken;
  }
  if (process.platform === 'darwin') {
    try {
      const raw = require('child_process')
        .execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 })
        .toString();
      const kc = JSON.parse(raw.trim());
      const kcOauth = kc && kc.claudeAiOauth;
      if (kcOauth && typeof kcOauth.accessToken === 'string' && kcOauth.accessToken
        && (!kcOauth.expiresAt || toTimestamp(kcOauth.expiresAt) > Date.now())) {
        return kcOauth.accessToken;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

function refreshUsageAndExit() {
  const token = loadAccessToken();
  if (!token) { process.exit(0); return; }
  const https = require('https');
  const req = https.request({
    host: 'api.anthropic.com',
    path: '/api/oauth/usage',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
      'User-Agent': 'claude-ttl-counter-statusline',
    },
    timeout: USAGE_FETCH_TIMEOUT_MS,
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        if (res.statusCode !== 200) { process.exit(0); return; }
        const json = JSON.parse(body);
        const pick = (kind) => (json.limits || []).find((l) => l && l.kind === kind);
        const session = pick('session');
        const weekly = pick('weekly_all');
        const five = session
          ? { used_percentage: session.percent, resets_at: session.resets_at }
          : json.five_hour && { used_percentage: json.five_hour.utilization, resets_at: json.five_hour.resets_at };
        const seven = weekly
          ? { used_percentage: weekly.percent, resets_at: weekly.resets_at }
          : json.seven_day && { used_percentage: json.seven_day.utilization, resets_at: json.seven_day.resets_at };
        if (!five && !seven) { process.exit(0); return; }
        const payload = { updated_at: Date.now(), rate_limits: {} };
        if (five) payload.rate_limits.five_hour = five;
        if (seven) payload.rate_limits.seven_day = seven;
        fs.mkdirSync(CLAUDE_DIR, { recursive: true });
        fs.writeFileSync(USAGE_CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
      } catch { /* ignore */ }
      process.exit(0);
    });
    res.on('error', () => process.exit(0));
  });
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('error', () => process.exit(0));
  req.end();
}

// ---- main ---------------------------------------------------------------------------------------

function printHelp() {
  process.stdout.write([
    'Claude TTL Counter — universal CLI statusline',
    '',
    'Usage: node statusline.js [--usage] [--no-color]',
    '',
    '  --usage       also show 5h/7d subscription usage, refreshed (background, 60s cache) from',
    '                api.anthropic.com using the Claude Code login already on this machine.',
    '                Claude Code CLI users get usage from stdin and do not need this.',
    '  --no-color    plain output (also honors NO_COLOR).',
    '',
    'Wire it up:',
    '  Claude Code  ~/.claude/settings.json -> "statusLine": {"type":"command",',
    '               "command":"node <path>/statusline.js"}',
    '  Any terminal tmux:  set -g status-right "#(node <path>/statusline.js --usage)"',
    '               watch: watch -n 5 node <path>/statusline.js --usage',
    '',
  ].join('\n'));
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) { printHelp(); process.exit(0); return; }
  if (hasFlag('--refresh-usage')) { refreshUsageAndExit(); return; }

  let output = '';
  try {
    const stdin = await readStdinPayload();
    const transcriptPath = resolveTranscript(stdin);
    const transcript = transcriptPath ? readTranscriptTail(transcriptPath) : undefined;
    const mode = readConfiguredMode();
    const usage = collectUsage(stdin);
    maybeRefreshUsageInBackground();
    output = render(stdin, transcript, mode, usage);
  } catch {
    output = '';
  }

  if (output) process.stdout.write(output);
  process.exit(0);
}

main();
