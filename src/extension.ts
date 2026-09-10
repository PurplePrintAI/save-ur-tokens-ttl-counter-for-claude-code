import * as vscode from 'vscode';

import { installAdvisorSkill } from './advisor-skill';
import { SettingsManager, TtlMode, getModeLabel } from './settings-manager';
import {
  HIGH_USAGE_THRESHOLD,
  buildStatusPresentation,
  formatResetCoarse,
  getCacheAnchorAt,
  hasFrequentResetWarning,
  shouldPrioritizeWarning,
} from './status-model';
import { StatusBarController } from './status-bar';
import { SubscriptionUsageClient, loadCredentials } from './subscription-usage';
import { TtlSnapshot, TtlWatcher } from './ttl-watcher';

const TOGGLE_MODE_COMMAND = 'claudeTtl.toggleMode';
const INSTALL_ADVISOR_COMMAND = 'claudeTtl.installAdvisorSkill';
const CONNECT_USAGE_COMMAND = 'claudeTtl.connectSubscriptionUsage';
const DISCONNECT_USAGE_COMMAND = 'claudeTtl.disconnectSubscriptionUsage';
const REFRESH_USAGE_COMMAND = 'claudeTtl.refreshSubscriptionUsage';
const ADVISOR_SLASH_COMMAND = '/ttl-advisor';
const CONFIG_SECTION = 'claudeTtl';
const SUBSCRIPTION_ENABLED_KEY = 'subscriptionUsage.enabled';
const SUBSCRIPTION_INTERVAL_KEY = 'subscriptionUsage.pollIntervalSeconds';
const SUBSCRIPTION_PROMPT_STATE_KEY = 'claudeTtl.subscriptionUsagePrompt';
const SUBSCRIPTION_PROMPT_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const ROLLING_STEP_MS = 3000;

interface SubscriptionConfig {
  enabled: boolean;
  pollIntervalMs: number;
}

function readSubscriptionConfig(): SubscriptionConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const seconds = config.get<number>(SUBSCRIPTION_INTERVAL_KEY, 60);
  return {
    enabled: config.get<boolean>(SUBSCRIPTION_ENABLED_KEY, false),
    pollIntervalMs: Math.max(20, Number.isFinite(seconds) ? seconds : 60) * 1000,
  };
}

async function writeSubscriptionEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(SUBSCRIPTION_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
}

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

function formatPercent(value?: number): string {
  return value === undefined ? '--' : value.toFixed(1);
}

