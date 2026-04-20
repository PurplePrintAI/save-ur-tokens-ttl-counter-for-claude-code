import * as vscode from 'vscode';

import { SettingsManager, TtlMode, getModeLabel } from './settings-manager';
import { buildStatusPresentation } from './status-model';
import { StatusBarController } from './status-bar';
import { TtlSnapshot, TtlWatcher } from './ttl-watcher';

const TOGGLE_MODE_COMMAND = 'claudeTtl.toggleMode';

function getPrimaryWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getRemainingMs(snapshot: TtlSnapshot, now = Date.now()): number | undefined {
  if (!snapshot.lastUserPromptAt) {
    return undefined;
  }

  return snapshot.ttlMs - (now - snapshot.lastUserPromptAt);
}

function formatRemainingText(remainingMs?: number): string {
  if (remainingMs === undefined) {
    return '--:--';
  }

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settingsManager = new SettingsManager();
  const watcher = new TtlWatcher({
    settingsManager,
    workspacePath: getPrimaryWorkspacePath(),
  });
  const statusBar = new StatusBarController(TOGGLE_MODE_COMMAND);

  let soonNotifiedKey: string | undefined;
  let expiredNotifiedKey: string | undefined;
  let cacheWarningKey: string | undefined;

  const maybeNotify = (snapshot: TtlSnapshot): void => {
    const remainingMs = getRemainingMs(snapshot);
    if (remainingMs === undefined || !snapshot.sessionId || !snapshot.lastUserPromptAt) {
      soonNotifiedKey = undefined;
      expiredNotifiedKey = undefined;
      cacheWarningKey = undefined;
      return;
    }

    const notificationKey = `${snapshot.sessionId}:${snapshot.lastUserPromptAt}:${snapshot.mode}`;

    if (remainingMs <= 0) {
      if (expiredNotifiedKey !== notificationKey) {
        expiredNotifiedKey = notificationKey;
        void vscode.window.showWarningMessage(
          'Prompt cache TTL expired. The next prompt will likely rebuild cache from scratch.',
        );
      }
      return;
    }

    if (remainingMs <= 5 * 60 * 1000 && soonNotifiedKey !== notificationKey) {
      soonNotifiedKey = notificationKey;
      void vscode.window.showInformationMessage(
        'Prompt cache TTL is under five minutes. If you expect a long pause, 1h mode may be safer.',
      );
    }

    const lastUsage = snapshot.lastCompletedTurn;
    if (!lastUsage?.timestamp) {
      return;
    }

    const frequentResetKey = `${snapshot.sessionId}:${lastUsage.timestamp}:${snapshot.cacheHealth.recentColdStarts}`;
    if (
      snapshot.cacheHealth.recentColdStarts >= 2
      && cacheWarningKey !== frequentResetKey
    ) {
      cacheWarningKey = frequentResetKey;

      const suggestedMode = snapshot.recommendation && snapshot.recommendation.mode !== snapshot.mode
        ? ` Consider switching to ${getModeLabel(snapshot.recommendation.mode)}.`
        : '';

      void vscode.window.showWarningMessage(
        `Recent prompt cache resets look frequent. This can waste tokens by rebuilding fresh input.${suggestedMode}`,
      );
    }
  };

  const render = (): void => {
    const snapshot = watcher.getSnapshot();
    statusBar.render(buildStatusPresentation(snapshot));
    maybeNotify(snapshot);
  };

  await watcher.start();
  render();

  const renderInterval = setInterval(render, 1000);

  const toggleModeDisposable = vscode.commands.registerCommand(TOGGLE_MODE_COMMAND, async () => {
    const currentMode = await settingsManager.getMode();
    const snapshot = watcher.getSnapshot();
    const remainingText = formatRemainingText(getRemainingMs(snapshot));

    const options: Array<vscode.QuickPickItem & { mode?: TtlMode }> = [
      {
        label: currentMode === '1h'
          ? '$(check) 1h mode'
          : '$(circle-outline) 1h mode',
        description: currentMode === '1h' ? `Current · ${remainingText}` : 'Switch',
        mode: '1h',
      },
      {
        label: currentMode === '5m'
          ? '$(check) 5m mode'
          : '$(circle-outline) 5m mode',
        description: currentMode === '5m' ? `Current · ${remainingText}` : 'Switch',
        mode: '5m',
      },
    ];

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: `Claude TTL · ${getModeLabel(currentMode)} · ${remainingText}`,
    });

    if (!selected?.mode || selected.mode === currentMode) {
      return;
    }

    await settingsManager.setMode(selected.mode);
    await watcher.refresh();
    render();

    void vscode.window.showInformationMessage(`TTL mode switched to ${getModeLabel(selected.mode)}.`);
  });

  const workspaceDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    watcher.setWorkspacePath(getPrimaryWorkspacePath());
    void watcher.refresh().then(render);
  });

  context.subscriptions.push(
    toggleModeDisposable,
    workspaceDisposable,
    {
      dispose: () => clearInterval(renderInterval),
    },
    {
      dispose: () => watcher.dispose(),
    },
    {
      dispose: () => statusBar.dispose(),
    },
  );
}

export function deactivate(): void {
  // VS Code lifecycle hook. Disposables are registered via context.subscriptions.
}
