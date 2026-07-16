import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadItem } from '../../src/codex/protocol/generated/v2/ThreadItem';
import { toConversationViewModel } from '../../src/conversation/conversationViewModel';
import { createThread, createTurn } from '../support/threadFixture';

const hiddenValues = {
  reasoning: 'private reasoning content',
  output: 'secret command output',
  diff: 'secret patch diff',
  prompt: 'secret delegated prompt',
  hook: 'secret hook fragment'
};

const items: ThreadItem[] = [
  {
    type: 'userMessage',
    id: 'user-1',
    clientId: null,
    content: [
      { type: 'text', text: '<script>alert(1)</script>', text_elements: [] },
      { type: 'localImage', path: 'D:\\image.png' },
      { type: 'skill', name: 'review', path: 'D:\\skill' },
      { type: 'mention', name: 'AGENTS.md', path: 'D:\\AGENTS.md' }
    ]
  },
  {
    type: 'agentMessage',
    id: 'agent-1',
    text: 'Done safely.',
    phase: 'final_answer',
    memoryCitation: null
  },
  {
    type: 'reasoning',
    id: 'reasoning-1',
    summary: ['Checked the implementation.'],
    content: [hiddenValues.reasoning]
  },
  {
    type: 'commandExecution',
    id: 'command-1',
    command: 'npm test',
    cwd: 'D:\\workspace',
    processId: null,
    source: 'agent',
    status: 'completed',
    commandActions: [],
    aggregatedOutput: hiddenValues.output,
    exitCode: 0,
    durationMs: 125
  },
  {
    type: 'fileChange',
    id: 'file-1',
    changes: [{
      path: 'src/example.ts',
      kind: { type: 'update', move_path: null },
      diff: hiddenValues.diff
    }],
    status: 'completed'
  },
  {
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'thread-1',
    receiverThreadIds: ['thread-child'],
    prompt: hiddenValues.prompt,
    model: null,
    reasoningEffort: null,
    agentsStates: {}
  },
  {
    type: 'hookPrompt',
    id: 'hook-1',
    fragments: [{ text: hiddenValues.hook, hookRunId: 'hook-run-1' }]
  }
];

test('maps stored history in order while excluding sensitive work payloads', () => {
  const model = toConversationViewModel(createThread({
    name: 'Conversation fixture',
    status: { type: 'active', activeFlags: [] },
    turns: [createTurn({
      items,
      itemsView: 'summary',
      status: 'failed',
      error: {
        message: 'Fixture failure',
        codexErrorInfo: 'other',
        additionalDetails: null
      }
    })]
  }));

  assert.equal(model.title, 'Conversation fixture');
  assert.equal(model.status, 'Running');
  assert.equal(model.updatedAt, 1_752_633_660_000);
  assert.equal(model.isPartialHistory, true);
  assert.deepEqual(model.turns[0]?.items.map((item) => item.id), items.map((item) => item.id));
  assert.equal(model.turns[0]?.startedAt, 1_752_633_600_000);
  assert.equal(model.turns[0]?.durationMs, 2_000);
  assert.equal(model.turns[0]?.errorMessage, 'Fixture failure');

  const userMessage = model.turns[0]?.items[0];
  assert.equal(userMessage?.kind, 'message');
  if (userMessage?.kind === 'message') {
    assert.match(userMessage.text, /<script>alert\(1\)<\/script>/u);
    assert.match(userMessage.text, /\[Image attachment\]/u);
    assert.match(userMessage.text, /\[Skill: review\]/u);
    assert.match(userMessage.text, /\[Mention: AGENTS\.md\]/u);
  }

  const serialized = JSON.stringify(model);
  for (const hidden of Object.values(hiddenValues)) {
    assert.equal(serialized.includes(hidden), false, `Expected hidden payload not to include ${hidden}.`);
  }
  assert.match(serialized, /Checked the implementation/u);
  assert.match(serialized, /npm test/u);
  assert.match(serialized, /src\/example\.ts/u);
});

test('falls back to a generic card for a future unknown item variant', () => {
  const futureItem = {
    type: 'futureWorkItem',
    id: 'future-1',
    internalPayload: 'do not expose'
  } as unknown as ThreadItem;
  const model = toConversationViewModel(createThread({
    turns: [createTurn({ items: [futureItem] })]
  }));

  assert.deepEqual(model.turns[0]?.items[0], {
    kind: 'activity',
    id: 'future-1',
    activityKind: 'unknown',
    title: 'Unsupported work item: futureWorkItem',
    status: null,
    detail: null
  });
  assert.equal(JSON.stringify(model).includes('do not expose'), false);
});
