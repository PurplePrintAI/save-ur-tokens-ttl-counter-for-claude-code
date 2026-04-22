import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { RateLimitSummary, readRateLimitSummary } from './rate-limit-bridge';
import { SettingsManager, TtlMode, getTtlDurationMs } from './settings-manager';

interface ClaudeSessionFile {
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
}

interface ResolvedClaudeSession extends ClaudeSessionFile {
  transcriptPath?: string;
  transcriptLastWriteAt?: number;
  activityAt?: number;
}

interface TranscriptUsagePayload {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  output_tokens?: unknown;
}

interface TranscriptContentItem {
  type?: string;
  text?: string;
}

interface TranscriptLine {
  requestId?: string;
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: {
    id?: string;
    content?: TranscriptContentItem[];
    usage?: TranscriptUsagePayload;
    stop_reason?: string;
  };
}

interface AssistantTurnCandidate {
  requestId?: string;
  messageId?: string;
  tokenTuple: string;
  usage: TurnUsageSummary;
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

export type RollingState = 'countdown' | 'turn_usage' | 'rate_limit';

export interface TtlSnapshot {
  workspacePath?: string;
  mode: TtlMode;
  ttlMs: number;
  sessionId?: string;
  transcriptPath?: string;
  lastUserPromptAt?: number;
  lastCompletedTurn?: TurnUsageSummary;
  rateLimits?: RateLimitSummary;
  cacheHealth: CacheHealthSummary;
  sessionGracePending: boolean;
  logicalTurnsSinceSessionSwitch: number;
  recommendation?: ModeRecommendation;
  awaitingAssistantTurn: boolean;
  rollingState: RollingState;
  lastUpdatedAt: number;
  error?: string;
}

interface TranscriptSignals {
  lastUserPromptAt?: number;
  lastCompletedTurn?: TurnUsageSummary;
  cacheHealth: CacheHealthSummary;
  sessionGracePending: boolean;
  logicalTurnsSinceSessionSwitch: number;
  recommendation?: ModeRecommendation;
}

const MAX_RECENT_ASSISTANT_TURNS = 5;
const MAX_RECENT_USER_PROMPTS = 8;
const MIN_RECOMMENDATION_USER_PROMPTS_5M = 6;
const MIN_RECOMMENDATION_USER_PROMPTS_1H = 4;
const ASSISTANT_FALLBACK_DEDUPE_WINDOW_MS = 10 * 1000;
const INTERRUPT_PLACEHOLDER_TEXT = '[Request interrupted by user]';
const RECOMMEND_5M_MAX_MEDIAN_GAP_MS = 3 * 60 * 1000;
const RECOMMEND_5M_MAX_SINGLE_GAP_MS = 5 * 60 * 1000;
const RECOMMEND_1H_MIN_MEDIAN_GAP_MS = 5 * 60 * 1000;
const STRONG_RECOMMEND_1H_MIN_MEDIAN_GAP_MS = 10 * 60 * 1000;

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

async function getLastWriteTimeMs(targetPath: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(targetPath);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
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

function getTranscriptContentItems(line: TranscriptLine): TranscriptContentItem[] {
  return Array.isArray(line.message?.content)
    ? line.message.content
    : [];
}

function normalizePromptText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === INTERRUPT_PLACEHOLDER_TEXT) {
    return undefined;
  }

  return trimmed;
}

function isActualUserPrompt(line: TranscriptLine): line is TranscriptLine & { timestamp: string } {
  if (line.type !== 'user' || !line.timestamp || line.isMeta) {
    return false;
  }

  const contentItems = getTranscriptContentItems(line);
  if (contentItems.some((item) => item.type === 'tool_result')) {
    return false;
  }

  return contentItems.some((item) => item.type === 'text' && Boolean(normalizePromptText(item.text)));
}

function buildAssistantTokenTuple(usage: TurnUsageSummary): string {
  return [
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
    usage.outputTokens,
  ].join(':');
}

function isFallbackAssistantDuplicate(
  candidate: AssistantTurnCandidate,
  recentTurns: AssistantTurnCandidate[],
): boolean {
  if (candidate.usage.timestamp === undefined) {
    return false;
  }

  const candidateTimestamp = candidate.usage.timestamp;
  return recentTurns.some((existing) =>
    existing.usage.timestamp !== undefined
    && existing.tokenTuple === candidate.tokenTuple
    && Math.abs(existing.usage.timestamp - candidateTimestamp) <= ASSISTANT_FALLBACK_DEDUPE_WINDOW_MS,
  );
}

function isDuplicateAssistantTurn(
  candidate: AssistantTurnCandidate,
  recentTurns: AssistantTurnCandidate[],
  seenRequestIds: Set<string>,
  seenMessageIds: Set<string>,
): boolean {
  if (candidate.requestId && seenRequestIds.has(candidate.requestId)) {
    return true;
  }

  if (candidate.messageId && seenMessageIds.has(candidate.messageId)) {
    return true;
  }

  if (candidate.requestId || candidate.messageId) {
    return false;
  }

  return isFallbackAssistantDuplicate(candidate, recentTurns);
}

