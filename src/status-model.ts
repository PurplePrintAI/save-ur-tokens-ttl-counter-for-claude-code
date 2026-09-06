import * as vscode from 'vscode';
import * as path from 'node:path';

import { hasRateLimitData } from './rate-limit-bridge';
import { getModeLabel } from './settings-manager';
import { TurnUsageSummary, TtlSnapshot } from './ttl-watcher';

export type StatusVisualState = 'countdown' | 'turn_usage' | 'rate_limit' | 'warning' | 'expired' | 'error';

export interface StatusPresentation {
  text: string;
  tooltip: string;
  visualState: StatusVisualState;
  remainingRatio?: number;
}

const locale = vscode.env.language || undefined;
const numberFormatter = new Intl.NumberFormat(locale);
const percentFormatter = new Intl.NumberFormat(locale, {
  style: 'percent',
  maximumFractionDigits: 1,
});
const compactNumberFormatter = new Intl.NumberFormat(locale, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const rateLimitPercentFormatter = new Intl.NumberFormat(locale, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function getCacheAnchorAt(snapshot: TtlSnapshot): number | undefined {
  return snapshot.cacheAnchorAt ?? snapshot.lastUserPromptAt;
}

function getRemainingMs(snapshot: TtlSnapshot, now = Date.now()): number | undefined {
  const anchor = getCacheAnchorAt(snapshot);
  if (!anchor) {
    return undefined;
  }

  return snapshot.ttlMs - (now - anchor);
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDurationShort(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) {
    return '--';
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = seconds / 60;
  if (minutes < 10) {
    return `${compactNumberFormatter.format(minutes)}m`;
  }

  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }

  return `${compactNumberFormatter.format(minutes / 60)}h`;
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

function formatCompactTokens(value?: number): string {
  if (value === undefined) {
    return '--';
  }

  if (Math.abs(value) < 1000) {
    return numberFormatter.format(Math.round(value));
  }

  const thousands = value / 1000;
  if (Math.abs(thousands) >= 10) {
    return `${numberFormatter.format(Math.round(thousands))}k`;
  }

  return `${compactNumberFormatter.format(thousands)}k`;
}

function formatPercent(value?: number): string {
  if (value === undefined) {
    return '--';
  }

  return percentFormatter.format(value);
}

function formatRateLimitPercent(value?: number): string {
  if (value === undefined) {
    return '--';
  }

  return rateLimitPercentFormatter.format(value);
}

function buildUsageLines(usage?: TurnUsageSummary): string[] {
  if (!usage) {
    return [vscode.l10n.t('Last turn: waiting')];
  }

  return [
    vscode.l10n.t('Last turn: {0} tokens', formatTokens(usage.grossInputTokens)),
    `  ${vscode.l10n.t('Cache hit {0} | Fresh {1}', formatPercent(usage.cacheHitRatio), formatTokens(usage.effectiveInputTokens))}`,
  ];
}

function buildRateLimitTooltipLines(snapshot: TtlSnapshot): string[] {
  if (!hasRateLimitData(snapshot.rateLimits)) {
    return [];
  }

  const lines: string[] = [''];
  if (snapshot.rateLimits?.fiveHourUsedPercentage !== undefined) {
    lines.push(vscode.l10n.t('5h usage: {0}%', formatRateLimitPercent(snapshot.rateLimits.fiveHourUsedPercentage)));
  }

  if (snapshot.rateLimits?.sevenDayUsedPercentage !== undefined) {
    lines.push(vscode.l10n.t('7d usage: {0}%', formatRateLimitPercent(snapshot.rateLimits.sevenDayUsedPercentage)));
  }

  return lines;
}

function buildTurnUsageFlash(usage?: TurnUsageSummary): string | undefined {
  if (!usage) {
    return undefined;
  }

  return vscode.l10n.t(
    '{0} in | hit {1} | {2} out',
    formatCompactTokens(usage.grossInputTokens),
    formatPercent(usage.cacheHitRatio),
    formatCompactTokens(usage.outputTokens),
  );
}

function formatDelta(delta?: number): string {
  if (delta === undefined || delta === 0) return '';
  const sign = delta > 0 ? '+' : '';
  return ` (${sign}${formatRateLimitPercent(delta)}%)`;
}

function buildRateLimitFlash(snapshot: TtlSnapshot): string | undefined {
  const fiveHour = snapshot.rateLimits?.fiveHourUsedPercentage;
  const sevenDay = snapshot.rateLimits?.sevenDayUsedPercentage;
  const fhDelta = snapshot.rateLimitDelta?.fiveHourDelta;
  const sdDelta = snapshot.rateLimitDelta?.sevenDayDelta;

  if (fiveHour !== undefined && sevenDay !== undefined) {
    return `5h ${formatRateLimitPercent(fiveHour)}%${formatDelta(fhDelta)} | 7d ${formatRateLimitPercent(sevenDay)}%${formatDelta(sdDelta)}`;
  }

  if (fiveHour !== undefined) {
    return `5h ${formatRateLimitPercent(fiveHour)}%${formatDelta(fhDelta)}`;
  }

  if (sevenDay !== undefined) {
    return `7d ${formatRateLimitPercent(sevenDay)}%${formatDelta(sdDelta)}`;
  }

  return undefined;
}

function buildHealthLines(snapshot: TtlSnapshot): string[] {
  const turns = snapshot.sessionGracePending
    ? snapshot.logicalTurnsSinceSessionSwitch
    : snapshot.cacheHealth.recentTurns;
  const ttlResets = snapshot.sessionGracePending ? 0 : snapshot.cacheHealth.recentTtlExpiryColdStarts;
  const otherResets = snapshot.sessionGracePending ? 0 : snapshot.cacheHealth.recentOtherColdStarts;

  const lines = [
    ttlResets > 0
      ? ttlResets > 1
        ? vscode.l10n.t('Health: {0} TTL-expiry resets in last {1} turns', ttlResets, turns)
        : vscode.l10n.t('Health: {0} TTL-expiry reset in last {1} turns', ttlResets, turns)
      : vscode.l10n.t('Health: stable ({0} turns)', turns),
  ];

  if (otherResets > 0) {
    lines.push(vscode.l10n.t('Other cold starts (model switch, compaction, reload): {0}', otherResets));
  }

  return lines;
}

function buildRhythmLines(snapshot: TtlSnapshot): string[] {
  const rhythm = snapshot.rhythm;
  if (!rhythm || rhythm.turns < 2 || rhythm.idleMedianMs === undefined) {
    return [];
  }

  const lines = [
    vscode.l10n.t(
      'Rhythm: idle gap median {0} | p75 {1} (last {2} turns)',
      formatDurationShort(rhythm.idleMedianMs),
      formatDurationShort(rhythm.idleP75Ms),
      rhythm.turns,
    ),
  ];

  if (rhythm.ttlExpiryColdStarts > 0) {
    lines.push(vscode.l10n.t(
      'TTL-expiry rebuilds: {0} turns | {1} tokens (last {2} turns)',
      rhythm.ttlExpiryColdStarts,
      formatCompactTokens(rhythm.ttlExpiryRebuildTokens),
      rhythm.turns,
    ));
  }

  return lines;
}

/** Builds the tooltip line for the recommendation. `undefined` when there is nothing to say. */
export function buildRecommendationLine(snapshot: TtlSnapshot): string | undefined {
  const recommendation = snapshot.recommendation;
  if (!recommendation) {
    return undefined;
  }

  const marginPercent = Math.round(recommendation.marginRatio * 100);
  const recommendedLabel = getModeLabel(recommendation.mode);
  const otherLabel = getModeLabel(recommendation.mode === '1h' ? '5m' : '1h');

  if (recommendation.mode === snapshot.mode) {
    return vscode.l10n.t(
      'Mode check: {0} is the cheaper choice (about {1}% vs {2}, last {3} turns).',
      recommendedLabel,
      marginPercent,
      otherLabel,
      recommendation.windowTurns,
    );
  }

  if (recommendation.strength === 'strong') {
    return vscode.l10n.t(
      'Tip: strongly recommend {0} (about {1}% less over your last {2} turns).',
      recommendedLabel,
      marginPercent,
      recommendation.windowTurns,
    );
  }

  return vscode.l10n.t(
    'Tip: {0} would have cost about {1}% less over your last {2} turns.',
    recommendedLabel,
    marginPercent,
    recommendation.windowTurns,
  );
}

export function hasFrequentResetWarning(snapshot: TtlSnapshot): boolean {
  return !snapshot.sessionGracePending
    && snapshot.mode === '5m'
    && snapshot.logicalTurnsSinceSessionSwitch >= 2
    && snapshot.cacheHealth.recentTtlExpiryColdStarts >= 2;
}

export function shouldPrioritizeWarning(snapshot: TtlSnapshot, now = Date.now()): boolean {
  const remainingMs = getRemainingMs(snapshot, now);
  return Boolean(snapshot.error || hasFrequentResetWarning(snapshot) || (remainingMs !== undefined && remainingMs <= 0));
}

export function buildStatusPresentation(snapshot: TtlSnapshot, now = Date.now()): StatusPresentation {
  const project = projectName(snapshot.workspacePath);
  const projectSuffix = project ? ` | ${project}` : '';

  if (snapshot.error) {
    return {
      text: `$(warning) ${vscode.l10n.t('TTL error')}${projectSuffix}`,
      tooltip: `${vscode.l10n.t('Claude TTL Counter')}\n\n${snapshot.error}`,
      visualState: 'error',
    };
  }

  const modeLabel = getModeLabel(snapshot.mode);
  const session = shortSessionId(snapshot.sessionId);
  const tooltipLines = [
    vscode.l10n.t('Claude TTL Counter'),
    '',
    vscode.l10n.t('Mode: {0}', modeLabel),
  ];

  if (snapshot.observedTier && snapshot.observedTier !== snapshot.configuredMode) {
    tooltipLines.push(vscode.l10n.t(
      'Observed cache TTL: {0} (settings say {1})',
      getModeLabel(snapshot.observedTier),
      getModeLabel(snapshot.configuredMode),
    ));
  }

  tooltipLines.push(
    vscode.l10n.t('Workspace: {0}', project || vscode.l10n.t('none')),
    vscode.l10n.t('Session: {0}', session),
  );

  if (!getCacheAnchorAt(snapshot)) {
    return {
      text: `$(clock) ${vscode.l10n.t('TTL --:--')}${projectSuffix}`,
      tooltip: [
        ...tooltipLines,
        vscode.l10n.t('Status: waiting for an active Claude session'),
      ].join('\n'),
      visualState: 'countdown',
    };
  }

  const remainingMs = getRemainingMs(snapshot, now) ?? 0;
  const expired = remainingMs <= 0;
  const timeText = expired ? vscode.l10n.t('expired') : formatRemaining(remainingMs);
  const remainingRatio = expired ? 0 : remainingMs / snapshot.ttlMs;

  const recommendationLine = buildRecommendationLine(snapshot);
  const awaitingLine = snapshot.awaitingAssistantTurn
    ? vscode.l10n.t('Generating...')
    : undefined;
  const visualState: StatusVisualState = expired
    ? 'expired'
    : hasFrequentResetWarning(snapshot)
      ? 'warning'
      : snapshot.rollingState === 'turn_usage'
        ? 'turn_usage'
        : snapshot.rollingState === 'rate_limit' && hasRateLimitData(snapshot.rateLimits)
          ? 'rate_limit'
          : 'countdown';
  const turnUsageFlash = buildTurnUsageFlash(snapshot.lastCompletedTurn);
  const rateLimitFlash = buildRateLimitFlash(snapshot);

  const text = visualState === 'turn_usage' && turnUsageFlash
    ? `$(pulse) ${turnUsageFlash}`
    : visualState === 'rate_limit' && rateLimitFlash
      ? `$(dashboard) ${rateLimitFlash}`
      : visualState === 'warning'
        ? `$(warning) ${vscode.l10n.t('TTL {0}', formatRemaining(remainingMs))}${projectSuffix}`
        : expired
          ? `$(warning) ${vscode.l10n.t('TTL expired')}${projectSuffix}`
          : `$(clock) ${vscode.l10n.t('TTL {0}', formatRemaining(remainingMs))}${projectSuffix}`;

  return {
    text,
    tooltip: [
      ...tooltipLines,
      vscode.l10n.t('TTL: {0}', timeText),
      '',
      ...buildUsageLines(snapshot.lastCompletedTurn),
      ...buildHealthLines(snapshot),
      ...buildRhythmLines(snapshot),
      ...buildRateLimitTooltipLines(snapshot),
      ...(awaitingLine ? [awaitingLine] : []),
      ...(recommendationLine ? ['', recommendationLine] : []),
      vscode.l10n.t('Ask Claude: run /ttl-advisor in Claude Code for a personalized explanation.'),
    ].join('\n'),
    visualState,
    remainingRatio,
  };
}
