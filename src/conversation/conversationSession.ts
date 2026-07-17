import { randomUUID } from 'node:crypto';
import type { Thread } from '../codex/protocol/generated/v2/Thread';
import type { ThreadReadParams } from '../codex/protocol/generated/v2/ThreadReadParams';
import type { ThreadReadResponse } from '../codex/protocol/generated/v2/ThreadReadResponse';
import type { ThreadResumeParams } from '../codex/protocol/generated/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from '../codex/protocol/generated/v2/ThreadResumeResponse';
import type { TurnInterruptParams } from '../codex/protocol/generated/v2/TurnInterruptParams';
import type { TurnInterruptResponse } from '../codex/protocol/generated/v2/TurnInterruptResponse';
import type { TurnStartParams } from '../codex/protocol/generated/v2/TurnStartParams';
import type { TurnStartResponse } from '../codex/protocol/generated/v2/TurnStartResponse';
import type { ConversationNotification } from '../codex/protocol/guards';
import { AppServerError } from '../common/errors';
import {
  activeConversationTurnId,
  createConversationReducerState,
  hydrateConversationReducer,
  isConversationBusy,
  reduceConversationNotification,
  reduceTurnStartResponse,
  type ConversationReducerState
} from './conversationReducer';
import {
  toConversationViewModel,
  type ConversationViewModel
} from './conversationViewModel';

export interface ConversationSessionClient {
  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
  readThread(params: ThreadReadParams): Promise<ThreadReadResponse>;
  startTurn(params: TurnStartParams): Promise<TurnStartResponse>;
  interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse>;
}

export type ConversationSessionSync = 'ready' | 'stale' | 'error';

export type ConversationSessionOperation =
  | 'idle'
  | 'resuming'
  | 'starting'
  | 'running'
  | 'interrupting';

export interface ConversationSessionSnapshot {
  readonly model: ConversationViewModel;
  readonly revision: number;
  readonly sync: ConversationSessionSync;
  readonly operation: ConversationSessionOperation;
  readonly activeTurnId: string | null;
  readonly notice: string | null;
}

export type ConversationSessionListener = (snapshot: ConversationSessionSnapshot) => void;

export class ConversationSession {
  private reducer: ConversationReducerState;
  private readonly listeners = new Set<ConversationSessionListener>();
  private revision = 0;
  private notificationVersion = 0;
  private asyncGeneration = 0;
  private sync: ConversationSessionSync = 'ready';
  private operation: ConversationSessionOperation;
  private notice: string | null;
  private sendPending = false;
  private stopPending = false;
  private resyncPending = false;
  private disposed = false;

  public constructor(
    private readonly client: ConversationSessionClient,
    initialThread: Thread
  ) {
    this.reducer = createConversationReducerState(initialThread);
    this.sync = this.reducer.needsResync ? 'stale' : 'ready';
    this.operation = reducerOperation(this.reducer);
    this.notice = this.reducer.needsResync
      ? 'Conversation history is inconsistent. Reload the conversation to resynchronize.'
      : null;
  }

