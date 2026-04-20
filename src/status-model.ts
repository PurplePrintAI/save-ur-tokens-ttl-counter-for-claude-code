import * as path from 'node:path';

import { getModeLabel } from './settings-manager';
import { TtlSnapshot } from './ttl-watcher';

export interface StatusPresentation {
  text: string;
  tooltip: string;
  warning: boolean;
  expired: boolean;
  remainingRatio?: number;
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function projectName(workspacePath?: string): string {
  if (!workspacePath) return '';
  return path.basename(workspacePath);
}

function shortSessionId(sessionId?: string): string {
  if (!sessionId) return 'none';
  return sessionId.slice(0, 8);
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

  if (!snapshot.lastUserPromptAt) {
    return {
      text: `$(clock) TTL --:--${projectSuffix}`,
      tooltip: `Claude TTL Counter\n\n${modeLabel}\n${project || 'workspace 없음'} · ${session}\n세션 대기 중`,
      warning: false,
      expired: false,
    };
  }

  const remainingMs = snapshot.ttlMs - (now - snapshot.lastUserPromptAt);
  const expired = remainingMs <= 0;
  const warning = !expired && remainingMs <= 5 * 60 * 1000;
  const timeText = expired ? '만료' : formatRemaining(remainingMs);

  const remainingRatio = expired ? 0 : remainingMs / snapshot.ttlMs;

  return {
    text: expired
      ? `$(warning) TTL expired${projectSuffix}`
      : `$(clock) TTL ${formatRemaining(remainingMs)}${projectSuffix}`,
    tooltip: [
      'Claude TTL Counter',
      '',
      `${modeLabel} · ${timeText}`,
      `${project || 'workspace 없음'} · ${session}`,
    ].join('\n'),
    warning,
    expired,
    remainingRatio,
  };
}
