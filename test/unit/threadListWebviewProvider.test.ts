import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import type { Thread } from '../../src/codex/protocol/generated/v2/Thread';
import type { ThreadResumeResponse } from '../../src/codex/protocol/generated/v2/ThreadResumeResponse';
import type { Turn } from '../../src/codex/protocol/generated/v2/Turn';
import type { ThreadDisplayModel, ThreadRepositorySnapshot } from '../../src/codex/threadRepository';
import type { ConversationSessionClient } from '../../src/conversation/conversationSession';
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

async function flushConversationPosts(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

function fakeConversationClient(
  readThread: (threadId: string) => Promise<Thread>
): ConversationSessionClient {
  return {
    readThread: async (params) => ({ thread: await readThread(params.threadId) }),
    resumeThread: async (params) => resumeResponse(createThread({ id: params.threadId })),
    startTurn: async () => {
      throw new Error('Unexpected turn/start call.');
    },
    interruptTurn: async () => {
      throw new Error('Unexpected turn/interrupt call.');
    }
  };
}

function resumeResponse(thread: Thread): ThreadResumeResponse {
  return {
    thread,
    model: 'gpt-fixture',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: thread.cwd,
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [thread.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    reasoningEffort: 'medium'
  };
}

test('posts a primitive-only list model and a secure Webview shell after ready', (t) => {
  setWorkspace();
  const logs: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: fakeConversationClient(async () => createThread()),
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
    conversationClient: fakeConversationClient(async (threadId) => {
      reads.push(threadId);
      return createThread({
        id: threadId,
        name: 'Loaded conversation',
        turns: [createTurn()]
      });
    }),
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

test('sends, streams, and stops only the active sidebar conversation', async (t) => {
  setWorkspace();
  const logs: string[] = [];
  const start = deferred<{ turn: Turn }>();
  const startCalls: unknown[] = [];
  const interruptCalls: unknown[] = [];
  const client: ConversationSessionClient = {
    readThread: async (params) => ({ thread: createThread({ id: params.threadId }) }),
    resumeThread: async (params) => resumeResponse(createThread({ id: params.threadId })),
    startTurn: async (params) => {
      startCalls.push(params);
      return start.promise;
    },
    interruptTurn: async (params) => {
      interruptCalls.push(params);
      return {};
    }
  };
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: client,
    logger: { appendLine: (value) => logs.push(value) }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  await flushPromises();

  const loaded = view.webview.postedMessages.find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
  ) as { state: { sessionId: string } } | undefined;
  assert.ok(loaded);
  const sessionId = loaded.state.sessionId;
  const secretText = 'message body must not enter logs';
  view.webview.fire({
    type: 'threads/conversation/send',
    sessionId,
    threadId: 'thread-1',
    requestId: 'send-1',
    text: secretText
  });
  view.webview.fire({
    type: 'threads/conversation/send',
    sessionId,
    threadId: 'thread-1',
    requestId: 'send-duplicate',
    text: 'duplicate body'
  });
  await flushPromises();
  assert.equal(startCalls.length, 1);
  assert.equal(JSON.stringify(startCalls[0]).includes(secretText), true);
  assert.equal(logs.some((line) => line.includes(secretText)), false);
  assert.equal(
    view.webview.postedMessages.some(
      (message) =>
        (message as { type?: unknown }).type === 'threads/conversationOperationResult' &&
        (message as { requestId?: unknown }).requestId === 'send-duplicate' &&
        (message as { outcome?: unknown }).outcome === 'rejected'
    ),
    true
  );
  start.resolve({
    turn: createTurn({
      id: 'turn-live',
      status: 'inProgress',
      completedAt: null,
      durationMs: null,
      items: []
    })
  });
  await flushPromises();
  assert.equal(
    view.webview.postedMessages.some(
      (message) =>
        (message as { type?: unknown }).type === 'threads/conversationOperationResult' &&
        (message as { requestId?: unknown }).requestId === 'send-1' &&
        (message as { outcome?: unknown }).outcome === 'accepted'
    ),
    true
  );
  const runningStateIndex = view.webview.postedMessages.findIndex(
    (message) =>
      (message as { type?: unknown }).type === 'threads/conversationState' &&
      (message as { state?: { execution?: { kind?: unknown } } }).state?.execution?.kind === 'running'
  );
  const acceptedSendIndex = view.webview.postedMessages.findIndex(
    (message) =>
      (message as { type?: unknown }).type === 'threads/conversationOperationResult' &&
      (message as { requestId?: unknown }).requestId === 'send-1' &&
      (message as { outcome?: unknown }).outcome === 'accepted'
  );
  assert.ok(runningStateIndex >= 0 && runningStateIndex < acceptedSendIndex);

  provider.handleNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      itemId: 'agent-live',
      delta: 'Streaming reply'
    }
  });
  await flushConversationPosts();
  const streamed = [...view.webview.postedMessages].reverse().find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationState'
  ) as { state?: { model?: { turns?: Array<{ items: Array<{ text?: string }> }> } } } | undefined;
  assert.equal(streamed?.state?.model?.turns?.[0]?.items[0]?.text, 'Streaming reply');

  view.webview.fire({
    type: 'threads/conversation/stop',
    sessionId,
    threadId: 'thread-1',
    requestId: 'stop-1'
  });
  await flushPromises();
  assert.deepEqual(interruptCalls, [{ threadId: 'thread-1', turnId: 'turn-live' }]);

  provider.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: createTurn({
        id: 'turn-live',
        status: 'interrupted',
        items: [{
          type: 'agentMessage',
          id: 'agent-live',
          text: 'Streaming reply',
          phase: 'final_answer',
          memoryCitation: null
        }]
      })
    }
  });
  await flushConversationPosts();
  const completed = [...view.webview.postedMessages].reverse().find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationState'
  ) as { state?: { execution?: { kind?: string } } } | undefined;
  assert.equal(completed?.state?.execution?.kind, 'idle');

  const beforeStale = view.webview.postedMessages.length;
  view.webview.fire({
    type: 'threads/conversation/send',
    sessionId: 'stale-session',
    threadId: 'thread-1',
    requestId: 'stale-send',
    text: 'must be ignored'
  });
  await flushPromises();
  assert.equal(view.webview.postedMessages.length, beforeStale);
});

