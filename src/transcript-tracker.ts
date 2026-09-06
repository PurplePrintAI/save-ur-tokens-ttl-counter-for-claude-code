import * as fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * Incremental reader for a Claude Code transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`).
 *
 * Transcripts are append-only, so the tracker remembers its byte offset and only parses new lines
 * on each refresh. It reconstructs:
 *   - logical turns (one per real user prompt) and the API calls inside each turn
 *   - the cache anchor: the start of the most recent API request (prompt or tool_result line).
 *     Anthropic measures the cache TTL from the *start* of the request that touched the cache,
 *     so this is the right timestamp for the countdown, not the user prompt.
 *   - the cache tier actually used per request (`usage.cache_creation.ephemeral_{5m,1h}_input_tokens`)
 *   - cold starts on the opening call of each turn, classified as session start / TTL expiry / other
 *
 * This module is intentionally free of `vscode` imports so it can be exercised with plain node.
 */

export type CacheTier = '5m' | '1h';

export const TTL_MS: Record<CacheTier, number> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

export interface ApiCall {
  turnIndex: number;
  /** Start of the request (timestamp of the prompt / tool_result line that triggered it). */
  requestAt: number;
  /** Timestamp of the assistant line (response written). */
  responseAt: number;
  model?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  grossInputTokens: number;
  /** Cache tier of the write in this request, when anything was written. */
  tier?: CacheTier;
  stopReason?: string;
}

export type ColdStartKind = 'session_start' | 'ttl_expiry' | 'other';

export interface LogicalTurn {
  index: number;
  promptAt: number;
  /** True when the tracker started reading mid-turn and had to invent the turn boundary. */
  synthetic: boolean;
  /** promptAt minus the previous turn's last request start. */
  idleBeforeMs?: number;
  /** Tier of the cache that existed when this turn opened (last observed write tier). */
  tierBefore?: CacheTier;
  callCount: number;
  openingCall?: ApiCall;
  closingCall?: ApiCall;
  /** Latest request start inside this turn (promptAt until the first tool_result). */
  lastRequestAt: number;
  coldStart: boolean;
  coldStartKind?: ColdStartKind;
  /** Opening call read less than half of the previous context: only the shared prefix survived. */
  partialHit: boolean;
}

export interface TranscriptState {
  turns: LogicalTurn[];
  calls: ApiCall[];
  lastUserPromptAt?: number;
  /** Cache anchor: start of the most recent API request. */
  lastRequestAt?: number;
  lastResponseAt?: number;
  /** Last call that ended a turn (stop_reason other than tool_use). */
  lastCompletedCall?: ApiCall;
  observedTier?: CacheTier;
  observedTierAt?: number;
}

interface TranscriptContentItem {
  type?: string;
  text?: string;
}

interface TranscriptUsage {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation?: {
    ephemeral_5m_input_tokens?: unknown;
    ephemeral_1h_input_tokens?: unknown;
  };
}

export interface TranscriptLine {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    content?: TranscriptContentItem[] | string;
    stop_reason?: string;
    usage?: TranscriptUsage;
  };
}

const INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_TURNS = 120;
const MAX_CALLS = 1200;
const MAX_SEEN_REQUEST_IDS = 4000;
const INTERRUPT_PLACEHOLDER_TEXT = '[Request interrupted by user]';
const LOCAL_WRAPPER_PATTERN = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|ide_selection|ide_opened_file)\b/;

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseTimestamp(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export type UserLineKind = 'prompt' | 'tool_result' | 'ignore';

/** Distinguishes a real human prompt from tool results, meta lines, and local command output. */
export function classifyUserLine(line: TranscriptLine): UserLineKind {
  if (line.type !== 'user' || line.isSidechain) {
    return 'ignore';
  }

  const content = line.message?.content;
  let texts: string[] = [];

  if (typeof content === 'string') {
    texts = [content];
  } else if (Array.isArray(content)) {
    if (content.some((item) => item.type === 'tool_result')) {
      return 'tool_result';
    }

    texts = content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string);
  } else {
    return 'ignore';
  }

  if (line.isMeta) {
    return 'ignore';
  }

  const real = texts
    .map((text) => text.trim())
    .filter((text) => text && text !== INTERRUPT_PLACEHOLDER_TEXT && !LOCAL_WRAPPER_PATTERN.test(text));

  return real.length > 0 ? 'prompt' : 'ignore';
}

export function extractTier(usage: TranscriptUsage | undefined): CacheTier | undefined {
  const breakdown = usage?.cache_creation;
  if (toNumber(breakdown?.ephemeral_1h_input_tokens) > 0) {
    return '1h';
  }

  if (toNumber(breakdown?.ephemeral_5m_input_tokens) > 0) {
    return '5m';
  }

  return undefined;
}

export class TranscriptTracker {
  private readonly transcriptPath: string;
  private offset = 0;
  private remainder = '';
  private decoder = new StringDecoder('utf8');
  private skipFirstPartialLine = false;
  private readonly seenRequestIds = new Set<string>();
  private readonly seenRequestIdOrder: string[] = [];
  private turns: LogicalTurn[] = [];
  private calls: ApiCall[] = [];
  private turnCounter = 0;
  private pendingRequestAt?: number;
  private lastKnownTier?: CacheTier;
  private lastUserPromptAt?: number;
  private lastRequestAt?: number;
  private lastResponseAt?: number;
  private lastCompletedCall?: ApiCall;
  private observedTier?: CacheTier;
  private observedTierAt?: number;

  constructor(transcriptPath: string) {
    this.transcriptPath = transcriptPath;
  }

  getPath(): string {
    return this.transcriptPath;
  }

  reset(): void {
    this.offset = 0;
    this.remainder = '';
    this.decoder = new StringDecoder('utf8');
    this.skipFirstPartialLine = false;
    this.seenRequestIds.clear();
    this.seenRequestIdOrder.length = 0;
    this.turns = [];
    this.calls = [];
    this.turnCounter = 0;
    this.pendingRequestAt = undefined;
    this.lastKnownTier = undefined;
    this.lastUserPromptAt = undefined;
    this.lastRequestAt = undefined;
    this.lastResponseAt = undefined;
    this.lastCompletedCall = undefined;
    this.observedTier = undefined;
    this.observedTierAt = undefined;
  }

  /** Reads any bytes appended since the last refresh. Re-reads from scratch if the file shrank. */
  async refresh(): Promise<void> {
    const stat = await fs.stat(this.transcriptPath);

    if (stat.size < this.offset) {
      this.reset();
    }

    if (stat.size === this.offset) {
      return;
    }

    if (this.offset === 0 && stat.size > INITIAL_TAIL_BYTES) {
      this.offset = stat.size - INITIAL_TAIL_BYTES;
      this.skipFirstPartialLine = true;
    }

    const handle = await fs.open(this.transcriptPath, 'r');

    try {
      let position = this.offset;

      while (position < stat.size) {
        const size = Math.min(READ_CHUNK_BYTES, stat.size - position);
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, position);
        if (bytesRead <= 0) {
          break;
        }

        position += bytesRead;
        this.consumeText(this.decoder.write(bytesRead === size ? buffer : buffer.subarray(0, bytesRead)));
      }

      this.offset = position;
    } finally {
      await handle.close();
    }
  }

  getState(): TranscriptState {
    return {
      turns: this.turns.map((turn) => ({ ...turn })),
      calls: [...this.calls],
      lastUserPromptAt: this.lastUserPromptAt,
      lastRequestAt: this.lastRequestAt,
      lastResponseAt: this.lastResponseAt,
      lastCompletedCall: this.lastCompletedCall,
      observedTier: this.observedTier,
      observedTierAt: this.observedTierAt,
    };
  }

  /** Feeds raw text (used by refresh and by tests). */
  consumeText(chunk: string): void {
    const text = this.remainder + chunk;
    const lines = text.split('\n');
    this.remainder = lines.pop() ?? '';

    for (const rawLine of lines) {
      if (this.skipFirstPartialLine) {
        this.skipFirstPartialLine = false;
        continue;
      }

      this.ingest(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    }
  }

  private ingest(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }

    const timestamp = parseTimestamp(parsed.timestamp);
    if (timestamp === undefined) {
      return;
    }

    if (parsed.type === 'user') {
      this.handleUserLine(parsed, timestamp);
      return;
    }

    if (parsed.type === 'assistant' && !parsed.isSidechain && parsed.message?.usage) {
      this.handleAssistantLine(parsed, timestamp);
    }
  }

  private handleUserLine(line: TranscriptLine, timestamp: number): void {
    const kind = classifyUserLine(line);
    if (kind === 'ignore') {
      return;
    }

    if (kind === 'prompt') {
      const previous = this.turns[this.turns.length - 1];
      this.pushTurn({
        index: this.turnCounter++,
        promptAt: timestamp,
        synthetic: false,
        idleBeforeMs: previous ? Math.max(0, timestamp - previous.lastRequestAt) : undefined,
        callCount: 0,
        lastRequestAt: timestamp,
        coldStart: false,
        partialHit: false,
      });
      this.lastUserPromptAt = timestamp;
    } else {
      const current = this.turns[this.turns.length - 1];
      if (current) {
        current.lastRequestAt = Math.max(current.lastRequestAt, timestamp);
      }
    }

    this.pendingRequestAt = timestamp;
    this.lastRequestAt = Math.max(this.lastRequestAt ?? 0, timestamp);
  }

  private handleAssistantLine(line: TranscriptLine, timestamp: number): void {
    const dedupeKey = line.requestId ?? line.message?.id;
    if (dedupeKey) {
      if (this.seenRequestIds.has(dedupeKey)) {
        return;
      }

      this.rememberRequestId(dedupeKey);
    }

    const usage = line.message?.usage ?? {};
    const inputTokens = toNumber(usage.input_tokens);
    const cacheReadTokens = toNumber(usage.cache_read_input_tokens);
    const cacheCreationTokens = toNumber(usage.cache_creation_input_tokens);
    const outputTokens = toNumber(usage.output_tokens);

    let turn = this.turns[this.turns.length - 1];
    if (!turn) {
      const promptAt = this.pendingRequestAt ?? timestamp;
      turn = {
        index: this.turnCounter++,
        promptAt,
        synthetic: true,
        callCount: 0,
        lastRequestAt: promptAt,
        coldStart: false,
        partialHit: false,
      };
      this.pushTurn(turn);
    }

    const requestAt = this.pendingRequestAt ?? this.lastResponseAt ?? timestamp;
    this.pendingRequestAt = undefined;

    const call: ApiCall = {
      turnIndex: turn.index,
      requestAt,
      responseAt: timestamp,
      model: line.message?.model,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      outputTokens,
      grossInputTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
      tier: extractTier(usage),
      stopReason: line.message?.stop_reason,
    };

    if (!turn.openingCall) {
      this.classifyOpeningCall(turn, call);
    }

    turn.closingCall = call;
    turn.callCount += 1;
    turn.lastRequestAt = Math.max(turn.lastRequestAt, requestAt);

    if (call.tier) {
      this.lastKnownTier = call.tier;
      this.observedTier = call.tier;
      this.observedTierAt = timestamp;
    }

    this.lastResponseAt = timestamp;
    if (call.stopReason !== 'tool_use') {
      this.lastCompletedCall = call;
    }

    this.calls.push(call);
    if (this.calls.length > MAX_CALLS) {
      this.calls.splice(0, this.calls.length - MAX_CALLS);
    }
  }

  private classifyOpeningCall(turn: LogicalTurn, call: ApiCall): void {
    turn.openingCall = call;
    turn.tierBefore = this.lastKnownTier;

    const previous = this.turns.length >= 2 ? this.turns[this.turns.length - 2] : undefined;
    const cold = call.cacheReadTokens === 0 && call.cacheCreationTokens > 0;
    turn.coldStart = cold;

    if (cold) {
      if (!previous || turn.idleBeforeMs === undefined) {
        turn.coldStartKind = 'session_start';
      } else if (turn.idleBeforeMs > TTL_MS[turn.tierBefore ?? '5m']) {
        turn.coldStartKind = 'ttl_expiry';
      } else {
        turn.coldStartKind = 'other';
      }
    }

    const previousGross = previous?.closingCall?.grossInputTokens ?? 0;
    turn.partialHit = !cold && previousGross > 0 && call.cacheReadTokens < 0.5 * previousGross;
  }

  private pushTurn(turn: LogicalTurn): void {
    this.turns.push(turn);
    if (this.turns.length > MAX_TURNS) {
      this.turns.splice(0, this.turns.length - MAX_TURNS);
    }
  }

  private rememberRequestId(id: string): void {
    this.seenRequestIds.add(id);
    this.seenRequestIdOrder.push(id);

    while (this.seenRequestIdOrder.length > MAX_SEEN_REQUEST_IDS) {
      const oldest = this.seenRequestIdOrder.shift();
      if (oldest) {
        this.seenRequestIds.delete(oldest);
      }
    }
  }
}
