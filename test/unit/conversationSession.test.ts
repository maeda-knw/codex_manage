import assert from 'node:assert/strict';
import test from 'node:test';
import type { Thread } from '../../src/codex/protocol/generated/v2/Thread';
import type { ThreadResumeResponse } from '../../src/codex/protocol/generated/v2/ThreadResumeResponse';
import type { Turn } from '../../src/codex/protocol/generated/v2/Turn';
import type { Model } from '../../src/codex/protocol/generated/v2/Model';
import {
  ConversationSession,
  type ConversationSessionClient
} from '../../src/conversation/conversationSession';
import { createThread, createTurn } from '../support/threadFixture';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error)
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

function liveTurn(id = 'turn-live'): Turn {
  return createTurn({
    id,
    status: 'inProgress',
    completedAt: null,
    durationMs: null,
    items: []
  });
}

test('resumes before starting a text turn and locks concurrent sends', async () => {
  const resume = deferred<ThreadResumeResponse>();
  const start = deferred<{ turn: Turn }>();
  const startParams: unknown[] = [];
  let resumeCalls = 0;
  const client: ConversationSessionClient = {
    resumeThread: async () => {
      resumeCalls += 1;
      return resume.promise;
    },
    readThread: async () => ({ thread: createThread() }),
    startTurn: async (params) => {
      startParams.push(params);
      return start.promise;
    },
    interruptTurn: async () => ({}),
    listModels: async () => ({ data: [], nextCursor: null })
  };
  const session = new ConversationSession(client, createThread());

  const first = session.send('Continue the thread');
  const duplicate = await session.send('Duplicate');
  assert.equal(duplicate, false);
  assert.equal(resumeCalls, 1);
  assert.equal(session.snapshot().operation, 'resuming');

  resume.resolve(resumeResponse(createThread()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(startParams.length, 1);
  assert.deepEqual(
    (startParams[0] as { input: unknown }).input,
    [{ type: 'text', text: 'Continue the thread', text_elements: [] }]
  );
  assert.match(
    String((startParams[0] as { clientUserMessageId?: unknown }).clientUserMessageId),
    /^[0-9a-f-]{36}$/u
  );

  start.resolve({ turn: liveTurn() });
  assert.equal(await first, true);
  assert.equal(session.snapshot().activeTurnId, 'turn-live');
  assert.equal(session.snapshot().operation, 'running');
});

test('applies streaming deltas and converges on the completed turn snapshot', () => {
  const client = passiveClient();
  const session = new ConversationSession(client, createThread());
  const turn = liveTurn();
  session.applyNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn }
  });
  session.applyNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: turn.id,
      itemId: 'agent-live',
      delta: 'Streamed'
    }
  });
  assert.equal(session.snapshot().model.turns[0]?.items[0]?.kind, 'message');

  const completed = createTurn({
    id: turn.id,
    status: 'completed',
    items: [{
      type: 'agentMessage',
      id: 'agent-live',
      text: 'Final response',
      phase: 'final_answer',
      memoryCitation: null
    }]
  });
  session.applyNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: completed }
  });

  const item = session.snapshot().model.turns[0]?.items[0];
  assert.equal(item?.kind, 'message');
  if (item?.kind === 'message') {
    assert.equal(item.text, 'Final response');
  }
  assert.equal(session.snapshot().operation, 'idle');
});

test('stops only the host-owned active turn and rejects a duplicate Stop', async () => {
  const interrupt = deferred<Record<string, never>>();
  const calls: unknown[] = [];
  const client: ConversationSessionClient = {
    ...passiveClient(),
    interruptTurn: async (params) => {
      calls.push(params);
      return interrupt.promise;
    }
  };
  const session = new ConversationSession(client, createThread({
    status: { type: 'active', activeFlags: [] },
    turns: [liveTurn('turn-owned')]
  }));

  const first = session.stop();
  const duplicate = await session.stop();
  assert.equal(duplicate, false);
  assert.deepEqual(calls, [{ threadId: 'thread-1', turnId: 'turn-owned' }]);
  interrupt.resolve({});
  assert.equal(await first, true);
  assert.equal(session.snapshot().operation, 'interrupting');

  session.applyNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: createTurn({ id: 'turn-owned', status: 'interrupted' })
    }
  });
  session.applyNotification({
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'idle' } }
  });
  assert.equal(session.snapshot().operation, 'idle');
  assert.equal(session.snapshot().notice, 'The turn was stopped.');
});

