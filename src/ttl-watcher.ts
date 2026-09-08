import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  RateLimitSource,
  RateLimitSummary,
  pickFreshestRateLimits,
  readRateLimitSummary,
  subscriptionUsageToSummary,
} from './rate-limit-bridge';
import {
  ModeRecommendation,
  RECOMMENDATION_WINDOW_TURNS,
  RhythmSummary,
  buildRecommendation,
  summarizeRhythm,
} from './recommendation';
import { SettingsManager, TtlMode, getTtlDurationMs } from './settings-manager';
import { SubscriptionUsageClient, SubscriptionUsageState } from './subscription-usage';
import { ApiCall, QuotaRejection, TranscriptState, TranscriptTracker } from './transcript-tracker';

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
  /** Cold starts excluding the expected one at session start. */
  recentColdStarts: number;
  recentTtlExpiryColdStarts: number;
  recentOtherColdStarts: number;
  recentLowHitTurns: number;
}

export type { ModeRecommendation, RhythmSummary } from './recommendation';
export type { QuotaRejection } from './transcript-tracker';
export type { SubscriptionUsageState } from './subscription-usage';

export type RollingState = 'countdown' | 'turn_usage' | 'rate_limit';

export interface RateLimitDelta {
  fiveHourDelta?: number;
  sevenDayDelta?: number;
}

interface RateLimitBaseline {
  source: RateLimitSource;
  fiveHour?: number;
  sevenDay?: number;
  turnAt?: number;
}

export interface TtlSnapshot {
  workspacePath?: string;
  /** Effective tier used for the countdown: observed from the transcript when available. */
  mode: TtlMode;
  /** Tier configured in ~/.claude/settings.json. */
  configuredMode: TtlMode;
  /** Tier actually used by the most recent cache write in the transcript. */
  observedTier?: TtlMode;
  ttlMs: number;
  sessionId?: string;
  transcriptPath?: string;
  lastUserPromptAt?: number;
  /** Start of the most recent API request; the cache TTL counts from here. */
  cacheAnchorAt?: number;
  lastCompletedTurn?: TurnUsageSummary;
  rateLimits?: RateLimitSummary;
  rateLimitDelta?: RateLimitDelta;
  /** Live subscription usage connection state (undefined when the feature is not wired). */
  subscription?: SubscriptionUsageState;
  /** Most recent "You've hit your limit" refusal seen in the transcript. */
  quotaRejection?: QuotaRejection;
  cacheHealth: CacheHealthSummary;
  rhythm?: RhythmSummary;
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
  cacheAnchorAt?: number;
  lastCompletedTurn?: TurnUsageSummary;
  observedTier?: TtlMode;
  cacheHealth: CacheHealthSummary;
  rhythm: RhythmSummary;
  sessionGracePending: boolean;
  logicalTurnsSinceSessionSwitch: number;
  recommendation?: ModeRecommendation;
  quotaRejection?: QuotaRejection;
}

const MAX_RECENT_TURNS_FOR_HEALTH = 5;
const MAX_TRACKERS = 4;

const EMPTY_HEALTH: CacheHealthSummary = {
  recentTurns: 0,
  recentColdStarts: 0,
  recentTtlExpiryColdStarts: 0,
  recentOtherColdStarts: 0,
  recentLowHitTurns: 0,
};

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

function toUsageSummary(call: ApiCall): TurnUsageSummary {
  const effectiveInputTokens = call.inputTokens + call.cacheCreationTokens;
  return {
    timestamp: call.responseAt,
    inputTokens: call.inputTokens,
    cacheReadTokens: call.cacheReadTokens,
    cacheCreationTokens: call.cacheCreationTokens,
    outputTokens: call.outputTokens,
    grossInputTokens: call.grossInputTokens,
    effectiveInputTokens,
    cacheHitRatio: call.grossInputTokens > 0 ? call.cacheReadTokens / call.grossInputTokens : undefined,
  };
}

