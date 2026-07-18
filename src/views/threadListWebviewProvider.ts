import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { AppServerNotification, AppServerRequest } from '../codex/appServerClient';
import {
  isJsonObject,
  parseConversationNotification,
  type ConversationNotification
} from '../codex/protocol/guards';
import type { ThreadPageState, ThreadRepositorySnapshot } from '../codex/threadRepository';
import { asError } from '../common/errors';
import { conversationErrorMessage } from '../conversation/conversationPanelManager';
import {
  buildConversationInteractionResponse,
  parseConversationInteraction,
  type ConversationInteractionReply,
  type ParsedConversationInteraction
} from '../conversation/conversationInteraction';
import {
  ConversationSession,
  type ConversationSessionClient,
  type ConversationSessionSnapshot
} from '../conversation/conversationSession';
import {
  isThreadsWebviewMessage,
  restoreThreadsWebviewState,
  type ConversationExecutionViewModel,
  type ConversationOperation,
  type ConversationScreenState,
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
  readonly conversationClient: ConversationSessionClient;
  readonly respondToServerRequest?: (id: AppServerRequest['id'], result: unknown) => Promise<boolean>;
  readonly logger: ThreadListWebviewLogger;
}

interface PendingConversationLoad {
  readonly generation: number;
  readonly sessionId: string;
  readonly threadId: string;
  readonly notifications: ConversationNotification[];
  overflowed: boolean;
  malformed: boolean;
}

interface PendingConversationPost {
  readonly generation: number;
  readonly sessionId: string;
  readonly threadId: string;
  readonly session: ConversationSession;
  readonly snapshot: ConversationSessionSnapshot;
}