  public subscribe(listener: ConversationSessionListener): { dispose(): void } {
    this.listeners.add(listener);
    listener(this.snapshot());
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  public snapshot(): ConversationSessionSnapshot {
    return {
      model: toConversationViewModel(this.reducer.thread),
      revision: this.revision,
      sync: this.sync,
      operation: this.operation,
      activeTurnId: activeConversationTurnId(this.reducer),
      notice: this.notice
    };
  }

  public updateTitle(title: string): void {
    if (this.disposed || this.reducer.thread.name === title) {
      return;
    }
    this.reducer = {
      ...this.reducer,
      thread: { ...this.reducer.thread, name: title }
    };
    this.publish();
  }

  public async send(text: string): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    if (!text.trim()) {
      this.updatePresentation({ notice: 'Enter a message before sending.' });
      return false;
    }
    if (this.sync !== 'ready') {
      this.updatePresentation({ notice: 'Reload the conversation before sending another message.' });
      return false;
    }
    if (this.reducer.needsResync) {
      this.updatePresentation({
        sync: 'stale',
        notice: 'Conversation history must be re-synchronized before sending another message.'
      });
      return false;
    }
    if (
      this.sendPending ||
      this.stopPending ||
      this.resyncPending ||
      this.operation === 'interrupting' ||
      isConversationBusy(this.reducer)
    ) {
      this.updatePresentation({ notice: 'A turn is already running for this conversation.' });
      return false;
    }

    this.sendPending = true;
    const generation = ++this.asyncGeneration;
    const notificationVersion = this.notificationVersion;
    this.updatePresentation({
      sync: 'ready',
      operation: 'resuming',
      notice: null
    });

    try {
      const resumed = await this.client.resumeThread({ threadId: this.reducer.thread.id });
      if (!this.isCurrent(generation)) {
        return false;
      }
      if (resumed.thread.id !== this.reducer.thread.id) {
        this.failOperation('Codex returned a different conversation while resuming.');
        return false;
      }

      if (notificationVersion === this.notificationVersion) {
        this.replaceReducer(hydrateConversationReducer(this.reducer, resumed.thread), false);
      } else {
        this.updatePresentation({
          sync: 'stale',
          operation: activeConversationTurnId(this.reducer) ? 'running' : 'idle',
          notice: 'Conversation activity changed while resuming. Reload before sending again.'
        });
        return false;
      }
      const resumedState = createConversationReducerState(resumed.thread);
      if (
        this.reducer.needsResync ||
        resumedState.needsResync ||
        isConversationBusy(this.reducer) ||
        isConversationBusy(resumedState)
      ) {
        const activeTurnId = activeConversationTurnId(this.reducer);
        const inconsistent = this.reducer.needsResync || resumedState.needsResync;
        this.updatePresentation({
          sync: inconsistent ? 'stale' : 'ready',
          operation: reducerOperation(this.reducer),
          notice: inconsistent
            ? 'Conversation history is inconsistent. Reload to resynchronize.'
            : activeTurnId
              ? 'This conversation already has a turn in progress.'
              : 'This conversation is already active. Wait for its current work to finish.'
        });
        return false;
      }

      this.updatePresentation({ operation: 'starting', notice: null });
      const response = await this.client.startTurn({
        threadId: this.reducer.thread.id,
        clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text, text_elements: [] }]
      });
      if (!this.isCurrent(generation)) {
        return false;
      }