function buildSignals(state: TranscriptState, configuredMode: TtlMode): TranscriptSignals {
  const realTurns = state.turns.filter((turn) => !turn.synthetic && turn.callCount > 0);
  const recent = realTurns.slice(-MAX_RECENT_TURNS_FOR_HEALTH);
  const recentTtlExpiryColdStarts = recent.filter((turn) => turn.coldStartKind === 'ttl_expiry').length;
  const recentOtherColdStarts = recent.filter((turn) => turn.coldStartKind === 'other').length;
  const recentLowHitTurns = recent.filter((turn) => {
    if (turn.coldStartKind === 'session_start' || !turn.openingCall) {
      return false;
    }

    const gross = turn.openingCall.grossInputTokens;
    return gross > 0 && turn.openingCall.cacheReadTokens / gross < 0.2;
  }).length;

  const effectiveTier = state.observedTier ?? configuredMode;

  return {
    lastUserPromptAt: state.lastUserPromptAt,
    cacheAnchorAt: state.lastRequestAt,
    lastCompletedTurn: state.lastCompletedCall ? toUsageSummary(state.lastCompletedCall) : undefined,
    observedTier: state.observedTier,
    cacheHealth: {
      recentTurns: recent.length,
      recentColdStarts: recentTtlExpiryColdStarts + recentOtherColdStarts,
      recentTtlExpiryColdStarts,
      recentOtherColdStarts,
      recentLowHitTurns,
    },
    rhythm: summarizeRhythm(realTurns.slice(-RECOMMENDATION_WINDOW_TURNS)),
    sessionGracePending: realTurns.length < 2,
    logicalTurnsSinceSessionSwitch: realTurns.length,
    recommendation: buildRecommendation(state.turns, state.calls, effectiveTier),
    quotaRejection: state.lastQuotaRejection,
  };
}

function percentDelta(current?: number, baseline?: number): number | undefined {
  return current !== undefined && baseline !== undefined ? current - baseline : undefined;
}

