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
    } else if (mode === 'server-request-supported') {
      send({
        id: 'server-request-2',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1,
          command: 'npm test', cwd: '<fixture>', reason: 'test approval'
        }
      });
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
  } else if (message.method === 'thread/resume' && mode === 'conversation-live') {
    if (message.params?.threadId !== 'thread-1') {
      send({ id: message.id, error: { code: -32602, message: 'Expected thread-1' } });
    } else {
      send({ id: message.id, result: resumeResponse('thread-1') });
    }
  } else if (message.method === 'turn/start' && mode === 'conversation-live') {
    const textInput = message.params?.input?.[0];
    if (
      message.params?.threadId !== 'thread-1' ||
      message.params?.clientUserMessageId !== 'client-message-1' ||
      textInput?.type !== 'text' ||
      textInput?.text !== 'Continue the fixture' ||
      !Array.isArray(textInput?.text_elements) ||
      textInput.text_elements.length !== 0
    ) {
      send({ id: message.id, error: { code: -32602, message: 'Unexpected turn/start params' } });
    } else {
      const runningTurn = conversationTurn('turn-live', 'inProgress', []);
      const userItem = {
        type: 'userMessage',
        id: 'user-live',
        clientId: 'client-message-1',
        content: [{ type: 'text', text: 'Continue the fixture', text_elements: [] }]
      };
      const startedAgentItem = {
        type: 'agentMessage',
        id: 'agent-live',
        text: '',
        phase: 'final_answer',
        memoryCitation: null
      };
      const completedAgentItem = { ...startedAgentItem, text: 'Streaming reply' };
      send({ id: message.id, result: { turn: runningTurn } });
      send({ method: 'turn/started', params: { threadId: 'thread-1', turn: runningTurn } });
      send({
        method: 'thread/status/changed',
        params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } }
      });
      send({
        method: 'item/started',
        params: { threadId: 'thread-1', turnId: 'turn-live', item: userItem, startedAtMs: 1_752_633_700_000 }
      });
      send({
        method: 'item/completed',
        params: { threadId: 'thread-1', turnId: 'turn-live', item: userItem, completedAtMs: 1_752_633_700_100 }
      });
      send({
        method: 'item/started',
        params: { threadId: 'thread-1', turnId: 'turn-live', item: startedAgentItem, startedAtMs: 1_752_633_700_200 }
      });
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'agent-live', delta: 'Streaming reply' }
      });
      send({
        method: 'item/completed',
        params: { threadId: 'thread-1', turnId: 'turn-live', item: completedAgentItem, completedAtMs: 1_752_633_701_000 }
      });
      send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: conversationTurn('turn-live', 'completed', [userItem, completedAgentItem])
        }
      });
      send({
        method: 'thread/status/changed',
        params: { threadId: 'thread-1', status: { type: 'idle' } }
      });
    }
  } else if (message.method === 'turn/interrupt' && mode === 'conversation-live') {
    if (message.params?.threadId !== 'thread-1' || message.params?.turnId !== 'turn-live') {
      send({ id: message.id, error: { code: -32602, message: 'Unexpected turn/interrupt params' } });
    } else {
      send({ id: message.id, result: {} });
    }
  } else if (message.method === 'thread/resume' && mode === 'malformed-thread-resume') {
    send({ id: message.id, result: { thread: conversationThread('thread-1') } });
  } else if (message.method === 'turn/start' && mode === 'malformed-turn-start') {
    send({ id: message.id, result: { turn: { id: 'turn-broken', items: 'invalid' } } });
  } else if (message.method === 'turn/interrupt' && mode === 'malformed-turn-interrupt') {
    send({ id: message.id, result: { unexpected: true } });
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
  } else if (message.method === 'thread/list' && mode === 'server-request-supported') {
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
  } else if (mode === 'server-request-supported' && message.id === 'server-request-2' && message.result) {
    send({ method: 'fixture/serverRequestAnswered', params: message.result });
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

function resumeResponse(threadId) {
  return {
    thread: conversationThread(threadId),
    model: 'gpt-fixture',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: 'D:\\workspace',
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: ['D:\\workspace'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    reasoningEffort: 'medium'
  };
}

function conversationTurn(id, status, items) {
  const completed = status !== 'inProgress';
  return {
    id,
    items,
    itemsView: 'full',
    status,
    error: null,
    startedAt: 1_752_633_700,
    completedAt: completed ? 1_752_633_701 : null,
    durationMs: completed ? 1_000 : null
  };
}
