import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadItem } from '../../src/codex/protocol/generated/v2/ThreadItem';
import type { Turn } from '../../src/codex/protocol/generated/v2/Turn';
import type { ConversationNotification } from '../../src/codex/protocol/guards';
import {
  activeConversationTurnId,
  createConversationReducerState,
  hydrateConversationReducer,
  reduceConversationNotification
} from '../../src/conversation/conversationReducer';
import { createThread, createTurn } from '../support/threadFixture';

function agentMessage(id: string, text: string): ThreadItem {
  return {
    type: 'agentMessage',
    id,
    text,
    phase: null,
    memoryCitation: null
  };
}

function notification(value: ConversationNotification): ConversationNotification {
  return value;
}

test('upserts lifecycle notifications by turn and item ID and treats completion as authoritative', () => {
  let state = createConversationReducerState(createThread({ turns: [] }));
  const startedTurn = createTurn({
    id: 'turn-live',
    status: 'inProgress',
    items: [],
    completedAt: null,
    durationMs: null
  });
  state = reduceConversationNotification(state, notification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: startedTurn }
  }));
  state = reduceConversationNotification(state, notification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      item: agentMessage('agent-live', ''),
      startedAtMs: 1
    }
  }));
  state = reduceConversationNotification(state, notification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      itemId: 'agent-live',
      delta: 'Hi'
    }
  }));
  state = reduceConversationNotification(state, notification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      itemId: 'agent-live',
      delta: 'Hi'
    }
  }));

  const duplicated = state.thread.turns[0]?.items[0];
  assert.equal(duplicated?.type, 'agentMessage');
  if (duplicated?.type === 'agentMessage') {
    assert.equal(duplicated.text, 'HiHi');
  }

  const completedTurn = createTurn({
    id: 'turn-live',
    status: 'completed',
    items: [agentMessage('agent-live', 'Hi')]
  });
  state = reduceConversationNotification(state, notification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: completedTurn }
  }));
  assert.deepEqual(state.thread.turns[0], completedTurn);
  assert.equal(activeConversationTurnId(state), null);

  const terminal = state;
  state = reduceConversationNotification(state, notification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      itemId: 'agent-live',
      delta: ' late'
    }
  }));
  assert.equal(state, terminal);
});

test('keeps an early delta when started events arrive later', () => {
  let state = createConversationReducerState(createThread({ turns: [] }));
  state = reduceConversationNotification(state, notification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-out-of-order',
      itemId: 'agent-out-of-order',
      delta: 'Early text'
    }
  }));
  state = reduceConversationNotification(state, notification({
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: createTurn({
        id: 'turn-out-of-order',
        status: 'inProgress',
        items: [],
        completedAt: null,
        durationMs: null
      })
    }
  }));
  state = reduceConversationNotification(state, notification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-out-of-order',
      item: agentMessage('agent-out-of-order', ''),
      startedAtMs: 2
    }
  }));

  const item = state.thread.turns[0]?.items[0];
  assert.equal(item?.type, 'agentMessage');
  if (item?.type === 'agentMessage') {
    assert.equal(item.text, 'Early text');
  }
  assert.equal(activeConversationTurnId(state), 'turn-out-of-order');
});

test('does not regress an item completed before its started notifications', () => {
  let state = createConversationReducerState(createThread({ turns: [] }));
  state = reduceConversationNotification(state, notification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-out-of-order',
      item: agentMessage('agent-out-of-order', 'Final text'),
      completedAtMs: 1
    }
  }));
  state = reduceConversationNotification(state, notification({
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: createTurn({
        id: 'turn-out-of-order',
        status: 'inProgress',
        completedAt: null,
        durationMs: null,
        items: [agentMessage('agent-out-of-order', '')]
      })
    }
  }));
  const beforeLateDelta = state;
  state = reduceConversationNotification(state, notification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-out-of-order',
      itemId: 'agent-out-of-order',
      delta: ' duplicate'
    }
  }));

  assert.equal(state, beforeLateDelta);
  const item = state.thread.turns[0]?.items[0];
  assert.equal(item?.type, 'agentMessage');
  if (item?.type === 'agentMessage') {
    assert.equal(item.text, 'Final text');
  }
});

test('flags a completed item whose type conflicts with its started shape', () => {
  let state = createConversationReducerState(createThread({ turns: [] }));
  state = reduceConversationNotification(state, notification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      item: agentMessage('item-conflict', ''),
      startedAtMs: 1
    }
  }));
  state = reduceConversationNotification(state, notification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      item: { type: 'plan', id: 'item-conflict', text: 'Different shape' },
      completedAtMs: 2
    }
  }));

  assert.equal(state.needsResync, true);
});

test('ignores foreign threads and flags an item ID owned by another turn', () => {
  const firstTurn = createTurn({
    id: 'turn-1',
    items: [agentMessage('shared-item', 'Done')]
  });
  const initial = createConversationReducerState(createThread({ turns: [firstTurn] }));
  const foreign = reduceConversationNotification(initial, notification({
    method: 'turn/started',
    params: {
      threadId: 'thread-foreign',
      turn: createTurn({ id: 'foreign', status: 'inProgress' })
    }
  }));
  assert.equal(foreign, initial);

  const collision = reduceConversationNotification(initial, notification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      item: agentMessage('shared-item', ''),
      startedAtMs: 3
    }
  }));
  assert.equal(collision.needsResync, true);
  assert.deepEqual(collision.thread, initial.thread);
});

test('marks contradictory terminal errors and multiple active turns for resync', () => {
  const active = (id: string): Turn => createTurn({
    id,
    status: 'inProgress',
    completedAt: null,
    durationMs: null
  });
  const initial = createConversationReducerState(createThread({
    turns: [active('turn-1'), active('turn-2')]
  }));
  assert.equal(initial.needsResync, true);
  assert.equal(activeConversationTurnId(initial), null);

  const errorState = reduceConversationNotification(
    createConversationReducerState(createThread()),
    notification({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: {
          message: 'private server detail',
          codexErrorInfo: null,
          additionalDetails: null
        }
      }
    })
  );
  assert.equal(errorState.needsResync, true);
});

test('hydrates only the same thread and clears provisional state on authoritative reload', () => {
  let state = createConversationReducerState(createThread({ turns: [] }));
  state = reduceConversationNotification(state, notification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-provisional',
      itemId: 'agent-provisional',
      delta: 'temporary'
    }
  }));

  const authoritative = createThread({
    name: 'Reloaded',
    turns: [createTurn({
      id: 'turn-final',
      items: [agentMessage('agent-final', 'Final')]
    })]
  });
  state = hydrateConversationReducer(state, authoritative);
  assert.equal(state.thread.name, 'Reloaded');
  assert.deepEqual(state.thread.turns.map((turn) => turn.id), ['turn-final']);
  assert.equal(state.needsResync, false);

  const mismatched = hydrateConversationReducer(state, createThread({ id: 'other-thread' }));
  assert.equal(mismatched.thread.id, 'thread-1');
  assert.equal(mismatched.needsResync, true);
});
