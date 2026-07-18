import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  AppServerClient,
  type AppServerNotification
} from '../../src/codex/appServerClient';
import type { CodexCommand } from '../../src/codex/codexExecutableResolver';
import {
  parseConversationNotification,
  type ConversationNotification
} from '../../src/codex/protocol/guards';
import { AppServerError } from '../../src/common/errors';

const fakeServerPath = resolve(process.cwd(), 'test', 'integration', 'fake-app-server.mjs');

function fakeCommand(mode: string): CodexCommand {
  return {
    executable: process.execPath,
    prefixArgs: [fakeServerPath, mode],
    resolvedPath: '<fake-codex>',
    source: 'configured-native'
  };
}

function createClient(mode: string, logs: string[]): AppServerClient {
  return new AppServerClient({
    codexPath: 'codex',
    clientVersion: '0.0.1-test',
    logger: { appendLine: (value) => logs.push(value) },
    requestTimeoutMs: 2_000,
    commandResolver: async () => fakeCommand(mode),
    versionProbe: async () => ({ raw: 'codex-cli 0.144.2', version: '0.144.2' })
  });
}

function waitForConversationNotification(
  client: AppServerClient,
  predicate: (notification: ConversationNotification) => boolean
): Promise<ConversationNotification> {
  return new Promise((resolveNotification) => {
    const subscription = client.onNotification((notification: AppServerNotification) => {
      const parsed = parseConversationNotification(notification.method, notification.params);
      if (parsed && predicate(parsed)) {
        subscription.dispose();
        resolveNotification(parsed);
      }
    });
  });
}

test('reads the requested thread with stored turns and items', async (t) => {
  const logs: string[] = [];
  const client = createClient('thread-read', logs);
  t.after(() => client.dispose());

  const response = await client.readThread({
    threadId: 'thread-1',
    includeTurns: true
  });

  assert.equal(response.thread.id, 'thread-1');
  assert.equal(response.thread.turns[0]?.items[0]?.type, 'userMessage');
  assert.equal(response.thread.turns[0]?.items[1]?.type, 'agentMessage');
});

test('reads workspace defaults and starts a thread with the selected runtime', async (t) => {
  const logs: string[] = [];
  const client = createClient('new-conversation', logs);
  t.after(() => client.dispose());

  const config = await client.readConversationConfig({ cwd: 'D:\\workspace' });
  assert.deepEqual(config, {
    model: 'gpt-fixture',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user'
  });

  const started = await client.startThread({
    model: config.model,
    serviceTier: config.serviceTier,
    cwd: 'D:\\workspace',
    approvalPolicy: config.approvalPolicy,
    approvalsReviewer: config.approvalsReviewer,
    sandbox: config.sandbox,
    ephemeral: false,
    sessionStartSource: 'startup',
    threadSource: 'codex-thread-manager'
  });

  assert.equal(started.thread.id, 'thread-new');
  assert.equal(started.thread.turns.length, 0);
  assert.equal(started.model, 'gpt-fixture');
  assert.equal(started.serviceTier, 'fast');
});

test('classifies malformed config and thread start responses as incompatible', async () => {
  const cases = [
    {
      mode: 'malformed-config-read',
      invoke: (client: AppServerClient) => client.readConversationConfig({ cwd: 'D:\\workspace' }),
      expectedLog: 'invalid config/read response'
    },
    {
      mode: 'malformed-thread-start',
      invoke: (client: AppServerClient) => client.startThread({ cwd: 'D:\\workspace' }),
      expectedLog: 'invalid thread/start response'
    }
  ] as const;

  for (const testCase of cases) {
    const logs: string[] = [];
    const client = createClient(testCase.mode, logs);
    try {
      await assert.rejects(
        testCase.invoke(client),
        (error) => error instanceof AppServerError && error.code === 'incompatible-cli'
      );
      assert.equal(logs.some((line) => line.includes(testCase.expectedLog)), true);
    } finally {
      client.dispose();
    }
  }
});

