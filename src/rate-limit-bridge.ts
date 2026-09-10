import * as fs from 'node:fs/promises';

import { SubscriptionUsage } from './subscription-usage';

interface RawRateLimitWindow {
  used_percentage?: unknown;
  usedPercentage?: unknown;
  resets_at?: unknown;
  resetsAt?: unknown;
}

interface RawRateLimits {
  five_hour?: RawRateLimitWindow;
  fiveHour?: RawRateLimitWindow;
  seven_day?: RawRateLimitWindow;
  sevenDay?: RawRateLimitWindow;
}

interface RawRateLimitPayload {
  session_id?: unknown;
  sessionId?: unknown;
  updated_at?: unknown;
  updatedAt?: unknown;
  rate_limits?: RawRateLimits;
  rateLimits?: RawRateLimits;
}

export type RateLimitSource = 'statusline' | 'subscription';

export interface RateLimitScopedWindow {
  label: string;
  usedPercentage: number;
  resetsAt?: number;
  isActive?: boolean;
}

export interface RateLimitSummary {
  source: RateLimitSource;
  sessionId?: string;
  updatedAt?: number;
  sourcePath?: string;
  fiveHourUsedPercentage?: number;
  fiveHourResetsAt?: number;
  sevenDayUsedPercentage?: number;
  sevenDayResetsAt?: number;
  scoped?: RateLimitScopedWindow[];
  subscriptionType?: string;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Claude Code's statusline payload uses unix seconds; accept milliseconds too.
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value
    : undefined;
}

function getRawWindow(
  rateLimits: RawRateLimits | undefined,
  snakeCaseKey: 'five_hour' | 'seven_day',
  camelCaseKey: 'fiveHour' | 'sevenDay',
): RawRateLimitWindow | undefined {
  return rateLimits?.[snakeCaseKey] ?? rateLimits?.[camelCaseKey];
}

function parseRateLimitPayload(
  parsed: RawRateLimitPayload,
  sourcePath: string,
  updatedAt?: number,
): RateLimitSummary {
  const rateLimits = parsed.rate_limits ?? parsed.rateLimits;
  const fiveHour = getRawWindow(rateLimits, 'five_hour', 'fiveHour');
  const sevenDay = getRawWindow(rateLimits, 'seven_day', 'sevenDay');

  return {
    source: 'statusline',
    sessionId: toStringValue(parsed.session_id ?? parsed.sessionId),
    updatedAt: toFiniteNumber(parsed.updated_at ?? parsed.updatedAt) ?? updatedAt,
    sourcePath,
    fiveHourUsedPercentage: toFiniteNumber(fiveHour?.used_percentage ?? fiveHour?.usedPercentage),
    fiveHourResetsAt: toTimestamp(fiveHour?.resets_at ?? fiveHour?.resetsAt),
    sevenDayUsedPercentage: toFiniteNumber(sevenDay?.used_percentage ?? sevenDay?.usedPercentage),
    sevenDayResetsAt: toTimestamp(sevenDay?.resets_at ?? sevenDay?.resetsAt),
  };
}

export function hasRateLimitData(summary?: RateLimitSummary): boolean {
  return summary?.fiveHourUsedPercentage !== undefined
    || summary?.sevenDayUsedPercentage !== undefined;
}

/** Converts a live subscription usage sample into the summary shape the UI renders. */
export function subscriptionUsageToSummary(
  usage: SubscriptionUsage,
  subscriptionType?: string,
): RateLimitSummary {
  return {
    source: 'subscription',
    updatedAt: usage.fetchedAt,
    fiveHourUsedPercentage: usage.fiveHour?.percent,
    fiveHourResetsAt: usage.fiveHour?.resetsAt,
    sevenDayUsedPercentage: usage.sevenDay?.percent,
    sevenDayResetsAt: usage.sevenDay?.resetsAt,
    scoped: usage.scoped.map((limit) => ({
      label: limit.label,
      usedPercentage: limit.percent,
      resetsAt: limit.resetsAt,
      isActive: limit.isActive,
    })),
    subscriptionType,
  };
}

/** A live subscription sample is authoritative for this long before the bridge may override it. */
const SUBSCRIPTION_AUTHORITATIVE_MS = 5 * 60 * 1000;
/** The bridge file's self-reported timestamp is trusted only this recent. */
const BRIDGE_FRESH_MS = 15 * 60 * 1000;

/**
 * Chooses the usage source. The subscription endpoint is the trusted source: while its sample is
 * fresh it wins outright, because the bridge file is world-writable (any process, including a
 * stale statusline, can stamp it with a spuriously fresh `updated_at`) and must not be able to
 * override a good live sample. The bridge is used only when the subscription is absent or stale,
 * and then only if the bridge sample itself is recent.
 */
export function pickFreshestRateLimits(
  subscription?: RateLimitSummary,
  statusline?: RateLimitSummary,
  now: number = Date.now(),
): RateLimitSummary | undefined {
  const subFresh = hasRateLimitData(subscription)
    && now - (subscription?.updatedAt ?? 0) <= SUBSCRIPTION_AUTHORITATIVE_MS;
  if (subFresh) {
    return subscription;
  }

  const bridgeFresh = hasRateLimitData(statusline)
    && now - (statusline?.updatedAt ?? 0) <= BRIDGE_FRESH_MS;
  if (bridgeFresh) {
    return statusline;
  }

  // Neither is fresh: prefer whichever has data, subscription first.
  if (hasRateLimitData(subscription)) {
    return subscription;
  }

  return hasRateLimitData(statusline) ? statusline : undefined;
}

/**
 * Drops usage windows whose reset time has already passed (their percentage is stale — the window
 * has rolled over). Returns undefined when nothing usable remains.
 */
export function dropExpiredWindows(
  summary: RateLimitSummary | undefined,
  now: number = Date.now(),
): RateLimitSummary | undefined {
  if (!summary) {
    return undefined;
  }

  const fiveExpired = summary.fiveHourResetsAt !== undefined && summary.fiveHourResetsAt <= now;
  const sevenExpired = summary.sevenDayResetsAt !== undefined && summary.sevenDayResetsAt <= now;

  const cleaned: RateLimitSummary = {
    ...summary,
    fiveHourUsedPercentage: fiveExpired ? undefined : summary.fiveHourUsedPercentage,
    fiveHourResetsAt: fiveExpired ? undefined : summary.fiveHourResetsAt,
    sevenDayUsedPercentage: sevenExpired ? undefined : summary.sevenDayUsedPercentage,
    sevenDayResetsAt: sevenExpired ? undefined : summary.sevenDayResetsAt,
    scoped: summary.scoped?.filter((limit) => limit.resetsAt === undefined || limit.resetsAt > now),
  };

  const hasScoped = Boolean(cleaned.scoped && cleaned.scoped.length);
  return hasRateLimitData(cleaned) || hasScoped ? cleaned : undefined;
}

export async function readRateLimitSummary(
  bridgePath: string,
  expectedSessionId?: string,
): Promise<RateLimitSummary | undefined> {
  let raw: string;
  let updatedAt: number | undefined;

  try {
    const stat = await fs.stat(bridgePath);
    updatedAt = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : undefined;
    raw = await fs.readFile(bridgePath, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: RawRateLimitPayload;
  try {
    parsed = JSON.parse(raw) as RawRateLimitPayload;
  } catch {
    return undefined;
  }

  const summary = parseRateLimitPayload(parsed, bridgePath, updatedAt);
  if (summary.sessionId && expectedSessionId && summary.sessionId !== expectedSessionId) {
    return undefined;
  }

  return hasRateLimitData(summary) ? summary : undefined;
}