test('restores the active conversation when the Webview context sends ready again', async (t) => {
  setWorkspace();
  const reads: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: fakeConversationClient(async (threadId) => {
      reads.push(threadId);
      return createThread({ id: threadId });
    }),
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

  assert.deepEqual(reads, ['thread-1']);
  assert.deepEqual(
    view.webview.postedMessages.map((message) => (message as { type?: unknown }).type),
    ['threads/conversationLoading', 'threads/conversationLoaded']
  );
});

test('replays conversation notifications received while the initial history read is pending', async (t) => {
  setWorkspace();
  const read = deferred<Thread>();
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: fakeConversationClient(async () => read.promise),
    logger: { appendLine: () => undefined }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });

  provider.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: createTurn({
        id: 'turn-live',
        status: 'completed',
        items: [{
          type: 'agentMessage',
          id: 'agent-live',
          text: 'Completed while loading',
          phase: 'final_answer',
          memoryCitation: null
        }]
      })
    }
  });
  provider.handleNotification({
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'idle' } }
  });
  read.resolve(createThread({
    status: { type: 'active', activeFlags: [] },
    turns: [createTurn({
      id: 'turn-live',
      status: 'inProgress',
      completedAt: null,
      durationMs: null,
      items: []
    })]
  }));
  await flushPromises();

  const loaded = [...view.webview.postedMessages].reverse().find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
  ) as { state?: { execution?: { kind?: string }; model?: { turns?: Array<{ items: Array<{ text?: string }> }> } } } | undefined;
  assert.equal(loaded?.state?.execution?.kind, 'idle');
  assert.equal(
    loaded?.state?.model?.turns?.[0]?.items[0]?.text,
    'Completed while loading'
  );
});

test('keeps a pending send tracked across Back and reopening the same conversation', async (t) => {
  setWorkspace();
  const start = deferred<{ turn: Turn }>();
  let readCalls = 0;
  let startCalls = 0;
  const client: ConversationSessionClient = {
    ...fakeConversationClient(async (threadId) => {
      readCalls += 1;
      return createThread({ id: threadId });
    }),
    startTurn: async () => {
      startCalls += 1;
      return start.promise;
    }
  };
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: client,
    logger: { appendLine: () => undefined }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  await flushPromises();
  const firstLoaded = [...view.webview.postedMessages].reverse().find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
  ) as { state: { sessionId: string } };
  view.webview.fire({
    type: 'threads/conversation/send',
    sessionId: firstLoaded.state.sessionId,
    threadId: 'thread-1',
    requestId: 'send-before-back',
    text: 'Keep tracking this turn'
  });
  await flushPromises();
  assert.equal(startCalls, 1);

  view.webview.fire({ type: 'threads/back' });
  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  await flushPromises();
  assert.equal(readCalls, 1);
  const loadedMessages = view.webview.postedMessages.filter(
    (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
  ) as Array<{ state: { sessionId: string } }>;
  assert.notEqual(loadedMessages[0]?.state.sessionId, loadedMessages[1]?.state.sessionId);

  start.resolve({ turn: createTurn({
    id: 'turn-live',
    status: 'inProgress',
    completedAt: null,
    durationMs: null,
    items: []
  }) });
  await flushConversationPosts();
  const latest = [...view.webview.postedMessages].reverse().find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationState'
  ) as { state?: { execution?: { kind?: string } } } | undefined;
  assert.equal(latest?.state?.execution?.kind, 'running');
});

