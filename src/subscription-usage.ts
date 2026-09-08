import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Real subscription usage (5-hour / 7-day / model-scoped weekly limits) for Claude Pro / Max users.
 *
 * Claude Code keeps the user's OAuth login in `~/.claude/.credentials.json` (macOS: the login
 * Keychain). With that token, `GET https://api.anthropic.com/api/oauth/usage` returns the same
 * utilization numbers the CLI shows in `/usage`. This module reads the token, calls the endpoint,
 * and caches the result. It never refreshes or writes tokens, never logs them, and sends nothing
 * except the bearer header to api.anthropic.com. The extension only turns it on when the user
 * opts in.
 *
 * This module is intentionally free of `vscode` imports so it can be exercised with plain node.
 */

export interface SubscriptionCredentials {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export type CredentialSource = 'file' | 'keychain';

export interface CredentialLookup {
  credentials?: SubscriptionCredentials;
  source?: CredentialSource;
  error?: string;
}

export interface UsageWindow {
  percent: number;
  resetsAt?: number;
}

export interface ScopedUsageLimit {
  label: string;
  percent: number;
  resetsAt?: number;
  isActive: boolean;
}

export interface SubscriptionUsage {
  fetchedAt: number;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  scoped: ScopedUsageLimit[];
  extraUsageEnabled?: boolean;
}

export type UsageFetchStatus =
  | 'ok'
  | 'disabled'
  | 'no_credentials'
  | 'token_expired'
  | 'unauthorized'
  | 'rate_limited'
  | 'network_error'
  | 'bad_response';

export interface UsageFetchResult {
  status: UsageFetchStatus;
  usage?: SubscriptionUsage;
  error?: string;
  httpStatus?: number;
  retryAfterMs?: number;
}

export interface SubscriptionUsageState {
  enabled: boolean;
  status: UsageFetchStatus;
  latest?: SubscriptionUsage;
  error?: string;
  lastAttemptAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
  credentialSource?: CredentialSource;
}

export const USAGE_ENDPOINT_HOST = 'api.anthropic.com';
export const USAGE_ENDPOINT_PATH = '/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE_NAME = 'Claude Code-credentials';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const MIN_FORCED_SPACING_MS = 5 * 1000;
const AFTER_TURN_DELAY_MS = 1500;
const BACKOFF_MS: Partial<Record<UsageFetchStatus, number>> = {
  token_expired: 60 * 1000,
  no_credentials: 5 * 60 * 1000,
  unauthorized: 10 * 60 * 1000,
  rate_limited: 5 * 60 * 1000,
  network_error: 60 * 1000,
  bad_response: 60 * 1000,
};

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Anthropic sends unix seconds in some payloads and milliseconds in others.
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function parseCredentialsJson(raw: string): SubscriptionCredentials | undefined {
  let parsed: { claudeAiOauth?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
  } catch {
    return undefined;
  }

  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return undefined;
  }

  return {
    accessToken: oauth.accessToken,
    expiresAt: toFiniteNumber(oauth.expiresAt),
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined,
  };
}

function execFileText(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(String(stdout));
    });
  });
}