test('keeps history while disconnected and replaces it after resume/read resync', async () => {
  const initial = createThread({
    name: 'Before disconnect',
    turns: [createTurn({ id: 'turn-old' })]
  });
  const reloaded = createThread({
    name: 'After reconnect',
    turns: [createTurn({ id: 'turn-new' })]
  });
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async () => resumeResponse(initial),
    readThread: async () => ({ thread: reloaded })
  };
  const session = new ConversationSession(client, initial);

  session.markDisconnected();
  assert.equal(session.snapshot().sync, 'stale');
  assert.equal(session.snapshot().model.title, 'Before disconnect');
  assert.equal(await session.resync(), true);
  assert.equal(session.snapshot().sync, 'ready');
  assert.equal(session.snapshot().model.title, 'After reconnect');
  assert.deepEqual(session.snapshot().model.turns.map((turn) => turn.id), ['turn-new']);
});

test('does not expose an unexpected transport error in the session notice', async () => {
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async () => {
      throw new Error('private transport detail');
    }
  };
  const session = new ConversationSession(client, createThread());

  assert.equal(await session.send('Hello'), false);
  assert.doesNotMatch(session.snapshot().notice ?? '', /private transport detail/u);
});

test('keeps an active thread without a visible turn locked instead of starting another turn', async () => {
  let resumeCalls = 0;
  let startCalls = 0;
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async (params) => {
      resumeCalls += 1;
      return resumeResponse(createThread({ id: params.threadId }));
    },
    startTurn: async () => {
      startCalls += 1;
      return { turn: liveTurn() };
    }
  };
  const session = new ConversationSession(client, createThread({
    status: { type: 'active', activeFlags: [] }
  }));

  assert.equal(session.snapshot().operation, 'resuming');
  assert.equal(await session.send('Do not overlap'), false);
  assert.equal(resumeCalls, 0);
  assert.equal(startCalls, 0);
});

test('cancels a pending send when its session is disposed', async () => {
  const resume = deferred<ThreadResumeResponse>();
  let startCalls = 0;
  const client: ConversationSessionClient = {
    ...passiveClient(),
    resumeThread: async () => resume.promise,
    startTurn: async () => {
      startCalls += 1;
      return { turn: liveTurn() };
    }
  };
  const session = new ConversationSession(client, createThread());
  const sending = session.send('Cancel before start');
  session.dispose();
  resume.resolve(resumeResponse(createThread()));

  assert.equal(await sending, false);
  assert.equal(startCalls, 0);
});

test('retries an authoritative read when notifications race with resynchronization', async () => {
  let readCalls = 0;
  let session: ConversationSession;
  const client: ConversationSessionClient = {
    ...passiveClient(),
    readThread: async () => {
      readCalls += 1;
      if (readCalls < 3) {
        session.applyNotification({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: `turn-race-${readCalls}`,
            itemId: `item-race-${readCalls}`,
            delta: 'racing'
          }
        });
      }
      return { thread: createThread({ name: `Authoritative ${readCalls}` }) };
    }
  };
  session = new ConversationSession(client, createThread());
  session.markDisconnected();

  assert.equal(await session.resync(), true);
  assert.equal(readCalls, 3);
  assert.equal(session.snapshot().sync, 'ready');
  assert.equal(session.snapshot().model.title, 'Authoritative 3');
});

test('becomes stale as soon as a notification creates an ID collision', () => {
  const session = new ConversationSession(passiveClient(), createThread({
    turns: [createTurn({
      id: 'turn-old',
      items: [{
        type: 'agentMessage',
        id: 'shared-item',
        text: 'Done',
        phase: null,
        memoryCitation: null
      }]
    })]
  }));
  session.applyNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-new',
      item: {
        type: 'agentMessage',
        id: 'shared-item',
        text: '',
        phase: null,
        memoryCitation: null
      },
      startedAtMs: 1
    }
  });

  assert.equal(session.snapshot().sync, 'stale');
  assert.match(session.snapshot().notice ?? '', /resynchronize/iu);
});

