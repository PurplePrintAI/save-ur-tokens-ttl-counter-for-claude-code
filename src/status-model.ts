import * as path from 'node:path';

import { getModeLabel } from './settings-manager';
import { TurnUsageSummary, TtlSnapshot } from './ttl-watcher';

export interface StatusPresentation {
  text: string;
  tooltip: string;
  warning: boolean;
  expired: boolean;
  remainingRatio?: number;
}

const numberFormatter = new Intl.NumberFormat('en-US');
const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function projectName(workspacePath?: string): string {
  return workspacePath ? path.basename(workspacePath) : '';
}

function shortSessionId(sessionId?: string): string {
  return sessionId ? sessionId.slice(0, 8) : 'none';
}

function formatTokens(value?: number): string {
  if (value === undefined) {
    return '--';
  }

  return numberFormatter.format(value);
}

function formatPercent(value?: number): string {
  if (value === undefined) {
    return '--';
  }

  return percentFormatter.format(value);
}

function buildUsageLines(usage?: TurnUsageSummary): string[] {
  if (!usage) {
    return ['Last completed turn: waiting for usage data'];
  }

  return [
    'Last completed turn:',
    `- Fresh input: ${formatTokens(usage.inputTokens)}`,
    `- Cache read: ${formatTokens(usage.cacheReadTokens)}`,
    `- Cache created: ${formatTokens(usage.cacheCreationTokens)}`,
    `- Gross input: ${formatTokens(usage.grossInputTokens)}`,
    `- Effective fresh: ${formatTokens(usage.effectiveInputTokens)}`,
    `- Cache hit: ${formatPercent(usage.cacheHitRatio)}`,
  ];
}

export function buildStatusPresentation(snapshot: TtlSnapshot, now = Date.now()): StatusPresentation {
  const project = projectName(snapshot.workspacePath);
  const projectSuffix = project ? ` · ${project}` : '';

  if (snapshot.error) {
    return {
      text: `$(warning) TTL error${projectSuffix}`,
      tooltip: `Claude TTL Counter\n\n${snapshot.error}`,
      warning: true,
      expired: false,
    };
  }

  const modeLabel = getModeLabel(snapshot.mode);
  const session = shortSessionId(snapshot.sessionId);
  const tooltipLines = [
    'Claude TTL Counter',
    '',
    `Mode: ${modeLabel}`,
    `Workspace: ${project || 'none'}`,
    `Session: ${session}`,
  ];

  if (!snapshot.lastUserPromptAt) {
    return {
      text: `$(clock) TTL --:--${projectSuffix}`,
      tooltip: [
        ...tooltipLines,
        'Status: waiting for an active Claude session',
      ].join('\n'),
      warning: false,
      expired: false,
    };
  }

  const remainingMs = snapshot.ttlMs - (now - snapshot.lastUserPromptAt);
  const expired = remainingMs <= 0;
  const timeText = expired ? 'expired' : formatRemaining(remainingMs);
  const remainingRatio = expired ? 0 : remainingMs / snapshot.ttlMs;

  const cacheHealthLines = [
    '',
    'Recent cache health:',
    `- Turns sampled: ${snapshot.cacheHealth.recentTurns}`,
    `- Cold starts: ${snapshot.cacheHealth.recentColdStarts}`,
    `- Low-hit turns: ${snapshot.cacheHealth.recentLowHitTurns}`,
  ];

  const recommendationLines = snapshot.recommendation
    ? [
      '',
      `Recommended mode: ${getModeLabel(snapshot.recommendation.mode)}`,
      snapshot.recommendation.reason,
    ]
    : [];

  const awaitingLine = snapshot.awaitingAssistantTurn
    ? ['', 'Current turn: waiting for the assistant response']
    : [];

  return {
    text: expired
      ? `$(warning) TTL expired${projectSuffix}`
      : `$(clock) TTL ${formatRemaining(remainingMs)}${projectSuffix}`,
    tooltip: [
      ...tooltipLines,
      `TTL: ${timeText}`,
      ...buildUsageLines(snapshot.lastCompletedTurn),
      ...cacheHealthLines,
      ...awaitingLine,
      ...recommendationLines,
    ].join('\n'),
    warning: !expired && remainingMs <= 5 * 60 * 1000,
    expired,
    remainingRatio,
  };
}
