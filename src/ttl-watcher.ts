import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { SettingsManager, TtlMode, getTtlDurationMs } from './settings-manager';

interface ClaudeSessionFile {
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
}

interface TranscriptUsagePayload {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  output_tokens?: unknown;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: {
    usage?: TranscriptUsagePayload;
  };
}

export interface TurnUsageSummary {
  timestamp?: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  grossInputTokens: number;
  effectiveInputTokens: number;
  cacheHitRatio?: number;
}

export interface CacheHealthSummary {
  recentTurns: number;
  recentColdStarts: number;
  recentLowHitTurns: number;
}

export interface ModeRecommendation {
  mode: TtlMode;
  reason: string;
}

export interface TtlSnapshot {
  workspacePath?: string;
  mode: TtlMode;
  ttlMs: number;
  sessionId?: string;
  transcriptPath?: string;
  lastUserPromptAt?: number;
  lastCompletedTurn?: TurnUsageSummary;
  cacheHealth: CacheHealthSummary;
  recommendation?: ModeRecommendation;
  awaitingAssistantTurn: boolean;
  lastUpdatedAt: number;
  error?: string;
}

interface TranscriptSignals {
  lastUserPromptAt?: number;
  lastCompletedTurn?: TurnUsageSummary;
  cacheHealth: CacheHealthSummary;
  recommendation?: ModeRecommendation;
}

function normalizePath(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  return path.resolve(input).replace(/[\\/]+/g, '/').toLowerCase();
}