/** Reads the Claude Code login from disk (or the macOS Keychain). Tokens are never logged. */
export async function loadCredentials(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<CredentialLookup> {
  const filePath = path.join(homeDir, '.claude', '.credentials.json');

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const credentials = parseCredentialsJson(raw);
    if (credentials) {
      return { credentials, source: 'file' };
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      return { error: nodeError.message };
    }
  }

  if (platform === 'darwin') {
    try {
      const raw = await execFileText('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE_NAME, '-w'], 5000);
      const credentials = parseCredentialsJson(raw.trim());
      if (credentials) {
        return { credentials, source: 'keychain' };
      }
    } catch {
      // Keychain entry missing or access denied: fall through to "no credentials".
    }
  }

  return { error: 'no_credentials' };
}

interface RawLimit {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  is_active?: unknown;
  scope?: {
    model?: { id?: unknown; display_name?: unknown };
    surface?: unknown;
  } | null;
}

interface RawUsagePayload {
  five_hour?: { utilization?: unknown; resets_at?: unknown } | null;
  seven_day?: { utilization?: unknown; resets_at?: unknown } | null;
  limits?: RawLimit[];
  extra_usage?: { is_enabled?: unknown } | null;
}

function scopeLabel(limit: RawLimit): string | undefined {
  const model = limit.scope?.model;
  if (model && typeof model.display_name === 'string' && model.display_name) {
    return model.display_name;
  }

  if (model && typeof model.id === 'string' && model.id) {
    return model.id;
  }

  const surface = limit.scope?.surface;
  return typeof surface === 'string' && surface ? surface : undefined;
}

/** Turns the raw endpoint payload into the compact structure the extension uses. */
export function parseUsagePayload(raw: unknown, fetchedAt: number): SubscriptionUsage | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const payload = raw as RawUsagePayload;
  const usage: SubscriptionUsage = { fetchedAt, scoped: [] };

  if (Array.isArray(payload.limits)) {
    for (const limit of payload.limits) {
      const percent = toFiniteNumber(limit?.percent);
      if (percent === undefined) {
        continue;
      }

      const window: UsageWindow = { percent, resetsAt: toTimestamp(limit.resets_at) };
      if (limit.kind === 'session') {
        usage.fiveHour = window;
      } else if (limit.kind === 'weekly_all') {
        usage.sevenDay = window;
      } else if (limit.kind === 'weekly_scoped') {
        usage.scoped.push({
          label: scopeLabel(limit) ?? 'scoped',
          percent,
          resetsAt: window.resetsAt,
          isActive: limit.is_active === true,
        });
      }
    }
  }

  if (!usage.fiveHour && payload.five_hour) {
    const percent = toFiniteNumber(payload.five_hour.utilization);
    if (percent !== undefined) {
      usage.fiveHour = { percent, resetsAt: toTimestamp(payload.five_hour.resets_at) };
    }
  }

  if (!usage.sevenDay && payload.seven_day) {
    const percent = toFiniteNumber(payload.seven_day.utilization);
    if (percent !== undefined) {
      usage.sevenDay = { percent, resetsAt: toTimestamp(payload.seven_day.resets_at) };
    }
  }

  if (payload.extra_usage && typeof payload.extra_usage === 'object') {
    usage.extraUsageEnabled = payload.extra_usage.is_enabled === true;
  }

  return usage.fiveHour || usage.sevenDay || usage.scoped.length ? usage : undefined;
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs?: number;
  host?: string;
  now?: () => number;
}

/** One GET to the usage endpoint. Never throws; the status field says what happened. */
export function fetchSubscriptionUsage(
  credentials: SubscriptionCredentials,
  options: FetchOptions,
): Promise<UsageFetchResult> {
  const now = options.now ?? Date.now;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: UsageFetchResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const request = https.request(
      {
        host: options.host ?? USAGE_ENDPOINT_HOST,
        path: USAGE_ENDPOINT_PATH,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
          Accept: 'application/json',
          'User-Agent': options.userAgent,
        },
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (body.length < 1024 * 1024) {
            body += chunk;
          }
        });
        response.on('end', () => {
          const httpStatus = response.statusCode ?? 0;

          if (httpStatus === 401 || httpStatus === 403) {
            finish({ status: 'unauthorized', httpStatus, error: `HTTP ${httpStatus}` });
            return;
          }

          if (httpStatus === 429) {
            const retryAfterHeader = response.headers['retry-after'];
            const retryAfterSeconds = Number(Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader);
            finish({
              status: 'rate_limited',
              httpStatus,
              error: 'HTTP 429',
              retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined,
            });
            return;
          }

          if (httpStatus < 200 || httpStatus >= 300) {
            finish({ status: httpStatus >= 500 ? 'network_error' : 'bad_response', httpStatus, error: `HTTP ${httpStatus}` });
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            finish({ status: 'bad_response', httpStatus, error: 'Response was not JSON' });
            return;
          }

          const usage = parseUsagePayload(parsed, now());
          if (!usage) {
            finish({ status: 'bad_response', httpStatus, error: 'Response had no usage windows' });
            return;
          }

          finish({ status: 'ok', httpStatus, usage });
        });
        response.on('error', (error) => finish({ status: 'network_error', error: error.message }));
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', (error) => finish({ status: 'network_error', error: error.message }));
    request.end();
  });
}

export interface SubscriptionUsageClientOptions {
  userAgent: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pollIntervalMs?: number;
  isEnabled?: () => boolean;
  fetchImpl?: typeof fetchSubscriptionUsage;
  now?: () => number;
}

/**
 * Polling wrapper with backoff. `maybePoll()` is cheap to call on every watcher tick;
 * `requestAfterTurn()` schedules a fetch shortly after a turn completes so the per-turn delta
 * reflects that turn.
 */
export class SubscriptionUsageClient {
  private readonly userAgent: string;
  private readonly homeDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetchImpl: typeof fetchSubscriptionUsage;
  private readonly now: () => number;
  private pollIntervalMs: number;
  private isEnabledFn: () => boolean;
  private latest?: SubscriptionUsage;
  private status: UsageFetchStatus = 'disabled';
  private error?: string;
  private lastAttemptAt?: number;
  private nextAllowedAt = 0;
  private inFlight?: Promise<UsageFetchResult>;
  private afterTurnTimer?: NodeJS.Timeout;
  private subscriptionType?: string;
  private rateLimitTier?: string;
  private credentialSource?: CredentialSource;

