import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import type { Thread } from '../../src/codex/protocol/generated/v2/Thread';
import {
  CONVERSATION_VIEW_TYPE,
  ConversationPanelManager
} from '../../src/conversation/conversationPanelManager';
import { createThread } from '../support/threadFixture';

type Listener<T> = (event: T) => unknown;

class FakeWebview {
  public readonly cspSource = 'vscode-webview-resource:';
  public options: vscode.WebviewOptions = {};
  public html = '';
  public readonly postedMessages: unknown[] = [];
  private readonly listeners = new Set<Listener<unknown>>();

  public asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return vscode.Uri.file(`webview${uri.fsPath}`);
  }

  public onDidReceiveMessage(listener: Listener<unknown>): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async postMessage(message: unknown): Promise<boolean> {
    this.postedMessages.push(message);
    return true;
  }

  public fire(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

class FakeWebviewPanel {
  public title = '';
  public readonly webview = new FakeWebview();
  public revealCount = 0;
  public disposed = false;
  private readonly disposeListeners = new Set<Listener<void>>();

  public reveal(): void {
    this.revealCount += 1;
  }

  public onDidDispose(listener: Listener<void>): vscode.Disposable {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const listener of this.disposeListeners) {
      listener();
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value)
  };
}

function installPanelFactory(createdPanels: FakeWebviewPanel[]): void {
  (vscode.window as unknown as {
    createWebviewPanel: (
      viewType: string,
      title: string,
      column: vscode.ViewColumn,
      options: vscode.WebviewPanelOptions & vscode.WebviewOptions
    ) => vscode.WebviewPanel;
  }).createWebviewPanel = (viewType, title, _column, options) => {
    assert.equal(viewType, CONVERSATION_VIEW_TYPE);
    assert.equal(options.enableScripts, true);
    const panel = new FakeWebviewPanel();
    panel.title = title;
    createdPanels.push(panel);
    return panel as unknown as vscode.WebviewPanel;
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('reuses one panel per thread and loads only after the ready handshake', async (t) => {
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  let readCount = 0;
  const manager = new ConversationPanelManager({
    extensionUri: vscode.Uri.file('D:\\extension'),
    readThread: async () => {
      readCount += 1;
      return createThread({ name: 'Loaded title' });
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());

  manager.openThread({ id: 'thread-1', title: 'Thread 1' });
  manager.openThread({ id: 'thread-1', title: 'Updated title' });

  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.revealCount, 1);
  assert.equal(readCount, 0);

  panels[0]?.webview.fire({ type: 'conversation/ready' });
  await flushPromises();

  assert.equal(readCount, 1);
  assert.equal(panels[0]?.title, 'Loaded title');
  assert.deepEqual(
    panels[0]?.webview.postedMessages.map((message) =>
      (message as { type?: unknown }).type
    ),
    ['conversation/loading', 'conversation/loaded']
  );
});

test('drops a stale thread/read result after a newer reload completes', async (t) => {
  const panels: FakeWebviewPanel[] = [];
  installPanelFactory(panels);
  const reads: Deferred<Thread>[] = [];
  const manager = new ConversationPanelManager({
    extensionUri: vscode.Uri.file('D:\\extension'),
    readThread: () => {
      const read = deferred<Thread>();
      reads.push(read);
      return read.promise;
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());

  manager.openThread({ id: 'thread-1', title: 'Thread 1' });
  panels[0]?.webview.fire({ type: 'conversation/ready' });
  panels[0]?.webview.fire({ type: 'conversation/reload' });
  assert.equal(reads.length, 2);

  reads[1]?.resolve(createThread({ name: 'Newest history' }));
  await flushPromises();
  reads[0]?.resolve(createThread({ name: 'Stale history' }));
  await flushPromises();

  const loaded = panels[0]?.webview.postedMessages.filter(
    (message) => (message as { type?: unknown }).type === 'conversation/loaded'
  ) as Array<{ model: { title: string } }>;
  assert.deepEqual(loaded.map((message) => message.model.title), ['Newest history']);
  assert.equal(panels[0]?.title, 'Newest history');
});

test('restores a valid panel and rejects invalid persisted state', async (t) => {
  const warnings: string[] = [];
  (vscode.window as unknown as {
    showWarningMessage: (message: string) => Promise<string | undefined>;
  }).showWarningMessage = async (message) => {
    warnings.push(message);
    return undefined;
  };
  const manager = new ConversationPanelManager({
    extensionUri: vscode.Uri.file('D:\\extension'),
    readThread: async () => createThread(),
    logger: { appendLine: () => undefined }
  });
  t.after(() => manager.dispose());

  const restored = new FakeWebviewPanel();
  await manager.deserializeWebviewPanel(
    restored as unknown as vscode.WebviewPanel,
    { version: 1, threadId: 'thread-1', title: 'Restored thread' }
  );
  assert.equal(restored.title, 'Restored thread');
  assert.match(restored.webview.html, /data-thread-id="thread-1"/u);

  const invalid = new FakeWebviewPanel();
  await manager.deserializeWebviewPanel(
    invalid as unknown as vscode.WebviewPanel,
    { version: 99, threadId: 'thread-2', title: 'Invalid' }
  );
  assert.equal(invalid.disposed, true);
  assert.equal(warnings.length, 1);
});
