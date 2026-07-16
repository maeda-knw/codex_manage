import * as vscode from 'vscode';
import { AppServerClient } from './codex/appServerClient';
import { ThreadRepository } from './codex/threadRepository';
import { AppServerError } from './common/errors';
import { PinStore } from './state/pinStore';
import { ThreadTreeItem, ThreadTreeProvider } from './views/threadTreeProvider';

let activeClient: AppServerClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Codex Thread Manager');
  const provider = new ThreadTreeProvider();
  const pinStore = new PinStore(context.workspaceState);
  let probeGeneration = 0;
  let repository: ThreadRepository | undefined;

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
      if (repository?.handleThreadNotification(notification.method, notification.params)) {
        repository.setPinnedThreadIds(pinStore.getPinnedThreadIds());
        provider.setSnapshot(repository.snapshot());
      }
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
    repository = new ThreadRepository(activeClient);
    repository.setPinnedThreadIds(pinStore.getPinnedThreadIds());
    provider.setSnapshot(repository.snapshot());
    return activeClient;
  };

  const refreshThreads = async (notifyOnError: boolean): Promise<void> => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      probeGeneration += 1;
      provider.setConnectionStatus({ kind: 'idle' });
      repository?.reset();
      if (repository) {
        provider.setSnapshot(repository.snapshot());
      }
      return;
    }

    const client = activeClient ?? replaceClient();
    const repo = repository ?? new ThreadRepository(client);
    repository = repo;
    repo.setPinnedThreadIds(pinStore.getPinnedThreadIds());
    const generation = ++probeGeneration;
    provider.setConnectionStatus({ kind: 'connecting' });

    const pageSize = getPageSize();

    try {
      const activePage = await repo.refreshActive(workspaceFolders, pageSize);
      const archivePage = await repo.refreshArchive(workspaceFolders, pageSize);
      if (generation !== probeGeneration || client !== activeClient) {
        return;
      }

      await pruneLoadedPins(pinStore, repo);
      repo.setPinnedThreadIds(pinStore.getPinnedThreadIds());
      provider.setSnapshot(repo.snapshot());
      provider.setConnectionStatus({ kind: 'ready' });
      output.appendLine(
        `[thread/list] Read ${activePage.threads.length} active and ${archivePage.threads.length} archived thread metadata record(s).`
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


  const loadMoreThreads = async (group: 'active' | 'archive'): Promise<void> => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length || !repository) {
      return;
    }
    const generation = ++probeGeneration;
    try {
      if (group === 'active') {
        await repository.loadMoreActive(workspaceFolders, getPageSize());
      } else {
        await repository.loadMoreArchive(workspaceFolders, getPageSize());
      }
      if (generation !== probeGeneration) {
        return;
      }
      provider.setSnapshot(repository.snapshot());
      provider.setConnectionStatus({ kind: 'ready' });
    } catch (error) {
      if (generation !== probeGeneration) {
        return;
      }
      const message = connectionErrorMessage(error);
      provider.setConnectionStatus({ kind: 'error', message });
      output.appendLine(`[thread/list] ${message}`);
      await showConnectionError(error, refreshThreads);
    }
  };

  activeClient = createClient();
  repository = new ThreadRepository(activeClient);
  repository.setPinnedThreadIds(pinStore.getPinnedThreadIds());

  context.subscriptions.push(
    output,
    provider,
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
    vscode.commands.registerCommand('codexThreadManager.loadMoreActive', () => loadMoreThreads('active')),
    vscode.commands.registerCommand('codexThreadManager.loadMoreArchive', () => loadMoreThreads('archive')),
    vscode.commands.registerCommand('codexThreadManager.pin', (item?: ThreadTreeItem) => pinThread(item, pinStore, repository, provider)),
    vscode.commands.registerCommand('codexThreadManager.unpin', (item?: ThreadTreeItem) => unpinThread(item, pinStore, repository, provider)),
    vscode.commands.registerCommand('codexThreadManager.rename', (item?: ThreadTreeItem) => renameThread(item, repository, provider)),
    vscode.commands.registerCommand('codexThreadManager.archive', (item?: ThreadTreeItem) => archiveThread(item, pinStore, repository, provider)),
    vscode.commands.registerCommand('codexThreadManager.unarchive', (item?: ThreadTreeItem) => unarchiveThread(item, repository, provider))
  );

  output.appendLine('Codex Thread Manager activated.');
  void refreshThreads(true);
}

export function deactivate(): void {
  activeClient?.dispose();
  activeClient = undefined;
}