test('disposes old workspace sessions before a pending send can start a turn', async (t) => {
  setWorkspace();
  const resume = deferred<ThreadResumeResponse>();
  let startCalls = 0;
  const client: ConversationSessionClient = {
    ...fakeConversationClient(async (threadId) => createThread({ id: threadId })),
    resumeThread: async () => resume.promise,
    startTurn: async () => {
      startCalls += 1;
      return { turn: createTurn({ id: 'unexpected', status: 'inProgress' }) };
    }
  };
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: client,
    logger: { appendLine: () => undefined }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  await flushPromises();
  const loaded = [...view.webview.postedMessages].reverse().find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationLoaded'
  ) as { state: { sessionId: string } };
  view.webview.fire({
    type: 'threads/conversation/send',
    sessionId: loaded.state.sessionId,
    threadId: 'thread-1',
    requestId: 'send-old-workspace',
    text: 'Must not cross workspaces'
  });
  provider.resetWorkspace();
  resume.resolve(resumeResponse(createThread()));
  await flushPromises();

  assert.equal(startCalls, 0);
  const listState = [...view.webview.postedMessages].reverse().find(
    (message) => (message as { type?: unknown }).type === 'threads/listState'
  );
  assert.equal(JSON.stringify(listState).includes('Thread 1'), false);
});

test('automatically resynchronizes the active conversation after reconnect', async (t) => {
  setWorkspace();
  let readCalls = 0;
  let resumeCalls = 0;
  const client: ConversationSessionClient = {
    ...fakeConversationClient(async (threadId) => {
      readCalls += 1;
      return createThread({
        id: threadId,
        name: readCalls === 1 ? 'Before reconnect' : 'After reconnect'
      });
    }),
    resumeThread: async (params) => {
      resumeCalls += 1;
      return resumeResponse(createThread({ id: params.threadId }));
    }
  };
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: client,
    logger: { appendLine: () => undefined }
  });
  t.after(() => provider.dispose());
  provider.setSnapshot(snapshot(displayThread('thread-1', 'Thread 1')));
  provider.setConnectionStatus({ kind: 'ready' });
  const view = new FakeWebviewView();
  resolveProvider(provider, view);
  view.webview.fire({ type: 'threads/ready' });
  view.webview.fire({ type: 'threads/open', threadId: 'thread-1' });
  await flushPromises();

  provider.setConnectionStatus({ kind: 'error', message: 'Disconnected' });
  provider.setConnectionStatus({ kind: 'ready' });
  await flushPromises();
  await flushConversationPosts();

  assert.equal(resumeCalls, 1);
  assert.equal(readCalls, 2);
  const latest = [...view.webview.postedMessages].reverse().find(
    (message) => (message as { type?: unknown }).type === 'threads/conversationState'
  ) as { state?: { model?: { title?: string }; execution?: { kind?: string } } } | undefined;
  assert.equal(latest?.state?.model?.title, 'After reconnect');
  assert.equal(latest?.state?.execution?.kind, 'idle');
});

test('reloads the selected thread and drops stale results after another selection or Back', async (t) => {
  setWorkspace();
  const pending: Array<{ threadId: string; read: Deferred<Thread> }> = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: fakeConversationClient(async (threadId) => {
      const read = deferred<Thread>();
      pending.push({ threadId, read });
      return read.promise;
    }),
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
  ) as Array<{ state: { model: { threadId: string } } }>;
  assert.deepEqual(loaded.map((message) => message.state.model.threadId), ['thread-2']);

  view.webview.fire({ type: 'threads/reload' });
  await flushPromises();
  assert.equal(pending[2]?.threadId, 'thread-2');
  view.webview.fire({ type: 'threads/back' });
  pending[2]?.read.resolve(createThread({ id: 'thread-2', name: 'Too late' }));
  await flushPromises();
  assert.equal(
    view.webview.postedMessages.some(
      (message) =>
        (message as { type?: unknown }).type === 'threads/conversationLoaded' &&
        (message as { state?: { model?: { title?: unknown } } }).state?.model?.title === 'Too late'
    ),
    false
  );
});

test('waits for the first loaded snapshot before restoring a conversation', async (t) => {
  setWorkspace();
  const reads: string[] = [];
  const provider = new ThreadListWebviewProvider({
    extensionUri: vscode.Uri.file('/extension'),
    conversationClient: fakeConversationClient(async (threadId) => {
      reads.push(threadId);
      return createThread({ id: threadId });
    }),
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
    conversationClient: fakeConversationClient(async () => {
      throw new Error('private failure');
    }),
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
    conversationClient: fakeConversationClient(async (threadId) => {
      reads.push(threadId);
      return createThread({ id: threadId });
    }),
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