const MAX_BUFFERED_CONVERSATION_NOTIFICATIONS = 512;
const CONVERSATION_POST_INTERVAL_MS = 16;

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
  private readonly conversationSessions = new Map<string, ConversationSession>();
  private readonly interactions = new Map<string, ParsedConversationInteraction>();
  private conversationSession: ConversationSession | undefined;
  private conversationSessionId: string | undefined;
  private conversationSubscription: { dispose(): void } | undefined;
  private pendingConversationLoad: PendingConversationLoad | undefined;
  private pendingConversationPost: PendingConversationPost | undefined;
  private conversationPostTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRestoreThreadId: string | undefined;
  private viewReady = false;
  private generation = 0;
  private conversationViewRevision = 0;
  private disposed = false;

  public constructor(private readonly options: ThreadListWebviewProviderOptions) {}

  public resolveWebviewView(
    view: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext<unknown>
  ): void {
    this.disposeViewListeners();
    this.clearConversationSession();
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
              this.reloadConversation();
            }
            return;
          case 'threads/conversation/send':
            this.runConversationOperation(
              'send',
              message.sessionId,
              message.threadId,
              message.requestId,
              message.text
            );
            return;
          case 'threads/conversation/stop':
            this.runConversationOperation(
              'stop',
              message.sessionId,
              message.threadId,
              message.requestId
            );
            return;
          case 'threads/conversation/settings':
            this.updateConversationSettings(message.sessionId, message.threadId, message.settings);
            return;
          case 'threads/conversation/interaction':
            this.respondToInteraction(
              message.sessionId,
              message.threadId,
              message.interactionId,
              message.reply
            );
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
        this.clearConversationSession();
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
    for (const [threadId, session] of this.conversationSessions) {
      const reference = this.findThread(threadId);
      if (reference) {
        session.updateTitle(reference.title);
      }
    }
    if (!this.resolvePendingRestore() && !this.activeThread) {
      this.postListState();
    }
  }

  public setConnectionStatus(status: ConnectionStatus): void {
    const previousStatus = this.status;
    this.status = status;
    if (status.kind === 'error') {
      for (const session of this.conversationSessions.values()) {
        session.markDisconnected();
      }
    }
    if (this.conversationSession) {
      if (
        status.kind === 'ready' &&
        (previousStatus.kind === 'error' || this.conversationSession.snapshot().sync !== 'ready')
      ) {
        this.resyncConversation();
      }
    }
    if (!this.resolvePendingRestore() && !this.activeThread) {
      this.postListState();
    }
  }

  public handleNotification(notification: AppServerNotification): void {
    if (notification.method === 'serverRequest/resolved' && isJsonObject(notification.params)) {
      const resolvedId = notification.params.requestId;
      for (const [id, interaction] of this.interactions) {
        if (interaction.requestId === resolvedId) {
          this.interactions.delete(id);
          this.postCurrentConversationState();
          break;
        }
      }
    }
    const threadId = isJsonObject(notification.params) &&
      typeof notification.params.threadId === 'string'
      ? notification.params.threadId
      : undefined;

    try {
      const parsed = parseConversationNotification(notification.method, notification.params);
      if (!parsed) {
        return;
      }
      const session = this.conversationSessions.get(parsed.params.threadId);
      if (session) {
        session.applyNotification(parsed);
        return;
      }
      const pending = this.pendingConversationLoad;
      if (pending?.threadId === parsed.params.threadId) {
        if (pending.notifications.length < MAX_BUFFERED_CONVERSATION_NOTIFICATIONS) {
          pending.notifications.push(parsed);
        } else {
          pending.overflowed = true;
        }
      }
    } catch (error) {
      this.options.logger.appendLine(
        `[threads] Ignored malformed ${notification.method} notification: ${asError(error).message}`
      );
      if (threadId) {
        this.conversationSessions.get(threadId)?.markDisconnected();
        if (this.pendingConversationLoad?.threadId === threadId) {
          this.pendingConversationLoad.malformed = true;
        }
      }
    }
  }

  public handleServerRequest(request: AppServerRequest): void {
    const interactionId = randomUUID();
    const interaction = parseConversationInteraction(request.id, interactionId, request.method, request.params);
    if (!interaction) {
      this.options.logger.appendLine(`[threads] Rejected malformed or unsupported server request ${request.method}.`);
      void this.respondToServerRequest(request.id, cancellationResponse(request.method));
      return;
    }
    this.interactions.set(interactionId, interaction);
    this.options.logger.appendLine(`[threads] Received ${request.method} for thread ${interaction.threadId}.`);
    this.postCurrentConversationState();
  }

  public markConversationDisconnected(): void {
    this.interactions.clear();
    for (const session of this.conversationSessions.values()) {
      session.markDisconnected();
    }
    this.postCurrentConversationState();
  }

  public resetWorkspace(): void {
    this.generation += 1;
    this.clearConversationSession();
    this.disposeConversationSessions();
    this.activeThread = undefined;
    this.pendingRestoreThreadId = undefined;
    this.interactions.clear();
    this.snapshot = {
      pinned: { threads: [], nextCursor: null, loaded: true },
      active: { threads: [], nextCursor: null, loaded: false },
      archive: { threads: [], nextCursor: null, loaded: false }
    };
    this.post({ type: 'threads/showList' });
    this.postListState();
  }

  public dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearConversationSession();
    this.disposeConversationSessions();
    this.activeThread = undefined;
    this.pendingRestoreThreadId = undefined;
    this.interactions.clear();
    this.viewReady = false;
    this.view = undefined;
    this.disposeViewListeners();
  }

  private showList(): void {
    this.generation += 1;
    this.clearConversationSession();
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

    this.clearConversationSession();
    const generation = ++this.generation;
    const sessionId = randomUUID();
    this.conversationSessionId = sessionId;
    this.activeThread = { id: reference.id, title: reference.title };
    this.post({
      type: 'threads/conversationLoading',
      sessionId,
      threadId: reference.id,
      title: reference.title
    });

    const existing = this.conversationSessions.get(reference.id);
    if (existing) {
      this.attachConversationSession(existing, generation, sessionId, reference);
      if (this.status.kind === 'ready' && existing.snapshot().sync !== 'ready') {
        this.resyncConversation();
      }
      return;
    }

    const pendingLoad: PendingConversationLoad = {
      generation,
      sessionId,
      threadId: reference.id,
      notifications: [],
      overflowed: false,
      malformed: false
    };
    this.pendingConversationLoad = pendingLoad;

    void this.options.conversationClient.readThread({
      threadId: reference.id,
      includeTurns: true
    }).then(
      ({ thread }) => {
        if (
          !this.isCurrentConversation(generation, reference.id, sessionId) ||
          this.pendingConversationLoad !== pendingLoad
        ) {
          return;
        }
        if (thread.id !== reference.id) {
          this.pendingConversationLoad = undefined;
          this.options.logger.appendLine(
            `[threads] Ignored mismatched sidebar history ${thread.id} for ${reference.id}.`
          );
          this.post({
            type: 'threads/conversationError',
            sessionId,
            threadId: reference.id,
            title: reference.title,
            message: 'This Codex CLI returned an incompatible conversation history response.'
          });
          return;
        }

        const session = new ConversationSession(this.options.conversationClient, thread);
        for (const buffered of pendingLoad.notifications) {
          session.applyNotification(buffered);
        }
        if (pendingLoad.overflowed || pendingLoad.malformed) {
          session.markDisconnected();
          this.options.logger.appendLine(
            `[threads] Sidebar thread ${reference.id} requires reload after notification buffering.`
          );
        }
        this.pendingConversationLoad = undefined;
        this.conversationSessions.set(reference.id, session);
        this.attachConversationSession(session, generation, sessionId, reference);
        void session.loadRuntimeSettings();
      },
      (error: unknown) => {
        if (
          !this.isCurrentConversation(generation, reference.id, sessionId) ||
          this.pendingConversationLoad !== pendingLoad
        ) {
          return;
        }
        this.pendingConversationLoad = undefined;
        this.options.logger.appendLine(
          `[threads] Could not load sidebar thread ${reference.id}: ${asError(error).message}`
        );
        this.post({
          type: 'threads/conversationError',
          sessionId,
          threadId: reference.id,
          title: reference.title,
          message: conversationErrorMessage(error)
        });
      }
    );
  }

  private attachConversationSession(
    session: ConversationSession,
    generation: number,
    sessionId: string,
    reference: { readonly id: string; readonly title: string }
  ): void {
    let initialSnapshot: ConversationSessionSnapshot | undefined;
    let loaded = false;
    this.conversationSession = session;
    this.conversationSubscription = session.subscribe((snapshot) => {
      if (!loaded) {
        initialSnapshot = snapshot;
        return;
      }
      if (
        this.isCurrentConversation(generation, reference.id, sessionId) &&
        this.conversationSession === session
      ) {
        this.queueConversationStatePost({
          generation,
          sessionId,
          threadId: reference.id,
          session,
          snapshot
        });
      }
    });
    const snapshot = initialSnapshot ?? session.snapshot();
    this.activeThread = { id: snapshot.model.threadId, title: snapshot.model.title };
    loaded = true;
    this.post({
      type: 'threads/conversationLoaded',
      state: this.toConversationScreenState(sessionId, snapshot)
    });
    this.options.logger.appendLine(
      `[threads] Loaded ${snapshot.model.turns.length} turn(s) for sidebar thread ${snapshot.model.threadId}.`
    );
  }

  private reloadConversation(): void {
    if (!this.conversationSession) {
      if (this.activeThread) {
        this.openConversation(this.activeThread.id);
      }
      return;
    }
    this.resyncConversation();
  }

  private resyncConversation(): void {
    const session = this.conversationSession;
    const sessionId = this.conversationSessionId;
    const threadId = this.activeThread?.id;
    const generation = this.generation;
    if (!session || !sessionId || !threadId) {
      return;
    }

    void session.resync().then((resynced) => {
      if (!this.isCurrentConversation(generation, threadId, sessionId) || !resynced) {
        return;
      }
      this.status = { kind: 'ready' };
      this.options.logger.appendLine(`[threads] Re-synchronized sidebar thread ${threadId}.`);
    });
  }

  private runConversationOperation(
    operation: ConversationOperation,
    sessionId: string,
    threadId: string,
    requestId: string,
    text?: string
  ): void {
    const session = this.conversationSession;
    if (!session || !this.isCurrentSession(sessionId, threadId)) {
      this.options.logger.appendLine(
        `[threads] Ignored stale ${operation} request for sidebar thread ${threadId}.`
      );
      return;
    }

    const generation = this.generation;
    const result = operation === 'send'
      ? session.send(text ?? '')
      : session.stop();
    void result.then((accepted) => {
      if (!this.isCurrentConversation(generation, threadId, sessionId)) {
        return;
      }
      this.flushConversationStatePost();
      this.post(accepted
        ? {
          type: 'threads/conversationOperationResult',
          sessionId,
          threadId,
          requestId,
          operation,
          outcome: 'accepted'
        }
        : {
          type: 'threads/conversationOperationResult',
          sessionId,
          threadId,
          requestId,
          operation,
          outcome: 'rejected',
          message: operation === 'send'
            ? 'The message could not be sent. Reload the conversation and try again.'
            : 'The running turn could not be stopped. Reload the conversation and try again.'
        });
    });
  }

  private updateConversationSettings(
    sessionId: string,
    threadId: string,
    settings: Parameters<ConversationSession['updateRuntimeSettings']>[0]
  ): void {
    const session = this.conversationSession;
    if (!session || !this.isCurrentSession(sessionId, threadId)) {
      this.options.logger.appendLine(
        `[threads] Ignored stale settings request for sidebar thread ${threadId}.`
      );
      return;
    }
    if (!session.updateRuntimeSettings(settings)) {
      this.options.logger.appendLine(
        `[threads] Ignored invalid settings request for sidebar thread ${threadId}.`
      );
    }
  }

  private respondToInteraction(
    sessionId: string,
    threadId: string,
    interactionId: string,
    reply: ConversationInteractionReply
  ): void {
    if (!this.isCurrentSession(sessionId, threadId)) {
      this.options.logger.appendLine(`[threads] Ignored a stale interaction response for thread ${threadId}.`);
      return;
    }
    const interaction = this.interactions.get(interactionId);
    if (!interaction || interaction.threadId !== threadId) {
      this.options.logger.appendLine(`[threads] Ignored a response for an unknown interaction in thread ${threadId}.`);
      return;
    }
    const approvalView = interaction.view.kind === 'commandApproval' ||
      interaction.view.kind === 'fileApproval' || interaction.view.kind === 'permissionsApproval'
      ? interaction.view
      : undefined;
    if (reply.kind === 'approval' && reply.decision === 'acceptForSession' &&
      (!approvalView || !approvalView.allowSession)) {
      this.options.logger.appendLine(`[threads] Rejected an unavailable session approval for thread ${threadId}.`);
      return;
    }
    const result = buildConversationInteractionResponse(interaction, reply);
    if (result === undefined) {
      this.options.logger.appendLine(`[threads] Rejected an invalid interaction response for thread ${threadId}.`);
      return;
    }
    this.interactions.delete(interactionId);
    this.postCurrentConversationState();
    void this.respondToServerRequest(interaction.requestId, result).then((sent) => {
      if (!sent && !this.disposed) {
        this.options.logger.appendLine(`[threads] Could not send the interaction response for thread ${threadId}.`);
      }
    });
  }

  private respondToServerRequest(id: AppServerRequest['id'], result: unknown): Promise<boolean> {
    return this.options.respondToServerRequest?.(id, result) ?? Promise.resolve(false);
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

  private isCurrentConversation(
    generation: number,
    threadId: string,
    sessionId?: string
  ): boolean {
    return (
      !this.disposed &&
      Boolean(this.view) &&
      generation === this.generation &&
      this.activeThread?.id === threadId &&
      (sessionId === undefined || this.conversationSessionId === sessionId)
    );
  }

  private isCurrentSession(sessionId: string, threadId: string): boolean {
    return (
      this.conversationSessionId === sessionId &&
      this.activeThread?.id === threadId
    );
  }

  private clearConversationSession(): void {
    this.conversationSubscription?.dispose();
    this.conversationSubscription = undefined;
    this.conversationSession = undefined;
    this.conversationSessionId = undefined;
    this.pendingConversationLoad = undefined;
    this.pendingConversationPost = undefined;
    if (this.conversationPostTimer !== undefined) {
      clearTimeout(this.conversationPostTimer);
      this.conversationPostTimer = undefined;
    }
  }

  private queueConversationStatePost(pending: PendingConversationPost): void {
    this.pendingConversationPost = pending;
    if (this.conversationPostTimer !== undefined) {
      return;
    }
    this.conversationPostTimer = setTimeout(() => {
      this.conversationPostTimer = undefined;
      this.flushConversationStatePost();
    }, CONVERSATION_POST_INTERVAL_MS);
  }

  private flushConversationStatePost(): void {
    if (this.conversationPostTimer !== undefined) {
      clearTimeout(this.conversationPostTimer);
      this.conversationPostTimer = undefined;
    }
    const latest = this.pendingConversationPost;
    this.pendingConversationPost = undefined;
    if (
      !latest ||
      !this.isCurrentConversation(latest.generation, latest.threadId, latest.sessionId) ||
      this.conversationSession !== latest.session
    ) {
      return;
    }
    this.post({
      type: 'threads/conversationState',
      state: this.toConversationScreenState(latest.sessionId, latest.snapshot)
    });
  }

  private postCurrentConversationState(): void {
    const session = this.conversationSession;
    const sessionId = this.conversationSessionId;
    if (!session || !sessionId) return;
    this.post({ type: 'threads/conversationState', state: this.toConversationScreenState(sessionId, session.snapshot()) });
  }

  private toConversationScreenState(sessionId: string, snapshot: ConversationSessionSnapshot): ConversationScreenState {
    return toConversationScreenState(
      sessionId,
      snapshot,
      [...this.interactions.values()]
        .filter((interaction) => interaction.threadId === snapshot.model.threadId)
        .map((interaction) => interaction.view),
      ++this.conversationViewRevision
    );
  }

  private disposeConversationSessions(): void {
    for (const session of this.conversationSessions.values()) {
      session.dispose();
    }
    this.conversationSessions.clear();
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

function toConversationScreenState(
  sessionId: string,
  snapshot: ConversationSessionSnapshot,
  interactions: ConversationScreenState['interactions'],
  revision: number
): ConversationScreenState {
  const execution = toConversationExecution(snapshot);
  return snapshot.notice
    ? {
      sessionId,
      revision,
      model: snapshot.model,
      execution,
      runtime: snapshot.runtime,
      interactions,
      notice: snapshot.notice
    }
    : {
      sessionId,
      revision,
      model: snapshot.model,
      execution,
      runtime: snapshot.runtime,
      interactions
    };
}

function cancellationResponse(method: string): unknown {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'cancel' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'cancel', content: null, _meta: null };
  return {};
}

function toConversationExecution(
  snapshot: ConversationSessionSnapshot
): ConversationExecutionViewModel {
  if (snapshot.sync !== 'ready') {
    return {
      kind: 'unavailable',
      message: snapshot.notice ?? 'Conversation updates are unavailable until the connection is restored.'
    };
  }
  switch (snapshot.operation) {
    case 'resuming':
      return { kind: 'resuming' };
    case 'starting':
      return { kind: 'starting' };
    case 'running':
      return snapshot.activeTurnId
        ? { kind: 'running', turnId: snapshot.activeTurnId }
        : { kind: 'unavailable', message: 'The running turn is being re-synchronized.' };
    case 'interrupting':
      return snapshot.activeTurnId
        ? { kind: 'stopping', turnId: snapshot.activeTurnId }
        : { kind: 'unavailable', message: 'The running turn is being re-synchronized.' };
    case 'idle':
      return { kind: 'idle' };
  }
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
