import type { Thread } from '../codex/protocol/generated/v2/Thread';
import type { ThreadItem } from '../codex/protocol/generated/v2/ThreadItem';
import type { Turn } from '../codex/protocol/generated/v2/Turn';
import type { ConversationNotification } from '../codex/protocol/guards';

type ItemLifecycle = 'unknown' | 'started' | 'completed';

interface ItemState {
  readonly turnId: string;
  readonly lifecycle: ItemLifecycle;
}

/**
 * Host-owned conversation state. Raw protocol values never cross the Webview
 * boundary; ConversationSession exposes only the sanitized ViewModel.
 */
export interface ConversationReducerState {
  readonly thread: Thread;
  readonly items: ReadonlyMap<string, ItemState>;
  readonly needsResync: boolean;
}

export function createConversationReducerState(thread: Thread): ConversationReducerState {
  const items = new Map<string, ItemState>();
  const turnIds = new Set<string>();
  let needsResync = false;
  let activeTurns = 0;

  for (const turn of thread.turns) {
    if (turnIds.has(turn.id)) {
      needsResync = true;
    }
    turnIds.add(turn.id);
    if (turn.status === 'inProgress') {
      activeTurns += 1;
    }
    for (const item of turn.items) {
      const owner = items.get(item.id);
      if (owner && owner.turnId !== turn.id) {
        needsResync = true;
        continue;
      }
      items.set(item.id, {
        turnId: turn.id,
        lifecycle: isTerminalTurn(turn) ? 'completed' : 'unknown'
      });
    }
  }

  return {
    thread,
    items,
    needsResync: needsResync ||
      activeTurns > 1 ||
      (activeTurns > 0 && thread.status.type !== 'active')
  };
}

export function hydrateConversationReducer(
  state: ConversationReducerState,
  thread: Thread
): ConversationReducerState {
  if (thread.id !== state.thread.id) {
    return markNeedsResync(state);
  }
  return createConversationReducerState(thread);
}

export function reduceConversationNotification(
  state: ConversationReducerState,
  notification: ConversationNotification
): ConversationReducerState {
  if (notification.params.threadId !== state.thread.id) {
    return state;
  }

  switch (notification.method) {
    case 'turn/started':
      return reduceTurnStarted(state, notification.params.turn);
    case 'turn/completed':
      return reduceTurnCompleted(state, notification.params.turn);
    case 'item/started':
      return reduceItemStarted(
        state,
        notification.params.turnId,
        notification.params.item
      );
    case 'item/completed':
      return reduceItemCompleted(
        state,
        notification.params.turnId,
        notification.params.item
      );
    case 'item/agentMessage/delta':
      return reduceAgentMessageDelta(
        state,
        notification.params.turnId,
        notification.params.itemId,
        notification.params.delta
      );
    case 'thread/status/changed': {
      const thread = { ...state.thread, status: notification.params.status };
      const inconsistent = notification.params.status.type !== 'active' &&
        hasInProgressConversationTurn(state);
      return {
        ...state,
        thread,
        needsResync: state.needsResync || inconsistent
      };
    }
    case 'error':
      return notification.params.willRetry ? state : markNeedsResync(state);
  }
}

export function reduceTurnStartResponse(
  state: ConversationReducerState,
  turn: Turn
): ConversationReducerState {
  return reduceTurnStarted(state, turn);
}

export function activeConversationTurnId(state: ConversationReducerState): string | null {
  const active = state.thread.turns.filter((turn) => turn.status === 'inProgress');
  return active.length === 1 ? active[0]?.id ?? null : null;
}

export function hasInProgressConversationTurn(state: ConversationReducerState): boolean {
  return state.thread.turns.some((turn) => turn.status === 'inProgress');
}

export function isConversationBusy(state: ConversationReducerState): boolean {
  return state.thread.status.type === 'active' || hasInProgressConversationTurn(state);
}

function reduceTurnStarted(
  state: ConversationReducerState,
  incoming: Turn
): ConversationReducerState {
  const existing = findTurn(state.thread, incoming.id);
  if (existing && isTerminalTurn(existing)) {
    return state;
  }
  if (hasForeignItemOwner(state, incoming.id, incoming.items)) {
    return markNeedsResync(state);
  }

  const merged = existing ? mergeStartedTurn(existing, incoming) : incoming;
  const items = replaceTurnItemStates(state.items, incoming.id, merged.items, 'started');
  const thread = upsertTurn(state.thread, merged);
  const activeCount = thread.turns.filter((turn) => turn.status === 'inProgress').length;
  return {
    thread,
    items,
    needsResync: state.needsResync || incoming.status !== 'inProgress' || activeCount > 1
  };
}

function reduceTurnCompleted(
  state: ConversationReducerState,
  incoming: Turn
): ConversationReducerState {
  if (hasForeignItemOwner(state, incoming.id, incoming.items)) {
    return markNeedsResync(state);
  }

  return {
    thread: upsertTurn(state.thread, incoming),
    items: replaceTurnItemStates(state.items, incoming.id, incoming.items, 'completed'),
    needsResync: state.needsResync || !isTerminalTurn(incoming)
  };
}

