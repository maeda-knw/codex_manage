import { randomBytes, randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, normalize } from 'node:path';
import * as vscode from 'vscode';
import type { AppServerNotification, AppServerRequest } from '../codex/appServerClient';
import {
  isJsonObject,
  parseConversationNotification,
  type ConversationNotification
} from '../codex/protocol/guards';
import type { ThreadPageState, ThreadRepositorySnapshot } from '../codex/threadRepository';
import type { Thread } from '../codex/protocol/generated/v2/Thread';
import type { Model } from '../codex/protocol/generated/v2/Model';
import type { AskForApproval } from '../codex/protocol/generated/v2/AskForApproval';
import type { ApprovalsReviewer } from '../codex/protocol/generated/v2/ApprovalsReviewer';
import type { ThreadStartParams } from '../codex/protocol/generated/v2/ThreadStartParams';
import type { ThreadStartResponse } from '../codex/protocol/generated/v2/ThreadStartResponse';
import type { ConversationConfigDefaults } from '../codex/protocol/guards';
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
  conversationRuntimeModelValue,
  createConversationRuntimeSettings,
  isConversationRuntimeUpdateValid,
  loadConversationModelCatalog,
  visibleConversationModels,
  type ConversationRuntimeSettings,
  type ConversationAdditionalInput,
  type ConversationSessionClient,
  type ConversationSessionSnapshot
} from '../conversation/conversationSession';
import {
  isThreadsWebviewMessage,
  restoreThreadsWebviewState,
  type ConversationExecutionViewModel,
  type ConversationAttachmentViewModel,
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
  readonly startThread?: (params: ThreadStartParams) => Promise<ThreadStartResponse>;
  readonly readConversationConfig?: (cwd: string) => Promise<ConversationConfigDefaults>;
  readonly onConversationCreated?: (thread: Thread) => void;
  readonly respondToServerRequest?: (id: AppServerRequest['id'], result: unknown) => Promise<boolean>;
  readonly pickLocalImages?: () => Promise<readonly PickedLocalImage[]>;
  readonly pickMentionFiles?: () => Promise<readonly PickedMentionFile[]>;
  readonly pickSkills?: (cwd: string) => Promise<readonly PickedSkill[]>;
  readonly logger: ThreadListWebviewLogger;
}

export interface PickedLocalImage {
  readonly path: string;
  readonly sizeBytes: number;
}

export interface PickedMentionFile {
  readonly path: string;
  readonly sizeBytes: number;
}

export interface PickedSkill {
  readonly name: string;
  readonly path: string;
  readonly description: string;
}

interface LocalImageAttachment {
  readonly id: string;
  readonly kind: 'localImage';
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
}

interface MentionAttachment {
  readonly id: string;
  readonly kind: 'mention';
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
}

interface SkillAttachment {
  readonly id: string;
  readonly kind: 'skill';
  readonly name: string;
  readonly path: string;
  readonly description: string;
}

type ConversationAttachment = LocalImageAttachment | MentionAttachment | SkillAttachment;

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

interface NewConversationDraft {
  readonly generation: number;
  readonly sessionId: string;
  readonly draftId: string;
  readonly cwd: string;
  runtime: ConversationRuntimeSettings;
  models: readonly Model[];
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  runtimeLoadVersion: number;
  createPending: boolean;
  createdThread: Thread | undefined;
  readonly attachments: ConversationAttachment[];
  readonly notifications: ConversationNotification[];
  overflowed: boolean;
  malformed: boolean;
}

