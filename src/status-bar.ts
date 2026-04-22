import * as vscode from 'vscode';

import { StatusPresentation } from './status-model';

export class StatusBarController {
  private readonly item: vscode.StatusBarItem;

  constructor(commandId: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = commandId;
    this.item.show();
  }

  render(presentation: StatusPresentation): void {
    this.item.text = presentation.text;
    this.item.tooltip = presentation.tooltip;

    switch (presentation.visualState) {
      case 'error':
      case 'expired':
        this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        return;
      case 'warning':
        this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        return;
      case 'turn_usage':
        this.item.color = '#ffffff';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        return;
      case 'rate_limit':
        this.item.color = '#ffffff';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        return;
      case 'countdown':
      default:
        break;
    }

    const ratio = presentation.remainingRatio;
    if (ratio !== undefined && ratio <= 0.1) {
      this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (ratio !== undefined && ratio <= 0.2) {
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (ratio !== undefined && ratio <= 0.5) {
      this.item.color = '#e0a030';
      this.item.backgroundColor = undefined;
    } else {
      this.item.color = '#4ec95e';
      this.item.backgroundColor = undefined;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