function calculateMedian(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const ascending = [...values].sort((a, b) => a - b);
  const middleIndex = Math.floor(ascending.length / 2);

  if (ascending.length % 2 === 1) {
    return ascending[middleIndex];
  }

  return (ascending[middleIndex - 1] + ascending[middleIndex]) / 2;
}

function buildRecommendation(
  userPromptTimestamps: number[],
  currentMode: TtlMode,
): ModeRecommendation | undefined {
  const ascending = [...userPromptTimestamps].sort((a, b) => a - b);
  const gaps: number[] = [];

  for (let index = 1; index < ascending.length; index += 1) {
    gaps.push(ascending[index] - ascending[index - 1]);
  }

  const medianGapMs = calculateMedian(gaps);
  if (medianGapMs === undefined) {
    return undefined;
  }

  if (medianGapMs < RECOMMEND_5M_MAX_MEDIAN_GAP_MS) {
    if (currentMode !== '1h' || userPromptTimestamps.length < MIN_RECOMMENDATION_USER_PROMPTS_5M) {
      return undefined;
    }

    const maxGap = Math.max(...gaps);
    if (maxGap >= RECOMMEND_5M_MAX_SINGLE_GAP_MS) {
      return undefined;
    }

    return {
      mode: '5m',
      reason: 'Tip: 5m mode may save tokens.',
    };
  }

  if (medianGapMs < RECOMMEND_1H_MIN_MEDIAN_GAP_MS) {
    return undefined;
  }

  if (currentMode !== '5m' || userPromptTimestamps.length < MIN_RECOMMENDATION_USER_PROMPTS_1H) {
    return undefined;
  }

  if (medianGapMs <= STRONG_RECOMMEND_1H_MIN_MEDIAN_GAP_MS) {
    return {
      mode: '1h',
      reason: 'Tip: 1h mode is safer.',
    };
  }

  return {
    mode: '1h',
    reason: 'Tip: strongly recommend 1h mode.',
  };
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
    sessionGracePending: false,
    logicalTurnsSinceSessionSwitch: 0,
    awaitingAssistantTurn: false,
    rollingState: 'countdown',
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
      rateLimits: this.snapshot.rateLimits
        ? { ...this.snapshot.rateLimits }
        : undefined,
      recommendation: this.snapshot.recommendation
        ? { ...this.snapshot.recommendation }
        : undefined,
    };
  }

  setRollingState(rollingState: RollingState): void {
    if (this.snapshot.rollingState === rollingState) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      rollingState,
      lastUpdatedAt: Date.now(),
    };
  }

  async refresh(): Promise<TtlSnapshot> {
    const mode = await this.settingsManager.getMode();
    const ttlMs = getTtlDurationMs(mode);

    try {
      const activeSession = await this.findActiveSessionForWorkspace(this.workspacePath);
      const transcriptPath = activeSession?.sessionId
        ? activeSession.transcriptPath ?? await this.findTranscriptPath(activeSession.sessionId, activeSession.cwd)
        : undefined;
      const transcriptSignals = transcriptPath
        ? await this.readTranscriptSignals(transcriptPath, mode)
        : undefined;
      const rateLimitBridgePath = await this.settingsManager.getRateLimitBridgePath();
      const rateLimits = await readRateLimitSummary(rateLimitBridgePath, activeSession?.sessionId);

      this.snapshot = {
        workspacePath: this.workspacePath,
        mode,
        ttlMs,
        sessionId: activeSession?.sessionId,
        transcriptPath,
        lastUserPromptAt: transcriptSignals?.lastUserPromptAt,
        lastCompletedTurn: transcriptSignals?.lastCompletedTurn,
        rateLimits,
        cacheHealth: transcriptSignals?.cacheHealth ?? {
          recentTurns: 0,
          recentColdStarts: 0,
          recentLowHitTurns: 0,
        },
        sessionGracePending: transcriptSignals?.sessionGracePending ?? false,
        logicalTurnsSinceSessionSwitch: transcriptSignals?.logicalTurnsSinceSessionSwitch ?? 0,
        recommendation: transcriptSignals?.recommendation,
        awaitingAssistantTurn:
          Boolean(
            transcriptSignals?.lastUserPromptAt
            && (
              !transcriptSignals.lastCompletedTurn?.timestamp
              || transcriptSignals.lastCompletedTurn.timestamp < transcriptSignals.lastUserPromptAt
            ),
          ),
        rollingState: this.snapshot.rollingState,
        lastUpdatedAt: Date.now(),
      };
    } catch (error) {
      this.snapshot = {
        workspacePath: this.workspacePath,
        mode,
        ttlMs,
        rateLimits: this.snapshot.rateLimits
          ? { ...this.snapshot.rateLimits }
          : undefined,
        cacheHealth: {
          recentTurns: 0,
          recentColdStarts: 0,
          recentLowHitTurns: 0,
        },
        sessionGracePending: false,
        logicalTurnsSinceSessionSwitch: 0,
        awaitingAssistantTurn: false,
        rollingState: this.snapshot.rollingState,
        lastUpdatedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return this.getSnapshot();
  }

  private async findActiveSessionForWorkspace(workspacePath?: string): Promise<ResolvedClaudeSession | undefined> {
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

    const matches: ResolvedClaudeSession[] = [];

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

        const transcriptPath = await this.findTranscriptPath(session.sessionId, session.cwd);
        const transcriptLastWriteAt = transcriptPath
          ? await getLastWriteTimeMs(transcriptPath)
          : undefined;
        const activityAt = Math.max(session.startedAt ?? 0, transcriptLastWriteAt ?? 0);

        matches.push({
          ...session,
          transcriptPath,
          transcriptLastWriteAt,
          activityAt,
        });
      } catch {
        continue;
      }
    }

    matches.sort((a, b) => {
      const aHasTranscript = a.transcriptPath ? 1 : 0;
      const bHasTranscript = b.transcriptPath ? 1 : 0;
      if (bHasTranscript !== aHasTranscript) return bHasTranscript - aHasTranscript;
      return (b.activityAt ?? 0) - (a.activityAt ?? 0)
        || (b.transcriptLastWriteAt ?? 0) - (a.transcriptLastWriteAt ?? 0)
        || (b.startedAt ?? 0) - (a.startedAt ?? 0);
    });
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

  private async readTranscriptSignals(jsonlPath: string, mode: TtlMode): Promise<TranscriptSignals> {
    const handle = await fs.open(jsonlPath, 'r');

    try {
      const stat = await handle.stat();
      const chunkSize = 64 * 1024;
      let position = stat.size;
      let remainder = '';

      let lastUserPromptAt: number | undefined;
      let lastCompletedTurn: TurnUsageSummary | undefined;
      const recentAssistantTurns: AssistantTurnCandidate[] = [];
      const recentUserPromptAts: number[] = [];
      const seenAssistantRequestIds = new Set<string>();
      const seenAssistantMessageIds = new Set<string>();

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
            && parsed.message.stop_reason !== 'tool_use'
            && recentAssistantTurns.length < MAX_RECENT_ASSISTANT_TURNS
          ) {
            const timestamp = parsed.timestamp ? Date.parse(parsed.timestamp) : undefined;
            const usage = buildUsageSummary(
              Number.isNaN(timestamp ?? Number.NaN) ? undefined : timestamp,
              parsed.message.usage,
            );

            const candidate: AssistantTurnCandidate = {
              requestId: parsed.requestId,
              messageId: parsed.message.id,
              tokenTuple: buildAssistantTokenTuple(usage),
              usage,
            };

            if (!isDuplicateAssistantTurn(
              candidate,
              recentAssistantTurns,
              seenAssistantRequestIds,
              seenAssistantMessageIds,
            )) {
              recentAssistantTurns.push(candidate);
              if (candidate.requestId) {
                seenAssistantRequestIds.add(candidate.requestId);
              }

              if (candidate.messageId) {
                seenAssistantMessageIds.add(candidate.messageId);
              }

              if (!lastCompletedTurn) {
                lastCompletedTurn = usage;
              }
            }
          }

          if (isActualUserPrompt(parsed)) {
            const timestamp = Date.parse(parsed.timestamp);
            if (!Number.isNaN(timestamp)) {
              if (!lastUserPromptAt) {
                lastUserPromptAt = timestamp;
              }

              if (recentUserPromptAts.length < MAX_RECENT_USER_PROMPTS) {
                recentUserPromptAts.push(timestamp);
              }
            }
          }

          if (
            lastUserPromptAt
            && recentAssistantTurns.length >= MAX_RECENT_ASSISTANT_TURNS
            && recentUserPromptAts.length >= MAX_RECENT_USER_PROMPTS
          ) {
            break;
          }
        }

        if (
          lastUserPromptAt
          && recentAssistantTurns.length >= MAX_RECENT_ASSISTANT_TURNS
          && recentUserPromptAts.length >= MAX_RECENT_USER_PROMPTS
        ) {
          break;
        }
      }

      if (remainder) {
        const parsed = this.parseTranscriptLine(remainder);
        if (parsed && isActualUserPrompt(parsed) && !lastUserPromptAt) {
          const timestamp = Date.parse(parsed.timestamp);
          if (!Number.isNaN(timestamp)) {
            lastUserPromptAt = timestamp;
          }
        }
      }

      const recentAssistantUsages = recentAssistantTurns.map((turn) => turn.usage);
      const logicalTurnsSinceSessionSwitch = recentAssistantUsages.length;
      const cacheHealth: CacheHealthSummary = {
        recentTurns: logicalTurnsSinceSessionSwitch,
        recentColdStarts: recentAssistantUsages.filter((usage) => usage.cacheReadTokens === 0 && usage.cacheCreationTokens > 0).length,
        recentLowHitTurns: recentAssistantUsages.filter((usage) => usage.cacheHitRatio !== undefined && usage.cacheHitRatio < 0.2).length,
      };

      return {
        lastUserPromptAt,
        lastCompletedTurn,
        cacheHealth,
        sessionGracePending: logicalTurnsSinceSessionSwitch < 2,
        logicalTurnsSinceSessionSwitch,
        recommendation: buildRecommendation(recentUserPromptAts, mode),
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
