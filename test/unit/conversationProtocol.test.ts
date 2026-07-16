import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isConversationHostMessage,
  isConversationWebviewMessage,
  isConversationWebviewState
} from '../../src/webview/conversation/protocol';

test('accepts only versioned conversation panel state', () => {
  assert.equal(isConversationWebviewState({
    version: 1,
    threadId: 'thread-1',
    title: 'Thread 1'
  }), true);
  assert.equal(isConversationWebviewState({
    version: 2,
    threadId: 'thread-1',
    title: 'Thread 1'
  }), false);
  assert.equal(isConversationWebviewState({
    version: 1,
    threadId: '',
    title: 'Thread 1'
  }), false);
});

test('rejects arbitrary webview commands and malformed host messages', () => {
  assert.equal(isConversationWebviewMessage({ type: 'conversation/ready' }), true);
  assert.equal(isConversationWebviewMessage({ type: 'conversation/reload' }), true);
  assert.equal(isConversationWebviewMessage({
    type: 'conversation/execute',
    command: 'anything'
  }), false);

  assert.equal(isConversationHostMessage({ type: 'conversation/loading' }), true);
  assert.equal(isConversationHostMessage({
    type: 'conversation/error',
    message: 'Failed'
  }), true);
  assert.equal(isConversationHostMessage({
    type: 'conversation/error',
    message: 123
  }), false);
});
