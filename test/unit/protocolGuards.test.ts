import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInitializeResponse, parseThreadListResponse } from '../../src/codex/protocol/guards';

const validThread = {
  id: 'thread-1',
  sessionId: 'session-1',
  forkedFromId: null,
  parentThreadId: null,
  preview: 'Preview',
  ephemeral: false,
  modelProvider: 'openai',
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
  status: { type: 'idle' },
  path: null,
  cwd: 'C:\\workspace',
  cliVersion: '0.144.2',
  source: 'vscode',
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: []
};

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
