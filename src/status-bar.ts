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

    if (presentation.expired) {
      this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      return;
    }

    if (presentation.warning) {
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    this.item.color = undefined;
    this.item.backgroundColor = undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