const MAX_BUFFERED_CONVERSATION_NOTIFICATIONS = 512;
const CONVERSATION_POST_INTERVAL_MS = 16;
const MAX_LOCAL_IMAGE_ATTACHMENTS = 10;
const MAX_LOCAL_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_MENTION_ATTACHMENTS = 20;
const MAX_MENTION_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_ATTACHMENTS = 10;
const LOCAL_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

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
  private readonly pendingNewConversations = new Set<NewConversationDraft>();
  private readonly interactions = new Map<string, ParsedConversationInteraction>();
  private conversationSession: ConversationSession | undefined;
  private newConversationDraft: NewConversationDraft | undefined;
  private conversationSessionId: string | undefined;
  private conversationSubscription: { dispose(): void } | undefined;
  private pendingConversationLoad: PendingConversationLoad | undefined;
  private pendingConversationPost: PendingConversationPost | undefined;
  private conversationPostTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRestoreThreadId: string | undefined;
  private viewReady = false;
  private generation = 0;
  private conversationViewRevision = 0;
  private conversationAttachments: ConversationAttachment[] = [];
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
          case 'threads/new':
            this.openNewConversation();
            return;
          case 'threads/back':
            this.showList();
            return;
          case 'threads/reload':
            if (this.newConversationDraft) {
              this.loadNewConversationRuntime(this.newConversationDraft);
            } else if (this.activeThread) {
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
          case 'threads/conversation/attachment/addImage':
            this.addLocalImages(message.sessionId, message.threadId);
            return;
          case 'threads/conversation/attachment/addMention':
            this.addMentionFiles(message.sessionId, message.threadId);
            return;
          case 'threads/conversation/attachment/addSkill':
            this.addSkills(message.sessionId, message.threadId);
            return;
          case 'threads/conversation/attachment/remove':
            this.removeAttachment(message.sessionId, message.threadId, message.attachmentId);
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
    if (!this.resolvePendingRestore() && !this.activeThread && !this.newConversationDraft) {
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
      const draft = this.newConversationDraft;
      if (draft && !draft.createPending) {
        this.postNewConversationState(
          draft,
          { kind: 'unavailable', message: 'Reconnect before creating the conversation.' },
          'The App Server connection was lost.'
        );
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
    if (
      status.kind === 'ready' &&
      previousStatus.kind === 'error' &&
      this.newConversationDraft &&
      !this.newConversationDraft.createPending
    ) {
      this.loadNewConversationRuntime(this.newConversationDraft);
    }
    if (!this.resolvePendingRestore() && !this.activeThread && !this.newConversationDraft) {
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
        return;
      }
      const draft = [...this.pendingNewConversations]
        .find((candidate) => candidate.createdThread?.id === parsed.params.threadId) ??
        this.newConversationDraft;
      if (draft?.createdThread?.id === parsed.params.threadId) {
        if (draft.notifications.length < MAX_BUFFERED_CONVERSATION_NOTIFICATIONS) {
          draft.notifications.push(parsed);
        } else {
          draft.overflowed = true;
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
        const draft = [...this.pendingNewConversations]
          .find((candidate) => candidate.createdThread?.id === threadId);
        if (draft) draft.malformed = true;
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
    for (const draft of this.pendingNewConversations) {
      draft.malformed = true;
    }
    for (const session of this.conversationSessions.values()) {
      session.markDisconnected();
    }
    const draft = this.newConversationDraft;
    if (draft && !draft.createPending) {
      this.postNewConversationState(
        draft,
        { kind: 'unavailable', message: 'Reconnect before creating the conversation.' },
        'The App Server connection was lost.'
      );
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
    this.pendingNewConversations.clear();
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
    this.pendingNewConversations.clear();
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

  private openNewConversation(): void {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (
      this.disposed ||
      !this.view ||
      !workspace ||
      this.status.kind !== 'ready' ||
      !this.options.startThread ||
      !this.options.readConversationConfig
    ) {
      this.options.logger.appendLine('[threads] Ignored an unavailable new conversation request.');
      return;
    }

    this.clearConversationSession();
    const generation = ++this.generation;
    const draft: NewConversationDraft = {
      generation,
      sessionId: randomUUID(),
      draftId: randomUUID(),
      cwd: workspace.uri.fsPath,
      runtime: loadingRuntimeSettings(),
      models: [],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      runtimeLoadVersion: 0,
      createPending: false,
      createdThread: undefined,
      attachments: [],
      notifications: [],
      overflowed: false,
      malformed: false
    };
    this.newConversationDraft = draft;
    this.activeThread = undefined;
    this.conversationSessionId = draft.sessionId;
    this.post({
      type: 'threads/newConversationLoaded',
      state: this.toNewConversationScreenState(draft, { kind: 'resuming' })
    });
    this.loadNewConversationRuntime(draft);
  }

  private loadNewConversationRuntime(draft: NewConversationDraft): void {
    if (!this.options.readConversationConfig || !this.isCurrentDraft(draft) || draft.createPending) {
      return;
    }
    const loadVersion = ++draft.runtimeLoadVersion;
    draft.runtime = { ...draft.runtime, status: 'loading', message: null };
    this.postNewConversationState(draft, { kind: 'resuming' });
    void Promise.all([
      loadConversationModelCatalog(this.options.conversationClient),
      this.options.readConversationConfig(draft.cwd)
    ]).then(
      ([catalog, defaults]) => {
        if (!this.isCurrentDraft(draft) || loadVersion !== draft.runtimeLoadVersion) return;
        const models = visibleConversationModels(catalog);
        const selectedModel = defaults.model ??
          models.find((model) => model.isDefault)?.id ??
          models[0]?.id;
        if (!selectedModel) {
          draft.runtime = {
            ...draft.runtime,
            status: 'unavailable',
            message: 'No conversation models are available.'
          };
          this.postNewConversationState(
            draft,
            { kind: 'unavailable', message: 'No conversation models are available.' },
            'No conversation models are available.'
          );
          return;
        }
        draft.models = models;
        draft.approvalPolicy = defaults.approvalPolicy ?? 'on-request';
        draft.approvalsReviewer = defaults.approvalsReviewer ?? 'user';
        draft.runtime = createConversationRuntimeSettings(
          models,
          selectedModel,
          defaults.reasoningEffort,
          defaults.serviceTier,
          defaults.sandbox ?? 'read-only',
          draft.approvalPolicy,
          draft.approvalsReviewer
        );
        this.postNewConversationState(draft, { kind: 'idle' });
      },
      () => {
        if (!this.isCurrentDraft(draft) || loadVersion !== draft.runtimeLoadVersion) return;
        draft.runtime = {
          ...draft.runtime,
          status: 'unavailable',
          message: 'New conversation settings could not be loaded.'
        };
        this.postNewConversationState(
          draft,
          { kind: 'unavailable', message: 'Reload the new conversation settings and try again.' },
          'New conversation settings could not be loaded.'
        );
      }
    );
  }

  private attachConversationSession(
    session: ConversationSession,
    generation: number,
    sessionId: string,
    reference: { readonly id: string; readonly title: string },
    previousThreadId?: string
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
    const state = this.toConversationScreenState(sessionId, snapshot);
    this.post(previousThreadId
      ? {
        type: 'threads/conversationCreated',
        previousThreadId,
        state
      }
      : {
        type: 'threads/conversationLoaded',
        state
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
    const draft = this.newConversationDraft;
    if (
      operation === 'send' &&
      draft &&
      draft.sessionId === sessionId &&
      draft.draftId === threadId
    ) {
      this.createNewConversation(draft, requestId, text ?? '');
      return;
    }
    const session = this.conversationSession;
    if (!session || !this.isCurrentSession(sessionId, threadId)) {
      this.options.logger.appendLine(
        `[threads] Ignored stale ${operation} request for sidebar thread ${threadId}.`
      );
      return;
    }

    if (
      operation === 'send' &&
      this.conversationAttachments.some((attachment) => attachment.kind === 'localImage') &&
      !session.supportsImageInput()
    ) {
      this.post({
        type: 'threads/conversationOperationResult',
        sessionId,
        threadId,
        requestId,
        operation,
        outcome: 'rejected',
        message: 'The selected model does not support image input. Remove the images or choose an image-capable model.'
      });
      return;
    }

    const generation = this.generation;
    const result = operation === 'send'
      ? session.send(text ?? '', this.conversationAttachments.map(toAdditionalInput))
      : session.stop();
    void result.then((accepted) => {
      if (!this.isCurrentConversation(generation, threadId, sessionId)) {
        return;
      }
      if (operation === 'send' && accepted) {
        this.conversationAttachments = [];
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
    const draft = this.newConversationDraft;
    if (draft?.sessionId === sessionId && draft.draftId === threadId) {
      if (
        draft.createPending ||
        draft.runtime.status !== 'ready' ||
        !isConversationRuntimeUpdateValid(
          draft.models,
          draft.runtime.approvalPolicy,
          draft.runtime.approvalsReviewer,
          settings
        )
      ) {
        this.options.logger.appendLine('[threads] Ignored invalid new conversation settings.');
        return;
      }
      if (settings.approvalPolicy !== 'custom') {
        draft.approvalPolicy = settings.approvalPolicy;
      }
      if (settings.approvalsReviewer !== 'custom') {
        draft.approvalsReviewer = settings.approvalsReviewer;
      }
      draft.runtime = createConversationRuntimeSettings(
        draft.models,
        settings.model,
        settings.effort,
        settings.serviceTier,
        settings.sandbox,
        settings.approvalPolicy,
        settings.approvalsReviewer
      );
      this.postNewConversationState(draft, { kind: 'idle' });
      return;
    }
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

  private addLocalImages(sessionId: string, threadId: string): void {
    const draft = this.newConversationDraft;
    const session = this.conversationSession;
    const isDraft = Boolean(draft?.sessionId === sessionId && draft.draftId === threadId);
    const isExisting = Boolean(session && this.isCurrentSession(sessionId, threadId));
    const available = isDraft
      ? Boolean(draft && !draft.createPending && draftSupportsImageInput(draft))
      : Boolean(isExisting && session?.snapshot().operation === 'idle' && session.supportsImageInput());
    if (!available) {
      this.options.logger.appendLine('[threads] Ignored an unavailable local image request.');
      return;
    }

    const generation = this.generation;
    const picker = this.options.pickLocalImages ?? pickLocalImages;
    void picker().then((picked) => {
      if (
        generation !== this.generation ||
        !this.isCurrentSession(sessionId, threadId) ||
        (isDraft
          ? !draft || draft.createPending || !draftSupportsImageInput(draft)
          : !session || session.snapshot().operation !== 'idle' || !session.supportsImageInput())
      ) return;
      const attachments = isDraft ? draft?.attachments : this.conversationAttachments;
      if (!attachments) return;
      const initialCount = attachments.length;
      let rejected = false;
      for (const image of picked) {
        if (attachments.filter((attachment) => attachment.kind === 'localImage').length >= MAX_LOCAL_IMAGE_ATTACHMENTS) {
          rejected = true;
          break;
        }
        const validated = validatePickedLocalImage(image);
        if (!validated) {
          rejected = true;
          continue;
        }
        const key = localPathKey(validated.path);
        if (attachments.some((attachment) => localPathKey(attachment.path) === key)) {
          continue;
        }
        attachments.push({ id: randomUUID(), kind: 'localImage', ...validated });
      }
      if (rejected) {
        void vscode.window.showWarningMessage(
          `Some images were not added. Use PNG, JPEG, GIF, or WebP files up to 20 MB (maximum ${MAX_LOCAL_IMAGE_ATTACHMENTS} images).`
        );
      }
      if (attachments.length !== initialCount) {
        this.postAttachmentState(isDraft ? draft : undefined);
      }
    }, () => {
      if (generation === this.generation) {
        this.options.logger.appendLine('[threads] The local image picker could not be opened.');
      }
    });
  }

  private addMentionFiles(sessionId: string, threadId: string): void {
    const draft = this.newConversationDraft;
    const session = this.conversationSession;
    const isDraft = Boolean(draft?.sessionId === sessionId && draft.draftId === threadId);
    const available = isDraft
      ? Boolean(draft && !draft.createPending)
      : Boolean(session && this.isCurrentSession(sessionId, threadId) && session.snapshot().operation === 'idle');
    if (!available) {
      this.options.logger.appendLine('[threads] Ignored an unavailable mention request.');
      return;
    }

    const generation = this.generation;
    const picker = this.options.pickMentionFiles ?? pickMentionFiles;
    void picker().then((picked) => {
      if (
        generation !== this.generation ||
        !this.isCurrentSession(sessionId, threadId) ||
        (isDraft ? !draft || draft.createPending : !session || session.snapshot().operation !== 'idle')
      ) return;
      const attachments = isDraft ? draft?.attachments : this.conversationAttachments;
      if (!attachments) return;
      const initialCount = attachments.length;
      let rejected = false;
      for (const file of picked) {
        if (attachments.filter((attachment) => attachment.kind === 'mention').length >= MAX_MENTION_ATTACHMENTS) {
          rejected = true;
          break;
        }
        const validated = validatePickedMention(file);
        if (!validated) {
          rejected = true;
          continue;
        }
        const key = localPathKey(validated.path);
        if (attachments.some((attachment) => attachment.kind === 'mention' && localPathKey(attachment.path) === key)) {
          continue;
        }
        attachments.push({ id: randomUUID(), kind: 'mention', ...validated });
      }
      if (rejected) {
        void vscode.window.showWarningMessage(
          `Some files were not mentioned. Select regular files up to 10 MB (maximum ${MAX_MENTION_ATTACHMENTS} files).`
        );
      }
      if (attachments.length !== initialCount) {
        this.postAttachmentState(isDraft ? draft : undefined);
      }
    }, () => {
      if (generation === this.generation) {
        this.options.logger.appendLine('[threads] The mention picker could not be opened.');
      }
    });
  }

  private addSkills(sessionId: string, threadId: string): void {
    const draft = this.newConversationDraft;
    const session = this.conversationSession;
    const isDraft = Boolean(draft?.sessionId === sessionId && draft.draftId === threadId);
    const cwd = isDraft ? draft?.cwd : session?.snapshot().model.cwd;
    const available = Boolean(
      cwd &&
      (this.options.pickSkills || this.options.conversationClient.listSkills) &&
      (isDraft
        ? draft && !draft.createPending
        : session && this.isCurrentSession(sessionId, threadId) && session.snapshot().operation === 'idle')
    );
    if (!available || !cwd) {
      this.options.logger.appendLine('[threads] Ignored an unavailable Skill request.');
      return;
    }

    const generation = this.generation;
    const picker = this.options.pickSkills ?? ((selectedCwd: string) => this.pickAvailableSkills(selectedCwd));
    void picker(cwd).then((picked) => {
      if (
        generation !== this.generation ||
        !this.isCurrentSession(sessionId, threadId) ||
        (isDraft ? !draft || draft.createPending : !session || session.snapshot().operation !== 'idle')
      ) return;
      const attachments = isDraft ? draft?.attachments : this.conversationAttachments;
      if (!attachments) return;
      const initialCount = attachments.length;
      let rejected = false;
      for (const skill of picked) {
        if (attachments.filter((attachment) => attachment.kind === 'skill').length >= MAX_SKILL_ATTACHMENTS) {
          rejected = true;
          break;
        }
        const validated = validatePickedSkill(skill);
        if (!validated) {
          rejected = true;
          continue;
        }
        const key = localPathKey(validated.path);
        if (attachments.some((attachment) => attachment.kind === 'skill' && localPathKey(attachment.path) === key)) {
          continue;
        }
        attachments.push({ id: randomUUID(), kind: 'skill', ...validated });
      }
      if (rejected) {
        void vscode.window.showWarningMessage(
          `Some Skills were not added. Choose up to ${MAX_SKILL_ATTACHMENTS} valid enabled Skills.`
        );
      }
      if (attachments.length !== initialCount) {
        this.postAttachmentState(isDraft ? draft : undefined);
      }
    }, () => {
      if (generation === this.generation) {
        this.options.logger.appendLine('[threads] Available Skills could not be loaded.');
        void vscode.window.showWarningMessage('Available Skills could not be loaded. Check the connection and try again.');
      }
    });
  }

  private async pickAvailableSkills(cwd: string): Promise<readonly PickedSkill[]> {
    const client = this.options.conversationClient;
    if (!client.listSkills) return [];
    const response = await client.listSkills({ cwds: [cwd], forceReload: false });
    const skills = response.data
      .filter((entry) => entry.cwd === cwd)
      .flatMap((entry) => entry.skills)
      .filter((skill) => skill.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (skills.length === 0) {
      void vscode.window.showWarningMessage('No enabled Skills are available for this workspace.');
      return [];
    }
    const items = skills.map((skill) => ({
      label: `$${skill.name}`,
      description: skill.scope,
      detail: skill.shortDescription ?? skill.description,
      skill
    }));
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: 'Choose Skills for the next message',
      title: 'Add Skills to the conversation'
    });
    return selected?.map(({ skill }) => ({
      name: skill.name,
      path: skill.path,
      description: skill.shortDescription ?? skill.description
    })) ?? [];
  }

  private removeAttachment(sessionId: string, threadId: string, attachmentId: string): void {
    if (!this.isCurrentSession(sessionId, threadId)) return;
    const draft = this.newConversationDraft;
    if (
      draft?.sessionId === sessionId
        ? draft.createPending
        : this.conversationSession?.snapshot().operation !== 'idle'
    ) return;
    const attachments = draft?.sessionId === sessionId && draft.draftId === threadId
      ? draft.attachments
      : this.conversationAttachments;
    const index = attachments.findIndex((attachment) => attachment.id === attachmentId);
    if (index < 0) return;
    attachments.splice(index, 1);
    this.postAttachmentState(draft?.sessionId === sessionId ? draft : undefined);
  }

  private postAttachmentState(draft?: NewConversationDraft): void {
    if (draft && this.isCurrentDraft(draft)) {
      this.postNewConversationState(draft, draftExecution(draft));
    } else {
      this.postCurrentConversationState();
    }
  }

  private createNewConversation(
    draft: NewConversationDraft,
    requestId: string,
    text: string
  ): void {
    if (
      this.isCurrentDraft(draft) &&
      draft.attachments.some((attachment) => attachment.kind === 'localImage') &&
      !draftSupportsImageInput(draft)
    ) {
      this.post({
        type: 'threads/conversationOperationResult',
        sessionId: draft.sessionId,
        threadId: draft.draftId,
        requestId,
        operation: 'send',
        outcome: 'rejected',
        message: 'The selected model does not support image input. Remove the images or choose an image-capable model.'
      });
      return;
    }
    if (
      !this.options.startThread ||
      !text.trim() ||
      !this.isCurrentDraft(draft) ||
      draft.createPending ||
      draft.runtime.status !== 'ready' ||
      !draft.runtime.model
    ) {
      return;
    }
    draft.createPending = true;
    this.pendingNewConversations.add(draft);
    this.postNewConversationState(draft, { kind: 'starting' });
    const model = conversationRuntimeModelValue(draft.models, draft.runtime.model);
    void this.options.startThread({
      model,
      serviceTier: draft.runtime.serviceTier,
      cwd: draft.cwd,
      approvalPolicy: draft.approvalPolicy,
      approvalsReviewer: draft.approvalsReviewer,
      sandbox: draft.runtime.sandbox,
      ephemeral: false,
      sessionStartSource: 'startup',
      threadSource: 'codex-thread-manager'
    }).then(async (started) => {
      draft.createdThread = started.thread;
      if (this.isDraftWorkspaceCurrent(draft)) {
        this.options.onConversationCreated?.(started.thread);
      }
      try {
        const response = await this.options.conversationClient.startTurn({
          threadId: started.thread.id,
          clientUserMessageId: randomUUID(),
          input: [
            { type: 'text', text, text_elements: [] },
            ...draft.attachments.map(toAdditionalInput)
          ],
          model,
          serviceTier: draft.runtime.serviceTier,
          effort: draft.runtime.effort,
          approvalPolicy: draft.approvalPolicy,
          approvalsReviewer: draft.approvalsReviewer
        });
        this.finishNewConversation(
          draft,
          requestId,
          started,
          { ...started.thread, turns: [response.turn] },
          true
        );
      } catch {
        this.finishNewConversation(draft, requestId, started, started.thread, false);
      }
    }, () => {
      this.pendingNewConversations.delete(draft);
      if (!this.isCurrentDraft(draft)) return;
      draft.createPending = false;
      this.postNewConversationState(
        draft,
        { kind: 'idle' },
        'The conversation could not be created. Check the connection and try again.'
      );
      this.post({
        type: 'threads/conversationOperationResult',
        sessionId: draft.sessionId,
        threadId: draft.draftId,
        requestId,
        operation: 'send',
        outcome: 'rejected',
        message: 'The conversation could not be created. Check the connection and try again.'
      });
    });
  }

  private finishNewConversation(
    draft: NewConversationDraft,
    requestId: string,
    started: ThreadStartResponse,
    thread: Thread,
    turnStarted: boolean
  ): void {
    const session = new ConversationSession(this.options.conversationClient, thread);
    session.initializeRuntimeSettings(
      draft.models,
      started.model,
      started.reasoningEffort,
      started.serviceTier,
      draft.runtime.sandbox,
      started.approvalPolicy,
      started.approvalsReviewer
    );
    for (const notification of draft.notifications) session.applyNotification(notification);
    if (draft.overflowed || draft.malformed) session.markDisconnected();
    this.pendingNewConversations.delete(draft);
    if (this.disposed || !this.isDraftWorkspaceCurrent(draft)) {
      session.dispose();
      return;
    }
    this.conversationSessions.set(thread.id, session);
    if (!this.isCurrentDraft(draft)) return;

    this.conversationAttachments = turnStarted ? [] : [...draft.attachments];
    this.newConversationDraft = undefined;
    this.activeThread = { id: thread.id, title: conversationTitle(thread) };
    this.attachConversationSession(
      session,
      draft.generation,
      draft.sessionId,
      this.activeThread,
      draft.draftId
    );
    this.post({
      type: 'threads/conversationOperationResult',
      sessionId: draft.sessionId,
      threadId: thread.id,
      requestId,
      operation: 'send',
      ...(turnStarted
        ? { outcome: 'accepted' as const }
        : {
          outcome: 'rejected' as const,
          message: 'The conversation was created, but its first message was not sent. Try sending it again.'
        })
    });
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
      this.conversationSessionId === sessionId && (
        this.activeThread?.id === threadId ||
        this.newConversationDraft?.draftId === threadId
      )
    );
  }

  private isCurrentDraft(draft: NewConversationDraft): boolean {
    return (
      !this.disposed &&
      Boolean(this.view) &&
      this.newConversationDraft === draft &&
      this.generation === draft.generation &&
      this.conversationSessionId === draft.sessionId
    );
  }

  private isDraftWorkspaceCurrent(draft: NewConversationDraft): boolean {
    return Boolean(vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === draft.cwd));
  }

  private clearConversationSession(): void {
    this.conversationSubscription?.dispose();
    this.conversationSubscription = undefined;
    this.conversationSession = undefined;
    this.conversationSessionId = undefined;
    this.newConversationDraft = undefined;
    this.conversationAttachments = [];
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

  private postNewConversationState(
    draft: NewConversationDraft,
    execution: ConversationExecutionViewModel,
    notice?: string
  ): void {
    if (!this.isCurrentDraft(draft)) return;
    this.post({
      type: 'threads/conversationState',
      state: this.toNewConversationScreenState(draft, execution, notice)
    });
  }

  private toNewConversationScreenState(
    draft: NewConversationDraft,
    execution: ConversationExecutionViewModel,
    notice?: string
  ): ConversationScreenState {
    return {
      sessionId: draft.sessionId,
      revision: ++this.conversationViewRevision,
      model: {
        threadId: draft.draftId,
        title: 'New conversation',
        cwd: draft.cwd,
        status: 'Draft',
        updatedAt: Date.now(),
        isPartialHistory: false,
        turns: []
      },
      execution,
      runtime: draft.runtime,
      availableAdditions: this.availableAdditions(draftSupportsImageInput(draft)),
      attachments: draft.attachments.map(toAttachmentViewModel),
      interactions: [],
      ...(notice ? { notice } : {})
    };
  }

  private toConversationScreenState(sessionId: string, snapshot: ConversationSessionSnapshot): ConversationScreenState {
    return toConversationScreenState(
      sessionId,
      snapshot,
      [...this.interactions.values()]
        .filter((interaction) => interaction.threadId === snapshot.model.threadId)
        .map((interaction) => interaction.view),
      ++this.conversationViewRevision,
      this.availableAdditions(Boolean(
        snapshot.runtime.status === 'ready' && this.conversationSession?.supportsImageInput()
      )),
      this.conversationAttachments.map(toAttachmentViewModel)
    );
  }

  private availableAdditions(image: boolean): ConversationScreenState['availableAdditions'] {
    return [
      ...(image ? ['localImage' as const] : []),
      'mention',
      ...(
        this.options.pickSkills || this.options.conversationClient.listSkills
          ? ['skill' as const]
          : []
      )
    ];
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

function loadingRuntimeSettings(): ConversationRuntimeSettings {
  return {
    status: 'loading',
    models: [],
    model: null,
    efforts: [],
    effort: null,
    defaultEffort: null,
    serviceTiers: [],
    serviceTier: null,
    defaultServiceTier: null,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    message: null
  };
}

function draftSupportsImageInput(draft: NewConversationDraft): boolean {
  if (draft.runtime.status !== 'ready' || !draft.runtime.model) return false;
  const model = draft.models.find((candidate) => candidate.id === draft.runtime.model) ??
    draft.models.find((candidate) => candidate.model === draft.runtime.model);
  return Boolean(model?.inputModalities.includes('image'));
}

function draftExecution(draft: NewConversationDraft): ConversationExecutionViewModel {
  if (draft.createPending) return { kind: 'starting' };
  if (draft.runtime.status === 'loading') return { kind: 'resuming' };
  if (draft.runtime.status === 'unavailable') {
    return { kind: 'unavailable', message: draft.runtime.message ?? 'Conversation settings are unavailable.' };
  }
  return { kind: 'idle' };
}

function toAttachmentViewModel(attachment: ConversationAttachment): ConversationAttachmentViewModel {
  switch (attachment.kind) {
    case 'localImage':
    case 'mention':
      return {
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes
      };
    case 'skill':
      return {
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        description: attachment.description
      };
  }
}

function toAdditionalInput(attachment: ConversationAttachment): ConversationAdditionalInput {
  switch (attachment.kind) {
    case 'localImage': return { type: 'localImage', path: attachment.path };
    case 'mention': return toFileReferenceInput(attachment);
    case 'skill': return { type: 'skill', name: attachment.name, path: attachment.path };
  }
}

function toFileReferenceInput(attachment: MentionAttachment): ConversationAdditionalInput {
  const prefix = 'Referenced file: ';
  const text = `${prefix}${attachment.path}`;
  return {
    type: 'text',
    text,
    text_elements: [{
      byteRange: {
        start: Buffer.byteLength(prefix, 'utf8'),
        end: Buffer.byteLength(text, 'utf8')
      },
      placeholder: `@${attachment.name}`
    }]
  };
}

function validatePickedLocalImage(image: PickedLocalImage): Omit<LocalImageAttachment, 'id' | 'kind'> | undefined {
  if (
    !isAbsolute(image.path) ||
    !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes <= 0 ||
    image.sizeBytes > MAX_LOCAL_IMAGE_SIZE_BYTES ||
    !LOCAL_IMAGE_EXTENSIONS.has(extname(image.path).toLowerCase())
  ) {
    return undefined;
  }
  const path = normalize(image.path);
  const name = basename(path);
  if (!name || name.length > 255) return undefined;
  return { path, name, sizeBytes: image.sizeBytes };
}

function validatePickedMention(file: PickedMentionFile): Omit<MentionAttachment, 'id' | 'kind'> | undefined {
  if (
    !isAbsolute(file.path) ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 0 ||
    file.sizeBytes > MAX_MENTION_FILE_SIZE_BYTES
  ) return undefined;
  const path = normalize(file.path);
  const name = basename(path);
  if (!name || name.length > 255) return undefined;
  return { path, name, sizeBytes: file.sizeBytes };
}

function validatePickedSkill(skill: PickedSkill): Omit<SkillAttachment, 'id' | 'kind'> | undefined {
  if (
    !isAbsolute(skill.path) ||
    !skill.name.trim() ||
    skill.name.length > 255 ||
    skill.description.length > 2_000
  ) return undefined;
  return {
    name: skill.name,
    path: normalize(skill.path),
    description: skill.description
  };
}

function localPathKey(path: string): string {
  const normalized = normalize(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function pickLocalImages(): Promise<readonly PickedLocalImage[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    title: 'Add images to the conversation',
    filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
  });
  if (!uris) return [];
  return Promise.all(uris.slice(0, MAX_LOCAL_IMAGE_ATTACHMENTS + 1).map(async (uri) => {
    if (uri.scheme !== 'file') return { path: uri.fsPath, sizeBytes: 0 };
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return {
        path: uri.fsPath,
        sizeBytes: stat.type === vscode.FileType.File ? stat.size : 0
      };
    } catch {
      return { path: uri.fsPath, sizeBytes: 0 };
    }
  }));
}

async function pickMentionFiles(): Promise<readonly PickedMentionFile[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    title: 'Mention files in the conversation',
    openLabel: 'Mention'
  });
  if (!uris) return [];
  return Promise.all(uris.slice(0, MAX_MENTION_ATTACHMENTS + 1).map(async (uri) => {
    if (uri.scheme !== 'file') return { path: uri.fsPath, sizeBytes: 0 };
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return {
        path: uri.fsPath,
        sizeBytes: stat.type === vscode.FileType.File ? stat.size : 0
      };
    } catch {
      return { path: uri.fsPath, sizeBytes: 0 };
    }
  }));
}

function conversationTitle(thread: Thread): string {
  const title = thread.name?.trim() || thread.preview.split(/\r?\n/u, 1)[0]?.trim();
  return title || 'New conversation';
}

function toConversationScreenState(
  sessionId: string,
  snapshot: ConversationSessionSnapshot,
  interactions: ConversationScreenState['interactions'],
  revision: number,
  availableAdditions: ConversationScreenState['availableAdditions'],
  attachments: ConversationScreenState['attachments']
): ConversationScreenState {
  const execution = toConversationExecution(snapshot);
  return snapshot.notice
    ? {
      sessionId,
      revision,
      model: snapshot.model,
      execution,
      runtime: snapshot.runtime,
      availableAdditions,
      attachments,
      interactions,
      notice: snapshot.notice
    }
    : {
      sessionId,
      revision,
      model: snapshot.model,
      execution,
      runtime: snapshot.runtime,
      availableAdditions,
      attachments,
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
