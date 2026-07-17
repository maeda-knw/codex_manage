import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Thread } from '../codex/protocol/generated/v2/Thread';
import type { ThreadPageState, ThreadRepositorySnapshot } from '../codex/threadRepository';
import { asError } from '../common/errors';
import { conversationErrorMessage } from '../conversation/conversationPanelManager';
import { toConversationViewModel } from '../conversation/conversationViewModel';
import {
  isThreadsWebviewMessage,
  restoreThreadsWebviewState,
  type ThreadListAction,
  type ThreadListPageViewModel,
  type ThreadListSnapshotViewModel,
  type ThreadsHostToWebviewMessage
} from '../webview/threads/protocol';
import type { ConnectionStatus } from './threadTreeProvider';

const ACTION_COMMANDS: Readonly<Record<ThreadListAction, string>> = {
  loadMoreActive: 'codexThreadManager.loadMoreActive',
  loadMoreArchive: 'codexThreadManager.loadMoreArchive',
  pin: 'codexThreadManager.pin',
  unpin: 'codexThreadManager.unpin',
  rename: 'codexThreadManager.rename',
  archive: 'codexThreadManager.archive',
  unarchive: 'codexThreadManager.unarchive'
};

export interface ThreadListWebviewLogger {
  appendLine(value: string): void;
}

export interface ThreadListWebviewProviderOptions {
  readonly extensionUri: vscode.Uri;
  readonly readThread: (threadId: string) => Promise<Thread>;
  readonly logger: ThreadListWebviewLogger;
}

