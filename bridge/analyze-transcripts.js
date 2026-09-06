#!/usr/bin/env node
'use strict';

/**
 * Claude TTL Counter — transcript analyzer.
 *
 * Reads Claude Code transcripts (~/.claude/projects/**\/*.jsonl) and reports the user's turn
 * rhythm, cold starts, the cache tier actually used, and a counterfactual cost comparison of the
 * 5-minute vs 1-hour prompt-cache TTL. Used by the `/ttl-advisor` Claude Code skill and runnable
 * on its own.
 *
 * Privacy: only timestamps and token counts are read. Prompt text is never printed.
 *
 *   node analyze-transcripts.js                 # current project (cwd), last 30 days, text report
 *   node analyze-transcripts.js --json          # machine-readable report
 *   node analyze-transcripts.js --all           # every project on this machine
 *   node analyze-transcripts.js --project <dir> --days 14 --window 30
 *   node analyze-transcripts.js --session <sessionId>
 *
 * The turn reconstruction mirrors src/transcript-tracker.ts in the extension.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MINUTE = 60 * 1000;
const TTL_MS = { '5m': 5 * MINUTE, '1h': 60 * MINUTE };
const CACHE_WRITE_MULTIPLIER = { '5m': 1.25, '1h': 2 };
const DEFAULT_READ_MULTIPLIER = 0.1;
const LOW_READ_MULTIPLIER = 0.025;
const LOW_READ_MODEL_PATTERN = /^claude-(fable|mythos)-5-1/;
const INTERRUPT_PLACEHOLDER_TEXT = '[Request interrupted by user]';
const LOCAL_WRAPPER_PATTERN = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|ide_selection|ide_opened_file)\b/;
const MIN_TURNS_FOR_1H = 5;
const MIN_TURNS_FOR_5M = 8;
const MIN_MARGIN_FOR_1H = 0.08;
const STRONG_MARGIN_FOR_1H = 0.25;
const MIN_MARGIN_FOR_5M = 0.2;
const STRONG_MARGIN_FOR_5M = 0.35;

function parseArgs(argv) {
  const args = { project: process.cwd(), all: false, days: 30, window: 30, json: false, session: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--json') args.json = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--project') args.project = next();
    else if (arg === '--days') args.days = Number(next());
    else if (arg === '--window') args.window = Number(next());
    else if (arg === '--session') args.session = next();
  }
  if (!Number.isFinite(args.days) || args.days <= 0) args.days = 30;
  if (!Number.isFinite(args.window) || args.window <= 0) args.window = 30;
  return args;
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readMultiplier(model) {
  return model && LOW_READ_MODEL_PATTERN.test(model) ? LOW_READ_MULTIPLIER : DEFAULT_READ_MULTIPLIER;
}

function classifyUserLine(line) {
  if (line.type !== 'user' || line.isSidechain) return 'ignore';
  const content = line.message && line.message.content;
  let texts = [];
  if (typeof content === 'string') texts = [content];
  else if (Array.isArray(content)) {
    if (content.some((item) => item && item.type === 'tool_result')) return 'tool_result';
    texts = content.filter((item) => item && item.type === 'text' && typeof item.text === 'string').map((item) => item.text);
  } else return 'ignore';
  if (line.isMeta) return 'ignore';
  const real = texts.map((text) => text.trim()).filter((text) => text && text !== INTERRUPT_PLACEHOLDER_TEXT && !LOCAL_WRAPPER_PATTERN.test(text));
  return real.length > 0 ? 'prompt' : 'ignore';
}

function extractTier(usage) {
  const breakdown = usage && usage.cache_creation;
  if (toNumber(breakdown && breakdown.ephemeral_1h_input_tokens) > 0) return '1h';
  if (toNumber(breakdown && breakdown.ephemeral_5m_input_tokens) > 0) return '5m';
  return undefined;
}

/** Reconstructs logical turns and API calls from one transcript file. */
function parseTranscript(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }

  const turns = [];
  const calls = [];
  const seen = new Set();
  let cwd;
  let pendingRequestAt;
  let lastKnownTier;
  let lastResponseAt;
  const tierWrites = { '5m': 0, '1h': 0 };

  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let line;
    try {
      line = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!line || typeof line !== 'object') continue;
    if (line.cwd && !cwd) cwd = line.cwd;
    const timestamp = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (Number.isNaN(timestamp)) continue;

    if (line.type === 'user') {
      const kind = classifyUserLine(line);
      if (kind === 'ignore') continue;
      if (kind === 'prompt') {
        const previous = turns[turns.length - 1];
        turns.push({
          index: turns.length,
          promptAt: timestamp,
          synthetic: false,
          idleBeforeMs: previous ? Math.max(0, timestamp - previous.lastRequestAt) : undefined,
          callCount: 0,
          lastRequestAt: timestamp,
          coldStart: false,
          partialHit: false,
        });
      } else {
        const current = turns[turns.length - 1];
        if (current) current.lastRequestAt = Math.max(current.lastRequestAt, timestamp);
      }
      pendingRequestAt = timestamp;
      continue;
    }

    if (line.type !== 'assistant' || line.isSidechain || !line.message || !line.message.usage) continue;
    const dedupeKey = line.requestId || line.message.id;
    if (dedupeKey) {
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }

    const usage = line.message.usage;
    let turn = turns[turns.length - 1];
    if (!turn) {
      const promptAt = pendingRequestAt !== undefined ? pendingRequestAt : timestamp;
      turn = { index: 0, promptAt, synthetic: true, callCount: 0, lastRequestAt: promptAt, coldStart: false, partialHit: false };
      turns.push(turn);
    }

    const requestAt = pendingRequestAt !== undefined ? pendingRequestAt : (lastResponseAt !== undefined ? lastResponseAt : timestamp);
    pendingRequestAt = undefined;
    const inputTokens = toNumber(usage.input_tokens);
    const cacheReadTokens = toNumber(usage.cache_read_input_tokens);
    const cacheCreationTokens = toNumber(usage.cache_creation_input_tokens);
    const call = {
      turnIndex: turn.index,
      requestAt,
      responseAt: timestamp,
      model: line.message.model,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      outputTokens: toNumber(usage.output_tokens),
      grossInputTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
      tier: extractTier(usage),
      stopReason: line.message.stop_reason,
    };

    if (!turn.openingCall) {
      turn.openingCall = call;
      turn.tierBefore = lastKnownTier;
      const previous = turns.length >= 2 ? turns[turns.length - 2] : undefined;
      const cold = call.cacheReadTokens === 0 && call.cacheCreationTokens > 0;
      turn.coldStart = cold;
      if (cold) {
        if (!previous || turn.idleBeforeMs === undefined) turn.coldStartKind = 'session_start';
        else if (turn.idleBeforeMs > TTL_MS[turn.tierBefore || '5m']) turn.coldStartKind = 'ttl_expiry';
        else turn.coldStartKind = 'other';
      }
      const previousGross = previous && previous.closingCall ? previous.closingCall.grossInputTokens : 0;
      turn.partialHit = !cold && previousGross > 0 && call.cacheReadTokens < 0.5 * previousGross;
    }

    turn.closingCall = call;
    turn.callCount += 1;
    turn.lastRequestAt = Math.max(turn.lastRequestAt, requestAt);
    if (call.tier) {
      lastKnownTier = call.tier;
      tierWrites[call.tier] += 1;
    }
    lastResponseAt = timestamp;
    calls.push(call);
  }

  if (!calls.length) return undefined;

  return {
    file: filePath,
    sessionId: path.basename(filePath, '.jsonl'),
    cwd: cwd || path.basename(path.dirname(filePath)),
    turns,
    calls,
    startedAt: turns.length ? turns[0].promptAt : calls[0].requestAt,
    endedAt: calls[calls.length - 1].responseAt,
    lastTier: lastKnownTier,
    tierWrites,
  };
}

