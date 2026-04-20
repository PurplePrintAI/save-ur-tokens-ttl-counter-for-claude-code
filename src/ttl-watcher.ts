import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { SettingsManager, TtlMode, getTtlDurationMs } from './settings-manager';

interface ClaudeSessionFile {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  kind?: string;
  entrypoint?: string;
}

export interface TtlSnapshot {
  workspacePath?: string;
  mode: TtlMode;
  ttlMs: number;
  sessionId?: string;
  transcriptPath?: string;
  lastUserPromptAt?: number;
  lastUpdatedAt: number;
  error?: string;
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
    return { ...this.snapshot };
  }

  async refresh(): Promise<TtlSnapshot> {
    const mode = await this.settingsManager.getMode();
    const ttlMs = getTtlDurationMs(mode);

    try {
      const activeSession = await this.findActiveSessionForWorkspace(this.workspacePath);
      const transcriptPath = activeSession?.sessionId
        ? await this.findTranscriptPath(activeSession.sessionId, activeSession.cwd)
        : undefined;
      const lastUserPromptAt = transcriptPath
        ? await this.findLastUserPromptTimestamp(transcriptPath)
        : undefined;

      this.snapshot = {
        workspacePath: this.workspacePath,
        mode,
        ttlMs,
        sessionId: activeSession?.sessionId,
        transcriptPath,
        lastUserPromptAt,
        lastUpdatedAt: Date.now(),
      };
    } catch (error) {
      this.snapshot = {
        workspacePath: this.workspacePath,
        mode,
        ttlMs,
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

  private async findLastUserPromptTimestamp(jsonlPath: string): Promise<number | undefined> {
    const handle = await fs.open(jsonlPath, 'r');

    try {
      const stat = await handle.stat();
      const chunkSize = 64 * 1024;
      let position = stat.size;
      let remainder = '';

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
          const timestamp = this.parseUserTimestamp(lines[index]);
          if (timestamp) {
            return timestamp;
          }
        }
      }

      return this.parseUserTimestamp(remainder);
    } finally {
      await handle.close();
    }
  }

  private parseUserTimestamp(line: string): number | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed) as { type?: string; timestamp?: string };
      if (parsed.type !== 'user' || !parsed.timestamp) {
        return undefined;
      }

      const timestamp = Date.parse(parsed.timestamp);
      return Number.isNaN(timestamp) ? undefined : timestamp;
    } catch {
      return undefined;
    }
  }
}