export class ThreadListWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly viewDisposables: vscode.Disposable[] = [];
  private snapshot: ThreadRepositorySnapshot = {
    pinned: { threads: [], nextCursor: null, loaded: true },
    active: { threads: [], nextCursor: null, loaded: false },
    archive: { threads: [], nextCursor: null, loaded: false }
  };
  private status: ConnectionStatus = { kind: 'idle' };
  private activeThread: { readonly id: string; readonly title: string } | undefined;
  private pendingRestoreThreadId: string | undefined;
  private viewReady = false;
  private generation = 0;
  private disposed = false;

  public constructor(private readonly options: ThreadListWebviewProviderOptions) {}

  public resolveWebviewView(
    view: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext<unknown>
  ): void {
    this.disposeViewListeners();
    this.generation += 1;
    this.activeThread = undefined;
    this.viewReady = false;
    this.disposed = false;
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      enableForms: false,
      enableCommandUris: false,
      localResourceRoots: [webviewRoot(this.options.extensionUri)]
    };
    view.webview.html = this.html(view.webview);

    const restoredState = restoreThreadsWebviewState(context.state);
    this.pendingRestoreThreadId = restoredState.screen === 'conversation'
      ? restoredState.selectedThreadId ?? undefined
      : undefined;

    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isThreadsWebviewMessage(message)) {
          this.options.logger.appendLine('[threads] Ignored an invalid Webview message.');
          return;
        }
        switch (message.type) {
          case 'threads/ready':
            this.viewReady = true;
            if (this.activeThread) {
              this.openConversation(this.activeThread.id);
            } else if (!this.resolvePendingRestore()) {
              this.showList();
            }
            return;
          case 'threads/open':
            this.openConversation(message.threadId);
            return;
          case 'threads/back':
            this.showList();
            return;
          case 'threads/reload':
            if (this.activeThread) {
              this.openConversation(this.activeThread.id);
            }
            return;
          case 'threads/action':
            this.executeAction(message.action, message.threadId);
        }
      }),
      view.onDidDispose(() => {
        if (this.view !== view) {
          return;
        }
        this.generation += 1;
        this.activeThread = undefined;
        this.pendingRestoreThreadId = undefined;
        this.viewReady = false;
        this.view = undefined;
        this.disposeViewListeners();
      })
    );
  }

  public setSnapshot(snapshot: ThreadRepositorySnapshot): void {
    this.snapshot = snapshot;
    if (!this.resolvePendingRestore() && !this.activeThread) {
      this.postListState();
    }
  }

  public setConnectionStatus(status: ConnectionStatus): void {
    this.status = status;
    if (!this.resolvePendingRestore() && !this.activeThread) {
      this.postListState();
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.activeThread = undefined;
    this.pendingRestoreThreadId = undefined;
    this.viewReady = false;
    this.view = undefined;
    this.disposeViewListeners();
  }

  private showList(): void {
    this.generation += 1;
    this.activeThread = undefined;
    this.pendingRestoreThreadId = undefined;
    this.post({ type: 'threads/showList' });
    this.postListState();
  }

  private openConversation(threadId: string): void {
    const reference = this.findThread(threadId);
    if (this.disposed || !this.view) {
      this.options.logger.appendLine(`[threads] Ignored conversation request for unknown thread ${threadId}.`);
      return;
    }
    if (!reference) {
      this.options.logger.appendLine(`[threads] Returned to the list after an unknown thread request for ${threadId}.`);
      this.showList();
      return;
    }

    const generation = ++this.generation;
    this.activeThread = { id: reference.id, title: reference.title };
    this.post({
      type: 'threads/conversationLoading',
      threadId: reference.id,
      title: reference.title
    });

    void this.options.readThread(reference.id).then(
      (thread) => {
        if (!this.isCurrentConversation(generation, reference.id)) {
          return;
        }
        const model = toConversationViewModel(thread);
        if (model.threadId !== reference.id) {
          this.options.logger.appendLine(
            `[threads] Ignored mismatched sidebar history ${model.threadId} for ${reference.id}.`
          );
          this.post({
            type: 'threads/conversationError',
            threadId: reference.id,
            title: reference.title,
            message: 'This Codex CLI returned an incompatible conversation history response.'
          });
          return;
        }
        this.activeThread = { id: model.threadId, title: model.title };
        this.post({ type: 'threads/conversationLoaded', model });
        this.options.logger.appendLine(
          `[threads] Loaded ${model.turns.length} turn(s) for sidebar thread ${model.threadId}.`
        );
      },
      (error: unknown) => {
        if (!this.isCurrentConversation(generation, reference.id)) {
          return;
        }
        this.options.logger.appendLine(
          `[threads] Could not load sidebar thread ${reference.id}: ${asError(error).message}`
        );
        this.post({
          type: 'threads/conversationError',
          threadId: reference.id,
          title: reference.title,
          message: conversationErrorMessage(error)
        });
      }
    );
  }

  private executeAction(action: ThreadListAction, threadId?: string): void {
    const command = ACTION_COMMANDS[action];
    if (threadId && !this.findThread(threadId)) {
      this.options.logger.appendLine(
        `[threads] Ignored ${action} request for unknown thread ${threadId}.`
      );
      return;
    }
    const execution = threadId
      ? vscode.commands.executeCommand(command, threadId)
      : vscode.commands.executeCommand(command);
    void execution.then(undefined, (error: unknown) => {
      this.options.logger.appendLine(
        `[threads] Command ${command} failed: ${asError(error).message}`
      );
    });
  }

  private resolvePendingRestore(): boolean {
    const threadId = this.pendingRestoreThreadId;
    if (!threadId || !this.viewReady || !this.view) {
      return false;
    }
    if (this.findThread(threadId)) {
      this.pendingRestoreThreadId = undefined;
      this.openConversation(threadId);
      return true;
    }
    if (
      !vscode.workspace.workspaceFolders?.length ||
      this.status.kind === 'error' ||
      (this.snapshot.active.loaded && this.snapshot.archive.loaded)
    ) {
      this.showList();
      return true;
    }
    this.postListState();
    return true;
  }

  private isCurrentConversation(generation: number, threadId: string): boolean {
    return (
      !this.disposed &&
      Boolean(this.view) &&
      generation === this.generation &&
      this.activeThread?.id === threadId
    );
  }

  private findThread(threadId: string): { readonly id: string; readonly title: string } | undefined {
    for (const page of [this.snapshot.pinned, this.snapshot.active, this.snapshot.archive]) {
      const thread = page.threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        return { id: thread.id, title: thread.title };
      }
    }
    return undefined;
  }

  private postListState(): void {
    this.post({
      type: 'threads/listState',
      snapshot: toListSnapshot(this.snapshot),
      status: this.status,
      hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length)
    });
  }

  private post(message: ThreadsHostToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const root = webviewRoot(this.options.extensionUri);
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'threads.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'threads.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
  >
  <link rel="stylesheet" href="${escapeAttribute(style.toString())}">
  <title>Codex Threads</title>
</head>
<body>
  <main id="app" aria-live="polite" aria-busy="true">Loading threads…</main>
  <script nonce="${nonce}" src="${escapeAttribute(script.toString())}"></script>
</body>
</html>`;
  }

  private disposeViewListeners(): void {
    while (this.viewDisposables.length > 0) {
      this.viewDisposables.pop()?.dispose();
    }
  }
}

function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
}

function toListSnapshot(snapshot: ThreadRepositorySnapshot): ThreadListSnapshotViewModel {
  return {
    pinned: toListPage(snapshot.pinned),
    active: toListPage(snapshot.active),
    archive: toListPage(snapshot.archive)
  };
}

function toListPage(page: ThreadPageState): ThreadListPageViewModel {
  return {
    threads: page.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      description: thread.description,
      statusLabel: thread.statusLabel,
      pinned: thread.pinned,
      archived: thread.archived
    })),
    nextCursor: page.nextCursor,
    loaded: page.loaded
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}