test('keeps an inconsistent authoritative reload stale', async () => {
  const active = (id: string): Turn => createTurn({
    id,
    status: 'inProgress',
    completedAt: null,
    durationMs: null
  });
  const client: ConversationSessionClient = {
    ...passiveClient(),
    readThread: async () => ({
      thread: createThread({
        status: { type: 'active', activeFlags: [] },
        turns: [active('turn-1'), active('turn-2')]
      })
    })
  };
  const session = new ConversationSession(client, createThread());
  session.markDisconnected();

  assert.equal(await session.resync(), false);
  assert.equal(session.snapshot().sync, 'stale');
  assert.match(session.snapshot().notice ?? '', /inconsistent/iu);
});

test('updates cached display metadata without changing conversation history', () => {
  const session = new ConversationSession(passiveClient(), createThread({
    name: 'Before rename',
    turns: [createTurn({ id: 'turn-kept' })]
  }));
  session.updateTitle('After rename');

  assert.equal(session.snapshot().model.title, 'After rename');
  assert.deepEqual(session.snapshot().model.turns.map((turn) => turn.id), ['turn-kept']);
});

test('loads validated runtime choices and applies changed settings only to the next turn', async () => {
  const resumeParams: unknown[] = [];
  const startParams: unknown[] = [];
  const fixtureModel: Model = {
    id: 'fixture-id',
    model: 'gpt-fixture',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT Fixture',
    description: 'Fixture model',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'More reasoning' }
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: [],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Lower latency' }],
    defaultServiceTier: null,
    isDefault: true
  };
  const client: ConversationSessionClient = {
    ...passiveClient(),
    listModels: async () => ({
      data: [
        fixtureModel,
        { ...fixtureModel, id: 'gpt-5.6-terra-id', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', isDefault: false },
        { ...fixtureModel, id: 'gpt-5.6-luna-id', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', isDefault: false }
      ],
      nextCursor: null
    }),
    resumeThread: async (params) => {
      resumeParams.push(params);
      return resumeResponse(createThread({ id: params.threadId }));
    },
    startTurn: async (params) => {
      startParams.push(params);
      return { turn: liveTurn() };
    }
  };
  const session = new ConversationSession(client, createThread());

  assert.equal(await session.loadRuntimeSettings(), true);
  assert.equal(session.snapshot().runtime.model, 'fixture-id');
  assert.deepEqual(session.snapshot().runtime.models.map((model) => [model.value, model.label]), [
    ['fixture-id', 'GPT Fixture'],
    ['gpt-5.6-terra-id', 'GPT-5.6-Terra'],
    ['gpt-5.6-luna-id', 'GPT-5.6-Luna']
  ]);
  assert.equal(session.updateRuntimeSettings({
    model: 'fixture-id',
    effort: 'high',
    serviceTier: 'fast',
    sandbox: 'read-only',
    approvalPolicy: 'never'
  }), true);
  assert.equal(await session.send('Use the selected runtime'), true);

  assert.deepEqual(resumeParams[1], {
    threadId: 'thread-1',
    model: 'gpt-fixture',
    serviceTier: 'fast',
    approvalPolicy: 'never',
    sandbox: 'read-only'
  });
  assert.equal((startParams[0] as { effort?: unknown }).effort, 'high');
  assert.equal((startParams[0] as { serviceTier?: unknown }).serviceTier, 'fast');
  assert.equal((startParams[0] as { approvalPolicy?: unknown }).approvalPolicy, 'never');
});

function passiveClient(): ConversationSessionClient {
  return {
    resumeThread: async (params) => resumeResponse(createThread({ id: params.threadId })),
    readThread: async (params) => ({ thread: createThread({ id: params.threadId }) }),
    startTurn: async () => ({ turn: liveTurn() }),
    interruptTurn: async () => ({}),
    listModels: async () => ({ data: [], nextCursor: null })
  };
}