export class TtlWatcher {
  private readonly settingsManager: SettingsManager;
  private readonly sessionsDir: string;
  private readonly projectsDir: string;
  private readonly pollIntervalMs: number;
  private readonly transcriptPathCache = new Map<string, string>();
  private readonly trackers = new Map<string, TranscriptTracker>();
  private readonly subscriptionUsage?: SubscriptionUsageClient;
  private workspacePath?: string;
  private intervalHandle?: NodeJS.Timeout;
  private lastSeenCompletedTurnAt?: number;
  private rateLimitBaseline?: RateLimitBaseline;
  private lastRateLimitDelta?: RateLimitDelta;
  private snapshot: TtlSnapshot = {
    mode: '5m',
    configuredMode: '5m',
    ttlMs: getTtlDurationMs('5m'),
    cacheHealth: { ...EMPTY_HEALTH },
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
    subscriptionUsage?: SubscriptionUsageClient;
  }) {
    this.settingsManager = options.settingsManager;
    this.workspacePath = options.workspacePath;
    this.subscriptionUsage = options.subscriptionUsage;
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

    this.subscriptionUsage?.dispose();
  }

  setWorkspacePath(workspacePath?: string): void {
    this.workspacePath = workspacePath;
  }

  getSnapshot(): TtlSnapshot {
    return {
      ...this.snapshot,
      cacheHealth: { ...this.snapshot.cacheHealth },
      rhythm: this.snapshot.rhythm ? { ...this.snapshot.rhythm } : undefined,
      lastCompletedTurn: this.snapshot.lastCompletedTurn
        ? { ...this.snapshot.lastCompletedTurn }
        : undefined,
      rateLimits: this.snapshot.rateLimits
        ? { ...this.snapshot.rateLimits, scoped: this.snapshot.rateLimits.scoped?.map((limit) => ({ ...limit })) }
        : undefined,
      subscription: this.snapshot.subscription
        ? { ...this.snapshot.subscription }
        : undefined,
      quotaRejection: this.snapshot.quotaRejection
        ? { ...this.snapshot.quotaRejection }
        : undefined,
      recommendation: this.snapshot.recommendation
        ? { ...this.snapshot.recommendation }
        : undefined,
    };
  }

  /** Forces a subscription usage fetch (used by the "refresh usage" command). */
  async refreshSubscriptionUsage(): Promise<void> {
    await this.subscriptionUsage?.refresh(true);
    await this.refresh();
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
    const configuredMode = await this.settingsManager.getMode();

    try {
      const activeSession = await this.findActiveSessionForWorkspace(this.workspacePath);
      const transcriptPath = activeSession?.sessionId
        ? activeSession.transcriptPath ?? await this.findTranscriptPath(activeSession.sessionId, activeSession.cwd)
        : undefined;
      const transcriptSignals = transcriptPath
        ? await this.readTranscriptSignals(transcriptPath, configuredMode)
        : undefined;
      const completedTurnAt = transcriptSignals?.lastCompletedTurn?.timestamp;
      if (completedTurnAt !== undefined && completedTurnAt !== this.lastSeenCompletedTurnAt) {
        this.lastSeenCompletedTurnAt = completedTurnAt;
        this.subscriptionUsage?.requestAfterTurn();
      }

      if (activeSession?.sessionId && this.subscriptionUsage) {
        await this.subscriptionUsage.maybePoll();
        await this.subscriptionUsage.waitForInFlight(1500);
      }

      const subscription = this.subscriptionUsage?.getState();
      const subscriptionSummary = subscription?.enabled && subscription.latest
        ? subscriptionUsageToSummary(subscription.latest, subscription.subscriptionType)
        : undefined;
      const rateLimitBridgePath = await this.settingsManager.getRateLimitBridgePath();
      const statuslineSummary = await readRateLimitSummary(rateLimitBridgePath, activeSession?.sessionId);
      const rateLimits = pickFreshestRateLimits(subscriptionSummary, statuslineSummary);
      const rateLimitDelta = this.computeRateLimitDelta(rateLimits, completedTurnAt);

      const mode = transcriptSignals?.observedTier ?? configuredMode;

      this.snapshot = {
        workspacePath: this.workspacePath,
        mode,
        configuredMode,
        observedTier: transcriptSignals?.observedTier,
        ttlMs: getTtlDurationMs(mode),
        sessionId: activeSession?.sessionId,
        transcriptPath,
        lastUserPromptAt: transcriptSignals?.lastUserPromptAt,
        cacheAnchorAt: transcriptSignals?.cacheAnchorAt,
        lastCompletedTurn: transcriptSignals?.lastCompletedTurn,
        rateLimits,
        rateLimitDelta,
        subscription,
        quotaRejection: transcriptSignals?.quotaRejection,
        cacheHealth: transcriptSignals?.cacheHealth ?? { ...EMPTY_HEALTH },
        rhythm: transcriptSignals?.rhythm,
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
        mode: configuredMode,
        configuredMode,
        ttlMs: getTtlDurationMs(configuredMode),
        rateLimits: this.snapshot.rateLimits
          ? { ...this.snapshot.rateLimits }
          : undefined,
        subscription: this.subscriptionUsage?.getState(),
        cacheHealth: { ...EMPTY_HEALTH },
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

  /**
   * Per-turn usage delta: the difference between the first sample taken after a completed turn
   * and the sample recorded for the previous turn. Samples that predate the turn are ignored so
   * the delta describes that turn rather than the polling cadence.
   */
  private computeRateLimitDelta(
    summary: RateLimitSummary | undefined,
    completedTurnAt: number | undefined,
  ): RateLimitDelta | undefined {
    if (!summary) {
      return undefined;
    }

    const baseline = this.rateLimitBaseline;
    if (!baseline || baseline.source !== summary.source) {
      this.rateLimitBaseline = {
        source: summary.source,
        fiveHour: summary.fiveHourUsedPercentage,
        sevenDay: summary.sevenDayUsedPercentage,
        turnAt: completedTurnAt,
      };
      this.lastRateLimitDelta = undefined;
      return undefined;
    }

    if (completedTurnAt === undefined || completedTurnAt === baseline.turnAt) {
      return this.lastRateLimitDelta;
    }

    if (summary.updatedAt === undefined || summary.updatedAt < completedTurnAt) {
      // No sample taken since the turn finished yet: show no delta rather than a stale one.
      return undefined;
    }

    this.lastRateLimitDelta = {
      fiveHourDelta: percentDelta(summary.fiveHourUsedPercentage, baseline.fiveHour),
      sevenDayDelta: percentDelta(summary.sevenDayUsedPercentage, baseline.sevenDay),
    };
    this.rateLimitBaseline = {
      source: summary.source,
      fiveHour: summary.fiveHourUsedPercentage,
      sevenDay: summary.sevenDayUsedPercentage,
      turnAt: completedTurnAt,
    };

    return this.lastRateLimitDelta;
  }

  private getTracker(transcriptPath: string): TranscriptTracker {
    const existing = this.trackers.get(transcriptPath);
    if (existing) {
      // Move to the end so the least recently used tracker is evicted first.
      this.trackers.delete(transcriptPath);
      this.trackers.set(transcriptPath, existing);
      return existing;
    }

    const tracker = new TranscriptTracker(transcriptPath);
    this.trackers.set(transcriptPath, tracker);

    while (this.trackers.size > MAX_TRACKERS) {
      const oldestKey = this.trackers.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }

      this.trackers.delete(oldestKey);
    }

    return tracker;
  }

  private async readTranscriptSignals(transcriptPath: string, configuredMode: TtlMode): Promise<TranscriptSignals> {
    const tracker = this.getTracker(transcriptPath);
    await tracker.refresh();
    return buildSignals(tracker.getState(), configuredMode);
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

    const matchesBySessionId = new Map<string, ResolvedClaudeSession>();

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

        matchesBySessionId.set(session.sessionId, {
          ...session,
          transcriptPath,
          transcriptLastWriteAt,
          activityAt,
        });
      } catch {
        continue;
      }
    }

    const workspaceTranscripts = await this.findWorkspaceTranscriptCandidates(workspacePath);
    for (const transcriptCandidate of workspaceTranscripts) {
      const existing = transcriptCandidate.sessionId
        ? matchesBySessionId.get(transcriptCandidate.sessionId)
        : undefined;

      if (!transcriptCandidate.sessionId) {
        continue;
      }

      matchesBySessionId.set(transcriptCandidate.sessionId, {
        ...existing,
        ...transcriptCandidate,
        cwd: existing?.cwd ?? transcriptCandidate.cwd,
        startedAt: existing?.startedAt,
        activityAt: Math.max(
          existing?.startedAt ?? 0,
          transcriptCandidate.transcriptLastWriteAt ?? 0,
          existing?.transcriptLastWriteAt ?? 0,
        ),
      });
    }

    const matches = Array.from(matchesBySessionId.values());
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

  private async findWorkspaceTranscriptCandidates(workspacePath: string): Promise<ResolvedClaudeSession[]> {
    const projectDir = path.join(this.projectsDir, workspaceSlug(workspacePath));

    let entries;
    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return [];
      }

      throw error;
    }

    const candidates: ResolvedClaudeSession[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      const transcriptPath = path.join(projectDir, entry.name);
      const transcriptLastWriteAt = await getLastWriteTimeMs(transcriptPath);
      if (transcriptLastWriteAt === undefined) {
        continue;
      }

      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      this.transcriptPathCache.set(sessionId, transcriptPath);

      candidates.push({
        sessionId,
        cwd: workspacePath,
        transcriptPath,
        transcriptLastWriteAt,
        activityAt: transcriptLastWriteAt,
      });
    }

    return candidates;
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
}