function workspaceSlug(workspacePath: string): string {
  return path.resolve(workspacePath).replace(/[:\\/]/g, '-').toLowerCase();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildUsageSummary(timestamp: number | undefined, usage: TranscriptUsagePayload): TurnUsageSummary {
  const inputTokens = toNumber(usage.input_tokens);
  const cacheReadTokens = toNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = toNumber(usage.cache_creation_input_tokens);
  const outputTokens = toNumber(usage.output_tokens);
  const grossInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const effectiveInputTokens = inputTokens + cacheCreationTokens;
  const cacheHitRatio = grossInputTokens > 0 ? cacheReadTokens / grossInputTokens : undefined;

  return {
    timestamp,
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    grossInputTokens,
    effectiveInputTokens,
    cacheHitRatio,
  };
}

function buildRecommendation(userPromptTimestamps: number[]): ModeRecommendation | undefined {
  if (userPromptTimestamps.length < 2) {
    return undefined;
  }

  const ascending = [...userPromptTimestamps].sort((a, b) => a - b);
  const gaps: number[] = [];

  for (let index = 1; index < ascending.length; index += 1) {
    gaps.push(ascending[index] - ascending[index - 1]);
  }

  if (gaps.length === 0) {
    return undefined;
  }

  const averageGapMs = gaps.reduce((total, gap) => total + gap, 0) / gaps.length;

  if (averageGapMs >= 10 * 60 * 1000) {
    return {
      mode: '1h',
      reason: 'Recent turn gaps are long enough that 1h mode is likely safer.',
    };
  }

  if (averageGapMs <= 2 * 60 * 1000) {
    return {
      mode: '5m',
      reason: 'Recent turn gaps are short, so 5m mode is likely more efficient.',
    };
  }

  return undefined;
}

export class TtlWatcher {
  private readonly settingsManager: SettingsManager;
  private readonly sessionsDir: string;
  private readonly projectsDir: string;
  private readonly pollIntervalMs: number;
  private readonly transcriptPathCache = new Map<string, string>();
  private workspacePath?: string;
  private intervalHandle?: NodeJS.Timeout;
  private snapshot: TtlSnapshot = {
    mode: '5m',
    ttlMs: getTtlDurationMs('5m'),
    cacheHealth: {
      recentTurns: 0,
      recentColdStarts: 0,
      recentLowHitTurns: 0,
    },
    awaitingAssistantTurn: false,
    lastUpdatedAt: Date.now(),
  };

  constructor(options: {
    settingsManager: SettingsManager;
    workspacePath?: string;
    pollIntervalMs?: number;
  }) {
    this.settingsManager = options.settingsManager;
    this.workspacePath = options.workspacePath;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  async start(): Promise<void> {
    await this.refresh();
    this.intervalHandle = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
  }

  dispose(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  setWorkspacePath(workspacePath?: string): void {
    this.workspacePath = workspacePath;
  }

  getSnapshot(): TtlSnapshot {
    return {
      ...this.snapshot,
      cacheHealth: { ...this.snapshot.cacheHealth },
      lastCompletedTurn: this.snapshot.lastCompletedTurn
        ? { ...this.snapshot.lastCompletedTurn }
        : undefined,
      recommendation: this.snapshot.recommendation
        ? { ...this.snapshot.recommendation }
        : undefined,
    };
  }

  async refresh(): Promise<TtlSnapshot> {
    const mode = await this.settingsManager.getMode();
    const ttlMs = getTtlDurationMs(mode);

    try {
      const activeSession = await this.findActiveSessionForWorkspace(this.workspacePath);
      const transcriptPath = activeSession?.sessionId
        ? await this.findTranscriptPath(activeSession.sessionId, activeSession.cwd)
        : undefined;
      const transcriptSignals = transcriptPath
        ? await this.readTranscriptSignals(transcriptPath)
        : undefined;

      this.snapshot = {
        workspacePath: this.workspacePath,
        mode,
        ttlMs,
        sessionId: activeSession?.sessionId,
        transcriptPath,
        lastUserPromptAt: transcriptSignals?.lastUserPromptAt,
        lastCompletedTurn: transcriptSignals?.lastCompletedTurn,
        cacheHealth: transcriptSignals?.cacheHealth ?? {
          recentTurns: 0,
          recentColdStarts: 0,
          recentLowHitTurns: 0,
        },
        recommendation: transcriptSignals?.recommendation,
        awaitingAssistantTurn:
          Boolean(
            transcriptSignals?.lastUserPromptAt
            && (
              !transcriptSignals.lastCompletedTurn?.timestamp
              || transcriptSignals.lastCompletedTurn.timestamp < transcriptSignals.lastUserPromptAt
            ),
          ),
        lastUpdatedAt: Date.now(),
      };
    } catch (error) {
      this.snapshot = {
        workspacePath: this.workspacePath,
        mode,
        ttlMs,
        cacheHealth: {
          recentTurns: 0,
          recentColdStarts: 0,
          recentLowHitTurns: 0,
        },
        awaitingAssistantTurn: false,
        lastUpdatedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return this.getSnapshot();
  }

  private async findActiveSessionForWorkspace(workspacePath?: string): Promise<ClaudeSessionFile | undefined> {
    if (!workspacePath) {
      return undefined;
    }

    const normalizedWorkspace = normalizePath(workspacePath);
    if (!normalizedWorkspace) {
      return undefined;
    }

    let entries;
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }

    const matches: ClaudeSessionFile[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const fullPath = path.join(this.sessionsDir, entry.name);

      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const session = JSON.parse(raw) as ClaudeSessionFile;

        if (!session.sessionId || !session.cwd) {
          continue;
        }

        if (normalizePath(session.cwd) !== normalizedWorkspace) {
          continue;
        }

        matches.push(session);
      } catch {
        continue;
      }
    }

    matches.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return matches[0];
  }

  private async findTranscriptPath(sessionId: string, sessionCwd?: string): Promise<string | undefined> {
    const cached = this.transcriptPathCache.get(sessionId);
    if (cached && await pathExists(cached)) {
      return cached;
    }

    if (sessionCwd) {
      const candidate = path.join(this.projectsDir, workspaceSlug(sessionCwd), `${sessionId}.jsonl`);
      if (await pathExists(candidate)) {
        this.transcriptPathCache.set(sessionId, candidate);
        return candidate;
      }
    }

    const found = await this.findFileRecursive(this.projectsDir, `${sessionId}.jsonl`);
    if (found) {
      this.transcriptPathCache.set(sessionId, found);
    }

    return found;
  }

  private async findFileRecursive(rootDir: string, targetName: string): Promise<string | undefined> {
    let entries;

    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);

      if (entry.isFile() && entry.name === targetName) {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const found = await this.findFileRecursive(fullPath, targetName);
        if (found) {
          return found;
        }
      }
    }

    return undefined;
  }

  private async readTranscriptSignals(jsonlPath: string): Promise<TranscriptSignals> {
    const handle = await fs.open(jsonlPath, 'r');

    try {
      const stat = await handle.stat();
      const chunkSize = 64 * 1024;
      let position = stat.size;
      let remainder = '';

      let lastUserPromptAt: number | undefined;
      let lastCompletedTurn: TurnUsageSummary | undefined;
      const recentAssistantUsages: TurnUsageSummary[] = [];
      const recentUserPromptAts: number[] = [];

      while (position > 0) {
        const readSize = Math.min(chunkSize, position);
        position -= readSize;

        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await handle.read(buffer, 0, readSize, position);
        const text = `${buffer.toString('utf8', 0, bytesRead)}${remainder}`;
        const lines = text.split(/\r?\n/);

        if (position > 0) {
          remainder = lines.shift() ?? '';
        } else {
          remainder = '';
        }

        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const parsed = this.parseTranscriptLine(lines[index]);
          if (!parsed) {
            continue;
          }

          if (
            parsed.type === 'assistant'
            && parsed.message?.usage
            && recentAssistantUsages.length < 5
          ) {
            const timestamp = parsed.timestamp ? Date.parse(parsed.timestamp) : undefined;
            const usage = buildUsageSummary(
              Number.isNaN(timestamp ?? Number.NaN) ? undefined : timestamp,
              parsed.message.usage,
            );
            recentAssistantUsages.push(usage);
            if (!lastCompletedTurn) {
              lastCompletedTurn = usage;
            }
          }

          if (parsed.type === 'user' && parsed.timestamp) {
            const timestamp = Date.parse(parsed.timestamp);
            if (!Number.isNaN(timestamp)) {
              if (!lastUserPromptAt) {
                lastUserPromptAt = timestamp;
              }

              if (recentUserPromptAts.length < 5) {
                recentUserPromptAts.push(timestamp);
              }
            }
          }

          if (lastUserPromptAt && recentAssistantUsages.length >= 5 && recentUserPromptAts.length >= 5) {
            break;
          }
        }

        if (lastUserPromptAt && recentAssistantUsages.length >= 5 && recentUserPromptAts.length >= 5) {
          break;
        }
      }

      if (remainder) {
        const parsed = this.parseTranscriptLine(remainder);
        if (parsed?.type === 'user' && parsed.timestamp && !lastUserPromptAt) {
          const timestamp = Date.parse(parsed.timestamp);
          if (!Number.isNaN(timestamp)) {
            lastUserPromptAt = timestamp;
          }
        }
      }

      const cacheHealth: CacheHealthSummary = {
        recentTurns: recentAssistantUsages.length,
        recentColdStarts: recentAssistantUsages.filter((usage) => usage.cacheReadTokens === 0 && usage.cacheCreationTokens > 0).length,
        recentLowHitTurns: recentAssistantUsages.filter((usage) => usage.cacheHitRatio !== undefined && usage.cacheHitRatio < 0.2).length,
      };

      return {
        lastUserPromptAt,
        lastCompletedTurn,
        cacheHealth,
        recommendation: buildRecommendation(recentUserPromptAts),
      };
    } finally {
      await handle.close();
    }
  }

  private parseTranscriptLine(line: string): TranscriptLine | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      return JSON.parse(trimmed) as TranscriptLine;
    } catch {
      return undefined;
    }
  }
}
