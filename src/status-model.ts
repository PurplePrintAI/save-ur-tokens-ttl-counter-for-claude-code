import * as vscode from 'vscode';
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

const locale = vscode.env.language || undefined;
const numberFormatter = new Intl.NumberFormat(locale);
const percentFormatter = new Intl.NumberFormat(locale, {
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
  return sessionId ? sessionId.slice(0, 8) : vscode.l10n.t('none');
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
    return [vscode.l10n.t('Last turn: waiting')];
  }

  return [
    vscode.l10n.t('Last turn: {0} tokens', formatTokens(usage.grossInputTokens)),
    `  ${vscode.l10n.t('Cache hit {0} · Fresh {1}', formatPercent(usage.cacheHitRatio), formatTokens(usage.effectiveInputTokens))}`,
  ];
}

export function buildStatusPresentation(snapshot: TtlSnapshot, now = Date.now()): StatusPresentation {
  const project = projectName(snapshot.workspacePath);
  const projectSuffix = project ? ` · ${project}` : '';

  if (snapshot.error) {
    return {
      text: `$(warning) ${vscode.l10n.t('TTL error')}${projectSuffix}`,
      tooltip: `${vscode.l10n.t('Claude TTL Counter')}\n\n${snapshot.error}`,
      warning: true,
      expired: false,
    };
  }

  const modeLabel = getModeLabel(snapshot.mode);
  const session = shortSessionId(snapshot.sessionId);
  const tooltipLines = [
    vscode.l10n.t('Claude TTL Counter'),
    '',
    vscode.l10n.t('Mode: {0}', modeLabel),
    vscode.l10n.t('Workspace: {0}', project || vscode.l10n.t('none')),
    vscode.l10n.t('Session: {0}', session),
  ];

  if (!snapshot.lastUserPromptAt) {
    return {
      text: `$(clock) ${vscode.l10n.t('TTL --:--')}${projectSuffix}`,
      tooltip: [
        ...tooltipLines,
        vscode.l10n.t('Status: waiting for an active Claude session'),
      ].join('\n'),
      warning: false,
      expired: false,
    };
  }

  const remainingMs = snapshot.ttlMs - (now - snapshot.lastUserPromptAt);
  const expired = remainingMs <= 0;
  const timeText = expired ? vscode.l10n.t('expired') : formatRemaining(remainingMs);
  const remainingRatio = expired ? 0 : remainingMs / snapshot.ttlMs;
  const healthTurns = snapshot.sessionGracePending
    ? snapshot.logicalTurnsSinceSessionSwitch
    : snapshot.cacheHealth.recentTurns;
  const healthColdStarts = snapshot.sessionGracePending
    ? 0
    : snapshot.cacheHealth.recentColdStarts;

  const healthSummary = healthColdStarts > 0
    ? healthColdStarts > 1
      ? vscode.l10n.t('Health: {0} cold starts in last {1} turns', healthColdStarts, healthTurns)
      : vscode.l10n.t('Health: {0} cold start in last {1} turns', healthColdStarts, healthTurns)
    : vscode.l10n.t('Health: stable ({0} turns)', healthTurns);

  const recommendationLine = snapshot.recommendation && snapshot.recommendation.mode !== snapshot.mode
    ? vscode.l10n.t(snapshot.recommendation.reason)
    : undefined;

  const awaitingLine = snapshot.awaitingAssistantTurn
    ? vscode.l10n.t('Generating...')
    : undefined;

  return {
    text: expired
      ? `$(warning) ${vscode.l10n.t('TTL expired')}${projectSuffix}`
      : `$(clock) ${vscode.l10n.t('TTL {0}', formatRemaining(remainingMs))}${projectSuffix}`,
    tooltip: [
      ...tooltipLines,
      vscode.l10n.t('TTL: {0}', timeText),
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
