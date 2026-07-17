import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import type { Thread } from '../../src/codex/protocol/generated/v2/Thread';
import type { ThreadDisplayModel, ThreadRepositorySnapshot } from '../../src/codex/threadRepository';
import { ThreadListWebviewProvider } from '../../src/views/threadListWebviewProvider';
import { createThread, createTurn } from '../support/threadFixture';

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

class FakeWebviewView {
  public readonly webview = new FakeWebview();
  private readonly listeners = new Set<Listener<void>>();

  public onDidDispose(listener: Listener<void>): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public dispose(): void {
    for (const listener of this.listeners) {
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
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

function displayThread(id: string, title: string, overrides: Partial<ThreadDisplayModel> = {}): ThreadDisplayModel {
  const date = new Date('2026-07-17T00:00:00Z');
  return {
    id,
    title,
    description: 'now • Idle',
    tooltip: new vscode.MarkdownString('private tooltip'),
    cwd: 'D:\\private-workspace',
    createdAt: date,
    updatedAt: date,
    recencyAt: date,
    statusLabel: 'Idle',
    iconId: 'comment-discussion',
    archived: false,
    pinned: false,
    sourceLabel: 'vscode',
    ...overrides
  };
}

function snapshot(...threads: ThreadDisplayModel[]): ThreadRepositorySnapshot {
  return {
    pinned: { threads: threads.filter((thread) => thread.pinned), nextCursor: null, loaded: true },
    active: { threads: threads.filter((thread) => !thread.archived && !thread.pinned), nextCursor: 'next', loaded: true },
    archive: { threads: threads.filter((thread) => thread.archived), nextCursor: null, loaded: true }
  };
}

function setWorkspace(): void {
  (vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: { fsPath: string } }>;
  }).workspaceFolders = [{ uri: { fsPath: 'D:\\workspace' } }];
}

function resolveProvider(
  provider: ThreadListWebviewProvider,
  view: FakeWebviewView,
  state?: unknown
): void {
  provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    { state } as vscode.WebviewViewResolveContext<unknown>
  );
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('posts a primitive-only list model and a secure Webview shell after ready', (t) => {
  setWorkspace();
  const logs: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    readThread: async () => createThread(),
    logger: { appendLine: (value) => logs.push(value) }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  provider.setConnectionStatus({ kind: 'ready' });
  const view = new FakeWebviewView();

  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });

  assert.equal(view.webview.options.enableScripts, true);
  assert.equal(view.webview.options.enableForms, false);
  assert.equal(view.webview.options.enableCommandUris, false);
  assert.match(view.webview.html, /threads\.js/u);
  assert.match(view.webview.html, /threads\.css/u);
  assert.match(view.webview.html, /default-src 'none'/u);
  assert.equal(view.webview.html.includes('unsafe-inline'), false);

  const listState = view.webview.postedMessages.find(
    (message) => (message as { type?: unknown }).type === 'threads/listState'
  );
  const serialized = JSON.stringify(listState);
  assert.match(serialized, /Thread 1/u);
  assert.equal(serialized.includes('private tooltip'), false);
  assert.equal(serialized.includes('private-workspace'), false);
});