function simulateCost(calls, tier) {
  const write = CACHE_WRITE_MULTIPLIER[tier];
  const ttl = TTL_MS[tier];
  let cost = 0;
  let expiredRequests = 0;
  let rebuildTokens = 0;
  let previous;
  for (const call of calls) {
    const read = readMultiplier(call.model);
    if (!previous) {
      cost += read * call.cacheReadTokens + write * call.cacheCreationTokens + call.inputTokens;
    } else if (call.requestAt - previous.requestAt <= ttl) {
      if (call.cacheReadTokens > 0) {
        cost += read * call.cacheReadTokens + write * call.cacheCreationTokens + call.inputTokens;
      } else {
        const reuse = Math.min(call.grossInputTokens, previous.grossInputTokens);
        cost += read * reuse + write * (call.grossInputTokens - reuse);
      }
    } else {
      cost += write * call.grossInputTokens;
      expiredRequests += 1;
      rebuildTokens += call.grossInputTokens;
    }
    previous = call;
  }
  return { tier, cost, expiredRequests, rebuildTokens };
}

function percentile(values, p) {
  if (!values.length) return undefined;
  const ascending = [...values].sort((a, b) => a - b);
  return ascending[Math.min(ascending.length - 1, Math.max(0, Math.floor(p * ascending.length)))];
}

