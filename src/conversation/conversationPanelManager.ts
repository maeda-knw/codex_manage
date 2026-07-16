import * as vscode from 'vscode';
import type { Thread } from '../codex/protocol/generated/v2/Thread';
import { AppServerError, asError } from '../common/errors';
import {
  createConversationWebviewHtml,
  configureConversationWebview,
  conversationWebviewRoot
} from './conversationWebview';
import { toConversationViewModel } from './conversationViewModel';
import {
  isConversationWebviewMessage,
  isConversationWebviewState,
  type ConversationHostToWebviewMessage,
  type ConversationWebviewState
} from '../webview/conversation/protocol';

export const CONVERSATION_VIEW_TYPE = 'codexThreadManager.conversation';

export interface ConversationThreadReference {
  readonly id: string;
  readonly title: string;
}

export interface ConversationPanelLogger {
  appendLine(value: string): void;
}

export interface ConversationPanelManagerOptions {
  readonly extensionUri: vscode.Uri;
  readonly readThread: (threadId: string) => Promise<Thread>;
  readonly logger: ConversationPanelLogger;
}

export class ConversationPanelManager implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private readonly panels = new Map<string, ManagedConversationPanel>();

  public constructor(private readonly options: ConversationPanelManagerOptions) {}

  public openThread(reference: ConversationThreadReference): void {
    const existing = this.panels.get(reference.id);
    if (existing) {
      existing.updateReference(reference);
      existing.reveal();
      existing.reload();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CONVERSATION_VIEW_TYPE,
      reference.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        enableFindWidget: true,
        retainContextWhenHidden: false,
        localResourceRoots: [conversationWebviewRoot(this.options.extensionUri)]
      }
    );
    this.attach(panel, reference);
  }

  public async deserializeWebviewPanel(
    webviewPanel: vscode.WebviewPanel,
    state: unknown
  ): Promise<void> {
    if (!isConversationWebviewState(state)) {
      webviewPanel.dispose();
      await vscode.window.showWarningMessage(
        'Codex Thread Manager could not restore a conversation tab because its saved state was invalid.'
      );
      return;
    }

    const existing = this.panels.get(state.threadId);
    if (existing) {
      existing.reveal();
      webviewPanel.dispose();
      return;
    }

    this.attach(webviewPanel, {
      id: state.threadId,
      title: state.title || 'Codex thread'
    });
  }

  public dispose(): void {
    for (const panel of this.panels.values()) {
      panel.detach();
    }
    this.panels.clear();
  }

  private attach(panel: vscode.WebviewPanel, reference: ConversationThreadReference): void {
    const managed = new ManagedConversationPanel(panel, reference, this.options, () => {
      if (this.panels.get(reference.id) === managed) {
        this.panels.delete(reference.id);
      }
    });
    this.panels.set(reference.id, managed);
  }
}

class ManagedConversationPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private generation = 0;
  private ready = false;
  private disposed = false;
  private reference: ConversationThreadReference;

  public constructor(
    private readonly panel: vscode.WebviewPanel,
    reference: ConversationThreadReference,
    private readonly options: ConversationPanelManagerOptions,
    private readonly onDispose: () => void
  ) {
    this.reference = reference;
    configureConversationWebview(panel.webview, options.extensionUri);
    panel.title = reference.title;
    panel.webview.html = createConversationWebviewHtml(
      panel.webview,
      options.extensionUri,
      this.webviewState()
    );

    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!isConversationWebviewMessage(message)) {
          this.options.logger.appendLine(
            `[conversation] Ignored an invalid webview message for thread ${this.reference.id}.`
          );
          return;
        }
        this.ready = true;
        this.reload();
      }),
      panel.onDidDispose(() => {
        this.disposed = true;
        this.generation += 1;
        this.disposeListeners();
        this.onDispose();
      })
    );
  }

  public updateReference(reference: ConversationThreadReference): void {
    this.reference = reference;
    this.panel.title = reference.title;
  }

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active, false);
  }

  public reload(): void {
    if (!this.ready || this.disposed) {
      return;
    }

    const generation = ++this.generation;
    void this.post({ type: 'conversation/loading' });
    void this.options.readThread(this.reference.id).then(
      async (thread) => {
        if (this.disposed || generation !== this.generation) {
          return;
        }
        const model = toConversationViewModel(thread);
        this.reference = { id: model.threadId, title: model.title };
        this.panel.title = model.title;
        await this.post({ type: 'conversation/loaded', model });
        this.options.logger.appendLine(
          `[conversation] Loaded ${model.turns.length} turn(s) for thread ${model.threadId}.`
        );
      },
      async (error: unknown) => {
        if (this.disposed || generation !== this.generation) {
          return;
        }
        this.options.logger.appendLine(
          `[conversation] Could not load thread ${this.reference.id}: ${asError(error).message}`
        );
        await this.post({
          type: 'conversation/error',
          message: conversationErrorMessage(error)
        });
      }
    );
  }

  public detach(): void {
    this.disposed = true;
    this.generation += 1;
    this.disposeListeners();
  }

  private webviewState(): ConversationWebviewState {
    return {
      version: 1,
      threadId: this.reference.id,
      title: this.reference.title
    };
  }

  private post(message: ConversationHostToWebviewMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private disposeListeners(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

function conversationErrorMessage(error: unknown): string {
  if (error instanceof AppServerError) {
    switch (error.code) {
      case 'cli-not-found':
        return 'Codex CLI was not found. Open the extension settings and configure codexPath.';
      case 'request-timeout':
        return 'Codex App Server timed out while loading this conversation.';
      case 'incompatible-cli':
      case 'protocol-error':
        return 'This Codex CLI returned an incompatible conversation history response.';
      case 'connection-closed':
      case 'process-start-failed':
      case 'disposed':
        return 'The Codex App Server connection is unavailable. Reload the history to reconnect.';
      case 'request-failed':
        return 'Codex App Server could not read this thread.';
    }
  }
  return 'An unexpected error occurred while loading this conversation.';
}