function reduceItemStarted(
  state: ConversationReducerState,
  turnId: string,
  incoming: ThreadItem
): ConversationReducerState {
  const owner = state.items.get(incoming.id);
  if (owner && owner.turnId !== turnId) {
    return markNeedsResync(state);
  }

  const turn = findTurn(state.thread, turnId);
  if (turn && (isTerminalTurn(turn) || owner?.lifecycle === 'completed')) {
    return state;
  }

  const target = turn ?? placeholderTurn(turnId);
  const current = target.items.find((item) => item.id === incoming.id);
  const merged = current ? mergeStartedItem(current, incoming) : incoming;
  const conflict = Boolean(current && current.type !== incoming.type);
  const updatedTurn = upsertItem(target, merged);
  const items = new Map(state.items);
  items.set(incoming.id, { turnId, lifecycle: 'started' });
  return {
    thread: upsertTurn(state.thread, updatedTurn),
    items,
    needsResync: state.needsResync || conflict
  };
}

function reduceItemCompleted(
  state: ConversationReducerState,
  turnId: string,
  incoming: ThreadItem
): ConversationReducerState {
  const owner = state.items.get(incoming.id);
  if (owner && owner.turnId !== turnId) {
    return markNeedsResync(state);
  }

  const turn = findTurn(state.thread, turnId);
  if (turn && isTerminalTurn(turn)) {
    return state;
  }

  const target = turn ?? placeholderTurn(turnId);
  const current = target.items.find((item) => item.id === incoming.id);
  if (current && current.type !== incoming.type) {
    return markNeedsResync(state);
  }
  const items = new Map(state.items);
  items.set(incoming.id, { turnId, lifecycle: 'completed' });
  return {
    thread: upsertTurn(state.thread, upsertItem(target, incoming)),
    items,
    needsResync: state.needsResync
  };
}

function reduceAgentMessageDelta(
  state: ConversationReducerState,
  turnId: string,
  itemId: string,
  delta: string
): ConversationReducerState {
  const owner = state.items.get(itemId);
  if (owner && owner.turnId !== turnId) {
    return markNeedsResync(state);
  }

  const turn = findTurn(state.thread, turnId);
  if (turn && (isTerminalTurn(turn) || owner?.lifecycle === 'completed')) {
    return state;
  }

  const target = turn ?? placeholderTurn(turnId);
  const current = target.items.find((item) => item.id === itemId);
  if (current && current.type !== 'agentMessage') {
    return markNeedsResync(state);
  }

  const message: ThreadItem = current
    ? { ...current, text: `${current.text}${delta}` }
    : {
      type: 'agentMessage',
      id: itemId,
      text: delta,
      phase: null,
      memoryCitation: null
    };
  const items = new Map(state.items);
  items.set(itemId, { turnId, lifecycle: 'started' });
  return {
    thread: upsertTurn(state.thread, upsertItem(target, message)),
    items,
    needsResync: state.needsResync
  };
}

function mergeStartedTurn(existing: Turn, incoming: Turn): Turn {
  const incomingById = new Map(incoming.items.map((item) => [item.id, item]));
  const existingById = new Map(existing.items.map((item) => [item.id, item]));
  const order = [
    ...incoming.items.map((item) => item.id),
    ...existing.items.map((item) => item.id).filter((id) => !incomingById.has(id))
  ];
  return {
    ...incoming,
    items: order.flatMap((id) => {
      const current = existingById.get(id);
      const next = incomingById.get(id);
      if (current && next) {
        return [mergeStartedItem(current, next)];
      }
      return next ? [next] : current ? [current] : [];
    })
  };
}

function mergeStartedItem(current: ThreadItem, incoming: ThreadItem): ThreadItem {
  if (current.type !== incoming.type) {
    return current;
  }
  if (current.type === 'agentMessage' && incoming.type === 'agentMessage') {
    if (current.text.startsWith(incoming.text)) {
      return current;
    }
    if (incoming.text.startsWith(current.text)) {
      return incoming;
    }
    return current;
  }
  return current;
}

function replaceTurnItemStates(
  source: ReadonlyMap<string, ItemState>,
  turnId: string,
  turnItems: readonly ThreadItem[],
  lifecycle: ItemLifecycle
): ReadonlyMap<string, ItemState> {
  const items = new Map(
    [...source].filter(([, value]) => value.turnId !== turnId)
  );
  for (const item of turnItems) {
    const previous = source.get(item.id);
    const nextLifecycle = lifecycle === 'started' &&
      previous?.turnId === turnId &&
      previous.lifecycle === 'completed'
      ? 'completed'
      : lifecycle;
    items.set(item.id, { turnId, lifecycle: nextLifecycle });
  }
  return items;
}

function hasForeignItemOwner(
  state: ConversationReducerState,
  turnId: string,
  items: readonly ThreadItem[]
): boolean {
  return items.some((item) => {
    const owner = state.items.get(item.id);
    return owner !== undefined && owner.turnId !== turnId;
  });
}

function upsertTurn(thread: Thread, turn: Turn): Thread {
  const index = thread.turns.findIndex((candidate) => candidate.id === turn.id);
  if (index < 0) {
    return { ...thread, turns: [...thread.turns, turn] };
  }
  const turns = [...thread.turns];
  turns[index] = turn;
  return { ...thread, turns };
}

function upsertItem(turn: Turn, item: ThreadItem): Turn {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) {
    return { ...turn, items: [...turn.items, item] };
  }
  const items = [...turn.items];
  items[index] = item;
  return { ...turn, items };
}

function findTurn(thread: Thread, turnId: string): Turn | undefined {
  return thread.turns.find((turn) => turn.id === turnId);
}

function placeholderTurn(turnId: string): Turn {
  return {
    id: turnId,
    items: [],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null
  };
}

function isTerminalTurn(turn: Turn): boolean {
  return turn.status !== 'inProgress';
}

function markNeedsResync(state: ConversationReducerState): ConversationReducerState {
  return state.needsResync ? state : { ...state, needsResync: true };
}