function round(value, digits = 1) {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function minutes(ms) {
  return ms === undefined ? undefined : ms / MINUTE;
}

function realTurns(session) {
  return session.turns.filter((turn) => !turn.synthetic && turn.callCount > 0);
}

/** Cost comparison over a set of sessions (each session simulated independently). */
function compare(sessions, windowTurns) {
  let cost5m = 0;
  let cost1h = 0;
  let calls = 0;
  let turns = 0;
  let expired5m = 0;
  let expired1h = 0;
  for (const session of sessions) {
    const considered = realTurns(session);
    const window = windowTurns ? considered.slice(-windowTurns) : considered;
    if (!window.length) continue;
    const firstIndex = window[0].index;
    const windowCalls = session.calls.filter((call) => call.turnIndex >= firstIndex);
    if (windowCalls.length < 2) continue;
    const sim5m = simulateCost(windowCalls, '5m');
    const sim1h = simulateCost(windowCalls, '1h');
    cost5m += sim5m.cost;
    cost1h += sim1h.cost;
    expired5m += sim5m.expiredRequests;
    expired1h += sim1h.expiredRequests;
    calls += windowCalls.length;
    turns += window.length;
  }
  const cheaper = cost5m <= cost1h ? '5m' : '1h';
  const marginRatio = Math.abs(cost5m - cost1h) / Math.max(cost5m, cost1h, 1);
  return { turns, calls, cost5m: Math.round(cost5m), cost1h: Math.round(cost1h), cheaper, marginPct: round(marginRatio * 100), expiredRequests5m: expired5m, expiredRequests1h: expired1h };
}

function decide(comparison) {
  const { cheaper, marginPct, turns } = comparison;
  const margin = (marginPct || 0) / 100;
  if (cheaper === '1h') {
    if (turns < MIN_TURNS_FOR_1H || margin < MIN_MARGIN_FOR_1H) return { mode: null, strength: 'insufficient' };
    return { mode: '1h', strength: margin >= STRONG_MARGIN_FOR_1H ? 'strong' : 'weak' };
  }
  if (turns < MIN_TURNS_FOR_5M || margin < MIN_MARGIN_FOR_5M) return { mode: null, strength: 'insufficient' };
  return { mode: '5m', strength: margin >= STRONG_MARGIN_FOR_5M ? 'strong' : 'weak' };
}

function rhythm(sessions) {
  const turns = sessions.flatMap(realTurns);
  const idle = turns.map((turn) => turn.idleBeforeMs).filter((gap) => gap !== undefined);
  const durations = turns.map((turn) => turn.closingCall.responseAt - turn.promptAt);
  const contexts = turns.map((turn) => turn.openingCall.grossInputTokens).filter((tokens) => tokens > 0);
  const partialReads = turns.filter((turn) => turn.partialHit && turn.idleBeforeMs !== undefined && turn.idleBeforeMs > TTL_MS['1h']).map((turn) => turn.openingCall.cacheReadTokens);
  const buckets = [['<1m', 0, 1], ['1-3m', 1, 3], ['3-5m', 3, 5], ['5-10m', 5, 10], ['10-30m', 10, 30], ['30-60m', 30, 60], ['1-3h', 60, 180], ['>3h', 180, Infinity]];
  const idleBuckets = buckets.map(([label, lo, hi]) => {
    const inBucket = turns.filter((turn) => turn.idleBeforeMs !== undefined && minutes(turn.idleBeforeMs) >= lo && minutes(turn.idleBeforeMs) < hi);
    const cold = inBucket.filter((turn) => turn.coldStart);
    return {
      label,
      turns: inBucket.length,
      coldRatePct: inBucket.length ? round((100 * cold.length) / inBucket.length, 0) : null,
      partialHitRatePct: inBucket.length ? round((100 * inBucket.filter((turn) => turn.partialHit).length) / inBucket.length, 0) : null,
    };
  }).filter((bucket) => bucket.turns > 0);
  const ttlExpiry = turns.filter((turn) => turn.coldStartKind === 'ttl_expiry');
  const other = turns.filter((turn) => turn.coldStartKind === 'other');
  return {
    turns: turns.length,
    idleGapMinutes: { p10: round(minutes(percentile(idle, 0.1))), p25: round(minutes(percentile(idle, 0.25))), p50: round(minutes(percentile(idle, 0.5))), p75: round(minutes(percentile(idle, 0.75))), p90: round(minutes(percentile(idle, 0.9))) },
    turnDurationMinutes: { p50: round(minutes(percentile(durations, 0.5))), p90: round(minutes(percentile(durations, 0.9))), over5mPct: durations.length ? round((100 * durations.filter((d) => d > 5 * MINUTE).length) / durations.length, 0) : null },
    contextTokens: { p50: percentile(contexts, 0.5) || null, p90: percentile(contexts, 0.9) || null },
    alwaysOnPrefixTokens: partialReads.length >= 3 ? percentile(partialReads, 0.5) : null,
    idleBuckets,
    coldStarts: {
      sessionStart: turns.filter((turn) => turn.coldStartKind === 'session_start').length,
      ttlExpiry: { turns: ttlExpiry.length, rebuildTokens: ttlExpiry.reduce((sum, turn) => sum + turn.openingCall.cacheCreationTokens, 0) },
      other: { turns: other.length, rebuildTokens: other.reduce((sum, turn) => sum + turn.openingCall.cacheCreationTokens, 0) },
    },
  };
}

function listTranscripts(projectsDir, projectPath, all) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'subagents') continue;
        walk(full);
      } else if (entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
        files.push(full);
      }
    }
  };

  if (all) {
    walk(projectsDir);
    return files;
  }

  const slug = path.resolve(projectPath).replace(/[:\\/]/g, '-').toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.toLowerCase() === slug) {
      walk(path.join(projectsDir, entry.name));
    }
  }
  return files;
}