async function pinThread(
  item: ThreadTreeItem | undefined,
  pinStore: PinStore,
  repository: ThreadRepository | undefined,
  provider: ThreadTreeProvider
): Promise<void> {
  const thread = item?.thread;
  if (!thread || thread.archived) {
    await vscode.window.showWarningMessage('Select an active Codex thread to pin.');
    return;
  }
  await pinStore.pin(thread.id);
  repository?.setPinnedThreadIds(pinStore.getPinnedThreadIds());
  if (repository) {
    provider.setSnapshot(repository.snapshot());
  }
}

async function unpinThread(
  item: ThreadTreeItem | undefined,
  pinStore: PinStore,
  repository: ThreadRepository | undefined,
  provider: ThreadTreeProvider
): Promise<void> {
  const thread = item?.thread;
  if (!thread) {
    await vscode.window.showWarningMessage('Select a pinned Codex thread to unpin.');
    return;
  }
  await pinStore.unpin(thread.id);
  repository?.setPinnedThreadIds(pinStore.getPinnedThreadIds());
  if (repository) {
    provider.setSnapshot(repository.snapshot());
  }
}

async function pruneLoadedPins(pinStore: PinStore, repository: ThreadRepository): Promise<void> {
  const snapshot = repository.snapshot();
  if (snapshot.active.nextCursor || snapshot.archive.nextCursor) {
    return;
  }
  await pinStore.pruneExistingThreadIds([
    ...snapshot.pinned.threads.map((thread) => thread.id),
    ...snapshot.active.threads.map((thread) => thread.id)
  ]);
}


async function renameThread(
  item: ThreadTreeItem | undefined,
  repository: ThreadRepository | undefined,
  provider: ThreadTreeProvider
): Promise<void> {
  const thread = item?.thread;
  if (!thread || thread.archived || !repository) {
    await vscode.window.showWarningMessage('Select an active Codex thread to rename.');
    return;
  }
  if (repository.isOperationPending(thread.id)) {
    await vscode.window.showWarningMessage('A Codex operation is already running for this thread.');
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'Rename Codex Thread',
    prompt: 'Enter a new thread name.',
    value: thread.title,
    validateInput: (value) => value.trim() ? undefined : 'Thread name cannot be empty.'
  });
  if (name === undefined) {
    return;
  }
  const trimmedName = name.trim();
  if (!trimmedName) {
    await vscode.window.showWarningMessage('Thread name cannot be empty.');
    return;
  }
  try {
    await repository.renameThread(thread.id, trimmedName);
    provider.setSnapshot(repository.snapshot());
  } catch (error) {
    await showOperationError('rename the thread', error);
  }
}

async function archiveThread(
  item: ThreadTreeItem | undefined,
  pinStore: PinStore,
  repository: ThreadRepository | undefined,
  provider: ThreadTreeProvider
): Promise<void> {
  const thread = item?.thread;
  if (!thread || thread.archived || !repository) {
    await vscode.window.showWarningMessage('Select an active Codex thread to archive.');
    return;
  }
  if (repository.isOperationPending(thread.id)) {
    await vscode.window.showWarningMessage('A Codex operation is already running for this thread.');
    return;
  }
  try {
    await repository.archiveThread(thread.id);
    await pinStore.unpin(thread.id);
    repository.setPinnedThreadIds(pinStore.getPinnedThreadIds());
    provider.setSnapshot(repository.snapshot());
    const selection = await vscode.window.showInformationMessage(`Archived “${thread.title}”.`, 'Undo');
    if (selection === 'Undo') {
      await repository.unarchiveThread(thread.id);
      provider.setSnapshot(repository.snapshot());
    }
  } catch (error) {
    await showOperationError('archive the thread', error);
  }
}

async function unarchiveThread(
  item: ThreadTreeItem | undefined,
  repository: ThreadRepository | undefined,
  provider: ThreadTreeProvider
): Promise<void> {
  const thread = item?.thread;
  if (!thread || !thread.archived || !repository) {
    await vscode.window.showWarningMessage('Select an archived Codex thread to restore.');
    return;
  }
  if (repository.isOperationPending(thread.id)) {
    await vscode.window.showWarningMessage('A Codex operation is already running for this thread.');
    return;
  }
  try {
    await repository.unarchiveThread(thread.id);
    provider.setSnapshot(repository.snapshot());
  } catch (error) {
    await showOperationError('restore the thread', error);
  }
}

async function showOperationError(action: string, error: unknown): Promise<void> {
  await vscode.window.showErrorMessage(`Codex Thread Manager could not ${action}: ${connectionErrorMessage(error)}`);
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


function getPageSize(): number {
  const configuredPageSize = vscode.workspace
    .getConfiguration('codexThreadManager')
    .get<number>('pageSize', 50);
  return Math.min(200, Math.max(1, configuredPageSize));
}