  constructor(options: SubscriptionUsageClientOptions) {
    this.userAgent = options.userAgent;
    this.homeDir = options.homeDir ?? os.homedir();
    this.platform = options.platform ?? process.platform;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.isEnabledFn = options.isEnabled ?? (() => true);
    this.fetchImpl = options.fetchImpl ?? fetchSubscriptionUsage;
    this.now = options.now ?? Date.now;
  }

  setEnabled(isEnabled: () => boolean): void {
    this.isEnabledFn = isEnabled;
  }

  setPollInterval(pollIntervalMs: number): void {
    this.pollIntervalMs = Math.max(10 * 1000, pollIntervalMs);
  }

  isEnabled(): boolean {
    return this.isEnabledFn();
  }

  getState(): SubscriptionUsageState {
    return {
      enabled: this.isEnabled(),
      status: this.isEnabled() ? this.status : 'disabled',
      latest: this.latest ? { ...this.latest, scoped: this.latest.scoped.map((limit) => ({ ...limit })) } : undefined,
      error: this.error,
      lastAttemptAt: this.lastAttemptAt,
      subscriptionType: this.subscriptionType,
      rateLimitTier: this.rateLimitTier,
      credentialSource: this.credentialSource,
    };
  }

  /** Called on every watcher tick; fetches only when the poll interval and backoff allow it. */
  async maybePoll(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const now = this.now();
    if (now < this.nextAllowedAt) {
      return;
    }

    if (this.lastAttemptAt !== undefined && now - this.lastAttemptAt < this.pollIntervalMs) {
      return;
    }

    await this.refresh();
  }

  /** Schedules a fetch shortly after a turn completes (the endpoint lags the request slightly). */
  requestAfterTurn(): void {
    if (!this.isEnabled()) {
      return;
    }

    if (this.afterTurnTimer) {
      clearTimeout(this.afterTurnTimer);
    }

    this.afterTurnTimer = setTimeout(() => {
      this.afterTurnTimer = undefined;
      void this.refresh(true);
    }, AFTER_TURN_DELAY_MS);
  }

  /** Waits for an in-flight fetch (bounded) so callers can render fresh numbers. */
  async waitForInFlight(timeoutMs: number): Promise<void> {
    if (!this.inFlight) {
      return;
    }

    await Promise.race([
      this.inFlight.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /**
   * Fetches now. `force` bypasses the poll interval (not the error backoff) and is spaced at
   * least a few seconds apart so a burst of turns cannot hammer the endpoint.
   */
  async refresh(force = false): Promise<UsageFetchResult> {
    if (!this.isEnabled()) {
      this.status = 'disabled';
      return { status: 'disabled' };
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const now = this.now();
    if (now < this.nextAllowedAt) {
      return { status: this.status, error: this.error, usage: this.latest };
    }

    if (force && this.lastAttemptAt !== undefined && now - this.lastAttemptAt < MIN_FORCED_SPACING_MS) {
      return { status: this.status, error: this.error, usage: this.latest };
    }

    this.inFlight = this.performFetch();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  dispose(): void {
    if (this.afterTurnTimer) {
      clearTimeout(this.afterTurnTimer);
      this.afterTurnTimer = undefined;
    }
  }

  private async performFetch(): Promise<UsageFetchResult> {
    const now = this.now();
    this.lastAttemptAt = now;

    const lookup = await loadCredentials(this.homeDir, this.platform);
    if (!lookup.credentials) {
      return this.record({ status: 'no_credentials', error: lookup.error });
    }

    this.credentialSource = lookup.source;
    this.subscriptionType = lookup.credentials.subscriptionType ?? this.subscriptionType;
    this.rateLimitTier = lookup.credentials.rateLimitTier ?? this.rateLimitTier;

    if (lookup.credentials.expiresAt !== undefined && lookup.credentials.expiresAt <= now) {
      // Claude Code refreshes its own token on its next request; we never refresh it ourselves.
      return this.record({ status: 'token_expired', error: 'Claude Code login token expired' });
    }

    const result = await this.fetchImpl(lookup.credentials, { userAgent: this.userAgent, now: this.now });
    return this.record(result);
  }

  private record(result: UsageFetchResult): UsageFetchResult {
    this.status = result.status;
    this.error = result.status === 'ok' ? undefined : result.error;

    if (result.status === 'ok' && result.usage) {
      this.latest = result.usage;
      this.nextAllowedAt = 0;
    } else {
      const backoff = result.retryAfterMs ?? BACKOFF_MS[result.status] ?? 60 * 1000;
      this.nextAllowedAt = this.now() + backoff;
    }

    return result;
  }
}