      this.replaceReducer(reduceTurnStartResponse(this.reducer, response.turn), false);
      if (this.reducer.needsResync) {
        this.updatePresentation({
          sync: 'stale',
          operation: activeConversationTurnId(this.reducer) ? 'running' : 'idle',
          notice: 'Conversation activity became inconsistent. Reload to resynchronize.'
        });
        return true;
      }
      this.updatePresentation({
        sync: 'ready',
        operation: activeConversationTurnId(this.reducer) ? 'running' : 'idle',
        notice: null
      });
      return true;
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.failOperation(safeSessionErrorMessage(error, 'send the message'));
      }
      return false;
    } finally {
      if (this.isCurrent(generation)) {
        this.sendPending = false;
      }
    }
  }

  public async stop(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const turnId = activeConversationTurnId(this.reducer);
    if (
      !turnId ||
      this.sendPending ||
      this.stopPending ||
      this.resyncPending ||
      this.operation === 'interrupting' ||
      this.sync !== 'ready'
    ) {
      if (!turnId) {
        this.updatePresentation({ notice: 'There is no running turn to stop.' });
      }
      return false;
    }

    this.stopPending = true;
    const generation = ++this.asyncGeneration;
    this.updatePresentation({ operation: 'interrupting', notice: null });
    try {
      await this.client.interruptTurn({ threadId: this.reducer.thread.id, turnId });
      if (!this.isCurrent(generation)) {
        return false;
      }
      this.updatePresentation({
        operation: activeConversationTurnId(this.reducer) ? 'interrupting' : 'idle',
        notice: activeConversationTurnId(this.reducer) ? 'Stop requested…' : this.notice
      });
      return true;
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.updatePresentation({
          sync: 'error',
          operation: activeConversationTurnId(this.reducer) ? 'running' : 'idle',
          notice: safeSessionErrorMessage(error, 'stop the turn')
        });
      }
      return false;
    } finally {
      if (this.isCurrent(generation)) {
        this.stopPending = false;
      }
    }
  }

  public applyNotification(notification: ConversationNotification): void {
    if (this.disposed || notification.params.threadId !== this.reducer.thread.id) {
      return;
    }

    this.notificationVersion += 1;
    const previousReducer = this.reducer;
    this.reducer = reduceConversationNotification(this.reducer, notification);
    let nextOperation = this.operation;
    let nextNotice = this.notice;

    switch (notification.method) {
      case 'turn/started':
        nextOperation = activeConversationTurnId(this.reducer) ? 'running' : nextOperation;
        nextNotice = null;
        break;
      case 'turn/completed':
        nextOperation = reducerOperation(this.reducer);
        nextNotice = turnCompletionNotice(notification.params.turn.status);
        break;
      case 'error':
        nextNotice = notification.params.willRetry
          ? 'Codex encountered a temporary error and is retrying.'
          : 'The current turn failed. Reload the conversation to resynchronize.';
        break;
      case 'thread/status/changed':
        if (notification.params.status.type === 'systemError') {
          nextNotice = 'Codex reported a conversation error. Reload to resynchronize.';
        } else if (
          notification.params.status.type === 'active' &&
          !activeConversationTurnId(this.reducer)
        ) {
          nextOperation = 'resuming';
          nextNotice = 'Codex is already working on this conversation.';
        } else if (
          notification.params.status.type !== 'active' &&
          nextOperation === 'resuming' &&
          !this.sendPending &&
          !this.resyncPending
        ) {
          nextOperation = 'idle';
          if (nextNotice === 'Codex is already working on this conversation.') {
            nextNotice = null;
          }
        }
        break;
      case 'item/started':
      case 'item/completed':
      case 'item/agentMessage/delta':
        break;
    }

    if (!previousReducer.needsResync && this.reducer.needsResync) {
      this.sync = 'stale';
      nextOperation = activeConversationTurnId(this.reducer) ? 'running' : 'idle';
      nextNotice = 'Conversation activity became inconsistent. Reload to resynchronize.';
    }
    const presentationChanged = nextOperation !== this.operation || nextNotice !== this.notice;
    this.operation = nextOperation;
    this.notice = nextNotice;
    if (previousReducer !== this.reducer || presentationChanged) {
      this.publish();
    }
  }

  public markDisconnected(): void {
    if (this.disposed) {
      return;
    }
    this.asyncGeneration += 1;
    this.sendPending = false;
    this.stopPending = false;
    this.resyncPending = false;
    this.updatePresentation({
      sync: 'stale',
      operation: activeConversationTurnId(this.reducer) ? 'running' : 'idle',
      notice: 'The Codex connection closed. Reload the conversation to reconnect.'
    });
  }

  public async resync(): Promise<boolean> {
    if (this.disposed || this.resyncPending || this.sendPending || this.stopPending) {
      return false;
    }

    this.resyncPending = true;
    const generation = ++this.asyncGeneration;
    this.updatePresentation({ operation: 'resuming', notice: null });
    try {
      const resumed = await this.client.resumeThread({ threadId: this.reducer.thread.id });
      if (!this.isCurrent(generation)) {
        return false;
      }
      if (resumed.thread.id !== this.reducer.thread.id) {
        this.failOperation('Codex returned a different conversation while reconnecting.');
        return false;
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const notificationVersion = this.notificationVersion;
        const response = await this.client.readThread({
          threadId: this.reducer.thread.id,
          includeTurns: true
        });
        if (!this.isCurrent(generation)) {
          return false;
        }
        if (response.thread.id !== this.reducer.thread.id) {
          this.failOperation('Codex returned a different conversation while reloading.');
          return false;
        }
        if (notificationVersion !== this.notificationVersion) {
          continue;
        }

        const hydrated = hydrateConversationReducer(this.reducer, response.thread);
        this.replaceReducer(hydrated, false);
        if (hydrated.needsResync) {
          this.updatePresentation({
            sync: 'stale',
            operation: reducerOperation(hydrated),
            notice: 'Codex returned inconsistent conversation history. Try reloading again.'
          });
          return false;
        }
        this.updatePresentation({
          sync: 'ready',
          operation: reducerOperation(this.reducer),
          notice: null
        });
        return true;
      }
      this.updatePresentation({
        sync: 'stale',
        operation: activeConversationTurnId(this.reducer) ? 'running' : 'idle',
        notice: 'Conversation activity kept changing during reload. Try again after the current turn settles.'
      });
      return false;
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.failOperation(safeSessionErrorMessage(error, 'reload the conversation'));
      }
      return false;
    } finally {
      if (this.isCurrent(generation)) {
        this.resyncPending = false;
      }
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.asyncGeneration += 1;
    this.sendPending = false;
    this.stopPending = false;
    this.resyncPending = false;
    this.listeners.clear();
  }

  private replaceReducer(next: ConversationReducerState, publish: boolean): void {
    if (next === this.reducer) {
      return;
    }
    this.reducer = next;
    if (publish) {
      this.publish();
    }
  }

  private failOperation(notice: string): void {
    this.updatePresentation({
      sync: 'error',
      operation: activeConversationTurnId(this.reducer) ? 'running' : 'idle',
      notice
    });
  }

  private updatePresentation(values: {
    readonly sync?: ConversationSessionSync;
    readonly operation?: ConversationSessionOperation;
    readonly notice?: string | null;
  }): void {
    const sync = values.sync ?? this.sync;
    const operation = values.operation ?? this.operation;
    const notice = values.notice === undefined ? this.notice : values.notice;
    if (sync === this.sync && operation === this.operation && notice === this.notice) {
      return;
    }
    this.sync = sync;
    this.operation = operation;
    this.notice = notice;
    this.publish();
  }

  private publish(): void {
    this.revision += 1;
    if (this.listeners.size === 0) {
      return;
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.asyncGeneration;
  }
}

