import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_COMPOSER_TEXT_LENGTH,
  MAX_CONVERSATION_ID_LENGTH,
  isThreadsHostMessage,
  isThreadsWebviewMessage,
  isThreadsWebviewState,
  restoreThreadsWebviewState
} from '../../src/webview/threads/protocol';

const conversationState = {
  sessionId: 'session-1',
  revision: 1,
  model: {
    threadId: 'thread-1',
    title: 'Thread 1',
    cwd: 'D:\\workspace',
    status: 'Running',
    updatedAt: 1_750_000_000_000,
    isPartialHistory: false,
    turns: [
      {
        id: 'turn-1',
        status: 'In progress',
        itemsView: 'full',
        startedAt: 1_750_000_000_000,
        completedAt: null,
        durationMs: null,
        errorMessage: null,
        items: [
          { kind: 'message', id: 'message-1', role: 'assistant', text: 'Hello' }
        ]
      }
    ]
  },
  execution: { kind: 'running', turnId: 'turn-1' },
  runtime: {
    status: 'ready',
    models: [{ value: 'gpt-fixture', label: 'GPT Fixture', description: 'Fixture model' }],
    model: 'gpt-fixture',
    efforts: [{ value: 'medium', label: 'medium', description: 'Balanced' }],
    effort: 'medium',
    serviceTiers: [],
    serviceTier: null,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    message: null
  }
} as const;

test('accepts only the explicit sidebar navigation messages', () => {
  for (const message of [
    { type: 'threads/ready' },
    { type: 'threads/open', threadId: 'thread-1' },
    { type: 'threads/back' },
    { type: 'threads/reload' }
  ]) {
    assert.equal(isThreadsWebviewMessage(message), true);
  }

  assert.equal(isThreadsWebviewMessage({ type: 'threads/open', threadId: '' }), false);
  assert.equal(isThreadsWebviewMessage({ type: 'threads/execute', command: 'anything' }), false);
});

test('requires thread IDs only for thread-scoped management actions', () => {
  for (const action of ['loadMoreActive', 'loadMoreArchive']) {
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action }), true);
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action, threadId: 'thread-1' }), false);
  }
  for (const action of ['refresh', 'openSettings']) {
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action }), false);
  }
  for (const action of ['pin', 'unpin', 'rename', 'archive', 'unarchive']) {
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action, threadId: 'thread-1' }), true);
    assert.equal(isThreadsWebviewMessage({ type: 'threads/action', action }), false);
  }
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/action',
    action: 'workbench.action.terminal.new'
  }), false);
});

test('accepts bounded composer actions and rejects arbitrary conversation payloads', () => {
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/send',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-1',
    text: 'Continue this thread'
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/settings',
    sessionId: 'session-1',
    threadId: 'thread-1',
    settings: {
      model: 'gpt-fixture',
      effort: 'high',
      serviceTier: 'fast',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request'
    }
  }), true);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/stop',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2'
  }), true);

  for (const text of ['', ' \n\t', 'x'.repeat(MAX_COMPOSER_TEXT_LENGTH + 1)]) {
    assert.equal(isThreadsWebviewMessage({
      type: 'threads/conversation/send',
      sessionId: 'session-1',
      threadId: 'thread-1',
      requestId: 'request-1',
      text
    }), false);
  }
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/send',
    sessionId: 'x'.repeat(MAX_CONVERSATION_ID_LENGTH + 1),
    threadId: 'thread-1',
    requestId: 'request-1',
    text: 'Hello'
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/settings',
    sessionId: 'session-1',
    threadId: 'thread-1',
    settings: {
      model: 'gpt-fixture',
      effort: null,
      serviceTier: null,
      sandbox: 'danger-everywhere',
      approvalPolicy: 'never'
    }
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/stop',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2',
    turnId: 'turn-from-webview'
  }), false);
  assert.equal(isThreadsWebviewMessage({
    type: 'threads/conversation/send',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-1',
    text: 'Hello',
    method: 'turn/start'
  }), false);
});

test('validates persisted navigation state and host messages', () => {
  assert.equal(isThreadsWebviewState({
    version: 2,
    screen: 'conversation',
    selectedThreadId: 'thread-1',
    listScrollTop: 120,
    expandedGroups: { pinned: false, active: true, archive: true }
  }), true);
  assert.equal(isThreadsWebviewState({
    version: 2,
    screen: 'conversation',
    selectedThreadId: null,
    listScrollTop: 0,
    expandedGroups: { pinned: true, active: true, archive: false }
  }), false);
  assert.equal(isThreadsWebviewState({
    version: 2,
    screen: 'list',
    selectedThreadId: null,
    listScrollTop: 0
  }), false);

  assert.equal(isThreadsHostMessage({ type: 'threads/showList' }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationLoading',
    sessionId: 'session-1',
    threadId: 'thread-1',
    title: 'Thread 1'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationLoaded',
    state: conversationState
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: {
      ...conversationState,
      revision: 2,
      execution: { kind: 'idle' }
    }
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationError',
    sessionId: 'session-1',
    threadId: 'thread-1',
    title: 'Thread 1',
    message: 500
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: { ...conversationState, revision: -1 }
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationState',
    state: {
      ...conversationState,
      execution: { kind: 'running', turnId: '' }
    }
  }), false);
});

test('validates correlated conversation operation results', () => {
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationOperationResult',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-1',
    operation: 'send',
    outcome: 'accepted'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationOperationResult',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2',
    operation: 'stop',
    outcome: 'rejected',
    message: 'The turn already completed.'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationOperationResult',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2',
    operation: 'execute',
    outcome: 'accepted'
  }), false);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationOperationResult',
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-2',
    operation: 'stop',
    outcome: 'rejected'
  }), false);
});

test('restores group visibility and migrates version 1 navigation state', () => {
  assert.deepEqual(restoreThreadsWebviewState({
    version: 2,
    screen: 'list',
    selectedThreadId: 'thread-1',
    listScrollTop: 80,
    expandedGroups: { pinned: false, active: true, archive: true }
  }), {
    version: 2,
    screen: 'list',
    selectedThreadId: 'thread-1',
    listScrollTop: 80,
    expandedGroups: { pinned: false, active: true, archive: true }
  });

  assert.deepEqual(restoreThreadsWebviewState({
    version: 1,
    screen: 'conversation',
    selectedThreadId: 'thread-2',
    listScrollTop: 120
  }), {
    version: 2,
    screen: 'conversation',
    selectedThreadId: 'thread-2',
    listScrollTop: 120,
    expandedGroups: { pinned: true, active: true, archive: false }
  });

  assert.deepEqual(restoreThreadsWebviewState({
    version: 2,
    screen: 'list',
    selectedThreadId: null,
    listScrollTop: 0,
    expandedGroups: { pinned: 'yes', active: true, archive: false }
  }), {
    version: 2,
    screen: 'list',
    selectedThreadId: null,
    listScrollTop: 0,
    expandedGroups: { pinned: true, active: true, archive: false }
  });
});