function projectLabel(cwd) {
  return String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
}

function buildReport(args) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const now = Date.now();
  const cutoff = now - args.days * 24 * 60 * MINUTE;
  let files = listTranscripts(projectsDir, args.project, args.all);
  if (args.session) files = files.filter((file) => path.basename(file, '.jsonl') === args.session);
  const sessions = files.map(parseTranscript).filter((session) => session && session.endedAt >= cutoff && realTurns(session).length > 0);
  sessions.sort((a, b) => a.endedAt - b.endedAt);

  const tierWrites = { '5m': 0, '1h': 0 };
  for (const session of sessions) {
    tierWrites['5m'] += session.tierWrites['5m'];
    tierWrites['1h'] += session.tierWrites['1h'];
  }
  const latest = sessions[sessions.length - 1];
  const overall = compare(sessions, undefined);
  const latestComparison = latest ? compare([latest], args.window) : undefined;
  const decision = decide(overall);

  const recentSessions = sessions.slice(-15).map((session) => {
    const comparison = compare([session], args.window);
    const idle = realTurns(session).map((turn) => turn.idleBeforeMs).filter((gap) => gap !== undefined);
    return {
      sessionId: session.sessionId,
      project: projectLabel(session.cwd),
      endedAt: new Date(session.endedAt).toISOString(),
      turns: realTurns(session).length,
      idleMedianMinutes: round(minutes(percentile(idle, 0.5))),
      tier: session.lastTier || null,
      cheaper: comparison.turns > 0 ? comparison.cheaper : null,
      marginPct: comparison.turns > 0 ? comparison.marginPct : null,
      verdict: formatVerdict(comparison),
    };
  });

  const perProject = [];
  if (args.all) {
    const groups = new Map();
    for (const session of sessions) {
      const key = projectLabel(session.cwd);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }
    for (const [project, group] of groups) {
      const comparison = compare(group, undefined);
      const idle = group.flatMap(realTurns).map((turn) => turn.idleBeforeMs).filter((gap) => gap !== undefined);
      perProject.push({
        project,
        sessions: group.length,
        turns: comparison.turns,
        idleMedianMinutes: round(minutes(percentile(idle, 0.5))),
        cheaper: comparison.turns > 0 ? comparison.cheaper : null,
        marginPct: comparison.turns > 0 ? comparison.marginPct : null,
        verdict: formatVerdict(comparison),
      });
    }
    perProject.sort((a, b) => b.turns - a.turns);
  }

  return {
    generatedAt: new Date(now).toISOString(),
    scope: { project: args.all ? 'all' : path.resolve(args.project), days: args.days, windowTurns: args.window, transcripts: files.length, sessions: sessions.length },
    assumptions: {
      cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
      cacheReadMultiplier: { default: DEFAULT_READ_MULTIPLIER, 'claude-fable-5-1': LOW_READ_MULTIPLIER },
      ttlMinutes: { '5m': 5, '1h': 60 },
      costUnit: 'base-input-token equivalents (input side only; output tokens are identical under both policies)',
      note: 'Subscription usage-limit accounting is assumed to be weighted like API pricing. Treat absolute numbers as estimates; the comparison between policies is the signal.',
    },
    observedTier: { latest: latest ? latest.lastTier || null : null, writesByTier: tierWrites },
    rhythm: rhythm(sessions),
    simulation: { overall, latestSession: latestComparison || null },
    recommendation: {
      mode: decision.mode,
      strength: decision.strength,
      cheaper: overall.cheaper,
      marginPct: overall.marginPct,
      basis: `${overall.turns} turns / ${overall.calls} API calls across ${sessions.length} sessions in the last ${args.days} days`,
    },
    recentSessions,
    perProject: args.all ? perProject : undefined,
  };
}

