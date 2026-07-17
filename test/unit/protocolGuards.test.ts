import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseConversationNotification,
  parseInitializeResponse,
  parseThreadListResponse,
  parseThreadReadResponse
} from '../../src/codex/protocol/guards';
import { createThread, createTurn } from '../support/threadFixture';

const validThread = createThread();

test('accepts valid initialize and thread/list boundaries', () => {
  assert.equal(parseInitializeResponse({
    userAgent: 'fixture',
    codexHome: '<fixture>',
    platformFamily: 'windows',
    platformOs: 'win32'
  }).userAgent, 'fixture');
  assert.equal(parseThreadListResponse({
    data: [validThread],
    nextCursor: null,
    backwardsCursor: null
  }).data[0]?.id, 'thread-1');
});

test('accepts a validated thread/read history including future item variants', () => {
  const thread = createThread({
    turns: [createTurn({
      status: 'failed',
      error: {
        message: 'Fixture failure',
        codexErrorInfo: 'usageLimitExceeded',
        additionalDetails: null
      },
      items: [
        {
          type: 'userMessage',
          id: 'user-1',
          clientId: null,
          content: [
            { type: 'text', text: 'Hello', text_elements: [] },
            { type: 'skill', name: 'review', path: 'D:\\skill' }
          ]
        },
        {
          type: 'futureWorkItem',
          id: 'future-1',
          privatePayload: 'ignored'
        } as never
      ]
    })]
  });

  const response = parseThreadReadResponse({ thread }, 'thread-1');

  assert.equal(response.thread.turns[0]?.items.length, 2);
});

test('rejects mismatched thread IDs and malformed stored items', () => {
  assert.throws(
    () => parseThreadReadResponse({ thread: validThread }, 'another-thread'),
    /invalid thread\/read response/u
  );
  assert.throws(
    () => parseThreadReadResponse({
      thread: createThread({
        turns: [createTurn({
          items: [{
            type: 'userMessage',
            id: 'user-1',
            clientId: null,
            content: [{ type: 'skill', path: 'D:\\skill' }]
          } as never]
        })]
      })
    }, 'thread-1'),
    /invalid thread\/read response/u
  );
});

test('rejects non-finite timestamps, invalid statuses, and malformed cursors', () => {
  assert.throws(
    () => parseThreadListResponse({
      data: [{ ...validThread, updatedAt: Number.NaN }],
      nextCursor: null,
      backwardsCursor: null
    }),
    /invalid thread\/list response/u
  );
  assert.throws(
    () => parseThreadListResponse({
      data: [{ ...validThread, status: { type: 'active' } }],
      nextCursor: null,
      backwardsCursor: null
    }),
    /invalid thread\/list response/u
  );
  assert.throws(
    () => parseThreadListResponse({
      data: [validThread],
      nextCursor: 123,
      backwardsCursor: null
    }),
    /invalid thread\/list response/u
  );
});

test('parses the conversation error notification and ignores unrelated notifications', () => {
  const notification = parseConversationNotification('error', {
    error: {
      message: 'Temporary stream failure',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
      additionalDetails: null
    },
    willRetry: true,
    threadId: 'thread-1',
    turnId: 'turn-1'
  });

  assert.equal(notification?.method, 'error');
  if (notification?.method === 'error') {
    assert.equal(notification.params.willRetry, true);
    assert.equal(notification.params.error.message, 'Temporary stream failure');
  }
  assert.equal(
    parseConversationNotification('thread/name/updated', {
      threadId: 'thread-1',
      threadName: 'Renamed'
    }),
    undefined
  );
});

test('rejects malformed params for recognized conversation notifications', () => {
  assert.throws(
    () => parseConversationNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'agentMessage',
        id: 'agent-1',
        text: '',
        phase: null,
        memoryCitation: null
      },
      startedAtMs: Number.NaN
    }),
    /invalid item\/started notification params/u
  );
  assert.throws(
    () => parseConversationNotification('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'active', activeFlags: ['unknownFlag'] }
    }),
    /invalid thread\/status\/changed notification params/u
  );
  assert.throws(
    () => parseConversationNotification('error', {
      error: {
        message: 'Bad error shape',
        codexErrorInfo: 'not-a-generated-error-code',
        additionalDetails: null
      },
      willRetry: false,
      threadId: 'thread-1',
      turnId: 'turn-1'
    }),
    /invalid error notification params/u
  );
});
