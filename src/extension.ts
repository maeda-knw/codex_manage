import * as vscode from 'vscode';
import { ThreadTreeProvider } from './views/threadTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Codex Thread Manager');
  const provider = new ThreadTreeProvider();

  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider('codexThreadManager.threads', provider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh();
    }),
    vscode.commands.registerCommand('codexThreadManager.refresh', () => {
      provider.refresh();
    }),
    vscode.commands.registerCommand('codexThreadManager.pin', () => showNotImplemented('Pin thread')),
    vscode.commands.registerCommand('codexThreadManager.unpin', () => showNotImplemented('Unpin thread')),
    vscode.commands.registerCommand('codexThreadManager.rename', () => showNotImplemented('Rename thread')),
    vscode.commands.registerCommand('codexThreadManager.archive', () => showNotImplemented('Archive thread')),
    vscode.commands.registerCommand('codexThreadManager.unarchive', () => showNotImplemented('Restore thread'))
  );

  output.appendLine('Codex Thread Manager activated.');
}

export function deactivate(): void {
  // No long-lived resources are created in the Phase 1 scaffold.
}

function showNotImplemented(action: string): Thenable<void> {
  return vscode.window.showInformationMessage(`${action} will be implemented in a later MVP phase.`).then(() => undefined);
}