function formatTokens(value) {
  if (value === null || value === undefined) return '-';
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

function formatMinutes(value) {
  return value === null || value === undefined ? '-' : `${value}m`;
}

function formatVerdict(comparison) {
  return comparison.turns > 0 ? `${comparison.cheaper} by ${comparison.marginPct}%` : 'not enough data';
}

function printText(report) {
  const lines = [];
  const r = report.rhythm;
  lines.push(`Claude TTL Counter — transcript analysis (${report.generatedAt.slice(0, 16).replace('T', ' ')} UTC)`);
  lines.push(`Scope: ${report.scope.project} | last ${report.scope.days} days | ${report.scope.sessions} sessions, ${r.turns} turns`);
  lines.push(`Observed cache tier: latest ${report.observedTier.latest || 'unknown'} | writes 5m=${report.observedTier.writesByTier['5m']} 1h=${report.observedTier.writesByTier['1h']}`);
  lines.push('');
  lines.push('Idle gap (last API request of a turn -> next prompt), minutes:');
  lines.push(`  p10 ${r.idleGapMinutes.p10} | p25 ${r.idleGapMinutes.p25} | p50 ${r.idleGapMinutes.p50} | p75 ${r.idleGapMinutes.p75} | p90 ${r.idleGapMinutes.p90}`);
  lines.push(`Turn duration (prompt -> last API call): p50 ${r.turnDurationMinutes.p50}m | p90 ${r.turnDurationMinutes.p90}m | ${r.turnDurationMinutes.over5mPct}% of turns run longer than 5 minutes`);
  lines.push(`Context at turn open: p50 ${formatTokens(r.contextTokens.p50)} | p90 ${formatTokens(r.contextTokens.p90)} tokens${r.alwaysOnPrefixTokens ? ` | always-on prefix ~${formatTokens(r.alwaysOnPrefixTokens)} tokens (shared across sessions)` : ''}`);
  lines.push('');
  lines.push('Idle bucket   turns  cold%  partial%');
  for (const bucket of r.idleBuckets) {
    lines.push(`  ${bucket.label.padEnd(8)} ${String(bucket.turns).padStart(6)} ${String(bucket.coldRatePct).padStart(6)}% ${String(bucket.partialHitRatePct).padStart(8)}%`);
  }
  lines.push('');
  lines.push(`Cold starts: session start ${r.coldStarts.sessionStart} | TTL expiry ${r.coldStarts.ttlExpiry.turns} (rebuilt ${formatTokens(r.coldStarts.ttlExpiry.rebuildTokens)} tokens) | other (model switch, compaction, reload) ${r.coldStarts.other.turns}`);
  lines.push('');
  const s = report.simulation.overall;
  lines.push(`Counterfactual cost (input side, base-token equivalents): 5m ${formatTokens(s.cost5m)} vs 1h ${formatTokens(s.cost1h)} -> ${s.cheaper} cheaper by ${s.marginPct}%`);
  lines.push(`  cache expiries under 5m: ${s.expiredRequests5m} requests | under 1h: ${s.expiredRequests1h} requests`);
  if (report.simulation.latestSession) {
    const l = report.simulation.latestSession;
    lines.push(`Latest session (last ${report.scope.windowTurns} turns): 5m ${formatTokens(l.cost5m)} vs 1h ${formatTokens(l.cost1h)} -> ${l.cheaper} by ${l.marginPct}%`);
  }
  lines.push('');
  const rec = report.recommendation;
  lines.push(rec.mode
    ? `Recommendation: ${rec.mode} (${rec.strength}) — ${rec.basis}`
    : `Recommendation: no confident call yet (${rec.cheaper} looks cheaper by ${rec.marginPct}%, ${rec.basis})`);
  lines.push('');
  lines.push('Recent sessions:');
  for (const session of report.recentSessions) {
    lines.push(`  ${session.endedAt.slice(5, 16).replace('T', ' ')} ${session.project.slice(0, 22).padEnd(22)} turns ${String(session.turns).padStart(3)} | idle p50 ${formatMinutes(session.idleMedianMinutes).padStart(6)} | tier ${session.tier || '?'} | ${session.verdict}`);
  }
  if (report.perProject) {
    lines.push('');
    lines.push('Per project:');
    for (const project of report.perProject) {
      lines.push(`  ${project.project.slice(0, 22).padEnd(22)} sessions ${String(project.sessions).padStart(3)} turns ${String(project.turns).padStart(4)} | idle p50 ${formatMinutes(project.idleMedianMinutes).padStart(6)} | ${project.verdict}`);
    }
  }
  lines.push('');
  lines.push(`Assumptions: ${report.assumptions.note}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node analyze-transcripts.js [--project <dir>] [--all] [--days N] [--window N] [--session <id>] [--json]\n');
    return;
  }
  const report = buildReport(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printText(report);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseTranscript, simulateCost, compare, decide, rhythm, buildReport };
