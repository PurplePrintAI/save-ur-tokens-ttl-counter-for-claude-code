import { ApiCall, CacheTier, LogicalTurn, TTL_MS } from './transcript-tracker';

/**
 * Counterfactual cost simulation for the 5m vs 1h prompt-cache TTL.
 *
 * Instead of thresholding a median turn gap, we replay the user's actual API calls (real request
 * timestamps, real cache read/write sizes) under both TTL policies and compare the estimated
 * input-side cost. The cheaper policy wins when the margin is large enough for the sample size.
 *
 * Cost model (Anthropic prompt-caching pricing, relative to the base input price):
 *   - cache write: 1.25x for the 5-minute TTL, 2x for the 1-hour TTL
 *   - cache read : 0.1x (0.025x on Claude Fable 5.1 / Mythos 5.1)
 *   - the cache entry lives TTL milliseconds from the *start* of the request that touched it
 *
 * Assumption: subscription usage-limit accounting is weighted roughly like API pricing. The
 * absolute numbers are estimates; the comparison between the two policies is what matters.
 *
 * This module is intentionally free of `vscode` imports so it can be exercised with plain node.
 */

export const CACHE_WRITE_MULTIPLIER: Record<CacheTier, number> = {
  '5m': 1.25,
  '1h': 2,
};

export const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
const LOW_CACHE_READ_MULTIPLIER = 0.025;
const LOW_CACHE_READ_MODEL_PATTERN = /^claude-(fable|mythos)-5-1/;

export const RECOMMENDATION_WINDOW_TURNS = 30;
const MIN_TURNS_FOR_1H = 5;
const MIN_TURNS_FOR_5M = 8;
const MIN_MARGIN_FOR_1H = 0.08;
const STRONG_MARGIN_FOR_1H = 0.25;
const MIN_MARGIN_FOR_5M = 0.2;
const STRONG_MARGIN_FOR_5M = 0.35;

export function cacheReadMultiplier(model?: string): number {
  return model && LOW_CACHE_READ_MODEL_PATTERN.test(model)
    ? LOW_CACHE_READ_MULTIPLIER
    : DEFAULT_CACHE_READ_MULTIPLIER;
}

export interface CostSimulation {
  tier: CacheTier;
  /** Estimated input-side cost in base-input-token equivalents. */
  cost: number;
  /** Requests whose cache would have expired under this policy. */
  expiredRequests: number;
  /** Tokens that would have been rebuilt from scratch under this policy. */
  rebuildTokens: number;
}

export function simulateCost(calls: ApiCall[], tier: CacheTier): CostSimulation {
  const write = CACHE_WRITE_MULTIPLIER[tier];
  const ttl = TTL_MS[tier];
  let cost = 0;
  let expiredRequests = 0;
  let rebuildTokens = 0;
  let previous: ApiCall | undefined;

  for (const call of calls) {
    const read = cacheReadMultiplier(call.model);

    if (!previous) {
      // No counterfactual for the first request in the window: charge what was observed.
      cost += read * call.cacheReadTokens + write * call.cacheCreationTokens + call.inputTokens;
    } else if (call.requestAt - previous.requestAt <= ttl) {
      if (call.cacheReadTokens > 0) {
        cost += read * call.cacheReadTokens + write * call.cacheCreationTokens + call.inputTokens;
      } else {
        // Observed a cold start, but this policy would have kept the previous context alive.
        const reuse = Math.min(call.grossInputTokens, previous.grossInputTokens);
        cost += read * reuse + write * (call.grossInputTokens - reuse);
      }
    } else {
      // This policy would have let the cache expire: everything is rebuilt.
      cost += write * call.grossInputTokens;
      expiredRequests += 1;
      rebuildTokens += call.grossInputTokens;
    }

    previous = call;
  }

  return { tier, cost, expiredRequests, rebuildTokens };
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const ascending = [...values].sort((a, b) => a - b);
  const index = Math.min(ascending.length - 1, Math.max(0, Math.floor(p * ascending.length)));
  return ascending[index];
}

