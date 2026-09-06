import * as vscode from 'vscode';

import { installAdvisorSkill } from './advisor-skill';
import { SettingsManager, TtlMode, getModeLabel } from './settings-manager';
import {
  buildStatusPresentation,
  getCacheAnchorAt,
  hasFrequentResetWarning,
  shouldPrioritizeWarning,
} from './status-model';
import { StatusBarController } from './status-bar';
import { TtlSnapshot, TtlWatcher } from './ttl-watcher';

const TOGGLE_MODE_COMMAND = 'claudeTtl.toggleMode';
const INSTALL_ADVISOR_COMMAND = 'claudeTtl.installAdvisorSkill';
const ADVISOR_SLASH_COMMAND = '/ttl-advisor';
const ROLLING_STEP_MS = 3000;

function getPrimaryWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getRemainingMs(snapshot: TtlSnapshot, now = Date.now()): number | undefined {
  const anchor = getCacheAnchorAt(snapshot);
  if (!anchor) {
    return undefined;
  }

  return snapshot.ttlMs - (now - anchor);
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

function buildModeOptionLabel(mode: TtlMode, selected: boolean): string {
  return vscode.l10n.t('{0} {1}', selected ? '$(check)' : '$(circle-outline)', getModeLabel(mode));
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
  let recommendationNotifiedKey: string | undefined;
  let lastRolledTurnKey: string | undefined;
  let rollingTimer: NodeJS.Timeout | undefined;

  const clearRollingTimer = (): void => {
    if (!rollingTimer) {
      return;
    }

    clearTimeout(rollingTimer);
    rollingTimer = undefined;
  };

  const clearRollingState = (): void => {
    clearRollingTimer();
    watcher.setRollingState('countdown');
  };

  const buildCompletedTurnKey = (snapshot: TtlSnapshot): string | undefined => {
    const turnTimestamp = snapshot.lastCompletedTurn?.timestamp;
    if (!snapshot.sessionId || !turnTimestamp) {
      return undefined;
    }

    return `${snapshot.sessionId}:${turnTimestamp}`;
  };

  const hasRateLimitData = (snapshot: TtlSnapshot): boolean =>
    snapshot.rateLimits?.fiveHourUsedPercentage !== undefined
    || snapshot.rateLimits?.sevenDayUsedPercentage !== undefined;

  const shouldSkipRolling = (snapshot: TtlSnapshot): boolean =>
    !snapshot.sessionId
    || !getCacheAnchorAt(snapshot)
    || shouldPrioritizeWarning(snapshot);

  const restoreCountdownAfterDelay = (): void => {
    clearRollingTimer();
    rollingTimer = setTimeout(() => {
      watcher.setRollingState('countdown');
      render();
    }, ROLLING_STEP_MS);
  };

  const scheduleRollingSequence = (): void => {
    clearRollingTimer();
    rollingTimer = setTimeout(() => {
      void watcher.refresh().then((snapshot) => {
        if (shouldSkipRolling(snapshot)) {
          clearRollingState();
          render();
          return;
        }

        if (hasRateLimitData(snapshot)) {
          watcher.setRollingState('rate_limit');
          render();
          restoreCountdownAfterDelay();
          return;
        }

        watcher.setRollingState('countdown');
        render();
      });
    }, ROLLING_STEP_MS);
  };

  const maybeStartRolling = (snapshot: TtlSnapshot): void => {
    const completedTurnKey = buildCompletedTurnKey(snapshot);
    if (!completedTurnKey) {
      return;
    }

    if (completedTurnKey === lastRolledTurnKey) {
      return;
    }

    lastRolledTurnKey = completedTurnKey;

    if (shouldSkipRolling(snapshot)) {
      clearRollingState();
      return;
    }

    watcher.setRollingState('turn_usage');
    scheduleRollingSequence();
  };

  const installAdvisor = async (): Promise<void> => {
    try {
      const { skillDir } = await installAdvisorSkill(context.extensionPath);
      const copyLabel = vscode.l10n.t('Copy /ttl-advisor');
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Installed /ttl-advisor at {0}. In Claude Code, type /ttl-advisor for a personalized TTL recommendation.',
          skillDir,
        ),
        copyLabel,
      );

      if (choice === copyLabel) {
        await vscode.env.clipboard.writeText(ADVISOR_SLASH_COMMAND);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Failed to install /ttl-advisor skill: {0}', error instanceof Error ? error.message : String(error)),
      );
    }
  };

  const applyMode = async (mode: TtlMode): Promise<void> => {
    await settingsManager.setMode(mode);
    await watcher.refresh();
    render();

    void vscode.window.showInformationMessage(
      vscode.l10n.t('TTL mode switched to {0}. Applies from your next prompt. If the previous cache already expired, the first turn may still trigger a rebuild.', getModeLabel(mode)),
    );
  };

  const maybeNotifyRecommendation = (snapshot: TtlSnapshot): void => {
    const recommendation = snapshot.recommendation;
    if (
      !recommendation
      || !snapshot.sessionId
      || snapshot.sessionGracePending
      || recommendation.strength !== 'strong'
      || recommendation.mode === snapshot.mode
    ) {
      return;
    }

    const key = `${snapshot.sessionId}:${recommendation.mode}`;
    if (recommendationNotifiedKey === key) {
      return;
    }

    recommendationNotifiedKey = key;

    const recommendedMode = recommendation.mode;
    const switchLabel = vscode.l10n.t('Switch to {0}', getModeLabel(recommendedMode));
    const askLabel = vscode.l10n.t('Ask Claude');

    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Based on your last {0} turns, {1} would have cost about {2}% less. Switch now?',
        recommendation.windowTurns,
        getModeLabel(recommendedMode),
        Math.round(recommendation.marginRatio * 100),
      ),
      switchLabel,
      askLabel,
    ).then(async (choice) => {
      if (choice === switchLabel) {
        await applyMode(recommendedMode);
      } else if (choice === askLabel) {
        await installAdvisor();
      }
    });
  };

  const maybeNotify = (snapshot: TtlSnapshot): void => {
    const remainingMs = getRemainingMs(snapshot);
    const anchor = getCacheAnchorAt(snapshot);
    if (remainingMs === undefined || !snapshot.sessionId || !anchor) {
      soonNotifiedKey = undefined;
      expiredNotifiedKey = undefined;
      cacheWarningKey = undefined;
      return;
    }

    const notificationKey = `${snapshot.sessionId}:${anchor}:${snapshot.mode}`;

    if (remainingMs <= 0) {
      if (expiredNotifiedKey !== notificationKey) {
        expiredNotifiedKey = notificationKey;
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Prompt cache TTL expired. The next prompt will likely rebuild cache from scratch.'),
        );
      }
      return;
    }

    if (remainingMs <= 5 * 60 * 1000 && soonNotifiedKey !== notificationKey) {
      soonNotifiedKey = notificationKey;
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Prompt cache TTL is under five minutes. If you expect a long pause, 1h mode may be safer.'),
      );
    }

    maybeNotifyRecommendation(snapshot);

    const lastUsage = snapshot.lastCompletedTurn;
    if (!lastUsage?.timestamp) {
      return;
    }

    const frequentResetKey = `${snapshot.sessionId}:${lastUsage.timestamp}:${snapshot.cacheHealth.recentTtlExpiryColdStarts}`;
    if (hasFrequentResetWarning(snapshot) && cacheWarningKey !== frequentResetKey) {
      cacheWarningKey = frequentResetKey;

      void vscode.window.showWarningMessage(
        vscode.l10n.t('Recent prompt cache resets look frequent. Each reset rebuilds the cache from scratch and burns your usage limit.'),
      );
    }
  };

  const render = (): void => {
    const snapshot = watcher.getSnapshot();

    if (shouldSkipRolling(snapshot) && snapshot.rollingState !== 'countdown') {
      clearRollingState();
    }

    maybeStartRolling(watcher.getSnapshot());

    const currentSnapshot = watcher.getSnapshot();
    statusBar.render(buildStatusPresentation(currentSnapshot));
    maybeNotify(currentSnapshot);
  };

  await watcher.start();
  lastRolledTurnKey = buildCompletedTurnKey(watcher.getSnapshot());
  render();

  const renderInterval = setInterval(render, 1000);

  const toggleModeDisposable = vscode.commands.registerCommand(TOGGLE_MODE_COMMAND, async () => {
    const currentMode = await settingsManager.getMode();
    const snapshot = watcher.getSnapshot();
    const remainingText = formatRemainingText(getRemainingMs(snapshot));

    const options: Array<vscode.QuickPickItem & { mode?: TtlMode; action?: 'advisor' }> = [
      {
        label: buildModeOptionLabel('1h', currentMode === '1h'),
        description: currentMode === '1h'
          ? vscode.l10n.t('Current | {0}', remainingText)
          : vscode.l10n.t('Switch'),
        mode: '1h',
      },
      {
        label: buildModeOptionLabel('5m', currentMode === '5m'),
        description: currentMode === '5m'
          ? vscode.l10n.t('Current | {0}', remainingText)
          : vscode.l10n.t('Switch'),
        mode: '5m',
      },
      {
        label: `$(sparkle) ${vscode.l10n.t('Ask Claude why (/ttl-advisor)')}`,
        description: vscode.l10n.t('Install the /ttl-advisor skill and get a personalized explanation in Claude Code'),
        action: 'advisor',
      },
    ];

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: vscode.l10n.t('Claude TTL | {0} | {1}', getModeLabel(currentMode), remainingText),
    });

    if (!selected) {
      return;
    }

    if (selected.action === 'advisor') {
      await installAdvisor();
      return;
    }

    if (!selected.mode || selected.mode === currentMode) {
      return;
    }

    await applyMode(selected.mode);
  });

  const installAdvisorDisposable = vscode.commands.registerCommand(INSTALL_ADVISOR_COMMAND, installAdvisor);

  const workspaceDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    watcher.setWorkspacePath(getPrimaryWorkspacePath());
    void watcher.refresh().then((snapshot) => {
      lastRolledTurnKey = buildCompletedTurnKey(snapshot);
      clearRollingState();
      render();
    });
  });

  context.subscriptions.push(
    toggleModeDisposable,
    installAdvisorDisposable,
    workspaceDisposable,
    {
      dispose: () => clearInterval(renderInterval),
    },
    {
      dispose: () => clearRollingTimer(),
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
