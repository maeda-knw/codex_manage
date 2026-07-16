import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'compatible';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        userAgent: 'fake-codex/0.142.3',
        codexHome: '<fixture>',
        platformFamily: process.platform,
        platformOs: process.platform
      }
    });
  } else if (message.method === 'initialized') {
    initialized = true;
    if (mode === 'server-request') {
      send({ id: 'server-request-1', method: 'fixture/approval', params: { reason: 'test' } });
    }
  } else if (message.method === 'thread/read' && mode === 'thread-read') {
    if (message.params?.threadId !== 'thread-1' || message.params?.includeTurns !== true) {
      send({ id: message.id, error: { code: -32602, message: 'Expected includeTurns for thread-1' } });
    } else {
      send({ id: message.id, result: { thread: conversationThread('thread-1') } });
    }
  } else if (message.method === 'thread/read' && mode === 'malformed-thread-read') {
    send({
      id: message.id,
      result: {
        thread: {
          ...conversationThread('different-thread'),
          turns: [{ id: 'broken-turn', items: 'not-an-array' }]
        }
      }
    });
  } else if (message.method === 'thread/list' && mode === 'compatible') {
    send({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: null } });
  } else if (message.method === 'thread/list' && mode === 'diagnostics') {
    process.stderr.write('Bearer super-secret-token sk-fixtureSecret12345678\n');
    process.stdout.write('{malformed}\n');
    send({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: null } });
  } else if (message.method === 'thread/list' && mode === 'disconnect') {
    send({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: null } });
    setImmediate(() => process.exit(7));
  } else if (message.method === 'thread/list' && mode === 'timeout') {
    // Intentionally leave the request pending.
  } else if (message.method === 'thread/list' && mode === 'server-request') {
    send({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: null } });
  } else if (message.method === 'thread/list' && mode === 'malformed') {
    send({ id: message.id, result: { data: 'invalid', nextCursor: null } });
  } else if (
    mode === 'operations' &&
    ['thread/name/set', 'thread/archive', 'thread/unarchive'].includes(message.method)
  ) {
    send({ id: message.id, result: {} });
    if (message.method === 'thread/name/set') {
      send({
        method: 'thread/name/updated',
        params: { threadId: message.params.threadId, threadName: message.params.name }
      });
    } else {
      send({ method: message.method === 'thread/archive' ? 'thread/archived' : 'thread/unarchived', params: message.params });
    }
  } else if (mode === 'server-request' && message.id === 'server-request-1' && message.error) {
    send({ method: 'fixture/serverRequestRejected', params: { code: message.error.code } });
  } else if (message.method === 'thread/list' && mode === 'operations' && initialized) {
    send({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: null } });
  } else if (message.method === 'thread/list') {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function conversationThread(threadId) {
  return {
    id: threadId,
    sessionId: 'session-1',
    forkedFromId: null,
    parentThreadId: null,
    preview: 'Fixture conversation',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1752633600,
    updatedAt: 1752633660,
    recencyAt: 1752633660,
    status: { type: 'idle' },
    path: null,
    cwd: 'D:\\workspace',
    cliVersion: '0.144.2',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: 'Fixture conversation',
    turns: [{
      id: 'turn-1',
      itemsView: 'full',
      status: 'completed',
      error: null,
      startedAt: 1752633600,
      completedAt: 1752633602,
      durationMs: 2000,
      items: [
        {
          type: 'userMessage',
          id: 'user-1',
          clientId: null,
          content: [{ type: 'text', text: 'Hello', text_elements: [] }]
        },
        {
          type: 'agentMessage',
          id: 'agent-1',
          text: 'Hi there',
          phase: 'final_answer',
          memoryCitation: null
        }
      ]
    }]
  };
}