test('opens history in the sidebar, keeps it during snapshot updates, and returns to the latest list', async (t) => {
  setWorkspace();
  const reads: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    readThread: async (threadId) => {
      reads.push(threadId);
      return createThread({
        id: threadId,
        name: 'Loaded conversation',
        turns: [createTurn()]
      });
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.postedMessages.length = 0;

  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  await flushPromises();

  assert.deepEqual(reads, ['thread-1']);
  assert.deepEqual(
    view.webview.postedMessages.map((message) => (message as { type?: unknown }).type),
    ['threads/conversationLoading', 'threads/conversationLoaded']
  );

  view.webview.postedMessages.length = 0;
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Renamed while open')));
  assert.deepEqual(view.webview.postedMessages, []);

  view.webview.fire({ type: 'threads/back' });
  assert.deepEqual(
    view.webview.postedMessages.map((message) => (message as { type?: unknown }).type),
    ['threads/showList', 'threads/listState']
  );
  assert.match(JSON.stringify(view.webview.postedMessages[1]), /Renamed while open/u);
});

test('restores the active conversation when the Webview context sends ready again', async (t) => {
  setWorkspace();
  const reads: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    readThread: async (threadId) => {
      reads.push(threadId);
      return createThread({ id: threadId });
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  await flushPromises();
  view.webview.postedMessages.length = 0;

  view.webview.fire({ type: 'threads/ready' });
  await flushPromises();

  assert.deepEqual(reads, ['thread-1', 'thread-1']);
  assert.deepEqual(
    view.webview.postedMessages.map((message) => (message as { type?: unknown }).type),
    ['threads/conversationLoading', 'threads/conversationLoaded']
  );
});

test('reloads the selected thread and drops stale results after another selection or Back', async (t) => {
  setWorkspace();
  const pending: Array<{ threadId: string; read: Deferred<Thread> }> = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    readThread: (threadId) => {
      const read = deferred<Thread>();
      pending.push({ threadId, read });
      return read.promise;
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(
    displayThread('thread-1', 'Thread 1'),
    displayThread('thread-2', 'Thread 2')
  ));
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.postedMessages.length = 0;

  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  view.webview.fire({ type: 'threads/open', threadId: 'thread-2' });
  assert.deepEqual(pending.map((entry) => entry.threadId), ['thread-1', 'thread-2']);
  pending[1]?.read.resolve(createThread({ id: 'thread-2', name: 'Newest' }));
  await flushPromises();
  pending[0]?.read.resolve(createThread({ id: 'thread-1', name: 'Stale' }));
  await flushPromises();

  const loaded = view.webview.postedMessages.filter(
    (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
  ) as Array<{ model: { threadId: string } }>;
  assert.deepEqual(loaded.map((message) => message.model.threadId), ['thread-2']);

  view.webview.fire({ type: 'threads/reload' });
  assert.equal(pending[2]?.threadId, 'thread-2');
  view.webview.fire({ type: 'threads/back' });
  pending[2]?.read.resolve(createThread({ id: 'thread-2', name: 'Too late' }));
  await flushPromises();
  assert.equal(
    view.webview.postedMessages.some(
      (message) =>
        (message as { type?: unknown }).type === 'threads/conversationLoaded' &&
        (message as { model?: { title?: unknown } }).model?.title === 'Too late'
    ),
    false
  );
});

test('waits for the first loaded snapshot before restoring a conversation', async (t) => {
  setWorkspace();
  const reads: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    readThread: async (threadId) => {
      reads.push(threadId);
      return createThread({ id: threadId });
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => provider.dispose());
  const view = new FakeWebviewView();
  resolveProvider(provider, view, {
    version: 2,
    screen: 'conversation',
    selectedThreadId: 'thread-1',
    listScrollTop: 10,
    expandedGroups: { pinned: false, active: true, archive: true }
  });

  view.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  assert.deepEqual(reads, []);
  assert.equal(
    view.webview.postedMessages.some(
      (message) => (message as { type?: unknown }).type === 'threads/showList'
    ),
    false
  );

  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  await flushPromises();
  assert.deepEqual(reads, ['thread-1']);
  assert.equal(
    view.webview.postedMessages.some(
      (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
    ),
    true
  );
});

test('returns stale thread selections to the latest list and reports read failures', async (t) => {
  setWorkspace();
  const logs: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    readThread: async () => {
      throw new Error('private failure');
    },
    logger: { appendLine: (value) => logs.push(value) }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.postedMessages.length = 0;

  view.webview.fire({ type: 'threads/open', threadId: 'stale-thread' });
  assert.deepEqual(
    view.webview.postedMessages.map((message) => (message as { type?: unknown }).type),
    ['threads/showList', 'threads/listState']
  );

  view.webview.postedMessages.length = 0;
  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  await flushPromises();
  assert.deepEqual(
    view.webview.postedMessages.map((message) => (message as { type?: unknown }).type),
    ['threads/conversationLoading', 'threads/conversationError']
  );
  assert.equal(JSON.stringify(view.webview.postedMessages).includes('private failure'), false);
  assert.equal(logs.some((line) => line.includes('private failure')), true);
});

test('uses an explicit command map and safely restores only known thread state', async (t) => {
  setWorkspace();
  const commandCalls: unknown[][] = [];
  const originalExecuteCommand = vscode.commands.executeCommand;
  (vscode.commands as unknown as {
    executeCommand: (...args: unknown[]) => Promise<unknown>;
  }).executeCommand = async (...args) => {
    commandCalls.push(args);
    return undefined;
  };
  const reads: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    readThread: async (threadId) => {
      reads.push(threadId);
      return createThread({ id: threadId });
    },
    logger: { appendLine: () => undefined }
  });
  t.after(() => {
    provider.dispose();
    (vscode.commands as unknown as {
      executeCommand: (...args: unknown[]) => Promise<unknown>;
    }).executeCommand = originalExecuteCommand as (...args: unknown[]) => Promise<unknown>;
  });
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  const view = new FakeWebviewView();
  resolveProvider(provider, view, {
    version: 1,
    screen: 'conversation',
    selectedThreadId: 'thread-1',
    listScrollTop: 10
  });
  view.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  assert.deepEqual(reads, ['thread-1']);

  for (const action of ['loadMoreActive', 'loadMoreArchive']) {
    view.webview.fire({ type: 'threads/action', action });
  }
  for (const action of ['pin', 'unpin', 'rename', 'archive', 'unarchive']) {
    view.webview.fire({ type: 'threads/action', action, threadId: 'thread-1' });
  }
  view.webview.fire({ type: 'threads/action', action: 'pin', threadId: 'missing-thread' });
  await flushPromises();
  assert.deepEqual(commandCalls, [
    ['codexThreadManager.loadMoreActive'],
    ['codexThreadManager.loadMoreArchive'],
    ['codexThreadManager.pin', 'thread-1'],
    ['codexThreadManager.unpin', 'thread-1'],
    ['codexThreadManager.rename', 'thread-1'],
    ['codexThreadManager.archive', 'thread-1'],
    ['codexThreadManager.unarchive', 'thread-1']
  ]);

  const invalidView = new FakeWebviewView();
  resolveProvider(provider, invalidView, {
    version: 1,
    screen: 'conversation',
    selectedThreadId: 'missing-thread',
    listScrollTop: 0
  });
  invalidView.webview.fire({ type: 'threads/ready' });
  await flushPromises();
  assert.deepEqual(reads, ['thread-1']);
});
