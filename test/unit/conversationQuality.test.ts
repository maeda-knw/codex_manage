import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadItem } from '../../src/codex/protocol/generated/v2/ThreadItem';
import type { ConversationNotification } from '../../src/codex/protocol/guards';
import {
  activeConversationTurnId,
  createConversationReducerState,
  reduceConversationNotification
} from '../../src/conversation/conversationReducer';
import { createThread, createTurn } from '../support/threadFixture';

function agentMessage(id: string, text: string): ThreadItem {
  return { type: 'agentMessage', id, text, phase: null, memoryCitation: null };
}

test('indexes a thousand-turn stored history without losing item ownership', { timeout: 5_000 }, () => {
  const turns = Array.from({ length: 1_000 }, (_, index) => createTurn({
    id: `turn-${index}`,
    items: [
      agentMessage(`agent-${index}-a`, `First response ${index}`),
      agentMessage(`agent-${index}-b`, `Second response ${index}`)
    ]
  }));

  const state = createConversationReducerState(createThread({ turns }));

  assert.equal(state.thread.turns.length, 1_000);
  assert.equal(state.items.size, 2_000);
  assert.equal(state.items.get('agent-999-b')?.turnId, 'turn-999');
  assert.equal(state.needsResync, false);
  assert.equal(activeConversationTurnId(state), null);
});

test('converges after five thousand streaming deltas and ignores foreign-thread noise', { timeout: 5_000 }, () => {
  let state = createConversationReducerState(createThread({ turns: [] }));
  const chunk = '0123456789';

  for (let index = 0; index < 5_000; index += 1) {
    state = reduceConversationNotification(state, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-stream',
        itemId: 'agent-stream',
        delta: chunk
      }
    });
  }

  const streamed = state.thread.turns[0]?.items[0];
  assert.equal(streamed?.type, 'agentMessage');
  if (streamed?.type === 'agentMessage') {
    assert.equal(streamed.text.length, 50_000);
    assert.equal(streamed.text.slice(-chunk.length), chunk);
  }
  assert.equal(state.needsResync, false);

  const beforeForeignNoise = state;
  const foreignNotification: ConversationNotification = {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-2',
      turnId: 'foreign-turn',
      itemId: 'foreign-item',
      delta: 'must not cross threads'
    }
  };
  for (let index = 0; index < 5_000; index += 1) {
    state = reduceConversationNotification(state, foreignNotification);
  }
  assert.equal(state, beforeForeignNoise);

  state = reduceConversationNotification(state, {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: createTurn({
        id: 'turn-stream',
        items: [agentMessage('agent-stream', 'Authoritative final response')]
      })
    }
  });
  const completed = state.thread.turns[0]?.items[0];
  assert.equal(completed?.type, 'agentMessage');
  if (completed?.type === 'agentMessage') {
    assert.equal(completed.text, 'Authoritative final response');
  }
  assert.equal(activeConversationTurnId(state), null);
});