function buildModeOptionLabel(mode: TtlMode, selected: boolean): string {
  return vscode.l10n.t('{0} {1}', selected ? '$(check)' : '$(circle-outline)', getModeLabel(mode));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settingsManager = new SettingsManager();
  const extensionVersion = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  const subscriptionUsage = new SubscriptionUsageClient({
    userAgent: `claude-ttl-counter/${extensionVersion}`,
    pollIntervalMs: readSubscriptionConfig().pollIntervalMs,
    isEnabled: () => readSubscriptionConfig().enabled,
  });
  const watcher = new TtlWatcher({
    settingsManager,
    workspacePath: getPrimaryWorkspacePath(),
    subscriptionUsage,
  });
  const statusBar = new StatusBarController(TOGGLE_MODE_COMMAND);

  let soonNotifiedKey: string | undefined;
  let expiredNotifiedKey: string | undefined;
  let cacheWarningKey: string | undefined;
  let recommendationNotifiedKey: string | undefined;
  const highUsageNotified = new Set<string>();
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

  const describeUsage = (snapshot: TtlSnapshot): string =>
    vscode.l10n.t(
      'Usage refreshed: 5h {0}% | 7d {1}%',
      formatPercent(snapshot.rateLimits?.fiveHourUsedPercentage),
      formatPercent(snapshot.rateLimits?.sevenDayUsedPercentage),
    );

  const connectSubscriptionUsage = async (): Promise<void> => {
    await writeSubscriptionEnabled(true);
    await watcher.refreshSubscriptionUsage();
    render();

    const snapshot = watcher.getSnapshot();
    if (snapshot.subscription?.status === 'ok' && snapshot.rateLimits?.source === 'subscription') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Subscription usage connected: 5h {0}% | 7d {1}%',
          formatPercent(snapshot.rateLimits.fiveHourUsedPercentage),
          formatPercent(snapshot.rateLimits.sevenDayUsedPercentage),
        ),
      );
      return;
    }

    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Subscription usage is on, but the first fetch failed: {0}. It will retry automatically.',
        snapshot.subscription?.error ?? snapshot.subscription?.status ?? 'unknown',
      ),
    );
  };

  const disconnectSubscriptionUsage = async (): Promise<void> => {
    await writeSubscriptionEnabled(false);
    await watcher.refresh();
    render();
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Subscription usage disconnected. The status bar falls back to the statusline bridge if present.'),
    );
  };

  const refreshSubscriptionUsage = async (): Promise<void> => {
    await watcher.refreshSubscriptionUsage();
    render();

    const snapshot = watcher.getSnapshot();
    if (snapshot.subscription?.status === 'ok') {
      void vscode.window.showInformationMessage(describeUsage(snapshot));
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Could not refresh usage: {0}', snapshot.subscription?.error ?? snapshot.subscription?.status ?? 'disabled'),
      );
    }
  };

  const maybeOfferSubscriptionUsage = async (): Promise<void> => {
    if (readSubscriptionConfig().enabled) {
      return;
    }

    const promptState = context.globalState.get<string>(SUBSCRIPTION_PROMPT_STATE_KEY);
    if (promptState === 'never') {
      return;
    }

    if (promptState) {
      const lastAskedAt = Date.parse(promptState);
      if (!Number.isNaN(lastAskedAt) && Date.now() - lastAskedAt < SUBSCRIPTION_PROMPT_RETRY_MS) {
        return;
      }
    }

    const lookup = await loadCredentials();
    if (!lookup.credentials) {
      return;
    }

    await context.globalState.update(SUBSCRIPTION_PROMPT_STATE_KEY, new Date().toISOString());

    const connectLabel = vscode.l10n.t('Connect');
    const laterLabel = vscode.l10n.t('Not now');
    const neverLabel = vscode.l10n.t('Never');
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Show your real 5h/7d subscription usage in the status bar? This sends one request about every minute to api.anthropic.com/api/oauth/usage with the Claude Code login token already stored on this machine. Nothing else is sent, and you can turn it off anytime in settings.',
      ),
      connectLabel,
      laterLabel,
      neverLabel,
    );

    if (choice === connectLabel) {
      await connectSubscriptionUsage();
    } else if (choice === neverLabel) {
      await context.globalState.update(SUBSCRIPTION_PROMPT_STATE_KEY, 'never');
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

  const maybeNotifyHighUsage = (snapshot: TtlSnapshot): void => {
    const limits = snapshot.rateLimits;
    if (!limits) {
      return;
    }

    const now = Date.now();

    // Only warn from a fresh sample. A stale or transient bridge reading must never pop a scary,
    // persistent notification that then no longer matches the live tooltip.
    if (limits.updatedAt !== undefined && now - limits.updatedAt > 10 * 60 * 1000) {
      return;
    }

    const candidates: Array<{ kind: '5h' | '7d'; percent?: number; resetsAt?: number }> = [
      { kind: '5h', percent: limits.fiveHourUsedPercentage, resetsAt: limits.fiveHourResetsAt },
      { kind: '7d', percent: limits.sevenDayUsedPercentage, resetsAt: limits.sevenDayResetsAt },
    ];

    for (const candidate of candidates) {
      if (candidate.percent === undefined || candidate.percent < HIGH_USAGE_THRESHOLD) {
        continue;
      }

      // Dedup per reset window, bucketed to the hour: the endpoint jitters resets_at by
      // sub-second amounts between fetches, so keying on the exact value re-fired the warning on
      // every poll. One warning per kind per reset window.
      const bucket = candidate.resetsAt !== undefined
        ? Math.floor(candidate.resetsAt / (60 * 60 * 1000))
        : `now-${Math.floor(now / (60 * 60 * 1000))}`;
      const key = `${candidate.kind}:${bucket}`;
      if (highUsageNotified.has(key)) {
        continue;
      }

      highUsageNotified.add(key);
      const resetText = formatResetCoarse(candidate.resetsAt !== undefined ? candidate.resetsAt - now : undefined);
      void vscode.window.showWarningMessage(
        candidate.kind === '5h'
          ? vscode.l10n.t('5h usage at {0}%. Resets in {1}.', formatPercent(candidate.percent), resetText)
          : vscode.l10n.t('7d usage at {0}%. Resets in {1}.', formatPercent(candidate.percent), resetText),
      );
      return;
    }
  };

  const maybeNotify = (snapshot: TtlSnapshot): void => {
    maybeNotifyHighUsage(snapshot);

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
    const subscriptionEnabled = readSubscriptionConfig().enabled;

    type Action = 'advisor' | 'connect' | 'disconnect' | 'refresh';
    const options: Array<vscode.QuickPickItem & { mode?: TtlMode; action?: Action }> = [
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

    if (subscriptionEnabled) {
      options.push(
        {
          label: `$(dashboard) ${vscode.l10n.t('Refresh usage now')}`,
          description: snapshot.rateLimits?.source === 'subscription'
            ? `5h ${formatPercent(snapshot.rateLimits.fiveHourUsedPercentage)}% | 7d ${formatPercent(snapshot.rateLimits.sevenDayUsedPercentage)}%`
            : undefined,
          action: 'refresh',
        },
        {
          label: `$(debug-disconnect) ${vscode.l10n.t('Disconnect subscription usage')}`,
          action: 'disconnect',
        },
      );
    } else {
      options.push({
        label: `$(plug) ${vscode.l10n.t('Connect subscription usage (real 5h/7d)')}`,
        description: vscode.l10n.t('One request per minute to api.anthropic.com with the Claude login already on this machine'),
        action: 'connect',
      });
    }

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: vscode.l10n.t('Claude TTL | {0} | {1}', getModeLabel(currentMode), remainingText),
    });

    if (!selected) {
      return;
    }

    switch (selected.action) {
      case 'advisor':
        await installAdvisor();
        return;
      case 'connect':
        await connectSubscriptionUsage();
        return;
      case 'disconnect':
        await disconnectSubscriptionUsage();
        return;
      case 'refresh':
        await refreshSubscriptionUsage();
        return;
      default:
        break;
    }

    if (!selected.mode || selected.mode === currentMode) {
      return;
    }

    await applyMode(selected.mode);
  });

  const installAdvisorDisposable = vscode.commands.registerCommand(INSTALL_ADVISOR_COMMAND, installAdvisor);
  const connectUsageDisposable = vscode.commands.registerCommand(CONNECT_USAGE_COMMAND, connectSubscriptionUsage);
  const disconnectUsageDisposable = vscode.commands.registerCommand(DISCONNECT_USAGE_COMMAND, disconnectSubscriptionUsage);
  const refreshUsageDisposable = vscode.commands.registerCommand(REFRESH_USAGE_COMMAND, refreshSubscriptionUsage);

  const configurationDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(CONFIG_SECTION)) {
      return;
    }

    subscriptionUsage.setPollInterval(readSubscriptionConfig().pollIntervalMs);
    void watcher.refresh().then(() => render());
  });

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
    connectUsageDisposable,
    disconnectUsageDisposable,
    refreshUsageDisposable,
    configurationDisposable,
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

  void maybeOfferSubscriptionUsage();
}

export function deactivate(): void {
  // VS Code lifecycle hook. Disposables are registered via context.subscriptions.
}
