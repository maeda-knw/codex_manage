import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isThreadsHostMessage,
  isThreadsWebviewMessage,
  isThreadsWebviewState,
  restoreThreadsWebviewState
} from '../../src/webview/threads/protocol';

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
    threadId: 'thread-1',
    title: 'Thread 1'
  }), true);
  assert.equal(isThreadsHostMessage({
    type: 'threads/conversationError',
    threadId: 'thread-1',
    title: 'Thread 1',
    message: 500
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
