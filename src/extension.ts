import * as vscode from 'vscode';
import { AppServerClient } from './codex/appServerClient';
import type { ThreadListParams } from './codex/protocol/generated/v2/ThreadListParams';
import { AppServerError } from './common/errors';
import { ThreadTreeProvider } from './views/threadTreeProvider';

let activeClient: AppServerClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Codex Thread Manager');
  const provider = new ThreadTreeProvider();
  let probeGeneration = 0;

  const createClient = (): AppServerClient => {
    const configuredPath = vscode.workspace
      .getConfiguration('codexThreadManager')
      .get<string>('codexPath', 'codex')
      .trim();
    const client = new AppServerClient({
      codexPath: configuredPath || 'codex',
      clientVersion: String(context.extension.packageJSON.version),
      logger: output
    });
    client.onNotification((notification) => {
      output.appendLine(`[app-server] Notification: ${notification.method}`);
    });
    client.onDidDisconnect((error) => {
      if (client !== activeClient) {
        return;
      }

      probeGeneration += 1;
      provider.setConnectionStatus({ kind: 'error', message: connectionErrorMessage(error) });
    });
    return client;
  };

  const replaceClient = (): AppServerClient => {
    probeGeneration += 1;
    activeClient?.dispose();
    activeClient = createClient();
    return activeClient;
  };

  const refreshThreads = async (notifyOnError: boolean): Promise<void> => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      probeGeneration += 1;
      provider.setConnectionStatus({ kind: 'idle' });
      return;
    }

    const client = activeClient ?? replaceClient();
    const generation = ++probeGeneration;
    provider.setConnectionStatus({ kind: 'connecting' });

    const configuredPageSize = vscode.workspace
      .getConfiguration('codexThreadManager')
      .get<number>('pageSize', 50);
    const params: ThreadListParams = {
      limit: Math.min(200, Math.max(1, configuredPageSize)),
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      cwd: workspaceFolders.map((folder) => folder.uri.fsPath)
    };

    try {
      const page = await client.listThreads(params);
      if (generation !== probeGeneration || client !== activeClient) {
        return;
      }

      provider.setConnectionStatus({
        kind: 'ready',
        pageCount: page.data.length,
        hasMore: page.nextCursor !== null
      });
      output.appendLine(
        `[thread/list] Read ${page.data.length} thread metadata record(s); hasMore=${String(page.nextCursor !== null)}.`
      );
    } catch (error) {
      if (generation !== probeGeneration || client !== activeClient) {
        return;
      }

      const message = connectionErrorMessage(error);
      provider.setConnectionStatus({ kind: 'error', message });
      output.appendLine(`[connection] ${message}`);
      if (notifyOnError) {
        await showConnectionError(error, refreshThreads);
      }
    }
  };

  activeClient = createClient();

  context.subscriptions.push(
    output,
    { dispose: () => activeClient?.dispose() },
    vscode.window.registerTreeDataProvider('codexThreadManager.threads', provider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshThreads(false);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexThreadManager.codexPath')) {
        replaceClient();
      }
      if (
        event.affectsConfiguration('codexThreadManager.codexPath') ||
        event.affectsConfiguration('codexThreadManager.pageSize')
      ) {
        void refreshThreads(false);
      }
    }),
    vscode.commands.registerCommand('codexThreadManager.refresh', () => refreshThreads(true)),
    vscode.commands.registerCommand('codexThreadManager.pin', () => showNotImplemented('Pin thread')),
    vscode.commands.registerCommand('codexThreadManager.unpin', () => showNotImplemented('Unpin thread')),
    vscode.commands.registerCommand('codexThreadManager.rename', () => showNotImplemented('Rename thread')),
    vscode.commands.registerCommand('codexThreadManager.archive', () => showNotImplemented('Archive thread')),
    vscode.commands.registerCommand('codexThreadManager.unarchive', () => showNotImplemented('Restore thread'))
  );

  output.appendLine('Codex Thread Manager activated.');
  void refreshThreads(true);
}

export function deactivate(): void {
  activeClient?.dispose();
  activeClient = undefined;
}

function showNotImplemented(action: string): Thenable<void> {
  return vscode.window.showInformationMessage(`${action} will be implemented in a later MVP phase.`).then(() => undefined);
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof AppServerError) {
    switch (error.code) {
      case 'cli-not-found':
        return 'Codex CLI was not found. Check the codexPath setting.';
      case 'request-timeout':
        return 'Codex App Server did not respond before the request timed out.';
      case 'request-failed':
        return 'Codex App Server rejected the request. See the output log for details.';
      case 'protocol-error':
        return 'Codex App Server returned an incompatible response.';
      case 'incompatible-cli':
        return `${error.message} Update Codex CLI or choose another CLI in the codexPath setting, then retry.`;
      case 'connection-closed':
      case 'process-start-failed':
      case 'disposed':
        return error.message;
    }
  }

  return error instanceof Error ? error.message : 'An unknown Codex App Server error occurred.';
}

async function showConnectionError(
  error: unknown,
  retry: (notifyOnError: boolean) => Promise<void>
): Promise<void> {
  const openSettings = error instanceof AppServerError &&
    (error.code === 'cli-not-found' || error.code === 'incompatible-cli');
  const actions = openSettings ? ['Open Settings', 'Retry'] : ['Retry'];
  const selection = await vscode.window.showErrorMessage(
    `Codex Thread Manager: ${connectionErrorMessage(error)}`,
    ...actions
  );

  if (selection === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codexThreadManager.codexPath');
  } else if (selection === 'Retry') {
    await retry(true);
  }
}