export interface RhythmSummary {
  /** Turns considered (real turns that made at least one API call). */
  turns: number;
  idleMedianMs?: number;
  idleP75Ms?: number;
  idleMaxMs?: number;
  sessionStartColdStarts: number;
  ttlExpiryColdStarts: number;
  ttlExpiryRebuildTokens: number;
  otherColdStarts: number;
  contextMedianTokens?: number;
}

export function summarizeRhythm(turns: LogicalTurn[]): RhythmSummary {
  const considered = turns.filter((turn) => !turn.synthetic && turn.callCount > 0);
  const idleGaps = considered
    .map((turn) => turn.idleBeforeMs)
    .filter((gap): gap is number => gap !== undefined);
  const contexts = considered
    .map((turn) => turn.openingCall?.grossInputTokens)
    .filter((tokens): tokens is number => tokens !== undefined && tokens > 0);
  const ttlExpiry = considered.filter((turn) => turn.coldStartKind === 'ttl_expiry');

  return {
    turns: considered.length,
    idleMedianMs: percentile(idleGaps, 0.5),
    idleP75Ms: percentile(idleGaps, 0.75),
    idleMaxMs: idleGaps.length ? Math.max(...idleGaps) : undefined,
    sessionStartColdStarts: considered.filter((turn) => turn.coldStartKind === 'session_start').length,
    ttlExpiryColdStarts: ttlExpiry.length,
    ttlExpiryRebuildTokens: ttlExpiry.reduce((sum, turn) => sum + (turn.openingCall?.cacheCreationTokens ?? 0), 0),
    otherColdStarts: considered.filter((turn) => turn.coldStartKind === 'other').length,
    contextMedianTokens: percentile(contexts, 0.5),
  };
}

export interface ModeRecommendation {
  /** The cheaper policy over the window. */
  mode: CacheTier;
  strength: 'weak' | 'strong';
  /** Relative saving of the cheaper policy: |cost5m - cost1h| / max(cost5m, cost1h). */
  marginRatio: number;
  windowTurns: number;
  cost5m: number;
  cost1h: number;
  /** True when the user is already on the cheaper policy. */
  isCurrent: boolean;
}

export function buildRecommendation(
  turns: LogicalTurn[],
  calls: ApiCall[],
  currentTier: CacheTier,
): ModeRecommendation | undefined {
  const window = turns
    .filter((turn) => !turn.synthetic && turn.callCount > 0)
    .slice(-RECOMMENDATION_WINDOW_TURNS);

  if (window.length === 0) {
    return undefined;
  }

  const firstTurnIndex = window[0].index;
  const windowCalls = calls.filter((call) => call.turnIndex >= firstTurnIndex);
  if (windowCalls.length < 2) {
    return undefined;
  }

  const sim5m = simulateCost(windowCalls, '5m');
  const sim1h = simulateCost(windowCalls, '1h');
  const cheaper: CacheTier = sim5m.cost <= sim1h.cost ? '5m' : '1h';
  const marginRatio = Math.abs(sim5m.cost - sim1h.cost) / Math.max(sim5m.cost, sim1h.cost, 1);

  if (cheaper === '1h') {
    if (window.length < MIN_TURNS_FOR_1H || marginRatio < MIN_MARGIN_FOR_1H) {
      return undefined;
    }
  } else if (window.length < MIN_TURNS_FOR_5M || marginRatio < MIN_MARGIN_FOR_5M) {
    return undefined;
  }

  const strongThreshold = cheaper === '1h' ? STRONG_MARGIN_FOR_1H : STRONG_MARGIN_FOR_5M;

  return {
    mode: cheaper,
    strength: marginRatio >= strongThreshold ? 'strong' : 'weak',
    marginRatio,
    windowTurns: window.length,
    cost5m: sim5m.cost,
    cost1h: sim1h.cost,
    isCurrent: cheaper === currentTier,
  };
}
