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
    return ['Last turn: waiting'];
  }

  return [
    `Last turn: ${formatTokens(usage.grossInputTokens)} tokens`,
    `  Cache hit ${formatPercent(usage.cacheHitRatio)} · Fresh ${formatTokens(usage.effectiveInputTokens)}`,
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

  const healthSummary = snapshot.cacheHealth.recentColdStarts > 0
    ? `Health: ${snapshot.cacheHealth.recentColdStarts} cold start${snapshot.cacheHealth.recentColdStarts > 1 ? 's' : ''} in last ${snapshot.cacheHealth.recentTurns} turns`
    : `Health: stable (${snapshot.cacheHealth.recentTurns} turns)`;

  const recommendationLine = snapshot.recommendation && snapshot.recommendation.mode !== snapshot.mode
    ? `Tip: switch to ${getModeLabel(snapshot.recommendation.mode)}`
    : undefined;

  const awaitingLine = snapshot.awaitingAssistantTurn
    ? 'Generating...'
    : undefined;

  return {
    text: expired
      ? `$(warning) TTL expired${projectSuffix}`
      : `$(clock) TTL ${formatRemaining(remainingMs)}${projectSuffix}`,
    tooltip: [
      ...tooltipLines,
      `TTL: ${timeText}`,
      '',
      ...buildUsageLines(snapshot.lastCompletedTurn),
      healthSummary,
      ...(awaitingLine ? [awaitingLine] : []),
      ...(recommendationLine ? ['', recommendationLine] : []),
    ].join('\n'),
    warning: !expired && remainingMs <= 5 * 60 * 1000,
    expired,
    remainingRatio,
  };
}