function turnCompletionNotice(status: Thread['turns'][number]['status']): string | null {
  switch (status) {
    case 'completed':
      return null;
    case 'interrupted':
      return 'The turn was stopped.';
    case 'failed':
      return 'The turn failed.';
    case 'inProgress':
      return 'Codex returned an inconsistent turn completion. Reload to resynchronize.';
  }
}

function reducerOperation(state: ConversationReducerState): ConversationSessionOperation {
  if (activeConversationTurnId(state)) {
    return 'running';
  }
  return state.thread.status.type === 'active' ? 'resuming' : 'idle';
}

function safeSessionErrorMessage(error: unknown, action: string): string {
  if (error instanceof AppServerError) {
    switch (error.code) {
      case 'cli-not-found':
        return 'Codex CLI was not found. Open the extension settings and configure codexPath.';
      case 'request-timeout':
        return `Codex App Server timed out while trying to ${action}.`;
      case 'incompatible-cli':
      case 'protocol-error':
        return `This Codex CLI returned an incompatible response while trying to ${action}.`;
      case 'connection-closed':
      case 'process-start-failed':
      case 'disposed':
        return `The Codex App Server connection is unavailable. Reload before trying to ${action}.`;
      case 'request-failed':
        return `Codex App Server could not ${action}.`;
    }
  }
  return `An unexpected error occurred while trying to ${action}.`;
}