test('classifies malformed conversation history as an incompatible CLI boundary', async (t) => {
  const logs: string[] = [];
  const client = createClient('malformed-thread-read', logs);
  t.after(() => client.dispose());

  await assert.rejects(
    client.readThread({ threadId: 'thread-1', includeTurns: true }),
    (error) => error instanceof AppServerError && error.code === 'incompatible-cli'
  );
  assert.equal(client.getDiagnostics().compatibility, 'incompatible');
  assert.equal(logs.some((line) => line.includes('invalid thread/read response')), true);
});

test('resumes a thread, starts a text turn, streams notifications, and interrupts by turn ID', async (t) => {
  const logs: string[] = [];
  const client = createClient('conversation-live', logs);
  t.after(() => client.dispose());

  const resumed = await client.resumeThread({ threadId: 'thread-1' });
  assert.equal(resumed.thread.id, 'thread-1');
  assert.equal(resumed.model, 'gpt-fixture');

  const userItemCompleted = waitForConversationNotification(
    client,
    (notification) => (
      notification.method === 'item/completed' &&
      notification.params.item.type === 'userMessage'
    )
  );
  const agentDelta = waitForConversationNotification(
    client,
    (notification) => notification.method === 'item/agentMessage/delta'
  );
  const turnCompleted = waitForConversationNotification(
    client,
    (notification) => notification.method === 'turn/completed'
  );

  const started = await client.startTurn({
    threadId: 'thread-1',
    clientUserMessageId: 'client-message-1',
    input: [{
      type: 'text',
      text: 'Continue the fixture',
      text_elements: []
    }]
  });

  assert.equal(started.turn.id, 'turn-live');
  assert.equal(started.turn.status, 'inProgress');

  const completedUserNotification = await userItemCompleted;
  assert.equal(completedUserNotification.method, 'item/completed');
  if (
    completedUserNotification.method === 'item/completed' &&
    completedUserNotification.params.item.type === 'userMessage'
  ) {
    assert.equal(completedUserNotification.params.item.clientId, 'client-message-1');
    assert.equal(completedUserNotification.params.completedAtMs, 1_752_633_700_100);
  }

  const deltaNotification = await agentDelta;
  assert.equal(deltaNotification.method, 'item/agentMessage/delta');
  if (deltaNotification.method === 'item/agentMessage/delta') {
    assert.equal(deltaNotification.params.itemId, 'agent-live');
    assert.equal(deltaNotification.params.delta, 'Streaming reply');
  }

  const completedTurnNotification = await turnCompleted;
  assert.equal(completedTurnNotification.method, 'turn/completed');
  if (completedTurnNotification.method === 'turn/completed') {
    assert.equal(completedTurnNotification.params.turn.status, 'completed');
  }

  await client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-live' });
  assert.equal(logs.some((line) => line.includes('Continue the fixture')), false);
});

test('classifies malformed resume, turn start, and interrupt responses as incompatible', async () => {
  const cases: ReadonlyArray<{
    readonly mode: string;
    readonly invoke: (client: AppServerClient) => Promise<unknown>;
    readonly expectedLog: string;
  }> = [
    {
      mode: 'malformed-thread-resume',
      invoke: (client) => client.resumeThread({ threadId: 'thread-1' }),
      expectedLog: 'invalid thread/resume response'
    },
    {
      mode: 'malformed-turn-start',
      invoke: (client) => client.startTurn({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Hello', text_elements: [] }]
      }),
      expectedLog: 'invalid turn/start response'
    },
    {
      mode: 'malformed-turn-interrupt',
      invoke: (client) => client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' }),
      expectedLog: 'invalid turn/interrupt response'
    }
  ];

  for (const testCase of cases) {
    const logs: string[] = [];
    const client = createClient(testCase.mode, logs);
    try {
      await assert.rejects(
        testCase.invoke(client),
        (error) => error instanceof AppServerError && error.code === 'incompatible-cli'
      );
      assert.equal(logs.some((line) => line.includes(testCase.expectedLog)), true);
    } finally {
      client.dispose();
    }
  }
});
