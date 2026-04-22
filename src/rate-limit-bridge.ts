import * as fs from 'node:fs/promises';

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

export interface RateLimitSummary {
  sessionId?: string;
  updatedAt?: number;
  sourcePath: string;
  fiveHourUsedPercentage?: number;
  fiveHourResetsAt?: number;
  sevenDayUsedPercentage?: number;
  sevenDayResetsAt?: number;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
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
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return undefined;
    }

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
